# Per-op creator maintenance admission: coalescing adjacent checks, concurrent source reads

Task: cut the creator's per-move maintenance admission latency (the gameplay path).
Constraints: leave epoch transitions alone, keep authentication and capacity accounting
intact, and keep every refusal reason and its precedence.

Patch: `prototype.patch` (a `git diff` against the sync baseline `6fa2bf3e`). It touches
one source file, `packages/node/src/internal/creator-closed-rollback-data.ts`, covering
the ordinary acquisition, `check`, `begin` and `reserveCreatorOrdinaryFinishingCapacity`.
It does not touch `creator-close.ts`, `v3-live.ts` or storage. Tests were added to
`packages/node/tests/creator-ordinary-numerical-delivery.test.ts`.

## 1. Where per-op time goes (baseline, creator spans, p50 ms)

Each op runs `prepareCreatorIncrementalIssuanceMaintenanceQuote`, then `beginWrite`.

| Step | p50 ms |
|---|---|
| acquire proof | 66 |
| reserve capacity | 23 |
| begin check | ~9 |

Breakdown of acquire proof:

| Sub-step | p50 ms |
|---|---|
| holds | 5.4 |
| bounded AHE read | 10.9 |
| snapshot / AHE / floor / journal images | 5.6 |
| inventory | 2.8 |
| native issuance + correspondence | 6.2 |
| journal correspondence | 3.1 |
| signing dependency borrow | 15.2 |
| final check C1 | 9.0 |

Breakdown of reserve capacity:

| Sub-step | p50 ms |
|---|---|
| pre-callback check C2 | 8.9 |
| derive + charge | 3.3 |
| post-charge check C3 | 10.0 |

Each op runs four full `check()` passes (C1–C4), about 36 ms together. One pass costs:

| Part | p50 ms |
|---|---|
| eligibility + all owned hold turns | 1.7 |
| AHE currency / facade head / snapshot readiness (concurrent) | 0.6 |
| snapshot admission image + recovery-role inventory | 5.2 |
| floor + journal probe + issuance probe | 1.3 |
| signing / runtime wrapper | ~0.5 |

The snapshot DB is not natively held; scope Web Locks are not inventory locks. Those
two snapshot reads are therefore 60% of every pass, and no hold or probe makes them
cheap.

## 2. The four passes, case by case

To skip or cheapen a pass, the facts it verifies must not have been able to change
since the previous complete pass. The relevant question is what lies between the end
of the previous pass and the start of this one.

| Pass | Preceded by | Could a verified fact change in between? | Decision |
|---|---|---|---|
| **C1** acquisition `await check()` | The acquisition's own source reads, then awaited `checkCurrentJournal`, anchor reads and signing borrow, all native I/O | Yes. Tasks run, and the snapshot DB is unheld. | **Full** (unchanged) |
| **C2** capacity pre-callback | Only our own synchronous code and microtask hops: the prepared-journal readiness cache, proof construction and custody registration, `readReceivedAppendSizing` (pure; its `facts.check()` is sync), and reserve's setup. No await of anything external, no store write, no callback. | Not by us. Only by the environment (another connection, an event, a timer), and no event can be delivered: see the claim in §3. | **Coalesced with C1** |
| **C3** capacity post-charge | The configured application hook `options.reader` (arbitrary synchronous app code) and our own book charges | Yes. The hook can release, abort, close, or schedule writes. | **Full** (unchanged) |
| **C4** `beginWrite` | Only our own synchronous code: stamp checks, the template `commit` (in-memory), the numerical handoff, `readIssuanceContext`, `captureCreatorOrdinaryAcceptedResourceUpdateForSizing`, and the consumer's return. `v3-live` then calls `beginWrite()` immediately, in both the local and the received path. `begin`'s own prefix follows. | Not by us. Environment only, with the same claim as C2. | **Coalesced with C3** when adjacent. Full otherwise. |

**Why not the "cheap currency re-read" of the held subset** (head, retirement-control
revision, journal frontier):
- The held subset is already cheap. The journal and issuance checks are probes, i.e. one
  native turn on the held transaction plus an identity comparison of the held-image
  basis. AHE currency is cached per held transaction.
- With the concurrent after-points (P1 below), floor, journal and issuance already run in
  the shadow of the 5.2 ms snapshot reads, so eliding them saves no wall time.
- The snapshot has no currency token. Its retirement-control revision does not move when
  scope or chunk rows are added or swept, so it cannot stand in for the image or the
  inventory.

The only sound way to drop the snapshot reads at C2 and C4 is therefore the adjacency
argument below, not a token.

## 3. The coalescing rule and its equivalence proof

### Mechanism

At the end of C1, and only for `preparedCapacityOnly` proofs, the proof stores a
**single-use, targeted claim** on its frame: `issueCreatorOrdinaryAdjacentCheck("pre-callback")`.
Capacity issues `"begin"` right before it delivers. `check(target)` works as follows:
- It consumes any claim. The claim yields `true` only if the claim is still pending and
  `target` matches.
- If it yields `true`, the check runs the **same** `runtime.checkWhile(…, signing)`
  wrapper. Inside it runs only the original synchronous prefix of `checkPointsBefore`:
  `checkAbort(signal)` and `requireLaw(!released && frame.alive && sourceIdentity === seed.identity, "chain-invalid")`.
- Otherwise the check is the full original.

The claim is pending only while its own microtask chain is (up to 256 hops):
- An HTML or Node event loop cannot start a task until the microtask queue is empty.
- So "still pending" proves that no task has run since the claim was issued. No IDB
  event, timer, message, WebCrypto result or `versionchange` was delivered.
- Any await on external work therefore kills the claim, and that boundary gets a full
  check. This covers a caller that holds the quote, and any `await` a future edit might
  insert between capacity and `beginWrite`.
- Any untargeted check also consumes the claim, as do a second use and a use at the other
  boundary.

### Equivalence (refinement)

Let P be the prototype and O the original. For a coalesced boundary B (C2 or C4) and its
predecessor A (C1 or C3):

1. **Wrapper refusals.** Runtime admit, lifetime revocation, prepared-graph change,
   signing-child revocation and the signing dependency's own checks are the identical code
   in the identical order. P and O refuse identically.
2. **Synchronous prefix.** Abort and released/frame/source run first in both, with the
   same reasons (`AbortError` / `chain-invalid`). Interleaved microtasks of other chains
   can only change in-memory state. If that state is one of these four facts, P catches
   it exactly where O does.
3. **Native facts.** These are hold liveness, AHE currency, facade head, snapshot
   readiness, snapshot image and inventory, floor, the journal and issuance probes, and
   the final abort. They change only through actions outside our chain: other
   connections or tabs, IDB backend commits, events, timers, other promise chains.
   - Between A's observations and B, our chain awaits none of those actions. It performs
     no write, callback or charge that could cause them or depend on them (table above,
     guarded at runtime by the claim).
   - So every P execution is an O execution in which those environment actions take
     effect after B's reads instead of before. No happens-before edge forces them
     earlier. In that O execution, B observes what A observed and passes, exactly as in
     P. All later behaviour is identical: same callbacks, same charges, same write.
   - Conversely, a change that O would report at B is reported by P at the next complete
     boundary. That is C3 after a coalesced C2, with the same check code and therefore
     the same reason and precedence. After a coalesced C4, the write's own native
     currency is the guard: the expected issuance image digest and control, plus the
     journal context. These are unchanged. O offers no more, because a change landing
     just after O's C4 reads is equally unseen.
4. **Side effects of a deferred refusal.** If a native change lands between C1 and C2,
   O refuses at C2 and keeps the application projection. P runs the hook and refuses at
   C3, clearing the projection. This is exactly O's behaviour when the same change lands
   a few ms later, which is a legal schedule. Only an internal cache differs, and the
   refusal reason is the same.
5. **Books and authority.** Nothing is charged, refunded or reused. Every stamp
   (`chargedBytes`, dimension stamp, proof/source identity) is still checked at its
   original point. The claim grants no capability; misuse only makes a check complete.

A coalesced pass therefore never accepts in a state where O must refuse. It only moves
the observation instant back to the end of the adjacent complete pass, a gap in which no
event can be delivered.

## 4. Acquisition source reads (P1, P2, P2b, P2c)

These start independent, nonmutating reads together and judge them in the original order.

**P2.** The bounded AHE read is followed by the AHE image. The journal, snapshot image,
floor and inventory reads start together with it. Every read is joined with
`allSettled` and then judged in the original order, so the first refusal and its reason
are the sequential ones. The reader enters custody at its original point.

**O(n) blob compare.** This keeps the same predicate ("each blob equals some prior in
canonical ref AND exact bytes"). Each ref is encoded once instead of once per pair; the
original was O(n²), about 1 ms per op.

**P2b.** `readNativeIssuance()` is started with the others and judged at its original
position.

**P2c.** The signing-dependency borrow (15 ms) is started with the others and judged at
its original position, so precedence is unchanged.
- **One deviation.** On a refusal path where O never borrows, P borrows and then releases
  at once. If that release is itself uncertain, the runtime's `release()` joins
  `childReleaseTasks` and throws an `AggregateError`, and the consumer marks
  `maintenanceReleaseFailure`. The deviation is fail-closed, not weaker.
- It can be dropped on its own (one hunk) if speculative borrowing is unwanted. It
  accounts for about 10 ms of the acquisition gain.

**P1.** Inside a check, after the held and eligibility batch has joined, the snapshot
image, inventory, floor, journal probe and issuance probe start together. They are judged
in the original order. The issuer full-image fallback still runs only when its probe is
stale, after earlier points have passed.

**Parked.**
- P3 (snapshot-store `scheduleRead`, letting image and inventory overlap): no measurable
  gain.
- Held-subset elision: no wall-time gain over P1 (§2).

## 5. Results

**Setup.** Interleaved ABBA: `pa-ab2-{base-1,proto-1,proto-2,base-2}`. The base build is
`pa-diag1` (6fa2bf3e plus instrumentation). The prototype build is `pa-adj1` (this patch
plus the same instrumentation). Each run is the healthy native Grid with 8 rollovers.
Values are pooled p50/p95 in ms. Load average was about 23 during the runs. The raw
output is in `ab2-compare.txt`.

| Per-op metric | n | Base p50 / p95 | Proto p50 / p95 | Δ p50 |
|---|---|---|---|---|
| **Creator issue** (ordinary-issue-and-publication) | 34 | 141.4 / 318.2 | **101.5** / 170.7 | −28% |
| Creator issue: maintenance admission | 34 | 72.9 / 188.6 | **47.9** / 72.7 | −34% |
| **Creator live admission + projection** (received op) | 136 | 91.5 / 216.6 | **70.9** / 149.2 | −23% |
| Creator live: maintenance admission | 102 | 71.6 / 96.9 | **47.9** / 91.5 | −33% |
| **Recipient issue** | 102 | 46.7 / 76.2 | 46.0 / 79.0 | ≈0 (no creator maintenance on this path) |
| Remote accept latency | 408 | 86.5 / 209.9 | 70.3 / 167.0 | −19% |

### Sub-phase breakdown (p50 ms)

| Sub-phase | Base | Proto |
|---|---|---|
| acquire proof | 54.6 | 39.4 |
| …source reads (serial sum vs joined) | ≈33.2 | 21.1 |
| …signing deps | 12.2 | 0.0 (joined above) |
| …native issuance correspondence | 5.35 | 0.2 |
| …acq check C1 (full) | 7.6 | 7.2 |
| reserve capacity | 19.1 | 11.2 |
| …C2 pre-callback | 7.6 | **0.3** (coalesced, 196/196) |
| …derive + charge | 3.1 | 3.0 |
| …C3 post-charge (full) | 8.0 | 7.15 |
| begin check C4 | ≈7.6 (full) | ≈0.3 (coalesced, 196/196) |
| full check passes per op | 832 / 212 = 3.9 | 440 / 212 = 2.1 |
| one full pass: before / after points | 2.0 / 1.1 + 4.3 snapshot | 2.1 / 4.6 (snapshot ∥ floor/journal/issuance) |

The base "serial sum" of source reads is bounded read + AHE image + journal + snapshot
image + floor + inventory + native issuance + signing. Both coalesced boundaries fired on
every op in the bench (196/196 each). No op fell back to a full check.

### Tests

The command was `test-run.sh`, i.e. `vitest run --exclude ".claude/**"` over
`packages/node/tests/creator-*.test.ts` and `closed-epoch-*.test.ts`.

| Run | Tests | Passed | Failed |
|---|---|---|---|
| Baseline (`tests-base1`, 6fa2bf3e) | 866 | 835 | 31 |
| Prototype (`tests-proto2`) | 869 (3 new) | 838 | 31 |

- The two failure sets are identical. `comm` of `tests-base1.fails` and
  `tests-proto2.fails` is empty both ways, so all 31 failures are pre-existing.
- The 3 new tests in `creator-ordinary-numerical-delivery.test.ts` pass. They cover:
  coalescing only at the claimed boundary and only once; full checks for another
  boundary, an untargeted check, or after a task; and coalesced refusals keeping the
  wrapper and sync-prefix reasons and order.

## 6. What remains (not in this patch)

**Snapshot currency token (storage-browser).**
- A durable per-object mutation stamp, bumped in every readwrite transaction that touches
  `scopes`, `chunks` or `retirementControls` for the object.
- Alternatively, a held snapshot `NativeReadReservation` (`readReservations` already
  exists, but it is single-holder).
- Either one would turn C1 and C3's 5.2 ms of snapshot reads into one `get`, and the
  acquisition's 5.4 ms likewise.
- It is a protocol and storage change. Today the design deliberately says "Scope Web
  Locks are NOT inventory locks".

**Pump CPU.** `NativeReadReservation.#pump` is 9% of creator-origin CPU. Each held view
re-issues `getKey("")` on every success, and about 5 views are held per op. Pacing the
sentinel would cut CPU contention for every client sharing the renderer: one sentinel per
turn only while work is queued, otherwise one outstanding request.

**Signing dependency borrow, 15 ms.** This is actor work to acquire recovery
dependencies per op. It is a candidate for the same per-epoch preparation as the
readiness source.

**Bounded AHE read, 10.9 ms per op.** It is a full AHE head/generations/blobs read each
op. A cross-op cache would need the AHE store to expose a mutation stamp; the same
storage change as above.
