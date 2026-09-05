import assert from "node:assert/strict";
import { Async, effect, Kyoot } from "kyoot";

export const Greeting = effect<string, string>()("greeting");
export const welcome = Greeting("Ada").map((text) => `${text}!`);
export const deterministic = Greeting.handle({
  onOp: (name, resume) => resume(`Hello, ${name}`),
});
export const live = Greeting.handle({
  onOp: (name, resume) =>
    Async.fromPromise(async (signal) => {
      const response = await fetch(
        `https://example.com/greeting?name=${encodeURIComponent(name)}`,
        { signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }).flatMap(resume),
});
export const uppercase = Greeting.intercept((name, next) =>
  next(name).map((text) => text.toUpperCase()),
);
assert.equal(welcome.pipe(uppercase, deterministic, Kyoot.runSync), "HELLO, ADA!");
