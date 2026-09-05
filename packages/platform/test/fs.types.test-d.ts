import { effect, Fail, Kyoot } from "kyoot";
import { FileSystem } from "@kyoot/platform";

const handler = {
  readFile: (_op, resume) => resume("text"),
  writeFile: (op, resume) => resume(op.data.length === 0 ? undefined : undefined),
  appendFile: (op, resume) => resume(op.data.length === 0 ? undefined : undefined),
  readDir: (_op, resume) => resume([]),
  stat: (_op, resume) => resume({ type: "file", size: 0, mtime: new Date() }),
  exists: (_op, resume) => resume(false),
  mkdir: (_op, resume) => resume(undefined),
  remove: (_op, resume) => resume(undefined),
  rename: (op, resume) => resume(op.to.length === 0 ? undefined : undefined),
} satisfies FileSystem.HandlerTable;

FileSystem.readFile("/a").pipe(FileSystem.handle(handler), Fail.orThrow, Kyoot.runSync);

const wrongReadAnswer = {
  ...handler,
  // @ts-expect-error readFile can resume only with a string
  readFile: (_op, resume) => resume(1),
} satisfies FileSystem.HandlerTable;

const wrongStatAnswer = {
  ...handler,
  // @ts-expect-error stat cannot resume with a readDir answer
  stat: (_op, resume) => resume(["not a stat"]),
} satisfies FileSystem.HandlerTable;

const wrongProgramAnswer = {
  ...handler,
  // @ts-expect-error resume.with keeps the answer tied to readFile
  readFile: (_op, resume) => resume.with(Kyoot.succeed(1)),
} satisfies FileSystem.HandlerTable;

const wrongPayload = {
  ...handler,
  readFile: (op, resume) => {
    // @ts-expect-error readFile does not carry write data
    void op.data;
    return resume("text");
  },
} satisfies FileSystem.HandlerTable;

void wrongReadAnswer;
void wrongStatAnswer;
void wrongProgramAnswer;
void wrongPayload;

const safeIntercept = FileSystem.intercept({
  readFile: (_op, next) => next(_op),
  exists: (_op, next) => next(_op),
});
FileSystem.readFile("/a").pipe(safeIntercept);
// @ts-expect-error an interceptor alone does not handle the filesystem operation
FileSystem.readFile("/a").pipe(FileSystem.intercept({}), Kyoot.runSync);
FileSystem.readFile("/a").pipe(
  FileSystem.intercept({ exists: (_op, next) => next(_op) }),
  // @ts-expect-error unrelated partial interceptors also leave fs unhandled
  Kyoot.runSync,
);
// @ts-expect-error a readFile interceptor must return a string answer
FileSystem.intercept({ readFile: () => Kyoot.succeed(123) });
// @ts-expect-error an exists interceptor must return a boolean answer
FileSystem.intercept({ exists: () => Kyoot.succeed("oops") });

const wrongRead = effect<FileSystem.Operation<"readFile">, boolean, FileSystem.Contract>()("fs");
const incompatible = wrongRead({ kind: "readFile", path: "/a" });
// @ts-expect-error a family handler cannot give a string to an operation expecting boolean
incompatible.pipe(FileSystem.handle(handler));
// @ts-expect-error a family interceptor checks the operation's answer signature
incompatible.pipe(FileSystem.intercept({ readFile: () => Kyoot.succeed("text") }));
