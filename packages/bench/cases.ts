export const size = 100;

const triangle = (size * (size - 1)) / 2;

export const cases = {
  maps: { title: `${size} × map`, expected: size },
  flatMaps: { title: `${size} × flatMap`, expected: size },
  generators: { title: `${size} × yield* succeed`, expected: triangle },
  environment: { title: `${size} × service lookup`, expected: size },
  state: { title: `${size} × state update`, expected: size },
  failing: { title: `${size} × yield*, then a typed failure`, expected: "boom" },
  asynchronous: { title: `${size} × await a resolved promise`, expected: triangle },
  handlers0: { title: `${size} lookups, 0 unrelated handlers between`, expected: size },
  handlers10: { title: `${size} lookups, 10 unrelated handlers between`, expected: size },
  handlers50: { title: `${size} lookups, 50 unrelated handlers between`, expected: size },
  depth0: { title: `${size} lookups inside 0 nested gen calls`, expected: size },
  depth10: { title: `${size} lookups inside 10 nested gen calls`, expected: size },
  depth50: { title: `${size} lookups inside 50 nested gen calls`, expected: size },
} as const;

export type CaseName = keyof typeof cases;

export const caseNames = Object.keys(cases) as CaseName[];

/** `run` is timed. `read` turns its result into the case's `expected` value and is not timed. */
export type Entry = { readonly run: () => unknown; readonly read?: (result: never) => unknown };

export type Library = Record<CaseName, Entry>;

export const libraries = ["kyoot", "effect"] as const;

export type LibraryName = (typeof libraries)[number];
