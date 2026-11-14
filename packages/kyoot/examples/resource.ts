import { Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Resource from "../src/effects/resource.ts";

const connection = (name: string) =>
  Resource.acquire(
    Kyoot.succeed(undefined).map(() => {
      console.log(`open ${name}`);
      return { name };
    }),
    (conn) => console.log(`close ${conn.name}`),
  );

const etl = (fail: boolean) =>
  Kyoot.gen(function* () {
    const source = yield* connection("source");
    const target = yield* connection("target");
    console.log(`copy ${source.name} -> ${target.name}`);
    if (fail) yield* Fail.fail("disk full");
    return "done";
  });

console.log(Kyoot.runSync(etl(true).pipe(Fail.run, Resource.run)));
