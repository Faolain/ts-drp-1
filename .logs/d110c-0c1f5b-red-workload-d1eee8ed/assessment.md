# Parent f5b bounded-workload RED

`ACCEPTED_CAUSAL_WORKLOAD_RED`. Base is signed/pushed
`a6a3f738f9fbe760c86b5231c93dedbb157a3c52`; tests-only commit is signed/pushed
`d1eee8ed48209c6ad3cfc07872984b4f94667cbb`. The sole focused run began only
after signature, remote equality, clean tracked worktree and all three frozen
test/helper hashes were checked. Its pre-frozen matrix SHA-256 is
`2820d4180b093eab0ff6ac24133cf554a9edac44641bc069f67feb2d09087c99`.

## Exact outcome

The 43-test reporter contains 26 active tests and 17 explicitly filtered
existing runtime tests. All 26 selected statuses and failure identities match:

- Nineteen genuine smaller-room continuations fail with
  `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED`, wrapping the unchanged
  `creator close actor failed: CERTIFIED_VALUE_MISMATCH`.
- The 64-writer test fails with exact `canonical value exceeds item limit`
  from the unchanged `migrationInviteAuthority()` owner, as explicitly frozen
  by the accepted corrective RED. This is not relabeled as a 64-writer pass.
- The three expected P2 failures remain
  `F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED`,
  `F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED`, and
  `F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED`.
- The exact unchanged v1 issue/close/adopt/cold-reopen/issue/stale-floor
  control, legacy reentry-guard custody, and closed-issue precedence pass.

There are 23 failures, three passes, zero matrix violations, zero loader,
missing-import/export, malformed blueprint/invite, application-state-ceiling,
top-level, timeout, additional soft failure or changed-control anomalies.
`focused.json` is the full raw reporter; `result.json` records every selected
outcome, duration and failure message. No focused rerun or post-run test edit
was performed.

## Workload construction and bounds

Every non-case-3 consumer of the parent `openRoom()` append-only chat fixture
now uses the same deterministic 256-character recovery text. Its exact effect
expectations are updated, including cases 1, 4/15/16/19 and the wide proof;
cases 24a and 25 inherit the same bounded fixture. Their operation counts,
publication/admission/plan/fence/replacement predicates and 64-writer
four-epoch/three-close/offline-rejoin/restart/cold-reopen composition remain.
The actual final canonical wide state is explicitly required to fit within
the unchanged 32,768-byte ceiling. Its unchanged exact 256 ordinary and six
transformed final messages model to 14,303 canonical bytes.

Case 3 alone selects the new local `f5b-transient-payload.v1` artifact under
`tests/fixtures/phase-6b-d110c-0c1f5b/`. The message/applicationBatch ABI and
manifest ceilings are unchanged. Large deterministic `text` bytes are real
signed operation payload, but both the reducer and application projection
retain only operation identity, not that transient padding. The catalog,
artifact digest, package bytes, package digest and creator invite are all
coupled; the real room validates the new package rather than substituting an
activation result or rewriting a product snapshot. Runtime preconditions
before the accepted codec failure pin the exact local package/invite binding,
real two-intent source and canonical payload inequalities.

The pure local-artifact preflight loads the checked-in canonical source through
the workspace TS loader and measures the actual authored reducer:

| Value | Canonical bytes |
| --- | ---: |
| First transformed operation | 33,061 |
| Second transformed operation | 33,061 |
| Two-intent application batch | 66,237 |
| Exact reducer state for those two intents | 108 |
| Modeled final case-3 state | 536 |
| Modeled final wide state | 14,303 |

Each transformed operation is below 65,536 bytes, their batch is above
65,536, and retained state is below 32,768. This resolves the fixture's prior
incompatible append-only chat stimulus without raising any limit. This pure
reducer smoke/bound calculation is not a second focused room run or evidence
that post-codec continuation has completed.

The authored continuation still demands real multiple replacement chunks and
a committed-prefix crash. It now explicitly restarts in the same epoch while
the suffix fault remains armed, proving exact partial plan/state custody and
one prefix issue/publication, then closes between epochs and recovers later.
It checks exact transient bytes in both committed chunks, no prefix reissue,
once-only suffix issue/publication, one bounded state effect per intent and
the retained `F5B_C14_THREE_TRANSITIONS_AND_COLD_REOPEN` predicate. These
post-codec requirements remain unexecuted in RED and belong to fresh GREEN.

## Preflight and scope

Lint, formatting, complete/selected collection and source-mapped typechecking
pass. Both parent test files and the new helper have zero target diagnostics;
the only external diagnostics are the same inherited three `live-snapshot.ts`
items (2741 at line 85, 7006 at 277, 2322 at 284). This is not claimed as a
repository-wide typecheck pass. Source-shape checks pin the unchanged v1 body,
unchanged previous runtime file, byte-identical parameters, unchanged timeout,
case-3-only large transform, actual wide-state ceiling assertion and case-14
predicate. The two initial authoring diagnostics (unnecessary synchronous
catalog awaits and an unannotated helper input) were corrected before freeze
and consumed no runtime run.

The first evidence calculator invocation mistakenly imported the workspace
package name from a root that only resolves it under aliases. That read-only
invocation failed before any focused run. `preflight-diagnostic.json` preserves
the exact error and root's disposition; only the calculator was corrected to
load checked-in `packages/canonical/src/index.ts` using `node --import=tsx`.
No dist artifact, Vite alias, product edit or test-semantic correction was used
to fix that diagnostic. `bounds.json` records the successful source calculation.

No production file, public API, wire/schema, dependency, cryptography, resource
ceiling, timeout or immutable evidence was changed. No campaign, long workload,
reviewer, Fable consultation or subagent was invoked. All 27 stashes and
protected untracked paths remain. Existing decoder/frontier/provenance seams
are still RED; no new design/code contradiction was found. D.110c-0c1f5b0y is
untouched, and this fixture proves no production Discord admission-safety or
long-horizon claim. The only authorized follow-up is the separate fresh parent
GREEN under its existing plan.
