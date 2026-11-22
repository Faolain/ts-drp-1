# Impact of the peer's authority-lineage-profile note on plan-change.md

Date: 2026-09-03. Branch `codex/phase3a1b-p6-golden-path`, HEAD `e6a67013`. Read-only review;
no tests run; the only file written is this one. Every code claim cites `file:line` at HEAD.
One measurement was run (`tsx` over `packages/canonical/src`, scratchpad script) and is
labelled as such.

## 0. Verdict

The note does not change the settlement construction in plan-change.md (plan → fence →
replacements; `[author, admissionEpoch, terminalThrough]`; C.4 scan; C.5 author rule).
Every settlement rule is per-author, keyed on the author's own Ed25519 signature, the
anchor/epoch decoded from the row, and the two ACL digests bound into the checkpoint — none
of it reads the identity of the closing authority. What the note does expose is that the
*carrier* plan-change.md inherits from the v1 frontiers codec bakes the fixed creator in at
two places that cost nothing to remove while f5b0a is writing a new codec anyway
(`compareBytes(current.publicKey, successor.publicKey)` at prepare and open, and signing
under the *current* rather than the *successor* trust material), and that the profile ID
`creator-trusted-settlement-v1` fuses two orthogonal axes (authority model × settlement
policy) that the note's third axis (lineage policy) will multiply. Host migration itself is
not representable in protocol-v3 today — the successor anchor copies `signerSetDigest` and
`profileDigest` from the current anchor and every opener requires byte-identical signer-set
bytes — so FPS host migration is a new authority model that plan-v2 already classifies as a
separate high-risk design; it is out of scope for f5b and must be recorded, not absorbed.
The 64-member cap is a Profile-M design decision (≤ 64 durable writers per zone) but it
already contradicts Profile D (≤ 128 active writers per channel) independently of the note;
an author-state map is a codec `version: 2` evolution of a byte-opaque closure blob, not a
wire break, and needs no field reservation now. Net effect on plan-change.md: two small
concrete deltas inside f5b0a, three clarifications, and five items to record for Phase 7 /
Train S. No slice order, RED case, stop rule or critical-path change beyond those.

## 1. Classification table

| Item | Question | Classification | One-line reason |
| --- | --- | --- | --- |
| A.1 | Settlement *rules* depend on a fixed creator? | no change | Fence, plan, admissionEpoch, terminal rule, scan and recovery never consult the signer identity (§2.A) |
| A.2 | Settlement *checkpoint codec* depends on a fixed creator? | concrete change required (f5b0a, small) | The v1 frontiers codec it is modelled on requires `current.publicKey == successor.publicKey` and signs under `current`; drop the equality, sign/verify under the successor ("installing") authority (§2.A, Delta 1) |
| A.3 | Lineage-layer openers (`openCreatorCheckpointTrust`, `openCreatorSuccessorTrust`, anchor advance) fixed-creator? | out of scope, must be recorded | They are the lineage layer the note wants to make selectable; plan-v2 :91828 already excludes rotating authority from 0b1 |
| A.4 | Is host migration representable in the v3 close path today? | out of scope, must be recorded | No: successor anchor copies `signerSetDigest`/`profileDigest`; three openers require byte-identical signer-set bytes (§2.A) |
| B | ACL (application membership) separate from closing authority? | no change (clarification recorded) | Authority = profile/signer-set carriers invariant across epochs; ACL = latched snapshot bound by `aclDigest`; grant/revoke never touches the trust record. One dormant hook (`finality` group → `deriveNextLatchedSignerSet`) must be named (§2.B) |
| C.1 | Is the 64 cap a placeholder or a decision? | out of scope, must be recorded | Decision for Profile M (plan :236, :18117); already contradicts Profile D (≤ 128 writers/channel); measured: 64 full-shape members exceed the ACL's own 8,192-byte ceiling (§2.C) |
| C.2 | Reserve `authorStateRoot/Size` in the checkpoint now? | no change | The checkpoint is a versioned, kind-tagged closure blob that only protocol-v3 parses; a `version: 2` carrier swap is not a wire break. One clarification: outside consumers must go through a per-author accessor (§2.C, Delta 3) |
| C.3 | Which settlement rules would change under a map? | clarification only | Per-author rules unchanged; only the global "vector == successor ACL member set" verifier rule and the adjacency check become per-path; proof delivery to authors is a new API → stop-rule if attempted inside f5b (§2.C) |
| C.4 | Stop-rule trigger now? | no change | Not triggered: brief and plan-v2 fix O(64); it would trigger only if Profile D or an MMORPG-scale author set is pulled into f5b |
| D.1 | FPS: must fence/plan run at all? | no change (clarification) | Yes for everything that affects correctness across a close or a reconnect: plan durability, fence, admissionEpoch, terminal rule. Pruning/census/archive are policy (§2.D) |
| D.2 | Genesis-committed policy knobs | out of scope, must be recorded | `parameters` (bound by `parametersDigest` in every anchor) is the right carrier for lineage/retention policy, not `profileId`; adding a key is a registry-schema change → not f5b |
| D.3 | Is `profileId` the right carrier for `lineagePolicy`? Decompose now? | clarification + concrete change (f5b0a, small) | Profile bytes already bundle authority model × quorum × signers × suite; settlement and lineage are orthogonal. Keep the accepted ID for this slice set but route every settlement-profile check through one predicate so decomposition later is one owner (Delta 2) |
| E.1 | Settlement checkpoint composes with all three lineage profiles as "part of the current signed state"? | no change (after Delta 1) | It binds `successorAnchorDigest` (which binds ACL/state/history/signer-set/profile digests) and is verified under the successor trust material only (§2.E) |
| E.2 | Does any cold client walk `priorCheckpointDigest` to genesis? | clarification only | No; adjacency/monotonicity are advance-time checks over the retained immediate predecessor (0b rollback window). Plan-change must say so explicitly (Delta 4) |
| F.1 | Slices / RED list / stop rules / critical path | concrete change (RED additions only) | Two RED cases added to f5b0a; no reorder; D.110c-c/d/Phase 7 unchanged (§2.F) |
| F.2 | Claims in the note that are wrong or inapplicable here | must be recorded | Five items (§2.F) |

## 2. Evidence and reasoning per item

### A. Fixed-creator assumption

**A.1 — the settlement rules are signer-agnostic.** Walking every rule in plan-change.md:

- Fence (C.3): an operation inside the author's own v3 envelope, authenticated by the
  author's Ed25519 signature under `ts-drp/vertex/v3`; admission authority is ACL
  membership. No creator key involved.
- Plan (A.5/C.8): device-local issuance-store state. No creator key.
- `admissionEpoch` (B.2/C.6): derived from "author ∈ prior frontiers / current ACL" and the
  two ACL digests the checkpoint binds; the verifier recomputes it from the bound ACLs. The
  ACL digests are anchor fields (`protocol-v3/src/creator-close.ts:205-224`,
  `aclDigest: cut.aclDigest`), independent of who signs the anchor.
- Terminal rule and C.4 scan: per-author adjacency over the close graph; the only
  creator-specific branches are the creator's *own* rows (`node/src/creator-close.ts:488-490,
  :503-508, :531-533, :546-548`), which are "own-author" branches, not "creator-key" branches:
  under a migrated host they apply to whichever key is closing.
- C.5 author rule: classifies own rows by own signature, scope and digest against the
  anchor/epoch decoded from the row (`v3-live.ts:4762-4769` shape). No creator key.
- Ingress anchor fencing (B.1.6): `expectedAnchor = payload.provenance.anchorDigest`
  (`v3-live.ts:3800-3829`). No creator key.

Nothing above changes under any of the note's three lineage profiles. **No change.**

**A.2 — the checkpoint codec plan-change.md is modelled on is not signer-agnostic.** The
settlement checkpoint (C.1) is "drop-in" for `drp-creator-author-issuance-frontiers-state`.
That codec:

- at prepare requires `compareBytes(current.publicKey, successor.publicKey) === 0`
  (`protocol-v3/src/creator-author-issuance-frontiers.ts:278`) and mints the signing request
  under `current.publicKey` (`:310`);
- at open with `currentTrust` present requires `compareBytes(current.publicKey,
  floor.publicKey) === 0` (`:399`) and verifies the signature under `floor.publicKey`
  (`:418`), i.e. the *successor* trust;
- resolves both materials via `resolveCreatorAnchorTrustMaterial(CurrentAnchorTrust)`, whose
  type is `profileId: "creator-trusted-v1"` (`protocol-v3/src/index.ts:120-125`).

Today the two keys coincide, so the equality is free. Under a rotated authority (host A
closes N, host B is the epoch-N+1 authority) the checks at `:278`/`:399` fail and the codec
cannot be reused. The minimal fix that composes with all three lineage profiles without a
later redesign: the settlement checkpoint is **a payload of the successor epoch's
authority** — the key(s) the epoch-N+1 trust record exposes — signed at prepare under
`successor` material, verified at open under `floorTrust` only, with no
current-vs-successor key equality. Reasons this is the right side: (i) a cold client holds
only the current (successor) trust, so verification under `floor` is what already happens at
`:418`; (ii) in a crash migration B *is* the closer of N; in a make-before-break handoff B is
online and holds the close graph, so B can recompute the C.4 vector before signing; (iii) the
closing epoch's authority is still bound because `closedAnchorDigest` is in the preimage and
the N→N+1 transition (QC, `commitQcRef`) is bound. See Delta 1.

Under multi-signer profiles (`delegated-trusted-v1`, `attested-bft-v1`, defined only as
genesis-certificate types at `protocol-v3/src/index.ts:127-135, :881, :997-998`, no close
path) the single `detachedCreatorSignature` field is the wrong shape; a QC-shaped
attestation is a codec version bump later. Rename the field now (free in a new codec) so
the name does not lie: `detachedAuthoritySignature`.

**A.3/A.4 — what is baked in, and whether host migration is representable.** Every place
the *lineage/trust layer* fixes the creator:

| Owner | Line | What it fixes |
| --- | --- | --- |
| `protocol-v3/src/creator-close.ts` | `:218-222` | successor anchor copies `parametersDigest`, `profileDigest`, `signerSetDigest` from the current anchor |
| same | `:274-282` | profile bytes must be exactly `{cryptoSuiteId, profileId: "creator-trusted-v1", quorum: 1, signers}` with one signer |
| same | `:379` | `prepareCreatorClose` requires `exactCanonicalNextSignerSetBytes` byte-equal to the current material's signer set |
| same | `:531-543` | trust record hard-codes `profileId: "creator-trusted-v1", quorum: 1` |
| same | `:598-601` | `openCreatorSuccessorTrust` requires `profileId === "creator-trusted-v1"`, `quorum === 1`, byte-identical profile and signer-set bytes |
| `protocol-v3/src/index.ts` | `:1510-1511`, `:1693-1694`, `:1744-1745` | anchor verification/advance requires `profileDigest`/`signerSetDigest` equal to the trusted state's |
| `protocol-v3/src/creator-checkpoint.ts` | `:144-145`, `:238-243`, `:260-262` | `openCreatorCheckpointTrust` requires `creator-trusted-v1`/quorum 1 and synthesises the genesis record with the predecessor's profile/signer bytes, then requires byte-equality with genesis material |
| `node/src/creator-close.ts` | `:203-213` | `verifiedCreatorTrustRecord` requires `creator-trusted-v1`, `quorum === 1`, `signerSet.length === 1` |
| same | `:902` | passes the *current* signer set as `exactCanonicalNextSignerSetBytes` — the close path has no input for a different next signer set |
| `node/src/v3-live.ts` | `:1431` | reopen requires `trust.profileId === "creator-trusted-v1"` |
| `examples/v3-room/src/index.ts` | `:242`, `:488`, `:3985` | room type and two runtime checks |
| `examples/grid/src/v3-zone.ts` | `:1685-1692` | zone genesis builds `signerSet = [{ publicKey: localAuthorId, signerId: "creator" }]`, `creator-trusted-v1`, quorum 1 |
| `protocol-v2/src/registry.ts` | `:459-462` | profile switch: `creator-trusted-v1` quorum must equal the creator quorum constant |

Therefore host migration (host A → host B as closing authority) is **not representable**
in the protocol-v3 close path: the next signer set is structurally the current one. This is
consistent with plan-v2's own scope statement: "D.110c-0b1 is limited to stable
`creator-trusted-v1`; rotating creator/seal authority, delegated/BFT repeated rollover,
external pins, and recursive proofs are excluded" (plan-v2 :91828-91830), and the 0b
decision matrix: "any future rotated-authority use is a separate high-risk design"
(:91746). The only rotation-shaped hook in the code is `deriveNextLatchedSignerSet`
(`latched-acl.ts:459-480`), which derives a seal signer set from ACL members holding the
`finality` group; it is called once (`v3-live.ts:3521`) to populate `nextSigners`
(`:3527`) and that field has no consumer (single grep hit in `packages/node/src`). The
creator close ignores it and passes the trust-record signer set (`creator-close.ts:902`).

Plan-change.md's stop rules already fix "creator-trusted authority model". The note's
Profile A (ephemeral chain with host migration) therefore requires a new authority model —
out of scope for f5b, to be recorded (§4 item 1). Nothing in plan-change.md needs to move
for it, provided Delta 1 lands so the settlement checkpoint does not have to be re-cut when
that model arrives.

### B. Authority membership vs application membership

Confirmed separate today:

- **Closing authority** = profile bytes + signer-set bytes carried in the trust record
  (`protocol-v3/src/creator-close.ts:531-543`), digests `profileDigest`/`signerSetDigest`
  in every anchor (`:219, :222`), invariant across epochs (`:379`, `:601`; `index.ts:1744-1745`).
- **Application membership** = `LatchedAclSnapshot` with groups `admin | finality | referee
  | writer` (`latched-acl.ts:5-6, :19-32`), bound into the anchor only by `aclDigest`
  (`protocol-v3/src/creator-close.ts:208`), staged from `grant`/`revoke`/`set-finality-key`
  by `admin`/`finality` actors (`latched-acl.ts:376-401`), and gating application writes at
  ingress (`v3-live.ts:3449-3455`, `:7510-7517`) and at close for the writer set
  (`creator-close.ts:404-412`).

Adding or removing an ACL member changes `aclDigest` and the frontier vector; it does not
touch the trust record, the signer set, `openCreatorSuccessorTrust`, or the anchor's
`signerSetDigest`. A player join is therefore not an authority change — the note's
requirement already holds. **No change.**

Two things to record so it *stays* true: (1) `permissionless: true` does not remove the
membership requirement (`latched-acl.ts:334-336`: `member !== undefined && (permissionless
|| writer)`), so "player joins" are ACL grants in every mode; (2) the `finality` group is
the ACL's dormant foothold into authority (`deriveNextLatchedSignerSet`). A future
rotating-authority profile that wires `nextSigners` into the close would make
`grant finality` an authority change — acceptable only because `finality` is a distinct
group from `writer`; plan-change.md should state that the settlement frontier vector keys
on *all roles* (C.1 already says "every role, ≤ 64") precisely so that authority-role
changes never alter the vector's membership rule.

### C. The 64-member cap and large rooms

**C.1 — decision or placeholder.** Evidence:

- `latched-acl.ts:133-134` (`members.length > 64` rejected), `:206`/`:218` (8,192-byte
  canonical ceiling on the ACL bytes), `protocol-v3/src/index.ts:774` (author-list ≤ 64),
  `creator-author-issuance-frontiers.ts:165` (≤ 64 frontier entries), and two tests pin 65
  as the rejection boundary (`tests/protocol-v3-creator-author-issuance-frontiers.test.ts:212`,
  `tests/protocol-v3-current-epoch-author-authorization-p6-red.test.ts:394`).
- plan-v2 `:236`: "reachable target is zone-instanced multiplayer (≤ 64 durable
  writers/zone …) … **Seamless single-shard worlds … are non-goals.**"; Profile M
  `:18117` "Active writers ≤ 64 durable". So for the MMORPG zone the cap is a **design
  decision**, and the note's "thousands of concurrent authors" world is explicitly a
  non-goal for this codebase.
- plan-v2 `:97018` and `:97080` call it "the existing 64-member ACL ceiling/maximum" —
  treated as given, never derived.
- **But Profile D** (`:18117`) states "Active writers ≤ 128 per 5-min window" and
  "Online replicas / object ≥ 1,000"; the chat golden path must grant Writer through the
  ACL (`:18262-18266`); and membership is required to author even in permissionless mode
  (`latched-acl.ts:334-336`). A Discord channel with 128 distinct writers in five minutes
  cannot exist under a 64-member ACL. This contradiction predates the note and is
  independent of settlement; it has no owner in plan-v2 that I can find.
- Measured (scratchpad `measure-acl.ts` via `tsx` over `packages/canonical/src`): a
  64-member v2 snapshot where every member holds a finality key and all four groups encodes
  to **12,888 B**, over the 8,192-byte ceiling at `latched-acl.ts:206/:218`; 64 writer-only
  members with `finalityKey: null` encode to **7,064 B**. So the effective cap is
  shape-dependent (~40 full-shape members). P3, but it belongs in the same record as the
  Profile-D contradiction because any cap decision must re-derive both numbers.

**C.2 — reserve `authorStateRoot/Size` now?** No. The settlement checkpoint is a
kind-tagged, versioned closure candidate blob (`kind`, `version: 1` in C.1); the AHE store
and control plane select it by decoded `kind` and treat it as bytes
(`node/src/internal/creator-transition-advance.ts:110-114`;
`node/src/creator-close.ts:255-284` `uniqueRecordCandidate`), and the 8,192-byte ceiling is
a codec constant (`creator-author-issuance-frontiers.ts:12`). Replacing `frontiers` with a
map root under a later `version: 2` (or a tagged `frontierCarrier`) is a codec change inside
protocol-v3, not a vertex-envelope or anchor change, and needs no reserved field today.
What *does* need doing now is cheap: the three consumers outside protocol-v3 that read
`identity.frontiers` positionally (`creator-transition-advance.ts:254, :418, :440-441`)
should read through a per-author accessor exported by the codec so a map-backed carrier can
answer the same lookups. See Delta 3.

**C.3 — which rules move if frontiers live in a map.** Independent of storage: fence
semantics; plan-fence-replace and its crash matrix (A.3/C.7); `admissionEpoch` copy/assign
rule per author; `terminalThrough` monotonicity per author; C.4 scan per author; C.5 author
classification; ingress anchor fencing; pruning gates; the null-boundary rule (B.3).
Storage-dependent: (a) the global verifier rule "vector is exactly the successor ACL's
members" (C.1, C.10 case 18) becomes "map size == member count, and each changed member's
path verifies"; (b) the advance-time adjacency check (`creator-transition-advance.ts:440-441`
today) becomes per-changed-path; (c) the creator's close emits O(changed × log N) proofs;
(d) the author must receive its own path at open — a proof carrier delivered with the
checkpoint, which does not exist (the trust record, cut, QC and checkpoint are the whole
closure). (d) is a new API/wire item and therefore a stop-rule trigger **if** attempted
inside f5b; it is not triggered by the note because the accepted scope is O(64).

**C.4 — stop-rule trigger now?** No. Record §4 item 2 (Profile-D contradiction / cap
decision) and §4 item 3 (author-state map as the Phase-7/Train-S evolution).

### D. Ephemeral profile (FPS match)

**D.1 — mandatory vs policy.** In an FPS match the displaced-row case is real: host
migration is an epoch close, and a player who reconnects after the migration holds rows
issued into the dead epoch. What must run regardless of profile:

- Durable plan before fence (A.3 rows 2-4): reconnect-after-crash *within* the match is
  exactly the FPS "preserve reconnect state" requirement; an in-memory plan reintroduces
  the peer's lost-work trace (peer-review-notes "Blocking problem 1"). The plan store's
  *storage class* (memory vs IDB vs SQLite) is a caller custody choice, as for every other
  store (plan-v2 row 10 `:592`: "storage class determines custody"), and C.8 already lists
  a memory implementation; it is not genesis-committed and not a profile axis.
- Fence, terminal rule, `admissionEpoch` (a player who leaves and rejoins mid-match is the
  same-key re-entry case, C.6/B.3), and the checkpoint frontier. Without these a migrated
  host's close cannot advance frontiers and a reconnecting player double-applies or stalls.
- Rollback-generation retention (0b window): safety, not policy.

Policy-gated: `pruneAuthenticatedSettledPrefix` (an FPS room can skip it and archive/delete
at match end); the ≥ 100-transition census (D.110c-d) is a long-lived-room gate; archive
tier; journal/snapshot/seal scope retirement cadence (D.110c-c) — for a 2-3 transition
room "retire at room end" is a valid cadence.

**D.2 — genesis-committed knobs.** Only inputs that change *verification* need genesis
commitment: settlement mode (already the profile), a maximum epoch/lifetime if verifiers
must reject closes beyond it, and a lineage mode. The existing genesis-committed
policy carrier is `parameters` (`parametersDigest` in every anchor, copied unchanged at
`protocol-v3/src/creator-close.ts:218`; fields today `maxEpochVertices`, `maxEpochBytes`,
`maxDependencies`, `snapshotChunkBytes`, `maxSnapshotBytes`, `maxPendingEntries`,
`maxPendingBytes`, `examples/grid/src/v3-zone.ts:28-36`). The note's `lineagePolicy {mode,
maximumEpochs, allowedUpgrade, recursiveVerificationKeyId}` belongs there (or in a sibling
policy carrier bound the same way), not in `profileId`. Adding a key changes the
protocol-v2 registry kind schema and every genesis builder (grid `:28-36`, v3-room,
v3-chat) → not f5b; record §4 item 4. Nothing in plan-change.md needs a knob for the FPS
case *today* because the fixed-signer profile has no lineage cost to bound.

**D.3 — is `profileId` the right carrier?** The profile bytes are exactly
`{cryptoSuiteId, profileId, quorum, signers}` (`protocol-v3/src/creator-close.ts:274-282`),
i.e. the profile is already (authority model × quorum × signer set × suite). Settlement
policy and lineage policy are orthogonal axes; `creator-trusted-settlement-v1` fuses the
first two and the note's third would give `creator-trusted-settlement-ephemeral-v1` etc.
Decomposing now would cost a registry schema change and touch every genesis builder — a
stop-rule trigger ("different wire … or API") for a slice set whose stop rules were
accepted with the profile-ID carrier. Decision: keep the accepted ID for f5b, but make the
*code* indifferent to it: one predicate in protocol-v3 answers "does this profile carry
settlement v1?" and every site that would otherwise compare a string consults it (Delta 2).
Then decomposition later is a one-owner change, and `creator-trusted-settlement-v1` is
recorded as the last fused ID (§4 item 4).

### E. Lineage proof layer and the trust boundary

The settlement checkpoint binds `successorAnchorDigest` (C.1), and the successor anchor
binds `aclDigest`, `stateDigest`, `historyRoot/Size`, `archiveIndexRoot`, `profileDigest`,
`signerSetDigest`, `parametersDigest` (`protocol-v3/src/creator-close.ts:205-224`). So once
any lineage profile has authenticated "the current epoch's anchor and authority", the
settlement checkpoint is verified as **part of that signed state**: signature under the
current-epoch authority material, plus the exact-digest bindings the frontiers opener
already checks (`creator-author-issuance-frontiers.ts:400-412`). After Delta 1 no other
material is required.

Exact trust boundary for a cold client (after Delta 1):

1. Lineage layer (whatever profile) yields the current epoch's authority material and anchor
   digest — today `openCreatorCheckpointTrust` with the pinned genesis, one predecessor
   record and the caller-held freshness head (`creator-checkpoint.ts:186-262`).
2. Settlement checkpoint: verify signature under that material (`floor.publicKey` at
   `:418` today); verify `successorAnchorDigest == currentAnchorDigest`, `successorEpoch ==
   currentEpoch`, `successorAclDigest == anchorAclDigest(current anchor)`, and the cut/QC/
   manifest/current-ACL expectations supplied from the retained closure.
3. `priorCheckpointDigest` / `priorCheckpointKind`: **opaque at cold open**. Adjacency
   ("genesis sentinel or one adjacent settled-v1"), `admissionEpoch` copy-unchanged and
   `terminalThrough` monotonicity are checked at *advance* time by the control-plane
   bounded-advance predicate over the retained immediate predecessor
   (`creator-transition-advance.ts:394-400` selects current vs proposed candidates;
   `:440-441` compares frontiers; the 0b rollback window guarantees that predecessor is
   present, plan-v2 `:91771-91779`, `:91797-91804` "no recursive predecessor walk is
   permitted beyond the fixed rollback window"). No client ever verifies the checkpoint
   chain back to genesis; cold reopen is O(1) in epochs.

Plan-change.md C.1 says "Predecessor rules (genesis sentinel or one adjacent settled-v1;
mixed/skipped/downgraded fail closed)" without saying *where* they are enforced; C.10 case
18 ("verifier rejects …") reads as if the codec opener does it. Delta 4 makes the split
explicit so f5b0a does not put an O(epochs) obligation into the opener.

### F. Everything else in the note

**F.1 — slices, RED list, stop rules, critical path.** No reorder. f5b0a gains Delta 1-3
and two RED cases (§3). f5b0s/b/c/d/f5b unchanged. D.110c-c, D.110c-d, Phase 7 unchanged;
Phase 7 gains the recorded items in §4. Stop rules unchanged in substance; one sentence is
added so "creator-trusted authority model" is not read as "settlement checkpoint verifier
compares creator keys".

**F.2 — claims in the note that are wrong or do not apply here.**

1. "The current transition-chain implementation is a useful foundation but … cannot close
   the genesis-only golden path" and the 1.8-7.3 MB / 3,650-sequential-verification cost.
   ts-drp does not retain a transition chain at all: the 0b design keeps one current trust
   record, the N-1→N cut/QC and exactly two rollback closures (plan-v2 `:91771-91779`), and
   the cold opener verifies the genesis pin, one predecessor and the current record
   (`creator-checkpoint.ts:186-262`). For a fixed signer the genesis-only golden path is
   already age-independent; the note's cost model applies only once the signer rotates.
2. "Keep the Merkle author map … in all profiles." Over-scoped for this codebase: at ≤ 64
   members the sorted vector *is* the authenticated author map, and the retired-key map was
   deleted for cause (plan-change §C.9). A map is the Train-S evolution (§4 item 3).
3. "One common checkpoint format" with `epoch / authority / state root / author map root /
   history root / lineage proof` as one record. ts-drp composes these by digest across
   anchor + trust record + settlement checkpoint; collapsing them into one record is a
   wire change and a stop-rule trigger. Composition by binding is equivalent and already
   the accepted shape.
4. Profile B (externally pinned checkpoint) was **rejected for D.110c-0b** and accepted only
   as a separately reviewed Phase-7 bootstrap/freshness design (plan-v2 `:91745`, `:92489`);
   Profile C (WRAPS-like) was rejected as disproportionate and "a separate high-risk design"
   (`:91746`, `:91828`). The note's recommendation to make them genesis-selectable is
   compatible with those decisions only as Phase-7 work; it does not reopen 0b.
5. "A server must not downgrade a sovereign room" is already the rule: `profileDigest` is
   bound in every anchor and compared at every advance (`index.ts:1510, :1744`), and
   plan-v2 `:17593` "negotiation MUST NOT downgrade an existing object". Nothing to add.
6. Applicable and already covered: "author-incarnation handling" = `admissionEpoch`;
   "append-only archive history" = RFC 9162 commitment (`compaction/src/history-commitment.ts`);
   "settlement rules … epoch-transition semantics" = plan-change Parts A-C.
7. Not applicable yet: "make-before-break handoff" — there is no handoff; the successor
   signer set is structurally the current one (A.4).

## 3. Concrete deltas to plan-change.md

**Delta 1 — C.1 / C.9 slice 1 (f5b0a): signer-agnostic settlement codec.** Add to C.1
after the byte-ceiling sentence:

> Signing and verification. The record carries `detachedAuthoritySignature` (not
> `detachedCreatorSignature`). `prepare…` mints the signing request under the **successor**
> trust material's public key; `open…` verifies under `floorTrust` only. The codec never
> requires `current.publicKey` to equal `successor`/`floor.publicKey`
> (the v1 frontiers codec's checks at `creator-author-issuance-frontiers.ts:278` and `:399`
> are **not** carried over). Binding of the closing epoch is by `closedAnchorDigest`,
> `closedEpoch`, `currentAclDigest` and `commitQcRef`, not by signer identity. Under
> `creator-trusted-settlement-v1` both keys coincide, so behaviour is identical; the rule
> exists so the checkpoint is a payload of "the authority that installs epoch N+1" and
> composes unchanged with a later rotated-authority lineage profile.

**Delta 2 — C.9 slice 1 (f5b0a): one settlement-profile predicate.** Add:

> Profile union is implemented as a single exported predicate in protocol-v3
> (`settlementProfileFor(profileId): "none" | "v1"`), consulted by the codec, the
> `registry.ts:460` switch, the control-plane normalisation, the closure validators, the
> Node close path (`creator-close.ts:209`), reopen (`v3-live.ts:1431`) and the room
> (`v3-room/src/index.ts:488, :3985`). No site compares the profile string directly.
> `creator-trusted-settlement-v1` is the last profile ID that fuses an authority model with
> a settlement policy; a later decomposition into (authority profile, lineage policy,
> settlement policy) carried in `parameters` changes only this predicate.

**Delta 3 — C.9 slice 1 (f5b0a): per-author accessor.** Add:

> The codec exports `frontierFor(identity, author)` and `frontierCount(identity)`; the
> control plane (`creator-transition-advance.ts:254, :418, :440-441` today) uses them
> rather than indexing `identity.frontiers`. This is the only preparation made for a
> map-backed carrier (`version: 2`); no field is reserved.

**Delta 4 — C.1 and C.10 case 18: where predecessor rules are enforced.** Replace
"Predecessor rules (genesis sentinel or one adjacent settled-v1; mixed/skipped/downgraded
fail closed) … are unchanged" with:

> The opener verifies one record against `floorTrust` and the expected cut/QC/manifest/ACL
> digests; `priorCheckpointDigest` and `priorCheckpointKind` are validated for shape only.
> Adjacency (genesis sentinel or exactly one adjacent settled-v1), `admissionEpoch`
> copy-unchanged and `terminalThrough` monotonicity are enforced by the control-plane
> bounded-advance predicate over the retained immediate predecessor in the 0b rollback
> window. No opener, cold or hot, walks the checkpoint chain; cold reopen is O(1) in
> epochs.

Amend C.10 case 18 to read "the **advance predicate** rejects …" and add:

> 28. (+) Cold open with `floorTrust` only (no `currentTrust`, no predecessor bytes)
>     succeeds for a valid current checkpoint whose `priorCheckpointDigest` is unknown to the
>     opener; the opener never requests predecessor bytes.
> 29. (+) Codec signer independence: a checkpoint prepared and opened where the
>     successor material's key is the only key supplied verifies; the codec exposes no input
>     for a current-epoch key.

**Delta 5 — Stop rules: one clarifying sentence.** After "creator-trusted authority model":

> "Creator-trusted" constrains who may close; it does not license the settlement codec or
> verifier to compare closing-authority keys across epochs (Delta 1).

## 4. Ranked record for later slices (not f5b)

1. **Rotating authority / host migration is a new authority model** (P1 for the FPS golden
   path, out of scope for D.110c). Not representable today: `protocol-v3/src/creator-close.ts:218-222,
   :379, :598-601`; `index.ts:1744-1745`; `node/src/creator-close.ts:902`. plan-v2 `:91828`
   already excludes it from 0b1; `:91746` classifies it as a separate high-risk design. The
   dormant hook is `deriveNextLatchedSignerSet` → `nextSigners` (`latched-acl.ts:459-480`,
   `v3-live.ts:3521-3527`, no consumer). Design must decide the closer-of-N vs
   installer-of-N+1 signing rule for the *trust record*; the settlement checkpoint is
   already settled on installer-of-N+1 by Delta 1.
2. **64-member cap vs Profile D** (P1 for the chat golden path, independent of the note).
   `latched-acl.ts:133-134, :334-336` vs plan-v2 `:18117` (≤ 128 writers, ≥ 1,000 replicas)
   and `:18262-18266`. Plus the measured shape dependence: 64 full-shape members = 12,888 B
   > 8,192-byte ceiling (`latched-acl.ts:206/:218`); 64 writer-only = 7,064 B. Any cap
   decision must re-derive the ACL ceiling, the author-list cap (`index.ts:774`), the
   frontier cap (`frontiers.ts:165`, C.1 "≤ 64") and the tests that pin 65.
3. **Author-state map carrier** (P2, Train S / Phase 7). Codec `version: 2` swapping
   `frontiers` for `{root, size}` with per-author O(log N) paths; new proof-delivery
   carrier to authors at open (does not exist; stop-rule if attempted inside f5b).
   Settlement rules that survive unchanged: everything per-author (§2.C.3).
4. **Policy decomposition and carrier** (P2, Phase 7 genesis schema). (authority profile,
   lineage policy, settlement policy) with lineage/settlement/retention knobs in
   `parameters` (bound by `parametersDigest`, `protocol-v3/src/creator-close.ts:218`;
   builders `examples/grid/src/v3-zone.ts:28-36`) — registry kind schema + every genesis
   builder. `creator-trusted-settlement-v1` recorded as the last fused ID (Delta 2).
5. **Ephemeral-room retention cadence** (P3, D.110c-c). "Retire journal/snapshot/seal
   scopes and skip `pruneAuthenticatedSettledPrefix`; delete at room end" is a valid cadence
   for ≤ 3-transition rooms; D.110c-c's census should accept it as a policy, not as a
   deviation. No genesis knob is required for the fixed-signer profile.
6. **Lineage Profiles B and C** (P3, Phase 7). Already dispositioned by plan-v2 `:91745-91746`,
   `:92489`; the note's genesis-committed `allowedUpgrade` pre-commitment is sound and
   belongs with item 4.
