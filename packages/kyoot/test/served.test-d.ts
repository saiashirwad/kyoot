import { Async, Emit, effect, Kyoot, type AsyncOp } from "../src/index.ts";
const BadClock = effect<void, string>()("clock");
// @ts-expect-error the runner's clock always accepts a number and answers void
Kyoot.runPromise(BadClock(undefined));
const GoodClock = effect<number, void>()("clock");
Kyoot.runPromise(GoodClock(1));
const BadAsync = effect<AsyncOp, string>()("async");
// @ts-expect-error fixed string answer is not the driver's unknown answer contract
Kyoot.runPromise(BadAsync({ execute: async () => 1 }));
const GoodAsync = effect<AsyncOp, unknown>()("async");
Kyoot.runPromise(GoodAsync({ execute: async () => 1 }));

// @ts-expect-error forking cannot erase an incompatible served requirement
Kyoot.runPromise(Async.fork(BadClock(undefined)));
// @ts-expect-error racing cannot erase an incompatible served requirement
Kyoot.runPromise(Async.race(BadClock(undefined), GoodClock(1)));
// @ts-expect-error all cannot erase an incompatible served requirement
Kyoot.runPromise(Async.all([BadClock(undefined)]));
// @ts-expect-error stream conversion also checks driver contracts
Emit.toAsyncIterable(BadClock(undefined));
