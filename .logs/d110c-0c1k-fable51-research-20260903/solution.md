# D.110c-0c1k writer capacity: research synthesis and decision

Date 2026-09-03. Branch `codex/phase3a1b-p6-golden-path`, source anchor
`1f35c937`. Four Fable 5.1 read-only research agents ran in parallel against
`brief.md`; their reports are the siblings `report-code-verification.md`,
`report-design.md`, `report-adversarial.md` and
`report-requirements-prior-art.md`. This document is the adjudication. It
authorizes nothing by itself; the plan record `D.110c-0c1k` carries the
authorization state.

## 0. Decision

**Writers leave the 64-member world in two stages, with no change to any
settlement rule of D.110c-0c1f5b0r and no authenticated map at any product
scale.**

- **W0, now, before or with f5b0a:** fix the live defects the research exposed.
  The operational ACL cap today is about 30 writer-only members, not 64,
  because the decoder's item limit binds first, and staging does not enforce
  the same limit, so a room can be grown past the point where its next close
  throws. Sweep the duplicated 8,192-byte constant that silently drops
  oversized closure records. Make per-vertex authorization O(1). Add a
  per-author share of the epoch vertex budget.
- **W1, folded into f5b0a and f5b before their RED:** the settlement checkpoint
  is written from its first line with a 256-line frontier under a 32,768-byte
  ceiling, and a version-3 latched ACL under the settlement profile carries up
  to 256 members under a 65,536-byte ceiling. Versions 1 and 2 and the
  `creator-trusted-v1` room stay byte-for-byte. This closes Profile D's 128
  distinct writers per epoch with headroom to 256 in one object.
- **W2, Train S / Phase 7:** the frontier stops being membership-shaped. Lines
  exist only for authors with a non-null boundary in their current incarnation
  (cap 2,048), `admissionEpoch` moves into a version-4 ACL member record (the
  design's own named fallback), idle authors are rotated out by a deterministic
  incarnation bump, and the ACL travels as digest-checked deltas. Membership to
  10,240 with role-holders capped at 64. Cost grows with activity, never with
  authors-ever.
- **Merkle/authenticated author map:** recorded as the evolution past roughly
  100,000 members, behind the `frontierFor`/`frontierCount` seam. Not built.
  The hot path never reads the frontier, so proofs would optimize a cold path
  that runs once per close, and the proof-delivery carrier they need does not
  exist.

## 1. What the code does today (all verified at file:line, anchor 1f35c937)

- Per-vertex authorization is ACL membership only:
  `packages/protocol-v3/src/latched-acl.ts:336`, called from
  `packages/node/src/v3-live.ts:3449-3455` and `:7510-7517`. Permissionless
  rooms still require membership. Readers never touch the ACL.
- **The binding cap is the decoder, not the member count.**
  `openCanonicalLatchedAclSnapshot` decodes with `{maxBytes: 8192, maxDepth: 4,
  maxItems: 512}` at `latched-acl.ts:219`; a member costs 16 decoded items
  writer-only and 22 full-shape on a base of about 25. Measured with the
  repo's decoder: writer-only 30 decodes and 31 fails; full-shape 22 decodes
  and 23 fails. The 64-member check at `:134` and the 8,192-byte check at
  `:16` are never reached first.
- **Stage/open asymmetry bricks rooms.** `stageLatchedAclOperations`
  (`latched-acl.ts:376-451`) validates only the 64-member object rule, so
  grants can grow the ACL to 31 or more; the successor encodes into the
  snapshot payload (`v3-live.ts:7146`), then close throws at
  `packages/node/src/creator-close.ts:437-441` and adoption/recovery fail the
  same way (`v3-live.ts:4926`, `creator-adoption.ts:874`, `:1145`, `:1478`).
  No test constructs a 65-member ACL; the member cap is unpinned.
- **Four independent 8,192-byte ceilings** cross between 74 and 96 members:
  `latched-acl.ts:16`; `packages/protocol-v3/src/index.ts:117` and `:401`;
  `creator-author-issuance-frontiers.ts:12`; `creator-issuance-retirement.ts:12`;
  `creator-checkpoint.ts:214-215`; `packages/protocol-v3/src/creator-close.ts:577`;
  and `packages/node/src/creator-close.ts:69` `SCANNABLE_BYTES = 8192`, used
  as a **filter** at `:620` and `:994`, so an oversized closure record silently
  vanishes from the candidate set and close then throws at `:466`.
- **Per-vertex authorization re-validates and re-allocates the whole member
  list**: `authorityInput → copySnapshot` (`latched-acl.ts:279-290` →
  `:120-181`) runs per vertex, O(V × N) per epoch fold. The v1 author-list
  path is Set-based (`index.ts:1611`), an in-repo precedent.
  `writeAuthorizedAuthors` is O(N²) (`packages/node/src/creator-close.ts:404-412`).
- The close scan is O(V log V) and N-independent via single-pass grouping
  (`creator-close.ts:485-500`), but `sequences.includes` at `:489` is O(k²)
  per author; keep single-pass and fix the includes before raising
  `maxEpochVertices`.
- The epoch vertex/byte budget is global with no per-author share
  (`v3-live.ts:6227`; charges keyed by digest at `:838`, `:1622-1629`). One
  writer can exhaust a shared epoch today. The settlement matrix's "only that
  author's space burns" answers the huge-fence attack, not this.
- Anchor fencing (`v3-live.ts:3795-3829`) is the load-bearing invariant for
  incarnations, and it holds only while admission changes latch at epoch
  closes. Mid-epoch admission would put two incarnations under one anchor.
- The settlement code does not exist yet: no `settlementProfileFor`,
  `$drp.author-fence`, or `frontierFor` under `packages/`. W1's numbers can be
  the first version of the checkpoint codec, not a version bump.

Measured bytes (repo canonical encoder; the two agents agree within noise):

| N | ACL writer-only | ACL full-shape | settlement checkpoint, max-width triples |
| --- | --- | --- | --- |
| 64 | 7,014 | 12,838 | 6,593 |
| 128 | 13,927 | 25,575 | 12,098 |
| 256 | 27,751 | 51,047 | 23,106 |
| 1,024 | 110,695 | 203,879 | 89,154 |
| 10,000 | 1,080,103 | 1,990,103 | 861,090 |

The 8,192-byte checkpoint ceiling fits 89 members at max integer widths and
about 93 to 97 realistically. No flat vector reaches 128 under any current
ceiling.

## 2. The requirement

The only normative source is Profile D (plan-v2 :18115-18129): active writers
≤ 128 per five-minute window, ≥ 1,000 online replicas. That is a rate of
distinct posters, not a stock of members. At 25 ops/s sustained an 8,192-vertex
epoch lasts about 5.5 minutes, so the protocol metric is **128 distinct authors
per epoch**. The plan already externalizes the roster ("guild roster a separate
object", :18129; Track S `GuildStateCert`, :18185). Permissionless is
demo-only (:1037). Profile M's 64 per zone is a stated decision (:236).

| Product | Distinct writers / epoch | Concurrent members | Churn / epoch | Readers need identity |
| --- | --- | --- | --- | --- |
| Discord channel, small guild | 64, spikes to 128 | ≤ 1,000 | 1–10 | no |
| Large community channel | 128 sustained, 256–512 spike | 1,000–5,000 | lands on the guild object | no |
| MMORPG zone | ≤ 64 (stated) | zone population | many enters, few ACL touches | no |
| 64/128-player FPS | 64–128 fixed roster | writers + spectators | ~0 | no |
| Collaborative canvas | 2–50 | 10–500 | low | no |

Target: 128 distinct authors per epoch with headroom to 256 in one object
(W1); membership to the low ten-thousands with cost independent of authors-ever
(W2); readers cost zero membership bytes (already true).

## 3. The construction

### W0. Defects and preconditions (own slice, before or with f5b0a)

1. **Decoder limit and staging parity.** Staging enforces exactly the open
   path's decode limits, and the limits are raised so that 64 full-shape
   members decode (`maxItems` ≥ 64 × 22 + 25). A RED constructs 31, 64 and 65
   members through grant staging and proves close, adoption and recovery all
   agree with open. This is a fix to `creator-trusted-v1` behavior only in the
   sense that a currently impossible state becomes possible; existing rooms
   under 30 members are unchanged.
2. **`SCANNABLE_BYTES` sweep.** The duplicated constant at
   `node/creator-close.ts:69` is replaced by per-kind ceilings from the codecs
   it scans; an oversized record is a loud rejection, never a silent skip.
3. **O(1) authorization.** A per-snapshot `Map<author, member>` built once at
   snapshot open, used by every `authorizeLatchedApplicationWrite` caller and
   by `writeAuthorizedAuthors`; accept/reject set identical to `members.find`.
4. **Per-author epoch share.** Each author may hold at most
   `ceil(maxEpochVertices / max(1, writerCount)) × k` vertices in one epoch
   with `k` a genesis parameter (default 4), enforced at ingress and at local
   issue, so a single writer cannot exhaust a shared epoch. This changes epoch
   accounting and takes its own RED. Fences count against the share.
5. **Same-anchor equivocation rule** (`packages/protocol-v3/src/index.ts:3648-3665`)
   ships in f5b0a as already listed in the settlement design.

### W1. Wide vector (fold into f5b0a and f5b)

- **Settlement checkpoint `version: 1`** exactly as design.md "Settlement
  checkpoint" with two constants changed: `frontiers` cap **256**, record
  ceiling **32,768 canonical bytes** (256 max-width triples plus fixed fields
  ≈ 23,937 B measured; headroom 1.4×). f5b0a's pinned re-measurement targets
  256 and pins 257 and 32,769 as rejections.
- **Latched ACL `version: 3`**, accepted only when
  `settlementProfileFor(profileId) !== "none"`: member cap **256**, canonical
  ceiling **65,536 B**, decode limits `{maxBytes: 65_536, maxDepth: 4,
  maxItems: 8_192}`. `LatchedAclMember` unchanged. Versions 1 and 2 untouched,
  including their 65-rejection tests. Old binaries fail closed at the existing
  version check (`latched-acl.ts:125`).
- **Author-list cap** at `index.ts:774` rises to 256 under the same predicate.
- **Genesis-bound.** A Profile-D room selects `creator-trusted-settlement-v1`
  and a version-3 genesis ACL; no late opt-in, same rule as the profile.
- Everything else in design.md is unchanged: fence, scan, drain, plan store,
  transition law, incarnation in the checkpoint, matrix, slices, stop rules.
  Fence load at 256 authors all reopening in one epoch is 3.1% of the vertex
  budget.
- Per close at 256 members: checkpoint ≤ 23.9 KB, ACL ≤ 27.8 KB on change,
  peer traffic ≈ 170 B/s, cold join +52 KB. All inside Profile D's budgets.

### W2. Sparse boundary frontier and admissioned ACL (Train S / Phase 7)

- **ACL `version: 4`.** Member record gains `admissionEpoch`. Member cap
  **10,240**, ceiling **2 MiB**. Members holding admin, finality or referee ≤
  **64 combined**, so the authority-adjacent surface and any D.110c-0c1j
  wiring stay small. Incarnation law moves from the checkpoint to the ACL:
  added member = `successorEpoch`; retained member copied unchanged; bumped
  only by the eviction rule; all verified by the advance predicate against the
  prior ACL. This selects the design's named fallback for the reason the
  design left open: a sparse frontier cannot state every member's incarnation,
  and the ACL is the one carrier that lists every member.
- **ACL delta record** `drp-v3-latched-acl-delta` `{baseAclDigest,
  targetAclDigest, removed[], upserts[]}`. Hot peers apply, re-encode and
  require the result to hash to the successor anchor's `aclDigest`; mismatch
  fails closed and falls back to a full fetch through the existing 131,072-byte
  chunk transport (`snapshot-transfer.ts:61`, `:292`). Recompute
  authentication, no proofs, no new cryptography.
- **Settlement checkpoint `version: 2`.** `frontiers` replaced by
  `boundaries: [author, lastActiveEpoch, terminalThrough][]`, cap **2,048**,
  ceiling **262,144 B**. A line exists iff the author has a non-null boundary
  in its current incarnation; `null` is unrepresentable. Drain step 1 reads
  `e` from the ACL member record and `s` from `boundaries` or null.
  Verifier rules replace "vector equals successor ACL": every line's author is
  a member; strictly sorted; `terminalThrough` and `lastActiveEpoch` monotone
  while `admissionEpoch` is unchanged; a line must be absent when
  `admissionEpoch` changed at this close; a fresh line may appear only for an
  author the scan advanced from null this epoch.
- **Creator scan** runs steps 1–5 of design.md over (authors with ≥ 1 vertex
  in the close graph ∪ authors carried in the prior `boundaries`) ∩ successor
  ACL, and emits a line only when `s !== null`. Close cost is
  O(V + carried + churn), independent of membership.
- **Idle rotation.** After the scan, while `boundaries.length > 2,048`, or for
  any author with `lastActiveEpoch ≤ closedEpoch − writerIdleEpochs` (a new
  genesis parameter), evict the smallest-`lastActiveEpoch` author (tie-break
  code-unit order) by bumping its ACL `admissionEpoch` to `successorEpoch` in
  the delta and dropping its line. This is byte-for-byte the existing same-key
  re-entry path: membership kept, device lineage kept, old rows terminal and
  resubmittable as content, first fence at `lineage.next` earns a fresh line.
- **Durable own boundary becomes mandatory.** The deferred plan-change B.4
  record (author keeps its last-adopted `terminalThrough` durably) is required
  in W2 so that an evicted author's drain can surface rows above its old
  boundary as `manual-review` candidates instead of silently terminalizing
  in-flight work. This is the one durability regression W2 introduces, and
  the record turns it from silent to visible.
- **Profile.** `settlementProfileFor` gains `"v2"`; checkpoint v2 and ACL v4
  are accepted only under it; no live W1→W2 migration; a room is born at its
  tier.
- Costs at 10,000 members with 128 active: checkpoint ≤ 177 KB, delta ≈ 16 KB
  per close, peer traffic ≈ 640 B/s, cold join +1.3 MB ACL +177 KB
  checkpoint, per-vertex auth O(1), fence ≤ 1.6% of the epoch.

### Deferred, named, not absorbed

- **Mid-epoch writer admission** (`$drp.writer-admission.v1`, a creator-signed
  control vertex folded into the ACL at close). Cuts re-admission latency from
  one close to one round-trip. Changes the ingress authorization function and
  needs its own review; W1 and W2 are complete without it. Candidate
  `D.110c-0c1k2`. Precondition from the adversarial report: admission must
  still latch at closes for incarnation purposes, or anchor fencing breaks.
- **Authenticated author map** at ≥ 10^5 members: 32-byte root, creator
  materializes at close, archive stores, authors carry O(log N) proofs at open.
  Needs the proof-delivery carrier the plan already lists as a stop-rule
  trigger. Reached through `frontierFor`/`frontierCount`.

## 4. Rejected, with the failing number

- **Raise the caps beyond about 256 (A).** The full-membership vector
  re-materializes N lines per close when about 128 changed: at 10,000 members
  that is 861 KB checkpoint plus up to 1.99 MB ACL per close against a 5 KB/s
  idle budget, and chat membership grows with joins, so any fixed cap
  re-creates the collision at cap+1 with no rotation escape. Adopted only as W1.
- **Authenticated map now (B).** The hot path never reads the frontier
  (`latched-acl.ts:336`). At 10,000 members a sparse Merkle tree saves at most
  the 1.3 MB one-time cold ACL fetch while adding about 57 KB of proofs per
  close at 128 changed lines against W2's 16 KB delta, plus a proof carrier
  that does not exist and a full-map store on the creator. Break-even is
  around 10^5 members, outside every profile.
- **Separate roster object or offline tickets (C literal).** The good half is
  W2. A roster object needs a new anchor field the anchor codec has no slot
  for (`creator-close.ts:205-224`); offline tickets must be replayed to every
  verifier, so they must live in the graph, which is the deferred mid-epoch
  admission item, and mid-epoch admission breaks anchor fencing unless it
  latches at closes.
- **Sharding a channel into lanes (D).** One channel is one object (plan
  :18127); cross-lane messages lose causal order; every lane pays its own
  close/checkpoint/fence; each lane's ACL still accumulates every author. Right
  above 10,240 as many channels per guild, which the profile already assumes.
- **Truly permissionless writers (E).** No admission authority means no
  removal authority: about 8,192 fresh keys per epoch each earn a monotone
  frontier line at about 86 B per key per epoch, forever, for under one second
  of attacker CPU; `admissionEpoch` has no defining event. The
  lines-only-for-appeared idea survives inside W2.

## 5. Invariants the adversarial report requires, and where they land

| Invariant | Holds in W1 | Holds in W2 | Where enforced |
| --- | --- | --- | --- |
| Anchor fencing (admission latches at closes) | yes | yes; mid-epoch admission deferred | ingress `v3-live.ts:3795-3829` |
| Contiguity | yes | yes | unchanged |
| Frontier completeness | vector = successor ACL | replaced by sparse verifier rules | advance predicate |
| Monotonicity | yes | per author while `admissionEpoch` unchanged | advance predicate |
| Fence implies plan | yes | yes | Node refusal rule |
| Per-author isolation | needs W0 item 4 | needs W0 item 4 | ingress and local issue |
| No silent terminalization | n/a | B.4 durable own boundary mandatory | author drain |

## 6. Slices, owners, RED

- **W0** (`packages/protocol-v3/src/latched-acl.ts`, `packages/node/src/creator-close.ts`,
  `packages/node/src/v3-live.ts`, genesis builders for the share parameter):
  RED 1 decoder parity through staging at 31/64/65; RED 2 loud rejection of an
  oversized closure record; RED 3 O(1) membership with identical accept/reject
  set on 8,192 vertices under `permissionless` and not; RED 4 one writer cannot
  exceed its share, fences included, and the epoch still closes.
- **W1** (inside f5b0a and f5b; `latched-acl.ts` v3, f5b0a checkpoint codec,
  `index.ts:770-780`, `protocol-v2/src/registry.ts:459-462`, genesis builders
  in `examples/grid/src/v3-zone.ts:1685-1692`, v3-room, v3-chat; new 257-pins
  beside the 65-pins): RED 5 ACL v3 at 256 writer-only and 256 full-shape
  round-trips, 257 and 65,537 B reject, v1/v2 keep 65; RED 6 checkpoint at 256
  max-width triples accepted, 257 and 32,769 B reject; RED 7 old decoder fails
  closed on v3 bytes; RED 8 200 authors reopen in one epoch, exactly 200 fences,
  200 advanced lines, 200 of 8,192 slots.
- **W2** (Train S / Phase 7; `latched-acl.ts` v4, checkpoint v2, delta codec,
  `creator-transition-advance.ts`, `creator-close.ts` scan/eviction/delta,
  `snapshot-transfer.ts` reuse, `writerIdleEpochs` parameter, B.4 durable own
  boundary in the issuance store): RED 9 sparse shape rules; RED 10
  `admissionEpoch` law; RED 11 eviction determinism at cap; RED 12 evicted
  author returns on the same device with manual-review surfacing; RED 13 delta
  apply hashes to `aclDigest` or falls back; RED 14 3,000-member reconnect herd
  spills fences over ≥ 2 closes with no blocked close; RED 15 close cost
  independent of membership; RED 16 eviction versus plan prune gate; RED 17
  v2/v4 accepted only under `"v2"`; RED 18 fence fixture gives identical
  boundaries under the 256-vector and the sparse carrier through `frontierFor`.

## 7. What is lost, plainly

W0: nothing; rooms that could brick can no longer be grown into that state.
W1: larger retained records, at most about 52 KB per close. W2: an author idle
past the rotation horizon loses protocol-level replay of unpublished displaced
rows, surfaced to the application as manual-review candidates rather than
silently dropped; re-admission of a rotated-out author waits for the next close
until the deferred admission vertex exists; "who is a member" always needs the
ACL bytes, which every peer already holds to authorize vertices.

## 8. Prior art that shaped the choice

Kafka producer-id expiry is the mechanical twin of W2's eviction: idle
producer state is dropped and a returning producer re-enters with an epoch
bump. Matrix's lazy-loaded membership and Discord's "channels have no member
list, posting rights come from the guild" validate lines-for-active-authors
and roles-out-of-the-writer-set. Cosmos and Hedera keep validator sets under
about 180 while authors are unbounded in a Merkleized account tree, which is
why admin/finality/referee stay in the 64-slot ACL and writers do not. MLS
shows that shipping the tree at join is the real failure mode, which is why
the map is deferred until peers cannot hold the writer set at all.
