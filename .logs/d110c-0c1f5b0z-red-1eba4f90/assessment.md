# D.110c-0c1f5b0z tests-only causal RED

Tests commit: `1eba4f9065d220afb0d77d90aac4a05b250a05bb`, signed (`G`) and
pushed before the independent checkout/install/source build and sole execution.
The commit changes only the new test file and its native child/source-custody
fixtures. No production source, existing test, dependency, configuration,
threshold, wire grammar, authority or plan changed.

## Exact result

The sole focused execution matches the pre-frozen matrix: one file, 16 tests,
14 failures, two passes, zero skipped/filtered/pending/top-level errors and no
matrix violations. Vitest exits 1 as expected; the matrix validator exits 0.
Cases 01-06 and 10-14 fail with the exact first-line error
`F5B0Z_NEUTRAL_MAINTENANCE_DISCOVERY_REQUIRED` (11). Cases 07-09 fail with
`F5B0Z_INCOMPATIBLE_REGISTRY_REFUSAL_REQUIRED` (three). Cases 15-16 genuinely
pass the legacy backend-identity and source-custody controls.

`matrix.json` was frozen before the signed test commit; SHA-256 is
`464e04a81d2d3e798f9cdcb43321b28b0070009b4291f0ed1fd79c98ca7f422d`.
The exact command, including its pre-frozen absolute reporter output path, is
recorded in that matrix and `execution-start.json`. It includes
`--coverage.enabled=false`; no repository coverage configuration or threshold
was changed, and this is not a coverage pass.

## First causal boundary and continuations

Each discovery case creates a genuine browser or SQLite facade, checks its
existing real backend capability and completes an ordinary head read before
the optional neutral identity comparison. The native duplicate-module case
does so in a fresh child against freshly built package files and distinct
query-string ESM instances in one global. There is no missing-export/import,
undefined-function call or `typeof` readiness failure, and no backend-resolver
fallback serves as neutral discovery.

The three incompatible-registry children assert unchanged descriptors and
zero accessor calls. Current code imports successfully despite the occupied
slot, yielding the required causal refusal token. Their GREEN continuations
require the exact TypeError prototype and message. Parent globals are never
modified by those children.

All remaining GREEN continuations are executable assertions, not readiness
passes: first-bind/repeat-bind semantics, dedicated genuine-facade internal
duplicate registration and exact TypeError, both resolver identities, closed
and substrate-corruption-latched poisoned refusals, exact original facade key
sets, no-I/O spies restored in `finally`, and source call-surface restrictions.
RED does not claim these post-discovery continuations executed successfully.

The first-bind=true primitive in cases 04 and 14 deliberately binds a separate
memory facade as trusted registry plumbing using a real capability. It never
invokes the foreign capability through that facade and claims no backend
ownership or authentication. Case 03 uses a different, unregistered memory
facade. Genuine browser/SQLite facade identities remain the positive backend
ownership premises. Root explicitly confirmed this fixture interpretation.

Case 05 invokes existing internal register functions only after discovery on
dedicated genuine facades; no public rebind API or lifecycle fixture is shared.
Case 14 uses post-construction SQLite prepare/exec and fake-indexeddb
transaction spies, exact existing own-field key sets and a source call-surface
check. Case 16 pins 12 complete unchanged files and 66 existing top-level
statement spans, including full backend maintenance classes, classifier,
receipt/error/type contracts, backend resolver bodies, constructors, ordinary
types, roots, manifests and issuance maintenance. It excludes changed imports
and registration bodies and preserves the browser's first input-capture
scheduling probe.

## Evidence and isolation

The fresh sparse clone has an independent offline frozen-lockfile installation
and complete successful `pnpm build:packages`. No dist or node_modules was
copied from the main workspace; only immutable Git objects are shared by the
clone. Isolated collection exactly matches all 16 frozen cases. Before/after
source hashes equal the signed test commit, all relevant native dist hashes
are unchanged and resolve inside the isolated checkout, and all seven parent
partial-production versions are absent. The checkout remains available at
`/private/tmp/d110c-f5b0z-red-isolated-8et9Mc/checkout`.

Complete runner stdout, stderr, reporter, assertion failure stacks/statuses,
command statuses and source/runtime hashes are retained. Artifact limitation:
Vitest's JSON reporter intercepted the tests' console.info output, so no
standalone child JSON/stdout/stderr stream artifacts are retained. Do not
infer otherwise from the console.info statement. The child's status/no-error/
no-signal assertions and exact emitted token enforce the preceding native
premises, and independent isolation records retain all native runtime paths
and hashes. Root accepted this as a disclosed RED artifact limitation, not a
causal blocker; there was no rerun. GREEN must preserve direct existing-helper
stdout/stderr for each mode in its already-required native import-identity gate.

The seven main-workspace production hashes and all 27 stash identities match
the preserved parent baseline before signing and after execution. All 86,522
protected untracked baseline paths remain present; none was targeted for edit
or deletion. The plan and prior immutable evidence were not edited.

## Static gates and authoring diagnostics

Exact-owner ESLint, Prettier, native child syntax, test-commit whitespace,
16-case collection and source custody pass. The source-mapped test/helper
typecheck has zero target diagnostics and one unchanged external TS2322 at
`tests/fixtures/phase-6b/ahe-reclamation-contract.ts:234` (BlobDigest versus
ClosureDigest). `@ts-drp/storage` package typecheck passes. Main-workspace
browser and Node package typechecks do not pass: their full 75/144 diagnostic
lists are preserved. Initial command exits were 2; repeated incremental
commands exit 1 with the same 75/144 lists. Browser includes the preserved
parent-dirty priorFence TS18047. These are not blanket typecheck passes.
Separate GREEN must rerun affected package checks in its clean signed
source-built checkout and distinguish inherited versus target diagnostics.

Before freezing or any runtime, ordinary draft import-order/handler-return
annotations were fixed. Root lacks a linked `@ts-drp/storage/maintenance`
runtime import at repository level, so the namespace uses the retained
source-relative import pattern without changing aliases. The first recorded
preflight then exposed a source/dist nominal-brand TS2322 in the test; that
failed collection/typecheck evidence is retained in `authoring-*`. The test
now derives its capability type from the actual backend resolver and uses an
explicit optional namespace observation boundary. Root confirmed this
test-only correction. No brands or configuration changed. Two recorder-draft
bookkeeping mistakes (old baseline property name and an extra quote) were
fixed before their gates executed. No focused runtime was consumed during
any authoring correction.

No design contradiction remains. This RED establishes only the neutral
discovery and incompatible-registry absence. It does not implement GREEN,
invoke parent cleanup, validate product room epochs, close parent lifecycle
gates, run retained/browser suites or authorize a campaign/reviewer round.

## Raw-capture whitespace disposition

The full staged evidence `git diff --cached --check` exits 2 solely because
`signed-tests-check/stdout:9` ends in an additional blank line emitted by the
successful `git show --check --stat --show-signature` command. That raw stream
is retained byte-for-byte. The test commit whitespace gate passes, and the
staged evidence check excluding only that exact raw stdout file passes; no
executable source, helper, assessment, script or other artifact is excluded.
Root accepted this recorded raw-capture disposition. It is not a product or
source whitespace waiver and consumed no runtime execution.
