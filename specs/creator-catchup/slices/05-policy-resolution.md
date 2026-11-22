# Durable decisions and independent current issuance

Use the existing room settlement-plan and issuance transaction owners to expose bounded pending work and source-bound resolution. The source identity includes object, author, sequence, digest, epoch and anchor, with the original signed operation available after restart. Native disposition labels are untrusted: a resolution must be rederived by trusted policy or reverified from authenticated decision evidence.

Unknown commitment permits continued review or explicit policy disposition. Retry needs authenticated noncommitment or application idempotency that survives compaction. Current issue must reserve its own finish capacity while old work retains its paid proof; current fences and `terminalThrough` cannot silently erase that custody. Audit ordinary admission, successor previews, settlement draining, close preparation and retirement together.

Verify useful current issue across multiple epochs with an older unresolved source, removal/re-admission, stable sequence identity, repeated resolution and exact replacement progress after real process death. The operation and plan effect use the existing atomic transaction. A committed source is never retryable merely because its effect no longer appears in a bounded projection.
