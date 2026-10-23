# Late-arrival retirement: model, evidence, and limits

The model supports the completion/dependency design for bounded retirement, with the conditions below. It
also reproduces the failures of the previous per-case rules. It does **not** prove the production library or
arbitrarily many epochs correct. Native browser, persistence, and long-room evidence remain separate gates.

[Replay lifetime and retirement-intent adjuncts](REPLAY-CUSTODY.md) cover the later read-phase, borrowed
custody, cross-handoff egress, broadcast-round, and exact-intent selection laws. Their current-fence
projection and finite transition bridge do not close the full-contract induction gap described here.

The user authorized challenging earlier assumptions on 2026-10-23. The completion contract may therefore
replace the earlier “replacement must land in a later cut” rule when implementation checks preserve accepted
intent. A durable replacement can carry that intent before it lands, provided the old source is signed
terminal and the replacement remains protected while any live plan entry needs it.

## What the model establishes

The [specification](../../../../packages/protocol-v3/formal/settlement-replacement-retirement.qnt) owns the
predicates and transitions. [Instances](../../../../packages/protocol-v3/formal/settlement-replacement-retirement-instances.qnt)
own deterministic schedules and simulation bounds; [proof instances](../../../../packages/protocol-v3/formal/settlement-replacement-retirement-proofs.qnt)
and [exhaustive instances](../../../../packages/protocol-v3/formal/settlement-replacement-retirement-exhaustive.qnt)
own checker bounds. [Mutation cases and the runner](../../../../packages/protocol-v3/formal/settlement-replacement-retirement-mutations/)
are the executable inventory of controls and expected failures.

A writer issues moves, install fences, and policy-derived replacements. A creator signs per-author cut
frontiers; writers may install late, miss cut members, crash between commits, rejoin, or return as a fresh
incarnation. The model tracks each store's copies, logical retirement, the physical watermark, settlement
plans, and the proof consumers. Signatures, digest identity, and policy derivation are abstract facts; the
model does not implement cryptography or transport.

The safety property asks whether deleted rows still carry required intent. The resource properties ask
whether a *completed* cleanup retains unnecessary scopes, exceeds scope limits, leaves an invalid plan,
or makes a later install terminal. Those are state invariants, **not eventual-delivery liveness**. A run
that never installs can satisfy them. Network fairness and actual progress need native evidence.

## Required implementation conditions

- **Terminal and settled are separate.** An outside own row is collectible only after an installed creator
  authority makes it terminal and its intent has a durable disposition. Neither fact alone is sufficient.
  A fence has no application intent; an expiry must be the immutable policy's authenticated disposition.
- **A missing cut member cannot erase proof.** The signed membership evidence must survive partial local
  receipt. Reconstructing a full cut from the writer's own graph fails on the partial-receipt schedule.
- **Proof lifetime follows every consumer.** Journal deletion cannot remove the only proof still needed by
  issuance retirement. Keep that proof until all consumers finish, or durably hand the fact to the next owner.
- **Plan dependencies close transitively.** A replacement named by a retained plan entry remains available.
  Compute retirement to a dependency fixpoint (or its equivalent topological pass). A single filter over the
  initial retirement candidates leaks or wedges on a longer replacement chain.
- **Retirement and plan rewriting commit together.** Retire-then-rewrite can leave references to retired rows;
  rewrite-then-retire can lose the evidence needed after a crash. Both orders have counterexamples.
- **Identity includes incarnation/digest.** Re-admission can restart author sequence numbers. Author plus
  sequence alone aliases new work with retired work and permits unsafe deletion.
- **Readmission preserves a disposition for old work.** A fresh replica must expose/recover unfinished work,
  or expire it under a durable authenticated policy. Silently abandoning the old replica loses intent.
- **Bounds require an admission policy.** The progress cases bound consecutive fence misses by
  `maxScopes - 1`, pending review duration, and retained rejoin history. With unbounded misses or unresolved
  reviews, finite storage cannot accept unlimited new durable work. Enforce backpressure before exhausting
  retained evidence; increasing `maxScopes` only postpones the failure.

Received outside rows have a different owner: their local copy is no longer needed after that peer installs
the signed successor. Waiting for the remote author's replacement ties local retention to an author that
may leave forever. Each store must discharge its own obligation rather than reuse another store's condition.

## Recovered checker results

The [evidence manifest](evidence/recovered-results.json) records original source hashes and individual
verdicts. Compressed raw logs accompany it. These are recovered Claude runs on the original Track J model
based on `0171994d`; they are not new runs on the later native implementation. The final model adds structural
lemma C9 to the *candidate induction hypothesis* and corrects the finite sequence-capacity guard described
below. Old `indContract` results cover C1–C8 and the old transition guard. They do not establish the final model.

| Check | Completed result | Scope |
|---|---|---|
| Decided rules + R7 + W1, with and without logical plan drop | Apalache base and inductive step pass | One writer; epochs 0–4, sequences 0–6, bounded moves/crashes |
| Decided-rule safety with delivery bounds disabled | Apalache base and inductive step pass | Same finite domain, partial receipt and mismatches |
| Contract safety, any-delay instance | TLC complete: 217,244 distinct states | One writer, epochs 0–4, sequences 0–6 |
| Contract with manual review/preserved old intent | TLC complete: 2,832,790 distinct states | Same finite domain |
| Contract with expiry policy | TLC complete: 224,181 distinct states | Same finite domain |
| Reduced contract | TLC complete: 6,764 distinct states | Epochs 0–3, sequences 0–4 |
| Contract progress under delivery assumptions | TLC complete: 198,931 distinct states | Epochs 0–4, sequences 0–6 |
| Larger contract safety | TLC complete: 2,483,501 distinct states | Epochs 0–5, sequences 0–8 |
| Larger contract progress | TLC complete: 2,166,963 distinct states | Same larger domain, fence pacing |
| Mutation controls | Every configured decided-rule and contract TLC mutation has its expected violation | Shortest counterexamples at each mutation's finite bounds |
| Deterministic tests and simulations | Original formal gate: 115 jobs pass | Sampling is not exhaustive proof |

A complete finite-state TLC graph covers arbitrary transition counts **within that finite domain**. An
inductive proof for a finite instantiation likewise does not prove arbitrary epoch, sequence, writer, or
resource bounds. TLC uses fingerprints; its logs include the collision estimates. No parameterized cutoff
or unbounded-epoch theorem is claimed here. The old report's suggestion that an Apalache step would extend
past an instance's bounds was incorrect.

Two-writer simulations and mutation checks pass, but the large two-writer exhaustive graphs did not finish.
The decided-rule graph had over 51 million distinct states and the contract graph over 75 million, each with
more than 20 million queued states, after 12–14 hours. They were stopped and recorded as incomplete. They are
not green proof results. A six-epoch one-writer exploration was also stopped before exhausting its queue.

## Final-source exhaustive results

After both review fixes, the final source passed 118 gate jobs: 3 typechecks, 60 deterministic-test jobs,
19 positive simulation jobs, and 36 expected-violation simulation jobs. These are distinct from the five
completed TLC checks below. None asserts temporal fairness or eventual delivery.

| Final TLC instance | Distinct states | Depth | Checked invariants |
|---|---:|---:|---|
| Reduced safety | 6,788 | 11 | `indContract` |
| Any-delay safety | 219,652 | 15 | `indContract` |
| Expiry safety | 226,661 | 15 | `indContract` |
| Manual-review safety | 4,162,986 | 18 | `indContract` |
| Bounded progress | 201,180 | 15 | `indContract`, `allInvariants`, `contractInvariants` |

Each queue exhausted. The manifest records every finite parameter, exact source SHA-256, and compressed raw
log. Reduced safety uses epochs 0–3 and sequences 0–4; the other four use epochs 0–4 and sequences 0–6,
all with one writer. “Bounded progress” checks resource/state invariants under fence pacing 2; it does not
prove that a delayed operation eventually runs.

## The incomplete induction attempt

The contract's `indContract` was initially a **candidate** inductive invariant. TLC established it on reachable
states at the completed bounds; Apalache did not establish closure from every state satisfying that predicate.
The reduced install-family run actually returned a counterexample after 20,692 seconds. Its initial state
contained an epoch-zero fence with an expiry plan entry. No reachable transition creates such a row: epoch
zero has no install fence, and fences never acquire settlement entries. The install displaced this impossible
fence, then a mismatched replacement escaped the non-fence census and violated the policy-derivation lemma.

C9 now states the missing structural fact: issued fences occupy exactly the first slot of an installed
epoch, and a row with a replacement/expiry/review entry is not a fence or cut member. The reduced instance
includes a deterministic regression that excludes the actual bad state and demonstrates why it broke the
old hypothesis, plus a reachable positive control. This strengthens the hypothesis; it does not weaken a
safety assertion or change product transitions.

**Full contract induction remains unproved.** The original base, move, and seal families completed; the
install family failed as described, and the other/rejoin families were interrupted after partial conjunct
checks. Partial conjunct results are not proofs. The strengthened hypothesis needs a complete base/step
check across all action families before any induction claim. Completed exhaustive checks remain useful
independent evidence, with their finite limits stated above.

## Independent review corrections

The Codex review found two coverage defects, both reproduced and corrected. The finite sequence guard
reserved replacement slots for expiry, manual review and fresh readmission even though those transitions
allocate only a fence. That excluded valid schedules near the instance's sequence bound. The guard and
transition now share the actual replacement-count function; deterministic regressions cover all three cases.
This widens the checked transition relation without weakening an invariant. The final exhaustive reruns are
recorded separately from the recovered results.

The simulator also reported a requested long-chain witness in zero traces while the runner returned success.
The runner now requires a positive count for every requested witness, as well as Quint's explicit successful
invariant verdict. The contract simulation uses 3,000 samples at the fixed seed to reach all requested cases;
its deterministic four-miss schedule remains an independent gate. Sampling and witness coverage do not
establish exhaustive correctness.

## Running and maintaining the evidence

`pnpm run track-j:formal` runs typechecks, deterministic tests, positive simulations, and expected-violation
simulations. `pnpm run track-j:verify -- proofs`, `-- exhaustive`, or `-- mutations` selects symbolic or
exhaustive checks. The runner is the source of truth for exact cases. Every successful simulation or
verification requires an explicit verdict; exit zero with no verdict is a failure. Negative controls require
an actual violation, not a timeout or compiler error. Logs are retained under `TRACK_J_LOGS` (a new temporary
directory by default). Requested witnesses must each occur in at least one trace.

The portable Node watchdog bounds each checker with `TRACK_J_TIMEOUT_SECONDS` (default one hour) and stops
its own process group, including descendant JVMs. Set a larger value deliberately for an exploratory check.
Formal jobs default to two; verifier jobs run serially. `TRACK_J_SLOW=1` includes all unfinished induction
families; `TRACK_J_LARGE=1` includes the unfinished large two-writer contract graph. Neither is represented as
a passing default result. The slow families and the large graph remain in the executable gate inventory.

Final validation results and hashes are recorded in [final-results.json](evidence/final-results.json).
Model changes require rerunning the affected properties and negative controls. Native implementation changes
need their own correspondence review and browser/persistence gates; model success cannot substitute for them.

The [native custody and repair adjuncts](NATIVE-CUSTODY.md) add whole-source recovery,
portable dependency closure, native send ownership and conditional repair liveness.
Their evidence also records the later final-source Apalache checks and larger A5
run, including the still-open contract induction counterexamples.

The [rejoin contract adjunct](REJOIN-CONTRACT.md) separately checks arbitrary-gap attachment, actual local recovery roles, durable unknown-source custody, and current pruning authority. Its signed-expiry law remains an explicit implementation requirement until a producer is mapped; it does not extend the older adjacent-install bridge or close full-contract induction.

The [pending-floor E2 adjunct](PENDING-FLOOR-EPHEMERAL.md) separately checks installed ephemeral authority under host callbacks, delayed old frames, registration replacement, and cold recovery. A stronger suspension policy is modeled as an optional contract, not a proven missing product gate.
