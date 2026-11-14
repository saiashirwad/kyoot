import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, ensuring, Kyoot, type Row } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Random from "../src/effects/random.ts";
import { Async, Clock, runPromise } from "../src/async/index.ts";
import * as Sim from "../src/sim/index.ts";
import * as Tickets from "../examples/sim/tickets.ts";
import * as Payments from "../examples/sim/payments.ts";
import * as Rare from "../examples/sim/rare.ts";

// One program, two drivers: a user effect, a fork, a timeout and a sleep.
const Lookup = effect<string, number>()("users/lookup");
const program = Kyoot.gen(function* () {
  const slow = yield* Async.fork(Lookup("slow"), { name: "slow" });
  const fast = yield* Async.timeout(1_000, Lookup("fast")).pipe(Fail.run);
  yield* Async.sleep(5);
  const late = yield* Async.timeout(1, Async.join(slow)).pipe(Fail.run);
  return [fast.ok && fast.value, !late.ok && late.cause._tag === "Fail" && late.cause.error._tag];
});

test("drivers: the same program runs under Sim.run and runPromise", async () => {
  const world = () => ({
    "users/lookup": (name: string) => (name === "slow" ? Sim.delay(60_000, 1) : 2),
  });
  const simulated = Sim.run(program, { seed: 0, world });
  assert.deepEqual(simulated.exit, { ok: true, value: [2, "Timeout"] });
  assert.equal(simulated.now, 6);

  const lookup = <A, S extends Row>(k: Kyoot<A, S>) =>
    k.pipe(
      Lookup.handle((name, resume) =>
        Async.fromPromise(
          (signal) =>
            new Promise<number>((resolve) => {
              const t = setTimeout(() => resolve(1), name === "slow" ? 60_000 : 0);
              signal.addEventListener("abort", () => clearTimeout(t));
              if (name !== "slow") resolve(2);
            }),
        ).flatMap(resume),
      ),
    );
  assert.deepEqual(await runPromise(program.pipe(Async.provide(lookup))), [2, "Timeout"]);
});

test("Async.provide reaches every fiber the program forks; a plain handler does not", async () => {
  const Name = effect<void, string>()("name");
  const child = Name().map((n) => `child sees ${n}`);
  const tree = Kyoot.gen(function* () {
    const f = yield* Async.fork(Async.fork(child).flatMap(Async.join));
    return [yield* Name(), yield* Async.join(f)];
  });
  const named = <A, S extends Row>(k: Kyoot<A, S>) =>
    k.pipe(Name.handle((_, resume) => resume("kyoot")));
  assert.deepEqual(await runPromise(tree.pipe(Async.provide(named))), [
    "kyoot",
    "child sees kyoot",
  ]);
  await assert.rejects(
    runPromise(tree.pipe(named) as never),
    /unhandled effect 'name'.*handlers don't cross a fork/,
  );
});

test("sim: the world answers any declared key, not just io/", () => {
  const Get = effect<string, number>()("db/get");
  const Model = effect<string, string>()("ai/model");
  const both = Kyoot.gen(function* () {
    const reply = yield* Async.fork(Model("hi"));
    return [yield* Get("a"), (yield* Async.join(reply)).length];
  });
  const r = Sim.run(both, {
    seed: 1,
    world: () => ({
      "db/get": (k: string) => k.length,
      "ai/model": () => Sim.delay(1_200, "hello"),
    }),
  });
  assert.deepEqual(r.exit, { ok: true, value: [1, 5] });
  assert.equal(r.now, 1_200);
});

test("sim: promise interop is raised in the fiber, with a hint", () => {
  const r = Sim.run(Async.fromPromise(() => Promise.resolve(1)) as Kyoot<number>, { seed: 0 });
  assert.ok(!r.exit.ok && r.exit.cause._tag === "Defect");
  assert.match(
    String((r.exit.cause as { defect: Error }).defect.message),
    /answer it from the world/,
  );
});

test("live: clock/now, random and yield are answered by the driver", async () => {
  const t0 = Date.now();
  const [now, x] = await runPromise(
    Kyoot.gen(function* () {
      yield* Async.yieldNow;
      return [yield* Async.now, yield* Random.next()];
    }),
  );
  assert.ok(now >= t0 && now <= Date.now());
  assert.ok(x >= 0 && x < 1);
});

test("live: yieldNow lets another fiber run", async () => {
  const seen: string[] = [];
  const step = (name: string) =>
    Kyoot.gen(function* () {
      for (let i = 0; i < 3; i++) {
        seen.push(`${name}${i}`);
        yield* Async.yieldNow;
      }
    });
  await runPromise(Async.all([step("a"), step("b")]));
  assert.deepEqual(seen, ["a0", "b0", "a1", "b1", "a2", "b2"]);
});

test("live: interrupt waits for the target's finalizers, which may sleep", async () => {
  const events: string[] = [];
  const r = await runPromise(
    Kyoot.gen(function* () {
      const f = yield* Async.fork(
        ensuring(
          Async.sleep(60_000),
          Async.sleep(5).map(() => events.push("cleaned")),
        ),
      );
      yield* Async.sleep(1);
      yield* Async.interrupt(f);
      events.push("interrupted");
      return yield* Async.wait(f);
    }),
  );
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["cleaned", "interrupted"]);
});

test("live: Clock.virtual still makes sleeps instant inside a subtree", async () => {
  assert.deepEqual(
    await runPromise(
      Async.sleep(60_000)
        .pipe(Clock.virtual)
        .map(([, t]) => t),
    ),
    60_000,
  );
});

test("demo: the ticket oversell happens for real under runPromise, and the fix holds", async () => {
  const racy = await Tickets.runLive();
  assert.deepEqual(racy.charged, ["alice", "bob"]);
  const safe = await Tickets.runLive({ safely: true });
  assert.deepEqual(safe.value, ["alice: got a ticket", "bob: sold out"]);
  assert.deepEqual(safe.charged, ["alice"]);
});

test("demo: payments and the stale cache also run live", async () => {
  const paid = await Payments.runLive();
  assert.deepEqual(paid.value, { ok: true, value: "paid on attempt 1" });
  assert.deepEqual(paid.charges, ["order-42"]);
  assert.equal(await Rare.runLive(), true);
});
