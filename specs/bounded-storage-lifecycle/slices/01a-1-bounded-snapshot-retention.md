# 1a-1 — Bounded durable snapshot retention

Status: contract amended after independent review, 2026-09-07. The preceding
[versioned-owner seam](01a-0-versioned-snapshot-owner.md) is accepted in the
[evidence ledger](../evidence.md). The requested Grok, Kimi (100-step cap), and
Opus xhigh reviews are terminal; root dispositions are in [review.md](../review.md).
Corrective causal RED and fresh immutable-input reviews are accepted; their
root dispositions are in [review.md](../review.md#corrective-1a-1-red-acceptance).
The distinct GREEN author is authorized to implement this frozen contract without
editing its RED tests. No implementation acceptance is claimed yet.

## One question

Can an exact, verified temporary snapshot acquire durable recovery ownership
atomically, within the persisted count/content budget, and remain safe through
expiry, concurrent calls, abort and uncertain completion?

This seam does not sign a close, publish a pending/head dependency, classify
legacy data, discover declarations, release ownership or enable endurance.
Its full pool must backpressure. It must never expand limits or evict a
dependency to make another promotion fit.

## Operation and ownership

Add to the existing scope capability:

```ts
retainForRecovery(
  options?: Readonly<{ readonly signal?: AbortSignal }>
): Promise<void>;
```

Add only `recovery-full` and `recovery-owned` to the shared failure-code union;
keep the existing code classifications otherwise. There is no caller reference,
receipt, expiry override or per-call limit.
Success acknowledges durable ownership, not new protocol/authentication
authority. The operation uses the handle's captured declaration/incarnation
and the actual persisted verified state. `complete()` remains the receipt-gated
verification transition; ordinary verification must not pin temporary bytes.

Preserve `kind === "verified"` and original expiry; change only retention and
the owner's two recovery counters. All retained staging, current and pending
snapshots use this same pool. There is no free pin category or demotion API.

The exact valid already-owned retry is a no-op, including past its former TTL
and with a full pool. It must still validate identity and closure. Release
remains session-only and cannot remove durable ownership.

## Refusals and precedence

Capture options before queuing; reject closed/released or aborted calls under
the existing rules, and recheck liveness and cancellation when work starts.
This new method always returns a promise, including preflight refusals; do not
inherit the unrelated historical methods' invocation-time abort asymmetry.
Within the transaction:

1. Use the existing recorded-row admission and identity rules. Malformed row
   headers may refuse `poisoned` before incarnation comparison; for a well-formed
   row, an occupied replacement is `stale-scope`, identity disagreement is
   `conflict`, and absence is `expired`. Preserve these existing fail-closed
   checks rather than adding a competing narrow-header lookup path.
2. Apply the existing store-wide legacy classification barrier:
   `migration-required`, unchanged.
3. Reject poisoned scope state with `poisoned`. A recovery role whose state is
   not verified is also `poisoned`; ownership must never be silently repaired
   through retention or ordinary verification.
4. A temporary scope at or beyond expiry is `expired`, without sweeping.
5. Anything other than verified is `incomplete`, even if all bytes are present.
6. Check complete exact closure. Visit every occupied key in the selected scope
   prefix. Extra/corrupt chunks, malformed keys or inconsistent canonical
   manifest/descriptor identity are `poisoned`, even when expected chunks are
   also missing. Only a valid proper subset of expected chunks is `incomplete`.
   These checks follow all preceding guards. Neither refusal mutates or repairs.
7. Valid already-owned retry succeeds unchanged.
8. New admission exceeding either durable bound refuses `recovery-full`.
9. Otherwise install recovery ownership and increment both counters atomically.

Invalid/unsafe counters and arithmetic refuse `storage-failed`, not a capacity
code. Counter validation must not coerce strings or BLOBs into numbers. Preserve
the existing owner-admission classifications for other malformed metadata.
This explicitly requires changing Node's central `ownerStatus` counter reads:
reject non-number SQL counter values with `storage-failed` before arithmetic,
rather than passing them through `Number()`. No new schema or BigInt API is needed.
Do not promise to detect arbitrary internally consistent raw-file
tampering by doing an unbounded recount on every operation.

Live cancel against an admitted recovery-owned row refuses `recovery-owned`,
unchanged. Session, existing recorded-row admission/identity, and legacy barriers
precede that guard. Missing chunks or an altered valid state flag cannot permit
deletion. A structurally corrupt header may instead hit the existing
`poisoned`/`conflict` refusal; exact error precedence is not permission to mutate.
Sweep excludes recovery rows.

Recovery ownership independently forbids port writes; do not rely only on
`state === "verified"`. Ordinary verified writes keep their `closed` refusal;
an owned row with nonverified state refuses `poisoned`, without filling missing
chunks, refreshing expiry or poisoning previously occupied content through the
ordinary conflicting-write path. `complete()` likewise cannot repair an owned
row whose state became nonverified: guard before missing-chunk checks or receipt
consumption, preserving authority as well as durable bytes. Retention's same
guard precedes closure checks. Completion's existing receipt behavior may remain
for already-verified owned rows, which requires no durable mutation. No new
receipt authority or corruption-repair API is introduced. Existing noncreating
inspection, reads and status remain usable after the former TTL.

## Exact closure without a second protocol parser

Use the existing protocol-v3 snapshot manifest decoder and index-bound chunk
digest. They own canonical bytes, digest domains and manifest field bounds.
Keep ordinary structural quarantine admission distinct from retention-time
validation; do not retroactively reject malformed-but-previously-admitted
legacy manifest bytes during migration.

The shared snapshot contract should own the pure synchronous manifest/descriptor
and per-chunk validation laws. Adapters own transactional row traversal and
commit/abort mechanics. Do not duplicate a decoder, digest implementation or
closure-membership policy in both adapters, or put receipt authority in storage.
Add exactly these synchronous properties to the existing frozen helper value,
without adding top-level runtime exports:

```ts
validateRecoveryManifest(declaration: SnapshotQuarantineDeclaration): void;
validateRecoveryChunk(
  declaration: SnapshotQuarantineDeclaration,
  descriptor: SnapshotChunkDescriptor,
  exactBytes: Uint8Array
): void;
```

Call manifest validation once at step 6, after the preceding transactional
guards, not immediately after identity admission. Chunk validation checks index membership and exact descriptor,
length and index-bound digest; it must not recapture/decode the manifest or
traverse the entire descriptor vector for every chunk. These pure checks grant
no durable or protocol authority. Invalid canonical/closure content is
`poisoned`; backend read/allocation errors outside those checks remain
`storage-failed`.

Validation compares the captured declaration with the durable manifest,
descriptor vector, scope identity and incarnation. Decode the manifest against
its expected digest, then compare all identity/total/vector fields. Visit every
occupied chunk for the selected scope, checking exact index, digest, length and
bytes. Include unexpected indices outside the ordinary descriptor range; a
range that hides extras cannot establish exact closure. Traverse at most one
payload chunk at a time, never concatenate the full payload or scan other
scopes. Manifest/vector work is bounded by the existing protocol limits.

The browser's old `[0, MAX_CHUNKS]` chunk-index range cannot establish exact
closure. A complete scope-prefix interval may use the four-part scope key as
its lower bound and `[objectId, epoch, anchor, manifestDigest + "\0"]` as its
exclusive upper bound. Validate every returned key suffix and its agreement
with the stored row's index; include negative, oversized and non-number key
controls in native tests. Do not load the next scope's payload to determine
that the selected prefix has ended.
Adapters classify malformed raw key shapes and key/row disagreement as
`poisoned`. The shared helper owns descriptor shape and membership validation
and maps invalid stored descriptor content to `poisoned`; do not route it
through the caller-input capture path and leak `malformed-input`. Keep one
membership law, not a second adapter-local descriptor validator. Preserve the
historical `chunkRange` users and ordinary completion/error taxonomy; the new
complete-prefix traversal belongs to retention.

Reusing protocol-v3 from the shared storage contract requires an explicit
runtime dependency amendment (and lock/build declarations where applicable),
not an undeclared transitive import. Source inspection found no reverse
protocol-v3 dependency on storage. Root/package export maps and protocol carrier
bytes remain unchanged. Extend only the named shared helper value as needed.
The package dependency and lock importer must order protocol-v3 before storage
in the topological build: the subpath resolves through protocol-v3's built dist,
not a new root path alias. Verify that build ordering explicitly.

## Admission, durability and uncertainty

Charge declared payload bytes plus exact manifest byte length. Check count and
content limits and write role/counters in one serialized durable transaction.
Same-scope concurrent calls charge once; competing scopes cannot oversubscribe.
Do not use a browser quota estimate as the logical admission check.
Keep the accepted 1a-0 default limits unchanged. The content budget includes
the manifest, so a maximum-size legal payload cannot be retained under the
default content limit even into an empty pool. This is intentional backpressure,
not permission to omit manifest charging or silently raise the limit.

Browser retention uses one readwrite transaction spanning owner, scopes and
chunks. Require its reported `durability` hint to be `strict`, not merely an
accepted request option on a runtime lacking that property. Unsupported
durability refuses `storage-failed` before invoking the operation or writing.
Abort/observe is cleanup of that earlier classified refusal and must not
relabel it as `aborted`. Resolve
success only after native transaction completion, not request success. Use
native request sequencing and synchronous hashing; no unrelated asynchronous
work inside that transaction. Extend the existing transaction owner, not a
parallel retention transaction wrapper:

```ts
transact(database, mode, operation, options?: {
  signal?: AbortSignal;
  requireStrictDurability?: boolean;
});
```

Retention opts into the active signal and strict-capability requirement.
Inherited operations need not gain unrelated new active-abort behavior.
Evolve the existing terminal observer to settle only on native `complete` or
`abort`: a transaction `error` event is evidence, not terminal noncommit proof.
Install observers immediately after transaction creation; reject missing,
default or relaxed reported durability before invoking the operation, aborting
and observing that transaction's termination.

Node retains the existing BEGIN IMMEDIATE, WAL and synchronous FULL discipline.
Success follows COMMIT acknowledgment. A COMMIT acknowledgment error or process
death may leave a committed operation whose caller saw failure or no result.
Do not describe every `storage-failed` as rollback.

`aborted` must mean confirmed noncommit. If cancellation arrives while a browser
transaction is active, its outcome must follow actual abort/complete evidence,
not the signal alone. Late cancellation cannot turn a committed success into a
claimed rollback. The active signal handler requests native abort but does not
settle the public promise; remove it at terminal settlement. Preserve an earlier
classified validation/backend refusal rather than relabeling it when a later
signal arrives. With no earlier failure, accepted cancellation followed by
native abort is `aborted`; successful work followed by native complete is
success, even if abort was requested too late. If `abort()` throws because the
transaction has advanced, await its actual terminal event. Never recheck the
signal after successful commit and retroactively claim noncommit.

Physical I/O/allocation failure remains `storage-failed`; avoid invented
backend-specific public error codes. Scope release during a transaction is
session release, not compensation or an active cancellation request. Preserve
the existing rule that a release winning before queued work starts prevents
that work from running.

After uncertainty, reopen the store and use noncreating, nonsweeping
`inspectRecovery` before any ordinary `openScope`. Retrying uses the existing
`openScope`, whose sweep excludes committed recovery rows; the same declaration
then acquires a new handle and retries without another charge. An uncommitted
temporary row may expire and be swept between inspection and `openScope`;
the newly created empty scope must refuse retention as `incomplete`, never
acknowledge phantom verified recovery. Pin this TTL race in RED. Missing
inspection may require a fresh transfer by a later consumer, not a new
noncreating-open API in this slice. No cancel, release of durable ownership
or deletion is authorized as compensation. A later consumer may depend on the
snapshot only once durable ownership is established; this slice adds no such
consumer behavior.

## Runnable seam and ownership

The human-runnable surface is the native adapter harness, not a new application
or UI. Keep the shared retention oracle under
`tests/fixtures/snapshot-recovery-retention/`; add
`packages/storage-node/tests/snapshot-recovery-retention-red.test.ts` and the
corresponding browser `snapshot-recovery-retention-red.pw.ts`, asset entry and
Playwright configuration. Extend the existing durable snapshot-owner strict
project to include this graph. The existing product
`recovery-retention-red.pw.ts` remains a different, unchanged integration oracle.
Mirror the owner graph's browser package compiler exclusions for the new RED,
asset and Playwright configuration; the durable strict project, wired into the
normal package check, remains their typecheck owner.

The shared storage snapshot contract owns canonical closure validation and
accounting rules. The existing adapters own native transaction enforcement and
persistent rows; the existing receipt owner remains the sole authority for
verification. No payload-copy store, adapter-local protocol parser, second
transaction wrapper or uncharged pending-pin category is permitted.

## Separate RED and GREEN

A distinct RED author must establish causal failures before GREEN. Preserve
the 1a-0 safety tests, historical v1 fixtures and all prior evidence. Explicitly
supersede the 1a-0 `fresh` observation that retention is absent: the next
contract requires its presence. Preserve the old source and results, and update
the active observation/expectation together in RED. Keep historical legacy
scope annotations honest by excluding the new method from that old surface.
Also amend the Node 1a-0 exact helper-key roster for the two named validation
properties, keeping the top-level export roster unchanged. These are the only
1a-0 supersessions. Archive their previous source/results before editing.
Separate the legacy scope from the current scope: derive the legacy shape by
omitting `status` and `retainForRecovery` from the production type and retaining
its historical status signature. Override `openScope` on
`Omit<LegacyStore, "openScope">` for the current store, returning the current
production scope type. Do not intersect competing legacy-first overloads or
duplicate the current production API shape.
Required new
adapter cases include genuine receipt-created verification; every refusal with
full unchanged-image/counter checks; exact TTL boundary; repeated and concurrent
admission; each bound independently and manifest charging; cross-store races;
released/ABA handles; sweep/cancel protection; corruption and missing/extra
closure controls; and noncreating inspection after uncertain completion.
Include a manageable multi-chunk payload case, not only the tiny fixture;
do not allocate the maximum legal payload merely to restate budget arithmetic.
Include an owned scope corrupted to a valid nonverified state, with both a
missing chunk and conflicting occupied bytes: attempted write and completion
must preserve the full image, expiry and counters. Label raw-row corruption as
fault injection rather than a state reachable through supported operations.

Use actual native browser transactions for strict durability and asynchronous
abort-after-request-success controls. Injected failures must be labeled, not
represented as disk exhaustion. Native process-death tests must prove the
intended interior/committed edge was reached and inspect before a repairing
reopen or retry. On Node, distinguish precommit rollback from committed-but-lost
acknowledgment, and prove retries do not double-charge.

The RED author must amend Phase 4c's normative `SnapshotQuarantineScope` in
`tests/fixtures/phase-4c-v3/snapshot-quarantine-types.ts` with the exact required
method, plus the session-method and failure-code rosters in its contract file.
The exact type oracle and its pull-oracle re-export are dependent gates; changing
only the otherwise unconsumed method roster is insufficient. GREEN must not
weaken these normative expectations. The GREEN author may add only the new
method's mechanical pass-through to the Phase 6a scope decorator, preserving
all fault/authority behavior. No creator integration is authorized here.
The test-only grid image copier retains its temporary-only source guard.
Its current destination clearing is not yet a recovery-safe transfer mechanism:
the symmetric destination-debt guard or replacement by real transfer/admission
belongs to 1b before any consumer can feed it owned destinations. Do not claim
that future invariant is enforced here or expand 1a-1 into image import policy.

Keep prior quarantine, transfer/adoption and unchanged grid64 gates green.
Preserve the native product retention RED as an expected remaining obligation
until creator integration. Record strict typecheck, lint, tests, source custody,
terminal process status, and requested independent implementation reviews.
No storage seam screenshots or thousand-epoch acceptance claims.
Use a durable strict harness project, wired into the normal package check,
rather than excluding the cross-package test graph with only log-local coverage.

## Platform evidence boundary

IndexedDB defines `durability` as a hint, not an application-visible flush
measurement. Requiring reported `strict` and observing native completion is the
supported API contract; it cannot prove physical media persistence or immunity
to device failure. The specification distinguishes request events from terminal
transaction events, and `abort()` may throw once committing has begun. These
rules motivate the terminal observer and late-cancellation controls, not a new
storage guarantee. See the [durability definition](https://www.w3.org/TR/IndexedDB/#transaction-durability-hint),
[commit algorithm](https://www.w3.org/TR/IndexedDB/#commit-transaction), and
[`abort()` method](https://www.w3.org/TR/IndexedDB/#dom-idbtransaction-abort).
Native browser automation and later release-device evidence remain separate.

## Remaining review questions

- Validate the shared helper and active-cancellation contract against independent
  adapter REDs and native terminal-event controls before GREEN.
- Resolve legacy-classification dependency ordering separately: authenticated
  discovery/protected planning may precede enabling migrated-room writes.
- Treat 1a-0/1a-1 as unshipped sub-slices of the same v2 release; if a v2 owner
  lacking cancel protection is actually deployed, it needs a new stale-client
  fence before recovery rows can exist.
