import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const config = process.argv[2];

if (!config) throw new Error("usage: build-package.mjs <tsconfig>");

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });

const declarationFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? declarationFiles(path)
        : entry.name.endsWith(".d.ts")
          ? [path]
          : [];
    }),
  );
  return nested.flat();
};

const tsc = join(dirname(require.resolve("typescript")), "tsc.js");
await rm(join(process.cwd(), "dist"), { recursive: true, force: true });
await run(process.execPath, [tsc, "-p", config]);

for (const path of await declarationFiles(join(process.cwd(), "dist"))) {
  const source = await readFile(path, "utf8");
  const output = source.replace(/(["'])(\.\.?(?:\/[^"']+)?)\.tsx?\1/g, "$1$2.js$1");
  if (output !== source) await writeFile(path, output);
}
