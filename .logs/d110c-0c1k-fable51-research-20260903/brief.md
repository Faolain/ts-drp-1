# Shared brief — supporting more than 64 writers per room (ts-drp protocol-v3)

Repo: /Users/aristotle/Documents/Projects/ts-drp-1 (pnpm monorepo, branch codex/phase3a1b-p6-golden-path, HEAD 1f35c937).
You are a READ-ONLY research agent. Do NOT edit files under the repo, do NOT run test campaigns, do NOT commit, do NOT `cd` (use absolute paths / `git -C`). You may grep, read, `git log/show`, and run quick `node -e` byte measurements. Write your report to the scratchpad path in your task prompt AND return it as your final message.

## The constraint today (verified facts)

- A room's latched ACL (`packages/protocol-v3/src/latched-acl.ts`) is a per-epoch member list `{author, finalityKey, groups}` with groups admin/finality/referee/writer, `permissionless` flag, cap of 64 members (`:133-134`), canonical byte ceiling 8,192 (`:334-336` area and the snapshot codec). Snapshot versions 1 and 2 exist.
- Authorization: `latched-acl.ts:336` — an operation is authorized only if the signer is a member AND (permissionless OR has writer group). Even permissionless rooms require membership. Readers/replicas do not need membership.
- Measured: 64 full-shape members (finality key + groups) encode to 12,888 bytes > 8,192; writer-only shape 7,064 bytes. So the real full-shape cap is below 64.
- Membership changes only at epoch close by the creator (creator-trusted-v1). Epoch ≤ 8,192 vertices / byte budget (AHE default).
- The plan (`docs/production-hardening/production-hardening-tdd-plan-v2.md`) Profile D (Discord channel) at ~line 18117 states "Active writers ≤ 128 per 5-min window", ≥1,000 online replicas; Profile M (MMORPG zone) 64 durable writers, stated decision; seamless single shard is a non-goal. The gap is recorded as plan record `###### D.110c-0c1k` (~line 97011); rotated closing authority is `###### D.110c-0c1j` (~line 96976).
- The just-accepted author-settlement design `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` (read it) carries a creator-signed checkpoint with one frontier line per successor-ACL member `[author, admissionEpoch, terminalThrough | null]`, ≤64 lines, under an 8,192-byte checkpoint ceiling; the creator scans every member's rows at each close; each author issues one `$drp.author-fence.v1` per open/adopt; `frontierFor/frontierCount` accessors were added so the frontier carrier could later become map-backed; `settlementProfileFor(profileId)` is the single profile predicate. Research behind it: `.logs/d110c-0c1f5b0-fable51-research-20260903/` (`plan-change.md`, `lineage-profiles-impact.md` §2.C and §4 discuss the 64-cap collision and the peer's "Merkle author map in all profiles" suggestion that was rejected *for now* as over-scoped at 64).

## The ask

The product needs rooms with more than 64 concurrent writers (chat channels at ≥128 distinct posters per 5 minutes at minimum; possibly hundreds to thousands; large FPS/MMORPG modes as secondary). Find the best construction that keeps: authorization cost per vertex bounded; per-epoch bytes bounded; cold join independent of room age; the settlement design's guarantees (per-author boundary, incarnation, fence, no author blocks a close); creator close cost bounded; 8,192-vertex epochs meaningful with N writers each issuing a fence.

Candidate directions to evaluate (add your own):
A. Raise the caps: bigger ACL byte ceiling and member cap (128/256/1024). What breaks, what it costs per epoch/per peer, does it scale to chat.
B. Map-backed ACL + map-backed settlement frontier (Merkle/authenticated map, root bound in anchor/checkpoint, proofs at authorization or at close). Who produces/stores proofs, verification cost per vertex, archive tier.
C. Two-tier membership: small durable role ACL (admin/finality/referee, ≤64) + a separate large writer set (a writer roster object, creator-signed writer tickets/certificates with expiry, or window-scoped writer admission). Settlement frontier lines only for writers active in the epoch, not all members.
D. Sharding: a channel as multiple objects/lanes; how writers map to lanes; what it does to ordering/UX.
E. Truly permissionless writers with per-author settlement lines only for authors that appeared in the epoch; incarnation/identity for a sparse set; Sybil and space-burn exposure.

For every option state: exact owners/files that change; byte and CPU costs at N = 128, 1,024, 10,000 writers (checkpoint bytes, per-vertex auth cost, close scan cost, fence overhead vs 8,192-vertex epoch); what the settlement design must change (frontier carrier, scan, incarnation); migration/compat (genesis-bound profile? new snapshot version?); what is lost; and rank. Cite file:line for every code claim and section for every design claim. Prefer a decisive recommendation to a survey.
