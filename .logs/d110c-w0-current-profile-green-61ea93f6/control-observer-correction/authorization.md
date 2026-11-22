# W0 settlement control-observer correction

Root readback, 2026-09-06. The first GREEN focused invocation under
`.logs/d110c-w0-current-profile-green-61ea93f6/focused/` completed with seven
cases: six passed and the settlement companion failed with registered-vertex
admission timeout. The legacy saturation case passed. No retained, browser,
isolated or campaign runtime is attributed to this invocation.

The frozen roster SHA was
`730b0fb9ba0f0cc3dedc429f67d069bd26f0d63473bfb1c1926a44a9f65e9f9b`.
Root verified all 934 source inputs and Node/Vitest identities before release.
Keep the full original source patch, roster, command, stdout/stderr, reporter,
status and failure validation immutable. This failure is real fixture evidence,
not a passing run or a demonstrated production refusal.

## Source-grounded diagnosis

The shared helper's `routeRegisteredVertex` waits solely for application
`onAdmittedVertex`. The existing Node ingress owner accepts and journals control
vertices, updates the close set and author counts, then returns before invoking
that application sink. Root independently inspected `handleV3Ingress` in
`packages/node/src/v3-live.ts` and the waiter in
`tests/fixtures/phase-6a-v3/creator-adoption-contract.ts`.

Thus a settlement fence must not be awaited through the application-delivery
helper. The previous companion's true application-delivery expectation was
incorrect: an admitted control fence contributes durable/share work and zero
application work. This agrees with existing Node control/application separation;
no production change or profile weakening is needed. Source diagnosis does not
claim the failed invocation measured its unavailable final journal observation.

Supplementary read-only evidence in GREEN's `diagnose-fence-rows.json` confirms
the received fence exists at journal sequence two after bootstrap and initial
local issue. Its exact preimage hashes to the timeout digest
`5e4ef45713ef2ec7969ffa30fa377b569193b6e78466a5e20f63c61a0c1f868d`;
the decoded offender author sequence and fence sequence are both zero. The
database hash remained unchanged during inspection. This establishes that
specific durable admission, not completion of saturation, application delivery
or successful close. Root read the complete detached row evidence.

## Authorized bounded correction

Keep the same three GREEN owners and shared selector seam. In the W0 helper,
record the settlement fence's original signed input, submit it through the
existing unchecked ingress, require that ingress claims it, and use the first
ordinary sequence-one add depending on that fence as the causal admission
barrier. No added writer, operation, dependency, threshold or timer is allowed.
The ordinary add already belongs to the frozen workload.

Both profiles require no fence application delivery. Settlement still requires
the offender's own sequence-zero fence in genuine durable rows, exact original
preimage/digest/signature and authenticated byte charges, all sequences through
1,491, the next add refused, another writer progressing and a genuine close.
The frozen row/application totals remain 1,496/1,496 for settlement and
1,514/1,652 for legacy. Do not repin them to observed results.

After static/equivalence/custody checks, freeze changed source identities and a
new non-overwriting invocation identity. Run the entire seven-case focused
file once on the corrected bytes, then retained only if its complete result
passes and quiesces. This is a changed-fixture corrective execution, not a retry
of the original consumed source/invocation. Formal review must inspect both
the original failure and correction. Browser and fresh-source acceptance remain
root-owned; no long-run or parent release follows from this correction.
