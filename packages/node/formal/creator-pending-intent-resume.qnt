// C03 layer 2: a Writer crashes between signing an issuance intent and committing it.
//
// The durable issuance store reserves an intent (its exact unsigned preimage, its plan
// effect, and the exact settlement plan bytes it was built against) as pending unsigned
// custody, then signs, then commits. A crash between sign and commit leaves the intent
// pending. While it is pending the store refuses (a) every settlement plan write and
// (b) every other issue at that ordinal. It clears only when the byte-identical intent
// commits; it has no abandon operation (an authenticated abandonment would need a
// signed record the store accepts; none exists today).
//
// At every reopen the room's startup drain merges and writes its settlement plan. In a
// new epoch the merged plan differs, so the write is real; in the same epoch it is a
// no-op and the old drain then re-issued the identical intent (it resumed by inheritance,
// which holds only while the plane has not moved on).
//
// Rule under test: before any plan write, every pending unsigned intent (fence or
// replacement) either resumes (commits byte-identical: same preimage, same effect, against
// the unchanged plan) or is abandoned with authentication.
//   SOUND: the drain first resumes the pending intent (commits its exact bytes, in either
//          epoch), then writes the plan.
//   Broken controls:
//     planFirst  - the current drain: write the plan first, resume only after (wedges in a new epoch).
//     fenceOnly  - resume only a pending fence before the plan write (a replacement still wedges).
//     silentDrop - clear the pending custody without a commit or a signed abandonment, so the
//                  ordinal is reused by a different intent (a second signature at one slot).
//     noCurrencyCheck - resume without the currency guard (below).
//
// Currency guard (sync before sending): the pending intent may come from a restored backup while
// the original device already committed and published a different vertex at that ordinal
// (restore). Resuming then re-signs a conflicting second vertex. A reopened session is not yet
// current until it confirms the creator's statement (confirm), whose admitted frontier for this
// author must be below lineage.next, which is the pending ordinal. Until then the drain is left
// undone ("awaiting"): the intent stays pending, no plan is written, nothing is signed. A
// confirmed statement runs the drain again; a statement at or above the ordinal refuses the
// session (V3RoomNotYetCurrent "behind-frontier") for good, and nothing is signed.
//
// Resuming in a new epoch commits an old-epoch vertex. That is exactly the state of a crash
// just after commit (the vertex is committed and unpublished), which the drain already handles.
module creatorPendingIntentResume {
  pure val MAX_EPOCH = 2
  pure val MAX_SEQ = 4
  pure val MAX_CRASHES = 3
  pure val MAX_IDS = 6

  type Mutants = { planFirst: bool, fenceOnly: bool, silentDrop: bool, noCurrencyCheck: bool }
  pure val SOUND: Mutants = { planFirst: false, fenceOnly: false, silentDrop: false, noCurrencyCheck: false }

  type Pending = { kind: str, seq: int, id: int, planRev: int, epoch: int }
  pure val NONE: Pending = { kind: "none", seq: -1, id: -1, planRev: -1, epoch: -1 }

  var mu: Mutants
  var epoch: int
  var plan: int          // settlement plan revision (stands for its exact bytes)
  var planEpoch: int     // the epoch the plan was last merged for
  var lineageNext: int          // lineage next ordinal
  var pending: Pending
  var nextId: int
  var phase: str         // "running" | "crashed" | "draining" | "wedged" | "refused"
  var crashes: int
  var applied: int -> int        // intent id -> times its effect committed
  var signedAt: int -> Set[int]  // ordinal -> intent ids this device signed there
  var otherAt: int -> Set[int]   // ordinal -> vertices the original device committed and published there
  var frontier: int              // this author's admitted frontier, as the creator states it
  var restored: bool             // this device runs from a restored backup
  var conflicts: int             // committed vertices at an ordinal another device already signed
  var confirmed: bool            // this session confirmed the creator's statement (it is current)
  var unconfirmedResumes: int    // resumes signed before this session was current

  action initWith(m: Mutants): bool = all {
    mu' = m,
    epoch' = 0,
    plan' = 0,
    planEpoch' = 0,
    lineageNext' = 0,
    pending' = NONE,
    nextId' = 0,
    phase' = "running",
    crashes' = 0,
    applied' = 0.to(MAX_IDS - 1).mapBy(_ => 0),
    signedAt' = 0.to(MAX_SEQ).mapBy(_ => Set()),
    otherAt' = 0.to(MAX_SEQ).mapBy(_ => Set()),
    frontier' = -1,
    restored' = false,
    conflicts' = 0,
    confirmed' = false,
    unconfirmedResumes' = 0,
  }
  action init = initWith(SOUND)
  action initPlanFirst = initWith({ ...SOUND, planFirst: true })
  action initFenceOnly = initWith({ ...SOUND, fenceOnly: true })
  action initSilentDrop = initWith({ ...SOUND, silentDrop: true })
  action initNoCurrencyCheck = initWith({ ...SOUND, noCurrencyCheck: true })

  // The store commits the pending intent byte-identically (fresh signature over the same bytes).
  action commitPending(p: Pending): bool = all {
    applied' = applied.setBy(p.id, v => v + 1),
    lineageNext' = lineageNext + 1,
    plan' = plan + 1, // its plan effect
    pending' = NONE,
    frontier' = if (p.seq > frontier) p.seq else frontier, // published and admitted
  }

  // Reserve and enter signing a new intent (fence or replacement) at the next ordinal.
  action reserve(kind: str): bool = all {
    phase == "running",
    pending.kind == "none",
    lineageNext < MAX_SEQ,
    nextId < MAX_IDS,
    pending' = { kind: kind, seq: lineageNext, id: nextId, planRev: plan, epoch: epoch },
    nextId' = nextId + 1,
    signedAt' = signedAt.setBy(lineageNext, s => s.union(Set(nextId))),
    epoch' = epoch, plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, phase' = phase,
    crashes' = crashes, applied' = applied, mu' = mu, frontier' = frontier, restored' = restored, conflicts' = conflicts, otherAt' = otherAt,
    confirmed' = confirmed, unconfirmedResumes' = unconfirmedResumes,
  }

  // The commit lands (only against the exact plan the intent was built on).
  action commit: bool = all {
    phase == "running",
    pending.kind != "none",
    pending.planRev == plan,
    commitPending(pending),
    epoch' = epoch, planEpoch' = planEpoch, nextId' = nextId, phase' = phase, crashes' = crashes,
    signedAt' = signedAt, mu' = mu, restored' = restored, conflicts' = conflicts, otherAt' = otherAt,
    confirmed' = confirmed, unconfirmedResumes' = unconfirmedResumes,
  }

  // A crash at any point; a pending intent survives it.
  action crash: bool = all {
    phase == "running",
    crashes < MAX_CRASHES,
    phase' = "crashed",
    crashes' = crashes + 1,
    epoch' = epoch, plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, pending' = pending,
    nextId' = nextId, applied' = applied, signedAt' = signedAt, mu' = mu, frontier' = frontier, restored' = restored, conflicts' = conflicts, otherAt' = otherAt,
    confirmed' = confirmed, unconfirmedResumes' = unconfirmedResumes,
  }

  // The device restores a backup taken while the intent was pending; the original device had
  // meanwhile committed and published a different vertex at that ordinal.
  action restore: bool = all {
    phase == "crashed",
    pending.kind != "none",
    not(restored),
    nextId < MAX_IDS,
    otherAt' = otherAt.setBy(pending.seq, s => s.union(Set(nextId))),
    signedAt' = signedAt,
    frontier' = if (pending.seq > frontier) pending.seq else frontier,
    nextId' = nextId + 1,
    restored' = true,
    epoch' = epoch, plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, pending' = pending, phase' = phase,
    crashes' = crashes, applied' = applied, mu' = mu, conflicts' = conflicts,
    confirmed' = confirmed, unconfirmedResumes' = unconfirmedResumes,
  }

  // Reopen in the same epoch, or after the creator closed it (cold successor reopen).
  action reopen(nextEpoch: bool): bool = all {
    phase == "crashed",
    not(nextEpoch) or epoch < MAX_EPOCH,
    epoch' = if (nextEpoch) epoch + 1 else epoch,
    phase' = "draining",
    plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, pending' = pending, nextId' = nextId,
    crashes' = crashes, applied' = applied, signedAt' = signedAt, mu' = mu, frontier' = frontier, restored' = restored, conflicts' = conflicts, otherAt' = otherAt,
    confirmed' = false, unconfirmedResumes' = unconfirmedResumes,
  }

  // The reopened session confirms the creator's statement: current when this author's admitted
  // frontier is below lineage.next (the pending ordinal); then the left drain runs again.
  action confirm: bool = all {
    phase == "draining" or phase == "awaiting",
    not(confirmed),
    if (frontier < lineageNext) all { confirmed' = true, phase' = "draining" }
    else all { confirmed' = false, phase' = "refused" },
    epoch' = epoch, plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, pending' = pending, nextId' = nextId,
    crashes' = crashes, applied' = applied, signedAt' = signedAt, mu' = mu, frontier' = frontier, restored' = restored,
    conflicts' = conflicts, otherAt' = otherAt, unconfirmedResumes' = unconfirmedResumes,
  }

  // The merged plan differs only when the plan was last merged for an older epoch.
  def planChanges: bool = planEpoch != epoch

  // Resume step of the drain: whether this rule resumes the pending intent now.
  def resumesFirst(p: Pending): bool =
    p.kind != "none" and not(mu.planFirst) and (not(mu.fenceOnly) or p.kind == "fence")
  // The session may sign this intent: it is current (confirmed), or the control skips the check.
  def current: bool = mu.noCurrencyCheck or confirmed

  // Committing this intent would put a second vertex at an ordinal another device already signed.
  def conflictOn(p: Pending): bool = otherAt.get(p.seq).exclude(Set(p.id)).size() > 0

  // The startup drain as one step.
  action drain: bool = all {
    phase == "draining",
    if (mu.silentDrop and pending.kind != "none") all {
      // No commit and no signed abandonment: the custody just disappears; the ordinal is free again.
      pending' = NONE, lineageNext' = lineageNext, applied' = applied, frontier' = frontier,
      plan' = if (planChanges) plan + 1 else plan, planEpoch' = epoch,
      phase' = "running", conflicts' = conflicts, unconfirmedResumes' = unconfirmedResumes,
    } else if (pending.kind != "none" and not(current)) all {
      // Not yet current: the drain is left undone, the custody kept, nothing signed.
      phase' = "awaiting", conflicts' = conflicts,
      plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, pending' = pending, applied' = applied, frontier' = frontier,
      unconfirmedResumes' = unconfirmedResumes,
    } else if (resumesFirst(pending)) all {
      // SOUND: resume byte-identically against the unchanged plan, then write the merged plan.
      applied' = applied.setBy(pending.id, v => v + 1),
      lineageNext' = lineageNext + 1,
      pending' = NONE,
      frontier' = if (pending.seq > frontier) pending.seq else frontier,
      plan' = if (planChanges) plan + 2 else plan + 1,
      planEpoch' = epoch,
      phase' = "running",
      conflicts' = if (conflictOn(pending)) conflicts + 1 else conflicts,
      unconfirmedResumes' = if (confirmed) unconfirmedResumes else unconfirmedResumes + 1,
    } else if (pending.kind != "none" and planChanges) all {
      // The store refuses the plan write while the intent is pending: wedged.
      phase' = "wedged", conflicts' = conflicts,
      plan' = plan, planEpoch' = planEpoch, lineageNext' = lineageNext, pending' = pending, applied' = applied, frontier' = frontier,
      unconfirmedResumes' = unconfirmedResumes,
    } else if (pending.kind != "none") all {
      // Same epoch: no plan write; the drain re-issues the identical intent (inheritance).
      applied' = applied.setBy(pending.id, v => v + 1),
      lineageNext' = lineageNext + 1,
      pending' = NONE,
      frontier' = if (pending.seq > frontier) pending.seq else frontier,
      plan' = plan + 1,
      planEpoch' = planEpoch,
      phase' = "running",
      conflicts' = if (conflictOn(pending)) conflicts + 1 else conflicts,
      unconfirmedResumes' = if (confirmed) unconfirmedResumes else unconfirmedResumes + 1,
    } else all {
      pending' = NONE, lineageNext' = lineageNext, applied' = applied, frontier' = frontier,
      plan' = if (planChanges) plan + 1 else plan, planEpoch' = epoch,
      phase' = "running", conflicts' = conflicts, unconfirmedResumes' = unconfirmedResumes,
    },
    epoch' = epoch, nextId' = nextId, crashes' = crashes, signedAt' = signedAt, mu' = mu, restored' = restored,
    otherAt' = otherAt, confirmed' = confirmed,
  }

  action step = any {
    nondet kind = Set("fence", "replacement").oneOf()
    reserve(kind),
    commit,
    crash,
    nondet nextEpoch = Set(true, false).oneOf()
    reopen(nextEpoch),
    restore,
    confirm,
    drain,
  }

  // A reopen never ends wedged.
  val noWedge: bool = phase != "wedged"
  // Every intent's effect commits at most once.
  val appliedOnce: bool = applied.keys().forall(id => applied.get(id) <= 1)
  // No ordinal carries two different signed intents (no equivocation at one slot).
  val noEquivocation: bool = signedAt.keys().forall(s => signedAt.get(s).size() <= 1)
  // A pending intent always matches the current plan bytes (plan writes never pass it).
  val pendingPlanCurrent: bool = pending.kind == "none" or pending.planRev == plan
  // Never a second committed vertex at an ordinal another device of this author already signed.
  val noConflictingResume: bool = conflicts == 0
  // Nothing is resumed (signed) before the session is current.
  val noResumeBeforeCurrent: bool = unconfirmedResumes == 0
  val safety: bool =
    noWedge and appliedOnce and noEquivocation and pendingPlanCurrent and noConflictingResume and noResumeBeforeCurrent

  // The C03 shape: a replacement crashes after entry, then the next epoch's reopen; the drain
  // waits for the statement, signs nothing meanwhile, then resumes before its plan write.
  run resumeNextEpochTest = init
    .then(reserve("replacement")).then(crash).then(reopen(true)).then(drain)
    .expect(phase == "awaiting" and pending.kind != "none" and applied.get(0) == 0 and safety)
    .then(confirm).then(drain)
    .expect(phase == "running" and pending.kind == "none" and applied.get(0) == 1 and lineageNext == 1 and safety)
    .then(reserve("fence")).then(commit).expect(safety)
  run resumeSameEpochTest = init
    .then(reserve("replacement")).then(crash).then(reopen(false)).then(confirm).then(drain)
    .expect(phase == "running" and pending.kind == "none" and applied.get(0) == 1 and safety)
  run resumeFenceNextEpochTest = init
    .then(reserve("fence")).then(crash).then(reopen(true)).then(confirm).then(drain)
    .expect(phase == "running" and applied.get(0) == 1 and safety)
  run restoredBehindFrontierRefusedTest = init
    .then(reserve("replacement")).then(crash).then(restore).then(reopen(false)).then(drain)
    .expect(phase == "awaiting" and safety)
    .then(confirm)
    .expect(phase == "refused" and pending.kind != "none" and applied.get(0) == 0 and conflicts == 0 and safety)
  run planFirstWedgesTest = initPlanFirst
    .then(reserve("replacement")).then(crash).then(reopen(true)).then(confirm).then(drain)
    .expect(phase == "wedged" and not(noWedge))
  run fenceOnlyWedgesReplacementTest = initFenceOnly
    .then(reserve("replacement")).then(crash).then(reopen(true)).then(confirm).then(drain)
    .expect(phase == "wedged")
  run fenceOnlyResumesFenceTest = initFenceOnly
    .then(reserve("fence")).then(crash).then(reopen(true)).then(confirm).then(drain)
    .expect(phase == "running" and safety)
  run noCurrencyCheckConflictsTest = initNoCurrencyCheck
    .then(reserve("replacement")).then(crash).then(restore).then(reopen(false)).then(drain)
    .expect(not(noConflictingResume))
  run noCurrencyCheckSignsBeforeCurrentTest = initNoCurrencyCheck
    .then(reserve("replacement")).then(crash).then(reopen(true)).then(drain)
    .expect(not(noResumeBeforeCurrent))
  run silentDropEquivocatesTest = initSilentDrop
    .then(reserve("replacement")).then(crash).then(reopen(true)).then(drain).then(reserve("fence"))
    .expect(not(noEquivocation))
}
