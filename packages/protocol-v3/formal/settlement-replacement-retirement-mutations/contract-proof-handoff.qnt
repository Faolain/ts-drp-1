// MUTATION of Track X's completion contract (astra H2): the membership proof of a scope (its F1 carrier and
// F2 authority) cleared with the scope (3.4 step 4 as drafted). Move 1 is a member of cut(1) with no plan
// entry. Install 4's J commit collects scope 1 and clears its proof; I (which runs after J's details are
// gone, one pass later as today, or after a crash between J and I) must re-derive Done(1) = in(1) and has no
// membership: T(1) holds but Settled(1) does not (a member has no entry). Row 1 is never retired.
// Expected to fail proofHeld at install 4, then iNoLeak at install 5. The candidates (carrierLife
// "consumers", the baseline; "handoff") pass the same schedule, also with a crash between J and I.
module mutationContractProofWithScope {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "scope", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run proofWithScopeLeaksTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(1)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(1)) and not(proofHeld) and safety)
    .then(seal(cut(4))).then(installA)
    .expect(s.term.get("A") == "" and not(s.retired.get("A").contains(1)) and not(iNoLeak) and safety)
}
module controlProofConsumers {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
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
  // A crash right after J's commit at install 4, a reopen, then the next install: I retires row 1.
  run proofConsumersCrashTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(1)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installMid("A", none, 2))
    .expect(not(s.scopes.get("A").contains(1)) and proofHeld and reachedProofAfterScope)
    .then(resume("A")).then(seal(cut(4))).then(installA)
    .expect(s.term.get("A") == "" and s.retired.get("A").contains(1) and allInvariants and contractInvariants)
}
module controlProofHandoff {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "handoff", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run proofHandoffCrashTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(1)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installMid("A", none, 2))
    .expect(not(s.scopes.get("A").contains(1)) and not(s.carrier.get("A").contains(1)) and proofHeld)
    .then(resume("A")).then(seal(cut(4))).then(installA)
    .expect(s.term.get("A") == "" and s.retired.get("A").contains(1) and allInvariants and contractInvariants)
}

// Apalache (bounded, --step stepMacro): expected to violate proofHeld within 5 macro steps.
module mutationContractProofWithScopeApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "scope", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
