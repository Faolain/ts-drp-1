// PROPOSAL MODEL (not implemented): bound the age of a move's replacement chain.
//
// One member move M. Each time the member installs a later epoch while M is displaced (never
// admitted), the room either REPLACES it (signs a new link in the member's current epoch, whose
// settlement source is the previous link) or EXPIRES it (signed local expiry of the newest link,
// the move handed back to the application, which offers it again as a fresh move: a new root in
// the current epoch). Every link of a live chain is a recovery dependency (the retirement closure
// protects a link while a later link names it as its source), and a member install's recovery
// certificate authenticates only the last COVER epochs of anchors. A live link older than that is
// RECOVERY_DEPENDENCY_ANCHOR_UNCOVERED and the member's room closes (observed in the 100-move,
// 16-epoch catch-up: rows at epoch 18 when the member reached 29, certificate covering 19..29).
//
// Shipped rule: the settlement window (WINDOW) is judged on the NEWEST link's epoch, which every
// replacement renews, so a move that keeps missing the creator keeps a chain whose root ages
// without bound. Proposed rule (expireByRoot): the window is judged on the ROOT's epoch: a
// displaced move whose root is WINDOW epochs old is expired and handed back instead of replaced.
// Expiry stays guarded exactly as shipped (only a frontier-displaced, fence-guarded link, i.e. one
// the creator can never admit), so the exactly-once properties do not depend on the change.
//
// Properties: exactlyOnce (M is admitted at most once, and never both admitted and handed back for
// the same root); coverage (no live link older than COVER) under the proposed rule whenever
// WINDOW + GAP <= COVER, where GAP bounds the epochs between two member installs.
module settlementChainAge {
  pure val MAX_EPOCH = 16
  pure val WINDOW = 4
  pure val COVER = 10
  pure val GAP = 3

  var epoch: int                 // creator's epoch
  var memberEpoch: int           // member's installed epoch
  var links: List[int]           // epochs of the live chain's links (root first); empty: no live chain
  var admitted: int              // admissions of M (any root)
  var handedBack: int            // hand-backs of M
  var landedRoot: bool           // the current root's chain was admitted
  var expireByRoot: bool         // rule under check

  action initWith(rule: bool): bool = all {
    epoch' = 1, memberEpoch' = 1, links' = [1], admitted' = 0, handedBack' = 0, landedRoot' = false,
    expireByRoot' = rule,
  }
  action initShipped = initWith(false)
  action initProposed = initWith(true)

  // The creator rolls (the member's link of the closing epoch is displaced unless admitted).
  action roll = all {
    epoch < MAX_EPOCH, memberEpoch >= epoch - GAP + 1,
    epoch' = epoch + 1,
    memberEpoch' = memberEpoch, links' = links, admitted' = admitted, handedBack' = handedBack,
    landedRoot' = landedRoot, expireByRoot' = expireByRoot,
  }
  // The newest link reaches the creator inside its own epoch: admitted, the chain ends.
  action admit = all {
    links.length() > 0, links[links.length() - 1] == epoch, memberEpoch == epoch, not(landedRoot),
    admitted' = admitted + 1, landedRoot' = true, links' = [],
    epoch' = epoch, memberEpoch' = memberEpoch, handedBack' = handedBack, expireByRoot' = expireByRoot,
  }
  // A member install of the creator's current epoch; a displaced live chain is replaced or expired.
  action install = all {
    memberEpoch < epoch,
    memberEpoch' = epoch,
    epoch' = epoch, admitted' = admitted, expireByRoot' = expireByRoot,
    if (links.length() == 0) all {
      // A handed-back move is offered again as a fresh root in the installed epoch.
      links' = if (landedRoot) [] else [epoch], handedBack' = handedBack, landedRoot' = landedRoot,
    } else {
      val judged = if (expireByRoot) links[0] else links[links.length() - 1]
      if (judged <= epoch - WINDOW) all {
        // Expire the newest (displaced, never admitted) link: hand the move back; its next offer
        // is a fresh root.
        links' = [epoch], handedBack' = handedBack + 1, landedRoot' = false,
      } else all {
        links' = links.append(epoch), handedBack' = handedBack, landedRoot' = landedRoot,
      }
    },
  }

  action step = any { roll, admit, install }

  // The move is admitted at most once (an expired link is one the creator can never admit).
  val exactlyOnce = admitted <= 1
  // Every live link is inside the member's certificate coverage.
  val coverage = links.foldl(true, (ok, e) => ok and e > memberEpoch - COVER)

  // The shipped rule loses coverage when the move keeps missing the creator.
  run shippedLosesCoverageTest = initShipped
    .then(roll).then(install).then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(roll).then(install).then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(all { assert(not(coverage)), assert(handedBack == 0), unchangedAll })
  // The proposed rule hands the move back before its root ages out, and it can still land once.
  run proposedKeepsCoverageTest = initProposed
    .then(roll).then(install).then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(roll).then(install).then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(roll).then(install).then(roll).then(install).then(roll).then(install)
    .then(all { assert(coverage), assert(handedBack >= 1), unchangedAll })
    .then(admit).then(all { assert(admitted == 1), assert(exactlyOnce), unchangedAll })

  action unchangedAll = all {
    epoch' = epoch, memberEpoch' = memberEpoch, links' = links, admitted' = admitted,
    handedBack' = handedBack, landedRoot' = landedRoot, expireByRoot' = expireByRoot,
  }
}
