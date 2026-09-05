import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, effect, Emit, Fail, Kyoot } from "kyoot";
import { z } from "zod";
import {
  AI,
  Approve,
  Events,
  generate,
  Mode,
  Model,
  needsApproval,
  TooManyRounds,
  Tool,
  ToolPolicyError,
  type Completion,
  type Requires,
  type Request,
} from "@kyoot/ai";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const Calc = effect<{ expression: string }, number>()("calc");
const calc = Tool("calc", "arithmetic", z.object({ expression: z.string() }), Calc);
const emitting = Tool("emitting", "emits numbers", z.object({}), () => Emit.value(1));
type _emittingRow = Expect<Equal<Requires<typeof emitting>["emit"], Events.Event | number>>;
const evaluate = Calc.handle({
  onOp: ({ expression }, resume) => resume(expression === "2+2" ? 4 : NaN),
});

const call = (name: string, args: object): Completion => ({
  text: "",
  toolCalls: [{ id: "1", name, arguments: JSON.stringify(args) }],
});
const say = (text: string, usage?: Completion["usage"]): Completion => ({
  text,
  toolCalls: [],
  usage,
});

const scripted = (script: readonly Completion[], seen: Request[] = []) =>
  Model.handle({
    initial: 0,
    onOp: (req, resume, i) => {
      seen.push(req);
      return resume(script[Math.min(i, script.length - 1)]!, i + 1);
    },
  });

test("ask: runs tool calls as effects and feeds results back", () => {
  const seen: Request[] = [];
  const answer = Kyoot.runSync(
    AI.ask("what is 2+2?", { tools: [calc] }).pipe(
      scripted([call("calc", { expression: "2+2" }), say("it is 4")], seen),
      evaluate,
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.equal(answer, "it is 4");
  assert.deepEqual(
    seen[0]!.tools?.map((t) => t.name),
    ["calc"],
  );
  assert.deepEqual(seen[1]!.messages.at(-1), { role: "tool", toolCallId: "1", content: "4" });
});

test("gen: decodes the answer tool, sending bad arguments back", () => {
  const seen: Request[] = [];
  const Answer = z.object({ value: z.number() });
  const answer = Kyoot.runSync(
    AI.gen(Answer, "2+2?").pipe(
      scripted([call("answer", { value: "four" }), call("answer", { value: 4 })], seen),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(answer, { value: 4 });
  assert.equal(seen[0]!.toolChoice, "required");
  assert.match((seen[1]!.messages.at(-1) as { content: string }).content, /expected number/);
});

test("ask: gives up with TooManyRounds", () => {
  const r = Kyoot.runSync(
    AI.ask("loop", { tools: [calc], rounds: 2 }).pipe(
      scripted([call("calc", { expression: "1" })]),
      evaluate,
      Emit.discard,
      Fail.run,
    ),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof TooManyRounds);
});

test("AI rounds accepts zero and rejects invalid values", () => {
  const zero = Kyoot.runSync(
    AI.ask("no turns", { rounds: 0 }).pipe(scripted([say("unexpected")]), Emit.discard, Fail.run),
  );
  assert.ok(!zero.ok && zero.cause._tag === "Fail" && zero.cause.error instanceof TooManyRounds);
  for (const rounds of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const seen: Request[] = [];
    assert.throws(
      () =>
        AI.ask("bad", { rounds }).pipe(
          scripted([say("unexpected")], seen),
          Emit.discard,
          Fail.orThrow,
          Kyoot.runSync,
        ),
      RangeError,
    );
    assert.equal(seen.length, 0);
  }
});

test("generate: one shot, returns the new messages", () => {
  const [value, added] = Kyoot.runSync(
    generate([{ role: "user", content: "hi" }]).pipe(
      scripted([say("hey")]),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.equal(value, "hey");
  assert.deepEqual(added, [{ role: "assistant", content: "hey" }]);
});

test("instances keep history; agents compose as tools with their own model", () => {
  const critic = AI.make({ prompt: "You critique." });
  const consult = Tool("critic", "ask the critic", z.object({ draft: z.string() }), ({ draft }) =>
    critic.ask(draft).pipe(scripted([say("too long")])),
  );
  const writer = AI.make({ tools: [consult] });
  const seen: Request[] = [];
  const [answer, usage] = Kyoot.runSync(
    Kyoot.gen(function* () {
      yield* writer.ask("write a haiku");
      return yield* writer.ask("shorter");
    }).pipe(
      Mode.usage,
      scripted(
        [call("critic", { draft: "roses are red" }), say("ok", { input: 3, output: 1 })],
        seen,
      ),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.equal(answer, "ok");
  assert.deepEqual(usage, { input: 6, output: 2 });
  assert.equal(critic.messages.length, 2);
  assert.equal(seen.at(-1)!.messages.length, 5);
});

test("top-level programs start with a fresh conversation on every run", () => {
  const seen: Request[] = [];
  const program = AI.ask("hello").pipe(scripted([say("hi")], seen), Emit.discard, Fail.orThrow);
  assert.equal(Kyoot.runSync(program), "hi");
  assert.equal(Kyoot.runSync(program), "hi");
  assert.deepEqual(
    seen.map((request) => request.messages),
    [[{ role: "user", content: "hello" }], [{ role: "user", content: "hello" }]],
  );
});

test("instances commit a whole turn only after it succeeds", () => {
  const agent = AI.make({ tools: [calc], rounds: 1 });
  const failed = Kyoot.runSync(
    agent
      .ask("bad")
      .pipe(scripted([call("calc", { expression: "1" })]), evaluate, Emit.discard, Fail.run),
  );
  assert.ok(!failed.ok && failed.cause._tag === "Fail");
  assert.deepEqual(agent.messages, []);

  assert.equal(
    Kyoot.runSync(
      agent.ask("good").pipe(scripted([say("ok")]), evaluate, Emit.discard, Fail.orThrow),
    ),
    "ok",
  );
  assert.deepEqual(agent.messages, [
    { role: "user", content: "good" },
    { role: "assistant", content: "ok" },
  ]);
});

test("instances reject concurrent turns and release the turn lock after interruption", async () => {
  const agent = AI.make();
  const result = await Kyoot.runPromise(
    Async.all([agent.ask("first"), agent.ask("second")]).pipe(
      Model.handle({ onOp: () => Async.never }),
      Emit.discard,
      Fail.run,
    ),
  );
  assert.ok(
    !result.ok &&
      result.cause._tag === "Fail" &&
      result.cause.error instanceof AI.ConcurrentTurnError,
  );
  assert.deepEqual(agent.messages, []);
  assert.equal(
    Kyoot.runSync(
      agent.ask("after").pipe(scripted([say("ok")]), evaluate, Emit.discard, Fail.orThrow),
    ),
    "ok",
  );
});

test("tool names are unique and cannot claim the answer channel", () => {
  const duplicate = Tool("same", "one", z.object({}), () => Kyoot.succeed(undefined));
  const duplicateAgain = Tool("same", "two", z.object({}), () => Kyoot.succeed(undefined));
  const reserved = Tool("answer", "bad", z.object({}), () => Kyoot.succeed(undefined));
  for (const tools of [[duplicate, duplicateAgain], [reserved]] as const) {
    const result = Kyoot.runSync(
      AI.ask("hi", { tools }).pipe(scripted([say("unused")]), Emit.discard, Fail.run),
    );
    assert.ok(
      !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof ToolPolicyError,
    );
  }
});

test("a mixed answer response fails before an incomplete tool protocol can commit", () => {
  const agent = AI.make({ tools: [calc] });
  const result = Kyoot.runSync(
    agent.gen(z.object({ value: z.number() }), "solve").pipe(
      scripted([
        {
          text: "",
          toolCalls: [
            { id: "answer", name: "answer", arguments: '{"value":4}' },
            { id: "calc", name: "calc", arguments: '{"expression":"2+2"}' },
          ],
        },
      ]),
      evaluate,
      Emit.discard,
      Fail.run,
    ),
  );
  assert.ok(
    !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof ToolPolicyError,
  );
  assert.deepEqual(agent.messages, []);
});

test("usage includes model calls made by concurrent child fibers", async () => {
  const [answers, total] = await Kyoot.runPromise(
    Async.all([AI.ask("a"), AI.ask("b")]).pipe(
      Mode.usage,
      Model.handle({ onOp: (_request, resume) => resume(say("ok", { input: 2, output: 1 })) }),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(answers, ["ok", "ok"]);
  assert.deepEqual(total, { input: 4, output: 2 });
});

test("modes: system prompts and config layer around the model", () => {
  const seen: Request[] = [];
  Kyoot.runSync(
    AI.ask("hi").pipe(
      Mode.system("inner"),
      Mode.system("outer"),
      Mode.config({ temperature: 0 }),
      scripted([say("hey")], seen),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(
    seen[0]!.messages.map((m) => m.content),
    ["outer", "inner", "hi"],
  );
  assert.equal(seen[0]!.temperature, 0);
});

test("events: text from the provider, calls and results from the loop", () => {
  const events: Events.Event[] = [];
  Kyoot.runSync(
    AI.ask("2+2?", { tools: [calc] }).pipe(
      Model.handle({
        initial: 0,
        onOp: (_req, resume, i) =>
          Emit.value<Events.Event>({ type: "text", text: "hm" }).flatMap(() =>
            resume(i === 0 ? call("calc", { expression: "2+2" }) : say("4"), i + 1),
          ),
      }),
      evaluate,
      Emit.forEach((e: Events.Event) => events.push(e)),
      Fail.orThrow,
    ),
  );
  assert.deepEqual(
    events.map((e) => (e.type === "text" ? e.text : e.type === "call" ? e.call.name : e.content)),
    ["hm", "calc", "4", "hm"],
  );
});

test("approval is an effect the tool performs", () => {
  const seen: Request[] = [];
  const program = AI.ask("2+2?", { tools: [needsApproval(calc)] }).pipe(
    scripted([call("calc", { expression: "2+2" }), say("done")], seen),
    evaluate,
    Emit.discard,
    Fail.orThrow,
  );
  const result = (content: string) => ({ role: "tool", toolCallId: "1", content });
  Kyoot.runSync(program.pipe(Approve.handle({ onOp: (_, resume) => resume(false) })));
  assert.deepEqual(seen[1]!.messages.at(-1), result('{"denied":true}'));
  Kyoot.runSync(
    program.pipe(Approve.handle({ onOp: ({ tool }, resume) => resume(tool === "calc") })),
  );
  assert.deepEqual(seen[3]!.messages.at(-1), result("4"));
});

test("a tool's typed failure goes back to the model, not up the stack", () => {
  const seen: Request[] = [];
  const flaky = Tool("flaky", "fails", z.object({}), () => Fail.fail({ _tag: "Boom" }));
  const answer = Kyoot.runSync(
    AI.ask("try", { tools: [flaky] }).pipe(
      scripted([call("flaky", {}), say("it failed")], seen),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.equal(answer, "it failed");
  assert.equal((seen[1]!.messages.at(-1) as { content: string }).content, 'error: {"_tag":"Boom"}');
});
