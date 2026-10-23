// MUTATION: R5 without the chain (row 65): an outside replacement's own replacement is not followed.
// Expected to fail g1NoLeak, noProtectedHole and then noPlanRefusal.
module mutationR5WithoutChain {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: false, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
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
  // The replacement of move 1 misses cut(2); its replacement lands in cut(3). Scope 1 leaks; scope 2 is
  // collected, so replacement 3 is retired above protected source 1 and the plan wedges.
  run doubleMissLeaksAndWedgesTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A").contains(1) and not(g1NoLeak) and safety)
    .then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA)
    .expect(not(planSound) and not(noProtectedHole))
    .then(seal(cut(8))).then(installA)
    .expect(s.term.get("A") == "plan" and not(noPlanRefusal))
}

// Apalache (bounded, --step stepMacro): mutationR5WithoutChain at small bounds. Expected to violate g1NoLeak within
// 5 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationR5WithoutChainApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: false, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 7, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
