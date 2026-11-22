// H5 adjunct: exact plan/control commit, dependency closure and same-intent
// recovery. Row signatures, digest collision resistance, canonical encoding,
// native transaction atomicity and coordinator custody are assumptions.
// Three rows represent a two-edge replacement chain. The epoch counter is a
// separate axis: increasing it does not increase rows/writers per epoch.
//
// Rewrite versus outbox: logical retirement (kept) and physical pruning (pruned)
// are separate commits. The store prunes a contiguous prefix of retired rows, so
// pruning may lag retirement indefinitely, and a row it still holds is a row the
// creator recovery census visits. The census classifies a displaced published
// source by its completed plan entry (completedBranch), so a completion entry is
// kept while its row exists (entryKept). CUSTODY: the plan rewrite keeps a
// completed entry whose source is retired but still held, without protecting it,
// and the plan check admits that entry while it is unchanged; a merge drops it
// once its source is pruned. CUSTODY false is today's rewrite and the broken
// control: it drops the entry as soon as its source retires.
module nativeRetirementCustodySpec {
  const MAX_EPOCH: int
  const CUSTODY: bool
  pure val ROWS = Set(0, 1, 2)
  pure val ENTRIES = Set(0, 1)
  type State = { epoch:int, floor:int, floorBefore:int, phase:int, kept:Set[int], plan:Set[int],
    targetKept:Set[int], targetPlan:Set[int], portable:bool, image:int,
    context:int, capturedContext:int, active:bool, choice:str, pruned:int, refused:bool }
  var s: State

  pure def expand(kept: Set[int], portable: bool): Set[int] =
    kept.union(ENTRIES.filter(x => kept.contains(x)).map(x => x + 1))
      .union(if (portable) ENTRIES.filter(x => kept.contains(x + 1)) else Set())
  pure def closure(kept: Set[int], portable: bool): Set[int] =
    0.to(2).fold(kept, (acc, _) => expand(acc, portable))
  pure def closed(kept: Set[int], portable: bool): bool = expand(kept, portable) == kept
  // The rows the store still holds: everything above the pruned prefix.
  pure def held(pruned: int, x: int): bool = x > pruned
  // issuanceRetirementTargetRows: a retained entry stays; under CUSTODY so does a
  // completed entry whose source is still held.
  pure def rewrite(kept: Set[int], pruned: int): Set[int] =
    ENTRIES.filter(x => kept.contains(x) or (CUSTODY and held(pruned, x)))
  // assertIssuanceRetirementPlanAllowed: every entry names live work, or (CUSTODY)
  // is a prior custody entry carried unchanged. A custody entry is not a
  // dependency: it neither protects nor requires its source or replacement.
  pure def planAllowed(proposed: Set[int], prior: Set[int], kept: Set[int]): bool =
    proposed.forall(x => (kept.contains(x) and kept.contains(x + 1)) or
      (CUSTODY and prior.contains(x) and not(kept.contains(x))))
  // The node store's prune: the longest contiguous prefix of retired rows.
  pure def prefix(kept: Set[int], pruned: int): int =
    (-1).to(2).filter(p => p >= pruned and ROWS.forall(x => (x > pruned and x <= p) implies not(kept.contains(x))))
      .fold(pruned, (acc, p) => if (p > acc) p else acc)
  pure def fresh(epoch: int): State = { epoch:epoch, floor:epoch - 1, floorBefore:epoch - 1, phase:0,
    kept:ROWS, plan:ENTRIES, targetKept:ROWS, targetPlan:ENTRIES,
    portable:false, image:0, context:0, capturedContext:0, active:false, choice:"", pruned:-1, refused:false }
  pure def safetyOf(st: State): bool = and {
    0 <= st.epoch and st.epoch <= MAX_EPOCH,
    st.floor == (if (st.phase == 2) st.epoch else st.epoch - 1),
    -1 <= st.floorBefore and st.floorBefore <= st.floor,
    Set(0, 1, 2).contains(st.phase), st.kept.subseteq(ROWS), st.plan.subseteq(ENTRIES),
    st.targetKept.subseteq(ROWS), st.targetPlan.subseteq(ENTRIES),
    closed(st.targetKept, st.portable),
    st.targetPlan == rewrite(st.targetKept, -1),
    -1 <= st.pruned and st.pruned <= 2,
    ROWS.forall(x => not(held(st.pruned, x)) implies not(st.kept.contains(x))),
    st.plan.forall(x => (st.kept.contains(x) and st.kept.contains(x + 1)) or (CUSTODY and not(st.kept.contains(x)))),
    (st.phase < 2).implies(st.kept == ROWS and st.plan == ENTRIES and st.image == 0 and st.pruned == -1),
    (st.phase == 1).implies(st.active),
    (st.phase == 2).implies(st.kept == st.targetKept and st.plan.subseteq(st.targetPlan) and
      st.targetPlan.filter(x => st.kept.contains(x)).subseteq(st.plan) and Set(1, 2).contains(st.image)),
    (st.choice == "original").implies(st.phase == 2 and st.image == 1 and st.context == st.capturedContext),
    (st.choice == "fresh").implies(not(st.active)),
    (st.choice == "refuse").implies(st.active),
  }
  val safety = safetyOf(s)
  // The census: every row still held keeps its completion entry.
  pure def entryKeptOf(st: State): bool = ENTRIES.forall(x => held(st.pruned, x) implies st.plan.contains(x))
  val entryKept = entryKeptOf(s)
  // No plan write is refused ("settlement plan references retired or absent issued work").
  val noRefusal = not(s.refused)
  pure def invOf(st: State): bool = safetyOf(st) and entryKeptOf(st) and not(st.refused)
  val inv = invOf(s)
  val reachedRewrite = s.phase == 2 and s.plan.size() < 2
  val reachedPortablePin = s.phase == 2 and s.portable and s.kept == ROWS
  val reachedChangedSource = s.choice == "fresh" and s.context != s.capturedContext
  val reachedCustody = s.phase == 2 and s.plan.exists(x => not(s.kept.contains(x)))
  val reachedPrunedBehindCustody = s.phase == 2 and s.pruned >= 0 and s.plan.exists(x => not(s.kept.contains(x)))
  val neverRewrite = not(reachedRewrite)
  val neverCustody = not(reachedCustody)
  val neverPrunedBehindCustody = not(reachedPrunedBehindCustody)
  action init = s' = fresh(0)
  action prepare(keep: Set[int], portable: bool): bool = {
    val target = closure(keep, portable)
    all { s.phase == 0, keep.subseteq(ROWS),
    s' = s.with("phase", 1).with("targetKept", target)
      .with("targetPlan", rewrite(target, s.pruned))
      .with("portable", portable).with("capturedContext", s.context).with("active", true).with("choice", ""),
    }
  }
  action commit = all { s.phase == 1,
    s' = if (planAllowed(s.targetPlan, s.plan, s.targetKept))
        s.with("phase", 2).with("floorBefore", s.floor).with("floor", s.epoch).with("kept", s.targetKept)
          .with("plan", s.targetPlan).with("image", 1).with("choice", "")
      else s.with("refused", true),
  }
  action finish = all { s.phase == 2, s.active,
    s' = s.with("active", false).with("choice", ""),
  }
  // A later journal/snapshot/floor source may change while the native issuance
  // target remains byte-for-byte equal. Target equality alone is insufficient.
  action changeOtherSource = all { s.phase == 2,
    s' = s.with("context", 1 - s.context).with("choice", ""),
  }
  action changeNativeImage = all { s.phase == 2, not(s.active),
    s' = s.with("image", 2).with("choice", ""),
  }
  // Physical pruning, its own commit after retirement completes. Leaving it
  // untaken is the lag (a whole-plan pruning precondition, a crash, a later row).
  action prune = {
    val through = prefix(s.kept, s.pruned)
    all { s.phase == 2, not(s.active), through != s.pruned,
    s' = s.with("pruned", through).with("image", 2).with("choice", ""),
    }
  }
  // completedSettlementSourcesPruned: a later merge drops a completed entry whose
  // source the store no longer holds.
  action merge = {
    val kept1 = s.plan.filter(x => s.kept.contains(x) or held(s.pruned, x))
    all { s.phase == 2, not(s.active), kept1 != s.plan,
    s' = if (planAllowed(kept1, s.plan, s.kept)) s.with("plan", kept1).with("image", 2).with("choice", "")
      else s.with("refused", true),
    }
  }
  // A later plan merge rebuilds the entry of a held displaced row whose entry is
  // absent (the shape of browser path 1: a zone rollover's merge). The store
  // refuses it while the row is logically retired.
  action rescan(x: int): bool = all { s.phase == 2, not(s.active), ENTRIES.contains(x),
    held(s.pruned, x), not(s.plan.contains(x)),
    s' = if (planAllowed(s.plan.union(Set(x)), s.plan, s.kept))
        s.with("plan", s.plan.union(Set(x))).with("image", 2).with("choice", "")
      else s.with("refused", true),
  }
  action recover = {
    val exact = s.image == 1 and s.context == s.capturedContext
    all { s.phase == 2,
    s' = s.with("choice", if (exact) "original" else if (s.active) "refuse" else "fresh"),
    }
  }
  action crash = s' = s.with("choice", "")
  action nextEpoch = all { s.phase == 2, not(s.active), s.epoch < MAX_EPOCH,
    s' = fresh(s.epoch + 1),
  }
  action step = any {
    { nondet keep = ROWS.powerset().oneOf()
      nondet portable = Set(false, true).oneOf()
      prepare(keep, portable) },
    commit, finish, changeOtherSource, changeNativeImage, prune, merge,
    { nondet x = ENTRIES.oneOf()
      rescan(x) },
    recover, crash, nextEpoch,
  }
  action unsafeFloorFirst = all { s.phase == 1,
    s' = s.with("phase", 2).with("floor", s.epoch).with("kept", s.targetKept).with("image", 1),
  }
  action unsafePlanFirst = all { s.phase == 1, s' = s.with("plan", s.targetPlan) }
  action unsafeNativeOnlyRecovery = all { s.phase == 2, s.image == 1,
    s' = s.with("choice", "original"),
  }
  // Today's rewrite inside the custody rule: drop a completed entry once its
  // source retires, whether or not the store still holds the source.
  action unsafeRetiredDrop = all { s.phase == 1,
    s' = s.with("phase", 2).with("floorBefore", s.floor).with("floor", s.epoch).with("kept", s.targetKept)
      .with("plan", ENTRIES.filter(x => s.targetKept.contains(x))).with("image", 1).with("choice", ""),
  }
  action unsafeStep = any { step, unsafeFloorFirst, unsafePlanFirst, unsafeNativeOnlyRecovery, unsafeRetiredDrop }
  // Explicit finite-type arbitrary-state induction hypothesis. MAX_EPOCH is
  // the epoch range checked by Apalache, not a proof of arbitrary parameters.
  action indInit = {
    nondet epoch = 0.to(MAX_EPOCH).oneOf()
    nondet floorBefore = (-1).to(MAX_EPOCH).oneOf()
    nondet phase = Set(0, 1, 2).oneOf()
    nondet kept = ROWS.powerset().oneOf()
    nondet plan = ENTRIES.powerset().oneOf()
    nondet targetKept = ROWS.powerset().oneOf()
    nondet targetPlan = ENTRIES.powerset().oneOf()
    nondet portable = Set(false, true).oneOf()
    nondet image = Set(0, 1, 2).oneOf()
    nondet context = Set(0, 1).oneOf()
    nondet capturedContext = Set(0, 1).oneOf()
    nondet active = Set(false, true).oneOf()
    nondet choice = Set("", "original", "fresh", "refuse").oneOf()
    nondet pruned = (-1).to(2).oneOf()
    nondet refused = Set(false, true).oneOf()
    val st: State = { epoch:epoch, floor:if (phase == 2) epoch else epoch - 1, floorBefore:floorBefore,
      phase:phase, kept:kept, plan:plan, targetKept:targetKept, targetPlan:targetPlan,
      portable:portable, image:image, context:context, capturedContext:capturedContext,
      active:active, choice:choice, pruned:pruned, refused:refused }
    all { invOf(st), s' = st }
  }
  run portableConsumerPinsWholeChainTest = init.then(prepare(Set(2), true)).then(commit)
    .expect(s.kept == ROWS and s.plan == ENTRIES and inv)
  run changedCompletedSourceStartsFreshTest = init.then(prepare(Set(1), false)).then(commit).then(finish)
    .then(changeOtherSource).then(recover).expect(s.choice == "fresh" and safety)
  run changedActiveSourceRefusesTest = init.then(prepare(Set(1), false)).then(commit)
    .then(changeOtherSource).then(recover).expect(s.choice == "refuse" and safety)
  run changedNativeTargetStartsFreshTest = init.then(prepare(Set(1), false)).then(commit).then(finish)
    .then(changeNativeImage).then(recover).expect(s.choice == "fresh" and safety)
  run nativeOnlyRecoveryCounterexampleTest = init.then(prepare(Set(1), false)).then(commit).then(finish)
    .then(changeOtherSource).then(unsafeNativeOnlyRecovery).expect(not(safety))
}

// The custody rule.
module nativeRetirementCustodySmall {
  import nativeRetirementCustodySpec(MAX_EPOCH = 3, CUSTODY = true).* from "./native-retirement-custody"
  // Retirement keeps 1 and 2; source 0 retires but stays held, so its completed
  // entry stays until the prune and the merge after it.
  run rewriteAndCrashTest = init.then(prepare(Set(1), false)).then(crash).expect(s.plan == ENTRIES and inv)
    .then(commit).then(crash).then(recover).expect(s.kept == Set(1, 2) and s.plan == ENTRIES and s.choice == "original" and inv)
    .then(finish).then(prune).expect(s.pruned == 0 and s.plan == ENTRIES and inv)
    .then(merge).expect(s.plan == Set(1) and inv)
  run sourceReleaseKeepsEntriesUntilPrunedTest = init.then(prepare(Set(), true)).then(commit)
    .expect(s.kept == Set() and s.plan == ENTRIES and inv)
    .then(finish).then(prune).then(merge).expect(s.pruned == 2 and s.plan == Set() and inv)
  // Pruning never waits on a custody entry: it is a completed entry.
  run custodyDoesNotBlockPruningTest = init.then(prepare(Set(2), false)).then(commit).then(finish).then(prune)
    .expect(s.pruned == 1 and s.plan == ENTRIES and inv)
  run retiredDropCounterexampleTest = init.then(prepare(Set(1), false)).then(unsafeRetiredDrop)
    .expect(safety and not(entryKept))
}

// Today's rewrite (the broken control): the same schedules lose the entry of a
// held row, and a later merge that rebuilds it is refused.
module nativeRetirementCustodyToday {
  import nativeRetirementCustodySpec(MAX_EPOCH = 3, CUSTODY = false).* from "./native-retirement-custody"
  run retiredSourceLosesEntryTest = init.then(prepare(Set(1), false)).then(commit)
    .expect(s.plan == Set(1) and s.pruned == -1 and safety and not(entryKept))
  run rescanOfRetiredRowRefusedTest = init.then(prepare(Set(1), false)).then(commit).then(finish).then(rescan(0))
    .expect(s.refused and safety and not(noRefusal))
  run floorFirstCounterexampleTest = init.then(prepare(Set(1), false)).then(unsafeFloorFirst).expect(not(safety))
  run planFirstCounterexampleTest = init.then(prepare(Set(1), false)).then(unsafePlanFirst).expect(not(safety))
}

module nativeRetirementCustody300 {
  import nativeRetirementCustodySpec(MAX_EPOCH = 299, CUSTODY = true).* from "./native-retirement-custody"
  action epochCycle = prepare(Set(1), false).then(crash).then(commit).then(crash).then(recover).then(finish)
    .then(prune).then(merge)
  run threeHundredEpochsTest = init.then(299.reps(_ => epochCycle.then(nextEpoch)))
    .then(epochCycle).expect(s.epoch == 299 and s.floor == 299 and s.plan == Set(1) and s.pruned == 0 and inv)
}
