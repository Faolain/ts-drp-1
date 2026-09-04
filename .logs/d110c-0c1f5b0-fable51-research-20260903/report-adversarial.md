# Adversarial and liveness analysis — D.110c f5b0 + f5b0p settlement design

Scope: threat actors are a Byzantine ACL member (author), untrusted storage/relay, partition/reordering, crashes, and an honest-but-absent author. The creator is trusted. Design citations are line numbers in `.logs/d110c-0c1f5b0-design-00a860ab/design.md` ("D:") and `.logs/d110c-0c1f5b0p-design-e6a67013/design.md` ("P:"). Code citations are current HEAD of `codex/phase3a1b-p6-golden-path`.

Bottom line: no author can abort epoch rotation or make the creator sign contradictory frontiers (per-author isolation holds against the real close code). The real holes are in the **honest** path, not the adversarial one: the checkpoint cannot express "admitted but not adjacent", so the design routes the most common delivery-gap case through an application presence query that is unsound for non-idempotent operations, and the author-side Node has no owner able to authenticate a row older than one epoch. Both are P1 and both have small fixes.

## Ranked findings

### P1-1 — The "admitted but non-adjacent" slot forces application authority into settlement (double-apply or permanent stall on the honest path)

Design sentences violated / at fault:
- D:367-368 "The admitted boundary separately advances only across exact adjacent graph slots and never across a disposition."
- D:166-173 `already-present` is permitted only when `hasDisplacedOperation(projection, operation)` returns true; D:394-398 rows above `settledThrough` and above `admittedThrough` "retain displaced/rebase behavior"; D:279-282 the room records `already-present` when "already represented in the authenticated projection", otherwise issues a rebase/transform replacement.
- D:437-441 `hasDisplacedOperation` is "required only for a settlement-profile room".

Honest trace (Alice, op 10 delayed, op 11 admitted at close of E):
1. Close E: creator scans Alice's slots 10.. ; slot 10 absent → admitted=9, settled=9 (D:367-368). Slot 11 is in E's graph and history, but the checkpoint cannot say so.
2. E+1 reopen at Alice: row 11 is signed under E's anchor. `classifyPlaneVertex` (`packages/node/src/v3-live.ts:4590-4642`) tries `current` (anchor mismatch), then `displaced` against `displacedSource.prepared` = E's payload → matches → kind `displaced`. It is not `covered-historical` because that path requires `row.authorSequence <= identity.admittedAuthorSequence` (`v3-live.ts:4749-4757`) and admitted=9.
3. Today `readRebaseOutbox` skips published displaced rows (`v3-live.ts:6446`: `if (crossSource === undefined && classified.row.publishState !== "pending") continue;`). The design deletes that skip ("Mutable `publishState` alone never settles a source", D:270-271) because publishState is local and op 10 may also be "published". So row 11 becomes a rebase source.
4. The room must now decide `already-present` vs `rebase` for op 11 using `hasDisplacedOperation`. Displacement policies are per action (`examples/v3-room/src/index.ts:357`, `expire | manual-review | rebase | transform`). For an idempotent CRDT op, presence is ambiguous (someone else may have added the same element — the query answers "present" and Alice's op is dropped as already-present even if it never applied). For a non-idempotent op (counter increment, append), presence is **undefinable from state**: the query either returns false → the room issues replacement R → op 11 is applied twice (once in E's state, once in E+1); or the app answers conservatively → `manual-review` → Alice's frontier never advances and every later Alice row above 9 is displaced forever.
5. The creator cannot check any of this: it only verifies `coveredStateDigest === currentAnchor.stateDigest` (D:137-139), a value every author can copy from the anchor it already signs over (`successorAnchor` binds `stateDigest`, `packages/protocol-v3/src/creator-close.ts:203-224`). D:172-173 admits this ("The query chooses honest application behavior; it is not accepted as creator authority").

Consequence: the design's central honest scenario (a single delivery gap) is resolved by an application callback whose correctness is not decidable for a large class of applications. The same root cause produces a second trace:

Trace P1-1b (delayed control vertex): Alice issues replacement R (seq 12) and control C (seq 13, sources 10→R, 11→already-present) in E+1. R is admitted; C is delayed past E+1's close. Creator at E+1: slot 10 has no accounting → Alice stays at 9; R and C are in E+1's history. At E+2, C cannot be republished (ingress requires the current anchor: `packages/node/src/v3-live.ts:3785-3815`, `expectedAnchor = payload.provenance.anchorDigest`; `classifyV3EnvelopeScope(...).current`). D:284-286 says the stale C is covered by a later `settlement-control` source — but the *sources C dispositioned are still unsettled*. Alice must re-disposition 10 in E+2, and D:106-107 + D:163-167 require every replacement to be in the control vertex's **current** epoch and a strict causal ancestor (dependencies can only reference the current index: `v3-live.ts:3862` `hasInstalledDependencies`, `3730-3745` pending ingress waits on index). R (E+1) is unreferenceable. Alice's only options are `already-present` for 10 (again the presence query) or a second replacement R′ → op 10 applied twice.

Root cause: the checkpoint has no bounded way to say "slot k was admitted in a prior epoch even though k−1 was not". Everything above is a workaround for that.

### P1-2 — No owner can authenticate an author's own row older than one epoch (absent ≥2 closes ⇒ hard reopen failure)

Design sentences: D:106-107 "The source vertex epoch/anchor may be older"; D:247-250 "Node reopens each named source from the existing issuance store, authenticates its exact digest/sequence and classification"; D:396-398 "any other row above the settled boundary retains displaced/rebase behavior".

Code: `displaced` classification authenticates against exactly one prior payload, `registration.displacedSource.prepared` (`v3-live.ts:4611-4619`), whose `expectedAnchor` is the immediately preceding epoch's anchor. `covered-historical` accepts any older anchor (`v3-live.ts:4760-4785` uses the row's own `anchor`) but only for `row.authorSequence <= admittedAuthorSequence` (`4755-4756`). A pending row from epoch E−2 with sequence above `admittedThrough` therefore classifies as `undefined` → `readRebaseOutbox` returns `record-rejected` (`v3-live.ts:6393-6398`) → the room throws `v3 room rebase outbox failed` inside `drainRebaseOutbox` (`examples/v3-room/src/index.ts:2800-2801`) → `terminalFailure` (`2988-2990`).

Liveness trace: Alice's op 10 is delayed at close E; Alice is offline through E+1's close; she reopens at E+2. Row 10 (anchor E) is above settled=9, above admitted=9, and `displacedSource` is E+1's payload → unauthenticated → room terminal failure. Alice can never settle 10 and never issues again in this room. The design's matrix (D:465-491) has no row for "author absent across two or more closes". The trust layer *does* allow the jump (`openCreatorCheckpointTrust` opens from pinned genesis plus one adjacent pair against an external head); only issuance-row classification lacks the owner.

### P1-3 — Two owners can complete a source; the legacy owner silently erases settlement debt

Design sentences: D:259 "only then are the exact source rows marked complete/published"; D:269-271 "Source completion before durable control issue is unrepresentable through the settlement method. Mutable `publishState` alone never settles a source."

Code: `completeRebaseSource` (`v3-live.ts:6637-6685`) remains a public handle method (`v3-live.ts:7538`) and marks the source `published` with no statement. The room calls it directly for zero-intent sources (`examples/v3-room/src/index.ts:2814-2818`) and after every non-held source (`2971-2975`). A published displaced row is then skipped forever by `readRebaseOutbox` (`v3-live.ts:6446`). If any path (crash between the two owners, a retained legacy call in f5b0c, a v1 code path shared with settlement mode) marks the source through the legacy method, the source disappears from the outbox, no control vertex ever names it, the creator's `settledThrough` stops at the slot below it, and nothing surfaces the debt ("Manual-review rows remain explicit ... debt", D:426-427 — this row is not manual-review, it is invisible). The design says the settlement method cannot do this but does not remove the method that can.

### P2-1 — Registry candidate-root discard and creator-local registry loss are under-specified

P:206-210: "A different transition is refused until the candidate is authenticated and either matched to a checkpoint or discarded from the still-current prior root." Deciding "matched to a checkpoint" requires scanning AHE generations for a Staged/Complete successor whose settlement checkpoint carries that root (D.110c-0c pending-adoption resume will replay it). The registry store is explicitly separate from AHE (P:181-183), so this cross-store gate has no named owner; discarding a candidate that a staged-but-unadopted checkpoint references orphans that checkpoint (adoption resume then fails on root mismatch → membership-changing close stalls permanently until manual repair).

P:213-215 "A missing current-root node after restart is corruption/availability failure, never nonmembership" and P:216-224 (reachable nodes are O(R) archive-tier, fetchable from untrusted storage). The nodes are also the only copy for a browser creator (dedicated IndexedDB, P:181). IndexedDB eviction under storage pressure is a realistic honest failure; after it, every ACL-changing close stalls forever. The dictionary is a deterministic function of the archived creator-signed checkpoint chain (each checkpoint binds root/count and both ACL digests), so a rebuild-from-archive recovery exists in principle — but old closures are pruned after two rollback generations (`packages/node/src/internal/closed-epoch-cleanup.ts:263-282, 320-340`), so that recovery depends on Phase-7 archive retention that is not yet a stated requirement.

Untrusted-storage adversary otherwise holds: stale-but-valid paths are rejected because the creator verifies against the root in its own signed prior checkpoint (P:152-158); withholding stalls only ACL-changing closes; two candidate roots cannot coexist (P:187-189 at most one candidate, CAS on `expectedRoot`).

### P2-2 — Displaced replacement has no disposition rule (duplicate-ref prohibition makes the obvious statement unrepresentable)

D:116-117 replacement identities are unique per control vertex; D:284-286 only the stale control row is covered. Trace: C names 10→R; R is delayed past close (C admitted). E+1 creator: ref R not in graph → Alice stalls at 9 (D:361-363). E+2: Alice must disposition 10 and R (both displaced) and the honest replacement for both is one new vertex R′ — forbidden. The room needs a stated rule: when a durable stale control statement shows source S was replaced by R and R is itself displaced, emit `expire` for S and treat R as an ordinary displaced source. Without it f5b0c will invent this rule ad hoc, and a crash between R′ issue and control issue can double-apply.

### P2-3 — Cross-vertex source uniqueness must be a close-time rule, not an ingress rule

D:120-121 "No source identity may repeat within a control vertex or across accepted control vertices in the same close graph" and D:197-199 (Node validates the grammar at admission). If enforced at ingress, two peers that receive C1 and C2 in different orders admit different graphs; the creator's graph is authoritative for the close set, but honest peers would then hold journal rows the creator does not, and `republishRetained` (`v3-live.ts:6703-6828`) keeps re-gossiping them. Ingress already has no per-author sequence uniqueness check (`handleV3Ingress`, `v3-live.ts:3830-3990`, index keyed by digest); keep it that way and let the creator freeze the author (`packages/node/src/creator-close.ts:486-497, 528-530` already does this for duplicate slots).

### P2-4 — `coveredStateDigest` earns no bytes

It duplicates a fact the outer vertex already commits to (the vertex's `anchor` field is the successor anchor, which binds `stateDigest`: `packages/protocol-v3/src/creator-close.ts:203-224`), and the creator cannot evaluate presence (D:172-173). Delete it together with `already-present` if P1-1 is fixed as recommended; if `already-present` survives as an application optimization it must never be a settlement outcome.

### P3-1 — Absent author: bounded, with one cliff

Creator state is O(64) triples (D:423-427) regardless of gap age — confirmed: nothing in the scan reads prior graphs. Other peers hold nothing for Alice. The archive grows O(vertices) (accepted). Alice's own unsettled rows are bounded by her lineage and by `maxPendingEntries`/`maxEpochVertices` (`protocol-v2/src/registry.ts:43-49`, 8192/4096 defaults). Cliff: the room aborts reopen when the rebase outbox exceeds 8192 sources (`examples/v3-room/src/index.ts:2807`), so an honest author who accumulated more than 8192 unsettled rows can never reopen; with P1-2 fixed this becomes reachable. Ordinary cold reopen does not touch old control vertices (they live in archived history only).

### P3-2 — Rollback generations: no real hole

Issuance pruning today requires the active generation `Adopted` with two `Superseded` parents (`closed-epoch-cleanup.ts:263-282`) and a durably observed head (`442-470`); `swapHead` is CAS (`packages/storage/src/types.ts:140-145`). There is no code path in which a peer that durably adopted N+1 returns to N, so a row pruned under N+1's `settledThrough` is never needed under N. The one true regression is a creator that loses durable seal custody and re-signs epoch N: peers at N+1 reject the fork (`packages/protocol-v3/src/creator-close.ts:615-619` `EPOCH_EQUIVOCATION`) and peers at N accept it — a trusted-creator failure the settlement design neither causes nor worsens.

### P3-3 — Equivocation and laundering: per-author isolation holds

- Same `(author, seq)` with two digests in the graph: `creator-close.ts:486-497` marks the author anomalous (creator's own scope throws, as intended); frontier stays at prior (`528-530`); monotonicity is enforced on verify (`packages/node/src/internal/creator-transition-advance.ts:433-437`). In a later epoch the author can disposition the slot; both forks were already folded in the equivocation epoch, which is the same as an author issuing two ops. No creator contradiction.
- Graph vertex vs. disposition for the same slot: D:360-361 "exactly one graph vertex identity or exactly one same-author source disposition" — stall only.
- Replacement laundering: wrong `entryIndex`/digest is caught by expanding the real batch entry (`applicationBatchEntries`, `v3-live.ts:6320`); non-ancestor/previous-epoch/unadmitted refs fail because dependencies are current-epoch-only (`v3-live.ts:3862`) and the strict-ancestor walk over `graph.vertices[*].dependencies` is implementable on the captured graph (`v3-live.ts:7430-7450`). A replacement that is itself a settlement/ACL vertex only cheats the author; the creator should still require the replacement to be in the application subset.
- Zero-intent ACL/join: ACL ops take effect only if admitted into the graph (`latchedOperations` set at `v3-live.ts:3963`/`6154`, staged at close via `stageLatchedAclOperations`, `packages/protocol-v3/src/latched-acl.ts:376-446`). Waiving a never-admitted slot changes nothing; waiving an admitted prior-epoch slot changes nothing (already latched). Negative authority holds. Note the product behavior: an admin's delayed ACL op is silently dropped by the waiver; the room should surface it rather than auto-waive.
- Denial of service: control vertices share `maxEpochVertices`/`maxEpochBytes` with application vertices — no new flood vector; ancestry verification is O(graph) per ref, bounded.

### P3-4 — Legacy throw for authors absent from the prior aggregate

`packages/node/src/creator-close.ts:519-526` throws (aborting the close) for **any** author with no prior entry whose first observed sequence exceeds one. f5a proved this unreachable through ordinary ingress (unauthorized rows are rejected by the fold), but under the registry design the ambiguity is resolved by nonmembership, so f5b GREEN must replace it with a per-author stall and the matrix (D:487) should state "fresh member, first observed > 0 → that author does not advance; close proceeds".

## Golden-path liveness trace (design as written)

| Step | Actor | Existing code path | New path required | Owner gap |
| --- | --- | --- | --- | --- |
| E close: Alice 10 absent, 11 present | creator | `creator-close.ts:418-582` adjacent scan | dual-frontier scan (f5b) → admitted=9, settled=9 | — |
| E+1 adopt at Alice | app/room | room reopen with `successorSnapshotDeclaration` (`examples/v3-room/src/index.ts:2216-2290`, drain bound at `2979-2987`) | — | drain runs only on reopen; an in-process hot successor does not trigger it |
| Classify rows 10, 11 | Node | `classifyPlaneVertex` `v3-live.ts:4590-4642` → both `displaced` | terminal rule (≤ settled) before classification | **P1-1**: row 11 is not distinguishable from row 10 |
| Disposition | room | `drainRebaseOutbox` `2796-2977` | `hasDisplacedOperation`; build statement | **P1-1** unsound for non-idempotent ops |
| Issue R, C | Node | ordinary issuer for R | `settleRebaseSources` + dedicated issuer (f5b0b) | **P1-3** legacy `completeRebaseSource` still reachable |
| Creator admits R, C | creator Node | `handleV3Ingress` `3830-3990` | settlement recognition, ACL-membership authority | — |
| E+1 close | creator | — | scan 10 (C), 11 (C), 12 (R), 13 (C) → settled=13 | if C delayed: **P1-1b** |
| E+2 adopt, prune | Alice | `planClosedEpochCleanup` gates | `pruneAuthenticatedSettledPrefix` | — |
| Alice offline through E+1 | Alice | `displaced` needs E+1 payload | none | **P1-2** hard failure |

## Smallest amendments that close the real holes

1. **Express admitted gaps in the checkpoint (closes P1-1, P1-1b, P2-2 pressure; removes the presence query).** Change the frontier entry to `[author, admittedThrough, settledThrough, admittedGaps]` where `admittedGaps` is the sorted list of missing slots in `(settledThrough, admittedThrough]`, with a **checkpoint-wide** cap (e.g. ≤32 gap entries total; an author whose gaps would exceed the cap falls back to the adjacent rule). This is the dotted-version-vector idea the brief lists. Budget: ~17 bytes per gap → ≤ ~600 B over the measured 7,064 B, under the 8,192 B ceiling that `MAX_SCANNABLE_BYTES` enforces (`packages/control-plane/src/anchor-trust.ts:23`, `creator-close.ts:65,984`); f5b0a must re-measure. Author-side classification then becomes pure checkpoint arithmetic: `≤ settled` → terminal; `∈ gaps` → displaced (needs disposition); `≤ admitted` → covered-historical (never rebased); `> admitted` → displaced. The creator scan accepts a prior-admitted slot as accounted. Delete `already-present`, `coveredStateDigest`, and `hasDisplacedOperation`. If the byte budget genuinely does not fit, the fallback is an `admitted-in-history` outcome carrying an RFC 9162 inclusion proof against `currentAnchor.historyRoot` (verifier already exists: `packages/compaction/src/ct-merkle.ts:153-200`; leaf binds `vertexHash`, `history-commitment.ts:473-500`), capped at 2 per control vertex because a 30-level path is ~1 KB.
2. **Anchor-agnostic authentication of own rows (closes P1-2).** In f5b0b, classify displaced rows by signature + scope + row digest only (the same shape `authenticatedCoveredHistoricalOutboxRow` uses at `v3-live.ts:4760-4785`), for any `epoch < current`, independent of `displacedSource.prepared`. Add the matrix row "author absent across ≥2 closes settles on return".
3. **One completion owner (closes P1-3).** Under `creator-trusted-settlement-v1`, `completeRebaseSource` must be unreachable (handle method absent or fail-closed), and the room's two direct calls (`examples/v3-room/src/index.ts:2814, 2971`) become `settleRebaseSources`. State it in D:252-261.
4. **Displaced-replacement rule (P2-2).** "If a durable stale control statement maps S→R and R is displaced, the new statement emits `expire` for S and dispositions R as an ordinary source." One sentence in D:284-292.
5. **Registry discard/recovery (P2-1).** Gate candidate discard on an AHE generation scan (no Staged/Complete successor references the candidate root), and either require Phase-7 retention of every settlement checkpoint so the dictionary can be rebuilt from the signed chain, or state explicitly that browser-creator registry loss is a permanent ACL-change stall.
6. **Close-time uniqueness (P2-3).** Move "no source repeats across accepted control vertices" from ingress to the creator scan; ingress validates only intra-vertex grammar and capacity.
7. **Matrix rows.** Add: fresh member first observed > 0 → per-author stall, close proceeds (replace `creator-close.ts:519-526` for foreign authors); admin ACL op waived by zero-intent is surfaced to the application; rebase outbox > 8192 sources is a stated liveness cliff.

Items 1-3 are the ones I would block RED on; 4-7 can be owner/disposition notes.
