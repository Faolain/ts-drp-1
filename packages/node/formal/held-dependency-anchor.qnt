// -*- mode: Bluespec; -*-
//
// Held dependency anchors against the recovery certificate's coverage.
//
// Three owners meet at one law (creator-closed-rollback-data acquireRecoveryRoleCertificate, native
// path):  requiredDependencyAnchors.every(required => dependencyAnchors.some(same epoch and digest)).
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
// A held row is one of two kinds. An "expiring" row is a displaced own row. Past the own-row window
// W (V3_SETTLEMENT_OWN_WINDOW_EPOCHS) it is resolved as expired on the creator's signed exclusion and
// is never replayed, but it can stay held until retirement reaches it. A "review" row is a pending
// manual-review source. It is held until the user decides, and its replay needs its historical
// anchor.
//
// Rules:
//   before     the census demands every held row's anchor; coverage is generations only; retirement
//              is oldest-first.
//   links      as before, plus coverage counts predecessor links.
//   exempt     the census does not demand an expired row's anchor; coverage as before.
//   protect    links + the retirement below, without exempt.
//   fixed      exempt + links + retirement keeps the generation whose trust or link is the last one
//              covering a demanded anchor, while another eligible generation exists.
//   unverified broken control: coverage accepts every demanded anchor.
//
// Properties: noForgedAccepted (coverage never accepts an anchor it did not authenticate) and
// honestNeverRefused (the law refuses only when the adversary has injected a forged anchor).
module heldDependencyAnchor {
  pure val MAX_E = 10
  pure val CAP = 5
  pure val W = 4
  pure val TOP = 3

  var rule: str
  var current: int
  // Retained native generations, by epoch (one per adjacent install). The pin is covered apart.
  var gens: Set[int]
  // Held rows: epoch -> kind ("expiring" | "review").
  var rows: int -> str
  // A forged dependency anchor injected by the adversary (epoch), or -1.
  var forged: int
  var refused: bool
  var acceptedForged: bool

  def expired(e: int, c: int): bool = e <= c - W

  // Anchors the census demands.
  def demanded(r: str, held: int -> str, c: int): Set[int] =
    held.keys().filter(e => not(r == "exempt" or r == "fixed") or held.get(e) == "review" or not(expired(e, c)))

  // Anchors the certificate authenticated.
  def links(r: str): bool = r == "links" or r == "protect" or r == "fixed"
  def covered(r: str, g: Set[int], c: int): Set[int] =
    Set(0, c, c - 1).union(g).union(if (links(r)) g.map(e => e - 1) else Set())

  def coveredBy(r: str, g: Set[int], c: int, e: int): bool = covered(r, g, c).contains(e)

  // The three newest generations are the active head and its two bases: never eligible.
  def top(g: Set[int]): Set[int] = g.filter(e => g.filter(f => f > e).size() < TOP)
  def eligible(g: Set[int]): Set[int] = g.exclude(top(g))

  def minOf(s: Set[int]): int = s.fold(MAX_E + 1, (m, e) => if (e < m) e else m)

  // A generation is needed if removing it leaves some demanded anchor uncovered.
  def needed(r: str, g: Set[int], c: int, held: int -> str, e: int): bool =
    demanded(r, held, c).exists(d => coveredBy(r, g, c, d) and not(coveredBy(r, g.exclude(Set(e)), c, d)))

  def victim(r: str, g: Set[int], c: int, held: int -> str): int =
    val free = eligible(g).filter(e => not(needed(r, g, c, held, e)))
    if ((r == "fixed" or r == "protect") and free.size() > 0) minOf(free) else minOf(eligible(g))

  def retire(r: str, g: Set[int], c: int, held: int -> str): Set[int] =
    if (g.size() > CAP) g.exclude(Set(victim(r, g, c, held))) else g

  // The law at a lull or install.
  action certify = {
    val genuineOk = demanded(rule, rows, current).forall(e => coveredBy(rule, gens, current, e))
    val forgedOk = forged < 0 or rule == "unverified"
    val ok = rule == "unverified" or (genuineOk and forgedOk)
    all {
      refused' = (refused or not(ok)),
      acceptedForged' = (acceptedForged or (ok and forged >= 0)),
      rule' = rule, current' = current, gens' = gens, rows' = rows, forged' = forged,
    }
  }

  action roll = all {
    current < MAX_E,
    val c = current + 1
    all {
      current' = c,
      gens' = retire(rule, gens.union(Set(c)), c, rows),
      rule' = rule, rows' = rows, forged' = forged, refused' = refused, acceptedForged' = acceptedForged,
    }
  }

  action hold(kind: str): bool = all {
    current > 0,
    not(rows.keys().contains(current)),
    kind == "expiring" or rows.keys().forall(e => rows.get(e) != "review"),
    rows' = rows.put(current, kind),
    rule' = rule, current' = current, gens' = gens, forged' = forged, refused' = refused, acceptedForged' = acceptedForged,
  }

  // Retirement reaches an expired row at some later point (never before expiry).
  action resolve(e: int): bool = all {
    rows.keys().contains(e),
    rows.get(e) == "expiring",
    expired(e, current),
    rows' = rows.keys().exclude(Set(e)).mapBy(k => rows.get(k)),
    rule' = rule, current' = current, gens' = gens, forged' = forged, refused' = refused, acceptedForged' = acceptedForged,
  }

  // The adversary names an anchor at an epoch with a digest no owner signed.
  action forge(e: int): bool = all {
    forged < 0,
    rows' = rows, forged' = e,
    rule' = rule, current' = current, gens' = gens, refused' = refused, acceptedForged' = acceptedForged,
  }

  action initWith(r: str): bool = all {
    rule' = r,
    current' = 0,
    gens' = Set(),
    rows' = Map(),
    forged' = -1,
    refused' = false,
    acceptedForged' = false,
  }
  action init = initWith("fixed")
  action initBefore = initWith("before")
  action initLinks = initWith("links")
  action initExempt = initWith("exempt")
  action initProtect = initWith("protect")
  action initUnverified = initWith("unverified")

  action honestStep = any {
    roll,
    certify,
    nondet k = Set("expiring", "review").oneOf()
    hold(k),
    nondet e = 1.to(MAX_E).oneOf()
    resolve(e),
  }
  action step = any {
    honestStep,
    nondet e = 1.to(MAX_E).oneOf()
    forge(e),
  }

  val noForgedAccepted = not(acceptedForged)
  val honestNeverRefused = refused implies forged >= 0

  // Witnesses: the measured probe (a review row at epoch 2, a lull at epoch 7), and an expired row
  // that outlives its generation's successor.
  action reviewRow(r: str): bool =
    initWith(r).then(roll).then(roll).then(hold("review"))
      .then(roll).then(roll).then(roll).then(roll).then(roll).then(certify)
  run beforeRefusesReviewTest = reviewRow("before").then(all { assert(refused), certify })
  run linksCoversReviewOnceTest = reviewRow("links").then(all { assert(not(refused)), roll }).then(certify)
    .then(all { assert(refused), certify })
  run fixedKeepsReviewTest = reviewRow("fixed").then(roll).then(roll).then(roll).then(certify)
    .then(all { assert(not(refused)), certify })
  action expiringRow(r: str): bool =
    initWith(r).then(roll).then(hold("expiring"))
      .then(roll).then(roll).then(roll).then(roll).then(roll).then(roll).then(roll).then(certify)
  run exemptCoversExpiredTest = expiringRow("exempt").then(all { assert(not(refused)), certify })
  run linksRefusesLingeringExpiredTest = expiringRow("links").then(all { assert(refused), certify })
  // Several expired rows linger at distinct old epochs: protection alone runs out of generations.
  run protectRunsOutTest = initWith("protect").then(roll).then(hold("expiring")).then(roll).then(roll).then(hold("expiring"))
    .then(roll).then(roll).then(hold("expiring")).then(roll).then(roll).then(roll).then(roll).then(roll).then(certify)
    .then(all { assert(refused), certify })
  run unverifiedAcceptsForgedTest = initWith("unverified").then(roll).then(forge(1)).then(certify)
    .then(all { assert(acceptedForged), certify })
  run fixedRefusesForgedTest = initWith("fixed").then(roll).then(roll).then(forge(9)).then(certify)
    .then(all { assert(refused and not(acceptedForged)), certify })
}
