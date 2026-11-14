import { Kyoot } from "kyoot";
import type { Kyoot as K } from "kyoot";
import { loop, type Options as Loop, type Requires } from "./loop.ts";
import type { Message } from "./model.ts";
import type { Schema } from "./schema.ts";
import type { Tool } from "./tool.ts";

export interface Options<T extends Tool = never> extends Loop<T> {
  readonly prompt?: string;
}

export interface Chat<T extends Tool = never> {
  readonly messages: Message[];
  ask(input: string): K<string, Requires<T>>;
  gen<A>(schema: Schema<A>, input: string): K<A, Requires<T>>;
}

// A conversation: each ask/gen appends to `messages`, so later turns see earlier ones.
export const chat = <T extends Tool = never>(options: Options<T> = {}): Chat<T> => {
  const messages: Message[] = [];
  const system: Message[] = options.prompt ? [{ role: "system", content: options.prompt }] : [];
  const turn = <A>(input: string, schema?: Schema<A>) =>
    Kyoot.gen(function* () {
      messages.push({ role: "user", content: input });
      const [value, added] = yield* loop([...system, ...messages], options, schema);
      messages.push(...added);
      return value;
    });
  return {
    messages,
    ask: (input) => turn<string>(input) as never,
    gen: (schema, input) => turn(input, schema) as never,
  };
};

export const ask = <T extends Tool = never>(input: string, options?: Options<T>) =>
  chat(options).ask(input);

export const gen = <A, T extends Tool = never>(
  schema: Schema<A>,
  input: string,
  options?: Options<T>,
) => chat(options).gen(schema, input);
