You are the expressly authorized one-off Fable 5.1/high read-only research sidecar for ts-drp D.110c-0b0b. Do not modify any repository file, create commits, invoke subagents/workflows, or run long tests/campaigns. Work independently and report evidence-backed architecture guidance; your result is advisory and does not replace the governing Grok/Kimi/Opus review.

Repository: /Users/aristotle/Documents/Projects/ts-drp-1
Primary local plan: docs/production-hardening/production-hardening-tdd-plan-v2.md

Task: perform the same bounded Hedera/Hiero comparative architecture audit requested for the existing D.110c-0b trust-checkpoint/control-proof decision, prospectively and without reopening completed D.110c evidence.

Inspect current primary upstream material and pin the exact revisions actually inspected:

- HIP-1200: https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-1200.md
- exact-weight TSS: https://github.com/hiero-ledger/hiero-consensus-node/blob/main/hedera-node/docs/exact-weight-tss.md
- relevant current production implementations and tests for HistoryService, WRAPS, roster transition/handoff, block/state proofs, signed state, reconnect/bootstrap, and obsolete-state purging.

Distinguish proposal/planned behavior from implemented and tested behavior. Map carefully, without conflating systems: Ledger ID/genesis roster hash to pinned room genesis anchor; evolving roster to evolving room ACL/authority; roster transition to authenticated epoch close/adoption; threshold signature to cut/QC; WRAPS proof to a possible compact authority-lineage proof; signed/current state to an authenticated room checkpoint; block/mirror history to archived room epochs/messages.

Determine exactly what Hiero's recursive proof establishes: authentication of current verification key/roster from genesis, incorporation of transitions, what is constant-size or age-independent, retained state, purge conditions, bootstrap/reconnect/handoff/rotation fail-closed behavior, and trust/setup/availability/external-storage assumptions.

Compare these candidate families against ts-drp's actual current code and accepted plan:

1. stable genesis/root authority signs current checkpoints;
2. periodically certified checkpoint with explicit external pin;
3. recursively accumulated transition proof comparable to WRAPS;
4. logarithmic Merkle/skip consistency proof;
5. the simplest construction already supported by ts-drp's anchors, creator signature, QC, RFC 9162 history root, and authority model.

For each, provide a decision matrix covering authentication from pinned genesis; evolving ACL support; proof and active-state growth; prover/update/verifier cost; browser/TypeScript feasibility; dependencies/setup; wire/schema/public-contract impact; restart with untrusted storage; rollback/availability; archive separation; migration; replay/substitution/equivocation/skipped-epoch/stale-checkpoint resistance; and safe pruning.

Non-negotiable constraints:

- A checkpoint from untrusted storage is not trusted merely because it has a hash or self-signature.
- Current epoch, anchor, authority/ACL, history root/size, and recovery state must authenticate from pinned genesis.
- Ordinary cold reopen must not retain/replay O(N) cut/QC or transition evidence or hide equivalent required control growth in an archive/metadata/bootstrap store.
- Historical application/archive bytes may grow separately but are explicitly accounted and not required as active control state.
- Prune only after a replacement checkpoint is durably/authentically established while rollback and availability remain safe.
- Do not weaken bounded durable census or age-independent cold reopen.
- Do not propose blockchain-wide consensus, cryptocurrency, mining, or a global ledger.
- Treat Hiero as reference, not a preselected dependency. Do not silently select WRAPS/SNARKs/BLS/hinTS/setup/wire/API/new-authority/migration changes.

Current local context matters. Inspect the latest D.110c, D.110c-0b, D.110c-0b0, D.110c-0b0a, and D.110c-0b1 plan text and the relevant creator seal/close/adoption/reopen/trust/history/storage owners. Preserve completed results. Note that prior accepted reasoning currently favors a bounded creator-signed dual-anchor/current-trust checkpoint plus an external authenticated freshness floor, with WRAPS viewed as disproportionate for a fixed creator signer; verify or challenge that conclusion from current primary sources and current local code rather than assuming it.

Return a concise but substantive report with:

- inspected upstream commit hashes/paths and proposal-vs-implementation status;
- exact transferable proof obligations and non-transferable assumptions;
- the full candidate decision matrix;
- recommended D.110c-0b0b decision (or explicit more-design-needed verdict);
- exact security assumptions and compatibility boundary;
- any required prerequisite slice if dependencies/wire/API/authority/setup/migration would change;
- concrete RED/GREEN/adversarial/retained gates and relationship to D.110c-0b0, 0b1, D.110c-c/d, the >=100 same-room transition gate, and Phase 7 cold join;
- findings classified P0/P1/P2, and a final `D110C_0B0B_DESIGN_READY: YES|NO`.

Disclose the substantive model, effort, whether any subagents were spawned, whether any permissions were denied, repository HEAD inspected, and whether repository files changed.
