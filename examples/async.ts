import { Abort, Async, Kyoot } from "../src/index.ts";
import { Result } from "../src/index.ts";

class FetchFailed {
  readonly _tag = "FetchFailed";
  readonly name: string;
  readonly status: number;
  constructor(name: string, status: number) {
    this.name = name;
    this.status = status;
  }
}

interface Pokemon {
  name: string;
  heightCm: number;
  weightKg: number;
  types: string[];
}

const get = (url: string) =>
  Async.suspend<{ status: number; json: unknown }>((resume, signal) => {
    fetch(url, { signal }).then(
      (res) =>
        res.json().then(
          (json) => resume({ status: res.status, json }),
          () => resume({ status: 0, json: null }),
        ),
      () => resume({ status: 0, json: null }),
    );
  });

const pokemon = (name: string) =>
  Kyoot.gen(function* () {
    const r = yield* get(`https://pokeapi.co/api/v2/pokemon/${name}`);
    if (r.status !== 200) yield* Abort.fail(new FetchFailed(name, r.status));
    const data = r.json as {
      name: string;
      height: number;
      weight: number;
      types: ReadonlyArray<{ type: { name: string } }>;
    };
    return {
      name: data.name,
      heightCm: data.height * 10,
      weightKg: data.weight / 10,
      types: data.types.map((t) => t.type.name),
    };
  });

const show = (p: Pokemon) => `${p.name} — ${p.types.join("/")}, ${p.heightCm}cm, ${p.weightKg}kg`;

const main = Kyoot.gen(function* () {
  console.log("racing pikachu vs slowpoke (loser gets interrupted)...");
  const winner = yield* Async.race(
    pokemon("pikachu").pipe(Abort.run()),
    pokemon("slowpoke").pipe(Abort.run()),
  );
  console.log(Result.isOk(winner) ? `winner: ${show(winner.value)}` : "race failed");

  console.log("\nfetching the starters in parallel...");
  const fibers: Async.Fiber<Result<FetchFailed, Pokemon>>[] = [];
  for (const name of ["bulbasaur", "charmander", "squirtle"]) {
    fibers.push(yield* Async.fork(pokemon(name).pipe(Abort.run())));
  }
  for (const fiber of fibers) {
    const r = yield* fiber.join;
    console.log(r.ok ? show(r.value) : `failed: ${JSON.stringify(r.cause)}`);
  }

  console.log("\nditto, with a 5s timeout...");
  const timed = yield* Async.timeout(5000, pokemon("ditto").pipe(Abort.run())).pipe(Abort.run());
  console.log(
    timed.ok
      ? timed.value.ok
        ? show(timed.value.value)
        : `failed: ${JSON.stringify(timed.value.cause)}`
      : "timed out",
  );
});

await Kyoot.runPromise(main);
