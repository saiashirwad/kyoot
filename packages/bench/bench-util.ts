export const heavy = process.env.BENCH_HEAVY === "1";

export const measure = async (
  name: string,
  runs: number,
  f: () => Promise<void>,
): Promise<void> => {
  for (let index = 0; index < Math.min(3, runs); index++) await f();
  const started = process.hrtime.bigint();
  for (let index = 0; index < runs; index++) await f();
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  console.log(
    `${name}: ${elapsed.toFixed(1)} ms for ${runs} runs (${(elapsed / runs).toFixed(3)} ms/run)`,
  );
};

export const bytes = (value: number): string => `${Math.round(value).toLocaleString("en-US")} B`;
