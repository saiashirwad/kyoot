import { Emit, Kyoot } from "../src/index.ts";

const program = Kyoot.gen(function* () {
  yield* Emit.value("started");
  yield* Emit.value("finished");
  return "done";
}).pipe(Emit.run());

const [result, events] = Kyoot.runSync(program);

console.log(result);
console.log(events);
