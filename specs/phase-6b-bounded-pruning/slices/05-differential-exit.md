# D.109f — Differential and Phase-6b Exit

## Inherited checkpoint and purpose

D.109f inherits the signed/pushed D.109e closure
`bb7d4601ac951df28b066e22dba1c096abe287c0`. D.109a through D.109e, their
immutable evidence, and their accepted findings are not reopened. No retained
campaign ran in those slices, and none is authorized here.

This final Phase-6b slice proves that bounded cleanup is observationally
equivalent to archival retention over a deterministic history of at least 100
closed epochs. It closes the finite census, cross-backend parity, raw-
dependency, fresh-process, and inherited P2 obligations already assigned to
D.109f. It changes no threshold, workload contract, wire format, digest,
signature, QC, activation, availability, identity, dependency, public product
API, browser schema, or Node schema.

The only already-demonstrated product defect is narrow: shared AHE input
capture currently accepts an empty `deleteGenerationIds` array paired with a
present `expectedBaseExpectedHead`, allowing the request to reach replay/retry
classification instead of rejecting it as
`AHE_RECLAMATION_INVALID_ARGUMENT`. That request performs no writes and cannot
authorize unsafe deletion, but its input polarity is stale. GREEN may correct
only that shared capture predicate in `packages/storage/src/maintenance.ts`.
If any other production owner must change, stop and reslice before editing it.

## Frozen equivalence oracle

One seeded fixture constructs 128 successive closed epochs for one object,
with deterministic signed/canonical operations, ACL changes, causal
dependencies, accepted and refused operations, snapshot/adoption material,
issued rows, publication state, AHE generation closures, and subsequent live
writes. The count is fixed at 128 so the `>=100` obligation is literal and the
existing 64-row issuance page boundary is crossed twice. Random generation
identifiers are never sorted as chronology; every retained/deleted identity is
derived by walking the verified `baseExpectedHead` lineage.

The fixture drives two replicas from the same copied inputs:

- the archival replica performs every close/adoption transition and retains
  all closed-epoch durable and runtime history; and
- the compacted replica performs the same transition, obtains genuine
  issuance and AHE receipts from the owning maintenance capabilities, then
  invokes the private installed-v3 runtime reclamation owner.

After every epoch, and again after a close/reopen boundary, compare the exact
application-state digest, ACL projection, frontier, accepted/refused operation
counts, current anchor/head identity, live publication result, retained ingress
result, and next local operation result. Expected differences are limited to
the explicitly enumerated closed-history structures and the five already-
frozen D.109d replay-outcome fields. Every comparison is performed from public
or already-existing package/test inspection surfaces; D.109f adds no product
inspection API.

The differential must prove both golden-path shapes without enabling either:

- a Discord-shaped history with membership/ACL churn, concurrent messages,
  offline gaps, and later live writes; and
- an MMORPG-shaped history with dense causally dependent state updates,
  rejected stale inputs, and later live writes.

The oracle fails if either compacted execution or restart can fetch a deleted
issued preimage, AHE blob, displaced runtime source, retired creator-close
graph/snapshot, or old snapshot dependency. Merely comparing final digests is
insufficient.

## Raw-dependency and identity proof

Tests wrap the existing test-owned durable stores and dependency readers before
the 128-epoch run. Each read is classified as current-retained, rollback-1,
rollback-2, intentionally retained metadata/finality, or deleted. A deleted
class read is an immediate `D109F_RAW_DEPENDENCY_READ` failure, including a read
that happens to succeed because the archival replica still owns the bytes.
The compacted replica must complete with zero deleted-class reads.

Receipt custody is identity-specific. The test records the exact genuine
issuance and AHE store facades that minted each receipt and proves copies,
proxies, cross-backend facades, stale receipts, and receipts from another
epoch/object cannot authorize runtime reclamation. Snapshot dependency proof is
live and transitive: after cleanup and after reopen, export a genuine successor
snapshot, import it into a fresh successor, accept one dependency-bearing live
operation, publish it, and read it from the durable live journal. A source-only
substring assertion is only a supplementary control.

## Complete census and inherited debt roster

The test contract owns one sorted, duplicate-free registry of every Phase-6b
enumerated structure. At each selected epoch it records exact archival and
compacted counts/booleans/bytes and classifies every intentional difference.
The registry includes:

- issuance rows, outbox rows by publish state, lineage rows and pruning
  watermark;
- AHE heads, generations by state, promotions, referenced/shared/unreferenced
  blobs, and the active plus two rollback closures;
- installed-v3 application authors/charges/vertices, causality index, blueprint
  state, anchor bytes, graph version, latched operations, pending ingress and
  bytes, quarantine, publication, rebase cursor/source, displaced source, hot
  predecessor, and retained payload metadata;
- creator-close graph, staged snapshot, persisted snapshot, derived commitment,
  and durable replay owners;
- snapshot-quarantine rows/chunks, live-journal rows, and intentionally
  unchanged legacy object/finality state; and
- browser facade keys, package export maps, package-root runtime rosters, and
  maintenance factory/module key sets.

This closes the following inherited findings without changing their original
dispositions:

1. D.109b Node inspection must match asynchronous-rejection behavior across
   ephemeral, Node, and browser maintenance; the present-below-watermark
   corruption polarity is exercised where a native owner can synthesize it;
   and every reachable member of the pruned error, including nested scope, is
   deeply frozen.
2. D.109c rejects the exact empty-delete/present-parent mutant with
   `AHE_RECLAMATION_INVALID_ARGUMENT`, runs a genuine second-process SQLite
   race, and asserts the browser fixture's already-computed `facadeKeys`.
3. D.109d observes actual post-release creator-close values rather than
   constant-filling expected false values; includes the shared Phase-6a fixture
   in changed-owner/source census; proves receipt/store identity; instruments
   raw dependencies; makes snapshot dependency proof lifecycle-live; and runs
   a genuine fresh-process reopen in which no weak predecessor/source handle
   can survive.
4. The stale `activeOwners` repeated-rollover concern is exercised across all
   128 epochs. If it fails, the failure is a new demonstrated product defect
   and D.109f stops for a narrow causal reslice.
5. Historical complete-export assertions are corrected to the exact current
   maps without removing any accepted subpath. The bounded batch owns the
   stale assertions in storage adapter/capacity, Node SQLite contract, browser
   Phase-2d structure/schema, Phase-3a1b live-journal parity, and Phase-4c
   snapshot quarantine. Each test first compares its previous frozen surface
   plus only the already-accepted additive `./maintenance`,
   `./issuance-maintenance`, `./snapshot-transfer`, `./seal-evidence`, and
   `./seal-vote` subpaths applicable to that package.

No census may be satisfied by hard-coded post-state values where the fixture
can inspect the owner. A constant is permitted only for a stable contract
registry and must be compared to a separately observed value.

## Fresh-process and backend matrix

Node runs two fresh child processes against built workspace packages resolved
through explicit build-root-relative file URLs, following the proven Phase-4c
and D.109c child pattern. It never imports stale source aliases or relies on
Vite. The first process creates and partially advances the fixed history; the
second opens the same SQLite files with no inherited JS object or `WeakRef`,
finishes cleanup, exports/imports the live snapshot, and performs the next live
write. A separate two-process contention case holds one native SQLite cleanup
transaction while the other process attempts the same request; exactly one
fresh delete and one replay/retry outcome may occur, with an old XOR complete-
new database image and no mixed state.

Browser runs the same compacted owner matrix in Chromium, Firefox, and WebKit.
It covers native granted ownership, explicit unelected fallback, absent/non-
callable/throw/reject/abort/unavailable/timeout scheduling, takeover after
close/versionchange, and a reopened origin. All modes produce the same eligible
deletion set and final semantic projection. Browser facade keys are asserted,
not merely returned in an attachment. Native capability presence is recorded;
injected deterministic controls remain the cross-engine oracle.

## Deterministic RED

RED is tests/evidence only. It may add exactly these new paths:

1. `tests/fixtures/phase-6b/differential-exit-contract.ts`;
2. `tests/phase-6b-differential-exit-red.test.ts`;
3. `packages/storage-node/tests/fixtures/phase-6b-differential-exit-child.mjs`;
4. `packages/storage-node/tests/phase-6b-differential-exit-red.test.ts`;
5. `packages/storage-browser/tests/assets/phase-6b-differential-exit-entry.ts`;
6. `packages/storage-browser/tests/phase-6b-differential-exit-global-setup.ts`;
7. `packages/storage-browser/tests/phase-6b-differential-exit-red.pw.ts`; and
8. `packages/storage-browser/playwright.phase-6b-differential-exit.config.ts`.

The same tests-only batch may amend the exact historical export-census owners
enumerated above, the existing D.109c Node/browser fixtures for the second-
process and `facadeKeys` assertions, and the D.109d contract/test plus shared
Phase-6a creator-adoption fixture for observed-census and fresh-process hooks.
The evidence ledger must record the exact changed-path roster before execution.

Run one focused non-browser RED command and one Chromium RED command. Controls,
the archival side, export census, and already-correct behavior pass. The exact
complete intended failure set is the single empty-delete/present-parent mutant,
whose expected code is `AHE_RECLAMATION_INVALID_ARGUMENT`; all dependent
compacted differential bodies skip behind the frozen token
`D109F_INVALID_INPUT_POLARITY_MISSING`. Any module-load failure, fixture error,
different code, additional assertion failure, top-level error, flaky result,
or retained title selected by the focused configuration invalidates RED and
must be diagnosed before GREEN. Sign and push the validated RED evidence; do
not run a separate full model RED review.

## Narrow GREEN and gates

GREEN may change only `packages/storage/src/maintenance.ts` to require the
following exact polarity:

- empty deletion list requires an already-normalized no-head floor and remains
  the existing no-write replay/empty success;
- nonempty deletion list requires a present expected former parent; and
- every other pairing throws the existing deeply frozen
  `AHE_RECLAMATION_INVALID_ARGUMENT` before owner dispatch or I/O.

The backend adapters, schemas, transactions, receipts, runtime, snapshot,
browser scheduler, package exports, and public APIs remain byte-identical. If
the 128-epoch differential, repeated rollover, raw-dependency, fresh-process,
or two-process test exposes another product failure, preserve that evidence and
stop for a separately reviewed causal reslice. Do not repair it opportunistically
inside D.109f.

Run, in order:

1. the focused non-browser GREEN command once;
2. the focused Chromium GREEN command once, then the same one-file browser
   selection in Firefox and WebKit;
3. retained D.109a, D.109b, D.109c, D.109d, D.109e, Phase-6a creator close/
   adoption/activation/product, snapshot quarantine, live journal, storage
   schema/capacity, and Phase-5c scheduling tests using exact file/title lists;
4. storage, issuance-store, storage-node, storage-browser, node, object, and
   compaction builds plus source-only typechecks, and bounded whole-package
   typecheck classification where inherited test-root debt remains;
5. exact-owner ESLint, Prettier, `git diff --check`, child syntax, package/root/
   facade/factory census, source-shape, changed-path, protected-untracked,
   26-stash, process/port, signature, and pushed-ref checks; and
6. a self-excluding evidence manifest covering commands, complete reporter
   JSON/stdout/stderr/attachments, child messages and statuses, environment,
   owner hashes, source/ref identity, results, and dispositions.

The focused evidence must state all selected file/test counts, pass/fail/skip/
flaky/top-level counts, the 128-epoch seed and completed epoch count, zero
deleted-class dependency reads, exact census registry coverage, both golden-
path projections, child exit/status chronology, and old XOR complete-new
transaction observations. There is no campaign and no retry loop.

## Review and stop policy

This exit proof covers physical deletion, cross-process recovery, and browser
scheduling, so its plan gets one signed/pushed Grok 4.6/high, standard Kimi CLI
K3/high with both 100-step controls, and Opus xhigh review before RED. The
standard `kimi` invocation is authoritative; Codex Sol is not a substitute. If
Grok cancels, resume the exact session. Only P0/P1 blocks, with one correction
batch and at most one confirmation only if executable scope, causal acceptance,
or a hard gate materially changes.

After signed/pushed GREEN, the sole formal Grok/Kimi/Opus review inspects the
accepted plan, causal RED, complete GREEN, retained behavior, and exit evidence.
Only P0/P1 blocks Phase-6b closure. No Fable, collaboration subagent, separate
RED model round, retained campaign, long campaign, recursive prose review, or
review substitution runs.

Stop before implementation if the plan review shows that the 128-epoch oracle
cannot use existing private/test seams without a product API. Stop during RED
or GREEN on any unexpected causal failure. Stop and reslice before changing any
production file other than `packages/storage/src/maintenance.ts`, or before
changing a schema, dependency, threshold, workload, timeout, wire/digest/QC/
activation/availability/identity contract, browser scheduler, snapshot format,
or legacy object/finality behavior.

## Phase-6b completion condition

Phase 6b closes only when the corrected invalid input rejects before I/O, both
128-epoch archival/compacted golden-path differentials are identical on every
non-pruned observation, the compacted path performs zero deleted-class raw
reads, all owner censuses are complete and bounded, fresh-process and two-
process recovery pass, all three browser engines agree, every named retained
test and static gate is green or has an unchanged explicitly classified
tests-only diagnostic, the evidence manifest validates, and the final
Grok/Kimi/Opus P0/P1 union is empty.
