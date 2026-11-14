import { effect } from "kyoot";
import type { Kyoot, MergeAll, Op as RowOp, Resume, RowsOf, Row } from "kyoot";

export type Code =
  | "NotFound"
  | "AlreadyExists"
  | "PermissionDenied"
  | "NotADirectory"
  | "IsADirectory"
  | "NotEmpty"
  | "Other";

export type Name =
  | "readFile"
  | "writeFile"
  | "appendFile"
  | "readDir"
  | "stat"
  | "exists"
  | "mkdir"
  | "remove"
  | "rename";

export class FsError {
  readonly _tag = "FsError";
  readonly op: Name;
  readonly path: string;
  readonly code: Code;
  readonly message: string;
  constructor(op: Name, path: string, code: Code, message: string) {
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

type Path = { readonly path: string };

export type Payload = {
  readFile: Path;
  writeFile: Path & { readonly data: string };
  appendFile: Path & { readonly data: string };
  readDir: Path;
  stat: Path;
  exists: Path;
  mkdir: Path & { readonly recursive: boolean };
  remove: Path & { readonly recursive: boolean };
  rename: Path & { readonly to: string };
};

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

type Failing = { fail: RowOp<FsError, never> };

export type FsRow = { [N in Name as `fs/${N}`]: RowOp<Payload[N], Answer[N]> };

const op = <N extends Name>() => effect<Payload[N], Answer[N], Failing>();

// One effect per operation: handle or intercept just the ones you care about.
export const ops = {
  readFile: op<"readFile">()("fs/readFile"),
  writeFile: op<"writeFile">()("fs/writeFile"),
  appendFile: op<"appendFile">()("fs/appendFile"),
  readDir: op<"readDir">()("fs/readDir"),
  stat: op<"stat">()("fs/stat"),
  exists: op<"exists">()("fs/exists"),
  mkdir: op<"mkdir">()("fs/mkdir"),
  remove: op<"remove">()("fs/remove"),
  rename: op<"rename">()("fs/rename"),
};

const names = Object.keys(ops) as Name[];

// Wraps k in one handler per operation. Typed at the call sites above, so the plumbing is loose.
const anyOp = (n: Name): any => ops[n];
const apply = (k: unknown, wrap: (n: Name) => any) =>
  names.reduce<any>((acc, n) => wrap(n)?.(acc) ?? acc, k) as never;

export type Handlers = {
  [N in Name]: (payload: Payload[N], resume: Resume<Answer[N], Failing>) => Kyoot<any, any>;
};

type ValueOf<R> = R extends Kyoot<infer A, any> ? A : never;

// Handle every operation at once; one call, so the handlers can share state.
export const handle =
  <H extends Handlers>(handlers: H) =>
  <B, S extends Row & Partial<FsRow>>(
    k: Kyoot<B, S>,
  ): Kyoot<
    B | ValueOf<ReturnType<H[Name]>>,
    MergeAll<Omit<S, keyof FsRow> | RowsOf<ReturnType<H[Name]>>>
  > =>
    apply(k, (n) => anyOp(n).handle(handlers[n]));

type Next<N extends Name> = Parameters<Parameters<(typeof ops)[N]["intercept"]>[0]>[1];

export type Interceptors = {
  [N in Name]?: (payload: Payload[N], next: Next<N>) => Kyoot<Answer[N], any>;
};

// Intercept only the operations given; the rest pass through untouched.
export const intercept =
  <H extends Interceptors>(interceptors: H) =>
  <B, S extends Row & Partial<FsRow>>(
    k: Kyoot<B, S>,
  ): Kyoot<
    B,
    MergeAll<
      | Omit<S, `fs/${keyof H & Name}`>
      | RowsOf<ReturnType<Extract<H[keyof H], (...args: any) => any>>>
    >
  > =>
    apply(k, (n) => interceptors[n] && anyOp(n).intercept(interceptors[n]));

export const readFile = (path: string) => ops.readFile({ path });

export const writeFile = (path: string, data: string) => ops.writeFile({ path, data });

export const appendFile = (path: string, data: string) => ops.appendFile({ path, data });

export const readDir = (path: string) => ops.readDir({ path });

export const stat = (path: string) => ops.stat({ path });

export const exists = (path: string) => ops.exists({ path });

export const mkdir = (path: string, { recursive = false } = {}) => ops.mkdir({ path, recursive });

export const remove = (path: string, { recursive = false } = {}) => ops.remove({ path, recursive });

export const rename = (path: string, to: string) => ops.rename({ path, to });
