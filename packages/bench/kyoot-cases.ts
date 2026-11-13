import { Env, Fail, Kyoot, Var, type Kyoot as Program, type Result } from "kyoot";
import { Async, runPromise } from "kyoot/async";
import { size, type Library } from "./cases.ts";

let maps: Program<number> = Kyoot.succeed(0);
for (let index = 0; index < size; index++) maps = maps.map((value) => value + 1);

let flatMaps: Program<number> = Kyoot.succeed(0);
for (let index = 0; index < size; index++) {
  flatMaps = flatMaps.flatMap((value) => Kyoot.succeed(value + 1));
}

const generators = Kyoot.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) sum += yield* Kyoot.succeed(index);
  return sum;
});

const Service = Env.tag<{ readonly value: number }>()("bench-service");

const lookups = Kyoot.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) sum += (yield* Service.get()).value;
  return sum;
});

const environment = lookups.pipe(Service.provide({ value: 1 }));

const Counter = Var.tag<number>()("bench-counter");
const state = Kyoot.gen(function* () {
  for (let index = 0; index < size; index++) yield* Counter.update((value) => value + 1);
  return yield* Counter.get();
}).pipe(Counter.run(0));

const failing = Kyoot.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) sum += yield* Kyoot.succeed(index);
  if (sum >= 0) yield* Fail.fail("boom" as const);
  return sum;
}).pipe(Fail.run);

const asynchronous = Kyoot.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) {
    sum += yield* Async.fromPromise(() => Promise.resolve(index));
  }
  return sum;
});

const withUnrelatedHandlers = (count: number): Program<number> => {
  let program: Program<number, any> = lookups;
  for (let index = 0; index < count; index++) {
    program = program.pipe(
      Env.tag<{ readonly value: number }>()(`unrelated-${index}`).provide({ value: 0 }),
    );
  }
  return program.pipe(Service.provide({ value: 1 }));
};

const insideNestedGens = (depth: number): Program<number> => {
  let program: Program<number, any> = lookups;
  for (let index = 0; index < depth; index++) {
    const inner = program;
    program = Kyoot.gen(function* () {
      return yield* inner;
    });
  }
  return program.pipe(Service.provide({ value: 1 }));
};

const runSync = (program: Program<unknown>) => () => Kyoot.runSync(program);

export default {
  maps: { run: runSync(maps) },
  flatMaps: { run: runSync(flatMaps) },
  generators: { run: runSync(generators) },
  environment: { run: runSync(environment) },
  state: { run: runSync(state), read: ([result]: readonly [number, number]) => result },
  failing: {
    run: runSync(failing),
    read: (result: Result<string, number>) =>
      result.ok ? result.value : result.cause._tag === "Fail" ? result.cause.error : result.cause,
  },
  asynchronous: { run: () => runPromise(asynchronous) },
  handlers0: { run: runSync(withUnrelatedHandlers(0)) },
  handlers10: { run: runSync(withUnrelatedHandlers(10)) },
  handlers50: { run: runSync(withUnrelatedHandlers(50)) },
  depth0: { run: runSync(insideNestedGens(0)) },
  depth10: { run: runSync(insideNestedGens(10)) },
  depth50: { run: runSync(insideNestedGens(50)) },
} satisfies Library;
