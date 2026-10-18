# Blueprint work budget v1

This additive protocol-v3 supplement extends the existing blueprint admission package without changing
its package `schemaVersion`, `protocolMajor`, digest domain, artifact identity, argument schemas, or the
frozen protocol registry. Existing manifest schema 1 remains valid and byte-for-byte unchanged.

Manifest schema 2 is a closed record with the existing `operationDiscriminator` and `operations` fields
plus `workBudgetProfile: "blueprint-work-budget-v1"`. Every operation declaration remains ordered by
unique operation name and is a closed record containing the existing `name` and `argumentSchema` plus
one required `maxCanonicalOperationBytes`. The limit is a positive safe integer. The operation and
argument-field ordering rules remain the existing locale-free code-point rules.

The digest preimage is the exact canonical whole blueprint package bytes. The existing
`blueprintDigest` is its domain-separated digest. Consequently the manifest schema, work-budget profile,
operation discriminator, complete operation identity and each `maxCanonicalOperationBytes` value are in
the digest preimage. There is no second budget digest, no digest fixed point and no detached caller
policy.

This governance slice defines representation and validation only. It does not measure an operation,
enforce a limit, decode or cap a transport frame, invoke a reducer or fold, transact, sign, publish,
select a runtime profile, bind a live anchor, classify finality, meter elapsed time or count
instructions. Phase 0p-2 owns measurement of the whole closed canonical operation record, including its
discriminator, after remote exact-byte authentication or from the local canonical-detached operation.

The frozen seven-field `parameters` kind is unchanged. In particular, this supplement does not add
`maxCanonicalOperationBytes` to `parameters`, does not add `maxEpochBytes`, and does not edit any
protocol-v2 registry, vector or reference artifact.
