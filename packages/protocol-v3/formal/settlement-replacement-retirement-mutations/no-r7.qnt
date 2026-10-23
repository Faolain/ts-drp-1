// MUTATION: the decided rules of rows 61-66 without R7 (no rule for an own fence outside its cut).
// Expected to fail g1NoLeak, noProtectedHole, noPlanRefusal and withinMaxScopes. This is the
// counterexample Track J found to the rules as first decided; R7 (2026-10-22) answers it.
module mutationNoR7 {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: false, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)

  // The Writer's install fence for epoch 1 is still in flight when the creator seals epoch 1, and its
  // move during that seal is outside cut(1) too. The move is replaced into cut(2), so rows 62-66 accept
  // it, but no rule accepts the outside fence: scope 1 stays protected for good.
  action fenceMissPrefix = init.then(seal(none)).then(installA).then(move("A"))
    .then(seal(none)).then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4)))
  run fenceMissLeaksScopeCounterexampleTest = fenceMissPrefix.then(installA)
    .expect(s.scopes.get("A").contains(1) and not(g1NoLeak) and safety and noTerminal)
  // Two installs later the replacement row 3 is logically retired (scope 2 collected, then the
  // issuance pass), but its source row 1 sits above the fence's hole at row 0, so the contiguous
  // watermark never prunes it and piece (2) never drops entry (1, 3): every plan write now refuses.
  run fenceMissWedgesPlanCounterexampleTest = fenceMissPrefix.then(installA).then(seal(cut(5)))
    .then(installA).then(seal(cut(6))).then(installA)
    .expect(s.wm.get("A") == -1 and s.retired.get("A").contains(3) and not(s.retired.get("A").contains(1)) and
      s.plan.get("A").get(1) == 3 and not(planSound) and not(noProtectedHole) and safety)
    .then(seal(cut(7))).then(installA).expect(s.term.get("A") == "plan" and not(noPlanRefusal))
  // A fence missing two cuts in a row leaks two scopes; with maxScopes 3 the next install refuses.
  run fenceMissesExceedMaxScopesCounterexampleTest = init.then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(cut(2)))
    .then(installA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
}

// Apalache (bounded, --step stepMacro): mutationNoR7 at small bounds. Expected to violate g1NoLeak within
// 4 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationNoR7Apalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: false, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
