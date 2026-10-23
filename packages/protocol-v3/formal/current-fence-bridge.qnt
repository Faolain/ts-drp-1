// Check the projection relation on the actual finite Track J transition system.
// This reachable-state check is separate from an arbitrary-state refinement
// proof, and uses the legacy adjacent/expire instance, not new gap reattachment.
module currentFenceBridge {
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
  pure def currentFenceOf(st: State): bool = WRITERS.forall(w => st.epoch.get(w) > 0 implies and {
    issued(st, w, st.start.get(w)),
    row(st, w, st.start.get(w)).kind == "fence",
    row(st, w, st.start.get(w)).ep == st.epoch.get(w),
  })
  val currentFence = currentFenceOf(s)
  type Projected = {epoch:int, start:int, next:int, rows:int -> {ep:int, kind:str}, assigned:Set[int]}
  pure def project(st: State, w: str): Projected = {epoch:st.epoch.get(w), start:st.start.get(w), next:st.next.get(w),
    rows:SEQS.mapBy(q => {ep:row(st, w, q).ep, kind:row(st, w, q).kind}),
    assigned:SEQS.filter(q => st.replOf.get(w).get(q) != -1)}
  var prior: str -> Projected
  pure def relates(a: Projected, b: Projected): bool = or {
    a == b,
    and { a.epoch == b.epoch, a.start == b.start, b.next == a.next + 1,
      SEQS.forall(q => if (q == a.next) b.rows.get(q).ep == a.epoch and Set("move", "repl").contains(b.rows.get(q).kind)
        else b.rows.get(q) == a.rows.get(q)),
    },
    and { b.epoch > a.epoch, b.start == a.next, b.next > b.start,
      SEQS.forall(q => if (q == a.next) b.rows.get(q) == {ep:b.epoch, kind:"fence"}
        else if (q > a.next and q < b.next) b.rows.get(q) == {ep:b.epoch, kind:"repl"}
        else b.rows.get(q) == a.rows.get(q)),
    },
  }
  pure def ageRelates(a: Projected, b: Projected): bool = or {
    a.epoch == b.epoch and a.next == b.next and a.assigned == b.assigned and
      SEQS.forall(q => a.rows.get(q).ep == b.rows.get(q).ep),
    and { a.epoch == b.epoch, b.next == a.next + 1, a.assigned == b.assigned,
      SEQS.forall(q => b.rows.get(q).ep == (if (q == a.next) a.epoch else a.rows.get(q).ep)),
    },
    and { b.epoch > a.epoch, b.next > a.next, a.assigned.subseteq(b.assigned),
      b.assigned.exclude(a.assigned).forall(q => q < a.next),
      SEQS.forall(q => b.rows.get(q).ep == (if (q >= a.next and q < b.next) b.epoch else a.rows.get(q).ep)),
    },
  }
  pure def sourceAgeOf(st: State): bool = WRITERS.forall(w => SEQS.forall(q =>
    st.replOf.get(w).get(q) != -1 implies row(st, w, q).ep < st.epoch.get(w)))
  val sourceAge = sourceAgeOf(s)
  val projectedStep = WRITERS.forall(w => relates(prior.get(w), project(s, w)))
  val projectedAgeStep = WRITERS.forall(w => ageRelates(prior.get(w), project(s, w)))
  val issuedRowEpochBound = WRITERS.forall(w => SEQS.forall(q => issued(s, w, q) implies
    (0 <= row(s, w, q).ep and row(s, w, q).ep <= s.epoch.get(w))))
  val bridgeSafety = projectedStep and projectedAgeStep and currentFence and sourceAge and issuedRowEpochBound
  action bridgeInit = all { init, prior' = WRITERS.mapBy(_ =>
    {epoch:0, start:0, next:0, rows:SEQS.mapBy(_ => {ep:-1, kind:"none"}), assigned:Set()}),
  }
  action bridgeStep = all { step, prior' = WRITERS.mapBy(w => project(s, w)) }
}
