import { effect, Fail, Kyoot, makeHandler, type RowOf } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const read = FileSystem.readFile("/example");
const ordinary = effect<FileSystem.Op, unknown>()("fs");
const wrong = ordinary({ kind: "readFile", path: "/example" });
const readRows: Kyoot<string, RowOf<typeof read>> = read;

// @ts-expect-error FileSystem replacement requires explicit unsafe opt-in
FileSystem.handle({ onOp: () => Kyoot.succeed(123) });
// @ts-expect-error FileSystem replacement requires explicit unsafe opt-in
FileSystem.handler(read, { onOp: () => Kyoot.succeed(123) });
// @ts-expect-error FileSystem interception requires explicit unsafe opt-in
FileSystem.intercept(() => Kyoot.succeed(false));
// @ts-expect-error fixed-answer handlers cannot consume dependent FileSystem operations
read.pipe(ordinary.handle({ onOp: (_, resume) => resume(123) }));
// @ts-expect-error fixed-answer handlers cannot consume dependent FileSystem operations
ordinary.handler(read, { onOp: (_, resume) => resume(123) });
// @ts-expect-error fixed-answer interceptors cannot consume dependent FileSystem operations
read.pipe(ordinary.intercept(() => Kyoot.succeed(123)));
// @ts-expect-error checked handlers cannot infer the answer of a dependent operation
makeHandler("fs", read, { onOp: (_, resume) => resume(null) });
// @ts-expect-error Memory requires the dependent FileSystem contract
wrong.pipe(Memory.fs());
// @ts-expect-error Node requires the dependent FileSystem contract
wrong.pipe(Node.fs);
// @ts-expect-error Node.provide requires the dependent FileSystem contract
wrong.pipe(Node.provide);

const stringRead: string = Kyoot.runSync(readRows.pipe(Memory.fs(), Fail.orThrow))[0];
const stringNode: Promise<string> = Kyoot.runPromise(read.pipe(Node.fs, Fail.orThrow));
const stringProvide: Promise<string> = Kyoot.runPromise(read.pipe(Node.provide, Fail.orThrow));
const pureMemory: readonly [number, Record<string, string>] = Kyoot.runSync(
  Kyoot.succeed(1).pipe(Memory.fs()),
);
const pureNode: Promise<number> = Kyoot.runPromise(Kyoot.succeed(1).pipe(Node.fs));

Kyoot.gen(function* () {
  const text: string = yield* read;
  const write: void = yield* FileSystem.writeFile("/example", text);
  const append: void = yield* FileSystem.appendFile("/example", text);
  const dir: string[] = yield* FileSystem.readDir("/");
  const stat: FileSystem.Stat = yield* FileSystem.stat("/example");
  const exists: boolean = yield* FileSystem.exists("/example");
  const mkdir: void = yield* FileSystem.mkdir("/dir");
  const remove: void = yield* FileSystem.remove("/example");
  const rename: void = yield* FileSystem.rename("/dir", "/renamed");
  return { text, write, append, dir, stat, exists, mkdir, remove, rename };
});
