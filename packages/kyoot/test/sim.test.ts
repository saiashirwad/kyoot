import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, ensuring, Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Random from "../src/effects/random.ts";
import * as Sim from "../src/sim/index.ts";
import * as Tickets from "../examples/sim/tickets.ts";
import * as Payments from "../examples/sim/payments.ts";

const Note = effect<string, void>()("io/note");
const notes = () => {
  const seen: string[] = [];
  return { seen, "io/note": (s: string) => void seen.push(s) };
};

const worker = (name: string, n: number) =>
  Kyoot.gen(function* () {
    for (let i = 0; i < n; i++) yield* Note(`${name}${i}`);
    return name;
  });

const three = Sim.all([worker("a", 3), worker("b", 3), worker("c", 3)]);

test("sim: the same seed gives the same trace", () => {
  for (const seed of [0, 1, 7, 12345]) {
    const a = Sim.run(three, { seed, world: notes });
    const b = Sim.run(three, { seed, world: notes });
    assert.equal(Sim.format(a.trace), Sim.format(b.trace));
    assert.deepEqual(a.world.seen, b.world.seen);
    assert.deepEqual(a.exit, { ok: true, value: ["a", "b", "c"] });
  }
});

test("sim: different seeds explore different interleavings", () => {
  const orders = new Set<string>();
  for (let seed = 0; seed < 50; seed++) {
    orders.add(Sim.run(three, { seed, world: notes }).world.seen.join(" "));
  }
  assert.ok(orders.size > 20, `only ${orders.size} distinct orders`);
});

test("sim: each fiber's own effects stay in program order", () => {
  for (let seed = 0; seed < 20; seed++) {
    const seen = Sim.run(three, { seed, world: notes }).world.seen;
    for (const name of ["a", "b", "c"]) {
      assert.deepEqual(
        seen.filter((s) => s.startsWith(name)),
        [0, 1, 2].map((i) => `${name}${i}`),
      );
    }
  }
});

test("sim: two fibers joining each other are reported as a deadlock", () => {
  const program = Kyoot.gen(function* () {
    const fibers: Sim.Fiber<unknown, unknown>[] = [];
    const waitFor = (i: number) =>
      Kyoot.gen(function* () {
        yield* Sim.sleep(1);
        return yield* Sim.join(fibers[i]!);
      });
    fibers.push(yield* Sim.fork(waitFor(1), { name: "left" }));
    fibers.push(yield* Sim.fork(waitFor(0), { name: "right" }));
    return yield* Sim.join(fibers[0]!);
  });
  const r = Sim.run(program, { seed: 3 });
  assert.equal(r.exit.ok, false);
  assert.ok(!r.exit.ok && r.exit.cause._tag === "Deadlock");
  assert.match(
    Sim.showExit(r.exit),
    /main waits for left; left waits for right; right waits for left/,
  );
});

test("sim: a livelock stops at maxSteps", () => {
  const spin = Kyoot.gen(function* () {
    while (true) yield* Sim.yieldNow;
  });
  const r = Sim.run(spin, { seed: 0, maxSteps: 50 });
  assert.deepEqual(r.exit, { ok: false, cause: { _tag: "StepLimit", steps: 51 } });
});

test("sim: virtual time jumps to the next sleeper and now reads it", () => {
  const program = Kyoot.gen(function* () {
    const slow = yield* Sim.fork(Sim.sleep(3_600_000).map(() => "slow"));
    const fast = yield* Sim.fork(Sim.sleep(1_000).flatMap(() => Sim.now));
    return [yield* Sim.join(fast), yield* Sim.join(slow), yield* Sim.now];
  });
  const r = Sim.run(program, { seed: 1 });
  assert.deepEqual(r.exit, { ok: true, value: [1_000, "slow", 3_600_000] });
  assert.equal(r.now, 3_600_000);
});

test("sim: interrupt runs finalizers, including effects inside them, then join reports it", () => {
  const program = Kyoot.gen(function* () {
    const child = yield* Sim.fork(
      Kyoot.gen(function* () {
        try {
          yield* Note("started");
          yield* Sim.sleep(60_000);
          yield* Note("never");
        } finally {
          yield* Sim.sleep(5);
          yield* Note("cleaned up");
        }
      }),
    );
    yield* Sim.sleep(1_000);
    yield* Sim.interrupt(child);
    yield* Note("after interrupt");
    return yield* Sim.wait(child);
  });
  for (let seed = 0; seed < 10; seed++) {
    const r = Sim.run(program, { seed, world: notes });
    assert.deepEqual(r.world.seen, ["started", "cleaned up", "after interrupt"]);
    assert.deepEqual(r.exit, { ok: true, value: { ok: false, cause: { _tag: "Interrupted" } } });
    assert.equal(r.now, 1_005);
  }
});

test("sim: when a fiber ends, its unfinished children are interrupted before it counts as done", () => {
  const guarded = (name: string) =>
    Kyoot.gen(function* () {
      try {
        yield* Note(`${name} up`);
        yield* Sim.sleep(10_000);
      } finally {
        yield* Note(`${name} cleanup`);
      }
    });
  const child = Kyoot.gen(function* () {
    yield* Sim.fork(Sim.fork(guarded("grandchild")).flatMap(() => Sim.sleep(10_000)));
    yield* Sim.fork(guarded("sibling"));
    yield* Sim.sleep(1);
    return "child done";
  });
  const program = Kyoot.gen(function* () {
    const c = yield* Sim.fork(child);
    const value = yield* Sim.join(c);
    yield* Note(`joined: ${value}`);
    return value;
  });
  for (let seed = 0; seed < 10; seed++) {
    const r = Sim.run(program, { seed, world: notes });
    assert.deepEqual(r.exit, { ok: true, value: "child done" });
    assert.deepEqual([...r.world.seen].sort(), [
      "grandchild cleanup",
      "grandchild up",
      "joined: child done",
      "sibling cleanup",
      "sibling up",
    ]);
    assert.equal(r.world.seen.at(-1), "joined: child done");
    assert.equal(r.now, 1);
  }
});

test("sim: main ending interrupts everything it left running", () => {
  const program = Kyoot.gen(function* () {
    yield* Sim.fork(ensuring(Sim.sleep(1_000_000), Note("background stopped")));
    return "main";
  });
  const r = Sim.run(program, { seed: 0, world: notes });
  assert.deepEqual(r.exit, { ok: true, value: "main" });
  assert.deepEqual(r.world.seen, ["background stopped"]);
  assert.equal(r.now, 0);
});

class Boom {
  readonly _tag = "Boom";
}

test("sim: join re-fails a child's failure and re-throws its defect", () => {
  const failing = Sim.fork(Fail.fail(new Boom())).flatMap(Sim.join);
  const failed = Sim.run(failing, { seed: 0 });
  assert.ok(!failed.exit.ok && failed.exit.cause._tag === "Fail");
  assert.ok(
    !failed.exit.ok && failed.exit.cause._tag === "Fail" && failed.exit.cause.error instanceof Boom,
  );

  const oops = new Error("oops");
  const throwing = Kyoot.gen(function* () {
    const f = yield* Sim.fork(
      Kyoot.gen(function* () {
        yield* Sim.yieldNow;
        throw oops;
      }),
    );
    return yield* Sim.join(f);
  });
  assert.deepEqual(Sim.run(throwing, { seed: 0 }).exit, {
    ok: false,
    cause: { _tag: "Defect", defect: oops },
  });
});

test("sim: timeout fails after the deadline in virtual time and interrupts the work", () => {
  const slow = ensuring(
    Sim.sleep(3_600_000).map(() => "late"),
    Note("work stopped"),
  );
  const r = Sim.run(Fail.run(Sim.timeout(5_000, slow)), { seed: 0, world: notes });
  assert.ok(r.exit.ok && !r.exit.value.ok && r.exit.value.cause._tag === "Fail");
  assert.ok(
    r.exit.ok &&
      !r.exit.value.ok &&
      r.exit.value.cause._tag === "Fail" &&
      r.exit.value.cause.error instanceof Sim.Timeout,
  );
  assert.deepEqual(r.world.seen, ["work stopped"]);
  assert.equal(r.now, 5_000);

  const quick = Sim.run(
    Sim.timeout(
      5_000,
      Sim.sleep(100).map(() => "fast"),
    ),
    { seed: 0 },
  );
  assert.deepEqual(quick.exit, { ok: true, value: "fast" });
  assert.equal(quick.now, 100);
});

test("sim: world responders can delay, throw, and draw seeded randomness", () => {
  const Flaky = effect<void, number>()("io/flaky");
  const program = Kyoot.gen(function* () {
    try {
      return yield* Flaky();
    } catch (e) {
      return (e as Error).message;
    }
  });
  const world = () => ({
    "io/flaky": (_: void, io: Sim.IoContext) => {
      if (io.random() < 0.5) throw new Error("connection reset");
      return Sim.delay(250, 42);
    },
  });
  const results = new Set<unknown>();
  for (let seed = 0; seed < 20; seed++) {
    const r = Sim.run(program, { seed, world });
    assert.ok(r.exit.ok);
    results.add(r.exit.value);
    if (r.exit.value === 42) assert.equal(r.now, 250);
  }
  assert.deepEqual([...results].sort(), [42, "connection reset"]);
});

test("sim: the existing random effect is answered from the seed", () => {
  const roll = Random.int(1_000_000);
  const a = Sim.run(roll, { seed: 5 });
  assert.deepEqual(Sim.run(roll, { seed: 5 }).exit, a.exit);
  assert.notDeepEqual(Sim.run(roll, { seed: 6 }).exit, a.exit);
});

test("sim: an effect no one answers is raised in the fiber that performed it", () => {
  const Mystery = effect<void, number>()("mystery");
  const r = Sim.run(Sim.fork(Mystery() as never).flatMap(Sim.wait), { seed: 0 });
  assert.ok(r.exit.ok && !r.exit.value.ok && r.exit.value.cause._tag === "Defect");
});

test("demo: explore finds the ticket oversell, replays it, and passes the fix", () => {
  assert.deepEqual(Sim.run(Tickets.oneAfterTheOther, { seed: 0, world: Tickets.world }).exit, {
    ok: true,
    value: ["alice: got a ticket", "bob: sold out"],
  });
  const found = Sim.explore(Tickets.atTheSameTime, {
    seeds: 1000,
    world: Tickets.world,
    check: Tickets.noOversell,
  });
  assert.equal(found.ok, false);
  if (found.ok) return;
  assert.match(found.reason, /sold 1 ticket to 2 fans/);
  const replay = Sim.run(Tickets.atTheSameTime, { seed: found.seed, world: Tickets.world });
  assert.equal(Sim.format(replay.trace), Sim.format(found.result.trace));
  const fixed = Sim.explore(Tickets.atTheSameTimeSafely, {
    seeds: 1000,
    world: Tickets.world,
    check: Tickets.noOversell,
  });
  assert.deepEqual(fixed, { ok: true, runs: 1000 });
});

test("demo: virtual time finds the double charge behind a timeout and retry", () => {
  const options = { seeds: 500, world: Payments.gateway, check: Payments.chargedOnce };
  const found = Sim.explore(Payments.naive, options);
  assert.equal(found.ok, false);
  assert.ok(!found.ok && found.result.now >= 10_000);
  assert.deepEqual(Sim.explore(Payments.safe, options), { ok: true, runs: 500 });
});
