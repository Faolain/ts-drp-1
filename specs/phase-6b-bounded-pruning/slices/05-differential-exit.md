# D.109f — Differential and Phase-6b Exit

## Inherited checkpoint and purpose

D.109f inherits the signed/pushed D.109e closure
`bb7d4601ac951df28b066e22dba1c096abe287c0`. D.109a through D.109e, their
immutable evidence, and their accepted findings are not reopened. No retained
campaign ran in those slices, and none is authorized here.

This final Phase-6b slice proves bounded cleanup over a deterministic history
of 128 closed-epoch records and proves genuine creator-close/adoption/runtime
behavior through the one transition the current product supports. It closes
the finite census, cross-backend parity, raw-dependency, fresh-process, and
inherited P2 obligations already assigned to D.109f. It changes no threshold,
workload contract, wire format, digest, signature, QC, activation,
availability, identity, dependency, public product API, browser schema, or
Node schema.

Three narrow defects are already demonstrated by source inspection and receive
causal RED assertions:

1. shared AHE input capture accepts an empty `deleteGenerationIds` array with
   a present `expectedBaseExpectedHead` rather than rejecting
   `AHE_RECLAMATION_INVALID_ARGUMENT` before I/O;
2. `DurableIssuanceRecordPrunedError.scope` is detached but not frozen; and
3. Node `inspectPruningState` can throw before returning a Promise, unlike the
   ephemeral and browser maintenance owners.

GREEN may change exactly `packages/storage/src/maintenance.ts`,
`packages/issuance-store/src/maintenance.ts`, and
`packages/storage-node/src/internal/node-issuance-store.ts`. If any other
production owner must change, stop and reslice before editing it.

## Frozen two-level equivalence oracle

The initial plan overstated the available seam. The current creator-close
owner is intentionally epoch-`0` to epoch-`1`, and a snapshot-closed successor
cannot be rebound as a new genesis-active creator. D.109f therefore does not
claim 128 genuine product close/adopt cycles and does not add multi-epoch close
authority.

The long-horizon level is one seeded, 128-step archival-versus-compacted
maintenance differential. It constructs deterministic closed-epoch durable
material through existing test/private fixtures and drives the real D.109a
planner plus genuine D.109b issuance and D.109c AHE maintenance owners. The
archival store retains every generated epoch. The compacted store prunes each
eligible prefix after the two-rollback warm-up. Generation order comes only
from the verified `baseExpectedHead` walk, never identifier sorting. The
fixture publishes at least 65 issued rows in each of two selected epochs so
the existing 64-row page boundary is crossed twice; 128 one-row epochs alone
would not prove that boundary. Generation and journal census walks paginate
past 128 rather than assuming one page.

After every step, compare the exact active head, retained floor and its
normalized parent, planner outcome, receipt range/identity, publication and
watermark state, generation/blob completeness, rollback-1/rollback-2 closure,
and deterministic Discord-shaped and MMORPG-shaped semantic projections.
Expected differences are limited to the enumerated pruned durable structures
and receipt replay fields. The 128-step oracle does not claim to exercise the
installed-v3 `activeOwners` map or application runtime 128 times.

The genuine lifecycle level uses the existing Phase-6a and D.109d fixtures for
one real creator close, verified commit, adoption, durable pruning, receipt-
gated runtime reclamation, reopen, snapshot export/import, and subsequent live
issue/publish/ingress behavior. It compares application-state digest, ACL,
frontier, accepted/refused operations, current anchor/head, publication,
ingress, and the next local operation. It runs both Discord-shaped and MMORPG-
shaped controls without enabling either. Repeated-rollover behavior remains a
future product capability question, not a hidden D.109f acceptance claim.

## Dependency and identity proof

Durable dependency reads and in-memory release observations are separate
proof classes.

- Test-owned genuine issuance, AHE, snapshot, and live-journal owners are
  instrumented in place, preserving the exact identity used by maintenance
  `WeakMap` resolution. Reads are classified from the planner and genuine
  receipt identities as current-retained, rollback-1, rollback-2,
  intentionally retained, or deleted. Any deleted-class durable read fails
  `D109F_RAW_DEPENDENCY_READ`.
- The shared genuine adoption fixture may expose its already-owned undecorated
  AHE backend as a tests-only field. Factory and maintenance resolution must
  load from the same freshly built tree; proxies and source/dist mixing are
  forbidden.
- Displaced runtime source and creator-close graph/snapshot owners are not
  durable readers. Their proof uses the genuine D.109d before/release/second-
  prepare observations plus live rebase/issue/publish behavior. It does not
  pretend that a wrapper intercepted every in-memory access.

Receipt custody remains identity-specific. Copies, proxies, cross-backend
facades, stale receipts, and another object/epoch cannot authorize runtime
reclamation. Snapshot dependency proof is live and transitive: after cleanup
and reopen, export a genuine successor snapshot, import it into a fresh
successor, accept a dependency-bearing operation, publish it, and read it from
the durable live journal. Source-shape assertions are supplementary only.

## Complete census and inherited debt roster

One sorted, duplicate-free registry maps every Phase-6b structure to its proof
kind. Durable structures receive exact archival/compacted counts or bytes.
Installed-v3 and creator-close structures receive owner-observed before/after
presence plus live behavioral reachability; no nonexistent archival numeric
inspection API is implied. Stable package surfaces receive exact key sets.
The registry covers issuance/outbox/lineage/watermark state; AHE heads,
generations, promotions, references and blobs; installed-v3 application,
causality, blueprint, anchor, graph, ingress, publication, rebase, displaced-
source, hot-predecessor and payload owners; creator-close graph/snapshot/
commitment/replay owners; snapshot quarantine; live journal; unchanged legacy
object/finality state; browser facade keys; and package/factory/module maps.

D.109f closes the inherited findings as follows:

1. Make Node inspection reject asynchronously like ephemeral/browser, exercise
   the native present-below-watermark corruption polarity, and deeply freeze
   the pruned error including its nested scope.
2. Reject only empty-delete/present-parent as
   `AHE_RECLAMATION_INVALID_ARGUMENT`; preserve all D.109c mutants and their
   exact codes, including nonempty-delete/no-parent as classify-time
   `AHE_RECLAMATION_RETRY_REQUIRED`. Run a genuine two-process SQLite case and
   assert the browser fixture's existing `facadeKeys` value.
3. Observe actual post-release creator-close values, include the shared
   Phase-6a fixture in the changed-owner census, prove receipt/store identity,
   split durable raw reads from in-memory observations, make snapshot proof
   lifecycle-live, and run a genuine fresh-process reopen with no inherited JS
   object or weak handle.
4. Correct stale complete-export assertions without removing an accepted
   subpath. The exact roster includes
   `packages/storage/tests/adapter-facade-red.test.ts`,
   `packages/storage/tests/phase-2g-a-capacity-red.test.ts`,
   `packages/storage-node/tests/sqlite-contract-red.test.ts`,
   `packages/storage-browser/tests/structural-controls.test.ts`,
   `packages/storage-browser/tests/phase-2d1-decision-schema-red.test.ts`,
   `tests/phase-3a1b-p4-live-journal-parity-governance-red.test.ts`, and the
   package-map assertions in
   `tests/phase-4c-snapshot-quarantine-red.test.ts`. Exact current maps
   retain every already-accepted additive maintenance, issuance-maintenance,
   snapshot-transfer, seal-evidence, and seal-vote subpath.

No census may be satisfied by hard-coded post-state values where an owner can
be observed. A stable contract registry is permitted only when compared with a
separately observed value.

## Fresh-process, process-contention, and browser matrix

Node children import freshly built workspace packages through explicit build-
root-relative file URLs. The fresh-process lifecycle child performs the one
genuine close/adopt/reclaim/reopen transition and next live write without an
inherited object or `WeakRef`. The separate two-process SQLite case uses IPC to
confirm transaction-held and release states; it never infers ordering from a
sleep or the native 1000 ms busy timeout. Exactly one fresh delete and one
replay/retry result are accepted, with old XOR complete-new database state and
no mixed image.

The 128-step durable differential is Node-only. Browser D.109f runs the genuine
eligible-deletion-set equivalence, invalid-input polarity, `facadeKeys`, and
reopened-origin controls in Chromium, Firefox, and WebKit. D.109e's retained
all-engine scheduling matrix supplies granted, fallback, throw/reject/abort/
unavailable/timeout, takeover, and versionchange coverage; D.109f does not
duplicate that closed matrix or run another 128-step browser history.

## Deterministic RED

RED is tests/evidence only. It may add:

1. `tests/fixtures/phase-6b/differential-exit-contract.ts`;
2. `tests/phase-6b-differential-exit-red.test.ts`;
3. `packages/storage-node/tests/fixtures/phase-6b-differential-exit-child.mjs`;
4. `packages/storage-node/tests/phase-6b-differential-exit-red.test.ts`;
5. `packages/storage-browser/tests/assets/phase-6b-differential-exit-entry.ts`;
6. `packages/storage-browser/tests/phase-6b-differential-exit-global-setup.ts`;
7. `packages/storage-browser/tests/phase-6b-differential-exit-red.pw.ts`; and
8. `packages/storage-browser/playwright.phase-6b-differential-exit.config.ts`.

The tests-only batch may amend the exact export-census roster, D.109c Node/
browser fixtures for two-process/backend-identity/`facadeKeys` assertions, and
the D.109d contract/test plus shared Phase-6a fixture for observed-census and
fresh-process hooks. It adds no product API.

Run the focused non-browser RED once and Chromium RED once. The 128-step
differential, census, raw-dependency, process controls, retained D.109c mutants,
and already-correct behavior execute at RED; none hides behind a missing-owner
skip. The exact intended causal set is three assertion classes: empty-delete/
present-parent does not yet return `AHE_RECLAMATION_INVALID_ARGUMENT`, the
nested pruned scope is not frozen, and Node inspection does not yet return an
asynchronously rejecting Promise. Evidence records the exact occurrence count
per selected suite surface. Any other code, failure, top-level error, flaky
result, module-load failure, or retained-title selection invalidates RED. Sign
and push RED after deterministic evidence validation; there is no separate
full model RED review.

## Narrow GREEN and gates

GREEN changes exactly three owners:

- `packages/storage/src/maintenance.ts` rejects only empty deletion plus a
  present former parent before owner dispatch or I/O. Empty plus no-head keeps
  existing replay/empty success; nonempty plus present remains legal; nonempty
  plus no-head retains D.109c classify-time retry semantics.
- `packages/issuance-store/src/maintenance.ts` returns a deeply frozen pruned
  error whose detached nested `scope` is also frozen, with unchanged public
  shape and code.
- `packages/storage-node/src/internal/node-issuance-store.ts` establishes the
  Promise boundary before unavailable/invalid-input inspection checks, matching
  ephemeral/browser rejection timing without changing results.

Run in order: focused non-browser GREEN once; focused Chromium once and the
same one-file selection in Firefox/WebKit; exact retained D.109a-e, Phase-6a,
snapshot-quarantine, live-journal, storage schema/capacity, and Phase-5c files/
titles; affected package builds and source typechecks; exact-owner ESLint and
Prettier; `git diff --check`; child syntax; package/facade/factory census;
source-shape and changed-path checks; protected-untracked, 26-stash, process/
port, signature, pushed-ref, and self-excluding evidence-manifest checks.

Evidence records selected counts, exact RED/GREEN outcomes, seed and all 128
completed durable steps, zero deleted durable reads, full registry coverage,
both golden-path projections, child chronology, transaction observations,
owner hashes, environment, and dispositions. There is no campaign or retry
loop.

## Initial review and correction disposition

The signed/pushed initial plan is
`926bf4c6f185fadfb6ae361e81448210f9e7e5af`. Grok 4.6/high session
`01a05bd1-c568-7db2-9c80-0230c01ab1c1`, standard Kimi K3/high/100 session
`session_5b19e331-2914-41ad-97b5-54ccda3b30e0`, and Opus xhigh session
`350cea36-b25b-4bce-beed-ebd3cba8b114` all returned `CHANGES_REQUIRED` and
`D109F_RED_READY: no`.

The accepted blocking union is: the unsupported 128-genuine-transition claim;
two inherited behavioral debts outside the original owner list; non-causal
RED skip gating; unavailable genuine AHE backend identity in the shared
fixture; the universal raw-reader claim over in-memory owners; impossible
archival runtime numeric census; and polarity wording that would change four
retained D.109c retry mutants. This correction adopts each item through the
two-level oracle, three exact GREEN owners, fully executing RED controls,
tests-only backend exposure with one build tree, split proof classes, proof-
kind census, and empty/present-only predicate above.

Nonblocking findings are also dispositioned: enumerate the complete export
roster; paginate 129+ records; put 65+ issued rows in two epochs; use IPC for
the two-process hold; await deterministic sinks rather than polling; treat
D.109d replay fields as receipt comparisons rather than archival differences;
and retain, rather than duplicate, D.109e's browser matrix. No recursive
review is created for these corrections.

Because the correction changes executable scope and causal acceptance, the
single permitted Grok/Kimi/Opus confirmation reviews this signed/pushed text.
Only an empty P0/P1 union authorizes RED. If Grok cancels, resume its exact
session. The standard `kimi` CLI is authoritative; Codex Sol is not a
substitute.

## Review and stop policy

After signed/pushed GREEN, one formal Grok/Kimi/Opus review inspects the
accepted plan, causal RED, complete GREEN, retained behavior, and exit
evidence. Only P0/P1 blocks. No Fable, collaboration subagent, separate RED
model round, retained campaign, recursive prose review, or review substitution
runs.

Stop during RED or GREEN on an unexpected causal failure. Stop and reslice
before changing a production file outside the three named owners, or before
changing a schema, dependency, threshold, workload, timeout, wire/digest/QC/
activation/availability/identity contract, browser scheduler, snapshot format,
or legacy object/finality behavior.

## Phase-6b completion condition

Phase 6b closes only when all three defects reject/behave as frozen; the
128-step archival/compacted durable-history differentials match every non-
pruned observation and perform zero deleted durable reads; the genuine one-
transition lifecycle controls preserve both golden paths through reclaim,
reopen, and next live work; all proof-kind censuses are complete and bounded;
fresh-process and two-process recovery pass; all three browser engines agree;
every named retained/static gate is green or has an unchanged explicitly
classified tests-only diagnostic; the evidence manifest validates; and the
final Grok/Kimi/Opus P0/P1 union is empty.
