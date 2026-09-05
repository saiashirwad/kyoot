import { Async, Emit, Kyoot } from "kyoot";
import { heavy, measure } from "./bench-util.ts";

const items = heavy ? 4_000 : 400;
const concurrency = heavy ? 16 : 4;
const buffer = heavy ? 32 : 4;

const emitAndConsume = async (): Promise<void> => {
  const stream = Kyoot.gen(function* () {
    yield* Async.all(
      Array.from({ length: items }, (_, index) => Emit.value(index)),
      { concurrency },
    );
  });
  let sum = 0;
  let count = 0;
  for await (const value of Emit.toAsyncIterable(stream, { buffer })) {
    sum += value;
    count++;
    // A microtask lets producer and consumer contend for the bounded buffer.
    if (count % 8 === 0) await Promise.resolve();
  }
  if (count !== items || sum !== (items * (items - 1)) / 2) {
    throw new Error(`stream returned ${count} items with sum ${sum}`);
  }
};

console.log(`stream: ${items} items; concurrency=${concurrency}; buffer=${buffer}`);
await measure("bounded concurrent emit/consume", heavy ? 50 : 6, emitAndConsume);
