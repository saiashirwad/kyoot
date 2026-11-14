import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Kyoot } from "kyoot";
import * as Fail from "kyoot/fail";
import { Async, runPromise } from "kyoot/async";
import * as Sim from "kyoot/sim";
import { FileSystem } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

// Two fibers read and append to one file. The same program runs on the real file system and under
// the simulator, whose world answers fs/* from a map.
const copyTwice = (from: string, to: string) =>
  Async.all(
    [0, 1].map(() =>
      Kyoot.gen(function* () {
        const text = yield* FileSystem.readFile(from);
        yield* FileSystem.appendFile(to, text);
      }),
    ),
  ).pipe(Fail.orThrow);

test("fs effects: the world fakes them in sim, Node handles them live", async () => {
  const r = Sim.run(copyTwice("/in", "/out"), {
    seed: 3,
    world: () => {
      const files = new Map([["/in", "ab"]]);
      return {
        files,
        "fs/readFile": ({ path }: { path: string }) => Sim.delay(2, files.get(path) ?? ""),
        "fs/appendFile": ({ path, data }: { path: string; data: string }) =>
          void files.set(path, (files.get(path) ?? "") + data),
      };
    },
  });
  assert.ok(r.exit.ok);
  assert.equal(r.world.files.get("/out"), "abab");

  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-sim-"));
  try {
    await fsp.writeFile(join(root, "in"), "ab");
    await runPromise(copyTwice(join(root, "in"), join(root, "out")).pipe(Async.provide(Node.fs)));
    assert.equal(await fsp.readFile(join(root, "out"), "utf8"), "abab");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
