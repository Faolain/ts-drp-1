# Attested Hard Epochs v4

## Browser-first compaction, checkpointing, and archive profile for ts-drp

**Status:** production target specification; protocol-major migration required  
**Reference implementation:** `implementation/src/` in the review bundle  
**Reviewed repository baseline:** `Faolain/ts-drp-1` commit `bf7d3516f6ed4be97a755698b4fb3a404e04dc0f`  
**Date:** 24 July 2026

This document specifies a replacement for arbitrary in-place hashgraph contraction. It preserves the good parts of the Attested Epoch Cuts proposal—attested stability, deterministic state forwarding, explicit evidence, and crash-safe adoption—while removing its lifetime exact covered-hash database and its dependence on origin-sensitive replay of a retained same-epoch tail.

Normative words such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used in their ordinary protocol-specification sense.

---

## 1. Goals and non-goals

### 1.1 Goals

The profile is designed to provide all of the following at the same time:

1. **Bounded replay.** A joiner can begin from a certified state snapshot rather than replaying the room’s entire operational history.
2. **Bounded compact-peer metadata.** A compact browser peer does not retain one hash or one tombstone per historical vertex.
3. **Deterministic convergence.** Given the same certified anchor and the same committed close set, every conforming implementation computes the same next state, authority state, history commitment, and next anchor.
4. **Objective stale-history handling.** A message from an already closed epoch is recognizable from its authenticated envelope. No timeout, probabilistic filter, or replica-local memory determines semantic validity.
5. **Untrusted transport and storage.** Snapshot chunks, archive segments, mirrors, and relays can be malicious; correctness follows from content commitments and signatures.
6. **Browser-first execution.** Expensive close work can run in a Worker, state is staged in IndexedDB, and the main thread remains responsive.
7. **Application-aware history.** Games can keep only current state; chat applications can retain historical messages in demand-loaded authenticated segments without forcing every joiner to download them.
8. **Auditable continuity.** Existing peers can verify that history commitments are append-only. Fresh peers can verify a current authority certificate and snapshot without full history replay.

### 1.2 Non-goals

This profile does not create permanent data availability from signatures alone. If every holder deletes a snapshot or archive segment, its content is unavailable even though its digest remains valid.

It also does not cryptographically prove that a received checkpoint is the globally latest checkpoint. In a serverless asynchronous network, freshness is weakly subjective: a peer must compare independent sources or use an invite/rendezvous record that pins a recent checkpoint.

The profile does not make semantically retained application state disappear. If a chat product wants every message available forever, those bytes must exist somewhere. The protocol makes that history segmented, authenticated, demand-loaded, and separable from the hot room state; it cannot compress arbitrary information below its information content.

---

## 2. Threat model and operating profiles

### 2.1 Network and storage adversary

The network may delay, duplicate, reorder, replay, or drop any message. Relays and mirrors may fabricate bytes, omit bytes, equivocate, or disappear. Peers may crash between any two durable writes. Multiple tabs for the same origin may race.

Correctness MUST NOT depend on wall-clock arrival deadlines. A local timeout MAY trigger retransmission, peer switching, round advancement, cache eviction, or quarantine, but MUST NOT convert an otherwise potentially valid current-epoch vertex into permanent semantic invalidity.

### 2.2 Identity and signature assumptions

Every ordinary vertex is signed by its author’s object identity key. Every seal vote is signed by the signer identity named in the epoch anchor. Signature verification is performed over a domain-separated canonical preimage.

The first production profile SHOULD use the repository’s already deployed identity signature primitive and carry individual signatures in a QC. Browser rooms normally have a small signer set, so the extra bytes are preferable to adding a BLS/WASM dependency and proof-of-possession surface. Aggregate signatures MAY be added later under a separately negotiated cryptographic suite.

### 2.3 Attested mode

Attested mode assumes a signer set of `n >= 4` and strictly fewer than `n/3` Byzantine signers. The quorum is:

```text
q(n) = ceil(2n / 3)
```

At least `q(n)` signers must be responsive for a cut to finalize. Room operations can continue while compaction is stalled; the active epoch simply grows until a configured hard safety limit forces the UI to request signer availability or switch policy.

### 2.4 Creator-trusted mode

Small rooms MAY use a one-authority or threshold-trusted mode. The wire objects and snapshot checks remain the same, but a single creator or delegated authority signs the cut. This mode is not Byzantine-fault-tolerant. The UI MUST display the trust profile.

### 2.5 Archive and mirror roles

An **archive** retains historical vertices, close manifests, snapshot payloads, or chat segments. A **mirror** is an availability replica that need not participate in consensus. Neither role is trusted for correctness. A peer verifies all received bytes against a certified digest.

---

## 3. Core terms

- **Object:** one DRP room/game instance identified by `objectId`.
- **Blueprint:** deterministic application and ACL reducers plus schema and archive policies.
- **Epoch:** an interval in which all ordinary vertices share one authenticated anchor and one latched authority state.
- **Epoch anchor:** a synthetic root that commits to the starting application state, ACL state, signer set, protocol parameters, history root, and previous cut.
- **Active graph:** the anchor plus ordinary vertices admitted for the current epoch.
- **Close frontier:** one or more active vertices proposed as the maximal vertices of the committed close set.
- **Close set:** the dependency closure of the proposed frontier down to, but excluding, the epoch anchor.
- **Cut descriptor:** the canonical value whose digest is voted on and whose commit QC finalizes the transition.
- **Snapshot:** the canonical application and ACL state produced by folding the close set over the epoch anchor state.
- **History commitment:** an append-only Merkle tree over committed vertex hashes in deterministic epoch order.
- **Archive segment:** an immutable application-level block of old records, such as chat messages, stored outside hot state and addressed by digest.
- **Authority handoff:** a certificate by the old authority set that installs a changed signer/ACL trust root.

---

## 4. Canonical value and hash profile

### 4.1 Production encoding

Production implementations MUST use one frozen deterministic encoding profile. Deterministically encoded CBOR is recommended, with additional restrictions defined by this protocol:

- shortest integer and length encodings;
- deterministic map-key ordering;
- no indefinite-length values;
- no duplicate map keys under canonical byte comparison;
- no unpaired Unicode surrogates;
- no `undefined`, functions, symbols, accessors, prototypes with executable behavior, or cyclic values;
- finite numbers only; `-0` is normalized to `0`; NaN is forbidden;
- typed arrays have an explicit type tag and fixed little-endian byte representation;
- schema-specific values such as dates are encoded as ordinary, versioned records rather than host objects.

A decoder MUST reject non-canonical encodings rather than normalize them silently. The reference implementation contains a small executable codec to validate these rules; it is specification material, not a recommendation to invent another general-purpose wire format.

### 4.2 Domain-separated hash function

Let `ENC(x)` be the canonical bytes and `H` be SHA-256 in the initial suite. Every digest is computed as:

```text
HASH(domain, parts...) = H(
  UTF8(domain) ||
  U32BE(len(part_0)) || part_0 ||
  ... ||
  U32BE(len(part_k)) || part_k
)
```

Domains MUST be fixed ASCII strings containing the protocol major version. A digest from one object type MUST NOT be accepted in another context.

### 4.3 Vertex preimage

An ordinary vertex commits to at least:

```text
{
  kind: "drp-vertex",
  protocolMajor,
  objectId,
  epoch,
  anchor,
  author,
  logicalTime,
  dependencies[],
  operation
}
```

The dependency array is sorted lexicographically before encoding. Duplicate dependencies are forbidden. The vertex hash is:

```text
HASH("ts-drp/vertex/v2", ENC(vertexPreimage))
```

The signature MUST cover either this digest or the same full preimage under a signature-specific domain. The current repository’s legacy hash omits `objectId`; this profile deliberately makes object identity, protocol version, epoch, and anchor part of the authenticated identity.

### 4.4 Stable application identifiers

Application payloads SHOULD carry stable client operation IDs and stable entity IDs. Cross-epoch semantic references, such as “edit message 42,” MUST use payload IDs, not graph dependencies to an old vertex. Graph dependencies express causal scheduling only within the current epoch.

---

## 5. Epoch anchor

An epoch anchor is not an ordinary application vertex and cannot be authored through the normal operation path. Its preimage includes:

```text
{
  kind: "drp-epoch-anchor",
  protocolMajor,
  objectId,
  epoch,
  previousAnchor,
  cutDigest,
  stateDigest,
  aclDigest,
  historyRoot,
  historySize,
  archiveIndexRoot,
  signerSetDigest,
  parametersDigest,
  blueprintDigest
}
```

The genesis anchor has `previousAnchor = ZERO`, `cutDigest = ZERO`, and a creator/initial-authority certificate. Every later anchor is deterministically derived from a committed cut descriptor. A peer MUST recompute the anchor hash; a network-supplied synthetic vertex is insufficient.

The anchor fixes the following for the whole epoch:

- application snapshot schema and blueprint digest;
- ACL state used to authorize ordinary vertices in this epoch;
- seal signer set;
- protocol resource limits;
- history and archive roots at epoch start.

---

## 6. Admission state machine

Admission returns one of four semantic classes:

1. **accept** — valid and dependency-complete for the current epoch;
2. **pending** — potentially valid but missing authenticated current-epoch dependencies or a not-yet-known future anchor;
3. **terminal** — objectively cannot become valid for the current object state;
4. **quarantine** — locally rate-limited or suspicious, but not semantically adjudicated.

### 6.1 Objective terminal conditions

A vertex is terminal when any of the following holds:

- malformed canonical encoding, hash, or author signature;
- wrong `protocolMajor` for the object namespace;
- wrong `objectId`;
- `epoch < currentEpoch`;
- `epoch == currentEpoch` but `anchor != currentAnchor`;
- a supplied dependency is authenticated as belonging to another object, epoch, or anchor;
- dependency list is empty, duplicated, too large, or not a direct antichain;
- logical time violates the deterministic dependency rule;
- operation schema is invalid;
- author is unauthorized under the ACL latched in the current anchor;
- applying the operation would violate a deterministic blueprint invariant.

### 6.2 Pending conditions

A current-epoch vertex with an otherwise valid envelope remains pending when one or more dependency hashes are unknown. Arrival time never changes that classification. When dependencies arrive, the peer retries to a fixed point.

A future-epoch vertex MAY be held in a small future-anchor quarantine while the peer requests its cut certificate. It is not accepted until the corresponding anchor is verified.

### 6.3 Bounded pending is non-semantic

The implementation MUST bound pending memory by count, bytes, dependency fan-out, and per-peer contribution. Eviction means only “not retained locally.” A later retransmission is classified from scratch. Eviction MUST NOT create a permanent rejection tombstone.

### 6.4 Dependency antichain

For every pair of direct dependencies `a` and `b`, neither may be an ancestor of the other. This removes redundant causal edges, bounds conflict checks, and prevents origin-sensitive behavior exposed by the legacy DFS implementation.

### 6.5 Logical time

The profile MAY retain a Lamport/logical time for fast checks and UI ordering. It is not a wall clock. A conforming rule is:

```text
logicalTime(vertex) = 1 + max(logicalTime(dep))
```

The anchor has logical time zero.

---

## 7. Deterministic graph order and conflict semantics

### 7.1 Canonical topological order

All state forwarding and history commitment use Kahn’s algorithm:

1. compute in-degree inside the exact close set plus anchor;
2. place all zero-in-degree vertices in a priority queue ordered by vertex hash;
3. repeatedly remove the minimum hash and decrement its children;
4. reject if the output length differs from the input size.

The anchor MUST be first and is not emitted as an application operation. No `Map` insertion order, arrival order, DFS origin, mutable adjacency-array order, or wall clock may influence the result.

### 7.2 Conflict resolver contract

A blueprint may use either operation-based CRDT semantics or an explicit pair resolver. A pair resolver receives two concurrent vertices and their authenticated context and returns one of a frozen set of actions, such as keep-both, drop-left, drop-right, or swap.

The engine MUST:

- invoke the resolver only for concurrent vertices;
- validate the returned action;
- impose a deterministic pair iteration order;
- detect non-convergent swap cycles;
- fail the close rather than guess if the resolver is malformed or throws;
- stage all state changes before adopting them.

### 7.3 Blueprint determinism

Reducers MUST be synchronous and deterministic. They MUST NOT read the network, current time, randomness, DOM state, local locale, mutable module globals, or replica identity unless that value is explicitly in the authenticated operation/context. A Promise returned by a reducer is a protocol error.

---

## 8. Hard close semantics

### 8.1 Proposal

A close proposal identifies the exact transition by including at least:

- object, protocol, epoch, and round;
- previous anchor and cut digest;
- close frontier;
- close-set root and count;
- previous and next history root/size;
- state, ACL, snapshot-manifest, archive-index, blueprint, signer-set, and parameter digests;
- close reason;
- optional availability receipts.

The proposal MAY refer to a content-addressed **close manifest** containing the sorted frontier, deterministic close-set order, and vertex byte lengths. Every signer must fetch and validate enough data to recompute every committed digest before voting.

### 8.2 Close set

The close set is the dependency closure of the frontier within the current epoch, excluding the anchor. It MUST be complete, acyclic, dependency-closed, and within configured vertex and byte limits.

Unlike the reviewed arbitrary-cut design, no current-epoch tail is retained across the transition. Once epoch `e+1` is committed, every epoch `e` vertex not in the close set is stale by envelope. A client that still wants the operation must rebase and re-sign it for the next anchor.

### 8.3 Rebase behavior

The SDK SHOULD keep a local outbox containing the original user intent and stable `clientOperationId`. When a cut excludes an unconfirmed operation, the SDK asks the blueprint to produce a next-epoch operation or marks it as requiring user review.

A replica MUST NOT rewrite and sign another author’s old operation. That is the signature ambiguity identified in the Topology research. Only the original client/author, or a separately authorized application mechanism, may mint the replacement.

Blueprints SHOULD make rebased operations idempotent by stable operation ID. Examples:

- chat send: same message ID, accepted once;
- counter increment: same operation ID tracked in state or transformed to an idempotent delta record;
- game input: usually expires rather than rebases;
- ACL mutation: triggers an early close and is revalidated against the new anchor.

### 8.4 Close barriers and UX

Safety does not require a quiet network, but user experience improves when the proposer first announces a short close barrier, gathers signer frontiers, reconciles missing vertices, and only then proposes. New local writes during the barrier go to a next-epoch outbox rather than the closing graph.

A barrier is an optimization, not a validity oracle. Delayed operations may still be excluded and rebased.

---

## 9. State and ACL fold

### 9.1 Latched authority

Authorization for every ordinary vertex in epoch `e` is evaluated against `ACL_e`, the ACL snapshot in anchor `A_e`. ACL operations inside the epoch are applied to a staged next ACL but do not retroactively change current-epoch authorization.

This makes authorization independent of arrival order and eliminates the need for a joiner to replay a lifetime ACL history. Moderation changes SHOULD trigger an immediate or short-latency close so they become effective in the next epoch quickly.

### 9.2 Fold procedure

For a candidate close set:

1. clone the certified application and ACL snapshots into isolated staging instances;
2. compute canonical Kahn order;
3. validate every vertex and its signature/envelope;
4. authorize it against the latched epoch ACL;
5. apply deterministic conflict semantics;
6. execute application, ACL, and system operations in canonical order;
7. export canonical application and ACL snapshots;
8. compute state and ACL digests;
9. construct archive updates and history commitments;
10. compare all results with the proposal;
11. expose an `adopt()` transition only after a commit QC and durable storage stage exist.

A failure leaves the live state untouched.

### 9.3 State replacement

Snapshot import is replacement, not shallow merge. Keys absent from the snapshot must be removed. Replica-local fields such as network context, callbacks, caches, and identity handles are explicitly excluded from snapshot serialization and reattached after decode.

---

## 10. Snapshot format and transfer

### 10.1 Snapshot payload

The canonical snapshot payload includes:

```text
{
  kind: "drp-snapshot-payload",
  protocolMajor,
  objectId,
  epoch,
  anchor,
  schemaVersion,
  blueprintDigest,
  application,
  acl,
  archiveIndexRoot
}
```

The state digest is over the fully domain-separated payload or over separately committed application/ACL bytes as frozen by the protocol profile. Implementations must not mix conventions.

### 10.2 Chunking

The default snapshot chunk size is 128 KiB. Each chunk digest commits to its index and bytes. The manifest commits to:

- object, epoch, anchor, schema, state, and ACL digests;
- payload digest and total byte length;
- ordered chunk digest and byte-length list.

A receiver validates configured maxima before allocation, stores chunks by digest, verifies every chunk, verifies the payload digest, decodes canonically, and verifies all embedded metadata before adoption.

### 10.3 Streaming and memory

Browsers SHOULD stream chunks directly to IndexedDB and decode in a Worker. The API MUST support resume by missing chunk digest. Fetch concurrency SHOULD be bounded, typically four to eight requests, to avoid memory and radio contention.

The initial profile SHOULD hash uncompressed canonical bytes. Transport compression MAY be negotiated as a non-consensus wrapper; the receiver decompresses and verifies the canonical chunk digest. Compression implementation/version must not alter the state digest.

### 10.4 Snapshot size limit

A room parameter sets `maxSnapshotBytes`. A signer MUST refuse a proposal beyond the limit. This is a resource bound, not a magical compaction result. A blueprint whose semantic state grows without bound must use archive segmentation, retention, or application-specific summaries.

---

## 11. Chat and long-lived archive segmentation

### 11.1 Why a snapshot alone is insufficient

For a game, thousands of input operations may collapse into a small current world state. For chat, the messages themselves are user-visible state. Serializing every message into one snapshot still requires a new joiner to download the full archive. Therefore a Discord-like application needs two state tiers.

### 11.2 Hot room state

The hot snapshot SHOULD contain:

- room metadata, membership, roles, bans, configuration;
- recent message window and current threads;
- message/edit/tombstone metadata needed for active interactions;
- archive index root and recent segment descriptors;
- attachment roots and retention policy;
- stable operation-ID deduplication window.

### 11.3 Immutable archive segments

At a close, old finalized records can be packed into canonical immutable segments. A segment descriptor commits to object, epoch, ordinal range, record count, schema, payload digest, total bytes, and ordered content-addressed chunks.

Segment descriptors are leaves in a Merkle archive index. A compact peer keeps only the current index root and recent descriptors. A mirror can answer “give me segment covering ordinal/time range” with the descriptor, payload chunks, and an inclusion proof. The peer verifies the proof and content before displaying it.

### 11.4 Edits, deletes, and moderation

Application references to archived messages use stable message IDs. Later edits/deletes are new operations. The blueprint may choose:

- a hot overlay of edits/tombstones committed in later snapshots;
- periodic re-segmentation that creates new segment digests and advances the archive root;
- append-only moderation records for audit-oriented rooms.

Physical deletion from untrusted mirrors cannot be guaranteed. Privacy-sensitive rooms SHOULD encrypt segments and attachments with per-segment keys so a certified key-erasure operation can make retained ciphertext unreadable to conforming clients, while acknowledging that recipients may already have plaintext.

### 11.5 Join policy

A normal cold join fetches:

1. latest verified authority/cut certificate;
2. latest hot snapshot chunks;
3. active epoch tail;
4. only the configured recent archive window.

Older history is fetched on demand. Search indexes are local caches or separately authenticated mirror products; they are not consensus state unless the blueprint explicitly commits them.

---

## 12. Append-only history commitment

### 12.1 Leaf order

At each close, committed vertex hashes are appended in canonical Kahn order. The history leaf input is domain-separated and includes at least object ID, epoch, ordinal, and vertex hash.

### 12.2 Tree construction

The profile uses the RFC 9162 binary Merkle tree shape with distinct leaf and node prefixes. A compact peer stores the tree size and O(log N) compact-range peaks. An archive stores leaves and internal nodes needed to produce inclusion and consistency proofs.

### 12.3 Purpose and limitation

The history tree is an audit commitment. It proves that a supplied historical vertex was committed and that a later tree extends an earlier one. It is not an admission oracle for an unknown dependency: absence cannot be proven from an ordinary Merkle root without a separate authenticated dictionary.

This distinction is why Bloom, cuckoo, or XOR filters cannot replace the reviewed proposal’s exact covered-hash set. A false positive would permanently drop a valid child on one replica while another replica later accepts it. Hard epoch envelopes remove the need to ask historical set membership during admission.

### 12.4 Existing-peer continuity

A peer that knows `(oldSize, oldRoot)` requests a consistency proof to `(newSize, newRoot)` before accepting a later cut. The proof is logarithmic. A fresh peer with no prior root verifies the latest cut QC against its pinned authority trust chain; it cannot independently infer freshness from the root alone.

---

## 13. Cut descriptor and next anchor

A cut descriptor commits to:

```text
{
  kind: "drp-hard-epoch-cut",
  protocolMajor,
  encodingVersion,
  objectId,
  epoch,
  round,
  previousAnchor,
  previousCutDigest,
  previousHistoryRoot,
  previousHistorySize,
  closeSetRoot,
  closeSetCount,
  historyRoot,
  historySize,
  stateDigest,
  aclDigest,
  snapshotManifestDigest,
  archiveIndexRoot,
  blueprintDigest,
  nextSignerSet,
  parameters,
  closeReason,
  availabilityPolicyDigest
}
```

`historySize` must equal `previousHistorySize + closeSetCount`. The next anchor is a deterministic hash of the descriptor’s committed outputs. No signer votes on a descriptor whose referenced snapshot, close manifest, blueprint version, history extension, ACL transition, or parameter set it has not fully verified.

---

## 14. Seal protocol safety core

### 14.1 Sidecar protocol

Seal votes and QCs are control-plane records, not ordinary application DAG vertices. They may be gossiped over the same transport but live in a separate namespace and store. This avoids recursive questions about whether the very evidence finalizing a cut is itself inside the cut.

### 14.2 Vote fields

A vote commits to:

```text
{
  kind: "drp-seal-vote",
  objectId,
  epoch,
  round,
  phase: "prepare" | "commit" | "round-change",
  proposalDigest,
  proposalHash,
  signerId,
  highestPrepareQC
}
```

The exact proposal bytes or a proposal hash are value-bound. A QC made from votes over different proposal digests/hashes is invalid.

### 14.3 Durable one-vote slots

Before gossip, a signer atomically inserts the exact signed vote into a durable slot keyed by `(objectId, epoch, round, phase, signerId)`. If the slot exists, the signer returns the exact existing bytes or rejects a conflict. Multi-tab coordination mechanisms are advisory; this IndexedDB uniqueness/CAS rule is the correctness boundary.

### 14.4 Rounds and locks

Each signer durably tracks:

- `enteredRound`, monotonically increasing;
- `lockedDigest` and `lockedRound` after emitting a commit vote for a verified prepare QC;
- highest verified prepare QC/valid value;
- finalized commit QC, if any.

A signer MUST NOT emit a vote for `round < enteredRound`, even when an old QC arrives late. This blocks the executable retroactive-commit fork found during review.

A signer locked on value `X` may prepare another value only when the proposal carries a valid prepare QC from a round at least as high as its lock and the protocol’s valid-value rule permits that value. It never unlocks based on unauthenticated claims or a timeout alone.

### 14.5 QC validation

A QC is valid only if:

- all votes have the same object, epoch, round, phase, proposal digest, and proposal hash;
- signer IDs are unique and belong to the anchor signer set;
- every signature verifies;
- at least `q(n)` votes are present;
- the proposal digest names a fully valid cut descriptor.

A commit QC finalizes the epoch. A correct signer does not finalize a second value for that epoch.

### 14.6 Pacemaker

Production requires a separately modeled pacemaker. The recommended profile is:

- deterministic round-robin leader;
- local timeout with exponential backoff and cap;
- signed round-change messages carrying the highest prepare QC;
- catch-up on a valid higher-round QC or at least `ceil(n/3)` round-change messages for that round;
- bounded future-round buffering and per-signer rate limits;
- proposal retransmission and missing-artifact requests by digest.

Safety does not depend on synchrony. Liveness assumes eventual partial synchrony and a responsive quorum. This pacemaker MUST be modeled in TLA+, Quint, or an equivalent state-machine checker before production enablement.

---

## 15. Authority and ACL handoff

### 15.1 Data epochs versus authority epochs

Most data cuts do not change the signer set. A joiner should not need a certificate chain proportional to message count. Therefore:

- every data cut is signed by the authority set pinned in its anchor;
- repeated data cuts with the same authority are independently verifiable by that set;
- only an ACL/signer-set change emits an authority-handoff certificate.

A fresh peer retains/verifies a chain proportional to governance changes, not chat messages.

### 15.2 Handoff certificate

A handoff commits to old authority digest, new authority digest, activation anchor, ACL digest, and proof-of-possession/acceptance signatures from new signers. It is finalized by a QC from the old authority. New-signer acknowledgments are not a replacement for old-authority authorization, but they prevent installing unusable or malformed keys.

### 15.3 Weak-subjectivity anchor

A room invite SHOULD pin at least the genesis creator key/object ID and MAY pin a recent authority handoff and data cut. A peer that has been offline for a long time compares multiple rendezvous peers/relays and warns on conflicting valid authority branches. The protocol can prove equivocation; it cannot decide which branch is “latest” without a freshness assumption.

---

## 16. Browser persistence and crash recovery

### 16.1 IndexedDB stores

A browser implementation SHOULD use separate object stores for:

- immutable chunks and archive chunks by digest;
- manifests, descriptors, QCs, and anchors by digest;
- active vertices and pending indexes;
- durable vote slots;
- object metadata/current-anchor pointer;
- staging journal and rollback references;
- optional cached archive-index pages.

### 16.2 Commit sequence

1. Download/produce content-addressed chunks and store them with relaxed durability.
2. Verify the full manifest, payload, state/ACL digests, descriptor, and QC.
3. Write a “staged” journal record.
4. In one strict read-write transaction, insert immutable descriptor/QC/anchor records, update the object’s current metadata pointer, mark the staged snapshot adopted, and persist any final vote/lock metadata.
5. After transaction completion, clean old tail indexes and surplus rollback artifacts asynchronously.

The active pointer is never updated before all referenced durable objects exist. Recovery reads the journal and pointer; an unadopted stage is safe to resume or delete.

### 16.3 Multi-tab coordination

A Web Lock SHOULD elect a primary tab for network sync and cleanup. Correctness MUST still hold if two tabs run or the lock implementation is unavailable. Immutable vote slots and metadata compare-and-swap in IndexedDB prevent double voting and conflicting anchor adoption.

### 16.4 Storage persistence and quota

The app SHOULD request persistent storage after explaining why history may otherwise be evicted. It SHOULD query storage estimates before large snapshot/archive writes, maintain a safety margin, handle `QuotaExceededError`, and offer export/recovery options.

A signer MUST NOT prune its last usable rollback snapshot merely because content was handed to an untrusted mirror. Local policy decides how many rollback generations and availability receipts are required.

---

## 17. Availability policy

### 17.1 Correctness versus availability

A cut QC proves that signers agreed on bytes identified by digests. It does not prove those bytes will remain retrievable. The room defines an availability policy, for example:

- at least `r` distinct mirror receipts for every snapshot and archive segment;
- one local archive plus one remote mirror;
- erasure-coded shards across `m` storage identities;
- periodic challenge/repair before deleting the last local copy.

Receipts are evidence of possession at one time, not permanent guarantees.

### 17.2 Pruning gate

A compact peer MAY prune an old graph only after:

- commit QC verified;
- snapshot adopted in durable storage;
- rollback policy satisfied;
- required snapshot/archive chunks available locally or availability policy satisfied;
- active outbox operations categorized as committed, rebased, expired, or user-review.

---

## 18. Synchronization protocol

### 18.1 Cold join

A cold join exchanges a small object head containing current authority certificate, data cut descriptor/QC, anchor, snapshot manifest, active-tail summary, and archive-window policy. The joiner verifies trust and requests only missing chunks.

### 18.2 Active-tail reconciliation

PRIBLT or another set-reconciliation codec is well suited to the bounded active epoch because cost follows the set difference rather than total room age. It MUST have a fallback to chunked hash lists when decoding fails or the difference is large.

Set reconciliation does not replace snapshot transfer. The snapshot and archive payloads are fetched by content digest.

### 18.3 Resource accounting

All handlers enforce maximum message bytes, hashes per request, outstanding chunk requests, dependencies per vertex, pending bytes per peer, decode work, and concurrent cryptographic operations. Oversize input is rejected before deep decode where possible.

---

## 19. Browser performance profile

Recommended initial defaults:

```text
maxEpochVertices      = 8,192
maxEpochBytes         = 8 MiB
maxDependencies       = 16
snapshotChunkBytes    = 128 KiB
maxSnapshotBytes      = 256 MiB
maxPendingEntries     = 4,096
maxPendingBytes       = 16 MiB
```

These are guardrails, not universal constants. Mobile profiles should be lower.

Close computation—canonical encoding, state hashing, archive packing, large Merkle work, and full fold—SHOULD run in a dedicated Worker. Work loops SHOULD yield in bounded batches and honor cancellation. The active gameplay/chat operation path must not wait for a full snapshot.

The reference Node benchmark on the supplied x64 environment processed a 1.88 MiB / 10,000-message state with median times of roughly 139 ms for canonical encoding, 138 ms for state digest, 11 ms for snapshot chunk/manifest generation, 178 ms for ten archive segments plus index, 24 ms for Kahn order over 8,192 active vertices, and 114 ms for a 4,096-vertex staged fold. Pure-JavaScript/WebCrypto Merkle construction was the slowest path and should be batched or implemented in a reviewed Worker/WASM hash backend. These figures are engineering signals, not browser guarantees.

---

## 20. Migration from the legacy protocol

This is a protocol-major change. It MUST NOT be introduced by silently changing the legacy vertex hash or accepting two preimages for one object.

Recommended rollout:

1. **Correctness fixes before pruning:** freeze canonical encoding, add object/protocol domain separation for new objects, replace shallow state merge with replacement, separate replica-local context, stage merges, remove timeout-based semantic rejection, and replace legacy DFS replay.
2. **New object namespace:** create v2/v4 rooms on a distinct pubsub/topic/version namespace.
3. **Legacy migration record:** current creator/authority signs a record that names the legacy object, its chosen final state digest, and a new genesis anchor. Participants explicitly join the new object.
4. **Shadow close:** produce and verify snapshots/QCs while retaining full history; compare independent replicas and archives.
5. **Rollback-limited pruning:** prune only after multiple successful epochs and retained rollback generations.
6. **Archive segmentation:** enable chat history paging and retention after state correctness is stable.
7. **Default-on only after gates:** formal seal model, multi-browser crash tests, adversarial network tests, and external security review.

---

## 21. Proof obligations and validation gates

### 21.1 Deterministic replay

For every accepted close set, all conforming peers must compute the same Kahn order, conflict decisions, state bytes, ACL bytes, archive root, and history extension. Property tests should randomize map insertion, arrival schedule, chunk order, and peer identity.

### 21.2 Snapshot induction

Let `S_e` be the certified state in anchor `A_e`, and `C_e` the committed close set. Define:

```text
S_(e+1) = Fold(S_e, CanonicalOrder(C_e))
```

If all signers verify the same descriptor and fold, importing the certified `S_(e+1)` is observationally equivalent to archival replay through epoch `e`. The independent model checks this induction over exhaustive small DAGs and randomized epochs.

### 21.3 Seal safety

The production pacemaker/locking model must show agreement, integrity, validity, and no retroactive vote. Finite tests and quorum intersection arithmetic are necessary regression evidence but are not a substitute for a full state-machine model.

### 21.4 Crash safety

Fault injection must terminate the browser before and after every IndexedDB request in stage/adopt/cleanup and show that recovery returns either the old complete anchor or the new complete anchor, never a mixed state.

### 21.5 Browser matrix

Required release matrix:

- current and previous Chrome/Chromium;
- current and previous Firefox;
- current and previous Safari/macOS;
- Safari/iOS and Chrome/Android on representative low-memory devices;
- private/incognito and denied-persistence behavior;
- multi-tab signer races;
- quota exhaustion and eviction simulation;
- Worker termination and page lifecycle suspension.

### 21.6 Adversarial protocol tests

Tests must include forged/mixed QCs, duplicate signers, round rollback, lock amnesia, malformed canonical values, oversized maps/arrays/dependency fans, missing chunks, manifest substitution, stale/future anchor replay, withheld close vertices, excluded local operations, archive-proof tampering, and conflicting authority handoffs.

---

## 22. Reference evidence summary

The included executable reference currently demonstrates:

- 22 passing unit/integration tests;
- exhaustive RFC-style Merkle consistency checks for small append histories;
- compact Merkle roots matching materialized roots;
- 5,231 exhaustive admissible DAG checks through seven vertices;
- 10,000 randomized hard epochs and 20,000 delivery permutations;
- a concrete legacy DFS/synthetic-root ordering counterexample;
- 11,612 quorum-pair intersection checks and 8,547 same-round QC-pair checks;
- an executable delayed-round retroactive-commit fork under the old rule and its rejection under monotone rounds;
- an approximate covered-membership false-positive divergence;
- archive segment/index inclusion and tamper tests;
- a static browser-surface audit with no Node-only dependency in the protocol modules.

The managed Chromium in the review environment blocks all navigation by policy, so real browser execution is recorded as **blocked**, not passed. The WebCrypto/Worker/IndexedDB harness is included for execution in normal profiles.

---

## 23. Production acceptance checklist

The implementation is ready for production enablement only when every item below is true:

- [ ] canonical codec has golden vectors in TypeScript and at least one independent language;
- [ ] all hashes/signatures include object, protocol, epoch, and anchor domains;
- [ ] legacy DFS is removed from all semantic paths;
- [ ] close set, fold, snapshot, archive, history root, and anchor reproduce across independent implementations;
- [ ] pacemaker and locking are model-checked;
- [ ] durable vote CAS survives multi-tab/process races;
- [ ] crash injection proves old-or-new atomic adoption;
- [ ] availability/pruning policy is explicit in room configuration and UI;
- [ ] cold join supports resume, limits, and untrusted mirrors;
- [ ] chat archive is paged and hot snapshot size is bounded;
- [ ] browser/mobile memory and frame-time budgets pass;
- [ ] migration creates a new versioned object namespace;
- [ ] external security review is complete;
- [ ] rollback telemetry and emergency disable switch are deployed.

---

## 24. Design conclusion

The safe generic primitive is not “delete old vertices and remember which hashes were deleted.” It is “finalize an exact epoch, carry its deterministic state into a new authenticated anchor, and make all future vertices name that anchor.”

That one semantic boundary turns an unbounded historical-membership problem into a bounded current-epoch problem. An append-only Merkle commitment preserves auditability; snapshots preserve executable state; archive segments preserve optional long-lived content; authority handoffs preserve trust; and browser storage journals preserve crash consistency. The cost is explicit epoch rebasing and signer availability during close, which is a preferable and testable product trade-off to replica-dependent stale-message decisions.
