// Same programs written twice: kyoot and Effect v4. `pnpm bench` from the
// root. Each group ends with a summary of which is faster and by how much.
import { bench, group, run, summary } from "mitata";
import { Context, Effect, Ref } from "effect";
import { Async, Env, Fail, Kyoot, Var, type Kyoot as Program } from "kyoot";

const size = 100;

const kyoot = (() => {
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
  const environment = Kyoot.gen(function* () {
    let sum = 0;
    for (let index = 0; index < size; index++) sum += (yield* Service.get()).value;
    return sum;
  }).pipe(Service.provide({ value: 1 }));

  const Counter = Var.tag<number>()("bench-counter");
  const state = Kyoot.gen(function* () {
    for (let index = 0; index < size; index++) yield* Counter.update((value) => value + 1);
    return yield* Counter.get();
  }).pipe(Counter.run(0));

  const failing = Kyoot.gen(function* () {
    let sum = 0;
    for (let index = 0; index < 10; index++) sum += yield* Kyoot.succeed(index);
    if (sum > 0) yield* Fail.fail("boom" as const);
    return sum;
  }).pipe(Fail.run);

  const asynchronous = Kyoot.gen(function* () {
    let sum = 0;
    for (let index = 0; index < size; index++) {
      sum += yield* Async.fromPromise(() => Promise.resolve(index));
    }
    return sum;
  });

  return {
    tiny: () => Kyoot.runSync(Kyoot.succeed(1)),
    maps: () => Kyoot.runSync(maps),
    flatMaps: () => Kyoot.runSync(flatMaps),
    generators: () => Kyoot.runSync(generators),
    environment: () => Kyoot.runSync(environment),
    state: () => Kyoot.runSync(state),
    failing: () => Kyoot.runSync(failing),
    asynchronous: () => Kyoot.runPromise(asynchronous),
  };
})();

const effect = (() => {
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
  const environment = Effect.gen(function* () {
    let sum = 0;
    for (let index = 0; index < size; index++) sum += (yield* Service).value;
    return sum;
  }).pipe(Effect.provideService(Service, { value: 1 }));

  const state = Effect.gen(function* () {
    const counter = yield* Ref.make(0);
    for (let index = 0; index < size; index++) yield* Ref.update(counter, (value) => value + 1);
    return yield* Ref.get(counter);
  });

  const failing = Effect.gen(function* () {
    let sum = 0;
    for (let index = 0; index < 10; index++) sum += yield* Effect.succeed(index);
    if (sum > 0) yield* Effect.fail("boom" as const);
    return sum;
  }).pipe(Effect.result);

  const asynchronous = Effect.gen(function* () {
    let sum = 0;
    for (let index = 0; index < size; index++) {
      sum += yield* Effect.promise(() => Promise.resolve(index));
    }
    return sum;
  });

  return {
    tiny: () => Effect.runSync(Effect.succeed(1)),
    maps: () => Effect.runSync(maps),
    flatMaps: () => Effect.runSync(flatMaps),
    generators: () => Effect.runSync(generators),
    environment: () => Effect.runSync(environment),
    state: () => Effect.runSync(state),
    failing: () => Effect.runSync(failing),
    asynchronous: () => Effect.runPromise(asynchronous),
  };
})();

const cases: Record<keyof typeof kyoot, string> = {
  tiny: "runSync(succeed(1))",
  maps: `${size} × map`,
  flatMaps: `${size} × flatMap`,
  generators: `${size} × yield* succeed`,
  environment: `${size} × service lookup`,
  state: `${size} × state update`,
  failing: "10 × yield*, then a typed failure",
  asynchronous: `${size} × await a resolved promise`,
};

for (const [name, title] of Object.entries(cases) as Array<[keyof typeof kyoot, string]>) {
  group(`${name}: ${title}`, () => {
    summary(() => {
      bench("kyoot", kyoot[name]);
      bench("effect", effect[name]);
    });
  });
}

await run();
