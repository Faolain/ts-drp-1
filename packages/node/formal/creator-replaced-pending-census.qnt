// MODEL (fix/lost-twice-replacement-dependency): the recovery dependency census, a never-published link
// of a replacement chain, and the custody that keeps an aged link authenticated.
//
// One member move M on a bad link. Its first link L0 is signed in epoch 1 and never published (pending).
// While the newest link is displaced (its epoch closed without it), a member install replaces it: the
// newest link's plan entry becomes a completed `rebase` naming the new link, and the new link is signed in
// the installed epoch; it may be published or lost. The close of a link's own epoch takes custody of an
// unadmitted current link (an open, unresolved entry with its context) or proves it committed.
//
// Every install first seals the recovery dependency census over the member's retained rows. Shipped
// rule: a displaced link that was never published passes only as open work, a committed link, or under
// the creator's signed frontier; a completed link (its entry names a replacement) that is still pending
// has none of these and the census refuses it: the install fails ("outbox-classification:<seq>:
// displaced:pending"). Proposed rule (1): a completed link passes as the dependency of its replacement
// when that replacement itself passes (current, open, committed, or completed with a passing
// replacement): its intents are carried by the chain's live tail, and it is never re-offered (a completed
// entry is never replaced again).
//
// Custody age (2). A pending completed link signed in epoch e authenticates through the census plane's
// displaced adjacency only at the install of epoch e + ADJACENCY at most; after that only its retained
// source contract (custody: its entry's displaced-plane context) authenticates it. Custody is taken at
// the MEMBER's close of its plane P, which runs inside its next install (before that install's census):
// - rule `every-close` (this fix): a completed link of epoch P - 1 whose replacement is not committed;
// - always (shipped): when the install is not adjacent (target > P + 1), the open newest link of epoch P
//   (application custody of unresolved work, kept when it is replaced).
// Rule `none` (before the fix; F2 adds custody only at a removing close, which this model has none of):
// an aged pending completed link of an adjacent chain cannot be authenticated and the census refuses it.
//
// Not modelled: the creator's signed frontier coverage beyond "a later link is committed" (a member whose
// later own row is admitted gets an admitted sequence covering L0, which the shipped census accepts as
// terminally covered); a removed author's frontier (F2).
//
// Properties: noStall (no install is refused by the census), exactlyOnce (M admitted at most once, only
// through its newest link), noReoffer (a completed link has exactly one replacement), authenticated
// (every pending completed link a passing census accepted was in custody, adjacent, or covered).
//
// Checked (bx sandbox, run q-05; .logs/realtime-resume-2026-11-10/anchor/lost-twice): quint test 5/5;
// simulation (20000 samples, 14 steps, seed 4711): proposed safety and noStall hold; shipped noStall is
// violated (expected: the lost-twice stall), shipped safety holds; rule (1) without custody violates
// noStall (expected: an aged link) and keeps safety; Apalache 0.56.1 (JDK 17), 10 steps, proposed
// `safety and noStall`: no violation.
module creatorReplacedPendingCensus {
  pure val MAX_EPOCH = 6
  pure val ADJACENCY = 1

  type Link = { epoch: int, published: bool, state: str, custody: bool } // state: current | open | completed | committed

  var epoch: int        // creator's epoch
  var memberEpoch: int  // member's installed epoch
  var links: List[Link] // the move's chain, root first
  var admitted: int
  var stalled: bool     // an install refused by the census
  var proposed: bool    // census rule (1) under check
  var custodyRule: str  // "every-close" | "none"
  var unauthenticated: bool // a passing census accepted a link it could not authenticate

  action initWith(rule: bool, custodyAt: str): bool = all {
    epoch' = 1, memberEpoch' = 1, links' = [{ epoch: 1, published: false, state: "current", custody: false }],
    admitted' = 0, stalled' = false, proposed' = rule, custodyRule' = custodyAt, unauthenticated' = false,
  }
  action initShipped = initWith(false, "none")
  action initChainOnly = initWith(true, "none")
  action initProposed = initWith(true, "every-close")

  def newest(ls: List[Link]): Link = ls[ls.length() - 1]
  def coveredAt(ls: List[Link], i: int): bool = ls.indices().exists(k => k > i and ls[k].state == "committed")

  // Whether the census can authenticate pending completed link i at the install of epoch t.
  def authenticAt(ls: List[Link], i: int, t: int): bool =
    ls[i].custody or t - ls[i].epoch <= ADJACENCY or coveredAt(ls, i)

  // Census acceptance of link i (the tail first, so a completed link can ask its replacement).
  def passes(ls: List[Link], rule: bool, t: int): bool =
    ls.indices().fold(true, (ok, i) => ok and passesAt(ls, i, rule, t))
  def passesAt(ls: List[Link], i: int, rule: bool, t: int): bool = {
    val l = ls[i]
    l.state == "current" or l.state == "open" or l.state == "committed" or
    (l.state == "completed" and (l.published or coveredAt(ls, i) or
      (rule and authenticAt(ls, i, t) and tailPasses(ls, i + 1))))
  }
  // The tail of a chain from link j on: every link after a completed one is current, open, committed or
  // completed again, so the replacement passes iff the first non-completed link after it is live.
  def tailPasses(ls: List[Link], j: int): bool =
    ls.indices().filter(k => k >= j).fold(true, (ok, k) =>
      ok and (ls[k].state == "current" or ls[k].state == "open" or ls[k].state == "committed" or
              (ls[k].state == "completed" and k + 1 < ls.length())))
  // The safety witness: what the census accepted, judged against authentication alone.
  def acceptsUnauthenticated(ls: List[Link], t: int): bool =
    ls.indices().exists(i => ls[i].state == "completed" and not(ls[i].published) and not(authenticAt(ls, i, t)))

  // The newest link reaches the creator inside its own epoch.
  action deliver = all {
    links.length() > 0, newest(links).state == "current", newest(links).epoch == epoch, memberEpoch == epoch,
    admitted' = admitted + 1,
    links' = links.replaceAt(links.length() - 1, { ...newest(links), published: true, state: "committed" }),
    epoch' = epoch, memberEpoch' = memberEpoch, stalled' = stalled, proposed' = proposed,
    custodyRule' = custodyRule, unauthenticated' = unauthenticated,
  }
  // The creator closes its epoch: an unadmitted newest link of that epoch is now displaced (open).
  action roll = all {
    epoch < MAX_EPOCH, not(stalled),
    epoch' = epoch + 1,
    links' = if (newest(links).state == "current" and newest(links).epoch == epoch)
      links.replaceAt(links.length() - 1, { ...newest(links), state: "open" }) else links,
    memberEpoch' = memberEpoch, admitted' = admitted, stalled' = stalled, proposed' = proposed,
    custodyRule' = custodyRule, unauthenticated' = unauthenticated,
  }
  // The member's close of plane p into target t: the custody it writes (see the header).
  def closeCustody(ls: List[Link], p: int, t: int, rule: str): List[Link] =
    // Each index updates only its own link (states unchanged), so the set fold order is irrelevant.
    ls.indices().fold(ls, (acc, i) =>
      if (rule == "every-close" and acc[i].state == "completed" and not(acc[i].custody) and acc[i].epoch == p - 1 and
          i + 1 < acc.length() and acc[i + 1].state != "committed")
        acc.replaceAt(i, { ...acc[i], custody: true })
      else if (t > p + 1 and i == acc.length() - 1 and acc[i].state == "open" and acc[i].epoch == p)
        acc.replaceAt(i, { ...acc[i], custody: true })
      else acc)
  // A member install: its close's custody, the census, then the displaced open newest link is replaced
  // (published or lost). A refused install keeps the custody its close already committed.
  action install = all {
    memberEpoch < epoch, not(stalled),
    val closed = closeCustody(links, memberEpoch, epoch, custodyRule)
    if (not(passes(closed, proposed, epoch))) all {
      stalled' = true, links' = closed, memberEpoch' = memberEpoch,
      epoch' = epoch, admitted' = admitted, proposed' = proposed, custodyRule' = custodyRule,
      unauthenticated' = unauthenticated,
    } else nondet published = Set(true, false).oneOf() all {
      memberEpoch' = epoch, stalled' = false,
      unauthenticated' = (unauthenticated or acceptsUnauthenticated(closed, epoch)),
      links' = if (newest(closed).state == "open")
        closed.replaceAt(closed.length() - 1, { ...newest(closed), state: "completed" })
              .append({ epoch: epoch, published: published, state: "current", custody: false })
        else closed,
      epoch' = epoch, admitted' = admitted, proposed' = proposed, custodyRule' = custodyRule,
    },
  }
  action step = any { deliver, roll, install }

  val noStall = not(stalled)
  val exactlyOnce = admitted <= 1 and
    links.indices().forall(i => links[i].state != "committed" or i == links.length() - 1)
  val noReoffer = links.indices().forall(i => links[i].state != "completed" or i + 1 < links.length())
  val authenticated = not(unauthenticated)
  val safety = exactlyOnce and noReoffer and authenticated

  action unchangedAll = all {
    epoch' = epoch, memberEpoch' = memberEpoch, links' = links, admitted' = admitted,
    stalled' = stalled, proposed' = proposed, custodyRule' = custodyRule, unauthenticated' = unauthenticated,
  }

  // The lost-twice trace: L0 never published, its replacement L1 published but never received. The
  // shipped census refuses the epoch-3 install (L0 is completed and pending).
  run shippedLostTwiceStallsTest = initShipped
    .then(roll).then(install).then(roll).then(install)
    .then(all { assert(stalled), assert(links.length() == 2), unchangedAll })
  // The same trace under the proposed rules installs, replaces L1 once more, and the move lands once.
  run proposedLostTwiceLandsOnceTest = initProposed
    .then(roll).then(install).then(roll).then(install)
    .then(all { assert(not(stalled)), assert(links.length() == 3), unchangedAll })
    .then(deliver).then(roll).then(install)
    .then(all { assert(admitted == 1), assert(safety), assert(noStall), unchangedAll })
  // The removed-author shape: L0 pending and completed, its replacement committed in its epoch.
  run proposedCommittedReplacementTest = initProposed
    .then(roll).then(install).then(deliver).then(roll).then(install)
    .then(all { assert(not(stalled)), assert(admitted == 1), unchangedAll })
  // Without custody (rule 1 alone), L0 is past the displaced adjacency at the epoch-3 install and the chain
  // rule cannot authenticate it: it must refuse (and does), so custody (2) is necessary.
  run chainOnlyStallsWithoutCustodyTest = initChainOnly
    .then(roll).then(install).then(roll).then(install)
    .then(all { assert(stalled), assert(authenticated), unchangedAll })
  // With custody at every close, L0 is in custody from the member's close of epoch 2 (inside the epoch-3
  // install), still authenticated at the epoch-4 install; L3 lands exactly once.
  run proposedAgedLandsOnceTest = initProposed
    .then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(all { assert(not(stalled)), assert(links[0].custody), assert(links.length() == 4), unchangedAll })
    .then(deliver).then(roll).then(install)
    .then(all { assert(admitted == 1), assert(safety), assert(noStall), unchangedAll })
}

// MODEL (fix/creator-replaced-source-resolution, design (b) "replacement committed" basis): releasing a
// replaced, never-published source from retention once its replacement is proven committed.
//
// Two member moves M (0) and N (1) with EQUAL intents (the same signed operations), each a chain of links
// as above: L0 signed in epoch 1 and never received; each member install replaces a displaced (open)
// newest link (its entry becomes a completed `rebase` claiming the new link, signed in the installed
// epoch); the newest link may reach the creator inside its own epoch (committed). The creator may revoke
// the member: a removed author signs nothing more, and its plan's author fence is withheld for good.
//
// Every install ends with the retention release of the completed links (pending, never published):
// - rule `fence` (shipped): a completed link whose claimed replacement is committed is released under the
//   plan's current author fence only; a removed author has none, so the link is held forever (the
//   withhold stall, p6);
// - rule `committed` (b): released when its single claimed replacement is committed (the creator-signed
//   completion proof) and that replacement is claimed by exactly this one link (unique claim), removed
//   or not;
// - control `committedNoClaim`: the committed basis without the unique-claim check;
// - control `replaced`: released as soon as the replacement exists (committed or not).
// `tamper`: a forged plan points a completed link of N at M's committed link (equal intents, so the link's
// operation check alone accepts it: only the unique claim tells them apart).
//
// Properties: neverReleaseAdmissible (a released link can never be admitted: its own epoch is closed and
// it is not the chain's current link), noLostMove (a link is released only once its move is admitted),
// noDoubleCredit (a committed link releases at most one source), intentsExactlyOnce (all three, and each
// move admitted at most once), noWithholdStall (no completed link whose replacement is committed is held
// past the retention window; asked of untampered plans only: a tampered plan is refused, so the native
// install fails closed and its rows stay held).
//
// Local-store-integrity residual: release of own unlanded move under raw store forgery (accepted,
// coordinator 2026-11-12; docs/realtime-latency row 84). The link step's checks a forged claim must pass
// are modelled (a replacement is admitted in a later epoch than its source; unique claim). With M a fresh
// move issued later with N's exact intents (initCommittedTamperLate), a forged entry naming M's unclaimed
// root as N's replacement passes them, and N's source is released while N never landed
// (committedTamperLateOriginalTest). It needs a raw edit of the device's own store and only loses the
// device's own move (no peer sees a duplicate); a signed source backlink on same-plane replacements is
// the follow-up protocol/format track.
module creatorReplacedSourceRelease {
  pure val MAX_EPOCH = 6
  pure val WINDOW = 2
  pure val MOVES = Set(0, 1)

  // state: current | open | completed | committed; (repl, target): the claimed replacement link
  type Link = { epoch: int, state: str, repl: int, target: int, released: bool }

  var epoch: int
  var memberEpoch: int
  var chains: int -> List[Link]
  var removed: bool
  var rule: str
  var tamperable: bool
  var lateOriginal: bool // M is a fresh move, issued in a later epoch (its root is never a replacement)

  pure val L0 = { epoch: 1, state: "current", repl: -1, target: -1, released: false }
  action initFull(r: str, t: bool, late: bool): bool = all {
    epoch' = 1, memberEpoch' = 1, chains' = Map(0 -> (if (late) List() else [L0]), 1 -> [L0]), removed' = false, rule' = r,
    tamperable' = t, lateOriginal' = late,
  }
  action initWith(r: str, t: bool): bool = initFull(r, t, false)
  action initShipped = initWith("fence", false)
  action initCommitted = initWith("committed", false)
  action initCommittedTamper = initWith("committed", true)
  action initNoClaimTamper = initWith("committedNoClaim", true)
  action initReplaced = initWith("replaced", false)
  // The residual: M issued fresh in a later epoch, with N's intents; a forged plan claims M's root for N.
  action initCommittedTamperLate = initFull("committed", true, true)

  def last(ls: List[Link]): Link = ls[ls.length() - 1]
  def claims(cs: int -> List[Link], m: int, k: int): int =
    MOVES.fold(0, (n, x) => n + cs.get(x).indices().filter(i => cs.get(x)[i].repl == m and cs.get(x)[i].target == k).size())
  def replacementCommitted(cs: int -> List[Link], l: Link): bool =
    l.target >= 0 and l.target < cs.get(l.repl).length() and cs.get(l.repl)[l.target].state == "committed"
  def releasable(cs: int -> List[Link], l: Link, r: str, gone: bool): bool =
    l.state == "completed" and not(l.released) and l.target >= 0 and
    (if (r == "replaced") true
     else if (r == "committedNoClaim") replacementCommitted(cs, l)
     else if (r == "committed") replacementCommitted(cs, l) and claims(cs, l.repl, l.target) == 1
     else replacementCommitted(cs, l) and claims(cs, l.repl, l.target) == 1 and not(gone))
  def release(cs: int -> List[Link], r: str, gone: bool): int -> List[Link] =
    MOVES.mapBy(m => cs.get(m).indices().fold(cs.get(m), (acc, i) =>
      if (releasable(cs, cs.get(m)[i], r, gone)) acc.replaceAt(i, { ...acc[i], released: true }) else acc))

  // The newest link of move m reaches the creator inside its own epoch.
  action deliverMove(m: int): bool = all {
    not(removed), chains.get(m).length() > 0, last(chains.get(m)).state == "current", last(chains.get(m)).epoch == epoch, memberEpoch == epoch,
    chains' = chains.set(m, chains.get(m).replaceAt(chains.get(m).length() - 1, { ...last(chains.get(m)), state: "committed" })),
    epoch' = epoch, memberEpoch' = memberEpoch, removed' = removed, rule' = rule, tamperable' = tamperable, lateOriginal' = lateOriginal,
  }
  action deliver = nondet m = MOVES.oneOf() deliverMove(m)
  // The creator closes its epoch (the member follows every epoch): an unadmitted newest link is displaced.
  action roll = all {
    epoch < MAX_EPOCH, memberEpoch == epoch,
    epoch' = epoch + 1,
    chains' = MOVES.mapBy(m => if (chains.get(m).length() > 0 and last(chains.get(m)).state == "current" and last(chains.get(m)).epoch == epoch)
      chains.get(m).replaceAt(chains.get(m).length() - 1, { ...last(chains.get(m)), state: "open" }) else chains.get(m)),
    memberEpoch' = memberEpoch, removed' = removed, rule' = rule, tamperable' = tamperable, lateOriginal' = lateOriginal,
  }
  // A member install: a member replaces each displaced newest link (a removed author signs nothing), then
  // the retention release.
  action install = all {
    memberEpoch < epoch,
    val replaced = MOVES.mapBy(m => if (not(removed) and chains.get(m).length() > 0 and last(chains.get(m)).state == "open")
      chains.get(m).replaceAt(chains.get(m).length() - 1, { ...last(chains.get(m)), state: "completed", repl: m,
        target: chains.get(m).length() }).append({ epoch: epoch, state: "current", repl: -1, target: -1, released: false })
      else chains.get(m))
    all { chains' = release(replaced, rule, removed), memberEpoch' = epoch },
    epoch' = epoch, removed' = removed, rule' = rule, tamperable' = tamperable, lateOriginal' = lateOriginal,
  }
  action revoke = all {
    not(removed), removed' = true,
    epoch' = epoch, memberEpoch' = memberEpoch, chains' = chains, rule' = rule, tamperable' = tamperable, lateOriginal' = lateOriginal,
  }
  // A forged plan: a completed, unreleased link of N claims M's committed link instead of its own.
  // A fresh move M, issued by the member in the current epoch (late-original shape only).
  action issue = all {
    lateOriginal, not(removed), chains.get(0).length() == 0, memberEpoch == epoch, epoch > 1,
    chains' = chains.set(0, [{ epoch: epoch, state: "current", repl: -1, target: -1, released: false }]),
    epoch' = epoch, memberEpoch' = memberEpoch, removed' = removed, rule' = rule, tamperable' = tamperable,
    lateOriginal' = lateOriginal,
  }
  action tamper = nondet i = chains.get(1).indices().oneOf() nondet k = chains.get(0).indices().union(Set(-1)).oneOf() all {
    k >= 0,
    // The link step's own checks: a replacement is admitted in a later epoch than its source.
    tamperable, chains.get(1)[i].state == "completed", not(chains.get(1)[i].released), chains.get(0)[k].state == "committed",
    chains.get(0)[k].epoch > chains.get(1)[i].epoch,
    chains' = chains.set(1, chains.get(1).replaceAt(i, { ...chains.get(1)[i], repl: 0, target: k })),
    tamperable' = false, lateOriginal' = lateOriginal, epoch' = epoch, memberEpoch' = memberEpoch, removed' = removed, rule' = rule,
  }
  action step = any { deliver, roll, install, revoke, tamper, issue }

  def admittedOf(m: int): bool = chains.get(m).indices().exists(i => chains.get(m)[i].state == "committed")
  def links: Set[{ m: int, i: int }] = MOVES.map(m => chains.get(m).indices().map(i => { m: m, i: i })).flatten()
  val neverReleaseAdmissible = links.forall(p => not(chains.get(p.m)[p.i].released) or
    (chains.get(p.m)[p.i].state != "current" and chains.get(p.m)[p.i].epoch < epoch))
  val noLostMove = links.forall(p => not(chains.get(p.m)[p.i].released) or admittedOf(p.m))
  val noDoubleCredit = links.forall(p => chains.get(p.m)[p.i].state != "committed" or
    links.filter(q => chains.get(q.m)[q.i].released and chains.get(q.m)[q.i].repl == p.m and
      chains.get(q.m)[q.i].target == p.i).size() <= 1)
  val atMostOnce = MOVES.forall(m => chains.get(m).indices().filter(i => chains.get(m)[i].state == "committed").size() <= 1)
  val intentsExactlyOnce = noLostMove and noDoubleCredit and atMostOnce
  val safety = neverReleaseAdmissible and intentsExactlyOnce
  val noWithholdStall = links.forall(p => not(chains.get(p.m)[p.i].state == "completed" and not(chains.get(p.m)[p.i].released) and
    replacementCommitted(chains, chains.get(p.m)[p.i]) and epoch - chains.get(p.m)[p.i].epoch > WINDOW))

  action unchangedAll = all {
    epoch' = epoch, memberEpoch' = memberEpoch, chains' = chains, removed' = removed, rule' = rule, tamperable' = tamperable,
    lateOriginal' = lateOriginal,
  }
  def rel(m: int, i: int): bool = chains.get(m)[i].released
  // The native withhold shape: M's L0 replaced on the adjacent install, its replacement committed, the
  // member revoked, then three more epochs. Shipped: L0 is held for good (the withhold stall).
  run shippedWithholdStallsTest = initShipped
    .then(roll).then(install).then(deliverMove(0)).then(revoke)
    .then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(all { assert(not(rel(0, 0))), assert(not(noWithholdStall)), assert(safety), unchangedAll })
  // Before the revocation the plan's fence releases it (shipped).
  run shippedFenceReleasesMemberTest = initShipped
    .then(roll).then(install).then(deliverMove(0)).then(roll).then(install)
    .then(all { assert(rel(0, 0)), assert(safety), unchangedAll })
  // (b): the committed replacement releases L0 of the removed author; N's L0 (its replacement displaced,
  // never committed) stays held; nothing stalls.
  run committedReleasesRemovedTest = initCommitted
    .then(roll).then(install).then(deliverMove(0)).then(revoke)
    .then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(all { assert(rel(0, 0)), assert(not(rel(1, 0))), assert(noWithholdStall), assert(safety), unchangedAll })
  // Equal intents, a forged claim of M's committed link by N's L0: the unique claim refuses both releases.
  run committedTamperRefusesTest = initCommittedTamper
    .then(roll).then(install).then(deliverMove(0)).then(tamper).then(roll).then(install)
    .then(all { assert(not(rel(0, 0))), assert(not(rel(1, 0))), assert(safety), unchangedAll })
  // Without the unique claim the forged release credits M's move to N: intents are not counted once.
  run noClaimTamperDoubleCreditsTest = initNoClaimTamper
    .then(roll).then(install).then(deliverMove(0)).then(tamper).then(roll).then(install)
    .then(all { assert(rel(1, 0)), assert(not(intentsExactlyOnce)), unchangedAll })
  // RESIDUAL (documented, not closed by the link step): N's L0 is replaced, its replacement is lost too; M is
  // a fresh move issued in epoch 3 with N's exact intents and is committed. A forged plan entry naming M's
  // root as N's replacement passes every check the link step has for a non-portable replacement (later
  // epoch, unclaimed by any other entry, equal signed operations), and N's source is released while N
  // never landed. Only a signed backlink from the replacement to its source (a portable settlementSource)
  // tells them apart.
  run committedTamperLateOriginalTest = initCommittedTamperLate
    .then(roll).then(install).then(roll).then(install).then(issue).then(deliverMove(0)).then(tamper).then(roll).then(install)
    .then(all { assert(chains.get(1).indices().exists(i => rel(1, i))), assert(not(noLostMove)), unchangedAll })
  // Releasing on a mere replacement loses the move when the replacement is lost too.
  run replacedLosesMoveTest = initReplaced
    .then(roll).then(install)
    .then(all { assert(rel(0, 0)), assert(not(noLostMove)), unchangedAll })
}
