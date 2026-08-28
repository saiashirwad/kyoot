import { Session } from "node:inspector/promises";
import type { HeapProfiler } from "node:inspector";
import { Async, Kyoot, type Kyoot as Program, type Row } from "kyoot";

const asyncOps = 100;
const expected = (asyncOps * (asyncOps - 1)) / 2;
const externalProfiler = process.execArgv.some(
  (arg) =>
    arg === "--cpu-prof" ||
    arg.startsWith("--cpu-prof=") ||
    arg === "--heap-prof" ||
    arg.startsWith("--heap-prof="),
);

const numberArgument = (name: string, fallback: number): number => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument === undefined) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`--${name} must be a positive integer`);
  return value;
};

const samples = numberArgument("samples", 10);
const timingRuns = numberArgument("runs", 1_000);
const requestedScenario = process.argv
  .find((value) => value.startsWith("--scenario="))
  ?.slice("--scenario=".length);
const sampling = !externalProfiler && !process.argv.includes("--no-sampling");

let sink: unknown;
const consume = (value: unknown): void => {
  sink = value;
};

function* sequence<S extends Row>(
  nodes: readonly Program<number, S>[],
): Generator<Program<unknown, S>, number, unknown> {
  let sum = 0;
  for (const node of nodes) sum += (yield* node) as number;
  return sum;
}

const programFrom = <S extends Row>(nodes: readonly Program<number, S>[]) =>
  Kyoot.gen(() => sequence(nodes));
const sharedPromise = Promise.resolve(0);
const sharedNodes = Array.from({ length: asyncOps }, () => Async.fromPromise(() => sharedPromise));
const freshNodes = Array.from({ length: asyncOps }, (_, index) =>
  Async.fromPromise(() => Promise.resolve(index)),
);
const sharedProgram = programFrom(sharedNodes);
const freshProgram = programFrom(freshNodes);
const endToEndProgram = Kyoot.gen(function* () {
  let sum = 0;
  for (let index = 0; index < asyncOps; index++) {
    sum += yield* Async.fromPromise(() => Promise.resolve(index));
  }
  return sum;
});

type Run = () => void | Promise<void>;
type Scenario = {
  readonly description: string;
  readonly run: Run;
};

const scenarios = {
  construction: {
    description: "node, payload, program, and generator-iterator construction only",
    run: () => {
      const nodes = Array.from({ length: asyncOps }, (_, index) =>
        Async.fromPromise(() => Promise.resolve(index)),
      );
      const program = programFrom(nodes);
      const iterator = sequence(nodes);
      consume({ nodes, program, iterator });
    },
  },
  "pump-shared": {
    description: "async pump over prebuilt nodes and one shared input Promise",
    run: async () => {
      const value = await Kyoot.runPromise(sharedProgram);
      if (value !== 0) throw new Error(`pump-shared returned ${value}`);
      consume(value);
    },
  },
  "pump-fresh": {
    description: "async pump over prebuilt nodes with one fresh input Promise per op",
    run: async () => {
      const value = await Kyoot.runPromise(freshProgram);
      if (value !== expected) throw new Error(`pump-fresh returned ${value}`);
      consume(value);
    },
  },
  "end-to-end": {
    description: "lazy node/payload construction, fresh input Promises, and async pump",
    run: async () => {
      const value = await Kyoot.runPromise(endToEndProgram);
      if (value !== expected) throw new Error(`end-to-end returned ${value}`);
      consume(value);
    },
  },
} satisfies Record<string, Scenario>;

type ScenarioName = keyof typeof scenarios;
const names = Object.keys(scenarios) as ScenarioName[];
if (requestedScenario !== undefined && !names.includes(requestedScenario as ScenarioName)) {
  throw new Error(`unknown scenario '${requestedScenario}'; expected one of ${names.join(", ")}`);
}
const selected = requestedScenario === undefined ? names : [requestedScenario as ScenarioName];

const execute = async (run: Run): Promise<void> => {
  const result = run();
  if (result instanceof Promise) await result;
};

const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((a, b) => a - b);
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

const time = async (run: Run): Promise<number> => {
  for (let index = 0; index < 100; index++) await execute(run);
  const start = process.hrtime.bigint();
  for (let index = 0; index < timingRuns; index++) await execute(run);
  return Number(process.hrtime.bigint() - start) / timingRuns;
};

type Site = {
  readonly functionName: string;
  readonly url: string;
  readonly line: number;
  bytes: number;
};

type Allocation = {
  readonly bytes: number;
  readonly sites: ReadonlyMap<string, Site>;
};

const collectProfile = (profile: HeapProfiler.SamplingHeapProfile): Allocation => {
  let bytes = 0;
  const sites = new Map<string, Site>();
  const visit = (node: HeapProfiler.SamplingHeapProfileNode): void => {
    bytes += node.selfSize;
    const { callFrame } = node;
    if (/\/packages\/kyoot\/src\/(?:runtime|effects\/async)\.ts$/.test(callFrame.url)) {
      const line = callFrame.lineNumber + 1;
      const key = `${callFrame.url}:${line}:${callFrame.functionName}`;
      const site = sites.get(key);
      if (site === undefined) {
        sites.set(key, {
          functionName: callFrame.functionName || "(anonymous)",
          url: callFrame.url,
          line,
          bytes: node.selfSize,
        });
      } else {
        site.bytes += node.selfSize;
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  return { bytes, sites };
};

const session = sampling ? new Session() : undefined;
if (session !== undefined) {
  session.connect();
  await session.post("HeapProfiler.enable");
}

const sample = async (run: Run): Promise<Allocation> => {
  globalThis.gc?.();
  await session!.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await execute(run);
  const { profile } = await session!.post("HeapProfiler.stopSampling");
  return collectProfile(profile);
};

const allocations = new Map<ScenarioName, readonly Allocation[]>();
let baseline: readonly number[] = [];
if (session !== undefined) {
  const measuredBaseline: number[] = [];
  for (let index = 0; index < samples; index++)
    measuredBaseline.push((await sample(() => {})).bytes);
  baseline = measuredBaseline;
  for (const name of selected) {
    const measured: Allocation[] = [];
    for (let index = 0; index < samples; index++) measured.push(await sample(scenarios[name].run));
    allocations.set(name, measured);
  }
  session.disconnect();
}

console.log(
  `Node ${process.versions.node}; ${asyncOps} sequential async ops; ${timingRuns} timing runs`,
);
console.log("Scenario       steady time   sampled bytes/run   sampled max/run");
for (const name of selected) {
  const elapsed = await time(scenarios[name].run);
  const measured = allocations.get(name);
  if (measured === undefined) {
    console.log(
      `${name.padEnd(14)} ${formatTime(elapsed).padStart(11)}   external profiler active`,
    );
    continue;
  }
  const baselineBytes = median(baseline);
  const adjusted = measured.map(({ bytes }) => Math.max(0, bytes - baselineBytes));
  console.log(
    `${name.padEnd(14)} ${formatTime(elapsed).padStart(11)}   ${formatBytes(median(adjusted)).padStart(17)}   ${formatBytes(Math.max(...adjusted)).padStart(15)}`,
  );
}

console.log("\nScenario boundaries:");
for (const name of selected) console.log(`- ${name}: ${scenarios[name].description}`);

if (session !== undefined) {
  console.log("\nKyoot-owned sampled allocation sites (estimated bytes/op):");
  for (const name of selected) {
    const aggregate = new Map<string, Site>();
    for (const allocation of allocations.get(name)!) {
      for (const [key, site] of allocation.sites) {
        const prior = aggregate.get(key);
        if (prior === undefined) aggregate.set(key, { ...site });
        else prior.bytes += site.bytes;
      }
    }
    const ranked = [...aggregate.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    console.log(`${name}:`);
    if (ranked.length === 0) console.log("  (no kyoot-owned site sampled)");
    for (const site of ranked) {
      const path = site.url.slice(site.url.indexOf("packages/"));
      const bytesPerOp = site.bytes / (samples * asyncOps);
      console.log(
        `  ${bytesPerOp.toFixed(1).padStart(7)} B/op  ${path}:${site.line}  ${site.functionName}`,
      );
    }
  }
}

void sink;
