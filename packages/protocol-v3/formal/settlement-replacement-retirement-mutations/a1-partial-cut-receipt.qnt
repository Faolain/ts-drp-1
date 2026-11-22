// MUTATION (astra A1, native counterexample): partial cut receipt. A Writer installs each epoch without
// ever receiving one member of the cut it closes (a creator row); the snapshot install succeeds. Its own
// graph cannot equal the cut's commitment, the R5/R5b candidates only subtract rows, so no closed-
// membership carrier is recorded and the scope is never collectible. No row is late and nothing is needed.
// Expected to fail g1NoLeak, then withinMaxScopes (natively install 9 at maxScopes 7; here install 4 at 3),
// under today's window (Track X's head) and under W1 alike.
//  candidateCarrierProof: the astra action (membership evidence that does not need every member), a
//  candidate pending Track X's completion contract, not a decided rule. Expected to PASS.
module mutationPartialReceiptToday {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: false, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installPartialA = installP("A", none, false, false, true)
  action installA = install("A", none, false, false)
  // Every fence makes its cut and there is no play; each install misses one member of the cut it closes.
  run partialReceiptLeaksTest = init.then(seal(none)).then(installPartialA).then(seal(cut(0))).then(installPartialA)
    .then(seal(cut(1))).then(installPartialA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(0, 1, 2, 3) and not(g1NoLeak) and safety)
    .then(seal(cut(2))).then(installPartialA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
  // The control: the same schedule with every member received stays healthy.
  run fullReceiptControlTest = init.then(seal(none)).then(installA).then(seal(cut(0))).then(installA)
    .then(seal(cut(1))).then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(3, 4, 5) and allInvariants and noProtectedHole)
}
module mutationPartialReceiptW1 {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installPartialA = installP("A", none, false, false, true)
  run partialReceiptLeaksUnderW1Test = init.then(seal(none)).then(installPartialA).then(seal(cut(0))).then(installPartialA)
    .then(seal(cut(1))).then(installPartialA).then(seal(cut(2))).then(installPartialA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
}
module candidateCarrierProof {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installPartialA = installP("A", none, false, false, true)
  run partialReceiptWithProofTest = init.then(seal(none)).then(installPartialA).then(seal(cut(0))).then(installPartialA)
    .then(seal(cut(1))).then(installPartialA).then(seal(cut(2))).then(installPartialA).then(seal(cut(3)))
    .then(installPartialA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(3, 4, 5) and allInvariants and noProtectedHole)
}

// Apalache (bounded, --step stepMacro): partial receipt under today's window at small bounds. Expected to
// violate g1NoLeak within 3 macro steps.
module mutationPartialReceiptTodayApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: false, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 3, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 3, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
