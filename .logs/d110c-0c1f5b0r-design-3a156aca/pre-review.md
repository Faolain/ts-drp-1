# f5b0r design-checkpoint review (read-only, HEAD ce6d4b57, anchor 3a156aca)

Scope reviewed: `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` (SHA-256 verified against
`manifest.sha256`: `251d3799…3fde5b`, matching the plan record's claim); plan records f5b0
(~:98404), f5b0p (~:98593), f5b0q (~:98784), f5b0r (~:98861), f5b (~:98937), 0c1j (:96976),
0c1k (:97011); evidence `plan-change.md` Parts A–C and `lineage-profiles-impact.md` §3.
`3a156aca` is an ancestor of HEAD with **no diff under `packages/` or `examples/`**, so every
code citation verified below holds at both commits.

## Findings — plan edits a future peer needs

### P1-1 — f5b record still commands the superseded RED shape, including a terminus error that exists nowhere
Evidence: `docs/production-hardening/production-hardening-tdd-plan-v2.md` f5b body (~:98950–99020)
requires "two independent genuine triggers" including the no-rebase trigger ("sequence `n+1` is
admitted in epoch `k` while `n` is delayed") that f5b0r proves unreachable by contiguity, requires
reconciling "the review's three proposals" (receipt/covered-run/history-proof families all
superseded), and requires the eventual RED to "terminate only at
`D110C_0C1F5_REBASE_SUPERSESSION_FRONTIER_REQUIRED`" — a token that appears **zero** times in
`packages/` or `examples/` (only in this plan record) and belongs to the superseded family. The
f5b0r record redirects the trigger ("f5b RED case 1 in the design replaces that trigger") but says
nothing about the terminus or the candidate-family audit instructions, and the f5b status line
does not either. A peer reading f5b top-to-bottom after the review passes would build slice-6 RED
against a nonexistent sentinel.

Proposed plan edit (inside f5b, immediately after its status paragraph): add
> "Superseding note (D.110c-0c1f5b0r): the two-trigger requirement, the three-proposal
> reconciliation and the `D110C_0C1F5_REBASE_SUPERSESSION_FRONTIER_REQUIRED` terminus below
> describe the pre-f5b0r candidate families and are historical audit record only. The
> authoritative f5b slice definition and RED obligations are design.md 'TDD implementation
> slices' item 6 and RED cases 1–27; the no-rebase trigger is replaced by delayed-dependency
> case 1."

### P2-2 — f5b0/f5b0q superseded slice paragraphs share the names f5b0a–f5b0d with the new list and still specify the old grammar
Evidence: f5b0's "implementation remains split by owner" paragraph (~:98565–98577) defines "f5b0a
protocol carrier/checkpoint codecs", "f5b0c room policy, exact indexed replacements, zero-intent
sources", "f5b creator dual-frontier advancement, registry transition"; f5b0q acceptance-matrix
item 3 (~:98826–98829) states "f5b0a is the sole owner of the signed settlement checkpoint codec,
its … root/count fields, 7,064-byte maximum" — the new f5b0a checkpoint has **no** root/count
fields and re-measures the ceiling. Both records carry SUPERSEDED status lines at the top, but a
peer grepping the plan for "f5b0a" lands in these paragraphs 100+ lines below the status with no
local marker. Answer to the navigability question: option (i) — one redirect sentence — is
sufficient; do not duplicate per-slice paragraphs into f5b0r (design.md already carries them and
duplication invites drift).

Proposed plan edit (in f5b0, immediately before "After an empty combined confirmation,
implementation remains split by owner:"): add
> "(Superseded slice definitions: the f5b0a–f5b0d/f5b descriptions below carry the retired
> per-source grammar and are retained as evidence only; the authoritative slice list is
> design.md 'TDD implementation slices' under D.110c-0c1f5b0r.)"
Optionally the same parenthetical after f5b0q matrix item 3's "root/count fields" sentence;
f5b0q's top status ("CLOSED AS SUPERSEDED … single ownership … carried into f5b0a") already
covers the rest of that short record.

## Findings — design.md edits

### P2-3 — Genesis `admissionEpoch` rule contradicts the absent-from-prior-checkpoint rule at the first checkpoint
Evidence: design.md "Settlement checkpoint" bullet 1: "A member absent from the prior checkpoint
carries `admissionEpoch = successorEpoch`" and, three sentences later, "Genesis members receive
`admissionEpoch = 0` in the first checkpoint." At the first checkpoint the predecessor is the
genesis sentinel, so **every** member is absent from the prior checkpoint; the two sentences give
0 and successorEpoch for the same member. The scan section has the correct key ("or
`(successorEpoch, null)` for a member absent from the **current ACL**"), matching plan-change B.2
("the creator derives `admissionEpoch` at close from 'author ∈ current ACL?'"). This directly
feeds f5b0a's codec derivation/binding vectors and RED cases 18/22 — the one place a fresh f5b0a
implementer must otherwise guess.

Proposed design edit: in the checkpoint section, replace
"A member absent from the prior checkpoint carries `admissionEpoch = successorEpoch` and
`terminalThrough = null`."
with
"A member absent from the **current ACL** carries `admissionEpoch = successorEpoch` and
`terminalThrough = null`; when the predecessor is the genesis sentinel, members of the current
(genesis) ACL receive `admissionEpoch = 0` and members added at this close receive
`successorEpoch`."
(and keep the existing genesis sentence as the worked case).

### P2-4 — When exactly a fence must be issued is stated three incompatible ways
Evidence: drain step 5 issues the fence unconditionally after the plan; the Compatibility section
says "the fence action is mandatory from the first epoch in which a displaced source exists";
plan-change B.3 says "The room always issues one fence per open/adopt after the drain." The
difference is load-bearing at same-device re-entry (matrix row and RED case 7: "first fence at
`lineage.next` establishes the base"): the returning author's old rows are **terminal**
(`epoch < admissionEpoch`), not displaced, so its plan can be empty — under the
"only-when-a-displaced-source-exists" reading no fence is issued, the null boundary can never
advance (no fence, no slot 0), and case 7 fails. Node's refusal rule ("refuses a fence unless a
durable plan exists with no `manual-review` entry and a null `fenceSequence`") must also be read
as accepting an empty-entries plan, which is currently only implicit.

Proposed design edit: in "Author drain, plan and fence", after step 5, add
"A fence is issued at every open/adopt under the profile once the drain completes, including with
an empty plan (a returning member with only terminal old-incarnation rows); Node's refusal rule
accepts a durable empty-entries plan. The Compatibility sentence's 'mandatory from the first
epoch in which a displaced source exists' is the verifier-side lower bound, not the room's
issuing rule." (Or, if conditional issuance is intended, name the re-entry carve-out explicitly.)

### P2-5 — Terminal-rule sentence contradicts the old-incarnation-terminal drain rule
Evidence: "Recovery, terminal rule and pruning": "Rows above the boundary from an older epoch are
displaced sources for the plan; they are never silently terminal" versus drain step 2:
"`row.epoch < e`: old incarnation, terminal." Old-incarnation rows above the boundary ARE
silently terminal by design (plan-change B.4 default). Two different rules for the same row.

Proposed design edit: change that sentence to
"Rows above the boundary from an older epoch **of the current incarnation
(`admissionEpoch <= epoch < current`)** are displaced sources for the plan; they are never
silently terminal. Old-incarnation rows (`epoch < admissionEpoch`) are terminal at re-admission
and covered by the first fence."

### P2-6 — No rule retires plan entries whose sources became terminal by incarnation change; unlinked entries then block pruning forever
Evidence: `pruneAuthenticatedSettledPrefix` "refuses any row referenced by an unlinked plan
entry" (design store section; plan-change §A.4/C.8). A member removed mid-plan and later
re-added has unlinked `rebase`/`transform`/`manual-review` entries whose source rows now classify
old-incarnation-terminal; neither design.md step 3's merge rules nor plan-change C.5 says those
entries are dropped, so the prune gate refuses their rows permanently and the `manual-review`
hold in step 4 could even re-arm against dead sources. Affects f5b0s conformance vectors (prune
gate) and f5b0c merge.

Proposed design edit: in drain step 3, add
"An entry whose source row now classifies terminal (`seq <= s`, or
`row.epoch < admissionEpoch`) is removed from the plan at merge — the boundary, not the plan,
settled it — and no longer holds the prune gate."

### P2-7 — Stale plan-line citation in "Retained findings absorbed"
Evidence: design.md cites "plan `:98815-98823` predicate reopened" for the `readRebaseOutbox`
published-rows finding. At HEAD those plan lines hold the f5b0q AVL acceptance matrix; the
intended target — D.110c-0c1d's "state-selection predicate" freeze ("…omitted from reissue by the
unchanged `publishState !== \"published\"` state-selection predicate… Do not change the
state-selection predicate, `readRebaseOutbox()`, or `completeRebaseSource()`") — now sits at
~:99083–99097 and will drift again with every plan insert. (plan-change.md carries the same raw
cite; that file is frozen evidence and needs no edit.)

Proposed design edit: replace "plan `:98815-98823` predicate reopened" with
"the D.110c-0c1d record's state-selection-predicate freeze ('Do not change the state-selection
predicate, `readRebaseOutbox()`, or `completeRebaseSource()`') is deliberately reopened for the
settlement profile only".

### P3-8 — Near-miss line cites (all within 1–3 lines; correct on substance)
- "pending-only predicate at `v3-live.ts:6446`": :6446 is the historical **published-skip**
  (`publishState === "published" → continue`); the pending-only line is :6447. Both are the
  predicate pair being replaced.
- "`applicationVertices/...` (`v3-live.ts:7433-7435`)": the `copyApplicationVertices` line is
  :7432; :7432–7434 is exact.
- `browser-issuance-store.ts:116-120` for `exactStoreNames`: function body is :115–119.
- `node-issuance-store.ts:249-254` for the v1→v2 migration: block is :248–255.
No action required beyond optional tightening.

### P3-9 — Two dropped/unstated minor items
- plan-change B.4's optional P2 follow-on (author durably records its own last-adopted
  `terminalThrough`; old rows above it become `manual-review` candidates at re-admission) is
  silently absent from design.md. plan-change marks it "not in this slice set", so the drop is
  legitimate, but the design's own acceptance rule ("P2 receives an owner/disposition") suggests
  naming it once as deferred-unowned.
- Scan step 2's `m = 0` base ("before slot 0") implies transient `s = -1`; by contiguity the
  admitted m=0 fence's own slot 0 always advances `s` to ≥ 0, so a negative `terminalThrough` is
  never emitted — one clause saying so would spare the f5b0a monotonicity-check implementer the
  derivation.

## Nothing to change — confirmation only

- **Fidelity (A).** Design.md is a faithful promotion of plan-change Part C: C.1 checkpoint
  (all fields, sort/uniqueness/monotonicity, both-ACL recomputation, absent
  `sequenceFloor`/`admittedThrough`/registry fields, 8,192 ceiling + 6,959 re-measure), C.3 fence
  (grammar `m <= f` only, global reservation, control/application close-graph split, dedicated
  control issuer), C.4 scan steps 1–5 verbatim including freeze semantics and the
  `AUTHOR_REENTRY_PROOF_REQUIRED` replacement scoped to the profile, C.5 steps 1–7 plus the
  restart/idempotence rule and the §A.3 fence-first justification, C.6 ACL law (including B.4
  resubmittability and the anchor-fencing collision argument), C.7 matrix (all 27 rows present,
  wording preserved, case-18 row amended to "advance predicate" per Delta 4, plus the two delta
  rows), C.8 store contract verbatim including no `transactAdvanceLineage` and the
  consumed-but-absent latch cites, C.9 slices (f5b0p-a/b deleted, f5b0s added, absorption notes
  preserved, dependency order 1∥2 → 3 → 4, 5 needs 1–2, 6 needs 1–5). All five lineage deltas are
  present: signer-agnostic codec with the :278/:399 checks "not carried over" (Delta 1),
  `settlementProfileFor` with exactly the seven named consumers (Delta 2), `frontierFor`/
  `frontierCount` with no reserved field (Delta 3), shape-only predecessor validation +
  advance-predicate enforcement + O(1) cold reopen + amended case 18 (Delta 4), and the
  stop-rule sentence verbatim (Delta 5).
- **RED renumbering is lossless.** C.10's 1–25 map one-to-one onto design 1–25 (C.10's "26/27"
  were drop-notes for deleted floor/dictionary cases, not cases); Delta-4's added 28/29 are
  design 26/27. The f5b0r plan record's "27 deterministic RED cases" is correct.
- **Code citations (B).** Every key citation verified exact at HEAD (= anchor): `v3-live.ts`
  :6217-6240 (tips-sourced local issue), :3711-3716 (`hasInstalledDependencies`), :3862 (ingress
  refusal), :7430-7460 (`captureCloseGraph`, completeness checks), :6446/:6447 (outbox
  predicates), :4611-4619 (single-predecessor classifier), :4756 (dropped
  `admittedAuthorSequence` constraint), :4762-4769 (anchor/epoch-from-row shape), :4349-4355
  (`countHistoricalIssuanceRow` cap — exact), :3800-3829 (anchor-fenced ingress +
  `classifyV3EnvelopeScope`), :3755-3756 (`maxPendingEntries` gates pendingIngress), :1431
  (reopen `profileId !== "creator-trusted-v1"`), :5436-5438 (classifier hard failure),
  :6637-6685 (`completeRebaseSource`), :3521-3527 (`nextSigners` hook); `creator-close.ts`
  :486-497 (duplicate slot), :517-524 (prior-less throw, block :518-524), :528-546 (regression
  freeze/throw), :209 (profile literal); frontiers :278/:399 (`compareBytes(current.publicKey,
  successor|floor.publicKey)`), :165 (>64 cap); `latched-acl.ts:8` (`MEMBER_KEYS`), :133-134,
  :206/:218, :334-336; `index.ts:3648-3665` (per-witness `expectedAnchor`), :774, :1744-1745;
  `contract.ts:281` (exact commit keys); browser store :176-181, :443-447, :1036-1038 (and
  :115-119 per P3-8); node store :248-255, :486-490, :756-800; `registry.ts:460` (profileId
  switch); `creator-trust-checkpoint-advance.ts:198-207`; `creator-transition-advance.ts`
  :326-328/:397-398; v3-room :2796-2990 (drain + rebasePromise), :2814, :2852-2857
  (absent-from-target throw), :2911, :2971, :3844 (`await rebasePromise`), :488, :3985. 0c1j's
  and 0c1k's citations (protocol creator-close :218-222/:379/:598-601, index :1744-1745, node
  creator-close :902, latched-acl :459-480) also verified; both records point at the right
  evidence sections (§2.A/Delta 1; §2.C/§4).
- **Contiguity fact (E).** The code supports it: local issue depends on the full tip set of the
  causally closed index (joins included), ingress admits nothing with uninstalled dependencies,
  and `captureCloseGraph` refuses any registration whose maps disagree with `index.size`. No
  contradiction found. No P0/P1 against safety or implementability of the construction itself;
  the fence/plan/checkpoint semantics are internally consistent everywhere else checked
  (fence-slot self-closure, matrix rows 4/6/7 of the crash walk, planEffect failure semantics vs
  restart via the displaced-fence-clears-`fenceSequence` merge rule, `m <= f`/`m <= s` scan
  agreement, delayed-fence row via contiguity of replacements-after-fence).
- **Manifests/anchors.** Design SHA-256 matches its manifest and the plan record; `3a156aca` is
  an ancestor of HEAD `ce6d4b57` with zero source drift under `packages/`+`examples/`.

## Verdict

**f5b0s: yes as-is.** The store contract, atomicity semantics, conformance-vector list and its
independence from f5b0a are complete and unambiguous in design.md, and the f5b0r plan record
routes a fresh peer there correctly.

**f5b0a: yes only after one design edit** — P2-3 (genesis `admissionEpoch` vs
absent-from-prior-checkpoint), which sits squarely in f5b0a's derivation/binding rules and RED
cases 18/22; everything else the slice needs is exact.

Minimum edit set before the RED pair starts: **P2-3** (design.md). Strongly recommended in the
same batch because they gate the immediately following slices and the plan's navigability:
**P1-1** (f5b inline note), **P2-2** (f5b0 redirect sentence), **P2-4/P2-5/P2-6** (design drain/
terminal/merge clarifications), **P2-7** (stale plan-line cite). P3 items are optional polish.
