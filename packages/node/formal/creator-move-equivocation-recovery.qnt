// Creator move equivocation after a stale restore: recovery (design under review, 2026-11-11).
//
// Two incarnations of the one creator key: O (the original device) and R (a copy restored from an
// older backup). Both sign creator moves from the same restore point, so creator author slots
// overlap: O's slot s and R's slot s are distinct creator-signed vertices. Members admit any
// authenticated vertex whose dependencies they hold, so they hold both copies; a member's close graph
// requires unique slots only for its own author (v3-live.ts ~21500), and install keeps the closed
// epoch's extra vertices out of the successor projection. Both copies carry the same key: no member
// can tell the incarnations apart. The only arbiter every member applies identically is the
// finality-signed cut of the creator that closes the epoch.
//
// Today (integration-7, tests/creator-move-equivocation-probe.test.ts): R's received-append
// maintenance trial close throws "creator issuance-frontier author slot is ambiguous" on O's copy,
// which then sits in R's pending ingress under R's own author; every later cold-path issue at R
// throws ("prospective runtime census has unresolved ingress"), nothing evicts it, and R is refused
// by the restore gate besides: the room stalls for good (control parkOwn).
//
// Rule under test (SOUND, "the live incarnation's chain is canonical"):
//   R1 R never indexes or parks a vertex under its own key that it did not sign: it verifies the
//      signature and keeps it as superseded-incarnation evidence (knownO), outside its graph and
//      outside pending ingress. A member move that depends on one never enters R's graph.
//   R2 R re-issues each verified O operation on its own chain (same operation bytes, so the same
//      (author, clientOperationId): members' chat window collapses the copies), at its own next
//      sequences. Its lineage only moves by one, so it signs over O's later slots too; that is a
//      further duplicate only members hold, which the cut resolves. Once every known O operation is
//      re-issued R's next sequence is above every O slot it knows, so the restore gate's rule
//      (refuse while a member holds sequence >= next) is satisfied: R is current again.
//   R3 R closes only after every known O operation is re-issued. Its cut is its own graph. Members
//      install it; their own moves outside the cut are re-offered by the existing displaced-move
//      settlement (same operation payload, up to 4 epochs).
//   R4 O (if it is in fact still running) halts issuing and sealing once it sees a vertex under its
//      own key that it did not sign. This cannot prevent a split when O hears nothing (witnessed
//      residual wSplitWhenOriginalUnaware), which is why automatic resume rests on "restoring from a
//      backup retires the original device".
//
// Properties (SOUND):
//   convergence          every member that installed shows the same state (the cut's operations)
//   closeNotBlocked      R's close never meets two creator vertices at one slot
//   issueNotBlocked      R is never stuck unable to issue after it sees O's vertices
//   cutClosed            the cut is causally closed
//   memberWorkKept       every member move in R's graph is in the cut (the rest are re-offered)
//   creatorOpsConserved  every operation R signed and every O operation R verified is in the cut
//   evidenceGenuine      R acts only on genuine creator-signed O vertices (a forged or unsigned
//                        claim cannot inject, exclude or re-sequence creator operations)
//   reissuedOnlyGenuine  every re-issued operation comes from a genuine O vertex
//   currentAfterCatchUp  once every known O operation is re-issued, R's next slot is above every
//                        O slot it knows (the restore gate no longer refuses on them)
//   noKnowingSplit       O never closes an epoch after seeing R's vertex
// Broken controls (each violates the property in brackets):
//   parkOwn           today's ingress: O's copy parks in R's own pending ingress [issueNotBlocked]
//   admitOriginal     R admits O's vertices into its graph            [closeNotBlocked]
//   excludeDivergence the close voids R's divergent chain and dependents [memberWorkKept]
//   noReissue         R closes without re-issuing O's operations     [creatorOpsConserved]
//   trustForged       an unsigned claim counts as an O vertex         [evidenceGenuine, reissuedOnlyGenuine]
//   memberLocalChoice a member keeps its own creator copies, not the cut [convergence]
//   admitDependents   R admits a member move whose O parent it lacks  [cutClosed]
//   noOriginalHalt    a live O keeps sealing after it sees R's vertex [noKnowingSplit]
// Residuals (witnessed): an O vertex no member delivers to R before the close is dropped at install
// (wResidualLostOriginal); a live O that never hears of R closes too (wSplitWhenOriginalUnaware).
module creatorMoveEquivocationRecovery {
  pure val MAX_V = 9
  pure val MEMBERS = Set("M1", "M2")
  pure val O_SLOTS = 2        // O signs at most this many slots after the restore point
  pure val R_SLOTS = 5        // R's chain length bound
  pure val R_PROVISIONAL = 2  // R signs at most this many fresh slots before it learns of O
  pure val MEMBER_MOVES = 2

  type Vertex = { author: str, slot: int, op: int, deps: Set[int], genuine: bool }
  type Mutants = { parkOwn: bool, admitOriginal: bool, excludeDivergence: bool, noReissue: bool, trustForged: bool,
                   memberLocalChoice: bool, admitDependents: bool, noOriginalHalt: bool }
  pure val SOUND: Mutants = { parkOwn: false, admitOriginal: false, excludeDivergence: false, noReissue: false,
                              trustForged: false, memberLocalChoice: false, admitDependents: false, noOriginalHalt: false }

  var mu: Mutants
  var vs: int -> Vertex
  var nextId: int
  var oTip: int               // 0 = the restore point (common prefix)
  var rTip: int
  var held: str -> Set[int]   // M1, M2, R: admitted vertices
  var rPhase: str             // "off" (before the restore) | "open" | "closed"
  var oAlive: bool            // O keeps running after R reopens (misconfiguration)
  var oHalted: bool
  var oClosed: bool
  var oClosedKnowing: bool    // O closed after it had seen an R vertex
  var knownO: Set[int]        // O vertices R verified (superseded-incarnation evidence)
  var reissued: Set[int]      // op ids R re-issued
  var memberMoves: int
  var blockedIssues: int
  var blockedCloses: int
  var cut: Set[int]
  var installed: str -> Set[int]  // a member's installed state: operation ids

  pure def isCreator(v: Vertex): bool = v.author == "O" or v.author == "R"
  pure def slotOf(m: int -> Vertex, id: int): int = if (id == 0) 0 else m.get(id).slot
  pure def opsOf(m: int -> Vertex, ids: Set[int]): Set[int] = ids.map(i => m.get(i).op)
  pure def maxSlot(m: int -> Vertex, ids: Set[int]): int = ids.fold(0, (acc, i) => if (m.get(i).slot > acc) m.get(i).slot else acc)
  // Every vertex in `base` and every vertex depending on one (ids grow along dependencies).
  pure def closure(m: int -> Vertex, base: Set[int]): Set[int] =
    range(1, MAX_V + 1).foldl(base, (acc, i) =>
      if (m.keys().contains(i) and m.get(i).deps.intersect(acc) != Set()) acc.union(Set(i)) else acc)
  pure def hasCreatorDuplicate(m: int -> Vertex, ids: Set[int]): bool =
    ids.exists(i => ids.exists(j => i != j and isCreator(m.get(i)) and isCreator(m.get(j)) and m.get(i).slot == m.get(j).slot))

  action initWith(m: Mutants): bool = all {
    mu' = m, vs' = Map(), nextId' = 1, oTip' = 0, rTip' = 0,
    held' = Set("M1", "M2", "R").mapBy(_ => Set()), rPhase' = "off", oAlive' = false, oHalted' = false,
    oClosed' = false, oClosedKnowing' = false, knownO' = Set(), reissued' = Set(), memberMoves' = 0,
    blockedIssues' = 0, blockedCloses' = 0, cut' = Set(), installed' = MEMBERS.mapBy(_ => Set()),
  }
  // The simulator explores every variant at once; Apalache runs one variant per init (--init).
  action init = all {
    nondet m = oneOf(Set(SOUND,
      { ...SOUND, parkOwn: true }, { ...SOUND, admitOriginal: true }, { ...SOUND, excludeDivergence: true },
      { ...SOUND, noReissue: true }, { ...SOUND, trustForged: true }, { ...SOUND, memberLocalChoice: true },
      { ...SOUND, admitDependents: true }, { ...SOUND, noOriginalHalt: true }))
    initWith(m)
  }
  action initSound = initWith(SOUND)
  action initParkOwn = initWith({ ...SOUND, parkOwn: true })
  action initAdmitOriginal = initWith({ ...SOUND, admitOriginal: true })
  action initExcludeDivergence = initWith({ ...SOUND, excludeDivergence: true })
  action initNoReissue = initWith({ ...SOUND, noReissue: true })
  action initTrustForged = initWith({ ...SOUND, trustForged: true })
  action initMemberLocalChoice = initWith({ ...SOUND, memberLocalChoice: true })
  action initAdmitDependents = initWith({ ...SOUND, admitDependents: true })
  action initNoOriginalHalt = initWith({ ...SOUND, noOriginalHalt: true })

  // O signs its next slot (before the restore, or after it while it still runs and has not halted).
  action oSigns = all {
    rPhase == "off" or (oAlive and not(oHalted) and not(oClosed)),
    nextId <= MAX_V, slotOf(vs, oTip) < O_SLOTS,
    vs' = vs.put(nextId, { author: "O", slot: slotOf(vs, oTip) + 1, op: nextId,
                           deps: if (oTip == 0) Set() else Set(oTip), genuine: true }),
    nextId' = nextId + 1, oTip' = nextId,
    mu' = mu, rTip' = rTip, held' = held, rPhase' = rPhase, oAlive' = oAlive, oHalted' = oHalted, oClosed' = oClosed,
    oClosedKnowing' = oClosedKnowing, knownO' = knownO, reissued' = reissued, memberMoves' = memberMoves,
    blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // The stale copy reopens from the restore point; O is retired, or (misconfiguration) still running.
  action restore = all {
    rPhase == "off",
    nondet alive = Set(false, true).oneOf()
    oAlive' = alive,
    rPhase' = "open",
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, oHalted' = oHalted,
    oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, knownO' = knownO, reissued' = reissued,
    memberMoves' = memberMoves, blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut,
    installed' = installed,
  }

  // parkOwn (today): an O copy R received sits in its own pending ingress; every issue then fails.
  def rParked: bool = mu.parkOwn and knownO != Set()

  action rSignsOp(op: int): bool = all {
    rPhase == "open", nextId <= MAX_V, slotOf(vs, rTip) < R_SLOTS,
    nondet extra = held.get("R").filter(i => not(isCreator(vs.get(i)))).union(Set(0)).oneOf()
    if (rParked) all {
      vs' = vs, held' = held, nextId' = nextId, rTip' = rTip, blockedIssues' = blockedIssues + 1,
    } else all {
      vs' = vs.put(nextId, { author: "R", slot: slotOf(vs, rTip) + 1, op: if (op == 0) nextId else op,
                             deps: (if (rTip == 0) Set() else Set(rTip)).union(if (extra == 0) Set() else Set(extra)),
                             genuine: true }),
      held' = held.setBy("R", s => s.union(Set(nextId))),
      nextId' = nextId + 1, rTip' = nextId, blockedIssues' = blockedIssues,
    },
    mu' = mu, oTip' = oTip, rPhase' = rPhase, oAlive' = oAlive, oHalted' = oHalted, oClosed' = oClosed,
    oClosedKnowing' = oClosedKnowing, knownO' = knownO, memberMoves' = memberMoves, blockedCloses' = blockedCloses,
    cut' = cut, installed' = installed,
  }

  // R signs a fresh creator move (before it knows of O, at most R_PROVISIONAL of them; after, freely).
  action rSigns = all {
    knownO != Set() or slotOf(vs, rTip) < R_PROVISIONAL,
    rSignsOp(0), reissued' = reissued,
  }

  // R re-issues one verified O operation on its own chain.
  action rReissues = all {
    knownO != Set(),
    nondet o = knownO.oneOf()
    all {
      not(reissued.contains(vs.get(o).op)), rSignsOp(vs.get(o).op),
      reissued' = if (rParked) reissued else reissued.union(Set(vs.get(o).op)),
    },
  }

  // A member receives any vertex whose dependencies it holds (any order, either copy).
  action memberReceives = all {
    vs.keys() != Set(),
    nondet m = MEMBERS.oneOf()
    nondet v = vs.keys().oneOf()
    all {
      rPhase != "closed", vs.get(v).genuine, not(held.get(m).contains(v)), vs.get(v).deps.subseteq(held.get(m)),
      held' = held.setBy(m, s => s.union(Set(v))),
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, oAlive' = oAlive,
      oHalted' = oHalted, oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, knownO' = knownO,
      reissued' = reissued, memberMoves' = memberMoves, blockedIssues' = blockedIssues,
      blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
    },
  }

  // A member moves on top of one vertex it holds (and its own previous moves).
  action memberIssues = all {
    rPhase != "closed", nextId <= MAX_V, memberMoves < MEMBER_MOVES,
    nondet m = MEMBERS.oneOf()
    nondet on = held.get(m).union(Set(0)).oneOf()
    val own = held.get(m).filter(i => vs.get(i).author == m)
    val deps = own.union(if (on == 0) Set() else Set(on))
    all {
      vs' = vs.put(nextId, { author: m, slot: 0, op: nextId, deps: deps, genuine: true }),
      held' = held.setBy(m, s => s.union(Set(nextId))),
      nextId' = nextId + 1, memberMoves' = memberMoves + 1,
      mu' = mu, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, oAlive' = oAlive, oHalted' = oHalted,
      oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, knownO' = knownO, reissued' = reissued,
      blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
    },
  }

  // R admits a member move whose dependencies it holds (admitDependents: even without its O parent).
  action rReceives = all {
    rPhase == "open", vs.keys() != Set(),
    nondet v = vs.keys().oneOf()
    val x = vs.get(v)
    all {
      not(isCreator(x)), x.genuine, not(held.get("R").contains(v)),
      x.deps.subseteq(held.get("R")) or (mu.admitDependents and x.deps.subseteq(held.get("R").union(knownO))),
      held' = held.setBy("R", s => s.union(Set(v))),
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, oAlive' = oAlive,
      oHalted' = oHalted, oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, knownO' = knownO,
      reissued' = reissued, memberMoves' = memberMoves, blockedIssues' = blockedIssues,
      blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
    },
  }

  // A member delivers to R the O vertices it holds (its view answer, retained history, parent fetches).
  action memberReachesR = all {
    rPhase == "open",
    nondet m = MEMBERS.oneOf()
    val seen = held.get(m).filter(i => vs.get(i).author == "O")
    all {
      seen != Set(), not(seen.subseteq(knownO)),
      knownO' = knownO.union(seen),
      held' = if (mu.admitOriginal) held.setBy("R", s => s.union(seen)) else held,
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, oAlive' = oAlive,
      oHalted' = oHalted, oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, reissued' = reissued,
      memberMoves' = memberMoves, blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut,
      installed' = installed,
    },
  }

  // A peer sends an unsigned or forged claim of an O vertex at R's next slot. SOUND: R verifies the
  // creator signature and ignores it. trustForged: R believes it (and re-issues its operation).
  action forgedClaim = all {
    rPhase == "open", nextId <= MAX_V,
    vs' = vs.put(nextId, { author: "O", slot: slotOf(vs, rTip) + 1, op: nextId, deps: Set(), genuine: false }),
    knownO' = if (mu.trustForged) knownO.union(Set(nextId)) else knownO, nextId' = nextId + 1,
    mu' = mu, oTip' = oTip, rTip' = rTip, held' = held, rPhase' = rPhase, oAlive' = oAlive, oHalted' = oHalted,
    oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, reissued' = reissued, memberMoves' = memberMoves,
    blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // A live O receives an R vertex from a member: it halts issuing and sealing.
  action oLearnsR = all {
    oAlive, not(oHalted), MEMBERS.exists(m => held.get(m).exists(i => vs.get(i).author == "R")),
    oHalted' = true,
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, rPhase' = rPhase,
    oAlive' = oAlive, oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, knownO' = knownO, reissued' = reissued,
    memberMoves' = memberMoves, blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut,
    installed' = installed,
  }

  // A live O closes the same epoch (SOUND: only while it has not seen R; noOriginalHalt: regardless).
  action oCloses = all {
    oAlive, not(oClosed), not(oHalted) or mu.noOriginalHalt,
    oClosed' = true, oClosedKnowing' = oHalted,
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, rPhase' = rPhase,
    oAlive' = oAlive, oHalted' = oHalted, knownO' = knownO, reissued' = reissued, memberMoves' = memberMoves,
    blockedIssues' = blockedIssues, blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // R closes the epoch once every verified O operation is re-issued; its cut is its graph.
  action rCloses = all {
    rPhase == "open", not(rParked),
    mu.noReissue or opsOf(vs, knownO).subseteq(reissued),
    val graph = held.get("R")
    val voided = if (mu.excludeDivergence and knownO != Set()) closure(vs, graph.filter(i => vs.get(i).author == "R"))
                 else Set()
    val c = graph.exclude(voided)
    if (hasCreatorDuplicate(vs, c)) all {
      blockedCloses' = blockedCloses + 1, rPhase' = rPhase, cut' = cut,
    } else all {
      blockedCloses' = blockedCloses, rPhase' = "closed", cut' = c,
    },
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, oAlive' = oAlive,
    oHalted' = oHalted, oClosed' = oClosed, oClosedKnowing' = oClosedKnowing, knownO' = knownO,
    reissued' = reissued, memberMoves' = memberMoves, blockedIssues' = blockedIssues, installed' = installed,
  }

  // A member installs R's successor: its state is the cut (memberLocalChoice: its own creator copies too).
  action install = all {
    rPhase == "closed",
    nondet m = MEMBERS.oneOf()
    val local = if (mu.memberLocalChoice) held.get(m).filter(i => isCreator(vs.get(i))) else Set()
    all {
      installed' = installed.set(m, opsOf(vs, cut.union(local))),
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, rPhase' = rPhase,
      oAlive' = oAlive, oHalted' = oHalted, oClosed' = oClosed, oClosedKnowing' = oClosedKnowing,
      knownO' = knownO, reissued' = reissued, memberMoves' = memberMoves, blockedIssues' = blockedIssues,
      blockedCloses' = blockedCloses, cut' = cut,
    },
  }

  action step = any {
    oSigns, restore, rSigns, rReissues, memberReceives, memberIssues, rReceives, memberReachesR, forgedClaim,
    oLearnsR, oCloses, rCloses, install,
  }

  // ---- Properties ----
  val sound = mu == SOUND
  val installedMembers = MEMBERS.filter(m => installed.get(m) != Set())
  val convergence = installedMembers.forall(a => installedMembers.forall(b => installed.get(a) == installed.get(b)))
  val closeNotBlocked = blockedCloses == 0
  val issueNotBlocked = blockedIssues == 0
  val cutClosed = rPhase == "closed" implies cut.forall(i => vs.get(i).deps.subseteq(cut))
  val memberWorkKept = rPhase == "closed" implies
    held.get("R").filter(i => not(isCreator(vs.get(i)))).subseteq(cut)
  val creatorOpsConserved = rPhase == "closed" implies
    opsOf(vs, vs.keys().filter(i => vs.get(i).author == "R")).union(opsOf(vs, knownO)).subseteq(opsOf(vs, cut))
  val evidenceGenuine = knownO.forall(i => vs.get(i).genuine)
  val reissuedOnlyGenuine =
    reissued.forall(op => vs.keys().exists(i => vs.get(i).author == "O" and vs.get(i).op == op and vs.get(i).genuine))
  val currentAfterCatchUp = (knownO != Set() and opsOf(vs, knownO).subseteq(reissued)) implies
    slotOf(vs, rTip) + 1 > maxSlot(vs, knownO)
  val noKnowingSplit = not(oClosedKnowing and rPhase == "closed")
  val allSafety = sound implies (convergence and closeNotBlocked and issueNotBlocked and cutClosed and memberWorkKept
    and creatorOpsConserved and evidenceGenuine and reissuedOnlyGenuine and currentAfterCatchUp and noKnowingSplit)

  // Controls: each must be violated by its mutant.
  val ctlParkOwn = mu.parkOwn implies issueNotBlocked
  val ctlAdmitOriginal = mu.admitOriginal implies closeNotBlocked
  val ctlExcludeDivergence = mu.excludeDivergence implies memberWorkKept
  val ctlNoReissue = mu.noReissue implies creatorOpsConserved
  val ctlTrustForged = mu.trustForged implies reissuedOnlyGenuine
  val ctlTrustForgedEvidence = mu.trustForged implies evidenceGenuine
  val ctlMemberLocalChoice = mu.memberLocalChoice implies convergence
  val ctlAdmitDependents = mu.admitDependents implies cutClosed
  val ctlNoOriginalHalt = mu.noOriginalHalt implies noKnowingSplit

  // Witnesses (each must be violated, i.e. the trace exists).
  // Recovery: R signed over a slot O signed, re-issued O's operations, closed; a member installed.
  val wRecovered = not(sound and rPhase == "closed" and knownO != Set() and installedMembers != Set()
    and vs.keys().exists(i => vs.get(i).author == "R" and knownO.exists(o => vs.get(o).slot == vs.get(i).slot)))
  // A member move built on R's divergent vertex is kept in the cut.
  val wMemberOnRForkKept = not(sound and rPhase == "closed" and cut.exists(i => not(isCreator(vs.get(i))) and
    vs.get(i).deps.exists(d => vs.get(d).author == "R")))
  // Residual: an O vertex no member delivered to R is outside the cut after the close.
  val wResidualLostOriginal = not(sound and rPhase == "closed" and
    vs.keys().exists(i => vs.get(i).author == "O" and vs.get(i).genuine and not(knownO.contains(i))))
  // Residual: a live O that never saw R closes the same epoch as R (two anchors).
  val wSplitWhenOriginalUnaware = not(sound and oClosed and rPhase == "closed")
}
