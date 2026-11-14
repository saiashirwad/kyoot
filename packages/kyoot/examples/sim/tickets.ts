/**
 * The last concert ticket: a check-then-act race that ordinary tests miss.
 *
 * buyTicket reads how many tickets are left, charges the card, then writes the new count. Each step
 * is an ordinary declared effect (db/get, payments/charge, ...): in production a handler answers it
 * with an await on a real database or payment API. Run alone, or one fan after the other, it is
 * correct. Run two fans at once and, in some interleavings, both read "1 left" and both are charged
 * for the same seat.
 *
 * Sim.explore runs the program under 1000 seeded schedules, finds one that oversells, prints the
 * interleaving, replays the seed to show it reproduces exactly, then checks a compare-and-set fix.
 * Finally the very same programs run under runPromise, on real fibers, against live handlers.
 *
 *   node packages/kyoot/examples/sim/tickets.ts
 */
import { effect, Kyoot, type Row } from "../../src/index.ts";
import { Async, runPromise } from "../../src/async/index.ts";
import * as Sim from "../../src/sim/index.ts";

// The outside world, declared as ordinary effects. Sim answers them from a fake world; in
// production a handler does (see `live` below).
const Db = {
  get: effect<string, number>()("db/get"),
  set: effect<{ key: string; value: number }, void>()("db/set"),
  // Writes only if the value is still `expected`; answers whether it did.
  cas: effect<{ key: string; expected: number; value: number }, boolean>()("db/cas"),
};
const Charge = effect<{ fan: string; cents: number }, void>()("payments/charge");

export const buyTicket = (fan: string) =>
  Kyoot.gen(function* () {
    const left = yield* Db.get("tickets");
    if (left === 0) return `${fan}: sold out`;
    yield* Charge({ fan, cents: 9_900 });
    yield* Db.set({ key: "tickets", value: left - 1 });
    return `${fan}: got a ticket`;
  });

// Fixed: claim the seat atomically first (retrying if someone else got there), then charge.
export const buyTicketSafely = (fan: string) =>
  Kyoot.gen(function* () {
    while (true) {
      const left = yield* Db.get("tickets");
      if (left === 0) return `${fan}: sold out`;
      if (yield* Db.cas({ key: "tickets", expected: left, value: left - 1 })) break;
    }
    yield* Charge({ fan, cents: 9_900 });
    return `${fan}: got a ticket`;
  });

export const oneAfterTheOther = Kyoot.gen(function* () {
  return [yield* buyTicket("alice"), yield* buyTicket("bob")];
});

const names = { names: ["alice", "bob"] };
export const atTheSameTime = Async.all([buyTicket("alice"), buyTicket("bob")], names);
export const atTheSameTimeSafely = Async.all(
  [buyTicketSafely("alice"), buyTicketSafely("bob")],
  names,
);

// A fresh world per run: one ticket left, and a ledger of charges.
export const world = () => {
  const db = new Map([["tickets", 1]]);
  const charged: string[] = [];
  return {
    charged,
    "db/get": (key: string) => db.get(key) ?? 0,
    "db/set": ({ key, value }: { key: string; value: number }) => void db.set(key, value),
    "db/cas": ({ key, expected, value }: { key: string; expected: number; value: number }) =>
      db.get(key) === expected && (db.set(key, value), true),
    "payments/charge": ({ fan }: { fan: string }) => void charged.push(fan),
  };
};

// Live handlers for the same keys: an in-memory store behind a promise and a millisecond of real
// latency, the shape a database or payments client has. Async.provide installs them in every fiber.
export const live = () => {
  const db = new Map([["tickets", 1]]);
  const charged: string[] = [];
  const io = <A>(f: () => A) =>
    Async.fromPromise(() => new Promise<A>((resolve) => setTimeout(() => resolve(f()), 1)));
  const handle = <A, S extends Row>(k: Kyoot<A, S>) =>
    k.pipe(
      Db.get.handle((key, resume) => io(() => db.get(key) ?? 0).flatMap(resume)),
      Db.set.handle(({ key, value }, resume) => io(() => void db.set(key, value)).flatMap(resume)),
      Db.cas.handle(({ key, expected, value }, resume) =>
        io(() => db.get(key) === expected && (db.set(key, value), true)).flatMap(resume),
      ),
      Charge.handle(({ fan }, resume) => io(() => void charged.push(fan)).flatMap(resume)),
    );
  return { charged, handlers: Async.provide(handle) };
};

// Runs the two fans for real: runPromise gives each one a real fiber.
export const runLive = async (options: { readonly safely?: boolean } = {}) => {
  const { charged, handlers } = live();
  const value = options.safely
    ? await runPromise(atTheSameTimeSafely.pipe(handlers))
    : await runPromise(atTheSameTime.pipe(handlers));
  return { value, charged };
};

// The invariant: never charge more fans than there were tickets.
export const noOversell = (r: { world: ReturnType<typeof world> }) =>
  r.world.charged.length <= 1 || `sold 1 ticket to ${r.world.charged.length} fans`;

if (import.meta.main) {
  const indent = (s: string) => s.replace(/^/gm, "    ");

  const plain = Sim.run(oneAfterTheOther, { seed: 0, world });
  console.log(`1. One fan after the other: ${Sim.showExit(plain.exit)}  (passes)\n`);

  const found = Sim.explore(atTheSameTime, { seeds: 1000, world, check: noOversell });
  if (found.ok) throw new Error("expected to find the oversell");
  console.log(
    `2. Two fans at once, 1000 schedules: seed ${found.seed} fails after ${found.runs} runs`,
  );
  console.log(`   ${found.reason}: ${Sim.showExit(found.result.exit)}`);
  let failing = 0;
  for (let seed = 0; seed < 1000; seed++) {
    if (noOversell(Sim.run(atTheSameTime, { seed, world })) !== true) failing++;
  }
  console.log(`   (${failing} of 1000 schedules oversell; a normal test runs exactly one)\n`);
  const { shrunk } = found;
  if (shrunk === undefined) throw new Error("expected a shrunk run");
  console.log(`   ${Sim.showShrink(shrunk)}\n`);
  console.log(indent(Sim.format(shrunk.result.trace)));

  const replay = Sim.run(atTheSameTime, {
    seed: found.seed,
    world,
    strategy: Sim.replay(shrunk.result.choices),
  });
  const same = Sim.format(replay.trace) === Sim.format(shrunk.result.trace);
  console.log(
    `\n3. Replaying the shrunk schedule: ${same ? "identical trace" : "DIFFERENT trace"}\n`,
  );

  const t0 = performance.now();
  const fixed = Sim.explore(atTheSameTimeSafely, { seeds: 1000, world, check: noOversell });
  const ms = (performance.now() - t0).toFixed(0);
  console.log(
    `4. With compare-and-set: ${fixed.ok ? `all ${fixed.runs} schedules pass` : `seed ${fixed.seed} fails`} (${ms}ms)`,
  );

  const racy = await runLive();
  const safe = await runLive({ safely: true });
  console.log(`\n5. The same programs under runPromise, with live handlers:`);
  console.log(
    `   two fans at once:  ${JSON.stringify(racy.value)}, charged ${racy.charged.join(", ")}`,
  );
  console.log(
    `   compare-and-set:   ${JSON.stringify(safe.value)}, charged ${safe.charged.join(", ")}`,
  );
}
