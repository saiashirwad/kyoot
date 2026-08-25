import { Async, effect, Emit, Fail, Kyoot, Log } from "kyoot";
import { ApiKey, ask, Deepseek, Tool } from "@kyoot/ai";

const Calc = effect<{ expression: string }, number>()("calc");

const calc = Tool(
  {
    name: "calc",
    description: "Evaluate an arithmetic expression",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
  Calc,
);

const program = ask("write me a poem about the meaning of life", [calc]).pipe(
  Deepseek("deepseek-chat"),
  Calc.handle({ onOp: ({ expression }, resume) => resume(Function(`return (${expression})`)()) }),
  ApiKey.provide(process.env.DEEPSEEK_API_KEY!),
  Emit.forEach((token: string) => process.stdout.write(token)),
  Log.print,
  Fail.run,
);

console.log("\n", await Async.timeout(60_000, program).pipe(Fail.orThrow, Kyoot.runPromise));
