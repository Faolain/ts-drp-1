# Gate67 existing issuance-store export additions

Gates59–66 pass181 assertions. Gate67 records10 total /9 passed /1 failed, exact file/title multiset, zero skips or suite errors. The failure at tests/phase-3a1b-p2-outbox-publication-contract.test.ts:574 expects30 root exports while runtime reports35. The preceding six-name conformance-module assertion passes.

Signed ea02487e9c80d25ab6e7038cdf35330b72f29de6 introduced five omitted exports through the unchanged root reexports: SETTLEMENT_REPLACEMENT_MAX_INTENTS, SETTLEMENT_REPLACEMENT_DIGEST_LIMITS (types.ts50–55), settlementReplacementLastLogicalTime (contract.ts244), assertSettlementPlanProgressTransition (546), and settlementPlanHasExactEffectLink (712). Latest signed contract changes also include9c1ec6c40b0af8999c22fa1bc9f1ad971e0e6b2e. None is in parent8patch; no new API was added in this continuation.

The later whole-file contract.ts hash assertion was NOT executed. Root's separate read-only hash audit finds its current2e2d160f7e59d643d01fb4d10e321c573ace252bef43040156ff26d92e837042 differs from expected49ac5a1d2b44f69a6becc3f3bcd4e44c2d4e178512a0d8489ae28766fa636cf7. The terminal.ts and index.ts hashes still match their pins. This is latent unexecuted debt, not another observed assertion failure. No export roster or hash pin was changed and no test rerun occurred.

Root confirmed both attribution and the latent pin, then authorized unchanged diagnostic continuation68 onward. Exact scope/disposition is still required before parent retained closure; no failures are waived.
