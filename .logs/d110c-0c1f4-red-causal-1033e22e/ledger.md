# D.110c-0c1f4 clean-isolated RED ledger

## Custody

- Clean worktree: `/private/tmp/ts-drp-d110c-0c1f4-red.6CrjQb`
- Branch: `codex/d110c-0c1f4-red`
- Signed/pushed plan base: `1033e22eaa152a1a1a26d1fc057564ac75b68192`
- Base tree: `cf6eef53618d00a47d5d666cce405e896bcd43e7`
- Main-worktree diagnostic GREEN draft: preserved and absent from this worktree
- Production-source changes: zero
- Selected scope: two tests in one Playwright file, zero retries

The clean worktree initially inherited the main root's `node_modules` symlink.
That was insufficient because package-local workspace links were absent. The
symlink was moved recoverably to
`/tmp/ts-drp-d110c-0c1f4-red.6CrjQb-main-node-modules-link`, then
`pnpm install --offline --frozen-lockfile --ignore-scripts` installed all 48
workspace projects from the local store. `pnpm build:packages` then passed for
all 40 package builds. No network-fetched or stale main-worktree build artifact
is the RED authority.

## Accepted causal matrix

The final run selected exactly these titles:

1. `D.110c-0c1f4 exact configured bootstrap authority is required on epoch-N cold reopen`
2. `D.110c-0c1f2 non-creator writer requires an authenticated historical frontier`

Reporter totals are expected `1`, unexpected `1`, skipped `0`, flaky `0`, and
top-level errors `0`.

The 0c1f4 observation test passes and emits exact
`D110C_0C1F4_EXACT_BOOTSTRAP_AUTHORITY_REQUIRED`. Both genuine Bob databases
contain one pending sequence-zero epoch-zero row, and Alice's accepted journal
does not contain that row. Alice genuinely advances the room to epoch three.
The control supplies Bob's canonical bootstrap bytes A; the treatment retains
the same Bob signing identity/database but supplies different blueprint-valid
bytes B. Both traces nevertheless classify sequence zero as `pinned-genesis`
under `predecessor-validation` at payload epoch three. This proves the missing
configured-bootstrap comparison at the intended exported recovery seam.

Both A and B later stop at the same separately owned `issuance-rejected`
boundary because the held D.110c-0c1f2 aggregate-carrier draft is intentionally
absent. Partial recovery is not called GREEN. The retained 0c1f2 test remains
the sole terminal failure at exact
`D110C_0C1F1_MULTI_AUTHOR_FRONTIER_CARRIER_REQUIRED`. Its attachment proves:

- exactly one Bob sequence-zero epoch-zero row is pending;
- Alice lacks Bob sequence zero before Bob's epoch-one application write;
- Alice genuinely accepts Bob sequence one; and
- Alice still lacks Bob sequence zero afterward.

This preserves the immutable 0c1f2 causal contract while supplying its missing
bootstrap preconditions. Full A-control recovery remains a combined
0c1f4-plus-0c1f2 GREEN acceptance condition.

Accepted reporter:
`.logs/d110c-0c1f4-red-causal-1033e22e/playwright.json`, SHA-256
`d4f7c8c6f798e45094ae4a5241552871de28eafecfc78f08b2b37277902af041`.

## Preserved diagnostic corrections

Three tests-only attempts preceded the accepted causal matrix. They are
preserved rather than overwritten or represented as acceptance evidence.

| Reporter                                                   | Result                              | Disposition                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.logs/d110c-0c1f4-red-1033e22e/playwright.json`           | expected 0, unexpected 1, skipped 1 | A creator-only epoch-one fixture reached covered/current/displaced classification, not pinned-genesis. Noncausal fixture shape.                                 |
| `.logs/d110c-0c1f4-red-corrected-1033e22e/playwright.json` | expected 0, unexpected 1, skipped 1 | A noncreator epoch-one fixture still authenticated through displaced genesis. Noncausal epoch selection.                                                        |
| `.logs/d110c-0c1f4-red-final-1033e22e/playwright.json`     | expected 0, unexpected 1, skipped 1 | Epoch three reached the intended seam, but the test incorrectly required full recovery despite the known downstream 0c1f2 carrier gap. Faulty test expectation. |

Their exact SHA-256 values are, respectively:

- `396f6ad16bde84ca5d652627bc19bb3474f10ed94e7c93712db908f309bf0d60`
- `9ee3216ab5cb91cbf42a2abdcca459b3bb5233f0df906250e667a63822de7bb4`
- `3184d38a6444191e4489f5957f76461d347296416e06f8fefe8d54636adb235f`

No production edit was made while correcting those test fixtures and
expectations.

## Static and workspace disposition

- Offline frozen install: pass, 48 workspace projects, 1,526 packages reused.
- `pnpm build:packages`: pass, 40 package builds.
- Storage-browser package build: pass.
- Broad storage-browser typecheck: nonzero only for inherited Phase-6b
  maintenance aliases and branded old fixture values; it emitted no diagnostic
  for either changed file. This inherited failure is not relabelled as RED.
- Exact-owner ESLint: pass.
- Exact-owner Prettier: pass.
- `git diff --check`: pass.
- Exact listing: two tests in one file.
- Accepted reporter and attachment predicate validation: pass.
- Main protected untracked roots: `.agents/`, `.claude/`, `.pnpm-store/` present.
- Stashes: 27 preserved.
- Fixed ports 4174, 4175, 51000, and 51002: clear at closure audit.
- Relevant ts-drp test/reviewer/profiler processes: zero at closure audit.
- No Fable or collaboration subagent was invoked.

Partial diagnostic observations never substitute for GREEN. The next action is
the frozen 0c1f4 public-compatibility implementation, followed by integration
of the held 0c1f2 carrier draft and the combined functional/retained gates.
