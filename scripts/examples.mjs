import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep network, real process commands, process exit, and live providers opt-in.
const examples = [
  "kyoot/domain",
  "kyoot/env",
  "kyoot/var",
  "kyoot/emit",
  "kyoot/resource",
  "kyoot/checkout",
  "kyoot/playground",
  "platform/intercept",
  "registry/registry",
];
for (const example of examples) {
  const [pkg, name] = example.split("/");
  const path = fileURLToPath(new URL(`../packages/${pkg}/examples/${name}.ts`, import.meta.url));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${example} exited with ${code ?? signal}`)),
    );
  });
}
