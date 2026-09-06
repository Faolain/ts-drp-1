# Blueprint operation byte-budget enforcement

This conformance layer turns the digest-bound `blueprint-work-budget-v1` declaration into an
admission and issuance boundary. The supplement remains the authority for the limit; this layer
does not introduce another digest, caller policy, or public export.

The meter is the byte length of the canonical encoding of the canonical-detached whole exact closed
operation record. The application discriminator is part of that record. JSON encodings, UTF-16 code
units, enclosing transport bytes, discriminator-free projections, and cooperative counters are not
equivalent meters.

Remote admission authenticates the exact received vertex bytes before matching the operation ABI,
then applies the operation budget before returning a decision that can authorize publication or
execution consumers. Local issuance snapshots through canonical detachment and applies the budget
before entering transaction, signing, issued-record, or outbox work.

Manifest schema 1 remains unbudgeted. Transport frame limits, reducer fuel, elapsed time, instruction
counts, collection-touch limits, live binding, and finality belong to their separate owners.
