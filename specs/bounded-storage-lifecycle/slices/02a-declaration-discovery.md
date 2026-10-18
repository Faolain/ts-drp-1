# 2a — Exact declaration discovery at the snapshot owner

Status: approved contract. The [live handoff](../README.md#next-agent-prompt) and
[review ledger](../review.md#2a-declaration-discovery-contract-review) own execution
status; the [contract archive](../../../.logs/bounded-storage-lifecycle/declaration-discovery-contract-freeze-01/manifest.json)
preserves the historical reviewed bytes. This is the first seam of
[slice 2](../README.md#slice-graph), not acceptance of declaration-free product
recovery or bounded historical recovery work.

## Contract and ownership

A fresh caller with an exact snapshot scope key can recover the durable canonical
declaration without supplying that declaration, reading chunks, or changing
snapshot lifetime. The existing snapshot owner remains the only metadata/payload
owner. AHE supplies authenticated references; it does not gain a declaration cache.

The next consumer slice authenticates the recovery chain before selecting the
key. This storage seam validates identity and durable representation, not authority
to activate a generation. Its result is an observation, never a verification
receipt, availability proof, pin, lease, or incarnation-bound acquisition.

The [shared contract](../../../packages/storage/src/snapshot-transfer.ts) owns the
types. Both existing backend factories return the richer capability on the same
object, database, queue and close lifecycle:

```ts
interface SnapshotRecoveryDeclarationReader {
	lookupRecoveryDeclaration(
		scope: SnapshotQuarantineScopeKey,
		options?: Readonly<{ readonly signal?: AbortSignal }>
	): Promise<SnapshotRecoveryDeclarationLookup>;
}

interface SnapshotRecoveryStore<Receipt extends object>
	extends SnapshotQuarantineStore<Receipt>,
		SnapshotRecoveryDeclarationReader {}

type SnapshotRecoveryDeclarationLookup =
	| Readonly<{ kind: "missing" }>
	| Readonly<{
			kind: "present";
			declaration: SnapshotQuarantineDeclaration;
			state: "open" | "poisoned" | "verified";
			retention: SnapshotRetention;
			expiresAt: number;
	  }>;
```

The narrow producer-facing store remains a genuine capability boundary, not a
second implementation. Recovery consumers must require discovery explicitly:
no optional method, runtime feature detection, caller-declaration fallback or
decorating owner. Existing `inspectRecovery` compares a supplied declaration and
reports chunk completeness; discovery reconstructs metadata without a payload
scan. These are distinct enduring operations. Shared validation should have one
owner, not copied parsers in each operation.

The rejected alternatives are a required new member on the base interface and an
overloaded `inspectRecovery`. Both break structural forwarding in the immutable
[producer fixture](../../../tests/fixtures/producer-presign-retention/fixture.ts).
The [type-only probe](../../../.logs/bounded-storage-lifecycle/declaration-discovery-plan-01/type-probe.mjs)
checks those failures and the proposed capability assignment using declarations
extracted from the current contract. It does not prove factory implementation,
consumer migration, lint, package typecheck or runtime behavior. Preserving the
fixture alone would not justify another owner; the capability split must also
remain appropriate after consumers migrate.

## Identity, validity and failures

Capture and validate all four scope fields and capture the signal before queued work.
Honor abort under existing lifecycle semantics; do not add signal-type validation
or a new malformed-input predicate for options in this seam.
Follow the existing promise-returning failure and close/abort lifecycle contracts;
no synchronous malformed-input throw, caller mutation after entry, or work on a
closed owner. Reuse the existing shared `captureScope` validator by exposing it
through the existing contract owner, not duplicating it in adapters.
All failure codes below are rejected promises carrying the existing
`SnapshotQuarantineFailureCode`, never additional result kinds. Only `missing`
and `present` resolve. Storage/transaction errors retain existing mapping;
malformed caller identity rejects `malformed-input`, lifecycle cancellation
rejects `aborted`/`closed`, and storage/allocation failure rejects `storage-failed`.

The normative identity decision uses one transaction. "Read" constrains its
operations and durable non-mutation, not a new SQLite lock mode: reuse the
existing SQLite `BEGIN IMMEDIATE` scheduling and error behavior. IndexedDB must
use `readonly`. A transient database transaction lock is not a snapshot pin,
retention lease or incarnation-bound acquisition. Do not add a separate
non-write-locking transaction redesign in this slice.

The ordered decision is:

1. Capture/validate caller key and capture the signal before queue entry, then apply the
   existing queued lifecycle checks.
2. Read the exact four-field primary key. If it exists, validate that exact row
   as specified below. Invalid exact metadata rejects `poisoned`; a valid row
   resolves `present`. Never consult a competing digest to override this result.
3. Only if the exact row is absent, make a bounded existence-only probe at the
   same object/epoch/anchor. Any occupied key rejects `conflict`; no occupied key
   resolves `missing`. The probe returns no competing declaration or payload.

Thus an exact row takes priority over other digests even if those competing rows
are corrupt. With no exact row, occupancy is `conflict` regardless of the other
row's body validity: this is an identity collision, not validation of that body.
Do not decode a conflicting manifest against the caller digest. This intentionally
replaces the draft's ambiguous "structurally valid other row" predicate and the
old comparison helper's arbitrary three-field row selection. Do not search
neighboring anchors, epochs or historical generations, even on corruption.

For the exact row, first validate durable shape: exact key/header correspondence,
nonempty incarnation, valid state/retention enums, descriptor storage type and
legacy/nullness agreement. Then validate bounded field types/lengths and decode
and bind the canonical manifest. Any failure in either stage rejects `poisoned`,
never `conflict` or `missing`. SQLite's pre-copy checks below precede materializing
variable-length fields; they are part of shape validation.
The native primary key already binds its key columns to the lookup arguments;
do not invent a negative that desynchronizes an IndexedDB inline keyPath from
its own record fields. The meaningful identity negative is a decoded manifest
that disagrees with that exact selected key.

Decode the exact canonical manifest using the existing protocol decoder and
limits. Bind its identity, digest, descriptors, chunk count and total to every
corresponding persisted header/descriptor. Reject inconsistent metadata, invalid
state/retention combinations, unsafe numeric fields and noncanonical bytes.
Unsafe persisted totals, counts and expiry values reject `poisoned`; do not reuse
an arithmetic helper that remaps those corruption failures to `storage-failed`.
A well-formed temporary or legacy row marked poisoned must resolve `present`
with `state: "poisoned"`. A recovery-retained row in any non-verified state,
including an explicit poisoned mark, must reject `poisoned`. This rejected
failure is distinct from the observable state. Discovery cannot turn recorded verification
into a claim that chunk bytes still exist or are authentic.

Legacy rows without persisted descriptors must resolve `present` with a declaration
reconstructed from their canonical manifest when the scope-row fields agree. They stay
`legacy-unclassified`; do not write derived descriptors, clear debt, change owner
counters or install recovery ownership. Invalid legacy data fails unchanged.
Lookup must not reject `migration-required` merely because classification is
required. Persisted chunk rows are outside this metadata bind set: missing or
inconsistent chunks do not change discovery's result and must not be read here.
Later acquisition/verification remains responsible for detecting those failures.
Authentication and complete protected-set classification remain later work.
In particular, the existing undecodable legacy-manifest control retains its old
declaration-supplied `inspectRecovery` result, while discovery must reject that
same row as `poisoned`. Assert both results without changing the historical oracle.

Return detached, frozen records, scope and descriptor vector, with fresh owned
manifest bytes. Typed-array contents need not be frozen: mutating them must not
affect durable state, another result, or later verification.

## Bounded observation, not acquisition

Materialize at most one exact scope body and zero chunk records. The only
additional scope operation is the existence-only, same-triple probe after an
exact miss. SQLite may use bounded scalar preflight reads of that exact key
before copying its body, all within the same transaction. IndexedDB uses one
exact `get`, then at most one key-only request after a miss. SQLite uses indexed
exact-key reads and a `LIMIT 1`/existence query, not a count or scan. This bound
concerns addressed candidates and bytes, not an identical SQL/IDB request count.
The key-only probe must stop after one key; `getAllKeys` without a one-key bound
does not qualify. The prefix must include every valid IndexedDB fourth-key type,
including raw-injected non-string competitors, while excluding other triples.
A string-only digest range does not implement "any occupied key".
An implementable native range is
`IDBKeyRange.bound([objectId, epoch, anchor], [objectId, epoch, anchor + "\u0000"], false, true)`:
the exclusive upper bound advances the third component, so the fourth component
needs no maximum. Use a single `getKey`, key cursor stopped immediately, or
`getAllKeys(range, 1)`. The
[native prefix feasibility probe](../../../.logs/bounded-storage-lifecycle/declaration-discovery-plan-01/idb-prefix-probe.mjs)
checks this range with every key class and neighboring triples; it is evidence
for the algorithm, not the separate RED oracle. No schema/index change or
neighboring-triple lookahead is needed.
Do not use status helpers that enumerate chunk presence, enumerate neighboring scopes, materialize history, or
refresh expiry. No sweep, create, promote, cancel, repair, migration or counter
mutation is permitted. An expired temporary row is discoverable if still present.

These read and mutation bounds apply per lookup invocation, not across setup or
subsequent `inspectRecovery`/`openScope` round-trip calls. Those existing methods
retain their own scans, sweep and acquisition behavior.

For valid protocol-admitted data, persisted metadata copied into JavaScript and
returned declarations are bounded by existing manifest and descriptor limits.
The native IndexedDB pre-clone exception below remains explicit for hostile or
malformed durable rows/keys. This does not claim a
constant bound for receiving/binding an arbitrarily large caller-supplied key:
the existing `captureScope` accepts a nonempty objectId without a length cap, and
must remain unchanged. Exact key columns are determined by that captured key;
SQLite must reuse those values or return bounded equality predicates, not fetch
another unbounded copy of the stored object identity. Anchor/digest caller fields
retain their existing fixed shape. Do not add a new caller-key length rejection.

For non-key metadata, SQLite must reject invalid storage types or oversized
values before copying them into JavaScript, using SQL type/length checks or
bounded projections. This includes manifest bytes, serialized descriptors,
state, retention and incarnation. Derive token bounds from valid protocol and
current/migration writer representations. `openScope` admission alone does not
make a declaration valid for discovery: for example, an admitted temporary row
whose 5000-character key objectId disagrees with its bounded canonical manifest
must reject lookup as `poisoned`, while old declaration-supplied inspection stays
unchanged. Apply the same manifest/key mismatch refusal at ordinary key lengths.
Do not promise discovery of every row accepted by the old permissive writer.

Derive the descriptor bound
from the existing protocol cardinality, index, length and digest bounds; do not
admit larger declarations. Native instrumentation must prove that oversized or
wrong-typed injected metadata is rejected without returning its body to JS.
IndexedDB structured-clones the addressed exact row, or the one occupancy key,
before application validation: this seam cannot claim a pre-clone allocation bound
against an oversized durable record/key, including an invalid declaration admitted
by a permissive old writer or a raw-injected fourth-key component. It must still
avoid reading/cloning any competing row value. A pre-clone allocation claim would require
a separately reviewed storage-layout seam. Do not increase existing limits.

Deletion or replacement after lookup remains possible. Later payload acquisition
must validate the exact declaration and verify actual bytes. In particular,
`openScope` can create an empty temporary scope after deletion; that must never
become successful recovery. A non-creating acquisition capability, if needed,
requires its own reviewed contract rather than silently changing `openScope` here.

## Decisive RED and GREEN evidence

Use a separate RED author after contract acceptance; freeze test/source custody
before the separate GREEN author changes product code. An absent discovery API is
an explicit contract RED, not a claim of a native product failure. The following
consumer slices need their own causal failures at declaration-required guards.
Use a distinct `MASKED_BY_ABSENT_DECLARATION_DISCOVERY_API` marker for the missing
capability and report dormant downstream checks as pending/not executed, never
as passing native runtime behavior. Genuine assertion failures after the API
exists must remain distinguishable from this readiness failure.

Both SQLite and native IndexedDB must prove:

- Exact hit/miss/conflict selection with neighboring object, epoch and anchor
  controls; dual occupancy with valid and corrupt competing rows must preserve
  exact-key priority. With no exact row, any same-triple occupancy rejects
  `conflict` without inspecting its body; no fallback to that declaration.
- Valid temporary, verified recovery and legacy observations, including expired
  temporary metadata; exact metadata and owner census unchanged after lookup.
- Corrupt manifest/header/descriptor/state negatives and protocol-boundary
  rejection, without poisoning or repairing unrelated durable rows.
- Result/input alias isolation and deterministic entry, queue, abort and close
  controls under the existing lifecycle semantics.
- The bounded exact-body/occupancy-probe behavior above and no chunk/history
  enumeration, including when payload is incomplete or absent. Metadata success
  must not imply byte success. SQLite must additionally prove its pre-copy bound.
- Round-trip a discovered non-legacy declaration through shared capture and the
  existing `inspectRecovery`/`openScope` binding to the same row under normal
  ready-owner, unexpired, unchanged-row conditions with no competing row at the
  same object/epoch/anchor. Keep dual-occupancy assertions on discovery itself;
  the old comparison operations are not required to gain exact-key priority.
  This checks interoperability,
  not byte availability. A coherent legacy declaration must pass shared capture;
  legacy chunk disagreement must still allow metadata discovery but fail existing
  `inspectRecovery` with `conflict`. Existing mutable-acquisition migration gates
  remain unchanged. Explicitly assert no migration-barrier rejection by lookup.
- Fresh-process SQLite and fresh-page/context native IndexedDB reopen using only
  database identity plus scope key. Setup may retain expected metadata for
  assertions, but cannot pass declaration, chunks or an in-memory owner to reopen.
  Add a dedicated native discovery page/worker entry and test harness; leave the
  existing dirty retention/product experiments untouched. Share fixture utilities
  where appropriate without passing setup's declaration into the reopen caller.
- Deletion/replacement after lookup cannot make an existing verification path
  accept missing or mismatched bytes. This is a race control, not permission to
  redesign acquisition in this slice.

Keep accepted retention and producer frozen suites unchanged. Log focused strict
typecheck, lint/format, tests, source hashes and terminal status; attribute known
broader compiler failures separately. Obtain Grok, Kimi with the requested
100-step cap, and Opus xhigh contract/RED/GREEN reviews with explicit dispositions.
No visual artifact or endurance run is required for this metadata seam.

## Explicit runtime and factory-type oracle evolution

The accepted [owner test](../../../packages/storage-node/tests/snapshot-recovery-owner-red.test.ts)
asserts the exact enumerable members of `snapshotQuarantineContract`. Adding the
already-required shared `captureScope` therefore conflicts with the earlier
blanket instruction to keep every accepted test byte-identical. This is a public
helper-roster evolution, not a defect in the old behavioral oracle.

After this amended contract is accepted, authorize only the separate RED author
to add `captureScope` to that one expected inner helper roster. Keep every old
member and every other assertion intact; preserve the original file and its hash
with historical evidence. Freeze and independently review the new expectation
before GREEN. The expanded exact roster must fail on the unchanged producer
checkpoint; no test skip, conditional detection, non-enumerable hidden helper,
prototype workaround or broadened "contains" assertion is permitted.

There is a second exact oracle in the
[historical type fixture](../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-types.ts):
the generated `_Node` and `_Browser` assertions use `Equal` on the full factory
function types. The [actual-oracle feasibility probe](../../../.logs/bounded-storage-lifecycle/declaration-discovery-plan-01/exact-type-probe.mjs)
compiles the original generated oracle against all four real owner sources with
zero diagnostics; richer virtual factory return aliases yield exactly two
TS2344 failures. This is a real expected-type evolution, not solved by runtime
type erasure or the earlier assignability probe.

Authorize only the separate RED author to add independent expected discovery
reader/result/richer-store type definitions to that fixture and widen its two
expected factory return types to the richer store (directly for Node, inside
`Promise` for Browser). Keep the existing narrow base store, parameter envelopes,
receipt and retention types, `_Retention`/`_Verify`/`_Consume` assertions, and
the exact `Equal`/`Assert` machinery unchanged. Do not import production discovery
types to define the expected oracle. Preserve the original fixture and its hash;
the evolved two factory assertions must fail on unchanged product and be frozen
and independently reviewed with RED before GREEN. No other type expectation
change is authorized.

All package export maps, root runtime rosters, outer shared-module exports,
producer fixtures and behavioral retention/ownership oracles remain unchanged.
The only new runtime helper member is `captureScope`; discovery is a method on
the existing returned owner, and new named interfaces/types erase at runtime.
Keep the old `recorded()` comparison/occupancy behavior for existing methods;
sharing a validator does not authorize retargeting their row selection.

This narrowly supersedes "keep accepted retention suites unchanged" only for
the additive inner-roster assertion and the two expected factory return types
with their necessary independent expected type definitions. GREEN may not edit
either fixture or any RED oracle.
If any other exact-surface oracle conflicts, stop and separately establish its
required evolution rather than silently changing it during implementation.

## Remaining slice-2 graph and scope firewall

The synthesis separates the following obligations; only 2a has a draft executable
contract. Reslice each later seam before authoring it:

| Seam | Question                                                                         | Decisive evidence                                                                                                         |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 2a   | Can the owner discover exact metadata without mutation?                          | Native fresh-caller lookup and bounded-read controls above                                                                |
| 2b   | Can cold recovery select and verify without a supplied declaration?              | Authenticate first; derive predecessor snapshot key from the authenticated cut; wrong-successor and missing-byte refusals |
| 2c   | Can pending recovery do the same without changing adoption authority?            | Exact pending candidate, ambiguity/refusal and interruption controls; no verifier pin                                     |
| 2d   | Can shipped startup select genesis/current/pending mode from trusted head state? | Real room reopen with no declaration-shaped mode flag or test-held payload                                                |
| 2e   | Are both protected rollback generations genuinely usable?                        | Distinct valid rollback recoveries without lowering floors or inventing arbitrary activation authority                    |

The existing recovery owner is
[creator adoption](../../../packages/node/src/creator-adoption.ts); public capture
and [room startup](../../../examples/v3-room/src/index.ts) must migrate as real
consumer seams, not merely remove one parameter. The authenticated cut identifies
the predecessor snapshot: object/epoch/previous anchor/manifest digest must not be
confused with the successor head. Trusted expected room identity must replace
identity currently derived from caller declaration before authentication.

Before freezing 2b, prove the cold-recovery capability path against the real
frozen producer fixture, whose narrow forwarding store also reaches shared
verification. The type-only probe does not solve that consumer migration.
Keep live producer verification narrow when it already has the declaration;
require discovery at the actual cold/pending entry points without decorating
the owner, optional methods, or caller-declaration fallback. If this cannot
preserve the frozen oracle boundary, reslice that type/consumer seam before RED.

Paged lineage that ultimately accumulates all pages is still unbounded. Neither
2a nor removal of caller declarations closes the planner/recovery-working-set
obligations. Pending enumeration, complete protected dependencies, legacy
classification, retirement and thousand-epoch acceptance remain in the parent
roadmap; reslice earlier if consumer work cannot be sound without them.

Recipient installation is likewise not generic payload verification. Its actual
publication/authority boundary still needs an explicit contract before pinning;
fixture AHE copying is not authenticated destination installation. New wire or
custody authority requires user direction, while an internal same-authority
installation seam stays within the existing roadmap. This dependency split does
not substitute discovery for the remaining recipient-retention outcome.
