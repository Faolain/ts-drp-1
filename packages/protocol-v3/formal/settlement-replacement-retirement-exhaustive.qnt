// Track J: the exhaustive (TLC) instances of settlementReplacementRetirementSpec
// (settlement-replacement-retirement.qnt). `quint verify --backend tlc` (Apalache 0.56.1 translates the
// spec to TLA+; TLC explores every reachable state) checks each at bounds larger than Apalache's proof
// instances. Kept apart from the proof instances so that quint verify's serialised input stays small.

// Exhaustive (TLC) instances of the contract at larger bounds than the proof instances. Any delay: the
// safety class. One Writer, epochs 0-5 (room for a chain that misses two cuts to land and be collected),
// sequences 0-8, 2 moves; mismatches, partial receipt, rejoin, re-admission, a lagging prune, crashes.
module exhContractSafetyA5 {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 8, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = true, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
// The same under the stated delivery assumptions (fence pacing 2): every invariant.
module exhContractProgressA5 {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A"), MAX_EPOCH = 5, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 8, MAX_MOVES = 2,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 2, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
// Two Writers (received rows, B2, the carrier minus other authors' rows, re-admission of either), any
// delay: the safety class.
module exhContractSafetyAB {
  import settlementReplacementRetirementSpec(
    RULES = { outsideLocal: true, chain: true, recvB2: true, recvA2: false, r6a: true,
      minusOwn: true, minusOthers: true, fenceRule: true, w1: true, planDrop: "eitherGuarded",
      fenceFrontier: false, fenceReceipt: false, truthReceipt: false,
      carrierProof: true, expireDone: true,
      contract: "full", truthIntent: true, w1Volatile: false, oldInc: true, carrierLife: "consumers", iCommit: "atomic", readmitPolicy: "expire" },
    WRITERS = Set("A", "B"), MAX_EPOCH = 3, MAX_SCOPES = 3, G1_BOUND = 3, MAX_SEQ = 4, MAX_MOVES = 1,
    MAX_CRASH = 1, MAX_MISS = 9, FENCE_PACE = 9, LAG = 9, ALLOW_MISMATCH = false, ALLOW_LEAVE = false,
    FENCE_IN_CUT = false, ALLOW_PARTIAL = true, EXPIRE = false,
    REJOIN_K = 3, ALLOW_READMIT = true, MANUAL_REVIEW = false, PRUNE_LAG = true, ADJACENT_ONLY = true, READMIT_FRESH = true
  ).* from "./settlement-replacement-retirement"
}
