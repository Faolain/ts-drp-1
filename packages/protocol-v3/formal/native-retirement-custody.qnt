// H5 adjunct: exact plan/control commit, dependency closure and same-intent
// recovery. Row signatures, digest collision resistance, canonical encoding,
// native transaction atomicity and coordinator custody are assumptions.
// Three rows represent a two-edge replacement chain. The epoch counter is a
// separate axis: increasing it does not increase rows/writers per epoch.
module nativeRetirementCustodySpec {
  const MAX_EPOCH: int
  pure val ROWS = Set(0, 1, 2)
  pure val ENTRIES = Set(0, 1)
  type State = { epoch:int, floor:int, floorBefore:int, phase:int, kept:Set[int], plan:Set[int],
    targetKept:Set[int], targetPlan:Set[int], portable:bool, image:int,
    context:int, capturedContext:int, active:bool, choice:str }
  var s: State

  pure def expand(kept: Set[int], portable: bool): Set[int] =
    kept.union(ENTRIES.filter(x => kept.contains(x)).map(x => x + 1))
      .union(if (portable) ENTRIES.filter(x => kept.contains(x + 1)) else Set())
  pure def closure(kept: Set[int], portable: bool): Set[int] =
    0.to(2).fold(kept, (acc, _) => expand(acc, portable))
  pure def closed(kept: Set[int], portable: bool): bool = expand(kept, portable) == kept
  pure def fresh(epoch: int): State = { epoch:epoch, floor:epoch - 1, floorBefore:epoch - 1, phase:0,
    kept:ROWS, plan:ENTRIES, targetKept:ROWS, targetPlan:ENTRIES,
    portable:false, image:0, context:0, capturedContext:0, active:false, choice:"" }
  pure def safetyOf(st: State): bool = and {
    0 <= st.epoch and st.epoch <= MAX_EPOCH,
    st.floor == (if (st.phase == 2) st.epoch else st.epoch - 1),
    -1 <= st.floorBefore and st.floorBefore <= st.floor,
    Set(0, 1, 2).contains(st.phase), st.kept.subseteq(ROWS), st.plan.subseteq(ENTRIES),
    st.targetKept.subseteq(ROWS), st.targetPlan.subseteq(ENTRIES),
    closed(st.targetKept, st.portable),
    st.targetPlan == ENTRIES.filter(x => st.targetKept.contains(x)),
    st.plan.forall(x => st.kept.contains(x) and st.kept.contains(x + 1)),
    (st.phase < 2).implies(st.kept == ROWS and st.plan == ENTRIES and st.image == 0),
    (st.phase == 1).implies(st.active),
    (st.phase == 2).implies(st.kept == st.targetKept and st.plan == st.targetPlan and
      Set(1, 2).contains(st.image)),
    (st.choice == "original").implies(st.phase == 2 and st.image == 1 and st.context == st.capturedContext),
    (st.choice == "fresh").implies(not(st.active)),
    (st.choice == "refuse").implies(st.active),
  }
  val safety = safetyOf(s)
  val reachedRewrite = s.phase == 2 and s.plan.size() < 2
  val reachedPortablePin = s.phase == 2 and s.portable and s.kept == ROWS
  val reachedChangedSource = s.choice == "fresh" and s.context != s.capturedContext
  val neverRewrite = not(reachedRewrite)
  action init = s' = fresh(0)
  action prepare(keep: Set[int], portable: bool): bool = {
    val target = closure(keep, portable)
    all { s.phase == 0, keep.subseteq(ROWS),
    s' = s.with("phase", 1).with("targetKept", target)
      .with("targetPlan", ENTRIES.filter(x => target.contains(x)))
      .with("portable", portable).with("capturedContext", s.context).with("active", true).with("choice", ""),
    }
  }
  action commit = all { s.phase == 1,
    s' = s.with("phase", 2).with("floorBefore", s.floor).with("floor", s.epoch).with("kept", s.targetKept)
      .with("plan", s.targetPlan).with("image", 1).with("choice", ""),
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
    commit, finish, changeOtherSource, changeNativeImage, recover, crash, nextEpoch,
  }
  action unsafeFloorFirst = all { s.phase == 1,
    s' = s.with("phase", 2).with("floor", s.epoch).with("kept", s.targetKept).with("image", 1),
  }
  action unsafePlanFirst = all { s.phase == 1, s' = s.with("plan", s.targetPlan) }
  action unsafeNativeOnlyRecovery = all { s.phase == 2, s.image == 1,
    s' = s.with("choice", "original"),
  }
  action unsafeStep = any { step, unsafeFloorFirst, unsafePlanFirst, unsafeNativeOnlyRecovery }
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
    val st: State = { epoch:epoch, floor:if (phase == 2) epoch else epoch - 1, floorBefore:floorBefore,
      phase:phase, kept:kept, plan:plan, targetKept:targetKept, targetPlan:targetPlan,
      portable:portable, image:image, context:context, capturedContext:capturedContext,
      active:active, choice:choice }
    all { safetyOf(st), s' = st }
  }
  run rewriteAndCrashTest = init.then(prepare(Set(1), false)).then(crash).expect(s.plan == ENTRIES and safety)
    .then(commit).then(crash).then(recover).expect(s.plan == Set(1) and s.choice == "original" and safety)
  run portableConsumerPinsWholeChainTest = init.then(prepare(Set(2), true)).then(commit)
    .expect(s.kept == ROWS and s.plan == ENTRIES and safety)
  run sourceReleaseDropsCompletedEntriesTest = init.then(prepare(Set(), true)).then(commit)
    .expect(s.kept == Set() and s.plan == Set() and safety)
  run changedCompletedSourceStartsFreshTest = init.then(prepare(Set(1), false)).then(commit).then(finish)
    .then(changeOtherSource).then(recover).expect(s.choice == "fresh" and safety)
  run changedActiveSourceRefusesTest = init.then(prepare(Set(1), false)).then(commit)
    .then(changeOtherSource).then(recover).expect(s.choice == "refuse" and safety)
  run changedNativeTargetStartsFreshTest = init.then(prepare(Set(1), false)).then(commit).then(finish)
    .then(changeNativeImage).then(recover).expect(s.choice == "fresh" and safety)
  run floorFirstCounterexampleTest = init.then(prepare(Set(1), false)).then(unsafeFloorFirst).expect(not(safety))
  run planFirstCounterexampleTest = init.then(prepare(Set(1), false)).then(unsafePlanFirst).expect(not(safety))
  run nativeOnlyRecoveryCounterexampleTest = init.then(prepare(Set(1), false)).then(commit).then(finish)
    .then(changeOtherSource).then(unsafeNativeOnlyRecovery).expect(not(safety))
}

module nativeRetirementCustodySmall {
  import nativeRetirementCustodySpec(MAX_EPOCH = 3).* from "./native-retirement-custody"
}

module nativeRetirementCustody300 {
  import nativeRetirementCustodySpec(MAX_EPOCH = 299).* from "./native-retirement-custody"
  action epochCycle = prepare(Set(1), false).then(crash).then(commit).then(crash).then(recover).then(finish)
  run threeHundredEpochsTest = init.then(299.reps(_ => epochCycle.then(nextEpoch)))
    .then(epochCycle).expect(s.epoch == 299 and s.floor == 299 and s.plan == Set(1) and safety)
}
