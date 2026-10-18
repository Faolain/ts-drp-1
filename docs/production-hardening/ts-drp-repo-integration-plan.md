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

## 9. Implementation log — findings and gotchas

Appended as each phase is implemented. Every entry is something that was **verified by
execution in this repository**, not inherited from a review document.

### General / infrastructure

- **Baseline at `7f9e66a` (2026-07-24):** `pnpm typecheck` clean, `pnpm lint` clean (32
  warnings), `pnpm vitest run` = 1342 passed / 4 skipped, **1 test file failing**. The failing
  file was `docs/production-hardening/ts-drp-ahe-review-bundle/reference-implementation/test/core.test.mjs`
  — a vendored `node:test` suite that vitest was globbing because `vite.config.mts`'s
  `test.exclude` did not cover `docs/`. Fixed by adding `"docs/**"` to the exclude list. Without
  this the repo suite is red for a reason unrelated to `packages/`, which makes red/green TDD
  unusable. *(Not a plan change; prerequisite infrastructure.)*
- **`production-hardening-tdd-plan-v2.md` contains a literal NUL byte** (offset 31266, inside a
  sentence discussing NUL-delimited vote keys). `grep`/`rg` therefore treat the whole file as
  binary and silently return nothing. Use `rg -a` on it, or normalise the byte.
- **`timeout(1)` is not present on this machine** (macOS, no coreutils on `PATH`). Wrapping agent
  CLIs in `timeout` silently produces `command not found` and a *successful* exit code, which
  reads as "the agent ran and said nothing". Use the CLIs bare.

### Phase 0, items 1-2 — state adoption, staged merge, typed rejection

All five defects below were confirmed by execution against `7f9e66a`, each with a failing test.

- **D1 — state adoption is a merge, not a replacement.** `Object.assign(this.acl, acl)` /
  `Object.assign(this.drp, drp)` at the end of `applyVerticesUntraced`, and both `Object.assign`
  calls in `assign()`. A top-level key deleted by a blueprint operation survives on the live
  object, so the live instance disagrees with `states.getDRPState(frontier)` and with any replica
  that replayed from scratch.
- **D2 — replica-local `context` is snapshotted.** `stateFromDRP()` snapshots every non-function
  own property, including `context: DrpRuntimeContext`, which `callDRP()` overwrites with the
  *calling peer id* before every operation. Two replicas agreeing on the graph produced different
  `DRPState` bytes for the same vertex hash (caller byte `97` vs `98`). Note `proxy.ts` already
  treats `context` as ignorable for mutation tracking — the snapshot path was the inconsistency.
- **D3 — merge batches are not atomic.** The per-vertex pipeline writes straight into
  `hashGraph`, `states` and `finalityStore`. A transient blueprint failure on a later vertex
  rethrows out of `applyVertices`, leaving earlier vertices of that batch permanently committed
  while the caller sees only a rejected promise.
- **D4 — authorization failure is an untyped `Error`.** `validateWriterPermission` throws
  `new Error("Not a writer " + peerId)`, which the classifier does not recognise, so it rethrows
  and **aborts the merge of every other vertex in the batch**. One unauthorized vertex from a
  hostile peer is a denial-of-service on the whole batch. Authorization is a deterministic
  verdict and must be a typed per-vertex rejection.
- **D5 — an unknown blueprint operation is an untyped `TypeError`, with the same batch-wide
  effect.** Related: a non-root vertex with the reserved `opType === "-1"` is silently `continue`d
  — reported as neither applied, missing, nor invalid.

**Gotcha for the fix:** a blueprint method may legitimately throw `TypeError` from inside correct
code. D5 must be fixed by checking that the named operation exists and is callable *before*
invoking it — a property of the blueprint — not by reclassifying `TypeError` as deterministic.

## 10. Release blockers

- external review of canonical codec, signatures, authority handoff, and seal state machine;
- formal pacemaker model;
- real-browser crash/quota/lifecycle matrix;
- deterministic blueprint restrictions and versioning;
- weak-subjectivity/fork UX;
- explicit archival availability and privacy policy.
