# 2c — Authenticated declaration-free pending recovery

Status: corrected contract accepted for separately authored RED after independent
Codex 6.1 xhigh approval, 2026-10-02. The
[root disposition](../../../.logs/bounded-storage-lifecycle/pending-discovery-contract-codex-reviews-02/root-disposition.md)
owns custody and the native/historical RED allocation. No GREEN authority yet.
The [live handoff](../README.md#next-agent-prompt)
owns execution status. The accepted cold checkpoint is commit `b29369df`; its
oracles and source-only qualifications remain binding.

## Outcome and one-owner boundary

The existing public `recoverPendingCreatorSuccessorAdoption` can authenticate
and publish a pending successor from durable state and independently trusted
previous/next heads without caller snapshot material. This is a non-activating
API: the pending kernel selects and publishes; the existing snapshot owner
discovers and supplies bytes; the shared verifier authenticates those bytes.
No new selector, recovery cache, factory, retention policy or compatibility path
is introduced. Removing the room call's argument is not declaration-free room
startup: its existing declaration-driven selector remains for the next seam.

The [public capture](../../../packages/node/src/creator-adoption-recover.ts)
loses `snapshotDeclaration` from its exact own enumerable data-key envelope.
The obsolete key, even with `undefined`, is `malformed-input`; preserve the
plain-object, accessor, symbol, missing-key and extra-key refusals, public
`unknown` input, private forwarding cast, export roster and result shapes.
The [private input](../../../packages/node/src/internal/creator-adoption-recover.ts)
requires existing `SnapshotRecoveryStore<SnapshotVerificationReceipt>` and no
declaration. Do not widen live producer facts or the declaration-taking verifier.
The capability is required, not optionally detected; no narrow-store fallback.

## Trusted selection before snapshot I/O

Within the [existing pending kernel](../../../packages/node/src/creator-adoption.ts):

1. Preserve synchronous detached copies of both expected heads before the first
   await. Guard invalid copies before dereferencing them. Parse the initial
   durable object from detached `expectedPrevious.objectId`, validate the
   creator-only profile, equal object identities and consecutive epochs before
   durable reads. Caller mutation across an await cannot redirect object selection
   or alter later admission comparisons. Do not expand detachment to other
   carriers in this seam.
2. Keep durable-head and full-lineage loading, candidate state/base/closure checks,
   duplicate-ID refusal and current/proposed/candidate closure loading. Preserve
   genesis and checkpoint trust branches, exact cut and exactly one successful
   QC, pinned genesis, both authenticated-head comparisons, pre-snapshot
   transition validation and existing anchor/projection-carrier checks in order.
   A merely decoded cut does not authorize discovery.
3. Immediately before the shared verifier, each candidate reaching that point
   invokes the actual snapshot owner's `lookupRecoveryDeclaration` once with
   authenticated cut `objectId`, `epoch`, `previousAnchor` as `anchor`, and
   `snapshotManifestDigest` as `manifestDigest`. No successor-scope substitution,
   caller hint, neighboring/older-scope fallback, memoization or deduplication.
   Equivalent retry candidates still each perform their own lookup.
4. Only a present, non-poisoned observation proceeds to unchanged `verifySnapshot`
   with the selected declaration and that same actual snapshot owner. Retain the
   selected declaration locally for the later manifest/projection comparison.
   Discovery itself is neither authentication nor proof of byte availability.
5. Preserve real chunk/payload verification and all later catalog, projection,
   parameters, ACL and settlement checks. In particular, the pre-snapshot
   transition predicate does not prove settlement ACL semantics; the existing
   post-snapshot ACL-dependent repeat remains mandatory.

The shared verifier's body, receipt/quarantine identity, port discard and scope
release remain unchanged. Do not add early declaration guards to accepted cold
recovery under this allocation. Temporary snapshot verification effects remain
possible; no new permanent pin, promotion, sweep or acquisition policy is allowed.

## Preserve candidate-set semantics explicitly

Root's proposed decision is to preserve the existing **fully verified candidate
set**, including its availability sensitivity. `true-fork` means distinct closure
digests among candidates that fully verify in this invocation, not every
historically valid or pre-snapshot-authenticated closure in storage.

A lookup rejection, missing/poisoned observation or failed byte verification
filters that candidate. A different candidate may still fully verify and publish
if the existing durable-head rules permit it. This already follows from
candidate-local byte verification; discovery adds another local availability
point. Candidates can share the same authenticated snapshot key yet experience
different observations under a race or injected owner fault. Pin this policy
with mixed-candidate controls; do not present it as comprehensive durable fork
detection. Strengthening it to fail the entire invocation after any unavailable
matching candidate is a separate contract decision, not an incidental fix here.

Preserve the outer algorithm: no survivors yields `pending-missing`; distinct
surviving closure digests yield `true-fork` before already-active success;
already-active candidates still fully verify and perform no CAS. Equivalent
surviving retries use the existing generation-ID ordering. Keep stale-base
refusal, at most one CAS, and the existing authenticated active reread after
ambiguous/unsuccessful publication. Only membership in the verified candidate
heads authorizes success after that reread. No activation, issuance, signing
or network publication is permitted; intentional AHE head publication is the
purpose of this API and is not network publication.

## Refusals and observation boundaries

Keep public failure shape `{ detail, kind, ok }` and the current success shape.
Invalid exact envelope is `malformed-input`; invalid captured heads/profile/
object/epoch relationship is `chain-invalid` before durable or snapshot calls.
Preserve unsuccessful durable-head/lineage result mapping to `storage-failed`,
the outer unexpected-exception mapping to `internal-invariant`, and existing
`pending-missing`, `true-fork`, `stale-head` and `pending-old` selection outcomes.
Do not import cold floor-migration precedence or invent `snapshot-unavailable`
at this API. Do not freeze new detail strings for metadata availability.

The required lookup invocation, including a missing-method TypeError from a
runtime narrow store, stays within the existing candidate catch and eliminates
that candidate. Record missing capability separately from an actual metadata
miss: attempted invocation is not an actual owner lookup. Preserve the verifier's
finally failures and existing catch boundaries instead of adding a generic mapper.

Zero snapshot lookup/acquisition/read at prelookup authentication gates is
candidate-local. Only an all-invalid fixture proves whole-call zero snapshot I/O;
mixed fixtures need candidate-attributed traces. Neither statement means zero
AHE reads. Post-snapshot refusal deliberately may have real reads and temporary
verification effects. No unsuccessful result can authorize new runtime/network
work; AHE effects follow only the preserved publication branch.

Present/open and present/verified observations must use actual payload bytes.
Missing, corrupt or non-equivalent replaced bytes cannot succeed. Deletion after
lookup may create an empty temporary scope during acquisition but cannot cause
successful publication. Byte-identical replacement that actually verifies may
succeed: metadata discovery is not an incarnation lease.

The pending discovery gate uses only `kind` and `state`: present/open or
present/verified proceeds, poisoned filters. It does not impose a new policy
on observed `retention` or `expiresAt`. Existing native acquisition and the
shared verifier determine subsequent behavior. In a ready owner, acquisition
sweeps expired temporary content and can recreate an empty temporary scope;
recovery-retained verified content survives its historical expiry. When global
legacy accounting suppresses sweeping, verified legacy or expired temporary
content can still pass real byte verification because the verified path skips
completion. Open content may be read before completion refuses under the
owner-wide migration barrier. Expiry after acquisition has no new deadline
guard. These are existing shared-owner semantics, including cold recovery's
same observation gate; the historical legacy-open refusal is not a universal
legacy refusal promise. Pin these cases in RED, including the influence of a
legacy row elsewhere in the owner. Do not classify legacy rows, add a local
retention/expiry filter, or claim migrated-room/endurance support here. A stronger
eligibility rule would need a separate reviewed policy change.

## Separate RED and historical oracle evolution

After contract acceptance, a distinct RED author owns new pending-only fixtures
and the two proven historical conflicts below. Freeze original bytes, failure
reports, evolved tests and custody before a different GREEN author edits product.
No accepted cold fixture or oracle changes outside this exact evolution.

- In [room callsite tests](../../../tests/cold-discovery-room-callsite.test.ts),
  replace the pending-key-presence obligation with omission and a retained-key
  mutant. Evolve all dependent expectations coherently. Preserve cold omission,
  unambiguous literal AST capture, malformed/spread/missing/duplicate refusal and
  the exact shared declaration-driven startup selector and its mutant. Keep the
  source-only runner/coverage qualification; it is not native runtime evidence.
- In [staged-handoff tests](../../../tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts),
  omit the obsolete key and use the actual capable snapshot owner captured via
  the existing genuine fixture's `options.createSnapshotStore` hook. Honor the
  configured factory/modules and return the same created owner to producer setup.
  Do not widen the producer's narrow decorator, assert it is capable, open a
  second owner as fallback or change the frozen genuine fixture source. Preserve
  retry, fork, already-active, wrong-head, export and CAS assertions. New stale-head
  evidence belongs to the new pending fixture; it is not an existing historical
  assertion.

The historical fixture helper must own its fresh database identity and cleanup
on construction failure as well as success; close fixture consumers and the
actual owner before deleting the exact owned database, reject blocked/error
deletion, and preserve the original construction failure. Factory suffixing is
part of exact target selection. These fake-IndexedDB cases do not prove native
restart. Any additional historical conflict requires evidence and separate RED
authorization rather than GREEN editing an inconvenient assertion.

Record any started snapshot factory promise before awaiting it; preparation's
parallel sibling failure can occur before that promise returns an owner. Settle
the started promise on failure and close any fulfilled owner before strict
deletion. If preparation succeeds, keep its cleanup handle before closing or
finishing; attempt its cleanup and the owned snapshot close even if another
cleanup fails. Invoke the historical fixture cleanup at most once. The native
snapshot owner's cached closing promise permits re-entering its close after a
delegated fixture close, without claiming fixture-wide idempotence. Preserve
the primary construction/finish error and attach cleanup failures. This proves
cleanup of the newly injected snapshot owner/database; it does not prove cleanup
of every earlier resource when frozen preparation fails before returning a handle.

Use the effective configured factory/module lane when modules are supplied;
otherwise resolve the same absolute source-module lane as the existing default
loader. Do not substitute a dist/package factory or mix receipt module instances.
Pending historical calls use the captured actual owner, so the decorator's
`durableReadHook` and chunk-mutation controls are bypassed there deliberately;
new pending observations and faults must be verified independently.

## Decisive evidence

The runnable deliverable is a dedicated pending-recovery fixture/driver through
the real public function. Native SQLite must use separate setup and recovery
processes, with setup exited first; native IndexedDB must close setup page/workers
before opening a fresh recovery page/realm in the same origin/context. Recovery
imports no producer/setup helper. Only durable database identities and existing
trusted heads/genesis/catalog/parameter carriers cross the boundary; no snapshot
declaration, manifest, chunk descriptors, payload or reconstruction hint.
Setup can retain expected values for external assertions, not feed selection.

Exercise both genesis and later-checkpoint branches in SQLite and in each native
IndexedDB engine (Chromium, Firefox and WebKit), including old-AHE publication
and already-new-AHE recovery. Prove exact authenticated head, durable
result, real payload reads, precise cut-derived lookup key and a competing real
scope that is never selected. No live issuance is part of this non-activating API.
Instrument without changing native quarantine, receipt or port identity, replacing
authentication, or mutating frozen cold instrumentation. Genuine native owners
must handle successful cases and durable malformed-byte controls.

In both trust branches, the observed lookup key must agree with the trusted
previous head's object, epoch and anchor as well as the authenticated cut's
manifest digest. This is an observational oracle, not a new product guard.
Competing scopes must be possible under storage's exact-key conflict rules:
use another epoch or anchor for the available neighboring scope, and separately
test an exact-key miss with an occupied same object/epoch/anchor under another
manifest digest as a rejected lookup with `conflict` provenance.

Observe actual reads with identity-preserving insertion inside the native read
method or equivalent native accounting; keep original return values/promises,
quarantine and port objects. Reusing the accepted observer unchanged is allowed;
pending candidate attribution needs its own observation owner. Missing-method
attempt evidence may use a property-access trace, while the prohibition on
feature detection additionally requires source review. Counts alone cannot
distinguish invocation from detect-and-skip behavior.

Required causal controls cover:

- Exact envelope and obsolete-key refusal; both-head mutation across an awaited
  durable boundary; structurally invalid and valid-but-wrong head tuples.
- Trust/cut/QC and pre-transition refusals on both branches before lookup;
  post-snapshot projection/catalog/parameters/ACL/settlement refusals afterward.
  Distinguish malformed closure bytes from digest-consistent authentication
  failures; record the actual reached gate instead of inferring from a result.
- Missing, poisoned and rejected lookup; missing runtime capability; present/open
  and verified success; missing/corrupt bytes; deletion, non-equivalent replacement
  and equivalent replacement between discovery and acquisition.
- Incomplete/unmatched and duplicate-ID candidates; equivalent retries under old
  and new durable heads; fully verified divergent closures, including an already
  active candidate; an unavailable candidate beside an available one; stale head;
  successful publication with lost CAS response and unsuccessful CAS/reread.
  Attribute exact lookup/acquisition/read counts per reaching candidate even when
  keys repeat; show all-invalid whole-call and mixed candidate-local boundaries.

The missing-declaration envelope is causal initial RED but masks downstream
assertions. Label them `MASKED_BY_ENVELOPE_REJECTION`, not executed passes.
Room omission must have its own causal RED. The real narrow producer remains
compile-checked; a runtime narrow-store negative must not be hidden behind the
obsolete envelope key. Preserve full historical consumer registrations and
default gate limits; no partition, timeout increase, coverage waiver or repinning.

RED must also establish unmasked fixture and observer preconditions before
GREEN: in fresh native processes/realms, direct owner probes demonstrate the
exact expected scope and competing scope exist, real lookup/acquisition/read
observations fire, and each owner fault/race injector affects its intended
direct operation. Gate instrumentation must fail closed on missing/duplicate
source seams and have positive insertion/reach controls. These probes exercise
owners and instrumentation, never replace product authentication or count as
product recovery success. Use independent probe fixtures for mutation/completion
so a probe cannot consume or repair the database used by a product case.
Probe-only oracle carriers have a separate driver/import graph and cannot cross
the product recovery envelope. Backend-specific fault probes must run on their
actual backend; the positive restart matrix covers all required engines.

GREEN reports each formerly masked assertion's actual reach and result, with
candidate/gate traces and per-case reached assertions. A favorable top-level
result cannot substitute for executed downstream assertions. RED review owns
the concrete mapping of cases/probes to branches, backends and budgets; no full
Cartesian product is implied, and no required behavior or engine may disappear.

Use durable named strict projects, build-before-test and exact source/output
custody. Record commands, exit codes, raw results, log hashes and child/page
cleanup. Focused typecheck, lint/format, native cases, historical preservation
and product-browser tests are required; known broader failures remain failures,
not claims that the entire repository passed. Freeze the new fixture's concrete
case roster and ordinary budgets in RED review before GREEN execution.

Obtain an independent Codex 6.1 xhigh review at contract, RED and GREEN
checkpoints. Implementation and investigation subagents use Codex 6.1 high.
Root reads complete verdicts, audits terminal
evidence and dispositions all findings. No visual UI or endurance claim belongs
to this API seam; visual gates apply only if later work creates a visual artifact.

## Allocation and firewalls

The prospective GREEN allocation is the public pending capture, private pending
input, the existing pending helpers in `creator-adoption.ts`, and removal of the
one pending-call declaration argument in the room. Shared verifier, accepted
cold implementation, live producer and storage factories remain unchanged.
RED owns tests/configuration only; implementation cannot silently extend that
allocation. Single-owner review rejects parallel policies, adapters and dev-only
compatibility paths.

Startup-selector migration, recipient pinning, usable rollback, protected-set
planning, legacy classification, retirement, schema/factory changes and bounded
history/working-set/endurance are excluded. `readGenerationLineage` still
accumulates history and pending recovery revisits candidates; exact discovery
does not bound either. The next seam removes the room startup declaration
dependency only after separately reviewing its selection/failure contract.
