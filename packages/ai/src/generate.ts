import { Fail, Kyoot, Resource } from "kyoot";
import type { Kyoot as K, MergeAll, Requirement } from "kyoot";
import * as Events from "./events.ts";
import { Model, type Message, type Request, type Completion } from "./model.ts";
import * as Schema from "./schema.ts";
import { schemaOf, approvalOf, Approve, type Tool } from "./tool.ts";
import {
  snapshot,
  snapshotCompletion,
  TurnBusy,
  TurnDiscarded,
  UnknownToolOutcome,
} from "./turn.ts";

export class TooManyRounds {
  readonly _tag = "TooManyRounds";
}

export interface Options<A, T extends Tool> {
  readonly tools?: readonly T[];
  readonly rounds?: number;
  readonly schema?: Schema.Schema<A>;
}

export type Requires<T extends Tool> = MergeAll<
  | {
      "ai/model": Requirement<Request, Completion>;
      emit: Requirement<Events.Event, void>;
      fail: Requirement<TooManyRounds | TurnBusy | TurnDiscarded | UnknownToolOutcome, never>;
    }
  | (T extends Tool<any, any, infer S> ? Omit<S, "fail"> : never)
>;

const show = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

const parse = <A>(schema: Schema.Schema<A>, raw: string): { args: A } | { error: string } => {
  try {
    return { args: Schema.parse(schema, JSON.parse(raw)) };
  } catch (e) {
    return { error: show(e) };
  }
};

type Progress<A> =
  | { kind: "model" }
  | {
      kind: "calls";
      completion: Completion;
      index: number;
      notified: boolean;
      approval: boolean | undefined;
      answer: { value: A } | undefined;
    }
  | { kind: "unknown"; error: UnknownToolOutcome }
  | { kind: "done"; value: A };

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
  { tools: configuredTools = [], rounds = 8, schema }: Options<A, T> = {},
): K<readonly [A, Message[]], Requires<T>> {
  const tools = [...configuredTools];
  const initial = snapshot(messages);
  const added: Message[] = [];
  let progress: Progress<A> = { kind: "model" };
  let round = 0;
  let running = false;
  return Kyoot.gen(function* () {
    if (running) return yield* Fail.fail(new TurnBusy());
    yield* Resource.acquire(
      () => {
        running = true;
      },
      () => {
        running = false;
      },
    );
    if (schema && tools.some((tool) => tool.name === "answer"))
      throw new Error("Tool name answer is reserved for structured output");
    const schemas = tools.map(schemaOf);
    if (schema)
      schemas.push({
        name: "answer",
        description: "Give the final answer",
        parameters: Schema.jsonSchema(schema),
      });
    while (true) {
      if (progress.kind === "done") return [progress.value, snapshot(added)] as const;
      if (progress.kind === "unknown") return yield* Fail.fail(progress.error);
      if (progress.kind === "model") {
        if (round >= rounds) return yield* Fail.fail(new TooManyRounds());
        const result = yield* Model({
          messages: snapshot([...initial, ...added]),
          tools: schemas.length > 0 ? schemas : undefined,
          toolChoice: schema ? "required" : "auto",
        });
        const completion = snapshotCompletion(result);
        round++;
        const { text, toolCalls } = completion;
        added.push({
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 && { toolCalls }),
        });
        progress =
          !schema && toolCalls.length === 0
            ? { kind: "done", value: text as A }
            : {
                kind: "calls",
                completion,
                index: 0,
                notified: false,
                approval: undefined,
                answer: undefined,
              };
        continue;
      }
      const current = progress;
      const call = current.completion.toolCalls[current.index];
      if (!call) {
        progress = current.answer
          ? { kind: "done", value: current.answer.value }
          : { kind: "model" };
        continue;
      }
      if (!current.notified) {
        current.notified = true;
        yield* Events.emit({ type: "call", call });
      }
      const tool = tools.find((t) => t.name === call.name);
      const args = schema && call.name === "answer" ? schema : tool?.args;
      const parsed = args ? parse(args, call.arguments) : { error: `unknown tool ${call.name}` };
      let content: string;
      if ("error" in parsed) content = parsed.error;
      else if (tool) {
        const approved = approvalOf(tool);
        if (approved && current.approval === undefined)
          current.approval = yield* Approve({ tool: tool.name, args: parsed.args });
        if (current.approval === false) content = '{"denied":true}';
        else {
          progress = { kind: "unknown", error: new UnknownToolOutcome(call) };
          const outcome = yield* Kyoot.gen(function* () {
            const value = yield* (approved ?? tool).run(parsed.args);
            return JSON.stringify(value) ?? "null";
          }).pipe(Fail.run);
          if (outcome.ok) content = outcome.value;
          else if (outcome.cause._tag === "Fail") content = `error: ${show(outcome.cause.error)}`;
          else {
            const error = new UnknownToolOutcome(
              call,
              outcome.cause._tag === "Defect" ? outcome.cause.defect : undefined,
            );
            progress = { kind: "unknown", error };
            return yield* Fail.fail(error);
          }
        }
      } else if (current.answer) content = "ignored: answer already provided";
      else {
        current.answer = { value: parsed.args as A };
        content = "ok";
      }
      added.push({ role: "tool", toolCallId: call.id, content });
      progress = {
        kind: "calls",
        completion: current.completion,
        index: current.index + 1,
        notified: false,
        approval: undefined,
        answer: current.answer,
      };
      yield* Events.emit({ type: "result", call, content });
    }
  }).pipe(Resource.run) as never;
}
