// A member's (recipient's) successor install, its failure and retry paths, and the
// room-head record and live-plane registration as two pieces of state that must
// advance together.
//
// State a member's install reads and writes:
//   head      the room-head authority record (v3-room openedRoomHeadState: stable
//             epoch, pending during adoption publication);
//   reg       the live plane's registration: its currentTrust epoch and whether it
//             resolves for a recipient install (resolveCreatorRecipientRegistration):
//             "active" resolves; "receiving" is inside beginReceived; "terminal"
//             was terminalized by a failed receive; "halted" is a durable reopen
//             halted on a retirement-resume request (creatorRetirementResumeRequested),
//             which resolves only for the resume, never for an install;
//   completed the durable retirement control's completed.throughEpoch, written by
//             the received turnover (at a lull, or inside an install).
// A durable reopen of the plane at epoch h halts it when h >= 2 and
// completed + 1 == h (v3-live reopenCreatorSuccessorAdoption, resumeCheckpoint).
//
// The install, each step its own action, in the order the code runs them
// (v3-room installCreatorSuccessor, creator-adoption receiveCreatorSuccessorAdoption,
// v3-room performCreatorSuccessorAdoption):
//   start      the delivery takes its newest offer (target > head) into the
//              lifecycle FIFO; one install at a time (the delivery serializes and
//              the room refuses a second owner);
//   recover    if creatorRecipientRecoveryRequired: recoverSettlementOwner(true)
//              reopens the plane from durable state (recoverStartupPlane), then
//              refreshRoomHeadState; the flag clears. FIXED only: a reopened plane
//              halted on a retirement-resume request is discharged here by the
//              same original reconciliation session startup runs
//              (maintainCreatorRecipientRecoveryPool resume); its failure is the
//              session's terminal failure, as at startup;
//   precheck   the registration resolves and its currentTrust equals head, or the
//              install refuses "creator recipient current authority is unavailable"
//              (and, as every failed receive, sets the recovery flag);
//   begin      beginReceived (the registration is inside the received transition);
//   fetch      creator material and snapshot chunks; the creator serves only its
//              latest successor, so a target below the creator's epoch is refused
//              as stale;
//   turnover   the received turnover when due (writes completed = head - 1);
//   pending    beginRoomHeadAdvance (head pending);
//   commit     publication and commitRoomHeadAdvance (head = target);
//   activate   the successor plane registers at target.
// Failure points: any failure from precheck to turnover terminalizes the
// registration (quiesceReceived) and sets the recovery flag; a failure from
// pending on is the session's terminal failure (explicit, never retried); a failed
// recovery is terminal too. A process death at any step drops volatile progress;
// the session reopens (a pending head resolves forward), and startup discharges a
// halted reopen (both variants: startup always did).
// Concurrency: offers (the creator's announcement and the member's poll/request
// answer, racing) only replace the delivery's newest candidate, also while an
// install is in flight; the creator advances its epoch independently.
// The member's recovery-pool lull (idle) runs the received turnover; it may fail,
// leaving the plane unavailable and the recovery flag set.
//
// Variant BROKEN (the code before the fix): recover does not discharge a halted
// reopen. Expected wedge: lull at h (completed = h - 1), an install fails, the next
// install's recovery reopens halted, precheck refuses, sets the flag, the next
// recovery reopens halted again: a refusal that can never be escaped.
// Startup serving after a reopen (fix/silent-writer-catchup). A session that reopens on a
// successor head serves its installed successor (v3-room serveAvailableSuccessor ->
// creator-adoption readCreatorSuccessorExport). The export re-verifies the transition it
// would vouch for against the predecessor closure the member holds (verifyChain over the
// predecessor generation). An install more than one epoch ahead is a reattachment
// checkpoint: its closure keeps only the compact point proof (creator-transition-advance
// "not a second current trust or a native intermediate generation"), so no predecessor
// generation exists until the member installs the next epoch adjacently.
//   serveMode "fixed":  a checkpoint head is not an export source
//                       (CreatorSuccessorExportUnavailable): the session opens, serves nothing;
//   serveMode "refuse": the code at c08d8680: the export throws "creator successor native
//                       predecessor is unavailable" and the reopen fails (BROKEN);
//   serveMode "widen":  tolerance widened blindly: serve from a checkpoint head without the
//                       predecessor closure to verify it (BROKEN).
module memberSuccessorInstall {
  pure val MAX_EPOCH = 5
  pure val MAX_FAILURES = 2
  pure val MAX_DEATHS = 1
  pure val NONE = -1

  var creatorEpoch: int
  var headEpoch: int
  var headPending: bool
  var regEpoch: int
  var regStatus: str        // active | receiving | terminal | halted
  var completed: int        // durable completed retirement through epoch (NONE: none)
  var recoveryRequired: bool
  var phase: str            // idle | started | recovered | received | fetched | turned | pending | committed
  var target: int
  var candidate: int        // the delivery's newest offer (NONE: none)
  var terminal: bool        // explicit terminal refusal (the session's terminal failure)
  var refusals: int         // "current authority is unavailable" refusals (diagnostic, capped)
  var failures: int
  var deaths: int
  var fixed: bool
  var serveMode: str        // fixed | refuse | widen
  var checkpointHead: bool  // the head was installed more than one epoch ahead (a checkpoint)
  var openRefused: bool     // a reopen refused to open (startup serving threw)
  var servedUnverified: bool // a startup serve vouched for a transition it could not re-verify

  pure def reopenHalted(h: int, c: int): bool = h >= 2 and c + 1 == h
  // The registration a reopen leaves for an install (before any discharge).
  pure def reopened(h: int, c: int): str = if (reopenHalted(h, c)) "halted" else "active"
  pure def max(a: int, b: int): int = if (a > b) a else b

  action initServe(f: bool, m: str): bool = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, refusals' = 0, failures' = 0, deaths' = 0, fixed' = f,
    serveMode' = m, checkpointHead' = false, openRefused' = false, servedUnverified' = false,
  }
  action initWith(f: bool): bool = initServe(f, "fixed")
  action init = initWith(true)
  action initBroken = initWith(false)
  action initServeRefuse = initServe(true, "refuse")
  action initServeWiden = initServe(true, "widen")

  // Unchanged-variable helpers.
  action keepServe = all { serveMode' = serveMode, checkpointHead' = checkpointHead, openRefused' = openRefused,
    servedUnverified' = servedUnverified }
  action keepCreator = all { creatorEpoch' = creatorEpoch, fixed' = fixed, keepServe }

  // The creator seals and adopts its next epoch, independently of the member.
  action creatorAdvance: bool = all {
    creatorEpoch < MAX_EPOCH, creatorEpoch' = creatorEpoch + 1, fixed' = fixed, keepServe,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, phase' = phase, target' = target,
    candidate' = candidate, terminal' = terminal, refusals' = refusals, failures' = failures, deaths' = deaths,
  }
  // An offer reaches the delivery: the creator's announcement or its answer to the
  // member's request/poll (the creator answers with its latest only). Either may race
  // the other or an in-flight install; the delivery keeps the newest.
  action offer: bool = all {
    not(terminal), creatorEpoch > headEpoch, creatorEpoch > candidate, keepCreator,
    candidate' = creatorEpoch,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, phase' = phase, target' = target,
    terminal' = terminal, refusals' = refusals, failures' = failures, deaths' = deaths,
  }
  action start: bool = all {
    not(terminal), phase == "idle", candidate > headEpoch, keepCreator,
    phase' = "started", target' = candidate, candidate' = NONE,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, terminal' = terminal, refusals' = refusals,
    failures' = failures, deaths' = deaths,
  }
  // creatorRecipientRecoveryRequired -> recoverSettlementOwner(true) -> refreshRoomHeadState.
  action recover: bool = all {
    phase == "started", recoveryRequired, keepCreator,
    val status = reopened(headEpoch, completed)
    all {
      // FIXED: the halted reopen is discharged by the original reconciliation.
      regStatus' = if (fixed) "active" else status,
      regEpoch' = headEpoch,
      recoveryRequired' = false,
      phase' = "recovered",
    },
    headEpoch' = headEpoch, headPending' = headPending, completed' = completed, target' = target,
    candidate' = candidate, terminal' = terminal, refusals' = refusals, failures' = failures, deaths' = deaths,
  }
  // The recovery itself fails (reopen, or FIXED: the resume discharge): terminal, as at startup.
  action recoverFails: bool = all {
    phase == "started", recoveryRequired, failures < MAX_FAILURES, keepCreator,
    terminal' = true, phase' = "idle", failures' = failures + 1, regStatus' = "terminal",
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, completed' = completed,
    recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate, refusals' = refusals,
    deaths' = deaths,
  }
  action skipRecover: bool = all {
    phase == "started", not(recoveryRequired), keepCreator, phase' = "recovered",
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate,
    terminal' = terminal, refusals' = refusals, failures' = failures, deaths' = deaths,
  }
  val resolves = regStatus == "active" and regEpoch == headEpoch and not(headPending)
  // receiveCreatorSuccessorAdoption's first check, then beginReceived.
  action precheck: bool = all {
    phase == "recovered", keepCreator,
    if (resolves) all {
      phase' = "received", regStatus' = "receiving", recoveryRequired' = recoveryRequired, refusals' = refusals,
    } else all {
      // "creator recipient current authority is unavailable"; the catch sets the flag.
      phase' = "idle", regStatus' = regStatus, recoveryRequired' = true,
      refusals' = if (refusals < 3) refusals + 1 else refusals,
    },
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, completed' = completed,
    target' = target, candidate' = candidate, terminal' = terminal, failures' = failures, deaths' = deaths,
  }
  // A failed receive after beginReceived: quiesceReceived terminalizes the
  // registration; the install's catch sets creatorRecipientRecoveryRequired.
  action receiveFailed(c: int): bool = all {
    phase' = "idle", regStatus' = "terminal", recoveryRequired' = true, completed' = c,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, target' = target,
    candidate' = candidate, terminal' = terminal, refusals' = refusals, deaths' = deaths,
  }
  action fetch: bool = all {
    phase == "received", keepCreator,
    if (target < creatorEpoch) all { receiveFailed(completed), failures' = failures } // refused: stale
    else all {
      phase' = "fetched", regStatus' = regStatus, recoveryRequired' = recoveryRequired, completed' = completed,
      headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, target' = target,
      candidate' = candidate, terminal' = terminal, refusals' = refusals, failures' = failures, deaths' = deaths,
    },
  }
  // The received turnover, when due (nondeterministic), writes the completed control.
  action turnover: bool = {
    nondet due = Set(true, false).oneOf()
    all {
      phase == "fetched", keepCreator,
      completed' = if (due and headEpoch >= 2) max(completed, headEpoch - 1) else completed,
      phase' = "turned",
      headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
      recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate, terminal' = terminal,
      refusals' = refusals, failures' = failures, deaths' = deaths,
    }
  }
  // A transient failure inside the receive (a reset stream, an exhausted transfer
  // session, damaged bytes, a native refusal) at any receive step.
  action receiveFails: bool = all {
    Set("received", "fetched", "turned").contains(phase), failures < MAX_FAILURES, keepCreator,
    receiveFailed(completed), failures' = failures + 1,
  }
  action pending: bool = all {
    phase == "turned", keepCreator, phase' = "pending", headPending' = true,
    headEpoch' = headEpoch, regEpoch' = regEpoch, regStatus' = regStatus, completed' = completed,
    recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate, terminal' = terminal,
    refusals' = refusals, failures' = failures, deaths' = deaths,
  }
  action commit: bool = all {
    phase == "pending", creatorEpoch' = creatorEpoch, fixed' = fixed, serveMode' = serveMode,
    openRefused' = openRefused, servedUnverified' = servedUnverified,
    // A target more than one epoch ahead installs as a reattachment checkpoint.
    checkpointHead' = target > headEpoch + 1,
    phase' = "committed", headPending' = false, headEpoch' = target,
    regEpoch' = regEpoch, regStatus' = regStatus, completed' = completed, recoveryRequired' = recoveryRequired,
    target' = target, candidate' = candidate, terminal' = terminal, refusals' = refusals, failures' = failures,
    deaths' = deaths,
  }
  action activate: bool = all {
    phase == "committed", keepCreator, phase' = "idle", regEpoch' = target, regStatus' = "active",
    headEpoch' = headEpoch, headPending' = headPending, completed' = completed,
    recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate, terminal' = terminal,
    refusals' = 0, failures' = failures, deaths' = deaths,
  }
  // A failure during adoption publication: the session's terminal failure (explicit).
  action adoptionFails: bool = all {
    Set("pending", "committed").contains(phase), failures < MAX_FAILURES, keepCreator,
    terminal' = true, phase' = "idle", regStatus' = "terminal", failures' = failures + 1,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, completed' = completed,
    recoveryRequired' = true, target' = target, candidate' = candidate, refusals' = refusals, deaths' = deaths,
  }
  // The member's recovery-pool lull at an idle point (maintainRecipientRecoveryPool):
  // the received turnover writes completed = head - 1; the live plane stays admitted.
  action lull: bool = all {
    not(terminal), phase == "idle", resolves, headEpoch >= 2, not(recoveryRequired), completed < headEpoch - 1,
    keepCreator, completed' = headEpoch - 1,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    recoveryRequired' = recoveryRequired, phase' = phase, target' = target, candidate' = candidate,
    terminal' = terminal, refusals' = refusals, failures' = failures, deaths' = deaths,
  }
  // A failed lull: admission halts and the next install recovers first; the turnover
  // may or may not have completed before the failure.
  action lullFails: bool = {
    nondet c = Set(completed, headEpoch - 1).oneOf()
    all {
      not(terminal), phase == "idle", resolves, headEpoch >= 2, not(recoveryRequired), failures < MAX_FAILURES,
      keepCreator,
      completed' = c, regStatus' = "terminal", recoveryRequired' = true, failures' = failures + 1,
      headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, phase' = phase, target' = target,
      candidate' = candidate, terminal' = terminal, refusals' = refusals, deaths' = deaths,
    }
  }
  // Process death at any point; the page reopens the same replica. A pending head
  // resolves forward (consumeCreatorAdoptionPendingRecovery). Startup reopens the plane
  // and discharges a halted reopen in both variants (it always did).
  action die: bool = all {
    not(openRefused), deaths < MAX_DEATHS, creatorEpoch' = creatorEpoch, fixed' = fixed, serveMode' = serveMode,
    deaths' = deaths + 1,
    val h = if (headPending) target else headEpoch
    // The head the reopen starts on, and whether it is a checkpoint.
    val ck = if (headPending) target > headEpoch + 1 else checkpointHead
    // Startup serving (selectRoomStartup() == "successor": any head past genesis).
    val serving = h >= 1
    val refused = serving and ck and serveMode == "refuse"
    all {
      headEpoch' = h, headPending' = false, regEpoch' = h, regStatus' = if (refused) "terminal" else "active",
      phase' = "idle", candidate' = NONE, recoveryRequired' = false, terminal' = refused,
      checkpointHead' = ck, openRefused' = refused,
      servedUnverified' = (servedUnverified or (serving and ck and serveMode == "widen")),
    },
    completed' = completed, target' = target, refusals' = 0, failures' = failures,
  }

  // The member's own progress: the delivery's request/poll and retry, and the install
  // continuing through its steps. Failures, deaths, lulls and the creator's advance are
  // not assumed fair.
  action memberStep = any { offer, start, recover, skipRecover, precheck, fetch, turnover, pending, commit, activate }
  action step = any {
    creatorAdvance, offer, start, recover, recoverFails, skipRecover, precheck, fetch, turnover, receiveFails,
    pending, commit, activate, adoptionFails, lull, lullFails, die,
  }

  // Safety: whenever the registration does not resolve for an install at the head
  // (head and registration disagree, or the registration is unavailable) and the
  // session is not terminal, a recovery is enabled for the next install AND that
  // recovery escapes the refusal: the registration it leaves resolves at the head.
  // BROKEN violates the second half: the reopen is halted and the refusal recurs.
  val recoveryLeavesResolvable = if (fixed) true else not(reopenHalted(headEpoch, completed))
  val refusalEscapable =
    if (phase != "idle") true
    else if (terminal) true
    else if (resolves) true
    else if (not(recoveryRequired)) false
    else recoveryLeavesResolvable
  // The two records never disagree on the epoch outside an install's own steps.
  val headMatchesRegistration = if (phase != "idle") true else if (terminal) true else regEpoch == headEpoch
  // A reopen always opens, and startup serving vouches only for a transition it re-verified.
  val reopenOpens = not(openRefused)
  val servesOnlyVerified = not(servedUnverified)
  val serveSafety = reopenOpens and servesOnlyVerified
  val safety = if (not(refusalEscapable)) false else if (not(headMatchesRegistration)) false else serveSafety

  // Liveness: under weak fairness of the member's own steps, a member behind the
  // creator eventually catches up, or the session ends in an explicit terminal refusal.
  val behind = headEpoch < creatorEpoch
  val caughtUpOrTerminal = if (terminal) true else headEpoch == creatorEpoch
  val vars = (creatorEpoch, headEpoch, headPending, regEpoch, regStatus, completed, recoveryRequired, phase,
    target, candidate, terminal, refusals, failures, deaths, fixed, serveMode, checkpointHead, openRefused,
    servedUnverified)
  temporal memberFollows = weakFair(memberStep, vars) implies always(behind implies eventually(caughtUpOrTerminal))

  // Witnesses.
  action follow = offer.then(start).then(skipRecover).then(precheck).then(fetch).then(turnover).then(pending)
    .then(commit).then(activate)
  run followsTest = init.then(creatorAdvance).then(follow).then(creatorAdvance).then(follow)
    .then(all { assert(headEpoch == 2 and regEpoch == 2 and safety), creatorAdvance })
  // The native wedge, step for step (tests/creator-recipient-failed-install-after-lull-native.test.ts):
  // the lull at 2, the next install fails inside the receive, the retry's recovery reopens
  // halted, precheck refuses, and every later install refuses the same way.
  run brokenWedgeTest = initBroken.then(creatorAdvance).then(follow).then(creatorAdvance).then(follow)
    .then(lull).then(creatorAdvance).then(offer).then(start).then(skipRecover).then(precheck).then(receiveFails)
    .then(all { assert(recoveryRequired and not(refusalEscapable)), offer }).then(start).then(recover)
    .then(all { assert(regStatus == "halted"), precheck })
    .then(all { assert(phase == "idle" and refusals == 1 and recoveryRequired), offer }).then(start)
    .then(recover).then(precheck).then(all { assert(refusals == 2 and headEpoch == 2 and creatorEpoch == 3), creatorAdvance })
  run fixedRecoversTest = init.then(creatorAdvance).then(follow).then(creatorAdvance).then(follow)
    .then(lull).then(creatorAdvance).then(offer).then(start).then(skipRecover).then(precheck).then(receiveFails)
    .then(all { assert(refusalEscapable), offer }).then(start).then(recover).then(all { assert(regStatus == "active"), precheck })
    .then(fetch).then(turnover).then(pending).then(commit).then(activate)
    .then(all { assert(headEpoch == 3 and creatorEpoch == 3 and safety), creatorAdvance })
  // A skip install (the creator two epochs ahead), then a reopen: FIXED opens and serves nothing;
  // the c08d8680 code refuses to open; a widened tolerance serves an unverified transition.
  action skipThenDie = creatorAdvance.then(creatorAdvance).then(follow).then(die)
  run reopenAfterSkipTest = init.then(creatorAdvance).then(follow).then(skipThenDie)
    .then(all { assert(headEpoch == 3 and checkpointHead and serveSafety and safety), creatorAdvance })
  run reopenAfterSkipRefusedTest = initServeRefuse.then(creatorAdvance).then(follow).then(skipThenDie)
    .then(all { assert(openRefused and not(reopenOpens)), creatorAdvance })
  run reopenAfterSkipWidenedTest = initServeWiden.then(creatorAdvance).then(follow).then(skipThenDie)
    .then(all { assert(servedUnverified and not(servesOnlyVerified)), creatorAdvance })
  // After the next adjacent install the head has its predecessor and is an export source again.
  run adjacentAfterSkipTest = initServeRefuse.then(creatorAdvance).then(follow).then(creatorAdvance)
    .then(creatorAdvance).then(follow).then(creatorAdvance).then(follow).then(die)
    .then(all { assert(not(checkpointHead) and reopenOpens), creatorAdvance })
  // A stale target (the creator advanced during the install) fails and the newer offer installs.
  run staleThenNewerTest = init.then(creatorAdvance).then(offer).then(start).then(skipRecover).then(precheck)
    .then(creatorAdvance).then(offer).then(fetch).then(all { assert(recoveryRequired and candidate == 2), start })
    .then(recover).then(precheck).then(fetch).then(turnover).then(pending).then(commit).then(activate)
    .then(all { assert(headEpoch == 2 and safety), creatorAdvance })
}
