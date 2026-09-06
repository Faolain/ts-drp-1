# Parent f5b corrective RED — accepted exact causal matrix

Verdict: `ACCEPTED_CAUSAL_CORRECTIVE_RED`. The fresh invocation exactly
reproduced the prospectively authorized matrix, including complete failure
messages and stacks, with no violations. This packet does not reclassify or
overwrite the rejected invocation.

Execution HEAD is signed/pushed
`fff5f0b5527a6c5c251472772afc1e2c5e3714d9`; unchanged tests-only commit is
signed/pushed `c1d04d31149cd4ed1e8631203213df99852036a2`. The Current frontier
and parent record's latest disposition at that HEAD authorize this one fresh
same-tests-commit invocation. The preflight completed and froze matrix SHA-256
`ae88bb15536be405f7a15f3d00730448f8c9196486f759626665e4f6a2fd84a3`
before execution started at `2026-09-05T15:16:14.550Z`; validation completed at
`2026-09-05T15:16:28.348Z`.

## Exact result and causal attribution

The unchanged focused non-long command in `execution-start.json` ran exactly
once. Runner exit status is 1, as required for RED. There are 43 reported tests:
26 active across the same two files, exactly 23 failures and three passes,
plus the same 17 explicitly filtered existing tests. `matrix.json` enumerates
every selected and filtered name; `result.json` records each observed outcome.

- Nineteen smaller-room continuations fail at the genuine creator close with
  exact `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED`, identifying
  `CERTIFIED_VALUE_MISMATCH` before checkpoint production. Their exact test
  paths/stacks match the prospective freeze. They do not establish that the
  post-codec assertions have executed.
- The genuine 64-writer composition fails only with exact
  `TypeError: canonical value exceeds item limit`, at
  `migrationInviteAuthority()` in `examples/v3-room/src/index.ts:1421:14`,
  called by `createV3RoomSessionOwned()` at `:1647:26`. The room's private
  latched-ACL decode uses `maxItems: 512`; adjacent `migrationCreatorAuthor()`
  repeats that ceiling. The closed protocol-v3 settlement profile instead uses
  `SETTLEMENT_MAX_CANONICAL_ITEMS = 8192` for version 3 with member cap 256.
  This is the diagnosed missing room-profile composition seam, not malformed
  fixture input, writer-count reduction, maxEpochVertices pressure,
  admissionEpoch insufficiency, device-local authority, noncontiguity, an
  anchor-fence failure, or a new public-API question. The wide test terminates
  during bootstrap, before opening the 64 sessions or its first close; it is
  not a completed 64-writer proof. Both existing private helper limits are
  parent GREEN ownership, with legacy profiles unchanged.
- One genuine non-hold callback collision fails only with
  `F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED`, after the test has established
  the actual application error and absence of a durable hold/migration.
- Closed rehearsal and activation fail only with
  `F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED` and
  `F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED`, respectively, after prompt
  refusal and exact no-effect custody assertions.
- All three controls pass: the complete unchanged v1
  issue/close/adopt/cold-reopen/issue/stale-floor control, exact legacy v1
  reentry-guard source custody, and closed issue precedence. The complete v1
  test tail is independently byte-identical to the pre-correction base.

There are zero extra soft failures, timeout failures, loader failures or
top-level errors; stderr is empty. The 60,000 ms wide-fixture watchdog,
256-round real IDB scheduling bound, and accepted 256-microtask prompt oracle
are unchanged. No timeout increase, rerun, campaign, production change,
reviewer, Fable consultation, or subagent was used by this evidence agent.

## Preflight and custody

Exact signature/origin checks cover HEAD and both ancestor commits. The
tests-only commit changes exactly the two listed test files; source, tests,
configuration and dependency paths have no delta from that commit to HEAD.
Lint, formatting, selected/full listing and diff checks pass. Source-mapped
typechecking has zero target diagnostics and exactly the same three inherited
`live-snapshot.ts` diagnostics: 2741 at 85, 7006 at 277, and 2322 at 284.
This is a zero-delta targeted result, not a repository-wide typecheck pass.

All 6,406 tracked-file SHA-256 values, two relevant loaded runtime artifact
hashes, 27 exact stash identities, and 86,510 existing untracked paths are
unchanged in before/after custody. No test, production, project docs, API,
configuration, timeout or dependency file was edited. Only this fresh evidence
directory is added. Accepted design, earlier causal RED, parent review and
final f5b0w review manifests are revalidated at sealing.

Rejected evidence commit `e9015cff673b070b672571e3064517dd542d45b7` remains
immutable at `.logs/d110c-0c1f5b-red-corrective-c1d04d31/`. Its 16-entry
self-excluding manifest remains
`acc11788eb3fafcc358fb6178fc8bdecc3740d9c97653163d51d6032016eedad`.
The fresh packet has its own self-excluding SHA-256 manifest.

No production GREEN, completed successor continuation, genuine checkpoint-
derived open-progress reachability, completed 64-writer transitions, retained
multi-context result, or >=100-transition same-room campaign is claimed.
The rejected coverage-correction packet and tests commit remain the detailed
authored-oracle mapping; this packet establishes only their accepted causal
RED execution under the corrected prospective matrix.
