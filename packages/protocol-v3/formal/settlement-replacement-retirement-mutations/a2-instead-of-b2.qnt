// MUTATION: option A2 instead of B2 for row 64: a received outside row is collectible only once its
// author's replacement lands in a cut. When the author leaves (or crashes for good) before replacing,
// the row's scope is protected for good. Expected to fail g1NoLeak.
module mutationA2InsteadOfB2 {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: false, recvA2: true, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure def cut2(a: int, b: int): str -> int = Map("A" -> a, "B" -> b)
  pure val none2 = cut2(-1, -1)
  action installW(w: str): bool = install(w, none2, false, false)
  run authorLeavesBeforeReplacingLeaksTest = init.then(seal(none2)).then(installW("A")).then(installW("B"))
    .then(move("B")).then(seal(cut2(0, 0))).then(install("A", cut2(-1, 1), false, false)).then(leave("B"))
    .then(seal(cut2(1, -1))).then(installW("A")).then(seal(cut2(2, -1))).then(installW("A"))
    .expect(s.scopes.get("A").contains(1) and not(g1NoLeak) and safety)
}

// Apalache (bounded, --step stepMacro): mutationA2InsteadOfB2 at small bounds. Expected to violate g1NoLeak within
// 7 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationA2InsteadOfB2Apalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: false, recvA2: true, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
