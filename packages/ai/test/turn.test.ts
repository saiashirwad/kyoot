import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Emit, Fail, Kyoot, Retry, runFiber, InterruptedError } from "kyoot";
import { z } from "zod";
import {
  AI,
  Model,
  Tool,
  generate,
  TurnBusy,
  TurnDiscarded,
  UnknownToolOutcome,
  type Completion,
  type Request,
  Events,
  Approve,
  needsApproval,
} from "@kyoot/ai";

const call: Completion = { text: "", toolCalls: [{ id: "one", name: "write", arguments: "{}" }] };
const done: Completion = { text: "done", toolCalls: [] };

test("whole-turn Retry retains successful tool receipts and one prompt", () => {
  let writes = 0;
  let requests = 0;
  const seen: Request[] = [];
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const action = ai.ask("go");
  const model = Model.handle({
    onOp: (req, resume) => {
      seen.push(req);
      requests++;
      if (requests === 2) return Fail.fail("temporary");
      return resume(requests === 1 ? call : done);
    },
  });
  assert.equal(
    Kyoot.runSync(
      action.pipe(
        model,
        Emit.discard,
        Retry.run({ times: 1 }),
        Clock.virtual,
        (k) => k.map(([value]) => value),
        Fail.orThrow,
      ),
    ),
    "done",
  );
  assert.equal(writes, 1);
  assert.deepEqual(seen[1], seen[2]);
  assert.deepEqual(
    ai.messages.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(Kyoot.runSync(action.pipe(model, Emit.discard, Fail.orThrow)), "done");
  assert.equal(requests, 3);
});

test("failure of the first model request does not duplicate the prompt", () => {
  let requests = 0;
  const ai = AI.make();
  const action = ai.ask("go");
  Kyoot.runSync(
    action.pipe(
      Model.handle({
        onOp: (_, resume) => (++requests === 1 ? Fail.fail("temporary") : resume(done)),
      }),
      Emit.discard,
      Retry.run({ times: 1 }),
      Clock.virtual,
      (k) => k.map(([value]) => value),
      Fail.orThrow,
    ),
  );
  assert.deepEqual(
    ai.messages.map((m) => m.content),
    ["go", "done"],
  );
});

test("direct generate retains completed model and receipts", () => {
  let writes = 0;
  let requests = 0;
  const seen: Request[] = [];
  const action = generate([], {
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const result = Kyoot.runSync(
    action.pipe(
      Model.handle({
        onOp: (request, resume) => {
          seen.push(request);
          return ++requests === 2 ? Fail.fail("temporary") : resume(requests === 1 ? call : done);
        },
      }),
      Emit.discard,
      Retry.run({ times: 1 }),
      Clock.virtual,
      (k) => k.map(([value]) => value),
      Fail.orThrow,
    ),
  );
  assert.equal(writes, 1);
  assert.equal(requests, 3);
  assert.deepEqual(seen[1], seen[2]);
  assert.deepEqual(
    result[1].map((message) => message.role),
    ["assistant", "tool", "assistant"],
  );
  const replay = Kyoot.runSync(
    action.pipe(
      Model.handle({
        onOp: () => {
          throw new Error("completed model replayed");
        },
      }),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(replay, result);
});

test("failed notification preserves model completion and earlier tool receipts", () => {
  let writes = 0;
  let models = 0;
  let notified = false;
  const ai = AI.make({
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  const action = ai.ask("two");
  const result = Kyoot.runSync(
    action.pipe(
      Model.handle({
        onOp: (_, resume) =>
          resume(
            ++models === 1
              ? { text: "", toolCalls: [call.toolCalls[0]!, { ...call.toolCalls[0]!, id: "two" }] }
              : done,
          ),
      }),
      Emit.forEach((event: Events.Event) => {
        if (event.type === "result" && !notified) {
          notified = true;
          return Fail.fail("notification failed");
        }
        return Kyoot.succeed(undefined);
      }),
      Retry.run({ times: 1 }),
      Clock.virtual,
      Fail.orThrow,
    ),
  );
  assert.equal(result[0], "done");
  assert.equal(writes, 2);
  assert.equal(models, 2);
  assert.deepEqual(
    ai.messages.filter((m) => m.role === "tool").map((m) => m.content),
    ["1", "2"],
  );
});

test("a failing call notification does not lose the stored completion", () => {
  let writes = 0;
  let models = 0;
  let notifications = 0;
  const action = AI.ask("go", {
    tools: [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))],
  });
  Kyoot.runSync(
    action.pipe(
      Model.handle({ onOp: (_, resume) => resume(++models === 1 ? call : done) }),
      Emit.forEach(() =>
        ++notifications === 1 ? Fail.fail("notification") : Kyoot.succeed(undefined),
      ),
      Retry.run({ times: 1 }),
      Clock.virtual,
      Fail.orThrow,
    ),
  );
  assert.equal(writes, 1);
  assert.equal(models, 2);
});

test("tool defects retain an unknown outcome and never repeat the action", () => {
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
  const turn = ai.turn("go");
  const run = turn.run.pipe(
    Model.handle({ onOp: (_, resume) => resume(call) }),
    Emit.discard,
    Fail.run,
  );
  for (let i = 0; i < 2; i++) {
    const result = Kyoot.runSync(run);
    assert.ok(
      !result.ok &&
        result.cause._tag === "Fail" &&
        result.cause.error instanceof UnknownToolOutcome,
    );
    assert.ok(
      !result.ok &&
        result.cause._tag === "Fail" &&
        result.cause.error instanceof UnknownToolOutcome &&
        result.cause.error.cause instanceof Error &&
        result.cause.error.cause.message === "lost receipt",
    );
  }
  assert.equal(writes, 1);
  assert.equal(ai.messages.length, 0);
  turn.discard();
  const result = Kyoot.runSync(run);
  assert.ok(
    !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof TurnDiscarded,
  );
  assert.equal(
    Kyoot.runSync(
      ai
        .ask("next")
        .pipe(Model.handle({ onOp: (_, resume) => resume(done) }), Emit.discard, Fail.orThrow),
    ),
    "done",
  );
  assert.equal(writes, 1);
});

test("concurrent turns and concurrent runs fail before changing the conversation", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ai = AI.make();
  const turn = ai.turn("first");
  let models = 0;
  const model = Model.handle({
    onOp: (_, resume) =>
      Async.fromPromise(async () => {
        models++;
        entered();
        await waiting;
        return done;
      }).flatMap(resume),
  });
  const active = Kyoot.runPromise(turn.run.pipe(model, Emit.discard, Fail.orThrow));
  await started;
  assert.throws(() => turn.discard(), TurnBusy);
  for (const action of [turn.run, ai.ask("competing")]) {
    const result = await Kyoot.runPromise(action.pipe(model, Emit.discard, Fail.run));
    assert.ok(!result.ok && result.cause._tag === "Fail" && result.cause.error instanceof TurnBusy);
  }
  assert.equal(ai.messages.length, 0);
  release();
  assert.equal(await active, "done");
  assert.equal(models, 1);
  assert.deepEqual(
    ai.messages.map((m) => m.content),
    ["first", "done"],
  );
});

test("failed turns retain ownership until explicit discard", () => {
  const ai = AI.make();
  const turn = ai.turn("failed");
  Kyoot.runSync(
    turn.run.pipe(Model.handle({ onOp: () => Fail.fail("temporary") }), Emit.discard, Fail.run),
  );
  const next = ai.turn("next");
  const run = next.run.pipe(
    Model.handle({ onOp: (_, resume) => resume(done) }),
    Emit.discard,
    Fail.run,
  );
  const busy = Kyoot.runSync(run);
  assert.ok(!busy.ok && busy.cause._tag === "Fail" && busy.cause.error instanceof TurnBusy);
  turn.discard();
  assert.deepEqual(Kyoot.runSync(run), { ok: true, value: "done" });
  const stale = Kyoot.runSync(
    turn.run.pipe(Model.handle({ onOp: (_, resume) => resume(done) }), Emit.discard, Fail.run),
  );
  assert.ok(!stale.ok && stale.cause._tag === "Fail" && stale.cause.error instanceof TurnDiscarded);
  assert.deepEqual(
    ai.messages.map((m) => m.content),
    ["next", "done"],
  );
});

test("history is a frozen snapshot", () => {
  const ai = AI.make();
  const before = ai.messages;
  Kyoot.runSync(
    ai
      .ask("go")
      .pipe(Model.handle({ onOp: (_, resume) => resume(done) }), Emit.discard, Fail.orThrow),
  );
  assert.deepEqual(before, []);
  const after = ai.messages;
  assert.ok(Object.isFrozen(after));
  assert.ok(Object.isFrozen(after[0]));
  assert.notEqual(after, ai.messages);
});

test("an interrupted action stays unknown and releases the running guard", async () => {
  let writes = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ai = AI.make({
    tools: [
      Tool("write", "write", z.object({}), () =>
        Async.fromPromise(async () => {
          writes++;
          entered();
          return await new Promise<never>(() => {});
        }),
      ),
    ],
  });
  const turn = ai.turn("go");
  const run = turn.run.pipe(
    Model.handle({ onOp: (_, resume) => resume(call) }),
    Emit.discard,
    Fail.orThrow,
  );
  const fiber = runFiber(run);
  await started;
  fiber.interrupt();
  await assert.rejects(fiber.promise, InterruptedError);
  await assert.rejects(Kyoot.runPromise(run), UnknownToolOutcome);
  assert.equal(writes, 1);
  turn.discard();
  await assert.rejects(Kyoot.runPromise(run), TurnDiscarded);
});

test("approval is retained separately when a later notification fails", () => {
  let approvals = 0;
  let writes = 0;
  let models = 0;
  let notifications = 0;
  const tool = needsApproval(Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes)));
  const action = AI.ask("go", { tools: [tool] });
  Kyoot.runSync(
    action.pipe(
      Model.handle({ onOp: (_, resume) => resume(++models === 1 ? call : done) }),
      Approve.handle({
        onOp: (_, resume) => {
          approvals++;
          return resume(true);
        },
      }),
      Emit.forEach((event: Events.Event) =>
        event.type === "result" && ++notifications === 1
          ? Fail.fail("notification")
          : Kyoot.succeed(undefined),
      ),
      Retry.run({ times: 1 }),
      Clock.virtual,
      Fail.orThrow,
    ),
  );
  assert.equal(approvals, 1);
  assert.equal(writes, 1);
});

test("earlier receipts survive an unknown later tool in the same completion", () => {
  let writes = 0;
  let failures = 0;
  const ai = AI.make({
    tools: [
      Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes)),
      Tool("broken", "broken", z.object({}), () =>
        Kyoot.gen(function* () {
          failures++;
          throw new Error("unknown");
        }),
      ),
    ],
  });
  const action = ai.ask("go").pipe(
    Model.handle({
      onOp: (_, resume) =>
        resume({
          text: "",
          toolCalls: [call.toolCalls[0]!, { id: "two", name: "broken", arguments: "{}" }],
        }),
    }),
    Emit.discard,
    Fail.run,
  );
  Kyoot.runSync(action);
  Kyoot.runSync(action);
  assert.equal(writes, 1);
  assert.equal(failures, 1);
});

test("turn construction snapshots the tool list for later execution", () => {
  let writes = 0;
  const tools = [Tool("write", "write", z.object({}), () => Kyoot.succeed(++writes))];
  const ai = AI.make({ tools });
  const turn = ai.turn("go");
  tools.length = 0;
  let models = 0;
  Kyoot.runSync(
    turn.run.pipe(
      Model.handle({ onOp: (_, resume) => resume(++models === 1 ? call : done) }),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  assert.equal(writes, 1);
});
