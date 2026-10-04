import { Env } from "kyoot";
import { Registry, type Ctx } from "../src/index.ts";
const Name = Env.tag<string>()("name");
const registry = new Registry();
registry.set(Name, "valid");
// @ts-expect-error registry storage cannot widen a tag's value contract
registry.set(Name, 1);
declare const ctx: Ctx;
// @ts-expect-error component providers obey the same tag value contract
ctx.set(Name, 1);
