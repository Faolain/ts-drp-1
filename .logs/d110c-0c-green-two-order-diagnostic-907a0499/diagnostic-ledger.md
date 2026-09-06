# D.110c-0c two-order post-commit diagnostic

- Plan anchor: signed/pushed `907a0499cfe03a858f682a2066faf3bbd210a59d`.
- Selection: exactly one Chromium test in one file.
- Playwright exit: `1`, intentionally diagnostic rather than GREEN.
- Reporter result: expected `0`, skipped `0`, unexpected `1`, flaky `0`, top-level errors `0`.
- Soft failures: exactly two, both `D110C_0C_EPOCH3_COLD_REOPEN_BLOCKED`.
- Both `old-ahe` and `new-ahe` returned `active-new`, committed stable epoch `3`, cleared pending state, and then failed immediate cold reopen with exact detail `v3 room successor reopen failed: recovery-rejected: creator predecessor recovery failed: admission-rejected`.
- `old-ahe` performed exactly one head swap: revision `7 → 8`, former active `Adopted → Superseded`, replacement `Complete → Adopted`, and every other generation remained exact.
- `new-ahe` performed zero swaps and retained the complete AHE value exactly.
- The first validator attempt used an ANSI-sensitive regex and was discarded as a faulty read-only diagnostic. The corrected validator strips ANSI codes and exits `0`; no product or test result depends on the failed regex.
- `pnpm --filter @ts-drp/node build` and `pnpm exec tsc -p packages/node/tsconfig.build.json --noEmit` both exited `0`.
- Exact-owner ESLint, Prettier, and `git diff --check` pass.
- No retained campaign, D.110a worker/preflight, Fable follow-up, or collaboration subagent ran.
