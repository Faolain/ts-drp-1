// Original native read/floor/full census + actual current partition are required
// at deletion. A historical absence certificate can justify only a scope already
// classified ABSENT independently in that current census. Native locks, digest
// collision resistance and truthful complete census are abstraction premises.
module rejoinPruningCurrency {
  pure val SCOPES = Set(0,1,2,3)
  type State = {present:Set[int], protected:int, revision:int, head:int, floor:int,
    normalized:bool, held:bool, plan:bool, planRevision:int, planHead:int, planFloor:int,
    planProtected:int, fullCensus:bool, planIntent:int, activeIntent:int,
    certificate:bool, certificateHead:int, certificateRevision:int, certificateAnchor:int, certificateGenesis:int,
    basisHead:int, basisRevision:int, basisHeld:bool,
    capsules:Set[int], receipts:Set[int], deleted:Set[int], badDelete:bool}
  var s:State
  pure def classification(st:State,id:int):str = if (id == st.protected) "protected"
    else if (id == 2) "foreign" else if (not(st.present.contains(id))) "absent" else "eligible"
  pure def current(st:State):bool = st.held and st.plan and st.fullCensus and
    st.planRevision == st.revision and st.planHead == st.head and st.planFloor == st.floor and
    st.planProtected == st.protected and st.planIntent == st.activeIntent
  pure def certificateExact(st:State):bool = st.certificate and st.basisHeld and st.certificateHead == st.basisHead and
    st.certificateRevision == st.basisRevision and st.certificateAnchor == st.basisHead and st.certificateGenesis == 0
  pure def lastJoined(st:State,id:int):bool = not(st.capsules.contains(id)) and not(st.receipts.contains(id))
  action init = s' = {present:Set(1,2,3),protected:1,revision:0,head:0,floor:0,
    normalized:false,held:false,plan:false,planRevision:-1,planHead:-1,planFloor:-1,
    planProtected:-1,fullCensus:false,planIntent:-1,activeIntent:0,
    certificate:true,certificateHead:0,certificateRevision:0,certificateAnchor:0,certificateGenesis:0,
    basisHead:0,basisRevision:0,basisHeld:true,
    capsules:Set(3),receipts:Set(3),deleted:Set(),badDelete:false}
  action capture = all {not(s.held), s' = s.with("held",true).with("plan",true)
    .with("planRevision",s.revision).with("planHead",s.head).with("planFloor",s.floor)
    .with("planProtected",s.protected).with("fullCensus",true).with("planIntent",s.activeIntent)}
  action release = all {s.held,s' = s.with("held",false)}
  action reacquire = all {not(s.held),s.plan,s' = s.with("held",true)}
  action joinCapsule = all {s.capsules != Set(),s' = s.with("capsules",Set())}
  action joinReceipt = all {s.receipts != Set(),s' = s.with("receipts",Set())}
  // Exact immutable publication tuple/anchor/genesis survive ancestry cleanup.
  action normalize = all {not(s.normalized),s' = s.with("normalized",true)}
  action changeRole = all {not(s.held),s.revision == 0,s.present.contains(3),
    s' = s.with("protected",3).with("revision",1)}
  action advanceFloor = all {not(s.held),s.floor == 0,s' = s.with("floor",1)}
  action replaceIntent = all {not(s.held),s.activeIntent == 0,s' = s.with("activeIntent",1)}
  action changeHead = all {not(s.held),s.head == 0,s' = s.with("head",1)}
  action retireHistoricalBasis = all {not(s.held),s.head == 1,s.basisHeld,s' = s.with("basisHeld",false)}
  action delete(id:int):bool = all {current(s),classification(s,id) == "eligible",lastJoined(s,id),
    s' = s.with("present",s.present.exclude(Set(id))).with("deleted",s.deleted.union(Set(id)))
      .with("plan",false).with("held",false)}
  action acknowledgeAbsent(id:int):bool = all {current(s),classification(s,id) == "absent",
    certificateExact(s),lastJoined(s,id),s' = s}
  val safety = s.present.contains(s.protected) and not(s.badDelete) and not(s.deleted.contains(2)) and not(s.deleted.contains(s.protected)) and
    s.deleted.intersect(s.capsules.union(s.receipts)) == Set()
  val neverDeleted = s.deleted == Set()
  val neverNormalizedCertificate = not(s.normalized and current(s) and certificateExact(s))
  action step = any {capture,release,reacquire,joinCapsule,joinReceipt,normalize,changeRole,advanceFloor,replaceIntent,changeHead,retireHistoricalBasis,
    {nondet id = SCOPES.oneOf() any {delete(id),acknowledgeAbsent(id)}}}
  // Each bad action represents omission of one independent guard. badDelete
  // records violation at the destructive boundary, not a later role change.
  action unsafeForgedPartition = all {current(s),
    s' = s.with("deleted",s.deleted.union(Set(s.protected))).with("badDelete",true)}
  action unsafeStaleAttachment = all {s.held,s.plan,not(current(s)),lastJoined(s,3),
    s' = s.with("deleted",s.deleted.union(Set(3))).with("badDelete",true)}
  action unsafeReceiptAuthority(id:int):bool = all {current(s),certificateExact(s),s.present.contains(id),
    s' = s.with("deleted",s.deleted.union(Set(id))).with("badDelete",true)}
  action unsafeLastConsumer = all {current(s),classification(s,3) == "eligible",not(lastJoined(s,3)),
    s' = s.with("deleted",s.deleted.union(Set(3))).with("badDelete",true)}
  action unsafeMissingCensus = all {s.held,s.plan,
    s' = s.with("fullCensus",false).with("deleted",s.deleted.union(Set(3))).with("badDelete",true)}
  action forgedStep = any {step,unsafeForgedPartition}
  action staleStep = any {step,unsafeStaleAttachment}
  action receiptProtectedStep = any {step,unsafeReceiptAuthority(s.protected)}
  action receiptForeignStep = any {step,unsafeReceiptAuthority(2)}
  action consumerStep = any {step,unsafeLastConsumer}
  action censusStep = any {step,unsafeMissingCensus}
  run joinedDeletionTest = init.then(joinCapsule).then(joinReceipt).then(capture).then(delete(3)).expect(safety)
  run normalizationPreservesExactCertificateTest = init.then(normalize).then(capture)
    .then(acknowledgeAbsent(0)).expect(certificateExact(s) and current(s) and safety)
  run historicalCertificateAfterAdvanceTest = init.then(changeHead).then(normalize).then(capture)
    .then(acknowledgeAbsent(0)).expect(s.head != s.certificateHead and certificateExact(s) and safety)
  run unretainedHistoricalBasisRefusesTest = init.then(changeHead).then(retireHistoricalBasis).then(capture)
    .expect(not(certificateExact(s)) and safety)
  run heldNativeExcludesWriteTest = init.then(capture).expect(s.held and s.revision == 0 and safety)
  run staleNativeCounterexampleTest = init.then(capture).then(release).then(changeRole)
    .then(joinCapsule).then(joinReceipt).then(reacquire).then(unsafeStaleAttachment).expect(not(safety))
  run oldFloorCounterexampleTest = init.then(capture).then(release).then(advanceFloor)
    .then(joinCapsule).then(joinReceipt).then(reacquire).then(unsafeStaleAttachment).expect(not(safety))
  run oldIntentCounterexampleTest = init.then(capture).then(release).then(replaceIntent)
    .then(joinCapsule).then(joinReceipt).then(reacquire).then(unsafeStaleAttachment).expect(not(safety))
  run oldCertificateCannotClassifyProtectedTest = init.then(capture).then(unsafeReceiptAuthority(1)).expect(not(safety))
  run oldCertificateCannotClassifyForeignTest = init.then(capture).then(unsafeReceiptAuthority(2)).expect(not(safety))
  run incompleteCensusCounterexampleTest = init.then(capture).then(unsafeMissingCensus).expect(not(safety))
  run unjoinedCapsuleCounterexampleTest = init.then(joinReceipt).then(capture).then(unsafeLastConsumer).expect(not(safety))
  run unjoinedNativeReceiptCounterexampleTest = init.then(joinCapsule).then(capture).then(unsafeLastConsumer).expect(not(safety))
}

// A scoped immutable-binding lemma: normalization cannot change the exact
// publication tuple; changing a publication invalidates a historical receipt.
module rejoinAbsenceProjection {
  type State = {head:int, room:int, revision:int, anchor:int, genesis:int, base:int,
    receiptHead:int,receiptRevision:int,receiptAnchor:int,receiptGenesis:int,valid:bool}
  var s:State
  pure def exact(st:State):bool = st.head == st.receiptHead and st.revision == st.receiptRevision and
    st.anchor == st.receiptAnchor and st.genesis == st.receiptGenesis
  pure def safetyOf(st:State):bool = st.valid == exact(st) and st.receiptHead <= st.head and st.head <= st.room and
    st.anchor == st.head and st.receiptAnchor == st.receiptHead and st.genesis == st.receiptGenesis
  val safety = safetyOf(s)
  action init = s' = {head:1,room:1,revision:1,anchor:1,genesis:0,base:0,
    receiptHead:1,receiptRevision:1,receiptAnchor:1,receiptGenesis:0,valid:true}
  action normalize = s' = s.with("base",-1)
  action change = all {s.head < 2,s' = s.with("head",2).with("room",if (s.room < 2) 2 else s.room).with("anchor",2).with("valid",false)}
  action advanceRoom = all {s.room < 3,s' = s.with("room",s.room+1)}
  action step = any {normalize,change,advanceRoom}
  action unsafeStep = any {step,s' = s.with("base",-1).with("valid",false)}
  action indInit = {nondet h = Set(1,2).oneOf() nondet room = 1.to(3).oneOf() nondet r = Set(1,2).oneOf()
    nondet a = Set(1,2).oneOf() nondet g = Set(0,1).oneOf() nondet b = Set(-1,0).oneOf()
    nondet rh = Set(1,2).oneOf() nondet rr = Set(1,2).oneOf()
    nondet ra = Set(1,2).oneOf() nondet rg = Set(0,1).oneOf() nondet v = Set(false,true).oneOf()
    val st = {head:h,room:room,revision:r,anchor:a,genesis:g,base:b,receiptHead:rh,receiptRevision:rr,receiptAnchor:ra,receiptGenesis:rg,valid:v}
    all {safetyOf(st),s' = st}}
}
