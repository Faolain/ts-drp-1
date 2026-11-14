# Given-back author order: `reissueOrigins` (design, for approval)

Status: proposal. No code until the coordinator approves it. The slow-member agent, which owns
hand-back records, reviews it.

The coordinator approved the direction: a separate settlement-plan field, which the slow-member agent
recommended over keeping consumed records alive.

## Problem

The settlement window gives a move back (`settlementStatus().undelivered`), and the application offers
it again as a new move: `issue(op, { handBack })`. The new row takes the next author sequence, so the
move lands after every move the author made since.

- **Overwrite apps (Grid).** An older placement of a block replaces the newer one in every replica.
  - Seen in browser FPS run tol1 (m-10).
  - The immediate fix is `fix/given-back-author-order`, using the identity-aware re-offer and
    `V3RoomKeptMoveSuperseded`.
  - That fix works only from the policy's in-memory history, so it is lost on a page reload.
- **Append apps (Chat).** A given-back message is admitted after the author's newer messages.
  - The projection folds admitted rows in order.
  - The view shows the window in that order.
  - So the message appears below newer ones while showing its older `displayTimeMs`.
- **Given-backs among themselves.** Records are ordered by `(sourceSequence, intent)`.
  - `sourceSequence` is the move's LAST carrier row (a replacement or a reissue), not where the author
    asked for the move.
  - A move replaced or handed back more often therefore sorts after newer moves.
- **RED.** `tests/app-rollover-given-back-origin-order.test.ts` has two cases: Chat order, and Grid
  across a reload.

## Definitions

- **Origin sequence** of a move: the author sequence of the move's first row, the row the author
  signed when it asked for the move. Replacements and reissues keep the move's origin.
- **Author order**: the order of origin sequences among one author's moves.

## Encoding (issuance-store, closed records)

1. **`SettlementHandBack.originSequence?: number`**
   - Invariant: `originSequence < sourceSequence`.
   - Written only when it differs from `sourceSequence`. Absent means the origin equals the source,
     which is today's record exactly.
   - Records are ordered by `(originSequence ?? sourceSequence, intent)`. This replaces the
     `(sourceSequence, intent)` order in `copySettlementHandBacks` and `settlementHandBacksWith`.
   - The record key a reissue passes back stays `{sourceSequence, intent}`.
2. **`SettlementPlan.reissueOrigins?: readonly { reissueSequence: number; originSequence: number }[]`**
   - Each entry maps a reissued row back to its move's origin.
   - Validated as a closed record and sorted by `reissueSequence`, with no duplicates.
   - Invariant: `originSequence < reissueSequence`.
   - Length is at most `SETTLEMENT_HAND_BACK_LIMITS.maxRecords` (64).
   - Absent when empty.

**Lifetime of a `reissueOrigins` entry**

- **Added** in the reissue row's own issuance transaction, the same transaction as the `hand-back`
  plan effect that sets `reissueSequence`, so it is atomic with consumption.
  - The effect carries `originSequence`.
  - It is applied in `storage-browser`, `storage-node` and the conformance store.
- **Dropped** only by the plan write that observes the move settled, in either of two ways:
  - **Admitted.** The chain's last carrier (the reissued row, or the newest replacement of it) is
    admitted. "Admitted" is decided only from the signed frontier in the installed settlement
    capability (frontier ≥ that carrier's sequence), never from local acceptance or relay evidence.
  - **Expired.** A window expiry of the chain's last carrier writes the new hand-back record with
    `originSequence` taken from the entry, and drops the entry in the same write.
- **Never dropped by replacement.** When the reissued row is displaced and replaced (a "rebase" entry
  with `replacementSequence`), the entry stays. A later expiry of the replacement walks the links back
  to the reissued row and needs the entry there.
- A plan write never drops an entry otherwise. This is the same contract as for unconsumed records.

**Bounds.** These are two separate bounds, and the sizing reserve charges both.

- **Record bound (`SETTLEMENT_HAND_BACK_LIMITS.maxRecords`, 64) counts unconsumed records only.**
  - Entries never take a record slot in `settlementHandBacksWith`. Today a consumed record is dropped
    at the next write and holds no slot either.
  - An entry can live for several epochs while a member is behind. If entries took record slots, a
    behind member would get fewer hand-back slots, more moves would hit `windowDeferredMoves`, stay
    live and be replaced again. That per-row replacement cost is the catch-up livelock.
- **Entry bound (64, the backlog term).**
  - `settlementBacklogOf` counts each entry's move as pending until the chain's last carrier is
    admitted. This replaces today's consumed-record term, which ended at the next merge.
  - A reissue moves one unit from the record term to the entry term, so the total does not grow.
  - `V3RoomLocalBacklogFull` (64) refuses new moves past the total, so entries ≤ 64. The codec enforces
    `reissueOrigins.length ≤ 64` as well.

**Origin at expiry.** `settlementWindowExpired` already walks the replacement links from the displaced
row back to the move's first row to find its origin epoch.

- The walk now also stops at a `reissueOrigins` entry: origin = `entry.originSequence`.
- Otherwise the origin is the first row's sequence.
- Window semantics are unchanged: a reissue still gets a fresh window. Only order and identity use the
  origin.

## Sizing (G22: sized ≥ written; `CLOSED_RETIREMENT_BYTES` stays 786,432)

The plan is part of the census image. Ordinary admission and maintenance share one forecast
(`issuance-image-capacity.qnt`, cap 786,432 = `CLOSED_RETIREMENT_BYTES.maxBytes`). The charge goes in
the one owner, `issuanceSourceCustodyPlanResourceForSizing` in packages/issuance-store/src/retirement.ts.

- **Hand-back records.** Add `originSequence: integer` to `handBackFields`.
  - Every existing and reserved free record is charged as if it carries the field.
  - That is +25 bytes per record (measured `encodeCanonical`; integer width 9), at most 1,600 bytes for
    64 records.
- **`reissueOrigins`.**
  - Existing entries are charged exactly.
  - Every record that could still be consumed reserves one entry: `min(64 - entries, unconsumed + free
    record slots)`. This charges the entry bound (64, backlog term) separately from the record bound
    (64 unconsumed records), so the reserve covers up to 64 records plus 64 entries.
  - An entry is at most 53 bytes; 64 entries in the field add 3,410 bytes (measured).
  - The entry is written in the reissue row's own issuance transaction, not only at maintenance plan
    writes. So the admission forecast of that row charges the plan effect plus the entry, through the
    same reserve: the reissue admission's F already includes the reserved entry, so the write never
    exceeds what admission sized.
- **Worst case added:** about 5.0 KB. The cap does not change.
- **Pinned by** extending `tests/source-custody-sizing-dispositions.test.ts`. For each written shape
  (record with origin, plan with 64 entries, consumption at the bound), sized ≥ written.
- **Model.** `issuance-image-capacity.qnt` HB gains the origin reserve. The new mutant
  `noOriginReserve` must violate `imageWithinForecast`.

## Migration and reads of old stores

- **Old plans** have no `reissueOrigins` and no `originSequence`. They read as empty, with origin equal
  to source, which is today's behaviour. No rewrite at open.
- **Writers** write the new fields only when non-empty or different. A store that never reissues a
  hand-back stays byte-identical, so older code can still read it.
- **Downgrade.** Once a field is written, older readers refuse the plan at open (closed record), before
  any write. This is the same rule as `memberFrontier` and `completedSourceCustody`. Their doc comments
  get the same sentence.
- **Records written before the upgrade** keep `origin := sourceSequence`. Their order among themselves
  is today's order. This is best effort for at most one window of moves after an upgrade.

## How it is used

**1. The author's own room (packages/node v3-room)**

- `settlementStatus().undelivered[i]` gains `originSequence`, and the listing is sorted by it. This
  fixes the order among given-backs.
- For apps with a displacement identity (`displacedOperationIdentity` on "rebase" actions), an entry
  gains `supersededBy?: { authorSequence }`.
  - It is set when an own issued row with a later ORIGIN and the same identity exists. "Later" compares
    origins, not sequences: another given-back's reissue has a high sequence but an older origin, so a
    row's origin is read through `reissueOrigins` (and the replacement links).
  - It is computed at plan-write time (the merge that lists records, and the reissue transaction that
    adds an entry), and kept with the in-memory listing, memoized by plan revision and lineage head.
    `settlementStatus()` is polled every second by the policy, so the listing never reads issued rows
    per poll: in the browser those reads are the IDB transactions this campaign is removing.
- This is durable, since it is recomputed from the plan and issued rows at open, so it survives a
  reload.

**2. The policy (examples/v3-room rollover.ts; interaction with the supersession fix)**

- A given-back entry with `supersededBy` is superseded. The decision no longer needs in-memory
  history.
  - The policy still offers the entry with its record, since only its row may consume the record.
  - It then offers the newest move again, as `V3RoomKeptMoveSuperseded` does today.
- The in-memory `latest` map stays for kept moves that were never accepted, because they have no
  record. Its order is consistent with origin sequences, since request order matches author order
  within a session.
- `identity` remains the opt-in hook. The room's `supersededBy` is the durable source and the
  in-memory check is the fallback.

**3. Other replicas**

- `reissueOrigins` is local to the author's plan and never leaves it. Replicas need nothing new for
  author order per identity: the author never lands an older move of an identity after a newer one
  (2), so every replica's last-writer-wins converges on the author's newest move.

**4. Chat display order**

- Replicas see only admitted order, so a reissued message cannot be put back at its old position by
  the room. Three options; C1 is recommended:
  - **C1 (recommended):** the Chat view orders each author's messages by the signed `displayTimeMs`
    they already carry, and interleaves authors by admitted order. Application only; no protocol or
    store change.
  - **C2:** carry the origin on the signed row. This changes the row format and verification; not
    proposed.
  - **C3:** accept the reorder and report it.
- C1 needs the Chat owner's agreement. `reissueOrigins` does not by itself change Chat's display. It
  gives Chat's local pending view the right order (the listing is sorted by origin).

## Model note (settlement qnt)

- **`settlement-window.qnt`**
  - Add the move's origin to the hand-back state and the reissue.
  - Add the invariant over what the store can guarantee, `listingInAuthorOrder`:
    - the listing is sorted by origin;
    - an entry has `supersededBy` exactly when an own row of the same identity with a greater origin is
      issued.
  - Model the policy step too (offer the superseded given-back with its record, then the newest move
    again), and check `authorOrderPerIdentity` over it: among one author's admitted rows of one
    identity, the last admitted row carries the greatest origin.
  - Mutant `carrierOrder` (records ordered by carrier, no `supersededBy`) must violate both.
  - Witnesses that must be reachable:
    - `handedBackTwiceKeepsOrigin`;
    - `reissuedReplacedExpiredKeepsOrigin`: reissued, displaced, replaced, then expired, with the origin
      still kept. This exercises the "never dropped by replacement" rule.
  - Admission in the model is decided by the signed frontier only.
- **`issuance-image-capacity.qnt`**: the origin reserve above.
- Run with `quint verify` (Apalache via openjdk@17), as for the existing settlement models.

## Tests to add with the implementation

- Store conformance: order by origin; entries added atomically with consumption; bound 64; old-plan
  reads; refusal by older readers.
- Store test at the record bound: 64 unconsumed records plus entries present, and a new expiry finds no
  free slot. The move is deferred (`windowDeferredMoves`) and no entry is dropped. (Requested by the
  slow-member review.)
- Native: `tests/app-rollover-handback-crash-native.test.ts` gets edges for re-hand-back of a reissued
  move (origin kept across the crash).
- Make the RED green: `tests/app-rollover-given-back-origin-order.test.ts`. The Grid reload case needs
  `supersededBy`; the Chat case also needs C1.

## Implementation notes (where the code differs from the text above)

Branch `feat/given-back-reissue-origins`.

- **Entry drop: admitted, not just within the frontier.** `terminalThrough` can pass a displaced own
  row (a later own fence admitted), and such a row is still given back later, by its window expiry or
  its frontier resolution, which needs the entry for the origin. So `settlementReissueOriginsUnsettled`
  keeps an entry while its chain's last carrier is displaced in the write, or has an own plan entry
  other than `committed`, even at or below the frontier. Found by `settlement-window.qnt`
  `settlementAuthorOrder`: variant `terminalDrop` (the first rule) violates `listingInAuthorOrder`.
- **Origin reserve counts consumed records.** A consumed record stays in the plan until a window write
  drops it, and that frees its slot for a new record that may be reissued in turn. The reserve is
  therefore `min(64 - entries, records + free record slots)`, counting every record, not only
  unconsumed ones. Otherwise that maintenance write raises the forecast: in
  `issuance-image-capacity.qnt`, mutant `originReserveIgnoresConsumed` violates
  `forecastOnlyGrowsByAdmission`. The worst case is unchanged.
- **`noOriginReserve`.** That model checks `imageWithinForecast` against the sound formula, so no
  forecast-formula mutant can violate it as written; `noHandBackReserve` and
  `replacedReceiptUncharged` fail `maintenanceAdmits` in the same way. The model therefore has
  `imageWithinForecastOf(m)`, and the deterministic run `noOriginReserveViolatesTest` shows that the
  forecast without the origin entries does not bound the image. Under its own step the mutant also
  violates `allProperties` (`maintenanceAdmits`).
- **`supersededBy` carries `operation`** as well as `authorSequence`. After a reload the policy has no
  history, and it needs the newer move itself to offer it again.
- **Policy precedence.** The session's in-memory `latest` is read first and the room's `supersededBy`
  second. Every move accepted in this session is newer than any row issued before it, so `latest` is
  at least as new as the room's answer, and it is current between a new move and the next listing
  refresh.
- **Backlog term: counted until a chain row counts itself.** `settlementBacklogMoves`
  (issuance-store) counts an entry's move pending on its chain's last carrier, unless a row of the chain
  is already counted by its own plan entry (rebase, transform, manual-review) or hand-back record. The
  first version skipped the entry whenever the last carrier was displaced. Before the rebase scan gave
  that row an entry, the move then counted zero times and `V3RoomLocalBacklogFull` admitted moves past
  the record bound: slow-member native test 2 lost moves (it passes at base). A displaced last carrier
  with no entry stays counted, because no creator row reaches it.
- **Chat C1** applies to the window and shares formats, which keep admitted order. The lifetime format
  sorts messages by identity, so it keeps its existing order.
