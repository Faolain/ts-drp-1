// Scoped ordinary issue path: no plan/effect; an initial full authenticated
// capture established the quoted image and size. Native counter semantics,
// no wrap, BEGIN IMMEDIATE exclusion, private connection ownership, and schema
// rejection of mutating triggers are premises, not consequences of this model.
module issuanceQuoteCurrency {
  type State = { stage:str, birth:bool, dataVersion:int, changes:int,
    quotedVersion:int, quotedChanges:int, control:int, quotedControl:int,
    lineage:str, ownedLineage:str, incarnation:int, ownedIncarnation:int,
    unexpected:int, crypto:bool }
  var s: State
  pure def counters(st: State): bool = st.dataVersion == st.quotedVersion and st.changes == st.quotedChanges
  pure def exact(st: State): bool = counters(st) and st.control == st.quotedControl and
    st.lineage == st.ownedLineage and st.incarnation == st.ownedIncarnation
  pure def safetyOf(st: State): bool = st.crypto implies
    (st.unexpected == 0 and exact(st) and st.lineage == "entered")
  val safety = safetyOf(s)
  val neverCrypto = not(s.crypto)
  action init = {
    nondet birth = Set(false, true).oneOf()
    nondet lineage = Set("none", "reserved", "entered").oneOf()
    all { birth.implies(lineage == "none"),
      s' = {stage:"captured", birth:birth, dataVersion:0, changes:0, quotedVersion:0, quotedChanges:0,
        control:0, quotedControl:0, lineage:lineage, ownedLineage:lineage, incarnation:0, ownedIncarnation:0,
        unexpected:0, crypto:false},
    }
  }
  // A phase writes the pending marker and bumps retirement (2 rows), plus one
  // initial control row when needed. The exact own-DML count is checked before
  // carrying that postimage across the COMMIT/BEGIN gap.
  action reserve(extra: int): bool = all { s.stage == "captured",
    val expected = (if (s.lineage == "none") 2 else 0) + (if (s.birth) 1 else 0)
    val lineage = if (s.lineage == "none") "reserved" else s.lineage
    val control = s.control + (if (expected > 0) 1 else 0)
    s' = s.with("changes", s.changes + expected + extra).with("quotedChanges", s.quotedChanges + expected)
      .with("control", control).with("quotedControl", control).with("lineage", lineage).with("ownedLineage", lineage)
      .with("stage", if (extra == 0) "reserved-gap" else "refused")
      .with("unexpected", s.unexpected + extra),
  }
  action enterWithDelta(extra: int): bool = all { s.stage == "reserved-gap",
    val marker = if (s.ownedLineage == "entered") 0 else 1
    s' = if (exact(s)) s.with("changes", s.changes + 2 * marker + extra).with("quotedChanges", s.quotedChanges + 2 * marker)
      .with("control", s.control + marker).with("quotedControl", s.quotedControl + marker)
      .with("lineage", "entered").with("ownedLineage", "entered")
      .with("unexpected", s.unexpected + extra).with("stage", if (extra == 0) "entered-gap" else "refused")
      else s.with("stage", "refused"),
  }
  action enter = enterWithDelta(0)
  action admitCrypto = all { s.stage == "entered-gap",
    s' = if (exact(s) and s.lineage == "entered") s.with("crypto", true).with("stage", "crypto")
      else s.with("stage", "refused"),
  }
  pure def gap(st: State): bool = Set("reserved-gap", "entered-gap").contains(st.stage)
  // A row mutation need not change the observed lineage or control. Every
  // foreign commit changes data_version; every same-connection DML increments
  // total_changes. Logical rollback still increments that latter counter.
  action mutate(foreign: bool, kind: str): bool = all { gap(s), s.unexpected < 2,
    s' = s.with("dataVersion", s.dataVersion + (if (foreign) 1 else 0))
      .with("changes", s.changes + (if (foreign) 0 else 1)).with("unexpected", s.unexpected + 1)
      .with("control", if (kind == "control") s.control + 1 else s.control)
      .with("lineage", if (kind == "lineage") "foreign" else s.lineage)
      .with("incarnation", if (kind == "incarnation") s.incarnation + 1 else s.incarnation),
  }
  action step = any { admitCrypto,
    { nondet extra = Set(0, 1).oneOf() any { reserve(extra), enterWithDelta(extra) } },
    { nondet foreign = Set(false, true).oneOf() nondet kind = Set("row", "control", "lineage", "incarnation").oneOf()
      mutate(foreign, kind) },
  }
  action unsafeRebaseline = all { gap(s),
    s' = s.with("quotedVersion", s.dataVersion).with("quotedChanges", s.changes)
      .with("quotedControl", s.control).with("ownedLineage", s.lineage).with("ownedIncarnation", s.incarnation),
  }
  action unsafeSkipCurrency = all { s.stage == "entered-gap", s' = s.with("crypto", true).with("stage", "crypto") }
  action unsafeStep = any { step, unsafeRebaseline, unsafeSkipCurrency }
  run exactOwnPhasesReachCryptoTest = init.then(reserve(0)).then(enter).then(admitCrypto).expect(s.crypto and safety)
  run reservedForeignRowChangeRefusesTest = init.then(reserve(0)).then(mutate(true, "row")).then(enter)
    .expect(s.stage == "refused" and not(s.crypto) and safety)
  run reservedSameConnectionChangeRefusesTest = init.then(reserve(0)).then(mutate(false, "row")).then(enter)
    .expect(s.stage == "refused" and safety)
  run enteredForeignControlChangeRefusesTest = init.then(reserve(0)).then(enter).then(mutate(true, "control"))
    .then(admitCrypto).expect(s.stage == "refused" and safety)
  run enteredSameConnectionLineageChangeRefusesTest = init.then(reserve(0)).then(enter).then(mutate(false, "lineage"))
    .then(admitCrypto).expect(s.stage == "refused" and safety)
  run unexpectedOwnDmlDeltaRefusesTest = init.then(reserve(1)).expect(s.stage == "refused" and safety)
  run unexpectedEnteringDmlDeltaRefusesTest = init.then(reserve(0)).then(enterWithDelta(1)).expect(s.stage == "refused" and safety)
  run rebaselineForeignMutationCounterexampleTest = init.then(reserve(0)).then(mutate(true, "row"))
    .then(unsafeRebaseline).then(enter).then(admitCrypto).expect(not(safety))
  run skipEnteredCurrencyCounterexampleTest = init.then(reserve(0)).then(enter).then(mutate(false, "row"))
    .then(unsafeSkipCurrency).expect(not(safety))
}
