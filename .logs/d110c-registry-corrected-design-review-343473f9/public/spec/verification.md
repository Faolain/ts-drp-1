# Verification contract

This candidate is not execution permission or a pass log.
[gate-plan.mjs](./gate-plan.mjs) emits commands from the inventory without
executing them. Freeze its emitted bytes with the corrected design review.
Stage custody binds command, cwd, environment, sources, timestamps, status,
raw logs and process-group termination. Run serially with reviewers stopped.
Ceilings stop a run; they do not authorize retries. Review a changed experiment
before repeating an unexpected terminal result.

## Attribution

RED adds only proposed test evidence. Capture a fresh strict compiler baseline
after those files exist and before GREEN changes. Run the new suite once after
static gates; its current-baseline assertion must reach the existing evaluator.
Do not rerun old suites merely to rediscover consumed failures.

GREEN runs every emitted whole-file test and controlled variant, then repeats
the roster in fresh-source isolation. Record discovered, executed, failed and
skipped identities. No title filters, readiness skips or extra exclusions.
All seal/pacemaker readiness cases execute; retitled obligations map back to the
owner map. Compiler collection success is not a clean typecheck: publish the
baseline errors as well as diagnostic equivalence. JavaScript syntax/lint are
separate evidence. The compiler runner is [typecheck.mjs](./typecheck.mjs).
Invoke it from the absolute selected checkout root using Node and these ordered
arguments: `baseline ROOT OUTPUT`, `green ROOT OUTPUT BASELINE_REPORT`, or
`isolated ROOT OUTPUT BASELINE_REPORT`. `OUTPUT` must be an existing dedicated
evidence directory; all paths are absolute. Each stage writes one exclusive
`typecheck-STAGE.json` and refuses replacement. Bind concrete paths in stage
custody before executing, under the roster's compiler ceiling.

The baseline is captured after RED evidence exists and before GREEN edits.
Selected-root diagnostics must be zero for acceptance; unrelated diagnostics
are retained and compared by file/category/code/message/source anchor, keeping
multiplicity while allowing line movement. Compiler hash/version and normalized
options must match. Project source resolutions outside the selected checkout
fail; dependency resolutions are recorded separately in source/type provenance.
If the initial baseline has selected-root errors, record and disposition them
before RED release rather than silently classifying them as unrelated.

Preserve main built outputs. Freeze any isolated build dependency closure and
commands before launch; do not discover prerequisites through root postinstall,
whole-root tests or campaigns.

## Routing controls

Use the installed test-side YAML parser on each selected workflow, rejecting
parse errors and duplicate keys. Locate executable steps structurally, not by
substring. Positive formatting controls cover indentation, scalar quoting and
unrelated comments. Bind actual runner text to the reviewed runner. Separately
validate event/base selection, permissions, status identity, retarget guard,
setup order and preserved subsystem commands.

Execute the actual extracted runner with Bash in fresh current Git fixtures
using the real v2 closure and proposed root checker. Capture output and status.
Each family first proves unchanged-base acceptance. Required execution controls:

- Missing, empty, zero, invalid and option-like base references; no HEAD fallback.
  Push selection uses the event's before commit.
- No common ancestor and real criss-cross ancestry with two merge-bases, not
  mocked Git output.
- Candidate no-op checker and coordinated checker/policy/artifact mutations;
  candidate code must never become transition authority.
- Missing base checker or incomplete base inventory without fallback.
- Wrong repository root, symlink/non-blob entries, executable-mode changes and
  an added sibling in each closed tree.
- A v2-protected mutation rejected by the real extracted v2 checker after a
  valid v2 positive establishes the fixture is meaningful.

Source-semantic controls cover duplicate/shadowed keys, conditional/dead/comment
invocations, ignored errors, candidate dispatch, omitted v2/subsystem commands,
changed status/permissions and dependency scripts before governance. Exercise
these through internally hash-consistent invalid-base snapshots and require
the intended semantic diagnostic. Do not execute arbitrary hostile workflow
text simply to prove a structural rejection.

## Evidence boundary

Controlled current repositories prove prospective behavior, not permission for
the obsolete base to approve this amendment. After signing the reviewed source
checkpoint, bind explicit v2/root invocations to that SHA and the actual working
tree. Final review and parent campaign gates remain separate. Local evidence
does not claim remote branch protection is installed.
