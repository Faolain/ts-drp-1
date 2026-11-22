# Native custody and repair adjuncts

The [checked evidence](evidence/native-custody/results.json) extends the original
[Track J result](RESULT.md) with explicit native retirement recovery and room
repair models. These are abstractions of the new owners, not a machine-checked
refinement of their TypeScript implementations. The native transaction and crash
evidence remains in [Track X native retirement](../40-track-x-native-retirement/RESULT.md).

## What each model establishes

The [retirement adjunct](../../../../packages/protocol-v3/formal/native-retirement-custody.qnt)
represents a replacement chain, its live plan entries, a prepared native rewrite,
the atomic commit, and same-intent recovery. Dependency closure includes the
backward edge required when a retained portable row still consumes its source.
Logical retirement and physical pruning are separate commits, and the creator
recovery census classifies every source the store still holds by its completed
entry. So a completed entry outlives its source's retirement as custody, without
protecting the source or its replacement, and a later merge drops it once the
prefix pruner removes the source (`entryKept`). The `nativeRetirementCustodyToday`
instance is the broken control: dropping the entry when its source retires loses
the entry of a held row, and a later merge that rebuilds it is refused. A crash exposes the
prepared original image or the committed target image. Recovery selects the
original source only when both the native target and the whole authenticated
source match; later journal, snapshot or floor changes require a fresh selection
after global completion, and refusal while the old coordinator remains active.

Its epoch counter and row capacity are deliberately separate. The 300-epoch
schedule and Apalache base/inductive-step pair use three rows and two replacement
edges throughout. They do not establish arbitrary numbers of authors, replacement
edges, native bytes, or epochs. Signature verification, collision resistance,
canonical encoding, exact native transaction semantics and coordinator custody
are premises whose implementation is exercised by the native tests.

The [repair adjunct](../../../../packages/protocol-v3/formal/room-repair-custody.qnt)
separates native request settlement from answer arrival. Lost answers leave the
data unrepaired, while recurring roster sweeps can ask again. The bounded hint
map does not bound roster eligibility. Cancelled sends continue occupying their
native slots, and close cannot join before native settlement.

Its temporal property is conditional: the roster stays connected, the plane has
capacity, the sweep is fairly scheduled, native sends eventually settle, and
infinitely retried valid answers eventually arrive and are admitted. Under those
premises, every modeled peer is repaired. The model permits lost answers before
success. It promises neither bounded latency nor liveness under arbitrary delay.
The exhaustive instance uses three peers; the 65-peer/64-hint schedule is a
deterministic boundary regression. Priority turns, exact timers, replay payloads,
bytes, and the new replay performance owner are outside this abstraction.

Both adjuncts include expected counterexamples and reachability checks. Releasing
a send slot on cancellation, joining before native settlement, splitting the
retirement commit, or selecting recovery from the native image alone breaks the
corresponding safety property. Limiting repair to remembered hints breaks the
conditional temporal property.

## Relation to F1, F2 and recovery

The original settlement model already represents partial-cut membership custody,
durable terminal authority, consumer lifetime and atomic issuance retirement.
Those establish abstract relationships between F1/F2/H5; they do not verify the
new native signed-byte parsing or every journal deletion branch. The retirement
adjunct adds the concrete source-selection distinction exposed by native review.
The existing received-certificate retry model was also rerun against its unchanged
source; it exercises same-offer custody, replay-before-lookup, ambiguous refusal
and joined resumption as deterministic schedules, not a temporal proof of the
entire recovery implementation.

## Contract induction remains open

The final transition source passes the larger A5 exhaustive safety and bounded
progress instances, and the decided-rule Apalache base/step pair. The A5 progress
check exhausts 2,174,196 distinct states at depth 17; it checks the stated progress
invariants, not unbounded temporal liveness. The contract candidate hypothesis is
still not inductive. Its move counterexample permits epoch 1 to be installed with
no current fence. Its seal counterexample permits an epoch-0 row to carry an
expiry entry before any epoch has been sealed. Neither is a reachable trace from
the model's initializer in the completed finite checks.

The [separate fence proof](../../../../packages/protocol-v3/formal/settlement-replacement-retirement-fence-proof.qnt)
keeps the proposed repair honest: the current fence gets its own base and
preservation checks, assuming only that fact within the finite field domains,
before it is added to the move obligation. It does not silently strengthen the
original hypothesis or change its already checked transition source. The expiry
counterexample needs an independently preserved source-age fact: settlement
entries are created only after installing past their source epoch. That obligation,
the remaining contract action families, and a complete contract induction gate
remain open. Passing the fence checks alone must not be reported as full contract
induction.

The current-fence fact holds on the entire reduced reachable graph (6,788 states).
Its Apalache base case passes; the stronger arbitrary-state preservation attempt
timed out after 300 seconds and remains incomplete. The manifest records the
separate repaired-move check, which passes with this reachable fact added, rather
than treating it as a complete induction.

## How to extend the bounds

Epoch count, work per epoch, number of writers, and delayed dependency depth are
different growth axes. The larger A5 instance raises both epoch and sequence
bounds; its state count cannot be attributed to epoch count alone. The adjunct's
300-epoch schedule holds per-epoch data fixed. The application endurance campaign
is separate native evidence and must supply its own completed epoch counts.

A useful next capacity campaign holds epoch count fixed while increasing edits,
writers and delayed settlement chains, then holds those capacities fixed while
increasing epochs. Track native retained rows/bytes, plan/carrier sizes, pending
sends and operation latency along both axes. A plateau in a small model is not a
claim that every native capacity profile can run forever. In particular, portable
consumers can keep an entire source chain alive until the authenticated consumer
selection releases it.

## Reproduction and evidence

`pnpm track-j:custody` runs the deterministic, exhaustive and native-adjunct
induction checks. Its `test` and `verify` arguments select those portions;
`pnpm track-j:custody fence` checks the isolated fence obligation. Java 17 and the
pinned Quint/Apalache toolchain are required. `CUSTODY_LOGS` selects the evidence
directory, and `TRACK_J_TIMEOUT_SECONDS` bounds each process group. The runner
records the exact commands, source hashes and checker verdicts and fails on a
timeout, source drift or a missing expected verdict.

The evidence manifest is the canonical record of completed versus incomplete
checks. Raw logs include the failed induction candidates and the independent
review. The reviewer found one invalid temporal expression; replacing it with
explicit previous-floor state made monotonicity part of the checked safety
invariant. The repair model's request/answer distinction was independently checked.
