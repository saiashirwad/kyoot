/**
 * Hours of retries in milliseconds: timeouts, backoff and a flaky gateway under virtual time.
 *
 * pay() charges an order through a payment gateway, giving each attempt 10s (Sim.timeout) and
 * retrying 503s and timeouts with exponential backoff (30s, 1m, 2m, ... up to an hour). The fake
 * gateway, driven by the seed, sometimes answers 503, and sometimes charges the card but then
 * hangs for two hours (a lost response). Every run spans minutes to hours of simulated time and
 * finishes at once, because Sim only moves the clock when every fiber is waiting.
 *
 * The hang exposes a real bug: the charge went through, the client timed out and retried, and the
 * customer paid twice. Sending an idempotency key with every attempt fixes it.
 *
 *   node packages/kyoot/examples/sim/payments.ts
 */
import { effect, Kyoot } from "../../src/index.ts";
import * as Fail from "../../src/effects/fail.ts";
import * as Sim from "../../src/sim/index.ts";

type ChargeRequest = { readonly order: string; readonly cents: number; readonly key?: string };
const Gateway = effect<ChargeRequest, { readonly status: 200 | 503 }>()("io/gateway.charge");

class GaveUp {
  readonly _tag = "GaveUp";
}

const pay = (order: string, cents: number, options: { readonly idempotent: boolean }) =>
  Kyoot.gen(function* () {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const key = options.idempotent ? `${order}-charge` : undefined;
      const reply = yield* Fail.run(
        Sim.timeout(10_000, Gateway({ order, cents, key }), { name: "charge" }),
      );
      if (reply.ok && reply.value.status === 200) return `paid on attempt ${attempt}`;
      yield* Sim.sleep(Math.min(30_000 * 2 ** (attempt - 1), 3_600_000));
    }
    return yield* Fail.fail(new GaveUp());
  });

// The fake gateway: 30% quick 503, 20% charges then hangs for 2h, else charges in 300ms.
// A request with an idempotency key it has already seen is answered without charging again.
const gateway = () => {
  const charges: string[] = [];
  const seen = new Set<string>();
  return {
    charges,
    "io/gateway.charge": (req: ChargeRequest, io: Sim.IoContext) => {
      const roll = io.random();
      if (roll < 0.3) return Sim.delay(200, { status: 503 as const });
      if (req.key === undefined || !seen.has(req.key)) charges.push(req.order);
      if (req.key !== undefined) seen.add(req.key);
      return Sim.delay(roll < 0.5 ? 7_200_000 : 300, { status: 200 as const });
    },
  };
};

const chargedOnce = (r: Sim.SimResult<unknown, unknown, ReturnType<typeof gateway>>) => {
  const n = r.world.charges.length;
  return n <= 1 || `order charged ${n} times (${Sim.showExit(r.exit)})`;
};

export const naive = pay("order-42", 4_999, { idempotent: false });
export const safe = pay("order-42", 4_999, { idempotent: true });
export { chargedOnce, gateway };

if (import.meta.main) {
  const t0 = performance.now();
  let simulated = 0;
  let longest = 0;
  for (let seed = 0; seed < 1000; seed++) {
    const r = Sim.run(safe, { seed, world: gateway });
    simulated += r.now;
    longest = Math.max(longest, r.now);
  }
  const ms = (performance.now() - t0).toFixed(0);
  console.log(
    `1000 runs, ${Sim.showTime(simulated)} of simulated time (longest ${Sim.showTime(longest)}) in ${ms}ms\n`,
  );

  const found = Sim.explore(naive, { seeds: 1000, world: gateway, check: chargedOnce });
  if (found.ok) throw new Error("expected a double charge");
  console.log(`Without an idempotency key, seed ${found.seed}: ${found.reason}\n`);
  console.log(Sim.format(found.result.trace).replace(/^/gm, "    "));

  const fixed = Sim.explore(safe, { seeds: 1000, world: gateway, check: chargedOnce });
  console.log(
    `\nWith an idempotency key: ${fixed.ok ? "all 1000 seeds charge at most once" : `seed ${fixed.seed} fails`}`,
  );
}
