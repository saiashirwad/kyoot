import { collect as collecting, effect } from "../core.ts";

export type Level = "debug" | "info" | "warn" | "error";

export interface Entry {
  readonly level: Level;
  readonly message: string;
}

const log = effect<Entry, void>()("log");

const at = (level: Level) => (message: string) => log({ level, message });

export const handle = log.handle;

export const intercept = log.intercept;

export const debug = at("debug");
export const info = at("info");
export const warn = at("warn");
export const error = at("error");

export const print = log.handle({
  tail: ({ level, message }) => console[level === "debug" ? "log" : level](message),
});

export const collect = collecting("log");

export const discard = log.handle({ tail: () => {} });
