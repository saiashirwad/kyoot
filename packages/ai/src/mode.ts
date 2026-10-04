import { Kyoot } from "kyoot";
import type { Kyoot as K, Row, Requirement } from "kyoot";
import { Model, type Request, type Completion, type Usage } from "./model.ts";

export const system = (content: string) =>
  Model.intercept((req, next) =>
    next({ ...req, messages: [{ role: "system", content }, ...req.messages] }),
  );

export const config = (patch: Pick<Request, "temperature" | "maxTokens">) =>
  Model.intercept((req, next) => next({ ...req, ...patch }));

export const usage = <A, S extends Row & { "ai/model"?: Requirement<Request, Completion> }>(
  k: K<A, S>,
) =>
  Model.handler(k, {
    initial: { input: 0, output: 0 } as Usage,
    onOp: (req, resume, total) =>
      Model(req).flatMap((c) =>
        resume(c, {
          input: total.input + (c.usage?.input ?? 0),
          output: total.output + (c.usage?.output ?? 0),
        }),
      ),
    onSuccess: (a, total) => Kyoot.succeed([a, total] as const),
  });
