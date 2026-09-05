# Writer-cap code and constraint verification (repo @ codex/phase3a1b-p6-golden-path)

All paths absolute under /Users/aristotle/Documents/Projects/ts-drp-1. All byte numbers measured with the repo's own `encodeCanonical`/`decodeCanonical` (packages/canonical/dist/src/index.js), 2026-09-03.

## 0. Headline verified fact (new, P0)

**The operational ACL cap today is NOT 64. It is 30 writer-only-shape members / 22 full-shape members**, because `openCanonicalLatchedAclSnapshot` decodes with `{ maxBytes: 8192, maxDepth: 4, maxItems: 512 }` at `packages/protocol-v3/src/latched-acl.ts:219`, and a member costs 16 decoded items (writer-only: `{author, finalityKey:null, groups:["writer"]}`) or 22 items (full shape), on a base of ~25 items. Measured with the actual decoder:

- writer-only: n=30 decodes, n=31 fails "canonical value exceeds item limit" (505 vs 521 items against 512)
- full shape: n=22 decodes, n=23 fails
- the 64-member object-level cap (`latched-acl.ts:134`) and the 8,192-byte cap (`latched-acl.ts:16`) are therefore never the binding constraint on the open path

**Asymmetry hazard**: `stageLatchedAclOperations` (`latched-acl.ts:376-451`) validates via `copySnapshot` (object-level, ≤64 check only, no item/byte limit) and `freezeMembers` imposes **no cap at all** on the staged successor. So grants can grow an ACL to 31..64 members, the successor snapshot encodes fine into the epoch snapshot payload (`packages/node/src/v3-live.ts:7146` encodes with `maxSnapshotBytes`), and then **close fails**: `packages/node/src/creator-close.ts:437-441` re-opens both ACLs via `openCanonicalLatchedAclSnapshot` and throws `"creator issuance-frontier ACL authority is unavailable"`. Adoption/recovery fail the same way (`v3-live.ts:4926`, `creator-adoption.ts:874/1145/1478`). This is a latent room-bricking path independent of any cap raise.

## 1. Every site pinning the caps

### 64-member / 64-author caps
| Site | What |
|---|---|
| packages/protocol-v3/src/latched-acl.ts:134 | `record.members.length > 64` → snapshot rejected (copySnapshot; used by open, stage, authorize, deriveSigners) |
| packages/protocol-v3/src/latched-acl.ts:219 | `maxItems: 512` decode limit — the *actual* binding cap (30 writer / 22 full) |
| packages/protocol-v3/src/index.ts:774 | v1 author-authorization carrier: `value.authors.length > 64` rejected |
| packages/protocol-v3/src/creator-author-issuance-frontiers.ts:165 | issuance-frontier aggregate: `value.length > 64` frontiers rejected |
| .logs/d110c-0c1f5b0r-design-3a156aca/design.md:87-89 | settlement checkpoint frontiers "exactly the successor ACL's members of every role (at most 64)" — design, not yet code |
| docs/production-hardening/production-hardening-tdd-plan-v2.md:18117 | Profile D "Active writers ≤128 per 5-min window / ≤64 durable"; gap record `D.110c-0c1k` at :97011 |

No source file defines a named `maxMembers`/`MAX_MEMBERS` constant; the 64s are inline literals.

### 8,192-byte ceilings
| Site | What |
|---|---|
| packages/protocol-v3/src/latched-acl.ts:16 | `MAX_CANONICAL_BYTES = 8192` — ACL carrier bytes (open path only, :206, :219) |
| packages/protocol-v3/src/index.ts:117 | `ANCHOR_TRUST_STATE_MAX_RECORD_BYTES = 8192` |
| packages/protocol-v3/src/index.ts:401 | `AUTHOR_AUTHORIZATION_MAX_BYTES = 8192` (v1 author-list carrier) |
| packages/protocol-v3/src/creator-author-issuance-frontiers.ts:12 | `CREATOR_AUTHOR_ISSUANCE_FRONTIERS_MAX_RECORD_BYTES = 8192` (decode at :376) |
| packages/protocol-v3/src/creator-issuance-retirement.ts:12 | `CREATOR_ISSUANCE_RETIREMENT_MAX_RECORD_BYTES = 8192` |
| packages/protocol-v3/src/creator-checkpoint.ts:214-215 | trust-state record pair each ≤8192 |
| packages/protocol-v3/src/creator-close.ts:577 | trust-state record ≤8192 |
| packages/node/src/creator-close.ts:69 | `SCANNABLE_BYTES = 8192` — blobs larger than this are **silently skipped** in the close trust scan (:620) and in the proposed-reference filter (:994) |
| .logs/d110c-0c1f5b0r-design-3a156aca/design.md:72,125 | settlement checkpoint "maximum 8,192 canonical bytes"; "the 8,192-byte ceiling is not raised" |

### ACL snapshot versions and member record shape
- Versions `1 | 2` only: latched-acl.ts:5-6 (`GROUPS_V1` = admin/finality/writer; `GROUPS_V2` adds referee), validated at :124; groups-for-version at :110-118.
- Member shape `{author, finalityKey, groups}`: `MEMBER_KEYS` latched-acl.ts:8, type `LatchedAclMember` :20-24; authors strictly sorted (:147), groups strictly ordered per version (:156-163), `finalityKey` requires finality group (:165), ≥1 admin required (:174).
- Anchor binds `aclDigest` only (index.ts:453 in `ANCHOR_KEYS`; digest check at index.ts:1600-1601); ACL bytes are NOT in the anchor.

### Tests that pin the constants
- tests/protocol-v3-current-epoch-author-authorization-p6-red.test.ts:394 — constructs 65 authors, expects rejection (pins v1 64-author cap).
- tests/protocol-v3-creator-author-issuance-frontiers.test.ts:145 — `expect(...MAX_RECORD_BYTES).toBe(8_192)`; :144 record-under-ceiling; :270 over-ceiling rejection.
- tests/protocol-v3-anchor-trust-3a0.test.ts:386 — `ANCHOR_TRUST_STATE_MAX_RECORD_BYTES` = 8192 (re-exported through ~15 more public-surface audit tests, e.g. tests/genesis-profile.test.ts:64, tests/protocol-v3-local-author-signer-p5-red.test.ts:112).
- packages/storage-browser/tests/phase-5e-creator-live-close.pw.ts:354 — retirement ref byteLength ≤ 8192.
- packages/storage-browser/tests/assets/phase-5e-creator-actor-entry.ts:138 and phase-6a-creator-successor-product-entry.ts:826, packages/storage-node/tests/phase-6a-creator-successor-local-author-death-red.test.ts:1144 — pin `maxEpochVertices: 8_192` (epoch budget, not ACL).
- **No test constructs a 65-member ACL**: nothing pins latched-acl.ts:134, and nothing pins the maxItems:512 behavior. The latched ACL tests (tests/protocol-v3-latched-acl-semantics-3d-red.test.ts, tests/protocol-v3-latched-acl-referee-successor-red.test.ts) use ≤3 members.
- examples/v3-room/src/index.ts:1352-1355 and :1392 — decodes ACL with `maxItems: 512, maxBytes: 65_536` (independent copy of the item limit; must move with any raise).
- packages/protocol-v3 freeze policy (conformance/freeze-policy-v3.json) does NOT freeze latched-acl.ts, creator-close.ts, or creator-checkpoint.ts (frozen set = registry/formal/reference/canonical-tag docs only).

## 2. Per-vertex authorization path

- Holder: `V3LiveAuthorization = {kind:"author-list", value: CurrentEpochAuthorAuthorization} | {kind:"latched-acl", value: LatchedAclSnapshot}` — packages/node/src/v3-live.ts:4210-4212, one per plane registration (per room per peer), built once per epoch at v3-live.ts:4910-4933 (`openRecoveryAuthorization`; ACL bytes verified against the anchor's `aclDigest`).
- Ingress per received envelope: v3-live.ts:4039-4041 → `resolveV3AuthorizedAuthor` (:3436-3447) → `authorizeLatchedEnvelopeAuthor` (latched-acl.ts:302-323). Recovery path: v3-live.ts:4437-4448. Blueprint fold authorizes **every application vertex again**: v3-live.ts:7043-7048 → `isV3ApplicationAuthorAuthorized` (:3449-3456) → `authorizeLatchedApplicationWrite` (latched-acl.ts:325-343).
- **Cost**: every single call goes through `authorityInput` → `copySnapshot` (latched-acl.ts:279-290 → :120-181), which re-validates and re-allocates the entire member list (regex per author, group ordering, freeze per member) — O(N) validation + O(N) allocation — then a linear `members.some/find` (:312, :335). So per-vertex auth is **O(N) with heavy allocation**, and an epoch fold is O(V·N): at V=8192, N=64 ≈ 0.5M member validations + 8,192 full-snapshot copies; at N=1024 ≈ 8.4M + 8,192 copies of a 1,024-member structure. Contrast: the v1 author-list path builds a `Set` once (index.ts:1611-1612) and is O(1) per lookup.
- ACL residency per peer per epoch: the decoded `LatchedAclSnapshot` (≈N × ~200 B of JS objects) held in the registration; exact canonical ACL bytes (≤8,192 today) held as an AHE blob (scan candidates, node/creator-close.ts:615-623) and inside the epoch snapshot payload as `payload.acl` (node/creator-close.ts:854-865; re-encoded at creator-adoption.ts:700, 1138). Transport: **anchor carries only `aclDigest`**; the ACL bytes ride in the snapshot payload / invite material / blob store — snapshot AND blob, never the anchor.

## 3. How the ACL changes

- Operation kind: an application vertex with `action: "acl"` (`RESERVED_BATCH_ACTIONS` v3-live.ts:224), shape `{action, group, kind: grant|revoke, target}` parsed at v3-live.ts:3458-3484 (`aclOperation`; actor = authenticated vertex author). `set-finality-key` exists at the codec level (latched-acl.ts:252-263) but is not producible from the live `acl` action.
- Staging: each accepted acl vertex is validated by replaying **all** staged ops + candidate through `stageLatchedAclOperations` (v3-live.ts:3496-3508 `validateLatchedOperation`, ordered by vertex digest :3486-3494) — O(k²) stage replays per epoch for k acl ops, each replay O(N+k). Stored in `registration.latchedOperations` (v3-live.ts:4245).
- Latching: at close/export, `latchedAclPreview` (v3-live.ts:3510-3538) folds staged ops into `next` (epoch+1), which is embedded in the snapshot payload (`exportLiveSnapshotPayload` v3-live.ts:7130-7161); the creator binds `aclDigest = H(payload.acl)` into the successor anchor via `prepareCreatorClose` closeInput (node/creator-close.ts:865, :894) — protocol-v3/creator-close.ts:65 has `aclDigest` in the anchor keys.
- Grant/revoke limits per close: only admins grant/revoke (latched-acl.ts:399-405); one acl op per vertex, so bounded by the epoch vertex budget (`maxEpochVertices`, examples/v3-chat/src/index.ts:29 = 8192) and by the staged-successor having ≥1 admin (:427-430); **no explicit count cap on operations**, and (per §0) no cap at all on the staged successor's member count — the cap is only enforced when the successor is later re-opened.

## 4. Measured canonical byte sizes (repo encoder)

ACL snapshot (`objectId` "room-abcdef-0123456789"; brief's 7,064/12,888 reproduces within objectId-length delta):

| N | writer-only shape | full shape (finalityKey + 4 groups) |
|---|---|---|
| 64 | 7,022 B | 12,846 B |
| 128 | 13,935 B | 25,583 B |
| 256 | 27,759 B | 51,055 B |
| 1,024 | 110,703 B | 203,887 B |

Marginal cost ≈108 B/member writer-only, ≈199 B/member full. Under the 8,192-byte ceiling alone: ≤74 writer-only / ≤40 full members. Under `maxItems: 512`: **≤30 writer-only / ≤22 full** (binding today).

Settlement checkpoint (full record per design.md:74-84 incl. `detachedAuthoritySignature`, triple `[author(hex64), admissionEpoch, terminalThrough|null]`, 50% null):

| N | full record bytes | vs 8,192 ceiling |
|---|---|---|
| 64 | 5,979 B | fits (design's own 64-member measurement region) |
| 128 | 10,780 B | exceeds |
| 256 | 20,380 B | exceeds |
| 1,024 | 77,980 B | exceeds |

Envelope ≈1,180 B, ≈75 B/frontier line → the v1 checkpoint ceiling fits **≤ ~93 members**. Frontier lines alone: 4,706 / 9,411 / 18,819 / 75,267 B at 64/128/256/1,024. Author identity is 64-char lowercase hex (ed25519 pubkey hex; `AUTHOR` regex latched-acl.ts:3, design triple uses the same hex author).

Issuance-frontier pairs `[author, seq|null]` alone: 4,544 / 9,090 / 18,177 / 72,705 B at 64/128/256/1,024; the v1 record (envelope ≈1.3 KB, tests/protocol-v3-creator-author-issuance-frontiers.test.ts:144 keeps 64 under 8,192) crosses its 8,192 ceiling just above ~96 pairs.

## 5. Everything else with a per-member / per-author dimension

1. **Creator close scan** (packages/node/src/creator-close.ts): `writeAuthorizedAuthors` :404-413 — N calls × O(N) copySnapshot each = O(N²) per close; per-author sequence reconstruction :487-556 — O(V) over `graph.authors` (every vertex identity) + O(N) frontier assembly; the frontier record build capped at 64 (creator-author-issuance-frontiers.ts:165) and 8,192 B (:12).
2. **Settlement frontier (design)**: one line per successor-ACL member of *every role* (design.md:87-89); the creator "scans every member's rows at each close" (design.md:153-165, `readSettlementSources` :444) — O(N × rows-above-terminalThrough). `frontierFor/frontierCount` accessors are design-only (design.md:119-123); grep confirms no code yet.
3. **Fence overhead (design)**: one `$drp.author-fence.v1` per author per open/adopt (design.md:56-66, fence section :127+). Against `maxEpochVertices = 8192`: 0.8% of the budget at N=64, 1.6% at 128, 12.5% at 1,024, and **impossible at 10,000** (fences alone exceed the epoch).
4. **Per-author lineage/issuance**: `DurableIssueScope {objectId, author}` + `readLineage` (packages/issuance-store/src/types.ts:26, :88); creator reads only its own lineage at close (node/creator-close.ts:504-509) — O(1) in N.
5. **v1 admitted-frontier aggregate**: author-authorization carrier ≤64 authors (index.ts:774), ≤8,192 B (index.ts:401); held per epoch as a Set (index.ts:1611) — O(1) lookups. Settlement-profile closures stop emitting it (design.md:177).
6. **Equivocation tracking**: per-author slot enumeration `enumerateCommittedAuthorSlots(author)` (protocol-v3/src/index.ts:1851), scope {author, slot} (:1805) — per-author storage rows, O(1) per access.
7. **Live-journal keys**: rows keyed (author, authorSequence) (packages/live-journal/src/types.ts:52-53, 70-71) — linear in traffic, not in roster size.
8. **Close-set/history proofs**: `deriveCloseSetHistoryCommitment` (node/creator-close.ts:874-882) is per-vertex, not per-member — no N dimension beyond V.
9. **Close trust scan**: every blob ≤ `SCANNABLE_BYTES` is fetched and fed to `inspectTrustClosure` (node/creator-close.ts:615-626); the predecessor ACL must be found among these candidates (:464) — an ACL/frontier/checkpoint blob > 8,192 B is skipped at :620 and the close **throws** ("predecessor proof is unavailable", :466).

## 6. What breaks if the caps are simply raised to 128 / 256 / 1,024

Constants that must move together (any one missed = fail-closed room brick):
1. latched-acl.ts:219 `maxItems: 512` → needs ≥ 25+16·N (writer) / 25+22·N (full): 128→~2,850; 256→~5,660; 1,024→~22,550. **Binding today; must be fixed even to reach the advertised 64.**
2. latched-acl.ts:16 `MAX_CANONICAL_BYTES = 8192` → 128 full-shape needs ~26 KB; 1,024 needs ~204 KB.
3. latched-acl.ts:134 member cap literal.
4. node/creator-close.ts:69 `SCANNABLE_BYTES = 8192` → else the grown ACL/frontier blobs silently vanish from the close scan (:620) and close throws (:466). Raising it widens the byte volume of *every* close scan for all rooms.
5. creator-author-issuance-frontiers.ts:165 (64) and :12 (8,192 B) — crosses at ~96 pairs.
6. index.ts:774 (64) and :401 (8,192 B) if the v1 author-list path must match (or is retired per design.md:177).
7. Settlement checkpoint (design): 8,192 ceiling explicitly frozen (design.md:125); fits ~93 members → 128+ requires a new checkpoint version or the map-backed carrier the design defers to `D.110c-0c1k`.
8. examples/v3-room/src/index.ts:1352-1355, :1392 — independent `maxItems: 512` decode of the same ACL bytes.

Tests that break or must be extended: tests/protocol-v3-current-epoch-author-authorization-p6-red.test.ts:394 (65-author rejection) if the v1 cap moves; tests/protocol-v3-creator-author-issuance-frontiers.test.ts:144-145, :270 (8,192 pins); the design's f5b0a slice pins the 64-member checkpoint shape + over-limit rejections as executable vectors (design.md:124-126). The 64-member ACL cap itself has **no test pin** — cheap to change; the decode-limit lattice is the expensive part.

O(N)/O(N²) paths that go hot: per-vertex auth O(V·N) with full-snapshot copy per call (latched-acl.ts:279-290 + v3-live.ts:4040/7047) — at N=1,024, V=8,192 this is ~8.4M member validations + 8,192 copies of a 1,024-member structure per epoch fold per peer; acl-op staging O(k²·N) (v3-live.ts:3496-3508); close `writeAuthorizedAuthors` O(N²) (node/creator-close.ts:404-413). None is architecturally fatal at 128; at 1,024 the per-vertex copySnapshot is the dominant CPU/GC hazard and wants a one-time Set/Map projection instead (the v1 author-list path at index.ts:1611 is the in-repo precedent).

Per-peer per-epoch bytes after a raise (writer-only): ACL bytes 13.9 KB (128) / 110.7 KB (1,024) held as blob + inside every epoch snapshot + decoded in memory; creator additionally carries frontier record ~10.4 KB (128, needs its ceiling raised) and settlement checkpoint ~10.8 KB (128).

Compatibility: the caps are **not genesis-bound** — they are global codec constants, so a raised-cap peer and an old peer disagree on the validity of the same bytes: the old peer's `openCanonicalLatchedAclSnapshot` returns `malformed-input`/`snapshot-mismatch` (latched-acl.ts:203-235) and it can never adopt the successor epoch. The ACL snapshot already carries `version: 1|2` (latched-acl.ts:124-131) — a `version: 3` with larger limits is the natural compat lever and old peers fail closed on it cleanly; the anchor format is unaffected (digest-only binding, index.ts:453). The trust profile `creator-trusted-v1` is pinned at creator-checkpoint.ts:146-147 (quorum 1) and index.ts:391 and does not itself constrain member count. The settlement checkpoint is version-carrying (`version: 1`, design.md:70-84) and its ceiling is design-frozen, so >~93 members forces a checkpoint version bump regardless of what the ACL does. Conclusion: **a raise to 128 is mechanically cheap in code (no named constants, one weak test pin) but requires a coordinated ACL snapshot version (or genesis-bound profile parameter) plus a settlement-checkpoint version bump; a raise to 1,024 additionally hits the O(V·N) per-vertex copy path, ~110-204 KB ACL bytes replicated into every epoch snapshot, 12.5% fence burn of the epoch budget, and the SCANNABLE_BYTES close-scan model — not cheap.**

## Scaling hazards ranked

- **P0** latched-acl.ts:219 `maxItems: 512` — real cap is 30/22 members today, below the advertised 64; plus the stage/open asymmetry (no cap on staged successor, latched-acl.ts:376-451) that lets an admin grow the ACL past openability and brick close/adoption (node/creator-close.ts:437-441).
- **P0** 8,192-byte ceilings as a lattice (latched-acl.ts:16; creator-author-issuance-frontiers.ts:12; settlement design.md:72,125; node/creator-close.ts:69) — four independent ceilings cross between N=74 and N=96; every one fails closed, one of them (SCANNABLE_BYTES skip at :620) fails by silent omission then throw.
- **P1** per-vertex authorization O(V·N) with full snapshot re-validation/copy per call (latched-acl.ts:279-290; v3-live.ts:4040, 7047) — GC-hostile at N≥256, needs a per-epoch Set projection before any large raise.
- **P1** settlement frontier = one line per member of every role (design.md:87-89) — couples roster size, not writer activity, to the checkpoint; ~93-member hard fit under the frozen ceiling.
- **P2** fence-per-author epoch burn (design.md:56-66) — 12.5% of an 8,192-vertex epoch at N=1,024; impossible at 10,000.
- **P2** close-time O(N²) `writeAuthorizedAuthors` (node/creator-close.ts:404-413) and O(k²·N) acl staging (v3-live.ts:3496-3508).
- **P3** per-author storage keys (issuance-store/types.ts:26,88; live-journal/types.ts:52-53; equivocation index.ts:1851) — linear rows, O(1) access; not a raise blocker.
