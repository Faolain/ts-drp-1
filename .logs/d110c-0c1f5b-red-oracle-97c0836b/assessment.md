# Parent f5b same-parent oracle consistency RED

`ACCEPTED_CAUSAL_ORACLE_CONSISTENCY_RED`. Signed/pushed tests-only commit
`97c0836bd92f2f045534852c991824fb9529b71c` follows root's signed disposition
`43141513af2549ff60b7791c748eb75ec70247d1`. Only the two existing parent test
files and one tests-only snapshot oracle helper changed. No runtime preceded
the signed/pushed tests commit.

## Exact isolated outcome

The sole focused execution in a fresh detached, independently installed and
source-built checkout matches the frozen **45 total / 28 active / 23 failed /
5 passed / 17 filtered** matrix with zero violations. The pre-frozen matrix
SHA-256 is `9136cfefc84c292c4365ee18a3adac3ee83a7c672f0f96d969e8cf74ad788cd9`.
The original 26 selected cases retain their exact expected status/token entries:

- Nineteen `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED` failures.
- One exact `canonical value exceeds item limit` failure owned by
  `migrationInviteAuthority` in the genuine 64-writer case.
- Three P2 failures: `F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED`,
  `F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED`, and
  `F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED`.
- Three original controls pass: complete genuine v1 continuation, legacy
  reentry-guard custody and closed-session issue precedence.

Both added pure oracle controls pass. No loader/import/export, malformed
blueprint/invite, application-state ceiling, top-level, timeout, count/token or
changed-control anomaly occurred. `execution-start.json` records the complete
command, pushed ref, signature, start and matrix hash; `focused.json` is the
full raw reporter and `result.json` records every selected outcome. No rerun or
post-run test edit occurred.

## Snapshot-state oracle correction

The wide test preserves the separate semantic/accounting comparison of the
pre-close migration-export view. It no longer treats that view's ordering as
the authoritative snapshot ordering. Expected snapshot bytes come only from
genesis empty state followed by the previously independently verified state and
the current genuine signed graph, never from snapshot bytes or a production
graph projection, linearizer, fold or reducer output.

The helper traverses raw frontier ancestry and requires complete raw coverage;
it reconnects dependencies through settlement fences/joins/causal joins,
removes redundant ancestor edges, then performs minimum-hash Kahn ordering on
that projected graph. ACL vertices remain ordering participants without chat
state effects. Each signed application batch stays atomic and preserves entry
order. Every message appends, including identical operation identities and
effects; there is no deduplication.

For each of the three real closes, the test independently verifies signed
commit digests/signatures, exact captured graph dependencies/operations and
vertex identities, complete graph keys and full frontier ancestry. It compares
expected application bytes to the actual snapshot-transfer encoder's returned
payload chunks and checks object/epoch/anchor and state digest, then retains
exact cut digest, adopted-state and restart-state comparisons. The actual
snapshot observation is transparent: it calls the real encoder unchanged and
records copies of input/result; it supplies no authority or expected state.
Raw close-set/history, authenticated byte charges, writer identities and
accounting remain separate and unchanged.

The two pure known-answer witnesses, neither used as room material, are:

- Valid raw graph with control paths `85 → 05 (ACL) → 90 → 80 → 00` and
  `95 → 80 → 00`, message A at `10` depending on incomparable `85,95`, and
  message B at `20` depending on anchor `00`. Raw minimum-hash Kahn order is
  `00,20,80,90,05,85,95,10`, so post-order filtering would yield B,A. Control
  removal first expands A's dependencies to `05,00`, reduces them to `05`, and
  yields exact projected order `00,05,10,20` and state A,B. The test pins the
  complete projected dependency map and complete raw ancestry.
- An unchanged prior `[dup]`, one same-effect message, an atomic batch with
  entries `[z,dup]`, and a following tail yield exactly
  `[dup,dup,z,dup,tail]`, not a sorted, interleaved or deduplicated result. The
  test pins bytes, vertex order and unchanged prior bytes.

Open epoch 3 is not a fourth snapshot. Its final 262-message live projection,
state ceiling, authority, issue/publication accounting and exact cold-reopen
tail remain byte-identical. All 64 writers, four contributing epochs, six
displaced sources and three-close/offline/rejoin/restart composition remain.
The pure controls pass, but the genuine post-codec wide continuation is still
a GREEN obligation and is not relabeled as a RED pass.

## Rollback and retained seal consistency

The rollback census now requires exactly two immediate complete Superseded
physical ancestors plus the active generation after a successful real
authenticated cleanup plan and physical census. It no longer infers physical
generation count from logical epoch count. Existing closure/digest linkage,
pruning, availability, outbox and authenticated boundary assertions remain.
The pruning helper call loses only the obsolete logical-epoch argument, and
its explanatory comment now distinguishes physical custody from deletable
issuance prefixes; its safety expectations do not change.

Both retained f5b0w seal controls now require genuine successful
`{ok:true,lifecycle:'successor-pending-adoption'}` results and exactly one
close-owner call. The held case retains prompt close-owner reachability and
exact before/after durable manual-review custody. The prior obsolete
`CERTIFIED_VALUE_MISMATCH` expectations remain immutable in historical evidence.
These two controls remain among the 17 filtered runtime tests for this frozen
RED; they must execute in the complete retained GREEN selection. No successful
retained seal run is claimed here.

## Gates and custody

The isolated checkout is `/private/tmp/d110c-f5b-oracle-red-DlOSng/checkout`.
It reuses the accepted sparse-checkout/independent frozen offline install/full
`build:packages` machinery with no dirty production overlay or copied dist.
All builds, changed-file and isolated lint/format, complete/selected collection
and exact tests-only diff checks pass. Source-mapped typechecking has zero
target diagnostics; the same three external `live-snapshot.ts` diagnostics
remain (TS2741 line 85, TS7006 line 277, TS2322 line 284). This is not a
repository-wide typecheck pass.

Before/after custody pins all seven dirty production hashes to the prior
stopped GREEN and all 27 stashes unchanged. Thirty-two protected functions are
checked exactly, with only the authorized pruning call/comment normalization;
the accepted case-25 function and open epoch-3 final accounting tail remain
exact. Isolated source and built runtime hashes remain unchanged at the signed
tests commit with a clean tracked checkout. Main-checkout changes remain only
the seven pre-existing production files. Root owns plan/frontier acceptance.

Precommit authoring diagnostics are preserved in custody: one import-order
lint error and five missing JSDoc tags were corrected; the first read-only
source-boundary checker was corrected to recognize the authorized pruning
call/comment change. No runtime was consumed. Root's read-only precommit
feedback strengthened explicit seal success and changed the pure witness to
valid incomparable dependencies before commit, without adding tests.

No production source, API, wire/schema, application fixture, dependencies,
cryptography, resource/state/time limits, f5b0y, protected untracked paths or
immutable evidence changed. No reviewer, subagent, Fable, long workload or
campaign was invoked. Snapshot/view ordering, physical-generation counting and
obsolete retained terminus expectations are prospectively corrected; remaining
readmission, segmented admission and production GREEN defects are not claimed
closed. No new causal or pure-oracle contradiction was found.
