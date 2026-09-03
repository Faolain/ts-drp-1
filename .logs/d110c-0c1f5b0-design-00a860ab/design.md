# D.110c-0c1f5b0 exact author-settlement design

## Decision and scope

This design is based on signed/pushed source-audit anchor
`00a860ab3c2ed64b236713fc63b7ae2b073f9f27`. The first high-risk review at
signed/pushed design commit `fc4b8fc78148e5211b09dc32e3f27f32756653ec`
rejected RED with a blocking union. The first amendment closed the bounded
carrier/lifecycle findings and isolated one genuine missing capability—bounded
authenticated history for removed author keys—as `D.110c-0c1f5b0p`. The
follow-on source audit and exact design are
`.logs/d110c-0c1f5b0p-design-e6a67013/{audit,design}.md`. They select a
creator-authenticated Merkle AVL retired-author dictionary and a genesis-bound
`creator-trusted-settlement-v1` profile. This combined amendment is not
production or RED authorization.

The selected construction has two new protocol-v3 control values and no new
transport, signature suite, dependency, public application operation, or
external trust service:

1. an **author-settlement control operation** inside the existing registered
   `drp-vertex` envelope, signed by the source author under the existing
   `ts-drp/vertex/v3` domain; and
2. a **creator author-settlement checkpoint** in the durable transition
   closure, signed by the fixed room creator and replacing (not shadowing) the
   v1 admitted-frontier aggregate for rooms created under the new settlement
   profile. Its active member vector is joined to the creator-authenticated
   retired-author dictionary root/count frozen by f5b0p.

The application operation and the protocol settlement statement have one
owner each. The reserved settlement action never enters a blueprint reducer;
ordinary application vertices retain their existing operation bytes. The
issuance store remains the single write-before-ack owner for both ordinary and
control vertices, and the existing v3 envelope remains the single network
carrier. The checkpoint is the sole active recovery authority for settled
issuance; receipt vertices are transient current-epoch evidence committed by
the existing close-set/history roots and are prunable after adoption gates.

This design changes protocol semantics, adds a transition-closure record, a
sibling genesis trust profile, a storage-neutral retired-author registry and
one application semantic query. It therefore needs the governing high-risk
review before RED or production edits. It does not change a vertex field, the
protobuf envelope, creator signer/quorum, digest suite, third-party dependency,
epoch workload or resource ceilings.

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
	priorCheckpointKind: "genesis" | "settled-v1",
	protocolMajor: 3,
	retiredAuthorRegistryRoot,
	retiredAuthorRegistrySize,
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

`retiredAuthorRegistryRoot` and `retiredAuthorRegistrySize` bind the exact
Merkle AVL state frozen in the f5b0p design. A fully removed key is inserted
with its final admitted/settled boundaries; a re-added key is deleted and its
boundaries return to the active vector. Verified nonmembership is the only way
a new key begins with null boundaries. Ordinary openers authenticate the
creator-signed root/count without loading dictionary nodes; the creator
verifies O(log R) paths only for membership-changing ACL transitions.

The record binds the current and successor creator trust, object/genesis,
adjacent epochs/anchors, both ACLs, cut digest, commit QC, snapshot manifest,
and the history root/size produced for the current graph. The cut independently
contains the same snapshot and history facts. Any mismatch fails closed. Under
`creator-trusted-settlement-v1`, the predecessor is exactly one genesis
sentinel or one prior settlement checkpoint; mixed, duplicate, skipped, stale
or downgraded predecessors fail. A `creator-trusted-v1` room never accepts this
checkpoint.

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
slots and never across a disposition. At settlement-profile genesis every
active member begins with both boundaries null. In later checkpoints both are
monotone and neither can regress. The creator's own author participates in the
same settlement scan. Settlement-profile closures contain neither the v1
aggregate nor the legacy creator-retirement record; the settlement checkpoint
is the sole per-author recovery authority from the first close. Existing v1
rooms retain their exact existing aggregate/retirement behavior and cannot
late-opt-in in this slice.

The scan advances from `prior + 1` (or zero) through exact adjacent accounted
slots; a control vertex's own author sequence is an ordinary graph slot. It
never takes an observed maximum and never advances across unknown evidence.
The creator signs the resulting vector and close proceeds even when one
foreign boundary cannot advance, preserving f5a's per-author liveness.

## Recovery semantics and pruning

The admitted and settled frontiers are different
capabilities and have different consumers:

- `creator-trusted-v1` retains its existing `covered-historical` behavior
  byte-for-byte;
- `creator-trusted-settlement-v1` begins at genesis with null admitted/settled
  boundaries and never imports a v1 admitted frontier;
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
The active checkpoint stays O(64), while reachable retired-author dictionary
nodes are an explicit O(R) archive-tier control index, counted separately and
unnecessary for ordinary cold reopen. They are needed only by the creator when
membership changes; unavailability stalls that close rather than weakening
freshness.

## Compatibility and genesis-profile boundary

The application adds
`hasDisplacedOperation(projection, operation): boolean`; it is required only
for a settlement-profile room. The function is called twice over the same
detached authenticated inputs and disagreement fails closed. It does not sign,
admit or settle anything.

The creator selects exact profile ID `creator-trusted-settlement-v1` in the
canonical profile bytes before genesis. Its signer set, quorum, crypto suite
and creator-trusted/not-BFT UI meaning are identical to
`creator-trusted-v1`; the genesis anchor's existing `profileDigest` binds the
choice. Settlement state starts at genesis with the active ACL's null
frontiers and the empty retired-author root/count. Every close uses the new
checkpoint and control rules. Old binaries reject the unsupported profile.

An existing `creator-trusted-v1` room emits and consumes only the existing
admitted frontier/creator retirement and cannot late-opt-in. There is no
runtime option, negotiation, fallback or automatic migration. A future
migration requires separately reviewed authenticated full-history author-index
construction. Existing bytes are never relabelled.

This is a protocol/closure-schema/profile and public compatibility change but
not a protobuf/wire-envelope or authority change. It adds no dependency and
uses the current Ed25519, canonical and RFC 9162 implementations.

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
| legacy v1 room receives settlement carrier/profile                                  | exact unsupported/mixed-profile rejection; existing behavior unchanged                                         |
| creator's own displaced row in settlement profile                                   | settles through the same control/checkpoint path; no legacy retirement owner exists                            |
| same-key removal/re-entry                                                           | registry membership restores the exact boundary; reset is rejected                                             |
| genuinely fresh key                                                                 | registry nonmembership permits null boundary and sequence zero                                                 |
| registry proof/store unavailable                                                    | membership-changing close stalls; no fallback-to-fresh                                                         |
| cross-object migration import                                                       | remains explicit manual-review debt; no fabricated same-object replacement                                     |
| manual review                                                                       | no receipt, no false settlement, other authors may close                                                       |
| incompatible/mixed/downgraded closure                                               | successor open/advance rejects                                                                                 |

## Resolved identity-history design prerequisite

The first review proved that the carrier and checkpoint cannot safely infer
that an ACL key absent from the immediately prior frontier is globally new.
The f5b0p audit confirms no dormant current owner can do so and selects the
Merkle AVL retired-author dictionary and genesis-bound settlement profile in
`.logs/d110c-0c1f5b0p-design-e6a67013/design.md`.

The active checkpoint holds only one authenticated root/count plus the current
64-member vector. Ordinary reopen does not read the dictionary. Membership-
changing creator close verifies O(log R) paths from untrusted storage; reachable
backing is an explicit O(R) archive-tier control index, not hidden active or
bootstrap state. That information-theoretic growth is accepted only if the
governing confirmation agrees it satisfies the durable-census contract. If
review instead requires O(1) durable bytes under unbounded distinct-key churn,
stop at design and open a cryptographic accumulator/recursive-proof prerequisite;
do not implement a disguised tombstone list.

## TDD implementation slices

After the combined design confirmation has an empty P0/P1 union,
implementation is split at natural owners without repeated plan ceremony:

1. **f5b0p-a — protocol dictionary/profile.** RED freezes the exact Merkle AVL
   node/proof/update grammar, deterministic rotations, profile union,
   genesis-empty state, root/count checkpoint fields and the measured
   64-frontier byte ceiling. GREEN is pure codecs/verifiers/profile plumbing;
   no store or creator-close behavior.
2. **f5b0p-b — retired-author registry store.** RED freezes the neutral
   contract plus memory/browser strict durability, idempotence, ambiguous
   outcome recovery, corruption refusal and current/two-rollback reachability
   GC. GREEN adds the dedicated store/schema; it does not hide nodes in AHE.
3. **f5b0a — protocol carrier and checkpoint codecs.** RED freezes exact
   canonical shapes, byte/count limits, signature/domain behavior,
   genesis/settled predecessor rules, global reservation, old/mixed-profile
   rejection and opaque signing custody. GREEN is confined to protocol-v3
   registry/codecs/exports, issuer-side discrimination, and conformance.
4. **f5b0b — Node admission, close-graph split and durable settlement
   transaction.** RED uses real
   signed vertices and durable issuance/live-journal stores for normal,
   restart, outcome-unknown, partial publication, duplicate and malformed
   cases, plus control∪application close-map equality and reducer exclusion.
   GREEN adds the settlement-specific authentication/recovery paths,
   `settleRebaseSources()`, and exact Node-owned close split; compaction is a
   retained invariant/test owner, not a widened reducer. No room policy or
   creator-frontier logic.
5. **f5b0c — room disposition orchestration.** RED drives the real rebase
   outbox through expire, manual-review, already-present, rebase, transform,
   indexed batching, zero-intent control sources, migration-import refusal and
   crash boundaries. GREEN adds only the deterministic
   projection-presence query and internal result plumbing; public `issue()` is
   unchanged.
6. **f5b0d — authenticated settled-prefix reclamation.** RED freezes the new
   storage-neutral CAS/delete contract and conformance across mixed epochs,
   pending/published/substituted rows, stale lineage/watermark, partial failure,
   rollback and v1 noninterference. GREEN owns issuance-store, memory model,
   browser implementation, closed-epoch cleanup integration and bounded
   retained census.
7. **f5b — creator settlement and recovery integration.** The already-owned
   causal RED covers rebase and honest delivery gaps, genesis gap, same-slot
   regression, membership re-entry, at least two later close/adopt cycles,
   creator and non-creator rows, restart and cold reopen. GREEN applies dual
   per-author advancement only under the genesis-bound settlement profile,
   emits no v1 aggregate/legacy retirement there, and owns terminal recovery
   and gated pruning. It derives the real current/successor ACL diff, commits the exact
   registry transition before checkpoint signing and keeps current plus two
   rollback roots.

Each sub-slice uses one causal tests-only RED before its production GREEN,
focused/static/retained/isolated gates with complete logs, signed commits and
pushed refs. The final f5b review inspects the complete signed design→RED→GREEN
history with Grok 4.6/high, direct Kimi K3 at 100 steps and Opus xhigh. Because
the design review is the unique high-risk authority/API checkpoint, the three
implementation sub-slices do not recursively reopen the architecture unless a
RED contradicts this matrix or production work requires a different wire,
authority, dependency, threshold or API.

## Acceptance and stop rules

No production edit or RED runs before the amended design confirmation has an
empty P0/P1 union. P2 receives an owner/disposition without prose-only
recursion. If review shows that a normal signed control vertex cannot preserve
the current causality/capacity contract, that author abandonment is
insufficient authority, that the genesis-profile boundary is unsafe, or that
the explicit O(R) archive-tier registry violates the accepted durable-census
contract, stop and reslice the exact prerequisite rather than implementing a
nearby substitute.

The complete GREEN must demonstrate genuine source rows and signed control
vertices through ordinary publication, close/adopt, restart and cold reopen;
exact state, ACL, authority, anchor, history, archive and operation accounting;
no same-anchor double close; unchanged `creator-trusted-v1` behavior;
fail-closed old/mixed peers; authenticated same-key continuation and fresh-key
zero; retained f2/f4/f5a and D.108-D.110 lifecycle behavior; bounded active
checkpoint/runtime census plus explicit O(R) registry accounting; and
fresh-process repeated same-room memory in the later ≥100-transition gate.
Tests-only receipt/registry injection or synthetic checkpoint bytes cannot
satisfy the end-to-end RED/GREEN.
