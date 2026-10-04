import { Fail, Kyoot, Resource } from "kyoot";
import type { Kyoot as K } from "kyoot";
import { generate, type Options as Generate, type Requires } from "./generate.ts";
import type { Message } from "./model.ts";
import type { Schema } from "./schema.ts";
import type { Tool } from "./tool.ts";
import { snapshot, TurnBusy, TurnDiscarded, type Turn } from "./turn.ts";

export interface Options<T extends Tool = never> extends Omit<Generate<never, T>, "schema"> {
  readonly prompt?: string;
  readonly messages?: readonly Message[];
}

export interface AI<T extends Tool = never> {
  readonly messages: readonly Message[];
  turn(input?: string): Turn<string, T>;
  turn<A>(schema: Schema<A>, input?: string): Turn<A, T>;
  ask(input?: string): K<string, Requires<T>>;
  gen<A>(schema: Schema<A>, input?: string): K<A, Requires<T>>;
  discard(): void;
}

export const make = <T extends Tool = never>(options: Options<T> = {}): AI<T> => {
  const messages = snapshot(options.messages ?? []);
  const system: Message[] = options.prompt ? [{ role: "system", content: options.prompt }] : [];
  let owner: (() => void) | undefined;
  function turn(input?: string): Turn<string, T>;
  function turn<A>(schema: Schema<A>, input?: string): Turn<A, T>;
  function turn<A = string>(first?: string | Schema<A>, second?: string): Turn<A, T> {
    const schema = typeof first === "object" ? first : undefined;
    const input = typeof first === "string" ? first : second;
    const config = { ...options, tools: options.tools ? [...options.tools] : undefined };
    let state: { kind: "open" } | { kind: "done"; value: A } | { kind: "discarded" } = {
      kind: "open",
    };
    let running = false;
    let generation: K<readonly [A | string, Message[]], Requires<T>> | undefined;
    const prompt: Message[] = input === undefined ? [] : [{ role: "user", content: input }];
    const discard = () => {
      if (running) throw new TurnBusy();
      state = { kind: "discarded" };
      if (owner === discard) owner = undefined;
    };
    const run = Kyoot.gen(function* () {
      if (running) return yield* Fail.fail(new TurnBusy());
      if (state.kind === "discarded") return yield* Fail.fail(new TurnDiscarded());
      if (state.kind === "done") return state.value;
      if (owner !== undefined && owner !== discard) return yield* Fail.fail(new TurnBusy());
      yield* Resource.acquire(
        () => {
          running = true;
          owner = discard;
        },
        () => {
          running = false;
        },
      );
      if (!generation) {
        const initial = [...system, ...messages, ...prompt];
        generation = schema ? generate(initial, { ...config, schema }) : generate(initial, config);
      }
      const [value, added] = yield* generation;
      messages.push(...prompt, ...added);
      state = { kind: "done", value: value as A };
      owner = undefined;
      return state.value;
    }).pipe(Resource.run) as K<A, Requires<T>>;
    return { run, discard };
  }
  return {
    get messages() {
      return Object.freeze(snapshot(messages));
    },
    turn,
    ask: (input) => turn(input).run,
    gen: (schema, input) => turn(schema, input).run,
    discard: () => owner?.(),
  };
};

export const ask = <T extends Tool = never>(input: string, options?: Options<T>) =>
  make(options).ask(input);

export const gen = <A, T extends Tool = never>(
  schema: Schema<A>,
  input: string,
  options?: Options<T>,
) => make(options).gen(schema, input);
