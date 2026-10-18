# D.109c — AHE Generation and Blob Reclamation

## Status and inherited anchors

D.109c starts only after signed/pushed D.109b closure
`2afadbe682261bdb311a5cb64f6f42d86ed7330b`. D.109a's planner and D.109b's
issuance deletion remain accepted, immutable prerequisites. This slice changes
only AHE physical ownership. It authorizes no runtime reclamation, scheduler,
campaign, threshold, dependency, protocol, wire, digest, QC, adoption,
availability, issuance, snapshot, or product-handle change.

The active formal-review trio is Grok 4.6/high, exact Kimi K3 thinking/high
with both `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and
`--max-steps-per-turn 100`, and Opus xhigh. Kimi occupies the middle
external-CLI slot; Codex `gpt-5.6-sol` is not a substitute. If Grok cancels,
resume that exact session. Fable and collaboration subagents are not
authorized.

## Source audit and one-owner seam

The mandatory `AheDurableStore` remains the exact existing 12-key facade:
`capabilities` plus `readHead`, `readGenerationPage`,
`recoverActiveGeneration`, `getBlob`, `beginGeneration`, `putCachedBlob`,
`promoteReference`, `completeGeneration`, `swapHead`, `discardGeneration`, and
`close`. D.109c does not add a thirteenth key.

Current physical facts are:

- the exported memory facade owns one `TransitionOwner("ephemeral")` and can
  never promote, complete, adopt, or supersede a generation through its public
  operations. It is not a D.109c physical-reclamation owner; its behavior and
  `TransitionOwner` remain byte-identical, while D.109d separately owns live
  runtime-memory reclamation;
- Node owns exact `objects`, `generations`, `blobs`, and `promotions` SQLite
  tables in the caller-selected file under WAL/FULL and foreign keys;
- browser owns the same four AHE stores inside the existing Phase-5e IndexedDB
  version-3 database. D.109c changes neither database name, schema version,
  store/table/key path, nor unrelated vote/evidence stores;
- blob identity is global by digest, not object-local, and neither persisted
  backend has a reverse index;
- creator adoption rejects every surviving generation whose `present`
  `baseExpectedHead` parent row is missing. Deleting an older prefix without
  rewriting the retained floor is therefore a demonstrated recovery defect.

There is one shared `@ts-drp/storage/maintenance` owner for the closed request,
receipt/error types, copying, canonical-generation validation, lineage graph
classification, and remaining-reference calculation. It grants no physical
authority and does not register the honest ephemeral memory facade. Node and
browser each add only `./maintenance`, backed by a module-private `WeakMap`
keyed by the exact strict facade their existing factory returned. Copies,
proxies, structural lookalikes, cross-backend facades, and the memory facade
resolve to `undefined`. Package roots and ordinary factory modules do not re-
export maintenance.

The two native backend transactions remain the only physical mutation owners.
No generic
adapter command, `AheDurableStore` method, public runtime handle, reverse-index
schema, receipt shadow table, or cross-database transaction is added.

## Closed maintenance contract

The one method is:

```text
reclaimClosedEpoch(input: unknown): Promise<AheReclamationReceipt>
```

The captured exact input has only:

```text
{
  activeGenerationId,
  availabilityPolicyDigest,
  closedEpoch,
  expectedHead,
  lineageFloor: {
    deleteGenerationIds,
    expectedBaseExpectedHead,
    generationId,
    replacementBaseExpectedHead
  },
  objectId,
  rollbackGenerationIds
}
```

It is the detached AHE subset of one successful D.109a plan. The availability
digest must be the frozen local-only digest
`53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b`;
D.109c compares it but never decodes policy bytes. The expected head is
`present`; active, both rollback, floor, and deletion identities are valid,
distinct where required, exact closed records; rollback order is immediate
parent then grandparent; deletion identities have no duplicates; replacement
is exactly `{ kind: "none", objectId }`; and an empty deletion list is valid
only when the expected floor parent is already that same no-head value.
Accessors, inherited fields, symbols, sparse arrays, shared buffers, aliases,
extra fields, and impossible relationships fail before transaction work.

Success returns a detached deeply frozen receipt with exact keys:

```text
{
  activeGenerationId,
  availabilityPolicyDigest,
  closedEpoch,
  deletedBlobDigests,
  deletedGenerationIds,
  deletedPromotionCount,
  expectedHead,
  floor: {
    expectedFormerBaseExpectedHead,
    generationId,
    normalizedThisCall,
    replacementBaseExpectedHead
  },
  objectId,
  reclaimedGenerationIds,
  rollbackGenerationIds
}
```

`reclaimedGenerationIds` is the exact requested older prefix proven absent at
commit. `deletedGenerationIds`, `deletedPromotionCount`, and
`deletedBlobDigests` describe writes performed by this call. A lost-receipt
replay has the same reclaimed prefix, `normalizedThisCall: false`, and empty
actual-deletion fields. No receipt contains blob bytes, closure bytes, QC,
signatures, snapshot bytes, runtime authority, or a future-deletion grant.

Failures are frozen errors with one of exactly:

- `AHE_RECLAMATION_INVALID_ARGUMENT`: malformed or internally impossible
  caller input; never poisons;
- `AHE_RECLAMATION_RETRY_REQUIRED`: a well-formed head, revision, generation,
  floor, branch, or selected-set observation changed since planning; zero
  writes and no poison;
- `AHE_RECLAMATION_CORRUPT`: malformed/unreadable native bytes, key/record
  mismatch, broken retained closure/promotion/blob evidence, impossible partial
  replay, or a malformed global remaining-reference row; zero committed writes
  and the ordinary store latches poison;
- `AHE_RECLAMATION_STORE_CLOSED` and `AHE_RECLAMATION_STORE_POISONED`: exact
  lifecycle precedence;
- `AHE_RECLAMATION_SUBSTRATE_FAILURE`: a contained native failure with cause;
  no false success.

No error exposes persisted bytes. Both native backends return asynchronous
rejection, never a backend-specific synchronous throw. Closed and poisoned
state precede transaction work, while invalid-argument validation follows the
existing backend convention and occurs before lifecycle classification; RED
pins that exact parity on both owners.

## Transactional algorithm

One SQLite `BEGIN IMMEDIATE` or strict IndexedDB `readwrite` transaction over
the four AHE stores performs this exact order:

1. Recheck lifecycle and decode the target object's head. A different valid
   head/revision is retry; malformed persisted head is corruption.
2. Enumerate and canonically decode every target generation row. Rebuild the
   chain from expected head → active → immediate rollback → second rollback →
   complete older prefix. Generation IDs are never sorted as chronology. Every
   `present` parent link must also decrement revision by exactly one, matching
   D.109a's live positive `parentMatches` equality and its
   `cursor.revision !== expectedRevision - 1` refusal branch.
3. Require active `Adopted`; both rollback rows and every selected prefix row
   `Superseded`; exact head/closure-digest/revision links; canonical nonempty
   digest-sorted closures; and exact equality with the requested active,
   rollback, floor, former-parent, and deletion identities. Any additional
   target generation row makes the plan stale rather than silently deleting it.
4. Verify active and both rollback closures remain complete: every referenced
   blob exists with exact byte length/digest and every promotion exists. Verify
   selected superseded rows' complete promotion/blob evidence before treating
   their references as newly reclaimable candidates.
5. Enumerate every generation record across every object and every promotion
   row in the database. Decode/bind each generation to its physical key. Every
   promotion must bind to an existing generation and a digest in that
   generation's closure. Any malformed remaining row aborts; omission cannot
   be interpreted as “unreferenced.” `Staged` and `Discarded` rows may have a
   promotion subset because discard is legal before completion; only
   `Complete`, `Adopted`, and `Superseded` rows require complete promotion
   sets.
6. Reject cycles, gaps, wrong floor/parent, any surviving non-floor edge into
   the selected prefix, any selected row outside the complete connected prefix,
   or any simulated post-state dangling `present` parent.
7. For a nonempty fresh prefix, rewrite only the second rollback/floor record's
   `baseExpectedHead` from the exact expected parent to the existing no-head
   form. Preserve every other generation field and re-encode canonical storage
   v1 bytes. Exact one-row update is required.
8. Delete exactly all promotions owned by the selected prefix, then exactly the
   selected generation rows. Count mismatch aborts.
9. From the selected closures, delete a candidate global blob only when no
   remaining generation closure across any object and no remaining promotion
   references its digest. Shared and unrelated-object blobs remain. Exact
   delete counts are checked.
10. Reread/simulate the resulting target graph: expected head, active, both
    rollback closures, normalized floor, no selected rows/promotions, and no
    dangling parent must all hold before commit. Then return the frozen receipt.

Node executes no callback inside the transaction except a new maintenance-
scoped package-owned test-only crash observer; it does not widen the existing
adapter-command checkpoint union. Browser issues every cursor/request from the
one live transaction and performs no unrelated asynchronous work that could
auto-commit it.

## Idempotence and concurrency

- An initially empty prefix with a no-head floor is a no-write success.
- A lost-receipt replay is accepted only when every requested prefix row and
  promotion is absent, the exact floor is already no-head, the head/active/two
  rollback graph still matches, and retained closure evidence is complete.
- All-present plus expected former parent is the only fresh mutable state.
  Any mixed present/absent prefix, already-normalized floor with a surviving
  selected row, or absent selected row with the old floor still present is
  corruption, never a guessed replay.
- A second native live handle that changes any selected fact before lock acquisition
  receives retry or observes the committed idempotent state; it cannot combine
  old classification with new writes.
- Closing or poisoning during admission cannot publish a receipt. A failed
  transaction retains the prior recovery certificate and bytes; a committed
  floor rewrite does not change the head fingerprint or active closure.

## Deterministic RED

RED adds tests/fixtures/config only. Production source, package manifests,
schemas, lockfile, dependencies, thresholds, and runtime code remain
byte-identical to D.109b closure.

The exact new RED path roster is:

1. `tests/fixtures/phase-6b/ahe-reclamation-contract.ts`
2. `tests/phase-6b-ahe-reclamation-red.test.ts`
3. `packages/storage-node/tests/fixtures/phase-6b-ahe-reclamation-child.mjs`
4. `packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts`
5. `packages/storage-browser/playwright.phase-6b-ahe-reclamation.config.ts`
6. `packages/storage-browser/tests/phase-6b-ahe-reclamation-global-setup.ts`
7. `packages/storage-browser/tests/assets/phase-6b-ahe-reclamation-entry.ts`
8. `packages/storage-browser/tests/assets/phase-6b-ahe-reclamation-worker.ts`
9. `packages/storage-browser/tests/phase-6b-ahe-reclamation-red.pw.ts`

The same tests-only RED batch may amend exactly four current live export-census
owners whose assertions will otherwise be invalidated by the three additive
`./maintenance` subpaths:

1. `tests/phase-2l-d-parity-governance-red.test.ts`
2. `tests/phase-3a1b-p2-outbox-publication-contract.test.ts`
3. `packages/storage-node/tests/phase-2l-c-node-issuance-registry-red.test.ts`
4. `packages/storage-node/tests/phase-3a1b-p4-node-live-journal-red.test.ts`

Each amended assertion must first recognize the exact D.109b Node/browser
package surface, then add only `./maintenance` for its owning package. The new
shared RED owner separately freezes the current `@ts-drp/storage` export map
before adding its own `./maintenance`. RED controls prove all three current
surfaces before GREEN; semantic expectations are gated on the corresponding
missing subpath. Each of the four amendments therefore remains green at RED by
expecting the exact current list until that package's maintenance subpath
exists; it must not require the future key unconditionally. Historical already-
stale complete-export assertions—including storage adapter/capacity, Node
SQLite-contract, browser Phase-2d structural/schema,
`tests/phase-3a1b-p4-live-journal-parity-governance-red.test.ts`, and
`tests/phase-4c-snapshot-quarantine-red.test.ts`—remain explicit D.109f census
debt. They are not silently edited or run as D.109c blocking retained gates.

The focused Vitest selection covers the shared contract and genuine Node owner;
the focused Playwright selection is exactly one file and the frozen Chromium
tests. Before GREEN, controls pass and semantic bodies skip behind exact
readiness predicates; failures are only
`D109C_SHARED_MAINTENANCE_MISSING`, `D109C_NODE_MAINTENANCE_MISSING`, and
`D109C_BROWSER_MAINTENANCE_MISSING`. Any module-resolution, build, server,
fixture, selected-count, top-level, or different-token failure invalidates RED.

The frozen semantic roster covers:

- exact facade/export census and identity denial for copy/proxy/fake/
  cross-backend values, plus proof that the honest ephemeral memory facade has
  no reclamation capability and its production owner is unchanged;
- detached closed input, frozen receipt/error, exact error-key/code registry,
  invalid/lifecycle precedence, and asynchronous-rejection parity on Node and
  browser;
- genuine Node and browser five-generation positive controls retaining active
  plus their two immediate ancestors, normalizing only the second rollback,
  deleting the two older connected rows/promotions, and preserving active/
  rollback bytes;
- empty-prefix success, lost-receipt replay, two-live-handle serialization,
  reopen, and a subsequent genuine creator-adoption commit;
- stale/different head or revision, active mismatch, insufficient rollback,
  wrong-but-countable rollback pair, duplicate identity, changed closure/state,
  wrong floor, wrong former parent, gap, cycle, alternate surviving branch,
  extra target row, and simulated dangling post-state;
- missing/corrupt retained blob, missing/extra/wrong promotion, malformed
  target or unrelated generation bytes, key/record mismatch, and partial
  replay; every corrupt case performs zero committed writes and poisons;
- shared blobs within the retained set and across an unrelated object,
  candidate-only blob deletion, unrelated orphan retention, and full global
  remaining-generation plus promotion scanning;
- injected floor-update, promotion-delete, generation-delete, and blob-delete
  count mismatches, each rolling back the complete transaction;
- Node hard `SIGKILL` at `after-floor-rewrite`,
  `after-promotion-delete`, `after-generation-delete`, `after-blob-delete`,
  `before-commit`, and `after-commit`; reopen must be old XOR complete-new;
- Chromium worker termination/transaction abort at the corresponding live-IDB
  stages, with reopen old XOR complete-new and no partial floor/prefix/blob
  combination.

RED also retains the D.109a planner positive/refusal matrix and its dangling-
parent oracle. It does not claim production behavior for skipped semantics and
does not run a retained campaign.

## Deterministic RED checkpoint

The signed/pushed RED anchor is
`84cff9ceaa6620c2ed8d1baa3a358ad9b018bb94`. The accepted focused Vitest run
selected two files and 38 tests: six controls passed, only the shared and Node
missing-owner readiness assertions failed, and 30 semantic bodies skipped. The
focused Chromium run selected one file and four tests: only the browser
missing-owner readiness assertion failed, three semantic bodies skipped, none
was flaky, and no top-level error occurred. The retained five-file selection
passed all 15 selected tests. The first Vitest diagnostic's extra failure was a
faulty public-facade shape check and is retained separately from the corrected
causal result.

The complete evidence is rooted at `.logs/phase-6b-d109c-red/`; its 20-entry
self-excluding manifest SHA-256 is
`d0745b39302d2e17437aea78ff8622ebb6bbc277fc20360fd8e67f33f924ca2f`.
Product sources, package manifests, the lockfile, protected paths, and all 26
stashes remained unchanged. No campaign or reviewer ran. RED therefore closes
causally and releases only the frozen GREEN implementation below.

## GREEN implementation batches

One D.109c GREEN checkpoint uses two diagnostic batches without an intermediate
commit or model review:

1. **Shared contract and classifier.** Add the maintenance types, copying,
   classifier, remaining-reference calculation, and exact package subpath;
   leave `MemoryAheDurableStore` and `TransitionOwner` unchanged, then run the
   focused shared-contract file once.
2. **Native owners.** Add Node and browser identity registries, transactions,
   separate maintenance-scoped test-only fault edges, package subpaths, and run
   the focused Node and browser commands once before the retained suites.

The native batch necessarily touches three existing internal integration
owners in addition to the new maintenance files: Node's scaffold registers the
genuine facade and live SQLite connection, Node's package-private test
instrumentation exposes only the maintenance crash observer, and the browser
IDB adapter registers its genuine facade and lifecycle. This is changed-path
custody for the already-frozen identity and crash design, not a new API or
behavioral slice. No root export, facade key, schema, dependency, or ordinary
adapter-command hook changes.

If either focused run reports a code/token outside its frozen matrix, stop and
diagnose rather than folding another concept into the batch. Before final
review, apply `refactor-clean`: one shared graph classifier, one backend
transaction per physical owner, no duplicate lineage walker, no compatibility
wrapper, no `TransitionOwner` reclamation mutation, and no temporary export
left behind.

## GREEN implementation evidence

The complete GREEN is locally implemented. The shared package owns the one
closed contract/capture/classifier/receipt implementation; strict weak-identity
registries expose separate Node and browser maintenance subpaths without
changing the 12-key facade or package roots. SQLite uses one `BEGIN IMMEDIATE`
and IndexedDB one strict four-store transaction. Both recheck the full global
generation/promotion graph, normalize only the retained floor, enforce exact
write counts, preserve shared/orphan references, replay idempotently, and
latch corruption without committing partial deletion.

The final focused Vitest reporter passes 48/48 with zero failure or skip. The
one-file Chromium reporter passes 4/4 and internally executes all 28 frozen
mutation/count cases, six reference cases, six worker-termination edges, and
the empty/replay/reopen/two-handle/successor/lifecycle controls. Four affected
package builds and source-only typechecks pass. The corrected retained Vitest
selection passes all 197 selected assertions; its two filters are the exact
predeclared D.109f stale complete-export assertion and unrelated opt-in long
SIGKILL campaign. Retained Chromium schema, adapter/recovery/lifecycle, real
process-death, and creator-adoption selections pass 12/12, 22/22, 1/1 and 2/2.
The initial retained diagnostic that selected the D.109f assertion is preserved
honestly rather than relabelled as a product failure.

Exact-owner lint/format/diff, child syntax, source pins, export/schema/facade
shape, 11-path custody, protected paths, 26 stashes, process and fixed-port
checks pass. One initial read-only custody check used an invalid Unicode regex;
the corrected diagnostic passes and the regex error is not a code failure.
The `refactor-clean` audit confirms one production classifier and one physical
transaction per backend with no wrapper, temporary export, duplicate lineage
walker, or adapter-command growth. Complete reporter JSON and the command/
result ledger are rooted at `.logs/phase-6b-d109c-green/`. Its validating
self-excluding manifest SHA-256 is
`6e21d87aae12c4b818d9d9676df987ebf034d4fe08bd0f4f544e38ef70c7cc28`;
no campaign ran.

GREEN must now be signed and pushed before the sole formal final review. That
review uses Grok 4.6/high, exact Kimi K3 thinking/high with both 100-step
controls, and Opus xhigh. Kimi occupies the middle external-CLI slot; Codex
`gpt-5.6-sol` is not a substitute and no collaboration subagent or Fable run is
authorized.

## GREEN and retained gates

GREEN must prove all focused assertions with no skip, failure, flaky result,
or top-level error, then run:

- affected `@ts-drp/storage`, `storage-node`, `storage-browser`, and `node`
  builds plus source-only typechecks;
- exact-owner ESLint, Prettier, `git diff --check`, package/root/factory export
  census, schema/version/name source shape, no generic adapter-command growth,
  and changed-path custody;
- explicitly named retained storage codecs and unchanged memory/state-machine,
  bounded reads, taxonomy/poison, recovery authority/memory-bound, current Node
  SQLite semantic/SIGKILL/lifecycle, current browser schema/adapter/recovery/
  process-death, D.109a planner, and Phase-6a creator adoption/reopen tests;
  the command ledger must list exact file paths and must not substitute the
  already-stale complete-export census files deferred above;
- a self-excluding evidence manifest covering complete reporter JSON, stdout,
  stderr, child/worker observations, commands, hashes, and dispositions;
- signature, pushed-ref equality, protected paths, 26 stashes, fixed ports,
  and no conflicting ts-drp reviewer/test/profiler process.

The unchanged memory facade/`TransitionOwner`, Node file path, four-table DDL,
WAL/FULL/foreign-key policy, browser
database name and version 3, nine-store authority, four AHE key paths, storage
v1 codecs, D.109a planner result and exact revision-decrement predicate, and
both creator parent-presence predicates are source pins. Directly affected
hashes may change only for the frozen owner paths and four authorized live
export-census tests; unrelated source drift stops the slice.

The initial plan review found and this correction accepts two P1s. First, the
honest memory facade cannot reach the frozen durable lineage state, so it is no
longer misrepresented as a positive reclamation owner and no `TransitionOwner`
mutation is authorized. Second, the four currently-live exact package-export
censuses above now have explicit tests-only RED/GREEN custody; inherited stale
complete-export assertions remain D.109f debt rather than surprise D.109c
gates. The same batch accepts four bounded P2 clarifications: a malformed row
found by the global scan poisons the whole native owner and D.109d must not
assume per-object isolation; the D.109a revision-decrement predicate is pinned;
async rejection plus invalid/closed/poisoned precedence is executable; and Node
uses a separate maintenance observer rather than widening adapter checkpoints.
Kimi's digest-metadata observation is accepted as intended auditable receipt
data, not persisted bytes. These corrections change causal RED acceptance and
therefore receive the plan's sole permitted confirmation round.

## Review and stop conditions

This is high-risk because it authorizes physical generation/blob deletion and
changes crash behavior. Sign and push this bounded plan, then run one
Grok/Kimi/Opus plan review. Only P0/P1 blocks; disposition P2 without recursive
prose review. Permit at most one confirmation if a P0/P1 correction changes
scope, causal RED behavior, or a hard acceptance gate. Deterministic RED gets
no separate full model round. Sign/push GREEN, then run the sole final
Grok/Kimi/Opus review over plan → RED → GREEN history. Only P0/P1 blocks
closure.

Stop and reslice rather than widen scope if safe implementation requires a
schema/reverse index, mandatory facade change, product/runtime API, dependency,
threshold, workload, protocol/wire/digest/QC/adoption/availability change, or
cross-database authority. D.109c runs no retained campaign. D.109d remains
unopened until D.109c's signed GREEN evidence and final review are complete.

## Human-verifiable outcome

The focused evidence must show, in plain data, the head and three retained
generation records before/after, the exact floor-parent rewrite, exact removed
prefix/promotions, shared-versus-deleted blob digests, replay receipt, and old
XOR complete-new crash observations for Node and Chromium. A reviewer can
therefore decide deletion safety without inferring it from implementation
prose.

## Final review and closure

The complete GREEN was signed and pushed at
`3d21264f4477fb5ff586047826ebd49e15d20bde`. The sole final review used Grok
4.6/high session `01a05a8e-66d1-73e3-9403-69c3d07f5995`, the
user-authorized standard Kimi CLI K3/high/100-step session
`session_926cdc44-4a34-474e-b63d-bcf0a9ab6ab8`, and Opus 5/xhigh session
`50126d08-0132-4491-9200-ae4a077455f5`. All three independently returned
`APPROVED`, `P0_P1_UNION: none`, and `D109C_MAY_CLOSE: yes`. Kimi occupied the
middle external-CLI slot; no Codex `gpt-5.6-sol`, Fable, collaboration
subagent, test, build, product mutation, or campaign ran during review.

The overlapping Kimi/Opus P2 identifies an exact invalid-input-polarity edge:
an empty deletion list with a present expected floor parent can reach
retry/replay rather than capture-time `AHE_RECLAMATION_INVALID_ARGUMENT`.
There are zero writes and no poison, so it cannot authorize unsafe deletion;
D.109f owns the exact mutant and correction. Opus's two further P2s assign a
genuine second-process SQLite concurrency control and the already-computed
browser `facadeKeys` assertion to D.109f's required crash/concurrency and
complete-census work. No P2 changes this reviewed GREEN or triggers another
review round.

The complete review evidence is rooted at
`.logs/phase-6b-d109c-green-review/`; its validating self-excluding manifest
SHA-256 is
`44971c03dce649d0886b2bebf943044aa55178499ede15155cc363f7b4d2692b`.
D.109c is closed on this signed record; D.109d may begin. No retained campaign
is authorized or executed by D.109c.
