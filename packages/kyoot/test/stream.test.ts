import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Emit, Kyoot } from "../src/index.ts";

test("Emit.fromIterable + map + run", () => {
  const r = Kyoot.runSync(
    Emit.fromIterable([1, 2, 3]).pipe(
      Emit.map((n: number) => n * 10),
      Emit.run,
    ),
  );
  assert.deepEqual(r, [undefined, [10, 20, 30]]);
});

test("Emit.forEach with an effectful callback", async () => {
  const seen: string[] = [];
  await Kyoot.runPromise(
    Emit.fromIterable(["a", "b"]).pipe(
      Emit.forEach((s: string) => Clock.sleep(1).map(() => void seen.push(s))),
    ),
  );
  assert.deepEqual(seen, ["a", "b"]);
});

async function* source(n: number) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 1));
    yield i;
  }
}

test("Emit.fromAsyncIterable → toAsyncIterable round trip", async () => {
  const out: number[] = [];
  for await (const x of Emit.toAsyncIterable(Emit.fromAsyncIterable(source(4)))) out.push(x);
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test("toAsyncIterable: breaking early interrupts the producer", async () => {
  let produced = 0;
  const stream = Emit.fromAsyncIterable(
    (async function* () {
      while (true) {
        await new Promise((r) => setTimeout(r, 1));
        produced++;
        yield produced;
      }
    })(),
  );
  for await (const x of Emit.toAsyncIterable(stream)) if (x >= 3) break;
  await new Promise((r) => setTimeout(r, 30));
  const at = produced;
  await new Promise((r) => setTimeout(r, 30));
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
