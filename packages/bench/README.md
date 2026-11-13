# @kyoot/bench

Compares kyoot with Effect 4 on the same programs.

## Run

```sh
pnpm bench                       # every case, 5 rounds
pnpm bench --rounds 9            # more rounds, tighter ranges
pnpm bench handlers50 depth50    # selected cases
node measure.ts effect maps      # one case, one library, one process
```

`pnpm -F @kyoot/bench bench:async-batch` compares kyoot's promise batch combinators.

## Method

- Each (case, library) pair runs in its own Node process. Two libraries in one process share the JIT and the heap, so whichever runs second is measured slower than it is.
- Rounds alternate the library order, so drift over the run favors neither side.
- `measure.ts` runs the program once and checks its result against the case's expected value before timing. A wrong result aborts the run.
- mitata's `measure` times the program, and `do_not_optimize` keeps the JIT from discarding the result. The reported number is mitata's p50 for one run of the program.
- The table shows the median across rounds for each side, with the half-range as `±%`. `effect/kyoot` is the median of the per-round ratios. Above 1 means kyoot is faster.
- A case is marked `noise` when its per-round ratios fall on both sides of 1.

## Cases

The case list and expected results live in `cases.ts`. `kyoot-cases.ts` and `effect-cases.ts` hold the programs. The `handlers` cases put 0, 10, or 50 unrelated handlers (kyoot) or services (Effect) between each lookup and its provider. The `depth` cases make each lookup from inside 0, 10, or 50 nested generator calls.
