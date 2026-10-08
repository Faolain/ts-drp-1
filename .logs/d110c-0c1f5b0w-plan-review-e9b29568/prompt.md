# D.110c-0c1f5b0w high-risk plan review

Review signed/pushed commit `e9b2956852a916cdf60c4de29dbe913532c284a3`
on branch `codex/phase3a1b-p6-golden-path`. This is a plan review only. Do not
edit files or run tests.

Read:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially
  “Current frontier — author settlement and writer capacity”,
  `D.110c-0c1f5b0w`, and the current `D.110c-0c1f5b` status;
- `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` cases 11, 21 and the
  crash/failure matrix, treating it as immutable and the plan amendment as
  prospective;
- `.logs/d110c-0c1f5b-red-review-b7751f72/` and
  `.logs/d110c-0c1f5b-manual-review-api-fable-high-b7751f72/`;
- `examples/v3-room/src/index.ts` at `settlementDisposition`,
  `writeMergedSettlementPlan`, `drainSettlementOutbox`, `rebasePromise`,
  public `issue()`, `sealEpoch()` and shutdown;
- `packages/issuance-store/src/contract.ts` at
  `assertSettlementPlanProgressTransition()` and settlement effects;
- the existing f5b0c/f5b0s/f5b0u tests relevant to manual review, migration,
  plan CAS and recovery.

Judge whether this is the smallest sound prerequisite for the Discord/MMORPG
golden paths and whether its RED can be reached before parent f5b production
GREEN without a circular dependency. Check specifically:

1. The plan adds no new public API, authority, wire/schema/crypto/dependency or
   threshold contract and does not smuggle a resolver into parent f5b.
2. Prompt fail-closed `issue()` behavior and creator-close continuity are
   mutually coherent, preserve the authenticated boundary, and cannot mistake
   a hold for successful settlement.
3. The store transition law is both necessary and correctly bounded; flag any
   unauthorized behavior or unsafe transition.
4. RED has deterministic real-product reachability without timeout, private
   plan mutation, missing import/export, or dependence on the still-missing
   parent settlement successor codec. If not, name the smallest sequencing or
   fixture correction—do not propose weakening TDD.
5. Removal/re-admission, restart/cold reopen, migration, prune custody and
   creator-owned holds have exact fail-closed acceptance.
6. The future D.110c-0c1f5b0x API is honestly deferred and not required for
   the present long-lived room proof.

Return only one JSON object matching `schema.json`. P0/P1 findings block.
P2 findings must be specific and dispositionable. Do not review unrelated
historical plan prose and do not recommend campaigns or long workloads.
