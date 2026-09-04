# D.110c-0c1f5b0d corrective tests-only RED

This packet records the corrective backend RED at signed and pushed commit
`0cafd35762a8a1c3c5767c89227f9f42c5e89729`, based on the signed and pushed
ownership-reslice anchor `adab0f56428bf0290a4437c83083db18e17eb2dc`.

The focused Vitest run selected exactly twelve tests: nine controls passed and
the memory, browser and Node future-epoch ceiling cases failed. All three
authenticated backends accepted a prefix containing an epoch-8 row under
`closedEpoch = 7`; the operation returned success, removed all rows and moved
the watermark to 2 instead of returning `ISSUANCE_INVALID_ARGUMENT` before
mutation. The focused real-Chromium IndexedDB test reproduced the same result:
`futureCode` was absent, `futureRowsPresent` was false and `futureWatermark`
was 2.

The passing controls establish exact-store capability identity; complete-plan
gating; refusal for absent, null-fence, manual-review and unlinked-anywhere
plans before mutation; mixed-old-epoch pending/published deletion; monotone
idempotent replay; Node transaction rollback after an injected partial delete;
and permanent-corruption classification.

This RED intentionally makes no production-reachability claim. The accepted
reslice assigns the first genuine every-peer invocation, legacy-first exclusion
and profile-specific recovery-scan behavior to parent f5b, where a real
settlement close/adopt path exists. No source-text assertion or manufactured
receipt substitutes for that later behavioral proof.

