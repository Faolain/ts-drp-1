// MUTATION of Track X's completion contract (CONTRACT.md): the contract without Settled for expire. The
// census and the journal reader still recognise only a replacement (today's D1), so under the expire policy
// the classification hold of the scope with the expired outside move refuses at install 4 (astra A2).
// Expected to fail noCensusRefusal: Settled(expire) is what removes A2.
module mutationContractWithoutExpireSettled {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: false, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = true, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run contractWithoutExpireSettledRefusesTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "census" and not(noCensusRefusal) and safety)
}

// Apalache (bounded, --step stepMacro): expected to violate noCensusRefusal within 5 macro steps.
module mutationContractWithoutExpireSettledApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: false, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = true, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
