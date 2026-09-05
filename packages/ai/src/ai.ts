import { Fail, Kyoot } from "kyoot";
import type { Kyoot as K, MergeAll } from "kyoot";
import { generate, type Options as Generate, type Requires } from "./generate.ts";
import type { Message } from "./model.ts";
import type { Schema } from "./schema.ts";
import type { Tool } from "./tool.ts";

export interface Options<T extends Tool = never> extends Omit<Generate<never, T>, "schema"> {
  readonly prompt?: string;
  readonly messages?: readonly Message[];
}

export interface AI<T extends Tool = never> {
  readonly messages: Message[];
  ask(input?: string): K<string, TurnRequires<T>>;
  gen<A>(schema: Schema<A>, input?: string): K<A, TurnRequires<T>>;
}

/** An AI instance accepts one active turn so its history stays in order. */
export class ConcurrentTurnError {
  readonly _tag = "ConcurrentTurnError";
  readonly message = "an AI instance already has an active turn";
}

type TurnRequires<T extends Tool> = MergeAll<Requires<T> | { fail: ConcurrentTurnError }>;

export const make = <T extends Tool = never>(options: Options<T> = {}): AI<T> => {
  const messages: Message[] = [...(options.messages ?? [])];
  const system: Message[] = options.prompt ? [{ role: "system", content: options.prompt }] : [];
  let active = false;
  const step = <A>(input: string | undefined, schema?: Schema<A>): K<A, TurnRequires<T>> =>
    Kyoot.gen(function* () {
      if (active) return yield* Fail.fail(new ConcurrentTurnError());
      active = true;
      try {
        // Keep the pending input out of shared history until every model and tool step succeeds.
        const pending =
          input === undefined ? [] : ([{ role: "user", content: input }] as Message[]);
        const [value, added] = yield* schema
          ? generate([...system, ...messages, ...pending], { ...options, schema })
          : generate([...system, ...messages, ...pending], options);
        messages.push(...pending, ...added);
        return value as A;
      } finally {
        active = false;
      }
    }) as never;
  return {
    messages,
    ask: (input) => step<string>(input),
    gen: (schema, input) => step(input, schema),
  };
};

export const ask = <T extends Tool = never>(input: string, options?: Options<T>) =>
  Kyoot.gen(function* () {
    return yield* make(options).ask(input);
  });

export const gen = <A, T extends Tool = never>(
  schema: Schema<A>,
  input: string,
  options?: Options<T>,
) =>
  Kyoot.gen(function* () {
    return yield* make(options).gen(schema, input);
  });
