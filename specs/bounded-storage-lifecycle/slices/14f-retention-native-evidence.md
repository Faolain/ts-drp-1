# 14f — Native evidence for single-database retirement (S6)

Status: contract draft, 2026-10-19, under the [slice 14 parent](14-single-database-watermark-retirement.md).
Evidence (Track R3): cases 1–4 pass in Chromium, Firefox and WebKit; case 10 passes on
Chromium; cases 5–9 and 11 are open. See the [evidence record](#evidence-record-track-r3-2026-10-19).
No evidence is accepted yet. The default flip in 14 depends on this slice passing.
Guarantee ids are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md).

## One question

Do the native claims of slices 14a–14e hold in real engines under real process
death: strict durability, single-transaction atomicity across the retention
stores, read-write serialisation against a foreign writer, version fencing across
tabs, and old-XOR-new after a kill at every retirement and migration edge?

Fake-indexeddb tests are mechanism evidence only ([G28](../golden-path-guarantees.md),
BSL:27-32, R2E:367-369). They cannot replace any case below.

## Engines and harness

Chromium, Firefox and WebKit, through the existing Playwright projects, with a
persistent profile per case. Use the existing three-engine process-death pattern
of [the live-journal death RED](../../../packages/storage-browser/tests/phase-3a1b-p4-browser-live-journal-death-red.pw.ts):

- a detached Node child launches `browserType(name).launchPersistentContext`;
- the page's worker posts a checkpoint at an instrumented edge, then blocks with
  `Atomics.wait`, freezing the IndexedDB operation at that edge;
- the parent kills the child's whole process group with `SIGKILL`, asserts the
  signal, and waits until every killed process is gone;
- a fresh child reopens the same profile in recover mode and asserts the outcome.

Instrumentation is test-only and cannot mint authority or change product
transitions (the trace conformance contract in the
[requirement map](../requirements-to-evidence.md#trace-conformance-contract)).

## Required cases

Mechanism cases, each in all three engines:

1. A retention read-write transaction reports `durability === "strict"`; a
   transaction that cannot be strict refuses before any write.
2. Atomicity: a retention transaction that deletes in every owner store and puts
   marks, aborted at its last request, leaves every store unchanged.
3. Serialisation: a second page's read-write transaction on an overlapping scope
   cannot interleave with a retirement transaction; its write is ordered before
   or after it, and a write below a new mark after it is refused.
4. Version fencing across tabs: page A holds the room database open at the
   current version; page B opens a higher version. A receives `versionchange`
   and closes; A's later operations refuse; code pinned to the old version gets
   `VersionError`. The same holds for each legacy database fenced by 14d.

Process-death cases, each in all three engines, each asserting old XOR exact new
per database, marks and floor fences consistent (S3), and replay converging to the
crash-free state:

5. SIGKILL inside step A (floor transaction admitted, before completion).
6. SIGKILL after step A completes, before step B starts.
7. SIGKILL inside step B (deletes issued, before completion).
8. SIGKILL after step B completes, before the caller observes it.
9. Migration (14d): SIGKILL after the room database upgrade, after the legacy
   fences, inside the copy transaction, after the copy before the legacy empty
   step, and inside the empty step.

Golden-path case:

10. The healthy native Grid run with the new path selected completes its
    rollovers, keeps every per-transition assertion, runs every recipient lull
    including the last, and passes the persisted close, the reopen and continued
    gameplay with exact recovered state (Chromium, as the existing Grid harness is
    Chromium-only).
11. A browser long room on the new path (at least 16 epochs, creator and
    recipient) holds the steady-state bounds of 14b acceptance 6 in Chromium.

## Evidence record

For each case and engine record the command, exit status, engine version, source
commit, and the asserted outcome. A case that did not run is OPEN, not passed. A
case blocked by harness failure is repaired and rerun, not reinterpreted.

## Guarantee map

This slice is the [G28](../golden-path-guarantees.md) evidence for
[G9](../golden-path-guarantees.md), [G11](../golden-path-guarantees.md),
[G12](../golden-path-guarantees.md), [G14](../golden-path-guarantees.md),
[G15](../golden-path-guarantees.md), [G16](../golden-path-guarantees.md),
[G17](../golden-path-guarantees.md), [G24](../golden-path-guarantees.md) and
[G25](../golden-path-guarantees.md) as implemented by 14a–14e, and for
[G1](../golden-path-guarantees.md) and [G3](../golden-path-guarantees.md) on the
Grid. It changes no product code.

## Stop conditions

If an engine cannot provide strict durability or cross-store atomicity within one
database, the new path stays opt-in for that engine and the parent records it.

## Evidence record (Track R3, 2026-10-19)

Stage 1a of 14a only: the room retirement session. 14b–14e are not implemented, so
cases that need their behaviour are OPEN.

| Case                                                    | Command                                                                                                                                                                                  | Source commit | Chromium 151.0.7922.34 | Firefox 153.0 | WebKit 26.5 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------- | ------------- | ----------- |
| 1–4, plus a not-ready database refused before any write | `playwright test --config packages/storage-browser/playwright.room-retirement-session-native.config.ts` (18 tests, exit 0)                                                               | 6c18b0c2      | pass                   | pass          | pass        |
| 5–8                                                     | —                                                                                                                                                                                        | —             | OPEN                   | OPEN          | OPEN        |
| 9                                                       | — (no migration)                                                                                                                                                                         | —             | OPEN                   | OPEN          | OPEN        |
| 10                                                      | healthy native Grid, 8 rollovers, `STARTUP_HEALTHY_GRID_POOL_LULL=1`, `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1` (exit 0; every recipient lull, persisted close, reopen, continued gameplay) | 981bb354      | pass                   | n/a           | n/a         |
| 11                                                      | — (no bounds assertion yet; see the Track R3 result for a 16-rollover Grid run)                                                                                                          | —             | OPEN                   | n/a           | n/a         |

Case 1 asserts `durability === "strict"` and mode `readwrite` on the session
transaction. Only the fake-indexeddb RED (`room-retirement-session-red.test.ts`)
exercises the refusal of a non-strict transaction. Case 3's "a write below a new mark
is refused" has no stage-1a counterpart, because there are no marks yet; the owners'
existing write fences are unchanged.
