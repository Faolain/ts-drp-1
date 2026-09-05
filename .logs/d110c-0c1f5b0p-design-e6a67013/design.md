# D.110c-0c1f5b0p bounded removed-author identity-history design

## Decision

Select a deterministic creator-authenticated Merkle AVL dictionary of currently
retired public keys and bind its root/count into every settlement checkpoint.
Select a new genesis-bound `creator-trusted-settlement-v1` profile so settlement
and retired-key continuity start at epoch zero. Do not migrate an existing
`creator-trusted-v1` room in this slice.

This remains a high-risk audited recommendation, not production authorization.
It adds no cryptographic dependency or setup and preserves the fixed creator
signer, Ed25519/SHA-256, cut/QC, ACL, anchor, snapshot, history and availability
authority. It does add a profile identifier, settlement/checkpoint schemas and
a storage-neutral retired-author registry contract. Those changes require the
combined f5b0p/f5b0 confirmation before tests-only RED.

## Authenticated dictionary

### Canonical node and root

The empty root is
`hex(hashDomain("ts-drp/retired-author-registry-empty/v1", encodeCanonical(null)))`.
Every nonempty node is the exact canonical record:

```ts
{
	author: string,
	admittedThrough: number | null,
	height: number,
	kind: "drp-retired-author-registry-node",
	left: {
		byteLength: number,
		digest: string,
		height: number,
		maxAuthor: string,
		minAuthor: string,
		subtreeSize: number,
	} | null,
	right: {
		byteLength: number,
		digest: string,
		height: number,
		maxAuthor: string,
		minAuthor: string,
		subtreeSize: number,
	} | null,
	settledThrough: number | null,
	subtreeSize: number,
	version: 1,
}
```

`author` is exactly 64 lowercase hexadecimal characters. Non-null boundaries
are safe nonnegative integers; `settledThrough` may not exceed
`admittedThrough`, and `admittedThrough === null` requires
`settledThrough === null`. Height and subtree size are safe positive integers
recomputed from children. A child reference has the six exact keys shown,
positive safe byte length/height/subtree size, lowercase 64-hex digest and
canonical min/max 64-hex keys. Parent height, size and extrema must recompute
exactly from those child facts, with `left.maxAuthor < author <
right.minAuthor`. Node digest is
`hex(hashDomain("ts-drp/retired-author-registry-node/v1", exactCanonicalNodeBytes))`.
Nodes have a 1,024-byte ceiling.

The exact maximum-shaped two-child node encoded with the workspace canonical
implementation is 792 bytes, leaving 232 bytes under that ceiling.

The tree is a strict binary-search tree under UTF-16 code-unit order and an AVL
tree with balance factor -1, 0 or 1. Heights, subtree sizes, extrema, child byte
lengths, digests, key ordering and canonical bytes are recomputed along every
opened path; authenticated unopened-child metadata supplies the sibling facts
needed for parent recomputation. Empty and nonempty roots are unambiguous.

### Proofs and deterministic updates

A lookup proof contains the exact root-to-terminal node bytes. The verifier
rehashes every node, follows only the branch selected by the queried key,
checks all AVL/order/metadata constraints exposed by the path, and ends either
at the unique matching key or at a null child. A truncated path, extra node,
wrong branch, foreign root, noncanonical node, digest/length mismatch,
duplicate key or malformed boundary fails closed. Membership returns the exact
prior boundaries; nonmembership returns no boundaries.

A batch witness is a canonical digest-keyed set of node bytes plus an ordered
mutation-to-path schedule. Each mutation path is verified against the root
produced by the preceding mutation, not only the original root. Deleting a node
with two children additionally opens the deterministic in-order-successor path.
Every deletion step also carries the exact ordered off-path rebalance nodes
needed by the frozen rotation algorithm: bottom-up by rebalanced ancestor,
sibling first and the sibling's inner child second only for a double rotation.
Every such node is rehashed and checked against the same evolving intermediate
root as the lookup/successor paths; missing, reordered or surplus scheduled
nodes fail. Shared nodes appear once in the node set and may be referenced
repeatedly by digest.

The detached canonical witness has this exact tests-and-store boundary (it is
not a vertex, checkpoint field or public network record):

```ts
type RetiredAuthorBatchWitness = {
	kind: "drp-retired-author-registry-batch-witness";
	mutationsDigest: string;
	nodes: readonly [digest: string, exactCanonicalNodeBytes: Uint8Array][];
	priorRoot: string;
	priorRootSize: number;
	steps: readonly {
		author: string;
		lookupPath: readonly string[];
		rebalanceNodes: readonly string[];
		successorPath: readonly string[];
	}[];
	version: 1;
};
```

`nodes` are strictly digest-sorted and unique. Every path item names one entry
in that map or one node computed by an earlier step. `steps` correspond one-to-
one with mutations in the same order. `successorPath` is empty except for a
two-child delete and `rebalanceNodes` is empty for assertions/inserts and for a
delete that needs no off-path node. The witness digest is
`hashDomain("ts-drp/retired-author-registry-batch-witness/v1", bytes)` and the
mutation digest uses
`ts-drp/retired-author-registry-mutations/v1`. Witness canonical bytes are
capped at 33,554,432; node count, path count and node-byte limits are checked
before allocation.

A transition is an exact code-unit-sorted, unique batch of at most 128
mutations, the maximum possible current-ACL-to-successor-ACL difference with
both ACLs capped at 64:

```ts
type RetiredAuthorMutation =
	| {
			author: string;
			expected: "absent";
			kind: "assert-absent";
	  }
	| {
			author: string;
			expected: "absent";
			kind: "insert";
			admittedThrough: number | null;
			settledThrough: number | null;
	  }
	| { author: string; expected: { admittedThrough: number | null; settledThrough: number | null }; kind: "delete" };
```

No assertion/insertion accepts an occupied key, no update overwrites an
occupied key and no delete accepts absent or different boundaries. An
`assert-absent` step leaves the root/count unchanged. The pure transition
verifier applies mutations in order using canonical AVL insertion/deletion and
this exact deterministic rotation selection: balance `> 1` with left-child
balance `>= 0` is one right rotation, otherwise left-right; balance `< -1`
with right-child balance `<= 0` is one left rotation, otherwise right-left.
Thus the deletion sibling-balance-zero case always uses the single rotation.
Two-child deletion always substitutes the in-order successor.
Given the prior root/count, exact verified path nodes and mutations, every
conforming implementation must derive the same successor root/count and the
same newly reachable node bytes. The successor count must equal prior count
plus inserts minus deletes and remain a safe integer.

Proof length is O(log R), where `R` is the prior retired-key count; update work
and newly written nodes are O(M log R) for `M <= 128`. With safe-integer
`subtreeSize`, an AVL path has at most 76 nodes. One maximum transition has at
most 64 insertions and 64 deletions. Conservatively, every delete may need a
76-node lookup path, a 76-node in-order-successor path and two off-path
rebalance nodes at each of 76 levels. It therefore schedules at most 24,320
node visits (`64 * 76 + 64 * (76 + 76 + 152)`) and at most 24,903,680
canonical node bytes under the 1,024-byte node ceiling; shared node bytes are
transmitted once. The 33,554,432-byte whole-witness cap leaves 8,650,752 bytes
for the closed canonical schedule/map structure above that worst-case node-byte
total.
The record does not set a room-age-dependent proof-byte threshold. Existing
epoch byte/capacity limits remain unchanged because proofs are creator/store
inputs, not vertices, checkpoint fields or application operations.
Implementations stream/iterate paths and may not materialize the complete
dictionary. The retained browser gate records measured maximum proof bytes,
update bytes and peak owned memory for the reviewed 100-transition workload;
it does not turn an observation into a new protocol ceiling.

## ACL transition law

For each authenticated current/successor ACL pair, derive sets by public key:

- retained member: copy its exact active frontier; dictionary is unchanged;
- removed member: insert its exact current
  `{admittedThrough,settledThrough}` into an absent dictionary key;
- added member with dictionary membership: delete the exact entry and restore
  those boundaries into the active successor frontier; its next authored
  sequence must be strictly above a non-null `admittedThrough`; restored null
  uses the same first-sequence-zero rule as genesis;
- added member with verified dictionary nonmembership: require an
  `assert-absent` step and begin with both boundaries null, so its first
  sequence is zero; and
- absent in both: no active or dictionary change.

No key may be active and retired in the same successor state. A key removed and
re-added by multiple operations within one staged ACL is classified only from
the authenticated current and final successor snapshots; if present in both it
is retained and cannot reset. Permission changes that leave any role/finality
key retain the active frontier. Settlement-profile rooms may remain
permissionless, but `authorizeLatchedApplicationWrite` still requires the
author to be an ACL member; every authorized writer is therefore in the active
frontier or retired dictionary lifecycle. There is no authorized non-ACL
writer and permissionless mode does not bypass identity continuity.

The creator settlement owner verifies the prior checkpoint and dictionary root,
derives this exact diff, asks the registry store for proofs, independently runs
the pure verifier, and durably installs the successor registry state before it
signs the successor settlement checkpoint. A missing/corrupt/stale path,
unknown transaction outcome or durability failure aborts the membership-
changing close before signature. An ACL-unchanged close copies the exact root
and count without opening the store.

The fixed creator signature attests the resulting current root to ordinary
openers under the already selected D.110c-0b trust model. Non-creator openers do
not need dictionary paths to authenticate the current ACL/frontiers. This does
not make a self-signed root trusted: the root/count are inside the exact creator
checkpoint, which is bound to the pinned genesis carrier, object, profile,
anchors, ACLs, close cut/QC, snapshot and history.

## Store contract and custody

Add a storage-neutral `RetiredAuthorRegistryStore` capability with opaque,
closed inputs/results. A `RegistryCheckpointBinding` is constructible only by
the settlement-checkpoint verifier and binds checkpoint digest, object,
genesis-anchor digest, settlement profile, epoch, root and root size. A
`RegistryLifecycleDecision` is constructible only by the Node adoption/rollback
owner after authenticating the AHE head/generation and contains its exact
monotone state revision, current checkpoint binding and zero to two rollback
checkpoint bindings. Root roles are keyed by checkpoint digest and epoch, not
only by root digest, because ACL-unchanged adjacent epochs may share a root.
The closed store operations are:

1. `prove({binding,authors})`: return detached canonical path nodes for sorted
   unique authors without mutating state;
2. `transactTransition({expectedRevision,current,mutations,witness})`:
   strict-durability CAS from the registered current checkpoint binding,
   validate/rederive the pure transition, write all new content-addressed
   nodes, register one candidate keyed by the prior checkpoint plus immutable
   receipt digest, and return prior/successor root/count, mutation digest and
   exact batch-witness digest;
3. `bindSignedCandidate({expectedRevision,receiptDigest,checkpoint})`: require
   the verifier-produced adjacent successor checkpoint binding to name the
   receipt's exact object/genesis/profile/epoch/root/count, then durably bind
   that checkpoint digest to the candidate without making it current;
4. `installLifecycle({expectedRevision,decision,candidateReceiptDigest})`:
   atomically replace registrations with exactly the authenticated lifecycle
   decision. Adoption promotes its matching bound candidate to current and
   demotes the former current into the supplied rollback set. Rollback promotes
   the exact retained rollback checkpoint to current and reconciles the
   abandoned current/remaining rollback registrations to the authenticated AHE
   generations. The oldest registration becomes reclaim-eligible only when it
   is absent from that verified rollback set. An ACL-unchanged adoption uses a
   null candidate receipt and the adjacent checkpoint binding with the same
   root/count;
5. `discardCandidate({expectedRevision,current,receiptDigest,roomHead})`:
   remove only an unbound candidate when an opaque authenticated room-head
   decision proves the prior checkpoint remains current and no signed/adopted
   checkpoint references the candidate; and
6. `reclaim({expectedRevision,decision,candidateReceiptDigest})`: mark from the
   exact authenticated current and rollback bindings plus any still-registered
   candidate, then atomically delete only unreachable nodes and obsolete root
   registrations. A missing/mismatched lifecycle binding or unresolved
   candidate omitted from the mark set refuses reclamation.

The in-memory reference implementation and the browser IndexedDB implementation
are conformant. The browser owner uses a dedicated derived database/schema with
strict transactions, content-addressed `nodes` and object-scoped `roots`; it is
not an untracked side table inside AHE. Opening validates schema/incarnation.
Every read rechecks canonical bytes/digest/length. Root registrations are
exactly `candidate | current | rollback`; one serialized object may have at
most one candidate, one current checkpoint binding and two rollback checkpoint
bindings. Conflicting bytes for one digest, root/count disagreement, an
unclassified registered root, partial writes, CAS mismatch or ambiguous commit
poison/fail closed until authenticated recovery reads the exact state revision,
role bindings and receipt/checkpoint digests. No caller label can promote,
revert, discard or reclaim a root.

Write-before-sign ordering is mandatory:

1. authenticate current settlement checkpoint and both ACLs;
2. derive mutations and verify prior paths;
3. strictly commit/register successor root;
4. stage/sign/publish close and successor checkpoint;
5. bind the signed candidate, then adopt and atomically install the
   authenticated lifecycle decision;
6. retain current plus two rollback registry checkpoint bindings while the
   matching authenticated AHE generations remain required; and
7. reclaim unreachable old nodes only after adoption, room-head/freshness,
   snapshot, rollback and availability gates pass.

A crash after step 3 but before signature leaves the sole inert candidate root;
retry with the same expected root/mutations/witness digest is idempotent and
may reuse it. A different transition is refused until the candidate is
authenticated and either matched to a checkpoint or discarded from the still-
current prior root. A crash after signature/binding but before adoption retains
the old current plus the bound candidate. A crash during lifecycle installation
is resolved by reading the monotone state revision and exact checkpoint-role
set: either the entire prior set or the entire requested set exists, never a
partial promotion/reversion. A genuine room rollback supplies a new
verifier-produced lifecycle decision and atomically makes the selected retained
checkpoint current before later creator close can use it. A missing current-root
node after restart is corruption/availability failure, never nonmembership.
Unknown transition, bind, adoption, rollback, discard or reclamation outcome is
resolved by authenticating the exact persisted revision, role bindings and
receipt/checkpoint digests; blind retry and caller-invented repair are
forbidden.

Reachable nodes under the current root grow O(R). They are explicitly counted
as an archive-tier control index. They are not loaded for ordinary issue,
publish, projection, current-checkpoint verification, restart or cold reopen.
They are required only for creator-authorized ACL membership change and may be
fetched from untrusted content storage because every byte is verified against
the creator-authenticated root. If unavailable, that ACL-changing close stalls;
ordinary room use under the current ACL continues. Phase 7 may mirror/page the
same content-addressed nodes but may not redefine their authentication.

## Genesis-bound profile and compatibility

Add profile ID `creator-trusted-settlement-v1`. Its canonical profile keys,
crypto suite, one signer, quorum and signer-set binding are identical to
`creator-trusted-v1`; only the profile ID differs. The genesis anchor's existing
`profileDigest` authenticates the choice. Internal trust values and the room's
successor authority widen to the exact union
`"creator-trusted-v1" | "creator-trusted-settlement-v1"`; the UI trust text
remains creator-trusted/not-BFT because authority did not change.

Under `creator-trusted-settlement-v1`:

- the implicit authenticated genesis sentinel supplies current ACL members
  with null boundaries and the empty retired root/size zero; there is no
  separate genesis settlement record;
- the first close emits the first settlement checkpoint directly;
- every later close requires exactly one settlement checkpoint;
- the v1 admitted-frontier aggregate and legacy creator retirement record are
  never emitted or accepted; and
- `$drp.author-settlement.v1` is mandatory from the first epoch in which a
  source disposition is needed.

Under `creator-trusted-v1`, all existing bytes and behavior remain unchanged;
settlement checkpoint/control kinds are rejected. There is no runtime option,
negotiation, downgrade or late opt-in. Existing v1 rooms cannot migrate here
because their removed-author history is not authenticated by a keyed index.
A future migration would need a separately reviewed full-history/archive proof
that reconstructs the registry without omission; Phase 7 may own that work.

The invite envelope, signer set, public key, anchor schema, CutValue, QC and
vertex envelope are unchanged. The new profile identifier is nevertheless a
public compatibility addition: old binaries reject it, and room creators must
choose it when producing the genesis profile bytes. This checkpoint does not
silently make it the default for existing callers.

This is a prospective profile-inventory amendment. Earlier Phase-3 acceptance
that supported exactly the then-existing three profiles remains immutable
historical evidence; after this slice GREEN, the supported inventory adds this
fourth creator-only sibling for newly created settlement rooms. It does not
reinterpret a prior profile, reopen its tests or claim old binaries support the
new ID.

The fixed-literal owner roster is closed explicitly. Protocol-v3 `index.ts`,
`creator-close.ts`, `creator-checkpoint.ts`, registry JSON/schema and generated
conformance reference widen only where parsing/encoding the sibling profile is
required. Node `v3-live.ts` and `creator-close.ts`, and v3-room's trust/open
checks, remain fail-closed on the new profile until the f5b integration installs
its mandatory settlement behavior. v3-chat and grid creation continue emitting
`creator-trusted-v1` by default; f5b0c must make any new-profile selection
explicit rather than silently changing those golden paths. Protocol-v2,
protocol-v2 registries/vectors, storage-browser historical test assets and all
old-profile golden vectors remain unchanged. f5b0a RED enumerates this roster
from a repository-wide fixed-string search and pins each widen-or-reject result.

## Settlement checkpoint amendment

Replace the previously proposed checkpoint's migration fields with this exact
shape (signature appended after signing):

```ts
{
	closedAnchorDigest,
	closedEpoch,
	commitQcRef: { byteLength, digest },
	currentAclDigest,
	cutValueDigest,
	frontiers: readonly [author, admittedThrough, settledThrough][],
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

`retiredAuthorRegistryRoot` is the exact empty or node digest;
`retiredAuthorRegistrySize` is a safe nonnegative integer. The current active
frontier has exactly the successor ACL's sorted unique members, at most 64.
The profile must be `creator-trusted-settlement-v1`. Genesis is the sole
sentinel predecessor; every non-genesis predecessor is one adjacent settlement
checkpoint under the same profile/object/genesis. There is no
`admitted-v1` predecessor, v1 migration branch or legacy-retirement bridge.
When `priorCheckpointKind === "genesis"`, `priorCheckpointDigest` is the named
`CREATOR_AUTHOR_SETTLEMENT_GENESIS_SENTINEL`, exactly
`hex(hashDomain("ts-drp/creator-author-settlement-genesis/v1",
encodeCanonical({genesisAnchorDigest, kind:
"drp-creator-author-settlement-genesis", objectId, profileId:
"creator-trusted-settlement-v1", protocolMajor: 3, version: 1})))`. f5b0a is
the sole owner of this signed checkpoint codec, signature/domain, predecessor
rule, root/count fields and byte/count ceiling.
The maximum-shaped signed checkpoint with 64 full frontier entries, a 256-code-
unit object ID, maximum safe integers, full digests and a 64-byte creator
signature encodes to 7,064 bytes with the workspace canonical implementation,
leaving 1,128 bytes under the unchanged 8,192-byte ceiling. Codec RED must pin
that exact measurement and adjacent over-limit/count rejection; the ceiling is
not raised.

## Failure and adversarial matrix

| Case                                                         | Required result                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| globally fresh key                                           | verified nonmembership; null boundaries; first sequence zero                                |
| removed key re-added, non-null boundary                      | membership restores exact boundaries; next sequence strictly greater than admitted boundary |
| removed never-authored key re-added, null boundary           | membership restores null/null; first sequence zero                                          |
| key retained across ACL roles                                | active boundary copied; no dictionary mutation                                              |
| remove then re-add within one staged ACL                     | retained by current/final membership; no reset                                              |
| active key also found in retired root                        | checkpoint/transition invalid                                                               |
| insertion finds occupied key                                 | fail closed; no checkpoint signature                                                        |
| deletion finds absent/different boundaries                   | fail closed; no checkpoint signature                                                        |
| stale, substituted, truncated, reordered or foreign proof    | fail closed before store mutation/signature                                                 |
| noncanonical node or wrong digest/length/height/size/balance | fail closed and classify store corruption                                                   |
| store unavailable                                            | membership-changing close unavailable; no fallback-to-fresh                                 |
| crash before registry commit                                 | old root remains current; retry from durable truth                                          |
| crash after registry commit before checkpoint signature      | inert candidate root; idempotent exact retry or later GC                                    |
| crash after signature before adoption                        | both roots retained; old checkpoint authoritative                                           |
| adoption succeeds before reclamation                         | new root authoritative; rollback roots still retained                                       |
| room rolls back to retained checkpoint                       | authenticated lifecycle CAS promotes that binding to current and reconciles rollback roles  |
| crash/unknown outcome during adoption or rollback            | read exact revision/roles; whole old or whole new set; no blind retry                       |
| discard bound/referenced candidate                           | refuse; no registration or node deletion                                                    |
| premature/misbound reclamation                               | CAS/reachability refusal; no live-node deletion                                             |
| old profile receives new carrier                             | unsupported/mixed-profile rejection                                                         |
| new profile omits settlement/registry carrier                | fail closed                                                                                 |
| legacy room attempts late opt-in                             | explicit unsupported migration failure                                                      |
| untrusted current checkpoint nominates its own key/root      | rejected by pinned-genesis creator-trust opener                                             |
| valid but stale checkpoint/root                              | rejected by the existing external room-head freshness floor                                 |

## Bounds and golden-path accounting

- Active settlement checkpoint: O(64) frontier entries plus one root/count;
  independent of epoch, rebase count and retired-author count.
- Ordinary hot issue/publish and cold reopen: no dictionary traversal; fixed
  checkpoint plus existing current/two-rollback closure law.
- Membership-changing close: O(M log R) verified reads/writes for `M <= 128`;
  no O(epoch) or O(history) replay.
- Reachable registry backing: O(R) entries/bytes for currently retired distinct
  keys, plus copy-on-write nodes reachable from at most two rollback roots and
  at most one serialized candidate root.
  This is separately reported in the durable census by entry count, node count
  and bytes. It is never counted as application archive or hidden bootstrap.
- Re-adding a retired key deletes its live registry entry; removing it later
  inserts the newer boundary. Repeated churn of a fixed author set therefore
  keeps current-root logical entries bounded by that set, while obsolete path
  nodes are reclaimable after rollback gates.
- The ≥100 same-room transition test includes remove/re-add, fresh additions,
  permissionless-member continuity, restarts before/after registry commit and
  adoption, genuine room rollback/reversion, selected prune boundaries, exact
  root/count recomputation, current/rollback reachability census and a fresh-
  process post-GC memory gate. It does not claim O(1) archival registry bytes
  under unbounded distinct-key churn.

## TDD slices and gates

After the combined design confirmation is empty at P0/P1:

1. **f5b0p-a protocol dictionary/profile RED→GREEN.** Tests-only RED exercises
   empty/member/nonmember proofs, exact single/double/zero-balance deletion
   rotation vectors, lookup/successor/rebalance schedules, batch updates,
   stale/substituted/surplus proofs, root/count/metadata corruption, the exact
   24,320-visit/24,903,680-node-byte/33,554,432-witness caps, maximum 128-key
   transition and low-level profile parsing/rejection. The signed settlement
   checkpoint and its 64-frontier measurement are excluded and owned wholly by
   f5b0a. GREEN is confined to pure dictionary codecs/verifiers/profile
   unions/exports, and all product close/adopt/open paths must continue to reject
   the new profile until f5b installs the mandatory settlement carrier.
2. **f5b0p-b store RED→GREEN.** Tests-only RED freezes in-memory and browser
   conformance, strict write-before-sign receipt semantics, idempotence,
   ambiguous outcomes for every state transition, bound-candidate adoption,
   current-to-rollback rotation, genuine room-rollback reversion, oldest-
   rollback eligibility, safe candidate discard, corruption poison, candidate/
   current/two-rollback reachability GC and unavailable-node refusal. GREEN adds
   only the neutral store, memory implementation, dedicated IndexedDB schema and
   store construction/disposal plumbing. It adds no room policy, issue path,
   rebase-outbox behavior or creator-close integration.
3. **f5b0a-d and f5b.** Resume the already frozen settlement carrier, Node,
   room and pruning slices, amended so new-profile genesis has no v1 migration
   or legacy retirement. Creator integration uses the genuine ACL diff and
   registry store before signing. f5b also owns the profile branch at both the
   retirement requirement and aggregate requirement in
   `creator-transition-advance.ts`, preserving both old-profile paths byte-for-
   byte. Each retains its causal RED and focused,
   static, retained and isolated GREEN gates.

The combined functional RED must fail through the real product path: create a
`creator-trusted-settlement-v1` room, remove an author after admitted/settled
activity, close/adopt/restart, re-add the same key and attempt sequence zero.
It must also show a truly fresh key starts at zero. Fixture-injected registry
roots or tests-only appearance facts cannot satisfy causality.

GREEN/retained acceptance includes exact same-key continuation, fresh-key zero,
mixed ACL role retention, 64-member/128-mutation bounds, store-death crash
matrix, two rollback roots, unavailable registry refusal, ordinary reopen with
the registry store absent, no v1 behavior change, old-binary profile rejection,
current checkpoint byte ceiling, ≥100 real same-room epochs, bounded active
checkpoint/owner census, explicit O(R) registry census, and Phase-7 cold join
using current authenticated checkpoint plus archived application history.

No production edit, RED, long campaign or multi-epoch run is authorized by this
document. The amended design and plan are signed/pushed first; one material
Grok 4.6/high, direct Kimi K3 with
`KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh confirmation reviews the
complete f5b0p/f5b0 design. Only an empty P0/P1 union authorizes RED. P2 is
owned/dispositioned without recursive prose review. No Fable or collaboration
subagent may be invoked without new express user authorization.
