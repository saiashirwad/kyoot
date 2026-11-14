import { effect, Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Var from "../src/effects/var.ts";
import type { Op, RowsOf } from "../src/index.ts";
import * as Sim from "../src/sim/index.ts";
import { Async } from "../src/async/index.ts";

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
  Equal<
    keyof RowsOf<typeof joined>,
    "fiber/fork" | "fiber/join" | "fiber/interrupt" | "io/db.get" | "fail"
  >
>;
type _joinFail = Expect<Equal<RowsOf<typeof joined>["fail"], Op<Nope, never>>>;
type _joinValue = Expect<Equal<typeof joined extends Kyoot<infer A, any> ? A : never, number>>;

type _sleep = Expect<
  Equal<RowsOf<ReturnType<typeof Sim.sleep>>, { "clock/sleep": Op<number, void> }>
>;
type _now = Expect<Equal<RowsOf<typeof Sim.now>, { "clock/now": Op<void, number> }>>;

// Whatever a forked program leaves unhandled surfaces in the parent's row, so the world must
// answer it (any key, not just io/). Handled inside the child, it doesn't.
const Count = Var.tag<number>()("count");
const counting = Sim.fork(Count.get());
type _countRows = Expect<Equal<keyof RowsOf<typeof counting>, "fiber/fork" | "var/count">>;
const counted = Sim.fork(Count.get().pipe(Count.run(0)));
type _countHandled = Expect<Equal<keyof RowsOf<typeof counted>, "fiber/fork">>;
// @ts-expect-error the world must answer var/count
Sim.run(counting, { seed: 1 });

// Promise interop can't run in a simulation: declare an effect and answer it from the world.
const viaPromise = Async.fromPromise(() => Promise.resolve(1));
// @ts-expect-error Unhandled<"async">
Sim.run(viaPromise, { seed: 1 });

// run needs a world responder for every effect any fiber leaves unhandled (io/ is just a name),
// typed by payload and answer.
const r = Sim.run(joined, { seed: 1, world: () => ({ "io/db.get": (key: string) => key.length }) });
const _exit: Sim.SimExit<Nope, number> = r.exit;
// @ts-expect-error the world is required when such effects remain
Sim.run(joined, { seed: 1 });
// @ts-expect-error the responder must answer a number
Sim.run(joined, { seed: 1, world: () => ({ "io/db.get": (key: string) => key }) });
Sim.run(Sim.sleep(1), { seed: 1 });
