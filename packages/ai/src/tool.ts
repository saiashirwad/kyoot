import type { Kyoot, Row } from "kyoot";
import type { ToolSchema } from "./model.ts";

export interface Tool<A = any, R = unknown, S extends Row = any> {
  readonly schema: ToolSchema;
  readonly run: (args: A) => Kyoot<R, S>;
}

export const tool = <A, R, S extends Row>(
  schema: ToolSchema,
  run: (args: A) => Kyoot<R, S>,
): Tool<A, R, S> => ({
  schema,
  run,
});
