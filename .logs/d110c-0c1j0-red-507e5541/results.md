# D.110c-0c1j-0 RED result

- Completed: `2026-09-04T05:18:55Z`.
- Exact selection: one file, five tests; one compatibility control passed and four tests failed for the intended missing registry/genesis capability.
- The omitted-policy control preserved the exact 155-byte parameters carrier, digest `cd31923f2f1928daab3a6943fa361f7cf40516ba3c4929abbd3109ee65cdc669`, and pinned genesis anchor, then proved the registry has no `lineagePolicy` field.
- Explicit `fixed-creator` and the three reserved future modes reached the registry boundary and failed because the field is absent.
- Malformed vectors failed closed at the same unknown-field boundary; GREEN must refine present-key validation and pin `D110C_LINEAGE_POLICY_UNSUPPORTED` for room rejection of reserved modes.
- The old-binary compatibility control passed: an old decoder rejects a present lineage-policy key as unknown.
- Prettier, ESLint, the protocol-v2 and example-v3-room typechecks, `git diff --check`, and isolated focused execution passed.
- A whole composed package build encountered the inherited settlement-plan integration gap in `packages/node/src/v3-live.ts`; it did not affect this RED, its exact owner typechecks, or its causal classification.
- No missing import, missing export, module-resolution, syntax, or fixture-self-failure occurred.
- Scope/stop rules: no protocol-v3 or Node production change is implicated, and no new cryptography, envelope, or protobuf change is required by RED.
