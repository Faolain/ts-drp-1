# D.110c prior-art report: epoch fencing, re-add incarnations, gap settlement, bounded state

(Verbatim final report of the Fable 5.1 prior-art research agent, 2026-09-03. The agent could not write to the scratchpad directly; the orchestrator saved this text.)

Scope: primary sources only (RFC text, papers, source code). Every code claim about ts-drp cites `file:line` at branch `codex/phase3a1b-p6-golden-path`; every design claim cites the section of `.logs/d110c-0c1f5b0-design-00a860ab/design.md` (hereafter **f5b0**) or `.logs/d110c-0c1f5b0p-design-e6a67013/design.md` (**f5b0p**).

## 0. Bottom line

Every production system examined that has a long-lived group, per-sender counters, membership churn and bounded state solves "same key re-added" and "gap from a removed/slow sender" the same way: **the durable identity is (stable key, authority-assigned monotone incarnation), counters live inside the incarnation, and the authority fences the previous incarnation instead of settling its gaps.** None of them keeps a dictionary of retired keys, and none asks the sender to sign an exact per-gap disposition before the authority advances.

- Kafka: `(producerId, producerEpoch)`; sequence restarts at 0 per epoch; broker rejects `epoch < current`; coordinator aborts the old epoch's open transaction before returning the new epoch; broker keeps 5 batches per producer plus an idle-expiry timer.
- MLS (RFC 9420): `(group_id, epoch, leaf_index, generation)`; leaf index is reused after Remove; generation restarts at 0 in every epoch because every epoch derives a fresh secret tree; old-epoch keys are deleted after a bounded window; loss detection is left to the application.
- Zab/ZooKeeper: `zxid = (epoch, counter)`; a follower acknowledges `NEWEPOCH(e')` only if `e' > accepted`, then discards proposals not in the new leader's history; a proposal that never reached a quorum is discarded because "the leader will tell the follower to discard U".
- Keybase: a user is `uid%eldestSeqno` (`UserVersion`), i.e. key-owner identity plus incarnation; per-team keys are `generation i`, rotated on removal, never reused.
- Yjs / Automerge: `clientID`/`actorId` must be fresh per concurrent session; per-actor `clock`/`seq` starts at 0 per actor; reusing an id "might get permanently corrupted without a way to recover".
- Signal/WhatsApp sender keys: random chain key + random signing key per distribution; "Whenever a group member leaves, all group participants clear their Sender Key and start over"; libsignal keeps at most 5 states and 2000 skipped keys.
- Key transparency (SEEMless/Parakeet/WhatsApp AKD): the "has this key appeared before, and what was its last state" question is answered by a **version counter per label** (`user|version`), never by a set of retired keys; deletion exists only as a storage-reclamation step with a tombstone grace period audited by the key owner.

For ts-drp this translates to: put a creator-assigned `admissionEpoch` into the latched ACL member record (replaces f5b0p entirely), and replace the per-source disposition carrier with a single author-signed per-epoch fence (`epochBaseSequence`), which is the never-resetting-sequence analogue of Kafka's "first sequence of a new epoch is 0". Details and costs in §9–§10.

---

## 1. MLS, RFC 9420 (and the architecture, RFC 9750)

Source: https://www.rfc-editor.org/rfc/rfc9420.txt , https://www.rfc-editor.org/rfc/rfc9750.txt

**Leaf index reuse after Remove.** §12.1.1: "For the first Add in the Commit, the corresponding new member will be placed in the leftmost empty leaf in the tree, for the second Add, the next empty leaf to the right, etc. If no empty leaf exists, the tree is extended to the right." §12.1.3 (Remove) blanks the leaf and its path, then "Truncate the tree by removing the right subtree until there is at least one non-blank leaf node in the right subtree." So a removed member's leaf index is reused by the next Add. Nothing about the old occupant is retained.

**Epoch in framing and rejection of wrong-epoch content.** §8 (GroupContext): "The epoch field increments by one for each Commit message that is processed." §12.1: "a client MUST verify the signature inside FramedContentAuthData and that the epoch field of the enclosing FramedContent is equal to the epoch field of the current GroupContext object." §12.4.2 repeats this for Commits.

**Generation restarts per epoch, and why that is safe.** §9: `DeriveTreeSecret(Secret, Label, Generation, Length) = ExpandWithLabel(Secret, Label, Generation, Length)` where the root secret is the *epoch's* `encryption_secret`; "each step along the ratchet is called a 'generation'". §6.3.1: "the sender looks at the ratchets it derived for its own member and chooses an unused generation." Because the secret tree is re-derived from each epoch's `epoch_secret`, generation 0 of epoch n+1 is cryptographically unrelated to generation 0 of epoch n; the tuple `(group_id, epoch, leaf_index, generation)` is what is globally unique, not `(leaf_index, generation)`. §6.3.1 also admits the failure mode this design must guard: "if this persistent state is lost or corrupted, a client might reuse a generation that has already been used" — mitigated by a random 4-byte `reuse_guard`, not by any group-level memory of past generations.

**Design principle extracted:** *counters may restart at every fence because the fence value is part of the identity and the material keyed by the counter is re-derived per fence.* MLS does not remember what an evicted leaf's old counters were; it makes them unreachable.

**Messages from a removed member / earlier epoch.** §9.2: "As soon as a group member consumes a value, they MUST immediately delete (all representations of) that value … Members MAY keep unconsumed values around for some reasonable amount of time to handle out-of-order message delivery." §15.3: "Applications SHOULD define a policy on how long to keep unused nonce and key pairs for a sender, and the maximum number to keep … Messages received with a generation counter that is too much higher than the last message received would then be rejected." RFC 9750 §5.2.2: "any copies of previous or forked group states must be deleted within a reasonable amount of time." A delayed message from epoch n (including from a member removed by the Commit that started n+1) is decryptable only inside the retention window and is otherwise dropped; there is no settlement.

**Gap detection is the application's job.** §16.9: "this can be observed by detecting gaps in the per-sender generation counter, though it may not always be possible to distinguish an attack from message loss … Aside from the SenderData.generation value, MLS leaves loss detection up to the application." RFC 9750: "If a group member observes a gap in the generation sequence for a sender, then they know that they have missed a message from that sender."

**Delivery Service retention.** RFC 9750 §5: the DS stores KeyPackages, delivers Welcome/GroupInfo, orders handshake messages, is untrusted and "can simply refuse to relay messages to and from a given client." No requirement that the DS retain application messages; forward secrecy forbids clients from retaining old keys.

**Re-add of the same signature key.** No counter continuity across removal; a re-added member presents a new KeyPackage and is placed by §12.1.1. The only prior-presence mechanism is optional: §12.4.3.2 lets an application require "a 'reinit' PSK proposal that demonstrates the joining member's presence in a prior epoch of the group." Continuity is proven by the joiner, not by group memory of retired keys.

## 2. Kafka idempotent/transactional producer

Sources: KIP-98, KIP-360 (https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=89068820), KIP-890; `ProducerAppendInfo.java`, `ProducerStateEntry.java`, `ProducerStateManager.java`, `TransactionCoordinator.scala` at https://github.com/apache/kafka (trunk); https://kafka.apache.org/40/generated/kafka_config.html

**Identity and counters.** KIP-98: "For a given PID, sequence numbers will start from zero and be monotonically increasing, with one sequence number per topic partition produced to." The epoch is a per-PID generational counter bumped by `InitProducerId`.

**Fencing rule (exact).** `ProducerAppendInfo.checkProducerEpoch` (trunk):

```java
short current = updatedEntry.producerEpoch();
boolean invalidEpoch = (transactionVersion >= 2) ? (producerEpoch <= current) : (producerEpoch < current);
… throw new InvalidProducerEpochException("Epoch of producer " + producerId + " … is " + producerEpoch + ", which is " + comparison + " the last seen epoch " + current …)
```

`checkSequence`: on an epoch change "the first sequence must be 0": `if (producerEpoch != updatedEntry.producerEpoch()) { if (appendFirstSeq != 0) { … throw new OutOfOrderSequenceException("Invalid sequence number for new epoch of producer …") } }`, and for TV2 "reject non-zero sequences when there is no producer ID state … Expected sequence 0 for transactions v2 idempotent producer with no existing state." Within an epoch: `nextSeq == lastSeq + 1` or wrap, else `OutOfOrderSequenceException`. The code still carries the legacy relaxation: "If there is no current producer epoch (possibly because all producer records have been deleted due to retention or the DeleteRecords API) accept writes with any sequence number" — pre-TV2 Kafka *accepted the reset risk* after state expiry; TV2 closed it by insisting on sequence 0 plus the epoch bump.

**What happens to the old epoch's in-flight work.** `TransactionCoordinator.prepareInitProducerIdTransit`: for `TransactionState.ONGOING` it returns `txnMetadata.prepareFenceProducerEpoch()` ("indicate to abort the current ongoing txn first. Note that this epoch is never returned to the user"), aborts via `endTransaction(… TransactionResult.ABORT, isFromClient = false)`, and answers `CONCURRENT_TRANSACTIONS` so the client retries; a mismatched `expectedProducerIdAndEpoch` yields `Errors.PRODUCER_FENCED`; on epoch exhaustion it calls `prepareProducerIdRotation(producerIdManager.generateProducerId() …)`. KIP-360: "Assignment of the epoch/sequence number to a record batch is permanent and happens at the time of the record send"; on a fatal error the client must "fail all subsequent batches for that partition which have been assigned a sequence number"; on a successful bump the producer will "reset sequence numbers back to 0 and continue"; if the epoch is exhausted, "generate a new producerId with epoch=0". KIP-890 bumps the epoch on every commit/abort so that late messages from previous transactions are rejected by the existing epoch fencing at the log layer.

**Bounded broker state.** `ProducerStateEntry.NUM_BATCHES_TO_RETAIN = 5` with `if (batchMetadata.size() == NUM_BATCHES_TO_RETAIN) batchMetadata.removeFirst();` and `maybeUpdateProducerEpoch`: `if (this.producerEpoch != producerEpoch) { batchMetadata.clear(); this.producerEpoch = producerEpoch; }`. `ProducerStateManager.removeExpiredProducers` drops entries idle longer than `producer.id.expiration.ms` (default 86,400,000 ms; "Producer IDs will not expire while a transaction associated to them is still ongoing"). `transactional.id.expiration.ms` (default 604,800,000 ms) expires the transactional-id → PID mapping at the coordinator.

**Loss and recovery.** Honest work that can be lost: batches stamped with the old epoch that never received a definitive answer. Recovery is sender-side: the producer re-sends under the new epoch from sequence 0, and the fence guarantees the old-epoch copies can never be appended afterwards. The broker never reasons about "which old-epoch sequence numbers are missing"; the new epoch starting at 0 makes the question moot.

## 3. Raft, Paxos ballots, Zab

Sources: https://raft.github.io/raft.pdf ; Zab DSN 2011 https://www.cs.cornell.edu/courses/cs6452/2012sp/papers/zab-ieee.pdf ; https://zookeeper.apache.org/doc/current/zookeeperInternals.html

**Zab epoch + counter.** ZooKeeper internals: "The zxid has two parts: the epoch and a counter … We use the high order 32-bits for the epoch and the low order 32-bits for the counter." Zab Phase 1: the prospective leader "proposes NEWEPOCH(e′) … such that it is later than any e received in a CEPOCH(e) message"; a follower, "Once it receives a NEWEPOCH(e′) … if f.p < e′, then make f.p ← e′ and acknowledge" — a promise never to accept proposals from an earlier epoch. Phase 2: the leader selects one follower's history as `I_e′` and followers adopt it.

**Discarding a predecessor's unresolved proposals.** ZooKeeper internals: "Since committed proposals must be seen by a quorum of servers, and a quorum of servers that elected the leader did not see U, the proposals of U have not been committed, so they can be discarded. When the follower connects to the leader, the leader will tell the follower to discard U." Zab's *primary order* is the dependency rule: "Since each state change is based on a previous state if the change for that previous state is skipped, the dependent changes must also be skipped."

**Raft.** §5.4.2: "Raft never commits log entries from previous terms by counting replicas; only log entries from the leader's current term are committed by counting replicas." §6 joint consensus: "Agreement (for elections and entry commitment) requires separate majorities from both the old and new configurations … There is no point in time in which C_old and C_new can both make decisions independently."

**Rule extracted:** the successor authority, holding a strictly greater ballot/epoch, declares dead everything the predecessor left unresolved (anything not in the successor's adopted history), and the *proposer* re-proposes under the new epoch. No system asks the proposer to sign a statement about each abandoned proposal before the new epoch can proceed.

## 4. Automerge and Yjs

Sources: https://docs.rs/automerge/latest/automerge/ ; https://mintlify.wiki/automerge/automerge/concepts/documents ; `rust/automerge/src/{automerge.rs,change_queue.rs,change_graph.rs}` at https://github.com/automerge/automerge ; https://docs.yjs.dev/api/y.doc , https://docs.yjs.dev/api/faq ; `src/utils/{Doc.js,Transaction.js,StructStore.js}` at https://github.com/yjs/yjs

**Actor identity rule.** docs.rs: "An actor ID is any random sequence of bytes but each change by the same actor ID must be sequential." Concepts doc: "Never use the same actor ID in multiple threads or processes editing simultaneously"; cloning generates a new actor ID. Enforcement in `change_queue.rs`: `ChangeBatch.push` returns `AutomergeError::DuplicateSeqNumber` when `incoming_actor_seqs` already contains `(actor, seq)`, and `remove_actor_branch_from` will "Remove queued changes at or after an incompatible actor sequence, together with changes which transitively depend on that branch" — comment: "A local change claims this actor sequence. Any queued change at the same or a later sequence belongs to an incompatible actor branch; retaining it would allow save() to encode duplicate sequence numbers." That is local fencing: on an `(actor, seq)` collision the local branch wins and the foreign branch is dropped.

**Missing dependencies are held forever (confirmed).** `automerge.rs` field `queue: ChangeQueue` — "The list of unapplied changes that are not causally ready"; `missing_deps_from` walks queued changes' deps to report hashes that are neither applied nor queued; `change_graph.rs` returns `MissingDep` if a dep is absent. No timeout, expiry or eviction exists in any of these files.

**Yjs.** `Doc.js`: `this.clientID = generateNewClientId()`; `Transaction.js`: `export const generateNewClientId = random.uint53`. API doc: `clientID` is "A unique id that identifies a client for a session. It should not be reused across sessions." FAQ: "When two Y.Doc instances with the same ClientID exist, the document might get permanently corrupted without a way to recover"; persistent user identity goes in Awareness, not clientID. `StructStore.js` keeps `pendingStructs {missing: Map<client, clock>, update}` and `pendingDs` with no expiry; `getStateVector` returns per-client "next expected clock id". Yjs identity is exactly *key (user) + fresh incarnation (clientID)*, with per-incarnation clocks starting at 0, and gaps are waited on, never settled.

**Extracted:** CRDT libraries sit at the opposite extreme from Kafka/Zab — they never settle a gap (unbounded pending state) — but agree on the identity rule: a returning process is a *new* actor, and reuse of an actor id across incarnations is a correctness violation, not something to reconcile via a registry.

## 5. Matrix

Source: https://spec.matrix.org/latest/client-server-api/#room-upgrades ; https://spec.matrix.org/latest/rooms/v2/

**Room upgrades.** `m.room.tombstone` (state event, empty state key) carries `replacement_room`; the new room's `m.room.create` carries `predecessor`. Server behaviour: "Replicates transferable state events to the new room … Membership events should not be transferred to the new room due to technical limitations … Sends a m.room.tombstone event to the old room to indicate that it is not intended to be used any further. If possible, the power levels in the old room should also be modified to prevent sending of events and inviting new users." The old room is left in place; clients may "virtually merge the rooms such that the old room's timeline seamlessly continues into the new timeline."

**State resolution v2** orders conflicted power events by "reverse topological power ordering", mainline-orders by `m.room.power_levels`, applies "iterative auth checks"; rejected events "are handled as usual by the algorithm." Nothing bounds state; a room's DAG and state are unbounded, and the only "compaction" is a room upgrade — *a new room in which every member re-joins*, i.e. fresh incarnation for everyone, with old history kept read-only rather than pruned.

**What Matrix does not solve:** bounded state. It is evidence that the industry answer to "rotate the group's authority" is a fresh incarnation with a signed pointer (`tombstone`/`predecessor`), not identity continuity of counters.

## 6. Keybase and Signal sender keys

Sources: https://book.keybase.io/docs/teams/crypto , https://book.keybase.io/docs/server , https://book.keybase.io/docs/teams/puk ; `protocol/avdl/keybase1/common.avdl`, `go/protocol/keybase1/extras.go` at https://github.com/keybase/client ; WhatsApp Encryption Overview (2026-02-25) https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf ; libsignal `rust/protocol/src/{sender_keys.rs,consts.rs}`

**Keybase.** "a user rotates these keys to a new a generation in a team.rotate link … This process is repeated at every generation i. At generation i, the keys E_i and D_i are signed into the team's public sigchain … When a team member revokes a device, or a team member is reset, or a user leaves or is removed from a team, the PTK must rotate … The new PTK keys are encrypted for all remaining members, and the new public key halves are written into the team's sigchain. Also, whenever the key rolls over, the previous seed s_i is encrypted with c_{i+1}" (old generations remain readable, never reused). PUK: "Users start at PUK generation 1. Every time they revoke a device, they increment their version number and roll their PUK." User identity across account reset: "since accounts can be reset, it actually starts playback at the most recent link whose eldest_kid matches the one in the Merkle tree"; in code, `record UserVersion { UID uid; Seqno eldestSeqno; }` printed as `uid%eldestSeqno` (`extras.go`, `func (u UserVersion) String()`), and team membership is keyed by `UserVersion`. A reset user is a *different* member that must be re-added. This is the cleanest production statement of "identity = key owner + incarnation".

**Signal/WhatsApp sender keys.** "The sender generates a random 32-byte Chain Key … a random Curve25519 Signature Key key pair … Whenever a group member leaves, all group participants clear their Sender Key and start over." libsignal: `SenderKeyRecord { states: VecDeque<SenderKeyState> }` evicting the oldest beyond `MAX_SENDER_KEY_STATES = 5`; per state `chain_id`, `iteration`, `sender_message_keys` trimmed to `MAX_MESSAGE_KEYS = 2000`; `MAX_FORWARD_JUMPS = 25_000`. A departure never reuses a sender key; a late message under an evicted state is simply undecryptable. State is bounded by eviction; lost work is recovered (if at all) by the application.

## 7. Certificate/Key Transparency: CONIKS, SEEMless, Parakeet, WhatsApp AKD

Sources: https://eprint.iacr.org/2014/1004.pdf ; https://eprint.iacr.org/2018/607.pdf ; https://eprint.iacr.org/2023/081.pdf ; https://github.com/facebook/akd ("based off of the protocols described in SEEMless, with ideas incorporated from Parakeet")

**CONIKS.** A Merkle prefix tree per epoch with a signed tree root: `STR = Sign(t || t_prev || root_t || H(STR_prev) || P)`; "Each STR includes the hash of the previous STR, committing to a linear history of the directory." A key change *replaces* the leaf; history is the chain of STRs, so a user must check every epoch to detect a transient change. No version counter per key, no tombstone.

**SEEMless.** "We use the aZKS to store ((label||version), val) pairs, and when Bob queries he will get Alice's latest version number and an aZKS proof for this (label||version)." Update: "The server first checks if the label already exists for some version α − 1, else sets α = 1. It adds a new entry (label|α, val) to the 'all' aZKS and also adds (label|α − 1, ) to the 'old' aZKS if α > 1. If the new version α = 2^i for some i, then the server adds a marker entry (label|mark|i, 'marker')". Freshness is a non-membership proof for `label|α+1`; the structure is append-only — entries are never removed. The structure is a sparse-Merkle/Patricia trie over VRF'd labels; the history dimension is the hash chain of commitments, not a history tree.

**Parakeet.** Same versioned labels: on update "the server inserts the labels 'Alice|i|stale' with value equal to the empty string, and 'Alice|(i + 1)'"; storage "only depends on the total number of leaves added". Deletion exists only as *compaction* with a grace period: "The compaction consists of two phases: the tombstone phase, a special epoch when some of the server's data is marked for garbage collection, followed, after a period of time, by the compaction phase … we require that users monitor their own key history after each tombstone phase, prior to the following compaction phase." The protected invariant: "a version number cannot be deleted and reinserted without detection."

**Comparison with the f5b0p retired-key dictionary.** KT answers exactly the question f5b0p poses ("has this key appeared before and what was its last state") by making the *version number* part of the label and never deleting it; "is this key fresh" is a non-membership proof for `key|1`. f5b0p maintains the set of *currently retired* keys with delete-on-re-add (f5b0p §"ACL transition law"). In information terms the union (active frontier vector ∪ retired dictionary) equals a KT-style map key → last boundary, so f5b0p is *equivalent in what it can prove to the creator*. It is *weaker* in auditability: KT never deletes, so a wrong re-insertion is detectable by the key owner; f5b0p deletes on re-add, so only the creator's honesty (already assumed under `creator-trusted-v1`) prevents a wrong boundary restore. It is *strictly more expensive* than what KT-style systems deploy for this question: an O(R) authenticated store, O(log R) proofs on every membership-changing close (up to 14,942,208 canonical node bytes per transition, f5b0p §"Proofs and deterministic updates"), a dedicated IndexedDB schema, candidate/current/rollback root lifecycle and a crash matrix. Most importantly, KT shows the cheaper answer: **if the authority assigns each key a monotone version at admission, no memory of retired keys is needed** — the version rides on the active record. That is the Kafka/MLS/Keybase incarnation design.

---

## 8. Cross-system summary

| System | Identity tuple | Counter scope | Re-add of same key | Gap from removed/slow sender | Bounded state by |
|---|---|---|---|---|---|
| Kafka | (PID, epoch, partition) | restarts at 0 per epoch | new epoch (or new PID) via `InitProducerId`; old epoch fenced | authority rejects `epoch < current`; open txn aborted; sender re-sends | 5 batches/producer + idle expiry |
| MLS | (group, epoch, leaf, generation) | restarts at 0 per epoch | new KeyPackage, leaf index reused | old-epoch keys deleted after window; app detects gaps | forward-secrecy deletion |
| Zab/Raft | (epoch/term, counter/index) | restarts per epoch | n/a | successor discards predecessor's uncommitted; client retries | log truncation to leader history |
| Keybase | uid%eldestSeqno; PTK generation | per generation | reset user is a new UserVersion, must be re-added | key rotation; old gens boxed forward | append-only linear sigchain |
| Yjs/Automerge | (clientID / actorId, clock/seq) | 0 per fresh id | fresh id per session (reuse = corruption) | wait forever (pending queue) | not bounded |
| Signal SK | (sender, distribution, chain_id, iteration) | per chain | new random key on any departure | undecryptable beyond 5 states / 2000 keys | eviction |
| KT | (label, version) | version per label, never reused | version+1; freshness = non-membership of version+1 | n/a | append-only; compaction only via audited tombstone grace |
| **f5b0/f5b0p** | (author, never-resetting seq) + retired-key dictionary | room lifetime | dictionary membership restores boundary; nonmembership ⇒ 0 | author-signed exact disposition per source | O(64) checkpoint + O(R) dictionary |

Industry convergence: **incarnation in the identity, counters inside the incarnation, authority-side fencing of the previous incarnation, sender-side re-issue.** The two places where the team's design diverges are precisely choices (i) and (ii).

---

## 9. Synthesis on the two open choices

### (i) Retired-key dictionary vs fresh incarnation per re-add

The dictionary exists only to answer "is this ACL key globally new or a return?" (f5b0 §"Resolved identity-history design prerequisite"; review disposition 4). Every system above makes that question unnecessary by binding an authority-assigned monotone incarnation to the identity at admission. In ts-drp the creator already signs the latched ACL snapshot per epoch and the snapshot already carries `epoch` (`packages/protocol-v3/src/latched-acl.ts:7` `SNAPSHOT_KEYS = ["epoch", …]`, `:126-128`), but members carry only `["author", "finalityKey", "groups"]` (`latched-acl.ts:8`), and `freezeMembers` (`:351-368`) drops a fully revoked key without trace — which is why the f5b0p audit (§1) found a re-grant "indistinguishable from a globally fresh key".

Adding one creator-assigned integer per member — `admissionEpoch` = the ACL epoch in which the current uninterrupted membership began — gives every vertex the effective identity `(author, admissionEpoch, authorSequence)` without touching the vertex envelope: the vertex preimage already binds `epoch` and `anchor` (`packages/protocol-v3/src/index.ts:2060-2071`, `AdmittedReceivedVertexView { epoch, anchor, author, authorSequence, … }`). Fencing rule: a vertex is admissible only if the current ACL entry for its author has `admissionEpoch ≤ vertex.epoch`; every vertex of a previous incarnation has `epoch < removalEpoch ≤ admissionEpoch` and is dead by construction — Kafka's `producerEpoch < current ⇒ InvalidProducerEpoch`, Zab's `f.p < e′`. No memory of retired keys is needed because *a returning key cannot collide with its own past*: the old incarnation's slots are unreachable, so whether the new incarnation starts at 0 or continues at its local `lineage.next` (`packages/issuance-store/src/types.ts:61-64`) is irrelevant to safety. The creator initialises the frontier of a null-boundary member at `(first observed sequence − 1)` — replacing today's `AUTHOR_REENTRY_PROOF_REQUIRED` throw at `packages/node/src/creator-close.ts:518-524` — safe for the same reason Kafka accepts any sequence "if there is no current producer epoch" *once fencing exists*; Kafka's TV2 tightening to "must be 0" was needed because Kafka lacked a per-partition admission record, which ts-drp has (the signed ACL).

The equivocation scope `(author, authorSequence, objectId)` (`index.ts:1807-1811`) stays valid: a pair straddling an incarnation boundary has one vertex with `epoch < admissionEpoch`, which the canonicaliser already re-authenticates with full preimage (`index.ts:3648-3665`) and must reject as cross-incarnation rather than as equivocation. Within one incarnation the sequence is still never-resetting, so nothing else that depends on `(author, sequence)` uniqueness breaks.

What this loses versus f5b0p: the creator cannot state the old incarnation's `admittedThrough/settledThrough` after re-add. Nobody needs it: the old incarnation's unadmitted rows are dead (epoch-bound to closed epochs and fence-rejected), and the author's own issuance store still holds their bytes, so the author re-issues their content under the new incarnation exactly as it would rebase a displaced row today. This is the MLS §12.4.3.2 stance (continuity is the joiner's business) and the Keybase stance (a reset user is a new UserVersion).

### (ii) Author-signed exact disposition per gap vs authority-side fencing

Kafka, Zab, Raft and MLS all resolve a predecessor epoch's unresolved work by fencing, and can do so *without knowing which counter values are missing* because the counter restarts at the fence: Kafka's "the first sequence must be 0" for a new epoch; MLS generation 0 per epoch; Zab `(e+1, 0)`. The team keeps a never-resetting `authorSequence`, so the creator, seeing author A's slots 5 and 7 in epoch N+1 with slot 6 missing, cannot tell whether 6 was issued for closed epoch N (dead) or for N+1 (displaced, alive). That ambiguity — not any deficiency in creator authority — is the sole reason f5b0 needs an author-signed statement.

Prior art leaves two consistent options, and the team's exact per-source grammar is neither:

- **(ii-a) Per-epoch sequence reset + pure authority fencing** (Kafka/MLS/Zab). Vertex identity becomes `(author, epoch, sequenceInEpoch)`; at close N+1 the creator declares every unadmitted slot of epoch ≤ N dead; no author statement at all. The wire meaning of `authorSequence` changes and every consumer assuming room-lifetime contiguity (`DurableLineage.next`, `deriveCreatorIssuanceRetirementBoundary` at `packages/node/src/internal/creator-issuance-retirement-boundary.ts:96-97,130`, pruning watermarks, equivocation scope) must be re-keyed by epoch. Sized by the "what reset breaks" agent.
- **(ii-b) Never-resetting sequence + one author-signed fence per epoch** (the KIP-360 `InitProducerId` pattern: the *sender* declares the bump, the *authority* validates monotonicity and records it). The author's first control vertex after adopting anchor N+1 carries `epochBaseSequence = m`, where `m` is its durable `lineage.next` at adoption. Meaning: "every slot of mine below m that is not admitted was issued for a closed epoch and is abandoned; every slot ≥ m is epoch N+1 work." The creator validates `m > settledThrough`, `m ≤ min(author's sequences in the N+1 close graph)` and that no graph slot lies in `[settledThrough+1, m)`; if valid, `settledThrough := m − 1` and the adjacent-slot scan continues from `m`. Rebase replacements are issued *after* adoption, hence at sequences ≥ m, so they are ordinary N+1 vertices and need no `replacements[]` linkage. Displaced N+1 rows are handled by the next epoch's fence after the room rebases them, exactly as today's startup barrier (f5b0 §"Admission and durable lifecycle": "Rows above the authenticated settled frontier are drained before a later ordinary issue").

(ii-b) keeps every existing consumer of the never-resetting sequence, keeps the v3 envelope unchanged, keeps the settlement carrier's admission path (ACL-membership authority, excluded from the application fold — f5b0 §"Admission and durable lifecycle" unchanged), and collapses the carrier from ≤8 sources × ≤8 intents × ≤8 replacement refs with `coveredStateDigest`, `semanticIdentityDigest`, `zero-intent`, `settlement-control` and `manual-review` semantics (6,003 B max, f5b0 §"Exact carrier grammar") to one integer (≈150–200 canonical bytes). `already-present` and its double-evaluated `hasDisplacedOperation` query (f5b0 §"Compatibility and genesis-profile boundary") disappear: idempotence of re-issue is the author's local concern, as in every fenced system (Kafka dedups only inside its 5-batch window; Raft pushes it to client serial numbers). Zero-intent `join/causalJoin/acl` slots are below the fence and need no grammar. `settlement-control` supersession is unnecessary because fences are monotone and one-per-epoch.

What (ii-b) gives up relative to f5b0: the creator no longer learns *why* a slot was abandoned. No fenced system records that at the authority; the author's issuance store and outbox remain the audit trail, and f5b0d's `pruneAuthenticatedSettledPrefix` still prunes them only after checkpoint adoption gates. Manual-review rows: the room must copy them to explicit debt before emitting the fence (or, equivalently, must not adopt/issue — the barrier — until every displaced row is rebased, expired or moved to debt). That is the barrier f5b0 already imposes.

Which did the industry converge on? Authority-side fencing, universally; the sender's only obligation is to re-propose under the new epoch. (ii-a) is the literal form; (ii-b) is the minimal adaptation that preserves a lifetime-monotone sequence. The team's exact per-source disposition is stronger than anything deployed and pays for it with a 6 KB grammar, a presence oracle, replacement-ref verification and a supersession chain, while the property it protects — "never advance across unknown evidence" — is already delivered by the fence: below the fence there is *no* unknown evidence, because the fence is the author's signed statement that nothing below it is alive, and the epoch binding of vertices makes that statement unforgeable by third parties.

---

## 10. Translation into ts-drp terms

**Field carrying the incarnation:** `admissionEpoch: number` in `LatchedAclMember` (`latched-acl.ts:8` `MEMBER_KEYS`, `copySnapshot` `:120-166`, `freezeMembers` `:351-368`, `stageLatchedAclOperations` `:376-446`), snapshot version 3. Staging rule: a granted key present in the current snapshot keeps its `admissionEpoch`; a key absent from the current snapshot gets `admissionEpoch = successor epoch` (f5b0p's "ACL transition law" with the dictionary deleted). Signed by the creator as part of the ACL already bound into anchors/checkpoints; no new signer, domain, store or proof.

**Field carrying the fence:** `epochBaseSequence: number` in a one-record control operation `$drp.author-fence.v1` inside the existing v3 envelope, signed by the author under `ts-drp/vertex/v3` (same admission path as f5b0's carrier). One per author per adopted epoch; monotone; validated by the creator against the close graph as in §9(ii-b).

**Checkpoint:** `frontiers: [author, admissionEpoch, settledThrough][]` (≤64). One boundary suffices: below the fence everything is terminal; above it the adjacent-slot scan defines the boundary. This removes `retiredAuthorRegistryRoot/Size` and the `admittedThrough`/`settledThrough` pair. Byte budget: same triple width as the measured 7,064 B record minus the registry fields, so it stays under 8,192 B.

**What is bounded:** creator side, 64 × 3 safe integers plus existing anchors/roots — no O(R) tier, no proofs, no second IndexedDB schema, no candidate/current/rollback root lifecycle; author side, its own issuance rows until pruned by f5b0d. An absent or malicious author can only freeze *its own* `settledThrough`; checkpoint cost is independent of that.

**Honest work that can be lost, and recovery:** exactly what is lost in Kafka/Zab/MLS — the sender's issued-but-unadmitted work of a closed epoch or closed incarnation. It is never lost from the sender's own store: the room re-issues it above the fence (rebase/transform) or records it as manual-review debt before declaring the fence. Third parties cannot resurrect it (epoch/anchor binding plus incarnation fence), so there is no replay or double-apply path.

**Owners that change (relative to f5b0/f5b0p):**
- Delete f5b0p-a and f5b0p-b (Merkle AVL codecs/verifier, `RetiredAuthorRegistryStore`, browser schema, reclamation, `assert-absent` grammar).
- `packages/protocol-v3/src/latched-acl.ts`: v3 member record with `admissionEpoch`; staging rule above.
- `packages/protocol-v3/src/index.ts`: admission check `admissionEpoch ≤ vertex.epoch`; equivocation canonicaliser rejects cross-incarnation pairs (`:3648-3665`).
- `packages/protocol-v3/src/creator-checkpoint.ts` / new settlement checkpoint: triple `[author, admissionEpoch, settledThrough]`; fence validation.
- `packages/node/src/creator-close.ts:518-524`: replace `AUTHOR_REENTRY_PROOF_REQUIRED` with base-at-first-observed for members whose prior boundary is null.
- f5b0a: replace the disposition grammar with the single fence record; f5b0b/f5b0c: keep the Node control/application split and durable order, drop replacement-ref verification, presence query, zero-intent and settlement-control handling; f5b0d unchanged.

**Cost:** ACL snapshot +≤64 integers; checkpoint unchanged in width; one ~200 B control vertex per author per epoch (within `maxEpochVertices`/`maxEpochBytes`); zero new storage owners; profile `creator-trusted-settlement-v1` still needed (genesis-bound schema change, as f5b0 §"Compatibility and genesis-profile boundary" argues).

---

## 11. Ranked findings

- **P1 — The retired-key dictionary solves a question that an authority-assigned incarnation makes moot.** Every surveyed system (Kafka epoch, MLS epoch+leaf, Zab epoch, Keybase `uid%eldestSeqno`/PTK generation, Yjs clientID, KT `label|version`) binds a monotone incarnation to the identity at admission and fences the predecessor; none maintains a set of retired identities. f5b0p adds an O(R) authenticated store, up to ~14.9 MB of proof material per membership-changing close, a dedicated IndexedDB schema and a crash/reclamation matrix (f5b0p §"Store contract and custody") to obtain a guarantee that one creator-signed integer per active member provides. Replace f5b0p with `admissionEpoch` in the latched ACL (§10).
- **P1 — The exact per-source disposition carrier is stronger and larger than any deployed fence and is required only because the never-resetting sequence hides which epoch a missing slot belongs to.** Adopt the KIP-360 pattern: the author signs one `epochBaseSequence` per adopted epoch; the creator validates monotonicity against the close graph and fences everything below it. This deletes `already-present`/`hasDisplacedOperation`, replacement refs, `zero-intent`, `settlement-control` and the 6,003-byte maximum shape (f5b0 §"Exact carrier grammar") while preserving "never advance across unknown evidence" (below a valid fence there is none).
- **P2 — Frontier invariant inconsistency.** f5b0p's node invariant "`settledThrough` may not exceed `admittedThrough`" (f5b0p §"Canonical node and root") contradicts f5b0 §"Creator checkpoint and advancement" ("The admitted boundary … never across a disposition") whenever a disposition settles a hole that admitted slots already straddle. With the fence model a single `settledThrough` suffices; if two boundaries are kept, reverse the inequality or define admitted as "accounted by graph or disposition".
- **P2 — `already-present` has no prior-art analogue and is the only place a creator-side decision depends on an application oracle evaluated twice (f5b0 §"Compatibility and genesis-profile boundary").** All fenced systems keep dedup on the sender. Dropping it removes a fold-adjacent dependency from the creator path.
- **P3 — CRDT prior art warns about the opposite failure.** Automerge and Yjs hold causally-unready work forever and corrupt on actor-id reuse. ts-drp's per-author frontier with terminal rows is already on the right side of that trade-off; the fence keeps it bounded.
- **P3 — MLS §15.3 DoS note.** A fence value far above `settledThrough` costs the creator nothing (no derivation), unlike MLS generation jumps; no cap is needed beyond safe-integer bounds. Sequence-space burn is self-inflicted and recovered by a new incarnation (re-add), as Kafka handles epoch exhaustion via producer-id rotation.

## 12. Source list

- RFC 9420 §6.3.1, §8, §9, §9.2, §12.1, §12.1.1, §12.1.3, §12.4.2, §12.4.3.2, §15.3, §16.9 — https://www.rfc-editor.org/rfc/rfc9420.txt
- RFC 9750 §5.2, §5.2.2, §8 — https://www.rfc-editor.org/rfc/rfc9750.txt
- KIP-98 — https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging
- KIP-360 — https://cwiki.apache.org/confluence/pages/viewpage.action?pageId=89068820
- KIP-890 — https://cwiki.apache.org/confluence/display/KAFKA/KIP-890:+Transactions+Server-Side+Defense
- Kafka trunk: `storage/src/main/java/org/apache/kafka/storage/internals/log/ProducerAppendInfo.java` (`checkProducerEpoch`, `checkSequence`), `ProducerStateEntry.java` (`NUM_BATCHES_TO_RETAIN`, `maybeUpdateProducerEpoch`), `ProducerStateManager.java` (`removeExpiredProducers`), `core/src/main/scala/kafka/coordinator/transaction/TransactionCoordinator.scala` (`prepareInitProducerIdTransit`) — https://github.com/apache/kafka
- Kafka broker configs `producer.id.expiration.ms`, `transactional.id.expiration.ms` — https://kafka.apache.org/40/generated/kafka_config.html
- Raft §5.4.2, §6 — https://raft.github.io/raft.pdf
- Zab, DSN 2011, §III (primary order), §IV Phase 1–2 — https://www.cs.cornell.edu/courses/cs6452/2012sp/papers/zab-ieee.pdf
- ZooKeeper internals (zxid, discard of U) — https://zookeeper.apache.org/doc/current/zookeeperInternals.html
- Automerge docs and source (`automerge.rs`, `change_queue.rs`, `change_graph.rs`) — https://docs.rs/automerge/latest/automerge/ , https://github.com/automerge/automerge
- Yjs docs and source (`Doc.js`, `Transaction.js`, `StructStore.js`) — https://docs.yjs.dev/api/y.doc , https://docs.yjs.dev/api/faq , https://github.com/yjs/yjs
- Matrix client-server API "Room Upgrades"; room version 2 — https://spec.matrix.org/latest/client-server-api/#room-upgrades , https://spec.matrix.org/latest/rooms/v2/
- Keybase teams crypto/PUK/server docs; `UserVersion` in `protocol/avdl/keybase1/common.avdl`, `go/protocol/keybase1/extras.go` — https://book.keybase.io/docs/teams/crypto , https://book.keybase.io/docs/teams/puk , https://book.keybase.io/docs/server , https://github.com/keybase/client
- WhatsApp Encryption Overview (2026-02-25), "Group Messages" — https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf
- libsignal `rust/protocol/src/sender_keys.rs`, `consts.rs` — https://github.com/signalapp/libsignal
- CONIKS — https://eprint.iacr.org/2014/1004.pdf ; SEEMless — https://eprint.iacr.org/2018/607.pdf ; Parakeet — https://eprint.iacr.org/2023/081.pdf ; facebook/akd — https://github.com/facebook/akd
- ts-drp: `packages/protocol-v3/src/latched-acl.ts:7-8,120-166,351-368,376-446`; `packages/protocol-v3/src/index.ts:1807-1811,2060-2071,3648-3665`; `packages/node/src/creator-close.ts:503-524`; `packages/node/src/internal/creator-issuance-retirement-boundary.ts:96-97,130`; `packages/issuance-store/src/types.ts:61-64`; `.logs/d110c-0c1f5b0-design-00a860ab/design.md`; `.logs/d110c-0c1f5b0p-design-e6a67013/{audit,design}.md`; `.logs/d110c-0c1f5b0-plan-review-fc4b8fc7/review.md`
