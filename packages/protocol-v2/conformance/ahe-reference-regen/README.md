# Regenerated protocol-v2 oracle

This small, dependency-free ESM implementation was written from the frozen
registry-v5 artifacts. It is deliberately isolated from both the TypeScript
implementation and the historical `ahe-reference` tree.

The oracle exposes canonical encoding/decoding, domain-separated SHA-256
framing, and registry-driven preimage construction. Its content-addressed lock
also records the exact frozen inputs used for regeneration.
