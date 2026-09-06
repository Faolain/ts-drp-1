# Peer note on selectable authority-lineage profiles (received 2026-09-03, condensed verbatim)

The important variable is not only wall-clock lifetime, but how many times the room's controlling authority changes.

## Short-lived FPS rooms
A 20-60 minute match: genesis/host A -> host migration to B -> match ends. The signed transition chain is tiny; no value in a recursive proof. Still needs: authenticate initial identity; prevent a fake snapshot; authenticate host migration; reject conflicting successors; preserve reconnect state. No unbounded-history problem; control state archived/deleted by policy at match end.

## Long-lived chat rooms and MMORPG worlds
Thousands of epoch rotations; many owners/moderators; authority-key rotation; participants leaving and returning; archival pruning; devices offline for years; recovery after every previous controller has disappeared. Authority-lineage compaction is essential: a new client must establish the current world descends from genesis without trusting the snapshot server.

Nuance: ordinary player joins should not count as authority changes. Authority membership and application membership should remain separate.

## Shared architecture with selectable trust profiles
One common checkpoint format with interchangeable authority-proof policies:

    Authenticated checkpoint
    ├── epoch
    ├── current authority/ACL
    ├── current application-state root
    ├── author-state map root
    ├── archive-history root + size
    └── authority-lineage proof
          ├── signed transition chain
          ├── externally pinned checkpoint
          └── recursive proof

All rooms share snapshot rules, author-incarnation handling, authenticated author map, append-only archive history, settlement rules, epoch-transition semantics, make-before-break handoff. Only the final authority-lineage proof differs.

- Profile A, ephemeral chain (FPS): retain every authority-transition certificate; verify chain from genesis; maximum epoch/lifetime policy; expire/archive at room end. No new crypto.
- Profile B, durable managed room: periodically pin a checkpoint via a stable owner key, trusted directory, transparency service, or previously trusted device; retain only the chain since it. Light; guarantee depends on the external trust source.
- Profile C, durable sovereign room: only genesis pinned, no permanent creator, no external checkpoint, untrusted providers -> WRAPS-like recursive authority proof; proving only on authority change.

The policy is committed in genesis; a server must not downgrade a sovereign room.

## Transition chain storage
Compact certificate ~0.5-2 KB (previous checkpoint hash, new authority hash, epoch, roots, signatures/QC). 10 years at one transition/day ~ 1.8-7.3 MB. The real cost: a cold client verifies every transition sequentially (3,650 for ten daily years). Merkle trees / skip lists give O(log N) inclusion and seeking but cannot prove all N transitions were correctly authorized without exposing them; aggregating signatures still needs every changing key to be legitimate. Options remain: verify the linear chain; trust a later checkpoint; retain a stable root authority; recursively prove the chain.

## Start simple, enable WRAPS later
Possible with preparation: full chain available at conversion; recursive verifier/key authenticated by genesis; permitted upgrade committed in advance; discarded history cannot be reconstructed from a hash. Suggested blueprint field:

    lineagePolicy:
      mode: "ephemeral-chain"
      maximumEpochs: 256
      allowedUpgrade: "recursive-v1"
      recursiveVerificationKeyId: "protocol-wrapping-key-v1"

## WRAPS in a browser
Verification: feasible (HIP-1200 704-byte proof, Arkworks serialization; cross-library compatibility not yet established; would need WASM/JS verifier, pinned key, test vectors, Web Worker). No official Hiero WRAPS browser package found. Proving: heavy (large WASM, memory, proving params, workers, elected prover; untrusted proving service is fine for correctness, is an availability dependency). WebGPU optional accelerator for the prover only; consensus must never depend on GPU arithmetic.

## Recommendation
One protocol, three selectable lineage policies: ephemeral-chain (FPS), durable-pinned (managed chat/MMORPG), durable-recursive (genesis-only sovereign). Explicit and authenticated at genesis. Keep the Merkle author map and RFC 9162 archive history in all profiles. For recursive rooms one elected peer/service proves at rollover; all browsers verify. The current transition-chain implementation is a useful foundation but cannot by itself close the strict age-independent, genesis-only golden path.
