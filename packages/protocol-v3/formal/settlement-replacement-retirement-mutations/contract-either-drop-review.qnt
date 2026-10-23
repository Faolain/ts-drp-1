// COUNTEREXAMPLE to Track X's completion contract as drafted (its 3.4 step 3 with 3.1 Settled): the
// unguarded "either" drop. Per-scope collection lets a later scope go first while an earlier scope is held
// by a pending manual review. Scope 1 holds move 1 (reviewed, resolved by replacement 4 in epoch 2, a member
// of cut(2)) and move 2 (review pending). Scope 2 is collected at install 5 and replacement 4 retired at
// install 6; the "either" drop removes [1 -> 4] at install 7. When the review of move 2 is resolved,
// Settled(1) needs a complete entry with a durable replacement, which is gone for good: scope 1 is never
// collected, although nothing in it is needed (move 1's intent is in cut(2), move 2 expired).
//  contractEitherDropLeak  "either": expected to fail g1NoLeak (then the journal bound).
//  candidateSourceDrop     drop [x -> y] only when x is retired (candidate (a)): I retires replacement 4,
//                          the entry [1 -> 4] stays, and the store refuses that plan write at install 7:
//                          expected to fail noPlanRefusal.
// The baseline, candidate (b) "eitherGuarded", passes the same schedule (contractGuardedDropA in the model).
// The review bound is off (FENCE_PACE above MAX_EPOCH): the application resolves the review after its
// scope's successors were collected.
module contractEitherDropLeak {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "either", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run eitherDropLeaksTest = init.then(seal(none)).then(installA).then(move("A")).then(move("A")).then(seal(cut(0)))
    .then(installA).expect(s.plan.get("A").get(1) == -3 and s.plan.get("A").get(2) == -3)
    .then(resolve("A", 1, false)).then(seal(cut(4))).then(installA).then(seal(cut(5))).then(installA)
    .then(seal(cut(6))).then(installA)
    .expect(s.scopes.get("A").contains(1) and not(s.scopes.get("A").contains(2)) and allInvariants)
    .then(seal(cut(7))).then(installA).expect(s.retired.get("A").contains(4))
    .then(seal(cut(8))).then(installA).expect(s.plan.get("A").get(1) == -1 and s.term.get("A") == "")
    .then(resolve("A", 2, true)).then(seal(cut(9))).then(installA)
    .expect(s.term.get("A") == "" and s.scopes.get("A").contains(1) and not(g1NoLeak) and safety)
}
module candidateSourceDrop {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "source", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run sourceDropWedgesTest = init.then(seal(none)).then(installA).then(move("A")).then(move("A")).then(seal(cut(0)))
    .then(installA).then(resolve("A", 1, false)).then(seal(cut(4))).then(installA).then(seal(cut(5))).then(installA)
    .then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA)
    .expect(s.term.get("A") == "plan" and not(noPlanRefusal) and safety)
}

// Exhaustive (TLC) versions: the bounds the schedules above need and no more (8 epochs, sequences 0-10, 2
// moves; no crash, partial receipt, rejoin or re-admission), so that every reachable state is explored.
//  contractEitherDropLeakSmall  expected to fail g1NoLeak.
//  candidateSourceDropSmall     expected to fail noPlanRefusal.
//  controlGuardedDropSmall      the baseline A-1 ("eitherGuarded"): expected to hold every invariant.
module contractEitherDropLeakSmall {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "either", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 0, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
module candidateSourceDropSmall {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "source", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 0, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
module controlGuardedDropSmall {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 8, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 10, MAX_MOVES = 2,
    MAX_CRASH = 0, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
