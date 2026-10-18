# Current registry governance

## Next agent prompt

You are replacing obsolete development governance with one prospective current
contract under the user's explicit greenfield authorization. W0 is accepted.
The corrected design review is recorded at signed/pushed
`89394d1f027e338e7b0ef78c9ce6f099af8c0f3d`; both review packets are immutable.
This revised candidate is **not yet released for RED/GREEN**. Finish and review the
exact inventory, executable routing controls and bounded gate roster before
releasing separate Astra-high RED and GREEN owners. Update this handoff before
ending a pass. Do not ask again for the authorization already recorded in the
production-hardening plan.

- [x] Consume both rounds of independent reviews and record every finding.
- [x] Choose an acyclic authority direction and a hash-bound semantic seam.
- [ ] Freeze the inventory, routing harness, oracle literals and gate commands.
- [ ] Obtain Grok high, Sol high and Fable xhigh corrected-plan acceptance.
- [ ] Release and verify separate RED/GREEN implementation.
- [ ] Verify main custody/static checks and two independent current-source
  runtime checkouts, sign the current baseline, then
  prove actual checkpoint-to-working-tree preservation and final review.
- [ ] Return to grid authority composition and the remaining parent gates.

The parent goal and campaign prerequisites remain unchanged. Preserve the eight
dirty production owners, built outputs, stashes and sealed evidence. No
production runtime/API change, registry-byte change or long-run campaign is
authorized by this specification.

## Why this is a baseline amendment

The old root owner promises immutable seven-field registry bytes. The accepted
W0 registry already contains an optional eighth field. Historical evidence is
valuable, but it cannot truthfully approve current bytes it never reviewed.
The current contract therefore starts from an explicitly reviewed development
baseline, not an automatic exception in the obsolete freeze checker.

Ordinary transitions remain base-authorized. A missing, obsolete, partial or
malformed base fails. Exactly one merge-base must exist, and the checker, policy
and protected inventory must all come from that same commit. No candidate
fallback, recursive predecessor chain, historical-tree projection or
accept-either-registry branch exists. An old-base PR remains rejected. Installing
this reviewed baseline in another protected branch is outside local checker
evidence; neither host settings nor such installation are claimed verified.

The new checkpoint metadata must state this amendment and the limits of local
evidence. Future host enforcement remains a requirement, not a claim that the
baseline itself passed the old policy's no-bypass gate. Registry version 1 is
the explicitly selected current greenfield baseline containing the already
signed optional field; historical version-1 attestations retain their original
seven-field scope. Any subsequent registry change requires a separately reviewed
baseline amendment and the registry's required version bump; there is no in-band
version-bump exception to this checker's byte-preservation rule. Do not claim
W0's earlier addition followed the obsolete bump policy.

## One transition owner; child integrity is not authorization

The existing root checker and policy own current transition authorization.
The root manifest byte-protects exactly `prospectiveByteProtectedPaths` in the
reviewed inventory, including child integrity policies, checker code, selected
test evidence and governance workflows. The root policy is independently bound
and compared as authority, but excluded from its own digest manifest.
Candidate policy bytes and byte-protected path/mode/type/hash state must match the
independently selected base. A candidate cannot shrink its own preservation
boundary or replace a checker together with its pin.

`semanticOnlyPaths` is a different fixed set: CODEOWNERS and the three ordinary
test-lifecycle sources. Require their presence, regular mode/type, source/hash
binding and valid semantics in both snapshots, but do not compare their content
hashes to each other or add them to the policy's byte-protected manifest. Thus a
valid alias addition, harmless formatting change or ordinary CI display-name edit
can pass while a test exclusion, shadow CODEOWNERS file or suppressed ordinary
test command fails. The trusted checker fixes these roles; candidate policy
cannot reclassify a protected artifact as semantic-only. Tests need positive
controls for benign semantic-source edits as well as suppression negatives.

Semantic-only does not mean arbitrary executable configuration is trusted.
The closed root-config grammar must preserve literal test selection, the exact
workspace membership and the actual exported config. Reject duplicate/computed
selection keys, test include/name filters, added setup/selection hooks, later
config mutation, altered config exports and plugin changes that escape the
reviewed shape. Allow literal workspace alias additions without freezing the
whole alias map. Ordinary CI validation must reject job/step conditions or
ignored failures that suppress its real `pnpm test` invocation, not merely find
that string in a comment or dead step. Preserve legitimate coverage settings;
coverage include/exclude keys are not test-selection keys.

The five currently active child owners—seal, pacemaker, Ed25519, blueprint
artifact and author authorization—retain their intrinsic schema, domain,
profile, vector and local-integrity checks. They relinquish bootstrap and
transition authorization. Their no-argument CLI performs explicitly labelled
**integrity-only** validation; it must not print a transition-approval claim.
Reject a supplied transition-base argument with an explicit root-owner
diagnostic rather than silently ignoring it. Current transition tests and CI
route through the real root checker, not a child wrapper calling back into root.
Do not retain unused alternate transition evaluators as hidden current owners;
move their safety assertions onto the root seam when superseding their callers.
Specifically remove `evaluateEd25519ProfileFreeze` and
`evaluateBlueprintArtifactProfileFreeze` as exported base/head transition
evaluators and migrate their live test callers to the root evaluator. Retain
intrinsic child integrity validation, not alternate transition APIs. This
supersedes the owner map's earlier wording about retaining those test callers.

Old successor and five predecessor budget/projection checkers remain preserved
historical evidence and are not executed as current transition authorities.
Their current subsystem tests, digest/evidence checks and public/type audits
remain active. The root neither replays historical checkouts nor recursively
invokes child checkers while validating its own manifest.

Historical tuple payloads are data, not reverse authority edges. In particular,
preserve the blueprint profile's five-key tuple and count 47: production profile
validation requires that shape. Preserve its checkpoint and old policy/state
hashes, and the equivalent Ed25519 provenance payloads. Child validators stop
dereferencing those historical paths against live root files. The new root can
hash these unchanged payloads without a child containing the hash of the new
root policy. Do not repin that cycle or modify runtime validation to accommodate
it. Existing signature vectors and blueprint runtime/artifact/type inputs stay
byte-identical.

The exact active invocation and test-title map is the bounded
[owner map](../../.logs/d110c-registry-current-contract-preparation-8d81c8f4/current-owner-map-v2.md).
Its old titles identify obligations to replace, not claims those predicates will
still be true. The inventory derived for this spec must explicitly classify
each path as editable current owner, preserved current semantic input, preserved
historical evidence or new RED evidence. Classification must be exhaustive for
the union of inherited protected inventories; no opportunistic repinning after
RED begins. [inventory.json](./inventory.json) is the mechanically derived
candidate inventory, with baseline hashes, exact source roles and historical
records whose live targets change. Its derivation reads existing policy data
only; it does not execute a checker. Freeze its required path inventory in the
root validator so an internally consistent but incomplete base cannot qualify.
Classification identifies current versus historical role and which files may
change during this amendment; `custody` independently specifies prospective
byte protection, semantic-only source, root policy authority or required
absence. All preserved inputs stay byte-identical during this amendment even
when their future custody is semantic-only.

`newlyByteProtectedPaths` explicitly adds selected governance tests/helpers,
new current RED evidence and the entire successor historical fixture closure.
That new ownership is deliberate: the replacement current assertions and the
historical data they must not restamp have one preservation owner. Future edits
to those named byte-protected files need a reviewed amendment, including edits
to other cases in the same file. This does not freeze arbitrary runtime imports
or general development configuration; non-editable runtime inputs are preserved
by this phase's separate source custody, not silently added to registry policy.

The root policy remains the canonical home of current artifact digests; do not
duplicate a whole-registry digest in checker code.

## Existing callable seam with bound source views

Keep `evaluateProtocolV3Freeze({ base, current })` as the sole callable current
governance API. It returns normally or throws a classified error. RED must use
this existing export; no new export or unsupported CLI option may be its causal
failure.

Extend the existing complete snapshot envelope with a closed `sources` map.
Values are the exact UTF-8 file contents, not normalized JSON or YAML. For each
required source path, require `sha256(UTF8(source)) === files[path]` in **both**
snapshots. Preserve file inventory and mode/type checks separately: source text
does not authenticate a symlink, submodule, added/deleted path or wrong root.
Use `fileEntries` with exactly the same present-file keys as `files`, each
containing `{ type: "blob", mode: <Git mode> }`. Preserve the pacemaker checker's
existing `100755`; the other existing selected files and new RED files are
`100644`. Required-absent paths occur in neither map. A mode change is not
invisible merely because file content hashes match.
The source roster is closed and fixed by the reviewed contract, not discovered
from whatever files the candidate supplied.
For this current envelope, `files`/`fileEntries` contain the selected present
inventory plus any additional entries discovered inside the five closed trees
(which must be rejected). Do not enumerate/hash every unrelated repository file,
and do not let candidate policy choose the snapshot's path roster. Required-absent
paths reject any filesystem entry, including a dangling symlink.

The CLI captures base entries from the selected commit's Git tree. Candidate
contents come from one worktree read per path, and candidate type/mode comes
from `lstat` (regular-file executable bits map to Git 100755 or 100644). Require
the index's stage-zero type/mode to agree for every tracked governed path;
reject unmerged entries, deleted-index substitutes, symlinks (including path
ancestors), submodules and non-regular entries. Worktree content may differ from
the index: it is explicitly the candidate being evaluated, not a staged-tree
approval. Include untracked entries in closed-tree enumeration and reject extras;
an untracked replacement cannot satisfy a base-required tracked path. Untracked
files outside governed boundaries do not expand the manifest. Controlled current
baselines commit their complete governed inventory before use.

The required source roles are root policy, registry, schema, both historical
reference locks, all eleven current workflow consumers, CODEOWNERS and the
three ordinary-test lifecycle files. Any additional source parsed by the
checker must join this exact roster before implementation; it cannot be read
through an unbound side channel. Snapshot construction reads each source once.
Existing `policy`, `locks`, root `workflow`, `codeowners`, `testLifecycle` and
registry-identity fields are derived views of those same bytes; the evaluator
must derive them itself or reject any supplied view/source disagreement.
Old `preV3`/`bootstrapConsumed` fields confer no bootstrap authority.

Root-policy bytes are included in the external snapshot's hash/source binding
and compared to the independent base. The policy's own content manifest does
not contain its own hash. Do not add a circular self-hash requirement.

Retain the root checker's five existing closed-tree boundaries: formal,
original reference, regenerated reference, registry and vectors. Their exact
current child-file sets stay unchanged. Snapshot construction includes every
tracked or untracked entry under those boundaries so an added sibling cannot
escape an exact-path manifest. Reject missing/extra entries there, independently
of ordinary protected-file comparison.

Validation is ordered and separately attributable:

1. Validate snapshot/source structure, base bindings, required inventory and base
   completeness. Missing/obsolete bases have explicit rejection identities.
2. Validate source semantics of the complete base: current parameter/schema
   contract, historical evidence meaning, current workflow and lifecycle rules.
3. Compare candidate policy, required entries/modes/types and byte-protected
   contents to base; candidate co-edits cannot redefine preservation. Semantic-only
   source contents are not frozen to the base's content digest.
4. Validate candidate source bindings and current semantics before acceptance.

The function is conditional on trusted snapshot construction; it does not verify
Git signatures or discover ancestry. The CLI owns Git/root selection, and CI
owns extraction of the selected base checker. Tests must not conflate these
three evidence boundaries. The current CLI requires exactly one explicit base
reference, resolves it to a commit before use, and has no implicit HEAD/parent
fallback. The bound repository root must resolve to the Git top-level of its
actual cwd; an override pointing to another repository fails. Extracted checker
files use the explicit root environment binding rather than inferring a repo
from their temporary location. Reject non-regular protected file entries and
mode/type substitutions instead of following them as ordinary source files.

## Two distinct mutation families

Every family first proves acceptance of one independently captured, known-good
current base and its unchanged candidate. Derive candidates by cloning that
base, never by rebuilding both sides from a mutated worktree policy.

**Transition mutations** change candidate-only artifact bytes, source views,
inventory/modes, checker, policy or coordinated combinations. They must be
rejected by the independent base owner. Cover no-op/candidate checkers,
policy-plus-artifact co-edits, omitted current semantic evidence, hidden
workflow suppression, root substitution and source/view mismatches.

**Invalid-base semantic mutations** start with the proven-good base, then make
a separate internally hash-consistent but semantically invalid baseline. Update
all affected sources, derived views, file hashes and non-self policy pins.
Invoke the real evaluator with that invalid base and its unchanged copy. Require
the specific semantic diagnostic, not an incidental stale-hash error. A
hardcoded whole-registry hash in checker code must not short-circuit these
controls. These tests prove a malformed baseline cannot qualify; they do not
authorize a candidate to rewrite an independent base.

Keep the consumed retained-30/40 failures as historical causal evidence. A new
current-snapshot refusal must be attributed to the predicate actually reached,
including lifecycle incompatibility where applicable. Never label every old
checker refusal an observed optional-field error. A baseline guard failure is
not a successful negative mutation and must not become a readiness skip.

## Schema and independent identity

The existing registry bytes stay unchanged. Add only the schema property for
the existing optional `authorShareMultiplier`: integer, minimum 1, maximum
1,000,000 and matching native metadata, with neither `const` nor `default`.
Insert this property first, matching its first position in the registry's
parameter declaration; do not append it. Keep all seven required names, closed-object behavior,
parameter domain, encoding and encoded-key-byte ordering. Preserve all-kind
schema/model/wire/domain and v2 separation controls.

The root's source-semantic validator exercises this contract through the
existing evaluator. The independent conformance tests retain the existing
schema-bijection oracle and prove valid/invalid parameter instances. Semantic
mutants include optional-to-required, deleted property, altered bounds/type/
domain/metadata, unknown fields and relaxed object closure. Concrete values
1 and 1,000,000 are schema/conformance controls, not new supported Node profiles.

The new test-only parameter oracle uses only the frozen grammar and Node
SHA-256, never production codec/registry/hash helpers. Its bounded corpus is
plain ASCII-key objects and nonnegative safe integers; use minimal varuint,
zigzag integer encoding and sorting by complete encoded-key bytes. Frame one
parameter part with `DRP\0`, U32BE UTF-8 domain length, the parameter domain,
U64BE part length and canonical bytes. The candidate literal corpus is
[oracle-vectors.json](./oracle-vectors.json), independently reproduced by
[oracle-construction.mjs](./oracle-construction.mjs). Review and freeze these
absent and present-four preimages/digests before comparing production observations.
Prove insertion-order equivalence, absent versus explicit-four distinction,
four-versus-five binding, and wrong-domain/drop-field/default-injection failure.
Old seven-field references corroborate absence only. W0 owns the supported
default/present-four runtime proof; do not reopen runtime or widen live-journal's
separate parameter boundary.

## Current workflow execution contract

All eleven identified workflows use the same fail-closed base-selection and
extraction rule, including author-authorization. Preserve existing job/status
identities, subsystem commands and setup requirements; make PR retarget checks
explicit. Preserve author-authorization's push-on-main behavior with the event's
`before` commit as the explicit proposed base. An empty/all-zero/unresolvable
push base is a rejection, not permission to substitute HEAD. No host result is
claimed by local workflow tests.

The root checker is standalone Node code. Run its base-governed step after
checkout/Node setup and before executing candidate dependency-install scripts
or subsystem code. Resolve exactly one merge-base with `git merge-base --all`;
reject zero or multiple results. Extract root and unchanged v2 checkers from
that exact commit into a fresh runner temporary directory and bind both to the
actual workspace root. Run v2 and root with the same explicit base. There is no
candidate-checker dispatch branch or ignored exit status. The candidate exact
runner is [runner.sh](./runner.sh), embedded as a `shell: bash` run step with
event-specific `BASE_SHA`. It uses neither `mapfile` nor `cd`; multiple
merge-base lines fail its single full-hex identity check. Its fresh temporary
directory contains only extracted base checkers and is left to the owning
runner/controlled-repository lifecycle, with no broad recursive shell cleanup.
Freeze and execute this actual text in the routing harness; substring presence
is not execution evidence.

Use parsed workflow structure in the test-side routing harness to locate the
actual executable step, then execute its actual runner text in controlled
current Git repositories. Preserve equivalent YAML formatting while rejecting
duplicate/shadowed keys, conditional/dead/comment-only invocation, changed
permissions/status identity, omitted subsystem/v2 commands, ignored errors,
wrong root, ambiguous ancestry and candidate fallback. The root's standalone
source validator may use a deliberately closed structural grammar, but must
accept the real workflow and reject the reviewed mutant set. Dependency/setup
and allowed commands are per-workflow; do not apply the old root-only ban on
`pnpm install`/`--filter` to subsystem jobs that require them.

## Supersession and acceptance

Preserve original reference/provenance/lock/vector/sign-off bytes and their
historical statements. The c2/d/d2/b2b, exhaustion and registry-spec current-path assertions
move to current root custody, while their grammar, neutral comparator,
chronology, signature, formal mapping and v2 semantic controls remain. Do not
rewrite their old hash records to pretend they reviewed current inputs.
Changed live tests get explicit current titles; no suite-level skip or exclusion
substitutes for the replacement obligation.

Seal and pacemaker readiness cases must all execute after repair. Replace their
absent-base bootstrap successes with genuine root missing/obsolete-base
rejections and unchanged-current-base positives, retaining protected-owner,
schema, drift and no-op controls. Apply the same rule to author-authorization's
bootstrap-positive test and harness. Keep the ordinary root lifecycle's actual
eight exclusions, including `**/.logs/**`, and reject additional test
suppression. The old successor-controlled current-tree cases migrate to the
root; historical controlled models retain only their explicitly historical role.
The [consumer supersession map](./consumer-supersession.md) resolves the
successor's eager readiness/certification machinery and the newly found
exhaustion consumer; it takes precedence over ambiguous old-map wording.

Two independently prepared current-source validation checkouts must each cover
every affected whole-file consumer, new semantic/oracle/routing suite and child
integrity CLI, with actual unchanged v2 checks and fresh build/type provenance.
Main receives static checks, source/output custody and post-checkpoint transition
evidence. This is not a claim of direct-main runtime execution; the verification
contract explains why nested build-writing suites require dedicated roots.
Preserve raw logs
and distinguish clean checks from baseline-equivalent diagnostics. Runtime
rosters and limits must be frozen before execution; do not discover scope by
rerunning consumed failures or by starting a whole-program campaign.

The candidate [verification contract](./verification.md) separates executable
routing controls from source-semantic mutants. Its [gate roster](./gate-plan.mjs)
derives exact whole-file and controlled-reference invocations from the inventory;
it prints commands without launching them. The fresh strict
[compiler runner](./typecheck.mjs) collects that roster with actual configuration
and source-resolution evidence. It is drafted, not executed or accepted; freeze
all three artifacts with the corrected review before RED release.

The inventory also records the unchanged verification-only v2 closure. Copy
those actual current bytes and modes into fresh controlled repositories so the
real extracted v2 checker runs; do not substitute a success stub or reconstruct
an old v3 tree. That verification closure is not an added v3 amendment surface.

Before the signed replacement baseline exists, main-tree transition checks
against the obsolete Git base must reject. Prove the proposed current contract
and its mutations in controlled current repositories without claiming that
they authorize that old-to-new transition. After the reviewed source checkpoint
is signed, explicitly check that checkpoint against the actual working tree;
record that as prospective preservation evidence, not retroactive old-policy
approval. Final independent review still precedes registry-slice acceptance,
and the parent production/grid/campaign gates remain separate.
