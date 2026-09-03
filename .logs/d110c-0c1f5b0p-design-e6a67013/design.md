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
with two children additionally opens the deterministic in-order-successor path;
missing or surplus scheduled nodes fail. Shared nodes appear once in the node
set and may be referenced repeatedly by digest.

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
		successorPath: readonly string[];
	}[];
	version: 1;
};
```

`nodes` are strictly digest-sorted and unique. Every path item names one entry
in that map or one node computed by an earlier step. `steps` correspond one-to-
one with mutations in the same order. `successorPath` is empty except for a
two-child delete. The witness digest is
`hashDomain("ts-drp/retired-author-registry-batch-witness/v1", bytes)` and the
mutation digest uses
`ts-drp/retired-author-registry-mutations/v1`. Witness canonical bytes are
capped at 20,971,520; node count, path count and node-byte limits are checked
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
deterministic single/double rotations.
Given the prior root/count, exact verified path nodes and mutations, every
conforming implementation must derive the same successor root/count and the
same newly reachable node bytes. The successor count must equal prior count
plus inserts minus deletes and remain a safe integer.

Proof length is O(log R), where `R` is the prior retired-key count; update work
and newly written nodes are O(M log R) for `M <= 128`. With safe-integer
`subtreeSize`, an AVL path has at most 76 nodes. One maximum transition has at
most 64 insertions and 64 deletions; a two-child deletion may need two paths.
It therefore schedules at most 14,592 node visits and at most 14,942,208
canonical node bytes under the 1,024-byte node ceiling; shared node bytes are
transmitted once.
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
  sequence must be strictly above `admittedThrough`;
- added member with verified dictionary nonmembership: require an
  `assert-absent` step and begin with both boundaries null, so its first
  sequence is zero; and
- absent in both: no active or dictionary change.

No key may be active and retired in the same successor state. A key removed and
re-added by multiple operations within one staged ACL is classified only from
the authenticated current and final successor snapshots; if present in both it
is retained and cannot reset. Permission changes that leave any role/finality
key retain the active frontier. Permissionless writer behavior does not bypass
identity continuity.

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
closed inputs/results for:

1. `prove({objectId,root,rootSize,authors})`: return detached canonical path
   nodes for sorted unique authors without mutating state;
2. `transactTransition({objectId,expectedRoot,expectedRootSize,retainRoots,mutations})`:
   strict-durability CAS from one registered current root, validate/rederive the
   pure transition, write all new content-addressed nodes, register the new
   root/count, and return an immutable receipt containing prior/successor
   root/count, mutation digest and exact batch-witness digest; and
3. `reclaim({objectId,currentRoot,rollbackRoots})`: mark from exactly the
   authenticated current root plus at most two authenticated rollback roots and
   delete other nodes/root registrations atomically.

The in-memory reference implementation and the browser IndexedDB implementation
are conformant. The browser owner uses a dedicated derived database/schema with
strict transactions, content-addressed `nodes` and object-scoped `roots`; it is
not an untracked side table inside AHE. Opening validates schema/incarnation.
Every read rechecks canonical bytes/digest/length. Root registrations are
exactly `candidate | current | rollback`; one serialized object may have at
most one candidate, one current and two rollback roots. Conflicting bytes for
one digest, root/count disagreement, an unclassified registered root, partial
writes, CAS mismatch or ambiguous commit poison/fail closed until authenticated
recovery determines whether the exact transition committed.

Write-before-sign ordering is mandatory:

1. authenticate current settlement checkpoint and both ACLs;
2. derive mutations and verify prior paths;
3. strictly commit/register successor root;
4. stage/sign/publish close and successor checkpoint;
5. adopt and install the authenticated successor;
6. retain current plus two rollback registry roots while matching rollback
   generations remain required; and
7. reclaim unreachable old nodes only after adoption, room-head/freshness,
   snapshot, rollback and availability gates pass.

A crash after step 3 but before signature leaves the sole inert candidate root;
retry with the same expected root/mutations/witness digest is idempotent and
may reuse it. A different transition is refused until the candidate is
authenticated and either matched to a checkpoint or discarded from the still-
current prior root. A crash
after signature but before adoption retains both roots. A missing current-root
node after restart is corruption/availability failure, never nonmembership.
Unknown write outcome is resolved by authenticating the registered exact
successor root/count/mutation/witness digest; blind retry is forbidden.

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
| removed key re-added                                         | membership restores exact boundaries; next sequence strictly greater than admitted boundary |
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
  restarts before/after registry commit and adoption, selected prune boundaries,
  exact root/count recomputation, current/rollback reachability census and a
  fresh-process post-GC memory gate. It does not claim O(1) archival registry
  bytes under unbounded distinct-key churn.

## TDD slices and gates

After the combined design confirmation is empty at P0/P1:

1. **f5b0p-a protocol dictionary/profile RED→GREEN.** Tests-only RED exercises
   empty/member/nonmember proofs, deterministic AVL rotations, batch updates,
   stale/substituted proofs, root/count/metadata corruption, maximum 128-key
   transition, profile acceptance/rejection and the measured 64-frontier
   checkpoint ceiling. GREEN is confined to pure codecs/verifiers/profile
   unions/exports and adds no storage or room behavior.
2. **f5b0p-b store RED→GREEN.** Tests-only RED freezes in-memory and browser
   conformance, strict write-before-sign receipt semantics, idempotence,
   ambiguous commit recovery, corruption poison, current/two-rollback
   reachability GC and unavailable-node refusal. GREEN adds the neutral store,
   memory implementation, dedicated IndexedDB implementation/schema and
   internal room construction plumbing; it does not integrate creator close.
3. **f5b0a-d and f5b.** Resume the already frozen settlement carrier, Node,
   room and pruning slices, amended so new-profile genesis has no v1 migration
   or legacy retirement. Creator integration uses the genuine ACL diff and
   registry store before signing. Each retains its causal RED and focused,
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
