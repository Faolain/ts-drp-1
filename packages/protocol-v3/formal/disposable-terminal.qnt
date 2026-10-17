module disposableTerminal {
  // Semantic differential of terminalDisposition and ownedContract. One
  // independently chosen slot of a finite two-slot profile is represented;
  // other slots are unchanged. Two incarnations bound these controls, NOT the
  // product policy. Real monotone safe-integer allocation is a native premise.
  pure val SLOTS = Set(0, 1)
  pure val ATOMS = Set(1, 2)
  pure val JOBS = Set(0, 1)
  type Backup = { inc:int, root:int, files:bool, mirror:bool, floor:int,
    head:int, protected:bool }
  type State = { slot:int, inc:int, account:str, accountKey:bool, root:int,
    floor:int, head:int, localInc:int, localRoot:int, localFloor:int,
    localHead:int, files:bool, mirror:bool, protected:bool,
    pending:bool, promised:bool, shared:bool, complete:bool,
    jobs:Set[int], settled:Set[int], alias:bool,
    capturedInc:int, capturedRoot:int, capturedFloor:int, capturedHead:int,
    prepared:bool, prepInc:int, prepRoot:int, prepFloor:int, prepHead:int,
    prepHandle:bool, abandoned:bool, floorReservation:bool, exclusion:bool,
    acknowledged:bool, terminalDigest:int, joined:bool, keyRetired:bool,
    partialDelete:bool, returned:bool, newGameplay:bool, refused:bool,
    backup:Backup, backedUp:bool, retiredThrough:int, badFloor:bool,
    badRelease:bool, badDelete:bool, clears:int, nonemptyEnded:bool }
  var x:State
  val current = x.account=="active" and x.accountKey and x.localInc==x.inc and
    x.root!=0 and x.localRoot==x.root and x.localFloor==x.floor and x.localHead==x.head
  val discharged = not(x.pending or x.promised or x.shared) and x.complete
  val exactPreparation = x.prepared and x.prepInc==x.inc and x.prepRoot==x.root and
    x.prepFloor==x.floor and x.prepHead==x.head
  // retiredThrough is a history monitor, NOT an extra protocol/database record.
  // The actual independent owner retains its monotone incarnation and status.
  val terminalSessionCannotReactivate = Set("active","retiring").contains(x.account)
    .implies(x.inc>x.retiredThrough)
  val noUnauthorizedEffects = not(x.badFloor or x.badRelease or x.badDelete)
  val boundedIdentityCatalog = SLOTS.contains(x.slot) and x.inc>=0 and x.inc<=2
  val protectedCompleteness = x.files.implies(x.protected or
    (x.account=="retiring" and x.acknowledged and discharged and x.joined))
  val joinedRelease = (not(x.accountKey) and x.account=="retiring").implies(
    x.joined and x.jobs==Set() and not(x.alias)) and
    x.partialDelete.implies(x.joined and x.keyRetired and x.acknowledged)
  val exactFence = x.acknowledged.implies(x.account=="retiring" and
    x.terminalDigest==x.inc and exactPreparation and discharged)
  val safety = noUnauthorizedEffects and terminalSessionCannotReactivate and boundedIdentityCatalog and protectedCompleteness and
    joinedRelease and exactFence and x.settled.subseteq(x.jobs) and
    (x.account=="free").implies(not(x.accountKey or x.acknowledged))
  // Existential targets, not universal eventuality or fair scheduler assumptions.
  val reachedFreshContinuation = x.inc==2 and current and x.newGameplay and x.nonemptyEnded
  val reachedAbandonedContinuation = current and x.clears>0 and x.returned
  action init = {
    nondet slot=SLOTS.oneOf()
    x'={slot:slot,inc:0,account:"free",accountKey:false,root:0,floor:0,head:0,
      localInc:0,localRoot:0,localFloor:0,localHead:0,files:false,mirror:false,
      protected:false,pending:false,promised:false,shared:false,complete:true,
      jobs:Set(),settled:Set(),alias:false,capturedInc:0,capturedRoot:0,
      capturedFloor:0,capturedHead:0,prepared:false,prepInc:0,prepRoot:0,
      prepFloor:0,prepHead:0,prepHandle:false,abandoned:false,
      floorReservation:false,exclusion:false,acknowledged:false,terminalDigest:0,
      joined:false,keyRetired:false,partialDelete:false,returned:false,
      newGameplay:false,refused:false,
      backup:{inc:0,root:0,files:false,mirror:false,floor:0,head:0,protected:false},
      backedUp:false,retiredThrough:0,badFloor:false,badRelease:false,
      badDelete:false,clears:0,nonemptyEnded:false}
  }
  // Independent owner never derives freshness from copied local metadata.
  action create = x'=if(x.account=="free" and x.inc<2 and not(x.files))
    x.with("account","active").with("inc",x.inc+1).with("accountKey",true)
      .with("localInc",x.inc+1).with("mirror",true).with("root",0)
      .with("localRoot",0).with("localFloor",0).with("localHead",0)
      .with("returned",false).with("newGameplay",false)
    else x.with("refused",true)
  // Exact authenticated root/ACL bytes + enrolled fresh key are PREMISES.
  // This relation is not crypto verification and a local selector is not authority.
  action bind(inc:int,root:int,acl:int):bool = x'=if(x.account=="active" and
    x.accountKey and inc==x.inc and root==inc and acl==root and x.root==0)
    x.with("root",root).with("localRoot",root) else x.with("refused",true)
  action declare = x'=if(current and not(x.prepared))
    x.with("files",true).with("protected",true) else x.with("refused",true)
  action obligations(p:bool,r:bool,s:bool,c:bool):bool = x'=if(current and
    x.files and not(x.prepared) and x.jobs==Set())
    x.with("pending",p).with("promised",r).with("shared",s).with("complete",c)
    else x.with("refused",true)
  // Existing lawful publication/settlement/shared owner, not creator abandonment.
  action lawfulDrain = x'=if(current and not(x.prepared) and x.jobs==Set())
    x.with("pending",false).with("promised",false).with("shared",false)
      .with("complete",true) else x.with("refused",true)
  action admit(id:int,inc:int,root:int):bool = x'=if(current and x.files and
    not(x.prepared) and JOBS.contains(id) and not(x.jobs.contains(id)) and
    inc==x.inc and root==x.root)
    x.with("jobs",x.jobs.union(Set(id))).with("capturedInc",x.inc)
      .with("capturedRoot",x.root).with("capturedFloor",x.floor).with("capturedHead",x.head)
    else x.with("refused",true)
  action settle(id:int):bool = x'=if(x.jobs.contains(id))
    x.with("settled",x.settled.union(Set(id))) else x.with("refused",true)
  action deliver(id:int,inc:int,root:int):bool = x'=if(current and
    x.settled.contains(id) and inc==x.inc and root==x.root and
    x.capturedInc==x.inc and x.capturedRoot==x.root and
    x.capturedFloor==x.floor and x.capturedHead==x.head)
    x.with("returned",true).with("newGameplay",x.inc==2) else x.with("refused",true)
  action release(id:int):bool = x'=if(x.settled.contains(id))
    x.with("jobs",x.jobs.exclude(Set(id))).with("settled",x.settled.exclude(Set(id)))
    else x.with("refused",true)
  action acquireAlias = x'=if(current and not(x.prepared))
    x.with("alias",true) else x.with("refused",true)
  action releaseAlias = x'=if(x.jobs==Set()) x.with("alias",false)
    else x.with("refused",true)
  action advance = x'=if(current and not(x.prepared) and x.jobs==Set() and x.floor<2)
    x.with("floor",x.floor+1).with("head",x.head+1)
      .with("localFloor",x.floor+1).with("localHead",x.head+1)
    else x.with("refused",true)
  // Full protected-planning/native observation is a premise. Current/rollback
  // bytes remain protected. Idle aliases may survive preflight; active native
  // reads/signing jobs must prevent acquisition of the original proof holds.
  action prepare = x'=if(current and x.files and discharged and x.jobs==Set() and
    not(x.prepared)) x.with("prepared",true).with("prepInc",x.inc)
      .with("prepRoot",x.root).with("prepFloor",x.floor).with("prepHead",x.head)
      .with("prepHandle",true).with("floorReservation",true).with("joined",false)
    else x.with("refused",true)
  // Necessary SQL-writer interleaving: native floor reservation is released
  // before independent transactional exact-image CAS. Other proof holds stay.
  action yieldFloor = x'=if(exactPreparation and x.account=="active" and x.prepHandle)
    x.with("floorReservation",false) else x.with("refused",true)
  action externalHeadChange = x'=if(x.account=="active" and not(x.floorReservation) and
    x.jobs==Set() and x.floor<2) x.with("floor",x.floor+1).with("head",x.head+1)
    else x.with("refused",true)
  action acknowledgeFence = x'=if(x.account=="active" and x.prepHandle and
    not(x.floorReservation) and exactPreparation and discharged)
    x.with("account","retiring").with("acknowledged",true).with("terminalDigest",x.inc)
    else x.with("refused",true)
  // Process death joins/releases THIS process's original OS reservations.
  // Independently owned alias custody survives until its own joined release.
  // SQL COMMIT is a checkpoint premise, NOT whole-workflow atomicity.
  action crash = x'=x.with("prepHandle",false).with("floorReservation",false)
    .with("abandoned",x.prepared).with("jobs",Set()).with("settled",Set())
  action takeOriginalExclusion = x'=if(x.prepared and not(x.prepHandle) and
    x.jobs==Set() and not(x.alias)) x.with("exclusion",true)
    else x.with("refused",true)
  // Exact local-frame CAS under original handle EXCLUSIVE plus account BEGIN
  // IMMEDIATE active/unfenced recheck. No live prep cancellation or fence undo.
  action clearAbandonedPreparation = x'=if(x.prepared and x.abandoned and
    x.exclusion and not(x.prepHandle) and x.account=="active" and
    not(x.acknowledged) and x.prepInc==x.inc and x.prepRoot==x.root)
    x.with("prepared",false).with("abandoned",false).with("exclusion",false)
      .with("clears",x.clears+1) else x.with("refused",true)
  action resumeExactIntent = x'=if(x.account=="retiring" and x.acknowledged and
    exactPreparation and discharged) x else x.with("refused",true)
  action joinCustody = x'=if(x.account=="retiring" and x.jobs==Set() and not(x.alias))
    x.with("joined",true).with("prepHandle",false).with("exclusion",true)
    else x.with("refused",true)
  action retireKey = x'=if(x.account=="retiring" and x.acknowledged and
    exactPreparation and discharged and x.joined and x.exclusion and
    x.jobs==Set() and not(x.alias)) x.with("accountKey",false).with("mirror",false)
      .with("keyRetired",true) else x.with("refused",true)
  action deleteBatch = x'=if(x.account=="retiring" and x.keyRetired and
    x.joined and x.exclusion and x.acknowledged) x.with("partialDelete",true)
    else x.with("refused",true)
  action completeCleanup = x'=if(x.partialDelete and x.joined and x.keyRetired and
    x.acknowledged and exactPreparation and discharged)
    x.with("account","free").with("root",0).with("floor",0).with("head",0)
      .with("localRoot",0).with("localFloor",0).with("localHead",0)
      .with("files",false).with("protected",false).with("prepared",false)
      .with("acknowledged",false).with("terminalDigest",0).with("partialDelete",false)
      .with("keyRetired",false).with("abandoned",false).with("exclusion",false)
      .with("nonemptyEnded",true).with("retiredThrough",x.inc) else x.with("refused",true)
  action backupLocal = x'=if(current and x.files) x.with("backedUp",true)
    .with("backup",{inc:x.localInc,root:x.localRoot,files:x.files,mirror:x.mirror,
      floor:x.localFloor,head:x.localHead,protected:x.protected}) else x
  action restoreLocal = x'=if(x.backedUp and x.jobs==Set() and not(x.prepared))
    x.with("localInc",x.backup.inc).with("localRoot",x.backup.root)
      .with("files",x.backup.files).with("mirror",x.backup.mirror)
      .with("localFloor",x.backup.floor).with("localHead",x.backup.head)
      .with("protected",x.backup.protected) else x.with("refused",true)
  action reopen(inc:int,root:int):bool = x'=if(current and not(x.prepared) and
    inc==x.inc and root==x.root) x else x.with("refused",true)
  action step = {
    nondet inc=ATOMS.oneOf(); nondet root=ATOMS.oneOf(); nondet acl=ATOMS.oneOf()
    nondet id=JOBS.oneOf(); nondet p=Set(false,true).oneOf()
    nondet r=Set(false,true).oneOf(); nondet s=Set(false,true).oneOf()
    nondet c=Set(false,true).oneOf()
    any {create,bind(inc,root,acl),declare,obligations(p,r,s,c),lawfulDrain,
      admit(id,inc,root),settle(id),deliver(id,inc,root),release(id),acquireAlias,
      releaseAlias,advance,prepare,yieldFloor,externalHeadChange,acknowledgeFence,
      crash,takeOriginalExclusion,clearAbandonedPreparation,resumeExactIntent,
      joinCustody,retireKey,deleteBatch,completeCleanup,backupLocal,restoreLocal,
      reopen(inc,root)}
  }
  // Deliberate mutants compute violated premises at the incorrect effect.
  action brokenRestoreAuthority = x'=if(x.backedUp and x.account=="free")
    x.with("account","active").with("accountKey",true).with("inc",x.backup.inc)
      .with("root",x.backup.root).with("floor",x.backup.floor).with("head",x.backup.head)
      .with("localInc",x.backup.inc).with("localRoot",x.backup.root)
      .with("localFloor",x.backup.floor).with("localHead",x.backup.head)
      .with("files",x.backup.files).with("protected",x.backup.protected)
      .with("mirror",x.backup.mirror) else x
  action brokenUndoFence = x'=if(x.acknowledged)
    x.with("account","active").with("prepared",false) else x
  action brokenEarlyRelease = x'=if(x.acknowledged and x.alias)
    x.with("accountKey",false).with("keyRetired",true) else x
  action brokenDeleteProtected = x'=if(x.files and not(discharged))
    x.with("files",false).with("protected",false).with("badDelete",true) else x
  run nonemptyContinuationTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(admit(0,1,1)).then(settle(0)).then(deliver(0,1,1)).then(release(0))
    .then(advance).then(prepare).then(yieldFloor).then(acknowledgeFence)
    .then(joinCustody).then(retireKey).then(deleteBatch).then(completeCleanup)
    .then(create).then(bind(2,2,2)).then(declare).then(admit(0,2,2))
    .then(settle(0)).then(deliver(0,2,2)).expect(safety and reachedFreshContinuation)
  run protectedDebtRefusalTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(obligations(true,true,true,false)).then(prepare).then(acknowledgeFence)
    .then(retireKey).then(deleteBatch).expect(safety and x.account=="active" and
      x.files and x.protected and x.accountKey and not(x.prepared))
    .then(lawfulDrain).then(prepare).expect(safety and x.prepared)
  run abandonedPreparationContinuationTest = init.then(create).then(bind(1,1,1))
    .then(declare).then(prepare).then(clearAbandonedPreparation)
    .expect(safety and x.prepared and x.prepHandle).then(crash)
    .then(clearAbandonedPreparation).expect(safety and x.prepared)
    .then(takeOriginalExclusion).then(clearAbandonedPreparation)
    .then(reopen(1,1)).then(declare).then(admit(0,1,1)).then(settle(0))
    .then(deliver(0,1,1)).expect(safety and reachedAbandonedContinuation)
  run staleFloorRefusalTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(prepare).then(externalHeadChange).expect(safety and x.floor==0)
    .then(yieldFloor).then(externalHeadChange).then(acknowledgeFence)
    .expect(safety and x.account=="active" and x.floor==1 and not(x.acknowledged))
  run joinedAliasTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(acquireAlias).then(admit(0,1,1)).then(prepare)
    .expect(safety and not(x.prepared)).then(settle(0)).then(release(0))
    .then(prepare).then(yieldFloor).then(acknowledgeFence).then(admit(1,1,1))
    .then(deliver(0,1,1)).then(joinCustody).then(retireKey).then(deleteBatch)
    .expect(safety and x.files and x.accountKey and not(x.joined))
    .then(releaseAlias).then(joinCustody).then(retireKey).then(deleteBatch)
    .then(completeCleanup).expect(safety and x.account=="free")
  run interruptedCleanupRetryTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(prepare).then(yieldFloor).then(acknowledgeFence).then(crash)
    .then(takeOriginalExclusion).then(clearAbandonedPreparation)
    .expect(safety and x.acknowledged and x.prepared).then(resumeExactIntent)
    .then(joinCustody).then(retireKey).then(crash).then(resumeExactIntent)
    .then(joinCustody).then(deleteBatch).then(crash).then(resumeExactIntent)
    .then(joinCustody).then(completeCleanup).expect(safety and x.account=="free")
  run survivingAliasCrashTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(acquireAlias).then(prepare).then(yieldFloor).then(acknowledgeFence)
    .then(crash).then(takeOriginalExclusion).then(joinCustody).then(retireKey)
    .expect(safety and x.alias and x.accountKey and x.files and not(x.joined))
    .then(releaseAlias).then(joinCustody).then(retireKey).then(deleteBatch)
    .then(completeCleanup).expect(safety and x.account=="free")
  run backupRefusalTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(backupLocal).then(prepare).then(yieldFloor).then(acknowledgeFence)
    .then(joinCustody).then(retireKey).then(deleteBatch).then(completeCleanup)
    .then(restoreLocal).then(reopen(1,1)).then(admit(0,1,1)).then(deliver(0,1,1))
    .expect(safety and x.account=="free" and not(x.accountKey) and x.jobs==Set() and
      x.inc==1 and not(x.returned))
  run alteredBindingTest = init.then(create).then(bind(1,1,2)).then(declare)
    .expect(safety and x.root==0 and not(x.files))
  run brokenBackupTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(backupLocal).then(prepare).then(yieldFloor).then(acknowledgeFence)
    .then(joinCustody).then(retireKey).then(deleteBatch).then(completeCleanup)
    .then(brokenRestoreAuthority).expect(not(safety))
  run brokenFenceTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(prepare).then(yieldFloor).then(acknowledgeFence).then(brokenUndoFence)
    .expect(not(safety))
  run brokenEarlyReleaseTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(acquireAlias).then(prepare).then(yieldFloor).then(acknowledgeFence)
    .then(brokenEarlyRelease).expect(not(safety))
  run brokenProtectedDeletionTest = init.then(create).then(bind(1,1,1)).then(declare)
    .then(obligations(true,false,false,true)).then(brokenDeleteProtected).expect(not(safety))
}
