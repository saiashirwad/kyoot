import { Fail, Kyoot } from "kyoot";
import { AI, Deepseek, Events, Tool } from "@kyoot/ai";
import { z } from "zod";

const weather = Tool(
  "weather",
  "Get the weather for a city",
  z.object({ city: z.string() }),
  ({ city }) => Kyoot.succeed({ city, temp: 21, unit: "C" }),
);
const Answer = z.object({ value: z.number() });

// Live provider example: run explicitly with DEEPSEEK_API_KEY set.
const answer = await AI.gen(Answer, "What is the temperature in Paris?", { tools: [weather] }).pipe(
  Deepseek(),
  Events.print,
  Fail.orThrow,
  Kyoot.runPromise,
);
console.log(answer);
