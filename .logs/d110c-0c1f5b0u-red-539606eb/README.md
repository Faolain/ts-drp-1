# D.110c-0c1f5b0u causal tests-only RED

Tests-only source: signed/pushed `539606ebe5f87f9f20e200df9025983c4a2433a1`.
This is RED evidence, not GREEN or a claim that the rejected production
candidate is accepted. No production file was edited or committed by this
author. No reviewers, subagents, campaign or long workload ran.

## Exact execution and results

The frozen four files contain 67 tests: 35 retained f5b0t controls and 32 new
f5b0u tests. Both layers used fresh detached checkouts, offline frozen install,
fresh workspace package builds, exact listing and one focused invocation.

| Layer | Checkout | Focused status | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- | --- |
| Clean prerequisite | `/tmp/d110c-f5b0u-red-GnZ3bK/checkout` | 1 | 20 | 47 | 0 |
| Exact rejected-candidate overlay | `/tmp/d110c-f5b0u-red-vaDX0i/checkout` | 1 | 39 | 28 | 0 |

All build/install/listing commands returned 0. The focused runs took 7,452 ms
and 11,178 ms, respectively. Exact argv, cwd, timestamps, statuses, stdout and
stderr are in each layer's `commands.json` and accompanying streams. Both
reporters contain the complete result set. Stderr contains only SQLite
experimental warnings; no unhandled or top-level test-loader error occurred.

The clean layer establishes only inherited absent f5b0t progress-contract and
split handling prerequisites. Genuine rooms bootstrap and issue, then stop
at the inherited `split-required` terminus. Its 83 complete failure messages
are retained without claiming f5b0u causality.

The overlay passes all 35 retained controls and four new positive controls:
real room-to-Node splits for 2 and 16 source intents, exact genuine signed
16-entry Node batch committed unchanged through the real ephemeral store,
and exact nested applicationBatch final-child time derivation. These passing
controls do not purport to be new defects.

The remaining 28 tests have 56 complete soft-failure messages, all classified
in `validation.json` against explicit tokens and exact soft-failure counts:

- Case 1: ordinary `entries`/`batch.entries` fields corrupt the time floor;
  invalid child times and oversize carriers commit rather than returning
  `ISSUANCE_COMMIT_INVALID`, with the resulting durable mutation visible.
- Case 2: all three adapters permit nonempty legacy progress origination by
  CAS rather than `ISSUANCE_RETRY_REQUIRED`, changing readback. Browser here
  is the deterministic fake-IndexedDB adapter test, not real Chromium proof.
- Case 3: stale rederived progress signs a missing fence and mutates lineage
  and plan before refusal.
- Case 4: absent legacy links and seven inexact progress-readback variants
  are accepted rather than rejected.
- Case 5: each real signed no-link/partial/final fault fires, but publication
  cannot resume; activation stays at one and the old owner remains active.
  The compatible pre-sign race likewise reuses one activation.
- Case 6: genuine split, batch grammar and durable-time controls pass.
- Case 8: queued public issue/migration reject from missing startup recovery,
  not a timeout; the rebind tests fail before fresh rebind or its required
  `D110C_B_CLOSE_REBIND_FAILED` code. Cleanup's terminal controls pass, but
  its preceding signed-recovery assertion fails. Successful settlement close
  or adoption is not claimed and remains parent f5b scope.

Case 7 remains explicitly assigned to parent f5b's genuine authenticated
checkpoint-to-runtime handoff; no private fixture authority was added.

## Mechanical validation and custody

`node .logs/d110c-0c1f5b0u-red-539606eb/validate.mjs` returned 0 with
`CAUSAL_RED_NOT_GREEN`. It validates exact file/title counts, unchanged
selection, result counts, each overlay failure token and full soft-failure
count, controls, command statuses, streams, hashes, and signed/pushed test
identity. Its first read-only draft mistakenly compared Vitest's space-joined
reporter fullName with the listing's ` > ` separators. The corrected check
compares exact file/ancestor/title tuples and all 67 lines. That diagnostic
mistake caused no test rerun and is not a source failure.

Exact-owner static commands passed before the final tests-only correction
commit: `pnpm exec prettier --check` and `pnpm exec eslint` on
`tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts`,
`tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`, and
`tests/phase-6b-d110c-0c1f5b0u-store-red.test.ts`; `git diff --check` also
returned 0. Earlier tests-only drafts' five-file static checks passed. No
claim is made that RED typechecks against future progress types; fresh package
builds and exact runtime listing pass in both layers.

Each main-before/main-after pair proves the seven rejected-GREEN production
file hashes, combined binary-patch hash and all 27 stash identities unchanged.
The overlay also verifies those seven hashes and the patch before and after
execution, with exactly those seven changed paths in its temporary checkout.
The combined hash remains
`1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9`.
Temporary checkouts remain retained; the diagnostic overlay was never applied
to or removed from the main worktree and was never committed. No protected
untracked path or existing stash was changed.

## Prior invalid attempts and remaining work

The independently manifested roots `d110c-0c1f5b0u-red-a9ba60ab`,
`d110c-0c1f5b0u-red-bb2453d5`, `d110c-0c1f5b0u-red-963f67ab`, and
`d110c-0c1f5b0u-red-64b91c7a` remain byte-for-byte preserved with honest
invalid-attempt dispositions. `prior-attempt-disposition.md` adds the later
attribution of the legacy scalar-only fixture without rewriting prior roots.
Tests-only history is `a9ba60ab` → `bb2453d5` → `963f67ab` → `64b91c7a`
→ `539606eb`, each signed and pushed before its execution.

Combined f5b0t/f5b0u GREEN, real Chromium, all specified static/retained/clean
GREEN gates and formal final review remain due. Parent f5b's frontier handoff,
checkpoint producer and genuine 64-writer repeated-close acceptance remain
blocked. This evidence does not close the slice or authorize those workloads.
