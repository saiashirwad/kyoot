import assert from "node:assert/strict";
import { test } from "node:test";
import { CleanupError, Clock, Emit, Env, Kyoot, Resource } from "../src/index.ts";

test("Env value provisioning preserves a Kyoot-valued service", () => {
  const Service = Env.tag<Kyoot<number>>()("kyoot-service");
  const value = Kyoot.succeed(42);
  assert.equal(Kyoot.runSync(Service.get().pipe(Service.provide(value))), value);
  assert.equal(Kyoot.runSync(Service.get().pipe(Service.provideValue(value))), value);
});

test("Emit.forEach awaits Promise callbacks", async () => {
  const events: string[] = [];
  const result = await Kyoot.runPromise(
    Emit.fromIterable([1, 2]).pipe(
      Emit.forEach(async (value) => {
        await Promise.resolve();
        events.push(String(value));
      }),
      Emit.collect,
    ),
  );
  assert.deepEqual(events, ["1", "2"]);
  assert.equal(result[0], undefined);
});

test("Emit.forEach owns rejected Promise callbacks", async () => {
  const failure = new Error("callback failed");
  await assert.rejects(
    Kyoot.runPromise(
      Emit.fromIterable([1]).pipe(
        Emit.forEach(async () => {
          await Promise.resolve();
          throw failure;
        }),
      ),
    ),
    failure,
  );
});

test("Resource promise release waits and runs every release", async () => {
  const events: string[] = [];
  const failure = new Error("release failed");
  const program = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "first",
      async () => {
        await Promise.resolve();
        events.push("first");
        throw failure;
      },
    );
    yield* Resource.acquire(
      () => "second",
      async () => {
        await Promise.resolve();
        events.push("second");
      },
    );
    return "done";
  }).pipe(Resource.run);
  await assert.rejects(Kyoot.runPromise(program), CleanupError);
  assert.deepEqual(events, ["second", "first"]);
});

test("Resource effectful acquisition is interpreted", () => {
  const program = Resource.acquireEffect(
    () => Clock.sleep(0).map(() => "value"),
    () => Clock.sleep(0),
  ).pipe(Resource.run);
  assert.deepEqual(Kyoot.runSync(program.pipe(Clock.virtual)), ["value", 0]);
});
