# Blueprint numeric-determinism successor

This one-time successor resolves the Phase 0n package-manifest freeze without
weakening numeric determinism. It preserves the complete v1 inventory, permits
one signed four-owner-plus-workflow bootstrap, and thereafter requires the base
and current successor checkers in the same workflow job.

The successor governs only the durable package semantics: the numeric
supplement remains packed, deterministic-math runtime dependencies and exports
remain forbidden, and the Phase 4a blueprint-application export and errors
dependency must either both be absent before the product transition or both
match their specified values afterward. Unrelated manifest evolution is not
hash-frozen.
