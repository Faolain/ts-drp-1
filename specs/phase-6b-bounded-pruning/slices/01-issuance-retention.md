# D.109b — Issuance Retention

## Status and inherited evidence

D.109a is closed at signed/pushed commit
`717b15ac0a8c7369fd18a0a1c08b8a88dfbb0056`. Its immutable cleanup plan is
eligibility evidence, not deletion authority. D.109b is the first physical
deletion slice. It changes no snapshot, vertex, wire, digest, signature, QC,
adoption, activation, workload, timeout, memory, or retained-campaign
contract.

The active review trio is Grok 4.6/high, exact Kimi K3 thinking/high with both
100-step controls, and Opus xhigh. Kimi occupies the middle review slot;
Codex `gpt-5.6-sol` is not a substitute. These are external CLI review
sessions, not collaboration subagents. Fable and collaboration subagents are
not authorized.

## Existing owners and frozen surface

The mandatory `DurableIssuanceStore` in
`packages/issuance-store/src/types.ts` remains exactly the existing six
methods. The existing `@ts-drp/storage-node/issuance` and
`@ts-drp/storage-browser/issuance` runtime modules retain their exact factory
surfaces. Maintenance is isolated instead:

- `@ts-drp/issuance-store/maintenance` owns the closed pruning-state,
  pruning-input, capability, and immutable receipt types;
- `@ts-drp/storage-node/issuance-maintenance` exports only
  `resolveNodeDurableIssuancePruningMaintenance(store)`;
- `@ts-drp/storage-browser/issuance-maintenance` exports only
  `resolveBrowserDurableIssuancePruningMaintenance(store)`; and
- `@ts-drp/issuance-store/conformance` adds the equivalent resolver for its
  explicitly non-durable memory implementation.

Each resolver uses a module-private `WeakMap` populated only when that module
creates the genuine six-method facade. Resolution is by exact facade object
identity. A copied facade, proxy, structural stub, closed-record lookalike, or
store from another backend resolves to `undefined`. The maintenance capability
has exactly two methods, `inspectPruningState(scope)` and
`prunePublishedPrefix(input)`, and is not attached to the ordinary store.
Inspection validates and copies the scope, then reads the exact lineage and
nullable pruning watermark together in one owner read transaction. It returns
a deeply frozen detached `{ scope, lineage, prunedThroughAuthorSequence }`
record. It does not expose native handles, rows, receipts, or deletion
authority.

The new maintenance subpaths are deliberate package-maintenance surfaces, not
new product/node-handle APIs. Existing package roots and the two existing
`./issuance` factory modules do not re-export them. Retained exact-export tests
are amended only to recognize the new explicit subpaths while preserving the
old factory-module key sets.

## Closed input and receipt

`prunePublishedPrefix` accepts one exact own-data record containing:

- `scope`;
- safe nonnegative `closedEpoch` and inclusive `throughAuthorSequence`;
- exact `expectedLineage: { exhausted, next }`;
- `expectedPrunedThroughAuthorSequence`, either `null` or a safe nonnegative
  inclusive ordinal;
- the separately authenticated `commitQcRef` as exact positive `byteLength`
  plus lowercase 64-hex `digest`; and
- the separately authenticated adopted `snapshotManifestDigest` as lowercase
  64-hex.

The QC and snapshot values are explicit inputs because D.109a intentionally
does not copy them into its result. The issuance owner validates, copies, and
binds them to the invocation but does not pretend it can reauthenticate facts
owned by another database. All deletion decisions still come from its own
transactional rows, lineage, watermark, and decoded canonical preimages.

Success returns a deeply frozen detached receipt with exactly the own keys
`scope`, `closedEpoch`, `commitQcRef`, `snapshotManifestDigest`,
`deletedAuthorSequenceRange`, `prunedThroughAuthorSequence`, and
`observedLineage`. The deleted inclusive range is `null` only for a genuine
idempotent no-op. That existing lineage pair is the observed CAS revision;
D.109b does not add a second lineage revision counter. No receipt is persisted
as a shadow truth store and no scheduler is added.

## Prospective planner continuation

D.109a's signed evidence remains immutable, but its current ordinal-zero
single-epoch input shape cannot reconstruct eligibility after a successful
prune. D.109b therefore prospectively extends the same pure
`planClosedEpochCleanup` owner and its existing focused test. The issuance
input adds exact `lineage: { exhausted, next }` and nullable
`prunedThroughAuthorSequence`; the successful plan copies both. For a null
watermark, rows remain the complete exact `0..throughAuthorSequence` prefix.
For a numeric watermark `W`, rows are the complete exact
`W + 1..throughAuthorSequence` suffix. `W === throughAuthorSequence` accepts
an empty row list for idempotent recovery. Every supplied row remains exactly
in `closedEpoch`, paired, consumed, and published; gaps, rows at or below `W`,
and `W > throughAuthorSequence` retain exact `D109A_OUTBOX_INCOMPLETE` refusal.

The caller obtains the lineage/watermark pair from `inspectPruningState`, reads
the remaining ordinary issuance rows, and submits those detached facts to the
pure planner. The later owner transaction revalidates all facts, so a
cross-read change can only refuse without deletion. This makes cold restart,
lost-receipt recovery, and a later closed epoch reachable without changing a
product API or reopening D.109a's historical checkpoint.

## One owner transaction

The owner validates and copies the input before opening a write transaction.
Inside one native transaction it rereads the selected lineage row and its
inclusive `prunedThroughAuthorSequence` watermark. On a delete path the
expected lineage and watermark must match exactly. The transaction then scans the selected range in
bounded pages from `watermark + 1` (or zero when the watermark is `null`)
through `throughAuthorSequence` and proves:

1. every ordinal exists exactly once in both issued and outbox storage;
2. both native keys, scope, and ordinal agree;
3. both digests are nonempty and byte-identical;
4. every canonical preimage decodes to a v3 `drp-vertex` whose object, author,
   ordinal, and safe nonnegative epoch agree with the native key;
5. every selected epoch is exactly `closedEpoch`;
6. every selected outbox row is `published`; and
7. the selected end is consumed by the unchanged observed lineage.

An unreadable, malformed, one-sided, foreign-digest, gapped, duplicate,
non-monotone, or newly changed durable row aborts and latches
`ISSUANCE_RECOVERY_CORRUPT` with zero writes. A well-formed selected `pending`
row aborts without latching as `ISSUANCE_RETRY_REQUIRED`. A well-formed
selected row in another epoch, an out-of-boundary request, or an internally
impossible caller state aborts without latching as
`ISSUANCE_INVALID_ARGUMENT`. Rows above the selected end and unrelated scopes
are not deleted. A pending newer-epoch suffix is retained and does not become
an old-epoch blocker merely because it shares the scope.

When the current watermark already equals the requested end and observed
lineage equals `expectedLineage`, the operation is an idempotent no-op and
returns a fresh receipt with `deletedAuthorSequenceRange: null` even when the
supplied expected watermark is stale or null. This is the exact same-input
lost-receipt retry. Otherwise a well-formed request whose expected lineage or
watermark became stale returns non-latching `ISSUANCE_RETRY_REQUIRED`. A
request below the current watermark, past the observed consumed lineage, or
with an internally impossible expected state is non-latching
`ISSUANCE_INVALID_ARGUMENT`. Owner lifecycle and substrate errors retain their
existing codes.

Only after the complete proof succeeds does the same transaction delete each
selected issued/outbox pair and update the existing lineage row's watermark to
the inclusive selected end. It verifies exact delete/update counts before
commit. The lineage row, `next`, and `exhausted` are retained unchanged. A
transaction abort, process death, or competing handle yields old state or the
complete new state, never deletion without the matching watermark.

## Watermark and terminal semantics

`prunedThroughAuthorSequence: number | null` is normalized in memory and is a
required member of the public `DurableIssuanceTerminalObservation`. The issued
row, outbox row, lineage, and watermark are read in one owner read transaction.
The unreadable observation variant remains `{ unreadable: true }`.
Missing, accessor-bearing, or invalid watermark state in an otherwise readable
public terminal observation is `ISSUANCE_RECOVERY_CORRUPT`. Every comparison
uses the explicit predicate
`watermark !== null && authorSequence <= watermark`; a null watermark is below
every valid ordinal and never satisfies an at-or-below row.

The exact absence matrix is:

| Durable row state      | Address relation                     | `readIssued`                | publication acknowledgement                  | transaction terminal classification                                                                             |
| ---------------------- | ------------------------------------ | --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| paired rows            | consumed and `sequence > watermark`  | existing behavior           | existing pending/published/digest behavior   | existing exact/foreign closure behavior                                                                         |
| either row present     | `sequence <= watermark`              | `ISSUANCE_RECOVERY_CORRUPT` | `ISSUANCE_RECOVERY_CORRUPT`                  | `ISSUANCE_RECOVERY_CORRUPT`                                                                                     |
| both absent            | not consumed                         | `null`                      | `ISSUANCE_INVALID_ARGUMENT` for never issued | existing definite-not-applied `ISSUANCE_SUBSTRATE_FAILURE` when lineage still equals the caller's prior lineage |
| both absent            | consumed and `sequence <= watermark` | `null`                      | exact non-poisoning `ISSUANCE_RECORD_PRUNED` | exact non-poisoning `ISSUANCE_RECORD_PRUNED`                                                                    |
| both absent            | consumed and `sequence > watermark`  | `ISSUANCE_RECOVERY_CORRUPT` | `ISSUANCE_RECOVERY_CORRUPT`                  | `ISSUANCE_RECOVERY_CORRUPT`                                                                                     |
| one-sided or malformed | any other relation                   | `ISSUANCE_RECOVERY_CORRUPT` | `ISSUANCE_RECOVERY_CORRUPT`                  | `ISSUANCE_RECOVERY_CORRUPT`                                                                                     |

`ISSUANCE_RECORD_PRUNED` is added to the frozen error-code registry. Its error
object exposes only `code`, a detached caller-known `scope`, and the
caller-known `authorSequence`; it never exposes or claims a stored digest,
candidate, token, receipt, or deleted bytes. A wrong-digest late acknowledgement
still returns `ISSUANCE_RECORD_PRUNED`, because no durable digest remains to
compare. This error does not poison the store. Above-watermark consumed absence
continues to poison as corruption.

## Schema compatibility

Browser keeps the exact derived database name suffix
`--drp-issuance-v1`, exact object-store names/key paths, and IndexedDB version
`1`. The watermark is an additive data member on the existing lineage row; no
versionchange or replacement database occurs. Every lineage reader, including
`readLineage`, `readOutboxPage`, terminal readback, pruning inspection, and
pruning mutation, accepts both a
legacy four-member lineage row as `watermark = null` and a five-member row with
a valid nullable/numeric watermark. Ordinary issuance preserves the legacy
four-member representation until pruning first writes a watermark, then
preserves that numeric member on every later lineage update. Unknown members,
invalid watermarks, or a watermark beyond the consumed lineage fail closed.
An old reader remains valid until pruning has actually introduced state it
cannot understand; D.109b does not claim post-pruning downgrade support.

Node keeps the exact `.drp-issuance-v1.sqlite` derived filename, page size, WAL,
FULL synchronous mode, and existing tables/keys. A fresh authority is created
at schema version 2 with one nullable checked
`pruned_through_author_sequence` column on `lineages`. Admission enters one
`BEGIN IMMEDIATE`, then rereads the exact user version and catalog under that
lock. Exact v1 rebuilds only `lineages` from one frozen literal v2 DDL string,
copies all lineage rows with a `NULL` watermark, preserves `issued_records` and
`issuance_outbox` unchanged, sets `user_version=2`, verifies the exact v2
catalog, and commits. Exact v2 no-ops under the same lock; every other
version/catalog is `ISSUANCE_UNSUPPORTED_SCHEMA`. The original authority is
never replaced or redirected. RED crosses two-handle concurrent v1 admission,
legacy open, failed migration, same-path identity, row preservation, numeric
watermark preservation, and reopen.

## Frozen RED

The tests-only RED owns exactly these new paths:

- `tests/fixtures/phase-6b/issuance-retention-contract.ts`;
- `tests/phase-6b-issuance-retention-red.test.ts`;
- `packages/storage-node/tests/fixtures/phase-6b-issuance-retention-child.mjs`;
- `packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts`;
- `packages/storage-browser/tests/assets/phase-6b-issuance-retention-entry.ts`;
- `packages/storage-browser/tests/phase-6b-issuance-retention-global-setup.ts`;
- `packages/storage-browser/tests/phase-6b-issuance-retention-red.pw.ts`; and
- `packages/storage-browser/playwright.phase-6b-issuance-retention.config.ts`.

It also prospectively extends the existing planner owner and
`tests/phase-6b-cleanup-eligibility-red.test.ts` only for the frozen
watermark/lineage input and output above. This is part of D.109b's causal RED,
not an amendment to D.109a's immutable evidence.

The RED batch may also correct only retained exact expectations directly
affected by the new error code, required terminal watermark, maintenance
subpaths, Node v2 lineage DDL, and compatible browser lineage row. The ledger
must enumerate `packages/issuance-store/src/types.ts`, the new shared
maintenance module, p2 contract/terminal/index hashes and conformance runtime
names, every terminal-observation literal, the Phase-2l exact error registry,
and the current Node/browser export lists. The complete exact-export census for
the mandatory retained gates explicitly owns:

- `tests/phase-2l-a-shared-issuance-contract.test.ts` line 239;
- `tests/phase-2l-d-parity-governance-red.test.ts` lines 135–136;
- `tests/phase-3a1b-p2-outbox-publication-contract.test.ts` lines 517–530;
- `packages/storage-node/tests/phase-2l-c-node-issuance-registry-red.test.ts`
  lines 33–38; and
- `packages/storage-node/tests/phase-3a1b-p4-node-live-journal-red.test.ts`
  lines 967–972.

Each assertion must first recognize the complete current package surface,
including existing Node `./snapshot-transfer` and `@ts-drp/compaction` plus
existing browser `./seal-evidence`, `./seal-vote`, and
`./snapshot-transfer`, then add only `./maintenance` or
`./issuance-maintenance` for its owning package. It may not delete or invent
package surface. The six-method facade and existing factory-module key sets
remain exact. Historical complete-export pins outside the mandatory D.109b
gate are recorded as pre-existing retained debt, owned by D.109f's complete
retained-suite/source-shape census before Phase-6b exit, and are not silently
widened into this deletion slice.

The shared/conformance test freezes exact input copying, identity-gated
resolution, immutable receipts, page boundaries at 64/65 and 128/129 rows,
successful prefix deletion, idempotence, stale lineage/watermark, pending
prefix refusal with the exact non-latching code, newer pending suffix
retention, unrelated scope preservation, cold restart/lost-receipt replan, a
later closed epoch, null-watermark polarity,
late exact/wrong-digest acknowledgement, the complete absence table, and exact
error keys/codes. Backend tests additionally mutate genuine native rows to
cover malformed canonical bytes, wrong vertex kind/protocol/epoch/scope,
one-sided rows, digest mismatch, sequence gap, epoch regression, end-epoch
mismatch, delete/update count mismatch, transaction abort, two-handle races,
schema migration, reopen, and crash boundaries around delete, watermark write,
and commit. Browser runs the same semantic matrix in Chromium against genuine
IndexedDB, proves `readLineage` and `readOutboxPage` work after pruning and
across legacy/new rows, proves later `transactIssue` preserves the numeric
watermark, and proves the database remains version 1. Node hard-kill recovery
proves old XOR complete-new state in the same derived file; concurrent v1
admission proves exactly one migration and no watermark reset.

The shared structural v3 decoder lives in
`@ts-drp/issuance-store/maintenance`, depends only on the existing canonical
owner, and pins literal `kind === "drp-vertex"`, `protocolMajor === 3`, safe
nonnegative epoch, scope, and author sequence. No protocol-v3 dependency is
introduced. The selected range is not capped by this slice; it is visited in
bounded 64-row pages inside one atomic owner transaction. Browser code awaits
only requests belonging to that live IndexedDB transaction until it reaches a
terminal event.

RED is accepted only when production remains byte-identical, exact test/file
selection is proven, no retained campaign title is selected, and failures are
the frozen missing `ISSUANCE_RECORD_PRUNED`, maintenance subpaths/resolvers,
required watermark member, and pruning behavior—not a fixture, build,
resolution, or source-shape error. Sign and push RED with a self-excluding
manifest before GREEN. RED receives no separate model round; the final review
must validate its causality.

## GREEN gates and review

GREEN changes only the shared issuance contract/terminal/conformance owners,
the two issuance adapters and their explicit maintenance subpaths/manifests,
the existing pure `packages/node/src/internal/closed-epoch-cleanup.ts` planner,
and directly affected retained tests. It does not modify node runtime wiring,
snapshot transfer, protocol-v3, AHE storage, runtime cleanup, scheduling,
dependencies, thresholds, or campaigns.

Run the focused shared, Node, and Chromium tests; all retained Phase-2l shared,
Node, browser, and parity issuance suites; the Phase-3a1b-p2 publication
contract; and the eight retained Phase-6a semantic tests used by D.109a. Run
source-only build/typechecks for issuance-store, storage-node, storage-browser,
and node; exact-owner lint/format/diff; closed surface/error/schema source
checks; manifest/hash validation; protected-path/stash/process/port checks; and
signed-commit/pushed-ref identity. Record every command and complete result
set.

Because this slice authorizes physical deletion, schema migration, and the
closed error/terminal-observation exception, sign and push its plan before one
Grok/Kimi/Opus plan review. Only P0/P1 blocks; correct one material union at
most. After signed RED and GREEN, run one final Grok 4.6/high, exact Kimi K3
thinking/high/100, and Opus xhigh review over plan → RED → GREEN history. If
Grok cancels, resume its exact session. No Sol substitution, Fable,
collaboration subagent, retained campaign, or recursive prose review is
authorized.

## Initial plan-review disposition

The signed/pushed initial plan commit is
`fe934eae3a781b70ef666e5827317cf231e5d078`. Grok 4.6/high completed normally
and returned four P1/two P2 findings; public-result SHA-256 is
`713cb28f53423699ee7c4551ebf41cc9e4472f81c612943262da0a1315c8bf6c`.
Exact Kimi K3 thinking/high with both 100-step controls returned approval with
three P2 observations; raw-stream SHA-256 is
`53d90eaee7bff295abc7446cba01d2550635c8e2d57e691229bb95944e8bb321`.
Opus xhigh returned four P1/five P2 findings; result SHA-256 is
`753a2453f8550fa87deeec1e5df2841f42615fbde1aa329c33bae25d93e8c953`.
The corrected exact-title audit ran the two alleged stale Node assertions once:
Vitest selected exactly two tests/two files and both failed solely because the
live manifest already contains `@ts-drp/compaction` and
`./snapshot-transfer`. The preceding title-filter attempt selected an
incomplete target and supplies no code verdict.

This single correction batch adopts the blocking union: exact non-latching
eligibility codes, same-input lost-receipt idempotence, explicit null polarity,
post-prune browser writeback, all browser lineage readers, migration reread
under lock with a crossed two-handle RED, prospective planner continuation,
and the two demonstrated stale retained pins. It also freezes every P2 detail
listed above. The source/causal contract materially changed, so the policy
permits exactly one confirmation of this corrected signed checkpoint by Grok,
Kimi, and Opus. No further plan confirmation or prose review may recurse.

## Confirmation disposition

The single confirmation inspected signed/pushed commit
`433f11afe22b2357563d0953c6634829ff344ab1`. The original Grok session
`01a05997-e41b-74e3-b8eb-ebb67a958976` reached its turn ceiling and was
honestly retained as `NO_VERDICT`; its event SHA-256 is
`0d6c0d2014dfa238bb603d3ce3c34bccd5dc3113e245d0bbfe6ab0347944a8e2`.
The exact session was resumed, completed normally, and returned one P1/six P2;
resumed-event SHA-256 is
`23aa2022e42912ef8d56750899fbff10e93e6e8f16ccfc0417f15df6b894a0c4`.
Exact Kimi K3 thinking/high with both 100-step controls returned `APPROVED`,
P0/P1/P2 `0/0/2`; raw SHA-256 is
`a51672afb7c3b50cca079bcae6a3c9c28fcb97823df8eb18a5dc067086b5047e`.
Opus xhigh session `5e372c80-3297-4cf3-bf55-fdbd6271f7e1` completed with
`is_error:false`, `stop_reason:end_turn`, `APPROVED`, and P0/P1/P2 `0/0/3`;
result SHA-256 is
`93d6473d217399d4d09f6ad46d39d083009b123d629af507ae329a4fa190ca6d`.

Grok's sole P1 demonstrated that the p2 and Phase-2l-d mandatory gates contain
the same stale complete-export assertion as the two already owned Node sites.
One corrected exact-title Vitest invocation selected exactly two tests/two
files and both failed only on those pre-existing omitted live subpaths. The
explicit five-site census above closes that ledger omission. This is a
bookkeeping-only correction to the retained-test owner list: it changes no
scope, causal RED outcome, acceptance predicate, or product behavior, so the
governing policy forbids another model confirmation. Grok's other P2 notes and
Kimi/Opus's overlapping P2 observations are recorded without more ceremony;
they either describe non-mandatory historical pins, wording already resolved
by the executable clauses, or later receipt-consumption ownership. The
blocking union is empty and D.109b RED may proceed.
