import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Kyoot, Resource, Sync } from "kyoot";
import * as Registry from "@kyoot/registry";
import { lifecycle, provider, X } from "./helpers.ts";

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

  const up = events.filter((event) => event === "consumer up").length;
  const down = events.filter((event) => event === "consumer down").length;
  assert.ok(up > 0);
  assert.equal(up, down);
});

test("a seeded add/remove/fail/cancel/replace sequence stays balanced", async () => {
  const events: string[] = [];
  const consumer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "consumer"),
  });
  const broken = Registry.component({
    inject: {},
    run: () =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "broken");
        yield* Sync.defer(() => {
          throw new Error("seeded failure");
        }).pipe(Sync.run);
      }),
  });
  let seed = 0x51ced;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    return seed;
  };

  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(consumer);
      let current: Registry.Handle | undefined;
      for (let step = 0; step < 48; step++) {
        switch (next() % 5) {
          case 0:
            if (current === undefined) {
              current = yield* registry.use(
                provider(events, `provider ${step}`, X, { name: `${step}` }),
              );
            }
            break;
          case 1:
            if (current !== undefined) {
              yield* current.remove();
              current = undefined;
            }
            break;
          case 2: {
            const failed = yield* registry.use(broken);
            assert.equal(failed.active, false);
            assert.match(String(failed.error), /seeded failure/);
            break;
          }
          case 3: {
            let started!: () => void;
            const startedPromise = new Promise<void>((resolve) => (started = resolve));
            const slow = Registry.component({
              inject: {},
              run: () =>
                Kyoot.gen(function* () {
                  yield* lifecycle(events, `cancelled ${step}`);
                  yield* Async.fromPromise(() => {
                    started();
                    return new Promise<never>(() => {});
                  });
                }),
            });
            const fiber = yield* Async.fork(registry.use(slow));
            yield* Async.fromPromise(() => startedPromise);
            yield* fiber.interrupt;
            break;
          }
          case 4:
            if (current !== undefined) yield* current.remove();
            current = yield* registry.use(
              provider(events, `replacement ${step}`, X, { name: `r${step}` }),
            );
            break;
        }
        yield* registry.settled();
      }
      if (current !== undefined) yield* current.remove();
    }).pipe(Resource.run),
  );

  const up = events.filter((event) => event.endsWith(" up")).length;
  const down = events.filter((event) => event.endsWith(" down")).length;
  assert.ok(up > 0);
  assert.equal(up, down);
});
