# Parent f5b corrective RED — rejected matrix, stopped without rerun

Base: signed/pushed `97ac13ca4202ee164c2d0274698643f6818dc2a5`.
Tests-only commit: signed/pushed `c1d04d31149cd4ed1e8631203213df99852036a2`.
The sole focused execution ran only after signature, origin equality, clean
tracked worktree and exact frozen test hashes were verified. The matrix SHA-256
is `c1684ee00074b694c0f2d07445d2a8bc1d1be65f4bae7399e87dff7e9cd2d1b4`.

## Verdict and exact result

`REJECTED_MATRIX_STOPPED_NO_RERUN`. This is immutable diagnostic evidence,
not accepted parent RED, not production GREEN, and not authorization to edit
production or broaden a threshold. No focused rerun, test edit after the run,
campaign, long workload, reviewer, Fable consultation or subagent was used.

The reporter has 43 total tests: 26 selected and 17 explicitly title-filtered
existing f5b0u/f5b0w tests. Selected results are 23 failures and three passes,
with zero top-level errors and no timeout, loader failure or extra soft failure.
Counts match the freeze; one failure identity does not:

- 19 genuine smaller-room continuations fail only with
  `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED`, wrapping exact
  `creator close actor failed: CERTIFIED_VALUE_MISMATCH`.
- The wide-room test instead fails in 34.959291 ms with exact
  `TypeError: canonical value exceeds item limit` at
  `examples/v3-room/src/index.ts:1421`, `migrationInviteAuthority()`, called
  unconditionally by `createV3RoomSessionOwned()` at line 1647. It never opens
  the 64 sessions or reaches its first close. It cannot count as a 64-writer
  proof, and the unexpected token cannot be relabeled after the freeze.
- The non-hold public callback actually throws the manual-review TypeError;
  the causal failure is `F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED`. The test
  reaches its no-durable-hold and no-migration assertions first.
- Closed rehearsal and activation reach exactly
  `F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED` and
  `F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED` after proving prompt refusal,
  zero effect delta and byte-exact held-plan/lineage/outbox custody.
- The unchanged complete v1 issue/close/adopt/cold-reopen/issue/stale-floor
  control passes (1478.038833 ms), legacy reentry-guard source custody passes,
  and closed issue precedence passes. The v1 test body/tail was independently
  compared byte-for-byte with the base before the tests commit.

## Read-only attribution and required root disposition

The accepted fixture creates its invite through the real
`createV3RoomCreatorInviteMaterial()` with a canonical version-3 64-member ACL,
one creator and 63 ordinary writers. Its genesis ACL cap, signer set,
parameters and signatures are unchanged. The room then decodes that ACL again
inside migration authority extraction, using a hard-coded `maxItems: 512`.
`migrationCreatorAuthor()` has the same 512-item ACL decode immediately beside
it. The protocol-v3 version-3 decoder instead uses the already-accepted
`SETTLEMENT_MAX_CANONICAL_ITEMS = 8192`, and its member cap is 256.
This exposes a room decoder-parity obstruction to the accepted 64-writer
composition. It is not evidence of noncontiguity, device-local-plan authority
insufficiency, admissionEpoch insufficiency, or anchor-fence failure.

Root must decide and freeze the disposition before any successor execution.
This agent did not change either decoder, increase any ceiling, fabricate an
invite/checkpoint, shrink the writer count, exclude migration authority, remove
the wide test, or repair/rebaseline its token. No new public API appears
necessary from this read-only attribution, but no production change is
authorized by this rejected run. Exact source excerpts are in
`source-attribution.json`.

## Authored reviewer-correction mapping (post-codec continuations unexecuted)

All changed source files are tests only:
`tests/phase-6b-d110c-0c1f5b-integration-red.test.ts` and
`tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts`.

| Review obligation | Authored executable oracle |
| --- | --- |
| Case 1 | `delayedDependency()` issues distinct adjacent sequences serially, pins the real signed dependency, delivers only n+1 through ingress, checks both absence from the real close graph and exact prefix checkpoint, then checks two real plan links and next-close advancement. |
| Case 12 | Separate stale-only `creatorFenceScan(false, true)` delivers a signed high-slot fence with m equal to the authenticated prior boundary; it cannot bridge the unknown slots. Large valid, m>f and duplicate controls remain separate. |
| Case 17 | `nullBoundaryClose()` performs genuine revoke/close/adopt/grant/close/adopt, leaves the re-admitted writer offline with no current fence or slot 0, then demands a successful null-preserving close. Separate source custody pins the exact legacy priorless reentry guard. |
| Case 22 | The original segmented-progress scenario pins the real creator genesis sequence-0 non-fence row, its real close-set membership, exact creator frontier and all genesis admissionEpoch values. |
| Case 25 | Every committed/neither fence/replacement and failed-read recovery outcome counts exactly one surviving sequence/digest outbox mark and network envelope, alongside the existing row/link/lineage/owner/retry/disposition/application assertions. |
| Universal writer accounting | `accountEpoch()` checks every author in all four epochs: exact durable scope/revision, plan write before fence, exactly one fence commit/publication before ordinary issue, no duplicate, and exact atomic effect revision increments; six selected replacement links remain required. |
| Exact canonical state/history | Preserve final unsorted product bytes across creator cold reopen, exact authority, and no new issue/publication accounting; retain semantic digest. Transparent real close-commitment observation checks the complete application/control digest set, exact signed byte charges, close-set root/count and exact history growth/root. |
| Rollback/prune | One Superseded generation after adoption 1, exactly two after 2 and 3, bounded total census; no deleting prefix before the full window has older history, positive deleting receipt and authenticated cleanup proof only at the third adoption. Creator-copied AHE custody remains explicitly creator-side evidence. |
| `openProgressSources` | Genuine segmented replacement/fence then genuine terminal checkpoint, retained unlinked source, cold reopen and preserved prefix plus completed suffix; source custody rejects the existing unconditional undefined-frontier call. No checkpoint/context is injected. The run stops before this branch and does not claim runtime reachability yet. |
| Case 11 / f5b0w continuation | Hold durability across close and cold reopen; genuine author-wide revoke and re-admit empties old-incarnation held entries, without claiming moderator approval or introducing a resolver. |
| Timeout concern | Independently attributable tests replace the old all-cases aggregate. The unchanged 60000 ms wide-fixture watchdog is not a performance threshold. The routed-application causal oracle now uses at most 256 real readonly IDB scheduling rounds, not a wall-clock timeout. P2 prompt checks retain the accepted 256-microtask oracle. No completed GREEN duration is claimed. |
| Parent P2 provenance | Existing genuine single-generation migration fixture, non-hold application callback throws the exact public TypeError; generic activation-failure mapping is required without specifying/exporting a new API. |
| Parent P2 closed precedence | Existing held fixture plus valid rehearsal-derived activation input; issue/rehearse/activate all require the existing closed-session error and no effects after orderly close. |

The original one-room 64-writer/four-epoch workload, 256 baseline real
operations, six displaced operations/replacements, rotating eight-writer
cohorts, three close/adopts, creator restart, peer reopen and final cold reopen
remain executable code without a synthetic authority shortcut. The new runtime
failure proves this entire continuation is still blocked at its earliest room
decoder, not that the continuation passed. Activation-owner query isolation
remains a bounded hybrid realm; true multi-context retained validation belongs
to D.110c-d. The later >=100-transition same-room campaign is not run or claimed.

Case 5 retains the already-closed f5b0s missing-plan/already-fenced store
conformance ownership; no duplicate primitive test or new public resolver is
added. Codec cases 18 and 26-27 and interrupted-adoption contracts retain their
existing closed owners. Superseded f5b0/f5b0p/f5b0q grammar was not consulted.

## Preflight and custody

Lint, formatting, collection and diff checks pass. Source-mapped typechecking
of both changed files has zero target diagnostics and exactly the same three
inherited `live-snapshot.ts` diagnostics (2741 at 85, 7006 at 277, 2322 at 284);
this is not advertised as a repository-wide typecheck pass. Preflight artifact
commands record both selected and full listing. Accepted design, causal RED,
parent review and final f5b0w review manifests validate with 3/11/14/15 entries.
All 27 stashes and protected/untracked paths remain untouched. The final
manifest excludes itself and covers this rejected evidence packet recursively.
