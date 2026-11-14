import { Kyoot } from "kyoot";
import type { Kyoot as K, Op, Row } from "kyoot";
import { Model, type Completion, type Request } from "./model.ts";

export const system = (content: string) =>
  Model.intercept((req, next) =>
    next({ ...req, messages: [{ role: "system", content }, ...req.messages] }),
  );

export const config = (patch: Pick<Request, "temperature" | "maxTokens">) =>
  Model.intercept((req, next) => next({ ...req, ...patch }));

export const usage = <A, S extends Row & { "ai/model"?: Op<Request, Completion> }>(k: K<A, S>) =>
  Kyoot.gen(function* () {
    const total = { input: 0, output: 0 };
    const a = yield* k.pipe(
      Model.handle((req, resume) =>
        Model(req).flatMap((c) => {
          total.input += c.usage?.input ?? 0;
          total.output += c.usage?.output ?? 0;
          return resume(c);
        }),
      ),
    );
    return [a, total] as const;
  });
