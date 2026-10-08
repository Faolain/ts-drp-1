# D.110c-0c1a high-risk authority-design plan review

Act as a read-only senior distributed-systems and security reviewer. Do not edit
files, run tests or campaigns, invoke D.110a, or spawn subagents. Review the
signed and pushed plan-only commit
`fc384d1fe3d503bb9e3706e97bf62bea39fe8a7c` (tree
`96b29a8f366b2c7ec3243c2fa5627610b28acd5e`, parent
`d6f5de263c5d0bcabe4df25532a0a8d3dcf0ccbd`) on
`origin/codex/phase3a1b-p6-golden-path`.

Read completely:

- the `D.110c-0c1a creator-signed issuance-retirement checkpoint prerequisite`
  subsection in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- every file in `.logs/d110c-0c1-architecture-audit-d6f5de26/`;
- the exact current production owners cited by that audit, including the
  creator issuance-store filter, v3 live recovery, creator checkpoint trust,
  keychain/finality signer dispatch, AHE closure ownership, creator close and
  adoption, RFC 9162 history, durable issuance store, and pruning owners; and
- the retained tests and fixtures named by the plan where needed to assess
  feasibility and compatibility.

The demonstrated problem is narrow: after a genuine same-room 0→1→2→3
lifecycle, recovery at epoch 3 rejects a valid published epoch-1 issuance row
because current control state authenticates only genesis and current/immediate
predecessor authority. A local database watermark, claimed old anchor, row
self-signature, RFC 9162 history root, or retained O(N) cut/QC chain is not an
acceptable substitute for an authenticated age-independent resolution proof.

Review these exact questions:

1. Does the source audit correctly establish that current product data cannot
   authenticate arbitrary intermediate issued rows age-independently, and that
   no existing authenticated per-author resolved-sequence frontier was missed?
2. Is the selected creator-signed cumulative issuance-retirement checkpoint a
   sound authority carrier under the explicitly creator-only compatibility
   boundary? It must be rooted in the pinned genesis creator finality key, bind
   room/genesis/author identity, current and successor epoch/anchor, cut/QC,
   snapshot manifest, prior checkpoint digest, previous/new inclusive sequence
   boundaries, and exact lineage exhaustion/next state.
3. Does that exact binding and monotonic predecessor relation resist stale,
   replayed, substituted, forked, skipped-boundary, cross-room, cross-author,
   and equivocated checkpoints without trusting untrusted storage?
4. Is one replaceable AHE closure candidate sufficient and safely
   authenticated, or must this instead change Cut/anchor schema, add another
   product/public API, dependency, or authority carrier? Account for the fact
   that the AHE item is independently creator-finality-signed and explicitly
   binds the authenticated room floor rather than being trusted merely as a
   local AHE head.
5. Is the minting moment implementable without circularity or crash ambiguity?
   Check that the creator can derive a dense boundary only after the real close
   graph, issued/outbox rows, publication state, sealed replay, cut/QC, snapshot
   manifest, and successor anchor are known, then preserve the pending candidate
   across restart and replace its predecessor with no third live copy.
6. Is the boundary derivation (`lineage.exhausted ? lineage.next :
lineage.next - 1`) safe for empty, partial, and exhausted lineages? Must every
   newly retired address be proven by exact issued/outbox equality, canonical
   vertex, valid author signature, room/anchor/epoch identity, publication,
   close-graph membership, and sealed durable replay as frozen?
7. At later recovery, can the signed checkpoint legitimately authorize an old
   address while the recovered row is still checked for exact address,
   canonical bytes, object/author/sequence identity, signature, issued/outbox
   equality, and published state—without retaining the old anchor/QC chain?
   Identify any missing proof needed to prevent fabricated or unresolved old
   rows from being accepted.
8. Is compatibility honest and fail closed: fresh rooms initialize at genuine
   0→1; inherited epoch≥1 rooms without the new checkpoint cannot silently
   synthesize history and require an explicit migration; rotating authority or
   independent non-creator cold reopen remains a separate high-risk design?
9. Is RED causal and feasible through the real product close path? The treatment
   must have all product-shaped close inputs yet zero retirement candidates and
   fail exactly with
   `D110C_0C1A_RETIREMENT_CHECKPOINT_UNAVAILABLE`; a second product-shaped
   control must prove the missing carrier rather than a fixture shortcut.
10. Does the slice preserve scope? GREEN adds only the signed control record,
    opener/opaque capability, protocol-owned signing request, close derivation,
    and AHE lifecycle. It must not yet change recovery filtering, prune data,
    modify issuance-store schema/API, alter Cut/anchor/wire public contracts,
    add dependencies, or weaken retained behavior. D.110c-0c1 consumes the
    carrier later and D.110c-c still owns physical pruning/census.
11. Are the named adversarial and retained gates sufficient to prove canonical
    signing, exact-one candidate custody, crash/reopen behavior, monotonicity,
    signature/finality separation, provenance, and no O(N) control growth?
12. Report every P0/P1 with the smallest exact correction. P2 observations are
    nonblocking but must have a concrete disposition.

Only P0/P1 findings block RED. Return exactly one JSON object matching the
provided schema, with no prose before or after it.
