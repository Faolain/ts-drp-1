# Phase 6b — Bounded Pruning

## Next Agent Prompt

Status (2026-08-31): D.109a eligibility and D.109b issuance retention are
closed. D.109b's signed/pushed GREEN and final-review anchors are respectively
`529367b154ffd3fb66bf31a6cfedb4a0d9b73746` and
`2afadbe682261bdb311a5cb64f6f42d86ed7330b`; their plan, RED, GREEN, reviews,
and evidence are accepted and must not be reopened. Freeze, sign, push, and
review [D.109c AHE reclamation](slices/02-ahe-reclamation.md). Its initial plan
review found two accepted P1 corrections: the ephemeral memory facade is not a
reclamation owner, and four live export-census tests require explicit tests-
only custody. Sign/push the corrected plan and run its one permitted
Grok/Kimi/Opus confirmation, then execute tests-only causal RED before adding
any AHE deletion path.

Global TODO:

- [x] D.109a eligibility planner and causal closure.
- [x] D.109b issuance retention and causal closure.
- [ ] D.109c AHE reclamation plan → RED → GREEN → final review.
- [ ] D.109d receipt-gated runtime reclamation.
- [ ] D.109e browser primary scheduling reuse.
- [ ] D.109f differential/census exit, including D.109b's three assigned P2
      parity/deep-freeze checks.

Before ending a pass, update this handoff with the exact signed/pushed anchor,
current gate, and next executable command.

The user has prohibited further Fable and collaboration subagents after the
one expressly authorized Phase-6b Fable review. Phase-6b formal reviews use
Grok, exact Kimi high/100-step, and Opus xhigh; Codex `gpt-5.6-sol` does not
substitute for Kimi. If Grok cancels, resume that exact session; do not replace
it. These reviews run through their external CLIs; they are not collaboration
subagents.

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

| Concern                                                | Existing sole owner                                             | Phase-6b rule                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| AHE head, generations, promotions, blobs               | `@ts-drp/storage` plus Node/IDB adapters                        | Add one bounded physical-reclamation command; never infer QC or availability in the adapter.                                 |
| Issued rows and issuance outbox                        | `@ts-drp/issuance-store` plus dedicated Node/IDB adapters       | Classify canonical preimages in the owning transaction; pending or malformed old-epoch rows block deletion.                  |
| Verified close and successor adoption                  | `@ts-drp/node` creator close/adoption owners                    | Supply authenticated facts to the cleanup planner; do not duplicate verification.                                            |
| Runtime graph, state snapshots, checkpoints and caches | `@ts-drp/object`; v3 pending/sync inventories in `@ts-drp/node` | The installed v3 runtime orchestrates both owners after durable cleanup receipts; neither owner can mint deletion authority. |
| Browser primary dispatch                               | Phase-5c internal vote dispatcher                               | Extract/reuse its one advisory lock runner; do not add a second election protocol.                                           |
| Legacy finality                                        | `FinalityStore`                                                 | Preserved until Phase 6d defines post-expiry behavior.                                                                       |

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
   durable receipts, compact graph payload/index history, state snapshots,
   checkpoints, and v3 pending/sync inventories; preserve legacy finality.
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
