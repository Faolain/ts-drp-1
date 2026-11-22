# Per-move publication path (read-only analysis, 4c4f192c)

V3RoomSession.issue -> issueOwned (v3-room.ts:4262)
  1. activeHandle.issueLocal(...)  admission + sign + durable append + projection
     (projection row is visible before step 2: acceptedOperationRows.get(digest))
  2. publishAccepted() (v3-room.ts:4216) loops activeHandle.publishPending() until "empty":
     each call = one registration-queue task (enqueuePendingPublication, v3-live.ts:16264)
     call 1: readOutboxPage(limit 1) -> authenticatedOutboxRow (readIssued + classifyPlaneVertex:
             decode, signature (memoized), ACL/operation checks) -> publishMessage ->
             compareAndMarkOutboxPublished (IDB readwrite)
     call 2: readOutboxPage after cursor -> null -> "empty"
  3. request.resolve() only after publication.

Measured: recipient move ~43 ms p50, of which accepted-publication ~17-19 ms.
Creator accepted-publication windows (17): 165 ms CPU-window total, idle 50, program 22,
IDB keep-alive pump 9.4, admitBrowserRetirementControl 9, digestClosure 7, authenticate 6.5.

Levers (not implemented; overlap tracks A/C files):
- Resolve issue() at durable local acceptance and expose publication as a separate
  promise/event (opt-in) -> removes ~18 ms from the caller-visible move latency. The game
  already sees the move in projection before publication starts.
- Fold the trailing "empty" probe into the publishing task (return published + more:false)
  -> saves one queue task + one IDB read per move.
- Hand the just-issued row (bytes already authenticated by issueLocal) to publication as a
  completion row instead of re-reading + re-classifying it from the store.
