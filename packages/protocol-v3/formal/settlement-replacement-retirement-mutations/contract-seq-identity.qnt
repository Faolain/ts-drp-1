// MUTATION (Track X, CONTRACT.md 1.4): own rows identified by (author, sequence) only. A re-admitted
// Writer is a fresh replica whose sequences restart at 0, and the snapshot it installs holds its earlier
// incarnation's cut members. Fence 0 and move 1 of the first incarnation are members of cut(1); the fresh
// replica's fence 3 and move 4 have native sequences 0 and 1. Reading their epoch through (author, sequence),
// the old-incarnation clause finds the earlier rows (epoch 1 < admissionEpoch 3) and reads both as signed
// terminal, so install 6 collects scope 3 while no signed cut covers them. Expected to fail safety: the
// old-incarnation clause depends on identity including the incarnation (today: the digest match). The
// schedule has no fence delivery bound (FENCE_PACE 9), as for the safety-only proof.
module mutationContractSeqIdentity {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true,
      contract: "seqIdentity", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers",
      iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run seqIdentityAliasesTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(1)))
    .then(installA).then(leave("A")).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.incStart.get("A") == 3 and s.admitted.get("A") == 3 and reachedSeqCollision)
    .then(move("A")).then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(3)) and not(safety))
}
module controlSeqIdentityDigest {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  // The same schedule with identity by (author, incarnation, sequence): scope 3 is kept, safety holds.
  run digestIdentityKeepsTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(1)))
    .then(installA).then(leave("A")).then(seal(none)).then(rejoin("A", true, none, false))
    .then(move("A")).then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A").contains(3) and safety)
}

// Apalache (bounded, --step stepMacro): expected to violate safety within 7 macro steps.
module mutationContractSeqIdentityApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true,
      contract: "seqIdentity", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers",
      iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 4, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
