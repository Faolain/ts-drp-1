module journalImageMemo {
  // Verify-once memo of live-journal retirement images keyed by the exact
  // native rows (packages/storage-node/src/internal/journal-image-memo.ts and
  // retirementImage in packages/storage-node/src/live-journal.ts).
  //
  // The rows of one object are a list of small integers (each stands for one
  // row's exact table, columns and values). The image is a PURE function of
  // the ordered list: `image`. A list whose total charge exceeds LIMIT is
  // refused (retirement-fenced) and has no image.
  //
  // Two connections share one committed database; each may hold an open write
  // transaction whose overlay it alone sees. Own appends, in-place rewrites and
  // deletions, commit, rollback and another connection's commit are modelled.
  //
  // A read scans the visible rows in order. While every scanned row equals the
  // remembered row at the same position, it is DEFERRED (retained, uncharged);
  // the first differing row replays the deferred prefix into the original
  // capture. Only a complete match (same length, every row equal) is a hit.
  //
  // Three memos observe every read side by side:
  //  - exact:  the implementation (complete in-order match)       -> SOUND
  //  - prefix: accepts when the scan is a prefix of the remembered
  //            rows (forgets the final length check)              -> BROKEN
  //  - object: keyed by object identity alone (never re-compares) -> BROKEN
  pure val CONNS = Set(0, 1)
  pure val VALUES = Set(1, 2, 3)
  pure val MAX_ROWS = 3
  pure val LIMIT = 6

  pure def charge(rows: List[int]): int = rows.foldl(0, (sum, row) => sum + row)
  pure def admitted(rows: List[int]): bool = charge(rows) <= LIMIT
  // Any injective-enough pure function of the ordered rows stands for the digest.
  pure def image(rows: List[int]): int = rows.foldl(rows.length(), (acc, row) => acc * 5 + row)
  pure def isPrefix(short: List[int], long: List[int]): bool =
    short.length() <= long.length() and 0.to(MAX_ROWS - 1).forall(i => i >= short.length() or short[i] == long[i])
  // Rows matched (and therefore deferred) before the first difference. Every row
  // list is bounded by MAX_ROWS, so the constant range is exact (and Apalache-encodable).
  pure def matchedPrefix(scan: List[int], remembered: List[int]): int =
    range(0, MAX_ROWS).foldl(0, (n, i) =>
      if (n == i and i < scan.length() and i < remembered.length() and scan[i] == remembered[i]) n + 1 else n)

  type Entry = { has: bool, rows: List[int], img: int }
  type Read = { live: bool, conn: int, rows: List[int], refused: bool,
    exactHit: bool, exactResult: int, deferredCharge: int,
    prefixHit: bool, prefixResult: int, objectHit: bool, objectResult: int }
  pure val none: Entry = { has: false, rows: [], img: 0 }
  pure val noRead: Read = { live: false, conn: 0, rows: [], refused: false, exactHit: false, exactResult: 0,
    deferredCharge: 0, prefixHit: false, prefixResult: 0, objectHit: false, objectResult: 0 }

  var committed: List[int]
  var txOpen: int -> bool
  var overlay: int -> List[int]
  var exact: int -> Entry
  var prefix: int -> Entry
  var byObject: int -> Entry
  var last: Read

  def visible(c: int): List[int] = if (txOpen.get(c)) overlay.get(c) else committed

  action init = all {
    committed' = [1],
    txOpen' = CONNS.mapBy(_ => false),
    overlay' = CONNS.mapBy(_ => []),
    exact' = CONNS.mapBy(_ => none),
    prefix' = CONNS.mapBy(_ => none),
    byObject' = CONNS.mapBy(_ => none),
    last' = noRead,
  }

  action unchangedMemos = all { exact' = exact, prefix' = prefix, byObject' = byObject }

  // Own write inside a transaction (BEGIN on first write): the overlay replaces the visible rows.
  action ownWrite(c: int, rows: List[int]): bool = all {
    rows.length() <= MAX_ROWS,
    txOpen' = txOpen.set(c, true),
    overlay' = overlay.set(c, rows),
    committed' = committed, last' = noRead, unchangedMemos,
  }
  action appendRow(c: int, v: int): bool = ownWrite(c, visible(c).append(v))
  action rewrite(c: int, i: int, v: int): bool = all { i < visible(c).length(), ownWrite(c, visible(c).replaceAt(i, v)) }
  action deleteLast(c: int): bool = all { visible(c).length() > 0, ownWrite(c, visible(c).slice(0, visible(c).length() - 1)) }

  action commit(c: int): bool = all {
    txOpen.get(c),
    committed' = overlay.get(c),
    txOpen' = txOpen.set(c, false),
    overlay' = overlay.set(c, []),
    last' = noRead, unchangedMemos,
  }
  action rollback(c: int): bool = all {
    txOpen.get(c),
    txOpen' = txOpen.set(c, false),
    overlay' = overlay.set(c, []),
    committed' = committed, last' = noRead, unchangedMemos,
  }

  // One capture. Every memo is consulted for the rows visible right now; only
  // admitted (non-refused) captures are remembered.
  action read(c: int): bool = {
    val rows = visible(c)
    val refused = not(admitted(rows))
    val e = exact.get(c)
    val p = prefix.get(c)
    val o = byObject.get(c)
    val exactHit = e.has and rows == e.rows
    val deferred = if (e.has) matchedPrefix(rows, e.rows) else 0
    val prefixHit = p.has and isPrefix(rows, p.rows)
    val objectHit = o.has
    val fresh = if (refused) -1 else image(rows)
    all {
      last' = { live: true, conn: c, rows: rows, refused: refused,
        exactHit: exactHit, exactResult: if (exactHit) e.img else fresh,
        deferredCharge: charge(rows.slice(0, deferred)),
        prefixHit: prefixHit, prefixResult: if (prefixHit) p.img else fresh,
        objectHit: objectHit, objectResult: if (objectHit) o.img else fresh },
      exact' = if (not(refused) and not(exactHit)) exact.set(c, { has: true, rows: rows, img: fresh }) else exact,
      prefix' = if (not(refused) and not(prefixHit)) prefix.set(c, { has: true, rows: rows, img: fresh }) else prefix,
      byObject' = if (not(refused) and not(objectHit)) byObject.set(c, { has: true, rows: rows, img: fresh }) else byObject,
      committed' = committed, txOpen' = txOpen, overlay' = overlay,
    }
  }

  action step = {
    nondet c = CONNS.oneOf()
    nondet v = VALUES.oneOf()
    nondet i = 0.to(MAX_ROWS - 1).oneOf()
    any { appendRow(c, v), rewrite(c, i, v), deleteLast(c), commit(c), rollback(c), read(c) }
  }

  // Every remembered entry is the image of exactly its rows, which were admitted.
  val exactMemoConsistent = CONNS.forall(c => exact.get(c).has implies
    (admitted(exact.get(c).rows) and exact.get(c).img == image(exact.get(c).rows)))
  // THE invariant: every result equals the image of the rows visible to that capture.
  val exactResultIsCurrent = (last.live and not(last.refused)) implies last.exactResult == image(last.rows)
  // A refused capture never returns a remembered image.
  val refusedNeverHits = (last.live and last.refused) implies (not(last.exactHit) and last.exactResult == -1)
  // Deferred rows are bounded by an already admitted image: memory stays within LIMIT.
  val deferredBounded = last.live implies last.deferredCharge <= LIMIT
  val safety = exactMemoConsistent and exactResultIsCurrent and refusedNeverHits and deferredBounded
  // Broken variants: these invariants are EXPECTED to be violated.
  val prefixResultIsCurrent = (last.live and last.prefixHit) implies last.prefixResult == image(last.rows)
  val objectResultIsCurrent = (last.live and last.objectHit) implies last.objectResult == image(last.rows)
  // Reachability witnesses for the sound memo.
  val reachedHit = last.live and last.exactHit
  val reachedRefusal = last.live and last.refused
  val reachedMultiRowHit = last.live and last.exactHit and last.rows.length() >= 2
  val reachedOwnUncommittedRead = last.live and txOpen.get(last.conn) and not(last.exactHit)

  // Unchanged rows: the second capture is a hit with the same image.
  run hitTest = init.then(read(0)).then(read(0))
    .expect(safety and last.exactHit and last.exactResult == image([1]))
  // Another connection appends and commits: a miss, never the old image.
  run otherConnectionAppendTest = init.then(read(0)).then(appendRow(1, 2)).then(commit(1)).then(read(0))
    .expect(safety and not(last.exactHit) and last.exactResult == image([1, 2]))
  // Own uncommitted rewrite, then rollback: each capture sees its own visible rows.
  run ownWriteRollbackTest = init.then(appendRow(0, 2)).then(read(0)).then(rewrite(0, 1, 3)).then(read(0))
    .expect(safety and not(last.exactHit) and last.exactResult == image([1, 3]))
    .then(rollback(0)).then(read(0))
    .expect(safety and not(last.exactHit) and last.exactResult == image([1]))
  // Deletion makes the scan a strict prefix of the remembered rows: the prefix
  // memo serves the stale longer image, the exact memo does not.
  run deletionPrefixWitnessTest = init.then(appendRow(0, 2)).then(commit(0)).then(read(1))
    .then(deleteLast(0)).then(commit(0)).then(read(1))
    .expect(safety and not(last.exactHit) and last.prefixHit and not(prefixResultIsCurrent)
      and last.exactResult == image([1]))
  // A same-length rewrite by another connection: the object-keyed memo is stale.
  run rewriteObjectWitnessTest = init.then(read(0)).then(rewrite(1, 0, 2)).then(commit(1)).then(read(0))
    .expect(safety and last.objectHit and not(objectResultIsCurrent) and last.exactResult == image([2]))
  // Refusal: an over-limit image is never remembered; restoring the rows hits the old entry.
  run refusalTest = init.then(read(0)).then(appendRow(1, 3)).then(appendRow(1, 3)).then(commit(1)).then(read(0))
    .expect(safety and last.refused and not(last.exactHit) and exact.get(0).rows == [1])
    .then(deleteLast(1)).then(deleteLast(1)).then(commit(1)).then(read(0))
    .expect(safety and last.exactHit and last.exactResult == image([1]))
}
