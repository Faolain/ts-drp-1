# D.110c-0b Hiero primary-source refresh

Audit date: 2026-09-02.

This is a bounded primary-source refresh of the already accepted D.110c-0b comparative architecture audit. It neither reopens completed D.110c work nor authorizes production edits.

## Pinned upstream revisions

- `hiero-improvement-proposals`: commit `54ccb06659592ab201e7adea632f1019e9faa00e`, tree `42ff7d2c1ff68ef662b405cb167838849d1b49f1`, HIP-1200 blob `088088185786375a1478166bbd61c4021eedc85c`.
- `hiero-consensus-node`: current `main` commit `92ea3b0caff4e8106f87e7f5f4a84c0361634299`, tree `3c4337aa328fccf5ea31bd9a6d6f3c321cf646af`.

The exact History/WRAPS/roster-handoff/protobuf/test paths inspected at the prior consensus pin `1aa1d6c153907750cfbba6935b7a21867053968e` have no byte diff at the refreshed pin. `git diff --quiet 1aa1d6c... 92ea3b0c... -- <inspected paths>` returned status 0.

## Refreshed consensus blobs

- exact-weight TSS design: `c35cb34e6e797719fdb02f8541cb067f64e3972a`
- `HistoryLibrary`: `c4c998d06d611fe7ece9c62346fb6fad4c7a671c`
- `HistoryLibraryImpl`: `c53deacbffe3352a0dba74d46cc7ddf265f4ed6c`
- `WrapsHistoryProver`: `fc7c893b20b9246be8f2b814af7810500ce4fa2a`
- `WritableHistoryStoreImpl`: `589537503db6da008b876b540c37664cbb9665ba`
- `V071HistorySchema`: `0cb24998101688d3fe0f09986cceea780fd213d4`
- `TssHandoffCoordinator`: `8ca7f9a87c853663add1bfb194b6017a80c6a2ff`
- `WrapsProvingKeyVerification`: `e15e6c352a085d3d44b3ac433712b6dfcc070647`
- `history_types.proto`: `5b4d59d4002426af096423af879390f883eda1ff`
- `WritableHistoryStoreImplTest`: `83aeacf8c2fd63a72dc562a35c3230a986503323`
- `WrapsHandoffsTest`: `2bc10375d75d7f635a62d78643169324f65b8dfe`
- `HederaReconnectTssControllerResetTest`: `d879a43f01e46a6a62545dcf475de468a146bf32`
- `DefaultSignedStateValidatorTests`: `efed3cb84371a70228a95fde85c9e4672033a0ea`

## Disposition

The refresh leaves the accepted decision unchanged. Hiero remains a close design reference for genesis-rooted, compact authority lineage and handoff-gated purge, but not a selected dependency or architecture for per-room `creator-trusted-v1`. D.110c-0b retains the bounded dual-anchor creator checkpoint with an authenticated caller-held freshness floor and fixed rollback window. WRAPS/SNARKs, TSS/BLS, setup artifacts, new wire fields, external checkpoint services, and rotating authority remain explicit high-risk prerequisites rather than implicit implementation work.
