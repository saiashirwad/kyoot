/**
 * The last concert ticket: a check-then-act race that ordinary tests miss.
 *
 * buyTicket reads how many tickets are left, charges the card, then writes the new count. Each step
 * is an io/ effect, i.e. an await on a real database or payment API. Run alone, or one fan after the
 * other, it is correct. Run two fans at once and, in some interleavings, both read "1 left" and both
 * are charged for the same seat.
 *
 * Sim.explore runs the program under 1000 seeded schedules, finds one that oversells, prints the
 * interleaving, replays the seed to show it reproduces exactly, then checks a compare-and-set fix.
 *
 *   node packages/kyoot/examples/sim/tickets.ts
 */
import { effect, Kyoot } from "../../src/index.ts";
import * as Sim from "../../src/sim/index.ts";

// The outside world, declared as io/ effects: Sim answers them from a fake, in-memory world.
const Db = {
  get: effect<string, number>()("io/db.get"),
  set: effect<{ key: string; value: number }, void>()("io/db.set"),
  // Writes only if the value is still `expected`; answers whether it did.
  cas: effect<{ key: string; expected: number; value: number }, boolean>()("io/db.cas"),
};
const Charge = effect<{ fan: string; cents: number }, void>()("io/payments.charge");

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
export const atTheSameTime = Sim.all([buyTicket("alice"), buyTicket("bob")], names);
export const atTheSameTimeSafely = Sim.all(
  [buyTicketSafely("alice"), buyTicketSafely("bob")],
  names,
);

// A fresh world per run: one ticket left, and a ledger of charges.
export const world = () => {
  const db = new Map([["tickets", 1]]);
  const charged: string[] = [];
  return {
    charged,
    "io/db.get": (key: string) => db.get(key) ?? 0,
    "io/db.set": ({ key, value }: { key: string; value: number }) => void db.set(key, value),
    "io/db.cas": ({ key, expected, value }: { key: string; expected: number; value: number }) =>
      db.get(key) === expected && (db.set(key, value), true),
    "io/payments.charge": ({ fan }: { fan: string }) => void charged.push(fan),
  };
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
  console.log(indent(Sim.format(found.result.trace)));

  const replay = Sim.run(atTheSameTime, { seed: found.seed, world });
  const same = Sim.format(replay.trace) === Sim.format(found.result.trace);
  console.log(
    `\n3. Replaying seed ${found.seed}: ${same ? "identical trace" : "DIFFERENT trace"}\n`,
  );

  const t0 = performance.now();
  const fixed = Sim.explore(atTheSameTimeSafely, { seeds: 1000, world, check: noOversell });
  const ms = (performance.now() - t0).toFixed(0);
  console.log(
    `4. With compare-and-set: ${fixed.ok ? `all ${fixed.runs} schedules pass` : `seed ${fixed.seed} fails`} (${ms}ms)`,
  );
}
