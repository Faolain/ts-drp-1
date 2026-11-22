module verifiedOnceCache {
  // A process-wide verify-once memo in front of a durable record (the issuance
  // retirement control, its embedded settlement plans, a settlement-plan row).
  // Verification (decode -> capture -> re-encode -> exact compare) is a pure function
  // of the exact stored bytes. Two SQLite connections share one process memo; each
  // may hold one uncommitted write; writes commit or roll back; the store reopens
  // (memo survives, same process) or the process restarts (memo lost); the bounded
  // memo may evict any entry at any time (covers every LRU policy).
  //
  // The memo key is the exact byte image. brokenStep keys it by the row address
  // instead (a revision or object id that a rollback or foreign write does not
  // change in lockstep with the bytes); the safety invariant catches the stale hit.
  pure val IMAGES = Set(0, 1, 2, 3)
  pure val VALID = Set(0, 1, 2)
  pure val CONNECTIONS = Set(0, 1)
  pure val CAPACITY = 2
  pure val REFUSED = -1
  pure val NONE = -2
  pure val ROW_ADDRESS = 0

  // The full verification of exactly these bytes: valid images verify to themselves.
  pure def verification(image: int): int = if (VALID.contains(image)) image else REFUSED
  pure def keyOf(byBytes: bool, image: int): int = if (byBytes) image else ROW_ADDRESS

  type Read = { conn: int, seen: int, returned: int, hit: bool }
  var committed: int
  var pending: int -> int
  var memo: int -> int
  var lastRead: Read
  var restarted: bool

  // What connection c reads: its own uncommitted write, else the committed image.
  def visible(c: int): int = if (pending.get(c) != NONE) pending.get(c) else committed
  def writerFree(c: int): bool = CONNECTIONS.exclude(Set(c)).forall(o => pending.get(o) == NONE)

  // Safety: every read, hit or miss, returns the verification of the bytes it read.
  val noStaleAdmit = lastRead.returned == verification(lastRead.seen)
  // Inductive strengthening for the byte-keyed memo: each entry is its key's verification.
  val memoExact = memo.keys().forall(k => memo.get(k) == verification(k))
  val boundedMemo = memo.keys().size() <= CAPACITY
  val safety = noStaleAdmit and boundedMemo

  // Existential coverage targets (witnesses), not universal claims.
  val reachedHit = lastRead.hit
  val reachedRefusal = lastRead.returned == REFUSED
  val reachedOwnUncommittedRead = lastRead.seen != committed
  val reachedHitAfterRestart = lastRead.hit and restarted
  val reachedFullMemo = memo.keys().size() == CAPACITY

  action init = {
    nondet image = IMAGES.oneOf()
    all {
      committed' = image,
      pending' = CONNECTIONS.mapBy(_ => NONE),
      memo' = Map(),
      lastRead' = { conn: 0, seen: image, returned: verification(image), hit: false },
      restarted' = false,
    }
  }

  // Insert, evicting the chosen victim first when the memo is full.
  pure def remember(m: int -> int, k: int, v: int, victim: int): int -> int =
    val room = if (m.keys().size() < CAPACITY) m else m.keys().exclude(Set(victim)).mapBy(key => m.get(key))
    room.put(k, v)

  action read(byBytes: bool, c: int, victim: int): bool =
    val seen = visible(c)
    val k = keyOf(byBytes, seen)
    all {
      // Any eviction policy: a full memo gives up some current entry for a new one.
      memo.keys().contains(k) or memo.keys().size() < CAPACITY or memo.keys().contains(victim),
      if (memo.keys().contains(k)) all {
        lastRead' = { conn: c, seen: seen, returned: memo.get(k), hit: true },
        memo' = memo,
      } else all {
        // A refusal is never memoized; it is recomputed on the next read.
        lastRead' = { conn: c, seen: seen, returned: verification(seen), hit: false },
        memo' = if (verification(seen) == REFUSED) memo
          else remember(memo, k, verification(seen), victim),
      },
      committed' = committed, pending' = pending, restarted' = restarted,
    }

  // SQLite allows one writer transaction at a time.
  action write(c: int, image: int): bool = all {
    writerFree(c),
    pending' = pending.set(c, image),
    committed' = committed, memo' = memo, lastRead' = lastRead, restarted' = restarted,
  }
  action commit(c: int): bool = all {
    pending.get(c) != NONE,
    committed' = pending.get(c),
    pending' = pending.set(c, NONE),
    memo' = memo, lastRead' = lastRead, restarted' = restarted,
  }
  action rollback(c: int): bool = all {
    pending.get(c) != NONE,
    pending' = pending.set(c, NONE),
    committed' = committed, memo' = memo, lastRead' = lastRead, restarted' = restarted,
  }
  // Store close/reopen in the same process: open transactions end, the memo survives.
  action reopen = all {
    pending' = CONNECTIONS.mapBy(_ => NONE),
    committed' = committed, memo' = memo, lastRead' = lastRead, restarted' = restarted,
  }
  // Process restart: the memo is gone.
  action restart = all {
    pending' = CONNECTIONS.mapBy(_ => NONE),
    memo' = Map(),
    committed' = committed, lastRead' = lastRead, restarted' = true,
  }
  action evict(victim: int): bool = all {
    memo.keys().contains(victim),
    memo' = memo.keys().exclude(Set(victim)).mapBy(key => memo.get(key)),
    committed' = committed, pending' = pending, lastRead' = lastRead, restarted' = restarted,
  }

  action anyStep(byBytes: bool): bool = {
    nondet c = CONNECTIONS.oneOf()
    nondet image = IMAGES.oneOf()
    nondet victim = IMAGES.oneOf()
    any { read(byBytes, c, victim), write(c, image), commit(c), rollback(c), reopen, restart, evict(victim) }
  }
  action step = anyStep(true)
  action brokenStep = anyStep(false)

  run testForeignCommitIsReadNotRemembered =
    init.then(all { committed' = 0, pending' = pending, memo' = memo, lastRead' = lastRead, restarted' = restarted })
      .then(read(true, 0, 3)).then(write(1, 1)).then(commit(1)).then(read(true, 0, 3))
      .expect(lastRead.returned == 1 and not(lastRead.hit) and safety and memoExact)
  run testRollbackReturnsToVerifiedImage =
    init.then(all { committed' = 0, pending' = pending, memo' = memo, lastRead' = lastRead, restarted' = restarted })
      .then(read(true, 0, 3)).then(write(0, 3)).then(read(true, 0, 3))
      .expect(lastRead.returned == REFUSED and safety)
      .then(rollback(0)).then(read(true, 0, 3))
      .expect(lastRead.returned == 0 and lastRead.hit and safety and memoExact)
  run testOtherConnectionUncommittedIsInvisible =
    init.then(all { committed' = 0, pending' = pending, memo' = memo, lastRead' = lastRead, restarted' = restarted })
      .then(write(1, 2)).then(read(true, 1, 3)).then(read(true, 0, 3))
      .expect(lastRead.returned == 0 and not(lastRead.hit) and safety and memoExact)
  run testReopenKeepsOnlyExactHits =
    init.then(all { committed' = 1, pending' = pending, memo' = memo, lastRead' = lastRead, restarted' = restarted })
      .then(read(true, 0, 3)).then(write(0, 2)).then(reopen).then(read(true, 1, 3))
      .expect(lastRead.returned == 1 and lastRead.hit and safety)
  // The witness the invariant exists for: an address-keyed memo serves the old
  // verification after another connection commits different (refused) bytes.
  run testAddressKeyedMemoServesStaleAdmit =
    init.then(all { committed' = 0, pending' = pending, memo' = memo, lastRead' = lastRead, restarted' = restarted })
      .then(read(false, 0, 3)).then(write(1, 3)).then(commit(1)).then(read(false, 0, 3))
      .expect(lastRead.hit and lastRead.returned == 0 and verification(lastRead.seen) == REFUSED and not(noStaleAdmit))
}
