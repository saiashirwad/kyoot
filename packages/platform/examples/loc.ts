import { Kyoot } from "kyoot";
import * as Fail from "kyoot/fail";
import { Command, FileSystem } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";
import { runPromise } from "kyoot/async";

const linesPerPackage = Kyoot.gen(function* () {
  const { stdout } = yield* Command.run("git", ["ls-files", "--", "*.ts"]);
  const counts: Record<string, number> = {};
  for (const file of stdout.trim().split("\n")) {
    const pkg = file.split("/").slice(0, 2).join("/");
    const text = yield* FileSystem.readFile(file);
    counts[pkg] = (counts[pkg] ?? 0) + text.split("\n").length;
  }
  return counts;
});

console.log(await linesPerPackage.pipe(Node.provide, Fail.orThrow, runPromise));
