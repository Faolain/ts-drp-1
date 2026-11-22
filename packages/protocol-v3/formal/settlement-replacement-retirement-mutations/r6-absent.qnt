// MUTATION: R6 absent (row 66): the census recognises a completed replacement only for a source of the
// immediately closed epoch (deriveOwnedReplacement resolves only that epoch's ACL). Expected to fail
// noCensusRefusal.
module mutationR6Absent {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: false,
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
  // The whole install output of epoch 2 misses cut(2); the install of epoch 3 meets completed source 1 of
  // epoch 1, older than the closed epoch 2, and refuses on every retry.
  run wholeInstallOutputMissRefusesTest = init.then(seal(none)).then(installA).then(move("A"))
    .then(seal(cut(0))).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "census" and not(noCensusRefusal) and safety)
}

// Apalache (bounded, --step stepMacro): mutationR6Absent at small bounds. Expected to violate noCensusRefusal within
// 4 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationR6AbsentApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: false,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 3, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
