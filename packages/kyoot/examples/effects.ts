import { effect, Env, Fail, Kyoot, Log, Resource } from "../src/index.ts";
import type { Kyoot as K, Row } from "../src/index.ts";

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
const Query = effect<string, User[], { fail: DbError }>()("db");
const findUser = (id: string) =>
  Kyoot.gen(function* () {
    const rows = yield* Query(`select * from users where id = '${id}'`);
    if (rows.length === 0) return yield* Fail.fail(new NotFound(id));
    return rows[0]!;
  });

const memoryDb = <A, S extends Row & { db?: string }>(k: K<A, S>) =>
  Kyoot.gen(function* () {
    const { url } = yield* Config;
    const table = yield* Resource.acquire(
      () => {
        console.log(`open ${url}`);
        return [{ id: "42", name: "douglas" }];
      },
      () => console.log(`close ${url}`),
    );
    return yield* Query.handle({
      onOp: (sql, resume) => {
        const id = sql.match(/id = '(\w+)'/)?.[1];
        if (id === undefined) return resume.with(Fail.fail(new DbError(sql)));
        return resume(table.filter((u) => u.id === id));
      },
    })(k);
  });

const greet = (id: string) =>
  findUser(id)
    .map((user) => `hello ${user.name}`)
    .pipe(Fail.catchTag("NotFound", (e: NotFound) => Kyoot.succeed(`no user ${e.id}`)));

const main = Kyoot.gen(function* () {
  console.log(yield* greet("42"));
  console.log(yield* greet("7"));
  yield* Query("drop table users");
  return "unreachable";
});

const app = main.pipe(
  Query.intercept((sql, next) => Log.info(sql).flatMap(() => next(sql))),
  memoryDb,
  Config.provide({ url: "postgres://localhost/app" }),
);

console.log(app.pipe(Resource.run, Log.print, Fail.run, Kyoot.runSync));
