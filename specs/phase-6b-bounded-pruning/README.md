# Phase 6b — Bounded Pruning

## Next Agent Prompt

Status (2026-09-01): D.109a eligibility, D.109b issuance retention, and
[D.109c AHE reclamation](slices/02-ahe-reclamation.md) are closed. D.109c's
signed/pushed GREEN is `3d21264f4477fb5ff586047826ebd49e15d20bde`;
Grok 4.6/high, standard Kimi K3/high/100-step, and Opus xhigh unanimously
approved it with an empty P0/P1 union. Its plan, RED, GREEN, review, and
evidence are accepted and must not be reopened. The bounded
[D.109d installed-v3 runtime reclamation](slices/03-runtime-reclamation.md) is
also closed. Its signed/pushed correction is
`40382c7bddadd4aa007bf9e2bc5bbab7b5a8b224`; the single Grok/Kimi/Opus
confirmation unanimously approved it with an empty P0/P1 union. Focused 12/12,
retained 142/142, all four retained browser groups, Node build, and affected
static gates pass. D.109e browser primary scheduling reuse is also closed at
signed/pushed correction `fd99b1ac567c6a559593916492cb9c2036109066`;
its one Grok/Kimi/Opus confirmation unanimously approved with an empty P0/P1
union. D.109e's documentation closure is signed/pushed at
`bb7d4601ac951df28b066e22dba1c096abe287c0`. D.109f differential/census exit
is the active slice. Its bounded plan is being frozen before RED; do not reopen
D.109a-D.109e or run a campaign.

Global TODO:

- [x] D.109a eligibility planner and causal closure.
- [x] D.109b issuance retention and causal closure.
- [x] D.109c AHE reclamation plan → RED → GREEN → final review.
- [x] D.109d receipt-gated runtime reclamation.
- [x] D.109e browser primary scheduling reuse.
- [ ] D.109f differential/census exit, including D.109b's three assigned P2
      parity/deep-freeze checks and D.109c's invalid-input-polarity,
      second-process SQLite concurrency, and browser facade-census checks.

Before ending a pass, update this handoff with the exact signed/pushed anchor,
current gate, and next executable command. D.109f's plan must be signed/pushed,
then reviewed once by Grok 4.6/high, standard Kimi CLI K3/high/100-step, and
Opus xhigh before its deterministic tests-only RED.

The user has prohibited further Fable and collaboration subagents after the
one expressly authorized Phase-6b Fable review. Phase-6b formal reviews use
Grok, the standard Kimi CLI with K3/high and a 100-step cap, and Opus xhigh;
Codex `gpt-5.6-sol` does not substitute for Kimi. If Grok cancels, resume that
exact session; do not replace it. These reviews run through their external
CLIs; they are not collaboration subagents.

## Goal

Bound closed-epoch durable and live structures without weakening recovery,
availability, publication, or activation authority. Cleanup becomes possible
only after verified commit QC, durable successor adoption, the two complete
rollback generations reached by following `baseExpectedHead` twice from the
active adopted generation, satisfied availability policy, and a completely
valid outbox classification.

## Non-goals

- No wire-format, digest-domain, signature, QC, activation, or identity change.
- No receipt-authentication or rollback-release work from deferred slice 7b-r.
- No deletion by a Web Lock, timer, lease, UI, or runtime-only observation.
- No cross-database atomicity claim. Each physical owner rechecks its own
  monotone facts transactionally immediately before its own deletion.
- No legacy-finality retention change; Phase 6d still owns it.
- No memory threshold change; Phase 6c still owns the memory gates.
- No archive-segment or cold-storage product behavior; Phase 7 owns it.

## Existing owners and gaps

| Concern                                              | Existing sole owner                                                              | Phase-6b rule                                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AHE head, generations, promotions, blobs             | `@ts-drp/storage` plus Node/IDB adapters                                         | Add one bounded physical-reclamation command; never infer QC or availability in the adapter.                                                                              |
| Issued rows and issuance outbox                      | `@ts-drp/issuance-store` plus dedicated Node/IDB adapters                        | Classify canonical preimages in the owning transaction; pending or malformed old-epoch rows block deletion.                                                               |
| Verified close and successor adoption                | `@ts-drp/node` creator close/adoption owners                                     | Supply authenticated facts to the cleanup planner; do not duplicate verification.                                                                                         |
| Installed-v3 closed runtime retention                | displaced/current registrations plus bound creator-close state in `@ts-drp/node` | After receipts cover the authenticated closed-epoch end, release predecessor graph/state/classification duplicates; the live successor remains byte- and identity-stable. |
| Legacy/general graph, snapshots, checkpoints, caches | `@ts-drp/object`                                                                 | It is not bound into the installed v3 plane and remains byte-identical in Phase 6b; do not invent a cross-runtime reclamation bridge.                                     |
| Browser primary dispatch                             | Phase-5c internal vote dispatcher                                                | Extract/reuse its one advisory lock runner; do not add a second election protocol.                                                                                        |
| Legacy finality                                      | `FinalityStore`                                                                  | Preserved until Phase 6d defines post-expiry behavior.                                                                                                                    |

The current AHE database, issuance database, snapshot quarantine, and runtime
memory are distinct owners. Safety therefore comes from monotone epoch closure,
exact revision/identity checks, store-local atomic refusal, idempotent stages,
and receipts. A partial crash may leave extra old data, but it may not delete
data whose local preconditions changed.

## One cleanup state machine

```text
verified close + adopted successor
              |
              v
       eligible plan (no mutation)
              |
       +------+------+
       |             |
       v             v
 issuance receipt  AHE receipt
       |             |
       +------+------+
              |
              v
       runtime reclamation
              |
              v
      bounded-structure audit
```

Every transition is idempotent. An absent receipt means “retain,” not “assume
success.” A stale request, changed head/revision, insufficient rollback set,
unsatisfied local availability, pending/invalid outbox row, raw dependency, or
owner lifecycle failure deletes nothing in that owner.

## Slice graph

1. [D.109a eligibility](slices/00-eligibility.md): one deterministic planner,
   exact refusal taxonomy, and no deletion.
2. [D.109b issuance retention](slices/01-issuance-retention.md): atomically
   classify and remove only eligible published closed-epoch issued/outbox
   pairs. Its prospective extension of the same pure D.109a planner carries
   the owner-observed lineage/watermark so restart and later-epoch planning
   remain reachable after an earlier prefix was physically pruned; historical
   D.109a evidence remains immutable.
3. [D.109c AHE reclamation](slices/02-ahe-reclamation.md): atomically remove
   selected superseded generations, their promotions, and newly unreferenced
   blobs while retaining the active generation plus its two immediate complete
   `baseExpectedHead` rollback ancestors.
4. [D.109d runtime reclamation](slices/03-runtime-reclamation.md): after both
   durable receipts, release the installed v3 successor's displaced-source
   retention and compact any hot retired predecessor registration; preserve
   the current successor and all legacy/general object/finality behavior.
5. [D.109e browser scheduling](slices/04-browser-scheduling.md): reuse the exact
   Phase-5c advisory primary-dispatch runner and prove lock-mode equivalence.
6. [D.109f differential exit](slices/05-differential-exit.md): ≥100-epoch
   archival-versus-compacted equivalence, raw-dependency audit, crash/reopen,
   and complete enumerated-structure census.

## Sacred contracts

- The active AHE head and every referenced byte remain complete and recoverable.
- Exactly the two immediate rollback ancestors reached by following
  `baseExpectedHead` twice from the active adopted generation remain complete
  after every AHE reclamation. Both generation rows and every blob in both
  closures must exist. Two other countable superseded generations never satisfy
  this rule. Random generation identifiers never imply chronological order;
  the verified lineage supplies exact identities.
- Generation-row reclamation preserves the current parent-presence invariant.
  In the same owner transaction that deletes a complete older ancestry prefix,
  rewrite only the oldest retained rollback ancestor's `baseExpectedHead` to
  the existing `{ kind: "none", objectId }` form. Its generation identity,
  revision-bearing descendants, closure digest, closure, state, and bytes are
  otherwise unchanged. The transaction refuses if any surviving row other than
  that exact floor points into the deletion set, if the deletion set is not the
  complete connected prefix below the floor, or if post-state lineage has a
  dangling parent. This is local metadata compaction, not a wire or digest
  change.
- An old-epoch issuance row is deletable only when its canonical preimage is
  valid, epoch-bound, paired, and `published`. A `pending`, malformed,
  one-sided, foreign-digest, or unreadable row blocks that owner with no writes.
- The issuance owner retains one monotone per-scope pruning watermark equal to
  the inclusive last deleted `authorSequence`, in the same transaction that
  removes a complete published prefix. Terminal classification reads the row
  and watermark in one owner transaction. Consumed-but-absent addresses at or
  below that watermark are `pruned`, never corruption;
  a late acknowledgement receives exact non-poisoning
  `ISSUANCE_RECORD_PRUNED` rather than an unverified exact-digest success.
- Local-only availability requires the adopted local snapshot and exact
  equality with frozen availability-policy digest
  `53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b`.
  Phase 6b never decodes policy bytes. Any other digest retains all data until
  Phase 7b owns policy grammar. Mirror receipt verification remains unavailable
  until 7b-r and cannot be fabricated in 6b.
- Runtime reclamation consumes exact durable receipts and cannot reconstruct
  them from current memory.
- Advisory browser ownership affects who attempts work, never which bytes are
  eligible. Locks on, off, unavailable, rejected, timed out, and takeover yield
  the same eventual eligible deletion set.
- A cleanup stage may fail by retaining too much; it must never fail by deleting
  too much.
- Until 7b-r supplies authenticated rollback release, neither of the two
  generations counted toward the committed minimum is deletable. The release
  conjunction member is vacuous only for older superseded generations beyond
  that protected pair.
- Phase 6b preserves both the Discord and MMORPG golden paths and enables
  neither; D.109f's archival-versus-compacted equivalence list is the proof
  obligation.

## Review and evidence

Each slice follows the prospective D.108e4 review policy: one bounded
Grok/Kimi-high-100/Opus plan review where required, deterministic RED, narrow
GREEN plus focused/static/retained gates, then one final review over the signed
plan/RED/GREEN history. High-risk deletion, schema, scheduling, or threshold
changes explicitly receive the review needed for that risk. Mechanical checks
own path sets, source shape, result counts, error codes, hashes, manifests,
signed commits, pushed refs, protected paths, stashes, ports, and processes.

## Refactor-clean audit

- There is one cleanup planner, not per-backend eligibility logic.
- There is one physical owner for each byte class; the orchestrator never
  reaches into native IDB/SQLite handles.
- Existing mandatory `AheDurableStore` and `DurableIssuanceStore` interfaces
  remain unchanged. Node/browser adapters expose separate identity-gated
  package maintenance capabilities resolved only from their genuine concrete
  store instances; ordinary stubs cannot mint deletion authority.
- The Phase-5c lock runner is extracted once and the vote dispatcher migrates
  to it before cleanup uses it; no compatibility wrapper remains.
- Durable receipts are stage results, not a second truth store or permanent
  shadow metadata model.
- The AHE receipt records the exact lineage floor, its former parent, and the
  deleted prefix. It does not authorize a later rewrite; every run rechecks the
  current complete graph transactionally.
- Public product APIs remain unchanged unless a later slice explicitly proves
  an unavoidable package contract change and reviews it before RED.
  D.109b’s addition of `ISSUANCE_RECORD_PRUNED` to the closed issuance error
  union and its required pruning-watermark member in the public terminal
  observation are one demonstrated exception: deleted digest evidence makes
  both success and corruption false.

## One-off advisory review

The expressly authorized Fable 5/high read-only review used session
`69ab32d6-9d07-4f38-953a-600d457b5320` and returned `CHANGES_REQUIRED` with two
P1 and two P2 findings. Result text SHA-256 was
`10dd88c2633239de76abb69158ba21899408dcf797d0425efe6d3a288becaefc`.
This corrected plan adopts the two P1s: a durable issuance pruning watermark
with non-poisoning pruned classification, and exact digest equality for the
frozen local-only availability profile without policy decoding. It also adopts
the P2s by naming separate identity-gated maintenance capabilities and a full
cross-object remaining-closure scan before global blob deletion. The reviewer
approved the staged owner topology, D.109a’s causal value, slice order, runtime
reuse, and Phase-5c advisory scheduling reuse. This one-off review is complete
and must not be relaunched.

## D.109d GREEN handoff

D.109d GREEN is implemented within its five executable owners and three
evidence documents. Receipt-gated reclamation now releases the authenticated
displaced source, compacts a reachable hot predecessor to its single anchor,
and clears the creator-close duplicate owner while leaving the current
successor and every durable store untouched. The accepted focused result is
12/12; retained D.109a/b/c and Phase-6a results are 142/142 Vitest plus 4/4,
4/4, 2/2, and 8/8 Chromium. All affected builds and exact-owner static gates
pass. Known whole-package typecheck debt remains confined to its inherited
test/configuration categories and emits no D.109d semantic diagnostic.

Evidence is rooted at `.logs/phase-6b-d109d-green/`. The final signed
Grok/Kimi/Opus implementation review and its one permitted correction
confirmation are complete. No campaign ran.

The first final review is complete and preserved. Grok and standard Kimi
approved; Opus's two P1s were corrected in the single permitted executable
batch. Correction evidence is rooted at
`.logs/phase-6b-d109d-green-correction/`; the signed and pushed correction
anchor is `40382c7bddadd4aa007bf9e2bc5bbab7b5a8b224`.
Grok 4.6/high, standard Kimi CLI K3/high/100-step, and Opus xhigh unanimously
returned `APPROVED` with an empty P0/P1 union. Confirmation evidence is rooted
at `.logs/phase-6b-d109d-green-confirmation/`; its validating self-excluding
manifest SHA-256 is
`428248d8bed4ee823a50dc94f64271419caa645fa5ca80eeb2e58f8ba57d67b0`.
D.109d is closed. The D.109e browser primary-scheduling plan is now frozen in
`slices/04-browser-scheduling.md` without reopening D.109a–D.109d; the exact
initial Grok/Kimi/Opus review preserved two approvals and one Opus P1. The exact
source-shape/causal-proof correction is signed and pushed at
`ea96d97525e34ab907f504dcef9ed2cfa43075fd`; its one confirmation unanimously
approved with an empty P0/P1 union. The exact next command is the single
authorized Chromium RED invocation after landing the frozen tests-only owners.

## D.109e plan handoff

D.109e extracts the existing Phase-5c advisory LockManager name, 250 ms
acquisition timeout, and exactly-once fallback into one package-private
primitive. The vote dispatcher retains all queue, durable scan, publication,
overflow, and close behavior. Browser AHE cleanup calls the same scheduling
primitive but retains all authority in its existing captured request,
owner-local recovery turn, current-state classification, strict transaction,
post-state validation, and immutable receipt.

The frozen RED covers grant, unelected/off, absent, non-callable, throw, reject,
abort, unavailable, timeout, stale late grant, same-context dual-tab replay,
primary close/takeover, `versionchange`, and changed-precondition refusal. The
lease carries no cleanup fact and cannot suppress the transaction's exact
recheck. Production scope is exactly four storage-browser internal owners; no
public API, schema, dependency, threshold, protocol, or campaign changes.

The initial plan review found one blocking wording/acceptance defect: a global
singleton scan would count legitimate LockManager users in other packages and
a separate 250 ms blocked-open timeout. The corrected scan is package-internal,
identifier-bound, and explicitly excludes tests-only injection and unrelated
timeouts. The same batch adds runtime observation of the exact AHE lock name
and requires the changed-precondition fixture to prove a genuine generation-6
head swap before callback release. Sign/push this correction, then run the one
permitted Grok/Kimi/Opus confirmation; RED remains unopened until its P0/P1
union is empty. That confirmation is complete with an empty union. Evidence is
rooted at `.logs/phase-6b-d109e-plan-confirmation/`; its validating
self-excluding manifest SHA-256 is
`c0f0dbd11bb0250edbbd98bff660f9786a9d240a6508b8cfe3559608532e531c`.
D.109e RED is now open; no further plan review runs.

The one authorized D.109e Chromium RED has now run and matched the frozen
matrix exactly: six tests in one file, one independent source/owner pass, one
failure carrying only `D109E_PRIMARY_DISPATCH_MISSING`, four readiness skips,
zero flaky results, and zero top-level errors. Evidence is rooted at
`.logs/phase-6b-d109e-red/`. The checkpoint is tests-only; production remains
unchanged, and D.109e GREEN is now open over exactly the four frozen internal
owners.

D.109e GREEN is now implemented over exactly those four internal owners. The
final gates are green: focused Chromium 6/6, all-engine D.109e 18/18, retained
Phase-5c 25 passed with its two expected non-Chromium death-test skips, retained
D.109c Chromium 4/4, and all build/exact-owner static gates. Whole-package
typecheck remains nonzero only on the inherited tests-root alias/branded-fixture
set and contains no frozen production owner. Evidence is rooted at
`.logs/phase-6b-d109e-green/`; sign/push this GREEN, then run the one formal
Grok/Kimi/Opus history review before closure.

That final review completed with three approvals and an empty P0/P1 union. A
Grok P2 correctly observed that failed publication no longer rejected the
consumer's internal tail, which could change Phase-5c `close()` behavior even
though `drain()` still rejected. The single correction restores the original
`await result` tail behavior. All D.109e and retained browser/static gates pass
again; correction evidence is rooted at
`.logs/phase-6b-d109e-green-correction/`. One bounded confirmation of this exact
correction followed; no other review P2 widened D.109e.

The bounded correction confirmation is complete. Grok 4.6/high, standard Kimi
CLI K3/high/100-step, and Opus xhigh unanimously returned `APPROVED`, P0 none,
P1 none, and `D109E_GREEN_CLOSABLE: yes` for signed/pushed correction
`fd99b1ac567c6a559593916492cb9c2036109066`. Its validating self-excluding
manifest SHA-256 is
`a78c72b15a660197ace16542af5b8b3491f3cb8a08a4a1ce2555c02f12ca6378`.
D.109e is closed without a campaign. D.109f is next.
