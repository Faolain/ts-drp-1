# Shared research brief — D.110c epoch-to-epoch author settlement

Repository: /Users/aristotle/Documents/Projects/ts-drp-1 (pnpm monorepo, branch `codex/phase3a1b-p6-golden-path`).
You are a READ-ONLY research agent. Do NOT edit files under the repo, do NOT run test campaigns, do NOT commit. You may run `grep`, `cat`, `sed -n`, `git log/show`, `node -e` quick measurements, and read anything. Write your final report to the scratchpad path given in your task prompt AND return it as your final message.

## The problem (golden path)

A room must stay alive for years across repeated epoch rotations (epoch 0 → 1 → 2 → …) with bounded control state and cold reopen cost independent of room age. Each author signs vertices with a never-resetting per-author `authorSequence`. When an author's operation is delayed/displaced across an epoch close, the creator (fixed room creator key signs each epoch's checkpoint; trust profile `creator-trusted-v1`) cannot advance that author's "everything through N is resolved" frontier without an authenticated statement of what happened to the gap. Without it: keep evidence forever (unbounded) or skip without proof (lost work / replay / wrong op).

## The selected design (drafted, NOT yet re-reviewed, NOT implemented)

Read these two files fully first:
- `.logs/d110c-0c1f5b0-design-00a860ab/design.md` — settlement carrier + creator checkpoint + recovery + pruning + slices.
- `.logs/d110c-0c1f5b0p-design-e6a67013/design.md` and `audit.md` — the identity-history prerequisite: a creator-authenticated Merkle AVL dictionary of *currently retired* author keys (root/count bound into the checkpoint), plus a genesis-bound sibling profile `creator-trusted-settlement-v1`.
- `.logs/d110c-0c1f5b0-plan-review-fc4b8fc7/review.md` — the review that blocked the first version (Grok 2×P1, Opus 2×P0 + 5×P1, Kimi approved) and the disposition of each.

Summary of the selected design:
1. Author-signed settlement control vertex `$drp.author-settlement.v1` inside the existing v3 vertex envelope (same Ed25519 signature, same domain `ts-drp/vertex/v3`). It carries per-source dispositions: `expire | already-present | rebase | transform`, plus `settlement-control` (supersede an older control vertex) and `zero-intent` (join/causalJoin/acl slots). ≤8 sources / ≤8 intents / ≤8 replacement refs, ≤8,192 canonical bytes (max shape measured 6,003 B).
2. Creator-signed checkpoint `drp-creator-author-settlement-state` v1 with per-member `[author, admittedThrough, settledThrough]` (≤64 members), `retiredAuthorRegistryRoot/Size`, bound to genesis/anchors/ACLs/cut/QC/history root/snapshot. Max shape measured 7,064 B under 8,192 B ceiling.
3. Settlement vertices never enter the application reducer; Node splits close-graph custody into application ⊔ settlement subsets.
4. Terminal rule: any same-author issuance row at or below `settledThrough` is terminal (never republished/rebased/applied).
5. `pruneAuthenticatedSettledPrefix` storage contract prunes rows across multiple epochs after checkpoint adoption + rollback-generation + availability gates.
6. Same-key removal/re-entry: the retired-key Merkle AVL dictionary. Removed member → inserted with final boundaries; re-added → deleted from dictionary, boundaries restored; verified nonmembership is the only way a key starts with null boundaries/sequence zero. O(log R) proofs only on membership-changing creator close; ordinary reopen never reads the dictionary; explicit O(R) archive-tier backing.
7. No migration for existing `creator-trusted-v1` rooms; new profile only at genesis.

## Open questions the team still has

- Is the retired-key dictionary the right answer, or is there a simpler, equally safe construction with existing primitives (Ed25519, SHA-256, canonical encoding, RFC 9162 history) that keeps active checkpoint O(64) and cold reopen O(1) in room age? The team's own audit rejected: unbounded tombstones, lifetime-64 cap, caller-local watermark, RFC 9162 alone, `archiveIndexRoot` (not implemented), incarnation certificates ("changes never-resetting identity"), sparse Merkle, accumulators, WRAPS.
- Does anything in the actual code contradict the design's claims about owners/seams? Key owners: `packages/protocol-v3/src/{latched-acl,creator-close,creator-checkpoint,index}.ts`, `packages/compaction/src/history-commitment.ts`, `packages/issuance-store`, `packages/live-journal`, `packages/storage/src/{types.ts,internal/closure-verifier.ts}`, `packages/storage-browser/src/internal/ahe-reclamation.ts`, `packages/node`, `examples/v3-room/src/index.ts`. The plan is `docs/production-hardening/production-hardening-tdd-plan-v2.md` (huge; grep for `D.110c`, `f5b0`, `f5a`, `admitted frontier`, `rebase`, `displaced`).
- Can a single absent/malicious author ever block epoch rotation or cause unbounded growth?
- What exactly does "sequence reset" break, concretely, in this codebase (which consumers depend on `(author, sequence)` uniqueness across the room lifetime vs. within an epoch)?

## Prior-art the team already considered

Hiero/Hedera HIP-1200 WRAPS roster lineage; Cosmos/Tendermint light clients (weak subjectivity); dynamic BFT reconfiguration; authenticated maps (ICS-23); RFC 9162; dotted version vectors; accumulators/recursive proofs. Consider ALSO (not yet considered by the team): MLS (RFC 9420) epochs and leaf-index/generation semantics on remove/re-add; Matrix room upgrades/tombstones; Keybase team sigchains and per-user-per-team key generations; Yjs/Automerge actor-ID and "never reuse an actor id across incarnations" rules; Signal sender keys; Kafka/Raft membership-change and log compaction with producer epochs/idempotent producer IDs (producer epoch fencing!); TLA+/Paxos "ballot" fencing.

## Output contract

Your report must be concrete and evidence-backed: cite `file:line` for every code claim; cite the section for every design claim. Rank findings by severity (P0 = design is unsafe/unsound or unimplementable as written; P1 = must change before RED; P2 = should change; P3 = note). For each alternative you propose, state exactly which owners/files change, what it costs (bytes, proofs, storage, migration), what it loses, and why it is or isn't better than the selected design. Do not pad. Do not restate the brief. Prefer a decisive recommendation over a survey.
