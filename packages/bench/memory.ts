import { Async, Kyoot, Resource } from "kyoot";
import { bytes, heavy } from "./bench-util.ts";

if (globalThis.gc === undefined) {
  throw new Error("run this benchmark with node --expose-gc");
}

const rounds = heavy ? 150 : 20;
const resources = heavy ? 128 : 24;

const workload = async (): Promise<void> => {
  const program = Async.all(
    Array.from({ length: resources }, () =>
      Resource.acquire(
        () => new Uint8Array(8 * 1024),
        () => {},
      ).pipe(Resource.run),
    ),
    { concurrency: 8 },
  );
  const values = await Kyoot.runPromise(program);
  if (values.length !== resources)
    throw new Error(`retained-memory workload returned ${values.length}`);
};

globalThis.gc();
const before = process.memoryUsage();
const started = process.hrtime.bigint();
for (let index = 0; index < rounds; index++) await workload();
globalThis.gc();
const after = process.memoryUsage();
const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;

console.log(`retained memory after ${rounds} runs of ${resources} scoped allocations`);
console.log(`time: ${elapsed.toFixed(1)} ms`);
console.log(`heap retained: ${bytes(after.heapUsed - before.heapUsed)}`);
console.log(`array-buffer retained: ${bytes(after.arrayBuffers - before.arrayBuffers)}`);
