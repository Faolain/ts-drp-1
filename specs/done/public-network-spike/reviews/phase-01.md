# Phase 01 Review: Deterministic Probe Kernel

Phase 01 adds the private probe runtime, strict telemetry contract, address
policy, deterministic all-refused relay fixture, CLI replay, and browser
evidence workbench preserved by the [closed decision record](../README.md).
Ordinary verification remained offline.

## Adversarial review

Both required reviewers ran read-only with a maximum budget of 100 turns or
steps. Initial passes rejected the phase and drove the following corrections:

- IPv4-compatible, mapped, translated, 6to4, NAT64, and deprecated IPv6
  embeddings now inherit the embedded IPv4 scope. DNS family mismatches,
  rebinding answers, local-use NAT64, and deprecated site-local IPv6 are denied.
- Throwing clocks, timers, resource samplers, event validation, cleanup, and
  observation sinks become typed outcomes. A sink failure on the terminal row
  cannot escape as success.
- Malformed probe results and failure codes are rejected. Probe events,
  deferred cleanups, identifiers, and protocol lists are bounded.
- Cleanup uses one aggregate deadline and abort signal. External cancellation
  stops probe work without pre-aborting teardown; timeout and external-abort
  paths both prove cooperative cleanup and zero runner timers.
- Runner-owned lifecycle rows cannot be forged. `emit` and `defer` close as soon
  as the run race settles, and the returned ledger is a frozen copy containing
  deeply frozen events. A non-cooperative post-timeout probe cannot append after
  `terminal` or call the sink.

Final verdicts on the stable, freshly built tree:

- Grok session `019f7f24-e7c4-7120-9d0b-1f5d02eb2ee1`: `ACCEPT`.
- Kimi session `b4affd66-7cdb-4ae0-95e3-6fa4c20eb8a8`: `ACCEPT`.

No blocking or high finding remains.

## Browser and visual evidence

The all-refused fixture renders 30 sanitized, replayable rows ending at
1,526 ms. Chromium instrumentation observed no application console errors or
warnings, a 1.1 ms initial render measure, and no horizontal overflow at a
390 px viewport. Filtering, the terminal outcome, and JSONL replay were
verified in Chromium, Firefox, and WebKit.

The first screenshot review rejected an accidental 152 px browser capture and
weak mobile/crop framing. Explicit desktop and mobile captures replaced it;
labels, terminal hierarchy, responsive navigation, and crop boundaries were
corrected. A fresh unprimed screenshot review returned `ACCEPT` with no
blocker, high, or medium findings. Sanitized evidence is under
[`evidence/phase-01`](../evidence/phase-01/).

## Profiling

The final Node CPU profile/flame-chart capture ran 5,000 deterministic replays
and serialized 150,000 events in 904.125 ms with 638 samples. Zod parsing was
the dominant sampled work; `deepFreeze` accounted for 33 samples and JSONL
serialization for 56. The raw Chrome CPU profile remains ignored under
`.network-spike-raw/` because profiling output is not durable public evidence.

## Verification

- Focused package typecheck, lint, and both package/example builds passed.
- Focused Phase 00 + Phase 01 verification: 4 files and 31 tests passed.
- Browser replay: 3 Playwright projects passed.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with 71 pre-existing warnings and no errors.
- Final serial `CI=1 pnpm test --run --reporter=dot`: 83 files passed, 603
  tests passed, 2 skipped, and 92.5% statement coverage.
- `git diff --check`: passed.
- Concurrent coverage runs performed during adversarial review interfered with
  Vitest's shared temporary coverage directory; they are not gates of record.
  The isolated focused rerun and final serial repository run above passed.
- No public-network request was made.
