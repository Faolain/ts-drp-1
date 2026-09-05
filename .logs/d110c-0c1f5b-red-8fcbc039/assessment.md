# REJECTED realm-corrective RED: pre-existing fixture page-limit violation

Tests-only commit `8fcbc0394d398120baaf2131ef5eebbe99ba74d8` is signed
(`G`) and pushed from signed/pushed base
`bc6ec1b12ce13baa408e0e4d7343f7730f7bcfed`. Only
`tests/phase-6b-d110c-0c1f5b-integration-red.test.ts` changed: 55 insertions,
21 deletions. No production, plan, public API, wire, schema, cryptographic,
dependency, workload or threshold edit was made. All 27 stashes remain.

The exact focused file ran **once**. Actual matrix: **2 failed, 0 passed**,
two selected tests in one file, zero skipped/todo tests, no top-level or import
failure. This is rejected evidence, not authority to start GREEN. The complete
unmodified reporter (including coverage), stdout and empty stderr are retained.
The reporter's two suite count includes describe accounting; `testResults`
contains exactly one file. Each assertion has exactly one failure and empty
metadata; no additional soft failure is hidden by the summary.

## What the run establishes

1. The genuine settlement close retains the exact intended failure:
   `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED: genuine settlement
   successor fails CERTIFIED_VALUE_MISMATCH before checkpoint production`.
   Duration: 387.873083 ms. All five profile source-attribution assertions
   completed. No authenticated checkpoint-derived continuation was entered.
2. The v1 control passes its original issue/close/adopt/creator-cold-reopen/
   issue sequence. The two-peer control then passes creator adoption,
   independent noncreator cold reopen, real epoch-1 writer issue/publication,
   and writer close. It no longer fails on active-owner realm collision.
   Distinct queried-module function identities were asserted by the real
   activation dispatcher; opaque material and all runtime bindings passed
   unchanged into the production functions.
3. The newly reached durable observation fails at test line 774:
   `DurableIssuanceTypeError: page limit is outside the closed range`.
   V1 assertion duration: 1078.25225 ms. The test helper calls
   `readOutboxPage({scope, limit:256})`; the existing product constant in
   `packages/issuance-store/src/types.ts:18` is
   `MAXIMUM_DURABLE_ISSUANCE_PAGE_LIMIT = 128`. The browser parser at
   `packages/storage-browser/src/internal/browser-issuance-store.ts:1208-1210`
   correctly refuses 256. This is another fixture-contract defect, not a
   product defect, authority change, or reason to raise a page ceiling.
4. The stale-local-head/newer-floor probe remains unexecuted: its preparatory
   durable snapshot failed first. `D110C_FLOOR_MISMATCH` is not runtime-proven
   by this invocation. The 64-writer and all settlement continuations remain
   executable source obligations, not observed passes.

## Bounded topology audit and correction

The only production module with the demonstrated topic singleton is
`creator-adoption-activate.ts`. The dist-facing test observer now dispatches
both exported activation functions to one cached query-isolated import of
that **unchanged source** per physical peer ID. No source is rewritten. One
peer retains one module realm across all restarts; the test never resets or
clears its `activeOwners`. Only real session close releases its ownership.
The intent, recovery and live-handle dependencies stay unqueried so their
genuine opaque WeakMap capabilities and registered kernels keep exact identity.
The queried function is passed the original input object; the fixture does not
substitute any handle, capability, checkpoint, room-head floor or activation
result. Real distinct-bindings collision behavior inside each selected module
is untouched. This is module-level fixture isolation, not a claim of separate
OS processes, independent browser globals, or a cross-window Web Lock test.

Every `createV3RoomSession` call in this fixture is inside `openRoom` or its
`reopen` helper. Room source imports the same dist-facing activation entry
at its cold-open and adoption sites; internal ambiguous-outcome recovery uses
the same room-owned creation path. Thus the dispatcher covers initial creator
adoption, subsequent creator restart, all noncreator reopen paths, delayed
fence/replacement/crash paths, stale-local-head recovery, ambiguity, positive
pruning, and same-key reentry without individual capability adapters.

The 64-writer source remains unchanged: all 64 genuine ACL-authorized peers
issue real operations in each epoch 0-3, eight-peer rotating cohorts stop after
contributing and stay offline across close/adopt and selected creator restart,
then rejoin before next-epoch contribution. Reopen of the 63 independent
noncreator clients remains `Promise.all`; no shared creator handle, serialized
single-client substitute, admission shortcut or weakened accounting was added.

The fresh same-key device previously inherited a closure that generated the
old device's transport ID. Transport construction is now a reusable test
factory and that fresh installation selects its own database/transport/module
identity. Its issuance/plan state is still not copied from the old device.
The v1 floor probe also explicitly stops the current creator before its
stale-copy attempt, without touching the committed floor. Neither later path
was runtime-completed in this rejected invocation.

## Next narrowly justified correction, not implemented here

Fix the observer's paging to use the public maximum (128) and the existing
`afterKey` cursor until exhaustion, preserving a complete durable census.
Do not merely lower the requested limit and truncate the result, raise the
production ceiling, or change the golden-path workload. Audit other helper
input contracts before another authorized focused run. This new fixture
failure triggered the explicit stop rule: no further test edit or run occurred.

The prior rejected evidence and accepted design manifests were verified before
editing and remain immutable. The design's API/authority stop rules are not
triggered by these two fixture mistakes. The outstanding RED review union and
all downstream production/golden-path obligations remain open.
