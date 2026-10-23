// MUTATION: R5 without R5b (row 64): a received outside row is never collectible, and the carrier does
// not subtract other authors' rows beyond their signed frontiers. Expected to fail g1NoLeak.
module mutationR5WithoutR5b {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: false, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: false, fenceRule: true, w1: true, planDrop: "pruned",
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
  // Writer A admits B's move made during the seal of epoch 1: A's scope 1 is never collected.
  run receivedLateMoveLeaksTest = init.then(seal(none2)).then(installW("A")).then(installW("B"))
    .then(move("B")).then(seal(cut2(0, 0))).then(install("A", cut2(-1, 1), false, false)).then(installW("B"))
    .then(seal(cut2(1, 3))).then(installW("A")).then(installW("B")).then(seal(cut2(2, 4)))
    .then(installW("A")).then(installW("B"))
    .expect(s.scopes.get("A").contains(1) and not(s.scopes.get("B").contains(1)) and not(g1NoLeak) and safety)
}

// Apalache (bounded, --step stepMacro): mutationR5WithoutR5b at small bounds. Expected to violate g1NoLeak within
// 6 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationR5WithoutR5bApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: false, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: false, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
