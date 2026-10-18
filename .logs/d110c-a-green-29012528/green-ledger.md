# D.110c-a authenticated repeat-close GREEN ledger

RED anchor: signed/pushed `29012528145e3f7ae2bf056ba351459b90cd8aa0`.

## Narrow implementation

- `v3-live.ts` restores the current projection's existing `compactHistory` through `CompactMerkleAccumulator`, requires canonical projection/current-trust/anchor epoch, object, root, and size agreement, and hands creator-close a copied private snapshot. Epoch 0 still requires the canonical empty accumulator.
- `creator-close.ts` passes the private snapshot to the unchanged history verifier, widens only the two existing result fields to `number`, rejects unsafe successor overflow at bind, and derives exact current/successor values from authenticated trust with `successorEpoch === epoch + 1` before generation staging.
- No wire/schema/record/dependency/public-key-roster/product-provider/threshold change occurred. The result key roster is unchanged.

## Focused and type gates

- First focused GREEN: 0/1 because the fixture made an out-of-scope epoch-2 call into the still epoch-pinned D.110c-b adoption verifier. Every preceding repeat-close/history assertion passed. This tests-only probe was removed; no product change resulted.
- Corrected focused GREEN: status 0, one result file, 1/1 passed, zero failed/pending/todo. It proves genuine 0→1 adoption/activation, real epoch-1 issue/publish, genuine 1→2 close, exact result 1/2, independently reconstructed history root/size, unchanged copied prior snapshot, successor Cut/QC/trust closure membership, positive closure-byte delta, unchanged epoch-1 caller floor, no provider/replacement activation, same-plane rebind identity, and concurrent/sequential/stale-predecessor close refusal.
- A final assertion-identical evidence capture used the gated test-parent reporter and passed 1/1. It records five→seven closure references and exact closure bytes 5,776→7,729 (delta 1,953), history size 2→3, and exact independently derived prior/current history roots in `exact-runtime-evidence.json`.
- Private exported-result TypeScript contract: status 0. Exact keys, exact `number` fields, epoch-0 compatibility, genuine 1→2, and later epoch 3 all compile.
- A plain root `tsx` evidence-only probe first failed during module loading because root Node resolution cannot resolve the monorepo bare `@ts-drp/canonical` import. It executed no fixture/workload and was not retried. The gated Vitest capture above closes the evidence-granularity gap through the supported workspace resolver.

## Retained gates

- First 16-file retained run: 127/128. Sole failure was the old Phase-6a cold-input key roster omitting the already-shipped D.110c-0b0 `expectedRoomHead` field.
- Corrected retained run: status 0, 16 result files, 128/128 passed, zero failed/pending/todo.
- Browser retained gates, sequentially across Chromium/Firefox/WebKit: creator live close 9/9; creator adoption commit/process-death reopen 6/6; successor activation 24/24; successor product lifecycle 27/27.

## Build, type, and static gates

Passed: Node build; exact Node source `tsc --noEmit -p tsconfig.build.json`; storage-browser build; root Phase-3a1b-p3 test TypeScript project; v3-room typecheck and build; independent v3-chat typecheck; exact D.110c-a type contract; exact-owner ESLint/Prettier; and `git diff --check`.

Broad `@ts-drp/node typecheck` and `@ts-drp/storage-browser typecheck` remain unsuitable aggregate gates. They report inherited test/config errors (worker-host rootDir, retained WebRTC/helper typing, missing browser test aliases, and branded fixture strings); neither reports a changed D.110c-a owner. Exact production source/build gates pass.

The final combined custody diagnostic first returned status 1 only because an `rg -c` no-match produced an empty shell value that was compared with `0`; the manifest and preceding predicates had passed. The corrected `rg | wc -l` zero-count check and the complete combined custody command pass. This diagnostic mistake is not a code or evidence failure.

The stale `d110cLastPendingRecovery()` tests-only diagnostic call is removed. Root package and lockfile hashes remain frozen. Protected roots and all 27 stashes are preserved. No D.110a or campaign invocation occurred, and no Fable or collaboration-subagent result is used as a D.110c-a gate. The user's separately authorized one-off, read-only Fable 5.1/high D.110c-0b comparative audit started only after this executable evidence was complete and cannot alter D.110c-a acceptance.
