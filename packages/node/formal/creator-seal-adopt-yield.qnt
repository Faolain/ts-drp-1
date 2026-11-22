module creatorSealAdoptYield {
  // The creator's seal and adoption with host boundaries between their native
  // spans, interleaved with every other room owner that can run in those turns.
  // Each seal or job action below is one synchronous span; any other enabled
  // action may run between two of them. Running without the boundaries is one
  // sub-sequence of these interleavings, so every property here holds for it too.
  //
  // Seal (creator-close.ts close()): new maintenance admission closes, admitted
  // jobs join and the sources are acquired, held across host turns of their
  // authentication walk; [A] their currency is rechecked and the close derived
  // from them; the membership write; [Y1] sources are reacquired and compared;
  // [Y2] currency is checked and the actor's evidence and prepare phases commit;
  // [P] the commit vote and commit QC; [P] the successor anchor (each [P] is a
  // boundary after a committed phase inside the seal actor's close); [Y3] the
  // trust advance; [Y4] the generation stage; [serve] the successor export.
  // Adoption's begin-to-projection span is one action.
  //
  // Every native owner of the creator handle (local and received issuance,
  // ordinary readiness, pool maintenance) is admitted through one job slot
  // (maintenanceJobs.size !== 0 refuses a second; refused ingress is retained,
  // modelled as the writer still owning the move). A job releases every
  // reservation for its detached preparation, [yield] qualifies by reacquiring
  // and comparing images, [yield] charges, and hands custody to its own write.
  //
  // Native exclusion: a read reservation blocks every write transaction on its
  // file for the synchronous busy timeout, so a write that starts while any
  // reservation is held is a lock failure. Each mutant step removes one guard.
  pure val WRITES = Set(1, 2)
  pure val NONE = 0
  pure val MAX_AUX = 2
  pure val SEALING = Set("acquired", "captured", "membership", "reacquired", "signing", "committed", "signed",
    "advanced", "staged", "served")

  type Image = { moves: Set[int], aux: int }
  type Mutants = {
    admitWhileClosing: bool, // ingress written into the epoch without the closing gate
    abortAfterQC: bool,      // stop abandons the close at Y3
    abortInsideSigning: bool, // stop reaches the actor at a [P] boundary instead of joining it
    noQualify: bool,         // a detached preparation is used without image comparison
    retainAtWrite: bool,     // a job keeps its reservation into its own write
    dropAcks: bool,          // refused ingress is acknowledged to the writer
    writerOutsideSlot: bool, // a native writer that bypasses the job slot
  }
  pure val SOUND: Mutants = { admitWhileClosing: false, abortAfterQC: false, abortInsideSigning: false,
    noQualify: false, retainAtWrite: false, dropAcks: false, writerOutsideSlot: false }

  var phase: str
  var held: bool            // seal sources' native read reservations
  var identity: Image       // epoch-0 image the sources were captured over
  var journal0: Set[int]
  var journal1: Set[int]
  var aux: int              // all other durable state on the same files
  var cut: Image            // the QC's sealed cut
  var qcs: int
  var stopReq: bool
  var lockConflict: bool
  var staleAdmit: bool
  var job: str              // idle | admitted | prepared | qualified | charged
  var jobId: int
  var jobEp: int
  var jobHeld: bool
  var jobImage: Image
  var writerEpoch: int
  var writerAccepted: Set[int]
  var writerAcked: Set[int]
  var inFlight: Set[(int, int)]
  var resettled: bool
  var revoked: bool
  var retried: bool

  def admitting(ep: int): bool = (ep == 0 and phase == "open") or (ep == 1 and phase == "adopted")
  def journalOf(ep: int): Set[int] = if (ep == 0) journal0 else journal1
  def imageOf(ep: int): Image = { moves: journalOf(ep), aux: aux }
  // What the successor carries: the sealed cut once signed, else the open epoch.
  def carried: Set[int] = if (qcs > 0) cut.moves.union(journal1) else journal0.union(journal1)

  // Safety.
  val sealedEpochFrozen = SEALING.contains(phase) implies imageOf(0) == identity
  val cutCurrent = (qcs > 0 and phase != "adopted") implies cut == imageOf(0)
  val singleSuccessor = qcs <= 1
  val noOrphanQC = phase == "aborted" implies qcs == 0
  val noLockConflict = not(lockConflict)
  val noStaleAdmit = not(staleAdmit)
  val noLostAcceptedWrite = writerAcked.forall(id => carried.contains(id))
  val safety = sealedEpochFrozen and cutCurrent and singleSuccessor and noOrphanQC and
    noLockConflict and noStaleAdmit and noLostAcceptedWrite

  // Witnesses (existential coverage, not claims).
  val reachedAdopted = phase == "adopted"
  val reachedAbortRetry = retried
  val reachedRevokedJob = revoked
  val reachedResettledWrite = resettled and journal1 != Set()
  val reachedStopAfterQC = stopReq and qcs > 0 and phase == "adopted"
  val reachedSealedWithJobWrite = qcs > 0 and cut.moves != Set()

  action init = all {
    phase' = "open", held' = false, identity' = { moves: Set(), aux: 0 }, journal0' = Set(),
    journal1' = Set(), aux' = 0, cut' = { moves: Set(), aux: 0 }, qcs' = 0, stopReq' = false,
    lockConflict' = false, staleAdmit' = false, job' = "idle", jobId' = NONE, jobEp' = 0,
    jobHeld' = false, jobImage' = { moves: Set(), aux: 0 }, writerEpoch' = 0, writerAccepted' = Set(),
    writerAcked' = Set(), inFlight' = Set(), resettled' = false, revoked' = false, retried' = false,
  }

  action keepSeal = all {
    phase' = phase, held' = held, identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
  }
  action keepJob = all {
    job' = job, jobId' = jobId, jobEp' = jobEp, jobHeld' = jobHeld, jobImage' = jobImage,
  }
  action keepWriter = all {
    writerEpoch' = writerEpoch, writerAccepted' = writerAccepted, writerAcked' = writerAcked,
    inFlight' = inFlight, resettled' = resettled,
  }
  action keepStore = all { journal0' = journal0, journal1' = journal1, aux' = aux }
  action keepFlags = all {
    lockConflict' = lockConflict, staleAdmit' = staleAdmit, revoked' = revoked, retried' = retried,
  }

  // ---- Writer peer ----
  action writerIssue(id: int): bool = all {
    not(writerAccepted.contains(id)),
    writerAccepted' = writerAccepted.union(Set(id)),
    inFlight' = inFlight.union(Set((id, writerEpoch))),
    writerEpoch' = writerEpoch, writerAcked' = writerAcked, resettled' = resettled,
    keepSeal, keepJob, keepStore, keepFlags,
  }
  // Retransmission (resettlement) of an unacknowledged move in the current epoch.
  action writerResend(id: int): bool = all {
    writerAccepted.contains(id), not(writerAcked.contains(id)),
    inFlight' = inFlight.union(Set((id, writerEpoch))),
    resettled' = (resettled or writerEpoch == 1),
    writerEpoch' = writerEpoch, writerAccepted' = writerAccepted, writerAcked' = writerAcked,
    keepSeal, keepJob, keepStore, keepFlags,
  }
  action writerInstall = all {
    writerEpoch == 0, phase == "served" or phase == "adopted",
    writerEpoch' = 1,
    writerAccepted' = writerAccepted, writerAcked' = writerAcked, inFlight' = inFlight, resettled' = resettled,
    keepSeal, keepJob, keepStore, keepFlags,
  }

  // ---- Ingress: admitted into the job slot, or refused and still owned ----
  action deliver(m: Mutants, msg: (int, int)): bool = all {
    inFlight.contains(msg),
    inFlight' = inFlight.exclude(Set(msg)),
    writerEpoch' = writerEpoch, writerAccepted' = writerAccepted, resettled' = resettled,
    keepSeal, keepFlags, aux' = aux,
    if (m.admitWhileClosing and msg._2 == 0 and SEALING.contains(phase)) all {
      journal0' = journal0.union(Set(msg._1)), journal1' = journal1,
      writerAcked' = writerAcked.union(Set(msg._1)),
      keepJob,
    } else if (admitting(msg._2) and job == "idle" and not(journalOf(msg._2).contains(msg._1))) all {
      job' = "admitted", jobId' = msg._1, jobEp' = msg._2, jobHeld' = false, jobImage' = jobImage,
      journal0' = journal0, journal1' = journal1, writerAcked' = writerAcked,
    } else all {
      writerAcked' = if (m.dropAcks and not(journalOf(msg._2).contains(msg._1))) writerAcked.union(Set(msg._1))
        else writerAcked,
      journal0' = journal0, journal1' = journal1, keepJob,
    },
  }

  // A native writer that bypasses the slot (mutant only). Sound owners never do.
  action outsideWrite = all {
    aux < MAX_AUX, phase == "open" or phase == "adopted",
    // Against a held reservation the write waits out the busy timeout and fails.
    aux' = if (held or jobHeld) aux else aux + 1,
    lockConflict' = (lockConflict or held or jobHeld),
    journal0' = journal0, journal1' = journal1,
    staleAdmit' = staleAdmit, revoked' = revoked, retried' = retried,
    keepSeal, keepJob, keepWriter,
  }

  // ---- The one job slot, with host boundaries between its spans ----
  action jobIdle(isRevoked: bool): bool = all {
    job' = "idle", jobId' = NONE, jobEp' = 0, jobHeld' = false, jobImage' = { moves: Set(), aux: 0 },
    revoked' = (revoked or isRevoked),
  }
  // Detached preparation: every reservation released, the image observed.
  action jobPrepare = all {
    job == "admitted",
    job' = "prepared", jobImage' = imageOf(jobEp), jobId' = jobId, jobEp' = jobEp, jobHeld' = false,
    keepSeal, keepWriter, keepStore, keepFlags,
  }
  // [yield] Qualification reacquires reservations and compares complete images.
  action jobQualify(m: Mutants): bool = all {
    job == "prepared",
    keepSeal, keepWriter, keepStore,
    lockConflict' = lockConflict, staleAdmit' = staleAdmit, retried' = retried,
    if (stopReq or held or (not(m.noQualify) and imageOf(jobEp) != jobImage)) jobIdle(true)
    else all {
      job' = "qualified", jobHeld' = true, jobId' = jobId, jobEp' = jobEp, jobImage' = jobImage, revoked' = revoked,
    },
  }
  // [yield] Charge; a stopped handle revokes the job, never resumes it.
  action jobCharge = all {
    job == "qualified",
    keepSeal, keepWriter, keepStore,
    lockConflict' = lockConflict, staleAdmit' = staleAdmit, retried' = retried,
    if (stopReq) jobIdle(true)
    else all { job' = "charged", jobHeld' = jobHeld, jobId' = jobId, jobEp' = jobEp, jobImage' = jobImage, revoked' = revoked },
  }
  // Custody is handed to the job's own write transaction, which commits in this span.
  action jobWrite(m: Mutants): bool = all {
    job == "charged",
    lockConflict' = (lockConflict or held or m.retainAtWrite),
    staleAdmit' = (staleAdmit or imageOf(jobEp) != jobImage),
    journal0' = if (jobEp == 0) journal0.union(Set(jobId)) else journal0,
    journal1' = if (jobEp == 1) journal1.union(Set(jobId)) else journal1,
    aux' = aux,
    writerAcked' = writerAcked.union(Set(jobId)),
    writerEpoch' = writerEpoch, writerAccepted' = writerAccepted, inFlight' = inFlight, resettled' = resettled,
    keepSeal, retried' = retried,
    jobIdle(false),
  }

  // ---- Seal and adoption: each action is one synchronous span ----
  action sealBegin = all {
    phase == "open", not(stopReq),
    phase' = "closing",
    held' = held, identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // Admitted jobs join; the stage closes admission; the sources are acquired
  // over the identity and stay held across the host turns of their walk.
  action sealCapture = all {
    phase == "closing", job == "idle",
    if (stopReq) all { phase' = "aborted", identity' = identity, held' = false }
    else all { phase' = "acquired", identity' = imageOf(0), held' = true },
    cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [A] Currency is rechecked before the close is derived from the held sources,
  // which are joined before the membership write.
  action sealDerive = all {
    phase == "acquired",
    phase' = if (stopReq or imageOf(0) != identity) "aborted" else "captured", held' = false,
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // The membership write; no reservation is held by any owner.
  action sealMembership = all {
    phase == "captured",
    lockConflict' = (lockConflict or held or jobHeld),
    phase' = if (stopReq) "aborted" else "membership", held' = held,
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, staleAdmit' = staleAdmit, revoked' = revoked, retried' = retried,
  }
  // [Y1] Reacquire sources and compare their identity.
  action sealReacquire = all {
    phase == "membership",
    if (stopReq or jobHeld or imageOf(0) != identity) all { phase' = "aborted", held' = false }
    else all { phase' = "reacquired", held' = true },
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [Y2] Check currency; the actor's evidence and prepare phases commit.
  action sealSignBegin = all {
    phase == "reacquired",
    if (stopReq or imageOf(0) != identity) all { phase' = "aborted", held' = false }
    else all { phase' = "signing", held' = held },
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [P] The commit vote and the commit QC over the cut the close was prepared on.
  // The handle's stop joins the close task, so the actor never observes it here.
  action sealCommit(m: Mutants): bool = all {
    phase == "signing",
    if (m.abortInsideSigning and stopReq) all { phase' = "aborted", held' = false, cut' = cut, qcs' = qcs }
    else all { phase' = "committed", held' = held, cut' = identity, qcs' = qcs + 1 },
    identity' = identity, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [P] The successor anchor completes the close.
  action sealSuccessor(m: Mutants): bool = all {
    phase == "committed",
    if (m.abortInsideSigning and stopReq) all { phase' = "aborted", held' = false } else all { phase' = "signed", held' = held },
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [Y3] The QC is final: stop joins completion.
  action sealAdvance(m: Mutants): bool = all {
    phase == "signed",
    if (m.abortAfterQC and stopReq) all { phase' = "aborted", held' = false } else all { phase' = "advanced", held' = held },
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [Y4] Generation stage, a compare-and-set on the head read before the QC.
  action sealStage = all {
    phase == "advanced", phase' = "staged",
    held' = held, identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // [serve] The successor export becomes available.
  action sealServe = all {
    phase == "staged", phase' = "served",
    held' = held, identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // Adoption's begin-to-projection span; sources terminate with it.
  action adopt = all {
    phase == "served", job == "idle",
    phase' = "adopted", held' = false,
    identity' = identity, cut' = cut, qcs' = qcs, stopReq' = stopReq,
    keepJob, keepWriter, keepStore, keepFlags,
  }
  // An aborted close rolls back to the open epoch and may seal again.
  action reopen = all {
    phase == "aborted", job == "idle",
    phase' = "open", held' = false, stopReq' = false, retried' = true,
    identity' = identity, cut' = cut, qcs' = qcs,
    keepJob, keepWriter, keepStore,
    lockConflict' = lockConflict, staleAdmit' = staleAdmit, revoked' = revoked,
  }
  action stop = all {
    phase != "open", phase != "adopted", phase != "aborted", not(stopReq),
    stopReq' = true,
    phase' = phase, held' = held, identity' = identity, cut' = cut, qcs' = qcs,
    keepJob, keepWriter, keepStore, keepFlags,
  }

  action stepWith(m: Mutants): bool = any {
    nondet id = WRITES.oneOf()
    any { writerIssue(id), writerResend(id) },
    writerInstall,
    all { inFlight != Set(), nondet msg = inFlight.oneOf() deliver(m, msg) },
    all { m.writerOutsideSlot, outsideWrite },
    jobPrepare, jobQualify(m), jobCharge, jobWrite(m),
    sealBegin, sealCapture, sealDerive, sealMembership, sealReacquire, sealSignBegin, sealCommit(m), sealSuccessor(m),
    sealAdvance(m), sealStage, sealServe,
    adopt, reopen, stop,
  }

  // ---- Deterministic scenarios ----
  // A job admitted before the seal began is revoked at its qualification boundary once stopped.
  run testJobRevokedAtBoundary =
    init.then(writerIssue(1)).then(deliver(SOUND, (1, 0))).then(jobPrepare).then(sealBegin)
      .then(stop).then(jobQualify(SOUND))
      .expect(revoked and job == "idle" and not(jobHeld) and safety)
  // Ingress refused while sealing stays the writer's and lands in the successor.
  run testRefusedIngressResettles =
    init.then(writerIssue(1)).then(sealBegin).then(sealCapture).then(sealDerive).then(deliver(SOUND, (1, 0)))
      .then(sealMembership).then(sealReacquire).then(sealSignBegin).then(sealCommit(SOUND))
      .then(sealSuccessor(SOUND)).then(sealAdvance(SOUND)).then(sealStage).then(sealServe).then(writerInstall)
      .then(adopt).then(writerResend(1)).then(deliver(SOUND, (1, 1))).then(jobPrepare).then(jobQualify(SOUND))
      .then(jobCharge).then(jobWrite(SOUND))
      .expect(journal1 == Set(1) and journal0 == Set() and writerAcked == Set(1) and safety)
  // A move admitted before the seal is in the cut; stop after the QC joins completion.
  run testStopAfterQCJoins =
    init.then(writerIssue(1)).then(deliver(SOUND, (1, 0))).then(jobPrepare).then(jobQualify(SOUND))
      .then(jobCharge).then(jobWrite(SOUND)).then(sealBegin).then(sealCapture).then(sealDerive)
      .then(sealMembership).then(sealReacquire).then(sealSignBegin).then(sealCommit(SOUND))
      .then(sealSuccessor(SOUND)).then(stop).then(sealAdvance(SOUND)).then(sealStage).then(sealServe).then(adopt)
      .expect(phase == "adopted" and qcs == 1 and cut.moves == Set(1) and safety)
  // The mutated close abandons its signed QC, and a retry signs a second one.
  run testAbortAfterQCDoubleSigns =
    init.then(sealBegin).then(sealCapture).then(sealDerive).then(sealMembership).then(sealReacquire)
      .then(sealSignBegin).then(sealCommit(SOUND)).then(sealSuccessor(SOUND)).then(stop)
      .then(sealAdvance(SOUND.with("abortAfterQC", true))).then(reopen).then(sealBegin).then(sealCapture)
      .then(sealDerive).then(sealMembership).then(sealReacquire).then(sealSignBegin).then(sealCommit(SOUND))
      .expect(not(noOrphanQC) or not(singleSuccessor))

  // Stop between the commit QC and the successor anchor joins completion.
  run testStopInsideSigningJoins =
    init.then(sealBegin).then(sealCapture).then(sealDerive).then(sealMembership).then(sealReacquire)
      .then(sealSignBegin).then(sealCommit(SOUND)).then(stop).then(sealSuccessor(SOUND)).then(sealAdvance(SOUND))
      .then(sealStage).then(sealServe).then(adopt)
      .expect(phase == "adopted" and qcs == 1 and safety)
  // Stop at the acquisition boundary aborts before any membership or QC.
  run testStopAtAcquiredBoundaryAborts =
    init.then(sealBegin).then(sealCapture).then(stop).then(sealDerive)
      .expect(phase == "aborted" and not(held) and qcs == 0 and safety)
  // A stop that reaches the actor between its committed phases orphans the QC.
  run testAbortInsideSigningOrphansQC =
    init.then(sealBegin).then(sealCapture).then(sealDerive).then(sealMembership).then(sealReacquire)
      .then(sealSignBegin).then(sealCommit(SOUND)).then(stop)
      .then(sealSuccessor(SOUND.with("abortInsideSigning", true)))
      .expect(not(noOrphanQC))

  action step = stepWith(SOUND)
  action brokenAdmitWhileClosing = stepWith(SOUND.with("admitWhileClosing", true))
  action brokenAbortAfterQC = stepWith(SOUND.with("abortAfterQC", true))
  action brokenAbortInsideSigning = stepWith(SOUND.with("abortInsideSigning", true))
  action brokenRetainAtWrite = stepWith(SOUND.with("retainAtWrite", true))
  action brokenDropAcks = stepWith(SOUND.with("dropAcks", true))
  // A writer outside the slot meets a job holding custody across a boundary.
  action brokenWriterOutsideSlot = stepWith(SOUND.with("writerOutsideSlot", true))
  // With such a writer, only qualification keeps a detached image from being admitted stale.
  action brokenNoQualify = stepWith(SOUND.with("writerOutsideSlot", true).with("noQualify", true))
}
