# Gate40 registry byte pin

Gates33–39 passed all70 assertions. Gate40 records13 total /12 passed /1 failed, exact file/name multiset, zero skips or suite errors. The failure at tests/phase-3a1b-p4-live-journal-parity-governance-red.test.ts:660 compares registry-v1.json SHA-256 against the old 2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9. The actual signed-W0 registry SHA is 663281a11da08d99e4a751ed3f439c1562a49d3b70ab21b34de50959bf47c190. The preceding checks that local journal domains are absent from both protocol registries pass.

This is an additional pin in the existing registry-freeze family documented with exact signed W0 diff and hashes in retained-30-attribution.json. No parent8 production owner, test, registry or checker changed. The complete raw reporter preserves the actual mismatch. No gate41 execution occurred before root disposition; no hash/expectation edit or rerun is authorized.
