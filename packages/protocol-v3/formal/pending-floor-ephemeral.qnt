// One adjacent transition. Epoch tags abstract the exact object/epoch/anchor/ACL
// tuple, not epoch-number-only comparison. Tag 2 is a foreign tuple at epoch 1.
// Native effects and their promise observations are distinct host-turn states.
// authorityBinding is room authority metadata, not completed application replay.
module pendingFloorEphemeral {
  type State = {durable:int, phase:str, runtime:bool, failed:bool,
    registration:int, handle:int, authorityBinding:int, suspended:bool, queued:int,
    delivered:int, admitted:int, pendingTraffic:bool, retiredTraffic:bool,
    badActivation:bool, badDelivery:bool, badCurrent:bool, badResume:bool}
  var s:State
  pure def authority(st:State, gate:bool):int =
    if (st.runtime and st.handle >= 0 and st.handle == st.registration and
      (not(gate) or (not(st.suspended) and not(st.failed)))) st.handle else -1
  pure def stable(st:State):int = if (st.durable == 3) 1 else 0
  pure def nativeHead(st:State):int = if (st.durable >= 2) 1 else 0
  pure def pending(st:State):bool = Set(1,2).contains(st.durable)
  pure def floorCurrent(st:State,a:int):bool =
    a >= 0 and not(pending(st)) and a == stable(st) and a == nativeHead(st)
  action init = s' = {durable:0,phase:"idle",runtime:true,failed:false,
    registration:0,handle:0,authorityBinding:0,suspended:false,queued:-1,
    delivered:-1,admitted:-1,pendingTraffic:false,retiredTraffic:false,
    badActivation:false,badDelivery:false,badCurrent:false,badResume:false}
  pure def running(st:State):bool = st.runtime and not(st.failed)
  action prepare = all {running(s),s.phase == "idle",s.durable == 0,
    s' = s.with("phase","prepared")}
  // Suspension is an optional stronger policy, not an inferred E2 requirement.
  // It must precede a native request if uncertainty is meant to fail closed.
  action requestBegin = all {running(s),s.phase == "prepared",
    s' = s.with("phase","begin").with("suspended",true)}
  action nativeBegin = all {running(s),s.phase == "begin",s.durable == 0,
    s' = s.with("durable",1)}
  action observeBegin = all {running(s),s.phase == "begin",s.durable == 1,
    s' = s.with("phase","publish")}
  action nativePublish = all {running(s),s.phase == "publish",s.durable == 1,
    s' = s.with("durable",2)}
  action observePublish = all {running(s),s.phase == "publish",s.durable == 2,
    s' = s.with("phase","commit")}
  action nativeCommit = all {running(s),s.phase == "commit",s.durable == 2,
    s' = s.with("durable",3)}
  action observeCommit = all {running(s),s.phase == "commit",s.durable == 3,
    s' = s.with("phase","activate")}
  action register = all {running(s),s.phase == "activate",s.durable == 3,
    s' = s.with("registration",1).with("phase","rebind")}
  action rebind = all {running(s),s.phase == "rebind",s.registration == 1,
    s' = s.with("handle",1).with("authorityBinding",1).with("phase","finish")}
  action finish = all {running(s),s.phase == "finish",s.registration == 1,
    s.handle == 1,s.authorityBinding == 1,s.durable == 3,
    s' = s.with("suspended",false).with("phase","ready")}
  // This action represents positively established no-effect, not a rejected or
  // ambiguous begin promise. No abort-to-old exists after nativeBegin.
  action provenNoEffectAbort = all {running(s),s.durable == 0,
    Set("prepared","begin").contains(s.phase),
    s' = s.with("suspended",false).with("phase","idle")}
  action failTransition = all {running(s),not(Set("idle","ready").contains(s.phase)),
    s' = s.with("failed",true)}
  action crash = all {s.runtime,
    s' = s.with("runtime",false).with("registration",-1).with("handle",-1)
      .with("authorityBinding",-1).with("suspended",true).with("queued",-1)}
  // Cold activation is distinct from permitting an existing old live view.
  // Authentication and exact native head/floor CAS are premises of recovery.
  action recover = all {not(s.runtime),
    s' = if (s.durable == 0) s.with("runtime",true).with("failed",false)
      .with("phase","idle").with("registration",0).with("handle",0)
      .with("authorityBinding",0).with("suspended",false)
    else s.with("runtime",true).with("failed",false)
      .with("phase",if (s.durable == 1) "publish" else if (s.durable == 2) "commit" else "activate")}
  action admit(gate:bool):bool = {
    val a = authority(s,gate)
    all {s.queued == -1,a >= 0,
      s' = s.with("queued",a).with("admitted",a)
        .with("pendingTraffic",s.pendingTraffic or pending(s))
        .with("retiredTraffic",s.retiredTraffic or (s.durable == 3 and a == 0))
        .with("badCurrent",s.badCurrent or a != s.registration)}
  }
  // A previously encoded send can physically finish after handoff. Its tuple
  // is preserved; physical completion is not fresh authority admission.
  action receive(n:int,gate:bool):bool = {
    val a = authority(s,gate)
    val accepted = a >= 0 and n == a
    all {Set(0,1,2).contains(n),
      s' = s.with("delivered",if (accepted) n else -1)
        .with("pendingTraffic",s.pendingTraffic or (accepted and pending(s)))
        .with("retiredTraffic",s.retiredTraffic or (accepted and s.durable == 3 and a == 0))
        .with("badDelivery",s.badDelivery or (accepted and n != s.registration))}
  }
  action finishQueued(gate:bool):bool = all {s.queued >= 0,
    val a = authority(s,gate)
    val accepted = a >= 0 and s.queued == a
    s' = s.with("queued",-1).with("delivered",if (accepted) s.queued else -1)
      .with("pendingTraffic",s.pendingTraffic or (accepted and pending(s)))
      .with("retiredTraffic",s.retiredTraffic or (accepted and s.durable == 3 and a == 0))
      .with("badDelivery",s.badDelivery or (accepted and s.queued != s.registration))}
  action lifecycle = any {prepare,requestBegin,nativeBegin,observeBegin,nativePublish,
    observePublish,nativeCommit,observeCommit,register,rebind,finish,
    provenNoEffectAbort,failTransition,crash,recover}
  action callback(gate:bool):bool = any {admit(gate),finishQueued(gate),
    {nondet n = Set(0,1,2).oneOf() receive(n,gate)}}
  action step = any {lifecycle,callback(false)}
  action gatedStep = any {lifecycle,callback(true)}
  val safety = and {not(s.badActivation),not(s.badDelivery),not(s.badCurrent),not(s.badResume),
    s.registration == 1 implies s.durable == 3,
    not(s.runtime) implies s.registration == -1 and s.handle == -1,
    (s.runtime and s.phase == "ready") implies s.registration == 1 and s.handle == 1 and s.authorityBinding == 1,
    s.durable > 0 implies not(Set("idle","prepared").contains(s.phase))}
  val gatedAvailability = safety and (authority(s,true) == -1 or floorCurrent(s,authority(s,true)))
  // Observation discriminators. Violations are NOT automatically product bugs.
  val neverPendingTraffic = not(s.pendingTraffic)
  val neverRetiredTraffic = not(s.retiredTraffic)
  val neverReady = s.phase != "ready"
  action unsafeEarlyNewActivation = all {running(s),s.durable < 3,
    s' = s.with("registration",1).with("handle",1).with("authorityBinding",1).with("badActivation",true)}
  action unsafeColdOldActivation = all {not(s.runtime),pending(s),
    s' = s.with("runtime",true).with("registration",0).with("handle",0).with("badActivation",true)}
  action unsafeAmbiguousAbort = all {s.runtime,s.durable > 0,s.phase == "begin",
    s' = s.with("phase","idle").with("suspended",false).with("badResume",true)}
  action unsafeQueuedDelivery = all {s.queued == 0,s.registration == 1,
    s' = s.with("delivered",0).with("queued",-1).with("badDelivery",true)}
  action unsafeEpochOnlyDelivery = all {s.registration == 1,s.handle == 1,
    // Tag 2 has the same epoch number but different anchor/ACL identity.
    s' = s.with("delivered",2).with("badDelivery",true)}
  action unsafeCachedAuthority = all {s.registration == 1,s.handle == 0,
    s' = s.with("admitted",0).with("badCurrent",true)}
  action unsafeLateSuspension = all {s.phase == "begin",s.durable == 1,
    s' = s.with("suspended",false)}
  action earlyStep = any {step,unsafeEarlyNewActivation}
  action coldStep = any {step,unsafeColdOldActivation}
  action abortStep = any {step,unsafeAmbiguousAbort}
  action queueStep = any {step,unsafeQueuedDelivery}
  action tupleStep = any {step,unsafeEpochOnlyDelivery}
  action cachedStep = any {step,unsafeCachedAuthority}
  action lateGateStep = any {gatedStep,unsafeLateSuspension}
  // Keep all normal state transitions; bypass suspension only on queued receive.
  // The observation property must detect this without a special failure flag.
  action queuedGateStep = any {gatedStep,finishQueued(false)}
  action toPending = prepare.then(requestBegin).then(nativeBegin)
  action toCommitted = toPending.then(observeBegin).then(nativePublish)
    .then(observePublish).then(nativeCommit)
  action toReady = toCommitted.then(observeCommit).then(register).then(rebind).then(finish)
  run installedOldDuringPendingTest = init.then(toPending).then(receive(0,false))
    .expect(s.delivered == 0 and s.pendingTraffic and safety)
  run installedOldAfterFloorCommitTest = init.then(toCommitted).then(receive(0,false))
    .expect(s.delivered == 0 and s.retiredTraffic and safety)
  run conservativeGateBeforeNativeEffectTest = init.then(toPending).then(receive(0,true))
    .expect(s.delivered == -1 and gatedAvailability)
  run oldQueuedBytesAfterReplacementTest = init.then(admit(false)).then(toReady)
    .then(finishQueued(false)).expect(s.delivered == -1 and safety)
  run queuedPendingTrafficObservedTest = init.then(admit(false)).then(toPending)
    .then(finishQueued(false)).expect(s.delivered == 0 and s.pendingTraffic and safety)
  run queuedPostcommitTrafficObservedTest = init.then(admit(false)).then(toCommitted)
    .then(finishQueued(false)).expect(s.delivered == 0 and s.retiredTraffic and safety)
  run queuedSuspensionBypassCounterexampleTest = init.then(admit(true)).then(toPending)
    .then(finishQueued(false)).expect(not(neverPendingTraffic))
  run newTupleWorksAfterReadyTest = init.then(toReady).then(receive(1,false))
    .expect(s.delivered == 1 and safety).then(receive(0,false)).expect(s.delivered == -1)
    .then(receive(2,false)).expect(s.delivered == -1 and safety)
  run replacementBeforeRoomRebindTest = init.then(toCommitted).then(observeCommit).then(register)
    .then(receive(0,false)).expect(s.authorityBinding == 0 and authority(s,false) == -1 and s.delivered == -1 and safety)
  run beginAmbiguityFailsGatedTest = init.then(toPending).then(failTransition).then(receive(0,true))
    .expect(s.delivered == -1 and gatedAvailability)
  run noEffectAbortRestoresTest = init.then(prepare).then(requestBegin).then(provenNoEffectAbort)
    .then(receive(0,true)).expect(s.delivered == 0 and gatedAvailability)
  run coldPendingOldCompletesTest = init.then(toPending).then(crash).then(recover)
    .then(receive(0,false)).expect(s.delivered == -1 and safety)
    .then(nativePublish).then(observePublish).then(nativeCommit).then(observeCommit)
    .then(register).then(rebind).then(finish).expect(gatedAvailability)
  run coldPendingNewCompletesTest = init.then(toPending).then(observeBegin).then(nativePublish)
    .then(crash).then(recover).then(nativeCommit).then(observeCommit).then(register).then(rebind).then(finish).expect(safety)
  run coldCommittedCompletesTest = init.then(toCommitted).then(crash).then(recover)
    .then(register).then(rebind).then(finish).expect(safety)
  run earlyNewActivationCounterexampleTest = init.then(toPending).then(unsafeEarlyNewActivation).expect(not(safety))
  run coldActivationCounterexampleTest = init.then(toPending).then(crash).then(unsafeColdOldActivation).expect(not(safety))
  run ambiguousAbortCounterexampleTest = init.then(toPending).then(unsafeAmbiguousAbort).expect(not(safety))
  run queueCounterexampleTest = init.then(admit(false)).then(toReady).then(unsafeQueuedDelivery).expect(not(safety))
  run tupleCounterexampleTest = init.then(toReady).then(unsafeEpochOnlyDelivery).expect(not(safety))
  run cachedAuthorityCounterexampleTest = init.then(toCommitted).then(observeCommit).then(register)
    .then(unsafeCachedAuthority).expect(not(safety))
  run lateGateCounterexampleTest = init.then(toPending).then(unsafeLateSuspension).expect(not(gatedAvailability))
}

// Original local attempt/registration identity is separate from wire tuple
// equality. This conservative original-continuation policy is not an on-wire
// registration identifier or a rule rejecting same-tuple transport replacement.
// Finite scoped induction; not the whole transition or native implementation.
module pendingFloorOwnerGate {
  type State = {registration:int,owner:int,attemptReg:int -> int,pending:Set[int],
    used:Set[int],allowed:bool,closed:bool,grantedAttempt:int,grantedOwner:int,
    captured:int,delivered:bool,deliveryCapture:int,deliveryRegistration:int,deliveryAllowed:bool}
  pure val IDS = Set(0,1)
  var s:State
  pure def safetyOf(st:State):bool = and {
    st.registration >= 0 and st.registration <= 1,
    st.owner == -1 or st.pending.contains(st.owner),
    st.pending.subseteq(st.used),st.used.subseteq(IDS),
    st.owner >= 0 implies not(st.allowed),st.closed implies not(st.allowed),
    st.allowed implies (if (st.grantedAttempt < 0)
      st.registration == 0 and st.grantedOwner == -1
      else st.used.contains(st.grantedAttempt) and st.grantedOwner == st.grantedAttempt and
        st.attemptReg.get(st.grantedAttempt) == st.registration),
    st.delivered implies st.deliveryAllowed and st.deliveryCapture == st.deliveryRegistration and
      IDS.contains(st.deliveryRegistration)}
  val safety = safetyOf(s)
  action init = s' = {registration:0,owner:-1,attemptReg:IDS.mapBy(_ => -1),
    pending:Set(),used:Set(),allowed:true,closed:false,grantedAttempt:-1,grantedOwner:-1,
    captured:-1,delivered:false,deliveryCapture:-1,deliveryRegistration:-1,deliveryAllowed:false}
  action begin(t:int):bool = all {not(s.closed),not(s.used.contains(t)),
    s' = s.with("owner",t).with("pending",s.pending.union(Set(t)))
      .with("used",s.used.union(Set(t))).with("attemptReg",s.attemptReg.set(t,s.registration)).with("allowed",false)}
  action replace = all {s.registration == 0,
    s' = s.with("registration",1).with("allowed",false)}
  action finish(t:int):bool = {
    val owns = s.owner == t and s.attemptReg.get(t) == s.registration and not(s.closed)
    all {s.pending.contains(t),
      s' = s.with("pending",s.pending.exclude(Set(t)))
        .with("owner",if (s.owner == t) -1 else s.owner)
        .with("allowed",s.allowed or owns)
        .with("grantedAttempt",if (owns) t else s.grantedAttempt)
        .with("grantedOwner",if (owns) s.owner else s.grantedOwner)}
  }
  action close = s' = s.with("closed",true).with("allowed",false)
  action capture = all {s.allowed,s.captured == -1,
    s' = s.with("captured",s.registration)}
  // A hypothetical await inside receive requires a current registration check.
  // Shipped receive has no such await; its pre-subscriber segment is atomic.
  action deliver = all {s.captured >= 0,
    // Record the actual decision and its pre-state evidence independently of
    // the authorization predicate. Weakening only that predicate now fails.
    s' = s.with("captured",-1).with("delivered",s.allowed and s.captured == s.registration)
      .with("deliveryCapture",s.captured).with("deliveryRegistration",s.registration)
      .with("deliveryAllowed",s.allowed)}
  action step = any {replace,close,capture,deliver,
    {nondet t = IDS.oneOf() any {begin(t),finish(t)}}}
  action unsafeFinish(t:int):bool = all {s.pending.contains(t),
    s' = s.with("pending",s.pending.exclude(Set(t)))
      .with("owner",if (s.owner == t) -1 else s.owner).with("allowed",true)
      .with("grantedAttempt",t).with("grantedOwner",s.owner)}
  action unsafeDelivery = all {s.captured >= 0,not(s.allowed) or s.captured != s.registration,
    s' = s.with("captured",-1).with("delivered",true)
      .with("deliveryCapture",s.captured).with("deliveryRegistration",s.registration)
      .with("deliveryAllowed",s.allowed)}
  action delayedStep = any {step,unsafeDelivery}
  action finishStep = any {step,{nondet t = IDS.oneOf() unsafeFinish(t)}}
  action unsafeStep = any {delayedStep,finishStep}
  action indInit = {
    nondet r = IDS.oneOf() nondet owner = Set(-1,0,1).oneOf()
    nondet a = Set(-1,0,1).oneOf() nondet b = Set(-1,0,1).oneOf()
    nondet pending = IDS.powerset().oneOf() nondet used = IDS.powerset().oneOf()
    nondet allowed = Set(false,true).oneOf() nondet closed = Set(false,true).oneOf()
    nondet captured = Set(-1,0,1).oneOf() nondet delivered = Set(false,true).oneOf()
    nondet grant = Set(-1,0,1).oneOf() nondet grantOwner = Set(-1,0,1).oneOf()
    nondet deliveryCapture = Set(-1,0,1).oneOf() nondet deliveryRegistration = Set(-1,0,1).oneOf()
    nondet deliveryAllowed = Set(false,true).oneOf()
    val st = {registration:r,owner:owner,attemptReg:Map(0 -> a,1 -> b),pending:pending,used:used,
      allowed:allowed,closed:closed,grantedAttempt:grant,grantedOwner:grantOwner,
      captured:captured,delivered:delivered,deliveryCapture:deliveryCapture,
      deliveryRegistration:deliveryRegistration,deliveryAllowed:deliveryAllowed}
    all {safetyOf(st),s' = st}}
  run staleAttemptDoesNotReleaseNewGateTest = init.then(begin(0)).then(begin(1)).then(finish(0))
    .expect(not(s.allowed) and s.owner == 1 and safety).then(finish(1)).expect(s.allowed and safety)
  run changedRegistrationDoesNotRestoreTest = init.then(begin(0)).then(replace).then(finish(0))
    .expect(not(s.allowed) and safety).then(begin(1)).then(finish(1)).expect(s.allowed and safety)
  run closeAbsorbsCompletionTest = init.then(begin(0)).then(close).then(finish(0)).expect(not(s.allowed) and safety)
  run delayedAuthorizationRecheckedTest = init.then(capture).then(replace).then(deliver).expect(not(s.delivered) and safety)
  run delayedAuthorizationAfterFreshGrantTest = init.then(capture).then(replace).then(begin(0))
    .then(finish(0)).then(deliver).expect(not(s.delivered) and safety)
  run staleFinishCounterexampleTest = init.then(begin(0)).then(begin(1)).then(unsafeFinish(0)).expect(not(safety))
  run changedRegistrationCounterexampleTest = init.then(begin(0)).then(replace).then(unsafeFinish(0)).expect(not(safety))
  run delayedReceiveCounterexampleTest = init.then(capture).then(replace).then(unsafeDelivery).expect(not(safety))
  run staleCaptureAfterFreshGrantCounterexampleTest = init.then(capture).then(replace).then(begin(0))
    .then(finish(0)).then(unsafeDelivery).expect(not(safety))
}
