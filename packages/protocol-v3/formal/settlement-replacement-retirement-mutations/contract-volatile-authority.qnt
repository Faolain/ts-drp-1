// MUTATION: the scope's Cut authority kept in memory (Track X's S3, a8bfbe64) instead of durably (F2). A
// crash between install and cleanup loses it; after the restart a scope older than today's window is never
// classified again. The schedule: fences of epochs 1 and 2 miss their cuts, the fence of epoch 3 lands, and
// the Writer crashes at install 4, the install that would collect scope 1. At install 5 scope 2 is
// classified through today's window and collected, scope 1 never: protected with nothing needed.
//  mutationContractVolatileAuthority  the contract without F2: expected to fail g1NoLeak.
//  mutationW1VolatileAuthority        the decided rules with W1 as built (S3): expected to fail g1NoLeak.
module mutationContractVolatileAuthority {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: true, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  action installCrashA = install("A", none, false, true)
  run contractVolatileAuthorityLeaksTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(cut(2))).then(installCrashA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A").contains(1) and not(s.scopes.get("A").contains(2)) and
      not(g1NoLeak) and safety)
}

// Apalache (bounded, --step stepMacro): expected to violate g1NoLeak within 5 macro steps.
module mutationContractVolatileAuthorityApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: true, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}

// The decided rules with W1 as built (S3, kept authorities in memory): the same schedule leaks.
module mutationW1VolatileAuthority {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: true, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  action installCrashA = install("A", none, false, true)
  run w1VolatileAuthorityLeaksTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(cut(2))).then(installCrashA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A").contains(1) and not(g1NoLeak) and safety)
}
