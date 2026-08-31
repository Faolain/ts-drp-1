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

- `@ts-drp/issuance-store/maintenance` owns the closed pruning input,
  capability, and immutable receipt types;
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
has one method, `prunePublishedPrefix(input)`, and is not attached to the
ordinary store.

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

Success returns a deeply frozen detached receipt containing the copied scope,
closed epoch, QC ref, snapshot digest, the exact deleted inclusive range (or
`null` for a genuine idempotent no-op), the resulting inclusive pruning
watermark, and the exact observed `{ exhausted, next }` lineage. That existing
lineage pair is the observed CAS revision; D.109b does not add a second lineage
revision counter. No receipt is persisted as a shadow truth store and no
scheduler is added.

## One owner transaction

The owner validates and copies the input before opening a write transaction.
Inside one native transaction it rereads the selected lineage row and its
inclusive `prunedThroughAuthorSequence` watermark. The expected lineage and
watermark must match exactly. The transaction then scans the selected range in
bounded pages from `watermark + 1` (or zero when the watermark is `null`)
through `throughAuthorSequence` and proves:

1. every ordinal exists exactly once in both issued and outbox storage;
2. both native keys, scope, and ordinal agree;
3. both digests are nonempty and byte-identical;
4. every canonical preimage decodes to a v3 `drp-vertex` whose object, author,
   ordinal, and safe nonnegative epoch agree with the native key;
5. epochs never regress, every selected epoch is at or below `closedEpoch`,
   and the final selected row is exactly in `closedEpoch`;
6. every selected outbox row is `published`; and
7. the selected end is consumed by the unchanged observed lineage.

An unreadable, malformed, pending, one-sided, foreign-digest, gapped,
duplicate, non-monotone, out-of-boundary, or newly changed selected row aborts
with zero writes. Rows above the selected end and unrelated scopes are not
deleted. A pending newer-epoch suffix is retained and does not become an
old-epoch blocker merely because it shares the scope.

When the current watermark already equals the requested end and both expected
state members match, the operation is an idempotent no-op and returns a receipt
with `deletedAuthorSequenceRange: null`. A request below the current watermark,
past the observed consumed lineage, or with an internally impossible expected
state is invalid. A well-formed request whose expected lineage or watermark
became stale returns `ISSUANCE_RETRY_REQUIRED`. Durable malformed state returns
and latches `ISSUANCE_RECOVERY_CORRUPT`. Input misuse returns
`ISSUANCE_INVALID_ARGUMENT`; owner lifecycle and substrate errors retain their
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
versionchange or replacement database occurs. The new reader accepts both a
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
`pruned_through_author_sequence` column on `lineages`. An exact version-1
catalog is upgraded inside one `BEGIN IMMEDIATE` transaction in the same file,
copying every lineage and issuance row and setting the new member to `NULL`;
the original authority is never replaced or redirected. Exact v2 admission is
then verified. Unknown versions/catalogs remain
`ISSUANCE_UNSUPPORTED_SCHEMA`. RED covers legacy open, failed migration,
same-path identity, row preservation, and reopen.

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

The RED batch may also correct only the retained exact expectations directly
affected by the new error code, required terminal watermark, explicit
maintenance subpaths, Node v2 lineage DDL, and compatible browser lineage row.
It must enumerate those edits in its changed-path ledger; it may not weaken
the six-method surface or unrelated Phase-2l semantics.

The shared/conformance test freezes exact input copying, identity-gated
resolution, immutable receipts, page boundaries at 64/65 and 128/129 rows,
successful prefix deletion, idempotence, stale lineage/watermark, pending
prefix refusal, newer pending suffix retention, unrelated scope preservation,
late exact/wrong-digest acknowledgement, the complete absence table, and exact
error keys/codes. Backend tests additionally mutate genuine native rows to
cover malformed canonical bytes, wrong vertex kind/protocol/epoch/scope,
one-sided rows, digest mismatch, sequence gap, epoch regression, end-epoch
mismatch, delete/update count mismatch, transaction abort, two-handle races,
schema migration, reopen, and crash boundaries around delete, watermark write,
and commit. Browser runs the same semantic matrix in Chromium against genuine
IndexedDB and proves the database remains version 1. Node hard-kill recovery
proves old XOR complete-new state in the same derived file.

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
and directly affected retained tests. It does not modify `packages/node`,
snapshot transfer, protocol-v3, AHE storage, runtime cleanup, scheduling,
dependencies, thresholds, or campaigns.

Run the focused shared, Node, and Chromium tests; all retained Phase-2l shared,
Node, browser, and parity issuance suites; the Phase-3a1b-p2 publication
contract; and the eight retained Phase-6a semantic tests used by D.109a. Run
source-only build/typechecks for issuance-store, storage-node, and
storage-browser; exact-owner lint/format/diff; closed surface/error/schema
source checks; manifest/hash validation; protected-path/stash/process/port
checks; and signed-commit/pushed-ref identity. Record every command and complete
result set.

Because this slice authorizes physical deletion, schema migration, and the
closed error/terminal-observation exception, sign and push its plan before one
Grok/Kimi/Opus plan review. Only P0/P1 blocks; correct one material union at
most. After signed RED and GREEN, run one final Grok 4.6/high, exact Kimi K3
thinking/high/100, and Opus xhigh review over plan → RED → GREEN history. If
Grok cancels, resume its exact session. No Sol substitution, Fable,
collaboration subagent, retained campaign, or recursive prose review is
authorized.
