import { Context, Effect, Ref, Result } from "effect";
import { size, type Library } from "./cases.ts";

let maps: Effect.Effect<number> = Effect.succeed(0);
for (let index = 0; index < size; index++) maps = Effect.map(maps, (value) => value + 1);

let flatMaps: Effect.Effect<number> = Effect.succeed(0);
for (let index = 0; index < size; index++) {
  flatMaps = Effect.flatMap(flatMaps, (value) => Effect.succeed(value + 1));
}

const generators = Effect.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) sum += yield* Effect.succeed(index);
  return sum;
});

class Service extends Context.Service<Service, { readonly value: number }>()("bench-service") {}

const lookups = Effect.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) sum += (yield* Service).value;
  return sum;
});

const environment = lookups.pipe(Effect.provideService(Service, { value: 1 }));

const state = Effect.gen(function* () {
  const counter = yield* Ref.make(0);
  for (let index = 0; index < size; index++) yield* Ref.update(counter, (value) => value + 1);
  return yield* Ref.get(counter);
});

const failing = Effect.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) sum += yield* Effect.succeed(index);
  if (sum >= 0) yield* Effect.fail("boom" as const);
  return sum;
}).pipe(Effect.result);

const asynchronous = Effect.gen(function* () {
  let sum = 0;
  for (let index = 0; index < size; index++) {
    sum += yield* Effect.promise(() => Promise.resolve(index));
  }
  return sum;
});

const withUnrelatedServices = (count: number): Effect.Effect<number> => {
  let program: Effect.Effect<number, never, any> = lookups;
  for (let index = 0; index < count; index++) {
    const Unrelated = Context.Service<{ readonly value: number }>(`unrelated-${index}`);
    program = program.pipe(Effect.provideService(Unrelated, { value: 0 }));
  }
  return program.pipe(Effect.provideService(Service, { value: 1 })) as Effect.Effect<number>;
};

const insideNestedGens = (depth: number): Effect.Effect<number> => {
  let program: Effect.Effect<number, never, any> = lookups;
  for (let index = 0; index < depth; index++) {
    const inner = program;
    program = Effect.gen(function* () {
      return yield* inner;
    });
  }
  return program.pipe(Effect.provideService(Service, { value: 1 })) as Effect.Effect<number>;
};

const runSync = (program: Effect.Effect<unknown>) => () => Effect.runSync(program);

export default {
  maps: { run: runSync(maps) },
  flatMaps: { run: runSync(flatMaps) },
  generators: { run: runSync(generators) },
  environment: { run: runSync(environment) },
  state: { run: runSync(state) },
  failing: {
    run: runSync(failing),
    read: (result: Result.Result<number, string>) =>
      Result.isFailure(result) ? result.failure : result.success,
  },
  asynchronous: { run: () => Effect.runPromise(asynchronous) },
  handlers0: { run: runSync(withUnrelatedServices(0)) },
  handlers10: { run: runSync(withUnrelatedServices(10)) },
  handlers50: { run: runSync(withUnrelatedServices(50)) },
  depth0: { run: runSync(insideNestedGens(0)) },
  depth10: { run: runSync(insideNestedGens(10)) },
  depth50: { run: runSync(insideNestedGens(50)) },
} satisfies Library;
