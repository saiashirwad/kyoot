// Deterministic simulation: the concurrency effects of kyoot/async, run by a seeded scheduler.
// import * as Sim from "kyoot/sim"
// The effects are re-exported here so a test can read Sim.fork / Sim.sleep; they are the same
// functions as Async.fork / Async.sleep, and the same program runs under runPromise.
export {
  all,
  fork,
  fromExit,
  interrupt,
  join,
  now,
  provide,
  race,
  sleep,
  timeout,
  Timeout,
  wait,
  yieldNow,
} from "../async/effects.ts";
export type {
  ConcurrencyKey,
  ConcurrencyRow,
  Exit,
  Fiber,
  ForkRequest,
  Interrupted,
} from "../async/effects.ts";
export { bounded, pct, random, replay } from "./strategy.ts";
export type { Chooser, Strategy } from "./strategy.ts";
export { delay, Delayed, fail, Failed, format, run, showExit, showTime } from "./scheduler.ts";
export { explore, shrink, showShrink } from "./explore.ts";
export type { Check, Cost, Explored, Shrunk } from "./explore.ts";
export type {
  IoContext,
  RunOptions,
  SimExit,
  SimResult,
  Simulable,
  Stuck,
  TraceEvent,
  World,
  WorldContext,
  WorldKeysOf,
} from "./scheduler.ts";
