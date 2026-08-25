import { InterruptedError } from "./core.ts";
import { gen } from "./gen.ts";
import type { Kyoot } from "./model.ts";
import type { AsyncOp, AsyncRuntime, FiberHandle } from "./runtime.ts";
import type { Only, Row } from "./types.ts";
import * as Async from "./effects/async.ts";
import type * as Env from "./effects/env.ts";
import * as Resource from "./effects/resource.ts";

type Tag<E> = Env.Tag<string, E>;
type AnyTag = Tag<any>;

export type Inject = Record<string, Tag<any>>;

export type Resolve<I extends Inject> = {
  [N in keyof I]: I[N] extends Env.Tag<string, infer E> ? E : never;
};

export interface Ctx {
  set<E>(tag: Tag<E>, impl: E): Kyoot<void, { resource: Resource.ResourceOp }>;
}

export interface Component<I extends Inject = Inject> {
  readonly inject: I;
  readonly run: (deps: Resolve<I>, ctx: Ctx) => Kyoot<unknown, any>;
}

export const component = <I extends Inject, S extends Row>(spec: {
  inject: I;
  run: (deps: Resolve<I>, ctx: Ctx) => Kyoot<unknown, S> & Only<S, "resource" | "async" | "clock">;
}): Component<I> => spec as Component<I>;

export interface Handle {
  readonly active: boolean;
  readonly error: unknown;
  remove(): Kyoot<void, { async: AsyncOp }>;
}

interface Entry {
  readonly component: Component;
  target: boolean;
  active: boolean;
  fiber?: FiberHandle;
  inertia?: Promise<void>;
  error?: unknown;
}

const root: Entry = {
  component: { inject: {}, run: () => Async.never },
  target: true,
  active: true,
};

export class Registry implements Ctx {
  private readonly bindings = new Map<AnyTag, { impl: unknown; owner: Entry }>();
  private readonly entries: Entry[] = [];

  private readonly rt: AsyncRuntime;

  constructor(rt: AsyncRuntime) {
    this.rt = rt;
  }

  use(component: Component<any>): Kyoot<Handle, { async: AsyncOp }> {
    const entry: Entry = { component, target: false, active: false };
    return Async.fromPromise(async () => {
      this.entries.push(entry);
      await this.refresh(entry);
      const registry = this;
      return {
        get active() {
          return entry.active;
        },
        get error() {
          return entry.error;
        },
        remove: () =>
          Async.fromPromise(async () => {
            entry.target = false;
            await registry.transition(entry);
            registry.entries.splice(registry.entries.indexOf(entry), 1);
          }),
      };
    });
  }

  set<E>(tag: Tag<E>, impl: E) {
    return this.bind(root, tag, impl);
  }

  dispose(): Kyoot<void, { async: AsyncOp }> {
    return Async.fromPromise(async () => {
      for (const entry of [...this.entries].reverse()) {
        entry.target = false;
        await this.transition(entry);
      }
      this.entries.length = 0;
    });
  }

  settled(): Kyoot<void, { async: AsyncOp }> {
    return Async.fromPromise(async () => {
      await Promise.all(this.entries.map((e) => e.inertia));
    });
  }

  private bind<E>(owner: Entry, tag: Tag<E>, impl: E) {
    return Resource.acquire(
      () => {
        this.bindings.set(tag, { impl, owner });
        void this.notify([tag]);
      },
      () => {
        this.bindings.delete(tag);
        void this.notify([tag]);
      },
    );
  }

  private provided(owner: Entry) {
    return [...this.bindings].filter(([, b]) => b.owner === owner).map(([tag]) => tag);
  }

  private satisfied(entry: Entry) {
    return Object.values(entry.component.inject).every(
      (tag) => this.bindings.get(tag)?.owner.active ?? false,
    );
  }

  private notify(tags: ReadonlyArray<AnyTag>) {
    const dependents = this.entries.filter((e) =>
      Object.values(e.component.inject).some((t) => tags.includes(t)),
    );
    return Promise.all(dependents.map((e) => this.refresh(e)));
  }

  private refresh(entry: Entry) {
    entry.target = this.satisfied(entry);
    return this.transition(entry);
  }

  private transition(entry: Entry): Promise<void> {
    if (entry.inertia) return entry.inertia;
    if (entry.target === entry.active) return Promise.resolve();
    const run = async () => {
      while (entry.target !== entry.active) {
        if (entry.target) await this.activate(entry);
        else await this.deactivate(entry);
      }
    };
    entry.inertia = run().finally(() => {
      entry.inertia = undefined;
    });
    return entry.inertia;
  }

  private async activate(entry: Entry) {
    const deps = Object.fromEntries(
      Object.entries(entry.component.inject).map(([name, tag]) => [
        name,
        this.bindings.get(tag)!.impl,
      ]),
    );
    const ctx: Ctx = { set: (tag, impl) => this.bind(entry, tag, impl) };
    let landed!: () => void;
    const setup = new Promise<void>((resolve) => (landed = resolve));
    const program = gen(function* () {
      yield* entry.component.run(deps, ctx);
      yield* Async.fromPromise(async () => landed());
      yield* Async.never;
    }).pipe(Resource.run);
    entry.active = true;
    entry.error = undefined;
    entry.fiber = this.rt.spawn(program);
    const failed = entry.fiber.promise.then(
      () => undefined,
      (e: unknown) => (e instanceof InterruptedError ? undefined : e),
    );
    const error = await Promise.race([setup.then(() => undefined), failed]);
    if (error !== undefined) {
      entry.error = error;
      entry.active = false;
      entry.target = false;
      entry.fiber = undefined;
    }
  }

  private async deactivate(entry: Entry) {
    entry.active = false;
    await this.notify(this.provided(entry));
    entry.fiber?.interrupt();
    await entry.fiber?.promise.catch(() => {});
    entry.fiber = undefined;
  }
}

export const make = (): Kyoot<Registry, { async: AsyncOp }> =>
  Async.runtime.map((rt) => new Registry(rt));
