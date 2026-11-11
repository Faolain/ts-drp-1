// Authority-bound ephemeral frames across epoch rollovers (perf/ephemeral-rollover-continuity).
//
// Facts the model takes from the code (packages/ephemeral/src/index.ts, createEphemeralChannel):
//   - A frame is tagged with the sender's current installed context (object, epoch, anchor, ACL) and,
//     when the sender's channel holds the context it installed immediately before (epoch - 1) and the
//     sender is still a writer under its current one, with that preceding context too (frame v3).
//   - A receiver delivers a frame only if (a) its authority is available (not the replacement gap),
//     (b) the authenticated sender maps to a writer under the receiver's CURRENT authority, (c) one of
//     the frame's tags equals a context the receiver itself installed: its current one, or the one it
//     held immediately before (epoch - 1), and (d) the frame's context epoch is not below the latest
//     context epoch the receiver has accepted from that sender.
//   - A channel holds the preceding context only after observing an adjacent change (epoch + 1, same
//     object). Any other change (a skipped epoch, a same-epoch replacement, a reopened channel) drops
//     it and every sender floor.
// Contexts are (epoch, branch). Branch 0 is the genuine chain honest peers install; branch 1 is a
// foreign tuple at the same epoch number (different anchor/ACL) that nobody installs: tags are exact
// tuple equality, never epoch-number comparison. Sender authentication is a premise (transport).
// The network keeps every frame ever sent and may deliver any of them, any number of times, in any
// order (delay, reorder, replay). Any peer may also forge frames with arbitrary tags under its own
// authenticated identity.
//
// Rules (the `rule` parameter of the receive action):
//   window   the shipped rule above;
//   exact    the previous single-context rule (only the receiver's current tuple) - the blackout;
// broken controls, each must violate one safety property:
//   ahead    also accepts any frame whose context epoch is the receiver's + 1, unverified;
//   prevAcl  checks a behind frame's sender against the receiver's PREVIOUS writer set;
//   nofloor  drops the per-sender floor;
//   anyPast  accepts any genuine context up to the receiver's current one (no window bound).
module ephemeralAdjacentAuthority {
  pure val PEERS = Set("c", "a", "b", "x")
  pure val MAX_EPOCH = 3
  pure val EPOCHS = 0.to(MAX_EPOCH)
  pure val BRANCHES = Set(0, 1)

  // x is a writer only in epoch 0: the successor of epoch 0 removes it.
  pure def writers(e: int): Set[str] = if (e == 0) Set("c", "a", "b", "x") else Set("c", "a", "b")

  type Ctx = { e: int, br: int }
  pure val NONE: Ctx = { e: -1, br: -1 }
  pure def ctx(e: int): Ctx = { e: e, br: 0 }

  type Frame = { sender: str, cur: Ctx, prev: Ctx, honest: bool }
  type Event = { kind: str, r: str, f: Frame, rEpoch: int, rPrev: bool, seenBefore: int }
  pure val NOFRAME: Frame = { sender: "", cur: NONE, prev: NONE, honest: false }
  pure val NOEVENT: Event = { kind: "none", r: "", f: NOFRAME, rEpoch: -1, rPrev: false, seenBefore: -1 }

  var installed: str -> int          // genuine epoch each peer has installed ("c" is the creator)
  var bound: str -> bool             // authority available (false inside the replacement gap)
  var hasPrev: str -> bool           // the channel holds the installed context of epoch installed - 1
  var floor: str -> (str -> int)     // receiver -> sender -> latest accepted context epoch (-1: none)
  var wire: Set[Frame]               // every frame ever sent
  // Ghost: the latest accepted context epoch per receiver/sender, never pruned, reset only when the
  // receiver's channel loses its window (independent of the implementation's floor).
  var seen: str -> (str -> int)
  var last: Event

  pure def noFloors: str -> int = PEERS.mapBy(_ => -1)

  action init = all {
    installed' = PEERS.mapBy(_ => 0),
    bound' = PEERS.mapBy(_ => true),
    hasPrev' = PEERS.mapBy(_ => false),
    floor' = PEERS.mapBy(_ => noFloors),
    wire' = Set(),
    seen' = PEERS.mapBy(_ => noFloors),
    last' = NOEVENT,
  }

  // ---- Lifecycle ----------------------------------------------------------------------------

  // Installing the next epoch (the creator adopts; a member installs up to the creator's epoch).
  // A peer the next epoch removes cannot install it. The channel observes the adjacent change.
  action install(p: str): bool = {
    val target = installed.get(p) + 1
    all {
      target <= MAX_EPOCH,
      if (p == "c") true else target <= installed.get("c"),
      writers(target).contains(p),
      installed' = installed.set(p, target),
      bound' = bound.set(p, true),
      hasPrev' = hasPrev.set(p, true),
      // Floors below target - 1 can never matter again; the implementation forgets them.
      floor' = floor.set(p, floor.get(p).keys().mapBy(s => if (floor.get(p).get(s) < target - 1) -1 else floor.get(p).get(s))),
      wire' = wire,
      seen' = seen,
      last' = NOEVENT,
    }
  }

  // The replacement gap: the old handle is revoked before the room binds the new one.
  action gap(p: str): bool = all {
    bound.get(p),
    bound' = bound.set(p, false),
    installed' = installed, hasPrev' = hasPrev, floor' = floor, wire' = wire, seen' = seen, last' = NOEVENT,
  }
  action rebind(p: str): bool = all {
    not(bound.get(p)),
    bound' = bound.set(p, true),
    installed' = installed, hasPrev' = hasPrev, floor' = floor, wire' = wire, seen' = seen, last' = NOEVENT,
  }

  // A channel that never observed the intermediate epoch (or was reopened) holds no window.
  action installSkipping(p: str): bool = {
    val target = installed.get(p) + 2
    all {
      target <= MAX_EPOCH,
      if (p == "c") true else target <= installed.get("c"),
      writers(target).contains(p),
      installed' = installed.set(p, target),
      bound' = bound.set(p, true),
      hasPrev' = hasPrev.set(p, false),
      floor' = floor.set(p, noFloors),
      wire' = wire,
      seen' = seen.set(p, noFloors),
      last' = NOEVENT,
    }
  }
  action reopen(p: str): bool = all {
    hasPrev' = hasPrev.set(p, false),
    floor' = floor.set(p, noFloors),
    seen' = seen.set(p, noFloors),
    installed' = installed, bound' = bound, wire' = wire, last' = NOEVENT,
  }

  // ---- Sending ------------------------------------------------------------------------------

  // An honest send: the current context, plus the preceding one while held and still a writer.
  action send(s: str): bool = {
    val e = installed.get(s)
    val f = { sender: s, cur: ctx(e),
              prev: if (hasPrev.get(s) and writers(e).contains(s)) ctx(e - 1) else NONE, honest: true }
    all {
      bound.get(s),
      wire' = wire.union(Set(f)),
      installed' = installed, bound' = bound, hasPrev' = hasPrev, floor' = floor, seen' = seen, last' = NOEVENT,
    }
  }

  // Any peer may forge arbitrary tags under its own authenticated identity. The codec fixes the
  // carried preceding context's epoch to the current one minus one (only its digests are encoded),
  // so a forger chooses the epoch, both branches, and whether a preceding tag is present.
  action forge(s: str, ce: int, cb: int, withPrev: bool, pb: int): bool = all {
    not(withPrev) or ce >= 1,
    wire' = wire.union(Set({ sender: s, cur: { e: ce, br: cb },
                            prev: if (withPrev) { e: ce - 1, br: pb } else NONE, honest: false })),
    installed' = installed, bound' = bound, hasPrev' = hasPrev, floor' = floor, seen' = seen, last' = NOEVENT,
  }

  // ---- Receiving ----------------------------------------------------------------------------

  def tagsMatch(r: str, f: Frame): bool = {
    val e = installed.get(r)
    or {
      f.cur == ctx(e),
      f.prev == ctx(e),
      hasPrev.get(r) and f.cur == ctx(e - 1),
    }
  }

  def accepts(rule: str, r: str, f: Frame): bool = {
    val e = installed.get(r)
    val writer = writers(e).contains(f.sender)
    val fresh = f.cur.e >= floor.get(r).get(f.sender)
    val base = bound.get(r) and f.sender != r
    if (rule == "exact") base and writer and f.cur == ctx(e)
    else if (rule == "ahead") base and writer and fresh and (tagsMatch(r, f) or f.cur.e == e + 1)
    else if (rule == "prevAcl") {
      val behindOnly = not(f.cur == ctx(e) or f.prev == ctx(e))
      base and (if (behindOnly) writers(e - 1).contains(f.sender) else writer) and fresh and tagsMatch(r, f)
    }
    else if (rule == "nofloor") base and writer and tagsMatch(r, f)
    else if (rule == "anyPast") base and writer and fresh and f.cur.br == 0 and f.cur.e <= e
    else base and writer and fresh and tagsMatch(r, f)
  }

  action receive(rule: str, r: str, f: Frame): bool = {
    val ok = accepts(rule, r, f)
    val before = seen.get(r).get(f.sender)
    all {
      wire.contains(f),
      bound.get(r),
      floor' = if (ok and f.cur.e > floor.get(r).get(f.sender))
                 floor.set(r, floor.get(r).set(f.sender, f.cur.e)) else floor,
      seen' = if (ok and f.cur.e > before) seen.set(r, seen.get(r).set(f.sender, f.cur.e)) else seen,
      last' = { kind: if (ok) "deliver" else "refuse", r: r, f: f, rEpoch: installed.get(r),
                rPrev: hasPrev.get(r), seenBefore: before },
      installed' = installed, bound' = bound, hasPrev' = hasPrev, wire' = wire,
    }
  }

  action lifecycle = nondet p = PEERS.oneOf() any { install(p), gap(p), rebind(p), installSkipping(p), reopen(p) }
  action traffic = any {
    nondet s = PEERS.oneOf() send(s),
    nondet s = PEERS.oneOf()
    nondet ce = EPOCHS.oneOf()
    nondet cb = BRANCHES.oneOf()
    nondet withPrev = Set(false, true).oneOf()
    nondet pb = BRANCHES.oneOf()
    forge(s, ce, cb, withPrev, pb),
  }
  action deliverWith(rule: str): bool = all {
    wire != Set(),
    nondet r = PEERS.oneOf()
    nondet f = wire.oneOf()
    receive(rule, r, f),
  }
  action stepWith(rule: str): bool = any { lifecycle, traffic, deliverWith(rule) }

  action step = stepWith("window")
  action exactStep = stepWith("exact")
  action aheadStep = stepWith("ahead")
  action prevAclStep = stepWith("prevAcl")
  action nofloorStep = stepWith("nofloor")
  action anyPastStep = stepWith("anyPast")

  // ---- Safety -------------------------------------------------------------------------------

  def delivered: bool = last.kind == "deliver"
  // S1: no frame is delivered from a sender that is not a writer under the receiver's current
  // (verified) authority - in particular a sender removed by an installed successor.
  val authorizedDelivery = delivered implies writers(last.rEpoch).contains(last.f.sender)
  val removedRefused = delivered implies not(last.f.sender == "x" and last.rEpoch >= 1)
  // S2: a delivered frame carries a tag equal to a context the receiver itself installed: its current
  // one, or the one it held immediately before. No forged or foreign tuple is ever the reason.
  val verifiedContext = delivered implies or {
    last.f.cur == ctx(last.rEpoch),
    last.f.prev == ctx(last.rEpoch),
    last.rPrev and last.f.cur == ctx(last.rEpoch - 1),
  }
  // S3: bounded window - nothing is accepted from a context more than one epoch away.
  val boundedWindow = delivered implies (last.f.cur.e >= last.rEpoch - 1 and last.f.cur.e <= last.rEpoch + 1)
  // S4: per sender, a receiver never goes back to an earlier context once it has accepted a later one.
  val senderMonotone = delivered implies last.f.cur.e >= last.seenBefore
  val safety = and { authorizedDelivery, removedRefused, verifiedContext, boundedWindow, senderMonotone }

  // ---- Continuity (the blackout this change removes) ----------------------------------------

  // An honest, fresh frame from a sender that is a writer on both sides, sent one epoch or less away,
  // where whichever side is behind holds the context the other needs, is never refused.
  def continuingFrame(ev: Event): bool = and {
    ev.f.honest,
    ev.f.sender != ev.r,
    writers(ev.rEpoch).contains(ev.f.sender),
    writers(ev.f.cur.e).contains(ev.f.sender),
    ev.f.cur.e >= ev.rEpoch - 1,
    ev.f.cur.e <= ev.rEpoch + 1,
    ev.f.cur.e >= ev.seenBefore,
    ev.f.cur.e > ev.rEpoch implies ev.f.prev != NONE,
    ev.f.cur.e < ev.rEpoch implies ev.rPrev,
  }
  val noContinuingRefusal = (last.kind == "refuse" and bound.get(last.r)) implies not(continuingFrame(last))

  // ---- Scenario tests ----------------------------------------------------------------------

  def frameOf(s: str): Frame = {
    val e = installed.get(s)
    { sender: s, cur: ctx(e), prev: if (hasPrev.get(s) and writers(e).contains(s)) ctx(e - 1) else NONE, honest: true }
  }

  // Creator adopts, members install one after another; frames cross in both directions throughout.
  run creatorAheadBothDirectionsTest =
    init
      .then(install("c"))
      .then(send("c")).then(receive("window", "a", frameOf("c")))
      .expect(last.kind == "deliver" and safety)
      .then(send("a")).then(receive("window", "c", frameOf("a")))
      .expect(last.kind == "deliver" and safety)
      .then(install("a"))
      .then(send("a")).then(receive("window", "b", frameOf("a")))
      .expect(last.kind == "deliver" and safety)
      .then(send("b")).then(receive("window", "a", frameOf("b")))
      .expect(last.kind == "deliver" and safety)

  run exactRuleBlacksOutTest =
    init
      .then(install("c"))
      .then(send("a")).then(receive("exact", "c", frameOf("a")))
      .expect(last.kind == "refuse" and not(noContinuingRefusal))

  run removedSenderRefusedOnceInstalledTest =
    init
      .then(send("x"))
      .then(install("c"))
      .then(receive("window", "c", { sender: "x", cur: ctx(0), prev: NONE, honest: true }))
      .expect(last.kind == "refuse")
      .then(receive("window", "a", { sender: "x", cur: ctx(0), prev: NONE, honest: true }))
      .expect(last.kind == "deliver" and safety)

  run senderFloorRefusesReplayTest =
    init
      .then(send("a"))
      .then(install("c"))
      .then(install("a"))
      .then(send("a")).then(receive("window", "c", frameOf("a")))
      .expect(last.kind == "deliver")
      .then(receive("window", "c", { sender: "a", cur: ctx(0), prev: NONE, honest: true }))
      .expect(last.kind == "refuse" and safety)

  run twoEpochsAwayRefusedTest =
    init
      .then(send("a"))
      .then(install("c")).then(install("c"))
      .then(receive("window", "c", { sender: "a", cur: ctx(0), prev: NONE, honest: true }))
      .expect(last.kind == "refuse" and safety)

  run foreignTupleRefusedTest =
    init
      .then(install("c"))
      .then(forge("a", 1, 1, true, 1))
      .then(receive("window", "b", { sender: "a", cur: { e: 1, br: 1 }, prev: { e: 0, br: 1 }, honest: false }))
      .expect(last.kind == "refuse" and safety)
      .then(forge("a", 1, 1, true, 1))
      .then(receive("ahead", "b", { sender: "a", cur: { e: 1, br: 1 }, prev: { e: 0, br: 1 }, honest: false }))
      .expect(last.kind == "deliver" and not(verifiedContext))
}
