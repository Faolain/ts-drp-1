// MUTATION of Track X's completion contract (CONTRACT.md 3.2, D8): T without the old-incarnation clause.
// On the contract's same-replica re-admission (6.2; READMIT_FRESH false) the frontier restarts at
// admissionEpoch, so the old incarnation's fence 0, signed terminal by cut(1) before the removal, reads as
// not terminal after the re-admission install. Expected to fail tMonotone (I5).
//  controlNoOldIncFreshReplica  the same rule on the native path (a fresh replica, CONTRACT.md 1.4): the
//                               clause is inert there (the replica holds no old-incarnation row), and the
//                               schedule passes. A control: expected to hold.
module mutationContractNoOldIncarnation {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: false, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run noOldIncarnationTurnsFalseTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).expect(s.tSeen.get("A").contains(0) and tMonotone)
    .then(leave("A")).then(seal(none)).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.admitted.get("A") == 4 and not(tMonotone) and safety)
}
module controlNoOldIncFreshReplica {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: false, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run noOldIncFreshReplicaHoldsTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(leave("A")).then(seal(none)).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.admitted.get("A") == 4 and allInvariants and tMonotone)
    .then(move("A")).then(seal(cut(4))).then(installA).then(seal(cut(6))).then(installA).then(seal(cut(9)))
    .then(installA).then(prune("A"))
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(4)) and allInvariants and tMonotone)
}

// Apalache (bounded, --step stepMacro): expected to violate tMonotone within 5 macro steps.
module mutationContractNoOldIncarnationApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: false, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 4, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
