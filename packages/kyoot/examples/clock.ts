import { Kyoot } from "../src/index.ts";
import { Clock, runPromise } from "../src/async/index.ts";

const boilEgg = (minute: number) =>
  Kyoot.gen(function* () {
    yield* Clock.sleep(1 * minute);
    yield* Clock.sleep(6 * minute);
    return "egg ready";
  });

console.log(Kyoot.runSync(boilEgg(60_000).pipe(Clock.virtual)));
console.log(await runPromise(boilEgg(20).pipe(Clock.live)));
