/**
 * A stale cache that only a rare interleaving leaves behind.
 *
 * refresh reads the config version, loads that version's data and caches it. update bumps the version
 * and, after a slow broadcast to its peers, invalidates the cache. If all of that lands between
 * refresh's read and its write, the cache keeps the old data under the old version, forever. It
 * takes two specific preemptions among ~200 steps (the request handlers only add noise), so random
 * scheduling almost never gets there. PCT does, within a few hundred runs.
 *
 * The effects are ordinary declarations (config/*, cache/*, audit): the world fakes them under
 * Sim.run, and live handlers answer them when the same program runs under runPromise.
 *
 *   node packages/kyoot/examples/sim/rare.ts
 */
import { effect, Kyoot, type Row } from "../../src/index.ts";
import { Async, runPromise } from "../../src/async/index.ts";
import * as Sim from "../../src/sim/index.ts";

const Version = {
  get: effect<void, number>()("config/version"),
  bump: effect<void, number>()("config/bump"),
};
const Load = effect<number, string>()("config/load");
const Cache = {
  get: effect<void, string | undefined>()("cache/get"),
  put: effect<{ version: number; data: string }, void>()("cache/put"),
  clear: effect<void, void>()("cache/clear"),
};
const Audit = effect<string, void>()("audit");

export const refresh = Kyoot.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Audit("refresh tick");
  const version = yield* Version.get();
  const data = yield* Load(version);
  yield* Cache.put({ version, data });
});

export const update = Kyoot.gen(function* () {
  for (let i = 0; i < 30; i++) yield* Audit("update tick");
  yield* Version.bump();
  for (let i = 0; i < 12; i++) yield* Audit("update notify");
  yield* Cache.clear();
});

const handler = Kyoot.gen(function* () {
  for (let i = 0; i < 40; i++) yield* Cache.get();
});

export const program = Kyoot.gen(function* () {
  const fibers = [
    yield* Async.fork(refresh, { name: "refresh" }),
    yield* Async.fork(update, { name: "update" }),
    yield* Async.fork(handler, { name: "req1" }),
    yield* Async.fork(handler, { name: "req2" }),
  ];
  for (const fiber of fibers) yield* Async.join(fiber);
});

// A fresh world per run.
export const world = () => {
  let version = 1;
  let cached: { version: number; data: string } | undefined;
  return {
    get cached() {
      return cached;
    },
    get version() {
      return version;
    },
    "config/version": () => version,
    "config/bump": () => ++version,
    "config/load": (v: number) => `config v${v}`,
    "cache/get": () => cached?.data,
    "cache/put": (entry: { version: number; data: string }) => void (cached = entry),
    "cache/clear": () => void (cached = undefined),
    audit: () => {},
  };
};

// Live handlers for the same keys: the state lives in the returned object, each call is a promise.
export const live = () => {
  const state = {
    version: 1,
    cached: undefined as { version: number; data: string } | undefined,
  };
  const io = <A>(f: () => A) => Async.fromPromise(async () => f());
  const handle = <A, S extends Row>(k: Kyoot<A, S>) =>
    k.pipe(
      Version.get.handle((_, resume) => io(() => state.version).flatMap(resume)),
      Version.bump.handle((_, resume) => io(() => ++state.version).flatMap(resume)),
      Load.handle((v, resume) => io(() => `config v${v}`).flatMap(resume)),
      Cache.get.handle((_, resume) => io(() => state.cached?.data).flatMap(resume)),
      Cache.put.handle((entry, resume) => io(() => void (state.cached = entry)).flatMap(resume)),
      Cache.clear.handle((_, resume) => io(() => void (state.cached = undefined)).flatMap(resume)),
      Audit.handle((_, resume) => io(() => undefined).flatMap(resume)),
    );
  return { state, handlers: Async.provide(handle) };
};

// Runs the program for real and checks the same invariant.
export const runLive = async () => {
  const { state, handlers } = live();
  await runPromise(program.pipe(handlers));
  return current(state);
};

type Config = {
  readonly version: number;
  readonly cached: { readonly version: number; readonly data: string } | undefined;
};

// The invariant: once everything has settled, the cache is empty or current.
const current = (c: Config) =>
  c.cached === undefined ||
  c.cached.version === c.version ||
  `cache holds v${c.cached.version}, config is v${c.version}`;

export const fresh = (r: { world: ReturnType<typeof world> }) => current(r.world);

if (import.meta.main) {
  const N = 2000;
  const hits = (strategy: Sim.Strategy) => {
    let n = 0;
    for (let seed = 0; seed < N; seed++) {
      if (fresh(Sim.run(program, { seed, world, strategy })) !== true) n++;
    }
    return n;
  };
  const strategies = [
    Sim.random(),
    Sim.bounded({ preemptions: 2, steps: 200 }),
    Sim.pct({ depth: 2, steps: 200 }),
  ];

  console.log(`Stale cache, ${N} schedules per strategy:\n`);
  for (const s of strategies) {
    const found = Sim.explore(program, { seeds: N, world, check: fresh, strategy: s });
    const n = hits(s);
    console.log(
      `  ${s.name.padEnd(24)} ${String(n).padStart(4)} / ${N} fail; ` +
        (found.ok ? "not found" : `first found at run ${found.runs} (seed ${found.seed})`),
    );
  }

  const found = Sim.explore(program, { seeds: N, world, check: fresh, strategy: strategies[2]! });
  if (found.ok) throw new Error("expected PCT to find the stale cache");
  const { shrunk } = found;
  if (shrunk === undefined) throw new Error("expected a shrunk run");
  console.log(`\n${found.strategy}, seed ${found.seed}: ${found.reason}`);
  console.log(`${Sim.showShrink(shrunk)}\n`);
  // Only the interesting steps: skip the audit and request noise.
  const noise = /^(audit|cache\/get)/;
  console.log(
    Sim.format(shrunk.result.trace.filter((e) => !noise.test(e.what))).replace(/^/gm, "    "),
  );

  const again = Sim.run(program, {
    seed: found.seed,
    world,
    strategy: Sim.replay(shrunk.result.choices),
  });
  const same = Sim.format(again.trace) === Sim.format(shrunk.result.trace);
  console.log(
    `\nReplaying its ${shrunk.result.choices.length} recorded choices: ${same ? "identical trace" : "DIFFERENT trace"}`,
  );

  const verdict = await runLive();
  console.log(
    `\nThe same program under runPromise, live handlers: ${verdict === true ? "cache fresh" : verdict}`,
  );
}
