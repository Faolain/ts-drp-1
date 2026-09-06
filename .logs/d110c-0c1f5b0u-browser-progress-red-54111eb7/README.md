# D.110c-0c1f5b0u native-browser progress RED

Signed/pushed tests-only source:
`54111eb767c53e360b17d002382ae5c7a59dba8b`.
Only the existing browser Playwright test and browser asset changed. The
launcher, configuration, dependencies, production, thresholds and timeouts
remain unchanged. This checkpoint extends native-browser acceptance already
owned by f5b0u; it does not reopen a completed slice or evaluate pending GREEN.

## Result

Exactly one native Chromium test ran once in a fresh detached clean checkout
at the tests-only source commit. Chromium reports `151.0.7922.34`.
The reporter records one expected RED failure, zero skips/flakes and zero
top-level errors. Its four complete soft failures have exact tokens:

- `D110C_F5B0U_BROWSER_zero-origin`
- `D110C_F5B0U_BROWSER_nonempty-origin`
- `D110C_F5B0U_BROWSER_partial`
- `D110C_F5B0U_BROWSER_final`

All six vectors were observed and attached before assertion. The native
browser's complete values are in `complete-vectors.json`, also preserved
verbatim as the reporter attachment. Expected clean semantics are:

| Vector | Observed clean result | Expected GREEN result |
| --- | --- | --- |
| Zero-chunk origination | `ISSUANCE_INVALID_ARGUMENT`; legacy state unchanged | Accept exact revision-1 empty progress |
| Nonempty CAS origination | `ISSUANCE_INVALID_ARGUMENT`; legacy state unchanged | `ISSUANCE_RETRY_REQUIRED`; unchanged readback |
| Partial atomic chunk | Empty-progress setup rejected; `transactIssue` gives `ISSUANCE_COMMIT_INVALID` | Revision 2, chunk sequence 0, range through 1, time 7, final scalar null |
| Final atomic chunk | Setup/partial rejected; `transactIssue` gives `ISSUANCE_COMMIT_INVALID` | Revision 3, exact second chunk sequence 1/range through 2/time 9, final scalar 1 |
| Stale CAS revision | `ISSUANCE_RETRY_REQUIRED`; exact unchanged revision-1 readback | Same; control passes |
| Inexact next revision | `ISSUANCE_INVALID_ARGUMENT`; exact unchanged revision-0 readback | Same; control passes |

Partial/final progress uses the real browser store's atomic `transactIssue`
path, not direct IndexedDB insertion or fabricated progress readback. The
test pins complete plans, digest bytes, revision, chunk range, sequence,
logical time, final-null/scalar semantics, lineage and issued/outbox counts.
Every vector closes and reopens its real store and compares the full durable
plan. These are store-contract vectors; they do not claim cryptographic
signature verification or new room authority.

The clean product rejects the progress schema/effect before it can implement
that acceptance. This is causal semantic RED, not an import/export, loader,
browser, asset or configuration failure. The pending dirty candidate was
never applied to the isolated checkout or executed.

## Commands and validation

`environment.json` records the exact detached checkout, source, Node and
timestamps. `commands.json` records full argv/cwd/status/start/finish/elapsed
for every command, with complete stdout/stderr in `isolated/`:

- Offline `pnpm install --offline --frozen-lockfile --ignore-scripts`: 0.
- Fresh `pnpm build:packages`: 0.
- Exact two-file Prettier, ESLint and diff gates: 0.
- Exact Playwright JSON listing: 0, one test/file/project.
- The single Playwright Chromium invocation: 1, expected causal RED.

Both test sources also passed TypeScript `transpileModule` syntax diagnostics
before the signed test commit; no test was executed before signing/pushing.
`node validate.mjs` returned 0 with `CAUSAL_NATIVE_BROWSER_RED`. It compares
every collected clean vector with its complete expected object, exact four
error tokens, all reporter/listing counts, attachments and command statuses.
It also verifies signed/pushed source identity and two-path commit custody.
This is a one-shot evidence generator; the self-excluding manifest is the
subsequent read-only byte-validation boundary.

## Workspace and evidence custody

Main-worktree candidate binary-patch SHA-256 stayed
`797511cab746df7ae44de600ae8eb110787b276f96973ef77863665c9cfa2675`.
`main-before.json` and `main-after.json` preserve all nine individual hashes,
the unchanged 27-stash identity hash, and 81 protected untracked entries
(file hashes, symlink targets, or nested-directory presence). Prior evidence
roots and protected paths were not edited. The temporary checkout is retained.

The initial read-only custody diagnostic exceeded its default child-output
buffer and then encountered a nested-directory entry. The corrected bounded
enumeration excludes evidence/package-cache trees and distinguishes files,
symlinks and directories. Those diagnostics changed no files and consumed no
test invocation. A draft outbox argument was corrected to the existing
`{ scope, limit }` API and import spacing was corrected before signing and
execution; neither required production or configuration changes.

Remaining work is the combined GREEN implementation's six-vector native
Chromium pass, its other frozen gates and final review. This RED does not
close f5b0u or authorize any retained campaign or long workload.
