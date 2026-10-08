# D.110c-0c1f5b0d reclamation GREEN

This evidence records the production GREEN at signed and pushed commit
`1063feca39d60d24972ee101ab4051b4c1a23bb9`, based on the accepted signed
tests-only RED `9ab5924a34faf9cd1e0f42b79026ef5313318da8`.

The GREEN adds one storage-neutral authenticated settled-prefix reclamation
operation to the existing private issuance maintenance surface. Memory,
IndexedDB, and SQLite now refuse reclamation unless the durable settlement
plan has a fence and every non-expiring entry is linked without manual review.
Once admitted, the operation atomically compares lineage and the prior
watermark, deletes any mixture of pending or published rows across old epochs,
and advances the monotone watermark. SQLite's injected mid-delete failure
continues to roll back both row tables and the watermark.

The ordinary eight-method issuance facade is unchanged. Maintenance remains
identity-bound: each backend's public maintenance resolver retains its own
exact-facade `WeakMap`; the cross-package runtime registry is a frozen closure,
accepts only its first binding for an exact facade, and exposes no raw map that
could replace an established owner. Filtered recovery facades alias the
already-bound backing-store capability, so the backend implementation remains
the sole mutation owner.

The settlement-profile runtime reclamation owner verifies the durable pruning
receipt against the exact registered successor and replays the authenticated
operation only after the existing cleanup receipt path has established
adoption, rollback, availability, outbox, and expected-head facts. Recovery's
historical issuance census is bounded to the active plus two rollback
generations (`3 * maxEpochVertices`) instead of one raw epoch.

Focused GREEN passed 21/21. The core retained set passed 124/124, the broader
settlement/recovery set passed 112/112, the real browser retained suite passed
4/4, and a detached clean checkout with an offline frozen install and freshly
built transitive package closure passed 21/21 focused and 124/124 retained.

No accepted-design stop rule fired. This slice changes no wire envelope,
protobuf, cryptography, dependency, lockfile, storage schema, threshold,
authority semantics, ordinary product API, or `creator-trusted-v1` behavior.
