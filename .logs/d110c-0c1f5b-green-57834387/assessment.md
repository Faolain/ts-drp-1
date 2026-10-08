# Parent GREEN stopped: observer contract and cleanup ownership

Base: signed/pushed `57834387c6222189757fce0e7e125914f8d181d8`, branch `codex/phase3a1b-p6-golden-path`. Accepted tests: `97c0836bd92f2f045534852c991824fb9529b71c`. The seven-file partial production patch inherited from the prior stopped run remains unchanged. No production or test source edit occurred during this resumed attempt. This record is not GREEN acceptance.

## Bounded diagnostic executions

All commands, exit statuses, stdout/stderr and available Vitest reporters are preserved.

1. `iteration-01-segmented`: configuration startup failure. The diagnostic config used an incorrect relative import of the root Vite config. No test ran and no product verdict follows. Original failed config retained.
2. `iteration-02-segmented`: one selected case failed, 23 parent cases filtered (24 total). The in-memory observer used console.warn, but the JSON reporter did not emit its telemetry. This is retained as a console-suppressed diagnostic, not an independently attributed product verdict.
3. `iteration-03-segmented`: one selected case failed, 23 parent cases filtered (24 total). Original result kind/detail and bounded epoch/count/progress/sequence facts were emitted through stderr. The same genuine handle, original inputs, returned result, and production error contract were preserved. No 33,000-character payload was emitted. The observer exists only as a diagnostic Vite transform under this evidence directory; production and test files are untouched. Normal acceptance commands must not select this config.

The accepted full RED matrix (28 selected/23 fail/5 pass/17 filtered) was not rerun. No full focused GREEN, retained, build, typecheck, lint, format, isolated-clean GREEN or campaign gate was run here.

## Exact segmented causal boundary

The recorded sequence is:

- Epoch 1 fence at sequence 4 succeeds.
- The two-intent replacement of source sequence 3 requests a real split before signing.
- Replacement interval `[0,1)` commits at sequence 5 and succeeds.
- Interval `[1,2)` attempts sequence 6 twice, after signing; both return `admission-rejected` with original detail `v3 local issue signature was not admitted`.

These failures occur while the fixture deliberately arms `F5B_SIGNED_SUFFIX_NOT_COMMITTED`. The first chunk and split are working. The repeated failure is the fixture's intentional suffix transaction fault and its existing bounded authenticated retry, not a newly demonstrated operation/state-size rejection. There is no `INVALID_APPLICATION_STATE` in the execution.

The test then calls `productState(writer)` to capture `beforeRestartState`, before beginning its same-epoch reopen. That helper calls the existing room `projection()` getter. The settlement drain has already installed `terminalFailure` and shut down the failed owner; `examples/v3-room/src/index.ts:4486` deliberately rethrows that terminal failure from the getter. Consequently the test stops before the same-epoch restart, not at a new replay or later-close defect. The stack retains the original settlement failure creation site rather than identifying the later getter call.

This getter behavior is an existing contract: retained runtime tests at `tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts:673` and `:730` require terminal projection reads to throw. Held-but-nonterminal projections remain readable. No getter bypass or broadened read-after-failure semantics was introduced.

Root's prospective correction is to observe the existing public `onProjection` callback, presently a no-op in this fixture, and compare the last actually emitted accepted projection across the fault/restart while explicitly retaining the terminal getter's throw. That correction has not been applied by this GREEN owner and requires separate disposition. The test must still prove the genuine two-chunk split, committed prefix once, uncommitted suffix retry, exact plan/progress/state, and later transitions.

## Cleanup authority/capability boundary

The existing private `CreatorSuccessorLiveMaterial` (`packages/node/src/internal/creator-successor-live.ts:27`) carries authenticated predecessor/successor generation material, exact successor snapshot bytes, issuance scope/store, live journal store, AHE store, pinned genesis, and source terminalization custody. `activateCreatorSuccessorLive` in `packages/node/src/v3-live.ts` receives it for hot adoption and cold reopen and opens the authenticated historical settlement capability. This is the natural place for checkpoint/floor/plan validation; its trust authority must not be reconstructed from room projections.

The backend-neutral issuance maintenance resolver already exists in `@ts-drp/issuance-store/maintenance` and is consumed by Node. In contrast, AHE reclamation is resolved through the existing backend-specific `@ts-drp/storage-browser/maintenance.resolveBrowserAheReclamationMaintenance` or Node-backend counterpart. Their private WeakMaps bind capabilities to the exact ordinary AHE facade. `AheDurableStore` itself has no reclamation member or backend-neutral reclamation resolver.

Room already depends on storage-browser and holds the ordinary browser AHE facade. It can resolve browser maintenance without a new dependency. It does not currently receive Node's opaque authenticated successor trust/checkpoint capability: its `successorProjectionAuthority` is a structural product projection, not a substitute for that custody. Node owns the authenticated material but does not depend on storage-browser. The existing D109d runtime reclamation hook accepts post-delete receipt pairs; it cannot authorize or execute the parent's required first deleting mutation.

Minimum alternatives for root's required ownership consultation, none implemented:

1. An explicitly scoped private composition seam between the existing room backend owner and Node's authenticated cleanup owner, passing the existing backend capability without making caller assertions into authority. Requires a deliberate shared-module/custody decision; do not hide it in an expando, duplicate module realm, or unreviewed relative source import.
2. A backend-neutral AHE maintenance registry/resolver analogous to the existing issuance resolver. This crosses additional storage owners/exports and is outside the current eight-owner authorization.
3. A public adoption/runtime callback or returned cleanup capability, or a direct Node-to-browser dependency. These are explicit API/dependency expansions and are not authorized by the accepted parent implementation.

Duplicating checkpoint authentication in room, synthesizing receipts, inventing published rows, relabeling row epochs, or reusing the post-delete receipt replay as first mutation are not acceptable alternatives.

The prospective private `closed-epoch-cleanup.ts` adaptation is explicitly authorized as the eighth owner, but no edit has been made there. It must preserve the default/v1 path, two complete physical rollback ancestors, QC/snapshot/adoption/local-only availability/expected-head gates, truthful eligible mixed-epoch pending/published terminal rows, backend linked-plan/fence checks, and no issuance deletion when no eligible prefix exists. The missing composition seam is distinct from the already-authorized pure gate adaptation.

## Remaining production work

The inherited seven-file patch is diagnostic, not accepted GREEN. Root identified the `m=0` fence sentinel edge: a fence at a positive outer sequence with no slot zero must not leave `boundary=-1`; preserve null until genuine contiguous coverage exists. Full `inspectCreatorAuthorSettlementAdvance` current/successor ACL and adjacency validation still needs production invocation. Returning-member recovery still must consume successor-authenticated admission without retroactive predecessor writer authorization. Real cleanup/pruning, bounded scans, remaining lifecycle rebind work, all complete test/static/build/isolated gates and final review remain outstanding.

The accepted new snapshot oracle is tests-only: no production projection/fold ordering change was made or inferred. No public API, wire/schema, dependency, crypto, operation/state/epoch/snapshot ceiling, timeout, archive behavior, maxEpochVertices or f5b0y implementation was changed.

Root instructed a stop after the attributed result and is handling the observer correction and one read-only Fable-high cleanup ownership consultation separately. This agent invoked no reviewer, Fable, subagent or campaign. Only this sealed evidence directory is authorized for the evidence-only signed commit; the inherited seven-file production patch must remain uncommitted and untouched.
