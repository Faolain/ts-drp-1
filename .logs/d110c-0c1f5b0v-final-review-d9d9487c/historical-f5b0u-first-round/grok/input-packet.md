# D.110c-0c1f5b0t/f5b0u final plan → RED → GREEN review

Act as an independent, read-only implementation reviewer. Review the complete
combined f5b0t/f5b0u plan, causal REDs, production GREEN, and immutable evidence.
Do not edit files, run tests, invoke subagents, or propose unrelated redesigns.

## Custody and review packet

- Authoritative branch: `codex/phase3a1b-p6-golden-path`.
- Accepted plan begins at signed commit
  `fefa6805e16066f55d15bb95701b3ced290553b3` and its bounded corrections through
  `9d1278d8a4bec1d7083ecd0037501c5e0ce85c08`.
- Final production GREEN:
  `ea02487e9c80d25ab6e7038cdf35330b72f29de6` (`G`, pushed).
- Final GREEN evidence:
  `60548549219378b30548c3c638da178561c17875` (`G`, pushed).
- The supplied staged diff is the exact non-evidence plan/test/production delta
  from the parent of `fefa6805` through the final GREEN. Inspect it in full.
- Authoritative plan section:
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`, record
  `D.110c-0c1f5b0u settlement restart/reconciliation prerequisite`, plus the
  `Current frontier — author settlement and writer capacity` subsection.
- The current frontier prospectively replaces the stale reviewer names inside
  the older record. This review is one of the final Grok/Sol/Fable reviewers;
  do not file a finding merely because the historical record says Kimi/Opus.

Read and validate these evidence roots and their self-excluding manifests:

- `.logs/d110c-0c1f5b0u-red-539606eb/`
- `.logs/d110c-0c1f5b0u-migration-frontier-red-0c9e5632/`
- `.logs/d110c-0c1f5b0u-successor-replay-red-fad19ef7/`
- `.logs/d110c-0c1f5b0u-browser-progress-red-54111eb7/`
- `.logs/d110c-0c1f5b0u-source-oracle-correction-6394f551/`
- `.logs/d110c-0c1f5b0u-green-ea02487e/`

The GREEN manifest has 417 entries and SHA-256
`eb1e192991a78ea4e607f5bccc85e4d9739ff4bc23efa492a95b013906018088`.
The evidence reports local and exact-clean-checkout results: 70/70 focused;
six native Chromium progress vectors; all 40 package builds; 350 retained
assertions with 331 passes and 19 failures reproduced exactly at the untouched
parent; 231 normalized package typecheck diagnostic headers identical to the
untouched parent, while issuance-store and room typechecks pass.

## Required review questions

Determine whether the GREEN closes each causal RED without widening scope:

1. Signed/unclassified settlement issuance never reuses a halted handle.
   Exact durable readback recognizes only the attempted one-revision/one-chunk
   effect, then recovery creates one fresh authenticated owner, commits recovered
   vertices before resumed issue/publication, and leaves no second owner.
2. Startup settlement/rebase owns exactly one lifetime transition and cannot
   deadlock through nested enqueueing with migration or close/adopt. Creator-close
   is rebound to the fresh plane; the predecessor is stopped; rebind/cleanup
   failures remain terminal.
3. Genesis and successor recovery preserve authenticated room-head, snapshot,
   authority, projection-base, state-byte, and state-digest validation. Successor
   replay delivers retained authenticated rows exactly once through the existing
   sink, without exposing a new public API or trusting a self-signed/stale anchor.
4. The pre-frontier migration activation refusal remains deliberately fail closed:
   rehearsal fulfills, activation settles promptly with parent
   `v3 room migration activation failed: terminal-rejected` and underlying
   `v3 room rebase outbox failed: record-rejected`, and cleanup leaves zero owners.
   Parent f5b—not this slice—owns authenticated settlement-frontier threading and
   eventual successful activation/settlement-profile close/adoption.
5. Issuance-store parsing accepts only the exact canonical real Node
   `applicationBatch` grammar and derives the final child logical time; collisions,
   unsafe/regressed times, malformed canonical carriers, and nonempty legacy →
   progress origination fail closed. Memory/browser/Node stores agree on exact
   revision, prefix, range, digest, sequence, partial/final and corruption rules.
6. The direct `@ts-drp/issuance-store` workspace dependency is the only dependency
   change. There is no wire/protobuf/checkpoint/anchor/ACL/authority/public-API,
   cryptography, threshold, timeout, workload, or external dependency change.
7. The browser extension genuinely executes native IndexedDB structured clone and
   atomic transactions for zero, refusal, partial, final, stale and malformed
   revision vectors. The corrected source-governance oracle is AST-scoped and does
   not weaken the sensitive-return prohibition.
8. RED evidence is genuinely causal rather than import/loader/timeout failure;
   GREEN and clean-checkout evidence are complete and match manifests; inherited
   retained/typecheck failures are baseline-identical and not newly introduced.
9. Identify any correctness, security, crash-consistency, exactly-once,
   ownership/leak, deadlock, compatibility, or evidence-integrity defect that
   should block parent f5b from resuming.

Only P0/P1 findings block. P2 findings must be concrete and receive a proposed
owner/disposition; documentation wording or already-owned parent-f5b work is not
a P1 unless this GREEN silently depends on it or weakens a hard gate.

## Terminal output contract

Return exactly one JSON object and no surrounding prose:

```json
{
  "verdict": "PASS or CHANGES_REQUIRED",
  "p0_count": 0,
  "p1_count": 0,
  "p2_count": 0,
  "findings": [
    {
      "severity": "P0 or P1 or P2",
      "title": "short title",
      "evidence": "specific file:line, diff hunk, or evidence path",
      "impact": "concrete failure mode",
      "required_action": "smallest correction or P2 disposition"
    }
  ],
  "red_green_causality": "brief assessment",
  "scope_assessment": "brief assessment",
  "evidence_assessment": "brief assessment",
  "parent_f5b_ready": true
}
```

Counts must equal the findings array. `PASS` requires zero P0/P1 and
`parent_f5b_ready: true`. Do not infer PASS from missing output.

<runner_git_packet>
HEAD: acec5c3fe03c83add9cd2c992dcdae88786c48cf
Status:
M  docs/production-hardening/production-hardening-tdd-plan-v2.md
M  examples/v3-room/package.json
M  examples/v3-room/src/index.ts
M  packages/issuance-store/src/conformance.ts
M  packages/issuance-store/src/contract.ts
M  packages/issuance-store/src/types.ts
M  packages/node/src/v3-live.ts
M  packages/storage-browser/src/internal/browser-issuance-store.ts
M  packages/storage-browser/tests/assets/phase-6b-settlement-progress-entry.ts
M  packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts
M  packages/storage-node/src/internal/node-issuance-store.ts
M  pnpm-lock.yaml
M  tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts
M  tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts
M  tests/fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.ts
M  tests/phase-6a-creator-successor-product-red.test.ts
M  tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts
A  tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts
A  tests/phase-6b-d110c-0c1f5b0u-store-red.test.ts
A  tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts
?? .logs/d110c-0c1f5b0u-browser-progress-red-54111eb7/
?? .logs/d110c-0c1f5b0u-green-ea02487e/
?? .logs/d110c-0c1f5b0u-migration-frontier-red-0c9e5632/
?? .logs/d110c-0c1f5b0u-plan-confirmation-c35fae7e/
?? .logs/d110c-0c1f5b0u-plan-review-fefa6805/
?? .logs/d110c-0c1f5b0u-red-539606eb/
?? .logs/d110c-0c1f5b0u-red-64b91c7a/
?? .logs/d110c-0c1f5b0u-red-963f67ab/
?? .logs/d110c-0c1f5b0u-red-a9ba60ab/
?? .logs/d110c-0c1f5b0u-red-bb2453d5/
?? .logs/d110c-0c1f5b0u-red-correction-686a1cf9/
?? .logs/d110c-0c1f5b0u-source-oracle-correction-6394f551/
?? .logs/d110c-0c1f5b0u-successor-replay-red-8af5561c/
?? .logs/d110c-0c1f5b0u-successor-replay-red-fad19ef7/
Staged paths:
docs/production-hardening/production-hardening-tdd-plan-v2.md
examples/v3-room/package.json
examples/v3-room/src/index.ts
packages/issuance-store/src/conformance.ts
packages/issuance-store/src/contract.ts
packages/issuance-store/src/types.ts
packages/node/src/v3-live.ts
packages/storage-browser/src/internal/browser-issuance-store.ts
packages/storage-browser/tests/assets/phase-6b-settlement-progress-entry.ts
packages/storage-browser/tests/phase-6b-settlement-progress-red.pw.ts
packages/storage-node/src/internal/node-issuance-store.ts
pnpm-lock.yaml
tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts
tests/fixtures/phase-6b-d110c-0c1f5b0b/node-settlement-contract.ts
tests/fixtures/phase-6b-d110c-0c1f5b0t/settlement-progress.ts
tests/phase-6a-creator-successor-product-red.test.ts
tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts
tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts
tests/phase-6b-d110c-0c1f5b0u-store-red.test.ts
tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts
Unstaged tracked paths:
(none)
Exact staged diff SHA-256: 8bb6e8a58d4d2951e7e115cb370a8d082b3c6322fcf0b6eb1796774f94ef4cd1
Exact staged diff file: /Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b0u-final-review-ea02487e/grok/review.diff
Use the supplied packet and read-only file tools. Do not invoke a shell or write review notes to disk. Return the requested terminal response directly.
</runner_git_packet>
