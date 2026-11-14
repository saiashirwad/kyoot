import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";

const src = resolve(import.meta.dirname, "../src");

const SPECIFIER =
  /(?:^|[;\n])\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const specifiers = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2] ?? m[3])!);

const reachable = (entry: string) => {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  for (const file of queue) {
    if (seen.has(file)) continue;
    const imports = specifiers(file);
    seen.set(file, imports);
    for (const s of imports) if (s.startsWith(".")) queue.push(resolve(dirname(file), s));
  }
  return seen;
};

test("the core entry point reaches no effect, no async file and no package", () => {
  const core = reachable(resolve(src, "index.ts"));
  const files = [...core.keys()].map((file) => relative(src, file));
  assert.ok(files.includes("machine.ts") && files.includes("step.ts"));
  assert.deepEqual(
    files.filter((file) => file.startsWith("async/") || file.startsWith("effects/")),
    [],
  );
  assert.deepEqual(
    [...core.values()].flat().filter((s) => !s.startsWith(".")),
    [],
  );
});
