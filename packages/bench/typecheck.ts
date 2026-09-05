import { spawnSync } from "node:child_process";

const started = process.hrtime.bigint();
const child = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  {
    stdio: "inherit",
  },
);
const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
if (child.status !== 0) process.exitCode = child.status ?? 1;
else console.log(`TypeScript checked realistic effect programs in ${elapsed.toFixed(1)} ms`);
