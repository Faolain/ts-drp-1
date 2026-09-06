# D.110c-0c1b source-audit commands

- `git rev-parse HEAD HEAD^{tree}`
- `rg -n 'issueOneVertex|committedFailure|operationAdmissionHalted|appendAccepted|recoverV3LiveReplica|stageClosedBlueprintEpoch|stageBlueprintEpoch|creatorCloseRegistration' packages/node/src/v3-live.ts packages/node/src/creator-close.ts tests`
- bounded `sed`/`nl` inspection of `v3-live.ts` issue, recovery, queue, fold and creator-close owner ranges
- inspection of `tests/e5-01-v3-operation-admission-red.test.ts` and `tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts`
- `shasum -a 256` over the six exact inspected owner/contract/test files into `source-hashes.sha256`
- `shasum -a 256 -c .logs/d110c-0c1b-source-audit-90a06a1a/source-hashes.sha256`
- `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec prettier --check docs/production-hardening/production-hardening-tdd-plan-v2.md`
- `git diff --check -- docs/production-hardening/production-hardening-tdd-plan-v2.md`

This checkpoint is read-only architecture evidence plus plan text. It runs no
test, preflight, campaign, D.110a invocation, or production edit.
