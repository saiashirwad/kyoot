import { Async, Clock, Emit, Env, Fail, Kyoot, Resource, Var } from "kyoot";

// This file is intentionally runtime-free. It gives `bench:typecheck` a program
// with the same row inference patterns used by applications: services, state,
// resources, streams, typed errors, and bounded parallel work.
const Config = Env.tag<{ readonly retry: number; readonly prefix: string }>()("bench/config");
const Count = Var.tag<number>()("bench/count");

class Rejected {
  readonly _tag = "Rejected";
  constructor(readonly id: number) {}
}

const request = (id: number) =>
  Kyoot.gen(function* () {
    const config = yield* Config.get();
    yield* Count.update((count) => count + 1);
    const connection = yield* Resource.acquire(
      () => ({ id, attempts: config.retry }),
      () => Clock.sleep(0),
    );
    if (connection.id % 11 === 0) yield* Fail.fail(new Rejected(connection.id));
    yield* Emit.value(`${config.prefix}${connection.id}`);
    return connection.id + connection.attempts;
  }).pipe(Resource.run);

const realisticProgram = Kyoot.gen(function* () {
  const values = yield* Async.all(
    Array.from({ length: 40 }, (_, id) => request(id + 1)),
    {
      concurrency: 6,
    },
  );
  return values.reduce((total, value) => total + value, 0);
}).pipe(
  Fail.catchAll((error: Rejected) => Kyoot.succeed(-error.id)),
  Emit.collect,
  Count.run(0),
  Config.provide({ retry: 2, prefix: "job-" }),
  Fail.run,
);

type RealisticProgram = typeof realisticProgram;
const checkRealisticProgram = async () => Kyoot.runPromise(realisticProgram);
type RealisticResult = Awaited<ReturnType<typeof checkRealisticProgram>>;

// Keep the declarations live without adding runtime work to the benchmark.
void (0 as unknown as RealisticProgram);
void (0 as unknown as RealisticResult);
