# D.110c-0c1b committed-issuance reconciliation plan review

Act as a strict, read-only senior distributed-systems/security reviewer.
Review the bounded source audit and frozen tests-only RED / narrow GREEN plan at
signed/pushed HEAD. Do not edit files, run tests, invoke subagents, or redesign
unrelated epoch/snapshot/authority behavior. Return exactly one JSON object.

Custody:

- branch: `codex/phase3a1b-p6-golden-path`
- closed D.110c-0c1a checkpoint: `90a06a1aae79d408a1c2c6b014dae1a99daf866d`
- signed/pushed D.110c-0c1b plan: `d4ed70242c9f21cfb24e1d5c6b1c9c6216096616`
- plan tree: `b48d37e683b51441de39aeeec57c27a0c19f82f8`
- local and remote refs match
- source audit: `.logs/d110c-0c1b-source-audit-90a06a1a/`
- audit manifest SHA-256:
  `48309c9c5ea98d4bdbd0e44ab1b05ab4fab5a375d8f091548e7adc2a260361fe`

Inspect the D.110c-0c1b section of
`docs/production-hardening/production-hardening-tdd-plan-v2.md` and the exact
owners in `packages/node/src/v3-live.ts`, especially:

- `issueOneVertex()` and `committedFailure()`;
- registration task serialization;
- `recoverV3LiveReplica()` journal replay and issuance/outbox scan;
- `stageClosedBlueprintEpoch()` / `stageBlueprintEpoch()`;
- `creatorCloseRegistration()` and creator close staging;
- retained E5-01 uncertain-outcome recovery and D.110c-a/b close/adoption
  fixtures.

Demonstrated defect and selected repair:

- `issuer.issue()` has returned a durable issued/outbox commit before any
  `committedFailure()` path.
- `committedFailure()` marks recovery-required only when an optional operation
  reservation exists.
- creator close and the queued fold do not consult that state, so an earlier
  issue can durably commit, fail before graph admission, and then be omitted by
  a close.
- restart recovery already authenticates and reconciles the row exactly once.
- GREEN is limited to unconditional recovery-required marking for every
  post-commit failure, bind-time close refusal, and a queued fold-time recheck.

Review questions:

1. Is the audit correct that no new durable marker, schema, API, wire field,
   dependency, authority rule, or store operation is needed because existing
   recovery fully reconciles the row?
2. Do the three proposed internal checks cover both bind-after-failure and
   bind-before/in-flight-close orderings without admitting a false close or
   silently dropping an issued operation?
3. Is `operationAdmissionHalted` the correct existing state owner, or is there
   a concrete semantic path where reusing it causes an incorrect pass/failure?
4. Is the RED causal and feasible through the real issue/store/close/adoption
   path, with a one-use failure adapter rather than store mutation or synthetic
   epoch records?
5. Are RED and GREEN acceptance sufficient to prove exact recovery once,
   operation-policy reconstruction, 0→1→2 continuation, non-null retirement
   boundary, and no duplicate/hidden row?
6. Are any listed fault cases impossible, redundant, or missing a material
   failure ordering that would let this defect survive?
7. Does any proposed step silently broaden product behavior or conflict with
   completed D.110c-0c1a evidence?

Only P0/P1 findings block. A P1 must identify a concrete defect in causal
attribution, selected behavior, or acceptance that could let incorrect code
pass or correct code fail materially. P2 receives an owner/disposition and
does not trigger recursive plan review unless its fix changes executable scope.
Do not demand another campaign, D.110a invocation, Fable run, or unrelated
authority/storage redesign.

Return exactly:

```json
{
  "verdict": "APPROVED | CHANGES_REQUIRED",
  "summary": "concise conclusion",
  "findings": [
    {
      "severity": "P0 | P1 | P2",
      "title": "short title",
      "evidence": "specific file/symbol/line or concrete evidence",
      "impact": "what can fail",
      "required_action": "smallest justified correction or disposition"
    }
  ],
  "red_causal": true,
  "green_closes_red": false,
  "scope_preserved": true
}
```

At plan review `green_closes_red` should remain false because GREEN has not run.
`APPROVED` requires zero P0/P1; findings may be empty.
