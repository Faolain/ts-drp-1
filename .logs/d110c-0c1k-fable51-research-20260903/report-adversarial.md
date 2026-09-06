# Adversarial and safety analysis — scaling writers beyond 64 under the f5b0r settlement design

Read-only analysis, branch `codex/phase3a1b-p6-golden-path`. Sources read in full:
`.logs/d110c-0c1f5b0r-design-3a156aca/design.md` (the accepted settlement design),
`.logs/d110c-0c1f5b0-fable51-research-20260903/plan-change.md` Parts A–C,
`lineage-profiles-impact.md` §2.C and §4. Every code claim verified at file:line as of
the working tree; byte numbers measured with the repo's own canonical encoder
(`packages/canonical/dist/src/index.js`).

## 0. Verified code facts everything below stands on

| Fact | Location |
| --- | --- |
| ACL member cap 64, canonical ceiling 8,192 B, decode `maxItems: 512`, `maxDepth: 4` | `packages/protocol-v3/src/latched-acl.ts:16`, `:134`, `:206`, `:218` |
| Authorization = `members.find(...)` linear scan, member AND (permissionless OR writer) | `latched-acl.ts:325-339` (`:336` the predicate) |
| Frontier record ceiling 8,192 B; frontier entries ≤ 64; author list ≤ 64 | `packages/protocol-v3/src/creator-author-issuance-frontiers.ts:12`, `:165`; `packages/protocol-v3/src/index.ts:774` |
| Creator close scans only closure blobs ≤ `SCANNABLE_BYTES = 8192`; larger refs silently skipped | `packages/node/src/creator-close.ts:69`, `:620`, `:994` |
| Close scan: one pass over `graph.authors`, per-author `number[]`, `sequences.includes` duplicate check (O(k) per vertex), then sort + adjacent walk | `creator-close.ts:485-500`, `:528-546` |
| `AUTHOR_REENTRY_PROOF_REQUIRED` close-aborting throw for prior-less writers | `creator-close.ts:71`, `:517-524` |
| Bounded-advance predicate: full-vector `Map` of proposed frontiers, iterate current, reject regression — O(N) and completeness-by-construction | `packages/node/src/internal/creator-transition-advance.ts:440-445` |
| Ingress admits only current-anchor/current-epoch vertices (`classifyV3EnvelopeScope(...).current`) | `packages/node/src/v3-live.ts:3795-3829` |
| Dependencies must be installed; local issue bounded by `index.size + requiredJoins + 1 ≤ maxEpochVertices` (global, not per-author) | `v3-live.ts:3711-3716`, `:6220-6228` |
| `maxPendingEntries/maxPendingBytes` bound received-pending ingress only | `v3-live.ts:3750-3757`, params `:850-857` |
| Charges are per-vertex byte charges keyed by digest — **no per-author quota anywhere** | `v3-live.ts:838`, `:1622-1629`, `:7434` |
| Equivocation canonicaliser authenticates each witness under its own `expectedAnchor` (cross-anchor pair accepted today; f5b0a adds same-anchor rule) | `packages/protocol-v3/src/index.ts:3645-3665` |

### Measured checkpoint growth (repo canonical encoder, triple `[64-hex author, admissionEpoch, terminalThrough]`)

- Fixed overhead (empty frontier, max-length objectId, worst-case integers): 1,339 B. Per member: **72–77.3 B** (worst-case integers).
- Worst-case shape: N=64 → 6,283 B; **first N over the 8,192 ceiling: N=89**; N=128 → 11,236 B; N=1,024 → 80,524 B; N=10,000 → 774,668 B.
- Realistic shape (short objectId, 3–4-digit epochs/boundaries): N=64 → 5,801 B; **first N over 8,192: N=97**; N=128 → 10,538 B.
- Design's own f5b0a figure (6,959 B at 64) is consistent with this range.

So the settlement checkpoint as frozen tops out at **≈88 members guaranteed / ≈96 lucky**. Profile D's "≤128 active writers per 5-min window" (plan-v2 ~:18117) does not fit the frozen carrier even before the ACL's own ceiling is considered (64 full-shape ACL members already measure 12,888 B > 8,192, `lineage-profiles-impact.md` §2.C.1).

---

## 1. Settlement frontier growth

- **Ceiling crossing:** N=89 worst-case / N=97 realistic (measured above). Every direction that keeps the flat triple vector dies between 88 and 96 members, far below even Profile D's 128.
- **The silent failure mode is worse than rejection (P0 for direction A):** the codec ceiling (`creator-author-issuance-frontiers.ts:12` and the design's "maximum 8,192 canonical bytes") is duplicated as `SCANNABLE_BYTES = 8192` at `creator-close.ts:69` and used as a *filter*, not a validator, at `:620` and `:994` (`.filter(({ ref }) => ref.byteLength <= SCANNABLE_BYTES)`). Raise the codec ceiling without this constant and an oversized checkpoint is **silently dropped from the closure candidate set** — the advance predicate then sees a closure with no settlement checkpoint. This is the derived-constant-adjacency failure class already on record; any cap raise must sweep `SCANNABLE_BYTES`, `latched-acl.ts:218` (`maxItems: 512` — 64 members × ~8 decoded items/member is already at the cap), `index.ts:774`, `frontiers.ts:165`, and the tests pinning 65.
- **Cold reopen:** O(1) in epochs by design (opener never walks the chain, design.md "Predecessor rules"), but O(N) in members to decode/verify one checkpoint. At N ≤ 10,000 that is < 1 MB and single-digit ms — decode cost is a non-issue; the *ceiling* is the binding constraint, not CPU.
- **Creator close scan:** the current implementation is one pass over `graph.authors` + per-author sort (`creator-close.ts:485-500`) — O(V log V) in epoch vertices, **independent of N**, plus O(N) frontier emission for members with zero vertices. The design's C.4 text ("For each successor ACL member A, group A's vertices in the … close graph") reads as per-member grouping; implemented naively that is O(N × V) = 82M vertex visits at N=10,000, V=8,192. The single-pass grouping must be kept (P2 implementation note, all directions).
- **Bounded-advance predicate:** full-vector compare (`creator-transition-advance.ts:440-445`) is O(N) time and memory per close — fine to 10,000 — but its *completeness guarantee* ("vector is exactly the successor ACL's members", design.md frontier rule, RED case 18) is what makes boundary-drop attacks impossible. Every direction that makes the vector sparse (C, E) loses this rule and must replace it (see §3, §7).

## 2. Fence overhead

Honest cost: one fence per author per epoch (design.md: "one control vertex per author per epoch"; re-issue only if `fenceSequence` null or fence displaced — so crash-loops within an epoch do not multiply it). Against the 8,192-vertex epoch:

| N writers | fences/epoch | fraction of epoch |
| --- | --- | --- |
| 128 | 128 | 1.6% |
| 1,024 | 1,024 | 12.5% |
| 4,096 | 4,096 | 50% |
| 8,192 | 8,192 | **100% — the epoch admits nothing but fences** |

So the fence design is structurally sound to ~1,000 writers per epoch and self-destructs around N ≈ maxEpochVertices. Note the fence is only issued by authors that *open/adopt* in the epoch; idle connected authors do not re-fence. For chat, the fencing population is "authors that reconnected this epoch", which for mobile clients tracks reconnect churn and can approach the active-writer count every epoch.

- **Byzantine fence exhaustion (P1, all directions):** the epoch vertex/byte budget is **global** (`v3-live.ts:6227`, `:2349-2350`) and charges are per-vertex with no per-author quota (`v3-live.ts:838`, `:1622-1629`). Admission authority for a fence is "ACL membership of any role" and the scan "ignores invalid fences; nothing aborts" (design.md fence carrier / scan step 2). A Byzantine writer — or a coalition of W cheap writers — can issue fence (or any) vertices until `maxEpochVertices` is consumed and every honest writer gets "v3 local issue graph is at capacity". This is not new to the settlement design (any op spam does it) but the design's matrix row "Byzantine fence far ahead → only that author's space burns" is answering a *different* attack. The matrix is silent on shared-budget exhaustion, and at N > 64 with cheap admission it becomes the cheapest liveness attack. Added rule needed: per-author per-epoch vertex/byte quota enforced at ingress and audited in the close charge accounting.
- **Huge `fenceSequence` (verified harmless to others, P3):** `m ≤ f` and `f` is the outer `authorSequence`, which a Byzantine author chooses freely (its own signature; the durable store's dense-prefix discipline binds only honest devices). `m = 2^53−1` → scan sets `s := m−1`; the checkpoint stores a 16-digit integer (+~9 B); the adjacent-walk never iterates the gap (sorted slots, walk-while-adjacent, `creator-close.ts:500`, design C.4 step 4 "never cross an unknown slot"). Cost to others: ~none. Cost to the attacker: its sequence space is gone. "Only that author's space burns" is accurate — but *recovery is a creator action* (removal + re-add resets the line to `[author, successorEpoch, null]`). At N=10,000 the creator becomes a manual re-admission desk; at 64 that was tolerable, at scale it needs an automated re-admission policy (P3).

## 3. Sparse and churning writer sets

The design's rule is: frontier = **exactly** the successor ACL's members; removed member dropped, "nothing is remembered about them"; re-added member `[author, successorEpoch, null]` (design.md ACL transition law). Attacks on making this sparse/windowed:

- **Return after 500 epochs (member the whole time):** safe and cheap — the line was carried (72–77 B/epoch of checkpoint space), `admissionEpoch` unchanged, rows classified by own signature/scope/digest for any old epoch (design.md drain step 2; matrix "author absent across two or more closes"). Cost: an idle member burns a frontier line forever, which is exactly why the flat carrier can't hold a chat roster.
- **Return after 500 epochs (dropped meanwhile, direction C/E):** fresh `admissionEpoch`; **every unadmitted row from before the drop is `epoch < e` → terminal, not displaced** (drain step 2). The plan never sees them; content is "resubmittable by the application" — i.e. the settlement machinery silently downgrades from auto-rebase to manual resubmit at every membership gap. For chat this means: any message in flight when your window membership lapses is dropped on the floor unless the app re-sends. Not a safety break, but a real durability regression the design's matrix does not cover, because the matrix assumes membership continuity (P1 for C/E). The B.4 mitigation (durable own last-adopted `terminalThrough` → `manual-review` candidates) is explicitly deferred and unowned (design.md "Retained findings absorbed", last bullet) — at high churn it stops being optional.
- **Can an old-incarnation vertex be replayed if anchors are the only fence? No — and this is the load-bearing invariant.** Ingress admits only vertices whose `anchor`/`epoch` classify as *current* (`v3-live.ts:3795-3829`); every close changes the anchor; so any vertex issued in a closed epoch is unadmittable everywhere, forever, regardless of membership bookkeeping. This holds for every direction A–E **as long as admission changes only take effect at epoch boundaries.** The one construction that breaks it is mid-epoch (re-)admission: two incarnations of one author sharing one anchor makes old-incarnation rows ingress-admissible and turns a same-slot old/new pair into a fake equivocation proof (the canonicaliser accepts cross-anchor pairs today, `index.ts:3645-3665`, and the f5b0a same-anchor fix assumes incarnations never share an anchor). **Any ticket/roster direction must latch admission to epoch closes (P0 rule for C and E).**
- **Writer never in any checkpoint:** under the frozen design it cannot issue — drain step 1: "A key absent from the vector is not a member and may not issue", and authorization requires ACL membership even when permissionless (`latched-acl.ts:336`). Under E (activity-scoped lines) a first-appearance author has no line for the creator to start from; the creator cannot derive `admissionEpoch` from an ACL diff that doesn't exist, and "nothing is remembered" means the creator can't distinguish first-appearance from returning-after-gap. Every gap ⇒ fresh incarnation ⇒ the durability regression above, now on *every* close for slow clients (a message issued at epoch end, delivered after the close, is `epoch < current` and — with the fresh incarnation — `epoch < e`, terminal). **P0 for E as literally specified in the brief.**
- **Malicious creator dropping an active member's line:** under the frozen design impossible (completeness rule, RED 18). Under C/E the completeness rule is gone; a dropped line resets the boundary to null and forgets `terminalThrough`. Replay of at-or-below-boundary rows is still blocked by anchor fencing (they're from closed epochs), so this is a *work-destruction* attack (creator terminalizes your in-flight work by dropping your line), not a replay attack. The creator is trusted in this profile family, so this is consistent with the trust model — but it must be stated, because "creator-trusted" was previously bounded by fail-closed rules the sparse carrier deletes.

## 4. Sybil and permissionless

- **What bounds distinct author keys per epoch?** Only two things: ACL membership (≤64 today — `latched-acl.ts:134`, and membership is required even for permissionless rooms, `:336`) and, absent that, the global epoch budget: at most `maxEpochVertices` = 8,192 distinct authors can appear in one epoch (one vertex each). Truly permissionless writing (E) with per-appearance frontier lines ⇒ up to 8,192 lines × ~77 B ≈ **630 KB checkpoint** — 77× the ceiling — and an 8,192-member scan/advance per close.
- **Cheapest unbounded-cost attack:** key generation is free; one signature per vertex. Attacker mints 8,192 fresh keys per epoch, one minimal vertex each. Under E: checkpoint size and scan state grow to the epoch budget every epoch; under C-with-cheap-tickets: same, bounded by ticket issuance. The attack costs the attacker ~8,192 ed25519 signatures (< 1 s of CPU) per epoch. Nothing in the current code path charges an author for *existing* — charges are per-vertex bytes only.
- **What stops it without a central service:** the room already has a creator that closes every epoch (creator-trusted profile family); a **creator-signed writer ticket** (direction C) is therefore not a new trust assumption — admission cost is one creator signature, and the creator bounds cardinality by policy (per-window ticket count). Alternatives that avoid even the creator (PoW per admission, stake) are foreign to this codebase's trust model and buy nothing here: the creator can already censor at close. Rule: **the number of frontier-line-bearing authors per epoch must be creator-bounded (ticket count ≤ K), and K must be derived from the checkpoint carrier's measured capacity**, exactly as the 64 cap should have been derived from the 8,192 ceiling (it wasn't — 64 full-shape members overflow it, `lineage-profiles-impact.md` §2.C.1).

## 5. Equivocation and same-slot duplicates at scale

- **Creator memory:** the scan's grouping state is O(epoch vertices), not O(N × V) — one `Map<author, number[]>` filled in a single pass (`creator-close.ts:485-497`). The design's per-author `(authorSequence, digest)` grouping has the same bound: total entries ≤ V = 8,192. An attacker cannot exceed the epoch budget no matter how many keys it holds, so **O(N × epochVertices) work cannot be forced** — provided the implementation keeps single-pass grouping (the C.4 prose invites a per-member re-scan; see §1).
- **Quadratic wrinkle (P2 today, P1 if V is raised):** the duplicate check is `sequences.includes(identity.authorSequence)` — O(k) per vertex, O(k²) per author (`creator-close.ts:489`). One author filling the epoch: 8,192²/2 ≈ 33M comparisons — tens of ms, tolerable. Raise `maxEpochVertices` to accommodate more writers (direction A's natural companion move) and this goes quadratic in the raise: 65,536 vertices → 2.1G comparisons per close. Replace with a `Set` before any epoch-size raise.
- **Same-slot duplicate:** freezes that author at the prior boundary, close proceeds (design C.4 step 1, matrix row) — the attacker only hurts itself; verified consistent with the duplicate handling at `creator-close.ts:489-495`.
- **Cross-incarnation framing:** today the canonicaliser accepts a cross-anchor same-slot pair as an equivocation proof (`index.ts:3645-3665` authenticates each witness under its own `expectedAnchor`). With incarnation churn at scale (C/E: constant re-admission), an old-incarnation row + a new row at the same slot is an easy frame. The design's f5b0a same-anchor rule closes this; at N>64 with churn it stops being a P2 cleanup and becomes a **precondition** (P1): ship it before, not with, any writer-scaling direction.

## 6. Authorization hot path

- **Today:** `authorizeLatchedApplicationWrite` does a linear `members.find` per authorization (`latched-acl.ts:339`). At N=10,000 and 100 ops/s that is ≤ 1M 64-char string compares/s — noise next to the ed25519 verify per vertex (~50–100 µs, which dominates everything). CPU is not the constraint at any N in scope; **bytes and the decode caps are** (`maxItems: 512` at `latched-acl.ts:218` breaks first, at ~64 members). A Map-keyed member set is a one-line hygiene fix, not a scaling requirement.
- **Direction B, Merkle-proof-per-vertex:** proof depth ⌈log₂N⌉ = 14 at N=10,000, ~32 B/level + positioning ≈ **450–500 B and 14 hashes per vertex**. At 100 ops/s: ~45–50 KB/s of proof bandwidth per receiving peer and ~1,400 SHA-256/s — both trivial (the signature verify per vertex costs more CPU than the proof). **Invalid-proof DoS is a non-issue relative to the existing surface:** rejecting a bad proof costs ≤14 hashes, ~50× cheaper than the signature verification the peer already performs on every received vertex; an attacker who can flood vertices DoSes you with signature checks long before proofs matter. The real costs of B are *systemic*: (a) who delivers an author its own path at open — a proof carrier that does not exist and is an explicit stop-rule trigger if attempted inside f5b (`lineage-profiles-impact.md` §2.C.3(d)); (b) the completeness rule and the bounded-advance predicate become authenticated-delta verification: the verifier must recompute the successor root from the prior root plus the complete change set, or a creator can mutate an unlisted leaf. Both are solved problems (the checkpoint is a versioned kind-tagged blob; a `version: 2` carrier swap is not a wire break, §2.C.2), but they are a design-and-slice effort, not a knob.
- **Full member set per epoch at N=10,000 (B's non-proof variant / A-extreme):** canonical bytes ~0.8–1.5 MB; in-memory JS Map with 64-hex keys ~2.5–3.5 MB per browser peer. Acceptable for a browser; the anchor-bound canonical ACL bytes flowing through snapshot transfer each epoch (~1 MB/epoch to ≥1,000 replicas) is the sore point, arguing for the delta/map form rather than the flat form.

## 7. Per-direction verdict: the invariant, whether it holds, ranked findings

The settlement matrix rests on six invariants:
**I1** anchor fencing — a vertex is admissible only in the epoch whose anchor it binds (`v3-live.ts:3795-3829`);
**I2** per-author contiguity — creator's graph holds k+1 ⇒ holds k (`v3-live.ts:3711-3716`, `:6217-6240`);
**I3** frontier completeness — the carrier accounts for exactly the member set (advance predicate, RED 18);
**I4** per-incarnation boundary monotonicity (`creator-transition-advance.ts:440-445`);
**I5** fence ⇒ complete durable plan (author-local, N-independent);
**I6** per-author isolation — a Byzantine author burns only its own space.

### A. Raise the caps (128/256/1024)
I1, I2, I4, I5 hold unchanged. I3 holds (flat vector). I6 holds per-sequence-space but I6's epoch-budget cousin worsens linearly (more admitted keys able to spam the shared budget, §2).
- **P0** — checkpoint ceiling: 128 members = 10.5–11.2 KB > 8,192; raising the codec ceiling without `SCANNABLE_BYTES` (`creator-close.ts:69/:620/:994`) silently drops the checkpoint from the closure (§1). Same raise must cover ACL ceiling (64 full-shape already 12,888 B), `maxItems: 512`, `index.ts:774`, `frontiers.ts:165`, and the 65-pinning tests.
- **P1** — no per-author epoch quota: at 128–1,024 admitted keys, one key exhausts the shared 8,192-vertex epoch (§2).
- **P2** — `sequences.includes` O(k²) if `maxEpochVertices` is raised alongside (§5); fence overhead 12.5% of the epoch at N=1,024 (§2).
- **P3** — per-vertex `members.find` linear scan; re-admission desk for burned sequence spaces.
- **Verdict: survives to 128, strained at 256, dead by 1,024** (80 KB checkpoint, 12.5% fence tax, ~200 KB full-shape ACL bytes per epoch to 1,000 replicas). A bounded bridge, not the destination.

### B. Map-backed ACL + map-backed frontier (root in checkpoint, proofs at close/authorization)
I1, I2, I5 hold untouched (per-author, storage-independent — `lineage-profiles-impact.md` §2.C.3). I3 and I4 **do not hold as written** and must be re-established as: successor root recomputable from prior root + complete authenticated change set, per-changed-leaf monotonicity, map-size = member-count. I6 holds.
- **P0** — completeness under deltas: if the advance predicate verifies only *presented* paths, a creator mutates an unpresented leaf; the rule must be root-recomputation from the full change set, or I3/I4 are gone.
- **P1** — the author's own path at open needs a proof-delivery carrier that does not exist (stop-rule trigger if smuggled into f5b; a new API/slice otherwise).
- **P2** — archive/cold-join tier must serve historical paths; creator stores the full map (1.5–3.5 MB at 10,000 — fine).
- **P3** — invalid-proof DoS (cheaper to reject than the signature verify already paid, §6).
- **Verdict: survives to 10,000+ with the added rule "authenticated delta, root-recomputed, size-checked" — this is exactly the reserved `D.110c-0c1k` evolution.** All per-author settlement semantics (fence, plan, incarnation, scan) carry over verbatim.

### C. Two-tier: small role ACL (≤64) + creator-signed writer tickets; frontier lines for epoch-active writers
I1, I2, I5 hold. I6 holds. I3 **is deleted** (the vector is no longer "exactly the member set") and I4 becomes vacuous for dropped lines.
- **P0** — ticket admission must be latched to epoch closes; mid-epoch admission gives two incarnations one anchor, breaking I1's replay/equivocation guarantees (§3).
- **P0** — a replacement completeness rule is mandatory: e.g. "a line is carried while the ticket is valid, dropped only at ticket expiry, and the vector = active-or-ticketed authors, count ≤ K with K derived from the measured carrier capacity" — without it, line-dropping is unauditable and every idle epoch terminalizes in-flight work (§3).
- **P1** — even "active ≤128 per window" overflows the frozen 8,192-byte carrier (needs ceiling ≈16 KB + the §1 constant sweep, or B's carrier); B.4's durable own-boundary record graduates from deferred to required at churn (§3).
- **P1** — ship the same-anchor equivocation rule first (§5); per-author epoch quota (§2).
- **P2** — fence population tracks reconnect churn in chat (§2).
- **Verdict: survives to ~a few hundred windowed writers with three added rules (close-latched tickets, ticket-lifetime line carriage, creator-bounded K ≤ measured capacity), on either a raised-ceiling flat carrier or B's map.** This is the only direction that meets Profile D without swallowing B whole.

### D. Sharding into lanes (one object per lane, ≤64 writers each)
All six invariants hold **per object, trivially** — each lane is a full settlement domain; nothing in the matrix is even exercised across lanes because objectId scopes issuance (`(objectId, author)` scope), anchors, and closes.
- **P1** — cross-lane ordering does not exist (no shared causality); chat rendering falls back to timestamps; an author with tickets in two lanes has two independent lineages/fences (correct but doubles its fence/plan overhead).
- **P2** — replica fan-in: 1,000 replicas × L lanes of anchors/checkpoints/ACLs; creator (or per-lane creators) multiplies close work by L.
- **P3** — writer→lane assignment needs a deterministic rule (hash of author key) to prevent lane-hopping same-content duplication — which is application-visible, not a protocol safety issue.
- **Verdict: survives at any N with the added rule "one lineage per (lane, author), assignment deterministic", at the cost of total order.** Right for MMO zones (already the plan's model); wrong for a chat channel that wants one timeline.

### E. Truly permissionless writers, frontier lines only for authors that appeared
I1, I2, I5 hold (anchor fencing and contiguity don't care about membership). I3, I4 deleted. I6 inverted: the *shared* space is what burns.
- **P0** — nothing bounds distinct keys per epoch except `maxEpochVertices`: 8,192 lines ≈ 630 KB checkpoint, 77× the ceiling, for < 1 s of attacker CPU per epoch (§4). Unfixable without an admission cost, at which point it has become direction C.
- **P0** — "appeared-only" lines give every slow client a fresh incarnation per gap: cross-close in-flight messages are silently terminalized every epoch (§3).
- **P1** — creator cannot derive `admissionEpoch` with no ACL diff and no memory of absence; incarnation identity for a sparse set has no anchor (§3).
- **Verdict: does not survive.** Permissionless *reading* is already free (replicas need no membership); permissionless *writing* is incompatible with a creator-signed bounded settlement carrier.

## Bottom line

Two directions survive, composed, plus one for the secondary profile:

1. **Now (Profile D at ≤128–256): C on a raised carrier.** Two-tier membership with creator-signed, epoch-close-latched writer tickets; frontier lines carried for the ticket lifetime, never activity-scoped; K (ticketed writers) derived from a re-measured carrier ceiling (~16 KB) with the full derived-constant sweep of §1 (`SCANNABLE_BYTES`, `maxItems`, `index.ts:774`, `frontiers.ts:165`, the 65-pin tests). Preconditions: same-anchor equivocation rule (f5b0a, ship first), per-author epoch quota, B.4 durable own-boundary record promoted from deferred to owned.
2. **Destination (≥1,000): B as `D.110c-0c1k`**, entered through the accessors the design already planted (`frontierFor`/`frontierCount`) — with the non-negotiable rule that the bounded-advance predicate verifies the **complete** authenticated delta by recomputing the successor root, and a real proof-delivery carrier designed as its own slice (it is a stop-rule violation inside f5b).
3. **MMO zones: D** — already the plan's stated model; add the deterministic lane-assignment rule.

Direction A alone is a dead end past 128; E is a dead end at any N. Nothing in the accepted f5b0r settlement semantics (plan-fence-replace, incarnation-by-`admissionEpoch`, anchor-fenced ingress, per-author scan) needs to change for any surviving direction — the entire scaling problem lives in the **carrier** (flat 8,192-byte vector), the **completeness rule** (I3), and the **absence of per-author epoch quotas** (I6's shared-budget gap), which is exactly the seam the design's accessor indirection anticipated.
