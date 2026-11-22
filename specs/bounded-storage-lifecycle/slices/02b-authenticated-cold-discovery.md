# 2b — Authenticated declaration-free cold recovery

Status: accepted for separately authored RED after the third qualified contract
reviews; no GREEN authority yet. The
[live handoff](../README.md#next-agent-prompt) owns execution status. This consumes
the accepted [metadata discovery capability](02a-declaration-discovery.md), not
the remaining pending, startup-selection, rollback or bounded-history contracts.

## Outcome and ownership

The existing public `reopenCreatorSuccessorAdoption` reconstructs an already
adopted successor from durable stores and independently trusted room-head/genesis
carriers, with no caller-supplied snapshot declaration, manifest, descriptors or
payload. Its existing cold owner authenticates the durable chain before selecting
snapshot metadata; the existing snapshot owner discovers the declaration and
supplies the bytes for real verification. Neither owner gains a competing cache,
discovery policy, activation authority or retention decision.

Only cold recovery changes. The live producer already possesses a declaration;
its shared declaration-taking verifier and `SealedAdoptionFacts` remain narrow.
The cold input requires the existing `SnapshotRecoveryStore` capability. Do not
add optional discovery, feature-detection fallback, a decorating store or a second
factory. A richer type assertion without a real capable owner is not migration.

The public cold envelope loses `snapshotDeclaration` in both its ordinary and
bootstrap-policy forms. Supplying the old field is an extra-key failure, not an
ignored compatibility input. Preserve all other exact-own-data-key capture,
profile, author, runtime-binding and bootstrap-carrier validation. Hot activation,
pending recovery, export/result rosters and storage factories remain unchanged.

Keep the existing public `unknown` capture and private forwarding cast. The
private capability type does not statically validate that public input; the
required narrow-store negative proves runtime enforcement. Do not widen the
public API or detach other carriers as part of the floor correction.

## Authentication precedes selection

The [public boundary](../../../packages/node/src/creator-adoption-activate.ts)
already detaches the expected head. It must explicitly forward that detached copy
to the private owner: spreading the shallow capture currently forwards the caller's
original object. Initial durable object selection and all later comparisons use
the detached identity. Mutating the original during an awaited store operation
must neither redirect lookup nor change the admitted floor.

The [cold owner](../../../packages/node/src/creator-adoption.ts) follows this order:

1. Select the durable object from captured trusted expected room identity, retaining
   storage-object parsing and existing active-generation/lineage/closure refusals.
2. Authenticate predecessor and successor trust, the exact cut and commit QC using
   existing genesis/checkpoint trust openers. Preserve their signatures, pinned
   genesis and profile constraints; a decoded cut alone is not authenticated.
3. Preserve pre-snapshot `inspectCreatorTransitionAdvance` and carrier/projection
   checks in their current relative order. Compare authenticated successor trust with the captured expected head
   in a common prelookup gate, including the genesis branch. Keep the checkpoint
   opener's existing expected-head check, and retain the final public comparison.
   Use `sameCreatorRoomHead`, not a new partial identity comparator. Only this
   expected-floor comparison moves earlier; preserve the existing later
   projection/catalog/parameter/ACL/issuance checks.
4. Derive the exact predecessor scope from the authenticated cut:
   `objectId`, `epoch`, `previousAnchor` as `anchor`, and `snapshotManifestDigest`
   as `manifestDigest`. Do not use successor epoch/anchor or a caller hint.
5. Perform one exact `lookupRecoveryDeclaration` call. Only a present, non-poisoned
   observation can proceed to the unchanged declaration-taking verifier. Use the
   returned declaration and the same actual owner; there is no neighboring-scope,
   older-generation, pending or caller-declaration fallback.
6. Verify actual chunk and payload bytes and preserve all catalog, projection,
   parameter, ACL, settlement and issuance checks before activating material.

The pre-snapshot transition predicate does not establish settlement ACL semantics:
it skips that validation without ACLs. The existing post-snapshot ACL-dependent
repeat remains mandatory. Do not move it earlier with invented or cached ACLs.

## Refusals and lifetime

Preserve existing public missing/invalid-floor and malformed-envelope failures.
A plain envelope with no expected floor still returns
`D110C_FLOOR_MIGRATION_REQUIRED`, including when it contains the obsolete key.
With a valid floor, the obsolete declaration key returns `malformed-input`.
On an otherwise exact envelope, a structurally invalid floor returns
`D110C_FLOOR_INVALID`; an identity that passes public capture but fails the
existing storage-object parser remains `chain-invalid`.
The common prelookup mismatch returns the existing `D110C_FLOOR_MISMATCH` result
and detail `creator successor differs from the authenticated room-head floor`;
checkpoint mismatches already rejected by its trust opener remain `chain-invalid`.
This deliberately preserves branch-specific historical taxonomy instead of
redesigning every failure code. Failures at the prescribed prelookup trust,
QC, transition and expected-successor gates perform zero declaration lookups,
snapshot acquisitions or payload reads, and cannot activate a runtime or
issue/sign/publish work. This is not a zero-I/O claim for every later
`chain-invalid` result: post-snapshot validation remains necessary.

A missing observation, observed poisoned state, or any rejection of the lookup
invocation returns `snapshot-unavailable`. The unconditional call itself must be
inside that local catch, including a missing-method TypeError from a runtime
narrow store. Test that case as a required-capability violation, not a metadata
miss; never add optional-method detection or fallback. Catch this invocation locally; this is
the cold consumer's existing availability abstraction, not a change to the storage
owner's precise error codes. Preserve the verifier's existing body/finally failure
behavior and outer unexpected-error handling; do not claim all later exceptions
share one result. No new generic failure-code dispatcher is needed.

Do not introduce a new stable detail-string contract for availability refusals.
Fault placement and exact lookup/acquisition/payload-read counters identify the
reached gate. A missing runtime method deliberately shares the public availability
kind with metadata misses; test diagnostics must preserve that distinction.

Metadata state and retention are observations, never payload evidence. Verified
metadata with missing, corrupt or replaced bytes must still fail real verification.
Deletion after lookup may let `openScope` create an empty temporary scope; this
cannot become successful activation. No new pin, promotion, sweep, release policy,
legacy classification or non-creating acquisition API is authorized. Ordinary
verification may retain its existing temporary lifecycle behavior, but must not
install permanent recovery ownership. Byte-identical replacement that genuinely
verifies is not required to fail merely because its incarnation changed: discovery
is not an incarnation lease.

## Decisive evidence

After contract acceptance, use the separate RED author and freeze its tests and
historical evolution before the separate GREEN author changes product code.
The initial absent-declaration envelope refusal is a causal RED, not evidence that
downstream authenticated selection or byte-race assertions ran. Report those
masked assertions explicitly as `MASKED_BY_ENVELOPE_REJECTION` until executable;
never count them as passes or claim that their intended downstream gate ran.

Native SQLite in a fresh process and native IndexedDB in a fresh page/realm must
reopen genuine adopted state without setup's live handles or snapshot material.
Setup may know expected bytes for assertions. The restart boundary admits only
database identities and existing trusted genesis/head/catalog/parameter/author
carriers and runtime bindings, not a declaration-shaped reconstruction hint.
The recovery entry must acquire actual reopened stores and call the production
public function; no fixture recovery implementation or simulated durable store.
Keep producer setup helpers out of the recovery entry's import graph. Node setup
must exit before a distinct child reopens persisted SQLite files. Browser setup
must close its page and workers before a separate page in the same origin/context
opens native IndexedDB. The existing `openD109dColdFixture` consumes a prepared
in-memory capability and cannot establish this boundary. Existing Node-specific
close/adopt recipes cannot be bundled unchanged as native browser evidence;
use a small environment-neutral setup recipe with real backend factories.

Exercise both genesis-to-successor and later-checkpoint branches in each native
environment (both branches in SQLite and both in IndexedDB). A competing
valid snapshot at another scope must not be selected: record the exact cut-derived
lookup key and genuine payload reads. Recovered state, authenticated head and a
valid subsequent issuance must agree; merely returning an object is insufficient.
Keep declaration-free recovery separate from setup's need to deliver real bytes.
The competing scope uses real owners to prove exact-key selection, not a
malicious owner returning the wrong declaration or a change to 2a conflict policy.
The unchanged shared verifier's declaration-to-cut binding remains necessary.

Include malformed old-key envelopes, missing/invalid floors, incorrect valid
successor floors, corrupt trust/cut/QC, caller-floor mutation across an awaited
store boundary, missing metadata, rejected lookup, poisoned observation, missing
or corrupt chunks, and deletion/replacement between discovery and acquisition.
Each negative must identify the intended reached gate and assert its downstream
no-effects boundary. Native successful cases and malformed durable-byte cases
must use real owners; narrow deterministic fault instrumentation may observe or
interrupt those owners but must not replace authentication or verification.

Exercise wrong valid floors on both branches with their specified distinct
results and zero snapshot I/O. Do not invent combined-fault precedence: preserve
the existing carrier/transition ordering and test each intended fault separately.
Present/open and present/verified observations must proceed to real verification;
present/poisoned must refuse without acquisition. Keep poisoned observation and
lookup rejection separate. Mutation-across-await evidence targets only the floor.

Preserve local-author possession, bootstrap policy, settlement, retained TTL and
direct payload-verification telemetry. Prove the real frozen producer fixture
still compiles against the unchanged narrow producer contract. Use durable strict
projects and explicit build-before-test custody: source hashes alone do not prove
which package outputs a child/browser loaded. Record actual exit codes, test
results and log hashes for focused typecheck, lint/format, native tests and
preservation gates. Existing broader compiler/default-WebKit failures stay
qualified; no increased timeout, coverage partition or gate relaxation is implicit.

Obtain qualified Grok, Kimi with the requested 100-step cap, and Opus xhigh
contract/RED/GREEN reviews. Root must read and disposition findings against the
actual frozen evidence. This seam does not need endurance or visual acceptance.

## Consumer and historical-oracle boundary

The [room owner](../../../examples/v3-room/src/index.ts) must mechanically stop
passing the declaration to its cold call. Keep its pending call and room-level
declaration-driven startup selection until the separately reviewed 2c/2d seams.
This edit alone is not declaration-free shipped startup.

The separate RED author must add
`tests/cold-discovery-room-callsite.test.ts` as the executable wiring gate.
Parse the actual room source: uniquely identify its production cold call and
assert that its argument has no `snapshotDeclaration`, while the pending call
still supplies that key and the startup selector still depends on the supplied
declaration. Fail closed on missing or ambiguous callsites or unresolved argument
structure. Include diagnostic source mutants for a retained cold key, a removed
pending key and a removed selector dependency; each must fail its corresponding
assertion. Run the gate directly with
`pnpm exec vitest run --config tests/fixtures/cold-discovery-room-callsite/vitest.config.mts --workspace tests/fixtures/cold-discovery-room-callsite/vitest.workspace.ts` and record exit
code and log hash at RED and GREEN. The current cold key must produce a causal
RED independently of envelope-masked native assertions. This source gate proves
mechanical wiring, not native startup, and does not replace the required native
process/page cases. No dirty product-suite partition is authorized by this gate.
The [accepted disposition](../../../.logs/bounded-storage-lifecycle/cold-discovery-contract-reviews-03/root-disposition.md)
pins this new source-only project's runner and coverage qualification; preserve
all existing root/native/package coverage gates. Prove collection and the actual
named assertion failure, not just a nonzero exit. Target the specific startup
branch selecting pending versus cold recovery, not any remaining declaration
occurrence elsewhere in the file.

The [prospective evolution manifest](../../../.logs/bounded-storage-lifecycle/cold-discovery-plan-01/historical-evolution.json)
owns exact historical paths, original hashes/bytes and permitted changes; it is
not authorized until contract acceptance. The
[baseline](../../../.logs/bounded-storage-lifecycle/cold-discovery-plan-01/baseline.json)
records the current frozen producer strict project and documentation gates; it
does not certify the future migration. Only the separate RED author may implement those approved
fixture changes; GREEN may not amend tests. Required candidates are the cold
envelope rosters and hostile-profile builder in the activation contract/test,
native Node/browser activation and local-author cold-input builders, and the
repeat-close fixture's cold inputs. Removing the old key from negative builders
is essential so they do not pass trivially at stale-envelope capture.

The repeat-close fixture obtains cold facts through a live forwarding store that
deliberately lacks discovery. Capture the actual capable predecessor factory
instance through a fixture-owned internal creation hook, and reuse that same
instance for epoch-one cold recovery. Reuse the already-owned repeat
`snapshotStore` instance for epoch-two cold recovery. No extra open is needed for
this historical in-process fixture; this is not a global singleton restriction on
native database clients. Keep the live forwarding object
unchanged and remove unused snapshot members from the fixture's cold-facts type.
Select configured module factories when supplied. These historical Node helpers
use a browser adapter with fake IndexedDB; that is actual adapter capability
evidence, not native-browser restart evidence.

The inherited caller-supplied `options.creator.createSnapshotStore` hook has no
demonstrated repeat-close caller. Reject that caller hook with
`TypeError("D110C_A_CALLER_SNAPSHOT_FACTORY_UNSUPPORTED")` at function entry,
before controls or factories run. The fixture-owned internal hook is allowed.
This makes unsupported caller ownership explicit rather than
silently overriding an unknown backend. This is a deliberate fixture restriction;
the original adoption helper and producer-retention hook remain unchanged.
Register each real owner immediately, cover hot-construction failure as well as
ordinary cleanup, stop consumers and close all owners before deleting owned
databases, and preserve the original construction error. Never call recovery
callbacks for a hot fixture that failed construction.
Database deletion must reject on blocked/error outcomes, never report successful
cleanup while a newly owned database remains open.
This applies to the repeat-close file's existing deletion helper across its
hostile-carrier, ordinary-cleanup and attempted-close paths; RED must exercise
those paths before freeze. After the preserved hot helper closes, strictly
re-delete the newly fixture-owned predecessor database identity through that
same deletion owner. Already-deleted identities may succeed; the preserved
helper's permissive deletion is not proof that the new owner was cleaned up.
Do not edit that preserved helper or add a competing cleanup abstraction.

Preserve the historical TTL oracle's one snapshot acquisition. Its verification
owner has still-present temporary metadata after time advances; lookup neither
sweeps nor tests current expiry. The subsequent source `openScope` performs its
existing expiry sweep/recreation, and missing bytes refuse activation. Pin this
reached sequence rather than changing the acquisition counter. The dirty room
product forged-declaration negative stays unchanged: it refuses at the room's
head-ahead gate before this cold seam, so it is not declaration-binding proof.

The [source allocation](../../../.logs/bounded-storage-lifecycle/cold-discovery-plan-02/allocation.json)
and [audit](../../../.logs/bounded-storage-lifecycle/cold-discovery-plan-02/audit.md)
own the exact four-file GREEN boundary, six-file RED historical evolution and
preservation envelope. The newer allocation supersedes the initial manifest's
repeat-close ownership recipe; original bytes remain preserved. Source-derived
findings and all first-round verdicts are recorded in the
[root disposition](../../../.logs/bounded-storage-lifecycle/cold-discovery-contract-reviews-01/root-disposition.md).
The [second-round disposition](../../../.logs/bounded-storage-lifecycle/cold-discovery-contract-reviews-02/root-disposition.md)
owns the missing consumer-gate correction. The
[third-round disposition](../../../.logs/bounded-storage-lifecycle/cold-discovery-contract-reviews-03/root-disposition.md)
accepts that correction and pins RED's advisory obligations, including exact
runner custody, selector mutants and construction-error preservation. Earlier
required revisions remain historical results, not retrospective approvals.

Any further proven oracle conflict needs its own explicit
evolution; the preservation inventory is not blanket permission to edit fixtures
or unrelated dirty browser/grid experiments.

## Scope firewall

Pending recovery and its input types, live producer facts/shared verifier,
producer-presign-retention fixture, behavioral discovery/retention oracles and
storage schema/factories are outside this product patch. Preserve exact historical
bytes except the separately approved RED evolution above. If the seam cannot be
implemented within that boundary, reslice before changing it.

This work does not bound `readGenerationLineage`, which currently accumulates
pages, nor snapshot payload working memory. Recipient installation, usable
rollback, protected-set planning, legacy migration, retirement, shipped startup
selection and thousand-epoch boundedness remain required in the parent roadmap.
