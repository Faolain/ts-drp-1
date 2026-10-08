# f5b0z: backend-neutral AHE maintenance discovery

Authorized by the user on 2026-09-05. Source anchor:
`609ee4ba24652cc10becc1a07e198a81a01e61ba` on
`codex/phase3a1b-p6-golden-path`. This is one prerequisite, not a reopening of
f5b0d or an authorization for the parent cleanup caller. The seven uncommitted
parent production files are preserved separately and are not this slice.

## Contract and ownership

Add exactly two exports to the existing `@ts-drp/storage/maintenance` subpath:

```ts
bindAheReclamationMaintenance(
  store: AheDurableStore,
  maintenance: AheReclamationMaintenance,
): boolean;
aheReclamationMaintenanceForStore(
  store: AheDurableStore,
): AheReclamationMaintenance | undefined;
```

The binder is trusted backend registration, not authentication of arbitrary
JavaScript supplied by an adversary. Valid inputs are an ordinary facade and
its owning existing maintenance object. Resolution is exact object identity;
copies, proxies and an unregistered memory facade do not inherit a binding.
The first bind returns true; every subsequent bind for that facade returns
false, including the same capability. It never replaces the first entry or
invokes a store/capability method. Do not widen the store interface or root
exports. The public reclamation inputs, receipts and error-code set are unchanged.

One process-global weak registry uses
`Symbol.for("@ts-drp/storage/ahe-reclamation-maintenance-v1")`. Its value is a
frozen ordinary object with exactly own data functions `bind` and `resolve`,
closing over a WeakMap. Install it as a non-enumerable, non-configurable,
non-writable own data property on `globalThis`. Inspect an existing property
by descriptor, without invoking an accessor. Reuse only that compatible
descriptor and frozen exact function-record shape; a present incompatible
property throws `TypeError("AHE maintenance registry is incompatible")` at
module initialization, without overwriting it or falling back to a second map.
This detects accidental incompatible module/registry state, not hostile local
code that can forge a compatible implementation. Separate module instances in
the same global share bindings. Separate workers/globals do not share facade
identity, and each registers its own stores. Do not change the issuance registry.

The existing browser and SQLite registration functions create their existing
maintenance object once, bind it neutrally, then install that same object in
their existing backend-local WeakMap. Failed duplicate binding throws
`TypeError("AHE maintenance facade is already registered")` before changing
the local map. Existing backend resolvers remain backend-specific: browser
must not resolve a SQLite facade and vice versa. These local maps are scoped
discovery indexes, not additional mutation owners; both paths return the exact
same backend object, never wrappers or duplicate capabilities.

Only these three production owners may change:

- `packages/storage/src/maintenance.ts`: registry, two exports, type import.
- `packages/storage-browser/src/internal/ahe-reclamation.ts`: import and registration body.
- `packages/storage-node/src/internal/ahe-reclamation.ts`: import and registration body.

All existing maintenance implementations, transaction/reclamation predicates,
schema, backend-specific resolver bodies, and lifecycle methods are untouched.
No Node/room source, dependency/package manifest, wire, API input key, pruning
policy, retry classification, threshold or timing contract changes. Importing,
binding and resolving do not perform I/O or reclaim anything. A discovered
capability remains subject to its existing closed/poisoned and transactional
checks. Legacy facades and backend resolver outcomes are unchanged.

## Causal RED and narrow GREEN

One Astra-high agent writes tests only, commits/signs/pushes, then runs the
single frozen focused RED in an independently installed/source-built checkout.
A separate Astra-high agent implements GREEN only after RED acceptance. Tests
live in `tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts` and,
if required for native ESM/global isolation, bounded helper children under
`tests/fixtures/phase-6b-d110c-0c1f5b0z/`. No existing retained fixture is changed.

Freeze 16 selected tests in one file, no skips or campaigns:

1. Real browser facade resolves the exact existing backend capability.
2. Real SQLite facade resolves the exact existing backend capability.
3. Memory, copied, proxy and foreign facade non-resolution after genuine discovery.
4. First-bind-wins through both backends; same and different second capability refused.
5. Duplicate backend registration cannot change either resolver's first capability.
6. Two freshly built native ESM module instances in one global share exact bindings.
7. Incompatible preoccupied registry value fails closed in a fresh child.
8. Preoccupied accessor is not invoked and import fails closed in a fresh child.
9. Mutable/configurable preoccupied registry descriptor fails closed in a fresh child.
10. Discovered browser maintenance preserves `AHE_RECLAMATION_STORE_CLOSED`.
11. Discovered browser maintenance preserves `AHE_RECLAMATION_STORE_POISONED`.
12. Discovered SQLite maintenance preserves `AHE_RECLAMATION_STORE_CLOSED`.
13. Discovered SQLite maintenance preserves `AHE_RECLAMATION_STORE_POISONED`.
14. Registration/discovery preserve facade keys and perform no additional store I/O.
15. Existing backend resolvers remain backend-specific and reject foreign identities.
16. Compatibility source custody: store interface, roots, manifests, mutation bodies unchanged.

For cases 1-6 and 10-14, first create a genuine facade, verify its existing
backend resolver and an ordinary store read work, then compare neutral discovery
to that existing capability. Import the existing maintenance namespace normally;
a safe optional lookup may observe no discovery, but cannot substitute the
backend resolver as GREEN behavior. Failure must be exactly
`F5B0Z_NEUTRAL_MAINTENANCE_DISCOVERY_REQUIRED`, after those genuine premises,
not an import/export error, `typeof` assertion, or undefined-function call.
Cases 7-9 fail with `F5B0Z_INCOMPATIBLE_REGISTRY_REFUSAL_REQUIRED` because the
existing module succeeds without refusing the incompatible slot. Their GREEN
continuations require the exact TypeError above, unchanged descriptor and no
accessor invocation. Cases 15-16 are retained compatibility controls and pass
in RED. Expected RED: 16 total, 14 exact failures (11 discovery, 3 registry
refusal), 2 passes, zero filtered/skipped/top-level errors. Stop on any other
matrix. Do not rerun to obtain the expected result.

The RED owner must substantiate case 14's no-I/O observation without counting
ordinary facade creation/schema setup as discovery I/O. Capture the already
open store and observe registration/resolution separately; preserve the exact
existing construction/registration boundary by source custody. No mocked
maintenance may replace the real backend in positive identity/lifecycle cases.
Corruption/poison controls use existing deterministic substrate-fault patterns,
not product instrumentation. Native module duplication and incompatible globals
run only in fresh bounded children, never poison the parent test runner.

GREEN changes only the three owners. All 16 tests must pass; post-discovery
continuations, including duplicate bind/registration and lifecycle refusal,
must actually execute. Read-only source-custody checks prove the existing
mutation bodies and legacy facade exports are byte-identical. A regex mistake
is a diagnostic error to correct and record, not a product failure.

## Gates and review

Plan: sign/push this bounded design and plan update, then Grok 4.6/high,
Codex gpt-5.6-sol high, Fable 5.1 xhigh via claude-phel. A new capability export
adjacent to destructive maintenance requires this plan gate: it checks exact
identity, duplicate registration, module compatibility and no authority expansion.
Only P0/P1 block; P2 receive owner/disposition, no recursive prose review.
At most one material confirmation if executable scope/acceptance changes.
Preserve and resume Grok's exact session if canceled; never replace NO_VERDICT
with approval. The earlier Fable-high consultation is input, not this gate.

RED: one isolated focused execution, exact matrix/error/status/hash validation,
signed/pushed evidence. No separate three-model RED round. Final GREEN review
must inspect signed causal RED and all GREEN evidence.

GREEN focused command:
`pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts --reporter=json`
with complete raw stdout/stderr, reporter, statuses and selected-test listing.
Use `pnpm build:packages` before children; typecheck each of `@ts-drp/storage`,
`@ts-drp/storage-browser`, `@ts-drp/storage-node`, plus the new test/fixtures
through the existing source-mapped harness. Record any inherited diagnostics
exactly; no blanket typecheck pass if it fails. Run exact-owner ESLint,
Prettier and `git diff --check`.

Retained Vitest gates (complete files, no filtering):

- `tests/phase-6b-ahe-reclamation-red.test.ts`
- `packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts`
- `tests/phase-6b-runtime-reclamation-red.test.ts`
- `tests/phase-6b-cleanup-eligibility-red.test.ts`
- `tests/phase-6b-issuance-retention-red.test.ts`
- `packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts`
- `tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`

Retained Chromium:
`pnpm exec playwright test --config packages/storage-browser/playwright.phase-6b-ahe-reclamation.config.ts --fail-on-flaky-tests`.
These are bounded deterministic retained suites, not campaign authorization.
Retain the configured timeouts/retries. Separately repeat focused GREEN and
fresh native import-identity proof in an isolated signed checkout with its own
frozen install/source build and no parent partial patch or copied dist. Record
all evidence under slice RED/GREEN/review roots with self-excluding manifests.

After signed/pushed GREEN, one final Grok/Sol/Fable review covers plan, RED,
GREEN, source custody, fresh-build identity, retained behavior and remaining
parent authority. Empty P0/P1 union plus all gates closes only f5b0z. Parent f5b
then resumes its previously authorized eight-owner implementation, including
the newly accepted observer correction; no automatic cleanup is added here.
Its genuine three-transition/64-writer and later >=100-transition obligations,
Discord safety checkpoint f5b0y, and Phase 7 archive/cold-join gates remain open.
