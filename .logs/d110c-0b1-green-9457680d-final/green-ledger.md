# D.110c-0b1 GREEN evidence ledger

- Accepted plan correction: `627f98d118fa22e935f31023171d38c6075e3bc0`
- Accepted plan confirmation: `2cd3ba512a62595a314b1806b70b0eac9092f09c`
- Signed causal RED: `9457680d95eec15afe3a6a6d7d17655a1d21c2ee`
- Scope: bounded creator checkpoint opener, exact stale control-proof/ACL retirement, shared Node transition classification, and genuine active epoch-2 cold reopen.
- Excluded: pending epoch>=2 recovery, physical pruning, third transition, arbitrary historical issuance compaction, wire/API/dependency/threshold/authority changes, D.110a invocations, long campaigns, Fable, and collaboration subagents.

## Final runtime gates

- `focused-final.json`: 5/5 passed, 0 failed, 0 pending.
- `focused-evidence.json`: genuine epoch-2 checkpoint success; bounded advance success; exact 5 -> 4 -> 5 current/staged/active census; exact durable heads and refs; active cold reopen; post-reopen issue accepted and publish successful.
- `retained-final.json`: 350/350 passed across 79 suites, 0 failed/pending.
- `retained-browser.json`: exact Chromium D.110c-b title 1/1 expected, 0 skipped/unexpected/flaky, no top-level error.
- `boundaries-final.json`: the same two boundary titles pass with the final adversarial assertion roster.

The final Vitest roster is recorded literally in `retained-final.files`; it contains 36 files. All development and diagnostic reporters are preserved under `development/`. The initial cold-reopen failures and stale retained expectations are not omitted or relabelled.

## Static gates

The following recorded commands exit 0:

- exact-owner ESLint and Prettier;
- protocol-v3, control-plane, Node, storage-node, and storage-browser builds;
- protocol-v3 and control-plane package typechecks;
- Node, storage-node, and storage-browser production-source `tsconfig.build.json` no-emit checks;
- v3-room typecheck and build;
- v3-chat typecheck;
- D.110c-a private fixture no-emit compile; and
- the corrected package-consumer source/export/runtime audit.

`node-typecheck.status` is deliberately retained at exit 2. The broad test-inclusive Node command reports inherited worker-host `rootDir`/file-list errors, retained E3-02 `emit` typing, and compact-history helper union typing. It names no D.110c-0b1 owner. `node-source-typecheck.status` and `node-build.status` both exit 0, matching the established D.110c exact-source gate.

The first static wrapper root `.logs/d110c-0b1-green-9457680d/` stopped after ESLint because zsh reserves the variable name `status`. It is a launcher diagnostic, not a code result. The first source-shape run used the non-package repository root and failed bare workspace resolution; the next used the correct package consumer but contained a faulty `kind:` regex. `source-shape-final.status` is the corrected authoritative audit and exits 0.

## Functional ownership and remaining debt

- The protocol non-root opener authenticates pinned genesis, immediate predecessor/current creator trust, the exact Cut/QC, lineage, and expected room head; root exports remain unchanged.
- The control-plane non-root predicate retires exactly old trust, stale Cut/QC, and stale predecessor ACL while preserving every unrelated ref.
- One Node-private classifier serves close stage, hot verify, adoption commit, and active cold reopen.
- Active epoch-2 recovery filters only a fully authenticated pinned-genesis issuance row cross-bound to the durable issued row. Malformed or substituted rows remain fail closed.
- Pending adoption remains intentionally pinned to 0 -> 1 for D.110c-0c.
- General intermediate-epoch issuance retirement/recovery remains D.110c-0c/D.110c-d debt before the >=100-transition gate. This checkpoint proves only the frozen genuine 0 -> 1 -> 2 contract and does not claim a third transition.

## Custody

The final manifest is self-excluding and covers this ledger, all command/status/stdout/stderr files, reporters, serialized functional evidence, development diagnostics, state audit, changed-path roster, and source hashes. Protected `.agents`, `.claude`, and `.pnpm-store` paths and all 27 stashes are preserved. The GREEN commit is signed and pushed before formal review. Its signature/ref identity is verified after commit and retained in the review evidence root because a commit cannot contain its own object identity without recursion.
