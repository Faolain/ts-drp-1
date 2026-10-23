// MUTATION of Track X's completion contract (astra H5): I's logical retirement and the plan rewrite that
// drops the entries naming retired work (3.4 steps 2-3) as two commits, with a crash between them. Move 1
// misses cut(1); its replacement 3 lands in cut(2); scope 1 is collected at install 4 and, at install 5, I
// retires row 1 and drops [1 -> 3].
//  mutationContractRetireFirst  the retirement commits, the crash comes before the plan rewrite: the stored
//                               plan names retired row 1, and on reopen the store's admission check refuses
//                               (IS:1652-1653). Expected to fail noPlanRefusal.
//  mutationContractPlanFirst    the plan rewrite commits first: [1 -> 3] is gone while row 1 is not retired;
//                               on reopen Settled(1) needs that entry, so row 1 is never retired. Expected to
//                               fail iNoLeak.
// The baseline (iCommit "atomic", one commit) passes the same schedule (controlAtomicCommit).
module mutationContractRetireFirst {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "retireFirst",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run retireFirstWedgesTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .expect(not(s.scopes.get("A").contains(1)))
    .then(seal(cut(5))).then(installMid("A", none, 3))
    .expect(s.retired.get("A").contains(1) and s.plan.get("A").get(1) == 3 and not(planSound))
    .then(resume("A"))
    .expect(s.term.get("A") == "plan" and not(noPlanRefusal) and safety)
}
module mutationContractPlanFirst {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "planFirst",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run planFirstLeaksTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .then(seal(cut(5))).then(installMid("A", none, 3))
    .expect(not(s.retired.get("A").contains(1)) and s.plan.get("A").get(1) == -1)
    .then(resume("A"))
    .expect(s.term.get("A") == "" and not(s.retired.get("A").contains(1)) and not(iNoLeak) and safety)
}
module controlAtomicCommit {
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
  run atomicCommitTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .then(seal(cut(5))).then(installMid("A", none, 3)).then(resume("A"))
    .expect(s.term.get("A") == "" and s.retired.get("A").contains(1) and s.plan.get("A").get(1) == -1 and
      allInvariants and contractInvariants)
}

// Apalache (bounded, --step stepMacro): expected to violate noPlanRefusal within 7 macro steps.
module mutationContractRetireFirstApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "retireFirst",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}

// Apalache (bounded, --step stepMacro): expected to violate iNoLeak within 7 macro steps.
module mutationContractPlanFirstApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "planFirst",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
