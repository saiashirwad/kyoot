import { Async, effect, Emit, Fail, Kyoot, Log } from "kyoot";
import { ApiKey, ask, deepseek, tool } from "@kyoot/ai";

const Calc = effect<{ expression: string }, number>()("calc");

const calc = tool(
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

const question =
  process.argv[2] ?? "What is 1234 * 5678? Use the calculator, then answer in one sentence.";

const program = ask(question, [calc]).pipe(
  deepseek(),
  Calc.handle({ onOp: ({ expression }, resume) => resume(Function(`return (${expression})`)()) }),
  ApiKey.provide(process.env.DEEPSEEK_API_KEY!),
  Emit.forEach((token: string) => process.stdout.write(token)),
  Log.print,
  Fail.run,
);

console.log("\n", await Async.timeout(60_000, program).pipe(Fail.orThrow, Kyoot.runPromise));
