import { effect, Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Var from "../src/effects/var.ts";
import type { Op, RowsOf } from "../src/index.ts";
import * as Sim from "../src/sim/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

class Nope {
  readonly _tag = "Nope";
}

const Get = effect<string, number>()("io/db.get");
const child = Kyoot.gen(function* () {
  const n = yield* Get("k");
  if (n < 0) yield* Fail.fail(new Nope());
  return n;
});

// fork types the handle by the child's value and failure, and its io/ effects surface in the parent.
const forked = Sim.fork(child);
type _forkValue = Expect<
  Equal<typeof forked extends Kyoot<infer A, any> ? A : never, Sim.Fiber<number, Nope>>
>;
type _forkRows = Expect<Equal<keyof RowsOf<typeof forked>, "fiber/fork" | "io/db.get">>;
type _forkOp = Expect<
  Equal<RowsOf<typeof forked>["fiber/fork"], Op<Sim.ForkRequest, Sim.Fiber<unknown, unknown>>>
>;

const joined = forked.flatMap(Sim.join);
type _joinRows = Expect<
  Equal<keyof RowsOf<typeof joined>, "fiber/fork" | "fiber/join" | "io/db.get" | "fail">
>;
type _joinFail = Expect<Equal<RowsOf<typeof joined>["fail"], Op<Nope, never>>>;
type _joinValue = Expect<Equal<typeof joined extends Kyoot<infer A, any> ? A : never, number>>;

type _sleep = Expect<
  Equal<RowsOf<ReturnType<typeof Sim.sleep>>, { "clock/sleep": Op<number, void> }>
>;
type _now = Expect<Equal<RowsOf<typeof Sim.now>, { "clock/now": Op<void, number> }>>;

// A forked program may not need effects the simulation cannot answer (handlers don't cross forks).
const Count = Var.tag<number>()("count");
// @ts-expect-error fork rejects var/count: Unhandled<"var/count">
Sim.fork(Count.get());
Sim.fork(Count.get().pipe(Count.run(0)));

// run needs a world responder for every io/ effect any fiber performs, typed by payload and answer.
const r = Sim.run(joined, { seed: 1, world: () => ({ "io/db.get": (key: string) => key.length }) });
const _exit: Sim.SimExit<Nope, number> = r.exit;
// @ts-expect-error the world is required when io/ effects remain
Sim.run(joined, { seed: 1 });
// @ts-expect-error the responder must answer a number
Sim.run(joined, { seed: 1, world: () => ({ "io/db.get": (key: string) => key }) });
Sim.run(Sim.sleep(1), { seed: 1 });
