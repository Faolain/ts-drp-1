// Track J: the instances of settlementReplacementRetirementSpec (settlement-replacement-retirement.qnt)
// used by quint test, quint run (simulator, invariants and witnesses). The Apalache proof instances are in
// settlement-replacement-retirement-proofs.qnt; the mutation instances are in
// settlement-replacement-retirement-mutations/. The instances are kept out of the spec file because
// quint verify serialises every module of the main file and of every file it imports into one JSON
// string, and two dozen instances of the spec pass Node's maximum string length (quint then exits 0
// with no verdict).

// ---- Instances --------------------------------------------------------------------------------------
// The decided rules (rows 61-66), R7 and W1, one Writer: the deep run. Every invariant must hold.
// Three misses in a row, an offline Writer up to three seals behind, and a crash across the window.
module decidedW1A {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  action installCrashA = install("A", none, false, true)
  val healthy = allInvariants and noProtectedHole

  // R5 (row 62): the Writer moves during every seal; each move is replaced into the next cut with the
  // install's fence. Each scope with an outside move is collected once it leaves the replay window.
  run r5LateMoveEverySealTest = init.then(seal(none)).then(installA)
    .then(move("A")).then(seal(cut(0))).then(installA)
    .then(move("A")).then(seal(cut(3))).then(installA)
    .then(move("A")).then(seal(cut(6))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy and reachedLateMove)
    .then(seal(cut(8))).then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and s.wm.get("A") == 1)
  // R5-chain (row 65): the replacement misses cut(2) while the fence makes it; its own replacement
  // lands in cut(3). C1 collects scope 1 through the chain; piece (2) later empties the plan.
  run r5ChainDoubleMissTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy and reachedDoubleMiss)
    .then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA).then(seal(cut(8))).then(installA)
    .expect(s.scopes.get("A") == Set(5, 6, 7) and planEntries(s, "A") == Set() and healthy)
  // R6 (row 66): the whole install output of epoch 2 (fence and replacement) misses cut(2). At the next
  // install the census meets the completed source of epoch 1, older than the closed epoch 2, and R6-A
  // recognises it. C1 collects scope 1, and R7 then collects scope 2 (its outside fence).
  run r6WholeInstallOutputMissTest = init.then(seal(none)).then(installA).then(move("A"))
    .then(seal(cut(0))).then(installA).then(seal(none)).then(installA)
    .expect(s.term.get("A") == "" and s.epoch.get("A") == 3 and healthy)
    .then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy)
    .then(seal(cut(6))).then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedWholeInstallMiss)
  // A crash between install and cleanup at scope 1's classification install (4): W1 classifies it at 5.
  run crashAcrossWindowTest = init.then(seal(none)).then(installA)
    .then(move("A")).then(seal(cut(0))).then(installA).then(seal(cut(3))).then(installA)
    .then(seal(cut(4))).then(installCrashA)
    .expect(s.scopes.get("A") == Set(1, 2, 3, 4) and not(s.cleaned.get("A")) and healthy)
    .then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedCrashThenCleanup)
  // R7: the fence misses two cuts in a row (the later fence is late too); the third lands.
  run r7FenceDoubleMissTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(cut(2))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy)
    .then(seal(cut(3))).then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedFenceDoubleMiss)
    .then(seal(cut(4))).then(installA).then(seal(cut(5))).then(installA)
    .expect(s.wm.get("A") == 2 and healthy)
  // R7 with rows 65 and 66: the fence and a move miss cut(1), then the whole install output (fence and
  // replacement) misses cut(2); the second replacement and the third fence land in cut(3).
  run r7FenceMissWithChainTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(none))
    .then(installA).then(seal(none)).then(installA).then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy)
    .then(seal(cut(6))).then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedFenceAndChain and reachedFenceDoubleMiss)
    .then(seal(cut(7))).then(installA).then(seal(cut(8))).then(installA)
    .expect(planEntries(s, "A") == Set() and s.wm.get("A") == 5 and healthy)
  // R7 with a crash between install and cleanup while a fence is outside its cut.
  run r7FenceMissThenCrashTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(none))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installCrashA)
    .expect(s.scopes.get("A") == Set(1, 2, 3, 4) and healthy)
    .then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedCrashThenCleanup)
  // The no-R7 counterexample schedule (mutations/no-r7.qnt), healthy to the last epoch.
  run formerFenceCounterexampleTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(none))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy)
    .then(seal(cut(5))).then(installA).then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA)
    .expect(s.term.get("A") == "" and planEntries(s, "A") == Set() and healthy)
  // W1, three misses in a row: move 1 misses cut(1), replacements 3 and 5 miss cuts 2 and 3, and
  // replacement 7 lands in cut(4). Scope 1 is classified at install 5, after its window (install 4).
  action tripleMissPrefix = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installA).then(seal(cut(7)))
  run w1TripleMissTest = tripleMissPrefix.then(installA)
    .expect(s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedTripleMiss)
    .then(seal(cut(8))).then(installA).then(seal(cut(9))).then(installA).then(seal(cut(10))).then(installA)
    .expect(s.term.get("A") == "" and planEntries(s, "A") == Set() and s.scopes.get("A") == Set(6, 7, 8) and healthy)
  // W1, a Writer offline across the window: it installed epoch 2, then the creator sealed epochs 2, 3
  // and 4 without it (two seals behind at the last). Catching up, its fences of epochs 2-4 all miss;
  // the fence of epoch 5 lands, and scopes 2-4 are collected at installs 6 and 7.
  run w1OfflineAcrossWindowTest = init.then(seal(none)).then(installA).then(seal(cut(0))).then(installA)
    .then(seal(none)).then(seal(none)).then(seal(none)).then(installA).then(installA).then(installA)
    .expect(s.maxLag.get("A") == 2 and s.scopes.get("A") == Set(2, 3, 4, 5) and healthy)
    .then(seal(cut(4))).then(installA)
    .expect(s.scopes.get("A") == Set(4, 5, 6) and healthy and reachedOfflineAcrossWindow)
    .then(seal(cut(5))).then(installA)
    .expect(s.scopes.get("A") == Set(5, 6, 7) and healthy)
}

// The decided rules, R7 and W1, two Writers (one may leave for good).
module decidedW1AB {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
  pure def cut2(a: int, b: int): str -> int = Map("A" -> a, "B" -> b)
  pure val none2 = cut2(-1, -1)
  action installW(w: str): bool = install(w, none2, false, false)
  val healthy = allInvariants and noProtectedHole
  // R5b (row 64): Writer B moves during the seal of epoch 1 and Writer A admits it. A records its carrier
  // (subtracting B's row beyond B's signed frontier) and collects scope 1 once it installed past it; B
  // collects its own scope by R5.
  run r5bReceivedLateMoveTest = init.then(seal(none2)).then(installW("A")).then(installW("B"))
    .then(move("B")).then(seal(cut2(0, 0))).then(install("A", cut2(-1, 1), false, false)).then(installW("B"))
    .then(seal(cut2(1, 3))).then(installW("A")).then(installW("B")).then(seal(cut2(2, 4)))
    .then(installW("A")).then(installW("B"))
    .expect(s.recv.get("A").get(1) == cut2(-1, 1) and s.carrier.get("A").contains(1) and
      s.scopes.get("A") == Set(2, 3, 4) and s.scopes.get("B") == Set(2, 3, 4) and healthy)
  // Both Writers late in the same seal, each admitting the other's move.
  run twoWritersLateTest = init.then(seal(none2)).then(installW("A")).then(installW("B"))
    .then(move("A")).then(move("B")).then(seal(cut2(0, 0)))
    .then(install("A", cut2(-1, 1), false, false)).then(install("B", cut2(1, -1), false, false))
    .then(seal(cut2(3, 3))).then(installW("A")).then(installW("B")).then(seal(cut2(4, 4)))
    .then(installW("A")).then(installW("B"))
    .expect(reachedTwoWritersLate and s.scopes.get("A") == Set(2, 3, 4) and s.scopes.get("B") == Set(2, 3, 4) and
      healthy)
  // B2 when the author leaves before replacing: A still collects B's outside row.
  run receivedRowAuthorLeavesTest = init.then(seal(none2)).then(installW("A")).then(installW("B"))
    .then(move("B")).then(seal(cut2(0, 0))).then(install("A", cut2(-1, 1), false, false)).then(leave("B"))
    .then(seal(cut2(1, -1))).then(installW("A")).then(seal(cut2(2, -1))).then(installW("A"))
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy)
}

// Replacements whose operations differ from the policy derivation (decided rules, R7, W1).
module decidedW1Mismatch {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "pruned",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = true, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  // A replacement that is not the policy derivation is not evidence: the census refuses it, and the
  // source's scope is never collected.
  run mismatchedReplacementNotEvidenceTest = init.then(seal(none)).then(install("A", none, false, false))
    .then(move("A")).then(seal(cut(0))).then(install("A", none, true, false))
    .expect(s.term.get("A") == "mismatch" and s.scopes.get("A").contains(1) and safety)
}

// The owner's (B), approved only if the model clears it: piece (2) also drops a completed entry once its
// source or its replacement is logically retired; the census covers the source through the signed
// terminal frontier. With W1 (every invariant must hold) and with today's window (the census question).
module decidedW1PlanDropBA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "either",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}
module decidedW1PlanDropBAB {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "either",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = true, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
}
module todayPlanDropBA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: false, planDrop: "either",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: false, expireDone: false,
      contract: "", truthIntent: false, w1Volatile: false, oldInc: true, carrierLife: "", iCommit: "", readmitPolicy: "abandon" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 3, FENCE_PACE = 3, LAG = 3, ALLOW_MISMATCH = false, ALLOW_LEAVE = false, FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false,
    REJOIN_K = 0, ALLOW_READMIT = false, MANUAL_REVIEW = false, PRUNE_LAG = false, ADJACENT_ONLY = false, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  // The triple-miss schedule under today's window: scope 1 leaks, scope 2 is collected and replacement 3
  // retired, so (B) drops entry (1, 3). Source 1 is still held, but at or below the signed frontier
  // (replacement 7 landed), so the census reads it as terminal: no refusal and no plan wedge.
  run planDropBTripleMissTodayTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installA).then(seal(cut(7)))
    .then(installA).then(seal(cut(8))).then(installA)
    .expect(s.retired.get("A").contains(3) and not(s.retired.get("A").contains(1)) and s.plan.get("A").get(1) == 3)
    .then(seal(cut(9))).then(installA)
    .expect(s.plan.get("A").get(1) == -1 and s.term.get("A") == "" and noTerminal and not(g1NoLeak) and safety)
    .then(seal(cut(10))).then(installA)
    .expect(s.term.get("A") == "" and noTerminal and safety)
}

// ---- Track X's completion contract (CONTRACT.md draft, 2026-10-22; a PROPOSAL, not decided) ----------
// Done(x) = in(x) and installed > e; received outside and installed > e (B2); own outside, T(x) and
// Settled(x) (its 3.2). T is the cumulative per-author frontier of the installed Settle record, reset at
// the author's admissionEpoch, plus the old-incarnation clause. F1 = carrierProof (membership from the
// successor offer), F2 = w1 with a durable authority, expire is Settled (expireDone), the plan entry is
// dropped when either end is logically retired, and the truth is its I3 (truthIntent). Lifecycle: native
// adjacency (an ordinary install only at lag 1), rejoin through retained certificates up to K = 3, beyond K
// (or after a removal) a new incarnation, the physical prune lagging the logical retirement.
// Delivery assumptions (its 3.5): no chain bound (MAX_MISS above MAX_EPOCH); an attached Writer's fences
// miss at most FENCE_PACE = maxScopes - 1 = 2 cuts in a row (counting the cut an outside row missed, an own
// row lands within maxScopes cuts of it); a manual review is resolved within the same bound.
module contractA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  action installPartialA = installP("A", none, false, false, true)
  action installCrashA = install("A", none, false, true)
  val healthy = allInvariants and contractInvariants

  // A move and three replacements miss four cuts in a row (the decided rules allow three). Every fence
  // lands, so the move is terminal once cut(2) is known, and its replacement is durable: scope 1 is
  // collected at install 4, before its chain lands (in cut(5)). The chain is never walked.
  run contractQuadMissTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installA)
    .expect(s.scopes.get("A") == Set(2, 3, 4) and healthy and reachedCollectedBeforeLanding)
    .then(seal(cut(6))).then(installA).then(seal(cut(9))).then(installA).then(seal(cut(10))).then(installA)
    .then(prune("A"))
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(5, 6, 7) and healthy and reachedQuadMissCollected)
  // astra A1 under F1: every install misses a member of the cut it closes; scopes retire as with full receipt.
  run contractPartialReceiptTest = init.then(seal(none)).then(installPartialA).then(seal(cut(0))).then(installPartialA)
    .then(seal(cut(1))).then(installPartialA).then(seal(cut(2))).then(installPartialA).then(seal(cut(3)))
    .then(installPartialA)
    .expect(s.term.get("A") == "" and s.scopes.get("A") == Set(3, 4, 5) and healthy and reachedPartialCollected)
  // A crash between install and cleanup at the classification install: the next install collects.
  run contractCrashTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installCrashA)
    .expect(s.scopes.get("A").contains(1) and not(s.cleaned.get("A")))
    .then(seal(cut(6))).then(installA)
    .expect(not(s.scopes.get("A").contains(1)) and not(s.scopes.get("A").contains(2)) and healthy and
      reachedCrashThenCleanup)
  // Fences of two epochs in a row miss their cuts; the third lands. T covers both (R7 as a special case).
  run contractFenceDoubleMissTest = init.then(seal(none)).then(installA).then(seal(none)).then(installA)
    .then(seal(none)).then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installA)
    .expect(healthy and reachedFenceDoubleMiss)
  // Offline for two seals with an outside move, then a rejoin in place (lag 3 <= K): one install of the
  // latest successor replaces the move; its scope is collected once the rejoin fence lands.
  run contractRejoinInPlaceTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(seal(none)).then(seal(none)).then(rejoin("A", false, none, false))
    .expect(s.epoch.get("A") == 4 and s.scopes.get("A") == Set(1, 4) and s.plan.get("A").get(1) == 3 and healthy)
    .then(seal(cut(3))).then(installA)
    .expect(not(s.scopes.get("A").contains(1)) and healthy and reachedRejoinInPlace)
  // Removal, then re-admission (natively a fresh replica, CONTRACT.md 1.4): admissionEpoch 4, an empty
  // store, sequences restarting (row 4 is the new incarnation's sequence 0, the old fence 0's native
  // sequence). The old replica's rows are abandoned with it; the new scopes retire as usual.
  run contractReadmitTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0))).then(installA)
    .then(leave("A")).then(seal(none)).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.admitted.get("A") == 4 and s.incStart.get("A") == 4 and s.scopes.get("A") == Set(4) and
      s.term.get("A") == "" and healthy and reachedSeqCollision)
    .then(move("A")).then(seal(cut(4))).then(installA).then(seal(cut(6))).then(installA).then(seal(cut(9)))
    .then(installA).then(prune("A"))
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(4)) and healthy and reachedReadmitCollected)
  // The physical prune lags: logically retired rows stay present, their entries are dropped, and the
  // census reads them as terminal.
  run contractPruneLagTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(4))).then(installA).then(seal(cut(6)))
    .then(installA).then(seal(cut(8))).then(installA)
    .expect(reachedRetiredPresent and s.plan.get("A").get(1) == -1 and healthy)
    .then(seal(cut(10))).then(installA).then(prune("A"))
    .expect(s.term.get("A") == "" and healthy)
  // H2 under the baseline (carrierLife "consumers"): move 1 is a member of cut(1); a crash right after J's
  // commit at install 4 (scope 1 collected), a reopen, then I retires row 1 with the proof still held.
  run contractCrashBetweenJAndITest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(1)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installMid("A", none, 2))
    .expect(not(s.scopes.get("A").contains(1)) and proofHeld and reachedProofAfterScope)
    .then(resume("A")).then(seal(cut(4))).then(installA)
    .expect(s.retired.get("A").contains(1) and not(s.carrier.get("A").contains(1)) and healthy and
      reachedMemberRetiredAfterCrash)
  // H5 under the baseline (iCommit "atomic"): a crash after I's commit, a reopen; no stale plan.
  run contractCrashInIStepTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .then(seal(cut(5))).then(installMid("A", none, 3)).then(resume("A"))
    .expect(s.retired.get("A").contains(1) and s.plan.get("A").get(1) == -1 and healthy)
  // H3 (i), the baseline: the fresh replica's re-admission expires the old incarnation's unfinished work
  // (replacement 3, outside cut(2), lived only in the old replica).
  run contractReadmitExpiresTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(leave("A")).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.replOf.get("A").get(3) == -2 and healthy and reachedOldWorkExpired)
}
// H3 (ii): re-admission preserves the old incarnation's unfinished work and exposes it to the application,
// which resolves it in the new incarnation (here by a replacement row, then by expiry).
module contractPreserveA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "preserve" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  val healthy = allInvariants and contractInvariants
  run contractPreserveResolvedTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(leave("A")).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.exposed.get("A") == Set(3) and s.replOf.get("A").get(3) == -3 and healthy)
    .then(resolve("A", 3, false))
    .expect(s.replOf.get("A").get(3) == 5 and s.exposed.get("A") == Set() and healthy and reachedExposedResolved)
    .then(seal(cut(5))).then(installA).then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(3)) and healthy)
  run contractPreserveExpiredTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(leave("A")).then(seal(none)).then(rejoin("A", true, none, false))
    .then(resolve("A", 3, true))
    .expect(s.replOf.get("A").get(3) == -2 and s.exposed.get("A") == Set() and healthy)
}
// astra A2 under the contract: the expire policy, an expired outside move is completed work.
module contractExpireA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = true,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run contractExpiredOutsideTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).then(seal(cut(2))).then(installA).then(seal(cut(3))).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(1)) and allInvariants and contractInvariants and
      reachedExpiredCollected)
}
// Manual review: every displaced move waits for the application (Settled false until resolved).
module contractReviewA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  // The review is resolved by a replacement row in epoch 2; the move's scope is collected once T and the
  // replacement are known.
  run contractReviewResolvedTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0)))
    .then(installA).expect(s.plan.get("A").get(1) == -3)
    .then(resolve("A", 1, false)).then(seal(cut(3))).then(installA).then(seal(cut(4))).then(installA)
    .expect(not(s.scopes.get("A").contains(1)) and allInvariants and contractInvariants and reachedReviewCollected)
}
// The either-drop schedule (mutations/contract-either-drop-review.qnt) under the baseline drop rule
// (candidate (b), "eitherGuarded"), with the review bound off: the issuance retirement keeps replacement 4
// while [1 -> 4] is live, so the entry stays and scope 1 is collected once the second review is resolved.
module contractGuardedDropA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run guardedDropCollectsTest = init.then(seal(none)).then(installA).then(move("A")).then(move("A")).then(seal(cut(0)))
    .then(installA).then(resolve("A", 1, false)).then(seal(cut(4))).then(installA).then(seal(cut(5))).then(installA)
    .then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA)
    .expect(s.retired.get("A").contains(3) and not(s.retired.get("A").contains(4)))
    .then(seal(cut(8))).then(installA).expect(s.plan.get("A").get(1) == 4)
    .then(resolve("A", 2, true)).then(seal(cut(9))).then(installA)
    .expect(s.term.get("A") == "" and not(s.scopes.get("A").contains(1)) and allInvariants and contractInvariants)
}
// The contract's own proposal for re-admission (its 6.2): the same replica continues as a new incarnation
// (natively impossible today, CONTRACT.md 1.4). The old-incarnation clause is what keeps its old rows
// terminal once its frontier restarts at admissionEpoch.
module contractSameReplicaA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = false
  ).* from "./settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  val healthy = allInvariants and tMonotone
  // Removal, then re-admission of the same replica: admissionEpoch 4, the frontier reset; the old rows are
  // terminal by the old-incarnation clause, the unsent replacement is expired, and the old scopes retire.
  run sameReplicaReadmitTest = init.then(seal(none)).then(installA).then(move("A")).then(seal(cut(0))).then(installA)
    .then(leave("A")).then(seal(none)).then(seal(none)).then(rejoin("A", true, none, false))
    .expect(s.admitted.get("A") == 4 and s.plan.get("A").get(3) == -2 and s.term.get("A") == "" and healthy)
    .then(seal(cut(4))).then(installA).then(prune("A"))
    .expect(s.term.get("A") == "" and healthy and reachedReadmitCollected)
}
// The contract, two Writers (received outside rows by B2, removal and re-admission), partial receipt.
module contractAB {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 6, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
// The contract with injected mismatched replacements: safety must hold (the census refuses the mismatch).
module contractMismatchA {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = true, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
