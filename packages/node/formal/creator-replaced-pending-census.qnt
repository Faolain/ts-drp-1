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
