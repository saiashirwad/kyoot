import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, InterruptedError, Kyoot, Resource, runFiber } from "kyoot";
import * as Registry from "@kyoot/registry";
import { deferred, lifecycle, X } from "./helpers.ts";

test("interrupted use releases setup before its caller settles and cannot reactivate", async () => {
  const registry = new Registry.Registry();
  const events: string[] = [];
  const started = deferred();
  const setup = deferred();
  const consumer = Registry.component({
    inject: { x: X },
    run: () => lifecycle(events, "consumer"),
  });
  const handle = await Kyoot.runPromise(registry.use(consumer));
  const provider = Registry.component({
    inject: {},
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* lifecycle(events, "partial");
        yield* ctx.set(X, { name: "x" });
        started.resolve();
        yield* Async.fromPromise(() => setup.promise);
        yield* lifecycle(events, "landed");
      }),
  });
  const fiber = runFiber(registry.use(provider));
  const rejected = assert.rejects(fiber.promise, InterruptedError);
  try {
    await started.promise;
    fiber.interrupt();
    await rejected;
    assert.deepEqual([...events], ["partial up", "partial down"]);
    setup.resolve();
    await Kyoot.runPromise(registry.settled());
    assert.equal(handle.active, false);
    assert.deepEqual(events, ["partial up", "partial down"]);
    await Kyoot.runPromise(
      Kyoot.gen(function* () {
        yield* registry.set(X, { name: "replacement" });
        yield* registry.settled();
        assert.equal(handle.active, true);
      }).pipe(Resource.run),
    );
    await Kyoot.runPromise(registry.settled());
    assert.deepEqual(events, ["partial up", "partial down", "consumer up", "consumer down"]);
  } finally {
    setup.resolve();
    await Kyoot.runPromise(registry.dispose());
  }
});

test("each evaluation of one use program has its own registration", async () => {
  const registry = new Registry.Registry();
  const events: string[] = [];
  const program = registry.use(
    Registry.component({ inject: {}, run: () => lifecycle(events, "instance") }),
  );
  try {
    const first = await Kyoot.runPromise(program);
    const second = await Kyoot.runPromise(program);
    assert.deepEqual([...events], ["instance up", "instance up"]);
    await Kyoot.runPromise(first.remove());
    assert.equal(first.active, false);
    assert.equal(second.active, true);
    await Kyoot.runPromise(second.remove());
    assert.deepEqual(events, ["instance up", "instance up", "instance down", "instance down"]);
  } finally {
    await Kyoot.runPromise(registry.dispose());
  }
});
