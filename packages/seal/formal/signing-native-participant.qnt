module signingNativeParticipant {
  import sealSafety.Vote from "./seal-safety"
  import sealSafety.vote from "./seal-safety"
  import sealSafety.sameSlot from "./seal-safety"
  // Mechanical addressed native participant. Eligibility, external execution,
  // native byte charges and authenticated source commitments are other evidence.
  type Effect = {epoch:int, round:int, cut:int, holes:Set[int]}
  type Native = {inc:int, revision:int, sequence:int, image:int,
    capturedInc:int, capturedRevision:int, capturedImage:int,
    alive:bool, used:bool, stage:int, operation:str, refused:bool,
    delivered:bool, unknown:bool, active:bool, activeCut:int, activeHoles:Set[int],
    cut:int, holes:Set[int], requested:int, requestedHoles:Set[int],
    pending:Set[int], detail:Set[Vote], qc:int, lock:int, roundFloor:int,
    effects:Set[Effect], capturing:bool, captureClosed:bool, captureReturned:bool,
    sEpoch:int,sRound:int,sBound:bool,sKey:bool,sPending:bool,sHeld:bool,
    sEntered:bool,sComplete:bool,sReleased:bool,sDelivered:bool,sExcluded:bool,sRefused:bool}
  var p:Native
  val currency = p.inc==p.capturedInc and p.revision==p.capturedRevision and p.image==p.capturedImage
  val monotone = p.requested>=p.cut and p.requestedHoles.forall(e=>e>p.cut or p.holes.contains(e))
  def legalEpoch(e:int):bool = (e>p.cut or p.holes.contains(e)) and
    (not(p.active) or e>p.activeCut or p.activeHoles.contains(e))
  val selectedSafe = p.effects.forall(e=>e.epoch>e.cut or e.holes.contains(e.epoch)) and
    p.effects.forall(e=>e.round>=p.roundFloor) and
    p.detail.forall(a=>p.detail.forall(b=>not(sameSlot(a,b)) or a==b)) and
    p.delivered.implies(p.stage==3 and not(p.unknown)) and p.qc==2 and p.lock==2
  action init = p'={inc:1,revision:0,sequence:0,image:0,capturedInc:1,capturedRevision:0,capturedImage:0,
    alive:false,used:false,stage:0,operation:"",refused:false,delivered:false,unknown:false,
    active:false,activeCut:-1,activeHoles:Set(),cut:-1,holes:Set(),requested:0,requestedHoles:Set(),
    pending:Set(),detail:Set(vote("A",2,"prepare","value-X")),qc:2,lock:2,roundFloor:1,effects:Set(),
    capturing:false,captureClosed:false,captureReturned:false,
    sEpoch:0,sRound:0,sBound:false,sKey:false,sPending:false,sHeld:false,sEntered:false,
    sComplete:false,sReleased:false,sDelivered:false,sExcluded:false,sRefused:false}
  action acquire = p'=p.with("capturedInc",p.inc).with("capturedRevision",p.revision).with("capturedImage",p.image)
    .with("alive",true).with("used",false).with("delivered",false).with("refused",false)
  action release = p'=p.with("alive",false)
  action invoke(kind:str,cut:int,holes:Set[int]):bool = p'=
    if(not(p.alive) or p.used or (kind=="prepare" and p.active) or (kind!="prepare" and not(p.active)))
      p.with("refused",true)
    else p.with("used",true).with("alive",false).with("stage",1).with("operation",kind)
      .with("requested",cut).with("requestedHoles",holes).with("delivered",false).with("refused",false)
  action requestSuccess = p'=p.with("stage",2)
  action nativeComplete(lost:bool):bool = p'=
    if((p.stage!=1 and p.stage!=2) or not(currency) or
      (p.operation=="prepare" and (not(monotone) or p.pending.exists(e=>e<=p.requested and not(p.requestedHoles.contains(e))))))
      p.with("stage",3).with("refused",true).with("unknown",false)
    else (if(p.operation=="prepare") p.with("active",true).with("activeCut",p.requested)
        .with("activeHoles",p.requestedHoles).with("sequence",p.sequence+1)
      else if(p.operation=="commit") p.with("cut",p.activeCut).with("holes",p.activeHoles).with("active",false)
      else p.with("active",false)).with("revision",p.revision+1).with("image",p.image+1)
        .with("stage",3).with("unknown",lost)
  action nativeAbort = p'=p.with("stage",3).with("refused",true).with("unknown",false)
  action deliver = p'= if(p.stage==3 and not(p.unknown)) p.with("delivered",true) else p.with("refused",true)
  action readback = p'=p.with("unknown",false)
  action foreignImage = p'=p.with("image",p.image+1)
  action restoreImage = p'=p.with("image",p.capturedImage)
  action foreignInc = p'=p.with("inc",p.inc+1)
  action addDebt = p'=p.with("pending",Set(0))
  action work(epoch:int,round:int):bool = p'=if(legalEpoch(epoch) and round>=p.roundFloor)
    p.with("effects",p.effects.union(Set({epoch:epoch,round:round,cut:p.cut,holes:p.holes})))
      .with("image",p.image+1).with("refused",false)
    else p.with("refused",true)
  action unsafeEarlyCommit = p'=p.with("cut",p.requested).with("holes",p.requestedHoles)
  action unsafeEarlyDelivery = p'=p.with("delivered",true)
  action unsafeRetiredWork = p'=p.with("effects",p.effects.union(Set({epoch:0,round:2,cut:p.cut,holes:p.holes})))
  val provisionalImageSafe = p.stage!=2 or (p.revision==p.capturedRevision and p.cut<0)
  run participantPrepareCommitProgressTest = init.then(acquire).then(invoke("prepare",2,Set(1)))
    .then(requestSuccess).expect(not(p.active) and selectedSafe).then(nativeComplete(false)).then(deliver)
    .then(acquire).then(invoke("commit",2,Set(1))).then(requestSuccess).then(nativeComplete(false)).then(deliver)
    .expect(p.cut==2 and p.holes==Set(1) and p.delivered and selectedSafe)
  run participantAbortPreservesSummariesTest = init.then(acquire).then(invoke("prepare",0,Set()))
    .then(requestSuccess).then(nativeComplete(false)).then(acquire).then(invoke("abort",0,Set()))
    .then(requestSuccess).then(nativeComplete(false)).expect(not(p.active) and p.cut<0 and selectedSafe)
  run participantForeignImageCasTest = init.then(acquire).then(invoke("prepare",0,Set())).then(foreignImage)
    .then(requestSuccess).then(nativeComplete(false)).expect(p.refused and not(p.active) and selectedSafe)
  run participantStaleIncarnationTest = init.then(acquire).then(invoke("prepare",0,Set())).then(foreignInc)
    .then(requestSuccess).then(nativeComplete(false)).expect(p.refused and not(p.active) and selectedSafe)
  run participantNativeRefusalConsumesReadTest = init.then(acquire).then(invoke("prepare",0,Set())).then(foreignImage)
    .then(requestSuccess).then(nativeComplete(false)).then(restoreImage).then(invoke("prepare",0,Set()))
    .expect(p.refused and p.used and not(p.active) and selectedSafe)
  run participantEarlyPhaseRefusalNonconsumingTest = init.then(acquire).then(invoke("abort",0,Set()))
    .expect(p.refused and not(p.used)).then(invoke("prepare",0,Set())).then(requestSuccess).then(nativeComplete(false))
    .expect(p.active and selectedSafe)
  run participantDebtRefusalTest = init.then(addDebt).then(acquire).then(invoke("prepare",0,Set()))
    .then(requestSuccess).then(nativeComplete(false)).expect(p.refused and not(p.active) and selectedSafe)
  run participantProtectedHoleAndFutureProgressTest = init.then(acquire).then(invoke("prepare",2,Set(1)))
    .then(requestSuccess).then(nativeComplete(false)).then(work(1,2)).expect(not(p.refused) and selectedSafe)
    .then(work(0,2)).expect(p.refused and selectedSafe).then(work(3,2)).expect(not(p.refused) and selectedSafe)
  run participantHoleCannotReturnTest = init.then(acquire).then(invoke("prepare",2,Set(1)))
    .then(requestSuccess).then(nativeComplete(false)).then(acquire).then(invoke("commit",2,Set(1)))
    .then(requestSuccess).then(nativeComplete(false)).then(acquire).then(invoke("prepare",3,Set(0,1)))
    .then(requestSuccess).then(nativeComplete(false)).expect(p.refused and not(p.active) and selectedSafe)
  run participantLostDeliveryReadbackTest = init.then(acquire).then(invoke("prepare",0,Set()))
    .then(requestSuccess).then(nativeComplete(true)).expect(p.active and p.unknown and not(p.delivered) and selectedSafe)
    .then(deliver).expect(not(p.delivered)).then(readback).then(deliver).expect(p.delivered and selectedSafe)
  run participantRequestCommitRuleKilledTest = init.then(acquire).then(invoke("prepare",0,Set()))
    .then(requestSuccess).expect(provisionalImageSafe).then(unsafeEarlyCommit).expect(not(provisionalImageSafe))
  run participantEarlyDeliveryRuleKilledTest = init.then(acquire).then(invoke("prepare",0,Set()))
    .then(requestSuccess).then(unsafeEarlyDelivery).expect(not(selectedSafe))
  run participantRetiredWorkRuleKilledTest = init.then(acquire).then(invoke("prepare",0,Set()))
    .then(requestSuccess).then(nativeComplete(false)).then(acquire).then(invoke("commit",0,Set()))
    .then(requestSuccess).then(nativeComplete(false)).then(unsafeRetiredWork).expect(not(selectedSafe))
  // CAS refusal has native COMPLETE but no observed control write-success.
  // Do not insert a fabricated requestSuccess in the actual projection.
  run participantReadOnlyCasRefusalBoundaryTest = init.then(acquire).then(invoke("prepare",0,Set())).then(foreignImage)
    .then(nativeComplete(false)).then(deliver).expect(p.refused and not(p.active) and p.delivered and selectedSafe)
  // Selected successful-return boundary, not an inductive claim that already
  // delivered observations remain live after a later lawful owner close.
  val captureReturnSafe = p.captureReturned.implies(not(p.captureClosed) and p.alive)
  action beginCapture = p'=p.with("capturing",true).with("captureReturned",false).with("alive",false)
  action closeDuringCapture = p'=p.with("captureClosed",true).with("alive",false)
  action returnCaptured = p'=if(p.capturing and not(p.captureClosed))
    p.with("capturing",false).with("captureReturned",true).with("alive",true).with("refused",false)
    else p.with("capturing",false).with("captureReturned",false).with("alive",false).with("refused",true)
  action unsafeReturnRevokedCapture = p'=p.with("capturing",false).with("captureReturned",true).with("alive",true)
  run participantLiveCaptureReturnTest = init.then(beginCapture).then(returnCaptured)
    .expect(p.captureReturned and not(p.refused) and captureReturnSafe and selectedSafe)
  run participantRevokedCaptureRefusesTest = init.then(beginCapture).then(closeDuringCapture).then(returnCaptured)
    .expect(not(p.captureReturned) and p.refused and captureReturnSafe and selectedSafe)
  run participantRevokedCaptureGuardKilledTest = init.then(beginCapture).then(closeDuringCapture)
    .expect(captureReturnSafe).then(unsafeReturnRevokedCapture).expect(not(captureReturnSafe))

  // Genuine scope/key/native/crypto facts are independent implementation evidence.
  // These finite laws model pending acquisition, not merely entered crypto.
  val presignSafe = p.sHeld.implies(legalEpoch(p.sEpoch) and p.sRound>=p.roundFloor) and
    p.sEntered.implies(p.sBound and p.sKey) and
    (p.sEntered and not(p.sComplete)).implies(p.sHeld) and
    p.sDelivered.implies(p.sComplete and p.sReleased and not(p.sRefused))
  action beginSigning(epoch:int,round:int,bound:bool,key:bool):bool = p'=
    if(p.sExcluded) p.with("sRefused",true)
    else p.with("sEpoch",epoch).with("sRound",round).with("sBound",bound).with("sKey",key)
      .with("sPending",true).with("sRefused",false)
  action acquireSigning = p'=if(p.sPending and p.sBound and p.sKey and legalEpoch(p.sEpoch) and p.sRound>=p.roundFloor)
    p.with("sHeld",true) else p.with("sPending",false).with("sRefused",true)
  action cryptoEntry = p'=if(p.sHeld and not(p.sRefused)) p.with("sEntered",true) else p.with("sRefused",true)
  action cryptoComplete = p'=if(p.sEntered) p.with("sComplete",true) else p.with("sRefused",true)
  action signingRelease = p'=if(p.sComplete or p.sRefused) p.with("sHeld",false).with("sReleased",true)
    .with("sPending",false) else p.with("sRefused",true)
  action signingDelivery = p'=if(p.sComplete and p.sReleased and not(p.sRefused)) p.with("sDelivered",true)
    else p.with("sRefused",true)
  action executionExclude = p'=p.with("sExcluded",true)
  val executionJoined = not(p.sPending)
  action foreignRetirement = p'=if(p.sHeld) p else p.with("cut",p.sEpoch).with("holes",Set())
  action unsafeRetirementWhileSigning = p'=p.with("cut",p.sEpoch).with("holes",Set())
  // Logical close revokes successful delivery, not entered crypto's physical
  // native custody. It is released only by the joined original signing task.
  action closeSigningOwner = p'=p.with("sExcluded",true).with("sRefused",true)
  action unsafeCloseDropsSigningHold = p'=p.with("sExcluded",true).with("sRefused",true).with("sHeld",false)
  run presignCloseRetainsNativeUntilCryptoJoinTest = init.then(beginSigning(0,1,true,true))
    .then(acquireSigning).then(cryptoEntry).then(closeSigningOwner).then(foreignRetirement)
    .expect(p.sHeld and p.sPending and p.cut<0 and presignSafe).then(cryptoComplete)
    .then(signingRelease).then(foreignRetirement).then(signingDelivery)
    .expect(p.cut==0 and not(p.sPending) and not(p.sDelivered) and presignSafe and selectedSafe)
  run presignCloseHoldGuardKilledTest = init.then(beginSigning(0,1,true,true))
    .then(acquireSigning).then(cryptoEntry).expect(presignSafe)
    .then(unsafeCloseDropsSigningHold).expect(not(presignSafe))
  run presignFirstAbsentRowProgressTest = init.then(beginSigning(0,1,true,true)).then(acquireSigning)
    .expect(p.sHeld and presignSafe).then(cryptoEntry).then(cryptoComplete).then(signingRelease).then(signingDelivery)
    .expect(p.sDelivered and presignSafe and selectedSafe)
  run presignRetiredScopeBeforeCryptoTest = init.then(beginSigning(0,1,true,true)).then(foreignRetirement)
    .then(acquireSigning).expect(p.sRefused and not(p.sEntered) and presignSafe)
  run presignUnboundRequestRefusesTest = init.then(beginSigning(0,1,false,true)).then(acquireSigning)
    .expect(p.sRefused and not(p.sEntered) and presignSafe)
  run presignWrongKeyRefusesTest = init.then(beginSigning(0,1,true,false)).then(acquireSigning)
    .expect(p.sRefused and not(p.sEntered) and presignSafe)
  run presignAcquisitionIncludedInJoinTest = init.then(beginSigning(0,1,true,true)).then(executionExclude)
    .expect(not(executionJoined)).then(acquireSigning).then(cryptoEntry).then(cryptoComplete).then(signingRelease)
    .expect(executionJoined and presignSafe)
  run presignEnteredCryptoHoldsNativeTest = init.then(beginSigning(0,1,true,true)).then(acquireSigning).then(cryptoEntry)
    .then(foreignRetirement).expect(p.cut<0 and p.sPending and presignSafe).then(cryptoComplete).then(signingRelease)
    .then(foreignRetirement).expect(p.cut==0 and presignSafe)
  run presignNativeGuardKilledTest = init.then(beginSigning(0,1,true,true)).then(acquireSigning).then(cryptoEntry)
    .expect(presignSafe).then(unsafeRetirementWhileSigning).expect(not(presignSafe))
  run presignRetirementGapFencesMutationTest = init.then(beginSigning(0,1,true,true)).then(acquireSigning).then(cryptoEntry)
    .then(cryptoComplete).then(signingRelease).then(foreignRetirement).then(work(0,1))
    .expect(p.refused and p.effects==Set() and presignSafe and selectedSafe)

  // Third request kind: exact verified close is epoch 0 / actual Commit QC
  // round 0 in this finite case. Codec authentication is separate evidence.
  val thirdClosingScopeSafe = p.sEntered.implies(p.sEpoch==0)
  run thirdRetirementClosingEpochRefusalTest = init.then(all {p'=p.with("roundFloor",0)})
    .then(beginSigning(0,0,true,true)).then(foreignRetirement).then(acquireSigning)
    .expect(p.sRefused and not(p.sEntered) and presignSafe and thirdClosingScopeSafe)
  run thirdRetirementHealthyVerifiedClosingScopeTest = init.then(all {p'=p.with("roundFloor",0)})
    .then(beginSigning(0,0,true,true)).then(acquireSigning).then(cryptoEntry)
    .then(cryptoComplete).then(signingRelease).then(signingDelivery)
    .expect(p.sDelivered and presignSafe and thirdClosingScopeSafe)
  run thirdRetirementSuccessorAgeGuardKilledTest = init.then(all {p'=p.with("roundFloor",0).with("cut",0)})
    .then(beginSigning(1,0,true,true)).then(acquireSigning).then(cryptoEntry)
    .expect(presignSafe and not(thirdClosingScopeSafe))
}
