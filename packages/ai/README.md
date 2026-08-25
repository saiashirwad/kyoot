# @kyoot/ai

Language models as kyoot effects, after [kyo-ai](https://github.com/getkyo/kyo/tree/main/kyo-ai). A program asks a `Model`; providers and modes handle it. The point is to show the effect model holds up, not to cover every provider feature.

```ts
import { Fail, Kyoot } from "kyoot";
import { AI, Deepseek, Events, Tool } from "@kyoot/ai";
import { z } from "zod";

const calc = Tool(
  "calc",
  "Evaluate an arithmetic expression",
  z.object({ expression: z.string() }),
  ({ expression }) => Kyoot.succeed(eval(expression)),
);

const Answer = z.object({ value: z.number() });

const answer = await AI.gen(Answer, "What is 12 * 34?", { tools: [calc] })
  .pipe(Deepseek(), Events.print, Fail.orThrow)
  .map(Kyoot.runPromise);
```

## Pieces

- `Model` — the effect: `Request` in, `Completion` out. Everything below is built on it.
- `generate(messages, { tools, rounds, schema })` — the loop. Calls the model, runs tool calls as effects, feeds results back, returns `[value, newMessages]`. With `schema` it asks for an `answer` tool call and decodes it. A tool's typed failure goes back to the model as a result; defects still throw.
- `AI.ask` / `AI.gen` — one shot. `AI.init({ prompt, tools })` returns an instance whose `messages` carry across calls: prepend history, `generate`, append. One call at a time per instance.
- `Tool(name, description, argsSchema, run)` — a typed function the model may call. `run` returns a program, so a tool's row shows up in the program's row, and the handler can be piped in anywhere. An `AI` instance wrapped in a `Tool` is an agent another agent can consult.
- `needsApproval(tool)` — wraps a tool so it performs `Approve({ tool, args })` first. Handle it with `Approve.handle(...)`: always yes in tests, a prompt in a CLI. Denied calls tell the model `{"denied":true}`. The loop knows nothing about it.
- `Events` — what happened, as a stream: `text` deltas from the provider, `call` and `result` from the loop. `Events.print`, `Events.forEach(f)`, `Events.discard`.
- `Schema<A>` — any [Standard Schema](https://standardschema.dev) that also implements Standard JSON Schema: zod 4.2+, ArkType, Valibot with `toStandardJsonSchema`. Nothing to import; the type is structural.
- `Mode` — middleware around `Model`: `Mode.system(text)`, `Mode.config({ temperature, maxTokens })`, `Mode.usage` (returns `[answer, { input, output }]`), or `Mode.init((req, next) => …)` for your own. Modes go inside the provider in a pipe.
- Providers — `Deepseek(options)`, `OpenAI(options)`, or `chatCompletions({ url, model, apiKey })` for anything OpenAI-shaped. They retry on 429/5xx and leave `RateLimited` in the row.

Handlers scope, so a tool can pipe its own model or mode:

```ts
const askPoet = Tool("poet", "Ask the poet", z.object({ request: z.string() }), ({ request }) =>
  poet.ask(request).pipe(Deepseek({ model: "deepseek-reasoner" })),
);
```

`examples/deepseek.ts` stages a debate: two agents on different models, a parallel judge panel with structured verdicts, the motion from `Random`, the score in a `Var`. Run it with `DEEPSEEK_API_KEY` set.
