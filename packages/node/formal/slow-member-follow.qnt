// A member that installs more slowly than its creator rolls over (fix/slow-member-follow):
// which successor it asks the creator for, what the creator still serves, and the moves the
// member makes while an install runs. Sibling of member-successor-install.qnt (one install's
// recovery steps) and settlement-window.qnt (a journaled move's way to the creator).
//
// Facts the model takes from the code:
//   - The creator switches its serving to the successor of epoch c at the seal of c
//     (sealEpochNow -> serveAvailableSuccessor), but publishes that successor's offer only after
//     the adoption and export. The adoption makes c + 1 the creator's epoch. So from the seal
//     to the publication, no member knows the offer of the newest serving.
//   - The material server refuses a request whose manifest is not one it serves ("stale"), and
//     the install refuses with it (CreatorSuccessorMaterialRefused). The install asks for the
//     material and then for the snapshot chunks of the same manifest; each request is answered
//     only if the manifest is still served then.
//   - An install is queued in the member's lifecycle FIFO; a slow host holds it there for an
//     unbounded time (queued). The transition then begins: its preamble (pre-drain), the fetch,
//     and the local adoption (apply).
//   - A move the member issues while its adoption task runs (the transition) is refused under the
//     settlement profile on the base ("v3 room live plane is unavailable"); the rollover policy
//     retries it, and a retry lands only if it comes while no transition runs.
//
// Epochs are relative to the creator's: `lag` is the member's distance behind the creator
// (saturated at CAP), `behindTarget` the distance of the install's target behind the creator
// (saturated at 2: no mode serves a target two epochs back). The offer of the creator's current
// epoch reaches the member at its publication (A2 below), so the newest offer the member knows is
// always the creator's current epoch.
//
// FIXED (all three):
//   F1 the install takes the newest offer the member knows when its fetch begins (selection), not
//      the one that was newest when it was queued (V3RoomCreatorSuccessorInstallRequest.newest);
//   K2 the creator keeps serving the adopted successor it replaced (CREATOR_SUCCESSOR_SERVINGS_RETAINED);
//   H  a move issued while the transition runs is held and released when it ends; the transition
//      begins by draining the moves released before it (installPreDrain).
// Broken controls: "enqueue" (no F1), "single" (no K2), "refuse" (no H).
//
// Environment assumptions (the residual requirements the fix leaves):
//   A1 a member's fetch window (selection to the last chunk) never spans a whole open period of
//      the creator: after the creator publishes an epoch inside the window, it does not seal that
//      epoch before the window ends. Wall-clock: a fetch completes within one epoch's open period
//      (publication to seal), whatever the member's queue delay and local adoption take.
//   A2 the creator's offer reaches the member at its publication (announcement; a missed one is
//      pulled after a stale refusal by the delivery, not modeled).
module slowMemberFollow {
  pure val CAP = 3

  var mode: str                // fixed | enqueue | single | refuse
  var phase: str               // creator: open | sealed (serving switched, offer not yet published)
  var stopped: bool            // the creator rolls no more
  var lag: int                 // creator epoch - member epoch, saturated at CAP
  var inst: str                // member install: idle | queued | material | chunks | apply
  var behindTarget: int        // creator epoch - install target, saturated at 2
  var windowAdopted: bool      // the creator adopted (published) an epoch inside the current fetch window
  var move: str                // none | held | pending | retrying | journaled
  var last: str                // the last action (for the liveness properties)

  def f1: bool = mode != "enqueue"
  def k2: bool = mode != "single"
  def hold: bool = mode != "refuse"
  def sat(n: int, m: int): int = if (n > m) m else n
  def windowed(i: str): bool = i == "material" or i == "chunks"
  def transition(i: str): bool = windowed(i) or i == "apply"
  // Successors the creator serves, as distances behind its epoch: when open in c, the successor
  // of c - 1 (that is c; distance 0) and with K2 the one it replaced (distance 1); when sealed, the
  // successor of c (unpublished, distance -1) and with K2 the one of c - 1 (distance 0).
  def served(d: int): bool = if (phase == "open") (d == 0 or (k2 and d == 1)) else (k2 and d == 0)

  action initWith(m: str): bool = all {
    mode' = m, phase' = "open", stopped' = false, lag' = 0, inst' = "idle", behindTarget' = 0,
    windowAdopted' = false, move' = "none", last' = "init",
  }
  action init = initWith("fixed")
  action initEnqueue = initWith("enqueue")
  action initSingle = initWith("single")
  action initRefuse = initWith("refuse")

  // The creator (no fairness: it may roll forever or stop).
  action creatorSeal = all {
    phase == "open", not(stopped), not(windowed(inst) and windowAdopted),
    phase' = "sealed", last' = "seal",
    stopped' = stopped, lag' = lag, inst' = inst, behindTarget' = behindTarget, windowAdopted' = windowAdopted,
    move' = move, mode' = mode,
  }
  action creatorAdopt = all {
    phase == "sealed",
    phase' = "open", lag' = sat(lag + 1, CAP), behindTarget' = if (inst == "idle") 0 else sat(behindTarget + 1, 2),
    windowAdopted' = (windowAdopted or windowed(inst)), last' = "adopt",
    stopped' = stopped, inst' = inst, move' = move, mode' = mode,
  }
  action creatorStop = all {
    phase == "open", not(stopped), stopped' = true, last' = "stop",
    phase' = phase, lag' = lag, inst' = inst, behindTarget' = behindTarget, windowAdopted' = windowAdopted,
    move' = move, mode' = mode,
  }

  // The member's install.
  action enqueue = all {
    inst == "idle", lag > 0,
    inst' = "queued", behindTarget' = 0, last' = "enqueue",
    phase' = phase, stopped' = stopped, lag' = lag, windowAdopted' = windowAdopted, move' = move, mode' = mode,
  }
  // The transition begins: the pre-drain journals the moves released before it (H), then the
  // install selects its offer (F1: the newest it knows).
  action beginFetch = all {
    inst == "queued",
    inst' = "material", behindTarget' = if (f1) 0 else behindTarget, windowAdopted' = false,
    move' = if (hold and move == "pending") "journaled" else move, last' = "beginFetch",
    phase' = phase, stopped' = stopped, lag' = lag, mode' = mode,
  }
  // A fetch that ends the transition releases the held moves (shared.finally releaseHeldIssues).
  def released(m: str): str = if (m == "held") "pending" else m
  action fetchMaterial = all {
    inst == "material",
    if (served(behindTarget)) all { inst' = "chunks", move' = move, last' = "material" }
    else all { inst' = "idle", move' = released(move), last' = "stale" },
    phase' = phase, stopped' = stopped, lag' = lag, behindTarget' = behindTarget, windowAdopted' = windowAdopted,
    mode' = mode,
  }
  action fetchChunks = all {
    inst == "chunks",
    if (served(behindTarget)) all { inst' = "apply", move' = move, last' = "chunks" }
    else all { inst' = "idle", move' = released(move), last' = "stale" },
    phase' = phase, stopped' = stopped, lag' = lag, behindTarget' = behindTarget, windowAdopted' = windowAdopted,
    mode' = mode,
  }
  action applyDone = all {
    inst == "apply",
    inst' = "idle", lag' = behindTarget, move' = released(move), last' = "installed",
    phase' = phase, stopped' = stopped, behindTarget' = behindTarget, windowAdopted' = windowAdopted, mode' = mode,
  }

  // One move of the member's app.
  action issue = all {
    move == "none",
    move' = if (not(transition(inst))) "journaled" else if (hold) "held" else "retrying", last' = "issue",
    phase' = phase, stopped' = stopped, lag' = lag, inst' = inst, behindTarget' = behindTarget,
    windowAdopted' = windowAdopted, mode' = mode,
  }
  // The drain (H) or the policy's retry (refuse) lands the move only while no transition runs.
  action drain = all {
    (move == "pending" or move == "retrying"), not(transition(inst)),
    move' = "journaled", last' = "drain",
    phase' = phase, stopped' = stopped, lag' = lag, inst' = inst, behindTarget' = behindTarget,
    windowAdopted' = windowAdopted, mode' = mode,
  }

  action step = any { creatorSeal, creatorAdopt, creatorStop, enqueue, beginFetch, fetchMaterial, fetchChunks, applyDone, issue, drain }

  // Safety: under A1 and A2 a fixed member's request is never refused as stale.
  val neverStale = last != "stale"
  // No move is lost: once issued, it is held, released, retried or journaled.
  val moveKept = move == "none" or move == "held" or move == "pending" or move == "retrying" or move == "journaled"
  val safety = neverStale and moveKept

  val vars = (mode, phase, stopped, lag, inst, behindTarget, windowAdopted, move, last)
  temporal memberFair =
    weakFair(enqueue, vars) and weakFair(beginFetch, vars) and weakFair(fetchMaterial, vars) and weakFair(fetchChunks, vars)
      and weakFair(applyDone, vars) and weakFair(drain, vars)
  // A lagging member keeps installing while the creator rolls on (it follows), and reaches the
  // creator's epoch once the creator stops.
  temporal memberFollows = memberFair implies always(lag > 0 implies eventually(last == "installed"))
  temporal memberCatchesUp = memberFair implies always(stopped implies eventually(lag == 0 and inst == "idle"))
  // A move the member issued is eventually journaled by its room (from there settlement-window.qnt
  // carries it to the creator).
  temporal moveLands = memberFair implies always(move != "none" implies eventually(move == "journaled"))

  // Witnesses.
  action rollOnce = creatorSeal.then(creatorAdopt)
  // The base: an install selected at enqueue, held in the queue while the creator rolls twice,
  // asks for a successor the creator no longer serves.
  run enqueueStaleTest = initEnqueue.then(rollOnce).then(enqueue).then(rollOnce).then(rollOnce).then(beginFetch)
    .then(all { assert(behindTarget == 2), fetchMaterial }).then(all { assert(last == "stale" and inst == "idle"), creatorStop })
  // The seal-to-publication window: with one serving, a fetch selected while open is refused at
  // the seal that follows, before the offer of the new serving exists.
  run singleSealWindowTest = initSingle.then(rollOnce).then(enqueue).then(beginFetch).then(creatorSeal)
    .then(fetchMaterial).then(all { assert(last == "stale"), creatorAdopt })
  // FIXED: the same schedule, and a queue delay of two rollovers, still installs; the member's lag
  // after the install is the creator's progress during the fetch.
  run fixedFollowsTest = init.then(rollOnce).then(enqueue).then(rollOnce).then(rollOnce).then(beginFetch).then(creatorSeal)
    .then(fetchMaterial).then(creatorAdopt).then(fetchChunks).then(applyDone)
    .then(all { assert(last == "installed" and lag == 1 and safety), enqueue })
  // A move issued during the install is held, released at its end, and journaled by the next
  // transition's pre-drain even when installs run back to back.
  run fixedHoldTest = init.then(rollOnce).then(enqueue).then(beginFetch).then(issue).then(all { assert(move == "held"), fetchMaterial })
    .then(fetchChunks).then(applyDone).then(all { assert(move == "pending"), rollOnce }).then(enqueue).then(beginFetch)
    .then(all { assert(move == "journaled"), fetchMaterial })
  // The base: the retry lands only between transitions, which back-to-back installs never leave.
  run refuseRetryTest = initRefuse.then(rollOnce).then(enqueue).then(beginFetch).then(issue)
    .then(all { assert(move == "retrying"), fetchMaterial }).then(fetchChunks).then(applyDone).then(rollOnce).then(enqueue)
    .then(beginFetch).then(all { assert(move == "retrying"), fetchMaterial })
}
