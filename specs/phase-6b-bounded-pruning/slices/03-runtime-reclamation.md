# D.109d — Runtime Structure Reclamation

Consume matching issuance and AHE receipts in the installed v3 runtime. Recheck
object/epoch/head identities, then reclaim only closed-epoch graph payloads,
`forwardEdges`, `frontier`, `vertexDistances`, causality caches, state snapshots,
checkpoints, pending indexes, and sync inventories. Preserve the root, active
tail, canonical live state, authenticated known-hash inventory, and all legacy
finality state until Phase 6d.

RED compares an archival writer with a receipt-authorized compacted writer,
tests stale/missing/mismatched receipts, injects raw dependency probes, and
rolls back any in-memory failure without half-pruned indexes. GREEN adds one
internal reclamation method; it does not create user-selected pruning authority.
