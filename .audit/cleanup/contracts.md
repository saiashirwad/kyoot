# A11, A12, A13 contracts and inheritance

Historical initial implementation, NOT VERIFIED. Independent review of commit 2d62944 found intersection laundering, union dispatch keys, and fixed/dependent crossing despite the checks recorded below. The contract claims and proof in this document are superseded by [contracts-repair.md](contracts-repair.md). The inheritance behavior remains covered by its runtime tests.

Selected candidate A preserves string dispatch and adds invariant payload and answer witnesses to checked requirement rows. Candidate B's runtime identity alternative was unnecessary. `Requirement<P, A, V = P>` also preserves the independent requirement value used by Env and Var. Ordinary calls to those APIs remain unchanged.

The runtime still sends an operation's actual payload. Generic checked handlers therefore extract P, not V. This distinction matters for Env, whose performed payload is void even though its independent value is the environment. A union of incompatible answers requires their intersection at raw-key resume; accepting their union would allow a handler to resume the wrong operation. `NoInfer<S>` prevents hooks from widening the row used for extraction. Raw-key checked handlers admit only pure `resume.with` continuations. Declaration-bound `handler` retains the declaration's continuation contract.

The existing internal makeHandler remains a trusted implementation boundary. The public package exports the checked version as makeHandler. Public raw op and makeIntercept are renamed unsafeOp and unsafeMakeIntercept. Sync and Async retain raw dependent rows and use their internal interceptors. Their answer depends on the submitted callback, so pretending each has a single invariant answer would break useful existing APIs. Var's dependent return type remains trusted as well.

`ForkMode<St>` is share, scope, none, or `(state: St) => St`. The copier runs in inherit for every child, never at snapshot capture. Scope retains fresh creation and completion hooks. Shared and copied children omit parent completion hooks, and none remains filtered by runtime snapshot capture.

## Evidence

Baseline 421ad78 was extracted to a separate temporary directory. The compiler accepted mismatched checked answers and wrong raw-key resume answers. Negative probes reported TS2578, unused ts-expect-error, at both sites. Assigning undefined to `Payload<{raw: undefined}, "raw">` instead failed TS2322 because the extracted type was never.

The new sibling and nested-child runtime regression failed against that baseline. Parent state ended at 8 instead of 2. Children observed `[2, 3, 6]` and `[4, 5, 7]` instead of independent `[2, 3, 3]` results. The fixed version creates four copies with source state values `[1, 1, 2, 2]`, leaves parent state at 2, and returns the independent child results. Separate tests retain explicit shared-reference behavior and fresh scope behavior. Existing resource and none-inheritance regressions remain part of the core suite.

Compile coverage includes same-contract interoperability, different answers, both literal answer directions, incompatible merged requirements, interceptors, raw-key wrong answers, payload widening, and undefined extraction. An initial union-answer implementation failed the new raw-key union probe and was replaced with intersection extraction. Payload invariance is also required because a covariant witness allowed a narrow handler to consume a broader payload through the program row's contravariance.

Mechanical workspace migrations update model, filesystem, and command requirement annotations. Generic AI usage and memory-filesystem collectors use declaration.handler for callback typing. No downstream behavior changes are intended.

Validation results are recorded after the final workspace check below.

## Served runtime contracts

A final compile probe exposed a second dispatch boundary. `runPromise(effect<void, string>()("clock")(undefined))` compiled because the runner checked keys alone. Its negative test reported TS2578. The coordinator accepted a ServedRow constraint on runPromise after a signature-only prototype rejected that call while accepting matching checked clock and async declarations. Raw number and AsyncOp rows remain trusted for the dependent built-ins.

Async.fork, race, and all now remove only compatible served requirements, using ServedKeys<S>. Otherwise they would erase the evidence before the strengthened runPromise could inspect it. Emit.toAsyncIterable checks the same served contracts. Compiler regressions cover those paths. runFiber intentionally remains a low-level trusted boundary accepting erased rows; RuntimeResume is not exported by the package.

Final validation: CI=true pnpm check passed formatting, lint, all five package typechecks, and 254 tests. The core has 197 tests, AI 22, registry 21, and platform 14. This branch does not include other cleanup workers' changes. The deslop pass retained the existing internal casts and added no any casts to bypass the checked contracts.
