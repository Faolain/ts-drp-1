# Phase 6d — Scoped v3-only finality retirement

Status: user-authorized scope replacement, 2026-10-02; planning/audit only.
Independent contract review and separate RED/GREEN are required before product
removal. The [live handoff](../README.md#next-agent-prompt) owns execution order;
this slice does not interrupt the accepted 2c allocation or accept Phase 6.

## Outcome and boundary

The greenfield product ships v3 only. Retire the obsolete per-vertex BLS
attestation/finality plane rather than designing enabled legacy-finality expiry,
compaction or a certified replacement. Shipped applications must not activate it
through defaults, opt-in configuration, imports, wire dispatch or restored state.
Do not replace it with per-operation quorum receipts without an explicit product
requirement. Epoch certificates and existing artifact-bound availability evidence
are different contracts, not permission to add operation receipts.

Keep current v3 operation authentication, signing/seal custody, certificates,
settlement, issuance safety, authenticated recovery closures and retained rollback
dependencies. Their later bounded cleanup belongs to the existing protected-set
planner and crash-safe retirement protocol; a name containing `finality`, `BLS`
or `legacy` is not a deletion predicate. Storage schema version numbers likewise
do not select the shipped protocol version.

## Consumer audit before removal

The [source audit](../../../.logs/bounded-storage-lifecycle/v3-only-scope-plan-01/finality-consumer-audit.md)
owns the concrete consumer, activation and evidence inventory. It is source proof,
not runtime or deployed-user evidence. Freeze it and disposition every consumer
at the contract checkpoint before RED. Trace configuration/defaults, object
construction, apply/rollback, query/sign/sync/wire behavior, public exports,
examples/build entry points and any durable codecs/imports that actually use the
old plane. Distinguish active shipped capabilities from historical fixtures.

Existing chat/canvas examples create/connect writer objects with default finality
and install BLS signer keys. Their activation is real, but that alone does not
show chat/paint functionality requires per-vertex attestations. Explain any
genuine shipped dependency before removal. Preserve the required capability on
a verified v3 path; an old entry point may be retired only with an explicit
shipping disposition and proven replacement for any golden-path capability it
represented. Do not silently drop an application or change operation admission
by deleting similarly named crypto code.

The separate [shipping ledger disposition](../../../.logs/bounded-storage-lifecycle/v3-shipping-capability-review-01/root-disposition.md)
retains chat, additive RGB canvas, grid/zone, CLI/RPC and public SDK capabilities.
It accepts one prospective host-neutral v3 room owner with application kernels
and explicit host acquisition, not exact app/RPC schemas, real ports or runtime
equivalence. The seeded v3-chat harness is not the shipping replacement, and zone
overwrite is not additive canvas. Freeze app identity/time/retry semantics, genuine
catalog/head/close custody, receive-only open and versioned bounded RPC/archive
coverage separately before executable porting. No capability is silently archived.

CLI/RPC create/connect reachability belongs to the same shipped activation audit;
sharing a v3 room's network node does not itself enforce a v3-only product profile.
Preserve every [Appendix C golden-path assertion](../../../docs/production-hardening/production-hardening-tdd-plan-v2.md#appendix-c--golden-path-verification),
including concurrent Writer grant and Finality-role revocation, ACL resolver
behavior and revoked authority. Freeze the current-v3 authorization counterpart
before removal; a permission named Finality is not itself an obsolete attestation.
The [accepted operation-authorization contract](../../../.logs/bounded-storage-lifecycle/v3-authorization-contract-review-01/root-disposition.md)
selects the existing latched-ACL owner for one early operation decision and
genuine next-anchor role composition. Its prospective A/B allocations are not
runtime or profile-complete authorization acceptance. Fixed creator seal-key
continuity is distinct from ACL Finality/key and Admin revocation; preview output
must not replace authenticated signer continuity. Dynamic signer changes,
certified successors and jointly invalid close selection require separately
governed contracts. Preserve every golden authority assertion through those
prerequisites, not by deleting assertions or manufacturing operation receipts.

The [accepted retired-wire/durable-input policy](../../../.logs/bounded-storage-lifecycle/v3-wire-durable-policy-review-01/root-disposition.md)
requires raw structural admission before generated decoding can erase retired
type/field evidence, under one Node eligibility owner. Preserve current v3
signature fields, CUSTOM, discovery and its required transport. Whole old
live-object-family refusal follows genuine capability ports; versioned bounded
RPC/query and actual repair remain separate contracts. This is prospective
policy, not enforcement, porting or retirement acceptance.

If a current durable record requires old evidence for safe recovery or migration,
retain or isolate that required read/transition path with fail-closed semantics
and an explicit removal condition. Do not enable new legacy authoring through
it. Snapshot-owner inherited rows, migration barriers and recovery debt remain
protected until authenticated classification and retirement fencing justify
their handling. Greenfield shipping is not authority to erase current data.
Supported current-v3 durable predecessors remain protected regardless of schema
or legacy labels. Existing whole-array historical rehydration is not a bounded
importer, and small cursor memory does not bound total migration work. Missing
original signed source remains held debt, never fabricated recovery authority.
Inherited-data classification remains ordered after protected planning and
cross-store fences; finishing fresh-owner recipient retention does not clear the
migration barrier or claim all inherited rooms migrated.

## One owner and scoped allocation

After the audit, freeze one coherent removal allocation: obsolete runtime store,
configuration/exports and their attestation-only consumers; affected shipped
entry points and wire admission must agree on v3-only behavior. Remove redundant
old owners instead of retaining disabled shims indefinitely. Historical evidence
and characterization remain archived honestly; tests for retired behavior may
be explicitly reclassified, not silently weakened by GREEN. Keep operation
signatures and transport identities separate from old finality attestations.

No compatibility retention policy, per-operation receipt design, protocol-suite
rewrite, blanket migration removal or independent age-based sweeper belongs to
this slice. Any genuinely load-bearing dependency discovered during the audit
must be explained and separately resliced before broadening the patch.

## Decisive RED/GREEN evidence

Separate authors freeze causal RED before GREEN. Pin shipped v3 create, join,
write, sync, close/adopt and restart/recovery paths, with actual supported app
profiles rather than fixture-only off-switches. Prove obsolete activation cannot
occur under default or explicit old configuration, old incoming attestation
messages, sync/update piggyback fields, late callbacks or durable reopen. Use
activation mutants and reached assertions: an empty finality map or unused symbol
search alone is insufficient. Verify production source/export/build reachability
as well as runtime behavior; no old store or alternate receipt map may relocate
unbounded per-operation state.

Preserve current-v3 signing/certificate/settlement and recovery positive/negative
controls, usable rollback, crash/restart safety, continued writes, exact admitted
and applied operation counts, final state digests, and bounded census/heap gates.
Pair memory claims with correctness/accounting; removing records by dropping
writes cannot pass. Test required durable-data migration separately from retired
protocol activation. Preserve thresholds, ordinary runners and earlier evidence.

Run build-before-test, focused strict typecheck, lint/format, affected native
browser/SQLite suites and shipped application regressions. Record commands,
exits, source/output custody, raw results and cleanup. Obtain a separate Codex
6.1 xhigh review at contract/RED/GREEN checkpoints; implementation/investigation
authors use Codex 6.1 high. Root dispositions all findings before acceptance.

## Phase closure

Phase 6d replaces only the old enabled-finality retention implementation.
Finish pending recovery, declaration-free startup, usable rollback and recipient
retention first, then protected planning, crash-safe retirement, journal/current-v3
evidence cleanup and bounded recovery. Phase 6 still requires the same-room proof
of at least 100 authenticated transitions with restart/recovery/pruning,
continued writes, exact state/operation accounting and bounded storage/memory;
0→1→2 and diagnostic runs remain partial. Preserve stronger existing endurance
gates. Close all remaining Phase 6 gates before Phase 7 archives/paging, and
complete all golden-path browser and real-device acceptance at the release SHA.
