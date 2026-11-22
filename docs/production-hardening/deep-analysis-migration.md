<prompt>
Do a deep comprehensive analysis on the library 
Faolain/ts-drp-1 which is a p2p database for multiplayer games specifically focusing on its data structure and how it fairs or compares to other CRDTs for the usecase of a p2p data structure. Compare it to other solutions that could be used as a backend such as yjs or automerge. Attached is a zip file of all the writings of the original creator of the topology / drp library which you can mine for details / origin / references / inspirations or other papers. You can also see their original implementation using yjs as their crdt and their explanation of BFT.
</prompt>

<response>
# Deep analysis of `Faolain/ts-drp-1`

## Executive assessment

`ts-drp-1` is best understood as an **experimental programmable, signed, operation-DAG replicated state machine**, not as a conventional database and not quite as a normal CRDT library.

Its central idea is compelling:

> Rather than restricting developers to predefined CRDT maps, lists, sets, and registers, replicate signed method calls in a causal hash graph, deterministically resolve concurrent calls, and replay them through application-defined game logic.

That gives DRP capabilities Yjs and Automerge do not provide directly:

* Operations have cryptographically authenticated authors.
* The application can validate commands against their causal past.
* Concurrent operations can be reordered or discarded according to domain rules.
* The replicated unit can be a behavioral object—`move`, `damage`, `pickup`, `grant`, `collide`—rather than merely a shared JSON document.

The cost is that the application developer inherits much of the mathematical and systems work that a traditional CRDT implementation normally handles:

* Blueprint code must be perfectly deterministic.
* Conflict resolvers must be pure, terminating, and globally coherent.
* Every replica must run exactly the same code and genesis state.
* Late concurrent history can require rollback and replay.
* History, anti-entropy, and checkpointing become central scaling problems.
* Signed commands do not, by themselves, make game commands valid or cheat-proof.

The present repository also has several important implementation gaps: synchronization exchanges the complete vertex-hash inventory; joining replicas replay signed history rather than adopting certified snapshots; the object store is in memory; graph history is not compacted; conflict processing can become quadratic or worse; and the optional “finality” layer is an attestation mechanism rather than a complete BFT consensus protocol.

The repository itself warns that it is a fork undergoing restructuring and that its specifications are only now being written from the implementation.

**My practical conclusion:**

* **Yjs** is the strongest choice for browser-first live collaboration, chat, lobby state, level editing, shared UI, and small-room cooperative experiences.
* **Automerge** is the strongest of these three for durable, offline-first, JSON-like game state with a proper storage-and-network abstraction.
* **DRP** is the most interesting for signed, auditable, application-defined game commands, but it is presently a research-grade semantic command layer—not a production-ready replacement for either an authoritative game server or a durable database.
* A serious multiplayer game should normally use a **hybrid**: ephemeral networking for transforms and inputs, an authoritative or committee-based simulation for contentious actions, and a CRDT or DRP-style layer for durable low-frequency state.

This assessment is based on a static audit of the repository’s current main branch, the technically relevant documents from the attached author archive, primary CRDT/BFT literature, and official Yjs and Automerge materials. I was not able to rerun the repository’s benchmark suite in the execution environment, so performance conclusions below distinguish measured claims from complexity derived directly from the code.

---

# 1. Where DRP came from

The author’s writings show a fairly coherent evolution.

## 1.1 From on-chain games to local-first games

The early work came from experiments such as Isaac, Mumu, and Shoshin. The author became dissatisfied with using a blockchain’s globally ordered ledger as the execution substrate for interactive worlds: it provides strong serialization and verification, but at a latency and coordination cost that is poorly matched to real-time play.

The transition is described in the attached [From Isaac, Mumu, Shoshin, to CRDTs](sandbox:/mnt/data/topology_author_sources/From%20Isaac%2C%20Mumu%2C%20Shoshin%2C%20to%20CRDTs%20-%20guiltygyoza.pdf). The prototype moved toward local-first browser execution, peer-to-peer networking, CRDT replication, and eventually a causal hash graph.

## 1.2 The original Yjs game prototype

The attached [Super Mario in CRDT](sandbox:/mnt/data/topology_author_sources/Super%20Mario%20in%20CRDT%20-%20guiltygyoza.pdf), especially pp. 2–5, describes a browser multiplayer platformer built with:

* A `Y.Doc`.
* A `Y.Map` from player IDs to player state.
* A `Y.Array` for chat.
* Player records containing position, animation, overhead text, audio state, and a per-player “mailbox.”
* `y-webrtc` for replication.
* Phaser for rendering and physics.
* SimplePeer/WebRTC for voice.

The mailbox was a particularly interesting design. A peer generally owned its own state; when Alice computed a collision affecting Bob, she could not directly mutate Bob’s owned motion state, so she placed an impulse vector in Bob’s mailbox. Bob consumed that mailbox and applied the effect locally.

That approach reduced direct shared-write contention, but it exposed the core trust problem:

* A malicious Alice could insert arbitrary impulses into Bob’s mailbox.
* A malicious Bob could ignore an impulse.
* Players could teleport by writing impossible positions.
* Tick rates and wall-clock time could be manipulated.
* Nothing in Yjs understood that these fields represented physical claims.

The author explicitly recognized that the prototype was not Byzantine tolerant and lacked the application-level causal command history needed to validate such behavior; see p. 15 of [From Isaac, Mumu, Shoshin, to CRDTs](sandbox:/mnt/data/topology_author_sources/From%20Isaac%2C%20Mumu%2C%20Shoshin%2C%20to%20CRDTs%20-%20guiltygyoza.pdf).

There is an important nuance here. It would be incorrect to conclude that **Yjs itself has no causal machinery**. Yjs operations include per-client clocks and dependencies, and its encoded updates are commutative, associative, and idempotent. The real limitation was that the game exposed only replicated fields and mailboxes; it did not have a first-class, signed, application-command DAG that the physics rules could inspect. Yjs’s own documentation notes that its state vectors are used to determine missing structs, rather than being an application-facing causal-history API. ([docs.yjs.dev][1])

## 1.3 The research lineage

The subsequent DRP design combines ideas from several lines of work:

* Classical CRDTs and local-first software.
* Merkle-CRDTs: content-addressed events arranged in a Merkle-DAG.
* Kleppmann and Howard’s work on Byzantine-fault-tolerant CRDTs.
* Blocklace and signed hash-pointer partial orders.
* Event sourcing and deterministic replay.
* Threshold Logical Clocks as a possible security/finality clock.
* Rateless IBLTs for efficient set reconciliation.
* DAG-based consensus and mempool research.
* Provable or deterministic virtual machines.

The progression is most clearly visible in the attached [Topology protocol walkthrough](sandbox:/mnt/data/topology_author_sources/Topology%20protocol%20walkthrough%20-%20guiltygyoza.pdf) and [DRP whitepaper](sandbox:/mnt/data/topology_author_sources/drp-whitepaper.pdf).

The conceptual layers were intended to be:

1. Peer-to-peer messaging.
2. A causal hash graph.
3. Programmable replicated objects.
4. Optional finality or DAG consensus.
5. “RAM” nodes that retain snapshots and improve availability.

The attached [Introducing RAM to the World Computer](sandbox:/mnt/data/topology_author_sources/Introducing%20RAM%20to%20the%20World%20Computer.pdf) makes clear that “RAM” was intended as replicated, comparatively ephemeral state availability—not automatic permanent database durability.

---

# 2. What the current library actually is

A useful way to compare the systems is to separate five concerns that are often conflated:

| Concern               | `ts-drp-1`                                            | Yjs                                    | Automerge                                         |
| --------------------- | ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| Replication semantics | Programmable operation DAG and deterministic replay   | Built-in shared CRDT types             | Built-in JSON-like CRDT operations                |
| Anti-entropy          | Current implementation sends all vertex hashes        | State vectors and differential updates | Heads, have/need information, Bloom-assisted sync |
| Transport/discovery   | Bundled libp2p-based network and rendezvous machinery | Provider-specific                      | Adapter-specific through Automerge Repo           |
| Durability            | Current object store is in memory                     | Provider/persistence-specific          | Storage adapters are a first-class Repo concept   |
| Trust/security        | Signed authors, ACL, optional attestations            | Mostly external to core                | Mostly external to core                           |

This separation explains why comparisons based only on “which CRDT is faster” are incomplete. DRP includes more networking and identity machinery than Yjs or Automerge core, but it includes less durability and less mature synchronization.

## 2.1 The operation pipeline

At a high level, a local mutating method call follows this path:

```text
blueprint method call
        |
        v
{ drpType, methodName, arguments }
        |
        v
vertex {
  author,
  dependencies = current frontier,
  timestamp,
  operation,
  hash,
  signature
}
        |
        v
libp2p gossip / anti-entropy
        |
        v
signature + hash + dependency + ACL checks
        |
        v
deterministic DAG linearization
        |
        v
application conflict resolver:
Nop / Drop / Swap
        |
        v
replay blueprint from a saved checkpoint
        |
        v
materialized object state
```

Each vertex includes an author, operation, dependencies, timestamp, hash, and signature. A locally created vertex defaults to depending on the entire current frontier—the set of graph heads known by the local replica.

The graph maintains:

* `vertices: Map<Hash, Vertex>`
* A `frontier` array.
* Forward edges.
* Distance information for lowest-common-ancestor calculations.
* Optional reachability bitsets for causality tests.

A useful formalization is:

[
\text{State}(G)=
\operatorname{fold}
\left(
S_0,;
\operatorname{resolve}
\left(
\operatorname{toposort}(G)
\right)
\right)
]

where:

* (G) is the accepted vertex DAG.
* (S_0) is the genesis blueprint state.
* `toposort` produces a deterministic causal order.
* `resolve` drops or reorders concurrent operations.
* `fold` executes the remaining operations through the blueprint.

This is the essential difference from a normal operation-based CRDT. A conventional op-based CRDT is designed so that concurrent operations commute. DRP permits noncommuting operations, but tries to produce the same deterministic order and filtering decision on every replica.

That can converge—but only under a much stronger set of application assumptions.

---

# 3. The convergence contract

A standard Yjs or Automerge datatype gives the application a library-defined convergence contract. The application may still misuse the datatype, but it generally does not need to prove that list insertion, deletion, and map assignment converge.

With DRP, convergence is conditional on all of the following:

1. Every honest replica eventually obtains the same accepted vertex set.
2. Topological linearization is deterministic.
3. Every replica starts from exactly the same blueprint state.
4. Every replica runs exactly the same blueprint and resolver code.
5. Blueprint methods are deterministic functions of replicated state, author, and arguments.
6. Conflict resolvers are deterministic, pure, terminating, and independent of unreplicated local state.
7. Validation and ACL decisions are deterministic from the operation’s causal past.
8. Serialization and hashing agree across implementations.
9. Errors and invalid operations are classified identically.

The framework helps with the first two. Much of the rest is currently an application convention.

## 3.1 Pair conflict semantics

The pair-semantic implementation first computes a deterministic topological order. When it finds concurrent vertices, it invokes the blueprint resolver, which may:

* Keep both operations.
* Drop the left operation.
* Drop the right operation.
* Swap their positions.

The supplied `AddMulDRP` is a good illustration. Starting from 10, concurrent operations:

```text
add(5)
mul(2)
```

produce either 30 or 25 depending on order. The resolver swaps a `mul` followed by an `add`, imposing a canonical “adds before multiplies” policy.

This is more expressive than a fixed CRDT register. It lets the application define meaningful algebra over commands.

It also means the application is responsible for ensuring the rule is globally coherent. A resolver that creates cyclic precedence—A before B, B before C, and C before A—can produce pathological behavior. A resolver that reads local time, randomness, or an unreplicated cache can cause honest replicas to disagree.

## 3.2 Multiple-operation semantics

The multiple-semantic implementation identifies groups of mutually concurrent operations and allows the resolver to discard selected vertices.

This is potentially useful for game rules such as:

* Keep one of several concurrent claims on an item.
* Drop movement commands that exceed a shared resource budget.
* Select a deterministic winner from simultaneous actions.
* Reject a set of operations whose combined effect violates an invariant.

But the implementation supplies the mechanism, not the proof that a custom rule is permutation-invariant, safe under late arrival, or compositional with other rules.

## 3.3 Late history means rollback

Suppose a replica sees operations A and B, renders a state, and later receives C, which is concurrent with A and B. The conflict resolver may reorder or discard one of the previously visible operations.

That means DRP provides **optimistic local execution with eventual deterministic revision**, not stable real-time finality.

For games, the application must therefore be prepared for:

* Inventory items disappearing after reconciliation.
* A collision result being revised.
* A simultaneous pickup choosing a different winner.
* A player state being reconstructed from an older checkpoint.
* UI or animation compensating for a state rollback.

Yjs and Automerge can also reveal merged remote state after a partition, but their datatype semantics make the possible revisions substantially more constrained and predictable.

---

# 4. Important implementation findings

## 4.1 Object identity does not commit to the program

Current object IDs are of the form:

```text
<creatorPeerId>:<randomSalt>
```

The creator prefix lets every replica derive the same genesis ACL locally, and the implementation refuses to replace that ACL with an untrusted network snapshot. This is a valuable security improvement in the fork.

However, the audited identity and hash paths do **not** commit to:

* The blueprint source or bytecode hash.
* Blueprint semantic version.
* Resolver version.
* Schema version.
* Initial DRP state.
* Serialization version.

The root hash is a fixed constant, while the initial DRP state is constructed locally.

This means two honest peers can subscribe to the same object ID, accept the same signed graph, and still compute different state because one is running:

* A different blueprint release.
* A different constructor default.
* A different resolver.
* A platform-specific implementation.

For a programmable replicated state machine, this is a **foundational compatibility issue**. Yjs and Automerge reduce this risk by embedding the core merge semantics in a fixed document format. Application interpretation can still vary, but the underlying document convergence does not depend on arbitrary user code.

A production DRP object should commit to something like:

```text
objectId = hash(
  creator,
  salt,
  blueprintCodeHash,
  ABIHash,
  schemaVersion,
  genesisStateHash,
  runtimeVersion
)
```

## 4.2 Hashing is not canonically specified

The vertex hash is computed from:

```ts
JSON.stringify({ operation, deps, peerId, timestamp })
```

followed by SHA-256.

`JSON.stringify` is deterministic for a particular JavaScript value with a particular property insertion order, but it is not a robust cross-language canonical content-addressing format:

* Object property order can depend on how values were constructed.
* `NaN`, infinities, negative zero, sparse arrays, and non-JSON values have troublesome encodings.
* Dependency order is included even though dependencies are semantically a set.
* Different language implementations may not generate byte-identical JSON.
* Equivalent dependency sets in different orders produce different hashes.

The whitepaper imagines multi-language blueprints and potentially provable execution. That requires canonical serialization—such as a rigorously specified deterministic protobuf profile, canonical CBOR, or another byte-level canonical format—and sorted dependency hashes.

Dependency-order canonicalization would also prevent an authorized malicious writer from creating numerous distinct hashes by permuting the same semantic dependency set.

## 4.3 No explicit operation ABI is enforced in the audited path

Remote operations carry a string method name and arguments. Replay ultimately performs:

```ts
drp[method](...args)
```

after setting the caller context.

I did not find an explicit per-blueprint ABI allowlist or argument schema in the application path. Hash validation checks the hash, dependencies, and timestamp; it does not verify that the method is an authorized blueprint command.

This creates several risks:

* Unknown methods produce application exceptions.
* Query or inherited prototype methods may be invocable.
* Malformed argument combinations can cause deterministic or platform-specific errors.
* A method added in one version but absent in another can halt reconciliation.
* ACL objects rely on their methods to reject unauthorized callers rather than on an explicit operation capability table.

The merge loop treats application and resolver exceptions as potentially transient and rethrows them rather than permanently rejecting the vertex. A malicious authorized writer could therefore repeatedly send a validly signed operation that predictably throws, creating an availability problem.

A production implementation needs an explicit manifest:

```text
method ID
argument schema
return schema
maximum input size
required capability
determinism classification
gas/resource limit
```

## 4.4 Arbitrary JavaScript is the largest determinism risk

The runtime supports normal nested JavaScript objects, arrays, maps, sets, and dates. Method calls are intercepted through a proxy; methods beginning with `query_` and `resolveConflicts` bypass ordinary operation creation.

Nothing in the audited code prevents a blueprint from using:

* `Date.now()`.
* `Math.random()`.
* I/O or network responses.
* Locale-sensitive formatting.
* Unreplicated global variables.
* Platform-dependent floating-point behavior.
* A mutable singleton or cache.
* A supposedly read-only `query_` method that actually mutates state.

The query naming rule is a convention, not a capability boundary.

The whitepaper’s longer-term interest in bytecode, deterministic runtimes, or provable VMs is therefore not an optional optimization. It is required to turn the current “same JavaScript is expected to behave the same” convention into a protocol guarantee.

## 4.5 Concurrent local asynchronous calls can create same-author branches

The operation pipeline supports both synchronous and asynchronous handlers. It does not visibly serialize all local mutations through a per-object operation queue.

A plausible sequence is:

1. Local call A captures the current frontier.
2. A awaits an asynchronous blueprint operation.
3. Local call B starts and captures the same frontier.
4. Both eventually add vertices.

The same author has then created sibling vertices from the same causal state. That may be semantically permitted, but it resembles the same-author branching or equivocation shape discussed in the BFT literature.

At minimum, the library should either:

* Serialize local mutations.
* Assign an authenticated per-author sequence number.
* Explicitly define same-author concurrency.
* Detect accidental forks and distinguish them from malicious equivocation.

## 4.6 The supplied Set is not a conventional add-wins or observed-remove set

`SetDRP` is a normal JavaScript `Set` with `add` and `delete`, and no custom conflict resolver.

Concurrent add and delete therefore resolve according to deterministic topological replay rather than explicit OR-Set, add-wins, or remove-wins semantics.

That can still converge, but the semantic contract is less obvious. A user seeing “SetDRP” could reasonably assume a standard CRDT set design with explicit observed-remove metadata. It should instead be documented as a replay-ordered set.

## 4.7 The Map tie-breaker is weak

For concurrent sets to the same map key, `MapDRP` computes a custom 32-bit string hash over `JSON.stringify(value)` and compares the resulting hex strings.

This is deterministic in ordinary cases, but:

* It is not collision resistant.
* It is adversarially gameable.
* Negative and positive signed values produce unusual string ordering.
* A collision between unequal values falls back to ordinary replay order.
* The winning value is unrelated to author priority, causal validity, or gameplay policy.

A cryptographic hash with canonical serialization would be safer, though a gameplay-specific winner rule would usually be better still.

## 4.8 The ACL resolver conflates operations on different groups

The ACL conflict resolver distinguishes targets using the first argument—the peer ID—but it does not compare the permission group. Concurrent `grant(peer, Writer)` and `revoke(peer, Finality)` can therefore be treated as conflicting even though they modify separate permissions.

The ACL also currently prevents revocation from an existing administrator, making a compromised administrator effectively permanent.

Those are fixable implementation issues, but ACL behavior is security-critical enough that its state machine should be more formally specified and tested than an ordinary blueprint.

---

# 5. Storage, checkpoints, and replay

## 5.1 It is not currently a durable database

The node’s `DRPObjectStore` is a normal in-memory JavaScript `Map`.

The current protocol does not provide:

* Durable local object storage.
* A disk-backed change log.
* Backup or restore.
* Replication-factor guarantees.
* “Zero peers online” availability.
* An archival checkpoint service.
* Database indexing or query planning.
* Schema migration.

The whitepaper explicitly treats long-term persistence as outside the core protocol, while the current architecture notes acknowledge that zero-member durability is not solved. The current fork has put substantial effort into public rendezvous, Nostr-based discovery, delegated routing, and circuit relays, but its own architecture separates that control-plane work from unresolved data-plane scaling and durability.

This is an important distinction:

> Successfully getting two browsers behind NATs to discover each other and converge is not the same as supporting a long-lived, compact, durable game database.

## 5.2 State snapshots are replay accelerators, not compaction

The applier creates checkpoints, by default after a suffix of 256 vertices, and retains at most 32 checkpoint records. A checkpoint stores:

* The frontier at the checkpoint.
* A selected origin hash.
* Vertex count.
* A complete DRP state snapshot.
* A complete ACL state snapshot.

The checkpoint is used only when the new dependencies causally cover the saved frontier. A late operation branching before that frontier can invalidate its usefulness and force replay from an older checkpoint or the root.

The pruning code deletes old **state snapshots**, but it does not remove:

* Vertices.
* Forward edges.
* Distance metadata.
* Finality states.
* Hash inventory.

So checkpointing currently reduces some replay and snapshot memory, but does not bound database history.

## 5.3 Joiners replay the signed history

The current network state-response path deliberately refuses to adopt network-provided state snapshots. Genesis is derived locally, and state is reconstructed from signed vertices.

That is conservative and security-positive: an untrusted peer cannot simply hand a joiner a fabricated state.

But without a **certified checkpoint protocol**, the consequence is that a late joiner must obtain and replay the full retained history.

A production design needs a checkpoint that commits to:

```text
object ID
blueprint/runtime version
causal frontier
state root
ACL state
pruned-history epoch
signer set
threshold certificate
```

A joiner could then verify the certificate, adopt the checkpoint, and request only post-checkpoint vertices.

## 5.4 Full-state cloning is costly for large objects

State snapshots are made by enumerating object fields and deep-cloning their values. Reconstruction creates an object from its prototype and deep-clones the stored state back into it.

Even though mutation tracking avoids creating a vertex for an operation that makes no effective change, several execution paths still clone or snapshot complete object state.

For a materialized state of size (S), the cost of one semantic operation can therefore include work proportional to (S), even when the operation touches one small field.

This strongly favors:

* Small objects.
* Room or zone sharding.
* Entity-level partitioning.
* Coarse semantic operations.
* Persistent data structures or copy-on-write snapshots.

It strongly disfavors one enormous mutable world object.

---

# 6. Synchronization and scaling

This is the current implementation’s largest practical weakness.

## 6.1 Full hash inventory anti-entropy

Every synchronization request currently contains:

```ts
vertexHashes: object.vertices.map(v => v.hash)
```

The periodic synchronization code describes this explicitly as sending the complete local vertex-hash inventory, with (O(|V|)) cost.

The receiver compares the remote list against its own vertices, sends all locally missing vertices, and asks for hashes that it lacks.

Consequences:

* Every anti-entropy probe grows with complete object history.
* Even fully synchronized peers repeatedly exchange history-sized summaries.
* A long-lived object eventually spends more bandwidth describing old history than transmitting new operations.
* A late join receives complete missing vertices.
* There is no current protocol-level epoch or compact checkpoint boundary.

## 6.2 The current comparison path is worst-case quadratic

For each hash in the received inventory, the handler calls:

```ts
object.vertices.find(v => v.hash === h)
```

The `vertices` getter itself materializes all vertices as an array.

As written, comparing two inventories is therefore worst-case (O(V_\text{local}V_\text{remote})), with repeated array creation in the loop.

The graph already has a `Map<Hash, Vertex>`, so this should be a direct (O(1)) lookup per hash. Even after fixing that code path, however, the transmitted inventory remains (O(V)).

## 6.3 One hour of 60 Hz data is already untenable

Assume one mutating DRP method call per player per simulation tick at 60 Hz:

[
60 \times 3600 = 216{,}000
]

vertices per player per hour.

Every hash is a 64-character hexadecimal SHA-256 value. Ignoring protobuf field tags, envelopes, arrays, signatures, dependencies, and full vertices, a single complete hash inventory has this lower bound:

| Players | Vertices after one hour | Minimum raw hash characters per sync |
| ------: | ----------------------: | -----------------------------------: |
|       1 |                 216,000 |                              13.8 MB |
|       8 |               1,728,000 |                             110.6 MB |
|      10 |               2,160,000 |                             138.2 MB |
|      32 |               6,912,000 |                             442.4 MB |

That is **per full anti-entropy inventory**, not total session traffic.

The full missing vertices are larger because each includes:

* Operation type and arguments.
* Author.
* Timestamp.
* One or more dependency hashes.
* Signature.
* Protocol framing.

DRP should therefore never record ordinary player transforms, velocities, animation frames, or input samples as durable per-tick vertices in its current form.

The same warning applies to Yjs and Automerge documents: durable CRDT history is generally the wrong channel for 60 Hz simulation traffic. Their advantage is that they already expose more efficient delta protocols and have established patterns for separating ephemeral presence from durable document state.

## 6.4 Frontier width adds peer-count-dependent metadata

Every new DRP vertex references the complete current frontier. In a highly concurrent room, the frontier can contain a recent head from many active writers.

If the frontier width is (W), one operation carries (W) dependency hashes and vertex insertion requires work proportional to the dependency/frontier size.

For a small cooperative room this is reasonable. For a large, partitioned, or adversarially branch-heavy object, it increases both operation size and graph edge count.

Automerge changes also reference causal heads, but Automerge can batch multiple document operations into one change and has a mature heads-based sync protocol. DRP currently emits a vertex per intercepted mutating method call unless the application manually defines a coarse method that performs several mutations.

## 6.5 Conflict processing has poor worst cases

The pair-semantic linearizer builds a dense reachability matrix:

```text
number of rows = n
words per row = ceil(n / 32)
```

The raw matrix occupies approximately:

[
\frac{n^2}{8}\text{ bytes}
]

before other arrays and JavaScript object overhead.

Examples:

* (n=10{,}000): approximately 12.5 MB.
* (n=100{,}000): approximately 1.25 GB.

The pair scan is also quadratic for a highly concurrent suffix.

The multiple-operation implementation contains nested scans over:

1. Every anchor.
2. Every later candidate.
3. Every still-later vertex.
4. The growing set of concurrent operations.

By code inspection, contrived all-concurrent inputs can produce super-quadratic behavior, with a quartic worst-case shape.

Normal checkpoints may keep the active suffix small, but a malicious old-dependency branch or long partition can invalidate a recent checkpoint boundary and expose a much larger history to reconciliation.

## 6.6 The author had already identified the correct anti-entropy direction

The attached [Practical Rateless IBLT: Part 1](sandbox:/mnt/data/topology_author_sources/Practical%20Rateless%20IBLT_%20Part%201%20-%20guiltygyoza.pdf) explains why sending complete inventories is wasteful and proposes rateless invertible Bloom lookup tables for reconciling set differences without knowing the difference size in advance.

The primary RIBLT work reports near-optimal reconciliation across unknown set differences and meaningful communication and compute improvements over comparable non-rateless schemes. ([arXiv][2])

The current protobuf even contains a comment indicating that the vertex message was “supposed to be” related to the RIBLT work, but the implemented sync still sends the complete hash list.

A nearer-term alternative would be Automerge-like head synchronization:

1. Exchange current heads.
2. Traverse unknown dependencies.
3. Maintain per-peer known/shared heads.
4. Use Bloom or RIBLT summaries when histories have diverged substantially.
5. Fall back to a certified snapshot if the missing suffix is large.

## 6.7 The checked-in benchmarks do not establish game-scale performance

The throughput benchmark defaults to 1,000 operations and includes creation and merging of two objects.

The memory harness primarily tests 100, 1,000, and 3,000 vertices, with selected cases extended to 3,000.

Those are useful regression tests, but they do not answer the important multiplayer questions:

* One hour or 24 hours of history.
* 8, 32, or 128 simultaneous writers.
* Long partitions and rejoin.
* Branch spam.
* Late old-dependency operations.
* Join bandwidth and replay latency.
* Memory after millions of vertices.
* Comparison with equivalent Yjs and Automerge workloads.

I found no checked-in head-to-head Yjs/Automerge benchmark results.

---

# 7. Security and the BFT claim

## 7.1 What DRP currently protects well

The current fork has meaningful security improvements.

### Authenticated authorship

Incoming update and sync vertices are authenticated before merge. The code:

1. Requires a signature.
2. Recovers a secp256k1 public key from the signature.
3. Derives the corresponding libp2p Peer ID.
4. Requires it to match the claimed `vertex.peerId`.

Thus an attacker cannot simply claim that another player authored an operation.

### Content integrity

The vertex hash binds:

* Operation.
* Dependencies.
* Peer ID.
* Timestamp.

The merge validator recomputes the hash and rejects a mismatch.

### Causal dependency validation

A vertex is rejected when its dependencies are missing from the local graph, and child/dependency timestamps receive a limited consistency check.

### Creator-bound genesis authority

The object ID commits to the creator, and network snapshots cannot overwrite the locally derived genesis ACL.

### Application-level authorization

The ACL can distinguish administrators, writers, and finality signers. In permissionless mode any authenticated peer may write; in permissioned mode the causal ACL state determines whether the vertex author is a writer.

These are substantial advantages over vanilla Yjs and Automerge, neither of which gives every document operation a built-in cryptographically authenticated, ACL-validated author identity.

## 7.2 BFT convergence is not cheat prevention

The primary intellectual basis is Kleppmann and Howard’s “Making CRDTs Byzantine Fault Tolerant.” A signed hash graph can prevent a Byzantine replica from rewriting or forging another author’s history, while deterministic validation from causal history can allow honest replicas to converge despite Byzantine participants. ([martin.kleppmann.com][3])

But the guarantee is closer to **Byzantine eventual consistency** than to traditional BFT consensus.

It does not automatically provide:

* A single globally agreed real-time order.
* Immediate irreversible finality.
* Fair transaction ordering.
* Protection from denial-of-service or branch spam.
* Sybil-resistant resource admission.
* Correct game physics.
* Trusted wall-clock time.
* Hidden information.
* Prevention of collusion.
* Prevention of a player signing an invalid command as themselves.

A signature proves:

> “This peer authored these bytes.”

It does not prove:

> “This movement was physically possible,”
> “this player did not see a hidden card,” or
> “this client really waited 500 milliseconds.”

The BFT paper’s tolerance of arbitrary Sybil identities concerns convergence without an honest-majority identity assumption. It does not make bandwidth, CPU, storage, matchmaking, or game economics Sybil-proof.

## 7.3 Current timestamps do not solve game time

The timestamp validator rejects vertices more than 60 seconds in the future and constrains a child from being too far earlier than a dependency. Arbitrarily old branches are not generally forbidden.

An attacker can still:

* Reference an old causal point.
* Create a late concurrent branch.
* Force reconsideration of a large suffix.
* Claim an arbitrary plausible local timestamp.
* Manipulate its effective simulation tick rate.

Trusted game time requires something more:

* An authoritative referee.
* A committee clock.
* Signed tick beacons.
* Delay assumptions.
* Threshold Logical Clocks.
* A deterministic lockstep round protocol.
* Or rules that do not depend on real time.

The author’s own whitepaper identifies old/backdated dependencies as one of the hardest unresolved attacks and discusses logical-clock/finality mechanisms as future work.

## 7.4 The BLS “finality” layer is not complete BFT consensus

Each vertex can collect BLS attestations from configured finality signers. The default threshold is 0.51 of the signer set.

There are three critical distinctions.

### First: vertices are applied before finality

The state application path does not wait for a finality certificate. Finality appears to be observed after the vertex is already part of visible state. I found no mechanism in the audited path that uses finality to:

* Gate visibility.
* Prevent rollback.
* Reject a conflicting branch.
* Authorize compaction.
* Delay irreversible side effects.

### Second: finality is per vertex, not an ordering protocol

Two concurrent vertices can both receive signatures and both be “finalized.” That may be correct for a DAG, but it does not choose a total order or resolve their game-level conflict.

### Third: 51% is not a general BFT quorum

With 10 signers and a threshold of 6, two certificates may overlap in only 2 signers. If those overlapping signers are Byzantine, conflicting certificates are possible.

A standard (f < N/3) Byzantine safety model generally uses a quorum around (2f+1), or over two thirds, so two quorums necessarily intersect in an honest signer. The correct threshold depends on the actual certificate semantics, but 51% should not be described as BFT finality without additional assumptions.

The current mechanism is more accurately called **aggregated committee attestation**.

## 7.5 Equivocation and old branches remain open

Blocklace research constructs a signed hash-pointer partial order with a more formal treatment of equivocation and Byzantine participants. ([arXiv][4])

Compared with that line of work, current DRP still needs:

* Per-author sequence or fork detection.
* An explicit equivocation policy.
* A rule for descendants of equivocating vertices.
* Stable epochs or causal cutoffs.
* A certified security clock.
* Resource limits on old and wide branches.
* A definition of when a validly signed operation becomes too old to admit.

This does not invalidate the DRP approach. It means the current library implements part of the BFT-CRDT foundation, while the hardest policy and finality layers are still unfinished.

---

# 8. Detailed comparison with Yjs and Automerge

## 8.1 Comparison table

| Dimension                      | `ts-drp-1`                                                | Yjs                                                                                 | Automerge                                                             |
| ------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Core abstraction               | Signed method-call vertex in a causal DAG                 | Shared map/array/text/XML types                                                     | JSON-like document with a change DAG                                  |
| Convergence mechanism          | Deterministic topological replay plus app resolver        | Library-defined CRDT integration; updates are commutative, associative, idempotent  | Library-defined CRDT operations with deterministic change integration |
| Domain behavior                | Arbitrary application methods and conflict rules          | App behavior sits above fixed shared types                                          | App behavior sits above fixed document operations                     |
| Causal representation          | Explicit dependency hashes and frontier                   | Client ID/clock structs and integration dependencies                                | Change dependencies and document heads                                |
| Current anti-entropy           | Complete vertex-hash inventory                            | State-vector-based differential update                                              | Heads, have/need state, Bloom filters, whole-document fallback        |
| Conflict visibility            | Resolver can drop or reorder commands                     | Generally exposes one resolved shared state                                         | Concurrent property conflicts can be inspected                        |
| History                        | Entire vertex DAG retained; checkpoints do not compact it | Deleted content can be garbage-collected; represented client clocks remain relevant | Full document history retained and compressed                         |
| Persistence                    | In-memory object store                                    | Supplied by providers/backends                                                      | First-class storage adapters in Automerge Repo                        |
| Network                        | Bundled libp2p, discovery, relays, room mechanisms        | Network-provider agnostic                                                           | Network-adapter agnostic                                              |
| Built-in author authentication | Yes                                                       | No general per-operation signed identity                                            | No general per-change signed identity                                 |
| ACL                            | Causal object ACL                                         | Provider/application concern                                                        | Application/Repo concern                                              |
| BFT                            | Partial signed-DAG and attestation foundation             | Not built in                                                                        | Not built in                                                          |
| Best fit                       | Experimental signed semantic commands                     | Browser collaboration and shared live UI                                            | Durable offline-first JSON game state                                 |
| Current maturity               | Repository warns restructuring/specification lag          | Established ecosystem                                                               | Established core and growing Repo ecosystem                           |

## 8.2 Yjs

Yjs represents collaborative state through built-in shared types. Its encoded updates are designed to be applied in any order and more than once, and state vectors allow one peer to request the structs it is missing rather than enumerate every operation hash. ([docs.yjs.dev][1])

### Where Yjs is stronger

**Synchronization efficiency.** A state vector contains a clock for each represented client rather than a hash for every operation. It can still grow under large actor churn, but it does not grow linearly with every write in the same way as DRP’s current hash inventory.

**Browser ecosystem.** Yjs has providers, persistence adapters, awareness/presence conventions, editor integrations, and mature use in interactive web applications.

**Transactions.** Several shared mutations can be grouped into a transaction rather than being emitted as separate application-level vertices.

**Predictable convergence.** The application does not supply its own list-insertion or map-resolution algorithm.

**Selective ephemeral state.** Presence, cursors, and transient status can be kept outside the durable document.

### Where DRP is stronger

Yjs does not natively interpret a write as a domain command such as:

```text
player A hit player B
player C claimed item 17
admin X revoked writer Y
```

It synchronizes the resulting shared data operations. Domain validation, authorship, capability checks, and anti-cheat rules must be implemented around the Yjs update protocol.

Validating arbitrary untrusted Yjs binary updates against game semantics is difficult because an update may contain low-level document changes rather than one clean application command.

DRP’s operation vertex is much easier to reason about semantically:

```text
author: Alice
method: move
args: [direction, tick]
causal dependencies: [...]
signature: [...]
```

That is DRP’s most important advantage.

### The `y-webrtc` qualification

The original prototype’s full-mesh concern was real, but it was a property of `y-webrtc`, not Yjs itself. The provider warns that it is not suited to a large number of collaborators in one document; it limits peer connections and may eventually lose connectivity guarantees if the random peer graph becomes partitioned.

Yjs can instead use a WebSocket or hosted persistence provider. Systems such as Y-Sweet add server persistence, document sessions, and authorization around Yjs. ([GitHub][5])

Thus the fair comparison is:

```text
DRP = semantics + sync + libp2p network + partial identity
Yjs core = semantics + sync
Yjs provider/backend = network + persistence + auth
```

## 8.3 Automerge

Automerge is conceptually closer to DRP than Yjs is.

It maintains a change DAG with heads and causal dependencies, retains document history, and deterministically integrates changes into a JSON-like document. Its Repo layer separates document handles, network adapters, and storage adapters. ([GitHub][6])

### Where Automerge is stronger

**Change-DAG synchronization.** Automerge’s protocol exchanges heads, tracks what a peer has and needs, and uses Bloom filters to estimate which changes are missing. It can send the entire document when a peer is far behind, but it does not ordinarily send every change hash on every probe.

**Durable backend composition.** Automerge Repo treats storage and networking as adapters. That makes it a more natural foundation for an offline-first backend than DRP’s current in-memory store. ([Automerge][7])

**Conflict inspection.** Concurrent assignments to the same property retain conflict information even though one deterministic value is exposed as the ordinary result. ([Automerge][8])

**Cross-platform runtime.** Its core is implemented in Rust with language bindings and WASM, reducing the arbitrary-runtime variability of executing user-provided JavaScript reducers.

**Explicit ephemeral messaging.** Automerge Repo recommends ephemeral broadcast for high-frequency, session-only information instead of storing every update in document history. ([Automerge][9])

Automerge 3 also substantially reduced memory usage, though full historical retention remains a design characteristic rather than disappearing entirely. ([Automerge][10])

### Where DRP is stronger

Automerge still gives the application fixed document semantics. It does not natively say:

* A concurrent heal must precede damage.
* Only one of four causally valid pickup commands may survive.
* A movement command must be checked against the caller’s causal position.
* A permission change must be signed by a current administrator.

The application can build those rules above Automerge, but they are not expressed as part of the core change-integration algorithm.

Automerge also does not provide built-in cryptographically trusted actor identities, an object ACL, or BLS attestations. Those can be added externally, but actor IDs alone are not a trust system.

### The main practical distinction

Automerge stores a document whose merge semantics are supplied by the library.

DRP stores a history of application commands whose semantics are supplied by the blueprint.

That makes Automerge safer and more predictable, and DRP more expressive.

## 8.4 OrbitDB as an adjacent comparison

OrbitDB is worth mentioning because it is closer to an actual serverless P2P database. It uses IPFS/libp2p and Merkle-CRDT-style logs, and supports access-controller mechanisms. ([OrbitDB API][11])

OrbitDB is more appropriate than current DRP when the main need is:

* A durable or content-addressed append log.
* Key-value or document storage.
* IPFS-based replication.
* Access-controlled P2P data.

It is less appropriate when the main requirement is programmable, causal execution of game-specific commands.

---

# 9. What should and should not be a CRDT in a multiplayer game

The most important architectural decision is not “DRP versus Yjs versus Automerge.” It is which data belongs in a durable convergent structure at all.

## Good CRDT or DRP candidates

* Lobby and party membership.
* Chat.
* Shared annotations and pings.
* Level or map editing.
* Construction and block placement.
* Cosmetic selections.
* Quest and achievement metadata.
* Turn-based actions.
* User-generated content.
* Low-frequency inventory outcomes.
* Signed administrative commands.
* Match summaries.
* Audit trails.

## Poor durable-CRDT candidates

* 60 Hz transforms.
* Velocity and acceleration.
* Mouse or controller samples.
* Collision contacts.
* Animation frames.
* Voice/video state.
* Aim direction at rendering frequency.
* Prediction corrections.
* Temporary particles and effects.

Those should use an ephemeral channel with interpolation, prediction, and expiration.

## Contentious state needs more than convergence

Some data can be replicated, but requires an authority, escrow mechanism, or finality rule:

* Currency.
* Scarce inventory.
* Simultaneous item pickup.
* Combat damage.
* Hit registration.
* Ranking.
* Payouts.
* Land ownership.
* Trading.
* Hidden cards or fog-of-war information.

A CRDT can deterministically choose a winner, but that does not necessarily make the choice fair or resistant to information advantage.

---

# 10. A better architecture for a P2P multiplayer game

A robust design would split the game into several planes.

## 10.1 Ephemeral simulation plane

Use direct WebRTC, WebTransport, QUIC, or libp2p streams/datagrams for:

* Inputs.
* Transforms.
* Velocity.
* Aim.
* Presence.
* Voice.
* Prediction corrections.

Do not append these to long-lived CRDT history.

## 10.2 Simulation authority plane

Use one of:

* A conventional authoritative server.
* An elected peer referee with migration.
* A small BFT committee.
* Deterministic lockstep.
* Rollback networking.
* Per-zone authorities.
* Verifiable simulation or proofs for selected actions.

This plane decides contentious physics and anti-cheat outcomes.

## 10.3 Durable replicated state plane

Use:

* **Yjs** for shared browser state and collaborative world editing.
* **Automerge** for offline-first durable JSON state and history.
* **DRP** for low-frequency signed semantic commands requiring causal validation or custom conflict resolution.

A DRP operation should look like:

```text
placeBlock(...)
claimQuestReward(...)
joinGuild(...)
grantPermission(...)
submitTurn(...)
commitTrade(...)
```

not:

```text
setPosition(...) 60 times per second
```

## 10.4 Persistence plane

Retain certified snapshots and post-snapshot changes in:

* Stable relay nodes.
* Object storage.
* IPFS/content-addressed storage.
* A conventional database.
* User-owned local stores plus replication-factor monitoring.

Pure P2P replication does not create durability when every peer goes offline.

## 10.5 Sharding plane

Use separate objects or documents by:

* Match.
* Zone.
* Dungeon instance.
* Guild.
* Entity group.
* Ownership domain.
* Chat room.

Avoid a single graph for an entire continuously active world.

Cross-object operations then need an explicit design: sagas, reservation tokens, deterministic transfer protocols, or a small consensus domain.

---

# 11. Recommended hardening roadmap for `ts-drp-1`

## P0: convergence and compatibility

### 1. Commit to the executable semantics

Bind object identity to:

* Blueprint code hash.
* Resolver hash.
* ABI.
* Runtime version.
* Serialization version.
* Genesis state.
* Schema version.

Reject peers with incompatible manifests before synchronization.

### 2. Replace JSON content addressing

Use canonical binary serialization and:

* Sort dependencies.
* Canonicalize maps and object fields.
* Define number encoding.
* Bound argument sizes.
* Domain-separate every hash.
* Version the hash format.

### 3. Define a deterministic execution environment

Move blueprints toward:

* Deterministic WASM or another restricted VM.
* No wall clock, randomness, I/O, or ambient globals.
* Deterministic numeric semantics.
* Resource metering.
* Memory limits.
* Explicit deterministic host functions.

Randomness and time should enter as signed replicated inputs, not local APIs.

### 4. Enforce an operation ABI

Validate before execution:

* Method ID.
* Argument schema.
* Caller capability.
* Maximum payload.
* Version.
* Gas limit.

Unknown or permanently invalid calls should be deterministically rejected rather than retried as transient application failures.

### 5. Serialize local mutations

Add a per-object mutation queue and an authenticated per-author sequence number.

Define whether same-author forks are:

* Forbidden.
* Automatically serialized.
* Valid but explicitly concurrent.
* Evidence of equivocation.

### 6. Publish the resolver laws

A custom resolver should be required to satisfy documented properties:

* Deterministic.
* Pure.
* Terminating.
* Independent of arrival/batch order.
* Compatible with causal ordering.
* No cyclic swap relation.
* Stable under addition of unrelated concurrent vertices.

Property-based tests should generate every permutation and partition schedule for small operation sets and verify identical final states.

## P1: synchronization and bounded history

### 7. Replace complete-inventory sync

Implement:

* Head exchange.
* Recursive missing-dependency retrieval.
* Per-peer shared-head state.
* Bloom summaries or RIBLT.
* Chunking and backpressure.
* Direct `Map<Hash, Vertex>` lookups.
* Maximum response sizes.
* Resumable synchronization.

The author’s own RIBLT work is directly relevant here.

### 8. Implement certified checkpoints and epochs

A final checkpoint should authorize:

* State adoption by new replicas.
* Pruning of pre-epoch vertices.
* Pruning of finality state.
* Rejection or quarantine of pre-epoch late branches.
* Archival retrieval for audit.

Checkpoint finality must be defined independently from ordinary per-vertex attestations.

### 9. Replace dense causality structures

Investigate:

* Sparse ancestor indexes.
* Interval/tree labels.
* Incremental reachability.
* Bloom ancestry summaries.
* Frontier-relative causal indexes.
* Bounded conflict windows.

Any algorithm should be tested against wide antichains and adversarial old branches, not only sequential histories.

### 10. Batch operations

Allow multiple related mutations to form one signed atomic change, similar to a Yjs transaction or Automerge change.

That reduces:

* Vertex count.
* Signature count.
* Frontier references.
* Sync metadata.
* Replay overhead.

## P1: BFT and abuse resistance

### 11. Specify finality semantics

Define exactly what a certificate means:

* Observed by a threshold?
* Validated by a threshold?
* Irreversible?
* Safe for external side effects?
* Safe for pruning?
* Ordered relative to other certificates?

Use a threshold justified by the explicit Byzantine fault assumption rather than a generic 51% default.

### 12. Add equivocation and old-branch policy

Borrow from Blocklace and related BFT-CRDT work:

* Detect same-author forks.
* Record equivocation proofs.
* Define whether descendants remain valid.
* Rate-limit or quarantine old-dependency branches.
* Introduce epochs or security-clock cutoffs.

### 13. Add resource governance

Per peer and per object:

* Vertex-rate limits.
* Branch-width limits.
* Dependency limits.
* Argument-size limits.
* Replay-work budgets.
* Sync-response limits.
* Storage quotas.
* Admission control.

Cryptographic validity must not imply unlimited resource entitlement.

## P2: production engineering

### 14. Add durable adapters

A storage abstraction should cover:

* Vertex log.
* Checkpoints.
* Finality certificates.
* Object manifests.
* Peer sync state.
* Crash recovery.
* Compaction.
* Backup and restore.

### 15. Publish reproducible comparative benchmarks

A credible suite should compare DRP, Yjs, and Automerge using the same semantic workload:

| Dimension              | Suggested cases                                                                  |
| ---------------------- | -------------------------------------------------------------------------------- |
| Peers                  | 1, 8, 32, 128                                                                    |
| Durable operation rate | 1, 10, 100 operations/sec                                                        |
| Ephemeral rate         | 30 and 60 Hz separately                                                          |
| Duration               | 1 hour and 24 hours                                                              |
| Partition              | 1 min, 10 min, 1 hour                                                            |
| Branching              | Normal and adversarial                                                           |
| History                | 10K, 100K, 1M, 10M operations                                                    |
| Metrics                | Join bytes, join time, CPU, peak memory, retained storage, p50/p99 apply latency |
| Security               | Bad signatures, invalid methods, old branches, fork spam                         |
| Correctness            | All arrival orders and partition/rejoin schedules                                |

The present 1,000–3,000-vertex harnesses are not enough to characterize the intended game workload.

---

# 12. Final verdict

## As a research design

DRP is genuinely interesting.

Its core insight is that many multiplayer problems are not well represented by synchronizing mutable fields. A signed causal command such as:

```text
Alice applies impulse X to Bob because of collision C
```

contains more useful validation context than merely synchronizing Bob’s new velocity.

The combination of:

* Signed causal history.
* Application-level commands.
* Deterministic replay.
* Custom concurrency semantics.
* Causal ACLs.

is a meaningful design space between ordinary CRDTs and consensus-based state-machine replication.

## As a current P2P database

It is not ready to be the sole backend for a long-running multiplayer game.

The largest blockers are:

1. No blueprint/runtime commitment in object identity.
2. Arbitrary JavaScript determinism.
3. Complete-history hash-inventory synchronization.
4. No certified snapshot adoption or actual graph compaction.
5. In-memory object storage.
6. Expensive replay, state cloning, and conflict processing.
7. Incomplete equivocation and old-dependency handling.
8. Finality that does not currently define BFT ordering or irreversibility.
9. Lack of operation ABI and resource controls.
10. Limited game-scale benchmark evidence.

## Choosing among the systems

Choose **Yjs** when the problem is primarily:

* Live browser collaboration.
* Chat and lobby state.
* Shared UI.
* Map or level editing.
* Small-room cooperative state.
* Existing editor/provider ecosystem.

Choose **Automerge** when the problem is primarily:

* Durable offline-first JSON state.
* Local persistence and rejoin.
* Inspectable history and conflicts.
* Multi-platform application state.
* A backend assembled from storage and network adapters.

Choose **DRP** when the problem is specifically:

* Signed semantic commands.
* Causal application validation.
* Auditable peer-authored behavior.
* Custom rules for concurrent game actions.
* A research environment where the team is prepared to own the replication protocol.

For a competitive real-time game, choose none of them as the complete solution. Use an authoritative or committee-based simulation for contentious state and use CRDTs or DRP only for the portions of the world that can safely remain local-first and eventually consistent.

The most promising production direction is not “replace Yjs or Automerge with DRP.” It is:

> Use an efficient mature CRDT/document layer for durable data, an ephemeral transport for simulation, and a hardened DRP-style signed command layer only where causal provenance and custom concurrency semantics justify its extra complexity.

## Attached primary materials used

* [Original Topology archive](sandbox:/mnt/data/Topology%20Details.zip)
* [DRP whitepaper](sandbox:/mnt/data/topology_author_sources/drp-whitepaper.pdf)
* [From Isaac, Mumu, Shoshin, to CRDTs](sandbox:/mnt/data/topology_author_sources/From%20Isaac%2C%20Mumu%2C%20Shoshin%2C%20to%20CRDTs%20-%20guiltygyoza.pdf)
* [Super Mario in CRDT](sandbox:/mnt/data/topology_author_sources/Super%20Mario%20in%20CRDT%20-%20guiltygyoza.pdf)
* [Topology protocol walkthrough](sandbox:/mnt/data/topology_author_sources/Topology%20protocol%20walkthrough%20-%20guiltygyoza.pdf)
* [Practical Rateless IBLT: Part 1](sandbox:/mnt/data/topology_author_sources/Practical%20Rateless%20IBLT_%20Part%201%20-%20guiltygyoza.pdf)
* [Introducing RAM to the World Computer](sandbox:/mnt/data/topology_author_sources/Introducing%20RAM%20to%20the%20World%20Computer.pdf)

[1]: https://docs.yjs.dev/api/document-updates "https://docs.yjs.dev/api/document-updates"
[2]: https://arxiv.org/abs/2402.02668 "https://arxiv.org/abs/2402.02668"
[3]: https://martin.kleppmann.com/2022/04/05/bft-crdt-papoc.html "https://martin.kleppmann.com/2022/04/05/bft-crdt-papoc.html"
[4]: https://arxiv.org/abs/2402.08068 "https://arxiv.org/abs/2402.08068"
[5]: https://github.com/jamsocket/y-sweet "https://github.com/jamsocket/y-sweet"
[6]: https://github.com/automerge/automerge "https://github.com/automerge/automerge"
[7]: https://automerge.org/docs/reference/repositories/dochandles/ "https://automerge.org/docs/reference/repositories/dochandles/"
[8]: https://automerge.org/docs/reference/documents/conflicts/ "https://automerge.org/docs/reference/documents/conflicts/"
[9]: https://automerge.org/docs/reference/repositories/ephemeral/ "https://automerge.org/docs/reference/repositories/ephemeral/"
[10]: https://automerge.org/blog/automerge-3/ "https://automerge.org/blog/automerge-3/"
[11]: https://api.orbitdb.org/ "https://api.orbitdb.org/"

</response>