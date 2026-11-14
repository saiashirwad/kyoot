import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot } from "kyoot";
import * as Fail from "kyoot/fail";
import { FileSystem } from "@kyoot/platform";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const program = Kyoot.gen(function* () {
  const text = yield* FileSystem.readFile("/in.txt");
  yield* FileSystem.writeFile("/out.txt", text.toUpperCase());
  return yield* FileSystem.exists("/out.txt");
});

type Pending = Extract<ReturnType<typeof Kyoot.step<boolean, FileSystem.FsRow>>, { done: false }>;
type At<K extends keyof FileSystem.FsRow> = Extract<Pending, { key: K }>;

// Compile-time only: the answer type of each pending step is its operation's.
export const typeOnly = (
  read: At<"fs/readFile">,
  write: At<"fs/writeFile">,
  has: At<"fs/exists">,
) => {
  read.resume("text");
  write.resume(undefined);
  has.resume(true);
  // @ts-expect-error readFile answers a string
  read.resume(1);
  // @ts-expect-error writeFile answers void
  write.resume("ok");
  // @ts-expect-error exists answers a boolean
  has.resume("yes");
  // @ts-expect-error writeFile has a payload with data, readFile does not
  const data: string = read.payload.data;
  return data;
};

// A host drives the program by hand: each pending step is typed per operation.
const drive = (files: Map<string, string>) => {
  let step = Kyoot.step(program);
  while (!step.done) {
    switch (step.key) {
      case "fs/readFile": {
        type _payload = Expect<Equal<typeof step.payload, { readonly path: string }>>;
        const text = files.get(step.payload.path);
        step =
          text === undefined
            ? step.raise(new FileSystem.FsError("readFile", step.payload.path, "NotFound", "no"))
            : step.resume(text);
        break;
      }
      case "fs/writeFile":
        files.set(step.payload.path, step.payload.data);
        step = step.resume(undefined);
        break;
      case "fs/exists":
        step = step.resume(files.has(step.payload.path));
        break;
      default:
        step.cancel();
        throw new Error(`unexpected ${step.key}`);
    }
  }
  return step.value;
};

test("a host drives file system effects one at a time, typed per operation", () => {
  const files = new Map([["/in.txt", "hi"]]);
  assert.equal(drive(files), true);
  assert.equal(files.get("/out.txt"), "HI");
});

test("each operation is its own key in the row", () => {
  const step = Kyoot.step(FileSystem.stat("/x"));
  assert.ok(!step.done);
  assert.equal(step.key, "fs/stat");
  step.cancel();
});

test("an interceptor touches only the operations it names", () => {
  const readOnly = FileSystem.intercept({
    writeFile: (p) =>
      Fail.fail(new FileSystem.FsError("writeFile", p.path, "PermissionDenied", "ro")),
  });
  const first = Kyoot.step(FileSystem.readFile("/a").pipe(readOnly));
  assert.ok(!first.done);
  assert.equal(first.key, "fs/readFile");
  first.cancel();
  const second = Kyoot.step(FileSystem.writeFile("/a", "x").pipe(readOnly));
  assert.ok(!second.done);
  assert.equal(second.key, "fail");
  second.cancel();
});
