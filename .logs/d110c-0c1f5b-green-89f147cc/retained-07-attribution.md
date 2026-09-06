# Retained gate 07: extracted-function dependency mismatch

Exact runtime: 19 assertions, 18 passed, one failed, no skips, status 1. File/title multisets match collection exactly; suite message is empty, no testExecError or other top-level error, and the sole nonempty failure-message record is the ReferenceError below. All 18 backend reclamation cases pass.

Failure title: `D.110c-0c1f5b0d authenticated settled-prefix reclamation RED keeps creator-trusted-v1 historical issuance within one maxEpochVertices window`.

First cause: `ReferenceError: resolveVerifiedCreatorHistoricalIssuance is not defined`, inside the function dynamically extracted by test helper `executableHistoricalIssuanceCounter` (test line 153), reached at line 342. This is not an assertion that the 8,192/8,193 boundary changed.

The test parses `packages/node/src/v3-live.ts`, selects only `countHistoricalIssuanceRow`, transpiles that one declaration and evaluates it through `Function`. Its local environment supplies only ReflectApply, SetPrototypeHas and SetPrototypeAdd. Its synthetic legacy context has count, countedSequences and maxEpochVertices, with no capability. The production helper now calls the already imported genuine `resolveVerifiedCreatorHistoricalIssuance(context.capability)` to distinguish settlement's three retained windows from the legacy one-window limit. That import exists in the real module but is absent from the extracted-function environment.

The actual private resolver in creator-transition-advance uses WeakMap.get and returns undefined for absent/foreign capability. Genuine legacy identity has no admissionEpoch, so production's `identity?.admissionEpoch === undefined ? 1 : 3` still selects exactly one maxEpochVertices window. Settlement's genuine capability selects three. The private context constructor and all five helper consumers remain bound to this actual capability; no caller-provided flag or fake authority was introduced.

Root independently verified these facts and found only this extraction helper in its bounded sweep. Root directs a separately owned, minimal tests-only actual-resolver binding correction. Do not refactor production merely to accommodate extraction, alter historical limits, mock the resolver to force a result, weaken the legacy 8,192 accepted/8,193 rejected assertion, change the 18 backend cases, or add a public API. No production/test edit or subsequent runtime occurred after this failure.

One direct read-only shell process failed to spawn; explicit /bin/zsh with login=false resumed source reads. This was tool startup, not a product/test failure. No full saved stderr is claimed for direct inspection outputs; complete runtime failure artifacts are retained independently.
