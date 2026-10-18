# D.110c current registry governance — root design candidate

Status: proposed for plan review, not an implementation release. The accepted
W0 baseline is `8d81c8f47b9f5df0ff4e67caa01ae6f4008db707`. The user-authorized
greenfield resolution in the production-hardening plan governs this repair.
The companion `red-proposal.md` identifies the consumed failures and current
consumer sites; its historical results are not fresh runs of this design.

## One owner and an honest trust boundary

The existing root checker and root policy become the sole current registry
governance owner. The registry itself remains the signed W0 bytes. The current
schema catches up with its already-present optional multiplier. Old references,
locks, vectors and formal sign-offs remain byte-identical historical evidence;
their registry hash identifies what they actually reviewed, not the live file.
No second registry, old-tree projection, accept-either pin, recursive release
chain or additional bootstrap exception is introduced.

Ordinary change authorization continues to come from a trusted base, never
from the candidate's replacement checker or policy. Keep the callable
`evaluateProtocolV3Freeze({ base, current })` seam. Both snapshots must describe
the current policy version. Require the same base-governed policy, exact
protected path set and file bytes in the candidate, including the checker,
policy, semantic oracle and all active workflows. Validate both complete
closures. A candidate that changes an artifact and its policy hash together
fails against the independent base. A candidate that replaces its checker with
a no-op also fails when evaluated by the base checker.

Remove the old pre-v3 bootstrap branch. A missing, malformed or obsolete base
fails closed; it does not select candidate authority. The CLI resolves exactly
one merge-base between its explicit base reference and HEAD, rejects ambiguous
merge bases, binds reads to the actual repository root and validates the working
tree against that base. CI extracts and runs the merge-base checker with the
repository root explicitly bound. It must not fall back to the candidate
checker or suppress a missing checker or a nonzero result. An optional local
current-bundle integrity operation must be named and reported as integrity only,
not as authorization of a transition or independent approval of its own bytes.

This repair is an explicit development-governance baseline amendment under the
user's existing authorization. It is not an ordinary transition approved by the
obsolete freeze policy. Separate RED/GREEN, independent plan/implementation
reviews, custody and a signed source checkpoint establish the replacement
baseline. No executable exception automatically recognizes or approves this
amendment. Post-checkpoint local acceptance may use that exact signed checkpoint
as the current base, and must include independent-base mutations proving future
co-edits fail. Report that scope exactly. A PR whose merge-base still has the old
governance owner remains rejected; neither a current/current fixture nor a local
HEAD check is evidence that such a PR passes. Installing the reviewed baseline
in another protected branch is outside local checker evidence. Do not alter
branch protection or claim host configuration has been verified.

## What the current closure means

The policy distinguishes current artifacts from preserved historical evidence.
Historical provenance/lock/sign-off hashes are validated internally against
their original statements and preserved files, not rebound to a changed live
registry/schema. The current registry digest has one canonical policy home;
current consumers derive their tuple from that owner. No old approval is edited
to imply review of current bytes. The new schema/oracle and current governance
tests have explicit current custody, rather than being smuggled into the old
sign-off's reviewed artifact list.

The protected roster is the union of the existing root governance obligations
and the active subsystem custody now held by freeze-successor, seal and
pacemaker owners. Preserve v2 separation and its unchanged checker/status,
reference/lock/vector integrity, CODEOWNERS precedence and cohort, closed
schema behavior, canonical domains, ordinary test lifecycle and subsystem
commands. Governance ownership changes; semantic subsystem laws do not.
Do not omit a subsystem because its old checker understands only seven fields.

Seal and pacemaker retain their domain/profile/schema/vector/formal validators
but relinquish duplicated current-registry tuple and bootstrap authority.
Their current checks consume the root contract. Root current governance must
not recursively invoke itself through these validators. The five active
successor-routed workflows move to the same current base-governed entrypoint;
old successor artifacts remain historical, not an alternative live route.
Preserve workflow status/job identities, PR retarget triggers, read-only
permissions, exit propagation, dependency setup and each existing subsystem
test/build/formal command. The author-authorization workflow remains a current
root consumer and keeps its v2 command.

## Schema and independent parameter identity

Change only the existing schema's optional `authorShareMultiplier` property:
safe integer, minimum 1, maximum 1,000,000, with matching native-registry
metadata. Keep all seven existing required fields, `additionalProperties:false`,
the domain, encoding and key order unchanged. No schema default and no
canonical default injection. The existing registry descriptor remains exactly
optional with its current null const/sortRule and bounds.

The new test-only oracle is independent of production encoders and hash
helpers. It implements the bounded canonical parameter corpus directly from
the frozen grammar: plain objects, ASCII keys, nonnegative safe integers,
encoded-key-byte ordering, minimal varuint counts/lengths and zigzag integer
encoding. It frames the parameter domain using `DRP\0`, U32BE domain length,
UTF-8 domain, U64BE part length and canonical bytes, then Node SHA-256. Pin
literal absent/present-four bytes and digests from this reviewed independent
path before comparing production observations. Existing seven-field references
may corroborate absent-field identity but cannot attest to present-four.

Prove absent is not explicit four, insertion order is immaterial, changing four
to five binds a different identity, and wrong-domain/drop-field/default-injection
mutants cannot match. Schema values 1 and 1,000,000 are conformance boundary
controls only. They do not add supported Node profile digests. W0 already proves
the supported default/present-four runtime behavior; do not reopen runtime or
change live-journal's independent parameter boundary in this repair.

## Explicit test supersession, not skipped obligations

The consumed seal and journal failures remain causal evidence. The schema and
pacemaker implications are static discoveries until executed. Preserve all
adjacent domain, seal identity, pacemaker law, operation/work budget, gossip,
anchor and v2 assertions when replacing their obsolete current pin/routing
predicates. All readiness-blocked seal obligations must actually execute and
pass after repair; a readiness skip is not acceptance.

Historical governance suites keep their controlled-model semantic tests.
Replace their current-tree bootstrap/successor assertions with explicit current
acceptance obligations; retitle changed predicates. Do not exclude suites,
blanket-skip tests or claim a superseded literal assertion passed. In the
registry/spec integration suite, distinguish unchanged formal mappings from
historical reviewed-artifact identity: retain formal parsing/typechecking and
mapping controls, but never compare a historical sign-off to a current schema
as though the old reviewers had approved it. New current schema coverage owns
the changed optional-field assertion.

The new RED suite must enter the existing checker seam with a coherent current
base/current fixture and fail for the stale current contract, not a missing
export, missing file or unsupported CLI flag. The same known-good current
baseline must be established before each mutation family is accepted as
evidence. Static/source-shape checks alone cannot prove a routing bypass fails.
Exercise the actual current checker and workflow-routing behavior in controlled
repositories with separately captured base and candidate states. These are
fresh current fixtures, not reconstructions of historical trees.

Retain the existing complete snapshot envelope (`files`, `policy`, historical
`locks`, `workflow`, `codeowners`, `alternateCodeowners`, `testLifecycle`, major,
version and registry path). Existing `preV3`/`bootstrapConsumed` fixture fields
grant no authority. The hash-map evaluator proves preservation conditional on
trusted snapshot construction; it does not parse schema semantics, authenticate
signatures or establish Git ancestry. Keep source-based schema conformance
verification distinct. Any new content-bearing snapshot field or export must
be specified before the RED release, not discovered as a missing-export failure.

Required negative controls cover descriptor/schema drift; unknown and missing
parameter fields; invalid multiplier values; coordinated artifact/policy/checker
edits; reference/lock/vector drift; missing or malformed base; multiple merge
bases; wrong root; missing/no-op/dead/comment-only/conditional checker routing;
ignored exit status; missing v2/subsystem commands; permission expansion;
CODEOWNERS precedence and ordinary-test suppression. Reject semantic schema
mutants through the current semantic validator as well as custody checks; a
generic stale-hash refusal is not proof that a semantic mutant was evaluated.

## Release and verification

Before RED implementation, resolve the exact snapshot-content shape, manifest
roster, consumer replacement mapping and bounded command selection in the
reviewed freeze. Separate Astra-high RED and GREEN owners remain mandatory.
No source edit, checker run or fresh runtime is authorized by this draft alone.
Do not repeat consumed failures just to rediscover them.

Acceptance requires the new semantic/oracle and genuine checker mutation
controls, current root/seal/pacemaker CLI checks, all affected current consumer
tests, unchanged v2 checks, typecheck/lint/format with raw logs and honest
baseline-equivalence reporting, fresh-source isolation and Grok high, Sol high
and Fable xhigh final review. Static workflow validation is local evidence, not
a claim of hosted CI or branch-protection success. Preserve the eight dirty
production owners, built outputs, stashes and previously sealed evidence.

This registry slice does not accept the parent production batch, solve grid
authority composition or release the 100-transition campaign. Those remain the
next explicit obligations after this contract is proven.
