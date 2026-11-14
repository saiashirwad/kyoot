/**
 * A stale cache that only a rare interleaving leaves behind.
 *
 * refresh reads the config version, loads that version's data and caches it. update bumps the version
 * and, after a slow broadcast to its peers, invalidates the cache. If all of that lands between
 * refresh's read and its write, the cache keeps the old data under the old version, forever. It
 * takes two specific preemptions among ~200 steps (the request handlers only add noise), so random
 * scheduling almost never gets there. PCT does, within a few hundred runs.
 *
 *   node packages/kyoot/examples/sim/rare.ts
 */
import { effect, Kyoot } from "../../src/index.ts";
import * as Sim from "../../src/sim/index.ts";

const Version = {
  get: effect<void, number>()("io/config.version"),
  bump: effect<void, number>()("io/config.bump"),
};
const Load = effect<number, string>()("io/config.load");
const Cache = {
  get: effect<void, string | undefined>()("io/cache.get"),
  put: effect<{ version: number; data: string }, void>()("io/cache.put"),
  clear: effect<void, void>()("io/cache.clear"),
};
const Audit = effect<string, void>()("io/audit");

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
    yield* Sim.fork(refresh, { name: "refresh" }),
    yield* Sim.fork(update, { name: "update" }),
    yield* Sim.fork(handler, { name: "req1" }),
    yield* Sim.fork(handler, { name: "req2" }),
  ];
  for (const fiber of fibers) yield* Sim.join(fiber);
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
    "io/config.version": () => version,
    "io/config.bump": () => ++version,
    "io/config.load": (v: number) => `config v${v}`,
    "io/cache.get": () => cached?.data,
    "io/cache.put": (entry: { version: number; data: string }) => void (cached = entry),
    "io/cache.clear": () => void (cached = undefined),
    "io/audit": () => {},
  };
};

// The invariant: once everything has settled, the cache is empty or current.
export const fresh = (r: { world: ReturnType<typeof world> }) =>
  r.world.cached === undefined ||
  r.world.cached.version === r.world.version ||
  `cache holds v${r.world.cached.version}, config is v${r.world.version}`;

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
  const noise = /io\/(audit|cache.get)/;
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
}
