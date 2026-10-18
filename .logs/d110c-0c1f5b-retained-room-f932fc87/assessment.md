# Parent f5b retained room-carrier correction — stopped

Tests-only commit `f932fc87cab77e22b2d3994b8af288e9e491547a` is signed G and pushed. It implements the exact three-span scope authorized at signed `29e26b3f93e215f66201bfd5a71e7b2f334c164d`: add existing hashDomain to the canonical import; replace invite() inner one-byte placeholders with full canonical records and explicit mocked-trust caveat; independently encode the exact forwarded ACL expectation. Test SHA-256 is `22e809bf725bebb2c3f85642ae3c9857fcc90c218ed1e9886ffe8cf903276d2f`.

**The sole isolated run did not meet the frozen expected 20-pass matrix. It stopped with 20 total / 2 passed / 18 failed / 0 skipped. No test, mock, production source or configuration was edited after the run, and no runtime rerun occurred.**

## Authorized correction and limits

The helper now carries all seven registered legacy numeric parameters (including the unchanged 8,192 maxEpochVertices bound), complete creator-trusted-v1 profile, single-entry signer set, version-1 ACL, and 16-key genesis record. Object/blueprint identities agree, inner-carrier digests use their existing domains, empty roots use SHA-256 of empty bytes, and state digest binds the controlled source/target marker. No empty/scalar parameters bypass, unregistered lineagePolicy field, loose subset check, or production/authentication guard change was introduced.

The a/b pinned anchor markers, detached signature markers, author-local identity and all seven mock factories remain unchanged. These are controlled composition records, not authenticated genesis proof or a golden-path claim. The valid hex creator in the decoded ACL supplies the required carrier shape without replacing the mocked application author.

AST masking proves every byte outside the three authorized spans unchanged, including all 20 titles and every other assertion, helper, mock, timeout, 16/17 batching threshold, 8,192-row case and projection rejection case. The first ACL expectation remains an independently authored exact byte comparison. Root independently verified the signed diff and outside-span equality. The earlier source audit found the inner-carrier requirements but missed the existing mock module-identity mismatch described below; its hypothesis that three spans would suffice was not confirmed by runtime.

## Independent checkout and exact one-run result

Fresh isolated checkout: `/tmp/d110c-f5b-retained-room-hsBT3J/checkout`, detached at the signed/pushed tests commit. Independent frozen offline installation completed without downloads, followed by the complete source build. There was no pending parent patch, copied dist, shared main node_modules, alternate Vite configuration, or main-workspace runtime. Node v22.15.0 and pnpm 10.24.0 are recorded. Before/after isolated source/runtime hashes and clean tracked status agree.

Exact 20-case collection matched the existing retained gate-10 file/title multiset. Frozen matrix SHA-256: `ce1df5c72afbec4d41591056acb8d428d5d7b18c9d3d914db839bdb85f052df1`. The command runs only tests/phase-3g-v3-room-rebase-red.test.ts, without name filtering, with --no-file-parallelism --coverage.enabled=false --reporter=json and the fresh reporter path. The original expected matrix and one-shot guard remain unchanged.

Actual Vitest status: 1, signal null, success false; one exact file, 20 outcomes, two passed, eighteen failed, zero skips. The guard returns 2 with UNEXPECTED_MATRIX_STOP_NO_RERUN. No suite messages, testExecError, unhandled errors, loader failure or timeout occurred; stderr is empty. Complete raw focused.json, stdout/stderr, exact names, durations and full failure stacks are retained. Raw reporter SHA-256: `ec73333a06bc187ca4fe452ec8f623eb817982c3ac40ee0e7fdc1b48f089d76d`.

Sixteen cases directly fail with `TypeError: v3 room preparation failed: trust-open-failed`. The inconsistent-issuance and wrong-readiness cases fail their unchanged expected-error assertions because they encounter that same preparation failure first. The two passing cases are the malformed displacement-policy evidence control and reserved terminal-activation policy control. All twenty outcomes are preserved individually in result.json; no scheduling, recovery, batching, publication or projection-success claim is made.

The old retained baseline at .logs/d110c-0c1f5b-green-ab98cce6/retained-10 remains immutable and was not rerun. Its prior 18 failures arose before this newly reached boundary from the malformed carrier. Equal aggregate counts do not mean equal causes.

## Newly reached failure attribution

The read-only actual Vite SSR resolver audit used resolveConfig/createResolver only, with no server, optimizer, module runner, fixture experiment, test or build. All seven existing mocks were resolved against their paired room imports. Five identities match. Two do not:

| Existing mock target | Room contract | Actual room resolution |
| --- | --- | --- |
| ../packages/node/dist/src/v3-live.js | @ts-drp/node/v3-live | packages/node/src/v3-live.ts |
| ../packages/protocol-v3/dist/src/public.js | @ts-drp/protocol-v3 | packages/protocol-v3/src/public.ts |

The control-plane bare mock does match. Consequently the real Node preparation implementation is reached, while control-plane open() returns the deliberately incomplete controlled value {ok:true, trust:{profileId:"creator-trusted-v1"}}. Real snapshotOpenedTrust requires the closed head/trust/trustRef record and rejects it, returning trust-open-failed before anchor authentication. The carrier guards now pass, but the intended controlled Node preparation boundary is not installed at the module actually imported.

mock-identity-attribution.json contains all seven resolved path pairs and source/runtime hashes. stopped-source-excerpts retains exact source excerpts; stopped validation captures the complete real Node preparation and trust-snapshot functions. No mock target was changed. The protocol mock mismatch is independently established by resolution but its issuer path was not reached, so no subsequent failure is asserted as observed.

This is a newly exposed fixture-boundary mismatch and an under-scoped three-span correction, not evidence of a production authentication regression. Root owns any later prospective authorization to align existing mock targets. Such a change and any new isolated run are outside this stopped run.

## Static diagnostics honestly attributed

Main and isolated focused lint/format, test diff, syntax, exact collection and full source build pass. Bounded TypeScript does NOT pass: three TS2345 diagnostics occur in unchanged projection-rejection bodies at current line1199 twice and1258 once (unknown is not assignable to object), plus one external TS2345 in examples/grid/src/v3-zone.ts638 (roomHeadAuthority missing). There are no diagnostics in any edited span.

Original isolated-preflight status1 and all raw diagnostics are retained. Per root authorization, one same-program/options comparison supplied only this test file in memory from signed pre-correction29e26b3f. Exact newline mapping across the three permitted spans maps1199→1136 and1258→1195; the diagnostic source lines are byte-identical. All three mapped target diagnostics and the external grid diagnostic are exactly equal to baseline. The external source is byte-identical. No source write, typecast, helper repair, repeated build or runtime occurred.

Debt owners: Phase3g projection fixture for the three unchanged-body diagnostics, and existing grid composition authority for the external diagnostic. Deadline: applicable parent static closure. No target-wide/package-wide typecheck pass is claimed. Root authorized only the frozen runtime after this exact inherited-debt proof.

## Custody and terminal handoff

All eight dirty production owners remain unchanged, as does full-index binary patch SHA-256 `245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed`. All27 stashes match; all86,522 protected paths exist; prior named evidence manifests validate. Other retained test/fixture hashes, including the accepted finality and counter corrections and parent oracles, remain unchanged.

No parent causal RED, other retained gate, campaign, model review, new agent, browser, production commit or main runtime ran. The stopped evidence is sealed separately without executing the unused acceptance-only seal.mjs. Root must record this stop and decide any prospective next authorization. Parent retained acceptance and the planned separate GREEN run are not cleared by this result.
