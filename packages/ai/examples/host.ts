import { effect, Kyoot } from "kyoot";
import * as Emit from "kyoot/emit";
import * as Fail from "kyoot/fail";
import { AI, needsApproval, Tool, type Completion } from "@kyoot/ai";
import { z } from "zod";

// A tool that needs the outside world: it only asks for a forecast.
const Forecast = effect<{ city: string }, string>()("forecast");
const forecast = needsApproval(
  Tool("forecast", "Weather for a city", z.object({ city: z.string() }), Forecast),
);

const agent = AI.ask("Do I need an umbrella in Pune?", { tools: [forecast] }).pipe(
  Emit.discard,
  Fail.orThrow,
);

// The agent does no IO. The host steps it and answers every request itself.
export const host = (modelReplies: Completion[]) => {
  const requests: [key: string, payload: unknown][] = [];
  let step = Kyoot.step(agent);
  while (!step.done) {
    requests.push([step.key, step.payload]);
    switch (step.key) {
      case "ai/model":
        step = step.resume(modelReplies.shift()!);
        break;
      case "ai/approve":
        step = step.resume(true);
        break;
      case "forecast":
        step = step.resume("rain");
        break;
    }
  }
  return { answer: step.value, requests };
};

if (import.meta.main) {
  const { answer, requests } = host([
    { text: "", toolCalls: [{ id: "1", name: "forecast", arguments: '{"city":"Pune"}' }] },
    { text: "Yes, it will rain.", toolCalls: [] },
  ]);
  console.log(requests.map(([key]) => key).join(" -> "));
  console.log(answer);
}
