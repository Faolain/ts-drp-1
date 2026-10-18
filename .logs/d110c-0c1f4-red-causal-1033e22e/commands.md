# D.110c-0c1f4 RED commands

## Clean worktree preparation

```sh
git worktree add -b codex/d110c-0c1f4-red \
  /tmp/ts-drp-d110c-0c1f4-red.6CrjQb \
  1033e22eaa152a1a1a26d1fc057564ac75b68192
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm build:packages
```

The original root `node_modules` symlink was moved aside before the offline
install because it did not supply package-local workspace links.

## Focused RED

All four diagnostic/causal attempts used the same bounded command and differed
only in tests-only fixture/assertion corrections:

```sh
pnpm exec playwright test \
  --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts \
  --project=chromium \
  --grep 'D.110c-0c1f4 exact configured bootstrap authority is required on epoch-N cold reopen|D.110c-0c1f2 non-creator writer requires an authenticated historical frontier' \
  --reporter=json
```

The accepted causal reporter is
`.logs/d110c-0c1f4-red-causal-1033e22e/playwright.json`. The three earlier raw
reporters are retained at the sibling roots named in `ledger.md`.

## Exact static listing

```sh
pnpm exec playwright test \
  --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts \
  --project=chromium \
  --grep 'D.110c-0c1f4 exact configured bootstrap authority is required on epoch-N cold reopen|D.110c-0c1f2 non-creator writer requires an authenticated historical frontier' \
  --list
```

## Mechanical gates

```sh
pnpm exec eslint \
  packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts \
  packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts

NODE_OPTIONS=--max-old-space-size=8192 pnpm exec prettier --check \
  docs/production-hardening/production-hardening-tdd-plan-v2.md \
  packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts \
  packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts \
  .logs/d110c-0c1f4-red-causal-1033e22e/ledger.md \
  .logs/d110c-0c1f4-red-causal-1033e22e/commands.md \
  .logs/d110c-0c1f4-red-causal-1033e22e/reporter-validation.md \
  .logs/d110c-0c1f4-red-causal-1033e22e/source-shape.md \
  .logs/d110c-0c1f4-red-causal-1033e22e/static-gates.md

git diff --check
git verify-commit 1033e22eaa152a1a1a26d1fc057564ac75b68192
git ls-remote origin refs/heads/codex/phase3a1b-p6-golden-path
```

The accepted reporter was also validated with `jq -e` for exact counts,
titles, status/token, decoded attachment facts, A/B inequality, epoch-three
pinned-genesis classifications, and the supplemental 0c1f2 journal predicates.
`sha256sum -c SHA256SUMS` validates the self-excluding manifest.

The first Prettier command also named raw `listing.txt`; Prettier correctly
reported that no parser applies to the raw command output. The corrected check
above excludes that non-source artifact and passes. This was a diagnostic
command error, not a code or evidence failure.
