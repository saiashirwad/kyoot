import assert from "node:assert/strict";
import { test } from "node:test";
import * as Emit from "kyoot/emit";
import * as Fail from "kyoot/fail";
import { Async } from "kyoot/async";
import * as Sim from "kyoot/sim";
import { AI, type Completion } from "@kyoot/ai";

// The model is an ordinary effect (ai/model): a provider handles it in production, and the
// simulator's world fakes it, with latency in virtual time.
const agent = Async.timeout(30_000, AI.ask("Will it rain?").pipe(Emit.discard)).pipe(Fail.run);
const model = (ms: number) => () => ({
  "ai/model": (): Sim.Delayed<Completion> => Sim.delay(ms, { text: "Yes.", toolCalls: [] }),
});

test("sim: the world answers ai/model, and a slow model times out in virtual time", () => {
  const fast = Sim.run(agent, { seed: 0, world: model(1_200) });
  assert.deepEqual(fast.exit, { ok: true, value: { ok: true, value: "Yes." } });
  assert.equal(fast.now, 1_200);

  const slow = Sim.run(agent, { seed: 0, world: model(60_000) });
  assert.ok(slow.exit.ok && !slow.exit.value.ok && slow.exit.value.cause._tag === "Fail");
  assert.equal(slow.now, 30_000);
});
