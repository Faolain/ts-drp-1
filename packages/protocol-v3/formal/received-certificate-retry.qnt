module receivedCertificateRetry {
  // Finite same-offer custody adjunct. Authentication, complete native closure,
  // exact certificate bytes and independently current owners are assumptions.
  type State = { certificate:bool, known:bool, matching:bool, current:bool,
    replayValid:bool, replaySealed:bool, replayRefused:bool, receiveGateOpen:bool, lookupReached:bool,
    observedCertificate:bool, resumptionReserved:bool, foreignRefused:bool, retryStarted:bool,
    held:bool, retainedCandidate:int, head:int, floor:int, incarnation:int,
    charge:int, oldTerminal:bool, quiescent:bool, aborted:bool, acknowledged:bool, adopted:bool,
    reconstructed:bool, refused:bool }
  var s:State
  val retainedCustodyPreserved = s.certificate.implies(
    s.retainedCandidate==1 and s.incarnation==1 and s.charge==1 and not(s.aborted))
  val adoptionUsesVerifiedRetainedIdentity = s.adopted.implies(
    s.reconstructed and s.matching and s.head==s.retainedCandidate and s.floor==1)
  val ambiguousCustodyNeverAbortsPredecessor = (not(s.known) or s.certificate).implies(not(s.aborted))
  val ambiguousFailureCannotReactivate = (s.refused and (not(s.known) or s.certificate)).implies(not(s.receiveGateOpen))
  val replayBeforeOccupiedLookup = s.lookupReached.implies(s.replaySealed)
  val safety = retainedCustodyPreserved and adoptionUsesVerifiedRetainedIdentity and
    ambiguousCustodyNeverAbortsPredecessor and ambiguousFailureCannotReactivate and
    replayBeforeOccupiedLookup and s.charge<=1
  val replayCurrent = s.replayValid and s.replaySealed
  val complete = s.adopted and s.acknowledged and not(s.held) and not(s.quiescent)
  action init = s' = {certificate:false,known:true,matching:true,current:true,
    replayValid:true,replaySealed:false,replayRefused:false,receiveGateOpen:true,lookupReached:false,
    observedCertificate:false,resumptionReserved:false,foreignRefused:false,retryStarted:false,
    held:false,retainedCandidate:1,head:0,floor:0,incarnation:1,charge:0,
    oldTerminal:false,quiescent:false,aborted:false,acknowledged:false,adopted:false,
    reconstructed:false,refused:false}
  action acquire = s' = if(s.current and not(s.held) and not(s.quiescent) and not(s.aborted))
    s.with("held",true).with("receiveGateOpen",false).with("retryStarted",true)
    else s.with("refused",true)
  // Original native retain completes; its delivered acknowledgement is lost.
  // This is the original owner's admitted retain, not the retry owner's hold.
  // Restricted to the observed PRE-RETRY prefix; later custody interleavings
  // use foreignRetain, which preserves detached knowledge and checks exclusion.
  action retainLostAck = s' = if(not(s.retryStarted) and s.current and not(s.oldTerminal) and not(s.certificate) and not(s.aborted))
    s.with("certificate",true).with("charge",1).with("known",false).with("oldTerminal",true)
    else s.with("foreignRefused",true)
  // A genuinely preexisting second owner, not a bootstrap grant after custody.
  // Native replay validation is an independent prerequisite, not startup-head equality.
  // Safe refusal is prospective; source's early abort is a counterexample below.
  action sealReplay = s' = if(s.current and s.held and not(s.quiescent) and s.replayValid)
    s.with("replaySealed",true)
    else s.with("replayRefused",true).with("refused",true).with("quiescent",true)
  action freshLookup = s' = if(s.current and replayCurrent and s.held and not(s.quiescent))
    s.with("known",true).with("observedCertificate",s.certificate).with("lookupReached",true)
    else s.with("refused",true).with("quiescent",true)
  action reconstruct = s' = if(s.current and replayCurrent and s.held and not(s.quiescent) and s.known and s.observedCertificate and s.matching)
    s.with("reconstructed",true) else s.with("refused",true).with("quiescent",true)
  action adopt = s' = if(s.current and replayCurrent and s.held and not(s.quiescent) and s.known and s.observedCertificate and
    s.matching and s.reconstructed)
      s.with("head",s.retainedCandidate).with("floor",1).with("adopted",true)
      else s.with("refused",true).with("quiescent",true)
  action acknowledge = s' = if(s.current and replayCurrent and not(s.quiescent) and s.adopted and s.reconstructed)
    s.with("acknowledged",true) else s.with("refused",true).with("quiescent",true)
  action release = s' = s.with("held",false)
  // PROSPECTIVE linearized exclusion by all genuine relevant native owners.
  // No such capability is supplied by a floor callback or today's detached reads.
  // This finite adjunct does not model its later release/handover lifecycle.
  action reserveResumption = s' = if(s.current and replayCurrent and s.held and not(s.quiescent) and
    not(s.certificate) and s.head==0 and s.floor==0)
      s.with("known",true).with("observedCertificate",false).with("resumptionReserved",true)
      else s.with("refused",true).with("quiescent",true)
  action abortAbsent = s' = if(s.current and replayCurrent and s.held and not(s.quiescent) and s.resumptionReserved and
    s.known and not(s.observedCertificate) and s.head==0 and s.floor==0)
    s.with("aborted",true).with("receiveGateOpen",true) else s.with("refused",true).with("quiescent",true)
  // A foreign actual native retain does not magically update this owner's
  // detached NULL observation, AHE head/floor or replay Boolean.
  action foreignRetain = s' = if(not(s.resumptionReserved) and not(s.certificate))
    s.with("certificate",true).with("charge",1) else s.with("foreignRefused",true)
  action lookupUncertain = s' = s.with("known",false)
  action mismatch = s' = s.with("matching",false)
  action stale = s' = s.with("current",false)
  action invalidateReplay = s' = s.with("replayValid",false)
  // Source finally(!dependent) abortReceived reopens only the local live gate;
  // it is not a claim that the persisted certificate was deleted or floor changed.
  action unsafeEarlyGateAbort = s' = s.with("receiveGateOpen",true).with("held",false)
  action unsafeAbortFromDetachedAbsence = s' = if(s.current and replayCurrent and s.held and
    s.known and not(s.observedCertificate) and s.head==0 and s.floor==0)
      s.with("aborted",true).with("receiveGateOpen",true) else s.with("refused",true)
  action unsafeAbortOccupied = s' = s.with("aborted",true)
  action unsafeNewCandidate = s' = s.with("head",2).with("adopted",true).with("reconstructed",true)
  action unsafeDoubleCharge = s' = s.with("charge",2)
  action lostOriginal = init.then(retainLostAck).then(acquire).then(sealReplay)
  run exactOccupiedRetryTest = lostOriginal.then(freshLookup).then(reconstruct).then(adopt).then(acknowledge).then(release).expect(safety and complete)
  run occupiedCannotAbortTest = lostOriginal.then(freshLookup).then(abortAbsent).expect(s.refused and s.quiescent and safety)
  run unknownLookupCannotAbortTest = init.then(acquire).then(sealReplay).then(reserveResumption).then(lookupUncertain)
    .then(abortAbsent).expect(s.refused and safety)
  run verifiedAbsenceMayAbortTest = init.then(acquire).then(sealReplay).then(reserveResumption).then(abortAbsent)
    .expect(s.aborted and s.receiveGateOpen and safety)
  run mismatchedCertificateRefusesTest = lostOriginal.then(freshLookup).then(mismatch).then(reconstruct).then(adopt).expect(s.refused and not(s.adopted) and safety)
  run staleOccupiedOwnerRefusesTest = lostOriginal.then(freshLookup).then(reconstruct).then(stale).then(adopt).expect(s.refused and not(s.adopted) and safety)
  run reconstructionRequiredTest = lostOriginal.then(freshLookup).then(adopt).expect(s.refused and not(s.adopted) and safety)
  run unsafeAbortCounterexampleTest = lostOriginal.then(unsafeAbortOccupied).expect(not(safety))
  run unrelatedCandidateCounterexampleTest = lostOriginal.then(freshLookup).then(unsafeNewCandidate).expect(not(safety))
  run doubleChargeCounterexampleTest = lostOriginal.then(unsafeDoubleCharge).expect(not(safety))
  run startupHeadDoesNotImplyReplayTest = init.then(retainLostAck).then(acquire).then(invalidateReplay)
    .then(sealReplay).expect(s.current and s.replayRefused and not(s.lookupReached) and not(s.receiveGateOpen) and safety)
  run lookupRequiresReplayTest = init.then(retainLostAck).then(acquire).then(freshLookup)
    .expect(s.refused and not(s.lookupReached) and safety)
  run staleReplayAfterLookupRefusesTest = lostOriginal.then(freshLookup).then(reconstruct).then(invalidateReplay).then(adopt)
    .expect(s.refused and not(s.adopted) and safety)
  run earlyAbortOccupiedCounterexampleTest = init.then(retainLostAck).then(acquire).then(invalidateReplay)
    .then(sealReplay).then(unsafeEarlyGateAbort).expect(not(safety) and s.certificate and s.head==0 and s.floor==0)
  run detachedAbsenceDoesNotReserveTest = init.then(acquire).then(sealReplay).then(freshLookup).then(foreignRetain)
    .then(abortAbsent).expect(s.refused and s.quiescent and s.known and not(s.observedCertificate) and safety)
  run detachedAbsenceAbortCounterexampleTest = init.then(acquire).then(sealReplay).then(freshLookup).then(foreignRetain)
    .then(unsafeAbortFromDetachedAbsence).expect(not(safety) and s.certificate and s.head==0 and s.floor==0 and s.current)
  run reservationExcludesForeignRetainTest = init.then(acquire).then(sealReplay).then(reserveResumption).then(foreignRetain)
    .then(abortAbsent).expect(s.foreignRefused and not(s.certificate) and s.aborted and safety)
  run originalRetainRestrictedToPrefixTest = init.then(acquire).then(sealReplay).then(reserveResumption).then(retainLostAck)
    .expect(s.foreignRefused and not(s.certificate) and s.known and not(s.refused) and safety)
}
