# D.110c-0c1f2 RED diagnostic ledger

The first protocol execution stopped before the frozen token because the test incorrectly expected received journal rows to expose top-level author and sequence fields. Received rows instead retain authenticated canonical preimage bytes and a vertex digest. The correction decodes the already-authenticated preimage and correlates its digest; no production source changed.

The first browser execution stopped during epoch-1-to-2 activation with the generic `D110C_B_ACTIVATION_STALLED`. One bounded tests-only observation exposed the underlying result as `recovery-rejected: creator predecessor recovery failed: issuance-rejected`. Alice had no current-epoch locally issued row, so her predecessor recovery correctly found an empty local issued chain. Adding one ordinary Alice epoch-1 message alongside Bob's genuine epoch-1 message corrected the fixture precondition. The temporary activation-result observation was then removed.

The next browser execution reached epoch 3 but the legacy `exportSuccessor()` helper rejected multiple successor projections as ambiguous. A tests-only epoch-selecting exporter now composes the existing exact `rawAuthorityAtEpoch()` and `rawSnapshotDeclarationAtEpoch()` readers; it does not alter product behavior or durable bytes.

The final observation correction attached the refusal to displaced predecessor epoch 2, not current epoch 3. The captured trace showed Bob's exact epoch-1 digest examined at epoch 3 and rejected by `predecessor-validation` at epoch 2. The final browser RED then reached only the frozen token.

These stopped diagnostics are not accepted RED evidence, are not product failures, and are not omitted or reclassified as passes. The accepted causal executions are the two `*.final.txt` records in this root.
