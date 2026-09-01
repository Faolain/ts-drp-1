# D.109e — Browser Cleanup Scheduling

## Entry and scope

D.109e begins only after signed/pushed D.109d closure
`1661092621afd010c1729caf3f1de3772c80ff92`. D.109a–D.109d and their
evidence remain accepted and are not reopened.

This slice extracts the advisory Web-Lock runner currently embedded in the
Phase-5c vote dispatcher into one package-internal primary-dispatch primitive,
migrates the vote dispatcher to that exact primitive, and invokes the existing
browser AHE reclamation state machine through it. It changes no cleanup
eligibility rule, transaction, receipt, durable schema, public API, dependency,
workload, threshold, wire/digest/QC/adoption/availability contract, or runtime
reclamation behavior. No retained campaign runs.

## Frozen ownership

Production owners:

1. `packages/storage-browser/src/internal/primary-dispatch.ts` — sole owner of
   advisory lock-name encoding, LockManager capability detection, the existing
   250 ms acquisition timeout, receiver-preserving `request` invocation, and
   exactly-once unelected fallback;
2. `packages/storage-browser/src/internal/seal-vote-dispatch.ts` — retains vote
   queue serialization, concurrency four, durable pending-row scans, exact-byte
   publication, dispatched marking, overflow, and close behavior, but delegates
   only the advisory lease/fallback step;
3. `packages/storage-browser/src/internal/ahe-reclamation.ts` — captures the
   cleanup request before scheduling and runs the unchanged owner-local
   reclamation transaction inside the shared primitive;
4. `packages/storage-browser/src/internal/idb-adapter.ts` — passes the exact
   database identity already captured by `createBrowserAheDurableStore` into
   the identity-bound maintenance owner.

Tests-only owners:

1. `packages/storage-browser/tests/assets/phase-6b-ahe-reclamation-entry.ts` —
   adds deterministic scheduling controls around the genuine browser store and
   maintenance capability;
2. `packages/storage-browser/tests/phase-6b-browser-scheduling-red.pw.ts` — owns
   the closed mode, takeover, stale-holder, lifecycle, and changed-precondition
   matrix;
3. `packages/storage-browser/playwright.phase-6b-browser-scheduling.config.ts`
   — selects exactly that test with one worker, no retries, and Chromium,
   Firefox, and WebKit projects; and
4. this slice, the Phase-6b README, and the production-hardening plan as
   evidence documents.

No package export or root export may expose the primitive, its identities, or a
lease handle. No product caller can select a lock alias, timeout, or deletion
decision.

## Shared primitive contract

The primitive accepts an owner-local storage identity and an asynchronous task.
It returns that task's result or failure. It does not inspect, classify,
authorize, retry, or transform the task.

The lock name is one injective UTF-8-length-framed encoding owned only by the
new primitive. The Phase-5c vote caller supplies its frozen `seal-vote:v2`
identity, preserving byte-for-byte
`ts-drp:seal-vote:v2:<utf8-database-name-length>:<database-name>`. Browser AHE
reclamation supplies a disjoint versioned `ahe-reclamation:v1` identity over
the exact database name already owned by the adapter. The browser origin and
default storage bucket remain native LockManager scope. This slice invents no
caller bucket token, epoch, room namespace, or public alias.

The existing Phase-5c behavior remains exact:

- a callable LockManager receives `{ ifAvailable: true, mode: "exclusive" }`
  with its original receiver;
- a granted lock invokes the task once;
- disabled/absent Locks, a missing or non-callable `request`, synchronous
  throw, rejected or aborted acquisition, an unavailable `null` lock, or an
  acquisition that does not settle within 250 ms invokes the same task
  unelected exactly once;
- a grant or rejection arriving after fallback does not invoke the task again;
- task failures remain task failures and are never converted into a successful
  lease result; and
- the timer is cleared on every terminal path.

The primitive owns no volatile work queue. Vote-key deduplication, durable
reread, concurrency and overflow remain in the vote dispatcher. Browser AHE
reclamation remains serialized by its existing recovery-turn lifecycle and
strict IndexedDB transaction.

## Cleanup authority boundary

`reclaimClosedEpoch(input)` captures and validates a detached request before
the advisory scheduling boundary. The granted or unelected callback then
starts the existing lifecycle operation, reacquires the existing recovery
turn, loads the current raw database snapshot, re-runs
`classifyAheReclamation`, performs the existing strict transaction, validates
the post-state, and returns the existing immutable receipt.

The lease carries no QC, adoption, head, lineage, availability, issuance,
closure, row, or receipt fact. It cannot suppress the owner-local recheck. If
the head or any cleanup precondition changes while the task is waiting, the
existing exact `AHE_RECLAMATION_RETRY_REQUIRED` refusal commits zero cleanup
writes. If close or `versionchange` retires the owner before callback entry,
the existing exact `AHE_RECLAMATION_STORE_CLOSED` refusal commits zero cleanup
writes. A successor facade may reopen and retry the original authenticated
request normally.

Concurrent eligible invocations may both reach the state machine when election
is unavailable. Owner-local serialization and transactional recheck determine
one deleting receipt and one replay receipt; election is never a safety fence.

## Deterministic RED matrix

The tests-only RED first proves its exact owner roster and that the new internal
primitive is absent. All behavioral cases remain readiness-gated until that
sole production seam exists; RED must fail only with
`D109E_PRIMARY_DISPATCH_MISSING` after its independent fixture/source controls
pass.

For an isolated genuine five-generation browser lineage whose eligible prefix
is generations 1 and 2, freeze these cases:

| Case                                           | Expected cleanup observation                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| granted/native when available                  | exact AHE lock name and exact two-generation deletion receipt                        |
| explicitly unelected/off                       | same exact deletion receipt                                                          |
| Locks absent                                   | same exact deletion receipt                                                          |
| `request` non-callable                         | same exact deletion receipt                                                          |
| synchronous throw                              | same exact deletion receipt                                                          |
| rejected acquisition                           | same exact deletion receipt                                                          |
| aborted acquisition                            | same exact deletion receipt                                                          |
| callback receives no lock                      | same exact deletion receipt                                                          |
| acquisition never settles                      | fallback after the frozen timeout, one exact deletion receipt                        |
| stale late grant after fallback                | no second task entry; one deletion receipt only                                      |
| two same-context tabs                          | combined receipts delete the same exact prefix once and replay once                  |
| primary closes before delayed grant            | exact closed refusal, zero writes; successor takes over and deletes the exact prefix |
| `versionchange` closes before delayed grant    | exact closed refusal, zero writes; reopened successor deletes the exact prefix       |
| head/precondition changes before delayed grant | exact retry-required refusal and zero cleanup deletion                               |

Every injected callable LockManager records the complete name passed by the
production runner. The positive cleanup path must observe exactly
`ts-drp:ahe-reclamation:v1:<utf8-database-name-length>:<database-name>`; this
behavioral check prevents unelected fallback from hiding a wrong or colliding
cleanup identity. GREEN evidence also records whether each engine exposes a
native LockManager; native absence is an expected capability observation, not a
substitute for the deterministic injected-grant control.

The changed-precondition case does not reuse the older request-only
`head-different` mutant. While the production callback is delayed, it creates a
lawful generation 6 and successfully swaps the genuine store head from
generation 5/revision 5 to generation 6/revision 6. The fixture must read back
and assert that new head before releasing the callback, capture the raw database
image after that swap, then require exact `AHE_RECLAMATION_RETRY_REQUIRED` and a
byte-identical image after the refused cleanup. This makes the head mismatch,
not an unrelated extra-row rule, the causal refusal and proves the lease cannot
hide a partial delete. The stale-holder case releases the original callback
after the timeout fallback has completed and counts entries into the inner AHE
transaction/observer path; the outer `reclaimClosedEpoch` call itself is not the
entry counter.

Source-shape controls require:

- within `packages/storage-browser/src/internal/`, exactly one runtime owner of
  `Reflect.get(navigator, "locks")`, `LOCK_TIMEOUT_MILLISECONDS = 250`,
  `{ ifAvailable: true, mode: "exclusive" }`, exactly-once fallback, and lock-
  name framing: `primary-dispatch.ts`;
- the unchanged package-local `seal-vote-test-control.ts` and D.109e browser
  asset may still replace or inspect `navigator.locks` only to inject the
  frozen test modes; neither is counted as a runtime runner;
- the timeout check is identifier- and owner-bound; it must not count the
  separate `PHASE_5C_BLOCKED_OPEN_TIMEOUT_MILLISECONDS` in `schema-idb.ts`, a
  bare `250`, or legitimate LockManager owners in other packages/examples;
- both consumers invoke the same internal primitive;
- the Phase-5c lock name remains exact;
- the AHE callback still enters `classifyAheReclamation` inside its strict
  transaction after scheduling;
- no duplicate fallback/timeout implementation remains in either consumer;
- no new export, dependency, schema/version, or public option exists; and
- no scheduling callback receives or returns deletion authority.

Run the focused RED once in Chromium. Accept it only when the selected listing
is exactly one file with no Phase-5c or D.109c retained title, all independent
controls pass, and the complete soft-failure set is only the frozen missing-
primitive readiness token. Sign and push RED evidence without a separate model
review.

## GREEN and retained gates

GREEN implements only the four frozen production owners and wakes the exact RED
without changing its matrix. Run:

1. the focused D.109e Chromium test;
2. the complete D.109e test in Chromium, Firefox, and WebKit;
3. the retained Phase-5c nine-test suite in all configured engines;
4. the retained D.109c four-test Chromium suite;
5. the storage-browser build and whole-package typecheck, recording only exact
   inherited configuration/test-root debt if the latter is nonzero;
6. exact-owner ESLint, Prettier, `git diff --check`, package-export and source-
   shape gates; and
7. changed-path, source-hash, protected-untracked-path, 26-stash, process, port,
   signed-commit, pushed-ref, and self-excluding evidence-manifest checks.

If any mode yields a different eligible set, an unexpected error code, more
than one stale-holder task entry, a late commit after close/versionchange, a
Phase-5c lock-name change, or a product-source path outside the frozen four,
stop and diagnose rather than folding in more behavior.

After signed/pushed GREEN, run one formal Grok 4.6/high, standard Kimi CLI
K3/high/100-step, and Opus xhigh review over plan → RED → GREEN. This slice
receives the high-risk plan and final reviews because it moves a browser
scheduling/timing owner around deletion work and must prove that the lease does
not become authority. Only P0/P1 findings block. At most one correction and one
confirmation are permitted under the governing review policy; documentation-
only closure prose does not recurse. Do not invoke Fable, Codex Sol, or
collaboration subagents.

## RED acceptance

The tests-only RED is signed against the six-test, one-file Chromium listing.
Its sole execution produced exactly one passing independent owner/source-shape
control, one unexpected result carrying only
`D109E_PRIMARY_DISPATCH_MISSING`, four readiness skips, zero flaky results, and
zero top-level errors. The missing owner was exactly
`src/internal/primary-dispatch.ts`; no retained Phase-5c or D.109c title was
selected. The genuine behavioral fixtures remained unexecuted, so RED did not
change or probe production behavior before the causal seam exists.

Evidence is rooted at `.logs/phase-6b-d109e-red/`. Exact-owner ESLint,
Prettier, bundle construction, `git diff --check`, and listing controls passed.
The whole-package `tsc --noEmit` remained nonzero only on the already-recorded
test-root alias and branded fixture values, including the unchanged companion
worker; it found no production-source regression and is retained honestly for
GREEN classification. No model review or retained campaign ran.

## GREEN implementation checkpoint

GREEN adds only the four frozen production owners. The new internal primitive
owns the exact UTF-8-framed lock name, receiver-preserving request, exclusive
`ifAvailable` acquisition, 250 ms fallback, and single task promise. The vote
dispatcher delegates only that advisory step. AHE captures its request first,
then invokes its unchanged lifecycle entry, recovery turn, classification,
strict transaction, post-state check, and receipt inside the task. The adapter
passes the exact database name it already owns. No package export, dependency,
schema, threshold, or public option changed.

The final executable gates passed:

- focused Chromium D.109e: 6/6;
- complete Chromium/Firefox/WebKit D.109e: 18/18;
- retained Phase-5c across all engines: 25 passed and the two frozen
  non-Chromium death-test skips, with no unexpected/flaky/top-level error;
- retained D.109c Chromium: 4/4;
- storage-browser build, exact-owner ESLint, Prettier, source/export checks, and
  `git diff --check`: pass; and
- whole-package typecheck: the same tests-root-only alias/branded-fixture debt,
  with zero error in any frozen production owner.

A supplemental, non-frozen default package Vitest sweep was also retained
honestly. It remained nonzero on historical packed-consumer timing gates,
pre-existing stale additive-export snapshots, and the tests-root raw-IDB/type
audit already made nonzero by the D.109c browser assets; its nested clean-copy
test repeated those same failures. No D.109e browser or production assertion
failed. These unrelated results do not authorize timing, export, ownership-
policy, or product changes in this slice.

Evidence is rooted at `.logs/phase-6b-d109e-green/`. The signed/pushed GREEN
head is the input to the sole formal Grok/Kimi/Opus plan → RED → GREEN review;
D.109e remains open until that review has an empty P0/P1 union.

## Final review and single correction

Grok 4.6/high, standard Kimi CLI K3/high/100-step, and Opus xhigh each approved
the signed/pushed GREEN with no P0/P1 and marked D.109e closable. The preserved
union is `.logs/phase-6b-d109e-final-review/review-union.md`.

One Grok P2 exposed a genuine close-preservation detail: the extracted vote
runner still rejected `drain()` on publication failure, but the consumer's
internal `tail` resolved because its catch settled the public promise without
then awaiting it. Before extraction, `tail` awaited the rejected public result,
so `close()` observed that rejection. The single permitted correction restores
the exact `await result` after the catch. It changes no scheduling, work,
threshold, API, or AHE behavior.

After that one-line correction, every frozen executable gate was rerun: focused
Chromium 6/6, all-engine D.109e 18/18, retained Phase-5c 25 plus the two expected
skips, retained D.109c 4/4, build/static gates green, and the same tests-only
typecheck file/class set. Correction evidence is rooted at
`.logs/phase-6b-d109e-green-correction/`. The corrected signed/pushed commit now
receives the one permitted bounded confirmation; no other P2 expands this
slice.

## Exit

D.109e closes only when every lock/lifecycle mode attempts the same eligible
cleanup set or produces its frozen fail-closed refusal, Phase-5c dispatch is
byte-for-byte behaviorally retained through the sole shared primitive, all
gates pass, and the final review has an empty P0/P1 union. Then D.109f becomes
the next active slice.

## Plan review closure

The corrected plan is signed and pushed at
`ea96d97525e34ab907f504dcef9ed2cfa43075fd`. Grok 4.6/high, standard Kimi CLI
K3/high/100-step, and Opus xhigh unanimously confirmed it with no P0/P1 finding
and `D109E_RED_READY: yes`. Evidence is rooted at
`.logs/phase-6b-d109e-plan-confirmation/`; its validating self-excluding
manifest SHA-256 is
`c0f0dbd11bb0250edbbd98bff660f9786a9d240a6508b8cfe3559608532e531c`.
The plan gate is closed and the one authorized Chromium RED may run.
