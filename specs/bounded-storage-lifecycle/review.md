# Snapshot ownership contract review

This is a findings ledger, not an implementation claim. Initial umbrella and
versioned-owner findings are dispositioned in the executable slice. Freeze the
amended independent RED before assigning its distinct GREEN author; review the
resulting implementation and these fixes together before accepting the seam.

## Corrected implementation checkpoint

[Codex's corrective-delta review](../../.logs/grid-memory-attribution/recovery-owner-corrective-codex-review-01/stdout.log)
returned no actionable findings after reading the three Node corrections and
four corrective test diffs against their archived preimages. The separate
[compiler-ownership review](../../.logs/grid-memory-attribution/snapshot-owner-compiler-owner-codex-review-01/stdout.log)
also returned no actionable findings, confirming explicit strict coverage of the
excluded cross-package test graph. Both are static reviews, not test execution;
both terminated normally with exact custody and no survivors.

The [fresh review handoff](../../.logs/bounded-storage-lifecycle/corrective-implementation-reviews/handoff.md)
records Grok APPROVED, Opus CHANGES_REQUIRED solely for a test-evidence gap,
and Kimi APPROVED. All three found the production correction implemented, with
no concrete product defect. Each terminated naturally with exact custody for
the 28 enumerated inputs and no survivors. Auxiliary source/log reads are
explicitly outside that before/after custody claim. Kimi's conservative usage
is 56 of 100 steps; no continuation was needed or launched. Opus used actual
Opus 5 at xhigh. These are source reviews; the reviewers ran no tests.

| Finding                                                                                                     | Root disposition                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opus F1; Kimi informational: the passing migration test prints hook counters but does not assert attachment | Fixed by the separate test author: positive selection/update telemetry and zero overlaps/repeats are asserted, the title is neutral, and all image/counter assertions remain. Main inspected the exact diff and passing gates; no production change. |
| Opus F2: unsafe BigInt control reaches only the first traversal row                                         | Fixed by parameterizing both seeded rows, also covering rollback after a prior row update. Main verified the unchanged-image assertions and passing gates.                                                                                           |
| Opus F3: new browser checks already passed before correction                                                | Already recorded as native controls, not causal browser RED. Preserve that distinction.                                                                                                                                                              |
| Opus F4: other historical Node method preflight aborts still throw synchronously                            | Explicitly outside the narrow cancellation correction. No change here; the new retention method must have its own promise-refusal contract.                                                                                                          |
| Opus F5: corrupt persisted limits may retain the existing malformed-input classification                    | Existing browser-consistent behavior; no new taxonomy change in this seam.                                                                                                                                                                           |

The [evidence ledger](evidence.md) separately records corrected runtime gates,
the unchanged failing package baseline, and final oracle tightening. None of
these reviews establishes durable retention or long-running acceptance.

## Reviewer custody

- [Grok](../../.logs/bounded-storage-lifecycle/contract-reviews/grok/runner/public.txt): CHANGES_REQUIRED, normal terminal answer, read-only source review. No test/build evidence supplied.
- [Opus](../../.logs/bounded-storage-lifecycle/contract-reviews/opus/public.txt): CHANGES_REQUIRED, actual `claude-opus-5` with `xhigh`, normal terminal answer. No tests/builds supplied. The shared test fixture changed while this review ran; its product/spec inputs did not.
- [Kimi](../../.logs/bounded-storage-lifecycle/contract-reviews/kimi-final/public.txt): CHANGES_REQUIRED, same-session terminal-only continuation, exit 0, no new tools or source drift in the continuation. The initial OAuth source-reading run timed out below its 100-step ceiling; invocation/authentication failures remain NO_VERDICT. Conservative remaining budget 60 plus at most 35 prior steps keeps cumulative work below 100. Its earlier no-op shell call violated the read/search-only constraint; the reviewer disclosed it and no finding relies on it. This is one independent review, not a second reviewer vote.

The [Codex test review and correction](evidence.md) are separate from these
storage-contract reviews.

## Accepted obligations

| Obligation                                                            | Disposition and acceptance boundary                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit promotion API, not `complete()` as an implicit permanent pin | Freeze the operation and its exact durable identity before adapter GREEN. Ordinary verified transfers must still expire.                                                                                                                                                                                |
| Immutable verified bytes with a separate recovery role                | Keep `status.kind === "verified"` for promoted snapshots so existing read/write guards remain valid. Do not add a competing verification state or expiry sentinel.                                                                                                                                      |
| Atomic bounded admission                                              | Retained cardinality and charged logical bytes must be limited in the same transaction that installs ownership. A quota estimate at store construction is not admission accounting. No additive unlimited pins, no limit increases to pass endurance.                                                   |
| Caller records are not authority                                      | A forged reference or declaration cannot manufacture verified durable contents. Validate exact persisted scope, manifest and chunk closure in the transaction; never trust a supplied boolean. The final API may use durable verification rather than treating a public reference as an opaque receipt. |
| Expired/unverified/missing/poisoned/mismatched refusal                | Ordinary temporary content cannot acquire recovery ownership after expiry. Exact already-owned retry remains idempotent beyond its former TTL. Legacy migration needs a separately explicit rule, not a hidden expiry bypass.                                                                           |
| No deletion through cancel or stale handles                           | A released handle cannot remain an unrestricted deletion capability. Fresh or stale cancel/sweep must enforce durable recovery ownership, not cached state.                                                                                                                                             |
| Promotion before close signing                                        | Protection must be durable before `actor.close`, and before any dependent pending/head publication. Protecting only before final adoption is too late.                                                                                                                                                  |
| Unknown completion is not permission to release bytes                 | Re-read durable ownership after uncertain completion; exact retries do not double-charge. Confirmed abort and unknown outcome are different observations.                                                                                                                                               |
| Non-creating recovery inspection                                      | Inspection must not sweep or recreate an empty scope. Keep declaration/manifest bytes keyed by exact object, predecessor epoch, predecessor anchor and manifest digest for later authenticated discovery.                                                                                               |
| Versioned migration and old-client fencing                            | The schema's strict shape must change deliberately. Preserve existing bytes while required dependencies are classified; never run TTL sweep first. Schema numbers alone do not fence already-open SQLite clients.                                                                                       |
| Separate adapter and consumer GREEN                                   | The native integration RED is the product obligation, not permission to combine schema, accounting, stale-client safety, migration and signing order into one opaque change.                                                                                                                            |
| Historical negative expectation is superseded, not preserved as law   | When consumer GREEN repairs retention, migrate the active characterization assertion to the supported behavior. Preserve its old reports and source custody unchanged.                                                                                                                                  |
| Current cleanup's availability booleans are insufficient              | The existing planner already authenticates other cleanup facts, but `snapshot: { adopted: true, manifestDigest }` does not prove durable byte availability. Replace that input with genuine retained-dependency evidence in the protected-set slice.                                                    |

## Rejected or narrowed advice

Opus's newest-four-epochs demotion to TTL is rejected. Demotion authorizes
future deletion just as surely as immediate deletion; age does not establish
that pending, rollback or shared dependencies are obsolete. Until authenticated
release exists, a full retention budget must refuse new promotion. That
intermediate backpressure is not long-running acceptance.

Grok's and Kimi's suggestions to retain schema v1 when only state values change are rejected.
Old implementations do not understand retention and can still cancel/sweep
those rows. Both semantic migration and stale-client enforcement are required,
regardless of whether the physical column list changes.

Kimi's exemption of promoted pins from all current budgets is rejected. A
finite census in a short test is not an enforced production bound. Newly
retained bytes and rows need atomic limits before the additive API exists.
Its proposed `promoted` verification kind is also rejected because it would
invalidate existing verified-read and immutable-write branches; recovery
ownership remains orthogonal to verification.

The blanket 8,192-byte AHE prohibition is rejected. Larger blobs can be opaque
to the trust scan; the actual obstacles are exact authenticated closure-set
laws, digest-domain mapping and eager candidate loading. Snapshot-owner
promotion is preferred because of those concrete costs, not because AHE is
intrinsically incapable of storing payloads.

An in-memory WeakMap token is not by itself durable retry authority. If a
reference-token API is selected, it still needs persisted verification and
inspection after process death. A declaration-based operation that derives
verification solely from exact durable state need not pretend its input is
unforgeable.

## Additional source-grounded migration evidence

The [SQLite mechanism probe](../../.logs/grid-memory-attribution/recovery-retention-sqlite-stale-client-probe-01/stdout.log)
confirms that a user_version bump leaves old DELETE statements effective.
An atomic table rename blocks both already-prepared and newly prepared SQL
using the old table name while preserving the row in the new table. This is a
candidate old-client fence, not proof of the full adapter migration, foreign
key/cascade behavior, crash recovery or schema validation. Those need REDs at
the actual adapter boundary.

Existing-store classification and finite retention admission remain following
seams. Do not silently auto-pin all legacy
rows, sweep them before classification, or claim a migration is complete
because it increments a version.

## Versioned-owner review and amendments

Fresh independent [Grok](../../.logs/bounded-storage-lifecycle/owner-contract-reviews/grok/public.txt),
[Opus](../../.logs/bounded-storage-lifecycle/owner-contract-reviews/opus/public.txt)
and [Kimi](../../.logs/bounded-storage-lifecycle/owner-contract-reviews/kimi/public.txt)
reviews all returned CHANGES_REQUIRED on the first executable 1a-0 contract.
All completed normally with unchanged input custody and no surviving processes;
the [handoff](../../.logs/bounded-storage-lifecycle/owner-contract-reviews/handoff.md)
records settings and exact hashes. Kimi used five requests under the 100-step
cap, Read calls only; this run had no invocation retry or continuation. Opus
used actual `claude-opus-5` at xhigh. These verdicts do not approve the subsequent
amendment or future implementation.

The [amended contract](slices/01a-0-versioned-snapshot-owner.md) resolves the
source-grounded union:

| Finding                                               | Chosen disposition                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspection outcomes and sibling-manifest disagreement | Past expiry remains `present`; identity disagreement and occupied sibling manifest reject `conflict`; only true absence reports `missing`. This preserves the existing selector conflict rule rather than hiding an occupied selector.                   |
| Unwritten descriptor identity was never stored in v1  | New v2 rows store full captured vectors. Legacy rows compare recorded identity and occupied descriptors only, explicitly marking missing historical information. No fabricated equality, protocol admission parser or retention authority is introduced. |
| Invalid policy/optional-field ambiguity               | Exact optional constructor field; explicit undefined and malformed limits refuse `malformed-input` before database work. Valid disagreement remains `policy-mismatch`.                                                                                   |
| Shared-interface blast radius                         | Extend the existing base store, with only pass-through additions to the Phase 6a decorator. No second owner interface or behavioral fixture bypass.                                                                                                      |
| Barrier and queued cancel precedence                  | Freeze the operation matrix, preserve identity conflicts, and recheck live session/incarnation when queued work runs. Release cannot leave a queued deletion capability.                                                                                 |
| Blocked-open event ordering and contention            | Disarm the blocked timer on upgrade start/success; canceled late upgrades abort and late handles close. Slow cooperative clients can safely time out too. Contention may refuse without mutation and be retried; no infinite-wait promise.               |
| Debt formula/overflow                                 | Charge declared payload plus manifest even for unfinished scopes; persist checked counters. Unsafe sums refuse `storage-failed` with migration rollback, never rounding/truncation.                                                                      |

Grok's proposed owner metadata containing limits only is rejected: the contract
requires persisted counters and bounded observational work. Exact internal
field names beyond the stale-SQL fencing table names need not be dictated by a
public behavior test; GREEN must still implement and test exact schema
admission. Its prescribed same-realm queue and Node retry loop are not required
when database serialization and explicit bounded contention refusal suffice.

Kimi's suggestion to permit a timed-out request to commit is rejected. Its race
assumes a blocked timer remains active after upgrade begins. Disarming that
timer preserves both the no-active-upgrade-timeout rule and the requirement
that a request canceled before upgrade cannot later commit.

Main-owner source review also resolves the artificial browser constructor
quota floor: existing-byte recovery must not require room for a hypothetical
maximum new snapshot. Remove that precondition and its now-meaningless estimate
call explicitly; retain atomic failure handling for real allocations. This is
not whole-store admission accounting, which remains a later required seam.

The clean-refactoring pass assigns local input capture, error classification,
limits and content arithmetic to one shared subpath helper. Both adapters must
delete their duplicated implementations in the same GREEN. The narrow runtime
roster amendment is explicit, with package export maps and root rosters frozen.

## Initial 1a-0 implementation review

The [review handoff](../../.logs/bounded-storage-lifecycle/owner-implementation-reviews/handoff.md)
records exact 29-file custody and terminal process evidence. Grok approved
without findings. Actual Opus 5 xhigh approved with two LOW findings, not a
clean no-findings verdict. Kimi's original attempt timed out without a verdict;
an authorized same-session, tool-free terminal continuation returned
CHANGES_REQUIRED within the cumulative 100-step cap. Its earlier read-only
`wc -l` call violated the no-shell prompt and remains disclosed, despite the
terminal answer's inaccurate claim that no shell ran. Codex supplied a fourth
source-only implementation review. None of these reviews ran tests.

| Finding                                                                                  | Root disposition                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex: ALTER-added columns follow the primary-key clause, so valid migration is rejected | Disproved. The [native SQL probe](../../.logs/grid-memory-attribution/recovery-owner-codex-alter-disposition-01/stdout.log) shows added columns before the primary-key clause, matching the validator; actual migration/crash tests also pass. No source change.                                                                                          |
| Opus F1: Node sweep hides a classified malformed-owner failure                           | Confirmed. Add a separate unchanged-image RED, then preserve the shared error through the catch boundary.                                                                                                                                                                                                                                                 |
| Opus F2: new Node cancel liveness checks throw before returning a promise                | Confirmed. Add a discriminator that does not conflate invocation-time throw with promise rejection, then align the cancellation boundary.                                                                                                                                                                                                                 |
| Opus U1: migration updates a table while iterating it                                    | Accepted as a platform-safety amendment, not an observed corruption incident. SQLite documents possible row reappearance in this pattern. The amended contract requires defined, bounded traversal and a labeled fault-model RED.                                                                                                                         |
| Kimi F1: rounding 9007199254740993n bypasses the safe-integer guard                      | Disproved. The rounded value is still outside the safe-integer range. The [native integer/helper probe](../../.logs/grid-memory-attribution/recovery-owner-kimi-integer-disposition-01/stdout.log) returns `storage-failed`, not admitted understated debt. Add an adjacent-value positive control, not a production workaround for a nonexistent bypass. |
| Kimi F2: extra chunks yield different completion codes across adapters                   | Pre-existing in both hash-pinned v1 sources: Node uses `poisoned`, browser `incomplete`. This slice explicitly preserves historical completion classifications; do not mislabel this as an introduced regression. The next retention operation must freeze its own consistent exact-closure taxonomy.                                                     |

The [20,000-row native cursor probe](../../.logs/grid-memory-attribution/recovery-owner-migration-cursor-probe-01/stdout.log)
observed exact counting and distinct nonempty incarnations while database pages
grew. That narrows the empirical concern but cannot replace
[SQLite's documented guarantee boundary](https://www.sqlite.org/isolation.html).
The corrective RED may model a permitted repeated observation; it must not
claim that the native probe spontaneously reproduced it.

The test-only grid image copier's destination guard currently checks schema
before replacement, while its source guard additionally requires temporary,
zero-debt ownership. Existing tests use fresh/default destinations; this is not
a production import capability. Subsequent retention integration must preserve
the source guard and use genuine destination transfer/admission semantics, not
copy recovery ownership or erase protected destination debt to keep tests green.

Initial review is not corrected-body acceptance. Preserve these results, run
the separate corrective RED/GREEN, and record final-body gates and review of the
corrections before closing 1a-0.

## 1a-1 retention contract synthesis

The [terminal review packet](../../.logs/bounded-storage-lifecycle/retention-contract-reviews/handoff.md)
records Grok CHANGES_REQUIRED/executable NO, Opus CHANGES_REQUIRED/executable
YES with repairs, and Kimi APPROVED/executable YES. These are differing verdicts,
not consensus approval. All wrappers exited zero without survivors and preserved
the 27 enumerated input hashes. Auxiliary Opus reads and initially unscoped Kimi
searches exceeded the prompt boundary; their broader claims have no all-input
custody. Kimi's claim that no test enumerates helper keys is incorrect: the Node
1a-0 test does. Root checked that gate and the actual Phase 4c type/legacy seams.
No reviewer ran product tests or established native persistence behavior.

Root resolved the findings in the [canonical contract](slices/01a-1-bounded-snapshot-retention.md):

- Grok's closure precedence and strict-capability refusal blockers are accepted:
  corruption wins over missing content at step 6; unsupported reported strict
  durability is `storage-failed` and cleanup cannot relabel it `aborted`.
- Opus B1/B2 are accepted: RED owns the actual Phase 4c exact-type amendment
  (including dependent pull gates), and historical/current scope types must be
  separated without legacy-first overloads. The exact 1a-0 helper roster also
  requires the explicitly authorized RED supersession.
- Opus M1–M4 and Kimi's counter/durability notes are resolved: defaults stay
  bounded and include manifest cost; uncertainty inspection precedes ordinary
  reopening with a pinned TTL race; raw key checks stay adapter-owned while
  descriptor/membership validation stays shared; Node counter coercion must
  actually be replaced in its central owner read.
- Optional scope/build concerns are resolved: preserve old range taxonomy,
  use dependency-driven topological builds and the durable strict harness, and
  test a manageable multi-chunk payload. The grid copier's destination-debt
  protection remains an explicit 1b integration obligation, not a claimed
  property of this storage-only slice.

This closes contract ambiguities sufficiently to author RED; it does not accept
an implementation. The amended contract is frozen and the separate RED author
has been assigned. GREEN cannot change normative test expectations. Preserve
the original reviewer reports and archive superseded oracle sources/results.

## Initial 1a-1 RED review synthesis

The [review audit](../../.logs/bounded-storage-lifecycle/retention-red-reviews/acceptance-audit.json)
preserves terminal Grok approval and Opus/Kimi change requests. All three kept
their enumerated inputs unchanged and left no surviving processes, but exceeded
the declared read boundary. They are **NO_VERDICT for acceptance**, not three
valid votes. Their concrete findings remain useful after root verification.
The additional [Codex review](../../.logs/bounded-storage-lifecycle/retention-red-codex/audit.json)
also requests changes. No reviewer established retention behavior while the
new API was absent.

The corrective RED author owns these changes; the production contract is not
being weakened:

- A positive chunk-helper control complements the negative matrix. Direct
  synchronous success/throw observations also pin the helper's transaction-safe
  calling contract. Native promotion already supplies positive integration
  coverage when that helper is actually used; the original unit matrix did not.
- Count every target-database readwrite transaction, not only the first one
  selected for instrumentation. Otherwise an exact-one assertion saturates at
  one and cannot detect split durability.
- Exercise key/row disagreement through explicitly synthetic native cursor
  observations with an independently demonstrated interception edge. The
  admitted IndexedDB inline key path derives its index from the row; ordinary
  writes cannot create a durable key/index disagreement. Do not label the
  synthetic observation as spontaneously corrupt native storage.
- Corrupt occupied bytes in the conflict fixtures, and add combined missing
  and corrupt chunks on a multichunk owned/nonverified scope. Writes and
  completion need independent starting images, unchanged-image checks and
  preserved genuine receipt authority.
- Require the late-cancellation commit outcome, not a particular signal-handler
  implementation that must call `abort()` after completion. Keep thrown-abort
  observations distinct from the separate native platform control.
- Persist browser observation bodies before assertions. An in-memory attachment
  without a retaining reporter is not durable evidence.

The protocol-v3 dependency and topological build-order requirement remains a
mandatory **GREEN build-evidence gate**; it need not become a test that parses a
fixed configuration-file shape. Optional broader traversal telemetry and
historical type-oracle diagnostic formatting do not justify unrelated changes.
Existing strict, dependent and preservation gates remain obligations; unrun
browser-owner checks must not be reported as new passes.

Fresh reviews will use a materialized copy of the permitted source/evidence
inputs so ordinary directory searches cannot reach historical opinions or
unrelated files. Copy and original-source custody, external instruction reads,
terminal schema and process cleanup still require explicit auditing. A copied
working directory alone is not a filesystem sandbox. Corrective RED, fresh
review and a distinct GREEN author remain the pickup order.

## Corrective 1a-1 RED acceptance

The [fresh review handoff](../../.logs/bounded-storage-lifecycle/retention-red-snapshot-reviews/handoff.md)
preserves Grok, Opus and Kimi's terminal APPROVED / RED_READY YES responses,
inspection limitations and exact input custody. Root read each full report and
checked the post-terminal archive against every frozen input hash. The original
automatic NO_VERDICT receipts remain: their parser missed a concatenated progress
line, Markdown headings and a metadata trailer respectively. Separate receipts
bind the actual final assistant event/turn and normal process termination;
they do not fabricate new reviewer answers or overwrite the failed parser output.

The additional [Codex report](../../.logs/grid-memory-attribution/retention-red-codex-corrective-01/stdout.log)
remains CHANGES_REQUIRED. Root's [code-grounded dispositions](../../.logs/bounded-storage-lifecycle/retention-red-codex-corrective/root-disposition.json)
reject its proposed `poisoned` expectation for well-formed durable declaration
drift: the frozen step-1 recorded-row owner compares manifest bytes/descriptors
and returns `conflict`, before step-6 closure validation. Existing owner tests
exercise those same equality checks. Its second request hypothesizes a separate
unchecked retention counter reader, which the contract expressly forbids; native
counter tests already discriminate the required central-reader correction.
Additional retention-path fault matrices are optional, not required to begin
GREEN. This is not approval by vote: GREEN acceptance must inspect direct reuse
of both existing owners and rerun their consumers. A bypass reopens the findings.

Other optional suggestions remain in the raw reports without changing frozen
tests: stronger roster membership and diagnostic output, extra combinations of
already-covered guards, redundant ownership observations, and clearer harness
reporting. The traversal telemetry and `promotionOnly` limitations are real
coverage boundaries: GREEN review must inspect exact selected-prefix traversal
without neighboring payload reads and verify durable ownership on every successful
new-admission path, not infer those properties from helper equality alone.
No test-run, receipt authority, refusal taxonomy or native durability requirement
is relaxed by leaving optional strengthening deferred.

Review prose that calls every shared case missing-API-masked is overbroad: the
existing write/complete/cancel cases have causal failures. Kimi's failure-union
amendment describes the normative test roster, not implemented production API.
Raw observations and current source remain authoritative over those summaries.
Dependent type failures have indirect attribution because their diagnostic body
was swallowed. Prior quarantine/transfer/adoption and grid64 gates were not all
rerun in corrective RED and must not be reported as new passes. Opus could not
inspect the uncopied prior Node quarantine test; observation sampling and other
inspection limits remain preserved in the reports.

Corrective RED is accepted for the distinct GREEN author. Dependency/importer
amendment, actual topological built-dist resolution, transaction terminal behavior,
full preservation gates and fresh independent implementation reviews remain
mandatory. Consumer integration and production boundedness remain unaccepted.

## 1a-1 GREEN acceptance

The exact stable-02 implementation is accepted. Qualified
[Opus](../../.logs/bounded-storage-lifecycle/retention-green-snapshot-reviews-02/opus/terminal.json),
[Kimi](../../.logs/bounded-storage-lifecycle/retention-green-snapshot-reviews-02/kimi/terminal.json)
and [Grok](../../.logs/bounded-storage-lifecycle/retention-green-grok-direct-02/grok/terminal.json)
reviews report no required fixes. Root read the public reports and independently
checked terminal boundaries, input custody and process completion. The additional
[Codex source review](../../.logs/grid-memory-attribution/retention-green-codex-review-01/stdout.log)
also found no required fixes; it did not assess execution or endurance.

The [root triage](../../.logs/bounded-storage-lifecycle/retention-green-snapshot-reviews-02/root-triage.md)
dispositions optional expiry/limit hardening and browser listener cleanup without
changing the frozen contract. Existing metadata-admission behavior remains
outside the narrow counter correction. No review demonstrated an accumulating
post-terminal listener root. Opus's claimed negative-index native coverage gap
was disproved by the existing frozen cases and all three engines' observations;
no RED amendment was needed.

Earlier tool-based Grok attempts remain ineligible for failed reads. The first
direct attempt also remains ineligible under its parser and the separately
recorded prospective policy: both mishandled real catalog metadata. The
[preserved disposition](../../.logs/bounded-storage-lifecycle/retention-green-grok-direct/root-disposition.md)
records those instrumentation defects. A fresh review used an unchanged source
packet and a corrected parser tested against the complete observed event format,
with rules fixed before launch. No failed tool, missing context, source drift or
nonterminal run was reinterpreted as approval.

Acceptance is limited to atomic, bounded retention on the existing owner.
Native integration, legacy classification, authenticated discovery, retirement,
producer/adoption ordering and endurance remain separate obligations. The
[evidence ledger](evidence.md#1a-1-green-checkpoint) preserves test and historical
provenance limits; review prose does not override the raw gate index.

## 1b-0 contract review

The first content-delivery plan round is complete, not accepted:
[Grok](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-plan-direct/run-grok/public.txt)
and [Opus](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-plan-direct/run-opus/public.txt)
require changes;
[Kimi](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-plan-direct/run-kimi/public.txt)
approved. All three have qualified terminal receipts beside their public reports.
Root independently checked raw terminal extraction, public-text hashes, frozen
input/control custody and normal process completion. No tools, timeout or cleanup
were needed. These are plan reviews, not implementation or execution evidence.

The [revised contract](slices/01b-0-fixture-snapshot-content-delivery.md) accepts
the following substantive findings rather than deciding by vote:

- Opus R1: explicitly supersede the old snapshot image-copy preservation clause;
  retain namespace and source coherence checks while native admission owns the
  destination. No parallel snapshot copier survives.
- Opus R2 and Grok R1: distinguish primary names from derived snapshot names and
  preserve the fresh-destination / non-fresh-creator-source asymmetry. Kimi
  inferred that asymmetry correctly from code; the original draft omitted it.
- Opus R3–R4: name the full integration consumers and give the focused strict
  project a normal package typecheck owner. The ordinary three-transition grid64
  case lives in the F5B integration suite, not `runGridTransitions`, whose allowed
  targets are longer diagnostics. Those are not interchangeable gates.
- Opus R5: forbid native factory use and migration in every declaration lookup;
  the v1 upgrade allowance applies only to delivery's destination admission.
- Grok R2–R4: use the delivered declaration directly, explicitly change destination
  occupancy to one selected snapshot, separate helper tests from room-floor
  sequencing, and distinguish causal RED-fail obligations from existing passing
  controls. An expired source sentinel is not an existing source-sweep defect.
- Grok R5: retain fail-closed prefix uniqueness, but require a real post-close
  census before freezing RED. Source inspection or a verified-only row filter
  cannot establish the stronger ordinary-producer precondition.

Optional clarifications adopted include removing `producedDeclaration` and the
raw copier's snapshot branches, exact public adapter/receipt imports, fresh
declaration construction, snapshot-only traversal tripwires, existing-profile
reuse and unexpired exact-destination reuse. The suggested folder reshuffle is
not needed for ownership. Exact IndexedDB range encoding remains an implementation
choice that must meet bounded observed traversal; no second manifest parser or
fixture-only recovery closure is authorized. Broader receipt-forgery tests remain
with the storage owner.

The original packet and reports remain preserved. The
[ordinary producer census](../../.logs/bounded-storage-lifecycle/snapshot-prefix-cardinality-01/observation.json)
observed zero selected-prefix rows before a genuine nonempty two-writer close
and one verified temporary row afterward, with matching native key/row identity.
Root inspected the probe, actual stdout, cleanup and unchanged source/dist hashes.
Both rooms closed; the probe exited normally without rebuild. Nonfatal historical
log-local tsconfig-discovery errors remain in stderr. This establishes the sampled
first-close precondition, not uniqueness for all rooms, later epochs or browser
durability. The focused ambiguity tests and full integration gates remain required.

### Revised contract disposition

The second independent round is complete:
[Grok](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-plan-direct-02/run-grok/public.txt)
and [Opus](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-plan-direct-02/run-opus/public.txt)
returned changes required;
[Kimi](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-plan-direct-02/run-kimi/public.txt)
approved. All have qualified terminal receipts beside the public reports. Root
independently recomputed terminal extraction, source/control custody and report
hashes. Each exited naturally with no tools, timeout, forced cleanup or surviving
process. Kimi used one assistant step within its cumulative cap. None inspected
the later follow-on census described below.

Root accepts the contract for separate RED authoring after these dispositions:

- Grok's ordinary-control concern is adopted explicitly: selected destination
  content and source preservation pass both implementations; copied destination
  ownership, incarnation, expiry or sibling images are never the passing oracle.
- Opus R1 identifies a real wording defect: there is no exported protocol profile
  value to import. The contract now names the exact three-field projection from
  the shared storage limits. Passing the four-field limits object is forbidden
  by the existing receipt owner, not a reason to change its API or admission.
- Opus R2–R3 are adopted as test/extraction precision: only exact-source database
  operations feed source traversal tripwires, and RED composes both old functions,
  including destination declaration lookup, before GREEN changes the owner.
- Opus R5 adds explicit absent-source and deletion-race no-creation controls.
  The first census never triggered `upgradeneeded`; Kimi's statement that it
  already proved creation rollback is too broad. Raw IndexedDB setup cannot
  replace the required genuine `retainForRecovery` setup for owned-source tests.
- Opus R4's additional census request is satisfied without relaxing the selector.
  The [follow-on probe](../../.logs/bounded-storage-lifecycle/snapshot-prefix-cardinality-02/attempt-02/probe.test.ts)
  exercises actual adoption and a once-only test-boundary failure before native
  completion, preserving the original quarantine/receipt identities. The
  [retry observation](../../.logs/bounded-storage-lifecycle/snapshot-prefix-cardinality-02/attempt-02/retry.json)
  contains one open row after failure and the same key, digest and incarnation
  verified after genuine retry. Both snapshot encodings have the same digest.
  The [adoption observation](../../.logs/bounded-storage-lifecycle/snapshot-prefix-cardinality-02/attempt-02/successful-adoption.json)
  leaves the selected row unchanged and activates creator epoch one.

The changed-manifest same-binding retry hypothesized by Opus is not supported by
those observations or `creator-close.ts`: failure resets `closeTask`, retains
`stagedSnapshot`, and leaves the binding sealed. Post-adoption release is the
separate path that clears that snapshot. This does not prove uniqueness under
process death, a new binding or arbitrary damage. Such ambiguity continues to
refuse; the fixture does not acquire authority to choose among competing rows.
Root rehashed all recorded source/dist inputs, checked the exact stdout evidence
and successful cleanup, and found no surviving probe process. The initial
[non-intercepting probe attempt](../../.logs/bounded-storage-lifecycle/snapshot-prefix-cardinality-02/status.json)
is preserved as a test-setup failure: its public-subpath mock never fired, so its
successful close is not evidence of interrupted completion. The corrected probe
uses the actual built-module interception already used by the room fixture.

These final clarifications do not change the reviewed API, authority boundary,
schema, selection law, limits or compatibility behavior. They resolve the review
findings at the same seam; no reviewer is represented as having approved the
post-review wording. Separate RED review must inspect the resulting actual
oracles and extraction before GREEN. The exact profile record, source-only
tripwires, genuine retention setup, missing-source noncreation, room-floor
ordering and causal RED-pass/RED-fail separation are explicit RED acceptance
conditions, not deferred implementation discretion.

Optional descriptor ordering, named room-level test ownership and built-declaration
typecheck limits are clarified in the contract. Native strict durability must not
be weakened for the patched IndexedDB fixture. Existing tsconfig-discovery noise
remains separately reported; it is neither a new compiler pass nor a new product
failure. The folder-style suggestion does not affect the single owner and remains
optional. Native integration and whole-storage boundedness remain unaccepted.

### RED extraction and resolution findings

The separate RED author exposed a shared-copier extraction constraint. Root
authorized the unchanged combined `transferDatabase` as a temporary third
test-only helper export, preserving AHE behavior without importing the room
runtime into focused tests. Its removal condition is explicit in the contract:
GREEN returns the AHE-only function to the room and deletes the temporary export
and all snapshot-copy capability. Diagnostic spans must bracket real work;
transfer now includes declaration selection, while local lookup keeps its own
declaration span.

Initial focused test/typecheck attempts then failed on missing public package
resolution before causal assertions. The root test package had neither declared
dependencies nor root links for the three required workspace packages. Package
exports and adapter-local links did not establish root-fixture resolution, so
the earlier review feasibility statements were incomplete on that point. These
attempts are setup failures, not accepted RED evidence.

Root authorized matching development dependencies and root lockfile links for
the three actual test consumers, with normal offline linking and install scripts
disabled. Separate Vite/TypeScript aliases to private built paths were rejected
as duplicate resolution configuration. Actual public-import/module identity and
focused compilation must pass before any causal RED freeze. The contract records
this test-dependency amendment; no production API, limits or receipt authority
change is authorized.

Offline frozen linking completed with scripts disabled and no build. Root
independently checked ESM resolution from both test and adapter consumers: each
selects the same built receipt module. The extracted copier, declaration selector
and their small utility functions emit identical JavaScript to the archived
pre-extraction bodies; the selector's type annotation no longer imports the room
runtime. The resolved draft run reaches causal assertions, including the old
owned-source refusal and destination-accounting overwrite. These observations
do not accept the unfinished RED freeze.

A separate read-only draft audit found test-oracle gaps before external review.
The completion observer must preserve the native return value. Incarnation-race
injection must follow observed source capture, not assume destination-factory
ordering. Bounded-read evidence must include index operations, exact-prefix and
ambiguity traversal, and transfer/reuse paths; scope identity and transaction
ordering need independent controls. The RED author owns these corrections and
their reruns. No production repair or GREEN authorization follows from draft
test failures.

Review custody must include preexisting untracked fixtures and actual built
dependencies, not just tracked source. The author's initial tracked-only baseline
was complete within its stated roster but did not cover those additional inputs.
A later expanded enumeration exceeded its output buffer; those run results remain
behavioral evidence with limited custody, not a full-input freeze. Corrected
enumeration checks command failure and captures scoped untracked files plus built
artifacts. The `final-02` gate runs in the
[RED evidence directory](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-01/)
have matching before/after/current hashes across their complete recorded rosters.
Root also independently rehashed the earlier pre-extraction prefix-probe custody:
its built dependencies and selected existing owner fixtures are unchanged. The
review packet must use the corrected evidence and preserve these limitations.

### RED freeze: scoped Codex review

The [public review](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-codex-review-01/stdout.log)
completed naturally with unchanged recorded source inputs; its
[terminal record](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-codex-review-01/status.json)
reports no remaining owned processes. Root confirmed both findings against the
accepted contract and frozen tests. Neither finding changes the contract:

- Descriptor damage currently tests a null field, not a well-formed descriptor
  that disagrees with the decoded manifest. Shape validation alone could pass
  without enforcing agreement. Add independent descriptor and applicable summary
  metadata mismatch controls.
- Source schema refusal currently exercises v1, not an unsupported v2 layout.
  A version-only check could pass without validating the supported schema. Add
  raw v2 layout mismatch controls and verify refusal without source mutation.

The first RED freeze is therefore not accepted. Corrections belong to the
separate RED author, with new immutable verification evidence; the old freeze
must not be rewritten. Grok, Kimi and Opus RED reviews have not run, and this
Codex review is not a substitute for them. GREEN remains unauthorized.

### Corrective RED: independent reviews and verification scope

The [corrected freeze](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-02/freeze.json)
adds metadata-agreement and unsupported-v2-schema controls without repairing the
helper. Root verified that only the focused test changed and that the final
commands, outputs and recorded input rosters match. The original freeze remains
rejected evidence, not an approval rewritten after correction.

[Grok](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-01/run-grok/public.txt)
and [Kimi](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-01/run-kimi/public.txt)
returned qualified RED approvals with no required corrections. Both finished
naturally with exact input custody and no tool attempts; Kimi used one assistant
step. Their approvals cover the reviewed RED source, not GREEN behavior or
exhaustive oracle coverage.

Opus's terminal text requested changes, but its CLI compacted the supplied
context and inserted a synthetic continuation. The initial terminal parser
missed that boundary change. Root's
[qualification correction](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-root-audit-01/opus-qualification.json)
therefore classifies the run as **NO_VERDICT**, preserving both the original
terminal record and the separately identified public fragment. No private
thinking or generated summary is used as evidence. Fresh review controls reject
compaction and synthetic continuation. The subsequent qualified review is
dispositioned below; it does not rehabilitate this first run.

Root independently checked the concrete verification findings from that
[public fragment](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-root-audit-01/opus-public-fragment-before-compaction.txt):

- Full helper/room/test lint and formatting already passed in the first freeze,
  whose unchanged files remain hash-identical. The corrective packet omitted
  those earlier commands and showed only the changed-test checks. A new
  [full scoped rerun](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-room-diagnostics-01/summary.json)
  removes that evidence ambiguity; it does not suppress existing warnings.
- The browser package's existing diagnostics do not cover the root room graph.
  The [separate compiler comparison](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-room-diagnostics-01/comparison.json)
  checks archived room bytes at the original path against current bytes with
  identical current resolution and strict root settings. Both graphs retain the
  same diagnostics; adding the new room test introduces none. Unresolved imports,
  ambient ancestor types and existing target/brand errors limit this evidence:
  it is not a clean room typecheck or proof of full type safety. The durable
  focused project stays narrow.

Optional observations remain bounded claims, not reasons to weaken the contract.
The old scope-key mismatch control rejects through an incidental chunk join; it
is not standalone proof of explicit key/row comparison. Reuse assertions are
preceded by traversal guards, so the old failure alone does not isolate every
reuse defect. Additional single-state, argument-variant and direct connection
closure controls would strengthen coverage; their absence is not evidence those
behaviors work. GREEN still must enforce the full source contract and preserve
decoder descriptors, with code review as well as the frozen tests.

Requiring a post-replacement chunk result in the incarnation test would exclude
a correct reader that rejects during its header recheck before fetching payload.
The observed capture, committed replacement and refusal remain the appropriate
ordering boundary. Room refusal remains paired with floor non-advance and genuine
positive room controls. Prefix censuses remain samples, not universal uniqueness
or process-death evidence. The broader package's diagnostic set is unchanged but
its recorded pnpm exit status differs from the historical run; neither an
improvement nor a new failure cause is inferred from that difference alone.

### Qualified Opus correction: verified state is independent of uniqueness

The [fresh Opus review](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-02/run-opus/public.txt)
returned **CHANGES_REQUIRED / RED_READY: NO**. Root checked natural successful
termination, exact input custody, no tool invocation, no synthetic continuation
or compaction, and no surviving review process. This is a qualified verdict,
unlike the first run. Its acceptance of existing causal controls does not make
the RED freeze accepted.

Root accepts the missing lone-unverified-candidate discriminator as required.
The selector must independently enforce candidate uniqueness and verified state;
a test with a second candidate cannot protect the latter during the planned
refactor. The recorded genuine pre-complete failure leaves a lone open row,
making this an observed producer state, not merely speculative hardening. The
separate RED author must freeze lone open/poisoned refusal controls against the
old implementation before GREEN. These are expected RED-pass controls, not new
reasons to manufacture failures or alter the implementation.

The second required finding is resolved by the preceding explicit record of the
unexplained package exit-status difference. Diagnostic equality is not identical
process status, a passing gate, or evidence of an improvement. That disposition
must accompany the next review evidence.

Optional direct connection-close and refusal-side-effect checks remain useful
coverage improvements, not permission to impose a blanket no-destination-creation
rule: native admission may legitimately create a destination or leave partial
temporary content before failure. Stored/decoded scope disagreement and local
already-suffixed names are existing contract obligations; the RED author may add
bounded causal controls without changing those obligations. No changes-required
verdict is relabeled as approval, and GREEN remains unauthorized pending the
correction and its review.

The [new RED freeze](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-03/freeze.json)
adds lone-state refusal on both paths, coherent stored-row/manifest anchor
disagreement, and local suffixed-name non-creation controls. Root checked the
insertion-only diff, unchanged original test outcomes and first failure messages,
actual new assertion failures, frozen copies, gate artifacts and all current
gate input rosters. The original expectations remain intact. Strict focused
types and full scoped style checks pass, retaining existing room lint warnings.
The new refusal controls pass the old verified-only selector; the identity/name
controls fail for the expected old behavior. This qualifies the correction for
review, not RED acceptance.

The next [independent review packet](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-03/selection-manifest.json)
binds the corrected source and explicitly labels inherited consumer/compiler
checks historical. Kimi's attempt exited zero with an
empty event stream and a stack-overflow error in stderr; its
[terminal record](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-03/run-kimi/terminal.json)
is **NO_VERDICT**, never approval. The local argv transport probe proves only
that the operating system accepts the arguments, not successful CLI processing
or provider context capacity. Preserve that failed attempt while diagnosing the
missing review.

### Corrected-freeze review dispositions

[Opus](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-03/run-opus/public.txt)
approved the corrected RED. [Grok](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-03/run-grok/public.txt)
requested changes to the incarnation-race oracle. Both reviews terminated
naturally with exact custody, no tools, no compaction or continuation, and no
remaining processes. Root preserves those distinct raw verdicts.

Root rejects Grok's proposed single-transaction counterexample as outside the
contract, rather than changing the refusal expectation. The
[observer](../../tests/grid-snapshot-content-delivery-red.test.ts) synchronously
queues a scopes write transaction when it exposes the initially selected header.
The installed IndexedDB scheduler appends transactions at creation and blocks a
later overlapping readonly transaction behind that earlier write. This test has
a fresh destination: the [stream owner](../../packages/compaction/src/snapshot-stream.ts)
awaits the destination read before requesting missing source content. The
contract forbids holding a source transaction across that destination work.
Consequently the later chunk/header transaction sees the replacement. Rejecting
at header recheck before returning chunk bytes is valid; demanding a chunk result
would exclude that implementation. Merely labeling settlement after awaiting the
mutation does not prove this ordering—the injected queue order and owner paths do.
The old copier's missing post-capture chunk event reflects its eager staging,
not proof that a compliant single-transaction reader can evade the queued write.

This is bounded fixture telemetry, not universal concurrency coverage. The
observer covers the selected store/index result methods; an unobserved future
API such as `getAllRecords` would need its own instrumentation assessment. That
limitation does not establish Grok's stated counterexample. Its optional refusal
classification and partial-reuse checks, and Opus's optional cancellation/floor
checks, remain coverage limits to inspect in GREEN. In particular the contract
still forbids compensating cancellation even where the existing refusal oracle
does not directly discriminate it. No frozen expectation is weakened.

The [Kimi diagnostic](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-kimi-diagnostic-01/stack-conclusion.json)
reproduces the stack failure on help-only full-size arguments, including equal-size
ASCII; shorter arguments print normal help. This supports a size-sensitive local
CLI startup failure, not a measured model context limit. Tested stack flags did
not establish a workaround. Root authorized a
[fresh packet](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-04/selection-manifest.json)
that retains every current source selection and all raw compiler errors, while
explicitly omitting duplicate structured diagnostics, superseded style logs and
unchanged surrounding historical room code. The historical excerpts cover every
changed old-side region of the complete extraction diff. Root reconstructed the
packet byte-for-byte and verified both exact-argv transport and help processing.
Neither probe is a review or provider-capacity claim. The new Kimi review is
complete as recorded below; earlier failed attempts remain disqualified.

### RED acceptance and distinct GREEN boundary

The [fresh Kimi review](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-red-reviews-04/run-kimi/public.txt)
approved the corrected RED with no required corrections. Root checked one
assistant step, natural successful exit, exact custody, no tools or step-cap
violation, and no surviving process. Its optional identity-attribution and
local-factory telemetry suggestions remain coverage limits; the source contract
still prohibits local lookup from opening the native factory.

Root accepts the corrected RED freeze after that approval, Opus's qualified
approval and the preceding disposition of Grok's required finding. This is
disposition-based acceptance, not unanimous raw approval. The distinct GREEN
author may now replace the helper and remove the snapshot-copy branch while
preserving all frozen tests. GREEN must prove the complete contract through
implementation inspection and the required current helper/consumer gates, then
receive its own reviews. No GREEN behavior, product pinning or full bounded
storage lifecycle is accepted by this RED checkpoint.

### Initial distinct GREEN checkpoint — review pending

Root implemented the bounded source reader and native destination delivery;
the snapshot image copier and old declaration selector no longer exist.
The AHE-only copy remains room-owned. Decoder consumption requires the root
test package to declare its direct protocol workspace dependency, just as the
receipt and adapter consumers declare theirs; no private alias or production
export was introduced.

The [initial GREEN audit](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-01/audit-initial.json)
records terminal current gates with exact before/after source custody:
74 frozen helper tests, 30 unchanged integration tests (including the ordinary
grid64, fresh-device and transition cases), and 8 diagnostic-entry tests pass.
Strict focused typecheck and formatting pass; lint exits zero with 30 room
JSDoc warnings. The broader browser package typecheck still fails with the same
76 diagnostic lines as the recorded RED baseline. Snapshot owner/retention
sources and tests remain byte-identical; this preservation audit is not a fresh
native-browser run.

The first implementation's missing protocol dependency and callback lint errors
remain in their original logs; corrected gates supersede them without erasing
them. Both frozen test files retain their accepted hashes. Vite's archived
tsconfig-resolution warnings remain visible in test stderr, not suppressed.
No producer pinning, retention policy, floor ordering or workload limit changed.

This is not GREEN acceptance. Remaining work is the full source/contract audit,
scoped Codex second opinion, requested Grok/Kimi/Opus GREEN reviews and root
dispositions, plus any resulting fixes and verification. The separate product
retention RED and all later storage-lifecycle obligations remain open.

The [source audit](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-01/source-audit.json)
confirms exact AHE-body preservation after the named snapshot branch removal,
the two-export boundary, shared ESM receipt-owner resolution, and only the
required direct protocol dependency addition. A misplaced room-head comment
was returned to its original function; the initial runtime gates predate that
comment-only correction. Root's refactor-clean inspection leaves one readonly
source selector and native destination ownership, with no snapshot copier fallback.

The [scoped Codex review](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-codex-review-01/stdout.log)
found no actionable bug or regression. Its terminal record shows natural zero
exit, exact source/control custody, no timeout or cleanup, and no surviving
process. It explicitly leaves native-browser crash/physical durability and the
broader storage lifecycle unverified. This second opinion does not replace the
requested Grok, Kimi and Opus GREEN reviews.

The [current gate audit](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-01/audit-current.json)
supersedes the initial checkpoint for the comment-corrected source. Helper,
integration and diagnostic tests again pass (74/30/8), as do focused typecheck,
formatting and lint (zero errors, 28 warnings). Package typecheck retains the
same 76 diagnostic lines. The separate
[room comparison](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-room-diagnostics-01/comparison.json)
checks accepted RED and GREEN under identical current compiler options and
dependency resolution, overriding both archived helper and room at their
original paths for the baseline. All three programs report 28 diagnostics;
file/code/message multisets show no additions or removals. These remain compiler
failures, not a claim that the broad room graph is clean.

Fresh native regression runs also pass:
[owner](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-01/owner-native-01/stdout.log)
in Chromium (43 tests), and
[retention](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-01/retention-native-01/stdout.log)
in Chromium, Firefox and WebKit (168 tests). They exercise existing native owner
contracts; they do not turn the patched IndexedDB fixture into a browser crash
or product retention proof. Every recorded gate has terminal status and unchanged
before/after source custody. The next action is freezing this GREEN evidence
and obtaining the requested three independent reviews, not acceptance or producer
pinning.

## 1b-0 GREEN review and corrective RED pickup

The [first GREEN freeze](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-01/freeze.json)
received qualified, naturally terminal approvals from
[Grok](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-reviews-01/run-grok/terminal.json),
[Kimi](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-reviews-01/run-kimi/terminal.json)
and [Opus](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-green-reviews-01/run-opus/terminal.json).
Their raw verdicts remain unchanged. Review readiness is not root acceptance.

Root's final [prefix diagnostic](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-audit-01/result.json)
reproduces a contract failure in both public helper APIs: a genuine verified row
and a raw array-anchor row share the requested object/epoch, yet selection
resolves successfully. The array sentinel used as the upper key bound excludes
valid IndexedDB keys with array-valued anchor components. Supported schema
admission does not universally validate persisted anchor types, so malformed
rows cannot be ignored when proving prefix uniqueness. The separate RED author
independently confirmed the gap. This diagnostic is patched-IndexedDB evidence,
not a frozen normative test or a browser durability result.

GREEN remains unaccepted. The next step is separate-author corrective RED
coverage preserving every existing test body and historical artifact, followed
by the requested review and corrective GREEN gates. No implementation repair
has been made on the strength of the diagnostic alone. Exact prefix coverage
must not broaden into neighboring numeric epochs.

The separate author's append-only
[corrective RED run](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-red-01/focused-final/results.json)
has 77 passes and five causal failures: all original 74 cases pass, four new
array-anchor refusals fail, and the negative-zero caller control exposes a
distinct decoded-declaration mismatch (`-0` returned instead of manifest `0`).
The contract already requires constructing the fresh declaration from decoded
fields. Fractional-neighbor, zero and maximum-safe-epoch controls pass. Focused
strict typecheck, lint and format exit zero in the same evidence directory.
This supersedes the predicted four-failure outcome without weakening a test;
the subsequent freeze audit and review are recorded below.

Packet clarification: the ESM resolution audit establishes shared built receipt
ownership. Vite retains its existing source aliases for the protocol decoder
and snapshot stream; their source, built artifacts and Vite configuration were
supplied to reviewers. The packet's blanket description of built modules as
runtime-resolved was too broad for those aliases. This does not change the
receipt identity evidence. Broader package compiler failures remain failures.

The [corrective RED disposition](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-red-reviews-01/root-disposition.json)
accepts the append-only freeze after qualified Grok, Kimi and Opus approvals.
All three runs exited naturally with exact input/control custody, no tool use,
no forced cleanup and no surviving processes. Optional deeper-array telemetry
and explicit zero-sign assertions do not require changing the frozen tests;
the implementation must close the full key class, not only the sample anchors.
The selection-before-admission boundary remains unchanged.

Root's separate corrective GREEN replaces the finite suffix sentinel with an
exclusive next-representable-epoch bound and constructs scope identity from the
decoded manifest. This keeps every suffix type inside the exact prefix while
excluding numeric neighbors, including fractional keys. No owner, room consumer,
test body, budget or protocol limit changed. The
[focused run](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-green-01/focused-01/results.json)
passes all 82 frozen cases; strict focused types, lint and format also pass in
that evidence directory. The unchanged
[integration gate](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-green-01/integration-01/results.json)
passes all 30 cases, and the diagnostic consumer passes eight. That diagnostic
run is evidence for the shared worktree: its earlier memory-diagnostic changes
are outside the accepted storage/content-delivery commit boundary. It is not
standalone coverage supplied by that checkpoint. Broader package
typecheck still fails with the exact same 76 diagnostic lines as the first GREEN
checkpoint. No diagnostic or workload limit was changed.

The [scoped Codex second opinion](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-green-codex-01/stdout.log)
found no actionable defect. It exited naturally with exact source/control
custody, no forced cleanup and no remaining processes. The requested independent
GREEN reviews remain pending; this is not GREEN acceptance. Earlier native owner
and retention runs remain historical regression evidence for unchanged owners,
not fresh browser evidence for this helper-only correction.

### 1b-0 acceptance

The [final corrective GREEN disposition](../../.logs/bounded-storage-lifecycle/fixture-content-delivery-prefix-green-reviews-01/root-disposition.json)
accepts fixture content delivery after qualified Grok, Kimi and Opus approvals
and root's final contract audit. Each run exited naturally with exact source and
control custody, no tool invocation, no forced cleanup and no surviving process.
The current implementation and all frozen oracles remain unchanged by review.

Kimi's optional suggestion to remove zero normalization is rejected: incrementing
the negative-zero bit pattern produces negative, not positive, minimum subnormal
value. Opus independently identifies that normalization as necessary. The
optional private-helper guard and cast cleanup are not needed under the validated
entry points and decoder contract. Raw opinions remain unmodified; the root
disposition records these distinctions rather than treating approval as infallible.

Acceptance covers the test fixture's content-delivery prerequisite only. It does
not pin producer or recipient snapshots, establish protected rollback closures,
authorize retirement, fix broader compiler debt, or prove native durability and
long-running storage boundedness. The next checkpoint is the dependency-complete
commit audit, followed by the separately reviewed producer pre-sign retention
contract. The earlier native retention failure remains frozen and unaccepted.

### Accepted foundations checkpoint

The [source/index audit](../../.logs/bounded-storage-lifecycle/accepted-checkpoint-01/source-index-audit.json)
matches every selected source and test to the accepted corrective GREEN custody.
Storage ownership, bounded retention, their legacy fixtures and strict projects,
and content delivery travel together. The shared browser conformance test stages
only the accepted schema expectations; its earlier mixed-expiry diagnostic stays
in the worktree. Memory diagnostics, native product experiments, generated build
output and bulk evidence logs are outside this checkpoint. Native integration
RED remains preserved locally, not shipped as part of these accepted foundations.

The [checkpoint regression](../../.logs/bounded-storage-lifecycle/accepted-checkpoint-01/tests.json)
passes 202 tests covering content delivery and room refusal, Node ownership,
shared retention and native Node retention. Both named strict TypeScript projects
and scoped owner/helper lint pass in the same evidence directory. These are
shared-worktree regression runs, not an isolated clean-install certification or
a fresh cross-browser run. Existing broader compiler failures remain open.
The earlier independent RED/GREEN reviews and their explicit dispositions remain
the acceptance authority; this audit changes packaging, not implementation or
frozen oracles. Producer retention is the next contract, not part of this GREEN.
