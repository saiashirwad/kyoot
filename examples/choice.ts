import { Choice, Kyoot } from "../src/index.ts";

const prog = Kyoot.gen(function* () {
  const alice = yield* Choice.get(["mon", "tue", "wed"]);
  const bob = yield* Choice.get(["mon", "tue", "wed"]);
  if (alice === bob) yield* Choice.get([]);
  return { alice, bob };
});

console.log(Kyoot.runSync(prog.pipe(Choice.run())));
