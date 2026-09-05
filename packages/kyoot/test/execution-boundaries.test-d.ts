import { Async, Clock, Emit, Env, Kyoot, Resource } from "../src/index.ts";
import type { AsyncOp, Kyoot as KyootT, RowsOf } from "../src/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ValueOf<R> = R extends KyootT<infer A, any, any> ? A : never;

const Service = Env.tag<KyootT<number>>()("program-service");
const service = Kyoot.succeed(1);
const valueProvided = Service.get().pipe(Service.provide(service));
const aliasProvided = Service.get().pipe(Service.provideValue(service));
type _valueProvided = Expect<Equal<ValueOf<typeof valueProvided>, KyootT<number>>>;
type _aliasProvided = Expect<Equal<ValueOf<typeof aliasProvided>, KyootT<number>>>;

const effectResource = Resource.acquireEffect(
  () => Clock.sleep(1).map(() => "value"),
  () => Clock.sleep(1),
);
const effectResourceRun = effectResource.pipe(Resource.run);
type _effectRows = Expect<Equal<keyof RowsOf<typeof effectResourceRun>, "clock">>;

const promiseResource = Resource.acquirePromise(
  async () => "value",
  async () => undefined,
).pipe(Resource.run);
type _promiseRows = Expect<Equal<keyof RowsOf<typeof promiseResource>, "async">>;
type _promiseOp = Expect<Equal<RowsOf<typeof promiseResource>["async"], AsyncOp>>;

const promiseRelease = Resource.acquire(
  () => "resource",
  async () => undefined,
).pipe(Resource.run);
type _promiseReleaseRow = Expect<Equal<keyof RowsOf<typeof promiseRelease>, "async">>;
// @ts-expect-error Promise releases require an asynchronous runner
Kyoot.runSync(promiseRelease);
const consumedPromise = Emit.value(1).pipe(Emit.forEach(async (n: number) => n + 1));
type _consumedPromiseRow = Expect<Equal<keyof RowsOf<typeof consumedPromise>, "async">>;
// @ts-expect-error Promise callbacks require an asynchronous runner
Kyoot.runSync(consumedPromise);
const attempted = Async.tryPromise(
  async () => 1,
  (reason) => ({ reason }),
);
type _attemptRows = Expect<Equal<keyof RowsOf<typeof attempted>, "async" | "fail">>;
type _attemptFailure = Expect<Equal<RowsOf<typeof attempted>["fail"], { reason: unknown }>>;
