import { Fail, InterruptedError, Kyoot } from "kyoot";
import type { Kyoot as K, MergeAll } from "kyoot";
import * as Events from "./events.ts";
import { Model, type Message, type Request } from "./model.ts";
import * as Schema from "./schema.ts";
import { schemaOf, type Tool } from "./tool.ts";

export class TooManyRounds {
  readonly _tag = "TooManyRounds";
}

/** A model response or tool list that cannot be represented safely in the chat protocol. */
export class ToolPolicyError {
  readonly _tag = "ToolPolicyError";
  constructor(readonly message: string) {}
}

export interface Options<A, T extends Tool> {
  readonly tools?: readonly T[];
  readonly rounds?: number;
  readonly schema?: Schema.Schema<A>;
}

export type Requires<T extends Tool> = MergeAll<
  | { "ai/model": Request; emit: Events.Event; fail: TooManyRounds | ToolPolicyError }
  | (T extends Tool<any, any, infer S> ? Omit<S, "fail"> : never)
>;

const toolPolicy = (tools: readonly Tool[]) => {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.name === "answer") return new ToolPolicyError("tool name 'answer' is reserved");
    if (names.has(tool.name)) return new ToolPolicyError(`duplicate tool name '${tool.name}'`);
    names.add(tool.name);
  }
  return undefined;
};

const show = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

const parse = <A>(schema: Schema.Schema<A>, raw: string): { args: A } | { error: string } => {
  try {
    return { args: Schema.parse(schema, JSON.parse(raw)) };
  } catch (e) {
    return { error: show(e) };
  }
};

const run = (tool: Tool, args: unknown) =>
  tool
    .run(args)
    .pipe(Fail.run)
    .map((r) => {
      if (r.ok) return JSON.stringify(r.value);
      if (r.cause._tag === "Fail") return `error: ${show(r.cause.error)}`;
      throw r.cause._tag === "Defect" ? r.cause.defect : new InterruptedError();
    });

export function generate<T extends Tool = never>(
  messages: readonly Message[],
  options?: Options<string, T> & { readonly schema?: undefined },
): K<readonly [string, Message[]], Requires<T>>;
export function generate<A, T extends Tool = never>(
  messages: readonly Message[],
  options: Options<A, T> & { readonly schema: Schema.Schema<A> },
): K<readonly [A, Message[]], Requires<T>>;
export function generate<A = string, T extends Tool = never>(
  messages: readonly Message[],
  { tools = [], rounds = 8, schema }: Options<A, T> = {},
): K<readonly [A, Message[]], Requires<T>> {
  if (!Number.isSafeInteger(rounds) || rounds < 0) {
    throw new RangeError("AI rounds must be a non-negative integer");
  }
  return Kyoot.gen(function* () {
    const policy = toolPolicy(tools);
    if (policy) return yield* Fail.fail(policy);
    const schemas = tools.map(schemaOf);
    if (schema)
      schemas.push({
        name: "answer",
        description: "Give the final answer",
        parameters: Schema.jsonSchema(schema),
      });
    const added: Message[] = [];
    for (let round = 0; round < rounds; round++) {
      const { text, toolCalls } = yield* Model({
        messages: [...messages, ...added],
        tools: schemas.length > 0 ? schemas : undefined,
        toolChoice: schema ? "required" : "auto",
      });
      if (schema && toolCalls.length > 1 && toolCalls.some((call) => call.name === "answer")) {
        return yield* Fail.fail(
          new ToolPolicyError("an 'answer' call must be the only tool call in a model response"),
        );
      }
      added.push({ role: "assistant", content: text, ...(toolCalls.length > 0 && { toolCalls }) });
      if (!schema && toolCalls.length === 0) return [text as A, added] as const;
      for (const call of toolCalls) {
        yield* Events.emit({ type: "call", call });
        const tool = tools.find((t) => t.name === call.name);
        const args = schema && call.name === "answer" ? schema : tool?.args;
        const r = args ? parse(args, call.arguments) : { error: `unknown tool ${call.name}` };
        const content = "error" in r ? r.error : tool ? yield* run(tool, r.args) : "ok";
        added.push({ role: "tool", toolCallId: call.id, content });
        yield* Events.emit({ type: "result", call, content });
        if (!("error" in r) && !tool) return [r.args as A, added] as const;
      }
    }
    return yield* Fail.fail(new TooManyRounds());
  }) as never;
}
