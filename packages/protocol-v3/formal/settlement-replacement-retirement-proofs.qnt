// Track J: the Apalache proof instances of settlementReplacementRetirementSpec
// (settlement-replacement-retirement.qnt): small bounds, for the inductive proofs (init and indInit*,
// one step) and for bounded checks. Kept apart from the simulator instances so that quint verify's
// serialised input stays small (see settlement-replacement-retirement-instances.qnt).

// ---- Proof instances (Apalache) ---------------------------------------------------------------------
// The decided rules, R7 and W1 at small bounds, for the inductive proof of (a) and for bounded checking.
module proofSmallA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}
// The owner's (B) with W1, one Writer, the same bounds.
module proofSmallBA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "either",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}
// (B) with W1, two Writers (received rows, a leave), a smaller sequence range.
module proofSmallBAB {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "either",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}
// The decided rules, R7 and W1, one Writer, six epochs: room for a triple miss to land and be collected.
module proofA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}
// Safety under arbitrary delay (astra A5): no delivery assumption (every miss, fence and lag bound above
// MAX_EPOCH), partial cut receipt allowed. Only (a) safety is claimed here (indSafety, lemmas L0-L6);
// progress (G1, no terminal, maxScopes) needs the delivery assumptions and is not claimed.
module proofSafetyAnyDelayA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "either",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = true, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}

// Proof instances (Apalache). Safety under any delay: no delivery bound at all (no fence pacing, no lag
// bound, no chain bound), partial receipt, mismatches, rejoin, re-admission, a lagging prune; lemmas L0-L6.
module proofContractSafetyAnyDelayA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = true, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
// The same with manual review (pending reviews, resolutions in later epochs) and the other re-admission
// policy, H3 (ii) "preserve" (old-incarnation work exposed to the application).
module proofContractSafetyAnyDelayReviewA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "preserve" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run reviewAtSequenceBoundaryTest = init.then(seal(none)).then(installA)
    .then(seal(cut(0))).then(installA).then(seal(cut(1))).then(installA)
    .then(move("A")).then(move("A")).then(seal(cut(2)))
    .expect(s.next.get("A") == 5 and displacedCount(s, "A") == 2 and
      installEnabled(s, "A", none, false, false, false))
    .then(installA)
    .expect(s.next.get("A") == 6 and s.epoch.get("A") == 4 and indContract)
}
// The same with the expire policy.
module proofContractSafetyAnyDelayExpireA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = true,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run expiryAtSequenceBoundaryTest = init.then(seal(none)).then(installA)
    .then(seal(cut(0))).then(installA).then(seal(cut(1))).then(installA)
    .then(move("A")).then(move("A")).then(seal(cut(2)))
    .expect(s.next.get("A") == 5 and displacedCount(s, "A") == 2 and
      installEnabled(s, "A", none, false, false, false))
    .then(installA)
    .expect(s.next.get("A") == 6 and s.epoch.get("A") == 4 and indContract)
}
// Progress (every invariant) under the stated delivery assumptions, the proofSmallA bounds.
module proofContractSmallA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 4, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 6, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
// The contract's safety class under any delay, reduced so that Apalache's inductive step can finish per
// action family: epochs 0-3 (scope 0 is collected at install 3), sequences 0-4, 1 move, no manual review.
// Mismatches, partial receipt, rejoin, re-admission as a fresh replica, a lagging prune and crashes stay.
module proofContractSafetyReducedA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 3, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 4, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = true, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  // Regression for the 2026-10-22 failed induction: the old hypothesis admitted an epoch-zero fence
  // with an expiry entry. Such a row is unreachable. A mismatched install could replace that fence,
  // then skip the replacement's source in the non-fence census and violate policy derivation (C1).
  action impossibleEpochZeroFence = s' = s
    .with("rows", s.rows.set("A", s.rows.get("A").set(0, row(s, "A", 0).with("kind", "fence"))))
    .with("plan", s.plan.set("A", s.plan.get("A").set(0, -2)))
    .with("replOf", s.replOf.set("A", s.replOf.get("A").set(0, -2)))
  run impossibleFenceExcludedTest = init.then(move("A")).then(seal(Map("A" -> -1)))
    .then(impossibleEpochZeroFence)
    .expect(structureOf(s, "A") and safety and not(contractRowShapeOf(s, "A")) and not(indContract))
    .then(install("A", Map("A" -> -1), true, false))
    .expect(s.term.get("A") == "" and not(row(s, "A", 2).deriv))
  run reachableFenceShapeTest = init.then(move("A")).then(seal(Map("A" -> -1)))
    .expect(indContract)
    .then(install("A", Map("A" -> -1), false, false))
    .expect(contractRowShapeOf(s, "A") and indContract)
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  run readmissionAtSequenceBoundaryTest = init.then(seal(none)).then(installA)
    .then(move("A")).then(seal(Map("A" -> 0))).then(installA)
    .then(leave("A")).then(seal(none))
    .expect(s.next.get("A") == 4 and displacedCount(s, "A") == 1 and
      rejoinEnabled(s, "A", true, none, false))
    .then(rejoin("A", true, none, false))
    .expect(s.next.get("A") == 5 and s.epoch.get("A") == 3 and indContract)
}
