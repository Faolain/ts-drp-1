# D.110c-0c1f5b0r author fence and membership-incarnation settlement design

## Decision and supersession

This design is based on signed anchor `3a156aca` (branch
`codex/phase3a1b-p6-golden-path`). It **supersedes** the per-source
author-settlement carrier of `D.110c-0c1f5b0`
(`.logs/d110c-0c1f5b0-design-00a860ab/design.md`), the Merkle AVL
retired-author dictionary of `D.110c-0c1f5b0p`
(`.logs/d110c-0c1f5b0p-design-e6a67013/design.md`) and the `D.110c-0c1f5b0q`
witness/lifecycle reconciliation that existed only to repair that dictionary.
Those signed checkpoints, their immutable review evidence (the blocking union at
`.logs/d110c-0c1f5b0-plan-review-fc4b8fc7/` and the combined confirmation at
`7ecd5f19`/`061457f2`) and the retained findings they produced are preserved
and cited, not erased. No result of theirs is reinterpreted as approval.

The evidence base is the Fable 5.1 research checkpoint
`.logs/d110c-0c1f5b0-fable51-research-20260903/` (`solution.md`,
`peer-review-notes.md`, `plan-change.md`, `lineage-profiles-impact.md` and the
five agent reports), signed at `d5b8168e`, `c9289c6a`, `cb2e723d`. The
adjudicated crash walk and code citations live in `plan-change.md` Parts A-C;
this document freezes the exact construction, matrix, slices and stop rules.
A pre-review consistency pass by one Fable 5.1 subagent is recorded as the
sibling `pre-review.md`; its seven integrated items (genesis `admissionEpoch`
key, fence-at-every-open rule, incarnation-scoped terminal rule, plan-entry
retirement, stale plan cite, four near-miss line cites, two deferred notes) are
folded into this text and it is not the governing review. This is a design
checkpoint only: no production edit, RED, campaign, long workload or subagent
invocation is authorized by it.

### The fact that drives the design

Local issue takes its dependencies from the causality index tips
(`packages/node/src/v3-live.ts:6217-6240`) and ingress refuses any vertex whose
dependencies are not installed (`:3711-3716`, `:3862`); the close graph is the
causally closed index (`:7430-7460`). An honest author's next vertex therefore
always causally follows its previous one, and if the creator's close graph
holds slot `k+1` it holds slot `k`. "Op 11 admitted while op 10 is delayed"
is unreachable inside an epoch for an honest author and self-inflicted for a
Byzantine one. Every part of the superseded grammar that existed to represent
an admitted-above-gap slot (`already-present`, `coveredStateDigest`,
`semanticIdentityDigest`, replacement references, `zero-intent`,
`settlement-control`, `hasDisplacedOperation`) is deleted. The author's own
authenticated boundary from the checkpoint tells it exactly which of its rows
were admitted (at or below the boundary) and which were not (above it).

### What the construction is

1. A **durable settlement plan** in the author's issuance store, written before
   any issue after open/adopt, recording one disposition per displaced source
   and linked atomically to the fence and each replacement inside the existing
   `transactIssue` transaction.
2. An **author fence** control operation `$drp.author-fence.v1` carrying one
   integer `fenceSequence = m`, issued **first** after the plan; every
   replacement is issued **after** it and therefore causally follows it.
3. A creator-signed **settlement checkpoint** whose frontier is
   `[author, admissionEpoch, terminalThrough]` for exactly the successor ACL's
   members, with `admissionEpoch` derived from the ACL diff and carried only
   in the checkpoint. No retired-author registry, no `sequenceFloor`, no
   `admittedThrough`, no ACL schema change, no issuance-store scope change, no
   lineage jump.

The construction is the Kafka producer-epoch / Zab ballot / MLS epoch fencing
pattern adapted so `authorSequence` stays never-resetting on each device. It
adds no cryptography, no wire-envelope field and no external trust service.
It adds one issuance-store object store (schema bump), one control operation
inside the existing v3 envelope, and one closure record kind.

## Settlement checkpoint

Kind `drp-creator-author-settlement-state`, version `1`, domain
`ts-drp/creator-author-settlement/v1`, maximum 8,192 canonical bytes:

```ts
{
	closedAnchorDigest, closedEpoch, commitQcRef: { byteLength, digest },
	currentAclDigest, cutValueDigest,
	frontiers: readonly [author: string, admissionEpoch: number, terminalThrough: number | null][],
	genesisAnchorDigest, historyRoot, historySize,
	kind: "drp-creator-author-settlement-state", objectId,
	priorCheckpointDigest, priorCheckpointKind: "genesis" | "settled-v1",
	protocolMajor: 3, snapshotManifestDigest, successorAclDigest,
	successorAnchorDigest, successorEpoch, version: 1,
}
```

- `frontiers` are strictly code-unit sorted, unique, and exactly the successor
  ACL's members of every role (at most 64). A member present in the prior
  checkpoint carries its `admissionEpoch` unchanged and a monotone
  `terminalThrough` (`null → n` allowed; `n → null` or lower rejected). A member absent from the **current ACL** (added at this close) carries
  `admissionEpoch = successorEpoch` and `terminalThrough = null`. When the
  predecessor is the genesis sentinel, members of the current (genesis) ACL
  receive `admissionEpoch = 0` and members added at this close receive
  `successorEpoch`. The verifier recomputes membership from the two bound ACL
  digests; "absent from the prior checkpoint" is never the key.
- The record binds the current and successor anchors and ACLs, cut, commit QC,
  snapshot manifest, history root/size and pinned genesis exactly as the
  superseded design did; any mismatch fails closed.
- **Signing and verification (signer-agnostic).** The record carries
  `detachedAuthoritySignature`. Prepare mints the opaque signing request under
  the **successor** trust material's public key; open verifies under floor
  trust only. The codec never compares a current-epoch key to the successor or
  floor key; the checks at
  `packages/protocol-v3/src/creator-author-issuance-frontiers.ts:278` and
  `:399` are not carried over. The closing epoch is bound by
  `closedAnchorDigest`, `closedEpoch`, `currentAclDigest` and `commitQcRef`,
  not by signer identity. Under `creator-trusted-settlement-v1` both keys
  coincide, so behavior is identical; the rule exists so the checkpoint is a
  payload of the authority that installs epoch N+1 and composes unchanged with
  a later rotated-authority lineage profile (`D.110c-0c1j`).
- **Predecessor rules and where they run.** The opener verifies one record
  against floor trust and the expected cut/QC/manifest/ACL digests;
  `priorCheckpointDigest`/`priorCheckpointKind` are validated for shape only.
  Adjacency (genesis sentinel or exactly one adjacent `settled-v1`),
  `admissionEpoch` copy-unchanged and `terminalThrough` monotonicity are
  enforced by the control-plane bounded-advance predicate over the retained
  immediate predecessor inside the D.110c-0b rollback window. No opener, cold
  or hot, walks the checkpoint chain; cold reopen is O(1) in epochs.
- The codec exports `frontierFor(identity, author)` and
  `frontierCount(identity)`; consumers outside protocol-v3 use them rather than
  indexing `frontiers`. This is the only preparation for a later map-backed
  carrier (`D.110c-0c1k`); no field is reserved.
- f5b0a re-measures the 64-member maximum shape (the prior two-boundary
  measurement was 6,959 bytes with the same triple width) and pins it plus the
  adjacent over-limit rejections as executable vectors; the 8,192-byte ceiling
  is not raised.

## Fence carrier

```ts
type AuthorFenceOperation = Readonly<{
	action: "$drp.author-fence.v1";
	fenceSequence: number; // m: safe nonnegative integer, m <= outer authorSequence
	version: 1;
}>;
```

Signed by the outer vertex's author under the existing `ts-drp/vertex/v3`
domain at outer slot `f`, it means: "every slot of mine with sequence `< m` in
my current incarnation is either already admitted or abandoned and may never
be admitted; every slot `>= m` is current-epoch work." The only grammar rule is
`m <= f`; there is no bound on `m`, no source list, no replacement reference,
no supersession record. Protocol-v3 reserves the action globally (blueprint
preparation rejects a blueprint that registers it) and Node recognizes it by
its own `action` data property. Admission authority is ACL membership of any
role; the operation never reaches a blueprint reducer. The Node close-graph
split (application ⊔ control, complete maps for index, charges, frontier,
close-set, history and creator scanning; application subset only for the
fold) and the dedicated control issuer are retained from the superseded design.

## Creator scan at close

For each successor ACL member `A`, from the prior frontier
`(admissionEpoch = e, terminalThrough = s)` or `(successorEpoch, null)` for a
member absent from the current ACL:

1. Group `A`'s vertices in the complete current close graph by exact
   `(authorSequence, digest)`. A same-slot duplicate freezes `A` at `s`; a
   foreign-author slot at or below `s` freezes `A` at `s`; a creator-own
   regression keeps its existing fail-closed error
   (`packages/node/src/creator-close.ts:486-497`, `:528-546`).
2. Among `A`'s fence vertices take the largest `m` with `m <= f` and
   (`s === null` or `m > s`); set `s := m − 1` (`m = 0` means the base is before slot 0; by contiguity
   the fence's own slot then advances `s` to at least 0 in step 4, so a
   negative `terminalThrough` is never emitted). Invalid fences are ignored; nothing aborts.
3. If `s === null` and no valid fence exists, scan from slot 0 if it is in the
   graph; otherwise emit `null`. This replaces, under the settlement profile,
   the close-aborting throw `D110C_0C1F1_AUTHOR_REENTRY_PROOF_REQUIRED`
   (`packages/node/src/creator-close.ts:517-524`); `creator-trusted-v1` keeps
   that throw byte-for-byte.
4. Advance `s` across exactly adjacent graph slots; never take an observed
   maximum; never cross an unknown slot.
5. Emit `[A, e, s]`.

Removed members are dropped from the vector; nothing is remembered about them.
The close proceeds when any foreign boundary cannot advance (f5a per-author
liveness). Settlement-profile closures emit neither the v1 admitted-frontier
aggregate nor the legacy creator-retirement record; the creator's own rows
take the same fence path.

## Author drain, plan and fence

At open or adopt under the settlement profile, before any ordinary issue (the
existing rebase startup barrier, `examples/v3-room/src/index.ts:2796-2990`,
`:3844`, remains the public-issue barrier):

1. Read own `(e, s)` from the authenticated checkpoint. A key absent from the
   vector is not a member and may not issue.
2. Classify every own durable row regardless of `publishState` (replacing the pending-only predicate at `v3-live.ts:6447`, whose
   published-skip at `:6446` is the historical defect, and the
   published-must-be-present path at `examples/v3-room/src/index.ts:2852-2857`), authenticating by own
   signature, scope and row digest against the anchor/epoch decoded from the
   row (the shape at `v3-live.ts:4762-4769`, not the single-predecessor
   classifier at `:4611-4619`), for any `epoch < current`:
   - `seq <= s`: terminal (never republished, rebased, applied or used as
     evidence);
   - `row.epoch < e`: old incarnation, terminal (its content is resubmittable
     by the application);
   - `row.epoch < current` and `seq > s`: not admitted (contiguity), displaced;
   - `row.epoch === current`: current; recovery replays it.
   Control rows are never handed to the application; a displaced fence is
   superseded by the next fence. Reserved `join`/`causalJoin` rows are covered
   by the fence with no application effect. A displaced `acl` row is surfaced
   to the application before any fence is issued.
3. Build or merge the plan: one entry per displaced application source with the
   room's policy (`expire | rebase | transform | manual-review`). Entries that
   already carry a `replacementSequence` are fulfilled; a replacement row that
   is itself displaced becomes a new source entry; a displaced fence clears `fenceSequence`. An entry whose source row now
   classifies terminal (`seq <= s`, or `row.epoch < e`) is removed from the
   plan at merge (the boundary, not the plan, settled it) and no longer holds
   the prune gate or a `manual-review` hold. Write it with `transactWriteSettlementPlan` (CAS on
   `revision`) **before any issue**.
4. If any entry is `manual-review`: no fence, no replacements; the barrier
   holds; only this author's boundary stalls.
5. Issue the fence through the dedicated control issuer with
   `m = lineage.next` and `planEffect: { kind: "fence" }`. Node refuses a fence
   unless a durable plan exists with no `manual-review` entry and a null
   `fenceSequence`. Publish it. A fence is issued at every open/adopt under
   the profile once the drain completes, including with an empty plan (a
   returning member whose only old rows are terminal old-incarnation rows);
   Node's refusal rule accepts a durable empty-entries plan.
6. Issue each `rebase`/`transform` replacement as an ordinary application
   vertex with `planEffect: { kind: "replacement", sourceSequence }`; the link
   is durable in the same transaction as the row. `expire` entries need no
   issue.
7. The plan is complete when `fenceSequence` is set and every non-`expire`
   entry is linked. No source row is ever marked complete; sources become
   terminal through the next checkpoint. `completeRebaseSource`
   (`v3-live.ts:6637-6685`; room callers `examples/v3-room/src/index.ts:2814`,
   `:2971`) is unreachable under the profile.

Restart at any point re-runs 1-7 from durable truth. The idempotence key is
the plan entry; the fence is re-issued only if `fenceSequence` is null or the
linked fence row is classified displaced. The complete crash walk that selects
this order over replacement-first is `plan-change.md` §A.3: with the fence
first, every replacement causally follows it, so "above `terminalThrough`
implies not admitted" holds at every instant; replacement-first breaks that
whenever the fence is delayed past a close, even without a crash.

## Settlement plan store contract

`@ts-drp/issuance-store` is the single owner. Additions to
`packages/issuance-store/src/types.ts`:

```ts
type SettlementDisposition = "expire" | "rebase" | "transform" | "manual-review";
interface SettlementPlanEntry {
	readonly sourceSequence: number;
	readonly sourceDigest: Uint8Array;
	readonly disposition: SettlementDisposition;
	readonly replacementSequence: number | null;
}
interface SettlementPlan {
	readonly scope: DurableIssueScope;
	readonly revision: number;
	readonly fenceSequence: number | null;
	readonly entries: readonly SettlementPlanEntry[]; // sorted by sourceSequence, unique
}
interface DurableIssueCommit {
	/* existing keys */
	readonly planEffect?: { readonly kind: "fence" } | { readonly kind: "replacement"; readonly sourceSequence: number };
}
interface DurableIssuanceStore {
	/* existing methods */
	readSettlementPlan(scope: DurableIssueScope): Promise<SettlementPlan | null>;
	transactWriteSettlementPlan(input: { scope: DurableIssueScope; expectedRevision: number | null; plan: SettlementPlan }): Promise<SettlementPlan>;
}
```

`transactIssue` applies `planEffect` inside the same strict transaction that
writes lineage, issued record and outbox (browser: one IndexedDB transaction
over the exact store set, `packages/storage-browser/src/internal/browser-issuance-store.ts:176-181`;
node: `BEGIN IMMEDIATE … COMMIT`,
`packages/storage-node/src/internal/node-issuance-store.ts:756-800`). For
`fence` it sets `fenceSequence := commit.authorSequence` and fails if already
set; for `replacement` it sets the entry's `replacementSequence` and fails if
the entry is absent, already linked or `manual-review`. The exact-key commit
validator (`packages/issuance-store/src/contract.ts:281`) widens to accept the
optional key. The plan lives in a fourth object store `settlementPlans` keyed
by `[objectId, author]`: browser schema version bump with the exact store-name
check updated (`browser-issuance-store.ts:115-119`, `:1036-1038`); node table
migration in the style of `node-issuance-store.ts:248-255`; in-memory model
and conformance vectors. `pruneAuthenticatedSettledPrefix` refuses any row
referenced by an unlinked plan entry. No `transactAdvanceLineage` exists: a
lineage jump manufactures consumed-but-absent ordinals that `readIssued`
latches as corruption (`browser-issuance-store.ts:443-447`,
`node-issuance-store.ts:486-490`).

## ACL transition law

- Retained member (present in both ACLs, any role): frontier copied with its
  scanned `terminalThrough` and unchanged `admissionEpoch`. Losing or gaining a
  role changes nothing in the vector.
- Removed member: dropped. Its unadmitted rows are dead to the protocol; its
  device keeps them; their content is resubmittable after re-admission.
- Added member (fresh or returning, indistinguishable and irrelevant):
  `[author, successorEpoch, null]`. Its first accountable vertex is a fence or
  slot 0. Local lineage continues on a returning device and starts at 0 on a
  fresh device; neither needs a store operation, and neither can collide with
  the old incarnation because every old-incarnation vertex is bound to an
  epoch below `admissionEpoch` and to a dead anchor, which ingress already
  rejects (`v3-live.ts:3800-3829`).
- `LatchedAclMember` stays `{author, finalityKey, groups}`
  (`packages/protocol-v3/src/latched-acl.ts:8`); snapshot versions 1 and 2 are
  untouched. The incarnation is a checkpoint fact. Authority membership
  (profile/signer-set carriers) and application membership (latched ACL) remain
  separate; a player join is an ACL grant and never an authority change.

## Recovery, terminal rule and pruning

- Under a verified settlement checkpoint any same-author row at or below
  `terminalThrough` is terminal regardless of digest; the checkpoint
  authenticates a decision boundary, not membership of arbitrary row bytes.
  Same-slot equivocation remains evidence and cannot advance a boundary.
- Rows above the boundary from an older epoch of the current incarnation
  (`admissionEpoch <= epoch < current`) are displaced sources for the plan;
  they are never silently terminal. Old-incarnation rows
  (`epoch < admissionEpoch`) are terminal at re-admission and covered by the
  first fence.
- f5b0d adds the storage-neutral `pruneAuthenticatedSettledPrefix` contract
  from the superseded design unchanged in shape (compare-and-delete across any
  number of old epochs, monotone pruned watermark, expected lineage-next and
  prior watermark, partial deletion fails closed), plus the plan gate above,
  plus its production invocation on every peer after durable checkpoint
  staging, verified adoption, rollback-generation retention, availability and
  expected-head checks, plus the recovery-scan cap correction
  (`v3-live.ts:4349-4355`: `(rollback + 1) × maxEpochVertices` or scan from the
  settled watermark).
- Active control state is one checkpoint of at most 64 triples plus the
  existing rollback generations and history peaks; nothing grows with epoch
  count, rebase count or distinct-key churn. Control vertices in the current
  epoch are bounded by `maxEpochVertices`/`maxEpochBytes`; the exposure is one
  fence per author per epoch.

## Compatibility, profile and lineage independence

- The creator selects `creator-trusted-settlement-v1` in the canonical profile
  bytes before genesis, exactly as the superseded design specified: identical
  signer set, quorum and suite to `creator-trusted-v1`; `profileDigest` in the
  genesis anchor binds the choice; old binaries reject it; existing v1 rooms
  cannot late-opt-in; no runtime negotiation or downgrade.
- Profile union is implemented as a single exported protocol-v3 predicate
  `settlementProfileFor(profileId): "none" | "v1"`, consulted by the codec,
  `packages/protocol-v2/src/registry.ts:460`, the control-plane normalization
  (`packages/control-plane/src/creator-trust-checkpoint-advance.ts:198-207`),
  the closure validators
  (`packages/node/src/internal/creator-transition-advance.ts:326-328`,
  `:397-398`), the Node close path (`packages/node/src/creator-close.ts:209`),
  reopen (`v3-live.ts:1431`) and the room (`examples/v3-room/src/index.ts:488`,
  `:3985`). No site compares the profile string directly.
  `creator-trusted-settlement-v1` is the last profile ID that fuses an
  authority model with a settlement policy; a later decomposition into
  (authority profile, lineage policy, settlement policy) carried in
  `parameters` changes only this predicate.
- Under the profile: exactly one settlement checkpoint per close; zero
  retirement/aggregate records; every member issues one fence at every open/adopt (one control vertex per
  author per epoch); a null-boundary member cannot advance without a fence or
  slot 0.
- The settlement layer composes with any authority-lineage profile as part of
  the current signed state (`lineage-profiles-impact.md` §2.E). Rotated closing
  authority is `D.110c-0c1j`; author sets beyond the 64-member vector are
  `D.110c-0c1k`; neither is absorbed here.

## Crash, attack and failure matrix

| Boundary or attack | Required result |
| --- | --- |
| crash before plan durable | restart re-drains; nothing issued twice |
| plan durable, crash before fence | restart issues the fence once |
| fence durable, unpublished | restart republishes; plan proceeds |
| fence admitted, crash before replacements, close intervenes | boundary = fence slot; sources terminal; restart issues every unlinked entry once in the new epoch |
| replacement issued, crash before the rest | linked entry never re-issued; unlinked entries issued once |
| replacements delayed past close while fence admitted | boundary = fence slot; replacements re-planned as new sources; no double apply |
| fence delayed past close | boundary unchanged; fence and everything after it re-planned; larger `m` next epoch |
| transaction outcome unknown mid-plan | admission halts; reopen enumerates durable truth; no half-link exists |
| rollback after adoption | boundaries regress with the closure; linked entries never re-dispositioned |
| manual-review entry | no fence, no replacements; only that author stalls |
| honest delivery gap (10 delayed, 11 after it) | 11 never admitted without 10; both displaced; plan; fence; advance |
| author absent across two or more closes | rows classified by own signature/scope/digest for any old epoch; no hard failure |
| fence `m > f`, or `m <= s` | ignored; no abort |
| Byzantine fence far ahead | only that author's space burns; recoverable by re-admission on a fresh device |
| Byzantine omission of own predecessor | only that author's boundary stalls |
| same-slot duplicate | author frozen at prior boundary; close proceeds |
| same-key removal and re-entry, same device | new `admissionEpoch`; old rows terminal; first fence at `lineage.next` establishes the base; sequence continues |
| same-key re-entry, fresh device | lineage 0; fence or slot 0 accepted; no collision with the old incarnation |
| stale old-incarnation vertex delivered | rejected at ingress by anchor; ignored by the scan; no equivocation proof for a cross-anchor pair |
| frontier `admissionEpoch` off-rule, boundary regression, vector ≠ successor ACL | rejected by the advance predicate |
| cold open with floor trust only and unknown `priorCheckpointDigest` | succeeds; the opener never requests predecessor bytes |
| codec given only the successor material's key | verifies; no input exists for a current-epoch key |
| control vertex in close graph | in charges/frontier/close-set/history; excluded from the application fold |
| row substitution at or below `terminalThrough` | terminal; never applied |
| legacy v1 room receives fence/profile | unsupported/mixed-profile rejection; v1 unchanged |
| creator's own displaced row | same plan/fence path; no legacy retirement record |
| null-boundary member with no fence and no slot 0 | boundary stays null; close succeeds |
| prune with an unlinked plan entry | refused |
| cross-object migration import | manual-review debt; unchanged |

## Retained findings absorbed

From `solution.md` §4 and the adjudication, each with its owning slice:

- inverted `admittedThrough`/`settledThrough` rules: resolved by one boundary (f5b0a, f5b);
- `readRebaseOutbox` skips published rows (`v3-live.ts:6446`; the D.110c-0c1d record's state-selection-predicate
  freeze is deliberately reopened for the settlement profile only): f5b0b;
- rows older than one predecessor unclassifiable (`v3-live.ts:4611-4619`,
  `:5436-5438`): f5b0b;
- no owner for the returning author's lineage: resolved as no jump (f5b0s);
- closure validators reject the new profile: f5b0a;
- prior-less writer check aborts close (`creator-close.ts:517-524`): f5b;
- `completeRebaseSource` is a second completion owner: f5b0b/f5b0c;
- `closeVertices/closeAuthors/closeCharges` do not exist; the complete maps are
  `applicationVertices/...` (`v3-live.ts:7432-7434`): rename in f5b0b;
- nothing prunes in production; recovery-scan cap fails with age: f5b0d;
- non-creator hot follow, journal/snapshot/seal scope retirement, ≥100-transition
  gate, archive-root producer: D.110c-c, D.110c-d, Phase 7, unchanged;
- durable own last-adopted `terminalThrough` so that old-incarnation rows above
  it become `manual-review` candidates at re-admission (plan-change.md B.4, P2):
  deferred and unowned; not in this slice set.

## TDD implementation slices

f5b0p-a and f5b0p-b are deleted. f5b0q is closed as superseded. Each slice has
one causal tests-only RED before its GREEN with focused, static, retained and
isolated gates, signed commits and pushed refs.

1. **f5b0a — protocol codecs.** Fence codec and global reservation; settlement
   checkpoint codec with the triple frontier, derivation/binding rules,
   signer-agnostic prepare/open, shape-only predecessor validation, per-author
   accessor, re-measured ceiling; `settlementProfileFor` predicate and its
   seven consumers; equivocation canonicaliser same-anchor rule
   (`packages/protocol-v3/src/index.ts:3648-3665`).
2. **f5b0s — settlement plan store.** The contract above; memory, browser and
   node implementations; conformance vectors for CAS, atomic `planEffect`,
   ambiguous outcome readback, corruption refusal and the prune gate.
   Independent of f5b0a; may run in parallel.
3. **f5b0b — Node.** Dedicated fence issuer over `transactIssue` +
   `planEffect`; refusal without a complete plan; anchor-agnostic own-row
   classification for any older epoch and for old incarnations;
   `readSettlementSources` returning every own row above `terminalThrough`
   regardless of `publishState`; `completeRebaseSource` unreachable under the
   profile; close-graph split with the rename; retained compaction invariant
   that no control operation reaches authorization, reservation, apply, ACL
   staging, projection or application accounting.
4. **f5b0c — room.** Plan building and merge, fence-then-replacements order,
   deletion of `already-present`, `hasDisplacedOperation` and the
   published-must-be-present throw, ACL-row surfacing, manual-review hold,
   migration-import refusal. Public `issue()` unchanged.
5. **f5b0d — reclamation.** `pruneAuthenticatedSettledPrefix` with the plan
   gate, its production invocation, the recovery-scan cap correction, and
   journal/snapshot/seal/AHE scope retirement hooks handed to D.110c-c.
6. **f5b — creator settlement and recovery integration.** The scan above under
   the profile, no v1 aggregate/legacy retirement, terminal recovery, and the
   causal RED below through at least three closes with restart and cold reopen
   for the creator and one non-creator writer.

Dependency order: 1 and 2 in parallel; 3 needs both; 4 needs 3; 5 needs 1-2;
6 needs 1-5. D.110c-c, D.110c-d and Phase 7 follow unchanged.

## Deterministic RED cases

1. Delayed dependency: 10 delayed, 11 causally after it; boundary stays at 9;
   11 never in a graph without 10; plan; fence; advance at the next close.
2. Fence admitted, crash before any replacement, close in between: boundary =
   fence slot; restart issues every unlinked entry exactly once next epoch.
3. Crash between two replacements, restart in the same epoch and after a
   close: the linked entry is never re-issued; the unlinked one is issued once.
4. Crash after the fence before the checkpoint: unpublished fence republished;
   displaced fence superseded by a larger `m`; never two accepted fences for
   one plan.
5. Node refuses a fence without a complete durable plan (missing,
   `manual-review`, or `fenceSequence` already set); a fence admitted before
   its replacements is the normal safe state.
6. Author absent for two or more closes: rows classified by own signature;
   drain; fence; advance; no `admission-rejected`.
7. Same-key removal and re-entry on the same device: new `admissionEpoch`; old
   rows terminal; first vertex is a fence at `lineage.next`; sequence continues.
8. Fresh-device re-entry: lineage 0; fence at 0 or slot 0 accepted; the old
   device's rows never collide.
9. Stale old-incarnation delivery: rejected at ingress by anchor; ignored by
   the scan; no equivocation proof materializes for a cross-anchor pair.
10. Duplicate replacement prevention: exactly one replacement per source across
    restart in the same epoch and after a close.
11. Manual-review hold: no plan completion, no fence, no replacements; other
    authors advance; resolving the hold later completes the plan.
12. Byzantine fence jump: huge `m <= f` accepted, only that author's space
    burns; `m > f` and `m <= s` ignored; two fences → largest valid `m`.
13. Pruning only after authenticated adoption, rollback and availability gates,
    and refused while any plan entry is unlinked.
14. Repeated restart/reopen across at least three transitions for the creator
    and one non-creator writer, with cold reopen and durable census.
15. Replacements delayed past the close while the fence is admitted: boundary =
    fence slot; replacements become new sources; no double apply.
16. Fence delayed past the close with replacements issued after it: nothing
    admitted; re-plan; larger fence; no double apply.
17. Null-boundary member with no fence and no slot 0: boundary stays null; the
    close succeeds; the v1 room keeps `AUTHOR_REENTRY_PROOF_REQUIRED`.
18. Advance predicate rejects a retained member's changed `admissionEpoch`, an
    added member's `admissionEpoch ≠ successorEpoch`, boundary regression, and
    a vector that is not exactly the successor ACL's members.
19. Published displaced source is surfaced by the drain; the room's
    absent-from-target path is unreachable under the profile.
20. `completeRebaseSource` unreachable under the profile; the plan is the only
    completion authority.
21. Displaced `join`/`causalJoin` covered by the fence with no application
    effect; displaced `acl` row surfaced before the fence.
22. Genesis: the first checkpoint assigns `admissionEpoch = 0` to every genesis
    member; the creator's slot-0 rows are accounted without a fence.
23. Same-slot duplicate below the fence: author frozen at the prior boundary;
    close proceeds; other authors unaffected.
24. Rollback after adoption: boundaries regress; linked plan entries are not
    re-dispositioned; the plan survives.
25. Transaction outcome unknown while issuing a fence or a replacement:
    admission halts; reopen finds either the row with its link or neither.
26. Cold open with floor trust only and an unknown `priorCheckpointDigest`
    succeeds; the opener never requests predecessor bytes.
27. Codec signer independence: prepare and open with only the successor
    material's key; no input exists for a current-epoch key.

## Acceptance and stop rules

No production edit or RED runs before this design receives one material
Grok 4.6/high, direct Kimi K3 (`KIMI_LOOP_MAX_STEPS_PER_TURN=100`) and Opus
xhigh confirmation with an empty P0/P1 union. P2 receives an owner/disposition
without prose-only recursion. No new cryptography; no protobuf/wire-envelope
change (the fence is an operation inside the existing envelope; the plan is
device-local); genesis-bound `creator-trusted-settlement-v1` with no v1
migration or late opt-in; `creator-trusted-v1` behavior byte-for-byte
unchanged. "Creator-trusted" constrains who may close; it does not license
the settlement codec or verifier to compare closing-authority keys across
epochs.

If review shows that a durable device-local plan is insufficient authority for
the author's own abandonment, that anchor fencing is not the admission check
for old incarnations, or that contiguity does not hold on a path this document
missed, stop and reslice rather than reintroducing the per-source grammar, the
global floor or the retired-key dictionary. The named fallback for the
incarnation carrier alone is `admissionEpoch` in a version-3 latched-ACL member
record; it is not selected here because ingress is already anchor-fenced.

The complete GREEN must demonstrate genuine plans, fences and replacements
through ordinary publication, close/adopt, restart and cold reopen; exact
state, ACL, authority, anchor, history, archive and operation accounting; no
same-anchor double close; unchanged `creator-trusted-v1` behavior; fail-closed
old/mixed peers; authenticated same-key re-entry on the same and a fresh
device; retained f2/f4/f5a and D.108-D.110 lifecycle behavior; bounded active
checkpoint/runtime census; and fresh-process repeated same-room memory in the
later ≥100-transition gate. Tests-only injected plans, fences or synthetic
checkpoint bytes cannot satisfy the end-to-end RED/GREEN.
