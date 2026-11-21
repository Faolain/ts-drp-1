// MODEL (efb13cd8 + docs 03dd3e55, track 46): a reissued move given back again is never superseded by
// its own row, and a later hand-back loses no move.
//
// One Writer move M of one displacement identity (a Grid block cell), first issued as row 0, its origin.
// Its rows (carriers) come from:
//   replace   the drain replaces a displaced carrier (plan entry source -> replacementSequence: a link);
//   reissue   the application offers a given-back M again with its record: the row consumes the record
//             (record.reissue = row) and adds a reissueOrigins entry (row -> origin) in one transaction.
// The author may also make a different move D of the same identity (issueD); its origin is its own row.
// A live carrier is given back (giveBack: window expiry, frontier resolution or row 97's refused replay):
// a hand-back record {src: carrier, origin} where the origin is read by walking the links back to an
// entry or the chain's first row (settlementMoveOrigin), and the entry the walk stopped at is dropped in
// the same write (settlementHandBacksAtOrigin). Every later merge prunes consumed records (merge:
// settlementWindowHandBacks and handBackRefusedReplay keep only unconsumed records).
//
// The listing's supersededBy (v3-room refreshHandBackSupersession): for the unconsumed record, the own row
// of the identity after the record's origin with the greatest row origin (then sequence), when that origin
// is greater than the record's. Row origins (`rule`):
//   ownRow      efb13cd8 settlementOwnRowOrigin: the walk's entry origin, else the origin of a record
//               whose src is the walk's stop row, else the stop row;
//   moveOrigin  before efb13cd8: settlementMoveOrigin only;
//   chainRecord a candidate (not shipped): as ownRow, but a record whose src is any row linked forward from
//               the stop row also gives the origin.
// The application after a reload offers the record's move again, then the supersededBy move (`policy`):
//   shipped        createV3RoomRolloverPolicy offerKept: superseded only when !sameMove(newer, move); the
//                  move is offered with its record either way, the newer move right after it;
//   noSameMove     superseded whenever supersededBy is set: a supersededBy carrying M itself makes the
//                  policy offer M again as a new move (without its record);
//   dropSuperseded an app on the raw API that drops a superseded given-back move.
//
// Invariants:
//   noSelfSupersession  a given-back M is never supersededBy one of its own rows;
//   noDuplicate         M is never offered again without its record (one move, one admission);
//   noLoss              M is never dropped unless a genuinely newer move (D) supersedes it;
//   authorOrder         after the policy's re-offer, the last move it lands is the author's newest move
//                       (D when D exists: every D row is newer than M's origin);
//   safety = noSelfSupersession and noDuplicate and noLoss.
//
// Scopes: init* (two hand-backs, replacements only before the first reissue: what efb13cd8 fixes);
// initThird* (three hand-backs: the documented 03dd3e55 known issue); initReplacedReissued* (a reissued
// row replaced, then given back from the replacement: found while modelling, see the report).
//
// Commands (packages/node/formal; JAVA_HOME=$(brew --prefix openjdk@17), PATH=$JAVA_HOME/bin:$PATH):
//   quint typecheck given-back-own-row-origin.qnt
//   quint test given-back-own-row-origin.qnt --main givenBackOwnRowOrigin --match 'Test$'
//   V="quint verify given-back-own-row-origin.qnt --main givenBackOwnRowOrigin --step step \
//      --backend apalache --apalache-version=0.56.1 --max-steps=7"
//   $V --init init --invariants safety                          # [ok]
//   $V --init init --invariants authorOrder                     # [ok]
//   $V --init initFixedNaiveApp --invariants safety             # [ok]
//   $V --init initPreFix --invariants noSelfSupersession        # violation (pre-efb13cd8)
//   $V --init initPreFixNaiveApp --invariants noLoss            # violation (pre-efb13cd8, raw-API app)
//   $V --init initThird --invariants noSelfSupersession         # violation (documented known issue)
//   $V --init initThird --invariants noDuplicate                # [ok]: the shipped sameMove check
//   $V --init initThird --invariants noLoss                     # [ok]: no move lost
//   $V --init initThirdNoSameMove --invariants noDuplicate      # violation: sameMove is load-bearing
//   $V --init initReplacedReissued --invariants noSelfSupersession       # violation (gap, see report)
//   $V --init initReplacedReissuedChain --invariants safety              # [ok] (candidate rule)
module givenBackOwnRowOrigin {
  pure val MAXROW = 7      // own rows 0..MAXROW-1
  pure val NONE = -1

  type HandBack = { src: int, origin: int, reissue: int }   // reissue NONE: unconsumed
  type Ent = { reissue: int, origin: int }
  type Walk = { cur: int, done: bool, hit: bool, origin: int }

  var op: int -> str          // issued rows: "M" or "D"
  var nextRow: int               // the lineage head (next own row)
  var links: Set[(int, int)]  // (source, replacement)
  var entries: Set[Ent]       // reissueOrigins
  var records: Set[HandBack]       // hand-back records (consumed ones until a merge prunes them)
  var carrier: int            // M's live row, NONE while given back (or dropped)
  var reissues: int
  var givenBacks: int
  var dIssued: bool
  var duplicate: bool         // ghost: M offered again without its record
  var lost: bool              // ghost: M dropped without a genuinely newer move
  var orderBroken: bool       // ghost: the policy's last landed move was not the author's newest
  var rule: str
  var policy: str
  var maxGiveBacks: int
  var replaceReissued: bool

  // settlementMoveOrigin: links back to an entry (its origin) or the chain's first row.
  def walk(s: int): Walk =
    0.to(MAXROW - 1).fold({ cur: s, done: false, hit: false, origin: s }, (acc, i) =>
      if (acc.done) acc
      else if (entries.exists(e => e.reissue == acc.cur))
        { cur: acc.cur, done: true, hit: true, origin: entries.fold(NONE, (x, e) => if (e.reissue == acc.cur) e.origin else x) }
      else if (links.exists(l => l._2 == acc.cur))
        { cur: links.fold(NONE, (x, l) => if (l._2 == acc.cur) l._1 else x), done: false, hit: false, origin: acc.origin }
      else { cur: acc.cur, done: true, hit: false, origin: acc.cur })
  // The rows linked forward from s (s included).
  def forward(s: int): Set[int] =
    0.to(MAXROW).fold(Set(s), (acc, i) => acc.union(links.filter(l => acc.contains(l._1)).map(l => l._2)))
  def recordOrigin(srcs: Set[int], fallback: int): int =
    records.fold(fallback, (x, r) => if (srcs.contains(r.src) and r.origin != r.src) r.origin else x)
  def rowOrigin(s: int): int = {
    val w = walk(s)
    if (rule == "moveOrigin") w.origin
    else if (w.hit) w.origin
    else if (rule == "chainRecord") recordOrigin(forward(w.cur), w.cur)
    else recordOrigin(Set(w.cur), w.cur)
  }
  // Every row's origin, computed once per evaluation (rows not issued yet are never read).
  def origins: int -> int = 0.to(MAXROW - 1).mapBy(s => rowOrigin(s))
  // The listing's supersededBy for the record with origin o (every row is of the identity).
  def supersededBy(o: int): int = {
    val org = origins
    val newest = op.keys().filter(s => s > o).fold(NONE, (best, s) =>
      if (best == NONE) s
      else if (org.get(s) > org.get(best)) s
      else if (org.get(s) == org.get(best) and s > best) s
      else best)
    if (newest == NONE) NONE else if (org.get(newest) > o) newest else NONE
  }
  def unconsumed: Set[HandBack] = records.filter(r => r.reissue == NONE)
  def listedOrigin: int = unconsumed.fold(NONE, (x, r) => r.origin)
  def listedBy: int = if (carrier == NONE and unconsumed.size() > 0) supersededBy(listedOrigin) else NONE

  action initWith(r: str, p: str, g: int, rr: bool): bool = all {
    op' = Map(0 -> "M"), nextRow' = 1, links' = Set(), entries' = Set(), records' = Set(), carrier' = 0,
    reissues' = 0, givenBacks' = 0, dIssued' = false, duplicate' = false, lost' = false, orderBroken' = false,
    rule' = r, policy' = p, maxGiveBacks' = g, replaceReissued' = rr,
  }
  action init = initWith("ownRow", "shipped", 2, false)
  action initFixedNaiveApp = initWith("ownRow", "dropSuperseded", 2, false)
  action initPreFix = initWith("moveOrigin", "shipped", 2, false)
  action initPreFixNaiveApp = initWith("moveOrigin", "dropSuperseded", 2, false)
  action initThird = initWith("ownRow", "shipped", 3, false)
  action initThirdNoSameMove = initWith("ownRow", "noSameMove", 3, false)
  action initThirdNaiveApp = initWith("ownRow", "dropSuperseded", 3, false)
  action initReplacedReissued = initWith("ownRow", "shipped", 2, true)
  action initReplacedReissuedChain = initWith("chainRecord", "shipped", 2, true)

  action keepConfig = all { rule' = rule, policy' = policy, maxGiveBacks' = maxGiveBacks, replaceReissued' = replaceReissued }
  action keepGhosts = all { duplicate' = duplicate, lost' = lost, orderBroken' = orderBroken }
  action unchangedAll = all {
    op' = op, nextRow' = nextRow, links' = links, entries' = entries, records' = records, carrier' = carrier,
    reissues' = reissues, givenBacks' = givenBacks, dIssued' = dIssued, keepGhosts, keepConfig,
  }

  // The author's different move D of the same identity (a fresh row, admitted).
  action issueD = all {
    not(dIssued), nextRow < MAXROW,
    op' = op.put(nextRow, "D"), nextRow' = nextRow + 1, dIssued' = true,
    links' = links, entries' = entries, records' = records, carrier' = carrier, reissues' = reissues,
    givenBacks' = givenBacks, keepGhosts, keepConfig,
  }
  // The drain replaces M's displaced carrier (the entry stays; the link is the plan entry).
  action replace = all {
    carrier != NONE, nextRow < MAXROW, if (replaceReissued) true else reissues == 0,
    op' = op.put(nextRow, "M"), nextRow' = nextRow + 1, links' = links.union(Set((carrier, nextRow))), carrier' = nextRow,
    entries' = entries, records' = records, reissues' = reissues, givenBacks' = givenBacks, dIssued' = dIssued,
    keepGhosts, keepConfig,
  }
  // M's carrier is given back: a record at the move's origin; the walk's entry passes to it.
  action giveBack = all {
    carrier != NONE, givenBacks < maxGiveBacks,
    val w = walk(carrier)
    all {
      records' = records.union(Set({ src: carrier, origin: w.origin, reissue: NONE })),
      entries' = if (w.hit) entries.filter(e => e.reissue != w.cur) else entries,
    },
    carrier' = NONE, givenBacks' = givenBacks + 1,
    op' = op, nextRow' = nextRow, links' = links, reissues' = reissues, dIssued' = dIssued, keepGhosts, keepConfig,
  }
  // A later merge drops the consumed records.
  action merge = all {
    records.exists(r => r.reissue != NONE),
    records' = unconsumed,
    op' = op, nextRow' = nextRow, links' = links, entries' = entries, carrier' = carrier, reissues' = reissues,
    givenBacks' = givenBacks, dIssued' = dIssued, keepGhosts, keepConfig,
  }
  // The application (after a reload: no in-memory history) offers M again with its record, then the
  // supersededBy move as the policy reads it.
  action offer = all {
    carrier == NONE, unconsumed.size() > 0, not(lost), nextRow + 2 <= MAXROW,
    val rec = unconsumed.fold({ src: NONE, origin: NONE, reissue: NONE }, (x, r) => r)
    val by = supersededBy(rec.origin)
    val byOp = if (by == NONE) "" else op.get(by)
    val superseded = if (by == NONE) false else if (policy == "noSameMove") true else byOp != "M"
    val newest = if (dIssued) "D" else "M"
    if (policy == "dropSuperseded" and by != NONE) all {
      // The raw-API app drops M; a loss unless the newer move is a different one.
      lost' = byOp == "M", records' = records.exclude(Set(rec)),
      orderBroken' = orderBroken, duplicate' = duplicate,
      op' = op, nextRow' = nextRow, links' = links, entries' = entries, carrier' = carrier, reissues' = reissues,
    } else all {
      records' = records.exclude(Set(rec)).union(Set({ ...rec, reissue: nextRow })),
      entries' = entries.union(Set({ reissue: nextRow, origin: rec.origin })),
      op' = if (superseded) op.put(nextRow, "M").put(nextRow + 1, byOp) else op.put(nextRow, "M"),
      nextRow' = if (superseded) nextRow + 2 else nextRow + 1,
      carrier' = nextRow, reissues' = reissues + 1,
      duplicate' = if (duplicate) true else superseded and byOp == "M",
      orderBroken' = if (orderBroken) true else (if (superseded) byOp else "M") != newest,
      lost' = lost, links' = links,
    },
    givenBacks' = givenBacks, dIssued' = dIssued, keepConfig,
  }

  action step = any { issueD, replace, giveBack, merge, offer }

  val noSelfSupersession = if (listedBy == NONE) true else op.get(listedBy) != "M"
  val noDuplicate = not(duplicate)
  val noLoss = not(lost)
  val authorOrder = not(orderBroken)
  val safety = noSelfSupersession and noDuplicate and noLoss

  // Witnesses (violated = reachable).
  val noSecondHandBackOfReissue = not(carrier == NONE and records.exists(r => r.reissue == NONE and r.src != r.origin))
  val noGenuineSupersession = if (listedBy == NONE) true else op.get(listedBy) != "D"

  // Given back, reissued (row 1), given back again from row 1: its record keeps origin 0; row 1 reads 0.
  action twice(start: bool): bool = start.then(giveBack).then(offer).then(merge).then(giveBack)
  run twiceFixedTest = twice(init)
    .then(all { assert(records == Set({ src: 1, origin: 0, reissue: NONE }) and rowOrigin(1) == 0 and listedBy == NONE and safety), offer })
    .then(all { assert(carrier == 2 and not(duplicate) and authorOrder), unchangedAll })
  run twicePreFixTest = twice(initPreFix)
    .then(all { assert(rowOrigin(1) == 1 and listedBy == 1 and not(noSelfSupersession)), offer })
    // The shipped policy's sameMove check still offers M once.
    .then(all { assert(carrier == 2 and noDuplicate), unchangedAll })
  run twicePreFixNaiveAppLosesTest = twice(initPreFixNaiveApp).then(offer)
    .then(all { assert(lost and carrier == NONE), unchangedAll })
  // A genuinely newer D still supersedes M (the fix does not hide it), and lands last.
  run genuineNewerTest = init.then(issueD).then(giveBack).then(offer)
    .then(all { assert(op.get(2) == "M" and op.get(3) == "D" and authorOrder), giveBack })
    .then(all { assert(listedBy == 3 and safety), offer })
    .then(all { assert(op.get(5) == "D" and authorOrder), unchangedAll })
  // Third hand-back: row 1's consumed record was pruned, so row 1 reads as its own move again.
  run thirdHandBackTest = twice(initThird).then(offer).then(merge).then(giveBack)
    .then(all { assert(rowOrigin(1) == 1 and listedBy == 1 and not(noSelfSupersession)), offer })
    .then(all { assert(carrier == 3 and noDuplicate and noLoss), unchangedAll })
  run thirdHandBackNoSameMoveTest = twice(initThirdNoSameMove).then(offer).then(merge).then(giveBack).then(offer)
    .then(all { assert(duplicate and op.get(4) == "M"), unchangedAll })
  // Reissued row 1 replaced by row 2, then given back from row 2: the record's src is 2, so rows 1 and 2
  // read origin 1 (> 0) under settlementOwnRowOrigin.
  run replacedReissuedTest = initReplacedReissued.then(giveBack).then(offer).then(merge).then(replace).then(giveBack)
    .then(all { assert(records == Set({ src: 2, origin: 0, reissue: NONE }) and rowOrigin(2) == 1 and listedBy == 2 and
      not(noSelfSupersession)), unchangedAll })
  run replacedReissuedChainTest = initReplacedReissuedChain.then(giveBack).then(offer).then(merge).then(replace).then(giveBack)
    .then(all { assert(rowOrigin(1) == 0 and rowOrigin(2) == 0 and listedBy == NONE and safety), unchangedAll })
}
