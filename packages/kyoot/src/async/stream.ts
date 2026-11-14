import { forEach } from "../effects/emit.ts";
import type { Kyoot } from "../model.ts";
import type { Only, Op, Payload, Row } from "../types.ts";
import { fromPromise } from "./promise.ts";
import { runFiber, type LiveKey } from "./runtime.ts";

export { fromAsyncIterable } from "./promise.ts";

// Runs the program on the live driver and hands out what it emits, at most `buffer` ahead of the
// consumer. Breaking out of the loop interrupts the program.
export const toAsyncIterable = <S extends Row & { emit?: Op<unknown, void> }>(
  k: Kyoot<unknown, S> & Only<S, "emit" | LiveKey>,
  options: { readonly buffer?: number } = {},
): AsyncIterable<Payload<S, "emit">> => ({
  [Symbol.asyncIterator]() {
    const capacity = Math.max(1, options.buffer ?? 16);
    const buffer: Payload<S, "emit">[] = [];
    let finished = false;
    let failed = false;
    let failure: unknown;
    let wake = () => {};
    let drain = () => {};
    const fiber = runFiber(
      k.pipe(
        forEach((e) => {
          buffer.push(e as Payload<S, "emit">);
          if (buffer.length < capacity) {
            wake();
            return;
          }
          const parked = new Promise<void>((r) => (drain = r));
          wake();
          return fromPromise(() => parked);
        }),
      ) as never,
    );
    fiber.promise.then(
      () => ((finished = true), wake()),
      (e: unknown) => ((failed = true), (failure = e), (finished = true), wake()),
    );
    return {
      async next() {
        while (buffer.length === 0 && !finished) await new Promise<void>((r) => (wake = r));
        if (buffer.length > 0) {
          const value = buffer.shift()!;
          drain();
          return { value, done: false };
        }
        if (failed) throw failure;
        return { value: undefined, done: true };
      },
      async return() {
        fiber.interrupt();
        await fiber.promise.catch(() => {});
        return { value: undefined, done: true };
      },
    };
  },
});
