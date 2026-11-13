import { isDeepStrictEqual } from "node:util";
import { do_not_optimize, measure } from "mitata";
import {
  cases,
  libraries,
  type CaseName,
  type Entry,
  type Library,
  type LibraryName,
} from "./cases.ts";

const [libraryName, caseName] = process.argv.slice(2) as [LibraryName, CaseName];
if (!libraries.includes(libraryName) || !(caseName in cases)) {
  console.error(
    `usage: node measure.ts <${libraries.join("|")}> <${Object.keys(cases).join("|")}>`,
  );
  process.exit(2);
}

const { default: library }: { default: Library } = await import(`./${libraryName}-cases.ts`);
const { run: execute, read = (result: unknown) => result }: Entry = library[caseName];

const first = execute();
const isAsync = first instanceof Promise;
const actual = (read as (result: unknown) => unknown)(await first);
const { expected } = cases[caseName];
if (!isDeepStrictEqual(actual, expected)) {
  console.error(
    `${libraryName} ${caseName} returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
  process.exit(1);
}

const stats = await measure(
  isAsync ? async () => do_not_optimize(await execute()) : () => do_not_optimize(execute()),
);
console.log(JSON.stringify({ library: libraryName, case: caseName, ns: stats.p50 }));
