import assert from "node:assert/strict";
import { effect, Fail, Kyoot, makeHandler } from "../../packages/kyoot/src/index.ts";
import { FileSystem } from "../../packages/platform/src/index.ts";

const Read = FileSystem.readFile("/example");
const Ordinary = effect<FileSystem.Op, unknown>()("fs");
const ordinary: string = Kyoot.runSync(
  Read.pipe(Ordinary.handle({ onOp: (_, resume) => resume(123) }), Fail.orThrow),
);
const direct: string = Kyoot.runSync(
  Read.pipe(FileSystem.handle({ onOp: (_, resume) => resume(456) }), Fail.orThrow),
);
const handler: string = Kyoot.runSync(
  FileSystem.handler(Read, { onOp: (_, resume) => resume(789) }).pipe(Fail.orThrow),
);
const intercepted: string = Kyoot.runSync(
  Read.pipe(
    FileSystem.intercept(() => Kyoot.succeed(false)),
    Fail.orThrow,
  ),
);
const checked: string = Kyoot.runSync(
  makeHandler("fs", Read, { onOp: (_, resume) => resume(null) }).pipe(Fail.orThrow),
);
assert.equal(ordinary, 123);
assert.equal(direct, 456);
assert.equal(handler, 789);
assert.equal(intercepted, false);
assert.equal(checked, null);
console.log({ ordinary, direct, handler, intercepted, checked });
