# D.110c-0c1f5b0 exact author-settlement design

## Decision and scope

This design is based on signed/pushed source-audit anchor
`00a860ab3c2ed64b236713fc63b7ae2b073f9f27`. The first high-risk review at
signed/pushed design commit `fc4b8fc78148e5211b09dc32e3f27f32756653ec`
rejected RED with a blocking union. This amendment closes every bounded
carrier/lifecycle finding and isolates one genuine missing capability—bounded
authenticated history for removed author keys—as `D.110c-0c1f5b0p`. It is not
production or RED authorization.

The selected construction has two new protocol-v3 control values and no new
transport, signature suite, dependency, public application operation, or
external trust service:

1. an **author-settlement control operation** inside the existing registered
   `drp-vertex` envelope, signed by the source author under the existing
   `ts-drp/vertex/v3` domain; and
2. a **creator author-settlement checkpoint** in the durable transition
   closure, signed by the fixed room creator and replacing (not shadowing) the
   v1 admitted-frontier aggregate after an explicit upgrade. Its current
   member-frontier grammar is fixed below, but its final removed-author
   identity-history binding remains blocked on f5b0p and therefore cannot yet
   be frozen as a production codec.

The application operation and the protocol settlement statement have one
owner each. The reserved settlement action never enters a blueprint reducer;
ordinary application vertices retain their existing operation bytes. The
issuance store remains the single write-before-ack owner for both ordinary and
control vertices, and the existing v3 envelope remains the single network
carrier. The checkpoint is the sole active recovery authority for settled
issuance; receipt vertices are transient current-epoch evidence committed by
the existing close-set/history roots and are prunable after adoption gates.

This design changes protocol semantics, adds a transition-closure record and
two package-facing opt-in seams. It therefore needs the governing high-risk
review before RED or production edits. It does not change a vertex field, the
protobuf envelope, a digest suite, dependency semantics, epoch workload or
resource ceilings.

## Exact carrier grammar

The reserved application discriminator is exactly
`$drp.author-settlement.v1`. A settlement operation is an exact canonical
record with keys `action` and `statement`:

```ts
type SettlementVertexRef = readonly [epoch: number, anchorDigest: string, authorSequence: number, vertexDigest: string];

type ReplacementRef = Readonly<{
	entryCount: number;
	entryIndex: number;
	operationDigest: string;
	vertex: SettlementVertexRef;
}>;

type IntentDisposition = Readonly<{
	coveredStateDigest: string | null;
	operationDigest: string;
	operationIndex: number;
	outcome: "already-present" | "expire" | "rebase" | "transform";
	replacements: readonly ReplacementRef[];
	semanticIdentityDigest: string;
}>;

type ApplicationSourceDisposition = Readonly<{
	dispositions: readonly IntentDisposition[];
	kind: "application";
	operationCount: number;
	source: SettlementVertexRef;
}>;

type ControlSourceDisposition = Readonly<{
	kind: "settlement-control";
	source: SettlementVertexRef;
}>;

type ZeroIntentSourceDisposition = Readonly<{
	kind: "zero-intent";
	source: SettlementVertexRef;
	sourceAction: "acl" | "causalJoin" | "join";
}>;

type SourceDispositionStatement = Readonly<{
	kind: "source-dispositions";
	sources: readonly (ApplicationSourceDisposition | ControlSourceDisposition | ZeroIntentSourceDisposition)[];
	version: 1;
}>;

type AuthorSettlementOperation = Readonly<{
	action: "$drp.author-settlement.v1";
	statement: SourceDispositionStatement;
}>;
```

All epochs, author sequences, operation counts and indices are nonnegative
safe integers. All anchors, vertex digests, operation digests, semantic
identity digests and state digests are lowercase 32-byte hex digests. The
source author and object are implicit and immutable from the outer signed
vertex. Every source/ref author is therefore the outer author; cross-author
settlement is unrepresentable. The source vertex epoch/anchor may be older;
every replacement is in the control vertex's current object, epoch and anchor.
Every source sequence and replacement sequence is strictly less than the
outer control vertex's author sequence.

The operation is at most 8,192 canonical bytes, contains 1 through 8 source
entries, at most 8 application intents in total, and at most 8 replacement
references in total. A source array is strictly ordered by
`(epoch, anchorDigest, authorSequence, vertexDigest)`. Application dispositions
are exactly indices `0..operationCount-1` in order, with no omission or
duplicate. Replacement arrays preserve application-declared order and contain
unique `(vertexDigest, entryIndex)` identities. `entryCount` is one for an
unbatched replacement or the exact `applicationBatch.entries.length` for a
batch, and `entryIndex` selects the exact inner operation in
`0..entryCount-1`. No source identity may repeat within a control vertex
or across accepted control vertices in the same close graph. The byte ceiling,
all three count ceilings and current graph/pending byte and entry ceilings are
checked before durable issue.

The corrected worst-case measurement uses maximum safe integer ordinals,
64-hex-character digests, eight application sources, eight transform intents,
and eight references into sixteen-entry replacement batches. Its exact
canonical operation is 6,003 bytes. This is the largest count distribution
because it pays all eight source, intent, and replacement object overheads;
the 2,189-byte margin remains below the unchanged 8,192-byte ceiling. f5b0a
must encode this maximum and the adjacent ninth-source/intent/replacement and
8,193-byte failures as executable conformance vectors.

The outcome grammar is closed:

- `expire` has no replacements and `coveredStateDigest === null`;
- `already-present` has no replacements and binds
  `coveredStateDigest` to the authenticated current-anchor application state
  digest;
- `rebase` and `transform` have `coveredStateDigest === null` and one through
  eight exact replacement refs;
- a `settlement-control` source has no application dispositions and means only
  that the older control vertex is superseded by this statement; and
- a `zero-intent` source has no application dispositions and covers exactly
  one author-signed Node-reserved `join`, `causalJoin`, or `acl` slot. The
  local settlement owner authenticates the durable source row and its action
  before emission. The creator treats the signed exact-source waiver only as
  negative authority and never infers an application effect from it.

`operationDigest` is
`hashDomain("ts-drp/author-settlement-operation/v1",
encodeCanonical(operation))`. `semanticIdentityDigest` is
`hashDomain("ts-drp/author-settlement-identity/v1",
encodeCanonical({ action, identity }))`, where both values are the two stable
strings already validated by the room's displacement contract. These inner
digests are evidence fields, not independent signatures. The exact existing
registered vertex preimage—including object, current epoch/anchor, author,
never-resetting author sequence, logical time, dependencies, and the complete
settlement operation—is hashed under `ts-drp/vertex/v3` and signed by the
existing author Ed25519 key. No self-signature or second signature domain is
introduced.

A source-disposition control vertex must causally follow every referenced
replacement. The creator verifies each replacement ref against the exact
current close graph, the same author/object/current epoch/current anchor, its
exact selected batch entry or unbatched canonical inner operation digest, and
a strict ancestor relation to the control vertex. `already-present` is
permitted only when the room's new
deterministic presence query returns true twice over the same authenticated
snapshot-base projection, with no current-epoch operations supplied, and the
receipt binds that current anchor's state digest. An equivalent operation found
in the current graph is instead named as a replacement ref. The query
chooses honest application behavior; it is not accepted as creator authority.
The author's signed statement is the authority to abandon or replace only that
author's own old operation. `manual-review` produces no statement and no
frontier advance until an explicit later application decision resolves it to
one of the closed outcomes.

The reviewed `author-baseline` form is deleted. A creator cannot authenticate
a caller-local `lineageNext`, and an author omitted after ACL removal could
otherwise reset to sequence zero when the same key returns. Every absent slot,
including genesis `join` and other zero-intent Node slots, therefore requires
an exact author-signed source disposition. Same-key removal/re-entry remains
fail closed pending the separately named bounded identity-history prerequisite
below; neither local-store possession nor a fixture claim is creator authority.

## Admission and durable lifecycle

Settlement control operations use the existing v3 envelope, gossip message,
settlement-specific transactional issuer, issuance outbox and live journal.
Protocol-v3 owns the exact settlement codec and reserves the action globally:
blueprint preparation rejects a blueprint that registers
`$drp.author-settlement.v1`, and Node recognizes the control body by an own
`action` data property independent of the blueprint-selected discriminator.

Node admission authenticates the normal vertex envelope and signature first,
requires current ACL envelope membership, requires settlement mode to be
active, validates the closed settlement grammar and capacities, then appends
the vertex to the ordinary causality index. Control authority is deliberately
ACL membership rather than application-write permission: the statement is
negative authority over only the signer's own issuance and is never presented
to the application fold. A member without write permission therefore cannot
inject application state or abort close.

The Node owner splits current-epoch custody explicitly. `closeVertices`,
`closeAuthors`, and `closeCharges` contain every admitted application and
settlement vertex and each has exactly the causality index size.
`applicationVertices` and `settlementVertices` are disjoint exact subsets
whose union is `closeVertices`; each subset has matching author/charge rows.
Close-set, RFC 9162 history, dependency/frontier validation, and creator slot
scanning use the complete close maps. `stageBlueprintEpoch()` passes only the
application subset to `foldBlueprintEpoch()`. The compaction fold keeps its
current fail-closed application authorization and reducer behavior; f5b0b
owns the Node split plus retained `@ts-drp/compaction` proof that no settlement
operation reaches authorization, reservation, apply, ACL staging, projection
callbacks, or application-state accounting.

The six current `preparedBlueprintAdmission` families are dispositioned
explicitly. Ordinary local issue, ingress, pinned-genesis recovery,
covered-historical recovery, displaced/current recovery, and application
journal replay remain blueprint-bound. Their shared envelope extraction first
recognizes an exact settlement body and routes it to the settlement codec only
when settlement mode is authenticated; malformed lookalikes fail rather than
fall through. Settlement local issue uses a dedicated Node issuer over
`DurableIssuanceStore.transactIssue`, the ordinary vertex signer, dependency
selection, capacity accounting, index, journal, and publish owners, but never
`createAdmissionBoundTransactionalVertexIssuer`. A terminal settlement row is
skipped before blueprint authentication. A nonterminal settlement row is
authenticated by the settlement codec and republished as control; it is never
returned by `rebaseIntents()` and is later covered only by a
`settlement-control` source.

The Node plane adds one settlement-specific method rather than widening public
application `issue()`:

```ts
settleRebaseSources(input: Readonly<{
	signRegisteredVertexDigest: SignRegisteredVertexDigest;
	statement: SourceDispositionStatement;
}>): Promise<V3AuthorSettlementResult>;
```

The room remains the single owner of displacement policy, source application
bytes, semantic identity, replacement selection and authenticated projection.
It retains the internal `V3LocalIssueResult` identities for rebase/transform
issues, builds the bounded statement, and calls the Node method. Public room
`issue()` continues to return `Promise<void>`. Node reopens each named source
from the existing issuance store, authenticates its exact digest/sequence and
classification, verifies current replacement refs, and issues the control
vertex through the dedicated transaction path described above.

The durable order is fixed:

1. replacement application vertices, if any, are durably issued, admitted and
   published;
2. the settlement control vertex is durably issued and appended to the live
   journal;
3. it is published through the existing outbox;
4. only then are the exact source rows marked complete/published; and
5. later pruning still waits for a creator-signed settled checkpoint, verified
   adoption, rollback-generation protection and availability policy.

The idempotence key is the exact source identity. On restart, Node enumerates
the issuance outbox and current live journal before authoring anything. One
already-authenticated matching control statement resumes publication and
source completion. A second identical or conflicting accepted statement for
the same source is an ambiguity and cannot advance the creator checkpoint.
Unknown issue/publication outcome halts local application issue under the
existing fail-closed rule. Source completion before durable control issue is
unrepresentable through the settlement method. Mutable `publishState` alone
never settles a source.

The room's existing rebase startup barrier remains the public-issue barrier.
Rows above the authenticated settled frontier are drained before a later
ordinary issue. For an application source, the room checks each intent:

- `manual-review`: retain it and emit no settlement;
- `expire`: record the exact terminal outcome;
- already represented in the authenticated projection: record
  `already-present` against the anchor state digest;
- otherwise issue the exact rebase/transform replacement(s), retain their
  returned identities, and record them.

An older settlement-control row is never handed to the application. It is
covered by a later `settlement-control` source entry. This closes crash cases
where a control vertex was durably authored but missed the prior close.
Reserved `join`, `causalJoin`, and `acl` rows are likewise never silently
auto-completed merely because `rebaseIntents()` returned an empty array; the
room emits the exact `zero-intent` disposition first. A cross-object migration
import remains outside automatic settlement: it stays explicit manual-review
debt and stops only that author until a later separately authenticated policy
exists.

## Creator checkpoint and advancement

The new record kind is exactly
`drp-creator-author-settlement-state`, version `1`, domain
`ts-drp/creator-author-settlement/v1`, maximum 8,192 canonical bytes. Its exact
preimage fields are:

```ts
{
	closedAnchorDigest,
	closedEpoch,
	commitQcRef: { byteLength, digest },
	currentAclDigest,
	cutValueDigest,
	frontiers: readonly [
		author: string,
		admittedThrough: number | null,
		settledThrough: number | null,
	][],
	genesisAnchorDigest,
	historyRoot,
	historySize,
	kind: "drp-creator-author-settlement-state",
	objectId,
	priorCheckpointDigest,
	priorCheckpointKind: "admitted-v1" | "genesis" | "settled-v1",
	protocolMajor: 3,
	snapshotManifestDigest,
	successorAclDigest,
	successorAnchorDigest,
	successorEpoch,
	version: 1,
}
```

The record adds `detachedCreatorSignature` after signing. The existing opaque
creator signing request pattern is reused; callers never receive an arbitrary
digest-signing primitive. Frontiers are strictly code-unit sorted, unique, and
contain at most the 64 members of the successor ACL (not only writers).
`admittedThrough` and `settledThrough` are distinct capabilities. A member
that loses write permission but retains another ACL role therefore keeps both
boundaries.

A fully removed key cannot simply be omitted and later accepted as fresh.
Doing so loses the only creator-authenticated never-resetting boundary. The
exact bounded representation for prior author identity after removal is not
present in the repository and is not selected here. The blocking
`D.110c-0c1f5b0p` prerequisite below must choose and review an authenticated,
age-independent identity-history construction or an equally enforceable
compatibility boundary before this checkpoint shape is frozen. Unbounded
tombstone vectors, caller-local lineage claims, fixture-only membership facts,
and a lifetime-64-author limit are rejected.

The record binds the current and successor creator trust, object/genesis,
adjacent epochs/anchors, both ACLs, cut digest, commit QC, snapshot manifest,
and the history root/size produced for the current graph. The cut independently
contains the same snapshot and history facts. Any mismatch fails closed. The
predecessor is exactly one genesis sentinel, one v1 admitted-frontier record,
or one prior settlement checkpoint; mixed, duplicate, skipped, stale or
downgraded predecessors fail.

For each successor ACL member, the creator begins with the prior authenticated
settled boundary (or null), groups the complete current close graph by exact
`(author, authorSequence, digest)`, and authenticates settlement statements.
A settled slot is accounted only by exactly one graph vertex identity or
exactly one same-author source disposition. A graph/source digest mismatch,
same-slot equivocation, duplicate source, invalid causal replacement,
cross-scope ref, or malformed statement stops settlement advancement for that
author at the last exact adjacent slot. It does not abort the close or change
another author's result. Creator-owned duplicate/regression errors keep their
current fail-closed behavior.

The admitted boundary separately advances only across exact adjacent graph
slots and never across a disposition. In the migration checkpoint it is copied
from the authenticated v1 frontier; the settled boundary starts null. In later
checkpoints both are monotone and neither can regress. The creator's own author
participates in the same settlement scan. The migration close retains the
legacy creator-issuance-retirement record only as the authenticated source of
the creator's initial admitted boundary and refuses opt-in until the creator's
existing v1 pending/displaced rows have drained. Subsequent settlement-mode
closures contain no legacy retirement record and no v1 aggregate; the new
checkpoint is the sole per-author recovery authority. The transition verifier
branches exactly between `(v1 aggregate + creator retirement, no settlement
checkpoint)`, `(migration settlement checkpoint + creator retirement, no v1
aggregate)`, and `(settlement checkpoint only)`. The old equality between the
creator retirement boundary and the v1 aggregate is not applied to later
settled checkpoints.

The scan advances from `prior + 1` (or zero) through exact adjacent accounted
slots; a control vertex's own author sequence is an ordinary graph slot. It
never takes an observed maximum and never advances across unknown evidence.
The creator signs the resulting vector and close proceeds even when one
foreign boundary cannot advance, preserving f5a's per-author liveness.

## Recovery semantics and pruning

The admitted and settled frontiers are different
capabilities and have different consumers:

- v1 retains its existing `covered-historical` behavior byte-for-byte;
- the first settlement checkpoint copies a verified v1 frontier only into
  `admittedThrough`; every `settledThrough` starts null, so an offline pending
  same-slot row retains the shipped covered-historical reissue behavior rather
  than becoming terminal without its author's statement;
- under a verified settlement checkpoint, any same-author issuance row at or
  below `settledThrough` is **terminal**. It is never republished, rebased,
  reduced or used as application evidence, regardless of its digest; and
- a valid row above `settledThrough` and at or below `admittedThrough` retains
  the existing covered-historical behavior; any other row above the settled
  boundary retains displaced/rebase behavior. Both require a later signed
  settlement statement before becoming terminal.

The terminal rule is why an unseen or substituted row below the new prefix
cannot gain authority. The checkpoint authenticates a decision boundary, not
membership of arbitrary row bytes. Same-slot equivocation remains evidence and
cannot advance a future boundary, but neither fork is applied after settlement.

Control and source issuance rows remain in issuance/live-journal custody until
a later authenticated checkpoint covers their sequence. f5b0d adds one
storage-neutral `pruneAuthenticatedSettledPrefix` contract, its in-memory and
browser implementations, and conformance vectors. Node may call it only after
durable checkpoint staging, verified successor adoption, rollback-generation
retention, availability, expected-head/revision, and exact checkpoint-author
boundary checks. Its transaction compare-and-deletes issued/outbox rows at or
below `settledThrough` across any number of old epochs and advances the
existing pruned watermark monotonically. Unlike legacy
`prunePublishedPrefix`, it does not require every selected row to share one
`closedEpoch` or to be published: the authenticated settled capability is the
authority that pending and substituted rows are terminal. It does require the
expected lineage-next and prior-pruned watermark to match, and ambiguity or
partial deletion fails closed. The legacy single-epoch method and all v1 paths
remain unchanged.

Receipt bytes remain in archived RFC 9162 history for audit but are not needed
for ordinary cold reopen. Active control state is one current checkpoint with
at most 64 frontier triples, the existing fixed rollback
generations and compact history peaks, plus current-epoch control vertices
already bounded by `maxEpochVertices`, `maxEpochBytes`, `maxPendingEntries`
and `maxPendingBytes`. No state grows with epoch count or number of completed
rebases. Manual-review rows remain explicit application/outbox debt and stop
only that author's boundary; they are not copied into another hidden store.

## Compatibility and upgrade boundary

The public room/session creation input adds one explicit opt-in:
`authorSettlementVersion?: 1`. The application adds
`hasDisplacedOperation(projection, operation): boolean`; it is required only
when the opt-in is present or an authenticated settlement checkpoint is being
opened. The function is called twice over the same detached authenticated
inputs and disagreement fails closed. This is the only new application-facing
semantic query. It does not sign, admit or settle anything.

With no opt-in, a v1 room emits and consumes only the existing admitted
frontier and creator retirement record. With opt-in, the next close emits the
new settlement checkpoint and the creator retirement record, but no v1
aggregate. The first record names the exact v1 aggregate digest as
`priorCheckpointKind: "admitted-v1"`, or the genesis sentinel at epoch zero,
copies only authenticated admitted boundaries, and initializes every settled
boundary to null. After that checkpoint is active, every successor contains
exactly one settlement checkpoint and neither legacy per-author record;
downgrade, omission, mixed kinds, or a later retirement record fail closed.

Settlement control operations are admitted only after an authenticated
settlement checkpoint is active, never in the migration epoch. Therefore the
first opt-in close uses existing v1 behavior and the successor enables the new
carrier. Old binaries reject that successor because they require a v1
aggregate and do not recognize the reserved action. They cannot silently
continue or partition application state. Operators must coordinate the opt-in;
there is no runtime negotiation, fallback or automatic upgrade. Existing v1
history is preserved unchanged, and its bytes are never relabelled as the new
record.

This is a protocol/closure-schema and public configuration/API change but not
a protobuf/wire-envelope change. It adds no dependency and uses the current
Ed25519, canonical and RFC 9162 implementations.

## Crash, attack and failure matrix

The implementation and retained tests must prove:

| Boundary or attack                                                                  | Required result                                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| crash before replacement issue                                                      | source stays pending; restart selects it once                                                                  |
| crash after some replacements                                                       | exact accepted identities are reused/deduped; missing replacements issue once                                  |
| crash before control transaction                                                    | no source completion; restart authors one statement                                                            |
| unknown control transaction outcome                                                 | application issue halts; reopen enumerates durable truth before retry                                          |
| control journaled but unpublished                                                   | restart republishes it; source remains pending until publication succeeds                                      |
| control published, creator has not admitted it                                      | local source may be complete, but no checkpoint advances; retained replay remains                              |
| close stages before source-local completion                                         | admitted statement may advance; restart terminalizes source from checkpoint and completes/prunes only at gates |
| close/adoption fails                                                                | old checkpoint remains authoritative; no prune                                                                 |
| adoption succeeds before prune                                                      | new terminal boundary is authoritative; rollback generations and availability still gate prune                 |
| malformed/cross-object/cross-author/cross-epoch/stale/future ref                    | statement rejected before append                                                                               |
| replacement missing, reordered, substituted, not same-author or not causal ancestor | source not settled                                                                                             |
| replacement batch count/index/digest mismatch                                       | source not settled                                                                                             |
| duplicate/conflicting receipt                                                       | affected author does not advance; creator-local conflict keeps exact hard failure                              |
| zero-intent join/causalJoin/ACL gap                                                 | exact signed source disposition advances only that slot; no application effect inferred                        |
| settlement vertex in close graph                                                    | included in charges/frontier/close-set/history, excluded exactly from application fold                         |
| row substitution at or below settled prefix                                         | row is terminal and never applied                                                                              |
| row above prefix                                                                    | ordinary authenticated displacement handling; never silently terminal                                          |
| pending covered-historical row at v1 migration                                      | remains nonterminal and follows the shipped v1 reissue path until its author's later signed settlement         |
| creator's own displaced row after migration                                         | settles through the same control/checkpoint path; no legacy retirement hard stop                               |
| same-key removal/re-entry                                                           | fail closed until D.110c-0c1f5b0p supplies authenticated bounded identity history                              |
| cross-object migration import                                                       | remains explicit manual-review debt; no fabricated same-object replacement                                     |
| manual review                                                                       | no receipt, no false settlement, other authors may close                                                       |
| incompatible/mixed/downgraded closure                                               | successor open/advance rejects                                                                                 |

## Blocking identity-history prerequisite

The first review proved that the carrier and checkpoint cannot safely infer
that an ACL key absent from the immediately prior frontier is globally new.
The current signed ACL, checkpoint, RFC 9162 history root, local issuance
store, and archive-index root expose no bounded authenticated non-reuse proof.
Omitting a removed key loses its never-resetting boundary; retaining every
removed key grows active control state with room age. The design therefore
opens `D.110c-0c1f5b0p` before any f5b0a RED.

That prerequisite must audit the genuine ACL add/remove/re-add and cold-open
owners and select exactly one age-independent creator-verifiable construction.
It must authenticate from the current pinned checkpoint both whether a public
key appeared before and the last admitted/settled boundary needed to reject a
reset, while allowing ordinary reopen without replaying O(epoch) history.
Candidates include a bounded authenticated author-incarnation dictionary, an
explicit authority-signed fresh-incarnation carrier, or a reviewed change to
the author identity/sequence contract. It must account for proof production,
untrusted storage, update and nonmembership proofs, removed-key pruning,
rollback, availability, migration, browser cost, schema/API/dependency impact,
and durable census. It must reject caller-local lineage, unbounded checkpoint
tombstones, an uncounted mandatory bootstrap store, and an arbitrary
lifetime-author cap. If the selected construction changes a vertex field,
authority assumption, public API, dependency, setup, or migration contract,
it receives its own explicit high-risk prerequisite and review rather than
being smuggled into settlement GREEN.

## TDD implementation slices

After the blocking prerequisite selects the missing identity-history boundary,
implementation is split at natural owners without repeated plan ceremony:

1. **f5b0p — bounded author identity history.** Source/architecture audit and
   exact high-risk design only. It closes when the selected construction and
   compatibility boundary have an empty P0/P1 review union; it authorizes no
   settlement production edit by itself.
2. **f5b0a — protocol carrier and checkpoint codecs.** RED freezes exact
   canonical shapes, byte/count limits, signature/domain behavior, v1→settled
   predecessor rules, admitted-versus-settled migration, global reservation of
   the action, downgrade/mixed rejection and opaque signing custody. GREEN is
   confined to protocol-v3 registry/codecs/exports, issuer-side discrimination,
   and conformance.
3. **f5b0b — Node admission, close-graph split and durable settlement
   transaction.** RED uses real
   signed vertices and durable issuance/live-journal stores for normal,
   restart, outcome-unknown, partial publication, duplicate and malformed
   cases, plus control∪application close-map equality and reducer exclusion.
   GREEN adds the settlement-specific authentication/recovery paths,
   `settleRebaseSources()`, and exact Node-owned close split; compaction is a
   retained invariant/test owner, not a widened reducer. No room policy or
   creator-frontier logic.
4. **f5b0c — room disposition orchestration.** RED drives the real rebase
   outbox through expire, manual-review, already-present, rebase, transform,
   indexed batching, zero-intent control sources, migration-import refusal and
   crash boundaries. GREEN adds only the opt-in, deterministic
   projection-presence query and internal result plumbing; public `issue()` is
   unchanged.
5. **f5b0d — authenticated settled-prefix reclamation.** RED freezes the new
   storage-neutral CAS/delete contract and conformance across mixed epochs,
   pending/published/substituted rows, stale lineage/watermark, partial failure,
   rollback and v1 noninterference. GREEN owns issuance-store, memory model,
   browser implementation, closed-epoch cleanup integration and bounded
   retained census.
6. **f5b — creator settlement and recovery integration.** The already-owned
   causal RED covers rebase and honest delivery gaps, genesis gap, same-slot
   regression, membership re-entry, at least two later close/adopt cycles,
   creator and non-creator rows, restart and cold reopen. GREEN replaces the
   v1 aggregate only in opt-in mode, applies dual per-author advancement,
   settlement-mode retirement-record removal, terminal recovery and gated
   pruning.

Each sub-slice uses one causal tests-only RED before its production GREEN,
focused/static/retained/isolated gates with complete logs, signed commits and
pushed refs. The final f5b review inspects the complete signed design→RED→GREEN
history with Grok 4.6/high, direct Kimi K3 at 100 steps and Opus xhigh. Because
the design review is the unique high-risk authority/API checkpoint, the three
implementation sub-slices do not recursively reopen the architecture unless a
RED contradicts this matrix or production work requires a different wire,
authority, dependency, threshold or API.

## Acceptance and stop rules

No production edit or RED runs before f5b0p is exact and the amended design
confirmation has an empty P0/P1 union. P2 receives an owner/disposition without
prose-only recursion. If review shows that a normal signed control vertex cannot preserve the current
causality/capacity contract, that author abandonment is insufficient authority,
or the v1 migration/downgrade rule is unsafe, stop and amend the design rather
than implementing a nearby substitute.

The complete GREEN must demonstrate genuine source rows and signed control
vertices through ordinary publication, close/adopt, restart and cold reopen;
exact state, ACL, authority, anchor, history, archive and operation accounting;
no same-anchor double close; unchanged v1 behavior without opt-in; fail-closed
old/mixed peers; retained f2/f4/f5a and D.108-D.110 lifecycle behavior; bounded
durable/runtime census; and fresh-process repeated same-room memory in the
later ≥100-transition gate. Tests-only receipt injection or synthetic
checkpoint bytes cannot satisfy the end-to-end RED/GREEN.
