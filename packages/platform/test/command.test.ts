import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Async, Fail, Kyoot } from "kyoot";
import { Command } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const node = (script: string, options?: Command.Options) =>
  Command.run("node", ["-e", script], options).pipe(Node.command);

test("command: exit code and output", async () => {
  const out = await Kyoot.runPromise(
    node("process.stdout.write('hi'); process.stderr.write('!'); process.exit(3)").pipe(
      Fail.orThrow,
    ),
  );
  assert.deepEqual(out, { code: 3, signal: null, stdout: "hi", stderr: "!" });
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
  if (!r.ok && r.cause._tag === "Fail") assert.equal(r.cause.error.kind, "StartFailed");
});

test("command: application failure handlers catch command errors", async () => {
  const result = await Kyoot.runPromise(
    Command.run("kyoot-no-such-binary").pipe(
      Fail.catchTag("CommandError", (error: Command.CommandError) => Kyoot.succeed(error.kind)),
      Node.command,
    ),
  );
  assert.equal(result, "StartFailed");
});

test("command: signal exits and nonzero exits are distinct", async () => {
  const out = await Kyoot.runPromise(
    node("process.kill(process.pid, 'SIGTERM')").pipe(Fail.orThrow),
  );
  assert.equal(out.code, null);
  assert.equal(out.signal, "SIGTERM");
});

test("command: output limits count UTF-8 bytes and fail with CommandError", async () => {
  const result = await Kyoot.runPromise(
    node("process.stdout.write('€'.repeat(3))", { maxOutputBytes: 8 }).pipe(Fail.run),
  );
  assert.ok(!result.ok && result.cause._tag === "Fail");
  if (!result.ok && result.cause._tag === "Fail") {
    assert.ok(result.cause.error instanceof Command.CommandError);
    assert.equal(result.cause.error.kind, "OutputLimitExceeded");
    assert.equal(result.cause.error.limit, 8);
  }
});

test("command: invalid output limits fail with CommandError", async () => {
  const result = await Kyoot.runPromise(node("", { maxOutputBytes: -1 }).pipe(Fail.run));
  assert.ok(!result.ok && result.cause._tag === "Fail");
  if (!result.ok && result.cause._tag === "Fail") {
    assert.ok(result.cause.error instanceof Command.CommandError);
    assert.equal(result.cause.error.kind, "InvalidOutputLimit");
  }
});

test("command: interruption terminates the direct child and waits for close", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-command-"));
  const readyPath = join(root, "ready");
  const closedPath = join(root, "closed");
  const watcher = fsp.watch(root);
  const ready = (async () => {
    for await (const event of watcher) {
      if (event.filename === "ready") return;
    }
  })();
  const script = [
    `const fs = require('node:fs')`,
    `const ready = ${JSON.stringify(readyPath)}`,
    `const closed = ${JSON.stringify(closedPath)}`,
    "fs.writeFileSync(ready, 'ready')",
    "process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(closed, 'closed'); process.exit(0) }, 20))",
    "setInterval(() => {}, 1_000)",
  ].join(";");
  try {
    const exit = await Kyoot.runPromise(
      Kyoot.gen(function* () {
        const fiber = yield* Async.fork(node(script));
        yield* Async.fromPromise(() => ready);
        yield* fiber.interrupt;
        return yield* fiber.await;
      }),
    );
    assert.ok(!exit.ok && exit.cause._tag === "Interrupted");
    assert.equal(await fsp.readFile(closedPath, "utf8"), "closed");
  } finally {
    if (watcher.return !== undefined) await watcher.return();
    await fsp.rm(root, { recursive: true });
  }
});

test("command: interrupting one concurrent command leaves the other child alone", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-command-"));
  const watcher = fsp.watch(root);
  const ready = (async () => {
    const pending = new Set(["first-ready", "second-ready"]);
    for await (const event of watcher) {
      if (typeof event.filename === "string") pending.delete(event.filename);
      if (pending.size === 0) return;
    }
  })();
  const firstClosed = join(root, "first-closed");
  const first = [
    `const fs = require('node:fs')`,
    `const ready = ${JSON.stringify(join(root, "first-ready"))}`,
    `const closed = ${JSON.stringify(firstClosed)}`,
    "fs.writeFileSync(ready, 'ready')",
    "process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(closed, 'closed'); process.exit(0) }, 20))",
    "setInterval(() => {}, 1_000)",
  ].join(";");
  const second = [
    `const fs = require('node:fs')`,
    `fs.writeFileSync(${JSON.stringify(join(root, "second-ready"))}, 'ready')`,
    "setTimeout(() => { process.stdout.write('second'); process.exit(0) }, 250)",
  ].join(";");
  try {
    const result = await Kyoot.runPromise(
      Kyoot.gen(function* () {
        const firstFiber = yield* Async.fork(node(first));
        const secondFiber = yield* Async.fork(node(second));
        yield* Async.fromPromise(() => ready);
        yield* firstFiber.interrupt;
        return { first: yield* firstFiber.await, second: yield* secondFiber.join };
      }).pipe(Fail.orThrow),
    );
    assert.ok(!result.first.ok && result.first.cause._tag === "Interrupted");
    assert.equal(await fsp.readFile(firstClosed, "utf8"), "closed");
    assert.deepEqual(result.second, { code: 0, signal: null, stdout: "second", stderr: "" });
  } finally {
    if (watcher.return !== undefined) await watcher.return();
    await fsp.rm(root, { recursive: true });
  }
});

test("command: a fake handler", () => {
  const out = Kyoot.runSync(
    Command.run("ls", ["-la"]).pipe(
      Command.handle({
        onOp: (op, resume) =>
          resume({ code: 0, signal: null, stdout: op.args.join(" "), stderr: "" }),
      }),
      Fail.orThrow,
    ),
  );
  assert.equal(out.stdout, "-la");
});
