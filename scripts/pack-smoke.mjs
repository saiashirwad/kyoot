import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = ["kyoot", "ai", "platform", "registry"];
const workspace = await mkdtemp(join(tmpdir(), "kyoot-pack-"));
const tarballs = join(workspace, "tarballs");
const consumer = join(workspace, "consumer");

const run = (command, args, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });

try {
  for (const name of packages)
    await run("pnpm", [
      "--dir",
      join(root, "packages", name),
      "pack",
      "--pack-destination",
      tarballs,
    ]);

  const packed = (await readdir(tarballs)).filter((name) => name.endsWith(".tgz"));
  if (packed.length !== packages.length)
    throw new Error("each public package must produce one tarball");

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--omit=dev",
      "typescript@7.0.2",
      "@types/node@26.1.2",
      ...packed.map((name) => join(tarballs, name)),
    ],
    consumer,
  );

  for (const name of ["kyoot", "@kyoot/ai", "@kyoot/platform", "@kyoot/registry"]) {
    const dist = join(consumer, "node_modules", name, "dist");
    const declaration = await readFile(join(dist, "index.d.ts"), "utf8");
    await readFile(join(dist, "index.js"), "utf8");
    await readFile(join(dist, "index.js.map"), "utf8");
    if (/from ["'][^"']+\.ts["']/.test(declaration))
      throw new Error(`${name} declarations must use JavaScript import paths`);
  }
  await readFile(join(consumer, "node_modules", "@kyoot", "platform", "dist", "node.js"), "utf8");

  await writeFile(
    join(consumer, "consumer.ts"),
    `import { Async, Kyoot, Resource, effect } from "kyoot";
import { makeHandler, unsafeRunFiber } from "kyoot/internal";
import * as AI from "@kyoot/ai";
import * as Platform from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";
import * as Registry from "@kyoot/registry";

const Read = effect<string, number>()("consumer/read");
const handled = Read("key").pipe(Read.handle({ onOp: (_, resume) => resume(42) }));
const value: number = Kyoot.runSync(handled);
// @ts-expect-error declared operations must be handled before execution
Kyoot.runSync(Read("key"));
const owned = Resource.acquire(() => value, () => Async.fromPromise(async () => {}))
  .pipe(Resource.run);
const result: Promise<number> = Kyoot.runPromise(owned);
void [result, makeHandler, unsafeRunFiber, AI, Platform, Node, Registry];
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      include: ["consumer.ts"],
    }),
  );
  await run(
    process.execPath,
    ["node_modules/typescript/lib/tsc.js", "-p", "tsconfig.json"],
    consumer,
  );

  await writeFile(
    join(consumer, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { Async, Kyoot, Resource } from "kyoot";
import { AI } from "@kyoot/ai";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";
import { Registry } from "@kyoot/registry";

assert.equal(typeof AI.ask, "function");
assert.equal(typeof Node.provide, "function");
assert.ok(new Registry() instanceof Registry);

const events = [];
const result = await Kyoot.gen(function* () {
  yield* Resource.acquire(
    () => {
      events.push("open");
      return "resource";
    },
    () => Async.fromPromise(async () => events.push("close")),
  );
  yield* FileSystem.writeFile("/artifact.txt", "ok");
  return yield* FileSystem.readFile("/artifact.txt");
})
  .pipe(Memory.fs(), Resource.run, Kyoot.runPromise);

assert.deepEqual(result, ["ok", { "/artifact.txt": "ok" }]);
assert.deepEqual(events, ["open", "close"]);
`,
  );
  await run(process.execPath, ["smoke.mjs"], consumer);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
