// Fence misses beyond maxScopes under W1 (Track X's limit), and three remedies. The decided rules, R7 and
// W1, one Writer, maxScopes 3. The schedule: a slow installer whose fence misses every cut (it installs
// epoch e after adoption and the creator seals e before the fence arrives). R7 never fires, so every
// scope from the first miss on stays protected until the install after the 4th miss holds 4 and refuses.
//  limitR7NoPacing             no creator-side pacing: expected to FAIL withinMaxScopes.
//  limitPacingBeyondMaxScopes  remedy (a), pacing bound 4 > maxScopes: expected to FAIL withinMaxScopes.
//  remedyPacing                remedy (a), pacing bound 3 = maxScopes: the creator holds the 4th seal for
//                              the fence; the schedule is impossible and the decided instance passes.
//  remedyFrontierNoPacing      remedy (b), the signed per-author frontier (cut membership) covers the
//                              fence: the same as R7, expected to FAIL withinMaxScopes.
//  remedyReceiptNoPacing       remedy (c), a signed receipt frontier covers the fence: expected to PASS
//                              every invariant, with the receipt ground truth.
//  remedyReceiptR7Truth        remedy (c) judged by R7's ground truth (a fence is needed until a later own
//                              fence is in a signed cut): expected to FAIL safety.
module limitR7NoPacing {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 9, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  // Fences of epochs 1-4 all miss their cuts; install 5 holds scopes 1-4 and refuses.
  run slowInstallerRefusesTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(1, 2, 3, 4) and safety)
    .then(seal(none)).then(installA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
}
module limitPacingBeyondMaxScopes {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 4, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  // Four misses are within the pacing bound; the install after them refuses before the 5th seal.
  run pacingFourMissesRefusesTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes))
}
module remedyPacing {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  // After three misses the creator holds the next seal until the fence arrives (the front holds it), so
  // the 4th seal cannot miss it; R7 then collects scopes 1-3.
  run pacingHoldsFourthSealTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(none)).fail()
  run pacingThenR7CollectsTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(Map("A" -> 3))).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(3, 4, 5) and allInvariants and noProtectedHole)
}
module remedyFrontierNoPacing {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: true, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 9, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  // No later cut holds any row of this Writer (its first row of each epoch is the fence that missed), so
  // no signed frontier covers a missed fence: the same refusal as R7.
  run frontierSlowInstallerRefusesTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "scopes" and not(withinMaxScopes) and safety)
}
module remedyReceiptNoPacing {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: true, truthReceipt: true,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 9, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  val healthy = allInvariants and noProtectedHole
  // Every fence misses its cut and reaches the creator before the next seal, whose receipt frontier
  // covers it: each scope is collected once it leaves the replay window, through the last epoch.
  run receiptSlowInstallerTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy)
    .then(seal(none)).then(installA).then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA)
    .expect(s.epoch.get("A") == 8 and s.scopes.get("A") == Set(6, 7, 8) and healthy)
}
module remedyReceiptR7Truth {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: true, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 9, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  action installA = install("A", none, false, false)
  // Receipt collects scope 1 at install 4, while no later fence of the Writer is in any signed cut.
  run receiptCollectsUnsettledFenceTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(none)).then(installA)
    .expect(not(s.scopes.get("A").contains(1)) and not(safety))
}

// Apalache (bounded, --step stepMacro): limitR7NoPacing at small bounds. Expected to violate withinMaxScopes within
// 5 macro steps (a macro step is a seal followed by an install, or any single step).
module limitR7NoPacingApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 5, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 9, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
