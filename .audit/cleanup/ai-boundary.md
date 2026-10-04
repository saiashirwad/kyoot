# AI protocol boundary

The local Response regressions failed before the fixes for truncated streams, missing assembled IDs and names, invalid call indexes, void results, and the reserved answer tool. They pass after the fixes. The full AI suite and its typecheck pass.

The SSE iterator now returns whether it read the terminal marker. The provider requires that marker and validates assembled call identities before exposing a completion. Void tools encode as the JSON string null. Structured output rejects a user tool named answer before requesting a model or executing tools.

Boundary Discipline put completion validation at the provider boundary. Deslop review kept the changes in the existing parser, provider, and generation loop. Process recovery remains outside this work.

Coordinator review found a related assembly defect after the first boundary fix. An index of Number.MAX_SAFE_INTEGER was accepted, stored outside the array's indexed elements, and silently omitted from a successful completion. Sparse indices also forced array traversal proportional to the index. ai-index-red.log records failures for huge and missing indices, numeric name fragments, object argument fragments, and conflicting IDs.

Assembly now uses a Map keyed by validated indices and checks a contiguous ordered set at completion. Fragment types and conflicting IDs are rejected before concatenation. Duplicate assembled IDs remain invalid. This preserves bounded work proportional to received calls rather than provider-supplied array length.

Independent review then reproduced two stream ownership defects. Rejecting malformed data left an open source uncancelled and locked. Interrupting a pending local stream read also left the source open. ai-stream-red.log records both cancellation assertions failing.

The provider now acquires the iterator as a resource and closes it during unwind. The fetch signal also controls the existing decoding pipeline, so interruption settles a pending read before the queued iterator return completes. This reuses the decoder and async iterator rather than adding a second manual reader and decoder state machine. The retained tests inspect source cancellation and lock release on both paths.

The next independent review verified stream cancellation and assembly but rejected malformed chunk shapes. Object tool_calls and null members became defects, while numeric content was coerced to text. ai-shape-red.log retains eight failing shape regressions. Provider input now arrives as unknown and is checked once before consumption. The guard covers used containers, content, call fragments, indices, and nonnegative integer usage counts. Nullable tool_calls represents no calls. Conflicting IDs and contiguous assembly remain stateful checks in the assembly loop.
