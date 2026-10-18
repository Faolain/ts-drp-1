# D.110c-0b1 deterministic causal RED ledger

- Accepted plan/confirmation base: signed/pushed `2cd3ba512a62595a314b1806b70b0eac9092f09c`.
- Scope: tests and evidence only; no production source, API, wire/schema, dependency, threshold, floor, rollback, pruning, pending-recovery, or campaign change.
- Focused execution count: exactly one; no retry.

## Sole focused execution

```text
pnpm exec vitest run tests/phase-6b-d110c-0b1-bounded-checkpoint-red.test.ts --coverage.enabled=false --reporter=json --outputFile=.logs/d110c-0b1-red-2cd3ba51/vitest.json
```

- Exit: `1` (expected RED).
- Selected result files: `1`.
- Selected tests: `3`.
- Failed: `3`; passed: `0`; pending: `0`; todo: `0`.
- Result-level top-level messages: `0`.
- `D110C_0B1_CHECKPOINT_OPENER_MISSING`: exactly `1`.
- `D110C_0B1_BOUNDED_ADVANCE_MISSING`: exactly `1`.
- `D110C_0B1_COLD_REOPEN_EPOCH_PINNED`: exactly `1`.

The hook completed and all semantic assertions before each terminal token passed. Those assertions prove:

1. Genuine epoch-1 and epoch-2 trust records both reject through the existing current opener as `trust-state-inconsistent`, and applying the remaining genesis capability to the genuine 1→2 Cut/QC/current record rejects as `EPOCH_GAP`.
2. The existing additive advance returns `ok:true`; the genuine closure grows 5→7→8 while retaining the epoch-0 Cut, epoch-0 commit QC, and epoch-0 predecessor ACL, then adding the epoch-1 Cut/QC and epoch-1 ACL.
3. After genuine hot epoch-2 activation and deactivation, the public installed cold-reopen owner receives captured production-created storage, snapshot, journal, issuance, genesis, parameters, runtime, and exact epoch-2 room-head inputs and returns `{ok:false,kind:"chain-invalid"}` without a handle. Close and adoption each advance the durable revision exactly once.

## Evidence-capture disposition

Vitest's JSON reporter retains failures and stacks but does not serialize successful assertion operands. The random runtime ref digests and numeric head revisions checked in memory were therefore not copied out before the three intended failures. The sole invocation is not rerun. D.110c-0b1 GREEN owns serializing exact current/proposed/active refs, decoded census, and revisions before its terminal proof; final review must inspect this limitation and confirm RED causality from the signed source/hash, assertion ordering, reporter stacks, and GREEN comparison. No GREEN census requirement is weakened.

## Static and custody gates

- Read-only listing: exactly three titles in the one intended file.
- Exact-owner ESLint: pass.
- Exact-owner Prettier: pass.
- `git diff --check`: pass.
- Source shape: both reviewed subpaths absent; old epoch literals/generation selectors and unbounded call sites present; retiring proof/ACL inputs absent.
- A discarded ad hoc deep-fixture TypeScript probe could not resolve inherited bare workspace imports; it exposed one wrong singleton import, corrected before execution. It is not an authoritative typecheck or code failure.
- No D.110a invocation/preflight, long campaign, reviewer, Fable run, or collaboration subagent occurred.
- Protected `.agents`, `.claude`, and `.pnpm-store` and all 27 stashes remain untouched.
