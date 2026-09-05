import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Emit, InterruptedError, Kyoot, runFiber } from "../src/index.ts";

const deferred = <A>() => {
  let resolve = (_value: A | PromiseLike<A>): void => {};
  let reject = (_reason?: unknown): void => {};
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

test("Emit.fromIterable + map + run", () => {
  const r = Kyoot.runSync(
    Emit.fromIterable([1, 2, 3]).pipe(
      Emit.map((n: number) => n * 10),
      Emit.collect,
    ),
  );
  assert.deepEqual(r, [undefined, [10, 20, 30]]);
});

test("Emit.forEach with an effectful callback", () => {
  const seen: string[] = [];
  const r = Kyoot.runSync(
    Emit.fromIterable(["a", "b"]).pipe(
      Emit.forEach((s: string) => Clock.sleep(1).map(() => void seen.push(s))),
      Clock.virtual,
    ),
  );
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(r, [undefined, 2]);
});

test("Emit.forEach owns a returned promise before a sync edge rejects async work", async () => {
  const promise = Promise.reject(new Error("late callback failure"));
  let unhandled = false;
  const onUnhandled = () => (unhandled = true);
  process.once("unhandledRejection", onUnhandled);

  assert.throws(
    () => Kyoot.runSync(Emit.value(1).pipe(Emit.forEach(() => promise)) as never),
    /runSync encountered unhandled effect 'async'/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, false);
});

async function* source(n: number) {
  for (let i = 0; i < n; i++) yield i;
}

test("Emit.fromAsyncIterable → toAsyncIterable round trip", async () => {
  const out: number[] = [];
  for await (const x of Emit.toAsyncIterable(Emit.fromAsyncIterable(source(4)))) out.push(x);
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test("fromAsyncIterable removes settled abort listeners", async () => {
  const count = 10;
  let next = 0;
  let returns = 0;
  let finish = (_r: IteratorResult<number>) => {};
  let waiting = () => {};
  const wait = new Promise<void>((resolve) => (waiting = resolve));
  const it: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (next++ < count) return Promise.resolve({ value: next, done: false });
      waiting();
      return new Promise((resolve) => (finish = resolve));
    },
    return() {
      returns++;
      finish({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  const fiber = runFiber(Emit.fromAsyncIterable(it).pipe(Emit.discard));
  await wait;
  fiber.interrupt();
  await assert.rejects(fiber.promise, (e) => e instanceof InterruptedError);
  assert.equal(returns, 1);
});

test("fromAsyncIterable awaits one rejected return while interruption still wins", async () => {
  const started = deferred<void>();
  const returned = deferred<IteratorResult<number>>();
  const closeError = new Error("close failed");
  let returns = 0;
  const it: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      started.resolve(undefined);
      return new Promise(() => {});
    },
    return() {
      returns++;
      return returned.promise;
    },
  };
  const fiber = runFiber(Emit.fromAsyncIterable(it).pipe(Emit.discard));
  await started.promise;
  fiber.interrupt();
  await Promise.resolve();
  assert.equal(returns, 1);
  returned.reject(closeError);
  await assert.rejects(fiber.promise, (e) => e instanceof InterruptedError);
  assert.equal(returns, 1);
});

test("toAsyncIterable: breaking early interrupts the producer", async () => {
  let produced = 0;
  const stream = Emit.fromAsyncIterable(
    (async function* () {
      while (true) yield ++produced;
    })(),
  );
  for await (const x of Emit.toAsyncIterable(stream, { buffer: 1 })) if (x >= 3) break;
  const at = produced;
  await Promise.resolve();
  assert.ok(at <= 4, "at most the in-flight item after the break");
  assert.equal(produced, at, "and nothing after that");
});

test("toAsyncIterable: a defect in the producer rejects the consumer", async () => {
  const boom = new Error("boom");
  const stream = Emit.fromIterable([1]).map(() => {
    throw boom;
  });
  await assert.rejects(
    (async () => {
      for await (const _ of Emit.toAsyncIterable(stream)) void _;
    })(),
    (e) => e === boom,
  );
});

test("toAsyncIterable: the producer runs at most `buffer` items ahead", async () => {
  let produced = 0;
  const stream = Kyoot.gen(function* () {
    for (let i = 0; i < 50; i++) {
      produced++;
      yield* Emit.value(i);
    }
  });
  let consumed = 0;
  let maxAhead = 0;
  for await (const _ of Emit.toAsyncIterable(stream, { buffer: 3 })) {
    consumed++;
    maxAhead = Math.max(maxAhead, produced - consumed);
    await Promise.resolve();
  }
  assert.equal(consumed, 50);
  assert.equal(produced, 50);
  assert.ok(maxAhead <= 3, `producer ran ${maxAhead} ahead`);
});

test("toAsyncIterable: concurrent producers wait in FIFO order when the buffer is full", async () => {
  const stream = Kyoot.gen(function* () {
    yield* Async.all([Emit.value(1), Emit.value(2), Emit.value(3), Emit.value(4)]);
  });
  const out: number[] = [];
  for await (const value of Emit.toAsyncIterable(stream, { buffer: 1 })) out.push(value);
  assert.deepEqual(out, [1, 2, 3, 4]);
});

test("toAsyncIterable: simultaneous next calls each receive a value", async () => {
  const release = deferred<void>();
  const stream = Kyoot.gen(function* () {
    yield* Async.fromPromise(() => release.promise);
    yield* Emit.value(1);
    yield* Emit.value(2);
  });
  const iterator = Emit.toAsyncIterable(stream, { buffer: 1 })[Symbol.asyncIterator]();
  const first = iterator.next();
  const second = iterator.next();
  release.resolve(undefined);
  assert.deepEqual(await Promise.all([first, second]), [
    { value: 1, done: false },
    { value: 2, done: false },
  ]);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test("toAsyncIterable: breaking while the producer is parked interrupts it", async () => {
  let produced = 0;
  const stream = Kyoot.gen(function* () {
    while (true) {
      produced++;
      yield* Emit.value(produced);
    }
  });
  for await (const x of Emit.toAsyncIterable(stream, { buffer: 2 })) if (x >= 5) break;
  const at = produced;
  assert.equal(produced, at);
  assert.ok(at <= 8);
});

test("toAsyncIterable: return interrupts a producer waiting for buffer space", async () => {
  let stopped = false;
  const stream = Kyoot.gen(function* () {
    try {
      for (let i = 0; ; i++) yield* Emit.value(i);
    } finally {
      stopped = true;
    }
  });
  const iterator = Emit.toAsyncIterable(stream, { buffer: 1 })[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: 0, done: false });
  assert.deepEqual(await iterator.return!(), { value: undefined, done: true });
  assert.equal(stopped, true);
});

test("toAsyncIterable: return settles readers after downstream abandons a delivered next", async () => {
  let stopped = false;
  const stream = Kyoot.gen(function* () {
    try {
      yield* Emit.value(0);
      yield* Async.never;
    } finally {
      stopped = true;
    }
  });
  const iterator = Emit.toAsyncIterable(stream, { buffer: 1 })[Symbol.asyncIterator]();
  const delivered = iterator.next();
  assert.deepEqual(await delivered, { value: 0, done: false });
  const waiting = iterator.next();
  const closing = iterator.return!();
  assert.deepEqual(await waiting, { value: undefined, done: true });
  assert.deepEqual(await closing, { value: undefined, done: true });
  assert.equal(stopped, true);
});

test("toAsyncIterable: a producer that throws undefined rejects the consumer", async () => {
  const stream = Kyoot.gen(function* () {
    throw undefined;
  });
  await assert.rejects(
    (async () => {
      for await (const _ of Emit.toAsyncIterable(stream)) void _;
    })(),
    (e) => e === undefined,
  );
});

test("toAsyncIterable: a defect after an emission delivers the item, then rejects", async () => {
  const stream = Kyoot.gen(function* () {
    yield* Emit.value(1);
    throw undefined;
  });
  const out: number[] = [];
  await assert.rejects(
    (async () => {
      for await (const x of Emit.toAsyncIterable(stream)) out.push(x);
    })(),
    (e) => e === undefined,
  );
  assert.deepEqual(out, [1]);
});

test("toAsyncIterable: an empty stream still completes", async () => {
  const stream = Emit.toAsyncIterable(Kyoot.gen(function* () {}));
  assert.deepEqual(await stream[Symbol.asyncIterator]().next(), { value: undefined, done: true });
});

for (const capacity of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
  test(`toAsyncIterable: rejects invalid buffer capacity ${String(capacity)}`, () => {
    assert.throws(
      () => Emit.toAsyncIterable(Emit.fromIterable([1]), { buffer: capacity }),
      (e) => e instanceof RangeError,
    );
  });
}

for (const defect of [null, 0, false, ""]) {
  test(`toAsyncIterable: a producer that throws ${JSON.stringify(defect)} rejects the consumer`, async () => {
    const stream = Kyoot.gen(function* () {
      throw defect;
    });
    await assert.rejects(
      (async () => {
        for await (const _ of Emit.toAsyncIterable(stream)) void _;
      })(),
      (e) => Object.is(e, defect),
    );
  });
}
