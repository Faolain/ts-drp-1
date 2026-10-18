# Storage substrate decision v1

Chosen: idb-strict

Decision JSON SHA-256: fc14fcde6aa4032fcb883a967a63b4af0ac522fb9030f120b49d14374c7ea901
Strict IDB SHA-256: 7f76bb252a3d3f7347c02ea49f418c10a5e26c56dad3f6f510d526b71f21e80f
Measurement SHA-256: 68a9a5d91d277ec909ebe1171a3a87c3b4975ee12566c86689f6cae1ed7aff85
Clear control SHA-256: 2b7be12a9ab4cbf8eca0f4c6b293a83b0ce29a24a9fb9df54dfc2ee21f435786

The decision is correctness-only for the generation/blob/pointer-swap workload. Raw asymmetric S2 timing is not scored.
IDB strict is selected for the measured scope because its live strict capability and the 2d/5c strict transaction boundary are directly compatible; this does not establish crash, multi-tab, custody, pressure-eviction, vote-parity, anti-equivocation, or golden-path behavior.
