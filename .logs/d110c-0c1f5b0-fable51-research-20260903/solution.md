# D.110c author settlement — Fable 5.1 research synthesis and recommended solution

Date: 2026-09-03. Branch `codex/phase3a1b-p6-golden-path`, HEAD `e6a67013`.
Method: five parallel Fable 5.1 (high) read-only research agents with distinct angles
(code-grounded verification, alternative constructions, adversarial/liveness,
prior art, end-to-end golden path), plus orchestrator verification of the one code
fact that decides the design. Agent reports are the sibling `report-*.md` files.
Nothing in this directory is a production edit, RED, or review authorization.

## 1. Verdict

The current amended design (per-source disposition carrier + creator dual-frontier
checkpoint + Merkle AVL retired-author dictionary) is **sound in its authority
model but over-built by roughly an order of magnitude, and it contains two
independent defects that every reviewer will block on**. A strictly smaller
construction using only existing primitives delivers the same guarantees with
O(1) creator state per author and no new store:

1. **Fence instead of dispositions.** One author-signed control vertex per adopted
   epoch carrying a single integer `fenceSequence = m`: "every slot of mine below
   `m` is either already admitted or abandoned; nothing below `m` may ever be
   admitted again." No sources, replacement refs, zero-intent, settlement-control,
   already-present, `coveredStateDigest`, `semanticIdentityDigest`, or
   `hasDisplacedOperation`.
2. **Sequence floor instead of the retired-key dictionary.** One creator-signed
   integer `sequenceFloor` in the checkpoint, equal to the maximum boundary ever
   signed for any member. Every ACL addition, fresh or returning, enters at
   `settledThrough = sequenceFloor`. The creator never needs to know whether a key
   was used before. No Merkle AVL, no `RetiredAuthorRegistryStore`, no second
   IndexedDB schema, no proofs, no "registry unavailable stalls close" failure.
3. **One boundary, not two.** `admittedThrough` is dropped. The checkpoint frontier
   is `[author, settledThrough, settledEpoch]`.

The construction is the industry-standard one (Kafka producer-epoch fencing,
Zab/Raft ballot fencing, MLS epoch generations, KIP-360 `InitProducerId`), adapted
so that `authorSequence` stays never-resetting for the room lifetime, which is
what the issuance store, pruning watermark and creator scan already assume.

## 2. The code fact that collapses the grammar

The peer summary's motivating scenario is "Alice's op 11 reaches the room but op
10 is delayed; the epoch closes with 11 admitted and 10 missing". **That scenario
cannot occur for an honest author within an epoch**, and the design's most
expensive machinery exists to handle it.

- Local issue takes its dependencies from the causality index tips
  (`packages/node/src/v3-live.ts:6217-6240`; the join loop at `:6231-6240`
  reduces every tip into the chain). Alice's op 10 is a tip or an ancestor of a
  tip when she issues op 11, so op 10 is always in the causal past of op 11.
- Ingress refuses a vertex whose dependencies are not installed
  (`v3-live.ts:3862`, `hasInstalledDependencies` at `:3711-3716`); unready
  vertices wait in the bounded `pendingIngress` map (`:2652`) and are never in
  the index. The close graph equals the index (`captureCloseGraph`,
  `:7430-7460`), so it is causally closed.
- Therefore, in the creator's close graph, an honest author's admitted slots
  always form a contiguous run above its prior boundary. If 11 is in the graph,
  10 is too. The only way to produce "11 without 10" is a Byzantine author that
  deliberately omits its own previous vertex from its dependencies, and that
  author harms only its own frontier.
- Across epochs the same holds because the room's rebase startup barrier drains
  every row above the boundary before any ordinary issue
  (`examples/v3-room/src/index.ts:2796-2990`, `:3844`).

Consequences:

- The creator's `admittedThrough` for an honest author is always exactly the
  contiguous scan result; there is never an "admitted but non-adjacent" slot to
  represent. The verification agent's P0-2 and the adversarial agent's P1-1
  (both: "the checkpoint cannot express admitted-above-gap, so `already-present`
  and an application presence oracle are forced into settlement") describe a
  state that is unreachable for honest authors and self-inflicted for Byzantine
  ones. The right fix is not to add admitted-gap lists or RFC 9162 inclusion
  proofs to the carrier; it is to delete `already-present`, `coveredStateDigest`
  and `hasDisplacedOperation` and rely on contiguity.
- An author reading its own `settledThrough` from the authenticated checkpoint
  knows *exactly* which of its rows were admitted (all rows at or below the
  boundary) and which were not (every row above it). That is the existing v1
  `covered-historical` idea, and it is sound precisely because of contiguity.
  The author needs no other evidence to decide rebase / expire / transform.

## 3. Recommended construction

### 3.1 Checkpoint (creator-signed, in the transition closure)

```ts
{
  kind: "drp-creator-author-settlement-state", version: 1, protocolMajor: 3,
  objectId, genesisAnchorDigest, closedEpoch, closedAnchorDigest,
  successorEpoch, successorAnchorDigest, currentAclDigest, successorAclDigest,
  cutValueDigest, commitQcRef, snapshotManifestDigest, historyRoot, historySize,
  priorCheckpointDigest, priorCheckpointKind: "genesis" | "settled-v1",
  sequenceFloor: number | null,
  frontiers: readonly [author: string, settledThrough: number | null, settledEpoch: number][],
}
```

- `frontiers` has exactly the successor ACL's members (≤ 64), code-unit sorted.
- `settledEpoch` is the closed epoch at which `settledThrough` last advanced (or
  the epoch of admission). It exists only to bound the fence (§3.3).
- `sequenceFloor` ≥ every `settledThrough` in the vector and ≥ the predecessor's
  `sequenceFloor`; `null` only while no member has a non-null boundary.
- Retired-author registry root/size, `admittedThrough`, and every v1
  aggregate/retirement field are absent. Everything else is as in the current
  design (genesis-bound `creator-trusted-settlement-v1` profile, adjacent
  predecessor, mixed/downgraded predecessors fail closed).
- Byte budget: the alternatives agent measured 6,959 B for the 64-member
  max shape with a `sequenceFloor` and *two* boundaries; with one boundary plus
  `settledEpoch` it is the same triple width, so it stays under the unchanged
  8,192-byte ceiling. f5b0a RED must pin the exact figure.

### 3.2 Fence carrier (author-signed, existing v3 envelope)

```ts
type AuthorFenceOperation = Readonly<{
  action: "$drp.author-fence.v1";
  fenceSequence: number;   // m, a safe nonnegative integer
  version: 1;
}>;
```

Semantics, signed by the outer vertex's author under the existing
`ts-drp/vertex/v3` domain with the outer vertex's own `authorSequence = f`:
"every slot of mine with sequence < m that is not already admitted is abandoned
and may never be admitted; every slot ≥ m is work for the current epoch."
Requirements: `m ≤ f` (the fence vertex itself is at or above the fence).
Canonical size is on the order of 100 bytes. Admission authority is ACL
membership, exactly as in the current design; the operation never reaches the
blueprint reducer; the Node close-graph split (application ⊔ control) and the
dedicated control issuer from the current design are retained unchanged.

The typical author emits exactly one fence per adopted epoch, as the first
vertex after the rebase barrier completes, with `m = lineage.next` at that
moment. Rebased/transformed replacements are ordinary application vertices
issued after the fence, at sequences > m. No linkage from replacement to source
is carried on the wire; the author's own issuance store keeps that audit trail.

### 3.3 Creator rule at close

For each member `A` of the successor ACL, starting from prior
`(settledThrough = s, settledEpoch = e0)` (or `(sequenceFloor, closedEpoch)` for a
member absent from the current ACL):

1. Collect `A`'s vertices in the complete current close graph grouped by exact
   `(authorSequence, digest)`; a same-slot duplicate freezes `A` at `s` (existing
   f5a behavior at `packages/node/src/creator-close.ts:486-497`, `:528-546`).
2. If the graph holds fence vertices of `A`, take the one with the largest `m`
   such that `s < m` and `m − 1 − s ≤ K × (closedEpoch − e0 + 1)`, where
   `K = maxEpochVertices + maxPendingEntries` from the authenticated payload
   parameters. A fence that violates the bound is ignored (author-local stall,
   no close abort). Set `s := m − 1`.
3. Advance `s` across exactly adjacent graph slots `s+1, s+2, …` (unchanged
   scan). Never take an observed maximum; never cross an unknown slot.
4. Emit `[A, s, s advanced ? closedEpoch : e0]`.

Then `sequenceFloor' = max(sequenceFloor, every non-null boundary just derived,
including boundaries of members being removed)`.

Why the bound in step 2 is safe and sufficient: an honest author consumes at
most `maxEpochVertices` sequences per epoch (its local graph capacity) plus at
most `maxPendingEntries` unpublished rows, so its unaccounted range after being
unaccounted for `n` closes is at most `K × n`. A Byzantine author therefore
cannot push its own boundary, and hence `sequenceFloor`, beyond what an honest
author could legitimately need, which prevents the one real attack on a global
floor (inflating it toward `2^53` so that no member can ever be added again).
Sequence exhaustion requires `K × epochs > 2^53`; with `K ≈ 2^14` that is
`2^39` epochs.

### 3.4 Author rule at open/adopt (Node + room)

1. Read own `(settledThrough = s)` from the authenticated checkpoint.
2. Rows with sequence ≤ s are terminal: never republished, rebased or applied
   (unchanged terminal rule). They are reclaimed later by
   `pruneAuthenticatedSettledPrefix` after the existing adoption/rollback/
   availability gates (f5b0d, unchanged).
3. If `lineage.next ≤ s`, execute one strict-durability CAS
   `DurableIssuanceStore.transactAdvanceLineage({scope, expectedLineage, next: s + 1})`
   before any issue. This is the one new store method; it is needed by the
   current design too (a fresh device reads `next: 0`,
   `packages/storage-browser/src/internal/browser-issuance-store.ts:413`) but is
   not assigned there.
4. Every own durable row with sequence > s and epoch < current is *not admitted*
   (contiguity, §2), regardless of its `publishState` and regardless of how many
   closes ago it was issued. Classify it as displaced by re-authenticating the
   author's own signature, scope and row digest, not against a single
   predecessor payload. The current single-predecessor classifier
   (`v3-live.ts:4611-4619`) hard-fails an author absent for two closes; that
   must change under the settlement profile.
5. The room's existing displacement policy runs over those rows: `expire`,
   `rebase`, `transform`, or `manual-review` (which holds the barrier).
   `already-present` is deleted. Reserved `join`/`causalJoin`/`acl` rows are
   simply covered by the fence; a displaced admin ACL op is surfaced to the
   application rather than silently waived.
6. When no held rows remain, issue the fence at `m = lineage.next`, then the
   replacements. Durable order: fence journaled → published → replacements →
   source rows marked complete. Crash anywhere before the fence is durably
   issued leaves every source pending and the restart re-runs the same drain;
   the idempotence key is the fence vertex itself. `completeRebaseSource`
   (`v3-live.ts:6637-6685`) must be unreachable under the settlement profile so
   that no second owner can complete a source without a fence.
7. If the fence is displaced by a close before admission, the next epoch's drain
   sees it as an ordinary displaced row and issues a new fence with a larger `m`.
   No supersession grammar is needed because fences are monotone.

### 3.5 ACL add/remove rule

- Retained member: copy its scanned `[settledThrough, settledEpoch]`.
- Removed member: dropped from the vector after contributing to
  `sequenceFloor'`. Nothing is remembered about it.
- Added member (fresh or returning, indistinguishable and irrelevant): enters
  at `[sequenceFloor', closedEpoch]`.

Safety argument (alternatives agent §2.B): every boundary ever signed for any
key is ≤ the floor at that close and the floor never regresses, so a returning
key's first accountable slot is strictly above every slot the creator ever
accounted for it. Lifetime uniqueness of accounted `(author, sequence)` holds;
the terminal rule covers every previously accounted row; the issuance store's
monotone lineage and pruned watermark are respected via the lineage jump.

What a returning member loses: rows it issued before removal that were never
admitted and never fenced. They become terminal at re-admission; the author still
holds their bytes and can resubmit their content as new operations. Removal is
an explicit creator authority act, and this is exactly what Kafka, Zab and MLS
do to a fenced predecessor.

### 3.6 Bounds and failure matrix (replacement rows)

| Case | Result |
| --- | --- |
| honest delivery gap (10 lost, 11 causally after it) | 11 is never admitted without 10; both are displaced; author rebases both and fences; `settledThrough` advances at the next close |
| author absent across ≥ 2 closes | rows are classified by own signature/scope/digest; drain, fence, advance; no hard failure |
| fence `m` below `s` or above the `K` bound | ignored; author-local stall; close proceeds |
| fence displaced before admission | next drain issues a larger fence; no supersession |
| Byzantine author omits own previous vertex from dependencies | only its own boundary stalls; other authors and the close are unaffected |
| Byzantine author fences far ahead | bounded by `K × n`; cannot poison `sequenceFloor` beyond honest need |
| same-key removal/re-entry | enters at `sequenceFloor`; every previously accounted slot is terminal; no fresh/returning distinction |
| genuinely fresh key | enters at `sequenceFloor`; sequence zero accepted only while the floor is `null` (genesis) |
| `sequenceFloor` regresses / null with non-null boundaries / below any boundary | checkpoint rejected at verify/open |
| creator's own displaced rows | same fence path; no legacy retirement record under the settlement profile |
| manual-review row | barrier holds; no fence; only that author's boundary stalls |
| rollback to prior checkpoint | floor and boundaries regress with it; keys added in rolled-back epochs are outside the rolled-back ACL |

Active state per room: one checkpoint of ≤ 64 triples plus one integer; no
archive-tier registry; no proofs; no state that grows with epochs, rebases, or
distinct-key churn.

## 4. Findings on the current design that stand regardless of §3

All five agents converged on these; they block RED even if the team keeps the
per-source grammar and the dictionary.

- **P0 — Boundary ordering is inverted between the two documents.** f5b0 makes
  `settledThrough` advance across dispositions while `admittedThrough` never
  does, so `settled > admitted` after the first gap; f5b0p's node schema and
  the checkpoint text require `settled ≤ admitted`, and the re-entry bound is
  keyed on `admittedThrough`. Under the dictionary, removing any author who
  ever had a gap makes the membership-changing close fail closed forever, and a
  re-added key may issue into terminal slots. (All four code agents.)
- **P1 — The honest delivery-gap source is a *published* row, and
  `readRebaseOutbox` only yields pending rows** (`v3-live.ts:6446`, frozen by
  the plan at `plan-v2.md:98815-98823`). The design's "rows above the settled
  frontier are drained" is unreachable without reopening that predicate; no
  slice names it. Under §3 the rule becomes "every own row above
  `settledThrough` with epoch < current", regardless of `publishState`.
- **P1 — Rows older than one epoch are unclassifiable** (`v3-live.ts:4611-4619`
  authenticates displaced rows against exactly one predecessor payload; an
  author absent for two closes gets `admission-rejected` at `:5436-5438` and
  the room terminal-fails). No matrix row covers it.
- **P1 — No owner for the returning/fresh author's lineage jump**
  (`DurableIssuanceStore` has no method that advances `next`;
  `packages/issuance-store/src/types.ts:84-91`). Needed by both designs.
- **P1 — Owner list misses closure-law validators** that will reject a
  settlement-profile closure: `creator-transition-advance.ts:326-328,397-398`
  (exactly one retirement, exactly one aggregate), control-plane normalization
  at `creator-trust-checkpoint-advance.ts:198-207`, and
  `packages/protocol-v2/src/registry.ts:460` (profile registry).
- **P1 — Shipped v1 liveness hole.** `creator-close.ts:517-524` throws
  `D110C_0C1F1_AUTHOR_REENTRY_PROOF_REQUIRED` for any prior-less writer whose
  first observed sequence exceeds one; the close aborts and keeps aborting until
  that author is removed. No test references the constant. The settlement scan
  must not inherit it.
- **P1 — Two owners can complete a source.** `completeRebaseSource` remains a
  public handle method and is called directly by the room
  (`examples/v3-room/src/index.ts:2814, 2971`); a source completed that way
  vanishes from the outbox without any statement.
- **P2 — `closeVertices/closeAuthors/closeCharges` do not exist**; the existing
  names `applicationVertices/...` (`v3-live.ts:7433-7435`) are today the
  *complete* map, so f5b0b must rename rather than add.
- **P2 — Control-vertex capacity from non-writers**: ACL membership without a
  write role can still flood `maxEpochVertices` with control vertices. Under §3
  the exposure is one ~100-byte fence per author per epoch, but a cap of one
  accepted fence per author per epoch should be explicit.
- **P2 — Cross-vertex source uniqueness must be a close-time rule, not an
  ingress rule** (peers would otherwise diverge on admission order). Moot under
  §3.

## 5. What no settlement design fixes: the rest of the golden path

The golden-path agent's gap table (`report-golden-path.md` §2) is the most
important product finding of this research. Even with the settlement design
GREEN, the "room alive for years" claim is false until these have owners:

| Gap | Evidence | Status |
| --- | --- | --- |
| Nothing prunes in production | `prunePublishedPrefix`, `planClosedEpochCleanup`, AHE `reclaim` have zero production callers | D.110c-c wiring is on the critical path, not a follow-up |
| Cold reopen already fails with age | recovery scans the whole outbox (`v3-live.ts:4813-4830, :5367`) and refuses once covered rows in one scan exceed `maxEpochVertices` (`:4349-4355`); with prune gated behind two rollback generations, ~3 busy epochs of rows can be resident | cap must become `(rollback + 1) × maxEpochVertices` or the scan must start at the settled watermark; unowned |
| Non-creator peers cannot hot-follow an epoch | no successor message in `packages/node/src/handlers.ts`; room exposes creator-only `adoptCreatorSuccessor()` (`examples/v3-room/src/index.ts:3739`); non-creators reopen with an out-of-band declaration | every non-creator transition is a cold reopen, so the two rows above are paid per peer per epoch |
| Live-journal old scopes, snapshot-transfer scopes, seal evidence, AHE generations | keyed per epoch, never deleted (`storage-browser/src/live-journal.ts:419-470`, `snapshot-transfer.ts:239,297-301`, `seal-evidence-store.ts:301`) | D.110c-c census; unbounded today |
| Room in-session maps | `acceptedVertices`/`acceptedOperationRows` never cleared (`examples/v3-room/src/index.ts:1774-1775, :1889`) | invisible to the fresh-process memory gate |
| `archiveIndexRoot` has no producer/consumer | protocol close requires next root == current root | Phase 7; Discord cold-join stays blocked |
| No ≥ 100-transition test exists | deepest test epoch is 3 (`tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts:839`) | D.110c-d |

Recommended critical path (replaces the current seven slices):

1. **Design amendment** adopting §3; delete f5b0p-a/f5b0p-b entirely; fix the
   §4 items in the text; sign, push, run the one permitted Grok/Kimi/Opus
   confirmation.
2. **f5b0a** — fence and checkpoint codecs, `sequenceFloor`, profile union,
   global action reservation, owner list from §4.
3. **f5b0b** — Node admission, close split, dedicated fence issuer,
   anchor-agnostic own-row classification, `readRebaseOutbox` widened to
   "above `settledThrough`", `completeRebaseSource` unreachable under the
   profile.
4. **f5b0c** — room drain: expire/rebase/transform/manual-review, then fence.
5. **f5b-core** — creator scan with fence + floor, terminal recovery; causal RED
   through ≥ 3 closes with restart and cold reopen for creator and one
   non-creator writer, plus remove/re-add of the same key.
6. **f5b0d + D.110c-c wiring** — `transactAdvanceLineage`,
   `pruneAuthenticatedSettledPrefix` and its production invocation, the
   recovery-scan cap fix, journal/snapshot/seal/AHE scope retirement.
7. **D.110c-d** — ≥ 100 transitions with a non-creator writer and a durable
   census that includes issuance, journal, snapshot and seal rows.
8. **Phase 7** — non-creator hot follow, archive segmentation, cold join.

## 6. Alternatives considered and why not

- **Merkle AVL retired-key dictionary (current f5b0p).** Correct but pays an
  O(R) archive tier, a proof grammar with deterministic rotations, a
  strict-durability content-addressed store with candidate/current/rollback
  roots and reachability GC, up to ~14.9 MB of witness bytes per
  membership-changing close, and a new failure mode where an unavailable node
  stalls every ACL-changing close. It buys exactly one thing the floor does
  not: a returning author's pre-removal unadmitted rows stay rebase-eligible.
  Key-transparency systems that answer the same question use a version per
  label, never a set of retired keys; fenced systems need neither.
- **`admissionEpoch` incarnation in the latched ACL member record** (prior-art
  agent's recommendation). Equally sound and the closest to Kafka/Keybase, and
  it makes sequence-space burn purely self-inflicted. It costs an ACL snapshot
  schema change, an admission check `admissionEpoch ≤ vertex.epoch`, and a
  change to the equivocation scope (`protocol-v3/src/index.ts:1804-1808`) which
  is currently epoch-agnostic. The floor gets the same guarantee with one
  checkpoint integer and no ACL or admission change, so it is preferred; keep
  `admissionEpoch` as the fallback if review rejects a global floor.
- **Floor derived from `historySize`** (`9 × H`). Provable but bakes the
  carrier's source ceiling into a safety bound and is looser than the exact
  floor. Keep `F = H` only as the future v1→settlement migration derivation,
  which the explicit floor makes provable (every v1 boundary is a dense prefix
  of history leaves).
- **Per-epoch sequence reset** `(author, epoch, seq)`. The literal Kafka/MLS
  form; changes the wire meaning of `authorSequence` and every lifetime-keyed
  consumer. Unnecessary once the fence exists.
- **Admitted-gap lists or RFC 9162 inclusion proofs in the carrier**
  (verification/adversarial agents' amendments). Solve a case that contiguity
  makes unreachable for honest authors (§2).
- **Refuse full ACL removal until the registry lands** (golden-path agent's
  interim). A valid ordering hack for the dictionary design; unnecessary under
  the floor, which handles re-entry from the first close.

## 7. Decisions the team must make explicitly

1. **Policy:** a removed member's never-admitted rows become terminal at
   re-admission (content resubmittable, sequence linkage lost). This is the
   fenced-system norm and the only cost of dropping the dictionary. If the team
   rejects it, `admissionEpoch` does not help either; only the dictionary
   preserves it.
2. **Constant:** `K = maxEpochVertices + maxPendingEntries` as the per-epoch
   fence budget. It must be derived from authenticated payload parameters, not a
   literal, and the derived-constant sweep rule applies.
3. **Audit trail:** the creator no longer learns why a slot was abandoned. The
   author's issuance store remains the audit trail; if a creator-side record is
   wanted later it can be an optional, non-authoritative annotation on the fence.
4. **Genesis-only profile** stays as designed; the floor additionally makes a
   later v1 migration provable (`F = historySize`), which the dictionary design
   declared impossible.
