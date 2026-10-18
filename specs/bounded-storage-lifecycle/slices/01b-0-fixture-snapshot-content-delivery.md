# 1b-0 — Fixture snapshot content delivery, not ownership copying

Status: contract accepted for separate RED authoring after independent reviews
and root dispositions, 2026-09-07.
[1a-1 retention](01a-1-bounded-snapshot-retention.md) is accepted; live acceptance
and review dispositions belong to the [handoff](../README.md) and
[review ledger](../review.md#1b-0-contract-review). RED is limited to the causal
extraction and tests below; GREEN requires its own accepted RED freeze.

## One question

Can the existing room workload deliver a selected snapshot's content into the
destination's own quarantine without copying recovery ownership, clearing
protected destination data, or loading historical payloads wholesale?

The [room fixture](../../../tests/fixtures/grid-room-workload.ts) currently
copies snapshot database images and discovers declarations by loading all scope
and chunk rows. Its temporary-only source guard correctly prevents importing
recovery authority, but will reject a genuinely pinned producer snapshot.
A symmetric destination-debt guard alone would protect destinations without
unlocking that producer path. Replace snapshot image copying with verified
content delivery before adding producer pins. Leave AHE delivery and product
successor authentication unchanged.

## Seam and single owners

Use `tests/fixtures/grid-snapshot-content-delivery.ts` for bounded declaration
selection and snapshot content delivery, with this test-only seam:

```ts
export declare function readFixtureSnapshotDeclaration(
	input: Readonly<{
		primaryDatabaseName: string;
		objectId: string;
		closedEpoch: number;
		signal?: AbortSignal;
	}>
): Promise<SnapshotQuarantineDeclaration>;

export declare function deliverFixtureSnapshot(
	input: Readonly<{
		sourcePrimaryDatabaseName: string;
		targetPrimaryDatabaseName: string;
		objectId: string;
		closedEpoch: number;
		signal?: AbortSignal;
	}>
): Promise<SnapshotQuarantineDeclaration>;
```

The result reuses the existing storage declaration type, not a new receipt or
recovery capability. Both transfer and non-transfer reopen paths consume the
same bounded declaration selector. Preserve native owner failure classifications;
fixture selection/shape failures reject without inventing production error codes.
No production export is added.

Inputs are unsuffixed room primary names (`peer.databaseName`), as consumed by
the native factory. Validate the primary-name grammar
`d110c-f5b-parent-<digits>-peer-<canonical nonnegative integer>[-fresh]` and derive
the exact `--drp-snapshot-quarantine-v1` name once; reject already-suffixed inputs.
Transfer requires the same fixture family, creator peer zero without `-fresh`
as source, and a distinct nonzero destination, with or without `-fresh`.
Local lookup accepts the caller's own valid creator, noncreator or fresh identity.
Both paths require the caller's object/epoch; never infer identity from a row.

The source reader owns raw readonly extraction, not admission or recovery policy:

- Require the existing supported v2 source schema; no source-side migration is
  permitted. The selected row must carry v2 descriptor/incarnation metadata.
  `readFixtureSnapshotDeclaration` never opens the native factory, for either
  transfer or non-transfer lookup; local v1 lookup refuses without migration.
  Open without an upgrade and
  abort `upgradeneeded`. A missing or concurrently deleted source must not be
  silently created. Close every acquired connection on success and failure.
- Visit only the exact object/epoch scope prefix, stopping after a second
  candidate. Require exactly one row in that prefix, and require that row to be
  verified; do not ignore a second open or poisoned candidate. Validate key/row
  identity.
- Capture its bounded manifest and incarnation. Derive the declaration using
  the existing protocol manifest decoder, checking requested identity and
  agreement with stored manifest/descriptor metadata. Do not copy a second parser.
  Construct a fresh exact declaration from decoded fields, not a spread of the
  stored row with persistence-only fields.
- Fetch only a requested descriptor's exact chunk key. In the same readonly
  transaction, recheck the selected header's incarnation and manifest identity;
  reject deletion, replacement and disagreement. Validate chunk key/row identity
  and byte shape, and return copied bytes only after transaction completion.
- Never use source `openScope()`, which can sweep. Never use payload `getAll`,
  concatenate the snapshot, or hold a transaction across destination work.

This proves content against a captured manifest, not an atomic whole-database
snapshot. It is fixture availability plumbing, not authenticated discovery.

The destination uses the existing native quarantine factory, `openScope`,
`verifySnapshotStreamWithReceipt`, awaited stream verification, and awaited
`complete` with the fresh destination-bound receipt. Release the handle and
close the store without canceling or compensating by deletion. The existing
stream verifier reads quarantine first and fetches/writes only missing chunks;
use that same path for absent, partial and exact verified destinations. Do not
introduce a verified-existing bypass or fixture-minted authority.
The verifier and native adapter must resolve the same receipt-owner module:
use `@ts-drp/compaction/snapshot-quarantine-receipt` rather than importing a source
copy beside the adapter's built module. The receipt registry is module-local;
matching TypeScript types cannot make receipts from duplicate registries valid.
Import the adapter through `@ts-drp/storage-browser/snapshot-transfer`, matching
the room's built-adapter resolution. Project `maxManifestBytes`,
`maxSnapshotBytes` and `snapshotChunkBytes` from `snapshotQuarantineContract.limits`
into an exact three-field profile record. The limits object itself has an extra
`maxChunks` field and is not an admissible receipt profile. No new exported
profile owner or changed limit is needed. Preserve the decoder's descriptor
objects and field order when constructing the declaration.

The root test package declares workspace development dependencies on
`@ts-drp/compaction`, `@ts-drp/storage` and `@ts-drp/storage-browser`, with their
matching root lockfile importer links. Public subpath exports alone do not make
these packages resolvable from root fixtures. Use those declared dependencies,
not parallel Vite/TypeScript aliases to private built files; verify that root
and adapter-local resolution reach the same receipt module. This is test-consumer
dependency ownership, not a production export or implementation change.

The destination chooses its own incarnation, expiry and ownership accounting.
No raw destination writes, clear, copied owner row, counter reset, retention
call or fixture classification is allowed. Preserve unrelated recovery-owned
rows, durable limits and accounting. An already-v2 legacy hold refuses without
changing its image. An unopened supported v1 destination may undergo the normal
native upgrade before refusal: preserve its content, but do not promise unchanged
schema/metadata. This allowance applies only to `deliverFixtureSnapshot`'s native
destination admission, never to declaration lookup. Missing destinations use
normal native creation. The fixture must not implement or bypass migration.

Ordinary native admission may sweep expired temporary destination rows, and a
failed transfer may leave partial temporary content. Neither behavior permits
removing protected data. Ordinary completion proves manifest-described content,
not absence of every out-of-range occupied key; later `retainForRecovery` owns
full recovery closure. No fixture-only closure checker should duplicate it.

Preserve `await delivery → floor.receive → authenticated reopen` at the existing
call site. Only a successful delivery result may proceed to floor receive. The
helper accepts no floor callback and neither advances a room floor nor establishes
authenticated recovery ownership.

In transfer reopen, keep AHE delivery unchanged, call `deliverFixtureSnapshot`
with the origin and peer primary names plus the fixture's `objectId` and
`closedEpoch`, then receive the floor and pass the returned declaration directly
to authenticated reopen. Do not rediscover it from destination rows. Non-transfer
reopen calls `readFixtureSnapshotDeclaration` with that peer's primary name and
the same explicit object/epoch. GREEN deletes `producedDeclaration`.

Selected-epoch delivery intentionally replaces whole-image occupancy: admit only
the selected snapshot, even for fresh-device readmission. Do not clone sibling
source epochs to preserve incidental image-copy behavior. Destination siblings
remain owned by native admission and retention policy.

## Named image-delivery contract amendment

This explicitly supersedes the snapshot image-copy preservation clause in
[1a-0's named amendment](01a-0-versioned-snapshot-owner.md#named-local-storage-contract-amendment).
Namespace, v2 source schema and descriptor/incarnation coherence move into the
readonly helper. Native destination admission owns destination schema and owner
metadata validation. The temporary-only source restriction, destination clearing
and copying of owner rows are removed, not relaxed inside a surviving copier.
No fixture owner-row read/copy or issuance/journal access is introduced. AHE
image delivery keeps its existing guards. GREEN removes the snapshot suffix
alternative, schema literal and snapshot guard block from the raw copier, so it
cannot remain reachable through an unused compatibility path.

## Causal RED and GREEN

Keep separate authors. RED composes the existing raw snapshot copier and
`producedDeclaration` behind the new primary-name signature: derive the existing
suffixed names once, perform the old copy, then select the declaration from the
destination as today's call site does. The local-read signature exposes the old
selector on its caller database. Do not repair old object selection or copying
during extraction; GREEN replaces them with the shared bounded source selector.
This is the minimum test-only extraction, preserving a passing
ordinary temporary-content control and the existing room workload. Its failure
must demonstrate the old owned-source rejection, protected destination clearing
or unbounded extraction—not merely a missing module or invented API. Archive the
pre-extraction fixture and exact source/command evidence. GREEN replaces that
exposed behavior and removes the snapshot branch of the raw image copier; do not
leave an unsafe unused import path or compatibility wrapper behind.

RED-only extraction may move the unchanged combined `transferDatabase` into
the helper and temporarily export it for the room's unchanged AHE call, avoiding
either duplicate copier code or a helper import of the room runtime. Record exact
body preservation. This third test-only export is scaffolding: GREEN returns
the AHE-only copier to the room fixture and removes the temporary export and
snapshot-copy capability, leaving only the two reviewed snapshot APIs.

`tests/grid-snapshot-content-delivery-red.test.ts` uses the native factory and raw
IndexedDB setup, not `openRoom`, to discriminate the new helper behavior:

- Genuine recovery-owned source delivers verified temporary destination content
  with a destination-created incarnation and no copied recovery charge.
- Readonly source transaction telemetry and before/after images preserve an
  expired temporary sentinel that source admission would otherwise sweep.
- Namespace/selector ambiguity, key/row mismatch, incarnation drift and corrupt
  or missing requested content refuse. Traversal and source-read tripwires prove
  bounded selection and no whole-payload staging.
- Missing-source and deleted-source opens refuse without creating a database:
  compare `indexedDB.databases()` before and after. Include a controlled deletion
  that wins a race with the helper's source open; do not label a pre-absent source
  alone as concurrent-deletion coverage. Preserve the operation ordering evidence.
- Exact existing destination succeeds through genuine verification/completion
  without source chunk fetches or chunk writes; partial destination fetches only
  missing descriptors. Observe the actual destination receipt handoff instead
  of repeating the storage owner's entire receipt-forgery matrix.
- Existing owned destination data and an already-v2 legacy hold survive. Abort
  or refusal cannot resolve a successful declaration. Floor non-advance belongs
  to the separate room call-site ordering check, not this helper's API.

Freeze causal expectations before GREEN: ordinary temporary delivery and the
expired source sentinel are RED-pass controls (the old source read is already
readonly). Ordinary delivery asserts selected verified manifest/chunk content
at the destination and unchanged source image, not destination image equality,
copied incarnation/expiry/accounting or sibling occupancy. Owned-source
acceptance, protected destination preservation, bounded
extraction and exact/partial destination reuse are RED-fail obligations against
the old copier. Never add a source sweep merely to make a sentinel test fail.
Exact-existing reuse means an unexpired temporary or recovery-owned destination;
native expiry may legitimately sweep an expired temporary scope and refetch.

Before freezing RED, preserve the recorded raw prefix censuses from genuine
post-close and post-adoption creator images and the explicitly injected
pre-complete failure followed by same-binding retry, outside the focused helper
graph. These are sampled evidence, not universal uniqueness. The selector tightens the old
verified-only filter to exactly one candidate of any state. If the ordinary
producer emits siblings for that object/epoch, amend the contract before GREEN;
do not silently ignore open/poisoned rows or wait for grid64 to reveal the mismatch.

Do not require this helper to reject content solely because ordinary completion
does not inspect out-of-historical-range keys; recovery closure is a separate
owner and acceptance boundary.

Traversal controls must observe actual source operations/visited rows, not only
match source text. Instrument after genuine setup and independent image capture
so the inspection code itself is not mistaken for helper access. Scope source
traversal/read tripwires to the exact source primary name plus snapshot suffix,
excluding native destination operations and unchanged AHE copying. A bounded header
selection is still required for exact-existing reuse; zero source chunk fetches
does not mean zero source reads.

Use the patched IndexedDB implementation already used by the room workload for
the fixture seam. Label this as fixture/API evidence, not native-browser crash
or physical durability evidence. Preserve the native owner/retention tests and
the separate native product retention RED. Run the focused helper tests and the
complete unchanged `tests/phase-6b-d110c-0c1f5b-integration-red.test.ts` gate,
including its `sixtyFourWriterGoldenPath`, fresh-device and three-transition
cases; also run `tests/phase-6b-grid-successor-state-red.test.ts`. The separate
`runGridTransitions` in `tests/fixtures/grid-transition-workload.ts` is an affected
diagnostic consumer, not the ordinary grid64 gate: preserve its call-site
compatibility and report it separately. Its longer diagnostic variants are not
substitutes or new endurance gates. Separately verify room-level refusal does
not advance the floor in `tests/grid-snapshot-content-delivery-room-red.test.ts`;
keep that integration check outside the focused project.
Log strict typecheck, lint and format. Add a fixture-owned strict project
at `tests/fixtures/grid-snapshot-content-delivery/tsconfig.json`, extending the
root configuration with explicit helper/test `files`, repository `rootDir`,
`composite: false`, `noEmit: true` and `include: []`. Imported dependencies remain
typechecked according to resolution; public package subpaths can resolve to built
declarations, not adapter implementation source. The existing snapshot-owner
project does not own this fixture seam;
do not expand it into a general workload checker. Preserve and separately report
the broader room workload's existing diagnostics rather than weakening compiler
settings to make the focused graph pass.
Wire `typecheck:grid-snapshot-content-delivery` in the browser package to
`tsc --project ../../tests/fixtures/grid-snapshot-content-delivery/tsconfig.json`
and invoke it in normal package `typecheck`, after the existing owner check and
before broad `tsc --noEmit`. A log-local compiler invocation is not durable coverage.

Obtain independent Grok, Kimi (100-step cap), and Opus xhigh contract/RED/GREEN
reviews with exact input custody and dispositions at the meaningful checkpoints.
No visual artifact or screenshot gate is needed for this fixture-only seam.

## Fixed boundaries and pickup

Do not change protocol byte/chunk ceilings, persisted recovery limits, existing
grid workload sizes or timing/memory thresholds. No producer/adoption pin,
classification, retirement, declaration-free product discovery, AHE transport
change or storage API expansion belongs here. Three distinct transition scopes
fit the current count budget, subject to content capacity; retries must not add
charges. The longer diagnostic workloads cannot become post-pin endurance claims
until genuine reclamation exists. Do not increase budgets to hide that dependency.

After this prerequisite is accepted, separately freeze the producer's
verification → retention → authoritative-dependence ordering and crash/refusal
tests. Current-head, pending and rollback consumer obligations remain with the
[parent retention slice](01-recovery-snapshot-retention.md).
