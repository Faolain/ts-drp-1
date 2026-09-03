# D.110c-0c1b GREEN evidence ledger

- Accepted plan confirmation: `4d616285f13daeb74934260b80fe627dd8bdb338`
- Signed causal RED: `0873dfd0cb202e216041f43562ca31ac4368f889`
- Scope: halt an active V3 registration after a durable issuance outcome can no longer be reconciled in-process, and refuse both pre-bound and not-yet-bound creator close until authenticated recovery.
- Excluded: wire/schema/API/dependency/authority/threshold changes, in-process outbox repair, retirement-boundary relaxation, campaigns, and D.110a work.

## Runtime gates

- `focused.json`: one selected file, 2/2 tests passed, zero failed/pending, reporter success true, runner exit 0.
- The pre-bound ordering commits one real issuance/outbox row, rejects its journal append, refuses the queued close twice, rejects a second issue without a new outbox row, cold-reopens the same genuine epoch-one room, sees the exact target row once, and accepts the immediately following author sequence.
- The not-yet-bound ordering delegates one real no-policy issuance transaction to durable completion, throws exact `ISSUANCE_OUTCOME_UNKNOWN` only after commit, retains one new pending row, and refuses close binding with existing `CREATOR_CLOSE_UNAVAILABLE`.
- `retained.json`: 9 selected files, 60/60 tests passed, zero failed/pending, reporter success true, runner exit 0. The roster covers E5-01 authenticated exact-once recovery, Phase-6a adoption/activation/epoch behavior, D.109d runtime reclamation, D.110c-0c1a retirement, D.110c-a repeat close, and D.110c-b hot epoch-two adoption.

## Static gates

- Exact-owner ESLint, Prettier, and `git diff --check` exit 0.
- `@ts-drp/node` build and its production-source `tsconfig.build.json` no-emit check exit 0.
- The four source-shape predicates for the unknown-outcome catch, unconditional committed-failure halt, queued fold recheck, and close-registration refusal are all true.
- Only `packages/node/src/v3-live.ts` changes production source. No root export, public API, package manifest, dependency, wire/schema, threshold, or product configuration changes.

## Retained expectation correction

D.110c-a initially failed only because its closure-byte expectation remained `-318`. A deterministic evidence run reported `before=6833`, `after=6516`, `delta=-317`, with one fewer retained reference and every semantic assertion passing. The exact value changed when completed D.110c-0c1a introduced the authenticated issuance-retirement carrier; this slice corrects only the stale retained expectation to `-317`.

## Development diagnostics

- The first focused GREEN semantic test passed, but its command exited 1 solely because the repository-wide 70% coverage threshold was applied to one file. The accepted focused command disables coverage and exits 0.
- A proposed exact-owner fixture `tsconfig` expanded inherited fixtures while failing to resolve bare workspace package imports; it was removed and is not an acceptance gate.
- The first integrated-recovery attempt tried to read close facts after hot activation, when production correctly revokes them. The final tests-only fixture retains the already-authenticated detached cold-reopen inputs before activation; it does not create or mutate epoch state.
- A draft assertion incorrectly required one `publishPending()` call to drain every historical pending row. The API correctly returned `{ok:true, kind:"empty"}` for ineligible rows. The accepted assertion instead proves the target row remains singular and visible after recovery and that dense author sequencing continues. Publication/rebase behavior remains owned by its retained suites.

## Custody

Protected `.agents`, `.claude`, and `.pnpm-store` paths and all 27 stashes remain present. The evidence manifest is self-excluding. Signed commit and pushed-ref identity are verified after commit in the final review evidence root.
