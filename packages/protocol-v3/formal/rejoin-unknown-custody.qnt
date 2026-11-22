// Unknown is epistemic: the remote application may already contain the source.
// Expiry abandons author retry/resolution; it never undoes remote application.
// Signed expiry is a REQUIRED CONTRACT adjunct until its implementation mapping
// records an implementing commit. Native crypto and byte-width bounds are inputs.
module rejoinUnknownCustody {
  pure val SOURCES = Set(0,1)
  pure val SOURCE_RESERVE = 5 // two custody units plus three disposition/plan units
  pure val QUOTA = 10
  type State = {epoch:int, writer:bool, online:bool, accepted:Set[int], local:Set[int],
    context:Set[int], liveAnchor:Set[int], reserved:Set[int], unknown:Set[int],committed:Set[int],expired:Set[int],evidence:Set[int],
    actual:Set[int], application:Set[int], duplicate:bool, requested:int, requestFloor:int,
    signed:Set[int], signedFloor:int -> int, capsules:Set[int], receipts:Set[int],
    disposed:Set[int], badExpiry:bool, badAdmission:bool}
  var s:State
  pure def charged(st:State):int = st.local.size()*SOURCE_RESERVE
  pure def safetyOf(st:State):bool = and {
    st.accepted.subseteq(st.local.union(st.committed).union(st.expired)),
    st.local.subseteq(st.context.union(st.liveAnchor)),st.local.subseteq(st.reserved),charged(st) <= QUOTA,
    st.unknown == st.accepted.exclude(st.committed).exclude(st.expired),
    st.unknown.subseteq(st.local),st.committed.intersect(st.expired) == Set(),st.committed.subseteq(st.evidence),st.evidence.subseteq(st.actual),
    st.expired.subseteq(st.signed),st.signed.subseteq(st.accepted),
    st.expired.forall(id => st.signedFloor.get(id) <= st.epoch),
    st.disposed.intersect(st.capsules.union(st.receipts)) == Set(),
    st.application == st.actual,not(st.duplicate),not(st.badExpiry),not(st.badAdmission)}
  val safety = safetyOf(s)
  val neverExpired = s.expired == Set()
  val neverUnknownAfterGap = not(s.epoch > 0 and s.unknown != Set())
  action init = s' = {epoch:0,writer:true,online:true,accepted:Set(),local:Set(),context:Set(),liveAnchor:Set(),reserved:Set(),
    unknown:Set(),committed:Set(),expired:Set(),evidence:Set(),actual:Set(),application:Set(),duplicate:false,
    requested:-1,requestFloor:-1,signed:Set(),signedFloor:SOURCES.mapBy(_ => -1),
    capsules:Set(),receipts:Set(),disposed:Set(),badExpiry:false,badAdmission:false}
  // Source context means authenticated anchor + ACL + parameter bytes + ABI
  // identity. Availability of an executable ABI is not assumed or required to
  // preserve unknown; no old live anchor is an input after this point.
  action accept(id:int,actuallyCommitted:bool):bool = all {s.online,s.writer,not(s.accepted.contains(id)),
    charged(s)+SOURCE_RESERVE <= QUOTA,
    s' = s.with("accepted",s.accepted.union(Set(id))).with("local",s.local.union(Set(id)))
      .with("liveAnchor",s.liveAnchor.union(Set(id))).with("reserved",s.reserved.union(Set(id)))
      .with("unknown",s.unknown.union(Set(id))).with("capsules",s.capsules.union(Set(id)))
      .with("receipts",s.receipts.union(Set(id)))
      .with("actual",if (actuallyCommitted) s.actual.union(Set(id)) else s.actual)
      .with("application",if (actuallyCommitted) s.application.union(Set(id)) else s.application)}
  action captureSource(id:int):bool = all {s.online,s.local.contains(id),s.liveAnchor.contains(id),
    not(s.context.contains(id)),s' = s.with("context",s.context.union(Set(id)))}
  action gap(n:int,writer:bool):bool = all {s.online,n > s.epoch,n <= 4,
    s.local.subseteq(s.context),
    s' = s.with("epoch",n).with("writer",writer).with("liveAnchor",Set())}
  action crash = all {s.online,s' = s.with("online",false).with("requested",-1).with("requestFloor",-1)}
  action reopen = all {not(s.online),s' = s.with("online",true)}
  // A previously sent operation may arrive remotely even after local expiry.
  // This environment effect also cannot be undone by abandoning local retry.
  action remoteCommit(id:int):bool = all {s.accepted.contains(id),not(s.actual.contains(id)),
    s' = s.with("actual",s.actual.union(Set(id))).with("application",s.application.union(Set(id)))}
  action observeSignedSettlement(id:int):bool = all {s.online,s.accepted.contains(id),s.actual.contains(id),
    not(s.evidence.contains(id)),s' = s.with("evidence",s.evidence.union(Set(id)))}
  action proveCommitted(id:int):bool = all {s.online,s.unknown.contains(id),s.evidence.contains(id),s.requested == -1,
    s' = s.with("committed",s.committed.union(Set(id))).with("unknown",s.unknown.exclude(Set(id)))}
  // Local author identity is a capability, not current Writer membership.
  // The original signing owner authenticates the exact source and current floor.
  action requestExpiry(id:int):bool = all {s.online,s.unknown.contains(id),s.requested == -1,
    s.context.contains(id),s.reserved.contains(id),
    s' = s.with("requested",id).with("requestFloor",s.epoch)}
  action cancelRequest = all {s.requested >= 0,s' = s.with("requested",-1).with("requestFloor",-1)}
  action signExpiry = all {s.online,s.requested >= 0,s.requestFloor == s.epoch,
    s.unknown.contains(s.requested),s.context.contains(s.requested),s.reserved.contains(s.requested),
    s' = s.with("signed",s.signed.union(Set(s.requested)))
      .with("signedFloor",s.signedFloor.set(s.requested,s.epoch))
      .with("expired",s.expired.union(Set(s.requested))).with("unknown",s.unknown.exclude(Set(s.requested)))
      .with("requested",-1).with("requestFloor",-1)}
  action joinCapsule(id:int):bool = all {s.committed.union(s.expired).contains(id),s.capsules.contains(id),
    s' = s.with("capsules",s.capsules.exclude(Set(id)))}
  action joinReceipt(id:int):bool = all {s.committed.union(s.expired).contains(id),s.receipts.contains(id),
    s' = s.with("receipts",s.receipts.exclude(Set(id)))}
  action prune(id:int):bool = all {s.local.contains(id),s.committed.union(s.expired).contains(id),
    not(s.capsules.contains(id)),not(s.receipts.contains(id)),
    s' = s.with("local",s.local.exclude(Set(id))).with("context",s.context.exclude(Set(id)))
      .with("liveAnchor",s.liveAnchor.exclude(Set(id)))
      .with("reserved",s.reserved.exclude(Set(id))).with("disposed",s.disposed.union(Set(id)))}
  action step = any {crash,reopen,signExpiry,cancelRequest,
    {nondet n = 1.to(4).oneOf() nondet writer = Set(false,true).oneOf() gap(n,writer)},
    {nondet id = SOURCES.oneOf() any {accept(id,true),accept(id,false),captureSource(id),remoteCommit(id),observeSignedSettlement(id),proveCommitted(id),requestExpiry(id),joinCapsule(id),joinReceipt(id),prune(id)}}}
  action unsafeAutoReplay(id:int):bool = all {s.online,s.unknown.contains(id),
    s' = s.with("application",s.application.union(Set(id))).with("duplicate",s.actual.contains(id))}
  action unsafeAutoExpire(id:int):bool = all {s.unknown.contains(id),
    s' = s.with("expired",s.expired.union(Set(id))).with("unknown",s.unknown.exclude(Set(id)))}
  action unsafeEraseUnknown(id:int):bool = all {s.unknown.contains(id),
    s' = s.with("local",s.local.exclude(Set(id))).with("context",s.context.exclude(Set(id)))}
  action unsafeEraseLastConsumer(id:int):bool = all {s.local.contains(id),s.expired.contains(id),
    s.capsules.contains(id) or s.receipts.contains(id),
    s' = s.with("local",s.local.exclude(Set(id))).with("context",s.context.exclude(Set(id)))
      .with("liveAnchor",s.liveAnchor.exclude(Set(id)))
      .with("reserved",s.reserved.exclude(Set(id))).with("disposed",s.disposed.union(Set(id)))}
  action unsafeAdmissionWithoutReserve(id:int):bool = all {not(s.accepted.contains(id)),
    s' = s.with("accepted",s.accepted.union(Set(id))).with("local",s.local.union(Set(id)))
      .with("context",s.context.union(Set(id))).with("unknown",s.unknown.union(Set(id)))}
  action unsafeUndoRemote(id:int):bool = all {s.expired.contains(id),s.actual.contains(id),
    s' = s.with("application",s.application.exclude(Set(id)))}
  action unsafeForeignExpiry(id:int):bool = all {s.unknown.contains(id),
    s' = s.with("signed",s.signed.union(Set(id))).with("signedFloor",s.signedFloor.set(id,s.epoch))
      .with("expired",s.expired.union(Set(id))).with("unknown",s.unknown.exclude(Set(id))).with("badExpiry",true)}
  action unsafeGapWithoutCustody = all {s.epoch < 4,s.local.exclude(s.context) != Set(),
    s' = s.with("epoch",s.epoch+1).with("liveAnchor",Set())}
  action gapCustodyStep = any {step,unsafeGapWithoutCustody}
  action unsafeStaleExpiry = all {s.requested >= 0,s.requestFloor != s.epoch,
    s' = s.with("signed",s.signed.union(Set(s.requested)))
      .with("signedFloor",s.signedFloor.set(s.requested,s.requestFloor))
      .with("expired",s.expired.union(Set(s.requested))).with("unknown",s.unknown.exclude(Set(s.requested)))
      .with("requested",-1).with("requestFloor",-1).with("badExpiry",true)}
  action staleExpiryStep = any {step,unsafeStaleExpiry}
  action unsafeProjectionCommit(id:int):bool = all {s.unknown.contains(id),s.actual.contains(id),not(s.evidence.contains(id)),
    s' = s.with("committed",s.committed.union(Set(id))).with("unknown",s.unknown.exclude(Set(id)))}
  action unsafeWrongSourceCommit(id:int):bool = all {s.unknown.contains(id),s.evidence != Set(),not(s.evidence.contains(id)),
    s' = s.with("committed",s.committed.union(Set(id))).with("unknown",s.unknown.exclude(Set(id)))}
  action projectionCommitStep = any {step,{nondet id = SOURCES.oneOf() unsafeProjectionCommit(id)}}
  action wrongSourceStep = any {step,{nondet id = SOURCES.oneOf() unsafeWrongSourceCommit(id)}}
  action replayStep = any {step,{nondet id = SOURCES.oneOf() unsafeAutoReplay(id)}}
  action autoExpiryStep = any {step,{nondet id = SOURCES.oneOf() unsafeAutoExpire(id)}}
  action unknownStep = any {step,{nondet id = SOURCES.oneOf() unsafeEraseUnknown(id)}}
  action consumerStep = any {step,{nondet id = SOURCES.oneOf() unsafeEraseLastConsumer(id)}}
  action reserveStep = any {step,{nondet id = SOURCES.oneOf() unsafeAdmissionWithoutReserve(id)}}
  action undoStep = any {step,{nondet id = SOURCES.oneOf() unsafeUndoRemote(id)}}
  action foreignStep = any {step,{nondet id = SOURCES.oneOf() unsafeForeignExpiry(id)}}
  run zeroSourceReceiveOnlyThenWriterTest = init.then(gap(2,false)).then(crash).then(reopen)
    .expect(not(s.writer) and s.local == Set() and s.context == Set() and charged(s) == 0 and safety)
    .then(gap(4,true)).then(accept(0,false)).expect(s.unknown == Set(0) and safety)
  run exactSignedCommitSurvivesAdjacentRemovalTest = init.then(accept(0,true)).then(captureSource(0))
    .then(gap(1,false)).then(observeSignedSettlement(0)).then(proveCommitted(0)).then(crash).then(reopen)
    .expect(s.committed == Set(0) and s.unknown == Set() and s.application == Set(0) and safety)
  run projectionAloneCannotClassifyCommitTest = init.then(accept(0,true)).then(unsafeProjectionCommit(0)).expect(not(safety))
  run otherSourceEvidenceCannotClassifyTest = init.then(accept(0,true)).then(accept(1,true))
    .then(observeSignedSettlement(0)).then(unsafeWrongSourceCommit(1)).expect(not(safety))
  run expiryDoesNotUndoLaterRemoteArrivalTest = init.then(accept(0,false)).then(captureSource(0))
    .then(requestExpiry(0)).then(signExpiry).then(joinCapsule(0)).then(joinReceipt(0)).then(prune(0))
    .then(remoteCommit(0)).expect(s.expired == Set(0) and s.application == Set(0) and safety)
  run unknownSurvivesGapRemovalReadmissionColdTest = init.then(accept(0,true)).then(captureSource(0)).then(accept(1,false)).then(captureSource(1))
    .then(gap(2,false)).then(crash).then(reopen).then(gap(4,true)).then(crash).then(reopen)
    .expect(s.unknown == SOURCES and s.context == SOURCES and s.application == Set(0) and safety)
  run expiryCommittedUnknownPreservesApplicationTest = init.then(accept(0,true)).then(captureSource(0)).then(gap(2,false))
    .then(requestExpiry(0)).then(signExpiry).then(crash).then(reopen)
    .then(joinCapsule(0)).then(joinReceipt(0)).then(prune(0))
    .expect(s.expired == Set(0) and s.application == Set(0) and safety)
  run expiryOmittedUnknownPreservesApplicationTest = init.then(accept(0,false)).then(captureSource(0)).then(gap(2,true))
    .then(requestExpiry(0)).then(signExpiry).then(crash).then(reopen)
    .then(joinCapsule(0)).then(joinReceipt(0)).then(prune(0))
    .expect(s.expired == Set(0) and s.application == Set() and safety)
  run crashUnsignedRequestDoesNotExpireTest = init.then(accept(0,false)).then(captureSource(0)).then(requestExpiry(0)).then(crash).then(reopen)
    .expect(s.unknown == Set(0) and s.expired == Set() and safety)
  run actualCommitProofMayResolveTest = init.then(accept(0,true)).then(captureSource(0)).then(observeSignedSettlement(0)).then(proveCommitted(0))
    .then(joinCapsule(0)).then(joinReceipt(0)).then(prune(0)).expect(s.committed == Set(0) and safety)
  run potentiallyCommittedDuplicateCounterexampleTest = init.then(accept(0,true)).then(captureSource(0)).then(gap(4,true))
    .then(unsafeAutoReplay(0)).expect(not(safety) and s.duplicate)
  run actuallyOmittedAutoReplayCounterexampleTest = init.then(accept(0,false)).then(captureSource(0)).then(gap(4,true))
    .then(unsafeAutoReplay(0)).expect(not(safety))
  run automaticExpiryCounterexampleTest = init.then(accept(0,false)).then(captureSource(0)).then(gap(4,false))
    .then(unsafeAutoExpire(0)).expect(not(safety))
  run missingPreJumpCustodyCounterexampleTest = init.then(accept(0,true)).then(unsafeGapWithoutCustody).expect(not(safety))
  run changedFloorRequiresFreshAuthorRequestTest = init.then(accept(0,false)).then(captureSource(0))
    .then(requestExpiry(0)).then(gap(2,false)).expect(s.requestFloor != s.epoch and safety)
    .then(cancelRequest).then(requestExpiry(0)).then(signExpiry).expect(s.signedFloor.get(0) == 2 and safety)
  run staleFloorExpiryCounterexampleTest = init.then(accept(0,true)).then(captureSource(0))
    .then(requestExpiry(0)).then(gap(2,false)).then(unsafeStaleExpiry).expect(not(safety))
  run reserveMissingCounterexampleTest = init.then(unsafeAdmissionWithoutReserve(0)).expect(not(safety))
  run finalConsumerCounterexampleTest = init.then(accept(0,false)).then(captureSource(0)).then(requestExpiry(0)).then(signExpiry)
    .then(joinCapsule(0)).then(unsafeEraseLastConsumer(0)).expect(not(safety))
  run expiryCannotUndoCommittedEffectTest = init.then(accept(0,true)).then(captureSource(0)).then(requestExpiry(0)).then(signExpiry)
    .then(unsafeUndoRemote(0)).expect(not(safety))
}

// Scoped per-source induction covers accepted-source preservation and the
// distinction between epistemic status and application truth. It abstracts the
// exact author/signature/floor capability and quota admission as booleans.
module rejoinCustodyProjection {
  type State = {accepted:bool,local:bool,context:bool,reserve:bool,status:str,
    actual:bool,application:bool,capsule:bool,receipt:bool,signed:bool,authorized:bool,evidence:bool}
  var s:State
  pure def safetyOf(st:State):bool = and {
    st.status == "none" implies not(st.accepted),
    Set("unknown","committed","expired").contains(st.status) implies st.accepted,
    st.accepted implies st.local or Set("committed","expired").contains(st.status),
    st.local implies st.accepted and st.context and st.reserve,
    st.status == "unknown" implies st.accepted and st.local,
    st.status == "expired" implies st.signed and st.authorized,
    st.status == "committed" implies st.evidence,st.evidence implies st.actual,
    not(st.local) implies not(st.capsule) and not(st.receipt),
    st.application == st.actual}
  val safety = safetyOf(s)
  action init = s' = {accepted:false,local:false,context:false,reserve:false,status:"none",
    actual:false,application:false,capsule:false,receipt:false,signed:false,authorized:false,evidence:false}
  action accept(actual:bool):bool = all {not(s.accepted),
    s' = {accepted:true,local:true,context:true,reserve:true,status:"unknown",
      actual:actual,application:actual,capsule:true,receipt:true,signed:false,authorized:false,evidence:false}}
  action expire = all {s.status == "unknown",s.context,s.reserve,
    s' = s.with("status","expired").with("signed",true).with("authorized",true)}
  action remoteCommit = all {s.accepted,not(s.actual),s' = s.with("actual",true).with("application",true)}
  action observe = all {s.actual,s' = s.with("evidence",true)}
  action commit = all {s.status == "unknown",s.evidence,s' = s.with("status","committed")}
  action joinCapsule = all {Set("committed","expired").contains(s.status),s' = s.with("capsule",false)}
  action joinReceipt = all {Set("committed","expired").contains(s.status),s' = s.with("receipt",false)}
  action prune = all {Set("committed","expired").contains(s.status),not(s.capsule),not(s.receipt),
    s' = s.with("local",false).with("context",false).with("reserve",false)}
  action step = any {s' = s,accept(false),accept(true),expire,remoteCommit,observe,commit,joinCapsule,joinReceipt,prune}
  action indInit = {nondet a = Set(false,true).oneOf() nondet l = Set(false,true).oneOf()
    nondet c = Set(false,true).oneOf() nondet r = Set(false,true).oneOf()
    nondet status = Set("none","unknown","committed","expired").oneOf()
    nondet actual = Set(false,true).oneOf() nondet app = Set(false,true).oneOf()
    nondet cap = Set(false,true).oneOf() nondet rec = Set(false,true).oneOf()
    nondet sig = Set(false,true).oneOf() nondet auth = Set(false,true).oneOf() nondet evidence = Set(false,true).oneOf()
    val st = {accepted:a,local:l,context:c,reserve:r,status:status,actual:actual,application:app,
      capsule:cap,receipt:rec,signed:sig,authorized:auth,evidence:evidence}
    all {safetyOf(st),s' = st}}
  action unsafeStep = any {step,all {s.status == "unknown",s' = s.with("local",false)}}
}
