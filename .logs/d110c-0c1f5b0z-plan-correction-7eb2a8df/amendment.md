# f5b0z plan-review correction and dispositions

This prospectively amends only the launcher detail of the signed design at
`.logs/d110c-0c1f5b0z-plan-609ee4ba/design.md` / commit `7eb2a8df`.
The original design and review artifacts remain unchanged.

## Blocking union: one P1, corrected

Sol found that root `vite.config.mts` enables package-wide coverage and a 70%
line threshold. That is not the focused sixteen-assertion acceptance gate and
can independently turn the process red. The exact common focused command for
both the sole RED and GREEN is:

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0z-maintenance-discovery-red.test.ts --coverage.enabled=false --reporter=json
```

Reporter output is captured in the per-run evidence root. The RED owner freezes
that exact path and any `--outputFile` argument before execution. The complete
retained-file command also explicitly disables unrelated repository coverage:

```sh
pnpm exec vitest run tests/phase-6b-ahe-reclamation-red.test.ts packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts tests/phase-6b-runtime-reclamation-red.test.ts tests/phase-6b-cleanup-eligibility-red.test.ts tests/phase-6b-issuance-retention-red.test.ts packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts --coverage.enabled=false --reporter=json
```

No coverage configuration, coverage threshold, test selection, product workload,
RED error token, 16/14-fail/2-pass matrix, timeout, memory ceiling, type/lint gate
or browser gate changes. This explicit focused-run flag matches the intended
causal assertion gate; it is not a repository-wide coverage pass. One targeted
Sol confirmation inspects this correction; Grok/Fable had no blockers and are
not relaunched for their P2 notes or this finding's bookkeeping.

## Nonblocking findings and owners

- Grok P2-1 / Fable P2-2, RED owner: case 5 uses the existing internal register
  functions, never a new public re-registration API. Use a dedicated genuine
  facade. Establish ordinary read and both resolver identities before the
  duplicate attempt; RED terminates at discovery before the current register
  function can replace its local entry. In GREEN require exact duplicate
  TypeError and both resolvers still returning the original object. Do not
  share this facade with closed/poison controls.
- Grok P2-2 / Fable P2-1, RED owner: case 16 pins existing maintenance class /
  classifier / receipt bodies, ordinary store types, roots, backend resolver
  bodies and package manifests. Do not hash the changed import/registration
  regions as immutable. Keep complete existing maintenance classes exact.
  GREEN owner: preserve the browser scheduling probe's existing first
  `captureAheReclamationInput(input)` occurrence; add no earlier copy in prose
  or a helper. The existing browser scheduling source probe is inspected
  mechanically; no additional browser campaign is created.
- Fable P2-3, GREEN owner: one JSDoc sentence beside the global symbol states
  that any registry-record shape change needs a new symbol version. The frozen
  v1 exact-shape/import-refusal behavior is unchanged.
- Fable P2-4, RED owner: case 14 installs spies after ordinary facade creation
  and the causal discovery premise. Observe SQLite `prepare`/`exec` and
  fake-indexeddb `IDBDatabase.prototype.transaction` during bind-attempt and
  resolution, with restoration in `finally`. Pin the exact constructor and
  maintenance-constructor bodies and registration's call surface so the
  initial binding adds no storage calls; do not count existing schema setup
  as discovery I/O. Use AST/call-surface checks where a token regex would be
  misleading. No new product instrumentation or mocked positive maintenance.

These notes implement the existing frozen cases and compatibility boundary;
they add no cases, skips, production owners or authority. Final GREEN review
must verify their execution, not merely this disposition text.

## Review provenance

Grok 4.6/high: PASS, P0=0/P1=0/P2=2.
Fable 5.1 xhigh via `claude-phel`: PASS, P0=0/P1=0/P2=4; reported model
`claude-fable-5-1`, session `37e547b1-4472-4278-bf1e-5e5dc244fcb3`.
Sol high: initial NO_VERDICT honestly preserved because the shared prompt
forbade its only local read mechanism; resumed exact session
`01a072f7-6534-7f62-9fcf-2a6c64ee674e` with read-only shell inspection allowed,
then CHANGES_REQUIRED, P0=0/P1=1/P2=0 for the command above. No source changed
during review and no unavailable verdict is represented as approval.
