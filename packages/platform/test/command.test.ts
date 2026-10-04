import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Fail, InterruptedError, Kyoot, runFiber } from "kyoot";
import { Command } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const node = (script: string, options?: Command.Options) =>
  Command.run(process.execPath, ["-e", script], options).pipe(Node.command);

test("command: interrupt stops a ready child before its delayed side effect", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-command-"));
  const ready = join(root, "ready");
  const sideEffect = join(root, "side-effect");
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setTimeout(() => fs.writeFileSync(${JSON.stringify(sideEffect)}, 'ran'), 500);
  `;
  const fiber = runFiber(node(script).pipe(Fail.orThrow));
  const interrupted = assert.rejects(fiber.promise, InterruptedError);
  try {
    const deadline = Date.now() + 5000;
    while (
      !(await fsp.access(ready).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "child did not become ready");
      await delay(10);
    }
    fiber.interrupt();
    await interrupted;
    await delay(650);
    assert.equal(
      await fsp.access(sideEffect).then(
        () => true,
        () => false,
      ),
      false,
      "interrupted child must not perform its delayed write",
    );
  } finally {
    fiber.interrupt();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`command: ${stream} has a default byte bound`, async () => {
    const result = await Kyoot.runPromise(
      node(`process.${stream}.write('x'.repeat(1024 * 1024 + 1))`).pipe(Fail.run),
    );
    assert.ok(!result.ok && result.cause._tag === "Fail");
    assert.ok(result.cause.error instanceof Command.CommandError);
    assert.match(result.cause.error.message, new RegExp(`${stream} maxBuffer`));
  });

  test(`command: ${stream} respects a smaller byte bound`, async () => {
    const options = { env: {}, maxBuffer: 64 };
    const result = await Kyoot.runPromise(
      node(`process.${stream}.write('é'.repeat(33))`, options).pipe(Fail.run),
    );
    assert.ok(!result.ok && result.cause._tag === "Fail");
    assert.ok(result.cause.error instanceof Command.CommandError);
    assert.match(result.cause.error.message, new RegExp(`${stream} maxBuffer`));
  });

  test(`command: ${stream} accepts larger output with a larger bounded allowance`, async () => {
    const options = { env: {}, maxBuffer: 2 * 1024 * 1024 };
    const output = await Kyoot.runPromise(
      node(`process.${stream}.write('x'.repeat(1024 * 1024 + 1))`, options).pipe(Fail.orThrow),
    );
    assert.equal(output.code, 0);
    assert.equal(output[stream], "x".repeat(1024 * 1024 + 1));
  });
}

test("command: exit code and output", async () => {
  const out = await Kyoot.runPromise(
    node("process.stdout.write('hi'); process.stderr.write('!'); process.exit(3)").pipe(
      Fail.orThrow,
    ),
  );
  assert.deepEqual(out, { code: 3, stdout: "hi", stderr: "!" });
});

test("command: stdin, cwd, env", async () => {
  const out = await Kyoot.runPromise(
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
  const r = await Kyoot.runPromise(
    Command.run("kyoot-no-such-binary").pipe(Node.command, Fail.run),
  );
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
