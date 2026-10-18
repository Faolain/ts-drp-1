# Evidence and contract dispositions

## Native integration RED

The separate RED author froze a normative current-head retention test in
[recovery-retention-red.pw.ts](../../packages/storage-browser/tests/recovery-retention-red.pw.ts).
The final causal run is
[RED-04](../../.logs/grid-memory-attribution/recovery-retention-red-04/status.json):
exit 1, no timeout or remaining processes, exact source custody. It reaches
three genuine settlement-grid transitions, deletes unrelated temporary scope
and chunk through real maintenance, kills the owned browser processes, proves
they are gone, and relaunches the same persistent profile/origin. Cold recovery
then rejects specifically with `snapshot-unavailable`.

The test's state/ACL/authority/head and next-issuance assertions remain
unreached until GREEN. Only the declaration crosses the process boundary;
declaration-free discovery is explicitly not covered. This is not a shipped
default-profile or thousand-epoch acceptance result.

Frozen test SHA-256:
`1f208a0778a97e62be8f5eedabeabdc0b35b2bfebf4b174277a022a5c4d0a600`.
Exact fixture/config/server and bundle custody are in the
[native evidence](../../.logs/recovery-retention/2026-09-07T08-13-01.515Z/recovery-retention-red.pw.-54010--hard-process-cold-recovery-chromium/recovery-retention-evidence.json).
Historical attempts remain intact.

The additional [Codex test review](../../.logs/grid-memory-attribution/recovery-retention-red-codex-review-01/stdout.log)
found a P1 false-green risk: generic recovery could eventually use another
durable source while the required snapshot was deleted. The correction records
exact manifest and every declared chunk's length/digest integrity after sweep,
without carrying payload across the process boundary, and asserts that saved
observation after successful reopen. Main source inspection confirms the check
cannot be satisfied by a later reconstruction. RED-04 retains the original
causal recovery failure and records required integrity changing true to false.

## RED gates

- [Scoped lint](../../.logs/grid-memory-attribution/recovery-retention-red-lint-03/status.json): pass.
- [Prettier check](../../.logs/grid-memory-attribution/recovery-retention-red-format-03/status.json): pass. An earlier attempted Biome invocation was unavailable and is preserved, not a formatter verdict.
- [Focused strict TypeScript](../../.logs/grid-memory-attribution/recovery-retention-red-scoped-typecheck-02/status.json): pass for the new test/config and changed fixture plus imports. The probe disables project-composite packaging, not strict type checking.
- [Package typecheck](../../.logs/grid-memory-attribution/recovery-retention-red-typecheck-02/status.json): fails with the same 76 diagnostics as the prior native-browser check at final RED-04 custody; [comparison](../../.logs/bounded-storage-lifecycle/red-typecheck-comparison.json). It is not a package pass.
- [Historical native characterization regression](../../.logs/grid-memory-attribution/recovery-retention-characterization-regression-02/status.json): both tests pass at final RED-04 custody. Their required-snapshot negative assertion describes current unfixed behavior; historical reports must remain intact when that expectation is superseded by the repair.

## Ownership decision under review

Raw AHE storage can hold arbitrary bytes; the trust scan ceiling is not a
universal payload-size limit. However, creator transition verification derives
an exact closure reference set. Snapshot blobs would need an authenticated
membership/replacement amendment and mapping between protocol chunk digests
and storage blob digests. Merely caching unreferenced bytes is not retention.
The relevant exact-set owners are
[initial transition](../../packages/control-plane/src/creator-trust-advance.ts),
[checkpoint transition](../../packages/control-plane/src/creator-trust-checkpoint-advance.ts),
and [adoption commit](../../packages/node/src/creator-adoption-commit.ts).

Therefore the preferred first implementation is snapshot-owner promotion,
split into adapter ownership/budget and pre-sign consumer integration. This
decision remains subject to the requested external contract reviews. AHE
payload ownership remains a genuine alternative, not rejected on a false size
restriction.

The earliest protection boundary is before durable close signing, not only
before final adoption. Close currently persists temporary bytes, signs the
close, then stages and publishes pending state. A crash after signing can
already leave a recovery obligation.

Schema migration needs stale-client enforcement. Browser version upgrades can
close old handles through the existing versionchange handler. SQLite old
handles, however, do not recheck user_version before each operation: their
existing sweep/cancel SQL can still delete scopes after a schema bump. A
version number alone is insufficient. Freeze a database-enforced protection
or equivalent schema-isolation contract and test an already-open old client
before accepting the new Node owner.

Finite promotion capacity without authenticated release eventually stops
transitions. That is an intermediate safety limit, never the requested
long-running solution. Keep later release/backpressure integration mandatory;
do not raise limits to make endurance pass.

## Requested reviews

Grok, Kimi under the cumulative 100-step cap, and Opus xhigh all returned
CHANGES_REQUIRED. See the [source-grounded dispositions](review.md) and
[exact review evidence](../../.logs/bounded-storage-lifecycle/contract-reviews/).
Kimi's initial timeout and invocation/authentication failures remain distinct
from its eventual same-session terminal verdict. The initial contract is not
GREEN-ready: executable API, admission and migration contracts must be resliced
and frozen first.

The [versioned-owner seam](slices/01a-0-versioned-snapshot-owner.md) now freezes
the next API/policy/migration contract. Independent adapter RED authoring and
fresh source-grounded review of that materially resliced contract are complete,
with amendments and dispositions in [review.md](review.md). Initial GREEN and
implementation review are complete; review-driven corrective RED/GREEN remains.
No retention grant or long-running acceptance is implied.

## Frozen versioned-owner RED

The amended executable contract is frozen at SHA-256
`8b91dc64018b55a4b33fb01ed22d367a741c2553a3786b2ffb871a8ea3a54467`.
Its separate RED author ran the real adapter boundaries before production edits:

- [Node RED-04](../../.logs/grid-memory-attribution/snapshot-owner-node-red-04/status.json): 37 tests, 27 failures and 10 retained positives.
- [Native Chromium RED-02](../../.logs/grid-memory-attribution/snapshot-owner-browser-red-02/status.json): 35 tests, 26 failures and 9 retained positives.
- [Focused strict typecheck](../../.logs/grid-memory-attribution/snapshot-owner-typecheck-04/status.json), [lint](../../.logs/grid-memory-attribution/snapshot-owner-lint-02/status.json), and [formatting](../../.logs/grid-memory-attribution/snapshot-owner-format-01/status.json): pass.

Every run completed without timeout, signal termination or remaining processes.
Main independently checked all five additional source manifests against both
the recorded before/after hashes and the current files before authorizing GREEN:
no drift. The manifests beside each status include exact historical v1 source,
actual package-local transpiled runtimes, new tests, helpers and the contract.

The failures include real ABA/released-cancel mutation and legacy expiry loss,
not only absent methods. Both migration crash cases explicitly fail
`MIGRATION_EDGE_NOT_REACHED` against v1. That is an unimplemented migration
checkpoint, not successful crash-recovery evidence. The observer does not split
production SQL to manufacture an interior crash.

The native product retention RED remains separately frozen and must still fail
after 1a-0, which intentionally does not implement retention.

A subsequent independent oracle-only review found narrower proof gaps in this
first adapter packet: same-version unchanged images omitted new v2 metadata;
the post-COMMIT crash assertion did not inspect complete owner metadata before
reopen; blocked-wait timing could accept a much shorter timeout; and the
allocation fault was a synchronous injected exception, not actual disk quota
exhaustion or asynchronous request failure. The separate RED author strengthened
these observations while GREEN continued against the unchanged contract.
Original RED reports remain intact. Corrective current-source runs
must not be relabeled as pre-GREEN baseline evidence; no implementation
acceptance follows until corrected gates and independent review are complete.

## Positive baselines before owner GREEN

- Source-only typechecks: [storage](../../.logs/grid-memory-attribution/recovery-owner-storage-source-typecheck-baseline-01/status.json), [Node](../../.logs/grid-memory-attribution/recovery-owner-storage-node-source-typecheck-baseline-01/status.json), and [browser](../../.logs/grid-memory-attribution/recovery-owner-storage-browser-source-typecheck-baseline-01/status.json) pass. These build-source checks do not claim the previously failing package test-typecheck is green.
- [Original quarantine conformance and Node crash tests](../../.logs/grid-memory-attribution/recovery-owner-legacy-unit-baseline-01/status.json): 20 pass.
- [Original native quarantine controls](../../.logs/grid-memory-attribution/recovery-owner-legacy-browser-baseline-01/status.json): 21 pass across Chromium, Firefox and WebKit.
- [Transfer and adoption/activation controls](../../.logs/grid-memory-attribution/recovery-owner-transfer-consumer-baseline-01/status.json): 56 pass.
- [Unchanged three-transition, 64-writer control](../../.logs/grid-memory-attribution/recovery-owner-grid64-baseline-01/status.json): pass, approximately 64 seconds including wrapper startup; its 90-second test limit is unchanged.

All baseline runs have exact recorded source custody and no surviving processes.
They establish the pre-change controls, not post-GREEN acceptance. The
[spec formatting check](../../.logs/grid-memory-attribution/recovery-owner-spec-format-01/status.json)
also passed before the GREEN handoff.

## Initial owner GREEN checkpoint

The [initial GREEN handoff](../../.logs/snapshot-recovery-owner/green-handoff-01.json)
contains exact commands, source hashes, terminal statuses and failed-run
qualifications. Main independently checked the final initial-body results:
59 Node/shared quarantine tests, 38 new Chromium cases and 21 existing native
cases across all three engines passed. Source build and formatting passed;
scoped lint had no errors and retained the existing grid-fixture JSDoc warnings.
The earlier-body transfer/adoption regression run passed 56 tests and still
needs a corrected-final-body rerun.

The first post-change grid64 run hit its unchanged 90-second wrapper bound
without an assertion result. Its existing diagnostic-mode retry passed the
unchanged test in 56.51 seconds, with exact custody and no survivors. The cause
of the first timeout is not established; neither host load nor a product
regression is asserted. Keep the timeout report and rerun the ordinary workload
on the corrected final body.

All four implementation reviews now have terminal findings/dispositions in
[review.md](review.md). Confirmed error/promise defects and a documented SQLite
iteration assumption require separate corrective RED/GREEN. This checkpoint
does not establish retained snapshots, native product recovery or bounded
long-running storage. Previously recorded package-wide typecheck failures must
remain distinguished from successful source-only builds and scoped checks.

## Review-driven corrective RED

The separate review-driven corrective RED is frozen against the amended
1a-0 contract (`cefea11d09ff70de03630f99d178a6c8617fe1f52c5ff55e0c9462f5e553242a`):

- [Node corrective RED](../../.logs/grid-memory-attribution/snapshot-owner-review-corrective-node-red-02/status.json): 43 pass and five intended failures—three cancellation invocation cases, classified sweep failure, and repeated migration observation.
- [Native browser controls](../../.logs/grid-memory-attribution/snapshot-owner-review-corrective-browser-02/status.json): 43 pass.
- [Focused strict typecheck](../../.logs/grid-memory-attribution/snapshot-owner-review-corrective-typecheck-02/status.json), [lint](../../.logs/grid-memory-attribution/snapshot-owner-review-corrective-lint-02/status.json), and [format](../../.logs/grid-memory-attribution/snapshot-owner-review-corrective-format-01/status.json): pass.

Main checked all five additional custody manifests against current bytes before
authorizing corrective GREEN: no drift, timeout, signal termination or survivors.
The [baseline archive](../../.logs/snapshot-recovery-owner/review-corrective-frozen/)
preserves the prior four test files and three production files. The new shared
oracle hash is `25e58b279f4e6e8d575a4c7bcb99f51c94c6559ed91049c80bf9f716724e62c5`;
the per-run manifests own the remaining exact file hashes.

The cursor fault's independent unfinished/completed native controls both pass.
One injected permitted repeat changes the old implementation's reported debt
from two scopes / 1,164 bytes to three / 1,747. It is not a claim that native
SQLite spontaneously duplicated a row. The initial test-hook path mismatch
and TypeScript/lint failures remain preserved and are not accepted causal
evidence. Adjacent unsafe-integer refusal passes without a production change.

## Corrective GREEN and compiler ownership

The [corrective GREEN handoff](../../.logs/snapshot-recovery-owner/corrective-green-handoff-01.json)
owns the twelve exact commands and source manifests. Main independently checked
their terminal logs and current source hashes: 68 Node/shared cases, 43 new
native cases, 21 existing cross-browser cases and 56 transfer/adoption consumers
pass. Build, all three source typechecks, focused strict typecheck, zero-warning
production lint and formatting pass. Only the Node adapter changed in this
correction; the separate RED author's frozen tests did not.

The [ordinary final-body grid64 run](../../.logs/grid-memory-attribution/recovery-owner-corrective-green-grid64-01/status.json)
passes in 53.20 seconds test time, 55.77 including wrapper startup, under the
unchanged 90-second bound and without diagnostic environment overrides. All
twelve runs have exact recorded custody and no timeout, signal or survivors.
The earlier timeout and diagnostic retry remain distinct historical evidence.

The [full package check](../../.logs/grid-memory-attribution/snapshot-owner-final-browser-package-typecheck-01/diagnostic-comparison.json)
then exposed eight introduced project-boundary diagnostics on top of the
76-error baseline. This was not a green package typecheck. The correction gives
the cross-package test graph one [durable strict project](../../tests/fixtures/snapshot-recovery-owner/tsconfig.json),
with exact exclusions from the package-local composite project and an explicit
named check invoked before the existing package check. It does not suppress
diagnostics or relax type safety. Historical log-only configuration stays frozen
as evidence, not a competing active project.

- [Named harness check](../../.logs/grid-memory-attribution/snapshot-owner-compiler-owner-harness-typecheck-01/status.json): pass.
- [Actual package command comparison](../../.logs/grid-memory-attribution/snapshot-owner-compiler-owner-package-typecheck-01/diagnostic-comparison.json): exactly the original 76 diagnostics, none added or removed; the strict harness runs first. The package still fails at that baseline.
- [Browser build](../../.logs/grid-memory-attribution/snapshot-owner-compiler-owner-browser-build-01/status.json), [source typecheck](../../.logs/grid-memory-attribution/snapshot-owner-compiler-owner-browser-source-typecheck-01/status.json), and [configuration formatting](../../.logs/grid-memory-attribution/snapshot-owner-compiler-owner-format-01/status.json): pass.

Main checked all five standard, additional and compiler-configuration custody
manifests against current bytes: exact, with no timeout, signal or survivors.
The eight-error failure and full diagnostic inventory remain preserved.

The [final-body native product retention RED](../../.logs/grid-memory-attribution/snapshot-owner-final-native-retention-red-01/status.json)
still fails causally: sweep removes required manifest/chunk content, the four
owned processes are killed and confirmed gone, and cold reopen rejects
`snapshot-unavailable`. Native evidence and wrapper custody are exact, and final
cleanup reports no survivors. This is the intended outstanding consumer
obligation, not acceptance of retention. Corrected implementation review
dispositions remain in [review.md](review.md).

## Final oracle tightening and 1a-0 acceptance

The separate test author closed Opus F1/F2 without changing production, shared
or browser test sources. Main read the [exact Node-test diff](../../.logs/snapshot-recovery-owner/post-green-oracle.patch):
the completed-selection fault guard asserts live targeting and no overlap or
repeat, while the unsafe-BigInt control covers both traversal rows. Original
tests remain in the [archive](../../.logs/snapshot-recovery-owner/post-green-oracle-frozen/).
This is post-GREEN oracle strengthening, not a new historical causal RED.

[Node/shared tests](../../.logs/grid-memory-attribution/snapshot-owner-post-green-oracle-node-01/status.json)
pass 69/69; the [durable strict harness](../../.logs/grid-memory-attribution/snapshot-owner-post-green-oracle-typecheck-01/status.json),
[zero-warning lint](../../.logs/grid-memory-attribution/snapshot-owner-post-green-oracle-lint-01/status.json),
and [formatting](../../.logs/grid-memory-attribution/snapshot-owner-post-green-oracle-format-01/status.json)
pass. Main independently checked all four terminal logs and standard/additional/
compiler custody against current bytes: exact, no timeout, signal or survivors.
The new Node test hash is `1d381184379b32e56e9784054da741a30259c020239a2cf33c932b7f9d6f8280`.
Previously verified browser/consumer/grid64 production inputs are unchanged;
their earlier tests are not relabeled as runs of this later Node oracle.

The versioned-owner seam is accepted on 2026-09-07 at its frozen scope, with
all review findings dispositioned. This means schema migration, old-client and
handle fencing, owner inspection and temporary compatibility—not retained
snapshot availability, completed legacy classification or bounded room age.
The native retention RED and later golden-path obligations remain open.

## Native retention-platform mechanism probe

The [platform-only probe](../../.logs/bounded-storage-lifecycle/retention-native-edge-probe.mjs)
and [native results](../../.logs/grid-memory-attribution/retention-native-edge-probe-02/stdout.log)
ground the next transaction contract without importing product retention code.
Chromium, Firefox and WebKit each report `strict` and demonstrate:

- Successful write request followed by native abort leaves no committed row.
- Abort after native completion throws `InvalidStateError` and retains the committed row.
- A prevented request error bubbles through a transaction error event, yet the transaction subsequently completes with its earlier successful write.

This is mechanism evidence for terminal-event semantics, not adapter RED,
retained-snapshot acceptance or physical flush proof. Script before/after hashes
match; the [bounded run](../../.logs/grid-memory-attribution/retention-native-edge-probe-02/status.json)
is terminal with exact recorded wrapper custody, and each engine's birth-token
process inventory confirms no survivors. The initial attempt failed on a
probe import path before browser execution and remains preserved as setup
failure, not a failed platform assertion.

## Initial 1a-1 retention RED

The [frozen RED handoff](../../.logs/snapshot-recovery-retention/red-handoff-01.json)
records current-source Node/browser, strict, lint/format and dependent gates.
The counter-representation and existing ownership-guard failures are causal;
missing retention/helper APIs mask the new admission and native terminal paths.
The passing direct SQL controls demonstrate instrumentation, not adapter
retention. The incomplete combined browser run and coverage-collision run stay
preserved and explicitly disqualified rather than becoming pass evidence.

The [review dispositions](review.md#initial-1a-1-red-review-synthesis) require
corrective RED and fresh reviews. Initial browser observation attachments were
not persisted by the line reporter; raw console failures cannot establish the
unreached terminal edges. Production retention remains unimplemented, and no
consumer or endurance acceptance follows from this test checkpoint.

## Corrective 1a-1 RED checkpoint

The [corrective handoff](../../.logs/snapshot-recovery-retention/red-handoff-02.json)
binds the frozen test graph, prior sources and terminal command evidence.
Node/shared reports 66 expected failures and four passing instrumentation
controls; each native browser engine reports 55 expected failures and one
passing platform control. Strict harness, lint and formatting pass. The separately
persisted observation index binds all 171 browser observation files; root verified
their hashes and the full-source preservation manifests. Missing APIs still mask
retention transaction behavior, while owned-state and counter failures are causal.

The [review archive receipt](../../.logs/bounded-storage-lifecycle/retention-red-snapshot-reviews/archive-receipt.json)
preserves all 482 immutable review inputs in the repository after all reviews
terminated. It is a byte-identical preservation copy, not the path the reviewers
read. Root verified its bytes, original/snapshot/orchestration custody and the
event-grounded terminal receipts. The [review synthesis](review.md#corrective-1a-1-red-acceptance)
accepts RED and authorizes the distinct GREEN implementation without changing
the test contract. Neither review approval nor passing platform controls prove
adapter retention, consumer recovery or long-running boundedness.

## Remaining recovery-admission boundary

The initial GREEN removes the browser constructor's hypothetical maximum-payload
free-space precondition. Native controls now reopen preserved legacy bytes
without that estimate; injected allocation failure and native asynchronous
upgrade abort are labeled separate observations, not measured disk exhaustion.
Real metadata allocation failure may still refuse atomically. Bounded admission
for new temporary transfers remains later work; removing this constructor gate
does not supply it.

The later retirement planner also needs stronger recovery evidence than the
current internal `snapshot.adopted` input. Its caller authenticates the close
and settlement, but does not supply exact snapshot payload dependencies for
the current and rollback generations. Extend that same planner's authority;
do not create a separate adapter-local eligibility rule.

## 1a-1 GREEN checkpoint

The [input archive receipt](../../.logs/bounded-storage-lifecycle/retention-green-snapshot-reviews-02/archive-receipt.json)
preserves every frozen review input byte after the reviews completed. Root
independently compared the archive to the frozen manifest. This is a preservation
copy, not a claim that reviewers inspected the later archive path.

The [stable checkpoint](../../.logs/snapshot-recovery-retention/green-stable-02/checkpoint.json)
binds the six-file implementation delta and unchanged RED graph. The
[final gate index](../../.logs/snapshot-recovery-retention/green-final-gate-index-01.json)
and [native observation index](../../.logs/snapshot-recovery-retention/green-final-observations-01.json)
own executed commands, source hashes and observations. Focused builds, source and
strict-harness typechecks, lint/format, adapter/native and compatibility gates
pass. The unchanged ordinary grid64 run stays within its existing ceiling.
No workload or storage budget was increased.

The browser-package typecheck still exits nonzero with 76 baseline diagnostics.
The [comparison](../../.logs/bounded-storage-lifecycle/retention-green-snapshot-reviews/evidence/diagnostic-comparison.json)
establishes normalized diagnostic multiset equality, not byte-identical output
or a clean package gate. The final index selects 17 records; the separately
preserved failed dependency-01 probe is not another passing gate.

Historical evidence limits remain: the exact TypeScript bytes for two
intermediate Node corrections and a pre-rebuild v3-live distribution file were
not archived. The distribution drift's cause is unestablished. Exact final-body
reruns do not reconstruct those missing historical bytes.

The [GREEN review synthesis](review.md#1a-1-green-acceptance) accepts the owner
seam with qualified independent reviews and root dispositions. The native
product retention RED is still a later consumer-integration obligation. Short
compatibility runs do not prove post-pin recovery, reclamation, thousand-epoch
storage bounds or physical media flush.
