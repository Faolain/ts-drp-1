// Finite adjuncts. Signatures/QC/ACL/settlement/snapshot verification are one
// authenticated predicate, not modeled cryptography. A native identity is the
// pair (head, revision); neither remote predecessor nor old signature is a role.
module rejoinHeadFloor {
  pure val MAX = 6
  type State = {head:int, floor:int, highFloor:int, phase:str, source:int,
    target:int, revision:int, captured:int, authenticated:bool, live:int,
    writer:bool, targetWriter:bool, runtime:bool,receipt:bool,receiptTarget:int,receiptOnlyRecovered:bool, badRecovery:bool, badPublication:bool, badSigning:bool}
  var s: State
  action init = s' = {head:0, floor:0, highFloor:0, phase:"idle", source:-1,
    target:-1, revision:0, captured:-1, authenticated:false, live:0,
    writer:true, targetWriter:true, runtime:false,receipt:false,receiptTarget:-1,receiptOnlyRecovered:false, badRecovery:false, badPublication:false, badSigning:false}
  action prepare(n:int, writer:bool):bool = all {s.phase == "idle", s.live == s.head,
    n > s.head + 1, n <= MAX,
    s' = s.with("phase","prepared").with("runtime",true).with("source", s.head).with("target", n)
      .with("captured", s.revision).with("authenticated", true)
      .with("targetWriter", writer).with("live", -1)}
  // A yield before acquiring the original writer can invalidate a captured read.
  // Once the native transition owns the writer, external mutation is excluded.
  action invalidate = all {s.phase == "prepared",s.revision == 0,
    s' = s.with("revision", 1)}
  action abandon = all {s.phase == "prepared",s.runtime,
    s' = s.with("phase", "idle").with("source", -1).with("target", -1)
      .with("authenticated", false).with("captured", -1).with("live", s.head).with("runtime",false)}
  pure def current(st:State):bool = st.authenticated and st.source == st.head and st.captured == st.revision
  action persistReceipt = all {s.phase == "prepared",s.runtime,current(s),s.floor == s.source,
    s' = s.with("phase","received").with("receipt",true).with("receiptTarget",s.target)}
  action competingOffer(n:int):bool = all {s.receipt,n > s.source+1,n <= MAX,s' = s}
  action stage = all {s.phase == "received",s.runtime,s.authenticated,s' = s.with("phase","staged")}
  action recoverReceipt = all {s.receipt,not(s.runtime),s.authenticated,
    s' = s.with("runtime",true).with("receiptOnlyRecovered",s.receiptOnlyRecovered or s.phase == "received")}
  action beginFloor = all {s.phase == "staged",s.runtime,current(s),s.floor == s.source,
    s' = s.with("phase", "begun")}
  action publish = all {s.phase == "begun",s.runtime,current(s), s.floor == s.source,
    s' = s.with("head", s.target).with("phase", "published").with("revision", 0)}
  action commitFloor = all {s.phase == "published",s.runtime,s.head == s.target,
    s' = s.with("floor", s.target).with("highFloor", s.target).with("phase", "committed")}
  action activate = all {s.phase == "committed",s.runtime,s.head == s.floor,
    s' = s.with("phase", "idle").with("live", s.head).with("writer", s.targetWriter)
      .with("source", -1).with("target", -1).with("captured", -1).with("authenticated",false).with("runtime",false).with("receipt",false).with("receiptTarget",-1)}
  action crash = all {s.live != -1 or s.runtime,
    s' = if (s.phase == "prepared") s.with("live",-1).with("runtime",false).with("phase","idle")
      .with("source",-1).with("target",-1).with("captured",-1).with("authenticated",false)
      else s.with("live",-1).with("runtime",false)}
  action reopen = all {s.phase == "idle",not(s.receipt),s.live == -1, s.head == s.floor,
    s' = s.with("live", s.head)}
  action sign(epoch:int):bool = all {s.phase == "idle",not(s.receipt),s.live == s.head,s.writer, epoch == s.head, s' = s}
  val safety = and {not(s.badRecovery),not(s.badPublication),not(s.badSigning), s.floor == s.highFloor,
    s.floor <= s.head,
    s.receipt == Set("received","staged","begun","published","committed").contains(s.phase),
    s.receipt implies s.live == -1 and s.target == s.receiptTarget,
    not(s.receipt) implies s.receiptTarget == -1,
    s.live == -1 or (s.phase == "idle" and s.live == s.head),
    s.phase == "idle" implies s.head == s.floor,
    s.phase != "idle" implies (s.authenticated and s.target > s.source + 1),
    Set("prepared","received","staged","begun").contains(s.phase) implies s.head == s.floor and s.head == s.source,
    s.phase == "published" implies s.head == s.target and s.floor == s.source,
    s.phase == "committed" implies s.head == s.target and s.floor == s.target}
  val neverGap = s.head < 4
  val neverReceiptOnlyRecovery = not(s.receiptOnlyRecovered)
  action step = any {invalidate,abandon,persistReceipt,stage,recoverReceipt,beginFloor, publish, commitFloor, activate, crash, reopen,
    {nondet n = 0.to(MAX).oneOf() nondet writer = Set(false,true).oneOf() prepare(n,writer)},
    {nondet n = 0.to(MAX).oneOf() any {sign(n),competingOffer(n)}}}
  action unsafeStalePublication = all {s.phase == "prepared",not(current(s)),
    s' = s.with("head", s.target).with("phase", "published").with("badPublication", true)}
  action unsafeLowerFloor = all {s.floor > 0, s' = s.with("floor", s.floor-1)}
  action unsafeRoleRevival = all {s.head > 0, s' = s.with("live", 0)}
  action unsafeOldSignature = all {s.head > 0, s' = s.with("badSigning", true)}
  action unsafeReceiptOnlyRefusal = all {s.phase == "received",not(s.runtime),s.authenticated,
    s' = s.with("badRecovery",true)}
  action unsafeOldAdmissionAfterReceipt = all {s.receipt,s.head == s.source,
    s' = s.with("live",s.head)}
  action unsafeReplaceReceipt(n:int):bool = all {s.receipt,s.head == s.source,n > s.target,n <= MAX,
    s' = s.with("target",n)}
  action receiptTargetStep = any {step,{nondet n = 0.to(MAX).oneOf() unsafeReplaceReceipt(n)}}
  action receiptAdmissionStep = any {step,unsafeOldAdmissionAfterReceipt}
  action receiptOnlyStep = any {step,unsafeReceiptOnlyRefusal}
  action staleStep = any {step, unsafeStalePublication}
  action lowerStep = any {step, unsafeLowerFloor}
  action reviveStep = any {step, unsafeRoleRevival}
  action signatureStep = any {step, unsafeOldSignature}
  action jump(n:int,w:bool):bool = prepare(n,w).then(persistReceipt).then(stage).then(beginFloor).then(publish).then(commitFloor).then(activate)
  run gapAndReadmissionTest = init.then(jump(2,false)).then(crash).then(reopen)
    .expect(not(s.writer) and safety).then(jump(6,true)).then(sign(6)).expect(safety)
  run beforePublishRecoveryTest = init.then(prepare(4,true)).then(persistReceipt).then(stage).then(beginFloor)
    .then(crash).then(recoverReceipt).expect(s.head == 0 and s.floor == 0 and safety).then(publish).then(commitFloor).then(activate).expect(safety)
  run afterPublishRecoveryTest = init.then(prepare(4,true)).then(persistReceipt).then(stage).then(beginFloor).then(publish)
    .then(crash).then(recoverReceipt).expect(s.head == 4 and s.floor == 0 and safety).then(commitFloor).then(activate).expect(safety)
  run receiptOnlyColdRecoveryTest = init.then(prepare(4,true)).then(persistReceipt).then(crash)
    .expect(s.phase == "received" and not(s.runtime) and safety).then(recoverReceipt).then(stage)
    .then(beginFloor).then(publish).then(commitFloor).then(activate).expect(s.receiptOnlyRecovered and safety)
  run receiptOnlyDiscoveryCounterexampleTest = init.then(prepare(4,true)).then(persistReceipt).then(crash)
    .then(unsafeReceiptOnlyRefusal).expect(not(safety))
  run receiptDiscoveryKeepsWriterHaltedTest = init.then(prepare(4,true)).then(persistReceipt).then(crash)
    .then(recoverReceipt).expect(s.runtime and s.receipt and s.live == -1 and safety)
  run receiptOldAdmissionCounterexampleTest = init.then(prepare(4,true)).then(persistReceipt).then(crash)
    .then(recoverReceipt).then(unsafeOldAdmissionAfterReceipt).expect(not(safety))
  run competingOfferPreservesOriginalReceiptTest = init.then(prepare(2,true)).then(persistReceipt).then(competingOffer(4))
    .then(crash).then(recoverReceipt).expect(s.receiptTarget == 2 and s.target == 2 and safety)
    .then(stage).then(beginFloor).then(publish).then(commitFloor).then(activate).expect(s.head == 2 and safety)
  run highestEpochReceiptReplacementCounterexampleTest = init.then(prepare(2,true)).then(persistReceipt)
    .then(unsafeReplaceReceipt(4)).expect(not(safety))
  run staleAttachmentCounterexampleTest = init.then(prepare(4,true)).then(invalidate)
    .then(unsafeStalePublication).expect(not(safety))
  run loweredFloorCounterexampleTest = init.then(jump(4,true)).then(unsafeLowerFloor).expect(not(safety))
  run oldRoleCounterexampleTest = init.then(jump(4,true)).then(unsafeRoleRevival).expect(not(safety))
}

// The current and two rollback roles follow actual native parent publications.
// This projection permits every strictly increasing target; it is independent
// of gap size. Oldest-parent normalization frames the usable three-point window.
module rejoinActualHeadRoles {
  pure val EPOCHS = 0.to(8)
  type State = {head:int, first:int, oldest:int, base:int -> int,birthKind:int -> str,retained:Set[int],
    published:Set[int],normalized:Set[int],live:int,promotedFrom:int,badPromotion:bool,badRecovery:bool}
  var s:State
  pure def roles(st:State):Set[int] = Set(st.head,st.first,st.oldest).exclude(Set(-1))
  pure def usable(st:State):Set[int] = roles(st).exclude(Set(0))
  pure def validPoint(st:State,e:int):bool = if (e == 0) st.birthKind.get(e) == "genesis"
    else Set("adjacent","checkpoint","promotion").contains(st.birthKind.get(e))
  pure def safetyOf(st:State):bool = and {
    0 <= st.head and st.head <= 8, -1 <= st.oldest and st.oldest <= st.first,
    (st.head == 0 and st.first == -1 and st.oldest == -1) or
      (0 <= st.first and st.first < st.head and st.oldest < st.first),
    st.base.get(st.head) == st.first,
    st.first >= 0 implies st.base.get(st.first) == st.oldest,
    roles(st).subseteq(st.retained), st.retained.subseteq(st.published), st.retained.size() <= 7,
    st.published.forall(e => e <= st.head),
    st.live == -1 or st.live == st.head,
    roles(st).forall(e => validPoint(st,e)),not(st.badPromotion),not(st.badRecovery)}
  val safety = safetyOf(s)
  val neverNormalized = s.normalized == Set()
  action init = s' = {head:0, first:-1, oldest:-1, base:(-1).to(8).mapBy(_ => -1),
    birthKind:(-1).to(8).mapBy(e => if (e == 0) "genesis" else "none"),
    retained:Set(0),published:Set(0),normalized:Set(),live:0,promotedFrom:-1,badPromotion:false,badRecovery:false}
  action install(n:int):bool = all {n > s.head, n <= 8, s.live == s.head, s.retained.size() < 7,
    s' = s.with("head",n).with("first",s.head).with("oldest",s.first)
      .with("base",s.base.set(n,s.head)).with("birthKind",s.birthKind.set(n,if (n == s.head+1) "adjacent" else "checkpoint"))
      .with("retained",s.retained.union(Set(n)))
      .with("published",s.published.union(Set(n))).with("live",n)}
  action normalizeOldest = all {s.oldest > 0, not(s.normalized.contains(s.oldest)),
    s' = s.with("base",s.base.set(s.oldest,-1)).with("normalized",s.normalized.union(Set(s.oldest)))}
  action prune(e:int):bool = all {s.retained.contains(e), not(roles(s).contains(e)),
    s' = s.with("retained",s.retained.exclude(Set(e)))}
  action crash = all {s.live != -1, s' = s.with("live",-1)}
  // No reconstruction of the removed oldest parent or historical revision.
  // Current/first exact birth receipts and independent oldest point are premises.
  action reopen = all {s.live == -1,roles(s).subseteq(s.retained),roles(s).forall(e => validPoint(s,e)),
    s.base.get(s.head) == s.first, s.first < 0 or s.base.get(s.first) == s.oldest,
    s' = s.with("live",s.head)}
  action promote(e:int,n:int):bool = all {Set(s.first,s.oldest).exclude(Set(-1,0)).contains(e),
    n > s.head, n <= 8, s.live == s.head, s.retained.size() < 7,
    s' = s.with("head",n).with("first",s.head).with("oldest",s.first)
      .with("base",s.base.set(n,s.head)).with("birthKind",s.birthKind.set(n,"promotion"))
      .with("retained",s.retained.union(Set(n)))
      .with("published",s.published.union(Set(n))).with("live",n).with("promotedFrom",e)}
  action step = any {normalizeOldest,crash,reopen,
    {nondet n = EPOCHS.oneOf() install(n)}, {nondet e = EPOCHS.oneOf() prune(e)},
    {nondet e = EPOCHS.oneOf() nondet n = EPOCHS.oneOf() promote(e,n)}}
  action unsafeRemotePredecessor = all {s.head > 1, not(s.published.contains(s.head-1)),
    s' = s.with("first",s.head-1)}
  action unsafePruneProtected = all {s.oldest >= 0,
    s' = s.with("retained",s.retained.exclude(Set(s.oldest)))}
  action unsafePromoteSignatureOnly = all {s.oldest > 0,
    s' = s.with("live",s.oldest).with("badPromotion",true)}
  action unsafeRejectAdjacentPoint = all {s.live == -1,roles(s).exists(e => s.birthKind.get(e) == "adjacent"),
    s' = s.with("badRecovery",true)}
  action mixedStep = any {step,unsafeRejectAdjacentPoint}
  action remoteStep = any {step,unsafeRemotePredecessor}
  action protectedStep = any {step,unsafePruneProtected}
  action obsoleteStep = any {step,unsafePromoteSignatureOnly}
  action window = install(2).then(install(4)).then(install(8))
  run mixedAdjacentGapColdOpenTest = init.then(install(1)).then(install(3)).then(install(5))
    .then(crash).then(reopen).expect(usable(s) == Set(5,3,1) and s.birthKind.get(1) == "adjacent" and safety)
  run trustOnlyColdOpenTest = init.then(crash).then(reopen).expect(usable(s) == Set() and safety)
  run ordinaryPointRefusalCounterexampleTest = init.then(install(1)).then(install(3)).then(install(5))
    .then(crash).then(unsafeRejectAdjacentPoint).expect(not(safety))
  run actualEightFourTwoTest = init.then(window).expect(usable(s) == Set(8,4,2) and safety)
  run normalizeThenColdOpenBeforeNextFloorTest = init.then(window).then(normalizeOldest).then(prune(0))
    .then(crash).then(reopen).expect(usable(s) == Set(8,4,2) and s.base.get(2) == -1 and safety)
  run remoteSevenNeverLocalTest = init.then(window).then(unsafeRemotePredecessor).expect(not(safety))
  run protectedOldestCounterexampleTest = init.then(window).then(unsafePruneProtected).expect(not(safety))
  run promoteFirstForwardTest = init.then(install(2)).then(install(4)).then(install(6))
    .then(promote(4,8)).expect(s.head == 8 and s.promotedFrom == 4 and safety)
  run promoteOldestForwardTest = init.then(install(2)).then(install(4)).then(install(6))
    .then(normalizeOldest).then(crash).then(reopen).then(promote(2,8)).expect(s.promotedFrom == 2 and safety)
  run obsoleteSignatureCounterexampleTest = init.then(install(2)).then(install(4)).then(install(6))
    .then(unsafePromoteSignatureOnly).expect(not(safety))
}

// Scoped arbitrary-state induction: only the three actual publication slots.
// This does not prove native receipt authentication or the concrete TS mapping.
module rejoinRoleProjection {
  type State = {head:int, first:int, oldest:int, normalized:bool, live:int}
  var s:State
  pure def safetyOf(st:State):bool = and {
    0 <= st.head and st.head <= 8,
    (st.head == 0 and st.first == -1 and st.oldest == -1) or
    (0 <= st.first and st.first < st.head and -1 <= st.oldest and st.oldest < st.first),
    st.live == -1 or st.live == st.head}
  val safety = safetyOf(s)
  action init = s' = {head:0,first:-1,oldest:-1,normalized:false,live:0}
  action advance(n:int):bool = all {n > s.head,n <= 8,
    s' = {head:n,first:s.head,oldest:s.first,normalized:false,live:n}}
  action normalize = s' = s.with("normalized",true)
  action crash = s' = s.with("live",-1)
  action reopen = s' = s.with("live",s.head)
  action step = any {normalize,crash,reopen,{nondet n = 0.to(8).oneOf() advance(n)}}
  action indInit = {nondet h = 0.to(8).oneOf() nondet f = (-1).to(8).oneOf()
    nondet o = (-1).to(8).oneOf() nondet norm = Set(false,true).oneOf() nondet live = (-1).to(8).oneOf()
    val st = {head:h,first:f,oldest:o,normalized:norm,live:live}
    all {safetyOf(st),s' = st}}
  action unsafeStep = any {step,all {s.head > 0,s' = s.with("live",s.first)}}
}
