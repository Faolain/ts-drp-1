// MUTATION of Track X's completion contract (CONTRACT.md): the contract without F1. The membership carrier
// is still recorded only when the Writer's own graph equals the cut's commitment, so a Writer that never
// receives one member of each cut it closes (astra A1) records no carrier, and Done for members is never
// reached. Expected to fail g1NoLeak, then withinMaxScopes at install 4: F1 is what removes A1.
module mutationContractWithoutF1 {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: false, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  action installPartialA = installP("A", none, false, false, true)
  run contractWithoutF1LeaksTest = init.then(seal(none)).then(installPartialA).then(seal(cut(0))).then(installPartialA)
    .then(seal(cut(1))).then(installPartialA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(0, 1, 2, 3) and not(g1NoLeak) and safety)
    .then(seal(cut(2))).then(installPartialA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
}

// Apalache (bounded, --step stepMacro): expected to violate g1NoLeak within 3 macro steps.
module mutationContractWithoutF1Apalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: false, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 3, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 3, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
