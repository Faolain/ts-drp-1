# 2e-0 — Non-creating snapshot byte acquisition

Status: independently reviewed prerequisite contract accepted, 2026-10-03, under
the [root disposition](../../../.logs/bounded-storage-lifecycle/usable-rollback-prerequisite-review-01/root-disposition.md).
Execution remains held behind 2d product acceptance, separate RED readiness and
distinct GREEN. The [live handoff](../README.md#next-agent-prompt) owns execution status.
The [prerequisite review](../../../.logs/bounded-storage-lifecycle/usable-rollback-prerequisite-review-01/public.md)
supports this dependency cut and exact contract readiness, not implementation or
usable rollback completion.

## Outcome and one owner

An already admitted snapshot recovery owner can acquire and read an exact existing
scope without creating, sweeping, repairing, completing, retaining or deleting
durable content. A missing scope stays missing. Unrelated expired temporary scopes
stay untouched. Actual manifest-described bytes are read through the same owner
and its existing validation law, not through raw database access or a second cache.

This is byte access, not authenticated historical state, a retention lease, writer
permission or room rollback. The later node recovery owner authenticates the selected
cut, trust/checkpoint lineage, manifest, payload, application and ACL. Ordinary cold
and pending recovery, producer retention, receipts and live activation stay unchanged.
The full plan's genuine rollback consumption and registry-role reconciliation remain
mandatory; two readable scopes do not satisfy them.

## Single public seam

Add one required method to the existing `SnapshotRecoveryStore`, implemented by
both existing native factories:

```ts
acquireRecoveryRead(
  declaration: SnapshotQuarantineDeclaration,
  options?: Readonly<{ signal?: AbortSignal }>
): Promise<SnapshotRecoveryReadAcquisition>;

type SnapshotRecoveryReadAcquisition =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "present";
      declaration: SnapshotQuarantineDeclaration;
      state: "open" | "verified";
      retention: SnapshotRetention;
      expiresAt: number;
      reader: SnapshotRecoveryChunkReader;
    }>;

interface SnapshotRecoveryChunkReader {
  read(
    descriptor: SnapshotChunkDescriptor,
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<Uint8Array | undefined>;
  release(): Promise<void>;
}
```

The method is not optional and has no `openScope` fallback. Extend the existing
owner and exports coherently; do not add a decorating factory, alternate owner,
schema, payload copy or compatibility adapter. The declaration is an exact local
expectation supplied by the later authenticated consumer, not selection authority
for an arbitrary historical state. Its returned observation is detached from
durable records and from the reader's private captured identity.

Capture and validate the complete declaration synchronously before the first await
using the existing intrinsic byte/declaration and manifest laws. Capture options
and abort state consistently with current owner operations. Mutation of input or
returned observation across awaits cannot redirect scope, descriptors or bytes.
Do not invent a universal getter-nonobservation promise beyond existing capture.

## Acquisition and eligibility

In one native read transaction, select the exact object/epoch/anchor/manifest key,
validate its persisted declaration and metadata with the shared recovery manifest
law, compare the detached requested declaration, and capture the row's private
incarnation. No neighboring epoch, manifest or scope is an availability substitute.
Preserve exact-key precedence and the existing occupancy law: an absent exact row
returns `missing` only when its object/epoch/anchor selector is unoccupied. That
selector occupied under another manifest digest refuses with `conflict`, rather
than masking the conflict as missing. A genuinely neighboring epoch or anchor
does not occupy it. A present exact row wins over neighboring metadata; its own
malformed metadata or inconsistent manifest refuses rather than becoming missing
or a new empty scope.

Existing non-poisoned `open` or `verified` scopes are eligible for byte access under
the current shared metadata law, including temporary, recovery and inherited
legacy-unclassified retention. Recovery metadata still requires verified state.
Poisoned state refuses with the existing `poisoned` failure. An open scope can have
missing chunks; acquisition is not completion or proof of availability. Expiry and
retention are observed metadata, not extended or reclassified by reading; this
operation can inspect still-present bytes without promising they survive maintenance.

Inherited bytes remain held and unclassified. Reader success neither clears the
migration barrier nor proves migrated-room support. The later ready-v2 protected
rollback acceptance requires genuinely verified, recovery-owned targets; temporary
or legacy byte reads cannot be counted as that durable proof. Any required legacy
consumer remains a separate authenticated migration obligation, not dropped support.

Lookup is not a lease. A byte-identical, declaration-matching replacement before
acquisition may be acquired as the actual current row. After acquisition, any
different incarnation is stale, even when declaration and bytes are identical.
The incarnation is private session identity, not an export or durable retention pin.

## Actual reads, refusal and session ordering

Every read captures and checks the descriptor against the private declaration
before scheduling a native read. In the same transaction as its chunk lookup,
recheck exact metadata/declaration, non-poisoned state and captured incarnation.
Return `undefined` for an absent acquired row or chunk; refuse a replacement
incarnation with `stale-scope`: an otherwise-valid same-selector replacement is
stale even under another manifest digest. A same-incarnation declaration mismatch
uses `conflict`. Malformed metadata keeps the shared poison law rather than a
universal stale precedence. Refuse a foreign descriptor with `malformed-input`.
Persisted declaration mismatch uses `conflict`; malformed/corrupt persisted
metadata or chunk bytes use the shared `poisoned` law. Abort, closed-owner/session
and native failure retain `aborted`, `closed` and `storage-failed` respectively.
Preserve existing carrier/declaration validation failures; do not coalesce them
into a favorable missing result. Existing schema/admission failures remain intact.

Validate descriptor/index, actual chunk length and digest through the shared
`validateRecoveryChunk` law. Return detached actual bytes, not a reconstruction
from metadata. Apply current manifest/chunk limits before avoidable native-to-JS
copying and allocation. Do not claim that IndexedDB structured cloning has no
native allocation, or that returned bytes authenticate application/ACL state.
The caller must read and bind the entire selected snapshot before historical success.

Acquisition and reads are operation-level readonly: SQLite read transactions issue
no durable DML/DDL and take no intentional writer reservation; IndexedDB uses
`readonly` transactions. Reuse one native transaction owner with explicit mode,
not a second database wrapper. No transaction remains open between reader calls.
Do not route these operations through a mutating scope opener or receipt completion.
Existing factory admission/schema creation/migration occurs before this boundary
and is not covered by the readonly claim.

Release is idempotent, process-local and drains that reader's admitted work. Mark
the session closed immediately; no newly requested or not-yet-executed read may
start after release. An already executing read may finish with detached data from
its admitted transaction; release settles only after it does. Owner close prevents
new `acquireRecoveryRead` and reader calls and their not-yet-executing jobs; these
new operations check the owner's closing state when each queued job starts.
Already executing acquisition/read work
may drain before the database closes. This is new reader-local cancellation, not
a change to the existing owner scheduler's drain of previously queued `openScope`,
cold/pending or other accepted operations. Preserve those existing close semantics.
Abort must be checked before native work and at transaction boundaries; an already
terminal native outcome is not retroactively rewritten. Releasing one reader does
not close the owner or affect another reader, content, retention counters or expiry.

Later authorized sweep/cancel/deletion may race and cause missing/stale refusal.
Reading grants no hidden lease and must not delay cleanup by retaining durable pins.
Same-incarnation completion/promotion does not confer mutation rights on a reader;
the next read validates the actual row under the same eligibility law. Poisoning
or incompatible metadata change refuses rather than using the acquisition snapshot.

## Separate RED and bounded GREEN allocation

After exact contract acceptance, a separate Codex 6.1 high RED author freezes
causal owner tests and original failures before a distinct GREEN author changes
product. An absent method is wiring RED, not proof that deeper behavior ran.
RED must also establish genuine existing scope/content, corruption/replacement and
readonly-operation observation preconditions without repairing product-case stores.
Reuse accepted identity-preserving observation where sufficient; new harness work
requires a concrete behavior blind spot, instrumentation effect or unsafe cleanup.

Required actual native cases, under unchanged budgets:

- Fresh SQLite process and fresh IndexedDB recovery realms in Chromium/Firefox/
  WebKit after setup handles/workers close: exact retained declaration/chunk bytes,
  detached results and repeated reads without owner mutation.
- Missing exact scope and missing chunk, with genuine readable neighboring scopes;
  no create, sweep, fallback, receipt completion, repair or promotion. An unrelated
  expired temporary transfer remains byte-for-byte untouched by this API.
- Non-poisoned open/verified and temporary/recovery/legacy observations, incomplete
  reads and poisoning; existing metadata/carrier/descriptor/corruption failures,
  including malformed present rows not masked as missing. No migration flag change.
- Exact replacement before acquisition; identical and different replacement after
  acquisition; delete/sweep races and stale session refusal without hidden pins.
- Input/observation/result mutation across awaits, foreign descriptor and byte
  corruption; exact native read reaches and no metadata-generated payload.
- Queued and executing read versus abort/release/owner close; idempotent release,
  independent readers, completed transaction outcomes and no leaked native handles.
- Per-operation SQL/IndexedDB mode and logical census prove no durable writes or
  readwrite transaction by this seam. Factory setup effects are separated honestly.

Prospective GREEN is the shared storage contract/validation helpers and exports,
plus Node and Browser snapshot adapters' existing owner operations. No AHE,
creator cold/pending, room/chat, producer, receipt, wire, retention-policy, release,
classification, finality, journal/issuance/signing or schema changes. Necessary
fixture/public mock type evolution is tests-only RED, preserving unaffected
registrations and assertions. Any additional conflict requires demonstrated
evidence and separate allocation; GREEN cannot repair frozen tests for convenience.

Build before tests; focused strict/types/lint/format and relevant existing snapshot
owner, discovery, retention and caller preservation gates. Run actual behavior
against changed product; do not substitute diagnostic counters for reader success.
No unchanged full cold/pending matrix is repeated solely for bookkeeping. A real
runtime-input or shared-owner behavior change needs the affected preservation
checks, with existing broader failures still failed and no budget/coverage waiver.
Independent xhigh GREEN review and root raw-evidence disposition precede landing.

## Later gates remain mandatory

This prerequisite does not authenticate either rollback state, bound AHE generation
scanning or establish profile-complete historical ACL proof. Next separately
contract bounded current-floor-rooted pair selection and data authentication,
including non-settlement carriers and the older QC/checkpoint authentication limit.
Do not invoke uncapped native recovery after a racy count and call it bounded.
Return cardinality is not work/heap boundedness.

Then separately resolve the mandatory genuine room/lifecycle rollback consumer and
registry-role promotion/reconciliation without lowering host freshness, signing,
issuance or retirement safety. A generic current-epoch application restore is not
automatically that lifecycle operation. A new wire/custody authority or weakening
supported rollback requires explicit product direction, not an inferred permission.
Recipient installation/retention, protected dependencies, crash-safe retirement,
same-room endurance, archives and full golden-path/device acceptance remain open.
