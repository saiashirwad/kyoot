import { collect as collecting, forEach as eaching, gen, makeIntercept, op } from "../core.ts";

export const value = <E>(e: E) => op<void>()("emit", e);

export const intercept = <E = unknown>() => makeIntercept<"emit", E, void>("emit");

export const fromIterable = <E>(items: Iterable<E>) =>
  gen(function* () {
    for (const e of items) yield* value(e);
  });

export const collect = collecting("emit");

export const forEach = <E, R>(f: (e: E) => R) => eaching("emit", f);

export const map = <E, E2>(f: (e: E) => E2) => forEach((e: E) => value(f(e)));

export const discard = forEach(() => {});
