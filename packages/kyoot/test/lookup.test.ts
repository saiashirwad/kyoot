import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import { Async, runPromise } from "../src/async/index.ts";

const Ask = effect<string, string>()("ask");
const Other = effect<string, string>()("other");
const Poke = effect<void, string>()("poke");

const answer = (name: string) => Ask.handle((q, resume) => resume(`${q}@${name}`));

test("an op from handler code skips every handler between that handler and the op", () => {
  const program = Poke().pipe(
    Ask.handle((q, resume) => resume(`${q}@masked`)),
    Other.handle((q, resume) => resume(`${q}@masked`)),
    Poke.handle((_, resume) =>
      Kyoot.gen(function* () {
        return yield* resume(`${yield* Ask("a")} ${yield* Other("o")}`);
      }),
    ),
    answer("outer"),
    Other.handle((q, resume) => resume(`${q}@outer`)),
  );
  assert.equal(Kyoot.runSync(program), "a@outer o@outer");
});

test("handler code nested in handler code skips both masked regions", () => {
  const program = Poke().pipe(
    answer("inner"),
    Poke.handle((_, resume) => Other("o").flatMap(resume)),
    answer("middle"),
    Other.handle((_, resume) => Ask("a").flatMap(resume)),
    answer("outer"),
  );
  assert.equal(Kyoot.runSync(program), "a@outer");
});

test("next from an intercept counts only handlers it can see", () => {
  const seen: string[] = [];
  const tag = (name: string) => Ask.intercept((q, next) => (seen.push(name), next(`${q}>${name}`)));
  const program = Poke().pipe(
    tag("hidden"),
    Poke.handle((_, resume) => Ask("p").flatMap(resume)),
    tag("visible"),
    answer("outer"),
  );
  assert.equal(Kyoot.runSync(program), "p>visible@outer");
  assert.deepEqual(seen, ["visible"]);
});

test("a handler that finished no longer answers ops performed after it", () => {
  const program = Kyoot.gen(function* () {
    const inside = yield* Ask("a").pipe(answer("inner"));
    const after = yield* Ask("b");
    return [inside, after];
  }).pipe(answer("outer"));
  assert.deepEqual(Kyoot.runSync(program), ["a@inner", "b@outer"]);
});

test("resuming after the handler's own nested handlers unwound reaches the original handlers", () => {
  const program = Kyoot.gen(function* () {
    const first = yield* Poke();
    return [first, yield* Ask("after")];
  }).pipe(
    Poke.handle((_, resume) =>
      Kyoot.gen(function* () {
        const scratch = yield* Ask("scratch").pipe(answer("scratch"));
        return yield* resume(scratch);
      }),
    ),
    answer("outer"),
  );
  assert.deepEqual(Kyoot.runSync(program), ["scratch@scratch", "after@outer"]);
});

test("a handler aborted by a failure no longer answers after the catch", () => {
  const program = Kyoot.gen(function* () {
    const caught = yield* Kyoot.gen(function* () {
      yield* Ask("before");
      return yield* Fail.fail("boom");
    }).pipe(
      answer("inner"),
      Fail.catchAll((e: string) => Kyoot.succeed(e)),
    );
    return [caught, yield* Ask("after")];
  }).pipe(answer("outer"));
  assert.deepEqual(Kyoot.runSync(program), ["boom", "after@outer"]);
});

test("cancel mid-stack: cleanup sees only the handlers still below it", () => {
  const seen: string[] = [];
  const program = Kyoot.gen(function* () {
    try {
      yield* Kyoot.gen(function* () {
        try {
          yield* Other("stop");
        } finally {
          seen.push(yield* Ask("inner cleanup"));
        }
      }).pipe(answer("inner"));
    } finally {
      seen.push(yield* Ask("outer cleanup"));
    }
  }).pipe(answer("outer"));
  const step = Kyoot.step(program);
  assert.equal(step.done, false);
  if (!step.done) step.cancel();
  assert.deepEqual(seen, ["inner cleanup@inner", "outer cleanup@outer"]);
});

test("a fiber forked from handler code is handled by its own handlers", async () => {
  const program = Poke().pipe(
    answer("masked"),
    Poke.handle((_, resume) =>
      Kyoot.gen(function* () {
        const fiber = yield* Async.fork(Ask("fiber").pipe(answer("fiber")));
        return yield* resume(yield* Async.join(fiber));
      }),
    ),
    answer("outer"),
  );
  assert.equal(await runPromise(program), "fiber@fiber");
});
