// sealPacemakerAdmission, moved verbatim out of seal-pacemaker.qnt.
// It was appended to that file by ea4eb1582; the Phase 5d contract
// (tests/fixtures/phase-5d-v3/pacemaker-contract.json) pins seal-pacemaker.qnt
// at f877e4d2..., so the governed sealPacemaker file keeps its bytes and this
// standalone module (no imports) lives here. The module body is unchanged.

// Local admission extension; original consensus module above is unchanged.
// Captured input sizes/quorum and native authentication/storage atomicity are
// premises. This model covers the admitted-job counter and join/stop/timer
// boundaries, not cryptography, byte encoding, physical heap or universal
// progress while a native job is permanently suspended.
module sealPacemakerAdmission {
  pure val LIMIT = 32
  var admitted: int
  var entered: bool
  var accepting: bool
  var stopped: bool
  var timerDebt: bool

  action initialize(count) = all {
    admitted' = count, entered' = false, accepting' = true,
    stopped' = false, timerDebt' = false,
  }
  action init = initialize(0)
  action initFull = initialize(LIMIT)
  action admit = all {
    accepting, admitted < LIMIT, admitted' = admitted + 1,
    entered' = entered, accepting' = accepting,
    stopped' = stopped, timerDebt' = timerDebt,
  }
  action enter = all {
    admitted > 0, not(entered), entered' = true,
    admitted' = admitted, accepting' = accepting,
    stopped' = stopped, timerDebt' = timerDebt,
  }
  action join = all {
    entered, admitted' = admitted - 1, entered' = false,
    accepting' = accepting, stopped' = stopped, timerDebt' = timerDebt,
  }
  action beginStop = all {
    accepting, accepting' = false, admitted' = admitted,
    entered' = entered, stopped' = stopped, timerDebt' = false,
  }
  action finishStop = all {
    not(accepting), admitted == 0, not(entered), stopped' = true,
    admitted' = admitted, entered' = entered,
    accepting' = accepting, timerDebt' = false,
  }
  action refuseTimerAtCapacity = all {
    accepting, admitted == LIMIT, timerDebt' = true,
    admitted' = admitted, entered' = entered,
    accepting' = accepting, stopped' = stopped,
  }
  action retryTimer = all {
    accepting, timerDebt, admitted < LIMIT, admitted' = admitted + 1,
    timerDebt' = false, entered' = entered,
    accepting' = accepting, stopped' = stopped,
  }
  action refuse = all {
    admitted' = admitted, entered' = entered, accepting' = accepting,
    stopped' = stopped, timerDebt' = timerDebt,
  }
  action step = any { admit, enter, join, beginStop, finishStop,
    refuseTimerAtCapacity, retryTimer, refuse }

  val admissionSafe = admitted >= 0 and admitted <= LIMIT and
    (not(entered) or admitted > 0) and
    (not(stopped) or (not(accepting) and admitted == 0 and not(entered))) and
    (accepting or not(timerDebt))
  val joinedStop = stopped and admitted == 0

  action check(condition) = all { assert(condition), refuse }

  // Deliberately broken old guard: capacity must reject this transition.
  action brokenAdmit = all {
    accepting, admitted' = admitted + 1, entered' = entered,
    accepting' = accepting, stopped' = stopped, timerDebt' = timerDebt,
  }

  run testLegitimateContinuationAndJoinedStop = init
    .then(admit).then(enter).then(admit).then(beginStop)
    .then(join).then(enter).then(join).then(finishStop)
    .then(check(admissionSafe and joinedStop))
  run testFullTimerContinuesAfterJoin = initFull
    .then(refuseTimerAtCapacity).then(enter).then(join).then(retryTimer)
    .then(check(admissionSafe and admitted == LIMIT and not(timerDebt)))
}
