// Rule R blocker (a): a replacement batch stopped mid-chunk commits the prefix it signed.
//
// A batched issuance (transactIssueBatch) durably enters ONE marker binding the exact bytes of all N
// intents to consecutive author sequences, then signs them in order, then commits every row, the plan
// effects and the lineage advance, and clears the marker, in one transaction. Rule R asks the caller,
// before each signature after the first, whether the creator's next offer arrived (the epoch is sealed);
// if so the store stops signing and commits the signed prefix alone: lineage next = first + k, the
// marker cleared. The unsigned rest is never signed, so its sequences are issued again later, with other
// bytes.
//
// A crash anywhere before that commit leaves the marker; the drain resumes it whole (the same bytes, so
// the same deterministic signatures) before anything else is issued (creator-pending-intent-resume).
//
// Safety (checked in every mode):
//   noSecondSignature - no author sequence is ever signed with two different contents (equivocation),
//                       counting signatures a crash lost;
//   committedSigned   - every committed row was signed;
//   contiguous        - the committed rows are exactly the sequences below the lineage's next.
// Broken controls (each must violate noSecondSignature):
//   stopAfterSign - the stop is decided after the next row's signature was requested (that row is signed
//                   but not committed, and its sequence is reused);
//   dropMarker    - a crash clears the marker without a commit (the signed rows' sequences are reused).
module batchPrefixCommit {
  pure val N = 3
  pure val MAX_NEXT = 5
  pure val MAX_CONTENT = 4

  var mode: str
  var lineNext: int                  // durable lineage next
  var markerFirst: int               // -1: no marker; else the marker's first sequence
  var markerContent: int             // the marker's content id (all its intents' bytes)
  var signing: bool                  // a batch is between its marker and its commit, in this process
  var k: int                         // signatures made by the batch in progress
  var content: int                   // the next fresh content id (a new batch's bytes)
  var signedAt: Set[(int, int)]      // every (sequence, content) ever signed, including lost ones
  var committed: Set[(int, int)]     // durable issued rows

  action initWith(m: str): bool = all {
    mode' = m, lineNext' = 0, markerFirst' = -1, markerContent' = 0, signing' = false, k' = 0, content' = 0,
    signedAt' = Set(), committed' = Set(),
  }
  action init = initWith("sound")
  action initStopAfterSign = initWith("stopAfterSign")
  action initDropMarker = initWith("dropMarker")

  def rowsOf(first: int, count: int, c: int): Set[(int, int)] =
    first.to(first + count - 1).map(s => (s, c))

  action unchangedMeta = all { mode' = mode }

  // Enter a new batch's marker (only when none stands: a marker is resumed first).
  action begin = all {
    not(signing), markerFirst == -1, lineNext <= MAX_NEXT, content < MAX_CONTENT,
    markerFirst' = lineNext, markerContent' = content, signing' = true, k' = 0, content' = content + 1,
    lineNext' = lineNext, signedAt' = signedAt, committed' = committed, unchangedMeta,
  }

  // Sign the batch's next row.
  action signNext = all {
    signing, k < N,
    signedAt' = signedAt.union(Set((markerFirst + k, markerContent))), k' = k + 1,
    lineNext' = lineNext, markerFirst' = markerFirst, markerContent' = markerContent, signing' = signing,
    content' = content, committed' = committed, unchangedMeta,
  }

  // Every row signed: commit them all and clear the marker.
  action finish = all {
    signing, k == N,
    committed' = committed.union(rowsOf(markerFirst, N, markerContent)), lineNext' = markerFirst + N,
    markerFirst' = -1, signing' = false, k' = 0,
    markerContent' = markerContent, content' = content, signedAt' = signedAt, unchangedMeta,
  }

  // Rule R: the caller stops the batch before the next signature; the signed prefix commits alone.
  // (stopAfterSign: the next row's signature was already requested when the stop is decided.)
  action stop = all {
    signing, k >= 1, k < N,
    val lost = if (mode == "stopAfterSign") Set((markerFirst + k, markerContent)) else Set()
    all {
      signedAt' = signedAt.union(lost),
      committed' = committed.union(rowsOf(markerFirst, k, markerContent)), lineNext' = markerFirst + k,
      markerFirst' = -1, signing' = false, k' = 0,
      markerContent' = markerContent, content' = content, unchangedMeta,
    },
  }

  // A crash before the commit: the process's progress is lost, the durable marker stays
  // (dropMarker: it is cleared without a commit).
  action crash = all {
    signing,
    signing' = false, k' = 0,
    markerFirst' = if (mode == "dropMarker") -1 else markerFirst,
    lineNext' = lineNext, markerContent' = markerContent, content' = content, signedAt' = signedAt,
    committed' = committed, unchangedMeta,
  }

  // The drain resumes a standing marker whole: the same bytes, the same signatures, one commit.
  action resume = all {
    not(signing), markerFirst != -1,
    signedAt' = signedAt.union(rowsOf(markerFirst, N, markerContent)),
    committed' = committed.union(rowsOf(markerFirst, N, markerContent)), lineNext' = markerFirst + N,
    markerFirst' = -1, k' = 0, signing' = false, markerContent' = markerContent, content' = content,
    unchangedMeta,
  }

  action stutter = all {
    mode' = mode, lineNext' = lineNext, markerFirst' = markerFirst, markerContent' = markerContent,
    signing' = signing, k' = k, content' = content, signedAt' = signedAt, committed' = committed,
  }

  action step = any { begin, signNext, finish, stop, crash, resume, stutter }

  val noSecondSignature = signedAt.forall(a => signedAt.forall(b => a._1 == b._1 implies a._2 == b._2))
  val committedSigned = committed.subseteq(signedAt)
  val contiguous = committed.map(r => r._1) == (if (lineNext == 0) Set() else 0.to(lineNext - 1)) and
    committed.forall(a => committed.forall(b => a._1 == b._1 implies a._2 == b._2))
  val safety = noSecondSignature and committedSigned and contiguous

  // Witnesses: a stopped batch whose unsigned sequences a later batch issued; a resumed marker.
  run soundPrefixThenReuseTest =
    init.then(begin).then(signNext).then(signNext).then(stop)
      .then(all { assert(lineNext == 2 and safety), stutter })
      .then(begin).then(signNext).then(signNext).then(signNext).then(finish)
      .then(all { assert(lineNext == 5 and safety and committed.contains((2, 1))), stutter })

  run soundCrashResumesWholeTest =
    init.then(begin).then(signNext).then(crash).then(resume)
      .then(all { assert(lineNext == 3 and safety), stutter })
      .then(begin).then(signNext).then(stop)
      .then(all { assert(lineNext == 4 and safety), stutter })

  run stopAfterSignEquivocatesTest =
    initStopAfterSign.then(begin).then(signNext).then(stop)
      .then(begin).then(signNext)
      .then(all { assert(not(noSecondSignature)), stutter })

  run dropMarkerEquivocatesTest =
    initDropMarker.then(begin).then(signNext).then(crash)
      .then(begin).then(signNext)
      .then(all { assert(not(noSecondSignature)), stutter })
}
