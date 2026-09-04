import { Session } from "node:inspector/promises";
import type { HeapProfiler } from "node:inspector";
import { Async, Kyoot, type AsyncOp, type Kyoot as Program } from "kyoot";

const numberArgument = (name: string, fallback: number): number => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument === undefined) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
};

const items = numberArgument("items", 100);
const samples = numberArgument("samples", 10);
const timingRuns = numberArgument("runs", 1_000);
const repeats = numberArgument("repeat", 3);

const values = Array.from({ length: items }, (_, index) => index);
const expected = (items * (items - 1)) / 2;

const separate = Kyoot.gen(function* () {
  let sum = 0;
  for (const value of values) {
    sum += yield* Async.fromPromise(() => Promise.resolve(value));
  }
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

type Scenario = {
  readonly description: string;
  readonly run: () => Promise<void>;
};

const check = (name: string, program: Program<number, { async: AsyncOp }>) => async () => {
  const value = await Kyoot.runPromise(program);
  if (value !== expected) throw new Error(`${name} returned ${value}`);
};

const scenarios = {
  separate: {
    description: `${items} × yield* Async.fromPromise (before)`,
    run: check("separate", separate),
  },
  reduce: {
    description: `one Async.reducePromise over ${items} values (after)`,
    run: check("reduce", reduced),
  },
  map: {
    description: `one Async.mapPromise over ${items} values (after)`,
    run: check("map", mapped),
  },
  forEach: {
    description: `one Async.forEachPromise over ${items} values (after)`,
    run: check("forEach", forEached),
  },
} satisfies Record<string, Scenario>;

type ScenarioName = keyof typeof scenarios;
const names = Object.keys(scenarios) as ScenarioName[];

const median = (numbers: readonly number[]): number => {
  const ordered = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
};

const formatBytes = (bytes: number): string => `${Math.round(bytes).toLocaleString("en-US")} B`;
const formatTime = (nanoseconds: number): string =>
  nanoseconds < 1_000
    ? `${nanoseconds.toFixed(0)} ns`
    : nanoseconds < 1_000_000
      ? `${(nanoseconds / 1_000).toFixed(2)} µs`
      : `${(nanoseconds / 1_000_000).toFixed(2)} ms`;

const time = async (run: Scenario["run"]): Promise<number> => {
  for (let index = 0; index < 100; index++) await run();
  const start = process.hrtime.bigint();
  for (let index = 0; index < timingRuns; index++) await run();
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

const sample = async (run: Scenario["run"]): Promise<number> => {
  globalThis.gc?.();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run();
  const { profile } = await session.post("HeapProfiler.stopSampling");
  return totalBytes(profile);
};

const measure = async (run: Scenario["run"]) => {
  const baseline: number[] = [];
  for (let index = 0; index < samples; index++) baseline.push(await sample(async () => {}));
  const measured: number[] = [];
  for (let index = 0; index < samples; index++) measured.push(await sample(run));
  const floor = median(baseline);
  return {
    elapsed: await time(run),
    bytes: Math.max(0, median(measured) - floor),
  };
};

console.log(
  `Node ${process.versions.node}; ${items} promise waits per run; ${timingRuns} timing runs; ${samples} allocation samples`,
);

for (let repeat = 1; repeat <= repeats; repeat++) {
  console.log(`\nrun ${repeat}`);
  console.log("Scenario       steady time   sampled bytes/run   sampled bytes/item");
  for (const name of names) {
    const { elapsed, bytes } = await measure(scenarios[name].run);
    console.log(
      `${name.padEnd(14)} ${formatTime(elapsed).padStart(11)}   ${formatBytes(bytes).padStart(17)}   ${formatBytes(bytes / items).padStart(18)}`,
    );
  }
}

session.disconnect();

console.log("\nScenario boundaries:");
for (const name of names) console.log(`- ${name}: ${scenarios[name].description}`);
