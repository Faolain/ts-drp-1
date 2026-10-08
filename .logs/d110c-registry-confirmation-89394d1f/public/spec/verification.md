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

GREEN runs every emitted whole-file test and controlled variant in dedicated
current-source checkout A, then repeats the roster in independently prepared
checkout B. Record discovered, executed, failed and
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
before RED acceptance/GREEN handoff rather than silently classifying them as
unrelated. RED authoring must happen first so the selected roots exist.

The collector labels decoded compiler text and file-byte digests separately.
The installed Vite loader may create a transient bundle in
`node_modules/.vite-temp`, or beside the config as fallback. This is not a
write-free operation. Its bounded before/after bundle census must agree; the
collector does not delete bundles. No concurrent reviewer or custody snapshot
may race that stage. Main sources, protected outputs and pre-existing artifacts
still require exact before/after custody.

## Physical execution and readiness

Two selected suites build from their repository root. Preserve their real
source/built/runtime assertions without redirecting or stubbing the build:
all runtime suites therefore use dedicated current-source checkouts with their
own dependency installations and outputs. This explicitly replaces the earlier
direct-main-runtime proposal. Main receives static checks, source/output custody
and final actual checkpoint-to-working-tree evidence; no direct-main runtime
coverage is claimed. Both runtime checkouts contain the exact main source
snapshot, unchanged production overlay and authored RED files, without project
symlinks back to main or shared main dist/node_modules.

Prepare each from signed source HEAD plus a hash-bound working overlay and
untracked source manifest. A local shared Git-object clone permits object
reads, not shared worktrees or outputs. Independently install the unchanged
lockfile using `pnpm install --offline --frozen-lockfile --ignore-scripts`
(180 seconds). Missing offline/native prerequisites stop preparation; no
network, root postinstall or ad hoc repair is implicit. Freeze installed/native
provenance before `pnpm build:packages` (300 seconds), allowed only in these
checkouts. This reuses the preparation shape verified for W0, not its pass claim.
Concrete paths, overlay, package graph, native inputs and watchdog are frozen
before preparation runs.

Roster ceilings are one-shot admission budgets, not measured maxima. Their
source basis is the [runtime audit](../../.logs/d110c-registry-corrected-preparation-89394d1f/runtime-budget-audit.md).
Readiness executes five child-integrity CLIs followed by the roster's six full
test files. These count as their normal gates, not a pilot plus automatic
repeat. Continue the remaining roster only after all required cases execute
and pass. Do not enable retired successor certification; follow the
[supersession map](./consumer-supersession.md).

Bound nested operations: Git/checkers at 30 seconds, Quint parse/typecheck and
ordinary file-only Vitest discovery at 60 seconds, source/built type audits and
package commands at 120 seconds, in-suite protocol-v3 builds at 180 seconds.
Keep smaller existing oracle/model bounds. The outer process-group ceiling
remains authoritative. Freeze exact replacement test-level limits and child
cardinalities after authoring and before runtime execution. File-only root
discovery is a lifecycle assertion, not permission to run root tests. Every
retained runIf/skipIf surface must exist and all cases execute without skips.

Unexpected exit, timeout, missing prerequisite, skipped/pending case or residual
process stops the roster. Seal the first evidence and review a changed experiment
before another invocation; no automatic retries, installs, longer budgets or
campaigns. Source cardinalities and preparation capsules are release gates,
not completed work claimed by this design.

## Inventory reproduction

Default derivation prints an inspection without writes. Before RED, an
intentional revision may use `--write --replace PRIOR_DIGEST`; replacement
requires the existing digest and absent RED files. After freezing, use
`--verify STAGE REVIEWED_DIGEST`, with STAGE `pre-red`, `post-red` or `green`.
That is non-mutating custody against an independently supplied inventory hash,
not regeneration from a candidate policy. The separate RED seal owns exact
new test bytes after RED acceptance.

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
