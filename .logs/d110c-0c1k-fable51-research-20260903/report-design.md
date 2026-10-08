# Writer-cap design report — alternatives and recommendation (D.110c-0c1k)

Read-only research. Repo `/Users/aristotle/Documents/Projects/ts-drp-1`, branch
`codex/phase3a1b-p6-golden-path`. Inputs read in full: the shared brief, the accepted
settlement design `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` (558 lines),
`.logs/d110c-0c1f5b0-fable51-research-20260903/lineage-profiles-impact.md` §2.C and §4, plan
record `D.110c-0c1k` (plan-v2 :97011-97043) and `D.110c-0c1j` (:96976). Every code claim
below was re-verified at file:line in the working tree. One measurement was run
(`measure-writers.ts` in this scratchpad, `tsx` over `packages/canonical/src`); its numbers
are labelled MEASURED.

## 0. Verdict

**Recommend a staged pair: W1 "wide vector" now (member cap 256, ceilings 65,536 B, folded
into the not-yet-implemented f5b0a codec) and W2 "sparse boundary frontier + admissioned ACL"
for Train S / Phase 7 (member cap 10,240, boundary lines only for authors with a non-null
boundary in their current incarnation, `admissionEpoch` moved into the version-4 ACL member
record — the design's own named fallback, design.md:546-548 — with deterministic idle
rotation reusing the existing re-admission machinery).** This is direction A at small N and
direction C refined by direction E's one good idea (lines only for authors that appeared) at
large N. No authenticated map (B) at any N the product states: the hot path never consults
the frontier, so Merkle proofs would optimize a cold path, and below ~10^5 members
digest-checked deltas plus full-set recompute give the same authentication with zero new
machinery and no proof-delivery carrier (which does not exist and is a recorded stop-rule
trigger, lineage-profiles-impact.md §2.C.3(d)).

Two structural facts drive everything:

1. **Settlement cost already scales with *active* authors, not membership.** Fences are
   issued per open/adopt (design.md:359-361: "every member issues one fence at every
   open/adopt — one control vertex per author per epoch"), so fence load per epoch is
   bounded by authors who actually open, ≤ 128 under Profile D (plan-v2:18117). Only the
   frontier *vector* ("exactly the successor ACL's members", design.md:87-88) and the ACL
   bytes scale with membership. Fixing the two carriers fixes the whole problem; no
   settlement *rule* changes (confirmed rule-by-rule signer/size-agnostic in
   lineage-profiles-impact.md §2.A, §2.C.3).
2. **Per-vertex authorization never toucheses the frontier.** It is ACL membership only:
   `member !== undefined && (permissionless || member.groups.includes("writer"))`
   (`packages/protocol-v3/src/latched-acl.ts:336`, called from
   `packages/node/src/v3-live.ts:3449-3455` and `:7510-7517`). The frontier is read at
   author open/adopt, creator close, and the advance predicate — all cold path. So the
   "proofs per vertex vs at close" question answers itself: even under B, verification
   would be cold-path only, which removes B's main selling point.

## 1. Measured baseline (MEASURED, workspace canonical encoder)

Fixed checkpoint fields ≈ 831 B; frontier triple ≈ 86–92 B at max integer widths, ~75 B
typical. ACL member ≈ 108 B writer-only, ~199 B full shape (finality key + 4 groups).

| N | ACL writer-only | ACL full-shape | checkpoint, max-width triples | frontiers only, typical |
|---|---|---|---|---|
| 40 | 4,422 B | 8,062 B | 4,529 B | 3,015 B |
| 64 | 7,014 B | 12,838 B | 6,593 B | 4,815 B |
| 128 | 13,927 B | 25,575 B | 12,098 B | 9,616 B |
| 256 | 27,751 B | 51,047 B | 23,106 B | 19,216 B |
| 1,024 | 110,695 B | 203,879 B | 89,154 B | 76,816 B |
| 10,000 | 1,080,103 B | 1,990,103 B | 861,090 B | 750,016 B |

(These reproduce the earlier 64-member measurements within noise: 7,014 vs 7,064 and
12,838 vs 12,888 recorded at plan-v2:97032-97035; encoding context differs slightly.)

Against the ceilings: ACL canonical ceiling 8,192 B (`latched-acl.ts:16`, enforced at
`:206` and `:218`), member cap 64 (`:134`), decode limits `maxDepth 4, maxItems 512`
(`:218`); author-list cap 64 (`packages/protocol-v3/src/index.ts:774`); v1 frontier cap 64
(`packages/protocol-v3/src/creator-author-issuance-frontiers.ts:165`); tests pinning 65 as
the rejection boundary
(`tests/protocol-v3-creator-author-issuance-frontiers.test.ts:212`,
`tests/protocol-v3-current-epoch-author-authorization-p6-red.test.ts:394`). **N = 128
already breaks both carriers today** (13,927 B ACL and 12,098 B checkpoint against 8,192 B
ceilings), which is exactly the D.110c-0c1k collision.

None of the settlement code exists yet — no `settlementProfileFor`, `$drp.author-fence`,
`frontierFor` anywhere under `packages/` (grep, 2026-09-03); design.md authorizes only the
f5b0a/f5b0s REDs. **This is the decisive scheduling fact: the settlement checkpoint codec
has not been written, so W1's numbers can be built in from the first line of f5b0a instead
of shipping a 64-line `version: 1` and immediately versioning it.**

## 2. The recommended construction

### 2.1 Stage W1 — wide vector (closes D.110c-0c1k for Profile D at ≤ 256)

Drop-in deltas to design.md, same voice:

**Latched ACL, snapshot version 3.** `LatchedAclSnapshot` gains `version: 3` with member
cap **256** and canonical ceiling **65,536 B** (full-shape 256 = 51,047 B MEASURED;
decode limits `maxBytes: 65_536, maxDepth: 4, maxItems: 4_096`). `LatchedAclMember` is
unchanged (`{author, finalityKey, groups}`, `latched-acl.ts:8-12`). Versions 1 and 2 are
byte-for-byte untouched, including the 64-cap and 8,192-B ceiling and the tests that pin
65. A version-3 snapshot is accepted only when `settlementProfileFor(profileId) !== "none"`;
old binaries fail closed at the existing version check (`latched-acl.ts:125`
`version !== 1 && version !== 2`), so a v3 room is unreadable, not misread, by old peers.

**Settlement checkpoint (f5b0a builds it with these numbers; no version 2 needed).**
Kind, fields, derivation, signing and predecessor rules exactly as design.md "Settlement
checkpoint"; the only changed constants: `frontiers` cap **256**, record ceiling
**32,768 B** (256 max-width triples + fixed fields = 23,106 + ~831 B MEASURED; headroom
~1.4×). f5b0a's re-measurement obligation (design.md:123-127) re-targets 256 and pins the
257-rejection and the 32,768-B over-limit vectors.

**Authorization per vertex — unchanged rule, O(1) implementation.** The rule stays
`latched-acl.ts:336`. The implementation must stop being a linear `members.find` per
vertex: at 256 members × 8,192-vertex catch-up ingest that is 2.1 M string compares
(tolerable), but the same code at W2's 10,240 members is ~84 M compares ≈ seconds of main
thread against Profile D's "no task > 50 ms" (plan-v2:18124). Add a per-snapshot
`Map<author, member>` built once at snapshot open, used by
`authorizeLatchedApplicationWrite` callers (`v3-live.ts:3449-3455`, `:7510-7517`) and by
`writeAuthorizedAuthors`, which is O(N²) today (find inside a member loop,
`packages/node/src/creator-close.ts:404-412`).

**Everything else in design.md is unchanged**: fence carrier, creator scan, drain steps
1-7, plan store, ACL transition law, incarnation-in-checkpoint, crash matrix, slices,
stop rules. Fence overhead at 256 authors all reopening in one epoch = 256/8,192 = 3.1%
of the vertex budget.

**Migration/compat:** genesis-bound, per-room, no live migration — a Profile-D room
selects `creator-trusted-settlement-v1` *and* a version-3 genesis ACL; existing rooms
cannot late-opt-in (same rule as the profile itself, design.md:337-342). The author-list
carrier cap (`index.ts:774`) rises to 256 only for the settlement profile via the same
predicate; v1 rooms keep 64 everywhere.

### 2.2 Stage W2 — sparse boundary frontier + admissioned ACL (Train S / Phase 7, ≤ 10,240)

This is the carrier evolution the accepted design explicitly prepared for
(`frontierFor`/`frontierCount` are "the only preparation for a later map-backed carrier
(D.110c-0c1k); no field is reserved", design.md:119-122). "Map-backed" turns out not to
mean Merkle (§3.B below); it means **the frontier stops being membership-shaped**.

**Latched ACL, snapshot version 4.** `LatchedAclMember` gains one field:

```ts
type LatchedAclMemberV4 = Readonly<{
	author: string;
	admissionEpoch: number;   // assigned by the close, verified by the advance predicate
	finalityKey: string | null;
	groups: readonly LatchedAclGroup[];
}>;
```

Member cap **10,240**; canonical ceiling **2,097,152 B** (writer-only + admissionEpoch
≈ 126 B/member → 10,240 ≈ 1.30 MB; role-holder rule below keeps full-shape members few).
New structural rule: members holding any of `admin | finality | referee` ≤ **64 combined**,
so the authority-adjacent surface (`deriveNextLatchedSignerSet`, `latched-acl.ts:459-480`)
and any future rotated-authority wiring (D.110c-0c1j) stay 64-small; `writer`-only members
fill the rest. Incarnation moves from checkpoint to ACL: added member gets
`admissionEpoch = successorEpoch`, retained member copies it unchanged, and the close may
bump it only under the eviction rule below — all verified by the advance predicate against
the prior ACL exactly as the checkpoint triple is verified today (design.md:87-95). This
**selects the design's named fallback** ("admissionEpoch in a version-3 latched-ACL member
record", design.md:546-548) for the reason the design left open: with a sparse frontier the
checkpoint can no longer carry every member's incarnation, and the ACL is the one carrier
that provably lists every member.

**ACL delta record.** A new closure candidate blob (selected by decoded `kind` like every
other closure record, `packages/node/src/internal/creator-transition-advance.ts:110-114`
pattern):

```ts
{ kind: "drp-v3-latched-acl-delta", version: 1, objectId,
  baseAclDigest, targetAclDigest,
  removed: readonly string[],            // authors, sorted
  upserts: readonly LatchedAclMemberV4[] // sorted; adds, role changes, admissionEpoch bumps
}
```

A hot peer applies the delta to its held base bytes, re-encodes, and requires the result to
hash to `targetAclDigest` (= the successor anchor's `aclDigest`,
`packages/protocol-v3/src/creator-close.ts:208`); any mismatch fails closed and falls back
to a full fetch. A cold joiner fetches the full ACL bytes through the existing chunk
transport (`snapshotChunkBytes: 131_072`,
`packages/protocol-v3/src/snapshot-transfer.ts:61,:292` — 10 chunks at 1.3 MB) and verifies
`aclDigest`. Recompute-authentication, no proofs, no new crypto — consistent with the
design's "no new cryptography" stop rule (design.md:534-535).

**Settlement checkpoint version 2 — the sparse frontier.** Same kind/domain/binding/signing;
`version: 2`; `frontiers` is replaced by:

```ts
boundaries: readonly [author: string, lastActiveEpoch: number, terminalThrough: number][]
```

- **A line exists iff the author has a non-null boundary in its current incarnation.**
  `terminalThrough: null` is unrepresentable in v2; the null-boundary member of v1
  (design.md:399) is simply absent. Membership and `admissionEpoch` come from the bound
  successor ACL (`successorAclDigest`); the author's drain step 1 (design.md:186-188)
  becomes "read `e` from the ACL member record, `s` from `boundaries` or null if absent; a
  key absent from the *ACL* may not issue".
- Cap **2,048** lines, record ceiling **262,144 B** (2,048 × ~86 B + fixed ≈ 177 KB
  MEASURED-extrapolated; f5b0a-style pinned re-measurement required).
- `lastActiveEpoch` is set to `closedEpoch` whenever the author has any vertex in the
  complete close graph, else copied. It exists solely to make eviction deterministic and
  verifiable from (prior checkpoint, close graph) alone — no side state.
- Verifier/advance-predicate rules (replacing "vector == successor ACL members",
  design.md case 18): every boundary author ∈ successor ACL; strictly sorted unique;
  per-author `terminalThrough` monotone and `lastActiveEpoch` monotone when the member's
  `admissionEpoch` is unchanged; a line must be **absent** when the member's
  `admissionEpoch` changed at this close; a fresh line may appear only for a member whose
  scan advanced it from null this epoch. Adjacency and genesis rules unchanged
  (design.md:112-118).

**Creator scan** (replacing "For each successor ACL member A", design.md:151): for each
author in ({authors with ≥ 1 vertex in the complete close graph} ∪ {authors carried in the
prior `boundaries`}) ∩ successor ACL — run steps 1-5 unchanged; emit a line only when
`s !== null`. Members in neither set are **skipped, not enumerated**: close cost is
O(V + carried + churn), independent of membership. At 10,240 members with 128 active and
2,048 carried lines that is ~8,192 grouping operations + ≤ 2,048 line copies + delta
assembly — single-digit milliseconds.

**Idle rotation — bounding the boundary set without new machinery.** At close, after the
scan, while `boundaries.length > 2,048` (and optionally for every author with
`lastActiveEpoch ≤ closedEpoch − writerIdleEpochs`, a new genesis `parameters` key next to
`maxEpochVertices` at `examples/grid/src/v3-zone.ts:28-36`): evict the author with the
smallest `lastActiveEpoch` (tie-break: code-unit author order) by **bumping its ACL
`admissionEpoch` to `successorEpoch` in the delta and dropping its line**. This is
byte-for-byte the existing same-key re-entry path (design.md matrix row "same-key removal
and re-entry, same device": new `admissionEpoch`; old rows terminal; first fence at
`lineage.next`; sequence continues) — the evicted author keeps membership, keeps its
device lineage, and on next open drains (all pre-eviction rows classify terminal
old-incarnation, resubmittable as content per design.md:295-297), fences, and earns a fresh
line. No author-side code beyond what f5b0b/f5b0c already build. Consequence to accept:
an author idle longer than the rotation horizon loses protocol-level replay of unpublished
displaced rows (the app resubmits their content) — identical to today's removed-member
rule, and the deterministic price of a frontier bounded by activity instead of membership.

**Fence interaction with a large/sparse set.** Unchanged. The fence stays one integer
`m ≤ f` (design.md:130-136); the scan's step 2 reads the prior `s` (null when no line);
`m = 0` base case unchanged. Per-epoch fence count = authors that open/adopt that epoch.
A mass-reconnect herd larger than `maxEpochVertices` (e.g. 10,000 reopeners) simply spills
fences across successive closes — epochs close on budget, no author blocks a close
(design.md:177-179), boundaries advance over 2+ closes. RED 12 pins it.

**Who stores what (browser-only peers).** Every replica holds the full current ACL bytes
(1.3 MB ≈ 0.25% of the 512 MB Profile-D heap budget) maintained by digest-checked deltas,
plus the current checkpoint (≤ 262 KB). No peer stores per-author proofs because none
exist. The creator additionally holds the close graph it already holds. Archive tier holds
what it already holds (chunked ACL + checkpoint per retained closure).

**Migration/compat.** W2 is a second genesis-bound point: `settlementProfileFor` gains
`"v2"` (one owner by construction, design.md:344-354 — "a later decomposition ... changes
only this predicate"); checkpoint `version: 2` and ACL `version: 4` are accepted only under
it. No W1→W2 live migration; a room is born at its scale tier. A `version: 2` carrier swap
was already classified as a codec evolution, not a wire break
(lineage-profiles-impact.md §2.C.2); the delta record and the `parameters` key are the only
new wire-adjacent items, which is why W2 is Train S/Phase 7 and not f5b (the plan record
itself sets that boundary, plan-v2:97036-97041).

**What binds what** (both stages, unchanged from design.md): the anchor binds `aclDigest`
(full ACL bytes) and `parametersDigest` (`creator-close.ts:208,:218`); the checkpoint binds
current/successor anchors and ACLs, cut, QC, manifest, history, genesis (design.md:96-98)
and is signed by the installing authority, verified under floor trust (design.md:99-110);
the delta record binds (base, target) ACL digests and carries no authority of its own —
it is a transport optimization whose correctness is checked by recomputing `aclDigest`.

### 2.3 Costs of the recommendation

Per close = one epoch ≤ 8,192 vertices; Profile D full rate closes every ~5.5 min
(8,192 / 25 ops/s); budgets from plan-v2:18113-18127.

| N members (active ≤ 128) | Stage | checkpoint B/close | ACL B/close (delta) | per-peer close traffic | cold-join adds | per-vertex auth | creator close scan | fence % of epoch (steady) |
|---|---|---|---|---|---|---|---|---|
| 128 | W1 | 12,929 max (12,098 + fixed spread) | full 13.9 KB only when changed | ≤ 27 KB ≈ 90 B/s | 26 KB | O(1) map | O(V+128) | ≤ 1.6% |
| 256 | W1 | ≤ 23.9 KB | ≤ 27.8 KB on change | ≤ 52 KB ≈ 170 B/s | 52 KB | O(1) | O(V+256) | ≤ 3.1% |
| 1,024 | W2 | ≤ 89 KB (≤ 1,024 lines) | delta ~16 KB @ churn 128 | ≤ 105 KB ≈ 350 B/s | 130 KB + 89 KB | O(1) | O(V+carried) | ≤ 1.6% |
| 10,000 | W2 | ≤ 177 KB (cap 2,048) | delta ~16 KB | ≤ 193 KB ≈ 640 B/s | 1.30 MB + 177 KB | O(1) | O(V+2,048) | ≤ 1.6% |

All rows sit inside Profile D's ≤ 5 KB/s idle bandwidth, < 10 MB cold join, no-task->50 ms
budgets. The comparison numbers that reject the alternatives are in §3.

## 3. Non-selected directions — rejection reasons

**A. Raise the caps beyond ~256 (adopted only as W1).** The full-membership vector
re-materializes N lines per close when ~128 changed: at N = 10,000 that is 861 KB
checkpoint + up to 1.99 MB ACL per close (MEASURED) ≈ 2.9–6.5 KB/s sustained against the
5 KB/s idle budget, ×2 rollback generations retained, ~247 MB/day of archive at full rate —
4.9× the W2 sparse cost for identical information. Worse, chat membership grows with joins
(golden path grants Writer on join, plan-v2:18262-18266), so any fixed cap under A
re-creates the 0c1k collision at cap+1 with no idle-rotation escape, because rotation
requires an incarnation carrier outside the checkpoint — at which point you have built W2.

**B. Authenticated map (Merkle Patricia / SMT / sorted-vector Merkle).** Rejected at every
stated N. (i) The hot path never reads the frontier — per-vertex authorization is ACL
membership only (`latched-acl.ts:336`, `v3-live.ts:3449-3455`) — so O(log N) proofs
accelerate only close/adopt-time checks that run once per ~5.5 min. (ii) It requires a
proof-delivery carrier to authors at open that does not exist and is a recorded stop-rule
trigger (lineage-profiles-impact.md §2.C.3(d), plan-v2:97036-97040). (iii) The concrete
numbers: at N = 10,000 an SMT saves at most the 1.30 MB one-time cold ACL fetch (13% of the
10 MB cold-join budget — affordable) while adding ~57 KB of proofs per close at 128 changed
lines (128 × 14 levels × 32 B) versus W2's ~16 KB delta, plus a full-map storage obligation
on the creator/archive that W2 imposes on nobody new. The map only pays when peers cannot
hold or fetch the writer set at all, ~10^5+ members — outside every profile
(plan-v2:236-238: seamless single-shard is a non-goal). Record it as the ≥ 10^5 evolution
behind `frontierFor`, exactly as design.md:119-122 already does.

**C. Two-tier as literally specified (separate roster object / signed tickets with
expiry).** The good half — small durable role set, activity-bounded settlement lines — is
absorbed into W2 (role-holders ≤ 64, boundaries ≤ 2,048). The separate-object half is
rejected: a roster object needs its own digest bound into the anchor (a new anchor field —
a wire change the anchor codec at `creator-close.ts:205-224` has no slot for, versus zero
anchor change in W2), duplicates the latched-ACL staging/verification machinery, and
offline creator-signed tickets verified at ingress make authorization a function of
(vertex, ACL, ticket-set), so tickets must be replayed to every verifier anyway — i.e.
they must live in the graph, which is a mid-epoch admission feature (deferred, §5), not a
capacity feature.

**D. Sharding a channel into lanes.** Rejected as the primary mechanism: Profile D's fabric
row fixes 1 channel = 1 object (plan-v2:18127), cross-lane messages lose the single DAG's
causal ordering (dependencies are taken from one object's causality index tips,
`v3-live.ts:6217-6240`), every lane pays its own close/checkpoint/fence overhead
(×lanes multiplier on exactly the bytes we are minimizing), and each lane's ACL still
accumulates every author who ever posted there, so the 64/256-cap collision reappears per
lane. Lanes remain the app-level answer *above* 10,240 (many channels per guild), which the
profile already assumes.

**E. Truly permissionless writers, lines only for authors that appeared.** The
lines-only-for-appeared idea is correct and is W2's frontier rule; the permissionless half
is rejected. Membership is required even when `permissionless: true` by design
(`latched-acl.ts:336`; lineage-profiles-impact.md §2.B "player joins are ACL grants in
every mode"). Without an admission authority there is no removal authority: an attacker
mints up to ~8,192 fresh keys per epoch (one vertex each inside `maxEpochVertices`), each
earning a frontier line that monotone rules force every future close to carry — unbounded
checkpoint growth at ~86 B/key/epoch — and `admissionEpoch` has no defining event, so the
incarnation/terminal rules (design.md:311-319) lose their anchor. Sybil space-burn with no
recovery path.

## 4. Direct answers to the pointed questions

- **Line per member, or per author that ever issued?** Per author with a **non-null
  boundary in the current incarnation** — strictly smaller than "ever issued", because
  idle rotation retires boundaries by incarnation bump. This requires exactly one thing in
  exchange: `admissionEpoch` must move to the membership carrier (ACL v4), since the
  checkpoint can no longer state it for line-less members and the author's drain step 2
  needs `e` to split terminal-old-incarnation from displaced rows (design.md:190-204).
- **Can the frontier be bounded by active-per-epoch rather than membership?** Bounded by
  active-per-rotation-window: min(membership, 2,048 cap), with deterministic eviction by
  `lastActiveEpoch` making the bound a verifier rule, not a hope. Pure active-per-epoch is
  impossible — a boundary must survive epochs of silence or rows at/below it stop being
  terminal — so `lastActiveEpoch` rides in the line to make "how long silent" checkpoint-
  derivable.
- **What does an authenticated map buy at each N?** N ≤ 256: nothing (the vector fits in
  one record). N = 1,024: nothing (89 KB/close vs proofs + carrier). N = 10,000: saves
  ≤ 1.30 MB once per cold join, costs ~57 KB/close in proofs vs ~16 KB deltas, plus a
  nonexistent proof-delivery API. Breakeven ~10^5 members, outside all profiles.
- **Proofs per vertex or at close/adopt?** Cold path only, in every construction — the
  per-vertex rule is ACL membership (`latched-acl.ts:336`) and W1/W2 keep it that way with
  an O(1) map. Frontier verification happens at author open/adopt, creator close, and the
  control-plane advance predicate (`creator-transition-advance.ts:254,:418,:440-441`, via
  `frontierFor` per design.md:119-122).
- **Who stores the full map on browser-only peers?** Everyone stores the full ACL
  (≤ 1.3 MB at 10,240 ≈ 0.25% of the 512 MB heap budget) and current checkpoint
  (≤ 262 KB), maintained by digest-checked deltas; cold join uses the existing 131,072-B
  chunk transport (`snapshot-transfer.ts:61,:292`). No proofs exist to store.

## 5. Owners / files that change

**W1** (fold into f5b0a/f5b slices; one reviewed cap decision per plan-v2:97014-97020):
`packages/protocol-v3/src/latched-acl.ts` (version-3 snapshot: cap 256, ceiling 65,536,
decode limits; v1/v2 untouched); f5b0a's new settlement-checkpoint codec (cap 256, ceiling
32,768, re-measured pins); `packages/protocol-v3/src/index.ts:770-780` (author-list cap
under the profile predicate); `packages/node/src/creator-close.ts:404-412` and
`packages/node/src/v3-live.ts:3449-3455,:7510-7517` (O(1) member lookup);
`packages/protocol-v2/src/registry.ts:459-462` (profile switch already routed through
`settlementProfileFor`); genesis builders `examples/grid/src/v3-zone.ts:1685-1692`,
v3-room/v3-chat; tests pinning 65 gain v3 257-pins
(`tests/protocol-v3-creator-author-issuance-frontiers.test.ts:212`,
`tests/protocol-v3-current-epoch-author-authorization-p6-red.test.ts:394`).

**W2** (Train S / Phase 7): `latched-acl.ts` (version-4 member with `admissionEpoch`, cap
10,240, ceiling 2 MiB, role-holder ≤ 64 rule); protocol-v3 checkpoint `version: 2`
(boundaries, cap 2,048, ceiling 262,144) and the ACL-delta codec;
`packages/node/src/internal/creator-transition-advance.ts` (per-author monotonicity +
eviction verification through `frontierFor`); `packages/node/src/creator-close.ts` (scan
over active ∪ carried, delta emission, eviction); chunked ACL transport reuse
(`snapshot-transfer.ts`); `parameters` key `writerIdleEpochs` (registry kind schema +
genesis builders — the recorded Phase-7 policy-carrier item, lineage-profiles-impact.md §4
item 4); `settlementProfileFor` gains `"v2"`.

**Deferred, named, not absorbed** (candidate `D.110c-0c1k2`): mid-epoch writer admission as
a creator-authored control vertex (`$drp.writer-admission.v1`, pattern-identical to the
fence: in-envelope operation, admission = causal descent from the grant vertex, folded into
the ACL at close). It cuts re-admission latency from one epoch close (potentially hours in
a quiet room, since epochs close on vertex/byte budget) to one creator round-trip, but it
changes the ingress authorization function and therefore needs its own review; W1/W2 are
complete without it.

## 6. Deterministic RED cases (Wn = stage)

1. **W1** Version-3 ACL with 256 writer-only members (27,751 B) and with 256 full-shape
   members (51,047 B) round-trips under the 65,536-B ceiling; 257 members and 65,537 B
   reject; v1/v2 keep the 65-rejection byte-for-byte.
2. **W1** Settlement checkpoint with 256 max-width triples (re-measured, ~23.9 KB total)
   accepted; 257 lines and ceiling+1 bytes reject; the pin is an executable vector.
3. **W1** An old (v1/v2-only) decoder given version-3 ACL bytes fails closed at the version
   check with no partial decode; a v1 room presented a settlement-profile genesis rejects
   it (`settlementProfileFor` = "none").
4. **W1** Ingesting 8,192 vertices under a 256-member ACL performs O(1) membership lookups
   (behavioral pin: exact same accept/reject set as `members.find`, including
   `permissionless: true` non-writer accept and non-member reject at `latched-acl.ts:336`
   semantics).
5. **W1** 200 authors open/adopt in one epoch: exactly 200 fences admitted, close emits 200
   advanced lines and copies the rest; fences consume exactly 200 of 8,192 vertex slots.
6. **W2** Sparse frontier shape: a member that never issued has no line; after its first
   fence at slot 0 a line `[A, closedEpoch, m−1..advanced]` appears; any line with a null
   or non-integer `terminalThrough`, an unsorted vector, or a non-member author rejects.
7. **W2** `admissionEpoch` law: added member = `successorEpoch`; retained member copied
   unchanged; any other change without the eviction rule firing is rejected by the advance
   predicate; boundary regression and `lastActiveEpoch` regression reject.
8. **W2** Eviction determinism: with `boundaries` at cap 2,048 and one new author earning a
   line, the close must evict exactly the smallest-`lastActiveEpoch` author (tie-break:
   code-unit order), bump its ACL `admissionEpoch` to `successorEpoch` in the delta, and
   drop its line; any other eviction choice or a cap overflow rejects.
9. **W2** Evicted author returns on the same device: drain classifies every pre-eviction
   row terminal (`row.epoch < admissionEpoch`), surfaces displaced content to the app as
   resubmittable, issues a fence at `lineage.next`, earns a fresh line; sequence continues;
   no collision (ingress anchor fencing, `v3-live.ts:3800-3829` per design.md:300-302).
10. **W2** ACL delta: apply(base, delta) re-encodes to `targetAclDigest` or fails closed
    and falls back to full fetch; a delta over a mismatched `baseAclDigest` rejects; cold
    join fetches the full 1.3 MB ACL in 131,072-B chunks and matches the anchor's
    `aclDigest`.
11. **W2** Mass-reconnect herd: 3,000 members open within one epoch's budget window; fences
    spill across ≥ 2 closes; every close succeeds without any author blocking it; all
    3,000 boundaries are advanced within the spill closes.
12. **W2** Close cost independence: a close over 10,240 members with 128 active and 2,048
    carried lines touches only active ∪ carried authors (behavioral pin on scanned-author
    set), emits ≤ 262,144 checkpoint bytes, and the authorized-writer materialization is
    O(N) not O(N²).
13. **W2** Idle author with an unlinked settlement-plan entry is *not* evicted while the
    prune gate holds... **correction — eviction must not race the plan:** an evicted
    author's unlinked plan entries are cleared at its next drain by the terminal rule
    (`row.epoch < e`, design.md:210-213); RED pins that `pruneAuthenticatedSettledPrefix`
    still refuses while an entry is unlinked and that the next drain removes the entry
    without replaying the row.
14. **W2** Checkpoint v2 accepted only under `settlementProfileFor = "v2"`; a v1-profile
    peer rejects v2 checkpoint bytes and v4 ACL bytes fail-closed; no late opt-in from a
    W1 room (genesis digests differ).
15. **W1/W2** Fence semantics unchanged across carriers: the same fence/scan fixture
    (author fences `m`, adjacent slots advance, foreign slot freezes) produces identical
    boundaries under the 256-vector and the sparse carrier via `frontierFor` — proving the
    accessor seam (design.md:119-122) actually isolates the carrier.

## 7. What is lost, stated plainly

W1: nothing beyond larger retained records (≤ 52 KB/close worst case). W2: (a) an author
idle past the rotation horizon loses protocol-level replay of unpublished displaced rows —
content is resubmitted by the app, identical to today's removed-member rule
(design.md:293-297); (b) re-admission of a rotated-out author waits for the next close
(mitigated by the deferred admission-vertex item); (c) the checkpoint no longer *contains*
the member list, so "who is a member" always requires the ACL bytes — which every peer
already must hold to authorize vertices, so no new obligation in practice.
