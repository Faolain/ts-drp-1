// One interrupted, authenticated retirement intent. Startup may reconcile that
// original intent while ordinary admission remains halted. Durable completion
// alone is insufficient: terminal verification and native release must join.
module retirementRecoveryAdmission {
  type State = { durable:str, stage:str, requested:int, qualified:bool, proof:bool,
    verified:bool, joined:bool, ordinary:bool, badIdentity:bool }
  var s: State
  pure def safetyOf(st: State): bool = and {
    not(st.badIdentity),
    (st.stage == "open").implies(st.durable == "completed" and st.qualified and st.proof and st.verified and st.joined),
    st.ordinary.implies(st.stage == "open"),
  }
  val safety = safetyOf(s)
  val neverOrdinary = not(s.ordinary)
  action init = s' = {durable:"active", stage:"halted", requested:-1, qualified:true, proof:false, verified:false, joined:false,
    ordinary:false, badIdentity:false}
  action beginRecovery(intent: int): bool = all { s.stage == "halted", intent == 0, s.qualified,
    // 0 denotes the original private request identity. qualified abstracts exact
    // current head, preparation domains, floor+1=current epoch, and no nominee.
    s' = s.with("stage", "reconciling").with("requested", intent),
  }
  action reconcile(hasProof: bool): bool = all { s.stage == "reconciling", s.requested == 0,
    s' = s.with("durable", "completed").with("stage", "terminal").with("proof", hasProof),
  }
  action verifyTerminal = all { s.stage == "terminal", s.durable == "completed",
    s' = if (s.proof) s.with("verified", true).with("stage", "releasing") else s.with("stage", "refused"),
  }
  action joinRelease = all { s.stage == "releasing", s' = s.with("joined", true).with("stage", "released") }
  action openAdmission = all { s.stage == "released", s.verified, s.joined,
    s' = s.with("stage", "open"),
  }
  action admitOrdinary = all { s.stage == "open", s' = s.with("ordinary", true) }
  // A dead process loses its runtime checks. Reopen verifies the durable old
  // or completed original intent afresh; old verification flags convey no right.
  action crashReopen = all { s.stage != "open",
    s' = s.with("stage", "halted").with("requested", -1).with("proof", false).with("verified", false).with("joined", false),
  }
  action invalidateRequest = all { s.stage == "halted", s' = s.with("qualified", false) }
  action step = any { verifyTerminal, joinRelease, openAdmission, admitOrdinary, crashReopen, invalidateRequest,
    { nondet hasProof = Set(false, true).oneOf() reconcile(hasProof) },
    { nondet intent = Set(0, 1).oneOf() beginRecovery(intent) },
  }
  action unsafeForeignRecovery = all { s.stage == "halted",
    s' = s.with("stage", "reconciling").with("requested", 1).with("badIdentity", true),
  }
  action unsafeOpenOnDurableComplete = all { s.durable == "completed", s' = s.with("stage", "open") }
  action unsafeAdmitWhileHalted = all { s.stage == "halted", s' = s.with("ordinary", true) }
  action unsafeVerifyEmptyProof = all { s.stage == "terminal", not(s.proof),
    s' = s.with("verified", true).with("stage", "releasing"),
  }
  action unsafeStep = any { step, unsafeForeignRecovery, unsafeOpenOnDurableComplete, unsafeAdmitWhileHalted, unsafeVerifyEmptyProof }
  action finishRecovery = beginRecovery(0).then(reconcile(true)).then(verifyTerminal).then(joinRelease).then(openAdmission)
  run exactRecoveryJoinsBeforeOrdinaryTest = init.then(beginRecovery(0)).then(reconcile(true))
    .expect(not(s.ordinary) and s.stage != "open" and safety).then(verifyTerminal).then(joinRelease)
    .then(openAdmission).then(admitOrdinary).expect(s.ordinary and safety)
  run crashAfterCommitReverifiesBeforeAdmissionTest = init.then(beginRecovery(0)).then(reconcile(true)).then(crashReopen)
    .expect(s.durable == "completed" and not(s.verified) and safety).then(finishRecovery).then(admitOrdinary).expect(safety)
  run foreignActiveIntentCounterexampleTest = init.then(unsafeForeignRecovery).expect(not(safety))
  run completionBeforeReleaseCounterexampleTest = init.then(beginRecovery(0)).then(reconcile(true))
    .then(unsafeOpenOnDurableComplete).expect(not(safety))
  run ordinaryBeforeRecoveryCounterexampleTest = init.then(unsafeAdmitWhileHalted).expect(not(safety))
  run emptyProofRefusesAdmissionTest = init.then(beginRecovery(0)).then(reconcile(false)).then(verifyTerminal)
    .expect(s.stage == "refused" and not(s.ordinary) and safety)
  run emptyProofCounterexampleTest = init.then(beginRecovery(0)).then(reconcile(false)).then(unsafeVerifyEmptyProof)
    .then(joinRelease).then(openAdmission).expect(not(safety))
}
