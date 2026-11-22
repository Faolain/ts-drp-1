Perform the one permitted material confirmation of the corrected
D.110c-0c1f5a foreign-author close-liveness plan and tests-only RED design at
signed/pushed commit `052eaa2151e57633485565ea5135f725e723183c`, tree
`7887ad49fd1ce18a2cc04026dfa88dab07533f06`, relative to signed parent
`eeaaaca8d7a30a84fda321b37544d57b6cc1c1f4`. Work read-only. Do not edit,
run tests or workloads, invoke other reviewers, or spawn subagents. Return only
one JSON object matching the supplied schema.

The first authorized focused execution is immutable diagnostic evidence, not
accepted RED. It selected exactly one file/title and exited 1. The null-prior
treatment reached exact
`D110C_0C1F1_LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED`; the next attempted
absent-prior treatment instead failed earlier at
`creator snapshot export failed: not-active`. The plan now records the source
ordering: creator close stages/folds the snapshot under the current latched ACL
before `authorIssuanceFrontiersCandidate()`. A staged successor grant cannot
authorize that author's current-epoch application row. Therefore the plan
removes that noncausal treatment from f5a, keeps the authorization refusal, and
assigns genuine prior-aggregate absence/re-entry reachability to f5b.

Inspect:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially
  D.110c-0c1f5a and f5b;
- exact diff `eeaaaca8d7a30a84fda321b37544d57b6cc1c1f4..052eaa2151e57633485565ea5135f725e723183c`;
- `.logs/d110c-0c1f5a-red-eeaaaca8/diagnosis.md`, `status.txt`,
  `stderr.txt`, `manifest.sha256`, and the failing assertion in `result.json`;
- `tests/fixtures/phase-6b-d110c-0c1f5/foreign-author-close-liveness-contract.ts`;
- `tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts`;
- the tests-only helper changes in
  `tests/fixtures/phase-6a-v3/creator-adoption-contract.ts` and
  `tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts`;
- `packages/node/src/creator-close.ts`, especially close ordering and
  `authorIssuanceFrontiersCandidate()`; and
- `packages/node/src/v3-live.ts` plus
  `packages/compaction/src/blueprint-fold.ts` for ingress, current ACL,
  snapshot fold, and captured graph behavior.

The corrected RED draft is statically lint/format/diff clean and lists exactly
one file/title. It has not been executed. Its causal treatments are:

1. a current authorized writer with prior null and first observed signed
   current-anchor sequence 2 reaches the legacy-migration frontier error;
2. a current authorized writer with prior numeric 0 and a signed current-anchor
   sequence 0 reaches boundary-regressed;
3. a current authorized writer with prior 0 and two distinct signed/admitted
   sequence-1 vertices reaches author-slot-ambiguous;
4. the same duplicate shape remains current-epoch authorized, while a creator
   ACL operation removes that writer only from the successor writer set; the
   current pre-filter duplicate scan reaches author-slot-ambiguous; and
5. a contiguous two-writer control closes with both exact boundaries at 1.

It also pins two creator-owned regression/duplicate errors, proves one valid
current-writer removal omits the removed author without blocking close, and
proves an already-currently-unauthorized foreign application row still fails at
snapshot export. Test-only helpers create real signed vertices, route them
through `routeV3Ingress`, wait for the real admission sink, and expose the real
aggregate from the repeat-close durable head. No product source is changed.

GREEN remains limited to close-side issuance-frontier classification. A valid,
currently authorized anomalous application vertex remains in authenticated
close-set/history; only its issuance frontier must not advance across the bad
range. Current-epoch application authorization, snapshot state, wire/schema,
carrier parsing, signatures, public APIs, dependencies, thresholds, and rebase
settlement do not change.

Decide only whether this corrected RED may execute once and whether its later
GREEN can remain within that narrow owner. Check especially:

1. Every treatment reaches snapshot success and the intended current frontier
   error rather than an earlier ingress, dependency, ACL, fold, or fixture
   failure.
2. The current-writer removal case correctly distinguishes current ACL from
   successor ACL and exercises pre-filter duplicate handling.
3. Creator-owned controls and current-unauthorized refusal preserve fail-closed
   behavior.
4. The helper refactor preserves the existing established-peer path and does
   not create a product API or synthetic aggregate.
5. The close-set/history versus issuance-frontier distinction is safe and
   accurately stated.
6. The unreachable absent-prior construction is honestly removed rather than
   silently weakened, and f5b is the correct owner for its architecture audit.
7. The corrected test can terminate only at exact
   `D110C_0C1F5_FOREIGN_AUTHOR_CLOSE_LIVENESS_REQUIRED` after all intended
   current errors and controls have completed.

Only P0/P1 findings block the corrected RED. P2 findings need a concrete owner
and disposition but cannot trigger another confirmation. Set `verdict` to
`CHANGES_REQUIRED` iff a P0/P1 exists. Set `corrected_red_authorized` true only
if the corrected one-file/one-title execution is justified as written.
