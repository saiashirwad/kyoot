# kyoot

`kyoot` is the synchronous core: algebraic effects, handlers, `runSync`, and the built-in effects `Emit`, `Env`, `Fail`, `Log`, `Random`, `Resource`, `Sync`, and `Var`. It imports nothing asynchronous.

`kyoot/async` adds fibers on top of the core: `runPromise`, `runFiber`, and the effects `Async`, `Clock`, and `Retry`.

`Kyoot.step(program)` runs a program until it finishes or performs an effect that no handler answers. It returns either `{ done: true, value }` or a pending step with the effect's `key` and `payload`. A program's row maps each effect key to `Op<Payload, Answer>`, so checking `step.key` narrows both `payload` and the value `resume` accepts. You answer a pending step with `resume(value)`, throw into it with `raise(error)`, or stop it with `cancel()`, which runs the program's cleanup. Each of the three returns the next step. A pending step can be used once, and disposing it cancels it. See [`examples/step.ts`](examples/step.ts).

Start with [`examples/checkout.ts`](examples/checkout.ts) (your own effects, swappable handlers) and [`examples/env.ts`](examples/env.ts); the rest of [`examples/`](examples) and [`test/`](test) are the docs.
