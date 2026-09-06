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

| Lifetime                          | Genuine owner                                                               | Closed-epoch retention in scope                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| active successor                  | current `V3PlaneRegistration` in `@ts-drp/node`                             | `displacedSource`, authenticated displaced issuance boundary, completed rebase state, replay latch, and one non-owning hot-predecessor reference                |
| hot predecessor                   | retired `V3PlaneRegistration` displaced during same-topic transport handoff | application vertex/author/charge maps, `CausalityIndex`, blueprint state, pending/quarantine/publication/rebase state; retained ACL preview metadata is bounded |
| bound predecessor close authority | `packages/node/src/creator-close.ts`                                        | separately captured graph, staged/persisted snapshot, derived commitment, and sealed durable-replay rows                                                        |
| cold reopen                       | no predecessor registration exists                                          | only the reconstructed `displacedSource`; no creator-close or hot-registration owner exists                                                                     |
| durable live journal              | `DurableLiveJournalStore`                                                   | out of scope: neither D.109b nor D.109c emits authority to delete journal rows                                                                                  |
| legacy/general object             | `@ts-drp/object`                                                            | out of scope and byte-identical in D.109d                                                                                                                       |

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

Malformed exact-record shape has first precedence. Self-contained disagreement
between the two well-shaped receipts is next. Genuine current-successor
identity is then resolved before any receipt comparison that needs a
registration. Registration-bound receipt disagreement follows, then
lifecycle/readiness, then a closed internal construction failure. Thus a fake
handle plus mutually inconsistent receipts yields `D109D_RECEIPT_MISMATCH`; a
fake handle plus internally consistent receipts yields
`D109D_IDENTITY_MISMATCH`; and no identity mutant is shadowed by a comparison
against a registration that was never resolved. Every refusal performs zero
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
7. the AHE availability digest remains the frozen local-only digest; and
8. the issuance `prunedThroughAuthorSequence` equals the exact maximum
   authenticated displaced local-issuance ordinal recorded while the existing
   successor-recovery path verifies the predecessor outbox. A genuine D.109b
   partial-prefix receipt is insufficient even when every deleted row was
   published.

The eighth value is not inferred at cleanup time and does not add a store
rescan. `v3-live.ts` records it while recovery already reads, authenticates, and
classifies the complete displaced outbox before activation. A missing boundary,
a surviving authenticated displaced row above the receipt watermark, or a
watermark below/above that exact boundary is `D109D_RECEIPT_MISMATCH`.
Successor-epoch rows above the boundary remain valid and untouched.

The runtime never reconstructs either receipt from memory and never treats a
missing receipt as success. The commit-QC comparison proves exact byte-length
and digest membership in the adopted closure; it does not relabel an arbitrary
closure member as a semantically reverified QC. The runtime does not reverify
QC, rescan a database, infer availability, or widen either durable owner's
authority.

Before the first release write, the owner freezes one bounded replay latch from
the authority-bearing fields: object/closed/successor epochs, issuance scope,
exact closed-epoch ordinal boundary, issuance `observedLineage`,
snapshot-manifest digest, commit-QC ref, adopted head, active generation,
exact `reclaimedGenerationIds` prefix, rollback/floor identities, and
availability policy. D.109b's `deletedAuthorSequenceRange` and only D.109c's
physical deletion-result fields (`deletedBlobDigests`, `deletedGenerationIds`,
`deletedPromotionCount`, and `floor.normalizedThisCall`) are outcome fields, so
their genuine first-call versus lost-receipt-replay forms do not alter latch
identity. `observedLineage` and `reclaimedGenerationIds` are never classified
as outcome fields. After release, replay requires the same current successor
plus an exact latch match; any changed authority field is
`D109D_RECEIPT_MISMATCH`.

### Serialized make-then-release

Reclamation joins the successor's existing `enqueueRegistrationTask` gate, so
all earlier issue, ingress, publication, and rebase work settles first and all
later work observes either the complete pre-state or complete post-state.
Receipt snapshots alone may be captured synchronously; every census, identity
recheck, readiness predicate, predecessor-gate wait, and mutation runs in the
queued thunk, never in `enqueueRegistrationTask`'s synchronous `capture()`
phase. A live hot predecessor is reached only through a non-owning
`WeakRef<V3PlaneRegistration>` installed at handoff. If it is still reachable,
the thunk awaits its gate and rechecks that it is the exact inactive direct
predecessor; if it has already been collected, its runtime state needs no
manual compaction. No strong successor-to-retired-registration link or
multi-epoch registration chain is permitted.

For a genuine bound creator-close authority, `creator-close.ts` registers one
package-internal no-throw release owner keyed by the predecessor handle. It is
ready only after `terminalizeSource()` reached `successor-adopted`. The kernel
constructs the complete retained predecessor root/index, close-owner release
plan, replay latch, and immutable result census before mutation. No user
callback, store call, decode, allocation, or other throwing work occurs after
the first release write.

On success it:

- removes the successor's `displacedSource`, completed rebase snapshot, and
  displaced rebase cursor;
- in a hot handoff, compacts the retired predecessor to its authenticated epoch
  anchor, retaining exactly one vertex, one byte charge, a one-entry causality
  index, anchor byte total, graph version one, the immutable object/epoch/topic
  handle identity, and no ordinary author entry;
- preserves the retired registration's bounded authorization, prepared
  anchor/projection/catalog/runtime metadata and `latchedOperations`, because
  its still-callable `previewLatchedAcl` observes those operations; records
  pending ingress as already empty at handoff; and clears its quarantine,
  publication, rebase, and blueprint-state references;
- clears a present creator-close owner's separately captured graph,
  staged/persisted snapshot, derived commitment, and durable-replay rows while
  preserving its already-unavailable `close()`, `status()`,
  `inspectDurableHead()`, and `stop()` behavior; and
- deletes the replayed non-owning predecessor reference after the complete
  post-census is frozen.

The current successor's anchor, application maps, causality index, blueprint
machine, ACL, pending ingress, quarantine, publication cursor, stores, network,
queue, topic, active handle, and canonical state remain referentially and
observably unchanged. Legacy finality and both durable stores are untouched.
Repeated invocation with the same receipts returns a frozen replay success and
does not require the removed predecessor payload. Genuine first-call and
lost-receipt outcome differences are accepted only when their authority latch
is identical. Different authority bindings after success fail closed.

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
  generation, policy, rollback, and floor mismatch, plus a genuine D.109b
  partial-prefix receipt below the authenticated displaced ordinal boundary;
- fake, predecessor, inactive, foreign and snapshot-closed handles;
- hot and cold positive controls, first-call/lost-receipt replay equivalence,
  post-success `observedLineage` and `reclaimedGenerationIds` authority
  mutations, other changed-authority post-success refusal, and replay without
  displaced payload;
- a queued-operation ordering control proving reclamation waits behind existing
  successor work and the retired predecessor gate, and that later live work
  sees only the post-state;
- before/after exact census of every listed predecessor-bearing structure,
  including creator-close duplicates, anchor byte total, graph version,
  intentionally retained ACL/payload metadata, and an absent strong
  registration chain;
- a raw-dependency probe proving later successor issue, ingress, publication,
  rebase-empty, close capture, and snapshot export do not read a released
  predecessor vertex or payload;
- a precommit construction-failure mutant proving byte-identical pre-state and
  subsequent live usability; and
- source guards proving the hot predecessor reference is non-owning and direct,
  and proving no `@ts-drp/object`, finality, durable-store mutation, package
  export, product-handle key, dependency, threshold, or scheduler change.

RED is accepted only when the focused file reports the exact frozen controls
green and the sole readiness assertion fails with
`D109D_RUNTIME_RECLAMATION_MISSING`; no retained Phase-6b assertion may fail.
RED contains no production edit and is signed/pushed with a validating
self-excluding evidence manifest.

### RED evidence

The corrected plan/confirmation gate is signed and pushed at
`e2ef3fbdf66deb138eaefde72abe1e23e9e46fe1`. RED adds exactly the two frozen
tests-only owners and no production edit. Its accepted focused reporter
selected one file and twelve declared tests: four control assertions passed,
seven GREEN-only semantic tests were skipped by the composite readiness gate,
and the sole failure was the readiness assertion with exact token
`D109D_RUNTIME_RECLAMATION_MISSING`. There were no top-level errors or other
soft failures. The non-consuming listing selected the same one file and its
five active RED assertions.

One earlier collection attempt is preserved and rejected as noncausal evidence:
an unescaped `}` in a test-only source-shape regex caused zero tests to collect.
Only that diagnostic was corrected; it was not treated as a product or
semantic failure. Exact-owner ESLint, Prettier, diff, changed-path, protected-
path, 26-stash, and source-owner hash checks pass. No retained campaign ran.
The complete RED evidence root is `.logs/phase-6b-d109d-red/`; its validating
self-excluding manifest SHA-256 is
`290c2cccbbdccc23ced7d91492e305d14ef82cf6380e006b4dea61201ee36874`.

## GREEN and gates

The prospective GREEN path set is limited to:

- `packages/node/src/internal/runtime-reclamation.ts`;
- `packages/node/src/v3-live.ts`;
- `packages/node/src/creator-close.ts`;
- the two D.109d tests-only owners; and
- this slice, the Phase-6b handoff, and the main evidence ledger.

The third production owner is the smallest honest correction for the
demonstrated creator-close duplicate retention; it does not change close,
adoption, activation, or product authority. If implementation proves that
`creator-adoption-activate.ts`, an
`@ts-drp/object` owner, a public export/API, durable schema/store, live-journal
deletion, dependency, threshold, protocol/wire/digest/QC/adoption/availability
contract, or another production owner must change, stop before editing it and
reslice with a new reviewed plan. In
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

The first plan review of signed commit
`8c7648c87f2faed2a22c9a4db263c9c76b98383e` completed with material findings
from Grok, Kimi, and Opus. Their union is preserved under
`.logs/phase-6b-d109d-plan-review/`. This correction accepts the complete
demonstrated P0/P1 union in one batch. Because it changes receipt acceptance
and adds the omitted creator-close production owner, exactly one confirmation
round reviews this corrected executable plan before RED; no further plan round
is permitted absent a newly demonstrated P0/P1.

## GREEN implementation and evidence

GREEN adds the frozen package-internal owner and no public surface. The
internal entry snapshots the exact closed input, delegates only to the single
installed v3 kernel, and converts both synchronous and asynchronous kernel
failure to `D109D_INTERNAL_INVARIANT`. `v3-live.ts` records the maximum
authenticated displaced issuance ordinal during its existing complete outbox
classification, installs a direct `WeakRef` only for a genuine same-transport
handoff, validates and latches every authority field, joins the successor gate,
awaits and rechecks a reachable predecessor gate, constructs the complete
post-state before mutation, and then releases the frozen owner set.
`creator-close.ts` supplies the separately demonstrated no-throw release plan
only after `successor-adopted`; it clears the captured graph, staged/persisted
snapshot, derived commitment, and durable replay while preserving the close
handle's status, durable-head inspection, and stop behavior.

The corrected test fixture uses the genuine close → verify → commit path and
the exact hot transport bindings. It copies the authenticated issuance commits
into a temporary genuine Node issuance store and obtains first-call, replay,
and partial-prefix receipts from
`resolveNodeDurableIssuancePruningMaintenance`. It also reconstructs the exact
four-generation adopted lineage and every referenced blob in a temporary
SQLite AHE store, then obtains first-call and replay receipts from
`resolveNodeAheReclamationMaintenance`. No synthetic successful receipt is
accepted as evidence. An independent-transport activation covers the
no-retired-registration branch; the same-transport path proves the actual hot
predecessor and creator-close owners.

The accepted focused reporter is
`.logs/phase-6b-d109d-green/focused-accepted.json`: one selected file, twelve
declared tests, twelve passed, zero failed/skipped/top-level errors. It covers
all 27 receipt mutants, seven identity labels (including a genuine deactivated
handle and proxy/copy identities), fourteen replay-authority mutations, the
five permitted outcome differences, exact hot before/after census, cold
absence, queued successor ordering plus predecessor-gate source custody, live
successor issue/publication after release, close-handle preservation, and
pre-write failure usability. Earlier all-green reporters remain immutable but
are rejected as final evidence: one used the shared D.109c receipt constructor
instead of native maintenance, one preceded the asynchronous closed-union
guard, and one preceded the genuine inactive-handle assertion.

Retained evidence is green:

- D.109a/b/c plus Phase-6a Node/Vitest paths: 142/142;
- D.109b Chromium retention: 4/4;
- D.109c Chromium reclamation: 4/4;
- Phase-6a Chromium adoption/death: 2/2; and
- Phase-6a Chromium activation: 8/8.

All seven affected package builds pass. Compaction, issuance-store, and storage
whole-package typechecks pass. Node, object, storage-node, and storage-browser
whole-package typechecks retain their pre-existing test/configuration failures:
worker-host `rootDir`/file-list inclusion, the retained WebRTC `emit` typing,
compact-history negative/config union fixtures, cross-package test-root
inclusion and unresolved workspace aliases, and D.109c browser negative-fixture
branding/import aliases. The Node production build and exact-owner ESLint,
Prettier, and diff checks pass; no D.109d semantic type diagnostic appears.
The complete commands, full reporter set, typecheck output, owner hashes, and
self-excluding manifest are rooted at `.logs/phase-6b-d109d-green/`.

No retained campaign, dependency, schema, threshold, timing, protocol,
wire/digest/QC/adoption/availability, live-journal deletion, legacy-object, or
product-API change ran. Final Grok/Kimi/Opus review remains the sole blocking
GREEN closure gate.

## Final-review correction

The signed/pushed GREEN review ran once against `f8f6367a1214486412873eb15dca55159c8a74b6`.
Grok 4.6/high and the standard Kimi CLI K3/high/100-step approved with empty
P0/P1 unions. Opus xhigh demonstrated two P1s: independent-transport adoption
left the live creator-close duplicate owner reachable while reporting it
absent, and the fixture's temporary D.109b owner left the successor's genuine
issuance store unpruned, so a post-release `readRebaseOutbox()` could return
`record-rejected`. The complete original results remain immutable under
`.logs/phase-6b-d109d-green-review/`.

One permitted executable correction batch closes that union. The existing
adoption custody now carries an optional `WeakRef` to the original runtime
handle. It is installed only for in-process close/adoption, copied through the
already-private adoption material, and cleared after reclamation; genuine
fresh-process reopen has no such reference. This adds
`packages/node/src/creator-adoption.ts` and
`packages/node/src/internal/creator-successor-live.ts` to the corrected GREEN
owner set without adding a package export, product-handle key, strong chain, or
public API. The shared Phase-6a fixture exposes its already-owned Node pruning
capability so D.109d prunes the exact issuance store used by the live successor;
only the genuine partial-prefix control remains on a temporary owner.

The corrected focused run is 12/12. Both hot and independent-transport controls
now census creator-close duplicates present before and absent after. The
post-release dependency gate proves rebase-empty, local issue, publication,
authenticated retained ingress and durable journal admission, close status and
durable-head capture; a bounded owner-local source check proves snapshot export
reads the current blueprint machine and neither `displacedSource` nor
`hotPredecessor`. A rejected diagnostic attempt tried to retrieve an active
creator successor through the existing snapshot-closed-only blueprint retrieval
contract; that attempt was removed rather than widening product behavior. The
construction-order diagnostic is now sliced to `reclaimV3RuntimeKernel`, fixing
the original file-global `indexOf` mistake.

Correction evidence is rooted at `.logs/phase-6b-d109d-green-correction/`:
focused 12/12, retained Vitest 142/142, D.109b/D.109c Chromium 4/4 and 4/4,
Phase-6a Chromium 2/2 and 8/8, Node build, Prettier, diff, and exact changed-owner
lint all pass. One inherited `@ts-drp/keychain/finality` alias-resolution lint
diagnostic in the shared Phase-6a fixture is preserved; that file passes with
only that pre-existing rule waived. No campaign ran. Because executable scope
changed, the review policy permits exactly one confirmation over this signed
correction; D.109d remains open until that confirmation has an empty P0/P1
union.

## Closure

The executable correction is signed and pushed at
`40382c7bddadd4aa007bf9e2bc5bbab7b5a8b224`. The single permitted confirmation
round is complete: Grok 4.6/high, standard Kimi CLI K3/high/100-step, and Opus
xhigh each returned `APPROVED` with no P0/P1 finding and
`D109D_GREEN_READY: yes`. The two original P1s are closed, so the blocking
union is empty.

Confirmation evidence is rooted at
`.logs/phase-6b-d109d-green-confirmation/`. Its validating self-excluding
manifest SHA-256 is
`428248d8bed4ee823a50dc94f64271419caa645fa5ca80eeb2e58f8ba57d67b0`.
Remaining P2 observations—post-release census observation, shared-fixture
static census, receipt/store identity and raw dependency auditing, transitive
snapshot dependency proof, and genuine fresh-process reopen—belong to D.109f
and do not reopen this slice. No campaign ran.

D.109d is closed. D.109e is the next executable Phase-6b slice.
