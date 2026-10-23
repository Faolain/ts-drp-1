// MUTATION of candidate (b), "eitherGuarded" (CONTRACT.md 3.6, A-1), as an implementation might first write
// it: the guard judged against the candidates of the step instead of the rows the step actually retires.
// A-1 says a replacement y stays unless the entry's source "is retired in the same step"; along a chain of
// replacements that is a fixpoint. The chain: move 1 -> replacement 4 (epoch 2, reviewed) -> replacement 6
// (epoch 3, reviewed, a member of cut(3)); move 2's review is pending, so scope 1 is held. At install 7 the
// one-pass guard keeps 4 (its source 1 is not a candidate) but retires 6 (its source 4 is a candidate),
// and the either drop removes [4 -> 6]. Once review 2 expires and row 1 is retired, row 4 has no entry:
// Settled(4) is false for good and row 4 is never retired. Expected to fail iNoLeak (a leak, not a loss:
// 4's intent is in cut(3)). The fixpoint guard (the baseline, controlGuardFixpoint) keeps 6 until 4 goes.
// The review bound is off (FENCE_PACE 9).
module mutationGuardOnePass {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuardedOnePass", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 9, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run guardOnePassLeaksTest = init.then(seal(none)).then(installA).then(move("A")).then(move("A")).then(seal(cut(0)))
    .then(installA).then(resolve("A", 1, false)).then(seal(cut(3))).then(installA).then(resolve("A", 4, false))
    .then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA).then(seal(cut(8))).then(installA)
    .then(seal(cut(9))).then(installA)
    .expect(s.retired.get("A").contains(6) and s.plan.get("A").get(4) == -1 and not(s.retired.get("A").contains(4)))
    .then(resolve("A", 2, true)).then(seal(cut(10))).then(installA).then(seal(cut(11))).then(installA)
    .expect(s.term.get("A") == "" and s.retired.get("A").contains(1) and not(s.retired.get("A").contains(4)) and
      not(iNoLeak) and safety and noIntentLoss)
}
module controlGuardFixpoint {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 9, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 14, MAX_MOVES = 3,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false, REJOIN_K = 3, ALLOW_READMIT = true,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
  pure val none = Map("A" -> -1)
  pure def cut(f: int): str -> int = Map("A" -> f)
  action installA = install("A", none, false, false)
  run guardFixpointCollectsTest = init.then(seal(none)).then(installA).then(move("A")).then(move("A")).then(seal(cut(0)))
    .then(installA).then(resolve("A", 1, false)).then(seal(cut(3))).then(installA).then(resolve("A", 4, false))
    .then(seal(cut(6))).then(installA).then(seal(cut(7))).then(installA).then(seal(cut(8))).then(installA)
    .then(seal(cut(9))).then(installA)
    .expect(not(s.retired.get("A").contains(6)) and s.plan.get("A").get(4) == 6)
    .then(resolve("A", 2, true)).then(seal(cut(10))).then(installA).then(seal(cut(11))).then(installA)
    .expect(s.term.get("A") == "" and s.retired.get("A").contains(4) and s.retired.get("A").contains(6) and
      allInvariants and contractInvariants)
}

// Exhaustive (TLC) versions: the bounds the schedules above need and no more (9 epochs, sequences 0-12, 2
// moves; no crash, partial receipt, rejoin or re-admission), so that every reachable state is explored.
//  mutationGuardOnePassSmall  expected to fail iNoLeak.
//  controlGuardFixpointSmall  the fixpoint guard (the baseline): expected to hold every invariant.
module mutationGuardOnePassSmall {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuardedOnePass", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 9, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 12, MAX_MOVES = 2,
    MAX_CRASH = 0, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
module controlGuardFixpointSmall {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true, minusOwn: true,
      minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded", fenceFrontier: false,
      fenceReceipt: false, truthReceipt: false, carrierProof: true, expireDone: true, contract: "full",
      truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic",
      readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 9, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 12, MAX_MOVES = 2,
    MAX_CRASH = 0, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = false, EXPIRE = false, REJOIN_K = 0, ALLOW_READMIT = false,
    MANUAL_REVIEW = true, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "../settlement-replacement-retirement"
}
