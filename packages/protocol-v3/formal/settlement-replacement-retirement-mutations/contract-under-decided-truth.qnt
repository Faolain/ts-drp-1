// DECISION CHECK (not a library bug): Track X's completion contract judged by the ground truth of the
// decided rows 62 and 65, "an outside move or replacement is needed until its derivation-equal replacement
// chain lands in a signed cut". The contract deletes a source once it is signed terminal and its
// replacement is durable, before the chain lands. Expected to fail safety: this is the change to rows
// 62/65 that the contract asks the owner to approve (its 3.2). Under the contract's own truth (I3, no
// intent loss: contractA) every invariant holds.
module contractUnderDecidedTruth {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  // The move (row 1) and its replacements 3 and 5 miss cuts 1-3; scope 1 is collected at install 4 while
  // replacement 7 (epoch 4) is not yet sealed.
  run contractCollectsBeforeLandingTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(1)) and not(safety) and reachedCollectedBeforeLanding)
}

// Apalache (bounded, --step stepMacro): expected to violate safety within 5 macro steps.
module contractUnderDecidedTruthApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 7, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
