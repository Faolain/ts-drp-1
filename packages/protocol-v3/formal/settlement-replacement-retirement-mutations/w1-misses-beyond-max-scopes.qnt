// LIMIT (expected to fail withinMaxScopes): W1 is bounded by maxScopes. The decided rules, R7 and W1,
// with a delivery bound looser than the journal bound: a chain may miss MAX_MISS = 4 cuts against
// maxScopes 3. Every scope from the first miss to the last is protected until the chain lands, so the
// install after the 4th miss holds 4 protected scopes and refuses. Natively (maxScopes 7) the same
// shape needs 8 misses in a row.
module limitW1MissesBeyondMaxScopes {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 4, FENCE_PACE = 4, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  // The Writer installed epoch 1, the creator sealed epochs 1-4 without hearing from it again; back
  // online, it moves in epoch 1 and catches up. The move and its replacements miss cuts 1-4.
  run fourMissesRefuseTest = init.then(seal(none)).then(installA).then(seal(cut(0))).then(seal(none))
    .then(seal(none)).then(seal(none)).then(move("A")).then(installA).then(installA).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(1, 2, 3, 4))
    .then(installA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
}

// Apalache (bounded, --step stepMacro): limitW1MissesBeyondMaxScopes at small bounds. Expected to violate withinMaxScopes within
// 6 macro steps (a macro step is a seal followed by an install, or any single step).
module limitW1MissesBeyondMaxScopesApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 4, FENCE_PACE = 4, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
