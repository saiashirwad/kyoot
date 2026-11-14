// While a simulation runs, the ambient sources of nondeterminism throw instead of answering. A
// program reaches time, randomness and I/O only through effects; this catches the ones that slip
// through (Date.now(), Math.random(), a stray setTimeout). It guards the run only: code that ran
// before it (module-level code, the world's closures created elsewhere) and code the globals don't
// cover (new Date(), Intl, a captured reference to Date.now) is not checked.

type Target = {
  readonly owner: object;
  readonly key: string;
  readonly name: string;
  readonly use: string;
};

const time = "Clock.now";
const random = "the random effect (Random)";
const timer = "Clock.sleep";
const io = "an effect answered by the world";

const targets = (): Target[] => {
  const g = globalThis as Record<string, any>;
  const list: Target[] = [
    { owner: Date, key: "now", name: "Date.now()", use: time },
    { owner: Math, key: "random", name: "Math.random()", use: random },
  ];
  const add = (owner: unknown, key: string, name: string, use: string) => {
    if (typeof owner === "object" || typeof owner === "function") {
      if (owner !== null && typeof (owner as Record<string, unknown>)[key] === "function") {
        list.push({ owner, key, name, use });
      }
    }
  };
  add(g.performance, "now", "performance.now()", time);
  add(g, "setTimeout", "setTimeout()", timer);
  add(g, "setInterval", "setInterval()", timer);
  add(g, "setImmediate", "setImmediate()", timer);
  add(g, "fetch", "fetch()", io);
  add(g.crypto, "randomUUID", "crypto.randomUUID()", random);
  add(g.crypto, "getRandomValues", "crypto.getRandomValues()", random);
  return list;
};

const trip = (t: Target) => () => {
  throw new Error(
    `${t.name} inside Sim.run breaks determinism; use ${t.use} (or pass { guard: false })`,
  );
};

/** Runs f with the nondeterministic globals replaced by ones that throw; always restores them. */
export const guarded = <A>(f: () => A): A => {
  const saved: Array<readonly [Target, PropertyDescriptor | undefined]> = [];
  try {
    for (const t of targets()) {
      const own = Object.getOwnPropertyDescriptor(t.owner, t.key);
      try {
        Object.defineProperty(t.owner, t.key, {
          value: trip(t),
          writable: true,
          configurable: true,
          enumerable: own?.enumerable ?? false,
        });
        saved.push([t, own]);
      } catch {
        // A global that can't be replaced is left alone.
      }
    }
    return f();
  } finally {
    for (const [t, own] of saved.reverse()) {
      if (own === undefined) Reflect.deleteProperty(t.owner, t.key);
      else Object.defineProperty(t.owner, t.key, own);
    }
  }
};
