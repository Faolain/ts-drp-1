module verifiedImageCache {
  // Verify-once caching of native retirement controls, admitted images and
  // blob digests (packages/storage/src/internal/exact-bytes-memo.ts and its
  // users). Durable rows hold byte strings, abstracted as small integers. The
  // verification of a byte string (decode + canonical re-encode, a content
  // digest, an image digest) is a PURE function of those bytes: `verify`.
  //
  // Two connections share one committed database. Each may hold an open
  // transaction overlay. Writes, commit, rollback, reopen, another
  // connection's commit, poison and session revocation are all modelled.
  //
  // Four caches observe every read side by side:
  //  - exact:    keyed by the exact bytes (THE implementation; process-global)
  //  - revFixed: keyed by (row, data_version, total_changes, rollback epoch)
  //              per connection; sound only because rollback bumps the epoch
  //  - revNaive: keyed by (row, data_version, total_changes) per connection,
  //              i.e. no rollback invalidation  -> BROKEN (stale after rollback)
  //  - byRow:    keyed by row identity alone (e.g. blob digest / object id,
  //              never re-checking bytes)       -> BROKEN (stale after a write)
  // The invariant for each cache: every hit equals verify(current bytes).
  pure val CONNS = Set(0, 1)
  pure val ROWS = Set("control", "image", "blob")
  pure val BYTES = Set(1, 2, 3)
  // A byte string that fails verification (noncanonical / corrupt): 3.
  pure def valid(b: int): bool = b != 3
  // Any pure function of the bytes stands for the verification result.
  pure def verify(b: int): int = if (valid(b)) 10 * b + 7 else -1

  type RevKey = { row: str, dv: int, tc: int, epoch: int }
  type Read = { live: bool, conn: int, row: str, bytes: int, refused: bool,
    exactHit: bool, exactResult: int, revFixedHit: bool, revFixedResult: int,
    revNaiveHit: bool, revNaiveResult: int, byRowHit: bool, byRowResult: int }

  var committed: str -> int
  var txOpen: int -> bool
  var txWrites: int -> (str -> int)
  // data_version as observed per connection: bumped by OTHER connections' commits.
  var dataVersion: int -> int
  // total_changes per connection: bumped by own writes, never by rollback.
  var totalChanges: int -> int
  // rollback epoch per connection (the fix for revision keys).
  var rollbackEpoch: int -> int
  var poisoned: int -> bool
  var revoked: int -> bool
  var exact: int -> int
  var revFixed: int -> (RevKey -> int)
  var revNaive: int -> (RevKey -> int)
  var byRow: str -> int
  var last: Read

  pure val noRead: Read = { live: false, conn: 0, row: "control", bytes: 1, refused: false,
    exactHit: false, exactResult: 0, revFixedHit: false, revFixedResult: 0,
    revNaiveHit: false, revNaiveResult: 0, byRowHit: false, byRowResult: 0 }

  def visible(c: int, r: str): int =
    if (txOpen.get(c) and txWrites.get(c).keys().contains(r)) txWrites.get(c).get(r) else committed.get(r)

  action init = all {
    committed' = ROWS.mapBy(_ => 1),
    txOpen' = CONNS.mapBy(_ => false),
    txWrites' = CONNS.mapBy(_ => Map()),
    dataVersion' = CONNS.mapBy(_ => 0),
    totalChanges' = CONNS.mapBy(_ => 0),
    rollbackEpoch' = CONNS.mapBy(_ => 0),
    poisoned' = CONNS.mapBy(_ => false),
    revoked' = CONNS.mapBy(_ => false),
    exact' = Map(),
    revFixed' = CONNS.mapBy(_ => Map()),
    revNaive' = CONNS.mapBy(_ => Map()),
    byRow' = Map(),
    last' = noRead,
  }

  action unchangedCaches = all {
    exact' = exact, revFixed' = revFixed, revNaive' = revNaive, byRow' = byRow,
  }

  // Own write inside a transaction (BEGIN on first write).
  action write(c: int, r: str, b: int): bool = all {
    not(poisoned.get(c)), not(revoked.get(c)),
    txOpen' = txOpen.set(c, true),
    txWrites' = txWrites.set(c, txWrites.get(c).put(r, b)),
    totalChanges' = totalChanges.set(c, totalChanges.get(c) + 1),
    committed' = committed, dataVersion' = dataVersion, rollbackEpoch' = rollbackEpoch,
    poisoned' = poisoned, revoked' = revoked, last' = noRead,
    unchangedCaches,
  }

  // COMMIT publishes the overlay; every OTHER connection's data_version moves.
  action commit(c: int): bool = all {
    txOpen.get(c),
    committed' = txWrites.get(c).keys().fold(committed, (m, r) => m.put(r, txWrites.get(c).get(r))),
    txOpen' = txOpen.set(c, false),
    txWrites' = txWrites.set(c, Map()),
    dataVersion' = CONNS.mapBy(o => if (o == c) dataVersion.get(o) else dataVersion.get(o) + 1),
    totalChanges' = totalChanges, rollbackEpoch' = rollbackEpoch,
    poisoned' = poisoned, revoked' = revoked, last' = noRead,
    unchangedCaches,
  }

  // ROLLBACK discards the overlay; total_changes does NOT go back.
  action rollback(c: int): bool = all {
    txOpen.get(c),
    txOpen' = txOpen.set(c, false),
    txWrites' = txWrites.set(c, Map()),
    rollbackEpoch' = rollbackEpoch.set(c, rollbackEpoch.get(c) + 1),
    committed' = committed, dataVersion' = dataVersion, totalChanges' = totalChanges,
    poisoned' = poisoned, revoked' = revoked, last' = noRead,
    unchangedCaches,
  }

  // Close and reopen: a new connection, new per-connection caches, healthy owner.
  // The exact cache is process-global and deliberately survives reopen.
  action reopen(c: int): bool = all {
    txOpen' = txOpen.set(c, false),
    txWrites' = txWrites.set(c, Map()),
    dataVersion' = dataVersion.set(c, 0),
    totalChanges' = totalChanges.set(c, 0),
    rollbackEpoch' = rollbackEpoch.set(c, 0),
    poisoned' = poisoned.set(c, false),
    revoked' = revoked.set(c, false),
    revFixed' = revFixed.set(c, Map()),
    revNaive' = revNaive.set(c, Map()),
    committed' = committed, exact' = exact, byRow' = byRow, last' = noRead,
  }

  action revoke(c: int): bool = all {
    revoked' = revoked.set(c, true),
    committed' = committed, txOpen' = txOpen, txWrites' = txWrites, dataVersion' = dataVersion,
    totalChanges' = totalChanges, rollbackEpoch' = rollbackEpoch, poisoned' = poisoned,
    last' = noRead, unchangedCaches,
  }

  // A read: state checks first (never cached), then each cache is consulted
  // for the bytes currently visible to this connection. Only successful
  // verifications are retained; a failed verification poisons the owner.
  action read(c: int, r: str): bool = {
    val b = visible(c, r)
    val k = { row: r, dv: dataVersion.get(c), tc: totalChanges.get(c), epoch: rollbackEpoch.get(c) }
    val kn = { row: r, dv: dataVersion.get(c), tc: totalChanges.get(c), epoch: 0 }
    val refused = poisoned.get(c) or revoked.get(c)
    val v = verify(b)
    val exactHit = not(refused) and exact.keys().contains(b)
    val revFixedHit = not(refused) and revFixed.get(c).keys().contains(k)
    val revNaiveHit = not(refused) and revNaive.get(c).keys().contains(kn)
    val byRowHit = not(refused) and byRow.keys().contains(r)
    val keep = not(refused) and valid(b)
    all {
      last' = { live: true, conn: c, row: r, bytes: b, refused: refused,
        exactHit: exactHit, exactResult: if (exactHit) exact.get(b) else v,
        revFixedHit: revFixedHit, revFixedResult: if (revFixedHit) revFixed.get(c).get(k) else v,
        revNaiveHit: revNaiveHit, revNaiveResult: if (revNaiveHit) revNaive.get(c).get(kn) else v,
        byRowHit: byRowHit, byRowResult: if (byRowHit) byRow.get(r) else v },
      exact' = if (keep and not(exactHit)) exact.put(b, v) else exact,
      revFixed' = if (keep and not(revFixedHit)) revFixed.set(c, revFixed.get(c).put(k, v)) else revFixed,
      revNaive' = if (keep and not(revNaiveHit)) revNaive.set(c, revNaive.get(c).put(kn, v)) else revNaive,
      byRow' = if (keep and not(byRowHit)) byRow.put(r, v) else byRow,
      poisoned' = if (not(refused) and not(valid(b))) poisoned.set(c, true) else poisoned,
      committed' = committed, txOpen' = txOpen, txWrites' = txWrites, dataVersion' = dataVersion,
      totalChanges' = totalChanges, rollbackEpoch' = rollbackEpoch, revoked' = revoked,
    }
  }

  action step = {
    nondet c = CONNS.oneOf()
    nondet r = ROWS.oneOf()
    nondet b = BYTES.oneOf()
    any { write(c, r, b), commit(c), rollback(c), reopen(c), revoke(c), read(c, r) }
  }

  // Every retained exact entry is the verification of exactly its key bytes.
  val exactCacheConsistent = exact.keys().forall(b => exact.get(b) == verify(b) and valid(b))
  // A refused read (poisoned or revoked) never returns any cached result.
  val refusedNeverHits = last.refused.implies(not(last.exactHit or last.revFixedHit or last.revNaiveHit or last.byRowHit))
  // THE invariant: every exact-bytes hit equals the verification of the current bytes.
  val exactHitIsCurrent = (last.live and last.exactHit).implies(last.exactResult == verify(last.bytes))
  val revFixedHitIsCurrent = (last.live and last.revFixedHit).implies(last.revFixedResult == verify(last.bytes))
  val safety = exactCacheConsistent and refusedNeverHits and exactHitIsCurrent and revFixedHitIsCurrent
  // Broken variants: these invariants are EXPECTED to be violated.
  val revNaiveHitIsCurrent = (last.live and last.revNaiveHit).implies(last.revNaiveResult == verify(last.bytes))
  val byRowHitIsCurrent = (last.live and last.byRowHit).implies(last.byRowResult == verify(last.bytes))
  // Existential reachability targets for the sound cache.
  val reachedExactHit = last.live and last.exactHit
  val reachedHitAfterReopen = last.live and last.exactHit and totalChanges.get(last.conn) == 0 and committed.get(last.row) != 1

  // Same bytes across write -> commit -> other connection: a sound hit.
  run hitAcrossConnectionsTest = init.then(write(0, "control", 2)).then(commit(0))
    .then(read(0, "control")).then(read(1, "control"))
    .expect(safety and last.exactHit and last.exactResult == verify(2))
  // Another connection's commit changes the bytes: miss, never the old result.
  run otherConnectionWriteTest = init.then(read(1, "blob")).then(write(0, "blob", 2)).then(commit(0))
    .then(read(1, "blob")).expect(safety and not(last.exactHit) and last.exactResult == verify(2)
      and last.byRowHit and last.byRowResult != verify(2))
  // Rollback: the exact cache stays current; the naive revision key serves the
  // rolled-back bytes (stale hit), the fixed revision key does not.
  run rollbackStaleWitnessTest = init.then(write(0, "control", 2)).then(read(0, "control"))
    .then(rollback(0)).then(read(0, "control"))
    .expect(safety and last.bytes == 1 and last.revNaiveHit and last.revNaiveResult == verify(2)
      and not(revNaiveHitIsCurrent) and not(last.revFixedHit) and last.exactResult == verify(1))
  // Poison: corrupt bytes are never retained; a poisoned owner never hits.
  run poisonTest = init.then(write(1, "image", 3)).then(commit(1)).then(read(0, "image"))
    .expect(safety and poisoned.get(0) and not(exact.keys().contains(3)))
    .then(read(0, "image")).expect(safety and last.refused and not(last.exactHit))
  // Revocation and reopen: refused while revoked; reopen re-reads current bytes.
  run revokeReopenTest = init.then(read(0, "control")).then(revoke(0)).then(read(0, "control"))
    .expect(safety and last.refused and not(last.exactHit))
    .then(write(1, "control", 2)).then(commit(1)).then(reopen(0)).then(read(0, "control"))
    .expect(safety and last.exactResult == verify(2) and not(last.exactHit))
}
