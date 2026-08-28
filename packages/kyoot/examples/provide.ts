import { Env, Fail, Kyoot, Resource } from "../src/index.ts";

class DbError {
  readonly _tag = "DbError";
  readonly sql: string;
  constructor(sql: string) {
    this.sql = sql;
  }
}
class NotFound {
  readonly _tag = "NotFound";
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

interface User {
  readonly id: string;
  readonly name: string;
}

const Config = Env.tag<{ url: string }>()("config");

const Db = Env.tag<{
  query(sql: string): Kyoot<User[], { fail: DbError }>;
}>()("db");

const Users = Env.tag<{
  find(id: string): Kyoot<User, { fail: DbError | NotFound }>;
}>()("users");

const memoryDb = Kyoot.gen(function* () {
  const { url } = yield* Config;
  const table = yield* Resource.acquire(
    () => {
      console.log(`open ${url}`);
      return [{ id: "42", name: "douglas" }];
    },
    () => console.log(`close ${url}`),
  );
  return {
    query: (sql: string) =>
      Kyoot.gen(function* () {
        const id = sql.match(/id = '(\w+)'/)?.[1];
        if (id === undefined) return yield* Fail.fail(new DbError(sql));
        return table.filter((u) => u.id === id);
      }),
  };
});

const users = Kyoot.gen(function* () {
  const db = yield* Db;
  return {
    find: (id: string) =>
      Kyoot.gen(function* () {
        const rows = yield* db.query(`select * from users where id = '${id}'`);
        if (rows.length === 0) return yield* Fail.fail(new NotFound(id));
        return rows[0]!;
      }),
  };
});

const greet = (id: string) =>
  Kyoot.gen(function* () {
    const users = yield* Users;
    const user = yield* users.find(id);
    return `hello ${user.name}`;
  }).pipe(Fail.catchTag("NotFound", (e: NotFound) => Kyoot.succeed(`no user ${e.id}`)));

const main = Kyoot.gen(function* () {
  console.log(yield* greet("42"));
  console.log(yield* greet("7"));
  const db = yield* Db;
  const res = yield* db.query("drop table users");
  console.log(res);
  return "unreachable";
});

const app = main.pipe(
  Db.intercept((_, next) =>
    next(undefined).map((db) => ({
      query: (sql: string) => {
        if (!sql.startsWith("select")) return Fail.fail(new DbError(sql));
        return db.query(sql);
      },
    })),
  ),
  Users.provide(users),
  Db.provide(memoryDb),
  Config.provide({ url: "postgres://localhost/app" }),
);

console.log(app.pipe(Resource.run, Fail.run, Kyoot.runSync));
