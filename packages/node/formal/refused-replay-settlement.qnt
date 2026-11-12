// MODEL (fix/refused-replay-settlement): a Writer's displaced move whose replay the room's admission
// refuses at the Writer's install.
//
// One Writer move M. Its chain of rows (links) starts with L0, signed in epoch 1. A link reaches the
// creator inside its own epoch and is admitted (deliver), or its epoch closes without it (roll: late,
// or refused at the creator's ingress; the creator signs no reason, so the Writer cannot tell which)
// and it is displaced ("open"). At the Writer's next install a displaced newest link is:
//   - past the settlement window (its chain's origin epoch <= epoch - D): expired with a durable
//     hand-back record (shipped window expiry, "expired");
//   - otherwise replayed: the drain derives its replacement and the Writer's own admission judges it on
//     the successor state (the application state bound, the room's admission policy). `refusable`
//     (nondet) is that judgement: the replay would be refused before signing.
//
// Variants:
//   shipped        a refused replay throws out of issueSettlement: the install fails (stall).
//   creatorDriven  the Writer does not judge replays: it signs every replay and lets the creator refuse
//                  it at ingress; the move is re-offered automatically each install until the window.
//   proposed       a refused replay settles its source as expire + handedBack {fromIntent, reason} with
//                  its hand-back records, in ONE plan write (atomic), and is never replayed again. With
//                  no free hand-back record (`full`, nondet) the source stays live (not expired, not
//                  replayed) and the install completes; the next install retries it. A SIGKILL at the
//                  plan write leaves either nothing (before the commit point: nothing was signed, the
//                  install did not complete, the next install re-judges) or the whole write (after).
//
// Chain composition (the lost-twice census, creator-replaced-pending-census.qnt): a "handedBack" link
// is a TERMINAL chain end, like "committed" and "expired": never followed by a link, never re-offered,
// not live work.
//
// Properties: exactlyOnce (M admitted at most once, and never both admitted and given back), noReoffer
// (no link follows a terminal one), noRefusedReoffer (a replay the Writer's admission refuses is never
// signed), listed (a given-back move is listed for the application in the same write), noStall.
module refusedReplaySettlement {
  pure val D = 4         // V3_SETTLEMENT_OWN_WINDOW_EPOCHS
  pure val MAX_EPOCH = 8

  type Link = { epoch: int, state: str } // current | open | completed | committed | handedBack | expired

  var epoch: int            // creator's epoch
  var memberEpoch: int      // Writer's installed epoch
  var links: List[Link]
  var admitted: int
  var listed: bool          // a durable hand-back record lists M for the application
  var stalled: bool
  var refusedReoffered: bool // a replay the Writer's admission would refuse was signed anyway
  var design: str

  action initWith(v: str): bool = all {
    epoch' = 1, memberEpoch' = 1, links' = [{ epoch: 1, state: "current" }], admitted' = 0,
    listed' = false, stalled' = false, refusedReoffered' = false, design' = v,
  }
  action initShipped = initWith("shipped")
  action initCreatorDriven = initWith("creatorDriven")
  action initProposed = initWith("proposed")

  def newest(ls: List[Link]): Link = ls[ls.length() - 1]
  def setNewest(ls: List[Link], s: str): List[Link] = ls.replaceAt(ls.length() - 1, { ...newest(ls), state: s })
  def terminal(s: str): bool = s == "committed" or s == "handedBack" or s == "expired"

  action unchangedAll = all {
    epoch' = epoch, memberEpoch' = memberEpoch, links' = links, admitted' = admitted, listed' = listed,
    stalled' = stalled, refusedReoffered' = refusedReoffered, design' = design,
  }

  // The newest link reaches the creator inside its own epoch, and the creator admits it.
  action deliver = all {
    newest(links).state == "current", newest(links).epoch == epoch, memberEpoch == epoch,
    admitted' = admitted + 1, links' = setNewest(links, "committed"),
    epoch' = epoch, memberEpoch' = memberEpoch, listed' = listed, stalled' = stalled,
    refusedReoffered' = refusedReoffered, design' = design,
  }

  // The creator closes its epoch: an unadmitted newest link of that epoch is displaced.
  action roll = all {
    epoch < MAX_EPOCH, not(stalled),
    epoch' = epoch + 1,
    links' = if (newest(links).state == "current" and newest(links).epoch == epoch) setNewest(links, "open") else links,
    memberEpoch' = memberEpoch, admitted' = admitted, listed' = listed, stalled' = stalled,
    refusedReoffered' = refusedReoffered, design' = design,
  }

  // A completed install: the Writer is at the creator's epoch.
  action installed(ls: List[Link], give: bool, reoffered: bool): bool = all {
    memberEpoch' = epoch, links' = ls, listed' = (listed or give), stalled' = false,
    refusedReoffered' = (refusedReoffered or reoffered),
    epoch' = epoch, admitted' = admitted, design' = design,
  }
  def replayed(ls: List[Link]): List[Link] = setNewest(ls, "completed").append({ epoch: epoch, state: "current" })

  // refusable: the Writer's admission would refuse the replay; full: no hand-back record is free;
  // killed: SIGKILL at the hand-back plan write, before its commit point.
  action installWith(refusable: bool, full: bool, killed: bool): bool = all {
    memberEpoch < epoch, not(stalled),
    if (newest(links).state != "open") installed(links, false, false)
    else if (links[0].epoch <= epoch - D) installed(setNewest(links, "expired"), true, false) // window expiry
    else if (not(refusable)) installed(replayed(links), false, false)
    else if (design == "shipped") all {
      stalled' = true, memberEpoch' = memberEpoch, links' = links, listed' = listed,
      refusedReoffered' = refusedReoffered, epoch' = epoch, admitted' = admitted, design' = design,
    }
    else if (design == "creatorDriven") installed(replayed(links), false, true)
    // proposed: the source stays live when no hand-back record is free; the install completes.
    else if (full) installed(links, false, false)
    // proposed: killed before the plan write commits; nothing was signed or written.
    else if (killed) unchangedAll
    else installed(setNewest(links, "handedBack"), true, false),
  }

  action install = {
    nondet refusable = Set(true, false).oneOf()
    nondet full = Set(true, false).oneOf()
    nondet killed = Set(true, false).oneOf()
    installWith(refusable, full, killed)
  }

  action step = any { deliver, roll, install }

  val noStall = not(stalled)
  val givenBack = links.indices().exists(i => links[i].state == "handedBack" or links[i].state == "expired")
  val exactlyOnce = admitted <= 1 and not(admitted >= 1 and givenBack) and
    links.indices().forall(i => links[i].state != "committed" or i == links.length() - 1)
  val noReoffer = links.indices().forall(i => not(terminal(links[i].state)) or i == links.length() - 1)
  val noRefusedReoffer = not(refusedReoffered)
  val listedWhenGiven = givenBack implies listed
  val safety = exactlyOnce and noReoffer and noRefusedReoffer and listedWhenGiven
  val proposedInv = safety and noStall

  // The shipped stall: L0 displaced, its replay refused at the epoch-2 install.
  run shippedStallsTest = initShipped.then(roll).then(installWith(true, false, false))
    .then(all { assert(stalled), assert(not(noStall)), unchangedAll })
  // creatorDriven: the refusable replay is signed anyway (an automatic re-offer of a refused move).
  run creatorDrivenReoffersTest = initCreatorDriven.then(roll).then(installWith(true, false, false))
    .then(all { assert(links.length() == 2), assert(not(noRefusedReoffer)), assert(noStall), unchangedAll })
  // proposed: the refused replay is handed back once and never replayed; the Writer keeps installing.
  run proposedHandsBackOnceTest = initProposed.then(roll).then(installWith(true, false, false))
    .then(all { assert(newest(links).state == "handedBack"), assert(listed), assert(proposedInv), unchangedAll })
    .then(roll).then(installWith(false, false, false)).then(roll).then(installWith(true, false, false))
    .then(all { assert(links.length() == 1), assert(admitted == 0), assert(memberEpoch == 4), assert(proposedInv), unchangedAll })
  // proposed: records full keeps the source live; the install completes and the next one retries it.
  run proposedFullRetriesTest = initProposed.then(roll).then(installWith(true, true, false))
    .then(all { assert(newest(links).state == "open"), assert(memberEpoch == 2), assert(noStall), unchangedAll })
    .then(roll).then(installWith(false, false, false)).then(deliver)
    .then(all { assert(admitted == 1), assert(proposedInv), unchangedAll })
  // proposed: a SIGKILL before the hand-back write commits leaves nothing; the retry hands it back once.
  run proposedKilledRetriesTest = initProposed.then(roll).then(installWith(true, false, true))
    .then(all { assert(newest(links).state == "open"), assert(not(listed)), assert(memberEpoch == 1), unchangedAll })
    .then(installWith(true, false, false))
    .then(all { assert(listed), assert(newest(links).state == "handedBack"), assert(proposedInv), unchangedAll })
  // proposed: the window still expires a move whose replays keep failing at the creator.
  run proposedWindowExpiresTest = initProposed
    .then(roll).then(installWith(false, false, false)).then(roll).then(installWith(false, false, false))
    .then(roll).then(installWith(false, false, false)).then(roll).then(installWith(false, false, false))
    .then(all { assert(newest(links).state == "expired"), assert(listed), assert(proposedInv), unchangedAll })
}
