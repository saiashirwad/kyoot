import { Async, Kyoot, Resource } from "kyoot";
import { heavy, measure } from "./bench-util.ts";

const fibersPerRun = heavy ? 96 : 16;

const cancelMany = async (): Promise<void> => {
  let released = 0;
  const program = Kyoot.gen(function* () {
    const fibers = [];
    for (let index = 0; index < fibersPerRun; index++) {
      fibers.push(
        yield* Async.fork(
          Kyoot.gen(function* () {
            yield* Resource.acquire(
              () => index,
              () => {
                released++;
              },
            );
            yield* Async.never;
            return index;
          }).pipe(Resource.run),
        ),
      );
    }
    for (const fiber of fibers) yield* fiber.interrupt;
    for (const fiber of fibers) yield* fiber.await;
    return released;
  });
  const releasedByProgram = await Kyoot.runPromise(program);
  if (releasedByProgram !== fibersPerRun) {
    throw new Error(`expected ${fibersPerRun} finalizers, got ${releasedByProgram}`);
  }
};

console.log(`cancellation: ${fibersPerRun} parked fibers per run`);
await measure("interrupt parked fibers and await cleanup", heavy ? 100 : 12, cancelMany);
