import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, Kyoot } from "../src/index.ts";
import * as Emit from "../src/effects/emit.ts";
import * as Env from "../src/effects/env.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Log from "../src/effects/log.ts";
import * as Random from "../src/effects/random.ts";
import * as Resource from "../src/effects/resource.ts";
import * as Var from "../src/effects/var.ts";
import { Async, Clock, InterruptedError, runPromise } from "../src/async/index.ts";
const nap = (ms: number) => Clock.sleep(ms).pipe(Clock.live);

const deferred = <A>() => {
  let resolve = (_value: A | PromiseLike<A>): void => {};
  let reject = (_error?: unknown): void => {};
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

test("fromPromise resolves through runPromise", async () => {
  const r = await runPromise(Async.fromPromise(() => Promise.resolve(42)));
  assert.equal(r, 42);
});

test("fromPromise exposes an AbortSignal from day one", async () => {
  const r = await runPromise(Async.fromPromise((signal) => Promise.resolve(signal.aborted)));
  assert.equal(r, false);
});

test("fromPromise sends a synchronous throw to Fail.run as a defect", async () => {
  const boom = new Error("boom");
  const r = await runPromise(
    Async.fromPromise(() => {
      throw boom;
    }).pipe(Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Defect" && r.cause.defect === boom);
});

test("fork/join: a fiber is an independent interpreter loop", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* nap(10);
        return "fiber done";
      }),
    );
    return yield* Async.join(fiber);
  });
  assert.equal(await runPromise(prog), "fiber done");
});

test("concurrent fibers may yield the same node", async () => {
  const gate = deferred<number>();
  const shared = Async.fromPromise(() => gate.promise);
  const program = Kyoot.gen(function* () {
    const left = yield* Async.fork(
      Kyoot.gen(function* () {
        return `left:${yield* shared}`;
      }),
    );
    const right = yield* Async.fork(
      Kyoot.gen(function* () {
        return `right:${yield* shared}`;
      }),
    );
    yield* Async.fromPromise(() => {
      gate.resolve(7);
      return Promise.resolve();
    });
    return [yield* Async.join(left), yield* Async.join(right)];
  });

  assert.deepEqual(await runPromise(program), ["left:7", "right:7"]);
});

test("fiber.await returns a Result instead of throwing", async () => {
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      nap(1).map(() => {
        throw boom;
      }),
    );
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.cause._tag === "Defect" && r.cause.defect, boom);
});

test("race: first to complete wins", async () => {
  const slow = nap(50).map(() => "slow");
  const fast = nap(5).map(() => "fast");
  assert.equal(await runPromise(Async.race(slow, fast)), "fast");
});

test("timeout: a slow computation fails with a typed Timeout", async () => {
  const r = await runPromise(Async.timeout(5, nap(50)).pipe(Fail.run));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Async.Timeout);
});

test("timeout: a fast computation wins", async () => {
  const r = await runPromise(
    Async.timeout(
      50,
      nap(5).map(() => "quick"),
    ).pipe(Fail.orThrow),
  );
  assert.equal(r, "quick");
});

test("timeout inside a gen resumes the surrounding computation", async () => {
  const prog = Kyoot.gen(function* () {
    const r = yield* Async.timeout(
      50,
      nap(5).map(() => "quick"),
    ).pipe(Fail.run);
    return r.ok ? `${r.value} again` : "failed";
  });
  assert.equal(await runPromise(prog), "quick again");
});

test("runPromise surfaces defects as rejections", async () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* nap(1);
    throw boom;
  });
  await assert.rejects(runPromise(k), (e) => e === boom);
});

test("runPromise on an unhandled non-async effect rejects loudly", async () => {
  const k = Fail.fail("still pending");
  await assert.rejects(
    runPromise(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'fail'"),
  );
});

test("runSync rejects an async op at runtime", () => {
  assert.throws(
    () => Kyoot.runSync(Async.fromPromise(() => Promise.resolve()) as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'async'"),
  );
});

test("interrupt: finalizers run and await reports Interrupted", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
        yield* nap(10_000);
        return "unreachable";
      }).pipe(Resource.run),
    );
    yield* Async.interrupt(fiber);
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["release"]);
});

test("structured concurrency: a completed parent interrupts its children", async () => {
  const events: string[] = [];
  await runPromise(
    Kyoot.gen(function* () {
      yield* Async.fork(
        Kyoot.gen(function* () {
          yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
          yield* nap(10_000);
        }).pipe(Resource.run),
      );
      return "parent done";
    }),
  );
  assert.deepEqual(events, ["release"]);
});
for (const timing of ["before", "after"] as const) {
  for (const completion of ["resolve", "reject"] as const) {
    test(`interrupt: stale wait may ${completion} ${timing} async cleanup`, async () => {
      const originalStarted = deferred<void>();
      const cleanupStarted = deferred<void>();
      const original = deferred<string>();
      const cleanup = deferred<void>();
      const events: string[] = [];
      const staleError = new Error("stale");

      const child = Kyoot.gen(function* () {
        yield* Resource.acquire(Kyoot.succeed("resource"), () =>
          Async.fromPromise(() => {
            events.push("cleanup start");
            cleanupStarted.resolve(undefined);
            return cleanup.promise.then(() => void events.push("cleanup end"));
          }),
        );
        return yield* Async.fromPromise(() => {
          originalStarted.resolve(undefined);
          return original.promise;
        });
      }).pipe(Resource.run);

      const result = await runPromise(
        Kyoot.gen(function* () {
          const fiber = yield* Async.fork(child);
          yield* Async.fromPromise(() => originalStarted.promise);
          // Interrupt waits for the finalizer, which waits for us: interrupt from a helper fiber.
          yield* Async.fork(Async.interrupt(fiber));
          yield* Async.fromPromise(() => cleanupStarted.promise);

          if (timing === "before") {
            if (completion === "resolve") original.resolve("stale");
            else original.reject(staleError);
            yield* Async.fromPromise(() => Promise.resolve());
          }

          cleanup.resolve(undefined);
          const exit = yield* Async.wait(fiber);

          if (timing === "after") {
            if (completion === "resolve") original.resolve("stale");
            else original.reject(staleError);
            yield* Async.fromPromise(() => Promise.resolve());
          }
          return exit;
        }),
      );

      assert.ok(!result.ok && result.cause._tag === "Interrupted");
      assert.deepEqual(events, ["cleanup start", "cleanup end"]);
    });
  }
}

test("all: results come back in input order, not completion order", async () => {
  const slow = nap(20).map(() => "slow");
  const fast = nap(5).map(() => "fast");
  assert.deepEqual(await runPromise(Async.all([slow, fast])), ["slow", "fast"]);
});

test("all: branches run concurrently", async () => {
  const clock = Clock.manual();
  const events: string[] = [];
  const branch = (tag: string, ms: number) =>
    Kyoot.gen(function* () {
      events.push(`start ${tag}`);
      yield* Clock.sleep(ms);
      events.push(`end ${tag}`);
    });
  const p = runPromise(
    Async.all([branch("a", 20), branch("b", 10)], { provide: (k) => k.pipe(clock.handler) }),
  );
  await clock.advance(10);
  assert.deepEqual(events, ["start a", "start b", "end b"]);
  await clock.advance(10);
  await p;
  assert.deepEqual(events, ["start a", "start b", "end b", "end a"]);
});

test("all: empty array resolves immediately", async () => {
  assert.deepEqual(await runPromise(Async.all([])), []);
});

test("all: NaN concurrency runs every branch", async () => {
  const ks = [1, 2, 3].map((n) => Async.fromPromise(() => Promise.resolve(n)));
  assert.deepEqual(await runPromise(Async.all(ks, { concurrency: NaN })), [1, 2, 3]);
});

test("all: first failure interrupts the rest and runs their finalizers", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
    yield* nap(10_000);
    return "unreachable";
  }).pipe(Resource.run);
  const failing = nap(5).map(() => {
    throw boom;
  });
  await assert.rejects(runPromise(Async.all([slow, failing])), (e) => e === boom);
  assert.deepEqual(events, ["release"]);
});

test("all: interrupting the parent interrupts every branch", async () => {
  const events: string[] = [];
  const branch = (tag: string) =>
    Kyoot.gen(function* () {
      yield* Resource.acquire(Kyoot.succeed(tag), () => events.push(`release ${tag}`));
      yield* nap(10_000);
    }).pipe(Resource.run);
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Async.all([branch("a"), branch("b")]));
    yield* nap(10);
    yield* Async.interrupt(fiber);
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events.sort(), ["release a", "release b"]);
});

test("race interrupts the loser and runs its finalizers", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("slow"), () => events.push("release slow"));
    yield* nap(10_000);
    return "slow";
  }).pipe(Resource.run);
  const fast = nap(5).map(() => "fast");
  const r = await runPromise(Async.race(slow, fast));
  assert.equal(r, "fast");
  assert.deepEqual(events, ["release slow"]);
});

test("timeout interrupts the branch and runs its finalizers", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
    yield* nap(10_000);
    return "unreachable";
  }).pipe(Resource.run);
  const r = await runPromise(Async.timeout(5, slow).pipe(Fail.run));
  assert.equal(r.ok, false);
  assert.deepEqual(events, ["release"]);
});

test("fromPromise's signal fires on interruption", async () => {
  let sawAbort = false;
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Async.fromPromise(
        (signal) =>
          new Promise(() => {
            signal.addEventListener("abort", () => {
              sawAbort = true;
            });
          }),
      ),
    );
    yield* Async.interrupt(fiber);
    yield* Async.wait(fiber);
    return sawAbort;
  });
  assert.equal(await runPromise(prog), true);
});

test("joining an interrupted fiber interrupts the joiner", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(nap(10_000));
    yield* Async.interrupt(fiber);
    return yield* Async.join(fiber);
  });
  await assert.rejects(runPromise(prog), (e) => e instanceof InterruptedError);
});

test("joining an interrupted fiber is an interruption, not a defect a handler catches", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(nap(10_000));
    yield* Async.interrupt(fiber);
    try {
      return yield* Async.join(fiber);
    } finally {
      events.push("finally");
    }
  }).pipe(Fail.run);
  await assert.rejects(runPromise(prog), (e) => e instanceof InterruptedError);
  assert.deepEqual(events, ["finally"]);
});

test("runPromise on an unhandled effect runs the program's cleanup before it rejects", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("conn"), () =>
      nap(1).map(() => void events.push("release")),
    );
    yield* Fail.fail("still pending");
  }).pipe(Resource.run);
  await assert.rejects(
    runPromise(prog as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'fail'"),
  );
  assert.deepEqual(events, ["release"]);
});

test("all: concurrency limit bounds in-flight fibers and keeps order", async () => {
  let inflight = 0;
  let peak = 0;
  const task = (n: number) =>
    Async.fromPromise(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return n;
    });
  const r = await runPromise(Async.all([1, 2, 3, 4, 5].map(task), { concurrency: 2 }));
  assert.deepEqual(r, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test("all: a failure stops scheduling the rest", async () => {
  let started = 0;
  const boom = new Error("boom");
  const task = (fail: boolean) =>
    Async.fromPromise(async () => {
      started++;
      await new Promise((r) => setTimeout(r, 2));
      if (fail) throw boom;
    });
  await assert.rejects(
    runPromise(Async.all([task(true), task(false), task(false), task(false)], { concurrency: 1 })),
    (e) => e === boom,
  );
  assert.equal(started, 1);
});

test("fork: a fiber installs the Env it needs", async () => {
  const Name = Env.tag<string>()("name");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Name.get()
        .map((n) => `hi ${n}`)
        .pipe(Name.provide("kyoot")),
    );
    return yield* Async.join(fiber);
  });
  assert.equal(await runPromise(prog), "hi kyoot");
});

test("fork: a fiber collects its own Log entries", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Log.info("child")
        .map(() => 1)
        .pipe(Log.collect),
    );
    return yield* Async.join(fiber);
  });
  const [n, entries] = await runPromise(prog);
  assert.equal(n, 1);
  assert.deepEqual(
    entries.map((e) => e.message),
    ["child"],
  );
});

test("all: each fiber collects what it emits", async () => {
  const r = await runPromise(
    Async.all([Emit.value(1).pipe(Emit.collect), Emit.value(2).pipe(Emit.collect)]),
  );
  assert.deepEqual(
    r.map(([, emitted]) => emitted),
    [[1], [2]],
  );
});

test("fork: a fiber's Var and Random.seeded are its own", async () => {
  const Count = Var.tag<number>()("Count");
  const draw = Random.next();
  const child = Kyoot.gen(function* () {
    yield* Count.update((n) => n + 10);
    return yield* draw;
  }).pipe(Count.run(100), Random.seeded(42));
  const prog = Kyoot.gen(function* () {
    yield* Count.update((n) => n + 1);
    const fiber = yield* Async.fork(child);
    const [childDraw, childCount] = yield* Async.join(fiber);
    return { childDraw, childCount, parentDraw: yield* draw };
  }).pipe(Count.run(0), Random.seeded(42));
  const solo = Kyoot.runSync(draw.pipe(Random.seeded(42)));
  const [r, parentCount] = await runPromise(prog);
  assert.deepEqual(r, { childDraw: solo, childCount: 110, parentDraw: solo });
  assert.equal(parentCount, 1);
});

test("fork: a typed failure in the fiber crosses join as a fail op", async () => {
  class Boom {
    readonly _tag = "Boom";
  }
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* nap(1);
        return yield* Fail.fail(new Boom());
      }),
    );
    return yield* Async.join(fiber);
  }).pipe(Fail.run);
  const r = await runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Boom);
});

test("fork: fiber.await reports a typed failure as a Fail cause", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Fail.fail("nope" as const));
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "nope");
});

test("race: a failing branch that finishes first fails the race, typed", async () => {
  const r = await runPromise(
    Async.race(
      nap(50).map(() => "slow"),
      nap(1).flatMap(() => Fail.fail("fast failure" as const)),
    ).pipe(Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "fast failure");
});

test("all: a typed failure in one branch fails the whole, and the rest are interrupted", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
    yield* nap(10_000);
    return 1;
  }).pipe(Resource.run);
  const failing = nap(1).flatMap(() => Fail.fail("bad" as const));
  const r = await runPromise(Async.all([slow, failing]).pipe(Fail.run));
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "bad");
  assert.deepEqual(events, ["release"]);
});

test("fork: Resource.run inside the fiber gives it a scope of its own", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("parent"), () => events.push("release parent"));
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(Kyoot.succeed("child"), () => events.push("release child"));
        yield* nap(1);
      }).pipe(Resource.run),
    );
    yield* Async.join(fiber);
    events.push("joined");
  }).pipe(Resource.run);
  await runPromise(prog);
  assert.deepEqual(events, ["release child", "joined", "release parent"]);
});

test("fork: Clock.virtual inside the fiber makes its sleeps instant", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Clock.sleep(10_000)
        .map(() => "woke")
        .pipe(Clock.virtual),
    );
    return yield* Async.join(fiber);
  });
  assert.deepEqual(await runPromise(prog), ["woke", 10_000]);
});

test("fork: an effect nobody handles in the fiber is a defect, loudly", async () => {
  const Ask = effect<string, number>()("ask");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Ask("n?") as Kyoot<number>);
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.ok(typeof r === "object" && !r.ok && r.cause._tag === "Defect");
  assert.match(String((r.cause as { defect: Error }).defect.message), /unhandled effect 'ask'/);
});

test("fork: a typed failure still ends the fiber's own scope", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
        return yield* Fail.fail("bad" as const);
      }).pipe(Resource.run),
    );
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "bad");
  assert.deepEqual(events, ["release"]);
});

test("all: a user effect is handled inside each branch", async () => {
  const Ask = effect<string, number>()("ask");
  const ask = (q: string) => Ask(q).pipe(Ask.handle((q, resume) => resume(q.length)));
  assert.deepEqual(await runPromise(Async.all([ask("a"), ask("bb")])), [1, 2]);
});

const hotLoop = (n: number) =>
  Kyoot.gen(function* () {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += yield* Kyoot.succeed(i);
    return acc;
  });

test("scheduler: a hot loop in one fiber does not starve a sleeper", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(hotLoop(300_000).map(() => void events.push("hot done")));
    yield* nap(1);
    events.push("slept");
    yield* Async.join(fiber);
  });
  await runPromise(prog);
  assert.deepEqual(events, ["slept", "hot done"]);
});

test("scheduler: a hot loop can be interrupted", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(hotLoop(Infinity));
    yield* nap(1);
    yield* Async.interrupt(fiber);
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
});

test("scheduler: runSync never yields", () => {
  assert.equal(Kyoot.runSync(hotLoop(50_000)), (50_000 * 49_999) / 2);
});

test("scheduler: yields keep handler state and continuations", async () => {
  const prog = Kyoot.gen(function* () {
    for (let i = 0; i < 20_000; i++) yield* Log.info(String(i));
    return "done";
  }).pipe(Log.collect);
  const [a, entries] = await runPromise(prog);
  assert.equal(a, "done");
  assert.equal(entries.length, 20_000);
  assert.equal(entries[19_999]!.message, "19999");
});

test("mapPromise keeps input order and hands each callback its index", async () => {
  const seen: Array<[string, number]> = [];
  const prog = Kyoot.gen(function* () {
    return yield* Async.mapPromise(["a", "b", "c"], async (value, index) => {
      await new Promise((r) => setTimeout(r, value === "a" ? 6 : 1));
      seen.push([value, index]);
      return `${value}${index}`;
    });
  });
  assert.deepEqual(await runPromise(prog), ["a0", "b1", "c2"]);
  assert.deepEqual(seen, [
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ]);
});

test("forEachPromise runs one item at a time and returns void", async () => {
  const events: string[] = [];
  const prog = Async.forEachPromise([1, 2, 3], async (value, index) => {
    events.push(`start ${value}@${index}`);
    await new Promise((r) => setTimeout(r, 1));
    events.push(`end ${value}`);
    return value;
  });
  assert.equal(await runPromise(prog), undefined);
  assert.deepEqual(events, ["start 1@0", "end 1", "start 2@1", "end 2", "start 3@2", "end 3"]);
});

test("reducePromise threads the accumulator in order", async () => {
  const prog = Async.reducePromise(["a", "b", "c"], "", (accumulator, value, index) =>
    Promise.resolve(`${accumulator}${value}${index}`),
  );
  assert.equal(await runPromise(prog), "a0b1c2");
});

test("a rejected batch callback is a defect, like fromPromise", async () => {
  const boom = new Error("boom");
  const started: number[] = [];
  const r = await runPromise(
    Async.mapPromise([1, 2, 3], (value) => {
      started.push(value);
      return value === 2 ? Promise.reject(boom) : Promise.resolve(value);
    }).pipe(Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Defect" && r.cause.defect === boom);
  assert.deepEqual(started, [1, 2]);
});

test("Async.intercept sees one operation for a whole batch", async () => {
  let ops = 0;
  const count = Async.intercept((op, next) => (ops++, next(op)));
  await runPromise(Async.forEachPromise([1, 2, 3, 4, 5], () => Promise.resolve()).pipe(count));
  assert.equal(ops, 1);

  ops = 0;
  const separate = Kyoot.gen(function* () {
    for (const value of [1, 2, 3, 4, 5]) yield* Async.fromPromise(() => Promise.resolve(value));
  });
  await runPromise(separate.pipe(count));
  assert.equal(ops, 5);
});

test("interruption stops a batch before the next item starts", async () => {
  const started: number[] = [];
  const first = deferred<void>();
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Async.forEachPromise([1, 2, 3], async (value) => {
        started.push(value);
        if (value === 1) {
          first.resolve();
          await new Promise((r) => setTimeout(r, 5));
        }
      }),
    );
    yield* Async.fromPromise(() => first.promise);
    yield* Async.interrupt(fiber);
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(started, [1]);
});

test("a pending batch callback sees the operation's abort signal", async () => {
  let sawAbort = false;
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Async.mapPromise(
        [1],
        (_value, _index, signal) =>
          new Promise<number>(() => {
            signal.addEventListener("abort", () => {
              sawAbort = true;
            });
          }),
      ),
    );
    yield* Async.interrupt(fiber);
    yield* Async.wait(fiber);
    return sawAbort;
  });
  assert.equal(await runPromise(prog), true);
});

test("a batch takes the source's length once, so a callback cannot extend it", async () => {
  const mapValues = [1, 2];
  const forEachValues = [1, 2];
  const reduceValues = [1, 2];
  const forEached: number[] = [];
  const prog = Kyoot.gen(function* () {
    const mapped = yield* Async.mapPromise(mapValues, (value) => {
      mapValues.push(value + 10);
      return Promise.resolve(value * 2);
    });
    yield* Async.forEachPromise(forEachValues, (value) => {
      forEachValues.push(value + 10);
      forEached.push(value);
      return Promise.resolve();
    });
    const reduced = yield* Async.reducePromise(reduceValues, 0, (sum, value) => {
      reduceValues.push(value + 10);
      return Promise.resolve(sum + value);
    });
    return { mapped, reduced };
  });
  assert.deepEqual(await runPromise(prog), { mapped: [2, 4], reduced: 3 });
  assert.deepEqual(forEached, [1, 2]);
  assert.deepEqual(mapValues, [1, 2, 11, 12]);
  assert.deepEqual(forEachValues, [1, 2, 11, 12]);
  assert.deepEqual(reduceValues, [1, 2, 11, 12]);
});

test("Async.next closes the iterator when the wait is interrupted", async () => {
  let closed = false;
  const it: AsyncIterator<number> = {
    next: () => new Promise(() => {}),
    return: async () => ((closed = true), { done: true, value: undefined }),
  };
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Async.next(it));
    yield* nap(1);
    yield* Async.interrupt(fiber);
    return yield* Async.wait(fiber);
  });
  const r = await runPromise(prog);
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.equal(closed, true);
});
