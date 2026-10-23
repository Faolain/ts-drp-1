// CONTROL (expected to PASS every invariant): the decided rules without R7, on schedules where every
// seal holds each live Writer's fence of that epoch (the creator seals only after the Writer installed
// and its fence arrived). The no-R7 failures therefore come from the fence missing the cut.
module controlFenceInCut {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: false, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = true, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  val healthy = allInvariants and noProtectedHole
  // The no-R7 counterexample's schedule with the fence of epoch 1 in cut(1); the move is still outside.
  run fenceInCutControlTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .expect(healthy and s.scopes.get("A") == Set(2, 3, 4))
    .then(seal(cut(5))).then(installA).then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA)
    .expect(healthy and s.term.get("A") == "" and planEntries(s, "A") == Set())
}

// The same control with two Writers.
module controlFenceInCutAB {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: false, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = true, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
