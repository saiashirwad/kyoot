import { Kyoot } from "../src/index.ts";
import * as Emit from "../src/effects/emit.ts";

const program = Kyoot.gen(function* () {
  yield* Emit.value("started");
  yield* Emit.value("finished");
  return "done";
});

const [result, events] = Kyoot.runSync(program.pipe(Emit.collect));

console.log(result);
console.log(events);
