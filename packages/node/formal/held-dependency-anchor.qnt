// -*- mode: Bluespec; -*-
//
// Held dependency anchors against the recovery certificate's coverage.
//
// Three owners meet at one law, the native recovery certificate's dependency-anchor law
// (creator-closed-rollback-data requireRecoveryDependencyAnchorsCovered):
//
//  * The received-turnover census (v3-live readCreatorRecoveryDependencyCensus) DEMANDS the
//    historical anchor of every held own row that is not terminally covered, retired or capsuled.
//    It bounds the count of anchors, not their age.
//  * The certificate COVERS an anchor only if it authenticated it: the pin, the current and
//    predecessor trusts, and the trust of every retained native generation. Each retained generation
//    also authenticates its predecessor link: the signed successor anchor's previousAnchor equals the
//    cut's (closedCutSuccessorEquation), and openCreatorSnapshotRecoverySourceTrust returns that
//    predecessor trust. The code before did not count those links.
//  * AHE generation retirement keeps at most CAP generations, retiring the oldest eligible one, and
//    never consults the demanded anchors.
//
// A held row is one of three kinds:
//  * "expiring": a displaced own row. Once W (V3_SETTLEMENT_OWN_WINDOW_EPOCHS) old, it is resolved as
//    expired on an authenticated expiry and the plan's entry becomes `expire`. It is then never
//    replayed, but it can stay held until retirement reaches it.
//  * "rebase": a source the plan keeps live (a window-expired source whose hand-back records did not
//    fit stays rebase since d6dc24db). It can be replayed at any time.
//  * "review": a pending manual-review source. It is held until the user decides, and replaying it
//    needs its historical anchor.
//
// Rules:
//   before      the census demands every held row's anchor; coverage is generations only.
//   links       as before, plus coverage counts predecessor links.
//   exempt      the census demands no anchor for an expired (resolved `expire`) row; generations only.
//   linksCoupled links, under the measured coupling: AHE retires a generation only after retirement
//               has reached every expired row it covers (roll is disabled otherwise). This is the
//               code after fix/snapshot-stage-chain-invalid, under the coupling measured in three
//               Writer shapes (adjacent; one skip after 3 moves; one skip after 8 moves) and the
//               slow-member trace: an expired row was always released no later than its coverage.
//               (A mutant that never retires an expired row refuses earlier, at the census, with or
//               without the exemption.)
//   fixed       exempt + links: holds without the coupling (the exemption is not in the code: no
//               reachable RED for it was found).
//   overExempt  broken control: the exemption also drops a live rebase or review row's anchor.
//   unverified  broken control: coverage accepts every demanded anchor.
//
// Protecting the last generation covering a demanded anchor from AHE retirement was tried and
// dropped: measured on the manual-review RED, the kept generation's classified snapshot had already
// been retired, so the certificate refused RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE. Without it, a
// replayable row older than the coverage still refuses. That is the residual, and it is stated
// exactly by refusedOnlyForReplayable.
//
// Properties, under the adversary's step:
//   noForgedAccepted          coverage never accepts an anchor it did not authenticate.
//   replaySafe                no row is ever replayed at an anchor the certificate did not cover.
//   refusedOnlyForReplayable  the law refuses only for a forged anchor or a replayable (rebase or
//                             review) row older than the coverage, never for an expired row.
module heldDependencyAnchor {
  pure val MAX_E = 8
  pure val CAP = 5
  pure val W = 4
  pure val TOP = 3

  var rule: str
  var current: int
  // Retained native generations, by epoch (one per adjacent install). The pin is covered apart.
  var gens: Set[int]
  // Held rows: epoch -> kind ("expiring" | "rebase" | "review").
  var rows: int -> str
  // A forged dependency anchor injected by the adversary (epoch), or -1.
  var forged: int
  var refused: bool
  // A refusal caused by something other than a forgery or an uncovered replayable row.
  var refusedForExpired: bool
  var acceptedForged: bool
  var replayedUncovered: bool

  def expired(r: int -> str, e: int, c: int): bool = r.get(e) == "expiring" and e <= c - W
  def replayable(r: int -> str, e: int): bool = r.get(e) == "rebase" or r.get(e) == "review"

  def exempts(rl: str): bool = rl == "exempt" or rl == "fixed" or rl == "overExempt"
  def links(rl: str): bool = rl == "links" or rl == "linksCoupled" or rl == "fixed" or rl == "overExempt"

  // Anchors the census demands.
  def demanded(rl: str, r: int -> str, c: int): Set[int] =
    r.keys().filter(e =>
      if (rl == "overExempt") not(expired(r, e, c) or (replayable(r, e) and e <= c - W))
      else not(exempts(rl) and expired(r, e, c)))

  // Anchors the certificate authenticated.
  def covered(rl: str, g: Set[int], c: int): Set[int] =
    Set(0, c, c - 1).union(g).union(if (links(rl)) g.map(e => e - 1) else Set())

  // The three newest generations are the active head and its two bases: never eligible.
  def top(g: Set[int]): Set[int] = g.filter(e => g.filter(f => f > e).size() < TOP)
  def minOf(s: Set[int]): int = s.fold(MAX_E + 1, (m, e) => if (e < m) e else m)
  def retire(g: Set[int]): Set[int] = if (g.size() > CAP) g.exclude(Set(minOf(g.exclude(top(g))))) else g

  def lawPasses(rl: str, r: int -> str, g: Set[int], c: int): bool =
    rl == "unverified" or demanded(rl, r, c).forall(d => covered(rl, g, c).contains(d))

  // The law at a lull or install.
  action certify = {
    val ok = rule == "unverified" or (lawPasses(rule, rows, gens, current) and forged < 0)
    val excused = forged >= 0 or rows.keys().exists(e => replayable(rows, e) and not(covered(rule, gens, current).contains(e)))
    all {
      refused' = (refused or not(ok)),
      refusedForExpired' = (refusedForExpired or (not(ok) and not(excused))),
      acceptedForged' = (acceptedForged or (ok and forged >= 0)),
      replayedUncovered' = replayedUncovered,
      rule' = rule, current' = current, gens' = gens, rows' = rows, forged' = forged,
    }
  }

  // A replayable row is replayed at its anchor. It runs only while the room is not refused and this
  // epoch's certificate passes, and it consumes the row.
  action replay(e: int): bool = all {
    rows.keys().contains(e),
    replayable(rows, e),
    not(refused),
    lawPasses(rule, rows, gens, current),
    replayedUncovered' = (replayedUncovered or not(covered(rule, gens, current).contains(e))),
    rows' = rows.keys().exclude(Set(e)).mapBy(k => rows.get(k)),
    refused' = refused, refusedForExpired' = refusedForExpired, acceptedForged' = acceptedForged,
    rule' = rule, current' = current, gens' = gens, forged' = forged,
  }

  // The measured coupling: after the roll, every expired row is still covered.
  def coupled(rl: str, r: int -> str, g: Set[int], c: int): bool =
    rl != "linksCoupled" or r.keys().forall(e => not(expired(r, e, c + 1)) or covered(rl, retire(g.union(Set(c + 1))), c + 1).contains(e))

  action roll = all {
    current < MAX_E,
    coupled(rule, rows, gens, current),
    current' = current + 1,
    gens' = retire(gens.union(Set(current + 1))),
    rule' = rule, rows' = rows, forged' = forged,
    refused' = refused, refusedForExpired' = refusedForExpired, acceptedForged' = acceptedForged,
    replayedUncovered' = replayedUncovered,
  }

  action hold(kind: str): bool = all {
    current > 0,
    not(rows.keys().contains(current)),
    kind != "review" or rows.keys().forall(e => rows.get(e) != "review"),
    rows' = rows.put(current, kind),
    rule' = rule, current' = current, gens' = gens, forged' = forged,
    refused' = refused, refusedForExpired' = refusedForExpired, acceptedForged' = acceptedForged,
    replayedUncovered' = replayedUncovered,
  }

  // Retirement reaches an expired row at some later point (never before expiry).
  action resolve(e: int): bool = all {
    rows.keys().contains(e),
    expired(rows, e, current),
    rows' = rows.keys().exclude(Set(e)).mapBy(k => rows.get(k)),
    rule' = rule, current' = current, gens' = gens, forged' = forged,
    refused' = refused, refusedForExpired' = refusedForExpired, acceptedForged' = acceptedForged,
    replayedUncovered' = replayedUncovered,
  }

  // The adversary names an anchor at an epoch with a digest no owner signed.
  action forge(e: int): bool = all {
    forged < 0,
    forged' = e,
    rule' = rule, current' = current, gens' = gens, rows' = rows,
    refused' = refused, refusedForExpired' = refusedForExpired, acceptedForged' = acceptedForged,
    replayedUncovered' = replayedUncovered,
  }

  action initWith(r: str): bool = all {
    rule' = r,
    current' = 0,
    gens' = Set(),
    rows' = Map(),
    forged' = -1,
    refused' = false,
    refusedForExpired' = false,
    acceptedForged' = false,
    replayedUncovered' = false,
  }
  action init = initWith("fixed")
  action initBefore = initWith("before")
  action initLinks = initWith("links")
  action initLinksCoupled = initWith("linksCoupled")
  action initExempt = initWith("exempt")
  action initOverExempt = initWith("overExempt")
  action initUnverified = initWith("unverified")

  action honestStep = any {
    roll,
    certify,
    nondet k = Set("expiring", "rebase", "review").oneOf()
    hold(k),
    nondet e = 1.to(MAX_E).oneOf()
    resolve(e),
    nondet e = 1.to(MAX_E).oneOf()
    replay(e),
  }
  action step = any {
    honestStep,
    nondet e = 1.to(MAX_E).oneOf()
    forge(e),
  }

  val noForgedAccepted = not(acceptedForged)
  val replaySafe = not(replayedUncovered)
  val refusedOnlyForReplayable = not(refusedForExpired)

  // Witnesses: the measured manual-review RED (a review row at epoch 2, a lull at epoch 7), the
  // silent Writer (expired rows lingering at every epoch), and the broken controls.
  action reviewRow(r: str): bool =
    initWith(r).then(roll).then(roll).then(hold("review"))
      .then(roll).then(roll).then(roll).then(roll).then(roll).then(certify)
  run beforeRefusesReviewTest = reviewRow("before").then(all { assert(refused), certify })
  run linksCoversReviewOnceTest = reviewRow("links").then(all { assert(not(refused)), roll }).then(certify)
    .then(all { assert(refused and not(refusedForExpired)), certify })
  action silentWriter(r: str): bool =
    initWith(r).then(roll).then(hold("expiring")).then(roll).then(hold("expiring")).then(roll).then(hold("expiring"))
      .then(roll).then(hold("expiring")).then(roll).then(hold("expiring")).then(roll).then(hold("expiring"))
      .then(roll).then(hold("expiring")).then(roll).then(hold("expiring")).then(certify)
  run linksRefusesSilentWriterTest = silentWriter("links").then(all { assert(refusedForExpired), certify })
  // Under the coupling the silent Writer cannot outrun coverage: the roll to 7 waits for row 1.
  run linksCoupledWaitsForRetirementTest =
    initWith("linksCoupled").then(roll).then(hold("expiring")).then(roll).then(roll).then(roll).then(roll).then(roll)
      .then(all { assert(not(coupled(rule, rows, gens, current))), resolve(1) }).then(roll).then(certify)
      .then(all { assert(not(refused)), certify })
  run fixedKeepsSilentWriterTest = silentWriter("fixed").then(all { assert(not(refused)), certify })
  run overExemptReplaysUncoveredTest =
    initWith("overExempt").then(roll).then(hold("rebase")).then(roll).then(roll).then(roll).then(roll)
      .then(roll).then(roll).then(roll).then(certify).then(replay(1))
      .then(all { assert(replayedUncovered), certify })
  run fixedRefusesUncoveredRebaseTest =
    initWith("fixed").then(roll).then(hold("rebase")).then(roll).then(roll).then(roll).then(roll)
      .then(roll).then(roll).then(roll).then(certify)
      .then(all { assert(refused and not(refusedForExpired) and not(replayedUncovered)), certify })
  run unverifiedAcceptsForgedTest = initWith("unverified").then(roll).then(forge(1)).then(certify)
    .then(all { assert(acceptedForged), certify })
  run fixedRefusesForgedTest = initWith("fixed").then(roll).then(roll).then(forge(5)).then(certify)
    .then(all { assert(refused and not(acceptedForged)), certify })
}
