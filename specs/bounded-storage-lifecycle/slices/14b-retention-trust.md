# 14b — Retention trust and the retirement decision (S2)

Status: contract draft, 2026-10-19, under the [slice 14 parent](14-single-database-watermark-retirement.md).
No review has run. RED precedes GREEN; no implementation acceptance is claimed.
Guarantee ids are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md). Line numbers are at commit 1c6a8259.
`CRD` = packages/node/src/internal/creator-closed-rollback-data.ts.

## One question

Is a retirement decision computed from facts verified on arrival and on every
open, and applied with exact-byte checks inside the one retirement transaction,
sound when every durable byte is untrusted, and does it never delete a row that
the existing planner would keep?

## Threat model, unchanged

Durable store bytes are untrusted carriers under a trusted pinned genesis, the
current room floor and a non-equivocating creator issuance signer
([G5](../golden-path-guarantees.md), PLAN:96278-96280, PLAN:10974-10981). Trust
state is "reverified on every open" (PLAN:6967-6968). A watermark or a physical
deletion alone is not authority ([G8](../golden-path-guarantees.md),
PLAN:96895-96899). Whole-origin rollback remains the host's custody question
([G6](../golden-path-guarantees.md), BSL:176-178).

## Where authority comes from

1. **Verify on arrival.** A closed epoch's facts become usable for retirement only
   after the existing arrival verifiers accepted them in this session:
   - the creator's own close (packages/node/src/creator-close.ts `close`, the
     signed Cut, QC, successor trust and recovery roles, and the
     closed-membership carrier it records at 4031-4061);
   - creator adoption (`verifyCreatorSuccessorAdoption`, packages/node/src/creator-adoption.ts);
   - recipient install (`receiveCreatorSuccessorAdoption`, creator-adoption.ts,
     including Track K's `recordReceivedClosedMembership`);
   - live admission of each vertex (its signature verdict in the session's
     `vertexFacts`, packages/node/src/v3-live.ts:20562-20563).
2. **Verify on every open.** Each session open starts with no carried facts. The
   first decision after an open runs the existing complete cold acquisition
   (`acquireClosedData`, CRD:7138, with the protected-union and role observation
   it uses today) over the bounded retained window. That is the open
   verification; it also checks the floor fences ([14c](14c-host-floor-retirement-fence.md)).
   "Reopen starts with independent verification, and native currency and current
   authorization remain fresh" (R2E:783-786).
3. **In session, the verified ledger.** Facts accepted by 1 or 2 are kept in one
   bounded in-memory ledger per room session. Its lifetime is the genuine live
   handoff, like `vertexFacts` (v3-live.ts:20562-20563, R2E:783-785): it is
   forked to a successor only on a genuine live handoff and is never rebuilt from
   durable bytes except by the open verification.

The ledger holds only immutable syntax and signed facts, which may outlive a
stage ([G10](../golden-path-guarantees.md), R2E:34-35):

- per closed epoch: the authenticated Cut summary, commit QC, successor trust,
  recovery roles and classified scopes, the received certificate digest and its
  transfer binding;
- per journal scope: the verified closed-membership set (member vertex digests
  and their dependency order) and the digests of verified local witnesses;
- per AHE generation: its verified identity (object, generation id,
  `baseExpectedHead`, closure digest) and whether its anchor chain authenticated
  it as historical;
- per snapshot scope: the manifest digest whose payload was validated;
- per issuance record: the digest of its verified, published preimage;
- per signing epoch: the verified QCs that rebuild its evidence frames.

The ledger never holds currency: head and row states, census, controls,
incarnations, floor state, publication state, pending ingress or unsettled
work, accounting or authorization. Those are read fresh, inside the transaction
that acts ([G11](../golden-path-guarantees.md), R2E:137-140), or held by the
existing runtime gate (pending ingress is in-memory runtime state behind the
lull's deferrable slot, [G23](../golden-path-guarantees.md), v3-live.ts:19518-19520).

Every ledger fact is keyed by the exact bytes it was verified from. A durable
row is used only if its exact bytes, read in the acting transaction, hash to the
ledger key. Two stored digests are never compared with each other as evidence
(PLAN:10974-10981).

## The decision

One decision per closed-epoch boundary, by the existing decision owner, the node
planner ([G7](../golden-path-guarantees.md), BSL:182-187). It is computed:

- on the creator, at the lull after adoption, or inline at seal when the
  existing triggers fire (creator-close.ts:3767-3828);
- on a recipient, at install or at its lull, whichever first finds work due
  (`receivedRecoveryTurnoverDue`, creator-adoption.ts:885-897).

Each owner's selection is that owner's existing rule, evaluated on ledger facts
and the fresh census:

| Owner    | Existing rule kept (source)                                                                                                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot | role turnover to the signed Cut's `recoveryRoles`; only `classifiedScopes` retire; survivor fact; live close hold covers dependency anchors; a displaced source's scope survives (CRD:20401-21019, CRD:20700-20800)                                                                                                                                   |
| Journal  | `closedJournalProtectedReplayScopes` (CRD:9521) are kept; collectible prefixes by membership or local issuance coverage (`prepareClosedJournalDetails`, CRD:9621; `prepareClosedJournalMembershipPrefix`, CRD:9359); empty headers outside `protectedHeaderScopes` (CRD:9222-9247); Track K's received-certificate replay narrowing (CRD:21290-21308) |
| Signing  | evidence only when rebuildable byte for byte (CRD:10110-10179), all or nothing per epoch; summaries only for epochs whose evidence retirement completed earlier; dispatch debt and replay-protected epochs excluded                                                                                                                                   |
| AHE      | head plus two `baseExpectedHead` rollbacks and source generations kept; only authenticated historical generations retire, Q before P; lineage-floor rewrite (packages/storage/src/maintenance.ts:576-828)                                                                                                                                             |
| Issuance | `closedIssuanceProtectedRecordsForRetirement` (CRD:19043-19089): epoch at most `throughEpoch - 2`, one covered classification, one published outbox pair, scope not replay-protected, no journal row for the scope                                                                                                                                    |

Cross-owner gates keep their present meaning: a pending floor, unsettled work,
pending ingress or unclassified replay makes the affected classes retain
everything (CRD:21427-21431, CRD:21275-21308). The real ordering dependencies
are kept, evaluated on the pre-state of the transaction:

- signing evidence before its summaries (summary rebuild needs signer state);
- signing work for an epoch before the AHE generation whose closure rebuilds it;
- Q before P among AHE generations;
- journal rows before their header, never in one decision (LJ:393-397 in
  packages/live-journal/src/retirement.ts);
- issuance after the AHE section, with no generation drain pending.

What the decision drops are scheduling policies, not rules: one class per pass,
one AHE generation per pass, 16-row batches, and suppressing journal prefixes
while a summary or generation is retired (CRD:19202-19207). They existed because
each pass had one decision policy and one two-phase commit
(docs/realtime-latency/tracks/18-track-r-redesign-guarantees/STEPS.md, step 3).
Track K's extra fresh pass after a generation drain (CRD:20153-20160) is not
needed: prefixes are no longer suppressed. Its effect, scope k-3 becoming
collectible at floor k, must still hold (acceptance 6).

The decision then becomes:

- step A: the per-owner floor fences ([14c](14c-host-floor-retirement-fence.md));
- step B: `applyRoomRetirement` ([14a](14a-retention-database-format.md)), with
  each row to delete named by its exact key and the digest of its exact bytes.

## Inside the transaction

Step B reads every byte the decision relies on and compares it exactly:

- each owner control equals the decision's `base`;
- each deleted row's exact bytes equal what the decision names, and the facts
  that make it retirable are in the ledger under those exact bytes;
- each survivor the decision relies on (protected snapshot scopes, the AHE head
  and its two rollbacks, journal protected headers) is present with exactly the
  bytes the ledger verified;
- the census of each retired range has no row the decision did not name.

A mismatch refuses `RETENTION_STALE` with zero writes. The planner then drops
the ledger facts that the mismatch touched and retains; the next decision
starts with the open verification for that object. Nothing is repaired.

## Allowed intermediate

An implementation may run the complete cold acquisition before every decision
instead of using the ledger (stage 1). That verifies more often than required
and is always allowed; it costs one acquisition per epoch instead of none. The
ledger (stage 2) is the end state. Both apply the same step B.

## What this slice does not change

- The arrival verifiers, the planner's protected-set rules, owner classifiers,
  signatures, digests and protocol formats.
- Readiness capture (`captureCreatorOrdinarySourceWithoutForecast`,
  creator-close.ts:2452-2496) and adoption are outside retirement.
- Track K's semantics: received-certificate replay narrowing, the recipient's own
  closed-membership carrier, numeric protected-hole order
  (packages/storage/src/snapshot-transfer.ts:1397-1439).
- Reopen admission after a retirement (Track K's open bug 1) is owned by Track L
  on the current path. This slice must not create a durable state that blocks
  admission after reopen: no control is left active, no drain is left pending,
  and no new resume request is introduced.

## Guarantee map

| Guarantee                                                                                                     | How this slice keeps it                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [G3](../golden-path-guarantees.md)                                                                            | Owner rules and arrival verifiers unchanged; Grid golden path in 14f                                              |
| [G5](../golden-path-guarantees.md)                                                                            | Bytes are verified on arrival and on every open; in session they are only compared exactly against verified facts |
| [G7](../golden-path-guarantees.md)                                                                            | One decision owner; no sweeper; no decision from age, counts, labels or marks                                     |
| [G8](../golden-path-guarantees.md)                                                                            | Marks and fences only fence, index and resume                                                                     |
| [G10](../golden-path-guarantees.md)                                                                           | The ledger holds immutable syntax and signed facts only, for one live lifetime; reopen is cold                    |
| [G11](../golden-path-guarantees.md)                                                                           | Currency is read inside step B                                                                                    |
| [G18](../golden-path-guarantees.md), [G19](../golden-path-guarantees.md), [G20](../golden-path-guarantees.md) | Protected set and owner rules unchanged; survivors checked exactly in step B                                      |
| [G22](../golden-path-guarantees.md)                                                                           | Each open verification and each step B pays its own charges ([14e](14e-retention-bounds-and-charges.md))          |
| [G23](../golden-path-guarantees.md)                                                                           | The decision runs inside the existing deferrable slot; ingress queues FIFO                                        |
| [G26](../golden-path-guarantees.md)                                                                           | No verification is skipped: work moves to arrival and open, and every acting byte is compared exactly             |
| [G27](../golden-path-guarantees.md)                                                                           | No game-specific rule                                                                                             |

## Runnable RED and acceptance

RED, in new test files only:

1. Poisoned bytes: a deleted row, a survivor row, a control or a carrier whose
   bytes differ from the ledger's refuses `RETENTION_STALE` with zero writes;
   a tampered mark that claims more retirement than the floor fails closed at open.
2. Foreign writer: another connection appends to a retired range, adopts, or
   rolls back between the decision and step B; step B refuses or, if serialised
   first, sees the change and refuses.
3. Stale writer: after step B, every owner's ordinary writer for the retired
   range refuses with its existing code.
4. Reopen: after a close and reopen, the first decision runs the open
   verification (observable: no ledger fact predates the open), and a poisoned
   retained row found there fails closed.
5. Differential safety: on a long room (creator and recipient, at least 16
   epochs), at every epoch the rows the new decision deletes are a subset of the
   rows the existing planner deletes for the same pre-state within the same lull.
6. Long-room bounds: the browser room on the new path reaches the steady state
   of `tests/recipient-long-room-journal-retention-native.test.ts` (journal
   throughEpoch k-2, at most two protected scopes, constant headers and rows from
   epoch 8), plus constant AHE generations, snapshot scopes and signing rows.
   That SQLite test itself stays green unchanged.
7. Grid acceptance (14f case 10 and the parent's acceptance): every recipient
   lull, including the last, then persisted close, reopen and continued gameplay.

## Feedback and stop conditions

If a rule above needs a currency fact that step B cannot read in its own
transaction, or a fact the ledger would have to rebuild from durable bytes
without the open verification, stop and record it; the decision for that class
then stays on the cold acquisition (stage 1).
