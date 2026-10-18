module signingNativeFrontier {
  import sealSafety.Vote from "./seal-safety"
  import sealSafety.vote from "./seal-safety"
  import sealSafety.sameSlot from "./seal-safety"
  import sealSafety.validTuple from "./seal-safety"
  // Round-local native participant, NOT epoch-detail deletion. Pending outbox
  // is the abstraction of native dispatched=false, not removed native rows.
  type Effect = {round:int, floor:int, kind:str}
  type Native = {floor:int, entered:int, revision:int, incarnation:int,
    qc:int, lock:int, evidence:int, pending:Set[int], detail:Set[Vote],
    stage:int, operation:str, requested:int, expected:int, expectedInc:int,
    refused:bool, unknown:bool, delivered:bool, effects:Set[Effect]}
  var n:Native
  val currency = n.expected==n.revision and n.expectedInc==n.incarnation
  val frontierAllowed = currency and n.requested>=n.floor and n.requested<=n.entered and
    (n.qc<0 or n.qc>=n.requested) and (n.lock<0 or n.lock>=n.requested) and
    (n.evidence<0 or n.evidence>=n.requested) and not(n.pending.exists(r=>r<n.requested))
  val operationAllowed = currency and n.requested>=n.floor and
    (if(n.operation=="vote") n.requested>=n.entered else true)
  val selectedSafe = n.floor<=n.entered and
    (n.qc<0 or n.qc>=n.floor) and (n.lock<0 or n.lock>=n.floor) and
    n.effects.forall(e=>e.round>=e.floor) and
    n.detail.forall(a=>n.detail.forall(b=>not(sameSlot(a,b)) or a==b)) and
    n.delivered.implies(n.stage==3 and not(n.unknown))
  action init = n'={floor:0,entered:2,revision:1,incarnation:1,qc:-1,lock:-1,evidence:-1,
    pending:Set(),detail:Set(),stage:0,operation:"",requested:0,expected:1,expectedInc:1,
    refused:false,unknown:false,delivered:false,effects:Set()}
  action invoke(kind:str,round:int,revision:int,incarnation:int):bool = n'=n
    .with("stage",1).with("operation",kind).with("requested",round)
    .with("expected",revision).with("expectedInc",incarnation).with("delivered",false).with("refused",false)
  // A request success is provisional. No durable image/authority is added here.
  action requestSuccess = n'=n.with("stage",2)
  action nativeComplete(lost:bool):bool = n'= if(n.stage==2 and
      (if(n.operation=="frontier") frontierAllowed else operationAllowed))
    (if(n.operation=="frontier") n.with("floor",n.requested).with("revision",n.revision+1)
     else if(n.operation=="vote") n.with("detail",n.detail.union(Set(vote("A",n.requested,"prepare","value-X"))))
       .with("pending",n.pending.union(Set(n.requested))).with("revision",n.revision+1)
     else if(n.operation=="ack") n.with("pending",n.pending.exclude(Set(n.requested)))
     else n).with("stage",3).with("unknown",lost)
       .with("effects",n.effects.union(Set({round:n.requested,floor:n.floor,kind:n.operation})))
    else n.with("stage",3).with("refused",true).with("unknown",false)
  action nativeAbort = n'=n.with("stage",3).with("refused",true).with("unknown",false)
  action deliver = n'= if(n.stage==3 and not(n.unknown)) n.with("delivered",true) else n.with("refused",true)
  action readback = n'=n.with("unknown",false)
  action debt(round:int):bool = n'=n.with("pending",Set(round))
  action summary(round:int):bool = n'=n.with("qc",round).with("lock",round)
  action evidence(round:int):bool = n'=n.with("evidence",round)
  action mutateRevision = n'=n.with("revision",n.revision+1)
  action mutateIncarnation = n'=n.with("incarnation",n.incarnation+1)
  action unsafeOldEffect = n'=n.with("effects",n.effects.union(Set({round:0,floor:n.floor,kind:"restore"})))
  action unsafeEarlyDelivery = n'=n.with("delivered",true)
  action unsafeFrontier = n'=n.with("floor",2)
  run nativeFrontierProgressTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess)
    .expect(n.floor==0 and selectedSafe).then(nativeComplete(false)).then(deliver).expect(n.floor==1 and n.delivered and selectedSafe)
  run nativeFrontierAbortNoEffectsTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeAbort).then(deliver)
    .expect(n.floor==0 and n.revision==1 and n.refused and selectedSafe)
  run nativeFrontierStaleRevisionTest = init.then(invoke("frontier",1,1,1)).then(mutateRevision).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and n.floor==0 and selectedSafe)
  run nativeFrontierStaleIncarnationTest = init.then(invoke("frontier",1,1,1)).then(mutateIncarnation).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and n.floor==0 and selectedSafe)
  run nativePublicationDebtRefusesTest = init.then(debt(0)).then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and n.floor==0 and selectedSafe)
  run nativeSummaryRetainedTest = init.then(summary(1)).then(invoke("frontier",2,1,1)).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and n.qc==1 and n.lock==1 and selectedSafe)
  run nativeEvidenceDebtRefusesTest = init.then(evidence(0)).then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and n.floor==0 and selectedSafe)
  run nativeDelayedRestorationRefusesTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeComplete(false)).then(deliver)
    .then(invoke("restore",0,2,1)).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and selectedSafe)
  run nativeDelayedAckRefusesTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeComplete(false))
    .then(invoke("ack",0,2,1)).then(requestSuccess).then(nativeComplete(false)).expect(n.refused and selectedSafe)
  run nativeLostDeliveryReadbackTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeComplete(true))
    .expect(n.floor==1 and n.unknown and not(n.delivered) and selectedSafe).then(readback).then(deliver).expect(n.delivered and selectedSafe)
  run nativeFrontierOldRuleKilledTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess).then(nativeComplete(false)).then(unsafeOldEffect).expect(not(selectedSafe))
  run nativeFrontierDeliveryRuleKilledTest = init.then(invoke("frontier",1,1,1)).then(requestSuccess).then(unsafeEarlyDelivery).expect(not(selectedSafe))
  run nativeFrontierSummaryRuleKilledTest = init.then(summary(1)).then(unsafeFrontier).expect(not(selectedSafe))
}
