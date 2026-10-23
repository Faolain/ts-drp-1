// MUTATION: the decided rules and R7 with today's classification window instead of W1. A scope e has a
// recovery trust only at install e+3 (prepareClosedJournalDetails reads authenticatedScopes from
// frame.recoveryTrusts), so it is classified there or never, with evidence from later scopes of the
// same image. Expected to fail g1NoLeak, noProtectedHole and noPlanRefusal.
module mutationTodayWindow {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: false, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  action installCrashA = install("A", none, false, true)

  // Three misses in a row: move 1 misses cut(1), replacements 3 and 5 miss cuts 2 and 3, replacement 7
  // lands in cut(4). Scope 1's only classification is install 4, before cut(4): it is kept for good.
  // Scope 2 is classified at install 5 and collected; pass 6 retires replacement 3 above the protected
  // source 1 (the contiguous watermark stays below it), and the plan write of install 7 refuses entry (1, 3).
  action tripleMissPrefix = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installA).then(seal(cut(7)))
  run tripleMissWedgeTest = tripleMissPrefix.then(installA)
    .expect(s.scopes.get("A") == Set(1, 3, 4, 5) and not(g1NoLeak) and safety)
    .then(seal(cut(8))).then(installA)
    .expect(s.retired.get("A").contains(3) and not(s.retired.get("A").contains(1)) and s.plan.get("A").get(1) == 3 and
      not(planSound) and not(noProtectedHole) and safety)
    .then(seal(cut(9))).then(installA)
    .expect(s.term.get("A") == "plan" and not(noPlanRefusal))
  // Offline across the window: the Writer installed epoch 2, the creator sealed epochs 2-4 without it;
  // catching up, scope 2's only classification (install 5) comes before any of its later fences lands.
  run offlineAcrossWindowLeaksTest = init.then(seal(none)).then(installA).then(seal(cut(0))).then(installA)
    .then(seal(none)).then(seal(none)).then(seal(none)).then(installA).then(installA).then(installA)
    .then(seal(cut(4))).then(installA).then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 5, 6, 7) and not(g1NoLeak) and not(noProtectedHole) and safety)
  // A crash between install and cleanup at scope 1's classification install (4): scope 1 is never
  // classified again.
  run crashAcrossWindowLeaksTest = init.then(seal(none)).then(installA)
    .then(move("A")).then(seal(cut(0))).then(installA).then(seal(cut(3))).then(installA)
    .then(seal(cut(4))).then(installCrashA).then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(1, 3, 4, 5) and not(g1NoLeak) and safety)
}

// Apalache (bounded, --step stepMacro): mutationTodayWindow at small bounds. Expected to violate g1NoLeak within
// 6 macro steps (a macro step is a seal followed by an install, or any single step).
module mutationTodayWindowApalache {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: false, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 8, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "../settlement-replacement-retirement"
}
