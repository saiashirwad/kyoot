import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Env, Kyoot, Resource, Sync } from "kyoot";
import * as Registry from "@kyoot/registry";

const X = Env.tag<{ name: string }>()("stress-x");
const Y = Env.tag<{ name: string }>()("stress-y");
const Trigger = Env.tag<{ name: string }>()("stress-trigger");

const lifecycle = (events: string[], name: string) =>
  Resource.acquire(
    () => events.push(`${name} up`),
    () => events.push(`${name} down`),
  );

const provider = <E>(events: string[], name: string, tag: Env.Tag<string, E>, impl: E) =>
  Registry.component({
    inject: {},
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, name);
        yield* ctx.set(tag, impl);
      }),
  });

test("a dependency chain stops and starts in dependency order", async () => {
  const events: string[] = [];
  const a = provider(events, "A", X, { name: "x" });
  const b = Registry.component({
    inject: { x: X },
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "B");
        yield* ctx.set(Y, { name: "y" });
      }),
  });
  const c = Registry.component({
    inject: { y: Y },
    run: () => lifecycle(events, "C"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const firstA = yield* registry.use(a);
      yield* registry.use(b);
      yield* registry.use(c);
      assert.deepEqual(events, ["A up", "B up", "C up"]);

      yield* firstA.remove();
      assert.deepEqual(events, ["A up", "B up", "C up", "C down", "B down", "A down"]);

      yield* registry.use(a);
      yield* registry.settled();
      assert.deepEqual(events.slice(-3), ["A up", "B up", "C up"]);
    }).pipe(Resource.run),
  );
});

test("a diamond dependent changes state once for each missing edge", async () => {
  const events: string[] = [];
  const px = provider(events, "X", X, { name: "x" });
  const py = provider(events, "Y", Y, { name: "y" });
  const diamond = Registry.component({
    inject: { x: X, y: Y },
    run: () => lifecycle(events, "D"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const hx = yield* registry.use(px);
      yield* registry.use(py);
      const d = yield* registry.use(diamond);
      assert.equal(d.active, true);
      assert.equal(events.filter((event) => event === "D up").length, 1);

      yield* hx.remove();
      assert.equal(d.active, false);
      assert.equal(events.filter((event) => event === "D down").length, 1);

      yield* registry.use(px);
      yield* registry.settled();
      assert.equal(d.active, true);
      assert.equal(events.filter((event) => event === "D up").length, 2);
    }).pipe(Resource.run),
  );
});

test("a component waits until all injected tags are present", async () => {
  const events: string[] = [];
  const both = Registry.component({
    inject: { x: X, y: Y },
    run: () => lifecycle(events, "both"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(provider(events, "X", X, { name: "x" }));
      const handle = yield* registry.use(both);
      assert.equal(handle.active, false);
      assert.equal(events.includes("both up"), false);

      yield* registry.use(provider(events, "Y", Y, { name: "y" }));
      yield* registry.settled();
      assert.equal(handle.active, true);
      assert.equal(events.filter((event) => event === "both up").length, 1);
    }).pipe(Resource.run),
  );
});

test("rapid provider churn keeps activations balanced", async () => {
  const events: string[] = [];
  const dependent = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "dependent"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const handle = yield* registry.use(dependent);
      for (let i = 0; i < 8; i++) {
        const p = yield* registry.use(provider(events, `P${i}`, X, { name: `${i}` }));
        yield* p.remove();
      }
      yield* registry.use(provider(events, "final", X, { name: "final" }));
      assert.equal(handle.active, true);
      assert.equal(events.filter((event) => event === "dependent up").length, 9);
      assert.equal(events.filter((event) => event === "dependent down").length, 8);
    }).pipe(Resource.run),
  );

  assert.equal(events.filter((event) => event === "dependent up").length, 9);
  assert.equal(events.filter((event) => event === "dependent down").length, 9);
});

test("a target flip during slow setup releases partial resources", { timeout: 2_000 }, async () => {
  const events: string[] = [];
  const slow = Registry.component({
    inject: { x: X },
    run: () =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "partial");
        yield* Clock.sleep(30);
        yield* lifecycle(events, "landed");
      }),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const handle = yield* registry.use(slow);
      const p = yield* registry.use(provider(events, "provider", X, { name: "x" }));
      assert.equal(events.includes("partial up"), true);
      assert.equal(events.includes("landed up"), false);

      yield* p.remove();
      assert.equal(handle.active, false);
      assert.equal(events.filter((event) => event === "partial up").length, 1);
      assert.equal(events.filter((event) => event === "partial down").length, 1);
      assert.equal(events.filter((event) => event === "landed up").length, 0);
      assert.equal(events.filter((event) => event === "landed down").length, 0);
    }).pipe(Resource.run),
  );
});

test("failed setup releases resources, preserves peers, and retries after a target flip", async () => {
  const events: string[] = [];
  const boom = new Error("setup boom");
  const broken = Registry.component({
    inject: { x: X, trigger: Trigger },
    run: () =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "broken");
        yield* Sync.defer(() => {
          throw boom;
        }).pipe(Sync.run);
      }),
  });
  const peer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "peer"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(provider(events, "X", X, { name: "x" }));
      const peerHandle = yield* registry.use(peer);
      const bad = yield* registry.use(broken);
      assert.equal(bad.active, false);

      const firstTrigger = yield* registry.use(
        provider(events, "trigger-1", Trigger, { name: "one" }),
      );
      yield* registry.settled();
      assert.equal(bad.active, false);
      assert.equal(bad.error, boom);
      assert.equal(peerHandle.active, true);
      assert.equal(events.filter((event) => event === "broken down").length, 1);

      yield* firstTrigger.remove();
      yield* registry.use(provider(events, "trigger-2", Trigger, { name: "two" }));
      yield* registry.settled();
      assert.equal(bad.active, false);
      assert.equal(bad.error, boom);
      assert.equal(events.filter((event) => event === "broken up").length, 2);
      assert.equal(events.filter((event) => event === "broken down").length, 2);
      assert.equal(peerHandle.active, true);
    }).pipe(Resource.run),
  );
});

test("use waits for setup to land", { timeout: 2_000 }, async () => {
  const events: string[] = [];
  let returned = false;
  const neverLands = Registry.component({
    inject: {},
    run: () =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "partial");
        yield* Async.never;
      }),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* Async.fork(registry.use(neverLands).map(() => (returned = true)));
      yield* Clock.sleep(20);
      assert.equal(returned, false);
    }).pipe(Resource.run),
  );

  assert.equal(returned, true, "use resolves once the registry is disposed");
  assert.deepEqual(events, ["partial up", "partial down"]);
});

test("a root binding is withdrawn when its resource scope ends", async () => {
  const events: string[] = [];
  const consumer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "consumer"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const handle = yield* registry.use(consumer);
      yield* Kyoot.gen(function* () {
        yield* registry.set(X, { name: "root" });
        yield* registry.settled();
        assert.equal(handle.active, true);
      }).pipe(Resource.run);
      yield* registry.settled();
      assert.equal(handle.active, false);
    }).pipe(Resource.run),
  );

  assert.deepEqual(events, ["consumer up", "consumer down"]);
});

test("synchronous root finalizers do not lose notify transitions", async () => {
  const events: string[] = [];
  const consumer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "consumer"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const handle = yield* registry.use(consumer);
      for (let i = 0; i < 100; i++) {
        yield* Kyoot.gen(function* () {
          yield* registry.set(X, { name: `${i}` });
        }).pipe(Resource.run);
      }
      yield* registry.settled();
      assert.equal(handle.active, false);
    }).pipe(Resource.run),
  );

  assert.equal(
    events.filter((event) => event === "consumer up").length,
    events.filter((event) => event === "consumer down").length,
  );
});

test(
  "dispose waits for an in-flight setup and leaves no resources",
  { timeout: 2_000 },
  async () => {
    const events: string[] = [];
    const slow = Registry.component({
      inject: { x: X },
      run: () =>
        Kyoot.gen(function* () {
          yield* lifecycle(events, "slow partial");
          yield* Clock.sleep(30);
          yield* lifecycle(events, "slow landed");
        }),
    });

    await Kyoot.runPromise(
      Kyoot.gen(function* () {
        const registry = yield* Registry.make();
        const slowHandle = yield* registry.use(slow);
        yield* registry.use(provider(events, "provider", X, { name: "x" }));
        yield* registry.dispose();
        assert.equal(slowHandle.active, false);
      }).pipe(Resource.run),
    );

    assert.equal(events.filter((event) => event === "slow partial up").length, 1);
    assert.equal(events.filter((event) => event === "slow partial down").length, 1);
    assert.equal(events.filter((event) => event === "slow landed up").length, 0);
    assert.equal(events.filter((event) => event === "slow landed down").length, 0);
  },
);

test("remove is idempotent and does not orphan another component", async () => {
  const events: string[] = [];
  const a = Registry.component({ inject: {}, run: () => lifecycle(events, "A") });
  const b = Registry.component({ inject: {}, run: () => lifecycle(events, "B") });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const ha = yield* registry.use(a);
      const hb = yield* registry.use(b);
      yield* ha.remove();
      yield* ha.remove();
      assert.equal(hb.active, true);
      yield* registry.dispose();
      assert.equal(hb.active, false);
    }).pipe(Resource.run),
  );

  assert.deepEqual(events, ["A up", "B up", "A down", "B down"]);
});

test("interrupting a registry program releases components in reverse order", async () => {
  const events: string[] = [];
  let ready = false;
  const a = provider(events, "A", X, { name: "x" });
  const b = Registry.component({
    inject: { x: X },
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "B");
        yield* ctx.set(Y, { name: "y" });
      }),
  });
  const c = Registry.component({ inject: { y: Y }, run: () => lifecycle(events, "C") });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(
        Kyoot.gen(function* () {
          const registry = yield* Registry.make();
          yield* registry.use(a);
          yield* registry.use(b);
          yield* registry.use(c);
          ready = true;
          yield* Async.never;
        }).pipe(Resource.run),
      );
      yield* Clock.sleep(20);
      assert.equal(ready, true);
      yield* fiber.interrupt;
    }),
  );

  assert.deepEqual(events, ["A up", "B up", "C up", "C down", "B down", "A down"]);
});

test("two registries do not share bindings", async () => {
  const events: string[] = [];
  const consumer = Registry.component({
    inject: { x: X },
    run: ({ x }) => lifecycle(events, `consumer ${x.name}`),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const first = yield* Registry.make();
      const second = yield* Registry.make();
      yield* first.use(provider(events, "first provider", X, { name: "first" }));
      const handle = yield* second.use(consumer);
      assert.equal(handle.active, false);

      yield* second.use(provider(events, "second provider", X, { name: "second" }));
      yield* second.settled();
      assert.equal(handle.active, true);
      assert.equal(events.includes("consumer first up"), false);
      assert.equal(events.includes("consumer second up"), true);
      yield* second.dispose();
      yield* first.dispose();
    }).pipe(Resource.run),
  );
});

test("a duplicate provider fails its setup and leaves the first binding alone", async () => {
  const events: string[] = [];
  const consumer = Registry.component({
    inject: { x: X },
    run: ({ x }) => lifecycle(events, `consumer ${x.name}`),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const first = yield* registry.use(provider(events, "P1", X, { name: "one" }));
      const handle = yield* registry.use(consumer);
      assert.equal(handle.active, true);
      const second = yield* registry.use(provider(events, "P2", X, { name: "two" }));
      assert.equal(second.active, false);
      assert.match(String(second.error), /duplicate provider/);
      assert.equal(handle.active, true);
      assert.equal(events.includes("P2 down"), true);

      yield* second.remove();
      yield* registry.settled();
      assert.equal(first.active, true);
      assert.equal(handle.active, true);
    }).pipe(Resource.run),
  );
});

test("a binding becomes visible only when its provider lands", { timeout: 2_000 }, async () => {
  const events: string[] = [];
  const slowProvider = Registry.component({
    inject: {},
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "provider");
        yield* ctx.set(X, { name: "x" });
        yield* Clock.sleep(30);
        events.push("provider landed");
      }),
  });
  const consumer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "consumer"),
  });

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(consumer);
      yield* registry.use(slowProvider);
      assert.deepEqual(events.slice(0, 3), ["provider up", "provider landed", "consumer up"]);
    }).pipe(Resource.run),
  );
});
