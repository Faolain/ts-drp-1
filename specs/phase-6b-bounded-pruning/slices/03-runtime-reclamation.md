# D.109d — Installed-v3 Runtime Reclamation

## Status and source correction

D.109d starts only after signed/pushed D.109c closure
`f5e76815df5201678f69934a1fc53eb0bf51a1a6`. D.109a planning, D.109b
issuance pruning, D.109c AHE reclamation, and all of their immutable evidence
remain accepted prerequisites. This slice changes only receipt-gated in-memory
retention in the installed v3 runtime. It authorizes no scheduler, retained
campaign, threshold, dependency, schema, protocol, wire, digest, QC, adoption,
availability, legacy-finality, or product-API change.

The earlier two-paragraph draft incorrectly said that the installed v3 runtime
orchestrates an `@ts-drp/object` owner. Source inspection disproves that claim:
`packages/node/src/v3-live.ts` imports no `@ts-drp/object` code and directly
owns its v3 graph, causality, blueprint-state, pending, quarantine, publication,
and rebase structures. The `DRPObject`/`HashGraph.compactPayloadHistory()` path
is a separate legacy/general runtime with already-shipped compact-history
semantics. D.109d must not add a fictitious binding to it or change its
`vertices`, `forwardEdges`, `frontier`, `vertexDistances`, state snapshots,
checkpoints, known hashes, finality state, or public surface.

The installed v3 ownership boundary is instead:

| Lifetime              | Genuine owner                                                               | Closed-epoch retention in scope                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| active successor      | current `V3PlaneRegistration` in `@ts-drp/node`                             | `displacedSource` authentication payload and any completed rebase snapshot/cursor that still retain the closed predecessor                                             |
| hot predecessor       | retired `V3PlaneRegistration` displaced during same-topic transport handoff | application vertex/author/charge maps, `CausalityIndex`, latched operations, blueprint machine/handle, pending ingress, quarantine set, and publication/rebase cursors |
| cold reopen           | no predecessor registration exists                                          | only the reconstructed `displacedSource` retained by the active successor                                                                                              |
| durable replay        | `DurableLiveJournalStore`                                                   | out of scope: neither D.109b nor D.109c emits authority to delete journal rows                                                                                         |
| legacy/general object | `@ts-drp/object`                                                            | out of scope and byte-identical in D.109d                                                                                                                              |

The active successor already owns the new epoch anchor, imported canonical
blueprint state, current causality index, current pending ingress, current
quarantine inventory, and current publication state independently. D.109d
never compacts those live structures. It releases only predecessor retention
after both physical owners have emitted matching receipts.

## Frozen internal contract

Add one package-internal, non-exported owner under
`packages/node/src/internal/runtime-reclamation.ts`. It installs one private
kernel in `v3-live.ts` and accepts exactly:

```text
{
  aheReceipt,
  issuanceReceipt,
  successor
}
```

`successor` must be a genuine current raw or aliased v3 handle resolvable by
the existing private handle-registration identity map. Structural fakes,
proxies, predecessor handles, inactive handles, snapshot-closed handles, and
foreign aliases fail closed. No method or key is added to `V3PlaneHandle`, the
creator-successor product authority, the node root, or `package.json` exports.

The internal result is a deeply frozen closed union:

- success: `ok: true`, exact object/closed/successor epochs, replay boolean,
  and before/after censuses for the predecessor-bearing structures;
- refusal: `ok: false` and exactly one of
  `D109D_INVALID_ARGUMENT`, `D109D_RECEIPT_MISMATCH`,
  `D109D_IDENTITY_MISMATCH`, `D109D_RUNTIME_NOT_READY`, or
  `D109D_INTERNAL_INVARIANT`.

Malformed exact-record shape has first precedence. Receipt disagreement is
next, genuine runtime identity is next, lifecycle/readiness is next, and a
closed internal construction failure is last. Every refusal performs zero
runtime writes and does not poison the successor.

### Receipt match

The owner snapshots both untrusted receipt values before its first await and
requires their complete exact shapes. It accepts both first-execution and
lost-receipt replay forms emitted by the existing D.109b/D.109c owners. It
then requires all of the following:

1. issuance and AHE `objectId`/`closedEpoch` agree;
2. the issuance scope equals the successor registration's exact durable
   issuance scope and the displaced source's object identity;
3. `closedEpoch` equals the displaced source epoch and the successor epoch is
   exactly `closedEpoch + 1` in the safe-integer domain;
4. the issuance `snapshotManifestDigest` equals the exact field decoded from
   the successor's authenticated canonical generation projection;
5. the issuance `commitQcRef` occurs exactly once, byte length and digest, in
   the successor's authenticated adopted closure;
6. the AHE `expectedHead`, `activeGenerationId`, object, and rollback/floor
   identities are internally valid and its expected head equals the
   successor registration's exact adopted head; and
7. the AHE availability digest remains the frozen local-only digest.

The runtime never reconstructs either receipt from memory and never treats a
missing receipt as success. It does not reverify QC, rescan a database, infer
availability, or widen either durable owner's authority.

### Serialized make-then-release

Reclamation joins the successor's existing `enqueueRegistrationTask` gate, so
all earlier issue, ingress, publication, and rebase work settles first and all
later work observes either the complete pre-state or complete post-state. The
kernel rechecks current handle identity and every receipt predicate inside that
turn. It constructs the complete retained predecessor root/index and immutable
result census before mutation; no user callback, store call, decode, allocation,
or other throwing work occurs after the first release write.

On success it:

- removes the successor's `displacedSource`, completed rebase snapshot, and
  displaced rebase cursor;
- in a hot handoff, compacts the retired predecessor to its authenticated epoch
  anchor, retaining exactly one vertex, one byte charge, a one-entry causality
  index, the immutable object/epoch/topic handle identity, and no ordinary
  author entry;
- clears only the retired predecessor's latched-operation, pending-ingress,
  quarantine, publication, rebase, and blueprint-state references; and
- severs the successor-to-retired-registration link after the compacted census
  is complete.

The current successor's anchor, application maps, causality index, blueprint
machine, ACL, pending ingress, quarantine, publication cursor, stores, network,
queue, topic, active handle, and canonical state remain referentially and
observably unchanged. Legacy finality and both durable stores are untouched.
Repeated invocation with the same receipts returns a frozen replay success and
does not require the removed predecessor payload. Different receipts after
success fail closed.

## Deterministic RED

Add exactly two tests-only owners:

- `tests/fixtures/phase-6b/runtime-reclamation-contract.ts`; and
- `tests/phase-6b-runtime-reclamation-red.test.ts`.

The fixture must use the genuine creator close → verify → commit → hot activate
path and the existing D.109b/D.109c maintenance owners to produce real receipts;
synthetic records are permitted only for negative mutants. A cold-reopen case
must prove the same cleanup without a hot predecessor registration.

Freeze these matrices before implementation:

- exact refusal precedence and unknown/accessor/proxy/aliased input rejection;
- either missing receipt, every shared object/epoch mismatch, wrong issuance
  scope, snapshot manifest, commit-QC ref/digest/length, AHE head/revision/
  generation, policy, rollback, and floor mismatch;
- fake, predecessor, inactive, foreign and snapshot-closed handles;
- hot and cold positive controls, lost-receipt replay, and different-receipt
  post-success refusal;
- a queued-operation ordering control proving reclamation waits behind existing
  work and a later live operation sees only the post-state;
- before/after exact census of every listed predecessor-bearing structure;
- a raw-dependency probe proving later successor issue, ingress, publication,
  rebase-empty, close capture, and snapshot export do not read a released
  predecessor vertex or payload;
- a precommit construction-failure mutant proving byte-identical pre-state and
  subsequent live usability; and
- source guards proving no `@ts-drp/object`, finality, durable-store mutation,
  package export, product-handle key, dependency, threshold, or scheduler
  change.

RED is accepted only when the focused file reports the exact frozen controls
green and the sole readiness assertion fails with
`D109D_RUNTIME_RECLAMATION_MISSING`; no retained Phase-6b assertion may fail.
RED contains no production edit and is signed/pushed with a validating
self-excluding evidence manifest.

## GREEN and gates

The prospective GREEN path set is limited to:

- `packages/node/src/internal/runtime-reclamation.ts`;
- `packages/node/src/v3-live.ts`;
- the two D.109d tests-only owners; and
- this slice, the Phase-6b handoff, and the main evidence ledger.

If implementation proves that `creator-adoption-activate.ts`, an
`@ts-drp/object` owner, a public export/API, durable schema/store, live-journal
deletion, dependency, threshold, protocol/wire/digest/QC/adoption/availability
contract, or more than the installed successor/predecessor registrations must
change, stop before editing it and reslice with a new reviewed plan. In
particular, the inherited stale-`activeOwners` multi-rollover P2 is not silently
folded into D.109d; D.109f must prove the repeated-epoch path or assign its own
causal prerequisite.

Run in order:

1. focused D.109d test once for RED and once after complete GREEN;
2. retained D.109a, D.109b, D.109c and Phase-6a close/adoption/activation tests;
3. Node, compaction, object, issuance-store, storage, storage-node, and
   storage-browser affected builds/typechecks;
4. exact-owner ESLint, Prettier, `git diff --check`, source-shape, export-census,
   changed-path, protected-path and stash checks; and
5. a validating self-excluding evidence manifest with exact commands, statuses,
   reporter counts, complete soft-failure sets, owner hashes, and pushed commit.

No retained campaign runs in D.109d.

## Review policy

Because this slice releases authenticated runtime state, its bounded plan is
signed/pushed and receives one Grok 4.6/high, standard Kimi CLI K3/high with
`KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh review before RED. The
standard `kimi` call is authoritative; legacy `kimi-cli`, unsupported `--auto`,
and Codex/Sol substitution are prohibited. If Grok cancels, resume that exact
session. Only P0/P1 blocks; one correction batch and at most one confirmation
are allowed only for a material executable/scope/causal change.

After signed/pushed GREEN, one final Grok/Kimi/Opus review inspects the complete
plan → RED → GREEN history and causal evidence. No separate full RED review,
Fable, collaboration subagent, retained campaign, or recursive review of
bookkeeping/closure prose runs.
