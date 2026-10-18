Review the signed/pushed D.110c-0c1b P1 correction at commit
9172e4adf60108b4c195c20ce61a7c67d2d8266d relative to its accepted GREEN
parent 7e3be150bdfd75683aa4473c947758f79c1b1fce.

This is the single permitted confirmation after the initial final review.
Review only whether the two accepted P1 findings are closed without a new P0
or P1:

1. `packages/node/src/v3-live.ts::issueOneVertex()` now treats the locally set
   `capacityRejected` branch as definitely pre-durable, releases an optional
   operation-policy reservation, and does not halt close. Verify every setter
   and path: this must not release a reservation after a possibly committed
   issuance outcome, weaken exact `ISSUANCE_OUTCOME_UNKNOWN` handling, or
   weaken any post-commit `committedFailure()` halt.
2. The tests-only capacity proof must reach the real valid canonical issuance
   candidate and the real `hasGraphCapacity` rejection, observe release without
   commit, then complete a genuine creator close. It must not manufacture
   production state, vary the fixed supported parameter profile, or add a
   product API.
3. The expanded retained command must close the frozen roster omission. Inspect
   `.logs/d110c-0c1b-green-correction-7e3be150/retained.json` and confirm 174/174
   with the five previously omitted owners plus the original nine paths.
4. Verify the original causal RED and GREEN behavior remain intact: committed
   or outcome-unknown issuance halts close until authenticated recovery; the
   pre-durable capacity refusal does not.
5. Verify scope: no wire/schema, dependency, public API, authority, threshold,
   supported parameter, workload, campaign, or D.110a change.

Relevant evidence:

- Initial final review:
  `.logs/d110c-0c1b-final-review-7e3be150/`
- Accepted correction:
  `.logs/d110c-0c1b-green-correction-7e3be150/`
- Plan owner:
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`, section
  `D.110c-0c1b committed-issuance outcome reconciliation prerequisite`

Only P0/P1 findings block. P2 findings may be recorded but must not recursively
expand this confirmation. Return only one JSON object matching the supplied
schema. Set `verdict` to `CHANGES_REQUIRED` iff at least one P0/P1 exists.
