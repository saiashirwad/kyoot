import assert from "node:assert/strict";
import { test } from "node:test";
import { Env, Kyoot, Registry, Resource, Sync } from "../src/index.ts";

const Db = Env.tag<{ name: string }>()("db");
const Cache = Env.tag<{ size: number }>()("cache");

const log = () => {
  const events: string[] = [];
  const database = (name: string) =>
    Registry.component({
      inject: {},
      run: (_, ctx) =>
        Kyoot.gen(function* () {
          yield* Resource.acquire(
            () => events.push(`open ${name}`),
            () => events.push(`close ${name}`),
          );
          yield* ctx.set(Db, { name });
        }),
    });
  const server = Registry.component({
    inject: { db: Db },
    run: ({ db }) =>
      Resource.acquire(
        () => events.push(`up on ${db.name}`),
        () => events.push(`down`),
      ),
  });
  return { events, database, server };
};

test("a component activates when its dependencies appear", async () => {
  const { events, database, server } = log();
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const srv = yield* registry.use(server);
      assert.equal(srv.active, false);
      yield* registry.use(database("pg"));
      yield* registry.settled();
      assert.equal(srv.active, true);
      yield* registry.dispose();
    }),
  );
  assert.deepEqual(events, ["open pg", "up on pg", "down", "close pg"]);
});

test("withdrawing a provider tears down dependents first", async () => {
  const { events, database, server } = log();
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const db = yield* registry.use(database("pg"));
      const srv = yield* registry.use(server);
      assert.equal(srv.active, true);
      yield* db.remove();
      assert.equal(srv.active, false);
      yield* registry.dispose();
    }),
  );
  assert.deepEqual(events, ["open pg", "up on pg", "down", "close pg"]);
});

test("hot swap: a replacement provider reactivates dependents on the new value", async () => {
  const { events, database, server } = log();
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      const old = yield* registry.use(database("pg-1"));
      yield* registry.use(server);
      yield* old.remove();
      yield* registry.use(database("pg-2"));
      yield* registry.settled();
      yield* registry.dispose();
    }),
  );
  assert.deepEqual(events, [
    "open pg-1",
    "up on pg-1",
    "down",
    "close pg-1",
    "open pg-2",
    "up on pg-2",
    "down",
    "close pg-2",
  ]);
});

test("a root binding counts as a provider", async () => {
  const { events, server } = log();
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(server);
      yield* registry.set(Db, { name: "root" });
      yield* registry.settled();
      yield* registry.dispose();
    }).pipe(Resource.run),
  );
  assert.deepEqual(events, ["up on root", "down"]);
});

test("a component whose setup throws is inactive with the error, and others keep working", async () => {
  const { events, database, server } = log();
  const boom = new Error("boom");
  const broken = Registry.component({
    inject: { db: Db },
    run: () =>
      Sync.defer(() => {
        throw boom;
      }).pipe(Sync.run),
  });
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(database("pg"));
      const bad = yield* registry.use(broken);
      const good = yield* registry.use(server);
      assert.equal(bad.active, false);
      assert.equal(bad.error, boom);
      assert.equal(good.active, true);
      yield* registry.dispose();
    }),
  );
  assert.deepEqual(events, ["open pg", "up on pg", "down", "close pg"]);
});

test("dispose unloads in reverse order", async () => {
  const { events, database, server } = log();
  const cache = Registry.component({
    inject: { db: Db },
    run: (_, ctx) =>
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          () => events.push("cache up"),
          () => events.push("cache down"),
        );
        yield* ctx.set(Cache, { size: 1 });
      }),
  });
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const registry = yield* Registry.make();
      yield* registry.use(database("pg"));
      yield* registry.use(cache);
      yield* registry.use(server);
      yield* registry.dispose();
    }),
  );
  assert.deepEqual(events, ["open pg", "cache up", "up on pg", "down", "cache down", "close pg"]);
});
