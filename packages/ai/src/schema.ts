export interface Schema<A> {
  readonly jsonSchema: object;
  readonly parse: (input: unknown) => A;
}

export type Infer<S> = S extends Schema<infer A> ? A : never;

const fail = (expected: string, input: unknown): never => {
  throw new TypeError(`expected ${expected}, got ${JSON.stringify(input)}`);
};

const primitive =
  <A>(type: string) =>
  (description?: string): Schema<A> => ({
    jsonSchema: { type, description },
    parse: (input) => (typeof input === type ? (input as A) : fail(type, input)),
  });

export const string = primitive<string>("string");
export const number = primitive<number>("number");
export const boolean = primitive<boolean>("boolean");

export const literal = <const V extends readonly (string | number | boolean)[]>(
  ...values: V
): Schema<V[number]> => ({
  jsonSchema: { enum: values },
  parse: (input) =>
    values.includes(input as V[number])
      ? (input as V[number])
      : fail(values.map((v) => JSON.stringify(v)).join(" | "), input),
});

export const array = <A>(item: Schema<A>, description?: string): Schema<A[]> => ({
  jsonSchema: { type: "array", description, items: item.jsonSchema },
  parse: (input) => (Array.isArray(input) ? input.map(item.parse) : fail("array", input)),
});

export const object = <P extends Record<string, Schema<any>>>(
  properties: P,
  description?: string,
): Schema<{ [K in keyof P]: Infer<P[K]> }> => ({
  jsonSchema: {
    type: "object",
    description,
    properties: Object.fromEntries(Object.entries(properties).map(([k, s]) => [k, s.jsonSchema])),
    required: Object.keys(properties),
  },
  parse: (input) =>
    typeof input === "object" && input !== null
      ? (Object.fromEntries(
          Object.entries(properties).map(([k, s]) => [k, s.parse((input as any)[k])]),
        ) as never)
      : fail("object", input),
});

export const Schema = { string, number, boolean, literal, array, object };
