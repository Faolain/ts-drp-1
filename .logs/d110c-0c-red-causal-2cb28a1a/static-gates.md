# D.110c-0c causal RED static gates

- Exact authored-file ESLint: passed.
- Exact authored-file Prettier check: passed.
- `git diff --check`: passed.
- Exact Playwright listing: one Chromium test in one file.
- Production-source diff across `packages/node/src`, `packages/room/src`, and `packages/storage-browser/src`: zero lines.
- Snapshot selector: exact epoch 2; pending successor: epoch 3.
- Diagnostic AHE equality: sorted normalized fingerprint; durable-floor equality: strict canonical bytes.
- Prelaunch process predicate: no ts-drp reviewer/test/profiler or D.110c child active after exact stale-child cleanup.
- Fixed ports 4174, 4175, 51000, and 51002: clear.
- Protected `.agents`, `.claude`, and `.pnpm-store`: present and untouched.
- Stashes: 27.
- One diagnostic source-shape check initially expected an anchored regex that the config intentionally does not use. The check was corrected to the exact literal configured grep before validation; this was a validator mistake, not a source failure.
