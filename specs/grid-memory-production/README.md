# Native-browser retention characterization

The fake-IndexedDB grid campaign identified retained storage, but cannot establish browser quota, physical storage, or production memory safety. This investigation keeps those questions separate and makes no production changes.

## Next Agent Prompt

Updated 2026-09-07. The reviewed end-to-end investigation has a negative verdict: current cleanup does not bound all persistent history, and transfer expiry can remove a snapshot required for cold recovery. Preserve the [canonical lifecycle audit and native evidence](lifecycle-audit.md). The user has now authorized production-sensible bounded-lifecycle implementation: continue in the [bounded storage lifecycle plan](../bounded-storage-lifecycle/README.md), whose reviewed recovery/retirement gates precede additional deletion or scale. This folder remains the historical characterization, not the implementation authority.

- [x] [Native browser baseline](slices/01-baseline.md)
- [x] [Mixed-cohort expiry](slices/02-expiry.md)
- [x] [Recovery after reclamation](slices/03-recovery.md): retained control succeeds; required-snapshot expiry rejects.
- [x] [Whole-storage lifecycle and fixed-state counterexample](slices/00-lifecycle.md)

These checks complete the characterization, not production acceptance or a cleanup implementation.

## Ownership and interpretation

The existing product browser fixture owns genuine creation, issuance, adoption and reopen behavior. Its server builder must have one shared test-only owner, consumed by both regression and diagnostic tests. Native-storage mode must never install a quota stub; legacy fault tests retain their explicit fixture behavior. Avoid retaining fault traces in the baseline. Existing process-forest helpers own process identity and closure observations.

Quarantine maintenance remains owned by the production store. Tests call its sweep or openScope entry points, never delete its rows to simulate maintenance. The existing expiry fixture owns clock control and must restore it in finally. Logical row bytes, native origin usage, renderer heap and process RSS are separate observations; census happens after heap sampling and returns aggregates only.

The legacy chat baseline and fixed-state settlement characterization are distinct consumers of these seams. Pending-adoption expiry remains deferred at the demonstrated stable-successor availability boundary. Browser-process cold reopen uses the same persistent profile and origin, never database export/import.

No memory ceiling, plateau requirement, deployment topology, history-pruning rule, or retention-policy change is inferred. No 1,000-epoch execution or grid-equivalence claim is in scope. These are machine-readable diagnostic artifacts, not visual UI work.

The existing three-generation guarantee covers physical AHE lineage, not every database or every epoch. The legacy browser baseline does not activate settlement cleanup. Keep it distinct from a fixed-state, settlement-enabled diagnostic using the real grid application and the same authenticated cleanup owner as the prior 60-transition fixture.
