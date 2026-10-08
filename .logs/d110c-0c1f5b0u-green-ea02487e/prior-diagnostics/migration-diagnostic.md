# Bounded GREEN diagnostic — not acceptance evidence

Baseline: signed/pushed `a787b6490ccbf844ec07d464ef4a726ac950f0e0` plus
the in-progress combined GREEN. No tests were edited. The 27 stashes remain.

Initial affected package builds and room build passed. The first focused run
of the frozen four-file set (67 tests, no file parallelism, coverage disabled)
returned 66 passed and one failed in 11.26 seconds. The only failure was
`queues migration rehearsal behind startup recovery without a nested lifetime-tail deadlock`:
public issue fulfilled but migration rejected. All three real signed failure
recovery vectors, creator-close rebind/failure, strict store and readback
vectors passed.

To expose the caught reason without editing either production or tests,
`diagnostic.workspace.ts` adds a single in-memory observer after the existing
`Promise.allSettled([issued, migration])`. This is a diagnostic configuration,
not a passing gate or a permanent runtime change.

Command:

```
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts --workspace .logs/d110c-0c1f5b0u-green-working-a787b649/diagnostic.workspace.ts -t 'queues migration rehearsal' --coverage.enabled=false
```

Observed result (2026-09-05 00:43:59 local): exit 1; one selected test failed,
eight skipped; 4.27 seconds. The exact caught reason was:

```
TypeError: v3 room migration state is unbounded
    at normalizeApplicationStateBytes (examples/v3-room/src/index.ts:591:44)
    at normalizeProjection (examples/v3-room/src/index.ts:3624:24)
    at performMigrationRehearsal (examples/v3-room/src/index.ts:3646:28)
    at examples/v3-room/src/index.ts:3847:15
```

The fixture creates two 33,000-byte messages, exceeding the unchanged 32,768-byte
migration application-state cap before it reaches the 49,152-byte record cap.
Its unkeyed mock room-head authority also cannot preserve independent source
and scratch-target floors. Neither is a recovery deadlock. Production edits
paused pending parent disposition. No threshold or test expectation was changed.

Proposed tests-only correction: retain every large split/fault control unchanged;
use a separate bounded-state migration control with a real signed legacy
replacement lost-receipt seam and per-object room-head authority custody. Require
both rehearsal and activation to fulfill; do not weaken success to arbitrary
rejection.
