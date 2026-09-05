import { Async, InterruptedError, Kyoot, Resource } from "kyoot";
import { unsafeRunFiber } from "kyoot/internal";
import type { AsyncOp, Env, FiberHandle, Kyoot as K, Only, Row } from "kyoot";

type AnyTag = { readonly key: string };

export type Inject = Record<string, AnyTag>;

export type Resolve<I extends Inject> = {
  [N in keyof I]: I[N] extends Env.Tag<any, infer E> ? E : never;
};

export interface Ctx {
  set<Id extends string, E>(
    tag: Env.Tag<Id, E>,
    impl: E,
  ): K<void, { resource: Resource.ResourceOp }>;
}

export interface Component<I extends Inject = Inject> {
  readonly inject: I;
  readonly run: (deps: Resolve<I>, ctx: Ctx) => K<unknown, any>;
}

export const component = <I extends Inject, S extends Row>(spec: {
  inject: I;
  run: (deps: Resolve<I>, ctx: Ctx) => K<unknown, S> & Only<S, "resource" | "async" | "clock">;
}): Component<I> => spec as Component<I>;

export interface Handle {
  readonly active: boolean;
  readonly error: unknown;
  remove(): K<void, { async: AsyncOp }>;
}

/** Registry operations fail with this defect once disposal has begun. */
export class RegistryDisposedError extends Error {
  constructor() {
    super("Registry is disposed");
    this.name = "RegistryDisposedError";
  }
}

/** The only lifecycle an entry may be in. Removed entries never leave Removed. */
type EntryState = "Waiting" | "Starting" | "Active" | "Stopping" | "Failed" | "Removed";

interface Entry {
  readonly component: Component;
  state: EntryState;
  generation: number;
  wanted: boolean;
  fiber?: FiberHandle;
  error?: unknown;
  failedAt: string;
  removing?: Promise<void>;
  waiters: Array<() => void>;
  initialChecked: boolean;
}

interface Binding {
  readonly impl: unknown;
  readonly owner: Entry | typeof root;
  readonly generation?: number;
}

type Outcome = { type: "landed" } | { type: "interrupted" } | { type: "failed"; error: unknown };

const root = { state: "Active" as const };

/** A single-writer reconciler. Async starts and stops each own a generation. */
export class Registry implements Ctx {
  private readonly bindings = new Map<string, Binding>();
  private readonly entries: Entry[] = [];
  private revision = 0;
  private readonly keyRevisions = new Map<string, number>();
  private pending = false;
  private running = false;
  private loop?: Promise<void>;
  private readonly transitions = new Set<Promise<void>>();
  private disposed = false;
  private disposing?: Promise<void>;

  use(component: Component<any>): K<Handle, { async: AsyncOp }> {
    // Allocate here, rather than outside the effect: one program may run many times.
    return Async.fromPromise(async (signal) => {
      this.assertOpen();
      const entry: Entry = {
        component,
        state: "Waiting",
        generation: 0,
        wanted: true,
        failedAt: "",
        waiters: [],
        initialChecked: false,
      };
      this.entries.push(entry);
      this.changed();

      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        void this.removeEntry(entry).catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await this.waitForInitial(entry);
        if (cancelled || signal.aborted) {
          await this.removeEntry(entry);
          throw new InterruptedError();
        }
        if (this.disposed) {
          await this.removeEntry(entry);
          // This use began while the registry was open. Its removed handle is
          // safe to return, and cannot expose live state after disposal.
          return this.handle(entry);
        }
        return this.handle(entry);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
  }

  set<Id extends string, E>(tag: Env.Tag<Id, E>, impl: E) {
    return this.bind(root, tag, impl);
  }

  dispose(): K<void, { async: AsyncOp }> {
    return Async.fromPromise(async () => {
      await this.beginDispose();
    });
  }

  settled(): K<void, { async: AsyncOp }> {
    return Async.fromPromise(() => this.quiesce());
  }

  private assertOpen() {
    if (this.disposed) throw new RegistryDisposedError();
  }

  private beginDispose() {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      for (const entry of [...this.entries].reverse()) this.requestRemoval(entry);
      await this.quiesce();
    })();
    return this.disposing;
  }

  private handle(entry: Entry): Handle {
    return {
      get active() {
        return entry.state === "Active";
      },
      get error() {
        return entry.error;
      },
      remove: () => Async.fromPromise(() => this.removeEntry(entry)),
    };
  }

  private bind<Id extends string, E>(
    owner: Entry | typeof root,
    tag: Env.Tag<Id, E>,
    impl: E,
    generation?: number,
  ) {
    const key = tag.key;
    return Resource.acquire(
      () => {
        if (owner === root) this.assertOpen();
        if (owner !== root && (owner.state !== "Starting" || owner.generation !== generation)) {
          throw new InterruptedError();
        }
        if (this.bindings.has(key)) throw new Error(`duplicate provider for ${key}`);
        this.bindings.set(key, { impl, owner, generation });
        if (owner === root || owner.state === "Active") this.changed([key]);
      },
      () => {
        const binding = this.bindings.get(key);
        if (binding?.owner !== owner || binding.generation !== generation) return;
        if (owner === root || owner.state === "Active") this.hideDependents([key]);
        this.bindings.delete(key);
        if (owner === root || owner.state === "Active") this.changed([key]);
      },
    );
  }

  private binding(tag: AnyTag) {
    return this.bindings.get(tag.key);
  }

  private providedKeys(owner: Entry) {
    return [...this.bindings].filter(([, binding]) => binding.owner === owner).map(([key]) => key);
  }

  private satisfied(entry: Entry) {
    return Object.values(entry.component.inject).every((tag) => {
      const binding = this.binding(tag);
      return binding !== undefined && (binding.owner === root || binding.owner.state === "Active");
    });
  }

  private dependsOn(entry: Entry, keys: readonly string[]) {
    return Object.values(entry.component.inject).some((tag) => keys.includes(tag.key));
  }

  private hideDependents(keys: readonly string[]) {
    if (keys.length === 0) return;
    for (const entry of this.entries) {
      if (entry.state === "Removed" || entry.state === "Stopping") continue;
      if (this.dependsOn(entry, keys)) this.requestStop(entry);
    }
  }

  private requestStop(entry: Entry) {
    if (entry.state === "Removed" || entry.state === "Stopping") return;
    const starting = entry.state === "Starting";
    entry.generation++;
    entry.state = "Stopping";
    this.wake(entry);
    // Reconcile may be awaiting this setup's land signal. Wake it now.
    if (starting) entry.fiber?.interrupt();
    // This hides bindings before any resource finalizer releases them.
    const keys = this.providedKeys(entry);
    this.hideDependents(keys);
    this.changed(keys);
  }

  private requestRemoval(entry: Entry) {
    if (entry.state === "Removed") return;
    entry.wanted = false;
    this.requestStop(entry);
    this.changed();
  }

  private async removeEntry(entry: Entry): Promise<void> {
    if (entry.state === "Removed") return;
    if (entry.removing) return entry.removing;
    entry.removing = (async () => {
      this.requestRemoval(entry);
      while (entry.state !== "Removed") {
        await this.drain();
        await Promise.resolve();
      }
    })();
    return entry.removing;
  }

  private changed(keys: readonly string[] = []) {
    this.revision++;
    for (const key of keys) this.keyRevisions.set(key, this.revision);
    this.pending = true;
    if (!this.loop && !this.running) this.startLoop();
  }

  private startLoop() {
    this.running = true;
    const work = this.reconcile();
    this.loop = work.then(
      () => {
        this.finishLoop();
      },
      () => {
        // Entry failures are represented on their handles. This only catches
        // unexpected reconciler defects so detached bookkeeping cannot reject.
        this.finishLoop();
      },
    );
  }

  private finishLoop() {
    this.running = false;
    this.loop = undefined;
    if (this.pending) this.startLoop();
  }

  private drain() {
    return this.loop ?? Promise.resolve();
  }

  private async quiesce(): Promise<void> {
    while (true) {
      const revision = this.revision;
      await this.drain();
      await Promise.all([...this.transitions]);
      await Promise.resolve();
      if (
        revision === this.revision &&
        !this.loop &&
        !this.running &&
        !this.pending &&
        this.transitions.size === 0
      ) {
        return;
      }
    }
  }

  private async waitForInitial(entry: Entry): Promise<void> {
    // Do not wait for unrelated registry work after this entry has landed.
    while (!entry.initialChecked || entry.state === "Starting") await this.waitEntry(entry);
  }

  private waitEntry(entry: Entry) {
    return new Promise<void>((resolve) => entry.waiters.push(resolve));
  }

  private wake(entry: Entry) {
    for (const resolve of entry.waiters.splice(0)) resolve();
  }

  private liveDependent(entry: Entry) {
    const keys = this.providedKeys(entry);
    return this.entries.some(
      (other) =>
        other !== entry &&
        other.state !== "Waiting" &&
        other.state !== "Failed" &&
        other.state !== "Removed" &&
        this.dependsOn(other, keys),
    );
  }

  private dependencyStamp(entry: Entry) {
    return Object.values(entry.component.inject)
      .map((tag) => `${tag.key}:${this.keyRevisions.get(tag.key) ?? 0}`)
      .join("|");
  }

  /** Start newly satisfied dependents before exposing the provider's handle. */
  private launchReady() {
    for (const entry of this.entries) {
      if (entry.wanted && entry.state === "Waiting" && this.satisfied(entry)) {
        this.launch(entry);
      }
    }
  }

  private launch(entry: Entry) {
    const transition = this.start(entry);
    this.transitions.add(transition);
    void transition.then(
      () => this.transitions.delete(transition),
      () => this.transitions.delete(transition),
    );
  }

  private async reconcile(): Promise<void> {
    while (true) {
      this.pending = false;
      for (const entry of this.entries) {
        if (
          (entry.state === "Starting" || entry.state === "Active") &&
          (!entry.wanted || !this.satisfied(entry))
        ) {
          this.requestStop(entry);
        }
      }
      for (const entry of this.entries) {
        if (entry.state === "Waiting" && !entry.initialChecked) {
          entry.initialChecked = true;
          this.wake(entry);
        }
      }

      const stopping = [...this.entries]
        .reverse()
        .find((entry) => entry.state === "Stopping" && !this.liveDependent(entry));
      if (stopping !== undefined) {
        await this.stop(stopping);
        continue;
      }

      const startable = this.entries.find(
        (entry) =>
          entry.wanted &&
          this.satisfied(entry) &&
          (entry.state === "Waiting" ||
            (entry.state === "Failed" && entry.failedAt !== this.dependencyStamp(entry))),
      );
      if (startable !== undefined) {
        await this.start(startable);
        continue;
      }
      if (!this.pending) return;
    }
  }

  private async start(entry: Entry) {
    const generation = ++entry.generation;
    entry.state = "Starting";
    entry.error = undefined;
    this.changed();
    const deps = Object.fromEntries(
      Object.entries(entry.component.inject).map(([name, tag]) => [name, this.binding(tag)!.impl]),
    ) as Resolve<Inject>;
    const ctx: Ctx = { set: (tag, impl) => this.bind(entry, tag, impl, generation) };
    let land!: () => void;
    const landed = new Promise<Outcome>((resolve) => (land = () => resolve({ type: "landed" })));
    const program = Kyoot.gen(function* () {
      yield* entry.component.run(deps, ctx);
      yield* Async.fromPromise(async () => land());
      yield* Async.never;
    }).pipe(Resource.run);
    const fiber = unsafeRunFiber(program);
    entry.fiber = fiber;
    const died = fiber.promise.then(
      (): Outcome => ({ type: "interrupted" }),
      (error: unknown): Outcome =>
        error instanceof InterruptedError ? { type: "interrupted" } : { type: "failed", error },
    );
    const outcome = await Promise.race([landed, died]);

    if (entry.generation !== generation || entry.state !== "Starting") return;
    if (outcome.type === "landed") {
      entry.state = "Active";
      this.changed(this.providedKeys(entry));
      this.launchReady();
      this.wake(entry);
      return;
    }
    entry.fiber = undefined;
    if (outcome.type === "failed") {
      entry.error = outcome.error;
      entry.state = "Failed";
      this.wake(entry);
      entry.failedAt = this.dependencyStamp(entry);
      // The failure itself is not a reason to retry. A later dependency change is.
      this.changed();
    } else {
      entry.state = entry.wanted ? "Waiting" : "Removed";
      this.wake(entry);
      this.changed();
    }
  }

  private async stop(entry: Entry) {
    const generation = ++entry.generation;
    const fiber = entry.fiber;
    entry.fiber = undefined;
    fiber?.interrupt();
    await fiber?.promise.catch(() => {});
    if (entry.generation !== generation || entry.state !== "Stopping") return;
    entry.state = entry.wanted ? "Waiting" : "Removed";
    this.wake(entry);
    this.changed();
  }
}

export const make = () =>
  Resource.acquire(
    () => new Registry(),
    (registry) => registry.dispose(),
  );
