# 1a-0 — Versioned snapshot owner and stale-client fence

## One question

Can the existing snapshot owner adopt the recovery lifecycle schema without
losing old bytes or allowing old clients to bypass its future ownership rules?
This slice does not expose retention, release ownership or change creator
close/adoption. The native integration RED intentionally remains RED.

The [review dispositions](../review.md) require this seam before adding an
irreversible retention operation. A schema version is not itself a SQLite
write fence; an old connection does not re-run admission on every operation.

## Frozen contract

Extend `SnapshotQuarantineStore` itself in the existing shared snapshot storage
contract, not a derived owner interface, sibling payload store or second
declaration parser. Both constructors accept optional `recoveryLimits`:

```ts
interface SnapshotRecoveryLimits {
	readonly maxRecoveryScopes: number;
	readonly maxRecoveryContentBytes: number;
}
type SnapshotRetention = "temporary" | "recovery" | "legacy-unclassified";
// Existing status.kind remains "open" | "poisoned" | "verified".
// Add status.retention: SnapshotRetention.
```

The initial durable defaults are four recovery scopes and 268,435,456 aggregate
recovery content bytes, store-wide across objects. These are admission limits,
not proof that every dependency fits. Content charge is payload `totalBytes`
plus exact manifest byte length. Four maximum-size snapshots do not fit; even
a maximum-size payload plus its manifest exceeds the default. No physical
allocation or total-memory claim follows from this content budget.

Verified-record metadata has separate field/cardinality bounds supplied by
the manifest contract (object ID at most 1,024 JavaScript characters, at most
2,048 chunks, manifest at most 212,387 bytes). Later retention must validate
that contract; the adapter's current general scope parser alone does not bound
object ID length. Ordinary temporary accumulation remains later admission
work, not a claimed result of this slice.

Limits are positive safe integers, copied and persisted once. Omitted limits
on reopen use the persisted values; explicit equal limits succeed; explicit
different limits refuse `policy-mismatch` without mutation. Concurrent first
openers serialize; no last-opener-wins update or resize API exists.

The constructor envelope admits exactly `{primaryFilename}` or
`{primaryFilename, recoveryLimits}` on Node, and the corresponding
`primaryDatabaseName` forms in the browser. Explicit `recoveryLimits: undefined`
is malformed, not omission. A supplied limits record has exactly the two named
fields. Wrong shapes, extra fields and non-positive/non-safe-integer values
refuse `malformed-input` before opening or mutating the database. Capture values
synchronously before asynchronous work. Lock contention may refuse
`storage-failed` without mutation and be retried; serialization guarantees one
durable policy, not indefinite waiting or guaranteed success for every opener.

Add noncreating, nonsweeping inspection:

```ts
inspectRecovery(
  declaration: SnapshotQuarantineDeclaration,
  options?: Readonly<{ signal?: AbortSignal }>
): Promise<
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "present"; status: SnapshotQuarantineStatus }>
>;
```

Inspection recaptures input and checks the recorded identity described below.
It never creates an empty row, promotes, refreshes expiry or runs maintenance.
An absent exact key with no sibling manifest at the same object/epoch/anchor
returns `missing`. An occupied sibling manifest or a disagreement with recorded
identity rejects `conflict` without mutation. Any matching persisted row,
including expired, poisoned or unfinished data, returns `present` with its
original status and expiry. It is not lookup-by-head or proof of authenticated
recovery eligibility.

New v2 scopes persist the complete captured descriptor vector at creation,
alongside scope key, exact manifest bytes, total bytes and chunk count. Compare
that vector too, even before chunks have been written. This remains structural
quarantine admission; do not add protocol-manifest verification before receipt
completion.

V1 did not persist descriptors for unwritten chunks. Migration must mark that
vector as unavailable rather than invent it from a caller or decode an
unverified manifest as historical fact. Legacy identity compares the persisted
scope/manifest/total/count and every occupied chunk's index/digest/length against
the captured declaration. Unwritten descriptor values cannot be checked and
must not be represented as verified historical equality. The read-only hold
makes this narrower observation non-authoritative: it grants neither mutation
nor retention. Preserve malformed-but-previously-admitted manifest bytes too;
authenticated classification must later resolve their disposition.

Expose the durable owner counters through one observational method, not raw
table inspection or a second accounting cache:

```ts
interface SnapshotRecoveryOwnerStatus {
  readonly limits: SnapshotRecoveryLimits;
  readonly recoveryScopes: number;
  readonly recoveryContentBytes: number;
  readonly legacyUnclassifiedScopes: number;
  readonly legacyUnclassifiedContentBytes: number;
  readonly migration: "ready" | "classification-required";
}
recoveryStatus(options?: Readonly<{ signal?: AbortSignal }>)
  : Promise<SnapshotRecoveryOwnerStatus>;
```

This method is noncreating and nonsweeping, returns a detached immutable view
of one durable transaction, and grants no mutation authority. Recovery counters
are zero in 1a-0 because retention is not exposed yet. Migration is
`classification-required` exactly when the unclassified count is nonzero.
This is the normative debt/policy inspection seam; adapter tests need not
invent an internal metadata row layout.

Every newly created durable scope gets a fresh persisted random incarnation;
every handle captures it. Existing handle operations check both declaration
and incarnation in the same transaction as their read/mutation. Browser chunk
reads therefore include the scope store as well as the chunk store. A stale handle
cannot act on a deleted-and-recreated identical declaration. Missing scope
keeps the existing absent/expired behavior; an occupied replacement refuses
`stale-scope`. Cancel requires a live handle; release cannot leave a deletion
capability behind. An already canceled live handle may retain its harmless
idempotent cancel behavior, but released handles refuse.
Queued operations recheck session liveness when they run; a release that wins
before a queued cancel runs must prevent its deletion. Reads of an absent scope
return `undefined`; status/missing/completion retain the existing `expired`
refusal for an absent scope. A still-live cancellation of an absent scope is a
harmless no-op. An occupied replacement always refuses `stale-scope` before
examining or mutating its payload. Aborted operations use the existing `aborted`
code, and closed stores/handles use `closed`.

Cancellation is a promise-returning operation, including preflight refusal:
released/closed/aborted cancellation returns a rejected promise with the
classified code rather than throwing before a caller can attach `.catch`.
Discriminate invocation failure from promise rejection in the oracle. Do not
broaden this correction into rewriting unrelated historical method behavior.
When an operation discovers malformed owner metadata, preserve the shared
classified failure across adapter catch boundaries; sweep must not hide
`unsupported-schema` inside a generic `storage-failed` wrapper.

## Shared local contract owner

Move the duplicated declaration/descriptor/exact-carrier validation and error
class out of both adapters into the existing storage subpath. Export one frozen
`snapshotQuarantineContract` value containing `limits`, `defaultRecoveryLimits`,
`captureDeclaration`, `captureDescriptor`, `captureExactBytes`,
`captureRecoveryLimits`, `recoveryContentBytes`, `addRecoveryContentBytes`,
`createError` and `isError`. The class and implementations remain private; any
necessary public error/limit shapes are types. Backend-specific constructor
envelopes and diagnostics remain at the adapter boundary.

`limits` names `maxManifestBytes`, `maxChunks`, `maxSnapshotBytes` and
`snapshotChunkBytes`, preserving the current respective ceilings of 212,387,
2,048, 268,435,456 and 131,072. Preserve existing carrier acceptance, defensive
copy timing and failure classification. Do not replace exact byte capture with
permissive conversion or declaration capture with protocol verification.
Receipt consumption remains in each adapter's completion transaction; storage
must not acquire compaction/receipt authority.

## Same-owner migration

Keep the existing database/file name; do not copy payloads into a sibling v2
database. Validate the exact supported v1 schema before mutating it. Unsupported
or malformed schemas refuse without clearing, overwriting or resetting data.

Browser: upgrade IndexedDB to version 2 and introduce durable owner metadata
plus retention/incarnation fields. Old owner handles must close through the
existing versionchange behavior before v2 becomes usable. An uncooperative old
connection blocks admission rather than coexisting with new semantics. Bound
blocked-open waiting, reject without resetting the database, and ensure a late
open completion cannot leak a handle or commit a canceled migration.
Use a 1,000 ms blocked-wait deadline beginning at the `blocked` event, returning
the existing `storage-failed` code with a migration-blocked diagnostic. This is
not a timeout on an already-running upgrade transaction. The native test may
allow 2,000 ms scheduling tolerance while keeping the blocking connection open;
after refusal, releasing that connection must not cause the canceled request
to commit v2 or leak a returned handle.
Disarm the blocked timer when `upgradeneeded` begins or open succeeds. If the
deadline already refused the request, a later `upgradeneeded` must abort and a
later successful connection must close without being returned. This applies to
slow cooperative connections too and is retryable. Do not allow a canceled
pre-upgrade request to commit merely because its blocker eventually closes.

Remove the constructor's hypothetical maximum-snapshot free-space precondition:
opening existing recovery bytes does not admit that payload again. Do not keep
an unused capacity-estimate call just for the old assertion. Actual metadata
allocation failure must abort migration, preserve the old schema/data and
report `storage-failed`; unsupported schema still reports `unsupported-schema`.
Operation-specific temporary admission remains slice 8, not a replacement quota
mechanism added here. This explicitly supersedes the Phase 4c constructor's
one-estimate-call expectation, not the actual allocation-failure safety rule.

Node: atomically rename `snapshot_scopes` to `snapshot_scopes_v2` and
`snapshot_chunks` to `snapshot_chunks_v2`, create `snapshot_owner_v2`, install
metadata/fields and advance the schema version in one transaction. Preserve
foreign-key/cascade semantics. Leave no writable old-name aliases. Both already
prepared and newly prepared v1 statements on an already-open old connection
must refuse after commit. A user_version bump alone is expressly insufficient.

All inherited v1 scopes become `legacy-unclassified`, retaining exact bytes,
verification state and original expiry. Assign their durable incarnations.
Do not infer temporary eligibility from age or automatically promote every
verified legacy row. Sweep cannot remove unclassified rows.

While any legacy scope remains unclassified, preserve noncreating inspection
and existing-byte reads; refuse new scope creation, writes, completion,
cancellation and other mutations with `migration-required`. Close and release
remain available. An existing scope may be opened for reading without running
sweep or changing its bytes. New mutations are blocked even if the inherited
content happens to fit the default budget.

`sweepExpired` during this barrier returns zero as a read-only no-op: it does
not delete rows, refresh expiry or change owner counters. It does not return an
alternative migration refusal. This preserves the method's exact deleted-count
meaning while classification is pending.

The barrier's precedence for otherwise well-formed live calls is:

| Operation                                               | Result while classification is required                              |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| Open existing matching identity, including expired data | Read handle; no sweep, refresh or mutation                           |
| Open occupied conflicting identity                      | `conflict`, unchanged                                                |
| Open missing scope                                      | `migration-required`, no insertion                                   |
| Inspect/status/missing/chunk read                       | Recorded observations, subject to identity/incarnation checks        |
| Chunk write, completion or cancel                       | `migration-required`, even if the requested write appears idempotent |
| Sweep                                                   | Zero, read-only                                                      |
| Release/close                                           | Available; no durable mutation                                       |

Persist/report inherited scope count and content bytes as migration debt.
Debt above the new limits is preserved, not truncated and not represented as
bounded new storage. Use checked arithmetic; do not materialize all historical
payloads or scopes in JavaScript arrays during migration/inspection. This is a
data-preserving store-level barrier, not transparent room write continuity.
Authenticated classification is a named subsequent prerequisite before
enabling writes on migrated populated stores.
Legacy charge uses the same declared `totalBytes` plus exact manifest byte
length, including unfinished scopes; it is not a count of only written chunks.
If stored arithmetic or aggregate debt cannot be represented exactly as safe
integers, refuse `storage-failed` and roll back admission without truncating old
rows. Persist the debt and recovery counters with owner metadata, rather than
rescanning all scopes on every status call. Internal field/column layout remains
the adapter's responsibility, with exact v2 schema admission and current
conformance fixtures matching the implemented format.

Migration must not rely on unique/complete results from an unfinished SQLite
SELECT while the same connection updates its table. SQLite explicitly permits
an updated row to reappear in subsequent steps of that query; a passing probe
on one database shape is not a guarantee. Use completed selections/keyset
traversal or another mechanism with defined semantics, without accumulating
all historical keys in an array or set. Keep all migration work in the same
atomic transaction. See [SQLite's same-connection isolation rules](https://www.sqlite.org/isolation.html).

For a fresh or empty migrated owner, existing temporary transfer behavior
continues, including expiry and receipt-gated verification. There are no
recovery-owned rows yet. Do not expose `retainForRecovery` without its atomic
budget in the following slice.

## RED and GREEN custody

A separate RED author writes adapter-contract tests against actual browser and
Node factories, freezing the exact new API expectation and existing-byte
controls. A distinct GREEN author implements this seam only after causal RED
and source custody are recorded. A new API may initially be absent; that is
separate from the already-executed native product failure.

Required cases:

- Fresh initialization/default policy; explicit policy validation, mismatch
  refusal and concurrent initialization; omitted-policy reopen.
- Noncreating/nonsweeping inspection of missing, expired, valid and mismatched
  declarations, including an unwritten v2 descriptor mismatch; exact status
  semantics and no row-count/expiry mutation.
- Exact v1 migration with expired verified and unfinished scopes; unchanged
  manifest/chunks and original expiry; legacy hold and mutation refusal.
- Inherited over-budget debt preserved; no old-row truncation or auto-pinning.
- Legacy unknown-descriptor observation does not invent equality or authorize
  mutation; low-free-space browser reopening still reads preserved bytes.
- Actual old browser adapter handle/version-1 open and actual old Node adapter
  connection cannot mutate v2 rows. Keep an old-source fixture solely for this
  compatibility proof, not an alternate production owner.
- Node prepared-statement, new-statement and foreign-key controls; interrupted
  migration yields complete old or complete new schema, never partial data.
- Released handle and identical-declaration ABA controls across cancel,
  write/read, complete, missing-indices and status operations.
- Fresh temporary verify/expiry/cancel and existing transfer regressions.
- Classified owner-metadata sweep refusal with unchanged durable image, and
  cancellation invocation/rejection discrimination on both adapters.
- Bounded injection of SQLite's documented possible cursor reappearance after
  an actual overlapping UPDATE; independent native controls prove the fault
  arms on unfinished reads and does not arm on completed reads. The migration
  must preserve exact debt/count and final per-key incarnations. This is a
  labeled fault model, not a claim of naturally observed duplicate rows.

The previous SQLite probe is mechanism evidence only. Use actual adapter
factories and native browser version-change behavior before accepting this
slice; fake IndexedDB cannot establish browser upgrade process behavior.

Log focused RED, strict typecheck, lint/format, affected tests and terminal
process state. Record pre-existing package diagnostics separately. Apply the
requested Grok, Kimi capped at 100 steps, and Opus xhigh implementation reviews
at this substantive checkpoint, including dispositions. No screenshots are
needed for this storage seam.

## Named local-storage contract amendment

This sub-slice deliberately supersedes the v1-only local storage surface/schema
expectations in the Phase 4c quarantine contract fixtures and adapter tests.
Update their current conformance expectations to the added owner inspection,
status retention, constructor policy and v2 schema, preserving their original
receipt, canonical identity, byte ceilings, poisoning, abort and restart
assertions. Raw census/crash helpers must query the real v2 tables; do not add
old writable aliases merely to keep a test green. Preserve exact v1 source in
the narrowly scoped historical-client fixture and preserve past evidence.
The shared snapshot-transfer subpath runtime roster becomes exactly
`SNAPSHOT_QUARANTINE_RETENTION_MS` and `snapshotQuarantineContract`. Amend its
closed roster explicitly; the root roster remains unchanged. Also authorize
only the new store-method pass-throughs in the existing Phase 6a
`tests/fixtures/phase-6a-v3/creator-adoption-contract.ts` decorator, preserving
all its fault-injection and authority semantics.
The existing deferred-availability image-transfer fixture in
`tests/fixtures/grid-room-workload.ts` must likewise match the real v2 snapshot
schema, including coherent owner metadata. Preserve its exact schema and
namespace/source/destination guards and prohibition on issuance/journal copies.
That fixture remains a test-only image delivery mechanism, not proof of
production transfer admission or authority to import recovery ownership.
No protocol carrier bytes, crypto domains, receipt authority, package export
map or root runtime export roster changes are authorized by this amendment.

## Following seams and hard limits

1a-1 adds `scope.retainForRecovery(options?)` with no caller reference, deriving
verification from exact durable state and enforcing count/content-byte limits
atomically. Every pre-close/pending retained snapshot consumes that same pool;
there is no uncharged pin category. Already-owned retry is idempotent after TTL
and when full. No demotion or unpin is introduced.

1a-2 supplies authenticated legacy classification before existing-room write
enablement. 1b then promotes before close signing and other dependence, with
the frozen native integration RED and distinct crash/pending/rollback cases.
Authenticated release remains required for sustained transitions; a full
intermediate budget must backpressure, never silently increase or discard a
dependency. Do not claim thousand-epoch acceptance from this adapter work.
