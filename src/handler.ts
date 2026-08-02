import { KyootImpl, type AnyKyoot, type OnOp } from "./core.ts";

// The handler protocol, value level. A handler is a pipeable function that
// intercepts one key, transforms that key's ops (resuming the continuation
// zero or one time — enforced by the interpreter), transforms the final
// result into its chosen shape, and (at the type level, in each effect
// module) removes the key from the row.
//
// Handlers compose by nesting: the innermost handler in the pipe chain wins
// for its key; an unhandled op propagates outward.
export interface HandlerSpec {
  readonly key: string;
  readonly self: AnyKyoot;
  readonly onOp: OnOp;
  readonly onPure: (a: any) => AnyKyoot;
  // If present, defects thrown inside the handled region are routed here
  // (Abort.run uses this to fill Result's defect channel). If absent,
  // defects bypass the handler and surface at the edge.
  readonly onDefect?: (d: unknown) => AnyKyoot;
}

export function makeHandler(spec: HandlerSpec): AnyKyoot {
  return new KyootImpl({ _tag: "handler", ...spec });
}
