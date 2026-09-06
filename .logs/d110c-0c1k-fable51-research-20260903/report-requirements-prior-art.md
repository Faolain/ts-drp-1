# Writer cap — product requirement and prior art

Angle report for the >64-writers research round. Read-only; all claims cite file:line or named prior-art
mechanisms from model knowledge (no web fetch performed).

---

## Part 1 — What number do we actually need, and what is the acceptance metric?

### 1.1 Where the 128 came from, and what it means

The only normative source of 128 is the Profile D table row
(`docs/production-hardening/production-hardening-tdd-plan-v2.md:18115-18129`):

> Active writers | **≤ 128 per 5-min window** | ≤ 64 durable (Profile M)

Three facts about that row:

1. **It is a rate, not a stock.** "Active writers ≤ 128 per 5-min window" counts *distinct posters within a
   rolling window*. Concurrent audience is a separate row: "Online replicas / object ≥ 1,000 browser-only;
   5,000 with relay spine" (plan:18119). The plan deliberately decouples writers from members: readers are
   replicas, not ACL entries, and the brief's verified fact confirms replicas need no membership
   (authorization gates writes only, `packages/protocol-v3/src/latched-acl.ts:325-343` —
   `authorizeLatchedApplicationWrite` checks `member !== undefined && (permissionless || writer group)`).
2. **The 5-minute window is approximately one epoch.** Profile D sustained rate is ≤25 durable ops/s
   (plan:18116); 8,192 vertices ÷ 25 ops/s = 328 s ≈ 5.5 min. So "128 distinct posters per 5-min window"
   translates almost exactly to **≤128 distinct authors per 8,192-vertex epoch** at sustained load. This is
   the load-bearing conversion: the natural protocol-level metric is *distinct authors per epoch*, and
   Profile D's product number maps ~1:1 onto it.
3. **The plan already externalizes the roster.** The Fabric row (plan:18129) states "guild roster a separate
   object", and Track S slice S1 (plan:18185) specifies guild→channel delegation: the channel blueprint pins
   `guildObjectId` and channel role checks accept a `GuildStateCert` (the guild's latest sealed ACL digest +
   QC/creator signature). The plan never intended the per-channel latched ACL to enumerate every person who
   may ever post; the collision recorded in `###### D.110c-0c1k` (plan:97016-97050) exists because the v3
   latched ACL as built requires membership even in permissionless mode, which S1 was supposed to relax.

On permissionless: Phase 1l (plan:1037) makes **permissioned the default**; permissionless is an explicit
opt-in for demos/fixtures only (plan:18264-18265, 40259-40263). The chat golden path "should grant Writer
as part of invite before concurrent sending" (plan:40259-40261) — i.e. the product path is
invitation-granted write access, not open admission. The `permissionless` flag in the latched ACL today is
a half-measure: it waives the writer *group* but still requires the author to be one of ≤64 *members*
(`latched-acl.ts:133-134` member cap; `:334-336` authorization).

Profile M's 64 is different in kind: "≤ 64 durable writers/zone" is a **stated design decision**
(plan:236-237 "reachable target" paragraph), reaffirmed in D.110c-0c1k ("not required for the MMORPG zone
profile, whose ≤64 durable writers per zone is a stated decision"). Nobody needs to raise it.

Examples (`examples/chat`, `examples/canvas`, `examples/grid`, `examples/v3-chat`, `examples/v3-room`)
state no audience numbers of their own; the plan is the sole authority, and its comparative-honesty gate
(plan:~18135-18141) already provides the fallback label if scale fails: "signed, moderated rooms ≤ N
writers — not Discord-like at scale."

### 1.2 The requirement, stated as a table

Definitions: *distinct writers/epoch* = authors issuing ≥1 durable vertex inside one ≤8,192-vertex epoch;
*concurrent members* = online replicas rendering the object; *churn/epoch* = write-authorization
grants+revocations that must take effect within one epoch close; *reader identity* = whether a replica must
hold a per-vertex-checkable identity to read.

| Product shape | Distinct writers / epoch | Concurrent members (replicas) | Membership churn / epoch | Readers need identity? |
| --- | --- | --- | --- | --- |
| Discord-style channel (guild ≤ ~500) | ≤ 64 typical, 128 spike | ≤ 1,000 | ~1–10 (grants at guild, propagated via S1 cert) | No (transport/invite gates access; per-vertex auth is writes-only) |
| Large community channel (guild 10k–100k) | **128 sustained, 256–512 spike** (real Discord throttles beyond this with slowmode) | 1,000–5,000 (relay spine, per plan:18119) | 10–100 at the guild object; ~0 at the channel object | No |
| MMORPG zone (1 instance = 1 object) | ≤ 64 (stated decision, plan:236) | zone population; durable writers are the bound | 10–100 zone enter/leave, but only writer-role changes touch the ACL | No (spectators read) |
| 64/128-player FPS match | 64–128, roster fixed at match start | = writers + spectators | ~0 mid-match; host migration is D.110c-0c1j (plan:96976), out of scope here | No |
| Collaborative canvas | 2–50 (Figma-class concurrency; real simultaneous editors rarely exceed ~30) | 10–500 | low; invite-granted | No |

Derived requirement, with reasoning:

- **The protocol number to hit is 128 distinct authors per epoch, with headroom to 256, in one channel
  object.** That covers Profile D sustained plus spike, and subsumes a 128-player FPS roster. Nothing in
  the product tables demands 1,024 *per-epoch* writers in one object; "thousands" appears only as
  *historical authors over a room's lifetime* and as *guild roster size* — both of which are stocks the
  channel ACL must not carry linearly.
- **The number the design must make *irrelevant* is authors-ever.** A six-month-old channel at 128 distinct
  authors/epoch with churn will accumulate thousands of historical authors, each holding a never-resetting
  sequence and (today) a settlement frontier line. Cold join must stay independent of that count (Profile D
  cold-join row, plan:18122: "independent of room age"; the ≥100-compacted-epoch fixture rule, plan:18131).
- **Readers never need per-vertex identity.** Everything that looks like "10,000 members" is either the
  guild roster (a separate object, plan:18129) or anonymous replicas. This kills any design that spends
  channel-ACL bytes on readers.

### 1.3 What "supports more than 64 writers" must mean as an executable gate

In the plan's own style (principle 4, plan:~244: "Every gate names an executable evidence artifact"; no
inherited number is a gate). "More than 64" without a harness is not a claim. The gate is Profile-D-shaped,
so the number is **128**, and the boundary pins move with it:

| Gate | Harness / evidence artifact | Fixture | Metric and threshold |
| --- | --- | --- | --- |
| **WC-1 distinct-author epoch** | `writer-cap-epoch.test.ts` (protocol-v3 suite) | one creator-trusted-v1 room; **128 distinct authors** each issuing ≥1 durable vertex (incl. one fence per author) inside one ≤8,192-vertex epoch | every vertex admitted through the real authorization path; epoch closes; **every canonical carrier (ACL snapshot, settlement checkpoint, anchor) ≤ its versioned byte ceiling, measured with the workspace canonical encoder** — not asserted from shape |
| **WC-2 boundary re-derivation** | updated pin tests | the tests that today pin **65 as the rejection boundary** (named in D.110c-0c1k, plan:97030-97033: `latched-acl.ts:133-134`, `index.ts:774`, `creator-author-issuance-frontiers.ts:165`) | all caps re-derived together from one reviewed constant; new rejection boundary pinned (e.g. 129/257); no cap raised implicitly by deleting a check |
| **WC-3 historical-author independence** | cold-join benchmark row in `benchmark.yml` (extends the existing ≥100-compacted-epoch rule, plan:18131, 18306) | ≥100 compacted epochs with a **rotating author population totalling ≥1,024 distinct historical authors** (≤128 active in any epoch) | cold join **< 10 MB and < 10 s p95** (Profile D row, plan:18122), network-byte-accounted; joining bytes must not grow with historical-author count (two fixture sizes, 1,024 vs 4,096 historical, within noise) |
| **WC-4 close-cost bound** | close-path perf assertion in the same harness | creator close at 128 active authors, each with a settlement row | close (scan + checkpoint build + sign) stays under Profile D's main-thread bound (**no task > 50 ms**, plan:18126) on the CI profile; cost measured vs 64-author baseline must be ≤ 2× (linear in *active* authors, never in authors-ever) |
| **WC-5 settlement guarantees at N** | re-run of the settlement RED/GREEN suites parameterized at N=128 | per-author fence, admissionEpoch, terminal boundary, incarnation, author recovery | identical pass at N=128; **fence overhead accounted**: 128 fences ≤ 1.6% of an 8,192-vertex epoch — assert fences don't crowd out payload (128/8192 budget line in the harness) |
| **WC-6 replica anonymity control** | existing replica/e2e harness | 1,000 simulated read-only replicas, 0 ACL entries for them | replicas sync and verify with zero membership state; a negative control proves a non-member still cannot write |

Explicitly **not** the gate: "the member-cap constant is now 128" (satisfiable by an edit that breaks the
byte ceiling — the measured fact that 64 full-shape members already encode to 12,888 B > 8,192 shows caps
and ceilings must be gated together); and "128 writers over the room's lifetime" (that's authors-ever,
which WC-3 covers differently).

Arithmetic the gate design must respect (verified with the workspace measurements in the brief):
writer-only members cost ~110.4 B each → 128 members ≈ **14,128 B > 8,192**; full-shape ~201.4 B → effective
full-shape cap ≈ **40 today**. Frontier lines at the 8,192-byte checkpoint ceiling leave 128 B/line at 64
lines, 64 B/line at 128. So *no flat-vector encoding reaches 128 under the current ceilings* — the gate
forces either a versioned ceiling raise or a map/root carrier (Part 2 recommendation).

---

## Part 2 — Prior art: how comparable systems bound membership state at scale

ts-drp constraints being mapped onto: creator-trusted rooms, per-epoch latched ACL, per-author
never-resetting sequence, 8,192-byte canonical ceilings, browser-only peers, no central service.

### MLS (RFC 9420)

**Mechanism**: members are leaves of a left-balanced binary ratchet tree, addressed by leaf index; a Commit
updates a path of ⌈log₂ N⌉ nodes, so steady-state per-member work for an update is O(log N); group state is
authenticated by a tree hash. **Bound**: the spec supports tens of thousands of leaves; practical
deployments cap at hundreds-to-low-thousands. **Cost / why it caps**: (a) a joiner's Welcome carries the
public tree — O(N) bytes at join; (b) removals blank nodes, and a churned tree degrades toward O(N) commit
cost until full paths are refreshed; (c) *every* member must download and process *every* commit in order —
membership churn is broadcast work for all N, so churn×N is the real killer, not N. **Lesson for ts-drp**:
the leaf-indexed authenticated tree is the right *shape* for a map-backed ACL/frontier (stable index, log-N
authenticated update), but MLS's O(N)-at-join Welcome is precisely what the Profile D cold-join gate
("independent of room age") forbids. Bind the tree *root* in the anchor/checkpoint and deliver per-author
proofs on demand; never ship the tree at join. And measure the churn gate, not just the size gate.

### Matrix

**Mechanism**: room membership is one `m.room.member` state event per user, fully replicated to every
participating server; conflicts resolved by state resolution v2 over the event DAG. **Bound**: flagship
rooms (Matrix HQ) reach tens of thousands of members — but joining one historically cost tens of MB and
minutes of state-res work, which is why Matrix built **lazy-loading membership** (clients fetch member
events only for senders visible in the timeline) and **faster remote joins** (a server joins with partial
state and backfills membership asynchronously). **Cost**: full-replication membership is O(members-ever) at
every replica; state resolution cost spikes superlinearly under membership conflicts. **Lesson**: Matrix is
the direct experiment report for "every reader is a membership record" — it does not scale, and the fix
they shipped is exactly the shape ts-drp should start with: *materialize identity only for authors who
appear in the visible window*. That is candidate C/E's "settlement lines only for authors active in the
epoch", validated at production scale by the closest product analogue.

### Discord (the product reference itself)

**Mechanism**: a channel has **no member list of its own**. Who can post is computed at send time from the
guild roster: base role permissions + per-channel role/user overwrites. Slowmode (5 s–6 h per-user cooldown)
bounds per-writer rate; guilds reach millions of members, and above ~1,000 online the client doesn't even
render the full sidebar. **Bound**: distinct posters per 5-minute window in even huge channels stays in the
low hundreds — because conversation is humanly serial and Discord throttles precisely to keep it so.
**Cost**: the guild roster is the single large object; channels carry only sparse overwrites. **Lesson**:
the product the profile is named after already implements the two-tier split the brief's option C
describes: channel-level *rules* (small), guild-level *roster* (large, separate object), write-time
evaluation against the pinned roster. The plan's own S1 slice (`GuildStateCert`, plan:18185) is this
design; D.110c-0c1k exists because v3 shipped a channel ACL that behaves like a members list instead. Also:
128/5-min is a *generous* product target — Discord's own throttling implies real channels rarely exceed it.

### Signal / WhatsApp

**Mechanism**: Signal private groups store membership as server-held encrypted group state with anonymous
credentials; message fan-out uses sender keys, which must be re-established after membership changes.
WhatsApp similar (sender keys), member cap raised 256→512→1,024. Signal caps at 1,000. **Bound / why**:
each membership change forces O(N) sender-key redistribution; abuse and fan-out amplification grow with N;
above ~1k the product becomes broadcast (few writers, many readers) and both vendors push those cases to
channel/community features with distinct read-only membership. **Lesson**: ~1,024 *writers* with cheap
churn is the honest ceiling even for centralized E2E products; beyond that the correct product answer is an
asymmetric writer/reader split, which ts-drp already has for free (replicas need no identity). A design
target of 128–256 active writers with a 1,024 roster ceiling is aligned with what the best-resourced
products chose, and going past it should be a different profile, not a bigger vector.

### Kafka producer-id expiry

**Mechanism**: idempotent/transactional producers hold broker-side per-producer state (PID, epoch, last
sequence numbers per partition). Brokers **evict idle producer state** (`transactional.id.expiration.ms`,
default 7 days; `producer.id.expiration.ms`). An evicted producer that returns gets
`UnknownProducerId`/out-of-order-sequence and must re-initialize — receiving a **new PID or a bumped
epoch**, deliberately breaking sequence continuity in exchange for bounded state. **Bound**: broker
producer-state is O(recently-active producers), never O(producers-ever). **Cost**: exactly-once/dedup
guarantees are windowed — a producer silent longer than the window loses its fencing continuity and must
re-enter through the epoch bump. **Lesson**: this is the closest mechanical match to the author-settlement
design ts-drp just accepted. `admissionEpoch` + fence + `terminalThrough` is the PID-epoch pattern already;
what Kafka adds is the *eviction rule*: the frontier need only carry authors active within a bounded
window; an idle author's line is settled to the archive tier, and re-entry is forced through a new
fence/incarnation (machinery that already exists per the settlement design). The cost Kafka accepted —
windowed rather than eternal continuity — is acceptable here because the settlement design's terminal
boundary + archive proofs let a returning author *prove* its old boundary instead of merely losing it.

### Yjs / Automerge

**Mechanism**: per-actor state — Yjs state vectors map clientID→clock (clientIDs are random per session, so
a long-lived doc accrues thousands); Automerge interns actor IDs and run-length/columnar-encodes per-actor
op metadata, making each historical actor cost a few bytes. GC removes deleted content but actor entries
persist. **Bound**: thousands-to-tens-of-thousands of historical actors are routine and tolerable.
**Cost**: tolerable *only because* the metadata is unsigned and byte-cheap (~10–20 B/actor after
compression) and there is no canonical ceiling. **Lesson**: a never-resetting per-author counter is cheap
as an integer and expensive as a signed canonical line. Yjs proves O(actors-ever) bookkeeping is fine when
it's bytes; ts-drp's frontier line is ~128 authenticated bytes under a hard 8,192-byte ceiling, so
O(authors-ever) in the checkpoint is structurally unaffordable — the same accounting must move to either an
active window (Kafka) or an authenticated map with a constant-size root (CT). Also the comparative-honesty
gate (plan:18135) already names Yjs as the benchmark opponent; losing the actor-accounting comparison by
10× would show up there.

### Certificate Transparency / sparse Merkle trees / verifiable maps

**Mechanism**: RFC 6962/9162 logs give O(log N) inclusion and consistency proofs against a 32-byte root;
verifiable maps (Trillian-style sparse Merkle trees over a 256-bit keyspace) give key→value proofs of both
inclusion and *non-inclusion* in ~log N compressed siblings. The tree is materialized by a log operator /
prover; verifiers hold only roots. **Bound**: effectively unbounded N (CT logs hold billions of entries);
proof size ~320 B at N=1,024, ~450 B at N=10,000 (32 B × depth). **Cost**: *someone* stores O(N) tree state
and serves proofs — the role maps onto the closer/creator (who already scans every member's rows at each
close per the settlement design) and the archive tier; verification per proof is a few hundred hash ops.
**Lesson**: this is candidate B, and it is the only pattern whose checkpoint footprint is independent of N:
a 32-byte author-map root fits any ceiling forever. D.110c-0c1k already records exactly this as the
evolution path ("authenticated author-state map, codec version 2, per-author O(log N) paths, a new proof
carrier to authors at open", plan:97044-97049), and the settlement design's `frontierFor/frontierCount`
accessors were added so the carrier could become map-backed. Non-inclusion proofs additionally give the
clean answer for a *new* author ("you have no prior boundary") without enumerating anyone.

### Hedera / Cosmos validator sets

**Mechanism**: BFT consensus with all-to-all voting — Cosmos Hub caps active validators (~180, grown slowly
from 100); Hedera's council is ~30 nodes. **Bound / why small**: Tendermint-style rounds are O(N²) in
message complexity, every block carries N signatures to verify, and stake-weighting makes tail validators
economically irrelevant anyway. Crucially, *transaction authors are unbounded* on the same chains — accounts
live in a Merkleized state tree (the verifiable-map pattern), and only the *finality set* is capped.
**Lesson**: this is the strongest argument for the two-tier split. ts-drp's roles map exactly:
admin/finality/referee are the validator set — keep them in the small latched ACL, ≤64 is generous by
validator-set standards; writers are the account set — take them out of the consensus-critical vector and
put them behind roster delegation or a map root. No serious system puts its "accounts" in its "validator
set", which is what the current latched ACL does.

---

## Ranked recommendation

1. **Adopt the two-tier split (brief option C) as the semantic change** — small durable role ACL
   (admin/finality/referee/creator, ≤64 stays fine per the validator-set evidence) plus write authorization
   delegated to the guild-roster object via the already-planned S1 `GuildStateCert` (plan:18185), or, for
   standalone rooms, creator-signed writer admission with expiry. This is what Discord actually is, what
   Cosmos/Hedera prove about role-vs-account sets, and what the plan's Fabric row already promised. It
   resolves the D.110c-0c1k contradiction at its root: the channel ACL stops being a members list.
2. **Adopt active-window settlement (Kafka pattern) immediately** — frontier/checkpoint lines only for
   authors that appeared since their last settlement, idle authors evicted to the archive tier, re-entry
   through the existing fence + `admissionEpoch` incarnation machinery. This is the cheapest change that
   makes checkpoint bytes scale with *activity* (bounded by the epoch itself: ≤128 active authors at
   Profile D) instead of authors-ever, and it reuses guarantees the settlement design already proved.
3. **Adopt the authenticated author map (CT/verifiable-map pattern, brief option B) as the codec-v2
   evolution, triggered by the WC gates, not before** — 32-byte root in the checkpoint, creator materializes
   the tree at close (it already scans every member), archive tier stores it, authors receive their O(log N)
   (~320–450 B) proof at open/adopt. This is the only construction whose checkpoint cost is independent of
   N, it is already recorded as the sanctioned evolution in D.110c-0c1k, and non-inclusion proofs handle
   new authors cleanly. Items 1+2 make item 3 smaller when it lands (the map holds only settled/idle
   authors; active ones ride the small window vector).
4. **Reject flat cap raising (option A) as the answer** — the arithmetic forbids it (128 writer-only members
   ≈ 14,128 B > 8,192; full shape caps at ~40 today), and MLS/Matrix show the real failure is O(N)
   membership at join and O(N×churn) broadcast, which a bigger vector makes worse. At most, a modest
   reviewed ceiling raise for the writer-only shape is a stopgap while 1–2 land — and only via the
   D.110c-0c1k rule that all five pinned caps are re-derived together.
5. **Reject channel sharding (option D) for writer count** — a chat channel is one total order as a product
   (Matrix and Discord both keep it so); lane-splitting a conversation breaks ordering UX for no need, since
   the *actual* required per-epoch writer count (≤128–256) fits in one object under 1–3. Keep sharding where
   the plan has it: guild→channels and cross-object conservation (Track S).
6. **Reject truly-permissionless writers (option E) for the product path** — Phase 1l made permissioned the
   default for exactly the Sybil/space-burn reason (plan:1037: "Scale tests against a permissionless default
   measure attacker bandwidth, not product"); Signal/WhatsApp cap even authenticated writers at ~1k.
   Permissionless stays an explicit opt-in demo mode. The sparse per-appearing-author settlement idea inside
   option E survives — but as part of item 2, gated by roster/ticket admission, not open admission.

Bottom line for the requirement: **the gate number is 128 distinct authors per epoch (headroom 256) in one
channel object, with cold join and close cost independent of authors-ever (≥1,024 historical in the
fixture), readers costing zero membership bytes** — and the winning construction is Discord's own shape:
small role ACL + delegated roster + activity-windowed per-author accounting, with the authenticated map
root as the recorded growth path.
