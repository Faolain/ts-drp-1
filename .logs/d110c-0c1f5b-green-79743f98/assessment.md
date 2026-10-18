# Parent f5b GREEN attempt — stopped at frozen state ceiling

This is incomplete production work, not GREEN. Base HEAD remains signed/pushed
`79743f98dc0c321a5e7da7b495fec4d761630097`. No test or ceiling changed, and no
production/evidence commit was made. The root instructed a stop after the
diagnosis below; the partial diff is preserved for disposition.

## Causal blocker

The accepted parent fixture `openRoom()` transforms every displaced message
text to 33,000 ASCII `r` characters (integration test line 601). This value
already existed at accepted original RED `cecde972`, before corrective tests
`c1d04d31`. It forces two genuine replacement intents over the existing
65,536-byte application-batch budget, creating durable segmented progress.

The main continuation passes its genuine first close, checkpoint, adoption,
writer reopen, real partial-progress creation and committed-prefix assertions.
After the creator issues `creator-during-writer-crash`, the genuine second
close fails. Iteration 7's normal error is `creator snapshot export failed:
not-active`. Iteration 8 adds temporary private diagnostic detail and proves
this is a fold rejection, not stale/inactive lifecycle custody. Iteration 9
exposes the actual caught exception:

`DRPError: application value is outside the bounded canonical domain`

The stack is preserved completely in `iteration-9-tests.json`. The cause is
`packages/compaction/src/blueprint-fold.ts`'s existing
`APPLICATION_LIMITS.maxBytes = 32_768`. The chat reducer stores message text
verbatim in state and output; a single transformed message requires 33,046
canonical bytes even in an otherwise empty state. All diagnostic-only error
changes have been removed from the final partial patch. Exact public errors
are restored.

No permissible threshold/workload-preserving production fix was identified.
Contiguity, admissionEpoch, plan authority and anchor fencing are not the
cause. Raising state/batch/epoch limits, truncating or compressing exact chat
state, or changing tests would exceed the assignment.

## Measurement and prospective options (not implemented)

`bounds.mjs` uses the installed canonical codec for read-only calculations.
Its deliberately generous *measurement-only* options permit measuring the
oversized values; they change no product threshold. The first invocation had
an import-path typo and is preserved in `bounds.json`; `bounds-corrected.json`
is the successful measurement.

For the exact two `displaced-0`/`displaced-1` message shapes and logical times
3/5, 33,000-character transforms produce a 66,237-byte batch. The smallest
equal text length exceeding 65,536 is 32,650. Neither it nor any smaller value
that still triggers this byte split permits the required full two-message
state to fit 32,768 bytes. The modeled main second-close state is 33,271 bytes;
its modeled final eight-message state is 66,518. The latter fits only up to
16,126 characters per transformed message. Exact time widths can affect a
batch boundary by a few bytes, not the fundamental two-to-one mismatch.

There is no alternative existing chat message shape with transient padding:
its closed schema is exactly action/clientOperationId/text, and both variable
strings persist in the reducer's state and output. `applicationBatch` contains
at most 16 source intents; the existing per-intent transform returns one
same-action, same-identity operation, so the count limit cannot turn a valid
source into more than 16 replacement intents. Reserved join/fence operations
are not application replacement intents. A compact-state, transient-payload
blueprint would need a separately authorized fixture/application design; it is
not an existing chat operation workaround.

The wide proof does not need a multi-intent split: it displaces two independent
single messages per transition. Its exact 262-message final state (256 ordinary
messages and six transforms) measures 210,773 bytes with the frozen text. With
256-character transforms it would be 14,303 bytes; the maximum equal transform
length for those exact IDs is 3,333 characters (the bound is state bytes, not a
claim that any unexecuted end-to-end gate passes). A prospective correction
could use small deterministic transforms for wide continuity while separately
reslicing the real cross-close segmented-progress proof. No such change is
authorized or made here.

## TDD progress, limitations, and partial source custody

- Iteration 1, full 26-active matrix: 6 pass / 20 fail. All three P2 cases
  pass; the legacy v1 and source guards remain green. Every settlement
  continuation progresses to the legacy-carrier/TRUST_CLOSURE_INVALID boundary.
- Iteration 2, four selected cases: 2 pass / 2 fail, real settlement checkpoints
  now emitted; activation fails at missing historical settlement custody.
- Iteration 3: 2 pass / 2 fail, next boundary is cold predecessor ACL profile
  reconstruction and later predecessor issuance recovery.
- Iterations 4–6 are bounded diagnostic runs preserving every command/report.
- Iteration 7, three selected cases: 2 pass / 1 fail. Largest-valid-fence scan
  and authenticated null-boundary removal/regrant/three-close path pass. Main
  checkpoint-terminal progress reaches the state-ceiling blocker.
- Iterations 8–9 preserve the causal fold diagnostic, one selected failure each.

The partial work changes seven production files: protocol creator-close and
creator-checkpoint; Node creator-close, creator-adoption, private
creator-transition-advance and v3-live; room index. It carries the profile
through successor records and private ACL consumers, implements profile-only
checkpoint/fence scanning, starts authenticated frontier recovery threading,
and fixes private hold provenance plus closed migration precedence. Root
explicitly accepted the private creator-adoption profile threading as in scope.

The patch is **unfinished and unreviewed**. In particular: authenticating and
invoking the full adjacency predicate; complete frontier/partial-progress and
incarnation recovery; creator cold-reopen close rebinding; genuine pruning and
bounded rollback generations; bounded scan accounting; the full 64-writer
continuation; retained/source-shape/static/build/typecheck/lint/format/isolated
gates remain incomplete. The final partial diff has not been formatted or
typechecked and may contain ordinary static defects. Do not promote it.

The pruning audit additionally found the existing `planClosedEpochCleanup`
issuance gate accepts only published rows whose epoch equals the closing
epoch. Root authorized a settlement-only, truthful private adaptation, but no
cleanup-gate or caller change was made before the state-ceiling stop. No new
API, public input, dependency, cryptography, wire, threshold or timeout exists.

The root owns reslice/disposition. No full GREEN, completed 64-writer proof,
isolated checkout, signed production commit, evidence commit, or formal review
is claimed. All 27 stashes, tests and immutable prior evidence remain protected.
