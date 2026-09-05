import { Kyoot } from "kyoot";
import { makeHandler } from "kyoot/internal";
import type { Kyoot as K, Row } from "kyoot";
import { Model, type Request } from "./model.ts";

type UsageTotal = { input: number; output: number };

export const system = (content: string) =>
  Model.intercept((req, next) =>
    next({ ...req, messages: [{ role: "system", content }, ...req.messages] }),
  );

export const config = (patch: Pick<Request, "temperature" | "maxTokens">) =>
  Model.intercept((req, next) => next({ ...req, ...patch }));

export const usage = <A, S extends Row & { "ai/model"?: Request }, Ops>(k: K<A, S, Ops>) =>
  makeHandler("ai/model", k, {
    // Child fibers inherit this object. Mutating it lets one run include model calls
    // made by concurrent children, while create keeps separate program runs isolated.
    create: () => ({ input: 0, output: 0 }) as UsageTotal,
    onOp: (req, resume, total) =>
      Model(req).flatMap((c) => {
        total.input += c.usage?.input ?? 0;
        total.output += c.usage?.output ?? 0;
        return resume(c);
      }),
    onSuccess: (a, total) => Kyoot.succeed([a, { ...total }] as const),
  });
