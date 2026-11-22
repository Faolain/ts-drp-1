# D.110c-0c1f5a final plan -> RED -> GREEN implementation review

Act as a read-only senior security/correctness reviewer. Review the complete
D.110c-0c1f5a history and return only the JSON object required by
`.logs/d110c-0c1f5a-final-review-3c305872/schema.json`. Do not edit files, run
tests, use the network, spawn subagents, or review unrelated work. Only P0/P1
findings block closure; still report concrete P2 debt.

## Signed chronology

- amended plan/diagnostic: `052eaa2151e57633485565ea5135f725e723183c`
- accepted plan confirmation: `466169aaf7c74b0c08b14e8c5f00b20f8710bfb8`
- causal tests-only RED: `e379cfd2854cbcb9db117960388e311251c9f086`
- production/tests GREEN: `52fe3b44a40ab025102cad7637bbd10fae6edaac`
- clean-isolated evidence/current review anchor:
  `3c305872fbee759b1b6386c10a1d1ebbde3dd6e6`

All are signed/pushed. Verify the current source and the precomputed bounded
history diff at `.logs/d110c-0c1f5a-final-review-3c305872/history.diff`.

## Exact review scope

Read:

- the D.110c-0c1f5/f5a/f5b plan sections in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- `packages/node/src/creator-close.ts`, especially
  `authorIssuanceFrontiersCandidate()`;
- `tests/fixtures/phase-6a-v3/creator-adoption-contract.ts`, especially
  `routeRegisteredVertex()`;
- `tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts` only for the
  exposed real close/adoption seam;
- `tests/fixtures/phase-6b-d110c-0c1f5/foreign-author-close-liveness-contract.ts`;
- `tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts`;
- causal RED evidence `.logs/d110c-0c1f5a-red-466169aa/`;
- GREEN evidence `.logs/d110c-0c1f5a-green-e379cfd2/`, especially
  `commands.md`, `validate.mjs`, `validation.txt`, and `SHA256SUMS`;
- isolated proof `.logs/d110c-0c1f5a-clean-52fe3b44-v2/` plus the honestly
  classified setup-only sibling root.

## Frozen decision and required judgment

RED proved on real signed/admitted vertices that a foreign null-prior,
regressed, or duplicate author slot aborts the creator's otherwise-valid close.
GREEN is intentionally narrow: a foreign anomaly freezes only that successor
author at the authenticated prior boundary or null; a removed successor writer
is omitted. The anomalous valid application vertex remains in the close
set/history, but the frontier never advances through it. Creator duplicate and
regression errors remain exact and fail closed. The ordinary adjacent-prefix
algorithm is unchanged. Absent-prior author re-entry and authenticated
historical settlement remain fail closed and explicitly belong to f5b.

Determine whether this implementation actually closes RED without creating an
authority, replay, substitution, or liveness bypass. In particular inspect:

1. duplicate collection and per-author iteration order, including creator plus
   foreign anomalies and removed-writer behavior;
2. null/numeric prior semantics and assurance that no observed maximum or gap
   crossing was introduced;
3. creator corruption precedence and exact error preservation;
4. aggregate canonicality, signing, opening, transition/adoption, no-gap
   behavior, and the unchanged protocol-v3 carrier/API boundary;
5. whether the real tests prove the exact close-set count, frozen frontier,
   verified adoption, post-adoption issue/publish, creator controls, removal,
   and current-unauthorized fail-closed control;
6. whether any promised adversarial matrix item is materially absent or merely
   redundant with the algorithm/source-shape and retained coverage; treat a
   missing test as P1 only when it leaves a plausible correctness/security
   regression untested, not merely because plan prose listed it;
7. the shared fixture fix: the synthetic gossip classifier must remain active
   until queued authentication/admission completes, restore on every exit, and
   not poison later direct-retained routing;
8. honest evidence classification: the sole focused assertion passed but its
   outer command hit a global one-file coverage threshold; the final retained
   RED-named control passed, the final 195/195 and Chromium 2/2 passed, and the
   signed isolated replay passed. Failed intermediate diagnostics must not be
   represented as passes;
9. scope: no product API, wire/schema/preimage, dependency, threshold, workload,
   recovery-consumer, or f5b settlement change is permitted.

Do not require f5a to solve f5b's authenticated settlement/rebase gap. Do not
reinterpret prior immutable evidence. If you find a blocker, cite exact
file/line or evidence and state the smallest required correction. Set
`f5a_closable` true only if the P0/P1 union is empty and the signed GREEN can be
accepted as this narrow close-liveness checkpoint.
