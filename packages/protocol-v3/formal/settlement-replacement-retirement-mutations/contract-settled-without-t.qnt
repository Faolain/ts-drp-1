// MUTATION of Track X's completion contract (CONTRACT.md 3.2): Done(x) for an own outside row with
// Settled(x) and without T(x). The move misses cut(1) (its fence lands) and the fences of epochs 2 and 3
// miss cuts 2 and 3, which the pacing allows; the move's replacement is durable, so install 4 collects
// scope 1 before any signed cut makes the move terminal. Expected to fail safety. This failure is partly
// definitional: in the model a row of epoch e is never admitted by a later cut, so "needed until signed
// terminal" is the contract's truth (the creator's promise not to admit x), not a modelled late admission.
module mutationContractSettledWithoutT {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true,
      contract: "settledOnly", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers",
      iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run settledWithoutTDeletesTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(1)) and not(safety))
}

// Apalache (bounded, --step stepMacro): expected to violate safety within 5 macro steps. Install 4 issues
// its fence at sequence 6 and the chain's third link at 7, hence MAX_SEQ 7 (at 5 install 4 is never
// enabled: TLC's exhaustive run showed that).
module mutationContractSettledWithoutTApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true,
      contract: "settledOnly", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers",
      iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 7, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
