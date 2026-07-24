# Attested Epoch Cuts (AEC) v3.1: Hashgraph Compaction & Checkpointing for ts-drp

**Status: post-crosscheck revision 3.1.** Review history:

- **v1** — synthesized from two independently designed candidates (quorum-signed
  checkpoint artifacts vs. finality-driven emergent cuts).
- **Round 1**: Codex (gpt-5.6-sol, high reasoning) — *flawed*; Grok (max effort) —
  *sound-with-fixes*. ~26 findings → **v2**.
- **Round 2**: Codex re-review of v2 — *flawed*: confirmed 13 v1 findings closed or
  mostly closed, found 10 remaining/new holes (epoch-1 bootstrap impossibility, vote-lock
  bricking, admission decidability, pruned commit evidence, timestamp floor, replay
  unification, migration cutover, boundary precision, canonicality, atomic locks).
- **Round 3**: Kimi k3 (thinking) fresh review of v2 — *sound-with-fixes*: independently
  converged on the vote-lock bricking (A1) and admission decidability (A2); new findings:
  the linearization-origin lemma at the heart of I2 (A3), unspecified joiner ACL-replay
  semantics (A4), rollout interop breaks (A5), missing audit sites (A6), and six
  pre-existing defects the census missed (B1–B6) — two of which break I1 **today**.
- **Round 4**: Codex focused check of the two v3-new mechanisms — seal protocol
  *sound-with-fixes* (retroactive-commit fork via late prepare-QC; seal-ancestry gap;
  unenforced evidence handoff to the next cut; pacemaker unspecified; cut-0
  equivocation); admission rule *flawed* (terminal-after-bounded-retry is
  schedule-dependent) → **v3.1**: monotone round records + value-bound votes,
  transitive seal ancestry, mandatory evidence witness in the next cut, and
  witness-based terminal classification with indefinite non-semantic pending.

This revision resolves rounds 2–4; §8 is the cumulative ledger. The architecture — in-DAG seal
evidence, admission-rule-as-semantics-contract, tainted forward-closure ejection,
quorum-pinned ACL ordering, fail-closed joiner freshness — has now survived three
adversarial rounds; every revision has been to mechanisms, not to the shape.

Core idea, unchanged: **in an open-admission byzantine setting you cannot detect that
operations concurrent with a cut are impossible — you must make them invalid via a
deterministic, universally checkable admission rule.** Compaction is a semantics
contract, not an optimization; that is what makes it testable.

---

## 1. Problem statement and codebase constraints

### 1.1 The problem

A long-lived busy room accumulates an ever-growing hashgraph; nothing is ever dropped:

- `HashGraph.vertices`, `forwardEdges`, `vertexDistances` are O(V) forever
  (`packages/object/src/hashgraph/index.ts:87-89,108`). `reachablePredecessors` bitsets
  are O(V²) bits (`:106-114,353`) — **latent today** (`areCausallyRelatedUsingBitsets`
  has no production callers; the applier's LCA stage routes through checkpoints,
  `drp-applier.ts:315-343`), but the seal protocol's stability checks *activate* them,
  and bitsets are invalidated on every `addVertex` (`hashgraph/index.ts:264`) — a compute
  cost §2.9 must account for.
- `FinalityStore` keeps one BLS `FinalityState` per vertex, never pruned
  (`packages/object/src/finality/index.ts:158-185`).
- Per-vertex deep-cloned state snapshots for every applied vertex
  (`drp-applier.ts:586-602`, `state.ts:184-193`).
- Sync ships the full vertex-hash inventory per probe (`packages/node/src/operations.ts:44`,
  Map-insertion-ordered) with O(V²) diffing (`handlers.ts:336-345`); a fresh joiner
  receives the entire hashgraph in one unbounded frame
  (`packages/network/src/stream.ts:29-44`); `syncHandler` has no admission control on
  serving the full graph to anyone (`handlers.ts:326` — `// TODO: when should we reject?`).
- Storage is purely in-memory (`packages/node/src/store/object.ts`); restart = full
  re-sync.

### 1.2 Existing seams built upon

- **In-memory linearization checkpoints** every `TS_DRP_CHECKPOINT_SUFFIX_SIZE = 256`
  vertices with a **causal-barrier** predicate (`collectSuffixSubgraph`,
  `drp-applier.ts:457-486`): every suffix vertex must descend from every
  checkpoint-frontier head. Exactly the safety predicate a durable cut needs — but today
  checkpoints bound replay cost only.
- **Non-root linearization origins** (`linearizeVertices(origin, subgraph)`,
  `hashgraph/index.ts:397-424`); linearizers skip the origin by identity.
- **Synthetic-root pattern** (`hashgraph/index.ts:101,124-151`; root state seeds at
  `state.ts:50-51`).
- **State reconstruction from snapshots** (`fromStates`, `state.ts:129-140`).
- **BLS attestation machinery** (`finality/index.ts:42-152`; quorum
  `Math.ceil(n·threshold)` at `:197`, default threshold 0.51 at `:17`; signer set pinned
  per vertex from ACL state at apply time, `drp-applier.ts:610-615`). `isFinalized` has
  zero consumers — finality is advisory today.
- **Creator-rooted trust**: object id = `<creatorPeerId>:<salt>`; genesis ACL derived
  locally from the id (`packages/object/src/index.ts:27-69`); network-supplied **ACL**
  root state hard-refused (`object/src/index.ts:188-194,221-229`). Vertices
  authenticated by secp256k1 recovery → peerId comparison (`handlers.ts:614-651`).
  Dependencies are inside the signed hash preimage (`packages/utils/src/hash/index.ts:14-17`).
- **Dormant state-transfer path**: `FETCH_STATE`/`FETCH_STATE_RESPONSE`
  (`handlers.ts:144-210`); receiver currently drops the state.

### 1.3 Defect census: what compaction makes load-bearing (much of it pre-existing)

1. **No domain separation by object** *(live vulnerability)*: `computeHash` covers only
   `(peerId, operation, dependencies, timestamp)` (`utils/hash/index.ts:13`); node auth
   ignores objectId (mechanism at `handlers.ts:614-651`); the root hash is a global
   constant. **A creator-signed ACL chain from room A replays verbatim into room B by
   the same creator**, reconstructing an attacker-chosen signer set there. Exploitable
   today. Fixing it is a hard fork at the auth layer (§2.11) — a new-preimage vertex
   fails hash recomputation on a legacy peer (`validation/vertex.ts:17-22`) and is
   **permanently marked invalid** (`drp-applier.ts:229-232`), cascading its descendants
   to 'missing'; so the preimage change cannot ship "quietly" in a compat phase.
2. **Remote NOP vertices are dropped before graph insertion** (`drp-applier.ts:197`) and
   unknown opTypes reach `drp[method](...)` (`:652-657`), throw, and — being
   non-validation errors — **abort the entire merge batch** (`:213-215`). No new vertex
   kind can ship before a forward-compat applier fix, and system vertices must be
   version-gated away from legacy peers from the first ACK ever sent (§2.11).
3. **Missing-ancestor paths fail silently** — and the *production-relevant* one is the
   linearizer's causality matrix: `LegacyCausalityMatrix` silently skips deps absent
   from the graph (`linearize/legacyCausality.ts:29`), *inside the conflict-resolution
   path*. Also: BFS silent skip (`hashgraph/index.ts:575`), bitset-build silent skip
   (`:358-367`), `MAX_VALUE` distances (`:253-260`), LCA log-and-return-undefined
   (`:468-477`) — the LCA apparatus is dead in production but reachable via public API.
4. **State recomputation cannot delete — I1 is violated today, without ejection**:
   `Object.assign` adoption (`drp-applier.ts:271,274,579,582`) never removes
   properties. A local `delete drp.foo` is correctly absent from the *snapshot*
   (`state.ts:187-190` iterates live keys) but survives on the live object, and
   checkpoints baked **from live objects** (`:497-500`) inherit the phantom key — so
   replay-from-checkpoint ≠ replay-from-genesis for ordinary deletes. Additionally
   `stateFromDRP` copies **all** own enumerable keys including `context`
   (`state.ts:184-193`), whose `caller` is the last applying peer — replica-dependent
   bytes in every snapshot digest.
5. **Serialization is not canonical**: `computeHash` uses `JSON.stringify`; the msgpack
   codec encodes Map/Set insertion order unsorted; two wire stacks exist (protobuf
   `google.protobuf.Value` in `object.proto:32-35` vs msgpack ext codec in
   `utils/src/serialization/`).
6. **Untyped writer-permission rejection with non-atomic merge** *(worse than the
   generic poison-vertex case)*: `validateWriterPermission` throws a plain `Error`
   (`drp-applier.ts:527`), not in the validation trio (`:209-212`), so `:215` rethrows
   and aborts the batch **mid-loop**: earlier vertices were already graph-inserted
   per-vertex (`:604-608`) but post-merge adoption (`:265-275`) and notify never ran —
   graph and live state desynchronize, with the window depending on delivery grouping.
   Descendants of the thrower strand in `recoverMissingSync` loops.
7. **Wall-clock-dependent permanent invalidity**: validation compares against
   `Date.now()` (`drp-applier.ts:306`; one-sided future bound,
   `validation/vertex.ts:6,37-43`). The same vertex is invalid at t, valid at t+Δ —
   replicas receiving it at different times build **different permanent invalid sets →
   different graphs → different folds**. The invalid set is also a bounded 10k FIFO
   (`:34,282-289`): eviction flips terminal-invalid descendants back into missing-retry
   loops (the bounded-buffer bug, pre-existing). A byzantine author can mint
   far-future-dated vertices as timed-release stragglers.
8. **No durable storage → no crash-safe votes**; and vote persistence needs **atomic
   put-if-absent** semantics — two tabs (or two devices holding the same BLS key) can
   both observe no-lock and emit conflicting acks.
9. **ACL/BLS gaps**: `setKey` accepts arbitrary/empty keys, no proof-of-possession
   (`acl/index.ts:148-159`); admins irrevocable (`:121`); concurrent `setKey`s resolve
   Nop/implicit-LWW (`:216-218`); the advisory finality quorum denominator counts
   empty-key signers who can never sign (`finality/index.ts:197` vs `:70-72`).
10. **Root-state refusal is ACL-only**: `setDRPState` has no root guard
    (`object/src/index.ts:201-203`); only ACL root writes are refused. Harmless today
    (FETCH_STATE receiver drops state) but §2.8 builds the adoption path on this seam.
11. **Graph/API hygiene**: `HashGraph.addVertex` is not idempotent (re-adding duplicates
    frontier/forwardEdges entries, `hashgraph/index.ts:237-266`; dedupe lives one level
    up at `drp-applier.ts:198`). `dfsTopologicalSortIterative` sorts the stored edge
    array **in place** during reads (`:318`) and has a double-emission hazard: a
    two-parent vertex can be pushed twice, consuming a result slot, after which the
    `result[0] = origin` patch (`:329`) can silently **overwrite a legitimate vertex**.
    `interval-sync.ts:53-59` declares "synchronized" on any single remote vertex.
    `fetchStateResponseHandler` logs "No state found" but does not return
    (`handlers.ts:183-185`).
12. **The applier has three raw-dep triage sites**, not one: `validateVertexDependencies`
    (`validation/vertex.ts:24-35`) plus the applier's own unresolved-dep filters at
    `drp-applier.ts:206-208` and `:241-243`. All three must consult the cut boundary.

### 1.4 Constraints

1. **Open admission** — Sybils free; "all replicas acked" quantifiers unsound; legacy
   binaries can join any room forever (no fleet-wide upgrade assumption is valid).
2. **Byzantine peers** — withheld pre-signed vertices, equivocation (including
   *valid* competing proposals), forged snapshots, eclipse.
3. **Creator may be permanently offline** (`examples/grid/e2e/grid-modular.spec.ts:154`).
4. **Relay-limited transport — stated precisely** (v2 was imprecise): libp2p refuses to
   negotiate protocols over limited (relayed) connections unless registered/dialed with
   `runOnLimitedConnection` — `/drp/message` is registered without it
   (`network/src/node.ts:1756`, `sendMessage` `:1705-1715`), so direct DRP streams
   simply don't run over relays and wait for the WebRTC upgrade; gossipsub likewise
   defaults off limited connections (`getGossipSubConfig`, `:1258-1281`, never
   overridden). The circuit-relay-v2 128KB/2min limits are **reservation-lifetime
   budgets, not per-frame caps**: an oversized transfer dies mid-stream (single `.read()`
   decode at `stream.ts:40-44`), so any limited-connection opt-in needs budget-aware
   chunked **resume**, not just chunking.
5. **Correctness bar** — compacted replicas converge to identical state with
   full-history replicas for every linearization semantics (pair incl. order-mutating
   Drop/Swap, and multiple), ACL-sound, finality-sound, with a validation strategy that
   proves it.

---

## 2. Design

### 2.0 Shape

An **in-DAG seal protocol** (now a proper single-shot BFT consensus instance per epoch,
§2.4) makes each cut an objective, monotone predicate of the hashgraph; a **verifiable
CutDescriptor artifact** lets cold joiners bootstrap without replaying history. Epochs
chain: cut e's frontier descends from cut e−1's.

### 2.1 System operations and the acknowledgment layer

First-class **system operation kinds** (`SYS_ACK`, `SYS_SEAL_PREPARE`,
`SYS_SEAL_COMMIT`, `SYS_SEAL_PROPOSE`) — not NOP-typed, never dispatched to
`drp[method]`, stored with no state effect, **permanently reserved** in the protocol
registry (a later version must never reinterpret stored history). They ride a
**versioned gossip topic** legacy peers never subscribe to (§2.11).

Any vertex authored by signer s with v in its causal past is s's acknowledgment of v.
Idle signers emit periodic `SYS_ACK` vertices (cadence `TS_DRP_ACK_INTERVAL`; liveness
only). **Stability**: v is stable iff ≥ Q(S_e) distinct signers have a vertex descending
from v. Monotone, downward-closed. Frontier **maximality is not enforced** (view-
dependent; see T6). Stability checks must not naively activate the O(V²) bitset rebuild
per `addVertex` — the implementation tracks signer-descent incrementally over the
retained suffix (an engineering obligation §2.9 prices; the current bitset cache is
rebuilt on every insertion, `hashgraph/index.ts:264,341-374`).

### 2.2 Signer set S_e, bootstrap, and activation floor

S_e = `query_getFinalitySigners` (`acl/index.ts:165-171`) evaluated on the ACL state
folded at cut e−1, **restricted to signers with a valid, proof-of-possession-verified
BLS key**. Quorum Q = ⌈2|S_e|/3⌉. Activation floor |S_e| ≥ 4 (n ≥ 3f+1).

**Epoch-0 bootstrap (fixes round-2 finding 1 — as previously specified, epoch 1 was
impossible: genesis ACL contains only the creator with an empty BLS key, so |S₁| could
never reach the floor).** Cut 0 is a **creator-signed bootstrap descriptor**: after
delegating admins/signers and observing their `setKey` ops, the creator signs a
descriptor pinning F₀ and S₁ (derived from the ACL state at F₀). F₀ is **not** required
to be "stable" — stability is defined over a pinned signer set and none exists yet
(round 4 caught v3 using the undefined predicate); cut 0 is a trusted bootstrap, full
stop. Two consequences are explicit rather than hand-waved: (a) **the creator is
assumed non-equivocating at cut 0** — a creator signing two different cut-0 descriptors
creates two independently valid chains, and "attributable" does not stop two
joined-from-cut populations from extending both; I4's uniqueness claim is scoped to
epochs ≥ 1, and the mitigation for cut-0 forks is external pinning (the invite/
rendezvous digest joiners already fail closed on, §2.8); (b) rooms whose creator leaves
before signing a bootstrap never cut (fail-safe; surfaced in room-creation UX). From
epoch 1 on, cuts are quorum-committed and the creator is not needed.

ACL prerequisites: `setKey` carries BLS proof-of-possession and rejects
empty/malformed/duplicate keys before entering any signer map; the historical
(peerId → key) mapping used to verify epoch-e ack shares is pinned by epoch (derivable
from the per-epoch ACL replay, §2.8) and survives pruning.

### 2.3 CutDescriptor

Canonical-protobuf sidecar, never a vertex. **Signed preimage = descriptor without the
certificate field**; `descriptorDigest = sha256(canonical_bytes(unsigned))`; BLS message
= `sha256("drp-cut-v1" ‖ objectId ‖ epoch ‖ round ‖ descriptorDigest)`.

| Field (unsigned preimage) | Meaning |
|---|---|
| `objectId`, `epoch`, `round` | Domain separation; chain position; committing round |
| `prevDescriptorDigest` | Hash chain to the creator-signed cut-0 descriptor |
| `frontier: Hash[]` | Sorted cut frontier F. **Validation**: non-empty, no duplicates, a true antichain, every head descends from F_{e−1}, and strict progress (`closure(F_{e−1}) ⊂ closure(F_e)`) |
| `stateBlobDigest` | Digest of canonical `fold(closure(F))` (§2.5) |
| `coveredHistoryRoot` | Merkle root over sorted hashes strictly below F. **Canonicality specified**: domain-tagged leaves/nodes (`"drp-cov-leaf" / "drp-cov-node"`), sorted unique leaves, duplicate-last odd-leaf rule, defined empty-root sentinel, proof length caps |
| `aclLinearization: Hash[]` | Exact linearized order of ACL vertices folded this epoch (§2.8). The ops are individually authenticated; **both their order and their causal-position validity are trusted to the quorum** (the artifact carries no causal structure to check them against) — stated honestly in T5, cross-checkable by archival replicas via fraud proof |
| `signerSetDigest` | Sorted (peerId, BLS pubkey) of S_{e+1} from the folded ACL state |
| `cutTimestamp` | max timestamp over F — **informational only; not an admission floor** (v2's floor created delivery-order disagreement: validation permits children up to 60s behind a dep, `validation/vertex.ts:37-43`, so a pre-cut-accepted low-timestamp descendant would be rejected only by replicas that first saw it post-commit). Timestamp admission stays dep-relative against retained deps |

`certificate`: BLS aggregate + aggregation bits over the message above.

**Commit evidence is epoch-relative, and the handoff is enforced** (fixes round-2
finding 3 and round-4's gap in it): for the **tip epoch**, replicas require quorum
`SYS_SEAL_COMMIT` vertices in the DAG (each embeds
`(epoch, round, descriptorDigest, blsShare)`, so the certificate is always
reconstructible). The transition to certificate-only verification is **not left to
chance**: frontier validation for cut e+1 additionally requires that
`closure(F_{e+1})` contain a canonical quorum witness of epoch-e commit vertices, and
the witness digest is a field of descriptor e+1 — v3 merely *assumed* the next cut
would cover the seal vertices, but non-maximal frontiers are allowed and could exclude
(and thus eject) the very evidence the certificate-only rule depends on. With the
witness requirement, once cut e+1 commits the chained certificate is the durable
evidence and joiners verify historical epochs by certificate against the ACL-derived
S_e.

### 2.4 Seal protocol — single-shot BFT consensus per epoch

v2's one-phase ack scheme is withdrawn: both round-2 reviews proved that permanent
per-epoch vote locks + intra-epoch rounds + view-dependent verification compose into a
**permanent brick** — an even honest split (or one byzantine proposer equivocating two
*valid* stable frontiers) durably locks honest signers on different digests and no
round can ever reach quorum. The seal sub-protocol is therefore an explicit
Tendermint-style two-phase instance among S_e, embedded as DAG vertices:

1. **Trigger/cadence**: attempt an epoch every `TS_DRP_CUT_SUFFIX_SIZE` applied
   vertices. Proposer for (e, r) = sorted-S_e[(e + r) mod |S_e|]; round r advances on a
   DAG-measured + wall-clock-floored timeout.
2. **SYS_SEAL_PROPOSE(e, r, F, D, justification)**: deps include all of F. If the
   proposer holds a *prepare-QC* (quorum of prepares) from any earlier round, it MUST
   re-propose that QC's digest (value adoption); the justification carries the highest
   prepare-QC seen or an explicit nil marker.
3. **SYS_SEAL_PREPARE(e, r, D, proposalHash)**: votes are **value-bound** — every
   prepare explicitly names the digest and the exact proposal vertex it endorses
   (round 4 caught v3's `PREPARE(e, r)` binding to nothing). A signer prepares iff
   (a) F verifies in its own view (stable, descends from F_{e−1}, frontier-valid per
   §2.3 including the evidence witness), (b) it independently recomputes fold,
   `aclLinearization`, and D, and (c) the proposal respects its lock (below). One
   prepare per (e, r), durably recorded before emission.
4. **Monotone round state (fixes the retroactive-commit fork)**: each signer persists
   a monotone `enteredRound(e)` and **never emits any vote for a round below it**.
   Without this, a late-arriving prepare-QC for an old round — perfectly natural in a
   DAG where vertices arrive out of order and missing deps are retried later
   (`drp-applier.ts:202`) — lets an honest signer commit an old value after a newer
   one already committed (the round-4 A/B/C+byzantine counterexample: X commits in
   round r via a retroactive commit while Y committed in r+1). Commits are emitted
   only while the signer is *currently in* (e, r), as an atomic
   observe-QC → record-commit → emit transition.
5. **Lock rule**: on observing a prepare-QC for (e, r, D), a signer sets its durable
   lock to (e, r, D, QC). It prepares a different digest in a later round only if the
   proposal carries a prepare-QC from a round ≥ its lock round (lock/unlock-on-higher-
   QC). With value-bound votes and monotone rounds this is the standard Tendermint
   safety argument; without them (v3) it was not.
6. **SYS_SEAL_COMMIT(e, r, D, prepareQCref)**: references the exact prepare-QC
   (authenticated vertex refs or embedded aggregate); embeds the BLS share over the
   §2.3 message. **Commit** = quorum commits for one (e, r, D).
7. **Seal ancestry (transitive, not direct-parent)**: v3's parent rule ("deps lie in
   closure(F) ∪ seal vertices") allowed a counted seal vertex to fail descent from
   some head of F — making it ejectable by the very cut it certifies — or to ride an
   equivocating proposal's ancestry. Corrected structural rule: the proposal depends
   on **every head of F**; each prepare depends on the exact proposal it names; each
   commit depends on (or authentically references) its prepare-QC; every **counted**
   seal vertex must transitively descend from every head of F and be an admitted,
   authenticated vertex from a distinct member of S_e.
8. **Durable vote store**: separate persisted records for prepare vote, commit vote,
   `enteredRound`, lock, and highest-known QC (v3's single
   `put-if-absent(epoch, round → digest)` cannot represent both phases or serialize a
   timeout-vs-QC race). After restart a signer **re-broadcasts its persisted votes
   verbatim** — never regenerates one. Safety assumes **single signer authority per
   key** (multi-tab handled by the atomic store; multi-device out of scope, O10).
9. **Pacemaker (liveness under partial synchrony — specified, not assumed)**: v3's
   "DAG-measured + wall-clock-floored timeout" was not a pacemaker (byzantine
   non-signers can inflate DAG progress; a fixed floor need not exceed post-GST
   delay). Requirements: monotonically increasing round timeouts; observing any valid
   future-round seal vertex triggers safe round catch-up (advance `enteredRound`,
   never retro-vote); round-change carries evidence (timeout attestation or the
   observed higher-round vertex); only authenticated, rate-bounded events count as
   progress signals; late/future-round proposals and QCs are processed by the
   monotone-round rules above. Liveness claim, correctly scoped: after GST, a round
   with an honest proposer whose proposal reaches ≥Q honest signers commits the
   epoch. If ≥1/3 of S_e is permanently silent, cuts stall fail-safe (T7).

### 2.5 Fold, ejection, and the atomic transition

On observing committed cut e = (F, D, cert), every replica performs one atomic
transition (crash-recoverable: the transition's intermediate steps are journaled so a
crash restarts into a clean pre- or post-transition world):

1. **Fold input is exactly `closure(F)`**, replayed with **the one canonical replay
   function** (§2.5a below).
2. **Ejection = tainted forward closure**: ejected = every local vertex not in
   `closure(F)` and not admissible above F, where admissibility is ancestry-closed
   (all non-closure ancestors admissible, descends from every head of F). A vertex
   `y → {x, F}` with x concurrent with F is ejected with x.
3. **Retained-tail replay** in the same transition: post-state = fold + canonical
   replay of the admissible tail. Never "keep live state"; never "fold only".
4. **Wholesale state replacement**: adopted instances rebuilt with delete-then-restore
   semantics; `Object.assign` adoption is removed from **both** the merge path and the
   per-op assign path (`drp-applier.ts:271,274,579,582`). (Promoted to Phase 0 — the
   phantom-delete defect breaks digest agreement today, §1.3.4.)
5. **Digest check**: mismatch = halt-and-alarm.
6. **Ejection surfacing**: bounded side buffer + rebase event; buffers carry **no**
   admission semantics.
7. **Root swap — precise baked-set rule** (round-2 finding 8): the transition
   distinguishes *physical retention* from *active membership*. `closure(F)` —
   **including F** — is *baked*: physically retained where needed (F's wire vertices
   are kept so signatures/hashes verify and tail deps ground), but excluded from every
   active traversal, linearization, and replay; the synthetic cut vertex C (hash =
   descriptorDigest, deps = [], timestamp = cutTimestamp) is the sole active origin.
   `effectiveDeps(v)` maps deps that land in baked territory to C. C enters the
   frontier iff no retained active vertex exists; frontier maintenance, `createVertex`
   default parenting, and checkpoint selection operate on the **active** graph.
   Synthetic vertices are never serialized as ordinary signed vertices.
   **Cache/structure enumeration** (complete, superseding v2's "six structures"):
   vertices, forwardEdges, vertexDistances, reachablePredecessors + topoSortedIndex +
   currentBitsetSize, finality states, state snapshots, applier checkpoints, frontier,
   effective-edge index, per-epoch pinned signer-key maps (retained), ejection/invalid
   buffers (reset), sync inventory source (`getAllVertices` consumers).
8. **Prune** (per-replica, only after durable persistence): delete baked entries from
   all structures above; rebuild bitsets over the active subgraph; replace
   `pruneSnapshots`' insertion-order indexing with active-membership.
9. **Hard guards**: post-prune, unmediated raw-dependency traversal that leaves the
   active graph **throws** — but traversal through the effective-edge mapping is the
   sanctioned path (v2's blanket "every path touching a covered hash throws"
   contradicted the mapping; the guard applies to *unmediated* access only). The audit
   list (§1.3.3, §1.3.11-12) includes `dfsTopologicalSortIterative` itself, the
   linearizers' causality matrices, frontier maintenance, bitset build, and the three
   applier triage sites; a CI grep-gate keeps raw `.dependencies` traversal out of
   graph algorithms.

#### 2.5a The canonical replay function and the linearization-origin lemma

Round 2 (finding 7) and round 3 (A3) exposed that "replay" is not yet one thing:

- **One canonical replay function**, used by live insertion, merge reconstruction,
  fold, retained-tail replay, cold join, and the reference model. Semantics: writer
  permission is validated **at each vertex's causal position** (as live insertion does
  today via LCA-state reconstruction, `drp-applier.ts:369-408,518-529`), then ops apply
  in linearized order with no re-check (as `applyVertices` does, `:660-669`). The
  current merge-reconstruction path (all-ACL-then-all-DRP, no permission checks,
  `:265-275`) must be brought to this function in Phase 0 — the two paths differ today
  and any digest agreement requires exactly one definition.
- **The origin lemma (proof obligation)**: I2 requires that linearizing the admissible
  tail from the synthetic cut vertex equals linearizing it from genesis/any checkpoint
  head. Linearization is DFS reverse-post-order over hash-sorted forward edges
  (`hashgraph/index.ts:274-332`) — origin- and edge-structure-sensitive. Kimi
  hand-traced a divergence: with a vertex whose deps are **not an antichain** (e.g.
  d → {b, h₁} where b ≻ h₁), tail orderings from different origins differ on
  concurrent vertices, and order-mutating semantics diverge. Such deps cannot arise
  from default parenting (frontier antichains, `hashgraph/index.ts:226`) but the
  public `createVertex(operation, dependencies, timestamp)` accepts arbitrary deps —
  a byzantine writer can mint the configuration, and a **pruned replica has no
  genesis fallback** (`getReplay` throws, `drp-applier.ts:426`).
  Resolution: **enforce the antichain-dependency invariant at admission** (a vertex
  whose deps are mutually causally related is invalid — checkable with existing
  causality machinery), and carry the lemma *barrier + antichain deps ⟹
  origin-independent suffix linearization* as an explicit obligation: proved in the
  design review or, failing that, enforced empirically by the grounding-invariance
  tests (§5.1 I2) before any prune ships.
- **DFS hygiene**: fix the in-place `.sort()` during reads (`:318`) and the
  double-emission → `result[0] = origin` overwrite hazard (`:329`); the suite-wide
  invariant `|linearized| == |subgraph| − 1` with no duplicates pins both.

### 2.6 Admission after the cut

Cut-aware triage — identical on every admission-enforcing replica, applied at **all
three** raw-dep triage sites (§1.3.12):

- dep in the active graph (incl. F, C) → validate as today (dep-relative timestamps;
  no cutTimestamp floor).
- dep covered (behind the cut) → **`BehindSealedCutError`, terminal**. Every upgraded
  replica **must retain the covered-hash set** (per-epoch sorted segments, 32B per
  pruned vertex — priced in §2.9): round 2 and round 3 both showed that optional
  retention + peer-supplied Merkle proofs makes admission an *availability* question
  (a compacted replica with no proof source classifies 'missing' where a full replica
  says 'terminal' — an I3 violation) and that a proof can't even exist for deps that
  were *ejected* rather than covered. Merkle proofs remain for cross-replica
  cross-checks and joiner audits, not as the local oracle.
- dep unknown, not covered → **pending, indefinitely, and pending is not a semantic
  class**. Round 4 disproved v3's `unresolvable-dep` terminal-after-bounded-retry:
  "a genuinely admissible dep is obtainable from any honest peer" conflates
  *eventually* obtainable with obtainable-within-a-local-retry-bound. Counterexample:
  admissible post-cut x with child y → x; replica A receives x then y and applies
  both; replica B receives y first, x is delayed past B's retries, B parks y
  terminally — then x arrives. A applied y, B permanently didn't: divergence from
  delivery schedule alone. (The existing retry machinery is keyed by
  (objectId, sender) with local-time cooldowns, `handlers.ts:73-102` — operational
  state that can never carry admission semantics.) Corrected rule:
  **terminal rejection requires an objective, durable witness** — covered-hash
  membership, deterministic invalidity of a *supplied* dependency, or a supplied
  ancestry proof of non-descent from F (a presenter wanting a terminal answer must
  include the dependency cone; absence alone never produces one). A vertex is
  **applied** only when its full authenticated causal cone down to F/active territory
  is present and valid. Everything else is pending: memory and retry budgets are
  bounded operationally (eviction, cooldowns), but eviction never becomes a
  classification — a re-presented pending vertex with its cone is evaluated fresh.
  Semantic classes are exactly {applied, terminal-with-witness}; both are
  schedule-independent, which is what I3 actually asserts.

Timestamp rule (replacing v2's floor): admission timestamp checks are dep-relative
against retained deps plus the future bound — and the future-clock bound becomes a
**quarantine** (revalidate later), never permanent invalidity, fixing §1.3.7's
wall-clock nondeterminism. Implementation note (round 4): `InvalidTimestampError`
today lands in the permanent invalid set (`drp-applier.ts:209,229-232`); the fix must
split future-clock quarantine from deterministic dep-relative timestamp failure — only
the latter is terminal. All three triage sites (§1.3.12) call **one central
classifier** rather than reproducing cut logic independently.

Application-exception rule: typed deterministic rejections (permission denied,
validation) classify the vertex invalid; untyped exceptions halt-and-alarm the replica.
The Phase-0 triage fix explicitly includes `validateWriterPermission`
(`drp-applier.ts:527` — currently an untyped batch-abort) and makes merge application
batch-atomic (graph insertion and state adoption must not be separable by a mid-batch
throw, §1.3.6).

### 2.7 Vertex lifecycle relative to cut e

Before commit: accepted as today. At commit: in `closure(F)` → folded; not admissible →
ejected. After commit: not descending from every head of F → terminal.

Replicas do **not** produce identical classification *histories* (transient-apply vs
immediate-reject vs never-saw); the invariants are identical final state and identical
response to any future presentation.

### 2.8 Cold-joiner bootstrap

Joiner derives genesis ACL from the room id, then via chunked `CUT_FETCH`/`CUT_CHUNK`
(§2.9 transport): (1) the descriptor chain from the creator-signed cut-0 through cut e
(historical epochs verified by certificate per §2.3's epoch-relative evidence rule);
(2) per-epoch ACL vertices + committed `aclLinearization`, replayed **in committed
order with no permission re-checks** — this is the specification round 3 (A4) demanded:
live semantics validate at causal position and apply without re-check, so prefix-order
re-checking would diverge (e.g. a causally-valid `setKey` racing a revoke that
linearizes earlier); the joiner therefore applies exactly the committed sequence, and
causal-position validity of ACL ops is part of the quorum trust (T5, §2.3); (3) the
base-state blob, digest-checked; (4) the tail via SYNC. Adoption passes a gate that
covers **both** ACL and DRP root state (closing §1.3.10's asymmetry) and extends —
never bypasses — the existing refusals. The FETCH_STATE fall-through
(`handlers.ts:183-185`) is fixed in the extended path.

**Freshness fails closed**: k-source cross-check of the latest descriptorDigest
(rendezvous records, invite-embedded digests); no independent source → join fails
(explicit override required). Residual: k colluding sources win (weak subjectivity, T8).

### 2.9 Sync, transport, storage, and honest cost accounting

Epoch-scoped sync is a **new message type** with `protocolVersion`
advertisement. Same-epoch peers tail-diff over the active graph; epoch-ahead responders
ship seal vertices; pre-cut requests get `behind-cut(e)` + covered-segment reference.

Transport: `/drp/message` does not negotiate over relayed circuits (libp2p default,
§1.4.4) — cut sync therefore runs after the WebRTC upgrade, **or** over a dedicated
limited-tolerant protocol registered with `runOnLimitedConnection` and designed for
budget death: reservation-lifetime budgets (128KB/2min) kill oversized transfers
mid-stream, so `CUT_CHUNK` must be independently resumable (content-addressed chunk
ids, re-dial-and-resume) — chunking alone is insufficient.

Storage: descriptor + blob + covered segments + vote store persist through
`DRPObjectStore` under content-addressed keys, write-new-then-delete-old. Durable
persistence is a hard prerequisite (votes §2.4.7, prune §2.5.8, transition journal
§2.5).

**Costs, stated exactly**: joiner = O(state + ACL history + descriptor chain + tail);
descriptor chain is O(#cuts) (grows with room lifetime — accepted, tiny per epoch);
every admission-enforcing replica retains covered segments = 32B × pruned vertices;
seal protocol adds per-epoch stability/fold compute — the fold is a replay of the
epoch's suffix (bounded by cut cadence), and stability tracking must be incremental
rather than the current invalidate-and-rebuild bitset pattern (§2.1). Compaction also
*shrinks* the per-probe amplification surface of the unbounded SYNC serve (§1.1).

### 2.10 Trigger policy

As v2: cadence-triggered epochs; heartbeat frontiers for idle rooms; prune is local,
post-commit, post-persistence; the admission rule — not pruning — is the semantics.

### 2.11 Rollout (five phases, corrected interop story)

Open admission means legacy binaries exist forever; every phase must be safe against
them (round 3, A5).

- **Phase F (forward-compat)**: (a) applier stores-never-dispatches system/unknown ops,
  stops NOP-drop and unknown-op batch aborts; (b) `protocolVersion` in `Message`;
  (c) **versioned gossip topic for system vertices** — legacy peers never subscribe,
  so ACK/seal traffic can never poison them, from the first ACK ever sent. The
  objectId-in-preimage change is **not** in Phase F (v2 was wrong to put it there — a
  new-preimage vertex is an `InvalidHashError` poison to every legacy peer, §1.3.1).
- **Phase 0 (standalone hardening, fixes live defects)**: canonical serialization +
  golden vectors (incl. `context` stripping from `stateFromDRP`); wholesale
  delete-then-restore adoption (I1 today); typed writer-permission rejection +
  batch-atomic merge; timestamp quarantine semantics; hard-fail guards; BLS PoP on
  setKey; `setDRPState` root guard; durable persistence layer; canonical replay
  unification (§2.5a).
- **Phase 1 (advisory cuts)**: seal protocol live on the versioned topic; descriptors
  minted and gossiped; nothing pruned; admission unchanged; joiners MAY bootstrap from
  cuts with full-sync fallback. Soak metric: fleet-wide fold-digest agreement.
- **Phase 2 (semantics switch — a deliberate hard fork per room)**: quorum-committed
  `ruleActiveFromEpoch`; **the objectId-preimage cutover rides the same activation**:
  after the committed cutover epoch, legacy-preimage vertices are rejected; pre-cutover
  history is grandfathered as-is (auditing it is O6). Upgraded peers refuse
  state-changing sync with non-advertising peers; archival replicas bridge legacy
  peers read-only (they never prune and never forward system vertices to them).
- **Phase 3 (prune)**: per-replica opt-in.

---

## 3. Invariants

- **I1 — Fold determinism**: `fold(closure(F))` is a pure function of `closure(F)` via
  the canonical replay function: identical canonical bytes on every replica, for every
  semantics, independent of arrival order, local extras, or observation time.
- **I2 — Cut-suffix equivalence**: for any committed cut and admissible suffix T:
  `state(fold(closure(F)) + T) == state(canonical replay of closure(F) ∪ T from
  genesis)`. Rests on the **origin lemma** (§2.5a) — enforced by the antichain
  admission rule and pinned by grounding-invariance tests. (Comparison against a
  no-cut replica that accepted ejected stragglers remains a deleted false property.)
- **I3 — Admission agreement**: the two semantic classes — applied, and
  terminal-with-witness — are pure functions of (committed cut chain, vertex,
  supplied causal cone): identical on compacted, full, and joined replicas,
  independent of delivery order, prune status, buffer contents, and data availability
  (mandatory covered segments; witness-based terminal rule §2.6). Pending is not a
  semantic class; classification *histories* may differ; applied-state never does.
- **I4 — Cut uniqueness & chain linearity** (scoped to epochs ≥ 1; cut 0 assumes a
  non-equivocating creator, §2.2): with <1/3 of S_e byzantine, value-bound votes,
  monotone round records, and single signer authority, at most one (F, D) commits per
  epoch (§2.4); committed cuts form one chain with strict closure growth and each
  descriptor carries its predecessor's commit-evidence witness; double-certification
  is an attributable fork alarm.
- **I5 — Causal barrier & closure**: committed frontiers are valid antichains
  descending from their predecessors; post-commit every admissible vertex descends from
  every head of F; the active graph is always dependency-closed under effective edges;
  **all vertex dependencies are antichains** (admission-enforced).
- **I6 — ACL soundness**: writer-permission outcomes for folded vertices equal
  canonical causally-positioned outcomes; S_e derives only from cut-(e−1) state;
  ACL ops concurrent with a seal cannot alter its quorum; joiner ACL replay in
  committed order reproduces exactly the signer sets and key maps full replicas hold.
- **I7 — Authority soundness**: certificates verify only against signer sets derived by
  replaying individually authenticated ACL vertices in committed order from
  creator-derived genesis (via the creator-signed cut-0); no network state adopted
  without local recomputation or digest match; domain separation for descriptors,
  seal messages, and (post-cutover) vertex preimages.
- **I8 — Fail-safe liveness**: seal failures (silent signers, censoring/equivocating
  proposers, partitions, sub-floor rooms) yield only log growth — never divergence,
  wrong ejection, pruning, or a **bricked epoch** (locks release via higher-round QCs;
  the only permanent stall is ≥1/3 of S_e silent, T7). Digest mismatch or untyped fold
  exception halts loudly.
- **I9 — Loud degradation**: unmediated raw-dependency traversal beyond the active
  graph throws; effective-edge-mediated traversal is the sanctioned path; no silent
  conflict-resolution divergence is reachable.
- **I10 — Re-presentation determinism**: re-delivery of any folded, ejected, or pruned
  vertex is a no-op/terminal-with-witness everywhere, independent of bounded-buffer
  state (including the invalid-set FIFO, §1.3.7); a re-presented **pending** vertex
  with its causal cone is evaluated fresh (applied or witness-terminal — never
  rejected on the memory of an evicted buffer); a validly rebased re-mint (authorized
  at its new position, application-valid) is accepted everywhere.
- **I11 — Prune completeness/safety**: pruning removes only baked territory; afterward
  no enumerated structure (§2.5.7 list) holds baked entries beyond F's retained wire
  forms and C; retained data suffices for every future admission decision and joiner.
- **I12 — Descriptor determinism & domain separation**: independent replicas holding
  `closure(F)` compute identical descriptorDigest; no cross-room/context replay.

---

## 4. Byzantine threat analysis

Model: open admission; unbounded byzantine non-signers; <1/3 byzantine signers per
epoch; atomic durable vote stores with single signer authority per key; all vertices
author-signed.

- **T1 Forged cuts** — require a quorum of S_e, derived independently from
  creator-rooted ACL replay anchored at the creator-signed cut-0.
- **T2 Withheld concurrent vertex** — terminally rejected everywhere post-commit;
  transient appliers eject at fold; converted into bounded rebase cost. Includes
  **timed-release stragglers** (far-future timestamps, §1.3.7): post-commit they fail
  descent regardless of clock; pre-commit the quarantine rule keeps invalid-sets
  deterministic.
- **T3 Equivocation** — twin vertices/double votes are attributable; honest-crash
  double votes prevented by the atomic vote store; cross-round double-prepare
  constrained by the lock rule.
- **T4 Byzantine proposer** — bogus proposals get no prepares; **two valid competing
  proposals** (the v2 killer) waste at most rounds: locks + value adoption prevent both
  bricking and forking; censoring proposals are T6.
- **T5 Quorum collusion (≥2/3 of S_e)** — residual trust boundary: false digest,
  censoring frontier, malicious `aclLinearization` **including causally-invalid ACL ops
  smuggled in committed order** (this trust is explicit; joiners cannot check causal
  position from the artifact). Archival replicas detect at fold and publish fraud
  proofs (descriptor + claimed digest + replay transcript hash); cold joiners under
  full eclipse adopt the false state — no new trust root beyond creator-derived ACL,
  but load-bearing for history. Mitigations: archival tier, fail-closed k-source
  freshness, invite digests.
- **T6 Censorship by non-maximal proposer** — accepted and bounded: ejected authors are
  notified and rebase; persistent censorship is visible and rotatable. No maximality
  claim anywhere (including the TLA model).
- **T7 Permanent stall & permanent seats** — ≥1/3 of S_e permanently silent stalls
  cuts forever (fail-safe: room works, log grows); admins are irrevocable
  (`acl/index.ts:121`), so a compromised admin key is a permanent seat. Recovery
  (admin-quorum recovery cut, or ACL admin-revocation/key-rotation semantics) is open
  question O3 and needs its own review round. The epoch-1 degeneracy is resolved by the
  creator-signed cut-0 (§2.2); rooms without a bootstrap simply never cut.
- **T8 Long-range/stale-cut attacks** — weak subjectivity; fail-closed freshness;
  documented residual.
- **T9 Cross-object replay** — descriptor and seal-message domain tags now; vertex
  preimage cutover at Phase 2 (§2.11). **Until that cutover the §1.3.1 hole is open —
  it is open today regardless.**
- **T10 Poison vertices** — typed rejections fold deterministically (incl. writer
  permission, once typed); untyped exceptions halt loudly.
- **T11 Transfer resource attacks** — chunked, size-capped, resumable CUT_FETCH;
  compaction shrinks the unbounded-SYNC amplification surface.

---

## 5. Validation plan

Harnesses: **tier 1** — homegrown seeded property harness
(`packages/test-utils/src/property-harness.ts`; *fast-check is not in this repo*),
replica seam `packages/object/tests/proptest/replicas.ts:16`, checkpoint template
`convergence.test.ts:95-142`. **tier 2** — real-libp2p cluster
(`packages/node/tests/proptest/spawn.ts`) + mocked-network protocol tests. **tier 3** —
Playwright e2e. Plus exhaustive small-model checking, fuzzing, crash injection.

### 5.0 Prerequisites (block everything else)

- **P0-a Canonical serialization (I1, I12)**: byte-equal digests across arrival and
  Map/Set insertion orders; adversarial value domain (−0, NaN, ±Infinity, undefined,
  BigInt, Dates, typed arrays, cycles → typed reject); **`context`/`caller` stripped
  from snapshot digests** (`state.ts:184-193`); **phantom-delete digest case**
  (delete-then-checkpoint ≡ fold-from-genesis); **both wire stacks** (protobuf
  `google.protobuf.Value` and the msgpack ext codec); golden vectors committed to CI
  and round-tripped on every supported runtime (Node + browser engines).
- **P0-b Compaction-aware convergence oracle**: boundary-aware `assertConverged`
  variant (existing one compares full vertex sets + genesis oplogs,
  `property-harness.ts:188-238`); non-vacuity proven via deliberate bias in
  `mutation-check.test.ts`.
- **P0-c Independent reference model**: separately implemented immutable model (signed
  deps, committed-cut chain, active/archival graphs, causal ACL validation, per-vertex
  final classification) as the differential oracle — **explicitly implementing the
  origin-lemma question independently** (if the model shares the implementation's
  "origin doesn't matter" assumption, the A3 blind spot stays green).
- **P0-d Byzantine replica roles** in both simulators: withholding writer, equivocator
  (incl. **valid-proposal equivocation**), silent signer, censoring proposer,
  poison-vertex author, forged-snapshot server, timed-release author.

### 5.1 Per-invariant matrix

| Invariant | Tests | Harness |
|---|---|---|
| I1 | P0-a; descriptor determinism across delivery orders; **fold ≡ live-path construction** on the canonical replay function; **merge-reconstruction ≡ insertion-time semantics** (pins the Phase-0 unification, §2.5a) | unit |
| I2 | Replay-equivalence property under hostile delivery (dup/loss/delay/tied timestamps), cut cadence ≈24 forcing 3+ seals, random prune subsets, both semantics incl. Swap, straddlers against multi-head frontiers, creator-only and multi-admin rooms, vs the P0-c model. **Origin-lemma suite (A3)**: unit tests minting non-antichain-dep vertices via public `createVertex` — assert rejected at admission; grounding-invariance metamorphic property (same graph replayed grounded at genesis vs every committed cut → identical states); suite-wide `|linearized| == |subgraph|−1` + no-duplicate assertion (pins the `result[0]` overwrite, `hashgraph/index.ts:329`) | tier-1 + unit |
| I2 (algebra) | Fold idempotence; merge-commutation **restricted to the same committed cut and an admissible ancestry-closed suffix**; chain composition; observer independence; garbage invariance | tier-1 |
| I3, I10 | Ejection agreement (pre-commit / post-commit / rule-active-full / never-saw all converge; re-delivery no-ops; **qualified** rebased re-mint accepted); buffer-eviction incl. the **invalid-set FIFO flip** (§1.3.7); **covered-data-unavailability test (A2)**: compacted replica + no reachable proof source presented a behind-cut straggler responds identically to a full replica (forces mandatory segments); **delayed-admissible-dep convergence (round 4)**: admissible x with child y, x delayed past every retry bound on replica B while A applies both — B stays pending and applies on x's eventual arrival; no schedule ever yields divergent applied sets; **witness-terminal tests**: terminal only with covered membership / supplied-dep invalidity / supplied non-descent proof (incl. the ejected-ancestor case y→{x,F} once x's cone is supplied); pending vertices evicted and re-presented with their cone evaluate fresh; all three applier triage sites route through the central classifier (redelivered pre-cut vertex post-prune at `drp-applier.ts:206-208,241-243` never loops) | tier-1 + P0-d + tier-2 |
| I4 | Two-phase state machine table: propose validation (stability, lineage, frontier canonicality incl. antichain/duplicates/empty, digest, **transitive seal ancestry**, **commit-evidence witness for the prior epoch**, QC justification/value adoption); lock/unlock-on-higher-QC; prepare/commit counting vs pinned S_e restricted to counted (transitively descending, authenticated) vertices; **retroactive-commit fork regression (round 4)**: the n=4 A/B/C+byzantine late-prepare-QC scenario — monotone `enteredRound` blocks the second commit; **epoch-bricking regressions**: n=4 partial-quorum lock recovers in a later round; valid-proposal equivocation cannot brick or fork; **seal-ancestry ejection case**: a prepare parented to miss one head of F is not counted and cannot be ejected by its own cut; crash-at-every-boundary double-vote with **separate phase records** (prepare/commit/round/lock/QC) and verbatim re-broadcast after restart; concurrent-tab vote race; **pacemaker**: future-round vertex triggers catch-up, never a retro-vote; byzantine DAG-progress inflation cannot force premature rotation; **small-quorum**: exhaustive n=3 fork demo + activation-floor refusal; **multi-epoch evidence**: joiner verifies historical epochs by certificate, tip epoch by DAG commits, and a proposed F_{e+1} lacking the epoch-e witness is invalid; **cut-0 equivocation**: two creator-signed bootstrap descriptors → joiners with pinned digests refuse the unpinned chain | unit + tier-1 + exhaustive |
| I4, I8 (design) | TLA+/explicit-state model of the **two-phase** seal protocol (n=4..5, 1 byzantine incl. valid-equivocation, 1 joiner): ≤1 commit per epoch; refinement; **liveness under partial synchrony + honest-proposer-round fairness** (now a true property; v2's was false); no maximality assertion. TLC traces exported as vitest regressions. Exhaustive TS enumeration ≤8 vertices incl. tainted-closure and antichain-violation cases, vs P0-c | model |
| I5 | Committed frontiers satisfy barrier + canonicality; non-barrier/non-antichain proposes get no prepares; active graph dependency-closed after every commit — **with per-seed ejection counters reported** so the check can't pass vacuously | tier-1 |
| I6 | ACL-straddle suite (grant/revoke vs F, revoked-writer straddler, post-commit writer with pre-cut parents, RevokeWins split, signer granted at e can't vote at e, privilege-resurrection via ejected grant); **aclLinearization semantics (A4)**: causally-valid-but-prefix-invalid op (setKey racing an earlier-linearized revoke) — joiner state ≡ live state, pinned to no-recheck replay; tamper (reorder/omit) fails; **signer-side refusal** of an internally inconsistent proposed ACL order | tier-1 + unit |
| I7 | Certificate matrix (sub-quorum, evicted signer, skipped epoch, wrong object/epoch/round, tampered digest); **cross-room ACL replay at node level with real signatures — post-cutover rejects; pre-cutover documented-vulnerable (no false "pre-Phase-F rejects" claim)**; forged-snapshot suite vs a real joiner; fail-closed freshness policy; BLS key-registration matrix vs the herumi backend; **historical key-map pinning** (rotated setKey across epochs → old ack shares verify against the epoch's pinned map) | unit + tier-2 through node auth |
| I8 | Liveness/byzantine sim: silent non-signer never delays; silent ≥1/3 stalls fail-safe forever; censoring proposer bounded by rotation; typed poison folds deterministically; **untyped-exception split** (typed converges; untyped halts one replica without divergent commit); digest mismatch halts; **B1 batch-desync regression**: same batch in different delivery groupings with a mid-batch untyped writer throw — graph and state never observably diverge (pins the Phase-0 atomicity fix) | tier-1 + P0-d |
| I9 | Hard-fail units: **unmediated** raw traversal beyond the active graph throws; effective-edge-mediated paths succeed; enumerated-site instrumentation (incl. DFS sort, causality matrices, frontier maintenance, all three triage sites) asserted unreachable suite-wide; CI grep-gate | unit + suite-wide |
| I10, I11 | Prune consistency over the **full** structure enumeration (§2.5.7); `getReplay` grounds at C; boundary-wire verification (serialize/restart, re-verify all hashes/signatures, **re-insertion through a dedupe gate** — `addVertex` is not idempotent, §1.3.11); root/index audit after 3 cuts vs P0-c; rollback-deletion (top-level field, nested map, array, Set — absence included); **timestamp-skew determinism (B2)**: fixed clock offsets across sim replicas → identical invalid/quarantine sets and folds; timed-release straggler vs committed cut | unit + tier-2 |
| I12 | Golden vectors across versions and runtimes; cross-room/context replay of descriptors, votes, and (post-cutover) vertices fails | unit/CI |

### 5.2 Integration, e2e, non-functional

- **Join-from-cut cluster** (tier-2): commits on a live cluster; kill all but one
  compacted replica; fresh node with only the room id **plus an invite-pinned digest**
  (reconciling the test with fail-closed freshness — without an independent source the
  join must refuse, which is its own assertion) verifies chain + ACL replay + digest +
  tail. Byte gate = the exact §2.9 formula (state + ACL history + descriptors +
  covered segments + tail). Mixed fleet 2 full + 2 compacted + 1 joiner; **quorum
  hosts explicitly enumerated as ≥4 distinct signer identities with independent vote
  stores** (v2's "{A,B} hold quorum" contradicted the floor).
- **Partition/fold race**: quorum side commits+folds+prunes; partitioned side
  accumulates straddlers; heal → ejection + rebase convergence.
- **Mixed-version interop** (process-level, real old binary): (a) Phase-F peer vs
  legacy — legacy **never receives system vertices** (versioned topic) and never
  poisons its invalid-set (no new-preimage vertices exist yet); (b) advisory-cut
  fleet vs legacy — full interop *because* system traffic is segregated (v2's version
  of this test was a false target); (c) rule-active vs legacy — loud refusal,
  read-only archival bridge works; (d) post-cutover — legacy-preimage vertices
  rejected, grandfathered history intact.
- **Transition crash injection**: kill between **every step of the §2.5 transition**
  (fold / eject / tail replay / root swap / per-structure prune), not just at storage
  boundaries; restart lands in clean pre- or post-transition state; two tabs
  compacting concurrently.
- **Relay/limited-transport e2e**: joiner behind a relayed circuit — assert `CUT_FETCH`
  **defers to WebRTC upgrade** (or, if the limited-tolerant protocol ships, that
  mid-stream budget death resumes correctly after re-dial); *not* a per-frame size
  assertion (§1.4.4 — the budgets are reservation-lifetime).
- **Fuzz**: structure-aware mutation of descriptors/blobs/chunk streams through the
  full adopt path; oversized/duplicate/out-of-order chunks.
- **Fraud-proof round trip**: colluding quorum certifies a false digest; archival
  replica publishes the specified proof; third replica verifies mechanically. Publish
  surface ships with Phase 1.
- **Complexity accounting**: 1k/10k/100k histories, fixed state+tail; joiner bytes and
  **seal-protocol compute** (stability tracking must not regress to O(V²)-per-vertex
  bitset rebuilds) meet stated slopes.
- **Seed ratchet**: every shrunk failing seed committed and replayed forever.

---

## 6. Open questions, ranked

1. **Canonical serialization across engines/versions** — encoding-version field;
   evolution story.
2. **The origin lemma** (§2.5a) — prove barrier + antichain ⟹ origin-independence, or
   accept test-only enforcement; decide before Phase 3.
3. **Permanent-stall recovery / admin revocation (T7)** — admin-quorum recovery cut vs
   ACL semantics change; needs its own adversarial round.
4. **ACL-history growth** — joiner cost keeps O(ACL history); compacting it requires
   trusting cut-asserted signer sets or threshold handoffs. Quantify when it bites.
5. **Archival-peer economics** — fraud-proofability needs ≥1 honest archival replica;
   no incentive/audit mechanism.
6. **Pre-cutover history audit** — grandfathered legacy-preimage ACL history remains
   replay-vulnerable across rooms until audited or re-anchored (§2.11 Phase 2).
7. **Ejection UX / rebase policy**; offline-first writers missing multiple epochs.
8. **Epoch cadence vs fold cost**; incremental stability tracking design (§2.1);
   full pacemaker parameterization (§2.4.9 — timeout schedule, round-change evidence
   format).
9. **Descriptor-chain growth** — O(#cuts) forever; checkpoint-of-checkpoints would
   reintroduce the circularity AEC avoids; accepted for now.
10. **Multi-device signers** — single-signer-authority is assumed (§2.4.7); relaxing it
    needs coordinated/HSM-backed vote storage.

---

## 7. Recommended build order

Phase F and Phase 0 first — they fix live defects (cross-room replay exposure, batch
desync, phantom deletes, wall-clock invalidity) and are valuable standalone. P0-a..d
are the first test work. The canonical replay function and reference model precede any
seal code; the two-phase seal protocol precedes any admission-rule code; nothing prunes
until the origin-lemma suite and transition crash injection are green.

---

## 8. Cross-check resolution ledger (cumulative)

### Round 1 → v2 (Codex r1 *flawed*; Grok *sound-with-fixes*)

| # | Finding | Resolution (v2, refined in v3) |
|---|---|---|
| 1 | Retained suffix not ancestry-closed; ejected-grant resurrection | Tainted forward-closure ejection §2.5.2 |
| 2 | Synthetic-root re-parenting vs dep-reading algorithms | Dual representation → v3 baked-set rule §2.5.7 + full audit list |
| 3 | Cross-room ACL replay | §1.3.1; cutover moved to Phase 2 in v3 (see r3-A5) |
| 4 | ACL sub-DAG not self-contained | `aclLinearization` §2.3; semantics completed in v3 (r3-A4) |
| 5 | Bootstrap cost overclaimed | Exact accounting §2.9; covered segments now mandatory (r2/r3) |
| 6 | Object.assign non-deletion | Wholesale replacement §2.5.4; promoted to Phase 0 in v3 (r3-B3) |
| 7 | I3/I10 overclaims; bounded buffers | Final-state invariants §2.7; buffers semantics-free; v3 adds invalid-set FIFO (r3-B2) |
| 8 | Missing retained-tail replay | Atomic transition §2.5.3 |
| 9 | Self-referential digest; cert/DAG evidence | Unsigned preimage; epoch-relative evidence rule (v3, r2-3) |
| 10 | No durable vote locks | Atomic durable vote store §2.4.7 (v3: put-if-absent + single-authority) |
| 11 | BLS rogue keys / empty keys | PoP + validation + floor §2.2 |
| 12 | Liveness circularity; skip-epoch; view-dependent timeout | v3: two-phase protocol with value adoption §2.4 (v2's intra-epoch rounds alone were insufficient — r2-4/r3-A1) |
| 13 | NOP-drop / unknown-op poison; no protocol version | Phase F §2.11; v3 adds versioned system topic (r3-A5) |
| 14 | False properties (cut-placement invariance; identical ejected sets; deterministic untyped rejection); non-independent oracle; node-auth bypass | Deleted/rewritten; P0-c; tier-2 auth tests |
| 15 | Fold ≠ live path; msgpack canonicality; maximality; small quorums; overlap-discard aggregation; fail-open freshness; Phase-2 hard fork | Canonical replay §2.5a; P0-a; T6 decision; floor §2.2; vote-share plumbing §2.3; fail-closed §2.8; named hard fork §2.11 |

### Round 2 (Codex re-review of v2 — *flawed*) → v3

| # | Finding | Resolution |
|---|---|---|
| 1 | **Epoch 1 impossible** (genesis ACL = creator, empty key, floor unreachable) | Creator-signed cut-0 bootstrap descriptor §2.2 |
| 2 | **Merkle proofs ≠ deterministic admission** (ejected deps have no proof; availability-dependent) | Mandatory covered segments + `unresolvable-dep` terminal parking §2.6 |
| 3 | **Old ACK vertices pruned** → historical certs unverifiable under the DAG-evidence rule | Epoch-relative commit evidence §2.3 |
| 4 | **Byzantine proposer splits vote locks permanently** | Two-phase locked protocol with value adoption §2.4 |
| 5 | Vote persistence needs atomic single-writer semantics | put-if-absent store + single-signer-authority assumption §2.4.7, O10 |
| 6 | cutTimestamp floor → delivery-order disagreement | Floor removed; dep-relative only §2.3/§2.6 |
| 7 | Tail authorization internally inconsistent (live split-apply vs causal recheck) | One canonical replay function §2.5a; Phase-0 unification |
| 8 | Baked-boundary underspecified (F double-replay; caches) | Baked-set rule + full structure enumeration §2.5.7 |
| 9 | Dual-acceptance hash migration keeps replay open | Cutover rides Phase-2 activation; grandfathering = O6 §2.11 |
| 10 | Frontier/Merkle canonicality unspecified | §2.3 frontier validation + Merkle encoding rules |
| — | Validation-plan false/contradictory properties (n=3 model, liveness claim, unqualified re-mint, blanket throws, impossible pre-Phase-F test, freshness-vs-join conflict, quorum hosts, tamper-test triviality, unrestricted commutation, missing counterexample tests) | All corrected in §5 (see matrix rows) |

### Round 3 (Kimi k3 fresh review of v2 — *sound-with-fixes*) → v3

| # | Finding | Resolution |
|---|---|---|
| A1 | Vote locks + rounds + view-dependence brick epochs (even all-honest) | Two-phase protocol §2.4 (converges with r2-4); bricking regressions in §5.1 I4 |
| A2 | I3 availability-dependence; two extra raw-dep triage sites | Mandatory segments §2.6; all three sites routed §1.3.12; unavailability test |
| A3 | **Origin lemma unproven**; byzantine non-antichain deps reach divergence; `result[0]` overwrite hazard; DFS omitted from audit | Antichain admission rule + lemma obligation + DFS hygiene §2.5a; grounding-invariance + count/no-dup tests; O2 |
| A4 | aclLinearization replay semantics unspecified; both naive choices wrong | No-recheck committed-order replay §2.8; causal-position trust stated in T5/§2.3; I6 tests |
| A5 | objectId preimage is a legacy-poisoning hard fork; Phase-1 ACKs poison legacy peers | Cutover moved to Phase 2; versioned system topic from first ACK §2.11; interop tests rewritten |
| A6 | Omitted audit sites (DFS, frontier, bitset/matrix skips, addVertex idempotency, getAllVertices, per-epoch key pinning); bitset activation cost | §1.3.3/11, §2.5.7 enumeration, §2.9 compute accounting, dedupe gate in I10 tests |
| B1 | Untyped writer-permission batch abort + graph/state desync | §1.3.6; Phase-0 typed + batch-atomic fix; I8 regression test |
| B2 | Wall-clock permanent invalidity; invalid-set FIFO flip; timed-release stragglers | Quarantine semantics §2.6; §1.3.7; I10/I11 skew tests; T2 |
| B3 | Phantom deletes break I1 today; `context` poisons digests | §1.3.4; Phase-0 promotion; P0-a scope |
| B4 | `setDRPState` has no root guard | §1.3.10; joiner gate covers DRP root §2.8 |
| B5 | Relay premise imprecise (verified v3: libp2p default gating is the mechanism; budgets are reservation-lifetime, not per-frame) | §1.4.4 restated; CUT_FETCH resume semantics §2.9; e2e assertion rewritten |
| B6 | FETCH_STATE fall-through; "synchronized" signal; finality denominator; key-rotation pinning | §1.3.11, §2.8, §1.3.9; historical key-map pinning §2.2 + I7 test |
| C1-11 | Validation gaps (origin-lemma tests, bricking tests, unavailability, ACL causal-validity, false interop target, wrong relay assertion, P0-a scope, batch-desync, timestamp determinism, transition-step crash injection, I5 vacuity) | All incorporated in §5 |

### Round 4 (Codex focused check of the v3 seal protocol and admission rule) → v3.1

| # | Finding | Resolution |
|---|---|---|
| S1 | **Retroactive-commit fork**: late prepare-QC + out-of-order DAG delivery lets an honest signer commit an old value after a newer one committed (seal: two committed values, all lock rules obeyed) | Monotone durable `enteredRound`, commit-only-in-current-round atomic transition, value-bound prepares naming digest + proposal hash §2.4.3-5 |
| S2 | Seal-parent rule (direct membership) lets counted seal vertices fail F-descent or ride equivocating ancestry — ejectable by their own cut | Transitive structural ancestry rule; only admitted, authenticated, distinct-signer, F-descending vertices are counted §2.4.7 |
| S3 | DAG→certificate evidence handoff unenforced (non-maximal F_{e+1} can eject epoch-e commit vertices) | Frontier validation requires a canonical quorum witness of prior-epoch commits, digest bound into descriptor e+1 §2.3 |
| S4 | Single put-if-absent store cannot represent two phases or serialize timeout-vs-QC races; regenerated votes after restart | Separate persisted prepare/commit/round/lock/QC records; verbatim re-broadcast §2.4.8 |
| S5 | "DAG-measured timeout" is not a pacemaker (byzantine progress inflation; fixed floor vs GST) | Pacemaker requirements specified: monotone timeouts, catch-up on future-round vertices, round-change evidence, rate-bounded progress signals §2.4.9; scoped liveness claim |
| S6 | Cut-0: "stable F₀" undefined (no pinned signer set yet); creator can equivocate two valid chains | Bootstrap is explicitly trusted (no stability predicate); non-equivocating-creator assumption stated; I4 scoped to epochs ≥1; external digest pinning as the cut-0 fork mitigation §2.2 |
| A1' | **`unresolvable-dep` terminal-after-bounded-retry is schedule-dependent** (admissible-but-delayed dep: one replica applies, another permanently parks — divergence from delivery schedule alone; retry state is (objectId, sender)-keyed operational state, `handlers.ts:73-102`) | Withdrawn. Semantic classes = {applied, terminal-with-witness}; pending is indefinite and non-semantic; terminal requires covered membership, supplied-dep invalidity, or supplied non-descent proof; eviction never classifies §2.6, I3, I10 |
| A2' | `InvalidTimestampError` is permanently recorded today (`drp-applier.ts:209,229-232`) — quarantine must be split from deterministic timestamp failure | §2.6 implementation note; central classifier for all three triage sites |
