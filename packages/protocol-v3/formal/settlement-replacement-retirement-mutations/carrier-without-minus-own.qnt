// MUTATION: the carrier without piece (1) of row 62: the closed-membership candidate is the whole graph,
// so it matches the cut's commitment only when the Writer has no own row outside the cut and the carrier
// is otherwise never recorded. Expected to fail g1NoLeak.
module mutationCarrierWithoutMinusOwn {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: false, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
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
  run lateMoveWithoutCarrierLeaksTest = init.then(seal(none)).then(installA).then(move("A"))
    .then(seal(cut(0))).then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .expect(not(s.carrier.get("A").contains(1)) and s.scopes.get("A").contains(1) and not(g1NoLeak) and safety)
}

// Apalache (bounded, --step stepMacro): mutationCarrierWithoutMinusOwn at small bounds. Expected to violate g1NoLeak within
// 5 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationCarrierWithoutMinusOwnApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: false, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
