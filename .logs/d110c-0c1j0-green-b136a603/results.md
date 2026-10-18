# D.110c-0c1j-0 GREEN result

- Completed: `2026-09-04T05:37:51Z`.
- Focused lineage-policy selection: one file, five tests; 5/5 passed.
- Retained protocol-v2 registry/golden selection: 33/33 passed. The separate coverage semantic gate passed 1/1.
- The optional `parameters.lineagePolicy` registry field validates the exact four-key grammar. An omitted key retains the pre-existing canonical bytes, digest, registry-preimage digest, and genesis anchor exactly.
- Explicit `fixed-creator` binds a distinct parameters digest into genesis and is accepted by both v3-room material creation and invite consumption. The three reserved future modes remain codec-valid and are rejected at both room boundaries with `D110C_LINEAGE_POLICY_UNSUPPORTED`.
- Malformed mode, maximum, upgrade, and key-identifier values fail closed. Old-binary present-key rejection remains pinned.
- Registry version remains 5. The added explicit-present golden/coverage vector does not mutate the legacy absent-policy vector; the golden harness now correctly requires every required field while separately exercising optional-field coverage.
- Protocol-v2 and v3-room build/typecheck passed; grid and v3-chat builds passed; v3-chat typecheck passed; exact-owner lint, format, JSON, diff, and signature gates passed.
- The inherited grid `roomHeadAuthority` fixture/type mismatch remains outside this slice and was not altered.
- Deferred compatibility obligations owned by D.110c-0c1j proper: the historical protocol-v2 registry freeze must be dispositioned when a migration boundary is selected, and Node's current seven-field `acceptedParameterDigest` cannot consume explicit-present parameters until the separately scoped Node/authority integration. This slice makes no live-Node acceptance claim and changes no protocol-v3 or Node source.
