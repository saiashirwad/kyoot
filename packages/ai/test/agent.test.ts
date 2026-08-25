import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, Emit, Fail, Kyoot, Log } from "kyoot";
import { ask, Model, TooManyRounds, Tool, type Completion, type Request } from "@kyoot/ai";

const Calc = effect<{ expression: string }, number>()("calc");
const calc = Tool({ name: "calc", description: "arithmetic", parameters: {} }, Calc);

const scripted = (script: readonly Completion[], seen: Request[] = []) =>
  Model.handle({
    initial: 0,
    onOp: (req, resume, i) =>
      Kyoot.gen(function* () {
        seen.push(req);
        const c = script[Math.min(i, script.length - 1)]!;
        for (const token of c.text.split(" ")) yield* Emit.value(token);
        return yield* resume(c, i + 1);
      }),
  });

test("ask: runs tool calls as effects and feeds results back", () => {
  const seen: Request[] = [];
  const [[answer, tokens], logs] = Kyoot.runSync(
    ask("what is 2+2?", [calc]).pipe(
      scripted(
        [
          { text: "", toolCalls: [{ id: "1", name: "calc", arguments: '{"expression":"2+2"}' }] },
          { text: "it is 4", toolCalls: [] },
        ],
        seen,
      ),
      Calc.handle({ onOp: ({ expression }, resume) => resume(expression === "2+2" ? 4 : NaN) }),
      Emit.run,
      Log.collect,
      Fail.orThrow,
    ),
  );
  assert.equal(answer, "it is 4");
  assert.deepEqual(tokens, ["", "it", "is", "4"]);
  assert.deepEqual(logs, [{ level: "info", message: 'tool calc({"expression":"2+2"})' }]);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]!.messages.at(-1), { role: "tool", toolCallId: "1", content: "4" });
});

test("ask: gives up with TooManyRounds", () => {
  const r = Kyoot.runSync(
    ask("loop", [calc], { rounds: 2 }).pipe(
      scripted([
        { text: "", toolCalls: [{ id: "1", name: "calc", arguments: '{"expression":"1"}' }] },
      ]),
      Calc.handle({ onOp: (_, resume) => resume(1) }),
      Emit.discard,
      Log.discard,
      Fail.run,
    ),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof TooManyRounds);
});
