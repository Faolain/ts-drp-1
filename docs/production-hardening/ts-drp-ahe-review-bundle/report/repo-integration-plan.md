# ts-drp Attested Hard Epochs integration plan

**Baseline:** `bf7d3516f6ed4be97a755698b4fb3a404e04dc0f`  
**Rule:** no destructive pruning until shadow-state equivalence, formal seal safety, and browser crash recovery are green.

## 1. Phase 0: correctness foundation

1. Replace `Object.assign` state adoption with delete-then-restore replacement; exclude replica-local `context` from snapshots.
2. Stage a whole merge/fold before mutating live graph/state; make authorization and deterministic blueprint rejection typed.
3. Split future-clock quarantine from deterministic timestamp invalidity; local timeout never creates semantic invalidity.
4. Route every dependency decision through one fail-closed classifier.
5. Introduce deterministic min-hash Kahn order and reject duplicate, missing, cyclic, or causally related direct dependencies.
6. Freeze deterministic CBOR test vectors and schemas.
7. Add protocol/object domain separation only in a new object namespace.

**Gate:** current non-compacted rooms pass randomized delivery-order and replay-from-snapshot equivalence tests.

## 2. Package boundaries

```text
packages/protocol-v2/       canonical envelopes, anchors, descriptors, votes, QCs
packages/compaction/        close-set collection, fold, snapshots, history roots
packages/storage-browser/   IndexedDB journal, vote CAS, chunk/archive cache
packages/sync-v2/           epoch summaries, resumable chunks, bounded tail diff
```

Keep legacy hash/topic semantics untouched.

## 3. Phase 1: snapshots without pruning

- Add canonical application/ACL export and import.
- Implement 128 KiB content-addressed chunks and a bounded manifest.
- Stage chunks and metadata in IndexedDB; adopt with one strict pointer transaction.
- Run snapshots in a Worker and expose timing/memory instrumentation.
- Compare two upgraded replicas and an archival replay for every candidate snapshot.

**Gate:** no digest mismatch across long randomized runs, engine test vectors, and restart tests.

## 4. Phase 2: protocol-v2 hard epoch envelope

Every vertex signs `{objectId, protocolMajor, epoch, anchor, author, logicalTime, deps, operation}`.

- Latched ACL from anchor authorizes the whole epoch.
- Unknown current-epoch deps are pending.
- Old epoch/wrong anchor is terminal.
- Out-of-close-set local intents enter a rebase outbox; only the original author signs replacements.

**Gate:** exhaustive small-graph model and adversarial schedule suite stay green in repository code.

## 5. Phase 3: sidecar seal, observation mode

- Use individual existing identity signatures first.
- Persist exact prepare/commit votes before gossip.
- Persist monotone entered round, lock, highest prepare QC, and finalized QC.
- Web Locks are advisory; IndexedDB unique vote slots are authoritative.
- Implement increasing-timeout pacemaker and authenticated round-change evidence.
- Keep all graph history while comparing independently computed cuts.

**Gate:** formal TLA+/Quint agreement/no-retro-vote invariants, adversarial network simulation, and multi-tab race tests.

## 6. Phase 4: bounded pruning

After several successful shadow epochs:

- retain current anchor, bounded active graph, at least two rollback generations, authority handoffs, Merkle compact peaks, and configured archive cache;
- remove closed-epoch graph/finality/snapshot structures only after durable adoption;
- record excluded/rebased intents and expose UI state;
- continuously check disk/memory slope.

**Gate:** browser kill-before/after-every-IDB-request tests on Chrome, Firefox, Safari, iOS, and Android.

## 7. Phase 5: Discord/archive profile

- Move old finalized messages into immutable canonical segments.
- Commit segment descriptors under a Merkle archive index.
- Hot snapshot contains recent window plus edit/tombstone overlay and archive root.
- Fetch older segments on demand with inclusion proofs.
- Store attachments separately by chunk manifest; define encryption/retention policy.

**Gate:** corrupt/missing/withheld segment tests; product-level availability policy and mirror repair.

## 8. Migration

A legacy creator/current authority signs an explicit migration record naming the legacy object/final state and new genesis anchor. Participants join a distinct v2 room/topic. Never dual-accept old and new vertex preimages under one object ID.

## 9. Release blockers

- external review of canonical codec, signatures, authority handoff, and seal state machine;
- formal pacemaker model;
- real-browser crash/quota/lifecycle matrix;
- deterministic blueprint restrictions and versioning;
- weak-subjectivity/fork UX;
- explicit archival availability and privacy policy.
