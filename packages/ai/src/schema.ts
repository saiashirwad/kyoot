type Validated<A> =
  | { readonly value: A; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

export interface Schema<A> {
  readonly "~standard": {
    readonly validate: (input: unknown) => Validated<A> | Promise<Validated<A>>;
    readonly jsonSchema: {
      readonly input: (options: { readonly target: "draft-2020-12" }) => Record<string, unknown>;
    };
  };
}

export const jsonSchema = (schema: Schema<unknown>) =>
  schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });

export const parse = <A>(schema: Schema<A>, input: unknown): A => {
  const r = schema["~standard"].validate(input);
  if (r instanceof Promise) throw new TypeError("async schemas are not supported");
  if (r.issues) throw new TypeError(r.issues.map((i) => i.message).join("; "));
  return r.value;
};
