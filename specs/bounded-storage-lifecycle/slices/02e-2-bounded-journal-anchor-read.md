# 2e-2 — Bounded exact journal-anchor observation

Status: independently reviewed source contract accepted, 2026-10-03, under the
[root disposition](../../../.logs/bounded-storage-lifecycle/rollback-journal-anchor-contract-review-01/root-disposition.md).
Separate RED readiness, distinct GREEN and independent product review/root
acceptance remain required. The [live handoff](../README.md#next-agent-prompt)
owns execution status. This is safe byte access, not historical availability,
authenticated closed ACL, protected custody or usable rollback.

## Outcome and one owner

Read an exact already-installed anchor preimage through the existing neutral
`DurableLiveJournalStore` and its Node/Browser native factories. No install,
repair, replay, parameter/signature/entry scan, alternate owner, cache, schema,
pin or lease. A physical old row is not a protected migration guarantee.
The [closed-cut architecture](../../../.logs/bounded-storage-lifecycle/rollback-data-contract-review-01/root-disposition.md)
still requires separate historical protection and migration provenance.

## Required public seam

The following are required contract names, not yet implemented exports:

```ts
export const LIVE_JOURNAL_ANCHOR_READ_MAX_BYTES = 8192 as const;

export interface LiveJournalAnchorReadInput {
  readonly scope: LiveJournalScope;
  readonly maxBytes: number; // captured safe integer 0..8192
}

export type LiveJournalAnchorReadFailureKind =
  | LiveJournalFailureKind
  | "read-budget-exceeded";

export type LiveJournalAnchorReadResult =
  | Readonly<{ ok: true; kind: "missing" }>
  | Readonly<{
      ok: true;
      kind: "present";
      scope: LiveJournalScope;
      exactCanonicalAnchorPreimageBytes: Uint8Array;
    }>
  | Readonly<{ ok: false; kind: LiveJournalAnchorReadFailureKind }>;

// Required on DurableLiveJournalStore; no optional fallback.
readAnchorPreimage(input: LiveJournalAnchorReadInput):
  Promise<LiveJournalAnchorReadResult>;
```

Resource refusal stays read-local: do not widen `LiveJournalFailureKind`,
`LIVE_JOURNAL_FAILURE_KINDS` or ordinary result vocabularies. The new read does
not begin returning write-ambiguity, duplicate/install or replay-token outcomes.
Factory schema/durability admission remains outside operation-level readonly.
Keep exports at the existing journal package root and native `./live-journal`
subpaths; no storage-root journal exports or dependency/version changes.

## Closed capture and exact absence

Extend existing `captureLiveJournalInput` with `"anchorRead"`, reusing its
descriptor-snapshot and scope laws. Capture closed enumerable own data fields
`{scope,maxBytes}` and `{objectId,epoch,anchorDigest}` synchronously before the
first await. Preserve ordinary/null-prototype inputs, canonical storage object
IDs, nonnegative safe epochs and fixed-64 lowercase hex digests. Extras, symbols,
accessors, hostile capture, invalid numbers or allowance above8192 return
`malformed-input` before native work. There is no default or larger entitlement.
Mutation of holder/nested scope across awaits cannot redirect the read.

Lookup uses the complete exact primary key. Absence is `missing`, even if another
anchor at the same object/epoch exists. Neighbors are not fallback material;
preserve old readiness/page's different object+epoch occupancy law unchanged.
An exact present corrupt anchor is never favorable missing. Zero allowance is
valid: absence remains observable; otherwise byte-eligible nonempty content
exceeds it. Gate actual persisted bytes, not an invented declared-length column.

## Shared narrow integrity and copy boundary

One observation helper belongs beside existing shared journal capture/anchor
validation. Its required export name is
`captureLiveJournalAnchorReadObservation`:

```ts
captureLiveJournalAnchorReadObservation(
  expected: LiveJournalAnchorReadInput,
  observation: unknown // closed {scope,exactCanonicalAnchorPreimageBytes}
): LiveJournalAnchorReadResult;
```

Recapture expected through the closed input law, including allowance, rather
than trusting TypeScript. Accept only the closed native projection, not a whole
scope row. Inspect actual intrinsic Uint8Array type, byte length and backing
before avoidable copying, then reuse the existing canonical anchor-field,
object/epoch and domain-hash laws. Ordinary shadowable `byteLength`/`buffer`
properties are not that intrinsic proof, including direct exported-helper calls.
Existing `copyBytes` alone is not a pre-budget guard. This does not authorize a
broad carrier rewrite of ordinary APIs.

Do not invoke `captureInstall`, `captureStoredScope`,
`deriveLiveJournalSnapshot`, Browser `fromRawScope`, or copy unrelated carriers.
Native projection adaptation and shared integrity are not a second classifier.
For admitted observations:

- Malformed physical key/type, non-byte or empty anchor is `store-poisoned`.
- Otherwise byte-eligible actual length over the allowance is
  `read-budget-exceeded`, before avoidable copy/decode/hash. This does not certify
  unexamined bytes as valid or corrupt.
- Within the envelope, noncanonical anchor, malformed fields, scope/epoch/hash
  mismatch is `store-poisoned` under the existing process-local poison latch.
- Native transaction/request failure is `substrate-failure`; unexpected internal
  invariant failure is not missing.

Budget refusal never poisons, repairs, creates content or installs a verified
watermark/certificate. Anchor observation does not certify parameter carriers,
signatures, accepted-entry sequence, replay health, retention or external freshness.
Freeze records/scope and detach actual bytes; no typed-array deep-freezing claim.
Returned mutation cannot affect storage or a later call. No incarnation or handle
survives: the next exact call observes replacement/deletion anew.

Later Node must open the registered canonical anchor and bind actual domain-hashed
bytes, object and epoch to both independently authenticated
`successor.previousAnchor` and signed `retirement.closedAnchorDigest` before using
`aclDigest`. Neither local hash integrity nor raw row/success/old signature supplies
that external authority. Prior signed QC-byte commitment does not recreate
erased-epoch seal replay trust; verified pinned genesis is the precise k=0 exception.

## Native transaction and lifecycle

SQLite reuses the admitted owner in a plain `BEGIN` read transaction, never an
intentional writer reservation. Use the indexed exact scope PK. Guard physical
key types, safe epoch and bounded canonical spelling before projecting unchecked
strings/BLOBs; digest length is64 bytes, not Unicode characters. In the same read
snapshot, guard native BLOB type and positive actual length against maxBytes
before BLOB projection. Failed gates expose bounded markers/scalars and null
BLOB only. A later JS check after whole-BLOB SELECT is insufficient. Read no
signature/parameter columns or entry tables. Respect actual commit/rollback;
no DML/DDL, repair or second database. Engine/page work is not allocation-free.

IndexedDB uses one `readonly` transaction on existing `scopes` and one exact get
with the private three-component key. No cursor/range occupancy/getAll,
acceptedEntries transaction or readiness fallback. Its whole row, including
parameter/signature fields and hostile content, is unavoidably cloned before JS;
this schema does not supply a finite native-clone heap bound. Inspect only required
own scope/anchor fields, immediately reject invalid shape/length, and detach only
the admitted anchor. Do not enumerate/copy/decode unrelated values or call
`fromRawScope`/`exclusiveBytes` on them. Respect native terminal/error outcomes.

Preserve actual poison-before-closed availability precedence. An unavailable
owner invocation keeps its existing failure before input capture. Once captured,
check availability again at native-work start if deferral or capture side effects
occur: no new/not-started accessor work begins after close. Neither owner has a
queue; do not invent one or pause synchronous SQLite. Browser can capture/open
its transaction before first await. Already executing reads may finish under
native close semantics; later close does not rewrite terminal results.

Keep existing idempotent close timing/database handling and old install/append/
readiness/page behavior. Do not delay physical close for a new drain queue or
claim close fulfillment waits for all Browser transactions. No new AbortSignal,
session, release or semantic cancellation API; native abort/error retains
`substrate-failure`. Callers join read promises as well as close for cleanup.
Independent owner sessions remain independent; no transaction survives a call.

## One proof allowance, not an availability promise

The cap is local observer entitlement consistent with current <=8192 trust
embedding, not wire validity or a new heap budget. A valid anchor above a smaller
allowance whole-refuses; callers cannot raise the maximum. Later Node passes
`min(8192,remainingWholeProofU)` and charges actual distinct bytes to the same
U262144 as selected AHE proof. Deduplication requires actual authenticated byte
equality, not labels; there is no independent journal U or payload allowance.
Clean retirement-only union221184 plus one anchor<=8192 is<=229376. All generic
selected refs remain charged; excess refuses the whole later proof. F7/G7 stay
unchanged, and genuine nonsettlement G8 is safe refusal, not usable availability.

## Required historical protection and migration remain separate

Before full-data acceptance, the private Node data owner derives exact closed-cut,
anchor-scope/domain-digest and captured AHE-head/host-floor provenance for every
required non-genesis retirement-only oldest closed ACL target. A future private
`ClosedAclAnchorRequirement` is not a public done/adopted flag. Only actual bounded
read plus both independent digest bindings may mint a fieldless private
`VerifiedClosedAnchorDependency` recording source, scope, digest, actual length
and all dependent targets. Structural rows do not mint it; missing/budget/corruption
is whole-target unavailable, not migrated-room success or deletion permission.

The future unified protected-dependency planner alone consumes genuine current/
pending/rollback provenance and protects the exact journal row/anchor while any
target needs it, even if entry history is obsolete. Shared dependence survives
another role retiring; no age/TTL/generation-ID/count proxy or per-call durable pin.
Fencing, cross-store application and migration clearing need separate contracts.
Current activation's exact anchor install does not prove older custody after
current-only recovery, nor does today's absence of delete APIs prove future survival.

Migration must distinguish actual sources:

- Existing exact older bytes can supply the old ACL expectation after bounded
  read and both authenticated bindings; genuine protected custody is still needed.
- A separately reviewed bounded durable source may hold the preimage even if the
  journal row is absent. Installing via current `installEpochAnchor` additionally
  needs genuine old detached signature and matching parameter carrier; a hash
  cannot synthesize them or authorize partial install/schema changes.
- If guaranteed remaining data lacks the preimage, its authenticated digest and
  current snapshot/ACL do not reconstruct old anchor or authenticate ACL(k).
  Retirement does not sign old ACL digest; old cut/history fields and raw ACL are
  not substitutes. Opportunistic unprotected bytes are not the required migration
  guarantee. Refuse and hold debt. Guaranteed lost-input success needs explicit
  product direction for a recovery-source guarantee or new migration/wire authority;
  do not fabricate history or silently drop the profile.
- k=0 uses exact verified pinned genesis, never as fallback for k>0.

These obligations do not block the independently useful safe accessor or permit
larger budgets/earlier producer redesign.

## Separate RED/GREEN and acceptance

Separate HIGH tests-only RED freezes native preconditions and causal failures
before distinct HIGH GREEN; missing method/export is wiring RED, not deeper proof.
Use dedicated fixture/strict/Node/all-three-engine browser surfaces. Build owned
dependencies before tests. At unchanged budgets prove fresh SQLite processes and
fresh IDB recovery realms after setup closes: genuine genesis/non-genesis installed
bytes, exact-neighbor missing, repeat/detached mutation, scope/hash/canonical/type
corruption, actual oversized8193-byte native gate, valid content above smaller
allowance, zero and invalid larger public allowance. Wrong-key controls must
genuinely address mismatching key/preimage, not an unreachable malformed neighbor.
Add one tiny direct-helper hostile intrinsic-carrier control.

Observe no create/repair/entry scan or unrelated avoidable carrier copy, unchanged
census/neighbors, readonly mode and SQLite scalar/null-before-BLOB gates. IDB clone
is qualified, not a clone mock; source review proves immediate rejection before
avoidable copy/decode/hash. Real close-before-start/executing-close/native-failure,
repeat-close and independent-session controls must not pause synchronous SQLite.

GREEN scope is existing shared journal types/contract/exports and both native
journal owner files only. Necessary exact governance/method rosters and strict
delegate/mock evolution require actual conflicts and preserve old assertions;
forward genuine delegates, never fabricate native bytes. Refresh the existing
emitted shared declaration SHA pin only from actual independently reviewed emit,
retaining the assertion. Preserve pre-existing missing-method/type/coverage failures
with attribution; no generic rewrite, lint/config/budget waiver or wrapper.

Preserve old install/append/readiness/page/close, schema/catalog, ambiguity,
duplicate, replay and no-write failure controls. Run affected preservation after
product changes, not unchanged recovery/reader matrices for bookkeeping. Separate
xhigh readiness/product review and root dispositions precede landing. Genuine
room rollback/promotion/rebind, continued issuance/replay, registry roles, recipient
custody, protected retirement, endurance and every golden path remain mandatory.

## Empirical checkpoint

The source contract above preserves its original framing. Separate RED readiness,
distinct GREEN, focused one-pass summary correction, independent XHIGH product
review and concrete unsafe-cleanup correction are now root-accepted. The
[MAIN landing disposition](../../../.logs/bounded-storage-lifecycle/journal-anchor-green-integration-01/root-disposition.md)
owns actual fresh native/shared28 and selected three-engine browser21 success,
affected static gates and exact source/emitted bindings. Previously masked
assertions execute against changed product. Prospective lifetime verification
uses the exact accepted ignored owner; frozen behavioral driver bytes are retained.

The original combined browser run remains failed, although full-run plus unchanged
focused repeat proves every original semantic title. Historical cause/deletion,
ordinary native/compiler/coverage failures and broader release gates stay qualified.
Safe access is implemented; full-profile source/custody, all-target authentication
and genuine usable room rollback remain separate required work.
