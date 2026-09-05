import assert from "node:assert/strict";
import { test } from "node:test";
import { Env, Fail, Kyoot, Resource } from "../src/index.ts";

const Config = Env.tag<{ url: string }>()("config");
const Db = Env.tag<{ query(sql: string): string }>()("db");

const makeDb = Config.get().map(({ url }) => ({ query: (sql: string) => `${url}: ${sql}` }));

test("Env: provide(make) runs the program, which may use a handler outside", () => {
  const prog = Db.get().map((db) => db.query("select 1"));
  const r = Kyoot.runSync(prog.pipe(Db.provideEffect(makeDb), Config.provide({ url: "pg" })));
  assert.equal(r, "pg: select 1");
});

test("Env: provide(make) runs once per run, however often the service is used", () => {
  let built = 0;
  const make = Kyoot.gen(function* () {
    const { url } = yield* Config;
    built++;
    return { query: (sql: string) => `${url}: ${sql}` };
  });
  const prog = Kyoot.gen(function* () {
    const a = yield* Db;
    const b = yield* Db;
    return a.query("1") + b.query("2");
  });
  const app = prog.pipe(Db.provideEffect(make), Config.provide({ url: "pg" }));
  assert.equal(Kyoot.runSync(app), "pg: 1pg: 2");
  assert.equal(built, 1);
  Kyoot.runSync(app);
  assert.equal(built, 2);
});

test("Env: provide keeps a Kyoot service as a value", () => {
  const service = Kyoot.succeed({ query: () => "ok" });
  const provided = Db.provide(service as never);
  assert.equal(Kyoot.runSync(Db.get().pipe(provided as never) as never), service);
});

test("Env: a resource the program opens is released after the program", () => {
  const events: string[] = [];
  const make = Kyoot.gen(function* () {
    const conn = yield* Resource.acquire(
      () => {
        events.push("open");
        return { run: (sql: string) => `ran ${sql}` };
      },
      () => events.push("close"),
    );
    return { query: (sql: string) => conn.run(sql) };
  });
  const prog = Db.get().map((db) => {
    events.push("use");
    return db.query("select 1");
  });
  assert.equal(Kyoot.runSync(prog.pipe(Db.provideEffect(make), Resource.run)), "ran select 1");
  assert.deepEqual(events, ["open", "use", "close"]);
});

test("Env: a program that fails fails the whole program", () => {
  class BadConfig {
    readonly _tag = "BadConfig";
  }
  const make = Kyoot.gen(function* () {
    const { url } = yield* Config;
    if (url === "") return yield* Fail.fail(new BadConfig());
    return { query: (sql: string) => sql };
  });
  const prog = Db.get().map((db) => db.query("select 1"));
  const r = Kyoot.runSync(prog.pipe(Db.provideEffect(make), Config.provide({ url: "" }), Fail.run));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.cause._tag, "Fail");
});

test("Env: intercept wraps a provided service", () => {
  const seen: string[] = [];
  const spy = Db.intercept((_, next) =>
    next(undefined).map((db) => ({
      query: (sql: string) => {
        seen.push(sql);
        return db.query(sql);
      },
    })),
  );
  const prog = Kyoot.gen(function* () {
    const db = yield* Db;
    return db.query("a") + db.query("b");
  });
  const app = prog.pipe(spy, Db.provideEffect(makeDb), Config.provide({ url: "pg" }));
  assert.equal(Kyoot.runSync(app), "pg: apg: b");
  assert.deepEqual(seen, ["a", "b"]);
});
