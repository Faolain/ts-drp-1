// A scoped repair of the contract induction hypothesis, without changing the
// production transition system or the earlier finite-check source hashes.
// The missing fact is the existence of the currently installed epoch's fence:
// install/fresh readmission writes it before move can issue an application row.
// Keep its own base/preservation obligation separate from contract induction.
module proofContractCurrentFence {
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
  action installA = install("A", Map("A" -> -1), false, false)

  pure def currentFenceOf(st: State): bool = WRITERS.forall(w => st.epoch.get(w) > 0 implies and {
    issued(st, w, st.start.get(w)),
    row(st, w, st.start.get(w)).kind == "fence",
    row(st, w, st.start.get(w)).ep == st.epoch.get(w),
  })
  val currentFence = currentFenceOf(s)
  val indContractFenced = indContract and currentFence
  action indInitContractFenced = anyState(st => indContractOf(st) and currentFenceOf(st))
  // Its own induction assumes only this law (within anyState's finite field
  // domains), so an unproved contract hypothesis cannot justify the addition.
  action indInitFence = anyState(currentFenceOf)

  run installedFenceExistsTest = init.then(seal(Map("A" -> -1))).then(installA)
    .expect(currentFence and indContractFenced)
  run missingCurrentFenceRejectedTest = init.then(seal(Map("A" -> -1))).then(installA)
    .then(all { s' = s.with("next", Map("A" -> s.start.get("A"))) })
    .expect(not(currentFence))
}
