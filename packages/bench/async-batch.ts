import { Session } from "node:inspector/promises";
import type { HeapProfiler } from "node:inspector";
import { Async, Kyoot, type AsyncOp, type Kyoot as Program } from "kyoot";

const items = 100;
const samples = 10;
const timingRuns = 1_000;
const repeats = 3;

const values = Array.from({ length: items }, (_, index) => index);
const expected = (items * (items - 1)) / 2;

const separate = Kyoot.gen(function* () {
  let sum = 0;
  for (const value of values) sum += yield* Async.fromPromise(() => Promise.resolve(value));
  return sum;
});

const reduced = Async.reducePromise(values, 0, (sum, value) => Promise.resolve(sum + value));

const mapped = Async.mapPromise(values, (value) => Promise.resolve(value)).map((all) =>
  all.reduce((sum, value) => sum + value, 0),
);

const forEached = Kyoot.gen(function* () {
  let sum = 0;
  yield* Async.forEachPromise(values, (value) => Promise.resolve((sum += value)));
  return sum;
});

type Run = () => Promise<void>;

const run =
  (name: string, program: Program<number, { async: AsyncOp }>): Run =>
  async () => {
    const value = await Kyoot.runPromise(program);
    if (value !== expected) throw new Error(`${name} returned ${value}`);
  };

const scenarios: ReadonlyArray<readonly [string, Run]> = [
  [`${items} × fromPromise`, run("fromPromise", separate)],
  ["reducePromise", run("reducePromise", reduced)],
  ["mapPromise", run("mapPromise", mapped)],
  ["forEachPromise", run("forEachPromise", forEached)],
];

const median = (numbers: readonly number[]): number => {
  const ordered = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
};

const formatBytes = (bytes: number): string => `${Math.round(bytes).toLocaleString("en-US")} B`;
const formatTime = (nanoseconds: number): string => `${(nanoseconds / 1_000).toFixed(2)} µs`;

const time = async (execute: Run): Promise<number> => {
  for (let index = 0; index < 100; index++) await execute();
  const start = process.hrtime.bigint();
  for (let index = 0; index < timingRuns; index++) await execute();
  return Number(process.hrtime.bigint() - start) / timingRuns;
};

const totalBytes = (profile: HeapProfiler.SamplingHeapProfile): number => {
  let bytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode): void => {
    bytes += node.selfSize;
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  return bytes;
};

const session = new Session();
session.connect();
await session.post("HeapProfiler.enable");

const sample = async (execute: Run): Promise<number> => {
  globalThis.gc?.();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await execute();
  const { profile } = await session.post("HeapProfiler.stopSampling");
  return totalBytes(profile);
};

const bytes = async (execute: Run): Promise<number> => {
  const baseline: number[] = [];
  const measured: number[] = [];
  for (let index = 0; index < samples; index++) baseline.push(await sample(async () => {}));
  for (let index = 0; index < samples; index++) measured.push(await sample(execute));
  return Math.max(0, median(measured) - median(baseline));
};

console.log(
  `Node ${process.versions.node}; ${items} promise waits per run; ${timingRuns} timing runs; ${samples} allocation samples`,
);

for (let repeat = 1; repeat <= repeats; repeat++) {
  console.log(`\nrun ${repeat}`);
  console.log("Scenario           steady time   sampled bytes/run   sampled bytes/item");
  for (const [name, execute] of scenarios) {
    const sampled = await bytes(execute);
    console.log(
      `${name.padEnd(18)} ${formatTime(await time(execute)).padStart(11)}   ${formatBytes(sampled).padStart(17)}   ${formatBytes(sampled / items).padStart(18)}`,
    );
  }
}

session.disconnect();
