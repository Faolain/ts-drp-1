module creatorFenceSingleCustody {
  // Which reads of retained closed data an adoption-fence proof may use
  // (packages/node/src/internal/creator-closed-rollback-data.ts,
  // acquireCreatorIssuanceMaintenanceProof -> acquireClosedData).
  //
  // Native custody is a held read view: a readonly transaction over an owner's
  // stores (packages/storage-browser/src/internal/native-read-reservation.ts).
  // While it is held, no foreign read-write transaction on those stores can
  // overlap, so the durable bytes cannot change. Durable bytes are untrusted:
  // a proof may use only bytes read and authenticated under its own CURRENT
  // custody (G5; Track R: no revision counters, no skipping a fresh read).
  //
  // An acquisition holds custody `custody` (0 = none) and may read the durable
  // value `stored` either before custody (`readUnheld`) or under it
  // (`readHeld`). `memo` is the last read, tagged with the custody it was read
  // under (0 = none). Four proof routes are observed side by side on every
  // `prove`:
  //  - exact:   use the memo only if it was read under THIS custody   -> SOUND, 1 read
  //             (the fix: the fence reads every retained byte once, under custody)
  //  - reread:  read again under custody and require equal bytes      -> SOUND, 2 reads
  //             (today's detached preparation plus qualify)
  //  - stale:   use a pre-custody read without re-reading it          -> BROKEN
  //  - carried: use a read from an EARLIER custody (a close, an
  //             adoption or a previous readiness) keyed by its digest,
  //             without reading the current bytes                     -> BROKEN
  // `stale` and `carried` show why the only lawful saving is within one custody:
  // knowing that "the rows are unchanged" requires reading the rows.
  pure val MAX_VALUE = 3
  pure val MAX_CUSTODY = 3

  type Memo = { has: bool, value: int, custody: int }
  type Proof = {
    done: bool,
    exactOk: bool, exact: int,
    rereadOk: bool, reread: int, rereadReads: int,
    stale: int, carriedOk: bool, carried: int,
    exactReads: int,
  }
  pure val NO_MEMO: Memo = { has: false, value: 0, custody: 0 }
  pure val NO_PROOF: Proof = {
    done: false, exactOk: false, exact: 0, rereadOk: false, reread: 0, rereadReads: 0,
    stale: 0, carriedOk: false, carried: 0, exactReads: 0,
  }

  var stored: int
  var custody: int
  var nextCustody: int
  var atAcquire: int
  var memo: Memo
  var reads: int
  var proof: Proof

  action init = all {
    stored' = 0,
    custody' = 0,
    nextCustody' = 1,
    atAcquire' = 0,
    memo' = NO_MEMO,
    reads' = 0,
    proof' = NO_PROOF,
  }

  // Another owner's read-write transaction (a received append, a retirement):
  // only possible while no held read view covers the stores.
  action foreignWrite = all {
    custody == 0,
    stored < MAX_VALUE,
    stored' = stored + 1,
    custody' = custody, nextCustody' = nextCustody, atAcquire' = atAcquire,
    memo' = memo, reads' = reads, proof' = proof,
  }

  action readUnheld = all {
    custody == 0,
    memo' = { has: true, value: stored, custody: 0 },
    reads' = reads + 1,
    stored' = stored, custody' = custody, nextCustody' = nextCustody, atAcquire' = atAcquire, proof' = proof,
  }

  action acquire = all {
    custody == 0,
    nextCustody <= MAX_CUSTODY,
    custody' = nextCustody,
    nextCustody' = nextCustody + 1,
    atAcquire' = stored,
    proof' = NO_PROOF,
    stored' = stored, memo' = memo, reads' = reads,
  }

  action readHeld = all {
    custody != 0,
    not(proof.done),
    memo' = { has: true, value: stored, custody: custody },
    reads' = reads + 1,
    stored' = stored, custody' = custody, nextCustody' = nextCustody, atAcquire' = atAcquire, proof' = proof,
  }

  action prove = all {
    custody != 0,
    memo.has,
    not(proof.done),
    proof' = {
      done: true,
      exactOk: memo.custody == custody,
      exact: memo.value,
      exactReads: reads,
      // The re-read happens under this custody and compares exact bytes.
      rereadOk: memo.value == stored,
      reread: stored,
      rereadReads: if (memo.custody == custody) reads else reads + 1,
      stale: memo.value,
      carriedOk: memo.custody != 0,
      carried: memo.value,
    },
    stored' = stored, custody' = custody, nextCustody' = nextCustody, atAcquire' = atAcquire,
    memo' = memo, reads' = reads,
  }

  // Release keeps the memo (with its custody tag) so a later acquisition can try
  // to carry it; the read counter belongs to one acquisition.
  action release = all {
    custody != 0,
    custody' = 0,
    reads' = 0,
    proof' = NO_PROOF,
    stored' = stored, nextCustody' = nextCustody, atAcquire' = atAcquire, memo' = memo,
  }

  action step = any { foreignWrite, readUnheld, acquire, readHeld, prove, release }

  // Custody excludes every foreign writer.
  val writeExcluded = custody != 0 implies stored == atAcquire
  // A proof is used only while its custody is held; it must equal the bytes there.
  val exactIsCurrent = (custody != 0 and proof.done and proof.exactOk) implies proof.exact == stored
  val rereadIsCurrent = (custody != 0 and proof.done and proof.rereadOk) implies proof.reread == stored
  // The exact route never needs more reads than the re-read route.
  val exactNoCostlier = (proof.done and proof.exactOk) implies proof.exactReads <= proof.rereadReads
  val safety = writeExcluded and exactIsCurrent and rereadIsCurrent and exactNoCostlier
  // BROKEN routes.
  val staleIsCurrent = (custody != 0 and proof.done) implies proof.stale == stored
  val carriedIsCurrent = (custody != 0 and proof.done and proof.carriedOk) implies proof.carried == stored

  // Witnesses (expected reachable; check with --invariant=not(...)).
  val reachedExactSingleRead = proof.done and proof.exactOk and proof.exactReads == 1
  val reachedRereadTwoReads = proof.done and not(proof.exactOk) and proof.rereadOk and proof.rereadReads == 2
  val reachedRereadRefusal = proof.done and not(proof.exactOk) and not(proof.rereadOk)
  val reachedSecondCustodyExact = nextCustody >= 3 and proof.done and proof.exactOk

  // The fix: acquire, read once under custody, prove.
  run exactSingleCustodyTest = init.then(acquire).then(readHeld).then(prove)
    .expect(proof.exactOk and proof.exactReads == 1 and proof.exact == stored and safety)
  // Today's detached preparation: read, (custody), re-read and compare: two reads.
  run detachedRereadTest = init.then(readUnheld).then(acquire).then(prove)
    .expect(not(proof.exactOk) and proof.rereadOk and proof.rereadReads == 2 and safety)
  // A write between the pre-custody read and custody: re-read refuses; stale would use old bytes.
  run staleWitnessTest = init.then(readUnheld).then(foreignWrite).then(acquire).then(prove)
    .expect(not(proof.exactOk) and not(proof.rereadOk) and not(staleIsCurrent) and safety)
  // A value authenticated under an earlier custody, then a write, then a new custody.
  run carriedWitnessTest = init.then(acquire).then(readHeld).then(release).then(foreignWrite)
    .then(acquire).then(prove)
    .expect(not(proof.exactOk) and proof.carriedOk and not(carriedIsCurrent) and safety)
  // The second epoch's fence also reads once under its own custody.
  run secondCustodyExactTest = init.then(acquire).then(readHeld).then(prove).then(release)
    .then(foreignWrite).then(acquire).then(readHeld).then(prove)
    .expect(proof.exactOk and proof.exactReads == 1 and proof.exact == stored and safety)
}
