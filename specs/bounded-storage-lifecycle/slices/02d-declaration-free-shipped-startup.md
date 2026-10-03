# 2d — Declaration-free shipped room startup

Status: independently reviewed contract accepted, 2026-10-03, under the
[root disposition](../../../.logs/bounded-storage-lifecycle/startup-selection-contract-review-01/root-disposition.md).
Separate RED begins after the focused 2c landing commit; product changes require
RED readiness and a distinct GREEN author. The [live handoff](../README.md#next-agent-prompt)
owns execution status.
The [source-grounded proposal](../../../.logs/bounded-storage-lifecycle/startup-selection-contract-plan-01/proposal.md)
owns reconnaissance and historical conflict locations; it is not runtime proof.

## Outcome and one owner

Ordinary shipped create/join/open and reused startup recovery select from the
room's current detached, validated host floor, without caller snapshot material.
The room owns classification; host authority persists the floor; AHE owns
authenticated generations; the existing snapshot owner discovers declarations
and bytes; accepted cold/pending kernels supply cryptographic proof. Structural
floor validation is a trusted expectation, never a replacement for those proofs.

Remove `successorSnapshotDeclaration` from the public room input and chat input,
its derived alias and forwarding consumers coherently. No deprecated option,
hint fallback, optional capability, declaration cache or compatibility selector.
The room input is not an exact-key runtime envelope: type removal does not add
runtime extra-key refusal or a universal getter-nonobservation promise. Preserve
cold/pending exact-envelope policies and declaration-taking live producer facts.

The runnable checkpoint is a real public room reopen with exact recovered state,
authenticated base/replay and continued issuance, plus shipped grid/chat callers
that supply no declaration. This does not provide durable chat host persistence,
a new grid host provider, rollback, recipient retention, retirement or endurance.

## Current floor classification

Promote the existing private floor capture/initialization/read machinery in
[the room](../../../examples/v3-room/src/index.ts) into the single state owner.
Derive a route from its latest validated state; do not persist an independent
route flag or use initialization kind, active-handle presence or projection
authority as a competing selector.

| Validated state                                         | Route                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Ordinary state with pending previous/next               | Pending successor, even when stable is pinned genesis |
| No pending; stable exactly equals scoped pinned genesis | Genesis                                               |
| No pending; stable is a positive-epoch successor        | Stable successor                                      |
| Explicit private redirect/fresh-trust/skip opening      | Existing internal authenticated route                 |

Keep internal exemptions private and explicit; an absent ordinary provider or
floor cannot select one. Ordinary authority is required at its existing
initialization boundary in every ordinary route. Missing/null/nonobject or
incomplete capability refuses with `D110C_FLOOR_MIGRATION_REQUIRED`; no inferred
genesis provider. Preserve create/reopen/migrate semantics and detached captures:
scope identity, pinned epoch-zero anchor, pending.previous equal to stable and
consecutive pending.next. Mutation across an await cannot redirect expectations.

Use the one classification consistently for preparation, pretransport replay,
activation/recovery, genesis-only blueprint binding, profile-sensitive creator
close availability/rebind and startup publication/rebase. Preserve legacy versus
settlement-v1 close-owner distinctions. Explicit internal target/redirect behavior
and retained-bootstrap holds remain unchanged.

Initial open consistently uses its captured initialization result. Every reused
startup activation/recovery must actually call existing `authority.read`, detach
and validate its result, replace current room state, then derive the route anew.
This includes settlement-owner recovery after hot adoption. Initialization's
create/migrate operation is not a refresh; a saved original genesis route or
locally remembered state is not authority for another activation.

## Publication, reactivation and retry

Preserve live ordering: verification/staging → host begin → AHE publication →
host commit and independent reread → hot activation. Save a successful begin's
detached pending state; save committed stable state only after its independent
reread succeeds. Neither assignment independently authorizes activation.

Pending startup uses accepted 2c, checks the exact returned next head, commits
and rereads host floor, then performs accepted cold reopen, authenticated base
installation and replay. Already-new AHE still requires pending authentication
and host commit/reread. Stable-successor startup directly authenticates its exact
floor expectation without genesis preparation/bootstrap issuance.

Refresh actual authority on an explicit adoption retry before selection or the
existing current-plane no-op. No-op requires an actual no-pending floor matching
the authenticated current plane. If interrupted work left durable pending or an
already-committed successor, reconcile through the existing authenticated startup
recovery/base/rebind machinery, not consumed hot capabilities or genesis fallback.
Preserve predecessor deactivation, close rebind and replacement cleanup ownership.
An in-process observation cannot lower an already authenticated active epoch or
replace its same-epoch anchor. A pending expectation can be reconciled only
through authentication of its next head; a lost/regressed floor is not repaired
by selecting genesis. Fresh reopen retains the existing host freshness/custody
threat model; this is not protection against whole-origin rollback.

A failed begin/publication/commit/reread attempt stays failed; no automatic retry
or favorable reinterpretation. Commit with lost response or failed reread permits
no replacement activation, base replay or success callback on that attempt. The
next explicit retry/recovery/reopen reads actual durable floor and authenticates
it. Missing, invalid, unavailable or conflicting observations refuse without
using saved state. Cross-store writes are not atomic: host pending, AHE old/new
or already-committed host state can remain after failure. Preserve the primary
failure and existing cleanup, not a fictional rollback of those writes.

Keep transport-before-pending/cold invocation order. Successor authentication or
byte failure may therefore open transport before refusing and shutting it down.
No room-generated live issuance/signing, retained-history request or new plane
activation follows floor commit/reread failure within that attempt. Do not add a
session-wide terminal policy to every preactivation hot-adoption failure.

## Refusals and honest observation boundary

Preserve existing helpers' actual mappings: host throw/unavailable →
`D110C_FLOOR_UNAVAILABLE`; malformed initialization/result/state →
`D110C_FLOOR_INVALID`; explicit conflict, null create/migrate response or wrong/null
commit response → `D110C_FLOOR_CONFLICT`; null reopen/read → migration-required; valid commit then
different valid reread → `D110C_FLOOR_MISMATCH`. Reread invalid/unavailable retains
its actual failure. Non-null create/migrate responses retain the existing detached
state validation; initialization does not add equality to the requested head.
Existing regression/mismatch refusal must remain fail closed;
new reached-gate evidence, not obsolete hint precedence, owns affected fixtures.

Keep room pending-invalid versus recovery-unavailable mapping and unchanged cold
failure wrapper. The exact returned-next-head guard stays mandatory, but its
token selection remains based on the returned failure kind: an otherwise-successful
wrong-head response has no failure kind and maps to recovery-unavailable, not
pending-invalid. This corrects the linked proposal's broader token claim without
adding a kernel result or changing room failure policy.
Actual missing/corrupt bytes reach the accepted kernel's real
failure gate. Synthetic positive-epoch tuples are not authenticated wrong-head
fixtures. Preserve accepted candidate-local filtering/fork and CAS/reread policy.

Unsupported successor composition is classified after invite/scope capture and
ordinary authority initialization, before room store opens, genesis preparation,
bootstrap issuance, transport opening or signer/admission-policy invocation.
Preserve existing earlier application/bootstrap/binding validation. Defer broad
object-rest forwarding capture until after this state/composition guard so it
does not read unrelated signer/transport getters just to copy unsupported input.
Provider methods and necessary invite/scope/composition properties are observable;
application/database properties needed by earlier validation can be read, and
initialization can affect external host state. This deliberately replaces the
historical declaration-based zero-application/store/signer/transport-getter rule.
Upstream shipped invite signing and grid network startup are outside this boundary.

Successor plus admission factory or rebase source remains unsupported. Legacy
successor plus creator finality signer remains unsupported; settlement-v1 signer
remains supported. Genesis checks remain. Earlier invalid application/invite/
provider can win over later composition refusal; no hint-only early guard.

Keep canonical authenticated-base verification, predecessor-cache clearing,
buffered startup delivery and awaited accepted-callback ordering before projection
mutation. Callback rejection still fails the session closed; reopen can replay
notifications. No exactly-once callback promise is introduced.

## Separate RED and historical evolution

After contract acceptance a separate high RED author freezes new causal startup
oracles and original failures before a distinct GREEN author changes product.
Only proven conflicts below may evolve; keep every unaffected registration,
assertion, default coverage, engine and budget. See the proposal for exact sources.

- Room source-callsite tests: evolve declaration-selected ancestry into genuine
  shared floor selection and causal wrong/stale-selector controls. Preserve both
  API argument omissions and unambiguous literal-call/malformed/spread/missing/
  duplicate refusals, with their source-only runtime/coverage qualification.
- Native pending-without-declaration: evolve the real interrupted room from its
  obsolete no-hint refusal to success with publication→commit→reread→cold order.
  Preserve old/new AHE controls and all unaffected provider faults.
- Historical missing-snapshot case that removes only a caller hint after genuine
  adoptions: evolve to stable no-hint success and add a separate actual owner
  metadata/byte loss or corruption negative. Undefined hint is not missing bytes.
- Declaration-selected composition/read-order cases: provide real scoped invite
  and initialized authority, preserve support policy, and causally assert the new
  property-observation versus zero-room-invocation boundary.
- Public room/chat option rosters and dependent forwarding/type assertions: remove
  the option coherently; real shipped omission success remains required.

Synthetic floor-ahead and genesis-floor-over-successor fixtures have obsolete
hint-precedence dependencies but unproved replacement tokens/gates. Separately
authorized RED establishes their real fail-closed reached gates before freezing
expectations; do not guess or weaken genuine genesis trust authentication. Any
additional provider-fallback or historical conflict needs concrete evidence and
separate allocation. GREEN cannot repair frozen tests for convenience.

## Decisive product evidence and firewalls

RED freezes a minimal causal matrix, not a full Cartesian product. GREEN must
execute and pass the previously masked behavior against changed product:

- Shipped grid/chat create/join and ordinary genesis open/restart, without a
  declaration option: exact projection/replay and continued issuance. In-memory
  chat provider success does not prove durable host persistence.
- Genuine stable successor, including later checkpoint: exact trusted/durable
  head, actual bytes, authenticated base before replay/callbacks and continued
  writes; no genesis preparation or duplicate bootstrap issue.
- Pending from genesis/later checkpoint under old/new AHE: accepted pending
  verification, exact host commit/reread before cold activation and no competing
  scope selection.
- Genesis open → hot adoption → reused settlement recovery/rebind: actual host
  read and current successor authentication, not saved original genesis selection.
- Begin/publication/commit/reread interruptions or ambiguity then explicit retry/
  reopen: failed attempt has no successor activation; next attempt authenticates
  actual durable pending/committed state, preserving primary failure and cleanup.
- Missing/invalid/unavailable authority and lost/regressed floor: refusal at the
  actual gate, no genesis fallback or activation. Genuine authenticated wrong
  state is independent from synthetic invalid lineage.
- Real missing/poisoned metadata and missing/corrupt/replaced bytes, independent
  from no-hint positives: actual lookup/read/reopen reach and transport/shutdown.
- Unsupported composition and explicit internal routes: documented observations
  and zero-room-invocation boundary, profile distinctions and genuine internal
  authentication/retained-bootstrap behavior, no ordinary exemption.

Native room reopen uses real IndexedDB in Chromium/Firefox/WebKit, setup pages/
workers closed before fresh recovery realms and exact owned origins/databases.
No declaration/manifest/chunk/payload crosses into product recovery. SQLite
kernel preservation is not a nonexistent SQLite room adapter. Reuse accepted
identity-preserving observers; new harness work requires a demonstrated behavior
blind spot, instrumentation effect or unsafe cleanup. Cosmetic controls/custody
do not reopen accepted reviews or justify unchanged matrix reruns.

Prospective GREEN allocation is the room private floor/startup lifecycle and
shared consumers, room public input/forwarding removal and chat input/forwarding
removal. Grid changes only for a proven declaration consumer, not a new host
provider. No changes to accepted cold/pending kernels, shared verifier/receipts,
live producer facts, native owners/factories/schema, retention/legacy policy or
finality. Rollback, recipient pinning, protected-set planning, retirement,
boundedness/endurance and archive/device acceptance remain later seams.

Require independent Codex 6.1 xhigh contract, separately authored RED and distinct
GREEN; build-before-test, focused strict/lint/format, relevant full product/native
and historical gates under ordinary budgets, then xhigh GREEN review and root
raw-evidence disposition. Known broader failures remain failures, with no waiver,
repinning or budget expansion. No visual UI/endurance claim belongs to this seam.
