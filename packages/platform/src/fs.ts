import { effect } from "kyoot";
import type { Kyoot, MergeAll, Resume, Row, RowOf } from "kyoot";
import type {
  Kyoot as CoreKyoot,
  Operation as CoreOperation,
  KnownOperationsOf,
  MergeOperations,
  RemoveOperations,
  ValueOf,
} from "kyoot/internal";

export type Op =
  | { readonly kind: "readFile"; readonly path: string }
  | { readonly kind: "writeFile"; readonly path: string; readonly data: string }
  | { readonly kind: "appendFile"; readonly path: string; readonly data: string }
  | { readonly kind: "readDir"; readonly path: string }
  | { readonly kind: "stat"; readonly path: string }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "mkdir"; readonly path: string; readonly recursive: boolean }
  | { readonly kind: "remove"; readonly path: string; readonly recursive: boolean }
  | { readonly kind: "rename"; readonly path: string; readonly to: string };

export type Code =
  | "NotFound"
  | "AlreadyExists"
  | "PermissionDenied"
  | "NotADirectory"
  | "IsADirectory"
  | "NotEmpty"
  | "Other";

export class FsError {
  readonly _tag = "FsError";
  readonly op: Op["kind"];
  readonly path: string;
  readonly code: Code;
  readonly message: string;
  constructor(op: Op["kind"], path: string, code: Code, message: string) {
    this.op = op;
    this.path = path;
    this.code = code;
    this.message = message;
  }
}

export interface Stat {
  readonly type: "file" | "directory" | "other";
  readonly size: number;
  readonly mtime: Date;
}

export type Answer = {
  readFile: string;
  writeFile: void;
  appendFile: void;
  readDir: string[];
  stat: Stat;
  exists: boolean;
  mkdir: void;
  remove: void;
  rename: void;
};

export type Kind = Op["kind"];

export type Operation<K extends Kind> = Extract<Op, { readonly kind: K }>;

export type Contract = { readonly fail: FsError };

/**
 * The continuation for one filesystem operation. Its value and `with` program both use the
 * answer associated with that operation's `kind`.
 */
export type OperationResume<K extends Kind, St = undefined> = Resume<Answer[K], St, Contract>;

type Handler<K extends Kind> = (
  operation: Operation<K>,
  resume: OperationResume<K>,
) => Kyoot<unknown, any>;

/**
 * A handler must describe every filesystem operation. This is deliberate: a handler cannot
 * accidentally claim an operation and then forward its answer through an untyped channel.
 */
export type HandlerTable = {
  readonly [K in Kind]: Handler<K>;
};

type HandlerProgram<H extends HandlerTable> = H[Kind] extends infer F
  ? F extends (...args: any[]) => infer R
    ? R
    : never
  : never;
type RemoveFs<S> = S extends unknown ? Omit<S, "fs"> : never;
type FamilyOperation = {
  [K in Kind]: CoreOperation<"fs", Operation<K>, Answer[K], Contract>;
}[Kind];
type FamilyCheck<Ops> = 0 extends 1 & Ops
  ? unknown
  : Exclude<Extract<Ops, { readonly key: "fs" }>, FamilyOperation> extends never
    ? unknown
    : { readonly "filesystem operation signature mismatch": Ops };

const raw = effect<Op, unknown, Contract>()("fs");

/**
 * Install a typed filesystem-operation handler.
 *
 * Each table entry receives the exact payload and continuation answer for its operation. Effects
 * returned directly from a table entry run in the handler; use `resume.with` to deliver an
 * expected `FsError` back to the operation site.
 */
export const handle =
  <H extends HandlerTable>(table: H) =>
  <A, S extends Row & { fs?: Op }, Ops>(
    program: Kyoot<A, S, Ops> & FamilyCheck<Ops>,
  ): Kyoot<
    A | ValueOf<HandlerProgram<H>>,
    MergeAll<RemoveFs<S> | RowOf<HandlerProgram<H>>>,
    MergeOperations<RemoveOperations<Ops, "fs">, KnownOperationsOf<HandlerProgram<H>>>
  > =>
    raw.handle({
      onOp: (operation, resume) => {
        switch (operation.kind) {
          case "readFile":
            return table.readFile(operation, resume as OperationResume<"readFile">);
          case "writeFile":
            return table.writeFile(operation, resume as OperationResume<"writeFile">);
          case "appendFile":
            return table.appendFile(operation, resume as OperationResume<"appendFile">);
          case "readDir":
            return table.readDir(operation, resume as OperationResume<"readDir">);
          case "stat":
            return table.stat(operation, resume as OperationResume<"stat">);
          case "exists":
            return table.exists(operation, resume as OperationResume<"exists">);
          case "mkdir":
            return table.mkdir(operation, resume as OperationResume<"mkdir">);
          case "remove":
            return table.remove(operation, resume as OperationResume<"remove">);
          case "rename":
            return table.rename(operation, resume as OperationResume<"rename">);
        }
      },
    })(program as never) as never;

type FamilyNext<K extends Kind> = (
  operation: Operation<K>,
) => Kyoot<
  Answer[K],
  { fs: Op; fail: FsError },
  CoreOperation<"fs", Operation<K>, Answer[K], Contract>
>;
type FamilyInterceptor<K extends Kind> = (
  operation: Operation<K>,
  next: FamilyNext<K>,
) => Kyoot<Answer[K], any>;
export type InterceptorTable = { readonly [K in Kind]?: FamilyInterceptor<K> };
type TableResult<H extends InterceptorTable> = H[keyof H] extends infer F
  ? F extends (...args: any[]) => infer R
    ? R
    : never
  : never;

/** Install typed interceptors. Omitted operation kinds pass through unchanged. */
export const intercept =
  <H extends InterceptorTable>(table: H) =>
  <A, S extends Row & { fs?: Op }, Ops>(
    program: Kyoot<A, S, Ops> & FamilyCheck<Ops>,
  ): Kyoot<
    A,
    MergeAll<S | RowOf<TableResult<H>>>,
    MergeOperations<Ops, KnownOperationsOf<TableResult<H>>>
  > =>
    raw.intercept((operation, next) => {
      const interceptor = table[operation.kind] as FamilyInterceptor<Kind> | undefined;
      return interceptor
        ? interceptor(operation as never, next as never)
        : (next(operation) as never);
    })(program as never) as never;

/** Untyped low-level interceptor retained for trusted interpreter code. */
export const unsafeIntercept =
  <R extends Kyoot<unknown, any>>(
    f: (operation: Op, next: (operation: Op) => Kyoot<unknown, { fs: Op; fail: FsError }>) => R,
  ) =>
  <A, S extends Row & { fs?: Op }>(
    program: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<RemoveFs<S> | RowOf<R>>> =>
    raw.intercept(f)(program) as never;

const perform = <O extends Op>(op: O) =>
  raw(op) as CoreKyoot<
    Answer[O["kind"]],
    { fs: Op; fail: FsError },
    CoreOperation<"fs", O, Answer[O["kind"]], Contract>
  >;

export const readFile = (path: string) => perform({ kind: "readFile", path });

export const writeFile = (path: string, data: string) => perform({ kind: "writeFile", path, data });

export const appendFile = (path: string, data: string) =>
  perform({ kind: "appendFile", path, data });

export const readDir = (path: string) => perform({ kind: "readDir", path });

export const stat = (path: string) => perform({ kind: "stat", path });

export const exists = (path: string) => perform({ kind: "exists", path });

export const mkdir = (path: string, { recursive = false } = {}) =>
  perform({ kind: "mkdir", path, recursive });

export const remove = (path: string, { recursive = false } = {}) =>
  perform({ kind: "remove", path, recursive });

export const rename = (path: string, to: string) => perform({ kind: "rename", path, to });
