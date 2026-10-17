module journalRetirement {
  import authorLineageActions.localSignedVertex from "./author-lineage-actions"
  import authorLineageActions.authenticateSignedVertex from "./author-lineage-actions"

  // Finite adjunct: authenticated scope/debt classification is assumed. These
  // fences are required future native transaction guards, not existing APIs.
  pure val SCOPES = Set(0,1,2,3)
  pure val REQUIRED = Set(1,2,3)
  type Row = { scope:int, sequence:int }
  type State = { scopes:Set[int], rows:Set[Row], high:int, issued:Set[int],
    replay:Set[int], pending:Set[int], shared:Set[int], floor:int, revision:int,
    capturedRevision:int, intent:bool, committed:bool, fence:bool, retired:bool,
    observed:bool, uncertain:bool, refused:bool, crashed:bool }
  var s:State
  val protected = REQUIRED.union(s.replay).union(s.pending).union(s.shared)
  val journalDependenciesProtected = protected.subseteq(s.scopes)
  val sequenceHighWatermarkPreserved = s.issued.forall(n => n < s.high)
  val retiredScopeCannotAppendOrInstall = s.retired.implies(
    s.floor == 1 and not(s.scopes.contains(0)) and s.rows.forall(r => r.scope != 0))
  val safety = journalDependenciesProtected and sequenceHighWatermarkPreserved and
    retiredScopeCannotAppendOrInstall and s.high >= 2 and s.high <= 3
  val current = s.revision == s.capturedRevision and not(s.crashed)
  val eligible = not(protected.contains(0)) and journalDependenciesProtected
  val complete = s.retired and s.observed and not(s.uncertain) and not(s.intent)
  action init = s' = {scopes:SCOPES,rows:Set({scope:0,sequence:0},{scope:0,sequence:1}),
    high:2,issued:Set(0,1),replay:Set(),pending:Set(),shared:Set(),floor:0,
    revision:1,capturedRevision:1,intent:false,committed:false,fence:false,
    retired:false,observed:false,uncertain:false,refused:false,crashed:false}
  action prepare = s' = if(current and eligible and not(s.intent))
    s.with("intent",true) else s.with("refused",true)
  action fence = s' = if(current and s.intent and eligible)
    s.with("fence",true).with("floor",1) else s.with("refused",true)
  action commit = s' = if(current and s.intent and s.fence and eligible)
    s.with("committed",true) else s.with("refused",true)
  action drain(lost:bool):bool = s' = if(current and s.committed and s.fence and eligible)
    s.with("scopes",s.scopes.exclude(Set(0))).with("rows",s.rows.filter(r => r.scope != 0))
      .with("retired",true).with("uncertain",lost).with("observed",not(lost))
    else s.with("refused",true)
  action readback = s' = if(current and s.committed and s.fence and s.retired and eligible)
    s.with("observed",true).with("uncertain",false) else s.with("refused",true)
  action finish = s' = if(current and s.observed and s.retired and not(s.uncertain))
    s.with("intent",false).with("fence",false) else s.with("refused",true)
  // Permanent floor is checked even after transient fences release. Captured
  // revision prevents a stale read token from authorizing any mutation.
  action appendRow(scope:int,token:int):bool = s' = if(not(s.crashed) and
    token == s.revision and SCOPES.contains(scope) and scope >= s.floor and s.scopes.contains(scope))
    s.with("rows",s.rows.union(Set({scope:scope,sequence:2}))) else s.with("refused",true)
  action install(scope:int,token:int):bool = s' = if(not(s.crashed) and
    token == s.revision and SCOPES.contains(scope) and scope >= s.floor)
    s.with("scopes",s.scopes.union(Set(scope))) else s.with("refused",true)
  action issueCurrent = s' = if(not(s.crashed) and s.high < 3 and
    authenticateSignedVertex(localSignedVertex(s.high),localSignedVertex(s.high)))
    s.with("issued",s.issued.union(Set(s.high))).with("high",s.high+1)
    else s.with("refused",true)
  action addDebt(kind:str):bool = s' = if(s.floor == 0 and not(s.crashed))
    if(kind == "replay") s.with("replay",Set(0))
    else if(kind == "pending") s.with("pending",Set(0)) else s.with("shared",Set(0))
    else s.with("refused",true)
  action stale = s' = s.with("revision",2)
  action crash = s' = s.with("crashed",true).with("observed",false)
  action restart = s' = s.with("crashed",false)
  action unsafeInstallWithoutFloor = s' = s.with("scopes",s.scopes.union(Set(0)))
  action unsafeEraseHighWatermark = s' = s.with("high",0)
  action stutter = s' = s
  action progress = if(complete) stutter else if(s.crashed) restart
    else if(not(s.intent)) prepare else if(not(s.fence)) fence
    else if(not(s.committed)) commit else if(not(s.retired)) drain(false)
    else if(not(s.observed) or s.uncertain) readback else finish
  action step = any {prepare,fence,commit,drain(false),drain(true),readback,finish,
    appendRow(0,1),appendRow(1,1),install(0,1),issueCurrent,addDebt("replay"),
    addDebt("pending"),addDebt("shared"),stale,crash,restart,stutter}
  run healthyFiniteDrainTest = init.then(prepare).then(fence).then(commit).then(drain(false)).then(finish).expect(safety and complete)
  run replayDependencyRefusesTest = init.then(addDebt("replay")).then(prepare).expect(s.refused and not(s.intent) and safety)
  run pendingDependencyRefusesTest = init.then(addDebt("pending")).then(prepare).expect(s.refused and safety)
  run sharedDependencyRefusesTest = init.then(addDebt("shared")).then(prepare).expect(s.refused and safety)
  run foreignDebtAfterPrepareRefusesTest = init.then(prepare).then(addDebt("shared")).then(fence).expect(s.refused and not(s.fence) and safety)
  run lateDebtAfterFenceRefusesTest = init.then(prepare).then(fence).then(addDebt("shared")).expect(s.refused and not(s.shared.contains(0)) and safety)
  run staleReadTokenRejectedTest = init.then(stale).then(appendRow(1,1)).then(install(0,1)).expect(s.refused and s.rows.size()==2 and safety)
  run staleDrainAuthorityRefusesTest = init.then(prepare).then(fence).then(commit).then(stale).then(drain(false)).expect(s.refused and not(s.retired) and s.scopes.contains(0) and safety)
  run staleReadbackAuthorityRefusesTest = init.then(prepare).then(fence).then(commit).then(drain(true)).then(stale).then(readback).expect(s.refused and not(s.observed) and s.uncertain and safety)
  run staleCompletionAuthorityRefusesTest = init.then(prepare).then(fence).then(commit).then(drain(false)).then(stale).then(finish).expect(s.refused and s.intent and s.fence and safety)
  run permanentFenceAfterReleaseTest = init.then(prepare).then(fence).then(commit).then(drain(false)).then(finish).then(appendRow(0,1)).then(install(0,1)).expect(s.refused and complete and safety)
  run currentWorkRemainsEnabledTest = init.then(prepare).then(fence).then(commit).then(drain(false)).then(finish).then(appendRow(1,1)).then(issueCurrent).expect(s.high==3 and s.rows.contains({scope:1,sequence:2}) and safety)
  run lostAckCrashRecoveryTest = init.then(prepare).then(fence).then(commit).then(drain(true)).then(crash).then(restart).then(finish).expect(s.refused and s.intent).then(readback).then(finish).expect(complete and safety)
  run unsafeLateInstallCounterexampleTest = init.then(prepare).then(fence).then(commit).then(drain(false)).then(finish).then(unsafeInstallWithoutFloor).expect(not(safety))
  run unsafeCounterResetCounterexampleTest = init.then(prepare).then(fence).then(commit).then(drain(false)).then(unsafeEraseHighWatermark).expect(not(safety))
}

module journalReplayReuse {
  // Selected finite adjunct to the existing journal model, not retirement
  // authority. Exact native header identity includes all three byte carriers.
  // SQLite data_version changes on foreign commits; own public writers clear
  // the basis explicitly. These are native/source assumptions, not proved here.
  // Token identity abstracts the original canonical full-prefix digest law.
  // Progress is conditional on valid stable native custody and the exact token;
  // this three-row witness is not a fairness, induction, or byte-bound proof.
  type State = {
    nativeVersion:int, nativeHeader:int, nativeHigh:int, nativeValid:bool,
    stable:bool, basisHeld:bool, basisVersion:int, basisHeader:int,
    basisToken:int, basisPrefix:int, suppliedToken:int, suppliedPrefix:int,
    cursor:int, delivered:Set[int], result:str, materialized:int,
    freshAtRead:bool, validAtRead:bool, stableAtRead:bool, poisoned:bool
  }
  var p:State
  pure val PREFIX = 3
  pure val LIMIT = 1
  pure val PREFIX_ROWS = Set(0,1,2)
  val exactToken = p.suppliedToken == 1 and p.suppliedPrefix == PREFIX
  val reusableExceptVersion = p.basisHeld and p.stable and
    p.nativeHeader == p.basisHeader and p.suppliedToken == p.basisToken and
    p.suppliedPrefix == p.basisPrefix
  val reusable = reusableExceptVersion and p.nativeVersion == p.basisVersion
  val validSnapshot = p.nativeValid and exactToken and p.suppliedPrefix <= p.nativeHigh
  // Successful observations are historical facts. A later external mutation
  // invalidates the NEXT reuse; it does not erase a prior delivered observation.
  val pageSafety = p.cursor >= 0 and p.cursor <= PREFIX and
    p.delivered.subseteq(PREFIX_ROWS) and
    (p.result == "fast").implies(p.freshAtRead and p.validAtRead and
      p.stableAtRead and p.materialized <= LIMIT+1) and
    p.poisoned.implies(p.result != "fast" and p.result != "full")
  val remaining = PREFIX - p.cursor
  pure def minimum(a:int,b:int):int = if(a < b) a else b
  def capturedBasis = p.with("basisHeld",p.stable)
    .with("basisVersion",p.nativeVersion).with("basisHeader",p.nativeHeader)
    .with("basisToken",p.suppliedToken).with("basisPrefix",p.suppliedPrefix)
  def emitted(mode:str, count:int):State = p
    .with("cursor",minimum(PREFIX,p.cursor+LIMIT))
    .with("delivered",if(p.cursor < PREFIX) p.delivered.union(Set(p.cursor)) else p.delivered)
    .with("result",mode).with("materialized",count)
    .with("freshAtRead",reusable).with("validAtRead",validSnapshot)
    .with("stableAtRead",p.stable)
  action init = p' = {
    nativeVersion:0,nativeHeader:0,nativeHigh:PREFIX,nativeValid:true,
    stable:true,basisHeld:false,basisVersion:0,basisHeader:0,
    basisToken:1,basisPrefix:PREFIX,suppliedToken:1,suppliedPrefix:PREFIX,
    cursor:0,delivered:Set(),result:"none",materialized:0,
    freshAtRead:false,validAtRead:false,stableAtRead:false,poisoned:false
  }
  action readiness = p' = if(p.poisoned) p.with("result","refused")
    else if(not(p.nativeValid)) p.with("poisoned",true).with("basisHeld",false).with("result","refused")
    else capturedBasis.with("result","ready").with("materialized",p.nativeHigh)
  action page = p' = if(p.poisoned) p.with("result","refused")
    else if(reusable) emitted("fast",minimum(remaining,LIMIT+1))
    else if(validSnapshot) emitted("full",p.nativeHigh)
      .with("basisHeld",p.stable).with("basisVersion",p.nativeVersion)
      .with("basisHeader",p.nativeHeader).with("basisToken",p.suppliedToken)
      .with("basisPrefix",p.suppliedPrefix)
    else p.with("result","refused").with("basisHeld",false)
      .with("poisoned",not(p.nativeValid))
  // Otherwise-identical fast-path mutant removes only the version guard.
  action unsafeSkipVersion = p' = if(p.poisoned) p.with("result","refused")
    else if(reusableExceptVersion) emitted("fast",minimum(remaining,LIMIT+1))
    else p.with("result","refused")
  action ownAppend = p' = p.with("nativeHigh",p.nativeHigh+1)
    .with("nativeHeader",p.nativeHeader+1).with("basisHeld",false)
  action foreignAppend = p' = p.with("nativeHigh",p.nativeHigh+1)
    .with("nativeHeader",p.nativeHeader+1).with("nativeVersion",p.nativeVersion+1)
  action foreignCorruptOffPage = p' = p.with("nativeValid",false)
    .with("nativeVersion",p.nativeVersion+1)
  action forgeToken = p' = p.with("suppliedToken",2)
  action truncateNativePrefix = p' = p.with("nativeHigh",PREFIX-1)
    .with("nativeHeader",p.nativeHeader+1).with("nativeVersion",p.nativeVersion+1)
  action unstableBracket = p' = p.with("stable",false)
  action stableBracket = p' = p.with("stable",true)
  action check(condition:bool):bool = all { condition, p' = p }

  run pageReuseHealthyBoundTest = init.then(readiness).then(page)
    .expect(pageSafety and p.result == "fast" and p.materialized == 2)
  run pageReuseOwnAppendPrefixFallbackTest = init.then(readiness).then(ownAppend).then(page)
    .expect(pageSafety and p.result == "full" and p.materialized == 4 and p.suppliedPrefix == 3)
    .then(page).expect(pageSafety and p.result == "fast" and p.materialized == 2 and p.cursor == 2)
  run pageReuseForeignAppendPrefixFallbackTest = init.then(readiness).then(foreignAppend).then(page)
    .expect(pageSafety and p.result == "full" and p.materialized == 4 and p.suppliedPrefix == 3)
    .then(page).expect(pageSafety and p.result == "fast" and p.materialized == 2)
  run pageReuseForeignCorruptionRefusalTest = init.then(readiness).then(foreignCorruptOffPage).then(page)
    .expect(pageSafety and p.result == "refused" and p.poisoned and p.delivered.size() == 0)
    .then(page).expect(pageSafety and p.result == "refused" and p.poisoned)
  run pageReuseForgedTokenRefusalTest = init.then(readiness).then(forgeToken).then(page)
    .expect(pageSafety and p.result == "refused" and p.delivered.size() == 0)
  run pageReuseUnstableFullFallbackTest = init.then(readiness).then(unstableBracket).then(page)
    .expect(pageSafety and p.result == "full" and not(p.basisHeld))
    .then(stableBracket).then(page).expect(pageSafety and p.result == "full" and p.basisHeld)
    .then(page).expect(pageSafety and p.result == "fast")
  run pageReuseVersionGuardRuleKilledTest = init.then(readiness).then(foreignCorruptOffPage)
    .then(check(reusableExceptVersion and not(reusable) and pageSafety))
    .then(unsafeSkipVersion).expect(not(pageSafety) and p.result == "fast")
  run pageReuseStaleHighWatermarkRefusalTest = init.then(readiness).then(truncateNativePrefix).then(page)
    .expect(pageSafety and p.result == "refused" and p.delivered.size() == 0)
  run pageReuseFiniteAvailableProgressTest = init.then(readiness)
    .then(check(remaining == 3 and pageSafety)).then(page)
    .then(check(remaining == 2 and pageSafety)).then(page)
    .then(check(remaining == 1 and pageSafety)).then(page)
    .expect(remaining == 0 and pageSafety and p.delivered == PREFIX_ROWS and p.materialized == 1)
}

module browserJournalHeldPage {
  // Narrow adjunct: an existing native held readonly transaction excludes
  // every native write to the journal stores and supplies one immutable image.
  // This native scheduling premise is checked separately in real IDB, not
  // proved by integer transaction IDs. Schema version is NOT a data version.
  // Token identity abstracts the unchanged canonical full-prefix commitment.
  type State = {
    live:bool, transaction:int, basis:int, basisHeld:bool, nativeValid:bool,
    pendingCorruption:bool, high:int, prefix:int, token:int, basisToken:int,
    cursor:int, delivered:Set[int], result:str, materialized:int,
    capturedLive:bool, capturedIdentity:bool, capturedValid:bool, poisoned:bool
  }
  var b:State
  pure val PREFIX = 3
  pure val LIMIT = 1
  val exactToken = b.token == 1 and b.prefix == PREFIX
  val basisMatches = b.basisHeld and b.basisToken == b.token and exactToken
  val reusable = b.live and b.transaction == b.basis and basisMatches
  val validSnapshot = b.nativeValid and exactToken and b.prefix <= b.high
  val remaining = PREFIX - b.cursor
  val pageSafe = b.cursor >= 0 and b.cursor <= PREFIX and
    b.delivered.subseteq(Set(0,1,2)) and
    (b.result == "fast").implies(b.capturedLive and b.capturedIdentity and
      b.capturedValid and b.materialized <= LIMIT+1) and
    b.poisoned.implies(b.result != "fast" and b.result != "full")
  pure def minimum(a:int,c:int):int = if(a < c) a else c
  def emitted(mode:str,count:int):State = b
    .with("cursor",minimum(PREFIX,b.cursor+LIMIT))
    .with("delivered",if(b.cursor < PREFIX) b.delivered.union(Set(b.cursor)) else b.delivered)
    .with("result",mode).with("materialized",count)
    .with("capturedLive",b.live).with("capturedIdentity",b.transaction == b.basis)
    .with("capturedValid",validSnapshot)
  action init = b' = {live:false,transaction:0,basis:0,basisHeld:false,
    nativeValid:true,pendingCorruption:false,high:PREFIX,prefix:PREFIX,
    token:1,basisToken:1,cursor:0,delivered:Set(),result:"none",materialized:0,
    capturedLive:false,capturedIdentity:false,capturedValid:false,poisoned:false}
  action acquire = b' = if(not(b.live)) b.with("live",true).with("transaction",b.transaction+1) else b
  // Selected release-and-join macro includes awaiting the already queued
  // foreign write's native terminal, as the native fixture does. It is not a
  // claim that reservation.release itself waits for foreign transactions.
  action release = b' = b.with("live",false)
    .with("nativeValid",b.nativeValid and not(b.pendingCorruption)).with("pendingCorruption",false)
  action foreignCorrupt = b' = if(b.live) b.with("pendingCorruption",true)
    else b.with("nativeValid",false)
  action readiness = b' = if(b.poisoned or not(b.nativeValid))
    b.with("poisoned",true).with("result","refused")
    else b.with("basisHeld",b.live).with("basis",b.transaction)
      .with("basisToken",b.token).with("materialized",b.high).with("result","ready")
  action page = b' = if(b.poisoned) b.with("result","refused")
    else if(reusable) emitted("fast",minimum(remaining,LIMIT+1))
    else if(validSnapshot) emitted("full",b.high).with("basisHeld",b.live)
      .with("basis",b.transaction).with("basisToken",b.token)
    else b.with("result","refused").with("poisoned",not(b.nativeValid))
  action ownAppend = b' = if(not(b.live)) b.with("high",b.high+1) else b
  action forgeToken = b' = b.with("token",2)
  // Otherwise-enabled causal mutants remove ONE exact native-view guard.
  action unsafeSkipIdentity = b' = if(not(b.poisoned) and b.live and basisMatches)
    emitted("fast",minimum(remaining,LIMIT+1)) else b.with("result","refused")
  action unsafeSkipLive = b' = if(not(b.poisoned) and b.transaction == b.basis and basisMatches)
    emitted("fast",minimum(remaining,LIMIT+1)) else b.with("result","refused")
  action check(condition:bool):bool = all { condition, b' = b }

  run browserPageHeldBoundTest = init.then(acquire).then(readiness).then(page)
    .expect(pageSafe and b.result == "fast" and b.materialized == 2)
  run browserPageForeignWriteExcludedTest = init.then(acquire).then(readiness).then(foreignCorrupt)
    .then(check(b.pendingCorruption and b.nativeValid)).then(page)
    .expect(pageSafe and b.result == "fast" and b.materialized == 2)
  run browserPageReleasedPoisonFullTest = init.then(acquire).then(readiness).then(foreignCorrupt)
    .then(release).then(page).expect(pageSafe and b.poisoned and b.result == "refused")
  run browserPageNewTransactionFullTest = init.then(acquire).then(readiness).then(release)
    .then(acquire).then(page).expect(pageSafe and b.result == "full" and b.materialized == 3)
    .then(page).expect(pageSafe and b.result == "fast" and b.materialized == 2)
  run browserPageRestoredPrefixFullTest = init.then(acquire).then(readiness).then(release)
    .then(ownAppend).then(acquire).then(page)
    .expect(pageSafe and b.result == "full" and b.materialized == 4 and b.prefix == 3)
  run browserPageIdentityGuardKilledTest = init.then(acquire).then(readiness).then(release)
    .then(foreignCorrupt).then(acquire).then(check(pageSafe and basisMatches and not(reusable)))
    .then(unsafeSkipIdentity).expect(not(pageSafe) and b.result == "fast")
  run browserPageLiveGuardKilledTest = init.then(acquire).then(readiness).then(release)
    .then(foreignCorrupt).then(check(pageSafe and basisMatches and not(reusable)))
    .then(unsafeSkipLive).expect(not(pageSafe) and b.result == "fast")
  run browserPageForgedTokenFullTest = init.then(acquire).then(readiness).then(forgeToken)
    .then(page).expect(pageSafe and b.result == "refused" and b.delivered.size() == 0)
  // Finite available three-row witness, not scheduler fairness or induction.
  run browserPageConditionalProgressTest = init.then(acquire).then(readiness)
    .then(check(remaining == 3 and pageSafe)).then(page)
    .then(check(remaining == 2 and pageSafe)).then(page)
    .then(check(remaining == 1 and pageSafe)).then(page)
    .expect(pageSafe and remaining == 0 and b.delivered == Set(0,1,2))
}
module hostFloorParticipant {
  // Mechanical IndexedDB participant only. The original source owner supplies
  // authenticated eligibility/decision commitments. IDB strict atomicity,
  // canonical validation, native exclusion and joined promises are premises;
  // same-origin storage does not prevent whole-origin rollback.
  // Atomic reserve/capture is split from revocation, admitted completion,
  // joined release and whole-image CAS, exposing the foreign-write gap.
  type State = { head:int, pending:bool, incarnation:int, revision:int, pin:int,
    capturedHead:int, capturedPending:bool, capturedIncarnation:int,
    capturedRevision:int, capturedPin:int, captured:bool, held:bool,
    admitted:int, joined:bool, consumed:bool, active:bool, completed:int,
    decision:int, proof:int, refused:bool, lost:bool, writes:int, writeCurrent:bool }
  var h:State
  val imageCurrent = h.captured and h.head == h.capturedHead and
    h.pending == h.capturedPending and h.incarnation == h.capturedIncarnation and
    h.revision == h.capturedRevision and h.pin == h.capturedPin
  val ready = imageCurrent and h.joined and not(h.held) and h.admitted == 0 and not(h.consumed)
  val floorsUnchanged = h.head >= 3 and h.completed < h.head
  val releaseAfterJoin = h.joined.implies(not(h.held) and h.admitted == 0)
  val nativeCasSafety = h.writeCurrent
  val safety = floorsUnchanged and releaseAfterJoin and nativeCasSafety
  action init = h' = {head:3,pending:false,incarnation:0,revision:0,pin:0,
    capturedHead:3,capturedPending:false,capturedIncarnation:0,
    capturedRevision:0,capturedPin:0,captured:false,held:false,admitted:0,
    joined:false,consumed:false,active:false,completed:-1,decision:0,proof:0,
    refused:false,lost:false,writes:0,writeCurrent:true}
  action capture = h' = if(not(h.held) and h.admitted == 0 and h.pin == 0)
    h.with("captured",true).with("held",true).with("joined",false).with("consumed",false)
      .with("capturedHead",h.head).with("capturedPending",h.pending)
      .with("capturedIncarnation",h.incarnation).with("capturedRevision",h.revision)
      .with("capturedPin",h.pin) else h.with("refused",true)
  action admit = h' = if(h.held and h.admitted == 0) h.with("admitted",1)
    else h.with("refused",true)
  action revoke = h' = h.with("held",false)
  action readComplete = h' = if(h.admitted == 1) h.with("admitted",0) else h
  action join = h' = if(not(h.held) and h.admitted == 0) h.with("joined",true)
    else h.with("refused",true)
  action foreignBegin = h' = if(not(h.held) and h.admitted == 0 and not(h.active) and not(h.pending))
    h.with("pending",true).with("revision",h.revision+1) else h.with("refused",true)
  action foreignIncarnation = h' = if(not(h.held) and h.admitted == 0 and h.incarnation == 0)
    h.with("incarnation",1) else h.with("refused",true)
  action prepare = h' = if(ready and not(h.active) and h.pin == 0)
    h.with("active",true).with("decision",1).with("proof",1).with("consumed",true)
      .with("revision",h.revision+1).with("writes",h.writes+1)
    else h.with("consumed",true).with("refused",true)
  action commit(proof:int):bool = h' = if(ready and h.active and proof == h.proof)
    h.with("active",false).with("completed",0).with("consumed",true)
      .with("revision",h.revision+1).with("writes",h.writes+1)
    else h.with("consumed",true).with("refused",true)
  action abort = h' = if(ready and h.active)
    h.with("active",false).with("consumed",true).with("revision",h.revision+1)
    else h.with("consumed",true).with("refused",true)
  action loseAck = h' = h.with("lost",true)
  action readback = h' = if(h.active and h.captured and h.held) h.with("lost",false) else h
  action futureCommit = h' = if(not(h.held) and h.admitted == 0 and h.pending and not(h.active) and h.head == 3)
    h.with("head",4).with("pending",false).with("revision",h.revision+1)
    else h.with("refused",true)
  action unsafePrepareWithoutImageCas = h' = h.with("active",true).with("writes",1).with("writeCurrent",imageCurrent)
  action unsafeJoinBeforeAdmittedCompletion = h' = h.with("joined",true)
  action step = any {capture,admit,revoke,readComplete,join,foreignBegin,
    foreignIncarnation,prepare,commit(1),commit(2),abort,loseAck,readback,futureCommit}
  run hostFloorHealthyReachabilityTest = init.then(capture).then(revoke).then(join).then(prepare)
    .then(capture).then(revoke).then(join).then(commit(1))
    .then(foreignBegin).then(futureCommit).expect(safety and h.head == 4 and h.completed == 0 and h.revision == 4)
  run hostFloorHeldExclusionTest = init.then(capture).then(foreignBegin)
    .expect(safety and h.refused and not(h.pending) and imageCurrent)
  run hostFloorQueuedForeignRefusesTest = init.then(capture).then(revoke).then(join)
    .then(foreignBegin).then(prepare).expect(safety and h.refused and not(h.active) and h.writes == 0)
  run hostFloorForeignIncarnationRefusesTest = init.then(capture).then(revoke).then(join)
    .then(foreignIncarnation).then(prepare).expect(safety and h.refused and h.writes == 0)
  run hostFloorFreshIncarnationIsNotVacuouslyBlockedTest = init.then(capture).then(revoke).then(join)
    .then(foreignIncarnation).then(prepare).then(capture).then(revoke).then(join).then(prepare)
    .expect(safety and h.active and h.incarnation == 1 and h.writes == 1)
  run hostFloorAdmittedJoinTest = init.then(capture).then(admit).then(revoke).then(admit).then(join)
    .expect(safety and h.refused and not(h.joined)).then(readComplete).then(join).then(prepare)
    .expect(safety and h.active and h.joined)
  run hostFloorLostAckResumeTest = init.then(capture).then(revoke).then(join).then(prepare).then(loseAck)
    .then(capture).then(readback).then(revoke).then(join).then(commit(2))
    .expect(safety and h.refused and h.active).then(capture).then(revoke).then(join).then(commit(1))
    .expect(safety and not(h.active) and h.completed == 0 and not(h.lost))
  run hostFloorBrokenCasRejectedTest = init.then(capture).then(revoke).then(join)
    .then(foreignIncarnation).then(unsafePrepareWithoutImageCas).expect(not(safety))
  run hostFloorBrokenJoinRejectedTest = init.then(capture).then(admit).then(revoke)
    .then(unsafeJoinBeforeAdmittedCompletion).expect(not(safety))
}

module journalNativeFenceParticipant {
  // Mechanical native participant only. Neither these digests nor commitLocal
  // establish the protocol union decision or all-participant commit.
  type Native = {revision:int,image:int,capturedRevision:int,capturedImage:int,
    incarnation:int,capturedIncarnation:int,sequence:int,active:bool,frontier:int,
    prepared:int,holes:Set[int],preparedHoles:Set[int],dead:Set[int],used:bool,
    refused:bool,badWrite:bool,badResurrection:bool,observed:bool}
  var n:Native
  pure val METHODS = Set("installGenesis","installEpochAnchor","appendAccepted","importHistoricalAnchor")
  val sameImage = n.revision == n.capturedRevision and n.image == n.capturedImage and n.incarnation == n.capturedIncarnation
  def allows(scope:int):bool = (scope > n.frontier or n.holes.contains(scope)) and
    (not(n.active) or scope > n.prepared or n.preparedHoles.contains(scope))
  val safety = not(n.badWrite or n.badResurrection) and n.dead.intersect(n.holes) == Set() and
    n.frontier >= -1 and n.revision >= 0 and n.sequence >= 0
  action init = n' = {revision:0,image:0,capturedRevision:0,capturedImage:0,
    incarnation:1,capturedIncarnation:1,sequence:0,active:false,frontier:-1,
    prepared:-1,holes:Set(),preparedHoles:Set(),dead:Set(),used:false,
    refused:false,badWrite:false,badResurrection:false,observed:false}
  action refuse = n' = n.with("refused",true)
  action capture = n' = n.with("capturedRevision",n.revision).with("capturedImage",n.image)
    .with("capturedIncarnation",n.incarnation).with("used",false).with("refused",false)
  action foreignOriginalWrite = n' = n.with("image",n.image+1)
  action foreignControlWrite = n' = n.with("revision",n.revision+1)
  action replaceIncarnation = n' = n.with("incarnation",n.incarnation+1)
  def legalPreparation(frontier:int,holes:Set[int]):bool = not(n.active) and
    frontier >= n.frontier and frontier <= 4 and holes.forall(s => s >= 0 and s <= frontier) and
    holes.filter(s => s <= n.frontier).subseteq(n.holes)
  action prepare(frontier:int,holes:Set[int]):bool =
    if(n.used or not(legalPreparation(frontier,holes))) refuse
    else if(not(sameImage)) n' = n.with("used",true).with("refused",true)
    else n' = n.with("used",true).with("active",true).with("prepared",frontier)
      .with("preparedHoles",holes).with("revision",n.revision+1).with("sequence",n.sequence+1)
  action busyAttempt = if(n.used) refuse else n' = n.with("used",true).with("refused",true)
  action abortLocal = if(n.used) refuse else if(not(sameImage) or not(n.active))
    n' = n.with("used",true).with("refused",true)
    else n' = n.with("used",true).with("active",false).with("revision",n.revision+1)
  pure def committed(x:Native):Native = {
    val lost = (0.to(x.prepared)).exclude(x.preparedHoles)
    x.with("used",true).with("active",false).with("frontier",x.prepared)
      .with("holes",x.preparedHoles).with("dead",x.dead.union(lost)).with("revision",x.revision+1)
      .with("badResurrection",x.badResurrection or x.dead.intersect(x.preparedHoles) != Set())
  }
  action commitLocal = if(not(n.used) and sameImage and n.active) n' = committed(n) else refuse
  action readback = n' = n.with("observed",true)
  action mutate(method:str,scope:int):bool = if(METHODS.contains(method) and allows(scope))
    n' = n.with("revision",n.revision+1).with("image",n.image+1) else refuse
  action missingFenceMutant = n' = n.with("image",n.image+1).with("badWrite",n.badWrite or not(allows(0)))
  action staleAbortMutant = n' = n.with("active",false).with("badWrite",n.badWrite or not(sameImage))
  action restoreHoleMutant = n' = n.with("holes",n.holes.union(Set(0))).with("badResurrection",n.dead.contains(0))

  run journalNativeRowCurrencyTest = init.then(capture).then(foreignOriginalWrite)
    .then(prepare(0,Set())).then(all { assert(n.used and n.refused and not(n.active)), assert(safety), n'=n })
  run journalNativeControlCurrencyTest = init.then(capture).then(foreignControlWrite)
    .then(prepare(0,Set())).then(all { assert(n.used and n.refused and not(n.active)), assert(safety), n'=n })
  run journalNativeIncarnationTest = init.then(capture).then(replaceIncarnation)
    .then(prepare(0,Set())).then(all { assert(n.refused and not(n.active)), assert(safety), n'=n })
  run journalNativeFourMutatorsTest = init.then(prepare(0,Set()))
    .then(mutate("installGenesis",0)).then(mutate("installEpochAnchor",0))
    .then(mutate("appendAccepted",0)).then(mutate("importHistoricalAnchor",0))
    .then(all { assert(n.image==0 and n.refused), assert(safety), n'=n })
  run journalNativeFutureScopeTest = init.then(prepare(0,Set())).then(mutate("appendAccepted",1))
    .then(all { assert(n.image==1), assert(safety), n'=n })
  run journalNativeProtectedHoleTest = init.then(prepare(1,Set(1))).then(capture).then(commitLocal)
    .then(mutate("appendAccepted",1)).then(mutate("appendAccepted",0))
    .then(all { assert(n.image==1 and n.dead==Set(0)), assert(safety), n'=n })
  run journalNativeHoleDropPermanentTest = init.then(prepare(1,Set(1))).then(capture).then(commitLocal)
    .then(capture).then(prepare(2,Set())).then(capture).then(commitLocal)
    .then(capture).then(prepare(3,Set(1)))
    .then(all { assert(n.refused and n.frontier==2 and n.holes==Set()), assert(safety), n'=n })
  run journalNativeBusyConsumedTest = init.then(busyAttempt).then(prepare(0,Set()))
    .then(all { assert(n.used and not(n.active)), assert(safety), n'=n })
  run journalNativeIllegalNonconsumeTest = init.then(prepare(-2,Set())).then(prepare(0,Set()))
    .then(all { assert(n.active and n.used), assert(safety), n'=n })
  run journalNativeStaleAbortTest = init.then(prepare(0,Set())).then(capture).then(foreignOriginalWrite)
    .then(abortLocal).then(all { assert(n.active and n.refused), assert(safety), n'=n })
  run journalNativeCommittedReadbackTest = init.then(prepare(0,Set())).then(capture).then(commitLocal)
    .then(readback).then(mutate("appendAccepted",1))
    .then(all { assert(n.observed and n.frontier==0 and n.image==1), assert(safety), n'=n })
  run journalNativeMissingFenceKilledTest = init.then(prepare(0,Set())).then(missingFenceMutant)
    .then(all { assert(not(safety)), n'=n })
  run journalNativeStaleAbortKilledTest = init.then(prepare(0,Set())).then(capture).then(foreignOriginalWrite)
    .then(staleAbortMutant).then(all { assert(not(safety)), n'=n })
  run journalNativeHoleRestorationKilledTest = init.then(prepare(1,Set())).then(capture).then(commitLocal)
    .then(restoreHoleMutant).then(all { assert(not(safety)), n'=n })
}

module snapshotNativeFenceParticipant {
  // Mechanical source image/frontier. Authentication, hashing, native atomicity
  // and original dependency admission are premises, not proved here.
  var s: { revision:int,image:int,incarnation:int,capturedRevision:int,capturedImage:int,
    capturedIncarnation:int,used:bool,held:bool,admitted:int,joined:bool,active:bool,
    frontier:int,prepared:int,hole:bool,preparedHole:bool,holeInc:int,sequence:int,
    refused:bool,badWrite:bool,badDelivery:bool,badJoin:bool }
  val current = s.revision==s.capturedRevision and s.image==s.capturedImage and s.incarnation==s.capturedIncarnation
  def allowed(epoch:int,inc:int):bool = (epoch>s.frontier or (s.hole and epoch==1 and inc==s.holeInc)) and
    (not(s.active) or epoch>s.prepared or (s.preparedHole and epoch==1 and inc==s.holeInc))
  val safety = not(s.badWrite or s.badDelivery or s.badJoin) and s.frontier>= -1 and s.sequence>=0
  action init = s' = {revision:0,image:0,incarnation:1,capturedRevision:0,capturedImage:0,capturedIncarnation:1,
    used:false,held:false,admitted:0,joined:true,active:false,frontier:-1,prepared:-1,hole:false,preparedHole:false,
    holeInc:1,sequence:0,refused:false,badWrite:false,badDelivery:false,badJoin:false}
  action capture = s' = s.with("capturedRevision",s.revision).with("capturedImage",s.image)
    .with("capturedIncarnation",s.incarnation).with("used",false).with("held",true).with("joined",false)
  action admit = s' = if(s.held and not(s.used)) s.with("admitted",s.admitted+1) else s.with("refused",true)
  action revoke = s' = s.with("held",false)
  action complete = s' = s.with("admitted",if(s.admitted>0) s.admitted-1 else 0)
  action join = s' = if(not(s.held) and s.admitted==0) s.with("joined",true) else s.with("refused",true)
  action foreignImage = s' = if(not(s.held)) s.with("image",s.image+1) else s.with("refused",true)
  action replaceControl = s' = if(not(s.held)) s.with("incarnation",s.incarnation+1) else s.with("refused",true)
  action prepare(epoch:int,hole:bool):bool = s' = if(not(s.used) and s.joined and current and not(s.active) and
    epoch>=s.frontier and (not(hole) or s.frontier<1 or s.hole))
    s.with("used",true).with("active",true).with("prepared",epoch).with("preparedHole",hole)
      .with("revision",s.revision+1).with("sequence",s.sequence+1)
    else s.with("used",true).with("refused",true)
  action commit = s' = if(not(s.used) and s.joined and current and s.active)
    s.with("used",true).with("active",false).with("frontier",s.prepared).with("hole",s.preparedHole).with("revision",s.revision+1)
    else s.with("used",true).with("refused",true)
  action abort = s' = if(not(s.used) and s.joined and current and s.active)
    s.with("used",true).with("active",false).with("revision",s.revision+1) else s.with("used",true).with("refused",true)
  action write(epoch:int,inc:int):bool = s' = if(allowed(epoch,inc)) s.with("image",s.image+1) else s.with("refused",true)
  action unsafeOldIncarnation = s' = s.with("badWrite",not(allowed(1,2)))
  action unsafeMissingImageCas = s' = s.with("active",true).with("badDelivery",not(current))
  action unsafeJoin = s' = s.with("joined",true).with("badJoin",s.admitted>0)
  def protected(epoch:int,inc:int):bool = epoch==1 and inc==s.holeInc and (s.hole or (s.active and s.preparedHole))
  action delete(epoch:int,inc:int):bool = s' = if(allowed(epoch,inc) and not(protected(epoch,inc))) s.with("image",s.image+1) else s.with("refused",true)
  action unsafeProtectedDelete = s' = s.with("badWrite",protected(1,1))
  run snapshotProtectedDeleteRefusesTest = init.then(prepare(2,true)).then(delete(1,1)).expect(safety and s.image==0 and s.refused)
  run snapshotProtectedDeleteMutantTest = init.then(prepare(2,true)).then(unsafeProtectedDelete).expect(not(safety))
  run snapshotNativeHealthyTest = init.then(capture).then(revoke).then(join).then(prepare(2,true))
    .then(capture).then(revoke).then(join).then(commit).then(write(1,1)).then(write(3,2)).expect(safety and s.frontier==2 and s.image==2)
  run snapshotNativeJoinedAdmissionTest = init.then(capture).then(admit).then(revoke).then(admit).then(join)
    .expect(safety and not(s.joined)).then(complete).then(join).then(prepare(2,false)).expect(safety and s.active)
  run snapshotNativeForeignImageTest = init.then(capture).then(revoke).then(join).then(foreignImage).then(prepare(2,false)).expect(safety and not(s.active) and s.used)
  run snapshotNativeIncarnationTest = init.then(capture).then(revoke).then(join).then(replaceControl).then(prepare(2,false)).expect(safety and not(s.active))
  run snapshotNativeStaleAbortTest = init.then(prepare(2,false)).then(capture).then(revoke).then(join).then(foreignImage).then(abort).expect(safety and s.active)
  run snapshotNativeHolePermanentTest = init.then(prepare(2,true)).then(capture).then(revoke).then(join).then(commit)
    .then(capture).then(revoke).then(join).then(prepare(3,false)).then(capture).then(revoke).then(join).then(commit)
    .then(capture).then(revoke).then(join).then(prepare(4,true)).expect(safety and not(s.active) and not(s.hole))
  run snapshotNativeIncarnationMutantTest = init.then(prepare(2,true)).then(unsafeOldIncarnation).expect(not(safety))
  run snapshotNativeCasMutantTest = init.then(capture).then(revoke).then(join).then(foreignImage).then(unsafeMissingImageCas).expect(not(safety))
  run snapshotNativeJoinMutantTest = init.then(capture).then(admit).then(revoke).then(unsafeJoin).expect(not(safety))
}

module aheFutureNomination {
  // Authentication, native atomicity and hash identity are premises. This
  // adjunct checks selected local boundaries, not complete graph eligibility.
  type State = {legacy:bool, active:bool, bound:bool, completed:bool, floor:int,
    image:int, captured:int, nominated:bool, authenticated:bool, epoch:int,
    published:bool, used:bool, refused:bool, recordDigest:int, protectedIdentity:int, stagedId:int, intentId:int, publishedId:int}
  var s:State
  val safety = s.floor == 0 and (s.active.implies(not(s.nominated))) and
    (s.nominated or s.published).implies(s.authenticated and s.epoch > s.floor and s.completed) and s.protectedIdentity == 0 and s.published.implies(s.publishedId == s.stagedId)
  action init = s' = {legacy:false,active:false,bound:false,completed:false,floor:0,
    image:0,captured:0,nominated:false,authenticated:false,epoch:0,published:false,used:false,refused:false,recordDigest:0,protectedIdentity:0,stagedId:0,intentId:0,publishedId:-1}
  action legacyPrepare = s' = s.with("legacy",true).with("active",true)
  action prepareBound = s' = s.with("active",true).with("bound",true)
  action commit = s' = if(s.active and s.bound and not(s.legacy) and s.image == s.captured)
    s.with("active",false).with("completed",true) else s.with("refused",true)
  action foreignImage = s' = s.with("image",s.image+1)
  action recapture = s' = s.with("captured",s.image).with("used",false)
  action stage(auth:bool,e:int):bool = s' = if(s.completed and not(s.active) and
    not(s.nominated) and not(s.used) and s.image == s.captured and auth and e > s.floor)
    s.with("nominated",true).with("authenticated",auth).with("epoch",e).with("used",true).with("stagedId",s.intentId)
    else s.with("refused",true).with("used",true)
  action ordinaryWrite = s' = if(s.active or s.completed) s.with("refused",true) else s
  action publish = s' = if(s.nominated and s.image == s.captured and not(s.used) and s.intentId == s.stagedId)
    s.with("nominated",false).with("published",true).with("publishedId",s.intentId).with("used",true) else s.with("refused",true)
  action unsafeRawEpoch = s' = s.with("nominated",true).with("epoch",1).with("authenticated",false)
  action legalLifecycle = s' = s.with("recordDigest",s.recordDigest+1)
  action unsafeIdentityChange = s' = s.with("protectedIdentity",1)
  action freshIntent = s' = s.with("intentId",s.intentId+1)
  action resume(verified:bool):bool = s' = if(s.nominated and verified and s.image == s.captured and not(s.used))
    s.with("intentId",s.stagedId).with("used",true) else s.with("refused",true)
  action unsafeNomineeRebind = s' = s.with("authenticated",false).with("used",true)
  // Durable published identity is not the next intent's verification bookkeeping.
  action unsafePublishedIdentity = s' = s.with("publishedId",s.publishedId+1)
  run freshGenuineNomineeResumeTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(freshIntent).then(recapture).then(resume(true)).then(recapture).then(publish).expect(s.published and s.intentId == s.stagedId and safety)
  run unauthenticatedNomineeResumeRefusesTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(freshIntent).then(recapture).then(resume(false)).expect(s.refused and s.intentId != s.stagedId and safety)
  run nomineeRebindMutantRejectedTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(unsafeNomineeRebind).expect(not(safety))
  run wrongNomineePublicationRefusesTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(freshIntent).then(recapture).then(publish).expect(s.refused and not(s.published) and safety)
  run protectedIdentitySurvivesLifecycleTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(recapture).then(publish).then(legalLifecycle).expect(s.recordDigest == 1 and safety)
  run changedProtectedIdentityMutantRejectedTest = init.then(prepareBound).then(commit).then(unsafeIdentityChange).expect(not(safety))
  run legacyCommitRefusesTest = init.then(legacyPrepare).then(commit).expect(s.refused and not(s.completed) and safety)
  run boundWholeImageRefusesTest = init.then(prepareBound).then(foreignImage).then(commit).expect(s.refused and s.active and safety)
  run completedOrdinaryFacadeRefusesTest = init.then(prepareBound).then(commit).then(ordinaryWrite).expect(s.refused and safety)
  run genuineFutureContinuationTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(recapture).then(publish).expect(s.published and not(s.nominated) and safety)
  run retiredEpochRefusesTest = init.then(prepareBound).then(commit).then(stage(true,0)).expect(s.refused and not(s.nominated) and safety)
  run oneUseFutureRefusesTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(publish).expect(s.refused and not(s.published) and safety)
  run rawEpochMutantRejectedTest = init.then(prepareBound).then(commit).then(unsafeRawEpoch).expect(not(safety))
  run freshIntentAfterPublishedPreservesIdentityTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(recapture).then(publish).then(freshIntent).expect(safety and s.published and s.intentId != s.stagedId)
  run changedPublishedIdentityMutantRejectedTest = init.then(prepareBound).then(commit).then(stage(true,1)).then(recapture).then(publish).then(unsafePublishedIdentity).expect(not(safety))
}
