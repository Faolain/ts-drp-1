# Parent f5b case-25 durable-row corrective RED

`ACCEPTED_CAUSAL_DURABLE_ROW_RED`. Tests-only commit
`689c69487d28cfdeae62a32ae4b56db36b037c60` is signed and pushed, based on root's
signed/pushed disposition `ac7fb4f1e9d3088fe5abdd0a692f0785651f0a41`.

## Correction and independent coverage

The stopped GREEN evidence at `.logs/d110c-0c1f5b-green-f031b166/` identified a
test/contract contradiction, not a missing product feature: `planEffect` is an
atomic transaction instruction applied to `settlementPlans`, not an issued-row
field. Accepted design lines 273–282 and browser store `commitFromIssued`,
`nativeIssued`, and the strict transaction at lines 905–947 establish this
existing separation. Persisting transaction-command history to satisfy the
former assertion would improperly widen durable schema/read behavior.

Only the row-assertion block inside case 25's `ambiguousPlanIssue` changed:

- Compare the exact durable four-field projection (`authorSequence`,
  `envelope`, `issuedRecord`, `outboxEntry`), or exact null for an uncommitted
  attempt.
- Independently compare the exact transaction instruction and entire durable
  plan against the existing structured-cloned pre-transaction observation.
  Uncommitted attempts preserve the whole plan. Committed fence attempts change
  only the fence link and revision. Committed replacement attempts change only
  the selected link, exact one-chunk progress and revision, retaining all other
  scope, source digest, disposition, entries and progress fields.
- Pin the one-intent source's exact transformed application operation, empty
  initial progress, intent identity/range and committed chunk logical time
  derived from the signed envelope.

Every existing assertion before and after this block remains byte-identical,
including exact lineage advancement, old-owner deactivation, authenticated
fresh-owner issuance/publication, failed-recovery immutability, durable-link
recovery, slot reuse, one surviving publication and network delivery, bounded
signed retries and once-only disposition/application effects. No observer,
production helper, public API, fixture or other expectation changed.

## One clean isolated execution

Isolation reused the accepted f5b0w/f5b0v sparse-checkout, offline-install,
complete-package-build and command-recorder pattern. The checkout at
`/private/tmp/d110c-f5b-row-red-hWOKRB/checkout` is detached at the signed tests
commit. Packages/examples/tests/scripts/configs/patches and root files came
only from that commit. An independent frozen offline install and complete
`pnpm build:packages` preceded collection and runtime. No dirty production
overlay, copied dist output, shared installed dependencies or main-checkout
test execution was used. Before/after custody pins exact committed source and
fresh isolated runtime paths/hashes, with a clean isolated tracked worktree.

The sole focused command and timestamp are in `execution-start.json`; the full
reporter is `focused.json`, and complete selected outcomes/failures are in
`result.json`. The frozen matrix hash is
`28873f33a3a11e6c565e24b53eeca0ea4bf869f7ebd44f4ec6aca0e078d475ce`.
Its entries exactly equal the previously accepted workload RED matrix.

Result: **26 active / 23 failed / 3 passed / 17 filtered**, zero violations:

- Nineteen `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED` failures.
- One exact `canonical value exceeds item limit` failure owned by
  `migrationInviteAuthority` in the genuine 64-writer case.
- Three expected P2 failures:
  `F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED`,
  `F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED`, and
  `F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED`.
- Three controls pass: the complete genuine v1 continuation, legacy reentry
  guard custody and closed-session issue precedence.

No loader/import/export, malformed blueprint/invite, application-state ceiling,
top-level, timeout, count/token or changed-control anomaly occurred. No rerun
or post-run test modification occurred. The corrected downstream case-25
assertions are intentionally still behind the accepted successor-codec RED
boundary; this is not a GREEN proof of those assertions or the wider lifecycle.

## Static gates and custody

Main changed-file lint/format and isolated three-file lint/format pass, as do
selected/complete collection, complete isolated package build and the exact
tests-only diff check. Source-mapped typechecking has zero target diagnostics;
the same three inherited external `live-snapshot.ts` diagnostics remain
(TS2741 line 85, TS7006 line 277, TS2322 line 284). No full-repository typecheck
pass is claimed.

`read-only-diagnostic.json` honestly preserves an evidence-recorder invocation
with the wrong working directory; only that invocation was corrected, before
the focused run. It is not a loader failure in the test run and consumed no
test execution. Root's independent plan formatter diagnostic is root-owned
and not represented as this agent's execution.

The seven main-checkout production paths remain byte-identical to the immutable
stopped GREEN patch, verified before commit, before run and after run. All 27
stashes remain identical. Protected untracked paths, prior immutable evidence,
production source, schema/wire, APIs, dependencies, cryptography, limits,
timeouts and f5b0y are untouched. Only the test path and this fresh evidence
root are committed by this agent; root owns plan/frontier acceptance. No
reviewer, subagent, Fable, campaign or additional runtime was invoked.

The scoped durable-row contradiction is corrected. Root separately owns the
prospective physical-generation, retained old-codec and exact-view/fold
ordering dispositions discovered during the stopped GREEN audit. None is
silently repaired, reclassified or claimed closed by this RED.
