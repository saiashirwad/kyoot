import { Env, Kyoot } from "../src/index.ts";

class Config extends Env.Tag<{ id: string; name: string }>()("Config") {}
class Greeting extends Env.Tag<string>()("greeting") {}

const program = Kyoot.gen(function* () {
  const config = yield* Config.service();
  const greeting = yield* Greeting.service();

  return { config, greeting };
});

const result = Kyoot.runSync(
  program.pipe(Config.provide({ id: "hi", name: "what" }), Greeting.provide("hi")),
);

console.log(result);
