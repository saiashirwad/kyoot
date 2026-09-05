import { effect, makeHandler, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

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
  onOp: ({ level, message }, resume) => {
    console[level === "debug" ? "log" : level](message);
    return resume(undefined);
  },
});

export const collect = <A, S extends Row & { log?: Entry }, Ops>(k: Kyoot<A, S, Ops>) =>
  makeHandler("log", k, {
    create: () => [] as Entry[],
    onOp: (entry, resume, entries) => {
      entries.push(entry);
      return resume(undefined);
    },
    onSuccess: (a, entries) => succeed([a, entries] as const),
  });

export const discard = log.handle({ onOp: (_e, resume) => resume(undefined) });
