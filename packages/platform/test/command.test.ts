import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Fail, Kyoot } from "kyoot";
import { Command } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";
import { InterruptedError, runFiber, runPromise } from "kyoot/async";

const node = (script: string, options?: Command.Options) =>
  Command.run("node", ["-e", script], options).pipe(Node.command);

test("command: interrupt stops the child process", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-command-"));
  const ready = join(root, "ready");
  const late = join(root, "late");
  const script = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(ready)}, "");
    setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, ""), 500);
  `;
  const exists = (path: string) =>
    fsp.access(path).then(
      () => true,
      () => false,
    );
  const fiber = runFiber(node(script).pipe(Fail.orThrow));
  const interrupted = assert.rejects(fiber.promise, InterruptedError);
  try {
    for (let i = 0; !(await exists(ready)); i++) {
      assert.ok(i < 500, "child did not start");
      await delay(10);
    }
    fiber.interrupt();
    await interrupted;
    await delay(700);
    assert.equal(await exists(late), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("command: exit code and output", async () => {
  const out = await runPromise(
    node("process.stdout.write('hi'); process.stderr.write('!'); process.exit(3)").pipe(
      Fail.orThrow,
    ),
  );
  assert.deepEqual(out, { code: 3, stdout: "hi", stderr: "!" });
});

test("command: stdin, cwd, env", async () => {
  const out = await runPromise(
    node("process.stdin.pipe(process.stdout); console.error(process.cwd(), process.env.KYOOT)", {
      stdin: "ping",
      cwd: "/",
      env: { KYOOT: "yes" },
    }).pipe(Fail.orThrow),
  );
  assert.equal(out.stdout, "ping");
  assert.equal(out.stderr, "/ yes\n");
});

test("command: a program that cannot start is a CommandError", async () => {
  const r = await runPromise(Command.run("kyoot-no-such-binary").pipe(Node.command, Fail.run));
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Command.CommandError);
});

test("command: a fake handler", () => {
  const out = Kyoot.runSync(
    Command.run("ls", ["-la"]).pipe(
      Command.handle({
        onOp: (op, resume) => resume({ code: 0, stdout: op.args.join(" "), stderr: "" }),
      }),
      Fail.orThrow,
    ),
  );
  assert.equal(out.stdout, "-la");
});
