# D.110c-0c1f5b0y chat admission and bounded-state continuity audit

Audit anchor: signed/pushed `d836fc3da007c21984ee990ec7b9be1b9062e0d2`.
This is read-only planning evidence; it authorizes no production edit.

## Existing guarantees

- Protocol-v3 blueprint admission can cap an operation's complete canonical
  bytes through `maxCanonicalOperationBytes`.
- The v3 chat blueprint currently assigns the generic 65,536-byte operation
  ceiling to `message` and `applicationBatch`.
- Compaction validates canonical application state and reducer output with a
  separate 32,768-byte ceiling and fails closed as
  `INVALID_APPLICATION_STATE`.
- The f5b fixture correction keeps its accepted settlement workload within
  those unchanged bounds; its transient-payload case intentionally separates
  operation bytes from retained-state bytes.
- Phase 7 already owns authenticated archive segmentation, hot/cold paging,
  and the million-message cold-join proof.

## Missing production guarantee

- The chat `message` schema checks that `text` is a string but has no explicit
  encoded-byte budget for text or message metadata below the generic
  65,536-byte operation limit. `send()` checks only nonempty text.
- A single chat operation may therefore be operation-valid while the resulting
  append-only state exceeds the 32,768-byte compaction ceiling.
- Individually valid smaller messages from concurrent writers may cumulatively
  exceed that state ceiling. Sender-local preflight cannot be authoritative
  because peers can observe different concurrent prefixes.
- Recovery transformations are constrained by generic operation admission but
  have no explicit contract guaranteeing that their retained result remains
  foldable or that an unfit transformation produces a durable, user-visible,
  non-stranding outcome.
- Current plan text does not assign one owner for the rule that accepted work
  cannot strand close/recovery at `INVALID_APPLICATION_STATE`.

## Disposition

Add D.110c-0c1f5b0y as a separately reviewed high-risk design checkpoint. It
must select deterministic admission/overflow/recovery semantics before any
production edit. It does not block W1, the bounded f5b settlement RED/GREEN, or
the MMORPG-only 100-transition control. It blocks closure of D.110c-d's
Discord-shaped control, any production Discord-scale claim, Phase 7a execution,
and therefore the complete Discord golden path. If the selected design needs a
public API, wire/schema field, manifest-contract change, or new durable outcome
carrier, it stops for an explicit prerequisite; the required root analysis and
one Fable-high API consultation occur before that decision.
