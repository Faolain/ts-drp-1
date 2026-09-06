# D.110c author settlement — adjudication of the peer review and amended plan

Date: 2026-09-03. Branch `codex/phase3a1b-p6-golden-path`, HEAD `e6a67013`. Read-only; no
tests run; the only file written is this one. Every code claim cites `file:line` as of HEAD.

## 0. Verdict in one paragraph

Both of the peer's blocking problems are real defects in `solution.md`, but the peer's fix
for problem 1 is wrong and its fix for problem 2 is over-scoped. The correct construction
is: **(a) durable disposition plan first, then the fence, then the replacements**
("plan-fence-replace"), with the source→replacement link written in the same store
transaction as each replacement; and **(b) `admissionEpoch` carried in the creator
checkpoint frontier `[author, admissionEpoch, terminalThrough]`, derived by the creator
from the ACL diff, with no ACL schema change, no issuance-store scope change, no
sequence reset, no global floor and no `K × epochs` bound.** Replacement-first
(peer) reintroduces "admitted above a gap" not only in the crash window but in the
ordinary case of a delayed fence, and the checkpoint cannot express that state; the
orchestrator's counter-concern is confirmed by the walk in §A.3. Fence-first's lost-work
crash is closed by the plan, not by reordering.

Disagreements with the peer, ranked (details in the cited sections):

| # | Peer claim | Ruling | Reason |
| --- | --- | --- | --- |
| 1 | Fence-first loses work on crash | **agree with correction** | True as written in solution.md (no durable plan). Fixed by the plan, not by reordering (§A.3, §A.4) |
| 2 | Correct order is replacements → fence, fence causally depends on replacements | **disagree** | Breaks contiguity; unsafe without any crash when the fence is delayed past a close (§A.3 rows 4, 6); needs admitted-gap evidence the design deleted |
| 3 | Global floor is the weakest part; `K` bound unproven | **agree** | `maxPendingEntries` bounds network ingress (`v3-live.ts:3755-3756`), not issuance; floor couples authors; floor needs a lineage jump that the store's dense-prefix invariants punish (§A.6, §B.2) |
| 4 | `admissionEpoch` must go into the ACL member record, issuance-store scope, pruning watermarks, equivocation identity | **agree with correction** | Checkpoint-only carriage gives the same guarantee with 1/5 of the blast radius; store scope, watermark and ingress are unchanged; equivocation canonicaliser is a P2 owner (§B.1, §B.2) |
| 5 | Rename `settledThrough` → `terminalThrough` | **agree** | The boundary means "terminal", not "admitted" |
| 6 | Sequence reset vs continue is security-irrelevant | **agree** | Continue is chosen because the store's `readIssued` latches corruption on consumed-but-absent ordinals (`browser-issuance-store.ts:443-447`, `node-issuance-store.ts:486-490`) |
| 7 | RED case "fence admitted without replacement must be impossible" | **disagree** | It is the normal state under plan-fence-replace; the invariant is "fence issued ⟹ complete durable plan" (§C.10 case 5) |
| 8 | Lifetime uniqueness already weakened by other-device sequences | **agree** | Already true today; same-key multi-device is terminal by design |
| 9 | Does not replace WRAPS | **agree** | Out of scope; unchanged |

## Part A — crash ordering

### A.1 What the store makes durable and atomic (facts)

- A durable issue is one transaction over `lineages` + `issuedRecords` + `issuanceOutbox`
  (browser: strict IDB transaction spanning `STORE_NAMES`, `browser-issuance-store.ts:176-181`,
  three stores `:1036-1038`; node: `BEGIN IMMEDIATE` … `COMMIT`,
  `node-issuance-store.ts:756-800`). `transactIssue(scope, buildAndSign)` is the only write
  path (`issuance-store/src/types.ts:56-59, :83-90`); the commit record has exact keys
  `["authorSequence","envelope","issuedRecord","outboxEntry"]` (`contract.ts:281`).
- The outbox row has exactly two states, `pending | published` (`types.ts:23`); "published"
  means handed to the network (`compareAndMarkOutboxPublished`, `types.ts:85`), never
  "admitted". There is no "complete", "replaced" or "linked" state anywhere in the store.
- Lineage is a dense prefix: `readIssued` on a consumed ordinal with no rows above the
  pruning watermark latches corruption (`browser-issuance-store.ts:443-447`,
  `node-issuance-store.ts:486-490`); terminal classification only ever examines
  `priorLineage.next` (`terminal.ts:120-124, :139-140`). Sequences are never burned without
  a row: a lineage race rolls back without consuming (`node-issuance-store.ts:761-767`,
  `ISSUANCE_RETRY_REQUIRED`), and an ambiguous commit is classified by readback
  (`:797-812`). The only gap-creating operation in either design is the floor's proposed
  `transactAdvanceLineage`.
- Local issue order is: `transactIssue` → authenticate row → index append → live-journal
  append → publish (`v3-live.ts:6015-6075`, journal kinds `live-journal/src/types.ts:40-54`).
  An unknown transaction outcome halts admission (`v3-live.ts:6027-6034`,
  `operationAdmissionHalted`). The live journal is per `(objectId, epoch, anchorDigest)`
  scope (`live-journal/src/types.ts:27-31`) and has no delete (`:138-145`); it is evidence,
  not intent, and is the wrong home for a plan.
- The browser store verifies the exact set of object-store names on open
  (`browser-issuance-store.ts:116-120`), so a new store is a schema-version bump; the node
  store already has a v1→v2 table migration precedent (`node-issuance-store.ts:249-254`).
- Local dependencies are the index tips (`v3-live.ts:6217-6240`); ingress refuses a vertex
  whose dependencies are not installed (`:3711-3716`, `:3862`); the close graph is the
  causally closed index. Therefore own vertex k+1 issued into the same epoch index always
  causally follows own vertex k, and **if the creator's graph holds k+1 it holds k**
  (contiguity). Crash between `transactIssue` and index append does not break this: on
  restart recovery replays own current rows into the index before any new issue
  (`:5436-5442`).
- Within one session the room dedupes replacements by application identity against
  in-memory `acceptedVertices` (`examples/v3-room/src/index.ts:1774-1775`, `:2715-2737`,
  `:2937-2943`), rebuilt from the *current* epoch only; it is empty after a close. For a
  *published* displaced source with a rebase/transform policy the room today requires the
  replacement to already be present in that map and otherwise throws
  `"published displaced operation is absent from target"` (`:2852-2857`). That is the
  in-code form of `already-present`, and it is exactly what the crash walk below shows is
  undecidable across a close.

### A.2 The two orderings, made precise

Notation: author A, prior boundary `s = 9`; rows 10, 11 issued in epoch N, not admitted;
epoch N+1 adopted; `lineage.next = 12`.

- **F (plan-fence-replace, this report).** P1 plan durable (`{10: rebase, 11: rebase}`,
  fence slot unset) → P2 fence issued at slot 12, `m = 12`, plan.fence = 12 in the same
  transaction → P3 fence published → P4 replacements issued at 13 (plan[10] := 13,
  same transaction), 14 (plan[11] := 14) → P5 plan complete → P6 prune after the
  checkpoint/adoption/rollback/availability gates.
- **R (replacement-first, peer).** P1 plan/link durable → P2 replacements at 12
  (plan[10] := 12), 13 (plan[11] := 13) → P3 fence at slot 14, `fenceSequence = 12`,
  causally depending on 12 and 13 → P4 publish → P5 sources complete.
- Solution.md's original (fence → replacements → sources complete, **no plan**) is
  strictly worse than F and is withdrawn; the peer's loss trace against it is correct.

### A.3 Crash walk (every crash point, both orderings)

"Close" means the creator's N+1 close captures the graph at that instant; anything not yet
delivered is absent from the graph. Columns: lost work / double-apply / creator stall.

| # | Crash or event | F: plan-fence-replace | R: replacement-first |
| --- | --- | --- | --- |
| 1 | Crash before the plan is durable | none / none / none — restart re-drains, sources still above `s` | same |
| 2 | Plan durable, crash before the first issue | none / none / none — restart reads plan; no fence row; issues it | none / none / none — issues replacement 12 |
| 3 | First issue durable but unpublished, crash | none / none / none — row is `current`+`pending`; recovery republishes (`v3-live.ts:5436-5442`); plan continues | same for replacement 12 |
| 4 | First issue published and **admitted**, crash before anything else, **close N+1 intervenes** | Creator: `s=9`, fence `m=12 > 9` → `s := 11`, slot 12 (fence) adjacent → `s = 12`. Author at N+2: rows 10, 11 ≤ 12 terminal; plan says both unfulfilled; issues 13', 14' in N+2 (the plan carries the disposition and reads the terminal rows' bytes; terminal means never republished/applied, not unreadable). **none / none / none** | Creator: `s=9`; slot 10 absent → adjacent scan stops; 12 is in the graph but non-adjacent → `s = 9`. Author at N+2: rows 10, 11 (epoch N) and 12 (epoch N+1) are all `> 9` with `epoch < current`. Plan says 10 → 12 issued. **Was 12 admitted?** The checkpoint cannot say: contiguity is broken by design because 12 does not depend on 10. Re-issuing 10 double-applies if 12 was admitted; fencing past 12 loses it if it was not. Row 12 itself is also classified displaced and would be re-rebased. **loss-or-double / yes / creator stuck at 9 until a later fence** |
| 5 | Some replacements issued, crash before the rest, no close | none / none / none — plan[10] := 13 was written in 13's transaction; restart issues 14 only | same, given the atomic link the peer also requires |
| 5b | As 5 but the link is **not** atomic (peer's "or") | Within epoch: journal replay rebuilds `acceptedVertices` → identity dedupe (`index.ts:2937-2943`). Across a close: 13 admitted ⇒ `s = 13` ⇒ 13 terminal; plan says 10 unfulfilled ⇒ re-issue ⇒ **double**. Atomic link is therefore mandatory under F too | same conclusion |
| 6 | All replacements issued and published; **close N+1 lands between the fence's admission and the replacements' delivery** (no crash; ordinary delay) | Creator: `s = 12` (fence). Author at N+2: 13, 14 are `> 12`, `epoch N+1 < N+2`, and by contiguity not admitted (they depend on 12, which *is* admitted, but they are absent) ⇒ displaced ⇒ new plan `{13: rebase, 14: rebase}` → fence(15, m=15) → 16, 17. **none / none / none** | Creator: 12, 13 admitted, fence 14 not; `s = 9` (gap at 10). Same undecidable state as row 4 **without any crash**. This is adversarial P1-1b reborn. **loss-or-double / yes / stuck** |
| 7 | Fence not admitted before close (delayed); replacements issued after it, also undelivered | Creator: `s = 9`. Author at N+2: 10, 11, 12 (fence), 13, 14 all displaced. Contiguity: 12 absent ⇒ 13, 14 absent. Plan: 10 → 13 and 11 → 14 fulfilled-but-displaced; 13, 14 become new sources; old fence row is control, never handed to the application, superseded by monotone `m`. Issue fence(15, m=15) → 16, 17. **none / none / none** | subsumed by row 6 |
| 8 | Close between the last replacement and "sources complete" | F has no completion step: sources become terminal through the checkpoint; the plan is complete when every entry has a link. **none / none / none** | R marks sources complete after the fence; the marking is redundant with the checkpoint either way |
| 9 | Rollback to the prior checkpoint after adoption | Boundaries regress with the closure; plan remains; an entry with a link is never re-dispositioned; the replacement row is an ordinary own row. **none / none / none** | same given the link |
| 10 | `transactIssue` outcome unknown mid-plan | Existing halt (`v3-live.ts:6027-6034`); reopen enumerates durable truth; because the plan effect is inside the same transaction there is no half-link. **none / none / none** | same |
| 11 | Manual-review entry present | No fence, no replacements, barrier holds (room `:2911`); other authors unaffected. **none / none / that author only** | same |
| 12 | Device loss | plan and rows lost together; identical under every design | same |

Rows 4 and 6 are decisive: R produces a state the checkpoint cannot describe and the
author cannot decide, and row 6 needs no crash at all. F never leaves contiguity, so
"above `terminalThrough` ⟹ not admitted" stays sound at every instant, and its only
weakness (row 4 under solution.md as written) is closed by the plan.

### A.4 Ruling on ordering

**Plan-fence-replace.** The fence is the first vertex the author issues after the drain
decides every source; every replacement causally follows the fence (it is issued into the
same index after the fence is locally admitted, `v3-live.ts:6217-6240`). The peer's
"fence causally depends on all replacements" is inverted. The fence does not need to name
replacements, and the creator never learns what happened to a slot; the author's plan is
the audit trail (solution.md §7.3 stands).

The idempotence key is the plan entry (source identity), not the fence and not the source
row's `publishState`. A source's terminal status is irrelevant to the plan: terminal means
"never republished, rebased-as-a-row, applied or used as evidence"; the plan still reads
the row's operation bytes to build the replacement. `pruneAuthenticatedSettledPrefix`
must therefore refuse to delete a source row referenced by an unfulfilled plan entry
(§C.8); ordinarily the plan is fulfilled long before the prune gates open.

### A.5 Where the plan lives and whether it is atomic with `transactIssue`

Home: the issuance store, as a fourth store `settlementPlans` keyed by
`[objectId, author]` (browser IDB schema v2 with `exactStoreNames` updated,
`browser-issuance-store.ts:116-120, :1036-1038`; node table with a v2→v3 migration in the
style of `:249-254`). Not the live journal (per-epoch evidence, no delete) and not the
room (in-memory). Contract additions (`issuance-store/src/types.ts`):

```ts
type SettlementDisposition = "expire" | "rebase" | "transform" | "manual-review";
interface SettlementPlanEntry {
  readonly sourceSequence: number;
  readonly sourceDigest: Uint8Array;
  readonly disposition: SettlementDisposition;
  readonly replacementSequence: number | null;   // set atomically when the replacement is issued
}
interface SettlementPlan {
  readonly scope: DurableIssueScope;
  readonly revision: number;                     // CAS token
  readonly fenceSequence: number | null;         // set atomically when the fence is issued
  readonly entries: readonly SettlementPlanEntry[];   // sorted by sourceSequence, unique
}
interface DurableIssueCommit { …existing…; readonly planEffect?:
  | { readonly kind: "fence" }
  | { readonly kind: "replacement"; readonly sourceSequence: number } }
interface DurableIssuanceStore { …existing…;
  readSettlementPlan(scope): Promise<SettlementPlan | null>;
  transactWriteSettlementPlan(input: { scope; expectedRevision: number | null; plan }): Promise<SettlementPlan>;
}
```

`transactIssue` applies `planEffect` inside the same strict transaction that writes
lineage/issued/outbox: for `fence` it sets `fenceSequence := commit.authorSequence`
(fails if already set); for `replacement` it sets the entry's `replacementSequence`
(fails if the entry is absent, already linked, or `manual-review`). The exact-key commit
validator (`contract.ts:281`) widens to accept the optional key. Atomicity is therefore
exactly the atomicity the store already provides (`browser-issuance-store.ts:176-181`,
`node-issuance-store.ts:756-800`). No second store, no cross-store transaction.

`transactAdvanceLineage` is **deleted** from the plan: under §B nothing needs a lineage
jump, and a jump is what creates the consumed-but-absent ordinals the store latches on.

### A.6 `maxPendingEntries` / `maxPendingBytes` and the `K` bound

Both parameters gate `registration.pendingIngress` — the map of *received* vertices
waiting for dependencies (`v3-live.ts:2652`; check at `:3755-3756`; parameters
`:855-856`). They do not bound local issuance. Local issuance per adopted epoch is bounded
by `index.size + requiredJoins + 1 ≤ maxEpochVertices` (`:6227`), and sequences are not
burned without rows (§A.1), so an honest author absent for `n` closes has at most
`(n+1) × maxEpochVertices` unaccounted rows. The peer is right that solution.md's
`K = maxEpochVertices + maxPendingEntries` is mis-derived; a provable `K` exists but is
irrelevant because §B removes the floor, and with it every reason to bound `m`. Under
`admissionEpoch` a runaway fence exhausts only its author's own sequence space
(`ISSUANCE_EXHAUSTED`, `types.ts:3`), recoverable by re-admission on a fresh device.

## Part B — global floor vs `admissionEpoch`

### B.1 True blast radius of `admissionEpoch`, from code

1. **Latched ACL.** Member record is exact-keyed `["author","finalityKey","groups"]`
   (`latched-acl.ts:8`; `copySnapshot` rejects any other key set `:143-156`); snapshot
   `version: 1 | 2` (`:32`, v2 added the `referee` group, commit `c17223b2`);
   `freezeMembers` drops a fully revoked key without trace (`:351-368`);
   `stageLatchedAclOperations` builds the successor from grant/revoke only
   (`:376-452`). Consumers of the canonical bytes/digest: 19 source files
   (`outcome-commit/src/index.ts` 16 refs, `examples/grid/src/v3-zone.ts` 13,
   `node/src/creator-close.ts` 9, `node/src/creator-adoption.ts` 9, `ephemeral` 9,
   `v3-room` 9, `snapshot-transfer.ts` 7, `v3-live.ts` 7, `protocol-v3/src/index.ts` 6 …);
   anchors bind `aclDigest` (`protocol-v3/src/index.ts:289, :453, :740`, verified
   `:1600-1604`); 14 files hand-build `kind: "drp-v3-latched-acl"` records. Every digest
   consumer is byte-opaque and survives a v3 member schema; every hand-built snapshot and
   every `copySnapshot`/`freezeMembers`/`stage` branch does not. **A member schema
   change is avoidable** (§B.2).
2. **Issuance store key.** Scope is `(objectId, author)` (`types.ts:25-28`); lineage is a
   dense prefix (§A.1). The incarnation matters only to the creator (which slot range is
   accountable) and to cross-device collisions (already terminal by design). A same-device
   re-added key simply continues at `lineage.next`; a fresh device starts at 0 under a new
   incarnation and cannot collide with the old one because every old-incarnation vertex is
   bound to an epoch `< admissionEpoch` and to a dead anchor. **No scope change; no reset.**
3. **Recovery classification.** `classifyPlaneVertex` tries exactly current, one
   `displacedSource`, pinned genesis, covered-historical (`v3-live.ts:4590-4645`; single
   predecessor `:5036-5040`; hard failure `:5436-5438`). The covered-historical path
   already authenticates an own row against the anchor/epoch decoded from the row itself
   (`:4762-4769`) — the anchor-agnostic shape the settlement profile needs, minus its
   `row.authorSequence ≤ admittedAuthorSequence` constraint (`:4756`). This change is
   required by the retained P1 ("rows older than one epoch") regardless of floor vs
   incarnation; `admissionEpoch` adds one predicate: `row.epoch < ownAdmissionEpoch ⟹
   old incarnation`.
4. **Pruning watermarks.** `prunedThroughAuthorSequence` is an inclusive prefix per scope
   (`maintenance.ts:14-18, :157-159`; browser `:589-682`; node `:631-743`). Because the
   lineage never resets and `terminalThrough` is monotone per incarnation on the device
   that issues the fence, old-incarnation rows on that device fall at or below the new
   boundary after the first fence and are prunable through the same prefix. **No
   watermark change.** (P3: a *stale* third device holding old-incarnation rows above the
   fresh device's boundary keeps them resident until it fences; bounded by what it issued.)
5. **Equivocation scope.** `EquivocationScope = {author, authorSequence, objectId}`
   (`protocol-v3/src/index.ts:1804-1808`); the canonicaliser authenticates each witness
   under its own `expectedAnchor` (`:3648-3665`), so a cross-anchor pair is accepted as a
   proof today. All 41 references are inside `protocol-v3/src/index.ts`; no package
   consumes proofs. Under `admissionEpoch` a same-slot pair across incarnations is not
   equivocation. **P2 owner:** require both witnesses to share `expectedAnchor`; no
   migration.
6. **Explicit admission check.** Ingress admits only vertices whose anchor is the current
   anchor and whose scope classifies as current (`v3-live.ts:3800-3829`,
   `expectedAnchor = payload.provenance.anchorDigest`, `classifyV3EnvelopeScope(...).current`).
   An old-incarnation vertex has `epoch < removalEpoch ≤ admissionEpoch ≤ currentEpoch`
   and a dead anchor, so it is already rejected. **No ingress check.** The check that is
   needed is (a) author-side classification (item 3) and (b) checkpoint binding: a
   frontier's `admissionEpoch` must equal `successorEpoch` for a member absent from the
   current ACL and must be copied unchanged for a retained member; both ACLs are already
   bound into the checkpoint by digest.

### B.2 Decision: `admissionEpoch` in the checkpoint frontier; no floor; ACL unchanged

- **Carrier:** `frontiers: [author, admissionEpoch, terminalThrough | null][]`, exactly
  the successor ACL's members (all roles, ≤ 64), creator-signed, in the transition
  closure. The creator derives `admissionEpoch` at close from "author ∈ current ACL?"
  which, because the prior checkpoint's vector equals the current ACL's member set, is
  the same as "author ∈ prior frontiers?". The verifier recomputes the rule from the two
  bound ACLs. Genesis members receive `admissionEpoch = 0` in the first checkpoint.
- **Why not in the ACL record:** the settlement path never needs the incarnation
  before the checkpoint exists, ingress is already anchor-fenced (B.1.6), and a v3 member
  schema costs every hand-built snapshot, three branches in `latched-acl.ts` and a
  version-3 negotiation for zero additional guarantee. If a later review wants the
  incarnation visible without the checkpoint, it can be added as ACL v3 then; nothing
  here depends on it.
- **Why not the floor:** (i) couples authors and inflates every returning key's space;
  (ii) needs a bound on `m` that solution.md derived from the wrong parameter (§A.6);
  (iii) needs `transactAdvanceLineage`, which manufactures consumed-but-absent ordinals
  that `readIssued` treats as corruption (`browser-issuance-store.ts:443-447`,
  `node-issuance-store.ts:486-490`) and that the terminal classifier never expects
  (`terminal.ts:139-168`); (iv) forfeits the bonus in B.4. The floor's single advantage
  (no checkpoint-diff rule) is not worth those.
- **Both?** No. With `admissionEpoch` the floor protects nothing.

### B.3 First accountable slot of a (re)added key; replacing `AUTHOR_REENTRY_PROOF_REQUIRED`

Today a prior-less writer whose first observed or local sequence exceeds one aborts the
close (`creator-close.ts:517-524`, constant `:71`; the only references are the definition
and this throw — no test). Under the settlement profile the rule for a member with
`terminalThrough = null` is:

1. If the complete close graph holds a valid fence of that member (`m ≤ f`, largest `m`),
   the accountable base is `m − 1` (or "before slot 0" when `m = 0`); then the adjacent
   scan runs from `m`.
2. Else if slot 0 of that member is in the graph, the adjacent scan runs from 0. This
   covers the creator's own genesis rows and a genuinely fresh device that issued before
   its first fence.
3. Else the boundary stays `null`; the close proceeds. No throw. The member harms only
   itself until it fences.

So: **a null-boundary member's first accountable vertex is a fence unless it is slot 0.**
The room always issues one fence per open/adopt after the drain (with `m = lineage.next`),
so the normal returning author satisfies rule 1 on its first close. Node-issued reserved
rows (`join`/`causalJoin`, `v3-live.ts:224`) that precede the fence are simply covered by
it. `creator-trusted-v1` keeps its throw byte-for-byte.

### B.4 The bonus the peer did not mention, and its exact condition

Under `admissionEpoch` the returning author's old-incarnation rows are *dead to the
protocol* but *alive in its store*. Rows that were never admitted can be re-issued under
the new incarnation instead of being terminalized — **but only if the author knows the
old incarnation's final boundary**: `publishState` cannot prove non-admission (a crash
between network send and `compareAndMarkOutboxPublished` leaves an admitted row
`pending`), and the checkpoint drops removed members. Default rule: old-incarnation rows
(`row.epoch < ownAdmissionEpoch`) are terminal at re-admission and are covered by the
first fence; their content is resubmittable by the application. Optional follow-on
(P2, not in this slice set): the author records its own last-adopted `terminalThrough`
durably in the plan store and, on re-admission, treats old-incarnation rows above that
value as `manual-review` candidates rather than terminal — never as automatic rebases,
because the recorded value may be stale by any number of closes. The floor cannot offer
even this, because it terminalizes by sequence rather than by incarnation.

## Part C — plan change

### C.1 Checkpoint (creator-signed, in the transition closure) — drop-in

```ts
{
  kind: "drp-creator-author-settlement-state", version: 1, protocolMajor: 3,
  objectId, genesisAnchorDigest, closedEpoch, closedAnchorDigest,
  successorEpoch, successorAnchorDigest, currentAclDigest, successorAclDigest,
  cutValueDigest, commitQcRef: { byteLength, digest }, snapshotManifestDigest,
  historyRoot, historySize, priorCheckpointDigest,
  priorCheckpointKind: "genesis" | "settled-v1",
  frontiers: readonly [author: string, admissionEpoch: number, terminalThrough: number | null][],
}
```

Rules: `frontiers` are strictly code-unit sorted, unique, and are exactly the successor
ACL's members (every role, ≤ 64). For a member present in the prior checkpoint,
`admissionEpoch` is copied unchanged and `terminalThrough` is monotone (null → number
allowed, number → null or lower rejected). For a member absent from the prior checkpoint,
`admissionEpoch = successorEpoch` and `terminalThrough = null`. The verifier recomputes
membership from the two bound ACLs. `sequenceFloor`, `admittedThrough`,
`retiredAuthorRegistryRoot/Size` and every v1 aggregate/retirement field are absent.
Predecessor rules (genesis sentinel or one adjacent settled-v1; mixed/skipped/downgraded
fail closed) and the 8,192-byte ceiling are unchanged; f5b0a re-measures the 64-member
max shape (same triple width as the measured 6,959 B).

### C.2 ACL member shape — unchanged

`LatchedAclMember` stays `{author, finalityKey, groups}` (`latched-acl.ts:8, :20-24`);
snapshot versions 1 and 2 are untouched. The incarnation is a checkpoint fact.

### C.3 Fence carrier (author-signed, existing v3 envelope) — drop-in

```ts
type AuthorFenceOperation = Readonly<{
  action: "$drp.author-fence.v1";
  fenceSequence: number;   // m: safe nonnegative integer, m ≤ outer authorSequence
  version: 1;
}>;
```

Meaning, signed by the outer vertex's author under `ts-drp/vertex/v3` at outer slot `f`:
"every slot of mine with sequence `< m` in my current incarnation is either already
admitted or abandoned and may never be admitted; every slot `≥ m` is current-epoch
work." Admission authority is ACL membership (any role); the operation never reaches the
blueprint reducer; the close-graph split (application ⊔ control) and the dedicated
control issuer are retained. There is no bound on `m` other than `m ≤ f`. No sources,
replacement refs, supersession, zero-intent, `coveredStateDigest` or presence query.

### C.4 Creator scan rule at close — drop-in

For each successor ACL member `A`, starting from the prior frontier
`(admissionEpoch = e, terminalThrough = s)` or `(successorEpoch, null)` for a member absent
from the current ACL:

1. Group `A`'s vertices in the complete current close graph by `(authorSequence, digest)`.
   A same-slot duplicate freezes `A` at `s` (existing `creator-close.ts:486-497, :528-546`
   semantics); a foreign-author slot at or below `s` freezes `A` at `s`; a creator-own
   regression keeps its fail-closed error.
2. Among `A`'s fence vertices take the largest `m` with `m ≤ f` and (`s = null` or
   `m > s`); set `s := m − 1` (`m = 0` ⇒ base before slot 0). Invalid fences are ignored;
   nothing aborts.
3. If `s = null` and no valid fence exists, scan from slot 0 if present; otherwise emit
   `null`.
4. Advance `s` across exactly adjacent graph slots `s+1, s+2, …`; never take an observed
   maximum; never cross an unknown slot.
5. Emit `[A, e, s]`.

Removed members are dropped from the vector; nothing is remembered. The close proceeds
when any foreign boundary cannot advance (f5a per-author liveness).

### C.5 Author rule at open/adopt (Node + room) — exact durable order

1. Read own `(e, s)` from the authenticated checkpoint. If own key is absent (not a
   member) the profile forbids issue.
2. Classify every own durable row (regardless of `publishState`, replacing the
   pending-only predicate at `v3-live.ts:6446` and the published-must-be-present path at
   `examples/v3-room/src/index.ts:2852-2857`), authenticating by own signature, scope and
   row digest against the anchor/epoch decoded from the row (the shape of `:4762-4769`),
   for any `epoch < current`:
   - `seq ≤ s` → terminal (never republished, rebased, applied or used as evidence);
   - `row.epoch < e` → old incarnation → terminal (B.4 default);
   - `row.epoch < current` and `seq > s` → **not admitted** (contiguity) → displaced;
   - `row.epoch = current` → current; recovery replays it.
   Control rows (fences) are never handed to the application; a displaced fence is simply
   superseded by the next fence. Reserved `join`/`causalJoin` rows are covered by the
   fence. A displaced `acl` row is surfaced to the application before any fence is issued.
3. Build the plan: one entry per displaced application source with the room's policy
   (`expire | rebase | transform | manual-review`). If a durable plan already exists,
   merge: entries with a `replacementSequence` are kept as fulfilled; a replacement row
   that is itself now displaced becomes a new source entry; a displaced fence clears
   `fenceSequence`. Write it with `transactWriteSettlementPlan` (CAS on `revision`)
   **before any issue**.
4. If any entry is `manual-review`, stop: no fence, no replacements, barrier holds
   (existing `rebasePromise` barrier, `index.ts:3844`).
5. Issue the fence through the dedicated control issuer with `m = lineage.next` and
   `planEffect: {kind: "fence"}`. Node refuses a fence issue unless a durable plan
   exists whose entries are all `expire`, `rebase` or `transform` (no `manual-review`)
   and whose `fenceSequence` is null. Publish it.
6. Issue each `rebase`/`transform` replacement as an ordinary application vertex with
   `planEffect: {kind: "replacement", sourceSequence}`; the link is durable in the same
   transaction as the row. `expire` entries need no issue.
7. The plan is complete when `fenceSequence` is set and every non-`expire` entry is
   linked. No source row is ever "marked complete": sources become terminal through the
   next checkpoint. `completeRebaseSource` (`v3-live.ts:6637-6685`; room callers
   `index.ts:2814, :2971`) is unreachable under the profile.
8. Later pruning (`pruneAuthenticatedSettledPrefix`) waits for checkpoint staging,
   verified adoption, rollback-generation retention, availability, expected lineage and
   watermark, **and refuses any row referenced by an unlinked plan entry**.

Restart at any point re-runs 1–7 from durable truth; the idempotence key is the plan
entry; the fence is re-issued only if `fenceSequence` is null or the linked fence row is
classified displaced.

### C.6 ACL add/remove rule — drop-in

- Retained member (present in both ACLs, any role): frontier copied with its scanned
  `terminalThrough` and unchanged `admissionEpoch`. Losing the writer role changes
  nothing in the vector.
- Removed member: dropped. Its unadmitted rows are dead to the protocol; its device keeps
  them.
- Added member (fresh or returning, indistinguishable and irrelevant):
  `[author, successorEpoch, null]`. Its first accountable vertex is a fence or slot 0
  (B.3). Local lineage continues on a returning device and starts at 0 on a fresh one;
  neither needs a store operation.

### C.7 Failure / crash matrix rows — replacing the current table

| Boundary or attack | Required result |
| --- | --- |
| crash before plan durable | restart re-drains; nothing issued twice |
| plan durable, crash before fence | restart issues the fence once |
| fence durable, unpublished | restart republishes; plan proceeds |
| fence admitted, crash before replacements, close intervenes | boundary = fence slot; sources terminal; restart issues every unlinked entry once in the new epoch |
| replacement issued, crash before the rest | linked entry never re-issued; unlinked entries issued once |
| replacements delayed past close while fence admitted | boundary = fence slot; replacements re-planned as new sources; no double |
| fence delayed past close | boundary unchanged; fence and everything after it re-planned; larger `m` next epoch |
| transaction outcome unknown mid-plan | admission halts; reopen enumerates durable truth; no half-link exists |
| rollback after adoption | boundaries regress; linked entries never re-dispositioned |
| manual-review entry | no fence, no replacements; only that author stalls |
| honest delivery gap (10 delayed, 11 after it) | 11 never admitted without 10; both displaced; plan; fence; advance |
| author absent ≥ 2 closes | rows classified by own signature/scope/digest for any old epoch; no hard failure |
| fence `m > f`, or `m ≤ s` | ignored; no abort |
| Byzantine fence far ahead | only that author's space burns; recoverable by re-admission on a fresh device |
| Byzantine omission of own predecessor | only that author's boundary stalls |
| same-slot duplicate | author frozen at prior boundary; close proceeds |
| same-key removal and re-entry, same device | new `admissionEpoch`; old rows terminal; first fence at `lineage.next` establishes the base; sequence continues |
| same-key re-entry, fresh device | lineage 0; fence or slot 0 accepted; no collision with the old incarnation |
| stale old-incarnation vertex delivered | rejected at ingress by anchor (existing); ignored by the scan |
| frontier `admissionEpoch` ≠ rule, boundary regression, vector ≠ successor ACL | checkpoint rejected at verify/open |
| control vertex in close graph | in charges/frontier/close-set/history; excluded from the application fold |
| row substitution at or below `terminalThrough` | terminal; never applied |
| legacy v1 room receives fence/profile | unsupported/mixed-profile rejection; v1 unchanged |
| creator's own displaced row | same plan/fence path; no legacy retirement record under the profile |
| null-boundary member with no fence and no slot 0 | boundary stays null; close succeeds (replaces `AUTHOR_REENTRY_PROOF_REQUIRED` under the profile) |
| prune with an unlinked plan entry | refused |
| cross-object migration import | manual-review debt; unchanged |

### C.8 Store contract additions (single owner: `@ts-drp/issuance-store`)

As in §A.5: `settlementPlans` store; `readSettlementPlan`; `transactWriteSettlementPlan`
(strict, CAS); `DurableIssueCommit.planEffect`; `pruneAuthenticatedSettledPrefix` gate on
unlinked entries. Memory, browser (IDB v2) and node (table migration) implementations
plus conformance vectors. `transactAdvanceLineage` is not added.

### C.9 Revised TDD slices (replacing the seven)

Deleted: **f5b0p-a** (Merkle AVL dictionary/profile) and **f5b0p-b** (retired-author
registry store). Ordering below is the dependency order; each slice has one tests-only RED
before its GREEN, as today.

1. **f5b0a — protocol codecs.** Fence codec (`$drp.author-fence.v1`, global reservation,
   blueprint-preparation rejection), settlement checkpoint codec with
   `[author, admissionEpoch, terminalThrough]` and the derivation/binding rules of C.1,
   genesis/settled predecessor rules, byte ceiling re-measurement, profile union
   (`protocol-v2/src/registry.ts:460` switch, control-plane normalization
   `creator-trust-checkpoint-advance.ts:198-207`, closure validators
   `creator-transition-advance.ts:326-328, :397-398`), equivocation canonicaliser
   same-anchor rule (`protocol-v3/src/index.ts:3648-3665`). Absorbs §4: closure-validator
   P1; control-vertex-cap P2 (resolved as "largest valid `m`, no cap");
   `closeVertices` naming P2 is deferred to f5b0b.
2. **f5b0s — settlement plan store (new).** C.8 in full. Absorbs §4: "no owner for the
   lineage jump" P1 (resolved as no jump); "two owners can complete a source" P1 is
   prepared here (plan is the only completion authority) and enforced in f5b0b.
3. **f5b0b — Node.** Dedicated fence issuer over `transactIssue` + `planEffect`; refusal
   without a complete plan; own-row classification for any `epoch < current` and for
   `epoch < admissionEpoch` (anchor-agnostic, replacing the single-predecessor classifier
   `v3-live.ts:4590-4645`); `readRebaseOutbox` → `readSettlementSources` returning every
   own row above `terminalThrough` regardless of `publishState` (reopening
   `plan-v2.md:98815-98823`); `completeRebaseSource` unreachable under the profile;
   close-graph split with the rename (`applicationVertices/...` at `:7433-7435` are the
   complete maps today). Absorbs §4: published-row P1; unclassifiable-rows P1;
   two-owners P1; `closeVertices` P2; compaction retained-invariant test (no control
   operation reaches authorization/reservation/apply/ACL staging/projection).
4. **f5b0c — room.** Plan building and merge (C.5 steps 2–4), fence-then-replacements
   order, deletion of `already-present`, `hasDisplacedOperation` and the
   published-must-be-present throw (`index.ts:2852-2857`), ACL-row surfacing,
   manual-review hold, migration-import refusal. Public `issue()` unchanged.
5. **f5b0d — reclamation.** `pruneAuthenticatedSettledPrefix` (mixed epochs, pending and
   substituted rows, stale lineage/watermark, partial failure, rollback, v1
   non-interference) plus the plan gate, its production invocation on every peer after
   the adoption gates, and the recovery-scan cap fix (`v3-live.ts:4349-4355` →
   `(rollback + 1) × maxEpochVertices` or scan from the watermark). Absorbs solution §5
   rows 1–2.
6. **f5b — creator settlement and recovery integration.** C.4 scan under the profile
   (fence, `admissionEpoch` derivation, null-boundary rule replacing the throw at
   `creator-close.ts:517-524`, no v1 aggregate/legacy retirement), terminal recovery,
   causal RED through ≥ 3 closes with restart and cold reopen for the creator and one
   non-creator writer, same-key remove/re-add on the same device and on a fresh device,
   old-incarnation delivery, manual review, Byzantine fence. Absorbs §4: inverted
   boundary P0 (resolved by one boundary); `AUTHOR_REENTRY_PROOF_REQUIRED` P1.
7. **D.110c-c, D.110c-d, Phase 7** — unchanged from solution.md §5.

Slices 1 and 2 are independent and may run in parallel; 3 needs both; 4 needs 3;
5 needs 1–2; 6 needs 1–5.

### C.10 Deterministic RED case list

Starting from the peer's 14; (P) = peer's case kept, (P*) = kept with correction,
(+) = added from the crash walk, (−) = dropped.

1. (P) Delayed dependency: 10 delayed, 11 causally after it; creator boundary stays at 9;
   11 is never in a graph without 10; author plans both; fence; advance at next close.
2. (P*) Crash after the fence is admitted, before any replacement, with a close in
   between: boundary = fence slot; restart issues every unlinked entry exactly once in the
   next epoch; content not lost (A.3 row 4).
3. (P*) "Crash after replacement but before fence" is unreachable under plan-fence-replace;
   replaced by: crash between two replacements, restart in the same epoch and after a
   close; the linked entry is never re-issued; the unlinked one is issued once.
4. (P) Crash after the fence but before the checkpoint: fence unpublished → republished;
   fence published but displaced → next drain issues a larger `m`; never two accepted
   fences for one plan.
5. (P*) "Fence admitted without replacement must be impossible" → inverted: Node refuses a
   fence without a complete durable plan (missing, `manual-review`, or `fenceSequence`
   already set); a fence admitted before its replacements is the normal state and is safe.
6. (P) Author absent for ≥ 2 closes: rows two or more epochs old classified by own
   signature; drain; fence; advance; no `admission-rejected`.
7. (P) Full removal and same-key re-entry on the same device: new `admissionEpoch` in the
   checkpoint; old-incarnation rows terminal; first vertex is a fence at `lineage.next`;
   creator establishes the base from it; sequence continues.
8. (P) Fresh-device re-entry: lineage 0; fence at 0 (or slot 0) accepted; the old device's
   rows never collide.
9. (P) Stale old-incarnation delivery: a vertex with `epoch < admissionEpoch` is rejected
   at ingress by anchor; the scan ignores it; no equivocation proof materializes for a
   cross-anchor pair.
10. (P) Duplicate replacement prevention: the link is atomic with the row; restart in the
    same epoch and after a close produce exactly one replacement per source.
11. (P) Manual-review hold: no plan completion, no fence, no replacements; other authors
    advance; resolving the hold later completes the plan.
12. (P) Byzantine fence jump: `m` huge with `m ≤ f` accepted and only that author's space
    burns; `m > f` ignored; `m ≤ s` ignored; two fences → largest valid `m`.
13. (P) Pruning only after authenticated adoption, rollback and availability gates, and
    refused while any plan entry is unlinked.
14. (P) Repeated restart/reopen across ≥ 3 transitions for the creator and one non-creator
    writer, with cold reopen, and durable census.
15. (+) Replacements delayed past the close while the fence is admitted (A.3 row 6):
    boundary = fence slot; replacements become new sources; no double apply.
16. (+) Fence delayed past the close with replacements issued after it (A.3 row 7): nothing
    admitted; re-plan; larger fence; no double apply.
17. (+) Null-boundary member with no fence and no slot 0: boundary stays null; close
    succeeds; the v1 room keeps `AUTHOR_REENTRY_PROOF_REQUIRED`.
18. (+) Checkpoint binding: verifier rejects a retained member's changed `admissionEpoch`, an
    added member's `admissionEpoch ≠ successorEpoch`, boundary regression, and a vector that
    is not exactly the successor ACL's members.
19. (+) Published displaced source (the commonest displacement) is surfaced by the drain;
    the room's "absent from target" path (`index.ts:2852-2857`) is unreachable under the
    profile.
20. (+) `completeRebaseSource` unreachable under the profile; the plan is the only
    completion authority.
21. (+) Reserved rows: displaced `join`/`causalJoin` covered by the fence with no application
    effect; displaced `acl` row surfaced to the application before the fence.
22. (+) Genesis: first checkpoint assigns `admissionEpoch = 0` to every genesis member; the
    creator's slot-0 rows are accounted without a fence.
23. (+) Same-slot duplicate below the fence: author frozen at the prior boundary; close
    proceeds; other authors unaffected.
24. (+) Rollback after adoption: boundaries regress; linked plan entries are not
    re-dispositioned; the plan survives.
25. (+) Transaction outcome unknown while issuing a fence or a replacement: admission halts;
    reopen finds either the row with its link or neither.
26. (−) Every `sequenceFloor` case from solution.md §3.6 (regression, null with non-null
    boundaries, floor poisoning, lineage jump) — the field no longer exists.
27. (−) Every dictionary/registry case (proof, store unavailable, reachability GC).

## Stop rules (unchanged)

No new cryptography; no protobuf/wire-envelope change (the fence is an operation inside
the existing envelope; the plan is device-local); genesis-bound
`creator-trusted-settlement-v1` with no v1 migration or late opt-in; creator-trusted
authority model; `creator-trusted-v1` behavior byte-for-byte unchanged. If review shows
that a durable device-local plan is insufficient authority for the author's own
abandonment, or that anchor fencing is not the admission check for old incarnations,
stop and reslice rather than reintroducing the floor or the dictionary.
