# 2e-1 — Bounded active-generation acquisition

Status: independently reviewed contract accepted, 2026-10-03, under the
[root disposition](../../../.logs/bounded-storage-lifecycle/rollback-bounded-read-contract-review-01/root-disposition.md).
This is a native storage prerequisite, not profile-complete authenticated history
or usable rollback. Separate RED readiness, distinct GREEN and independent product
review/root acceptance remain required. The [live handoff](../README.md#next-agent-prompt)
owns execution status; the [snapshot reader](02e-0-noncreating-snapshot-read.md)
continues as an independent prerequisite. Serialize overlapping GREEN owners and
integration; this contract does not authorize changes to that reader's frozen oracles.

## Decision and sequencing

Add one required readonly `acquireBoundedActiveRead` to the **existing**
`AheDurableStore`, selecting actual active plus zero or two immediate parents in
one native snapshot. Use the fixed reviewed read-resource profile below and refuse
an over-budget object without modifying it or poisoning its owner.

**Producer admission is not a prerequisite for this safe, useful read seam.** It
is required later for sustained availability through thousands of genuine epochs,
including stalled maintenance and every supported profile. The earlier policy
memo's proposed producer-admission-first ordering is not adopted here. A readonly
observer may safely refuse valid debt; it cannot promise every existing object
fits, implement maintenance, or count that refusal as complete usable rollback.
This preserves the required rollback-before-later-admission/retirement sequence.

## Fixed resource policy, not an inferred producer admission law

| Bound                                         | Fixed read profile          | Source/representation rationale                                                                                                     |
| --------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| G, total object generation rows               | 7                           | Fixed observer entitlement; every row/state counts, including both shipped bootstrap records. Genuine unpruned epoch three refuses. |
| H, encoded head bytes                         | 3,326                       | Closed storage-v1 envelope; object ID≤1024 UTF-16 units, ≤3072 UTF-8 bytes; 64-hex IDs/digests and safe revision.                   |
| F, refs per examined generation               | 7                           | Largest clean current producer L closure, aggregate+retirement; settlement L≤6 and genesis L=2. Generic refs also count.            |
| R, encoded generation bytes                   | 7,307                       | Conservative closed-v1 bound `6627+v(F)+97F`, with `v(7)=1`; no whole-decoder default allowance.                                    |
| B, each selected blob's declared/actual bytes | 65,536                      | Largest current mandatory ACL ceiling; trust/cut/QC≤8192, retirement/aggregate≤8192 each, settlement≤32768.                         |
| U, distinct selected blob-byte sum            | 262,144                     | Clean L/Q/L union: two sets of trust/cut/QC/projection/control/ACL; `2*(3*8192+8192+32768+65536)`.                                  |
| Metadata decode depth/items                   | Head 2/33; generation 4/127 | Exact closed-v1 structure; generation items `57+10F`; applied together with byte gates before avoidable copy/decode.                |

These are reviewed **local observer entitlement limits**, not existing global caps,
measured budgets or wire validity rules. Execution cannot raise them to fit a failing run. They are not a heap
budget increase. No object, ref, catalog or profile is silently exempted.

### Fixed entitlement and actual producer debt

The new native producer evidence, independently accepted under the
[empirical disposition](../../../.logs/bounded-storage-lifecycle/bounded-active-read-red-review-01/root-disposition.md),
supersedes the earlier source-only bootstrap-one premise. Actual shipped
epoch 0/1/2/3 checkpoints contain **2/4/6/8** rows without settlement cleanup and
**2/3/3/3** with it, across all three engines. Both bootstrap records count.
The bounded advance removes obsolete refs from the new closure; it does **not**
delete generation rows. Actual successor cleanup may return without a settlement
frontier, either maintenance capability or supported availability policy in the
[successor cleanup owner](../../../packages/node/src/v3-live.ts).

Successful settlement cleanup retains three, erases both earlier bootstrap
records and normalizes the selected oldest L's base through the
[node planner](../../../packages/node/src/internal/closed-epoch-cleanup.ts) and
[transactional maintenance owner](../../../packages/storage/src/maintenance.ts).
The genuine epoch-three oldest is the accepted epoch-two head, not a synthetic
genesis substitute; reading it must not walk its erased prefix.

**G=7 remains unchanged.** Genuine unpruned nonsettlement epoch three therefore
requires whole, nonpoisoning budget refusal before generation values. This is
safe observation, not usable rollback availability for that debt state. The
entitlement is neither a retry/fork admission cap nor permission to choose seven
preferred rows. Supported sustained availability remains a mandatory later
maintenance/admission obligation; this empirical correction authorizes no
producer redesign, budget increase or weaker full-profile requirement.

### Full closure and carrier qualifications

The prior [policy derivation](../../../.logs/bounded-storage-lifecycle/rollback-bounded-policy-plan-01/proposal.md)
owns the clean F/B/U arithmetic and detailed carrier bounds. Current producers
preserve generic refs; scan limits and selected byte limits apply to **all** refs,
not just recognized proof kinds. An in-budget generic blob is fetched and verified
normally. Any excess refuses the whole read; there is no trimming, generic exclusion,
neighbor selection, hidden fallback, deletion or debt classification. A metadata
budget refusal does not assert an unexamined row is valid or corrupt.

The clean projection≤8192 derivation assumes the actual trusted-local catalog's
≤128-ASCII artifact ID. Public custom resolvers do not universally enforce that
bound. This read profile does not impose that spelling on producers: it admits
their **actual full** reference counts/lengths/union or returns a labelled resource
refusal, including valid larger projections. Likewise clean U assumes current
mandatory representations; the later required older closed-ACL representation
may add a ref/preimage. That later authentication contract must derive/protect its
actual closure and review resource compatibility before execution; this storage
gate is not profile-complete authentication. Preserve aggregate+retirement and
retirement-only migration obligations and the older-QC authentication limitation.

## Single public seam

Names below are required contract names, not yet implemented exports. Add these types and
the required method coherently to the existing contract/exports and all owners,
including ephemeral storage. No optional method, decorator, second factory/cache,
schema, new durable incarnation or alternate canonical decoder.

```ts
// One frozen exported resource profile; exact literal values are the table above.
type AheBoundedReadLimits = Readonly<{
  maxObjectGenerations: 7; maxHeadBytes: 3326; maxGenerationBytes: 7307;
  maxClosureReferences: 7; maxBlobBytes: 65536; maxUnionBytes: 262144;
}>;

acquireBoundedActiveRead(input: Readonly<{
  objectId: StorageObjectId;
  ancestorCount: 0 | 2;
  limits: AheBoundedReadLimits;
}>): Promise<StoreResult<AheBoundedReadAcquisition>>;

type AheBoundedReadAcquisition =
  | Readonly<{ kind: "empty"; head: NoHead }>
  | Readonly<{ kind: "present"; reader: AheBoundedActiveRead }>;

interface AheBoundedActiveRead {
  readonly head: PresentHead;
  readonly generations: readonly GenerationRecord[]; // active, parent, older
  readonly blobs: readonly Readonly<{ ref: GenerationRef; bytes: Uint8Array }>[];
  checkCurrent(): Promise<StoreResult<Readonly<{ kind: "current" }>>>;
  release(): Promise<void>;
}
```

Validate/detach closed input and exact approved limit values synchronously before
the first await; larger caller limits are `INVALID_ARGUMENT`, not permission to
expand the profile. Existing result vocabulary stays intact; extend its rejection
union with `READ_BUDGET_EXCEEDED`, `READ_STALE_HEAD`, `READ_RELEASED`. Ordinary
methods do not begin returning these new read-local reasons. Freeze structural
arrays/records, detach bytes and keep private captured identity independent of
returned mutations; do not promise typed-array deep freezing.

## Atomic native algorithm and refusal law

1. In one readonly native transaction, read/validate the exact head under H. Obtain
   at most G+1 object-scoped generation **keys**, not whole values. Before SQLite
   projects any physical `generation_id` to JS, require native TEXT type and exactly
   64 **bytes**, e.g. `typeof(generation_id)='text'` and
   `length(CAST(generation_id AS BLOB))=64`, with a guarded projection/failure marker.
   SQLite Unicode character length alone is insufficient. The census must include
   malformed rows as bounded failure markers, never filter them out. Apply the
   shared fixed-64 lowercase-hex and exact object-scope binding law to every exposed
   key, including the overflow sentinel. Malformed physical keys keep the shared
   corruption law; a numerically overflowing census of valid keys returns
   `READ_BUDGET_EXCEEDED` before generation values. IDB's unavoidable native key
   clone is qualified below; validate compound-key shape, spelling and exact scope
   immediately before avoidable copies or value requests. Its bounded census must
   cover the **complete exact-object physical key prefix**, including malformed
   component types/extra shape, not only canonical-looking keys. Do not reuse the
   existing `[objectId]..[objectId,[]]` upper bound as that completeness proof:
   a nonempty array second component can sort above `[]` and be omitted
   in the [existing adapter](../../../packages/storage-browser/src/internal/idb-adapter.ts). A bounded key-cursor/prefix-stop strategy or suitable
   existing exact-object index may implement this later; no schema redesign or
   alteration of existing helpers/global recovery kernels is authorized here.
   No uncapped COUNT, global scan, all-page accumulation or `recoverActiveGeneration`/certificate call.
2. Bound R before avoidable metadata copying, then decode using shared closed-v1
   laws under depth4/items127 (head depth2/items33); apply F before closure copies/
   digest sorts. Decoder resource exhaustion is `READ_BUDGET_EXCEEDED`, not an
   automatic NON_CANONICAL_RECORD/poison latch; distinguish it from malformed
   canonical bytes inside the admitted envelope. Examine
   every admitted key exactly once (exact selected reads may replace its census
   read). Select head and follow only two exact base references when requested;
   retain only selected records while serially validating the other rows. Count
   Adopted rows: exactly one must bind a present head; no-head is `empty` only with
   zero Adopted rows. Empty may still have valid unadopted debt; it is not a room
   identity or genesis-authentication certificate.
3. Require distinct same-object selected IDs, active Adopted, parents Superseded,
   exact closure digests and each younger head/base revision increment. A missing
   parent uses `GENERATION_NOT_FOUND`; inconsistent state/base/head uses existing
   `ILLEGAL_TRANSITION`/`BASE_HEAD_MISMATCH`/`HEAD_CONFLICT` as appropriate; malformed
   persisted encoding/key binding keeps the shared corruption law. Do not walk
   oldest L's base or demand its erased prefix. Do not infer epochs or L/Q phases
   from native generation IDs; that belongs to later node authentication.
4. Admit each selected declared length≤B and checked distinct sum≤U **before** any
   selected blob value request; repeated digests require identical lengths. Check
   the exact selected generation's promotion for every ref (≤3F lookups), never
   another generation's substitute. Fetch each distinct selected blob once (≤3F),
   check actual B before avoidable copying/hash, then exact length and blob digest.
   Missing/unpromoted/corrupt bytes retain existing selected/adopted integrity
   failures. No partial success. Extra global promotion integrity is not certified
   by bounded exact promotion lookups, and no mutation certificate is installed.

Resource limits precede work they avoid; a later detected corruption does not
retroactively excuse unbounded reads. `READ_BUDGET_EXCEEDED` alone never poisons,
clears or creates mutation recovery certificates, writes, repairs or releases debt.
Genuine admitted corruption retains the existing shared poison law. Native failure,
unsupported schema, owner closed/poisoned, and malformed public input retain their
existing distinctions. Shared validators/closure laws need a coherent bounded
entry path, not a forked classifier or default-limit decode before the new gates.
Limit exhaustion needs unambiguous provenance in that shared path: no fuzzy error-
message matching or remapping all canonical errors to budget refusal. If the existing
canonical owner needs a minimal limit-error provenance extension, include/review it
in this same seam, preserving ordinary decoder defaults and rejection behavior.

SQLite uses a plain read transaction, indexed LIMIT G+1/exact keys and same-snapshot
`length(record)`/`length(bytes)` gates before projecting BLOB values; no intentional
writer reservation/DML/DDL. Its generation-key native type/byte gate applies
whenever a physical key is projected, not only to generation-record BLOBs. Return
only bounded markers/scalars for an invalid physical key, not its unchecked TEXT
or BLOB; native evaluation/index work is not claimed allocation-free. IDB uses one
`readonly` transaction and bounded key requests, serial exact gets, never whole-value `getAll`. Respect native transaction
lifetime/outcomes. Factory setup/schema admission is outside operation-level readonly.
Existing whole-row IDB values are unavoidably structured-cloned before JS length
inspection; hostile oversized persisted rows/keys are **not** finitely native-clone
bounded by this schema. Reject immediately before avoidable copy/decode/hash/next
requests. Storage-engine traversal/scheduling is not constant wall-clock work.

Output≤U is not an exact transient heap cap: count serial metadata decode/reencode,
selected metadata, key/ref sets, native buffers and real detached output/verifier
copies separately. No G-full-closure cache; no snapshot payload copy in AHE. Later
snapshot verification/output has its own owner and unchanged working-set budgets.

## Handle freshness and lifecycle

Capture privately the complete head tuple (object/generation/revision/closure) and
actual owner lifecycle. `checkCurrent()` reads only bounded H in a fresh readonly
transaction; changed/disappeared head returns `READ_STALE_HEAD`, malformed head
keeps shared failure law. It cannot promise freshness after that transaction or
detect same-tuple whole-database rollback; no durable AHE incarnation exists here.
The node consumer later rechecks its independently trusted room floor as well.

Release marks the handle closed immediately, is idempotent and drains its admitted
checks. New/not-started checks refuse `READ_RELEASED`; already executing checks may
finish. At queued execution, owner closed/poisoned checks precede reader-release
checks; malformed captured public input refuses before scheduling native work.
Owner close prevents new/not-started **new read-seam** jobs with STORE_CLOSED;
executing work may drain. Preserve old cold/pending/mutation scheduler semantics.
No native transaction, retention pin or writer/recovery authority survives between
calls. Release never closes the owner or changes rows. A terminal native outcome
is not retroactively rewritten by a later release/close.

## Separate allocation and mandatory later gates

After xhigh contract acceptance, separate high RED freezes actual SQLite fresh-
process and IDB fresh-realm Chromium/Firefox/WebKit cases under unchanged budgets;
distinct high GREEN changes only this existing storage contract/shared bounded
validation path, indispensable shared canonical limit-error provenance, and owner
implementations. Native mode/logical census, G+1-before-
values, exact three-record ancestry, all-ref byte/promotion integrity, boundary
refusal/nonpoisoning, no certificates, detached mutation, stale head and release/
close scheduling need causal assertions. Add actual native physical-key controls:
SQLite oversized TEXT, 64-character multibyte TEXT with more than 64 bytes, wrong-
type BLOB keys, and 64-byte bad spelling; IDB malformed compound-key type/shape,
spelling and scope, specifically a nonempty array second component outside the
old `[]` upper bound. Prove complete-prefix inclusion/classification rather than
a canonical-subset census. Each malformed-key case must reach shared corruption refusal
before generation values/avoidable copies, with SQLite traces proving unchecked
physical key bytes never reached JS. A valid G+1 census separately proves non-
poisoning numeric overflow refusal before values; invalid sentinel keys are not
silently dropped or reclassified as favorable overflow. Keep budgets unchanged.
Missing API is wiring RED, not proof of masked behavior. Source-derived 0/1/2/3 rows and real reclaimed normalized oldest L
need native evidence; do not substitute synthetic counts or rerun unchanged matrices
for bookkeeping. Independent xhigh GREEN review/root disposition precedes landing.

Then separately authenticate full current-floor-rooted closed-cut data using the
accepted snapshot reader: n=0 returns zero cuts; n=1 one; n≥2 both distinct exact
cuts, never Q/L double counting. Resolve every required profile's closed-ACL custody
and older-QC authority limits. Next prove **genuine room rollback, authenticated
checkpoint promotion and registry-role reconciliation**, without regressing host,
signing, issuance or retirement floors. Observation alone cannot close usable rollback.
Recipient retention, protected dependencies, crash-safe retirement and producer/
maintenance admission follow in their required order. All profiles, thousands of
epochs, MMORPG/grid, Discord/archive and terminal FPS/chess golden paths remain
mandatory; the read resource policy cannot waive them.

No hard authority gap requires earlier producer changes for this native data-read
contract. If policy instead demands unconditional success for every currently valid
generic object, finite small caps cannot satisfy that requirement: explicitly choose
the larger representation/admission prerequisite before making that stronger claim.
This contract chooses bounded refusal, not that stronger promise.
