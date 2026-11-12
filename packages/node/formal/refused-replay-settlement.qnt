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
//     (nondet) is that judgement: the replay would be refused before signing. A transient refusal
//     (input capacity, snapshot readiness) is retried inside the same install: one that clears is
//     `refusable = false`; one that outlasts the retries is `refusable = true` (handed back as
//     "transient-exhausted"; its reissue may later be admitted, `lasting = false`).
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
//   proposedNoDecline  proposed without the application's decline: the only way out of a hand-back
//                  record is the reissue carrying exactly that operation.
//
// The application's side of a hand-back record (proposed variants). The record is "unconsumed" and
// listed; it holds one of the Writer's backlog slots (V3_ROOM_LOCAL_BACKLOG_LIMIT, here BOUND = 1 with
// the move's own live chain). The application offers the move again (`reissue`): admitted, its row
// consumes the record in its own issuance transaction ("consumed"); refused, nothing changes. `lasting`
// (nondet, fixed when the record is written) is a refusal the Writer's admission repeats on every
// reissue (the state limit, the admission policy). In "proposed" the application may decline the
// record (`decline`): ONE plan write drops exactly that unconsumed record ("declined") and the
// application has decided (and tells its user); a SIGKILL before that write's commit point leaves the
// record whole. Declining a consumed or absent record changes nothing (a typed no-op). A new move
// (`newMove`) is accepted only while a backlog slot is free.
//
// Chain composition (the lost-twice census, creator-replaced-pending-census.qnt): a "handedBack" link
// is a TERMINAL chain end, like "committed" and "expired": never followed by a link, never re-offered,
// not live work.
//
// Properties: exactlyOnce (M admitted at most once, and never both admitted and given back), noReoffer
// (no link follows a terminal one), noRefusedReoffer (a replay the Writer's admission refuses is never
// signed), listed (a given-back move is listed for the application in the same write), noStall;
// intentsExactlyOnce (M's intent is admitted at most once, by its chain or by its reissue, never both),
// noSilentLoss (M is always admitted, still live in its chain, listed, or declined by the application),
// noStuckWriter (a backlog slot held by a record whose reissue is refused for good can still be freed).
module refusedReplaySettlement {
  pure val D = 4         // V3_SETTLEMENT_OWN_WINDOW_EPOCHS
  pure val MAX_EPOCH = 8
  pure val BOUND = 1      // backlog slots in this one-move model
  pure val MAX_PLAYED = 2

  type Link = { epoch: int, state: str } // current | open | completed | committed | handedBack | expired

  var epoch: int            // creator's epoch
  var memberEpoch: int      // Writer's installed epoch
  var links: List[Link]
  var admitted: int
  var listed: bool          // a durable hand-back record lists M for the application
  var stalled: bool
  var refusedReoffered: bool // a replay the Writer's admission would refuse was signed anyway
  var design: str
  var record: str           // none | unconsumed | consumed | declined (M's hand-back record)
  var lasting: bool         // the record's reissue is refused on every offer
  var reissued: int         // M admitted through its reissued row
  var told: bool            // the application declined M (its own decision, told to its user)
  var played: int           // the Writer's new moves accepted after M

  action initWith(v: str): bool = all {
    epoch' = 1, memberEpoch' = 1, links' = [{ epoch: 1, state: "current" }], admitted' = 0,
    listed' = false, stalled' = false, refusedReoffered' = false, design' = v,
    record' = "none", lasting' = false, reissued' = 0, told' = false, played' = 0,
  }
  action initShipped = initWith("shipped")
  action initCreatorDriven = initWith("creatorDriven")
  action initProposed = initWith("proposed")
  action initProposedNoDecline = initWith("proposedNoDecline")

  def newest(ls: List[Link]): Link = ls[ls.length() - 1]
  def setNewest(ls: List[Link], s: str): List[Link] = ls.replaceAt(ls.length() - 1, { ...newest(ls), state: s })
  def terminal(s: str): bool = s == "committed" or s == "handedBack" or s == "expired"

  action unchangedApp = all {
    record' = record, lasting' = lasting, reissued' = reissued, told' = told, played' = played,
  }
  action unchangedAll = all {
    epoch' = epoch, memberEpoch' = memberEpoch, links' = links, admitted' = admitted, listed' = listed,
    stalled' = stalled, refusedReoffered' = refusedReoffered, design' = design, unchangedApp,
  }
  // The Writer's backlog: M's live chain, or its unconsumed record.
  val slots = (if (record == "unconsumed") 1 else 0) + (if (terminal(newest(links).state)) 0 else 1)

  // The newest link reaches the creator inside its own epoch, and the creator admits it.
  action deliver = all {
    newest(links).state == "current", newest(links).epoch == epoch, memberEpoch == epoch,
    admitted' = admitted + 1, links' = setNewest(links, "committed"),
    epoch' = epoch, memberEpoch' = memberEpoch, listed' = listed, stalled' = stalled,
    refusedReoffered' = refusedReoffered, design' = design, unchangedApp,
  }

  // The creator closes its epoch: an unadmitted newest link of that epoch is displaced.
  action roll = all {
    epoch < MAX_EPOCH, not(stalled),
    epoch' = epoch + 1,
    links' = if (newest(links).state == "current" and newest(links).epoch == epoch) setNewest(links, "open") else links,
    memberEpoch' = memberEpoch, admitted' = admitted, listed' = listed, stalled' = stalled,
    refusedReoffered' = refusedReoffered, design' = design, unchangedApp,
  }

  // A completed install: the Writer is at the creator's epoch.
  // give: the install writes M's hand-back record (listed); keeps: its reissue is refused for good.
  action installedWith(ls: List[Link], give: bool, reoffered: bool, keeps: bool): bool = all {
    memberEpoch' = epoch, links' = ls, listed' = (listed or give), stalled' = false,
    refusedReoffered' = (refusedReoffered or reoffered),
    epoch' = epoch, admitted' = admitted, design' = design,
    record' = if (give) "unconsumed" else record, lasting' = if (give) keeps else lasting,
    reissued' = reissued, told' = told, played' = played,
  }
  action installed(ls: List[Link], give: bool, reoffered: bool): bool = installedWith(ls, give, reoffered, false)
  def replayed(ls: List[Link]): List[Link] = setNewest(ls, "completed").append({ epoch: epoch, state: "current" })

  // refusable: the Writer's admission would refuse the replay; full: no hand-back record is free;
  // killed: SIGKILL at the hand-back plan write, before its commit point.
  // keeps: the record's reissue would be refused on every offer (fixed when the record is written).
  action installWithKeeps(refusable: bool, full: bool, killed: bool, keeps: bool): bool = all {
    memberEpoch < epoch, not(stalled),
    if (newest(links).state != "open") installed(links, false, false)
    else if (links[0].epoch <= epoch - D) installedWith(setNewest(links, "expired"), true, false, keeps) // window expiry
    else if (not(refusable)) installed(replayed(links), false, false)
    else if (design == "shipped") all {
      stalled' = true, memberEpoch' = memberEpoch, links' = links, listed' = listed,
      refusedReoffered' = refusedReoffered, epoch' = epoch, admitted' = admitted, design' = design, unchangedApp,
    }
    else if (design == "creatorDriven") installed(replayed(links), false, true)
    // proposed: the source stays live when no hand-back record is free; the install completes.
    else if (full) installed(links, false, false)
    // proposed: killed before the plan write commits; nothing was signed or written.
    else if (killed) unchangedAll
    else installedWith(setNewest(links, "handedBack"), true, false, keeps),
  }
  action installWith(refusable: bool, full: bool, killed: bool): bool = installWithKeeps(refusable, full, killed, true)

  action install = {
    nondet refusable = Set(true, false).oneOf()
    nondet full = Set(true, false).oneOf()
    nondet killed = Set(true, false).oneOf()
    nondet keeps = Set(true, false).oneOf()
    installWithKeeps(refusable, full, killed, keeps)
  }

  action keepChain = all {
    epoch' = epoch, memberEpoch' = memberEpoch, links' = links, admitted' = admitted, listed' = listed,
    stalled' = stalled, refusedReoffered' = refusedReoffered, design' = design,
  }

  // The application offers M again with its record, in the Writer's current epoch: admitted unless the
  // refusal is lasting; its row consumes the record in its own issuance transaction.
  action reissue = all {
    record == "unconsumed", not(lasting), memberEpoch == epoch, keepChain,
    record' = "consumed", reissued' = reissued + 1, lasting' = lasting, told' = told, played' = played,
  }

  // The application declines M's record: one plan write drops exactly that unconsumed record. killed: a
  // SIGKILL before the write's commit point (the record stays whole). A consumed or absent record: no-op.
  action declineWith(killed: bool): bool = all {
    design == "proposed",
    if (record != "unconsumed" or killed) unchangedAll
    else all { keepChain, record' = "declined", told' = true, lasting' = lasting, reissued' = reissued, played' = played },
  }
  action decline = { nondet killed = Set(true, false).oneOf() declineWith(killed) }

  // A new move of the Writer, accepted only while a backlog slot is free (V3RoomLocalBacklogFull).
  action newMove = all {
    slots < BOUND, played < MAX_PLAYED, keepChain,
    played' = played + 1, record' = record, lasting' = lasting, reissued' = reissued, told' = told,
  }

  action step = any { deliver, roll, install, reissue, decline, newMove }

  val noStall = not(stalled)
  val givenBack = links.indices().exists(i => links[i].state == "handedBack" or links[i].state == "expired")
  val exactlyOnce = admitted <= 1 and not(admitted >= 1 and givenBack) and
    links.indices().forall(i => links[i].state != "committed" or i == links.length() - 1)
  val noReoffer = links.indices().forall(i => not(terminal(links[i].state)) or i == links.length() - 1)
  val noRefusedReoffer = not(refusedReoffered)
  val listedWhenGiven = givenBack implies listed
  val safety = exactlyOnce and noReoffer and noRefusedReoffer and listedWhenGiven
  val intentsExactlyOnce = admitted + reissued <= 1
  val noSilentLoss = admitted >= 1 or reissued >= 1 or record == "unconsumed" or told or
    not(terminal(newest(links).state))
  // A slot held by a record whose reissue is refused for good can still be freed (by a decline).
  val noStuckWriter = not(record == "unconsumed" and lasting and design != "proposed")
  val proposedInv = safety and noStall and intentsExactlyOnce and noSilentLoss and noStuckWriter

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
  // proposedNoDecline: a record refused for good holds the Writer's only slot: no new move, ever.
  run noDeclineStuckTest = initProposedNoDecline.then(roll).then(installWith(true, false, false))
    .then(all { assert(record == "unconsumed"), assert(lasting), assert(slots == BOUND), assert(not(noStuckWriter)), unchangedAll })
  // proposed: the application declines it; the slot is free and the Writer plays again; M is never admitted.
  run declineFreesWriterTest = initProposed.then(roll).then(installWith(true, false, false))
    .then(all { assert(slots == BOUND), assert(proposedInv), unchangedAll })
    .then(declineWith(true))
    .then(all { assert(record == "unconsumed"), assert(proposedInv), unchangedAll })
    .then(declineWith(false))
    .then(all { assert(record == "declined"), assert(told), assert(slots == 0), assert(proposedInv), unchangedAll })
    .then(newMove).then(declineWith(false))
    .then(all { assert(played == 1), assert(record == "declined"), assert(admitted + reissued == 0), assert(proposedInv), unchangedAll })
  // proposed: a reissue admitted consumes the record; declining it then is a no-op.
  run reissueThenDeclineTest = initProposed.then(roll).then(installWithKeeps(true, false, false, false))
    .then(reissue).then(declineWith(false))
    .then(all { assert(record == "consumed"), assert(reissued == 1), assert(not(told)), assert(proposedInv), unchangedAll })
}
