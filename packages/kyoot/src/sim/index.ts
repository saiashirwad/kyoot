// Deterministic simulation: concurrency as data effects, run by a seeded scheduler.
// import * as Sim from "kyoot/sim"
export {
  all,
  fork,
  FiberInterrupted,
  interrupt,
  join,
  now,
  sleep,
  timeout,
  Timeout,
  wait,
  yieldNow,
} from "./effects.ts";
export type {
  ChildKey,
  Exit,
  Fiber,
  ForkRequest,
  Interrupted,
  IoKey,
  SimKey,
  SimRow,
} from "./effects.ts";
export { bounded, pct, random, replay } from "./strategy.ts";
export type { Chooser, Strategy } from "./strategy.ts";
export { delay, Delayed, explore, format, run, showExit, showTime } from "./scheduler.ts";
export type {
  Check,
  Explored,
  IoContext,
  RunOptions,
  SimExit,
  SimResult,
  Stuck,
  TraceEvent,
  World,
} from "./scheduler.ts";
