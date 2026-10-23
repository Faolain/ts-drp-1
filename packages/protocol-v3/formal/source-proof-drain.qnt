// Two exact committed sources share one bounded completion context. Source ids
// stand for the complete object/author/sequence/digest tuple. Authentic Cut/QC/
// membership, exact native issued/outbox pairing, fresh held native currency,
// and truthful complete absence are premises of these original-owner actions.
// This adjunct does not model signatures, native transactions, or unknown expiry.
module sourceProofDrain {
  pure val SOURCES = Set(1,2)
  type State = {pairs:Set[int], acknowledged:Set[int], entries:Set[int], context:bool,
    prefixBlocked:bool, planRevision:int, progressed:bool, online:bool, reopened:bool,
    coldPairs:Set[int], coldProof:Set[int],
    inverseStored:bool, inverseEntries:Set[int], inverseContext:bool, inverseTarget:int,
    read:bool, readSource:int, readEntries:Set[int], readContext:bool,
    readInverse:bool, readPlan:int, readTarget:int}
  var s:State

  // Completion removes settlement/reissue debt, not pending publication debt.
  pure def eligible(st:State,id:int):bool = st.pairs.contains(id) and st.acknowledged.contains(id)
  pure def canPrune(st:State,id:int):bool = st.online and eligible(st,id) and not(st.prefixBlocked) and
    st.pairs.forall(other => other >= id)
  pure def currentProof(st:State):Set[int] = if (st.context) st.entries else Set()
  // The former inverse helper is represented only for the regression controls.
  // A revision is an injective exact-plan identity; no ABA or hash collision is
  // admitted. Its before-plan is genuine historical data, never fresh currency.
  pure def exactInverse(st:State):bool = st.inverseStored and st.inverseContext and
    st.planRevision == st.inverseTarget
  pure def recoverableProof(st:State):Set[int] = currentProof(st).union(
    if (exactInverse(st)) st.inverseEntries else Set())
  pure def readAuthority(st:State):bool = not(st.read) or and {
    st.readEntries.contains(st.readSource),st.readContext,
    not(st.readInverse) or st.readPlan == st.readTarget}
  val pendingRetained = SOURCES.exclude(s.acknowledged).subseteq(s.pairs)
  val sharedContextRetained = (s.entries == Set()) == not(s.context)
  val currentCustody = s.pairs.subseteq(currentProof(s))
  // Record what the cold owner actually found. An earlier valid reopen is not
  // retroactively invalidated by later progress, nor permission for a new read.
  val coldCustody = not(s.reopened) or s.coldPairs.subseteq(s.coldProof)
  val safety = pendingRetained and sharedContextRetained and currentCustody and readAuthority(s)
  val neverReleased = s.context or s.entries != Set() or s.pairs != Set()
  val neverPartial = not(s.pairs == Set(2) and s.entries == Set(2) and s.context)

  action init = s' = {pairs:SOURCES,acknowledged:Set(),entries:SOURCES,context:true,
    prefixBlocked:true,planRevision:0,progressed:false,online:true,reopened:false,coldPairs:Set(),coldProof:Set(),
    inverseStored:false,inverseEntries:Set(),inverseContext:false,inverseTarget:-1,
    read:false,readSource:-1,readEntries:Set(),readContext:false,
    readInverse:false,readPlan:-1,readTarget:-1}
  // Only a successful original publication owner supplies this exact ACK.
  // Targeted replay, mere inclusion, and a failed send cannot invoke it.
  action publicationAck(id:int):bool = all {s.online,s.pairs.contains(id),not(s.acknowledged.contains(id)),
    s' = s.with("acknowledged",s.acknowledged.union(Set(id)))}
  action joinPrefixBlocker = all {s.online,s.prefixBlocked,s' = s.with("prefixBlocked",false)}
  // Retained terminal proof is deliberately absent from the protection test.
  // The original native owner atomically removes the exact pair and watermark.
  action physicalPrune(id:int):bool = all {canPrune(s,id),
    s' = s.with("pairs",s.pairs.exclude(Set(id)))}
  // Ordinary FENCE/plan progress is independent and preserves source custody.
  action planProgress = all {s.online,not(s.progressed),s.planRevision < 3,
    s' = s.with("planRevision",s.planRevision + 1).with("progressed",true)}
  // A fresh metadata rewrite uses actual native absence, not eligibility or an
  // intended physical target. Shared bytes survive every remaining reference.
  action rewrite = {
    val retained = s.entries.intersect(s.pairs)
    all {s.online,retained != s.entries,s.planRevision < 3,
      s' = s.with("entries",retained).with("context",retained != Set())
        .with("planRevision",s.planRevision + 1)}}
  action crash = all {s.online,s' = s.with("online",false).with("reopened",false).with("read",false)}
  action reopen = all {not(s.online),s' = s.with("online",true).with("reopened",true)
    .with("coldPairs",s.pairs).with("coldProof",recoverableProof(s))}
  action readCurrent(id:int):bool = all {s.online,s.pairs.contains(id),currentProof(s).contains(id),
    s' = s.with("read",true).with("readSource",id).with("readEntries",s.entries)
      .with("readContext",s.context).with("readInverse",false)
      .with("readPlan",s.planRevision).with("readTarget",-1)}
  action step = any {joinPrefixBlocker,planProgress,rewrite,crash,reopen,
    {nondet id = SOURCES.oneOf() any {publicationAck(id),physicalPrune(id),readCurrent(id)}}}

  // Regression: rewrite on eligibility while a separate prefix still prevents
  // physical deletion. The exact-target inverse temporarily masks the loss.
  action prematureRewrite = {
    val dropped = s.pairs.filter(id => eligible(s,id))
    val retained = s.entries.exclude(dropped)
    all {s.online,not(s.inverseStored),dropped != Set(),retained != s.entries,s.planRevision < 3,
      s' = s.with("entries",retained).with("context",retained != Set())
        .with("planRevision",s.planRevision + 1).with("inverseStored",true)
        .with("inverseEntries",s.entries).with("inverseContext",s.context)
        .with("inverseTarget",s.planRevision + 1)}}
  // This action records the actual mismatched identities rather than setting a
  // mutant flag. Widening historical before-plan authority must be rejected.
  action staleInverseRead(id:int):bool = all {s.online,s.inverseStored,s.pairs.contains(id),
    s.inverseEntries.contains(id),not(exactInverse(s)),
    s' = s.with("read",true).with("readSource",id).with("readEntries",s.inverseEntries)
      .with("readContext",s.inverseContext).with("readInverse",true)
      .with("readPlan",s.planRevision).with("readTarget",s.inverseTarget)}
  action dropSharedContext = all {s.online,s.entries == Set(2),s.context,
    s' = s.with("context",false)}
  action prunePending(id:int):bool = all {s.online,s.pairs.contains(id),not(s.acknowledged.contains(id)),
    s' = s.with("pairs",s.pairs.exclude(Set(id)))}
  action prematureStep = any {step,prematureRewrite}
  action inverseStep = any {prematureStep,{nondet id = SOURCES.oneOf() staleInverseRead(id)}}
  action contextStep = any {step,dropSharedContext}
  action pendingStep = any {step,{nondet id = SOURCES.oneOf() prunePending(id)}}
  val inverseSafety = readAuthority(s)

  run pendingPublicationKeepsPairTest = init.then(joinPrefixBlocker)
    .expect(not(canPrune(s,1)) and not(canPrune(s,2)) and safety)
  run independentPrefixKeepsProofTest = init.then(publicationAck(1)).then(planProgress)
    .expect(eligible(s,1) and not(canPrune(s,1)) and s.entries == SOURCES and safety)
  run proofDoesNotProtectEligiblePairTest = init.then(publicationAck(1)).then(joinPrefixBlocker)
    .expect(s.entries.contains(1) and canPrune(s,1)).then(physicalPrune(1)).expect(safety)
  run publishedLaterSourceWaitsForPrefixTest = init.then(publicationAck(2)).then(joinPrefixBlocker)
    .expect(eligible(s,2) and not(canPrune(s,2)) and safety)
  run sharedContextSurvivesPartialDrainTest = init.then(publicationAck(1)).then(joinPrefixBlocker)
    .then(physicalPrune(1)).then(rewrite).expect(s.entries == Set(2) and s.context and safety)
  run coldProgressPreservesProofTest = init.then(publicationAck(1)).then(planProgress).then(crash).then(reopen)
    .then(readCurrent(1)).expect(coldCustody and safety)
  run partialDrainColdReopenTest = init.then(publicationAck(1)).then(joinPrefixBlocker).then(physicalPrune(1))
    .then(rewrite).then(planProgress).then(crash).then(reopen).then(readCurrent(2))
    .expect(s.entries == Set(2) and s.context and coldCustody and safety)
  run finalNativeAbsenceReleasesSharedProofTest = init.then(publicationAck(1)).then(joinPrefixBlocker)
    .then(physicalPrune(1)).then(rewrite).then(planProgress).then(publicationAck(2)).then(physicalPrune(2))
    .expect(s.context and s.entries == Set(2)).then(rewrite).expect(not(neverReleased) and safety)
  run prematureInverseMasksLossOnlyAtExactTargetTest = init.then(publicationAck(1)).then(prematureRewrite)
    .expect(not(currentCustody) and s.pairs.subseteq(recoverableProof(s))).then(crash).then(reopen)
    .expect(coldCustody).then(planProgress).expect(not(s.pairs.subseteq(recoverableProof(s))))
    .then(crash).then(reopen).expect(not(coldCustody))
  run prematureProofLossAfterProgressColdTest = init.then(publicationAck(1)).then(prematureRewrite)
    .then(planProgress).then(crash).then(reopen).expect(not(coldCustody) and s.pairs == SOURCES)
  run staleInverseCannotBecomeCurrentAuthorityTest = init.then(publicationAck(1)).then(prematureRewrite)
    .then(planProgress).then(crash).then(reopen).then(staleInverseRead(1)).expect(not(inverseSafety))
  run partialSharedContextLossCounterexampleTest = init.then(publicationAck(1)).then(joinPrefixBlocker)
    .then(physicalPrune(1)).then(rewrite).then(dropSharedContext).expect(not(safety))
  run pendingPhysicalLossCounterexampleTest = init.then(prunePending(1)).expect(not(pendingRetained))
}

// Small exact-target currency lemma, separate from the lifecycle. Before-plan
// authenticity is assumed; equality to an obsolete target still grants nothing.
// The accepted read retains decision-time evidence, not post-state currentness.
module sourceProofTargetCurrency {
  type State = {plan:int,target:int,accepted:bool,grantPlan:int,grantTarget:int}
  var s:State
  pure def safetyOf(st:State):bool = not(st.accepted) or st.grantPlan == st.grantTarget
  val safety = safetyOf(s)
  action init = s' = {plan:0,target:0,accepted:false,grantPlan:-1,grantTarget:-1}
  action progress = all {s.plan == 0,s' = s.with("plan",1)}
  action read = s' = s.with("accepted",s.plan == s.target).with("grantPlan",s.plan).with("grantTarget",s.target)
  action step = any {progress,read}
  action staleRead = all {s.plan != s.target,
    s' = s.with("accepted",true).with("grantPlan",s.plan).with("grantTarget",s.target)}
  action unsafeStep = any {step,staleRead}
  action indInit = {
    nondet plan = Set(0,1).oneOf() nondet target = Set(0,1).oneOf()
    nondet accepted = Set(false,true).oneOf()
    nondet grantPlan = Set(-1,0,1).oneOf() nondet grantTarget = Set(-1,0,1).oneOf()
    val st = {plan:plan,target:target,accepted:accepted,grantPlan:grantPlan,grantTarget:grantTarget}
    all {safetyOf(st),s' = st}}
  run exactTargetReadTest = init.then(read).expect(s.accepted and safety)
  run changedTargetRefusesTest = init.then(progress).then(read).expect(not(s.accepted) and safety)
  run validEarlierReadIsHistoricalTest = init.then(read).then(progress).expect(s.accepted and safety)
  run staleTargetCounterexampleTest = init.then(progress).then(staleRead).expect(not(safety))
}
