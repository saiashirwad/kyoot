import { Async, effect, Kyoot, Resource } from "kyoot";
import { heavy, measure } from "./bench-util.ts";

const workers = heavy ? 64 : 12;
const handlerDepth = heavy ? 80 : 20;

const scopedForkJoin = async (): Promise<void> => {
  let cleaned = 0;
  const program = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "parent",
      () => {
        cleaned++;
      },
    );
    const fibers = yield* Async.all(
      Array.from({ length: workers }, (_, index) =>
        Kyoot.gen(function* () {
          const value = yield* Resource.acquire(
            () => index,
            () => {
              cleaned++;
            },
          );
          return value * 2;
        }).pipe(Resource.run),
      ),
      { concurrency: 4 },
    );
    return fibers.reduce((total, value) => total + value, 0);
  }).pipe(Resource.run);

  const value = await Kyoot.runPromise(program);
  if (value !== workers * (workers - 1) || cleaned !== workers + 1) {
    throw new Error(`scope benchmark lost cleanup or work: value=${value}, cleaned=${cleaned}`);
  }
};

const Ask = effect<number, number>()("bench/deep-intercept");

const deepInterception = async (): Promise<void> => {
  let program = Ask(0);
  for (let index = 0; index < handlerDepth; index++) {
    program = program.pipe(Ask.intercept((value, next) => next(value + 1)));
  }
  const value = Kyoot.runSync(program.pipe(Ask.handle({ onOp: (value, resume) => resume(value) })));
  if (value !== handlerDepth) throw new Error(`interception returned ${value}`);
};

console.log(`scopes: ${workers} scoped workers; ${handlerDepth} nested interceptors`);
await measure("scoped fork/join with cleanup", heavy ? 300 : 30, scopedForkJoin);
await measure("deep handler interception", heavy ? 20_000 : 2_000, deepInterception);
