import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { caseNames, cases, libraries, type CaseName, type LibraryName } from "./cases.ts";

const { values, positionals } = parseArgs({
  options: { rounds: { type: "string", default: "5" } },
  allowPositionals: true,
});
const rounds = Number(values.rounds);
const selected = (positionals.length > 0 ? positionals : caseNames) as CaseName[];
for (const name of selected) {
  if (!(name in cases)) throw new Error(`unknown case ${name}; cases: ${caseNames.join(", ")}`);
}

const measure = (library: LibraryName, name: CaseName): number => {
  const output = execFileSync(process.execPath, ["measure.ts", library, name], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return (JSON.parse(output) as { ns: number }).ns;
};

const samples = new Map(
  selected.map((name) => [name, { kyoot: [] as number[], effect: [] as number[] }]),
);

const started = performance.now();
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? libraries : [...libraries].reverse();
  for (const name of selected) {
    for (const library of order) samples.get(name)![library].push(measure(library, name));
  }
  console.error(`round ${round + 1}/${rounds} done`);
}

const median = (numbers: readonly number[]): number => {
  const ordered = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
};

const spread = (numbers: readonly number[]): string =>
  `±${(((Math.max(...numbers) - Math.min(...numbers)) / 2 / median(numbers)) * 100).toFixed(0)}%`;

const rows = selected.map((name) => {
  const { kyoot, effect } = samples.get(name)!;
  const ratios = kyoot.map((ns, round) => effect[round]! / ns);
  const low = Math.min(...ratios);
  const high = Math.max(...ratios);
  return [
    `${name}: ${cases[name].title}`,
    `${median(kyoot).toFixed(0)} ${spread(kyoot)}`,
    `${median(effect).toFixed(0)} ${spread(effect)}`,
    `${median(ratios).toFixed(2)}x`,
    `${low.toFixed(2)}–${high.toFixed(2)}`,
    low <= 1 && high >= 1 ? "noise" : "",
  ];
});

const header = ["case", "kyoot ns", "effect ns", "effect/kyoot", "ratio range", ""];
console.log(`| ${header.join(" | ")} |`);
console.log(`|${header.map(() => " --- ").join("|")}|`);
for (const row of rows) console.log(`| ${row.join(" | ")} |`);
console.log(
  `\nNode ${process.version}, ${rounds} rounds, one process per (case, library), ` +
    `${((performance.now() - started) / 1000).toFixed(0)} s. ns is mitata's p50 per run.`,
);
