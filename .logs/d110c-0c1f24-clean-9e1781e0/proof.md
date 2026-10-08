# D.110c-0c1f2/f4 clean-isolated proof

- Temporary worktree: `/tmp/ts-drp-d110c-f24-clean.vc0NSD`
- Signed commit: `9e1781e0966953d7adce8cf6b0a4d9e56d12299a`
- Tree: `74aade705d2cb0d0a939dd2aa2ac137566266f77`
- `git verify-commit HEAD`: good RSA signature from
  `Faolain <Faolain@users.noreply.github.com>`.
- Node: `v22.15.0`; pnpm: `10.24.0`.
- Lockfile SHA-256:
  `73c7c0660fa32c7380d0fe5a026897a7ad85a40edf1f169730c2d8e44e613a99`.

The first deliberately repo-local-store command,
`pnpm install --offline --frozen-lockfile --store-dir /Users/aristotle/Documents/Projects/ts-drp-1/.pnpm-store`,
stopped because that partial store lacked the `fake-indexeddb@6.2.5` tarball.
This was not a source or lockfile failure. The corrected command used pnpm's
existing physical global store:

`pnpm install --offline --frozen-lockfile`

It resolved 1,526 packages with 1,525 reused and zero downloaded, then its
normal postinstall rebuilt all 40 `@ts-drp/*` workspace packages plus the
affected browser-network and v3-room examples successfully.

The exact six-file focused command then passed 41/41 assertions with coverage
disabled. The exact two-title Chromium command passed 2/2 with one worker and
`--fail-on-flaky-tests`. `git status --porcelain=v1` was empty afterward.

The main workspace's unrelated untracked
`packages/protocol-v2/tests/author-sequence-0g2.test.ts` and local `.agents`
directory were absent, proving neither could influence the isolated result.
No long campaign or D.110a invocation ran.
