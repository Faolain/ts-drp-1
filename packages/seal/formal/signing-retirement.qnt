module signingRetirement {
  import sealSafety.Vote from "./seal-safety"
  import sealSafety.vote from "./seal-safety"
  import sealSafety.sameSlot from "./seal-safety"
  import sealSafety.validTuple from "./seal-safety"

  // One signer and two rounds. Ghost signed/delivered sets are proof history,
  // NOT a proposed durable tombstone catalog. Real signatures are abstracted.
  type State = { detail:Set[Vote], outbox:Set[Vote], signed:Set[Vote], delivered:Set[Vote],
    floor:int, lock:str, lockRound:int, highestQc:int, committed:str,
    revision:int, captured:int, incarnation:int, capturedIncarnation:int,
    intent:bool, fenced:bool, compacted:bool, observed:bool, uncertain:bool,
    crashed:bool, refused:bool }
  var s:State
  pure val P0 = vote("A",0,"prepare","value-X")
  pure val C0 = vote("A",0,"commit","value-X")
  pure val P1 = vote("A",1,"prepare","value-X")
  pure val C1 = vote("A",1,"commit","value-X")
  val currency = s.revision==s.captured and s.incarnation==s.capturedIncarnation and not(s.crashed)
  val signingFloorSurvivesCompaction = s.compacted.implies(s.floor==1 and
    s.lock=="value-X" and s.lockRound==1 and s.highestQc==1 and s.committed=="value-X")
  val noConflictingSignatureAfterRestart = s.signed.forall(a =>
    s.signed.forall(b => not(sameSlot(a,b)) or a==b))
  val retiredEvidenceCannotResurrect = s.detail.forall(v => v.round>=s.floor) and
    s.outbox.forall(v => v.round>=s.floor)
  val currentQcDependenciesRetained = s.detail.contains(P1) and s.detail.contains(C1)
  val retainedDetailRespectsLock = s.detail.forall(v => v.valueDigest==s.lock)
  val durableBeforeGossip = s.delivered.subseteq(s.signed)
  val safety = signingFloorSurvivesCompaction and noConflictingSignatureAfterRestart and
    retiredEvidenceCannotResurrect and currentQcDependenciesRetained and retainedDetailRespectsLock and durableBeforeGossip
  // Only actual durable state is readable by recovery. Ghost history is never
  // an authorization predicate, even indirectly through a safety conjunction.
  val durableReadback = signingFloorSurvivesCompaction and retiredEvidenceCannotResurrect and
    currentQcDependenciesRetained and retainedDetailRespectsLock
  val complete = s.compacted and s.observed and not(s.uncertain) and not(s.intent)
  action init = s' = {detail:Set(P0,C0,P1,C1),outbox:Set(P0,C0,P1,C1),
    signed:Set(P0,C0,P1,C1),delivered:Set(P0,C0),floor:0,lock:"value-X",
    lockRound:1,highestQc:1,committed:"value-X",revision:1,captured:1,
    incarnation:1,capturedIncarnation:1,intent:false,fenced:false,compacted:false,
    observed:false,uncertain:false,crashed:false,refused:false}
  action prepare = s' = if(currency and currentQcDependenciesRetained and not(s.intent))
    s.with("intent",true) else s.with("refused",true)
  // Native atomic participant transaction must preserve the entire lock/QC/
  // committed summary and remove detail below its new floor together.
  action compact(lost:bool):bool = s' = if(currency and s.intent and s.fenced and currentQcDependenciesRetained)
    s.with("floor",1).with("detail",s.detail.filter(v => v.round>=1))
      .with("outbox",s.outbox.filter(v => v.round>=1)).with("compacted",true)
      .with("uncertain",lost).with("observed",not(lost)) else s.with("refused",true)
  action fence = s' = if(currency and s.intent) s.with("fenced",true) else s.with("refused",true)
  action readback = s' = if(currency and s.intent and s.fenced and s.compacted and durableReadback)
    s.with("observed",true).with("uncertain",false) else s.with("refused",true)
  action finish = s' = if(currency and s.compacted and s.observed and not(s.uncertain))
    s.with("intent",false).with("fenced",false) else s.with("refused",true)
  def allowed(v:Vote):bool = currency and validTuple(v) and v.signer=="A" and
    v.round>=s.floor and v.round<=2 and v.valueDigest==s.lock and
    not(s.detail.exists(old => sameSlot(old,v) and old!=v))
  action sign(v:Vote):bool = s' = if(allowed(v))
    s.with("detail",s.detail.union(Set(v))).with("outbox",s.outbox.union(Set(v)))
      .with("signed",s.signed.union(Set(v))) else s.with("refused",true)
  // Restore requires retained durable detail, not the proof-only ghost history.
  action restore(v:Vote):bool = s' = if(allowed(v) and s.detail.contains(v))
    s.with("detail",s.detail.union(Set(v))).with("outbox",s.outbox.union(Set(v)))
    else s.with("refused",true)
  action dispatch(v:Vote):bool = s' = if(currency and v.round>=s.floor and s.outbox.contains(v) and s.detail.contains(v))
    s.with("delivered",s.delivered.union(Set(v))) else s.with("refused",true)
  action acknowledge(v:Vote):bool = s' = if(currency and v.round>=s.floor and s.outbox.contains(v))
    s.with("outbox",s.outbox.exclude(Set(v))) else s.with("refused",true)
  action stale(kind:str):bool = s' = if(kind=="revision") s.with("revision",2) else s.with("incarnation",2)
  action crash = s' = s.with("crashed",true).with("observed",false)
  action restart = s' = s.with("crashed",false)
  action stutter = s' = s
  action unsafeRestore = s' = s.with("detail",s.detail.union(Set(P0)))
  action unsafeConflictingSign = s' = s.with("signed",s.signed.union(Set(vote("A",0,"prepare","value-Y"))))
  action unsafeResetSummary = s' = s.with("lock","").with("highestQc",0)
  action progress = if(complete) stutter else if(s.crashed) restart
    else if(not(s.intent)) prepare else if(not(s.fenced)) fence
    else if(not(s.compacted)) compact(false) else if(not(s.observed) or s.uncertain) readback else finish
  action step = any {prepare,fence,compact(false),compact(true),readback,finish,
    sign(P0),sign(vote("A",2,"prepare","value-X")),sign(vote("A",0,"prepare","value-Y")),
    restore(P0),dispatch(P0),acknowledge(P0),stale("revision"),stale("incarnation"),crash,restart,stutter}
  run healthyDetailDrainTest = init.then(prepare).then(fence).then(compact(false)).then(finish).expect(safety and complete and s.detail.size()==2)
  run delayedSignRefusesTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(sign(P0)).expect(s.refused and safety)
  run delayedRestoreRefusesTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(restore(P0)).expect(s.refused and safety)
  run delayedDispatchRefusesTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(dispatch(P0)).expect(s.refused and safety)
  run delayedAckRefusesTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(acknowledge(P0)).expect(s.refused and safety)
  run currentSigningStillEnabledTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(sign(vote("A",2,"prepare","value-X"))).expect(s.detail.size()==3 and safety)
  run newlySignedDeliveryGroundedTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(sign(vote("A",2,"prepare","value-X"))).then(dispatch(vote("A",2,"prepare","value-X"))).expect(s.delivered.contains(vote("A",2,"prepare","value-X")) and safety)
  run conflictingSignatureRefusesTest = init.then(prepare).then(fence).then(compact(false)).then(crash).then(restart).then(sign(vote("A",0,"prepare","value-Y"))).expect(s.refused and safety)
  run unoccupiedCurrentRoundLockRefusesTest = init.then(prepare).then(fence).then(compact(false)).then(crash).then(restart).then(sign(vote("A",2,"prepare","value-Y"))).expect(s.refused and not(s.detail.contains(vote("A",2,"prepare","value-Y"))) and safety)
  run staleRevisionRefusesTest = init.then(prepare).then(fence).then(stale("revision")).then(compact(false)).expect(s.refused and not(s.compacted) and safety)
  run staleIncarnationRefusesTest = init.then(prepare).then(fence).then(stale("incarnation")).then(compact(false)).expect(s.refused and not(s.compacted) and safety)
  run lostAckNeedsReadbackTest = init.then(prepare).then(fence).then(compact(true)).then(crash).then(restart).then(finish).expect(s.refused and s.intent).then(readback).then(finish).expect(complete and safety)
  run unsafeRestoreCounterexampleTest = init.then(prepare).then(fence).then(compact(false)).then(finish).then(unsafeRestore).expect(not(safety))
  run unsafeConflictCounterexampleTest = init.then(prepare).then(fence).then(compact(false)).then(unsafeConflictingSign).expect(not(safety))
  run unsafeSummaryResetCounterexampleTest = init.then(prepare).then(fence).then(compact(false)).then(unsafeResetSummary).expect(not(safety))
}

module finalityExecutionCustody {
  // One genuine, already-created finality key. Request authentication and actual
  // Ed25519/key erasure are premises, not checked by this execution adjunct.
  // This volatile exclusion cannot replace the native permanent epoch/round
  // frontier or establish custody of another signer reconstructed from a seed.
  type State = {admitted:Set[int], frozen:bool, joined:bool, released:bool,
    retired:bool, keyPresent:bool, acquired:bool, refused:bool, badAdmission:bool}
  var e:State
  val noNewAdmissionAfterRevocation = not(e.badAdmission)
  val releaseJoinsAdmittedExecution = e.joined.implies(e.admitted == Set())
  val retiredKeyClearedAfterJoin = (e.retired and e.joined).implies(not(e.keyPresent))
  val safety = noNewAdmissionAfterRevocation and releaseJoinsAdmittedExecution and retiredKeyClearedAfterJoin
  action init = e' = {admitted:Set(),frozen:false,joined:false,released:false,
    retired:false,keyPresent:true,acquired:false,refused:false,badAdmission:false}
  action admit(id:int):bool = e' = if(not(e.frozen or e.retired) and e.keyPresent)
    e.with("admitted",e.admitted.union(Set(id))).with("joined",false)
    else e.with("refused",true)
  action complete(id:int):bool = e' = e.with("admitted",e.admitted.exclude(Set(id)))
  action acquire = e' = if(not(e.frozen or e.retired))
    e.with("frozen",true).with("released",false).with("acquired",false).with("joined",false)
    else e.with("refused",true)
  action acquisitionReturn = e' = if(e.frozen and not(e.retired) and e.admitted == Set())
    e.with("acquired",true).with("joined",true) else e.with("refused",true)
  action release = e' = if(e.acquired and e.admitted == Set())
    e.with("frozen",false).with("released",true).with("acquired",false)
    else e.with("refused",true)
  action retire = e' = e.with("retired",true).with("acquired",false).with("joined",false)
  action retirementJoin = e' = if(e.retired and e.admitted == Set())
    e.with("joined",true).with("keyPresent",false) else e.with("refused",true)
  action unsafeAdmission = e' = e.with("admitted",e.admitted.union(Set(1)))
    .with("badAdmission",e.frozen or e.retired)
  action unsafeReturnBeforeJoin = e' = e.with("acquired",true).with("joined",true)
  action step = any {admit(0),admit(1),complete(0),complete(1),acquire,
    acquisitionReturn,release,retire,retirementJoin}
  run executionHealthyContinuationTest = init.then(admit(0)).then(acquire).then(admit(1))
    .then(acquisitionReturn).expect(safety and e.refused and not(e.acquired))
    .then(complete(0)).then(acquisitionReturn).then(release).then(admit(1))
    .expect(safety and e.admitted == Set(1) and not(e.frozen))
  run executionRetirementJoinsTest = init.then(admit(0)).then(retire).then(admit(1))
    .then(retirementJoin).expect(safety and e.keyPresent and not(e.joined))
    .then(complete(0)).then(retirementJoin).then(admit(1))
    .expect(safety and not(e.keyPresent) and e.admitted == Set())
  run executionRetireDuringAcquisitionTest = init.then(admit(0)).then(acquire).then(retire)
    .then(complete(0)).then(retirementJoin).then(acquisitionReturn)
    .expect(safety and e.refused and not(e.acquired) and not(e.keyPresent))
  run executionMissingAdmissionGuardKilledTest = init.then(acquire).then(unsafeAdmission).expect(not(safety))
  run executionEarlyJoinKilledTest = init.then(admit(0)).then(acquire).then(unsafeReturnBeforeJoin).expect(not(safety))
  run executionEveryAdmittedSignatureJoinsTest = init.then(admit(0)).then(admit(1)).then(acquire)
    .then(complete(0)).then(acquisitionReturn).expect(safety and not(e.acquired) and e.admitted == Set(1))
    .then(complete(1)).then(acquisitionReturn).then(release)
    .expect(safety and e.released and e.admitted == Set())
}
