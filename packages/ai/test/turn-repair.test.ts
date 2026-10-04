import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Emit, Fail, Kyoot } from "kyoot";
import { z } from "zod";
import {
  AI,
  Approve,
  Events,
  Model,
  Tool,
  TurnBusy,
  TurnDiscarded,
  UnknownToolOutcome,
  needsApproval,
  type Completion,
  type Request,
} from "@kyoot/ai";

const answer = { id: "answer", name: "answer", arguments: '"first"' };
const write = { id: "write", name: "write", arguments: "{}" };
const done: Completion = { text: "done", toolCalls: [] };

for (const calls of [
  [answer, write],
  [write, answer],
]) {
  test(`structured output records every call in ${calls.map((call) => call.name).join(", ")}`, () => {
    let writes = 0;
    let models = 0;
    const ai = AI.make({
      tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
    });
    const result = Kyoot.runSync(
      ai.gen(z.string(), "go").pipe(
        Model.handle({
          onOp: (_, resume) => {
            models++;
            return resume({ text: "", toolCalls: calls });
          },
        }),
        Emit.discard,
        Fail.orThrow,
      ),
    );
    assert.equal(result, "first");
    assert.equal(writes, 1);
    assert.equal(models, 1);
    assert.deepEqual(
      ai.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
      calls.map((call) => call.id),
    );
  });
}

test("the first valid answer wins while later answers and tools receive receipts", () => {
  let writes = 0;
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const calls = [
    { ...answer, id: "invalid", arguments: "42" },
    answer,
    { ...answer, id: "later", arguments: '"second"' },
    write,
  ];
  assert.equal(
    Kyoot.runSync(
      ai
        .gen(z.string(), "go")
        .pipe(
          Model.handle({ onOp: (_, resume) => resume({ text: "", toolCalls: calls }) }),
          Emit.discard,
          Fail.orThrow,
        ),
    ),
    "first",
  );
  assert.equal(writes, 1);
  const receipts = ai.messages.filter((message) => message.role === "tool");
  assert.deepEqual(
    receipts.map((message) => message.toolCallId),
    calls.map((call) => call.id),
  );
  assert.match(receipts[0]!.content, /string/);
  assert.deepEqual(
    receipts.slice(1).map((message) => message.content),
    ["ok", "ignored: answer already provided", "1"],
  );
});

test("an undefined structured answer is retained until later tools finish", () => {
  let writes = 0;
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const schema = z.string().transform(() => undefined);
  assert.equal(
    Kyoot.runSync(
      ai
        .gen(schema, "go")
        .pipe(
          Model.handle({ onOp: (_, resume) => resume({ text: "", toolCalls: [answer, write] }) }),
          Emit.discard,
          Fail.orThrow,
        ),
    ),
    undefined,
  );
  assert.equal(writes, 1);
});

test("a retained answer survives later approval and result notification failures", () => {
  let answers = 0;
  let models = 0;
  let approvals = 0;
  let notifications = 0;
  let writes = 0;
  const schema = z.string().transform((value) => ({ value, sequence: ++answers }));
  const ai = AI.make({
    tools: [needsApproval(Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes)))],
  });
  const action = ai.gen(schema, "go").pipe(
    Model.handle({
      onOp: (_, resume) => {
        models++;
        return resume({ text: "", toolCalls: [answer, write] });
      },
    }),
    Approve.handle({
      onOp: (_, resume) => (++approvals === 1 ? Fail.fail("approval unavailable") : resume(true)),
    }),
    Emit.forEach((event: Events.Event) =>
      event.type === "result" && event.call.id === "write" && ++notifications === 1
        ? Fail.fail("notification unavailable")
        : Kyoot.succeed(undefined),
    ),
    Fail.run,
  );
  assert.equal(Kyoot.runSync(action).ok, false);
  assert.equal(ai.messages.length, 0);
  assert.equal(Kyoot.runSync(action).ok, false);
  assert.equal(ai.messages.length, 0);
  assert.deepEqual(Kyoot.runSync(action), { ok: true, value: { value: "first", sequence: 1 } });
  assert.equal(answers, 1);
  assert.equal(models, 1);
  assert.equal(approvals, 2);
  assert.equal(notifications, 1);
  assert.equal(writes, 1);
});

for (const approved of [false, true]) {
  test(`an answer does not bypass a later ${approved ? "failed" : "denied"} tool`, () => {
    let writes = 0;
    let approvals = 0;
    const ai = AI.make({
      tools: [
        needsApproval(
          Tool("write", "write", z.object({}), () => {
            writes++;
            return Fail.fail("write failed");
          }),
        ),
      ],
    });
    const result = Kyoot.runSync(
      ai.gen(z.string(), "go").pipe(
        Model.handle({ onOp: (_, resume) => resume({ text: "", toolCalls: [answer, write] }) }),
        Approve.handle({
          onOp: (_, resume) => {
            approvals++;
            return resume(approved);
          },
        }),
        Emit.discard,
        Fail.orThrow,
      ),
    );
    assert.equal(result, "first");
    assert.equal(writes, Number(approved));
    assert.equal(approvals, 1);
    assert.deepEqual(
      ai.messages.filter((message) => message.role === "tool").map((message) => message.content),
      ["ok", approved ? 'error: "write failed"' : '{"denied":true}'],
    );
  });
}

test("a later unknown tool outcome prevents publishing the retained answer", () => {
  let writes = 0;
  const ai = AI.make({
    tools: [
      Tool("write", "write", z.object({}), () =>
        Kyoot.gen(function* () {
          writes++;
          throw new Error("lost receipt");
        }),
      ),
    ],
  });
  const action = ai
    .gen(z.string(), "go")
    .pipe(
      Model.handle({ onOp: (_, resume) => resume({ text: "", toolCalls: [answer, write] }) }),
      Emit.discard,
      Fail.run,
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = Kyoot.runSync(action);
    assert.ok(
      !result.ok &&
        result.cause._tag === "Fail" &&
        result.cause.error instanceof UnknownToolOutcome,
    );
  }
  assert.equal(writes, 1);
  assert.equal(ai.messages.length, 0);
});

test("accepted completions are isolated from later provider mutation", () => {
  let writes = 0;
  let requests = 0;
  const first = { text: "original", toolCalls: [{ ...write, id: "original" }] };
  const seen: Request[] = [];
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const action = ai.ask("go").pipe(
    Model.handle({
      onOp: (request, resume) => {
        seen.push(request);
        requests++;
        return requests === 2 ? Fail.fail("temporary") : resume(requests === 1 ? first : done);
      },
    }),
    Emit.discard,
    Fail.run,
  );
  assert.equal(Kyoot.runSync(action).ok, false);
  first.text = "changed";
  first.toolCalls[0]!.id = "changed";
  first.toolCalls.push({ ...write, id: "injected" });
  assert.deepEqual(Kyoot.runSync(action), { ok: true, value: "done" });
  assert.equal(writes, 1);
  assert.deepEqual(seen[1], seen[2]);
  assert.deepEqual(
    ai.messages.filter((message) => message.role !== "user"),
    [
      { role: "assistant", content: "original", toolCalls: [{ ...write, id: "original" }] },
      { role: "tool", toolCallId: "original", content: "1" },
      { role: "assistant", content: "done" },
    ],
  );
});

test("event consumers cannot mutate accepted tool calls", () => {
  let writes = 0;
  let models = 0;
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  Kyoot.runSync(
    ai.ask("go").pipe(
      Model.handle({
        onOp: (_, resume) => resume(++models === 1 ? { text: "", toolCalls: [write] } : done),
      }),
      Emit.forEach((event: Events.Event) => {
        if (event.type !== "text") {
          assert.ok(Object.isFrozen(event.call));
          assert.throws(
            () => Object.assign(event.call, { id: "changed", name: "missing" }),
            TypeError,
          );
        }
        return Kyoot.succeed(undefined);
      }),
      Fail.orThrow,
    ),
  );
  assert.equal(writes, 1);
  assert.equal(ai.messages.find((message) => message.role === "tool")?.toolCallId, "write");
});

test("pending calls use the accepted completion after a notification failure", () => {
  let writes = 0;
  let notifications = 0;
  const first = { text: "", toolCalls: [{ ...answer }, { ...write }] };
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const action = ai.gen(z.string(), "go").pipe(
    Model.handle({ onOp: (_, resume) => resume(first) }),
    Emit.forEach(() =>
      ++notifications === 1 ? Fail.fail("notification unavailable") : Kyoot.succeed(undefined),
    ),
    Fail.run,
  );
  assert.equal(Kyoot.runSync(action).ok, false);
  first.toolCalls[0]!.arguments = '"changed"';
  first.toolCalls[1]!.name = "missing";
  first.toolCalls.push({ ...write, id: "injected" });
  assert.deepEqual(Kyoot.runSync(action), { ok: true, value: "first" });
  assert.equal(writes, 1);
  assert.deepEqual(
    ai.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    ["answer", "write"],
  );
});

for (const structured of [false, true]) {
  test(`AI.discard releases a failed ${structured ? "gen" : "ask"} convenience turn`, () => {
    let writes = 0;
    const ai = AI.make({
      tools: [
        Tool("write", "write", z.object({}), () =>
          Kyoot.gen(function* () {
            writes++;
            throw new Error("lost receipt");
          }),
        ),
      ],
    });
    const action = (structured ? ai.gen(z.string(), "first") : ai.ask("first")).pipe(
      Model.handle({ onOp: (_, resume) => resume({ text: "", toolCalls: [write] }) }),
      Emit.discard,
      Fail.run,
    );
    const failed = Kyoot.runSync(action);
    assert.ok(
      !failed.ok &&
        failed.cause._tag === "Fail" &&
        failed.cause.error instanceof UnknownToolOutcome,
    );
    const next = ai
      .ask("next")
      .pipe(Model.handle({ onOp: (_, resume) => resume(done) }), Emit.discard, Fail.run);
    const busy = Kyoot.runSync(next);
    assert.ok(!busy.ok && busy.cause._tag === "Fail" && busy.cause.error instanceof TurnBusy);
    ai.discard();
    const stale = Kyoot.runSync(action);
    assert.ok(
      !stale.ok && stale.cause._tag === "Fail" && stale.cause.error instanceof TurnDiscarded,
    );
    assert.deepEqual(Kyoot.runSync(next), { ok: true, value: "done" });
    ai.discard();
    assert.deepEqual(Kyoot.runSync(next), { ok: true, value: "done" });
    assert.equal(writes, 1);
    assert.deepEqual(
      ai.messages.map((message) => message.content),
      ["next", "done"],
    );
  });
}

test("AI.discard rejects an active convenience turn and leaves it running", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ai = AI.make();
  ai.discard();
  const active = Kyoot.runPromise(
    ai.ask("first").pipe(
      Model.handle({
        onOp: (_, resume) =>
          Async.fromPromise(async () => {
            entered();
            await waiting;
            return done;
          }).flatMap(resume),
      }),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  await started;
  try {
    assert.throws(() => ai.discard(), TurnBusy);
  } finally {
    release();
  }
  assert.equal(await active, "done");
  assert.deepEqual(
    ai.messages.map((message) => message.content),
    ["first", "done"],
  );
});

test("result encoding defects report an unknown outcome immediately without replay", () => {
  let writes = 0;
  const cause = new Error("encoding failed");
  const ai = AI.make({
    tools: [
      Tool("write", "write", z.object({}), () => {
        writes++;
        return Kyoot.succeed({
          toJSON() {
            throw cause;
          },
        });
      }),
    ],
  });
  const run = ai
    .ask("go")
    .pipe(
      Model.handle({ onOp: (_, resume) => resume({ text: "", toolCalls: [write] }) }),
      Emit.discard,
      Fail.run,
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = Kyoot.runSync(run);
    assert.ok(!result.ok && result.cause._tag === "Fail");
    assert.ok(result.cause.error instanceof UnknownToolOutcome);
    assert.equal(result.cause.error.cause, cause);
  }
  assert.equal(writes, 1);
  assert.deepEqual(ai.messages, []);
  ai.discard();
});
