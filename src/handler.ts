import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Kyoot, OnOp } from "./model.ts";
import type { Row } from "./types.ts";

// A handler wraps a continuation and intercepts operations for one effect key
// Matching operations are handled here; unhandled operations and defects continue onwards
export interface HandlerSpec {
  readonly key: string;
  readonly self: AnyKyoot;
  readonly onOp: OnOp;
  readonly onPure: (a: any) => AnyKyoot;
  readonly onDefect?: (d: unknown) => AnyKyoot;
}

export type Handler<K extends string, In, Out> = <A, S extends Row & { [P in K]: In }>(
  k: Kyoot<A, S>,
) => Kyoot<Out, Omit<S, K>>;

export function makeHandler(spec: HandlerSpec): AnyKyoot {
  return new KyootImpl({ _tag: "handler", ...spec });
}
