// Creator move equivocation after a stale restore: recovery (design under review, 2026-11-11).
//
// Two incarnations of the one creator key: O (the original device, gone once R reopens) and R (a
// copy restored from an older backup). Both sign creator moves from the same restore point, so
// creator author slots overlap: O's slot s and R's slot s are two distinct creator-signed vertices.
// Members admit any authenticated vertex whose dependencies they hold (both copies; observed on
// integration-7, tests/creator-move-equivocation-probe.test.ts). Both copies carry the same key:
// no member can tell the incarnations apart from signatures. The only signed tie-breaker is the
// finality-signed cut of the creator that closes the epoch.
//
// Rule under test (SOUND, "live chain canonical"):
//   - R never admits another incarnation's creator vertex into its graph (today's ingress), so a
//     member move depending on one never enters R's graph either: they are void for R.
//   - Refused (a member's verified view holds an O vertex at a slot R signs from), R catches up:
//     it records the O vertices it verified (self-authenticating, under its own author key) and
//     resumes. Its next slot is above every creator slot it knows (own or O's), the jump carried by
//     an author fence (the existing $drp.author-fence.v1), so it signs no further slot it knows O
//     signed. It re-issues each verified O vertex's operation on its own chain before it closes.
//   - The close cuts R's graph (only R's chain and moves built on it). Members install that cut;
//     a member's own moves outside it are re-offered in the next epoch (existing path).
//
// Properties (SOUND):
//   convergence          every member that installed holds the same state (the cut's operations)
//   closeNotBlocked      the close never meets two creator vertices at one slot (today: the throw
//                        "creator issuance-frontier author slot is ambiguous")
//   cutClosed            the cut is causally closed
//   memberWorkKept       every member move in R's graph is in the cut (non-conflicting moves are
//                        never excluded; void ones are re-offered by their authors)
//   creatorOpsConserved  every operation R signed, and every O operation R verified, is in the cut
//   reissuedOnlyGenuine  a re-issued operation always comes from a genuine O vertex (a forged or
//                        unsigned claim cannot inject or exclude creator operations)
//   noKnownConflict      after the refusal R never signs a slot it knows O signed
//   frontierValid        the cut's creator slots run contiguously except where an author fence jumps
//   evidenceGenuine      R refuses, skips and re-issues only on genuine creator-signed O vertices
// Broken controls (each violates the property in brackets):
//   admitOriginal     R admits O's vertices into its graph            [closeNotBlocked]
//   excludeDivergence the close voids both forks above the restore point [memberWorkKept]
//   noReissue         R closes without re-issuing O's operations     [creatorOpsConserved]
//   trustForged       an unsigned claim counts as an O vertex         [evidenceGenuine, reissuedOnlyGenuine]
//   noSkip            R resumes at its own next slot                  [noKnownConflict]
//   noFence           R jumps its next slot without a fence           [frontierValid]
//   memberLocalChoice a member keeps its own creator copies, not the cut [convergence]
//   admitDependents   R admits a member move whose O parent it lacks  [cutClosed]
// Residual (witnessed): an O vertex that no member delivers to R before the close is dropped at
// install (nobody else can sign it again).
module creatorMoveEquivocationRecovery {
  pure val MAX_V = 9
  pure val MEMBERS = Set("M1", "M2")
  pure val O_SLOTS = 2        // O signs at most this many slots after the restore point
  pure val R_PROVISIONAL = 2  // R signs at most this many slots before it is refused
  pure val MEMBER_MOVES = 2

  type Vertex = { author: str, slot: int, op: int, deps: Set[int], fence: bool, genuine: bool }
  type Mutants = { admitOriginal: bool, excludeDivergence: bool, noReissue: bool, trustForged: bool,
                   noSkip: bool, noFence: bool, memberLocalChoice: bool, admitDependents: bool }
  pure val SOUND: Mutants = { admitOriginal: false, excludeDivergence: false, noReissue: false, trustForged: false,
                              noSkip: false, noFence: false, memberLocalChoice: false, admitDependents: false }

  var mu: Mutants
  var vs: int -> Vertex
  var nextId: int
  var oTip: int               // 0 = the restore point (common prefix)
  var rTip: int
  var held: str -> Set[int]   // M1, M2, R: admitted vertices
  var rPhase: str             // "off" (O alive) | "provisional" | "refused" | "resumed" | "closed"
  var knownO: Set[int]        // creator vertices of another incarnation R verified (void for R)
  var reissued: Set[int]      // op ids R re-issued
  var memberMoves: int
  var signedKnownSlot: int    // R signed a slot it knew O signed (after the refusal)
  var blockedCloses: int
  var cut: Set[int]
  var installed: str -> Set[int]  // a member's installed state: operation ids

  pure def isCreator(v: Vertex): bool = v.author == "O" or v.author == "R"
  pure def slotOf(m: int -> Vertex, id: int): int = if (id == 0) 0 else m.get(id).slot
  pure def creatorSlots(m: int -> Vertex, ids: Set[int]): Set[int] =
    ids.filter(i => isCreator(m.get(i))).map(i => m.get(i).slot)
  pure def opsOf(m: int -> Vertex, ids: Set[int]): Set[int] = ids.map(i => m.get(i).op)
  // Every vertex in `base` and every vertex depending on one (ids grow along dependencies).
  pure def closure(m: int -> Vertex, base: Set[int]): Set[int] =
    range(1, MAX_V + 1).foldl(base, (acc, i) =>
      if (m.keys().contains(i) and m.get(i).deps.intersect(acc) != Set()) acc.union(Set(i)) else acc)
  pure def hasCreatorDuplicate(m: int -> Vertex, ids: Set[int]): bool =
    ids.exists(i => ids.exists(j => i != j and isCreator(m.get(i)) and isCreator(m.get(j)) and m.get(i).slot == m.get(j).slot))

  action keepAll = all {
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, rPhase' = rPhase,
    knownO' = knownO, reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot,
    blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  action initWith(m: Mutants): bool = all {
    mu' = m, vs' = Map(), nextId' = 1, oTip' = 0, rTip' = 0,
    held' = Set("M1", "M2", "R").mapBy(_ => Set()), rPhase' = "off", knownO' = Set(), reissued' = Set(),
    memberMoves' = 0, signedKnownSlot' = 0, blockedCloses' = 0, cut' = Set(),
    installed' = MEMBERS.mapBy(_ => Set()),
  }
  // The simulator explores every variant at once; Apalache runs one variant per init (--init).
  action init = all {
    nondet m = oneOf(Set(SOUND,
      { ...SOUND, admitOriginal: true }, { ...SOUND, excludeDivergence: true }, { ...SOUND, noReissue: true },
      { ...SOUND, trustForged: true }, { ...SOUND, noSkip: true }, { ...SOUND, noFence: true },
      { ...SOUND, memberLocalChoice: true }, { ...SOUND, admitDependents: true }))
    initWith(m)
  }
  action initSound = initWith(SOUND)
  action initAdmitOriginal = initWith({ ...SOUND, admitOriginal: true })
  action initExcludeDivergence = initWith({ ...SOUND, excludeDivergence: true })
  action initNoReissue = initWith({ ...SOUND, noReissue: true })
  action initTrustForged = initWith({ ...SOUND, trustForged: true })
  action initNoSkip = initWith({ ...SOUND, noSkip: true })
  action initNoFence = initWith({ ...SOUND, noFence: true })
  action initMemberLocalChoice = initWith({ ...SOUND, memberLocalChoice: true })
  action initAdmitDependents = initWith({ ...SOUND, admitDependents: true })

  // O signs its next slot (it publishes; members may receive it later).
  action oSigns = all {
    rPhase == "off", nextId <= MAX_V, slotOf(vs, oTip) < O_SLOTS,
    vs' = vs.put(nextId, { author: "O", slot: slotOf(vs, oTip) + 1, op: nextId, deps: if (oTip == 0) Set() else Set(oTip),
                           fence: false, genuine: true }),
    nextId' = nextId + 1, oTip' = nextId,
    mu' = mu, rTip' = rTip, held' = held, rPhase' = rPhase, knownO' = knownO, reissued' = reissued,
    memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot, blockedCloses' = blockedCloses, cut' = cut,
    installed' = installed,
  }

  // The stale copy reopens from the restore point; O is gone.
  action restore = all {
    rPhase == "off",
    rPhase' = "provisional",
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, knownO' = knownO,
    reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot,
    blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // R's next slot: provisional, its own next; resumed, above every creator slot it knows (unless noSkip).
  def rNextSlot: int =
    val own = slotOf(vs, rTip) + 1
    if (rPhase == "resumed" and not(mu.noSkip))
      creatorSlots(vs, held.get("R").union(knownO)).fold(own, (acc, s) => if (s + 1 > acc) s + 1 else acc)
    else own

  action rSignsOp(op: int): bool = all {
    nextId <= MAX_V,
    val slot = rNextSlot
    val jump = slot != slotOf(vs, rTip) + 1
    nondet extra = held.get("R").filter(i => not(isCreator(vs.get(i)))).union(Set(0)).oneOf()
    all {
      vs' = vs.put(nextId, { author: "R", slot: slot, op: if (op == 0) nextId else op,
                             deps: (if (rTip == 0) Set() else Set(rTip)).union(if (extra == 0) Set() else Set(extra)),
                             fence: jump and not(mu.noFence), genuine: true }),
      held' = held.setBy("R", s => s.union(Set(nextId))),
      signedKnownSlot' = signedKnownSlot + (if (creatorSlots(vs, knownO).contains(slot)) 1 else 0),
    },
    nextId' = nextId + 1, rTip' = nextId,
    mu' = mu, oTip' = oTip, rPhase' = rPhase, knownO' = knownO, memberMoves' = memberMoves,
    blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // R signs a fresh creator move (provisional: on its stale fork; resumed: on its chain).
  action rSigns = all {
    (rPhase == "provisional" and slotOf(vs, rTip) < R_PROVISIONAL) or (rPhase == "resumed" and slotOf(vs, rTip) < 5),
    rSignsOp(0), reissued' = reissued,
  }

  // Resumed R re-issues one verified O operation on its own chain.
  action rReissues = all {
    rPhase == "resumed", knownO != Set(),
    nondet o = knownO.oneOf()
    all { not(reissued.contains(vs.get(o).op)), rSignsOp(vs.get(o).op), reissued' = reissued.union(Set(vs.get(o).op)) },
  }

  // A member receives any vertex whose dependencies it holds (any order, either copy).
  action memberReceives = all {
    vs.keys() != Set(),
    nondet m = MEMBERS.oneOf()
    nondet v = vs.keys().oneOf()
    all {
      rPhase != "closed", vs.get(v).genuine, not(held.get(m).contains(v)), vs.get(v).deps.subseteq(held.get(m)),
      held' = held.setBy(m, s => s.union(Set(v))),
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, knownO' = knownO,
      reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot,
      blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
    },
  }

  // A member moves on top of one vertex it holds (and its own previous move).
  action memberIssues = all {
    rPhase != "closed", nextId <= MAX_V, memberMoves < MEMBER_MOVES,
    nondet m = MEMBERS.oneOf()
    nondet on = held.get(m).union(Set(0)).oneOf()
    val own = held.get(m).filter(i => vs.get(i).author == m)
    val deps = own.union(if (on == 0) Set() else Set(on))
    all {
      vs' = vs.put(nextId, { author: m, slot: 0, op: nextId, deps: deps, fence: false, genuine: true }),
      held' = held.setBy(m, s => s.union(Set(nextId))),
      nextId' = nextId + 1, memberMoves' = memberMoves + 1,
      mu' = mu, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, knownO' = knownO, reissued' = reissued,
      signedKnownSlot' = signedKnownSlot, blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
    },
  }

  // R admits a member move whose dependencies it holds (admitDependents: even without its O parent).
  action rReceives = all {
    rPhase != "off", rPhase != "closed", vs.keys() != Set(),
    nondet v = vs.keys().oneOf()
    val x = vs.get(v)
    all {
      not(isCreator(x)), x.genuine, not(held.get("R").contains(v)),
      x.deps.subseteq(held.get("R")) or (mu.admitDependents and x.deps.subseteq(held.get("R").union(knownO))),
      held' = held.setBy("R", s => s.union(Set(v))),
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, rPhase' = rPhase, knownO' = knownO,
      reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot,
      blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
    },
  }

  // A member holding an O vertex reaches R: R verifies it and learns every O vertex that member holds.
  // While refused or resumed, members that reach R add what they hold (R keeps learning).
  action memberReachesR = all {
    rPhase == "provisional" or rPhase == "refused" or rPhase == "resumed",
    nondet m = MEMBERS.oneOf()
    val seen = held.get(m).filter(i => vs.get(i).author == "O")
    all {
      seen != Set(), not(seen.subseteq(knownO)),
      knownO' = knownO.union(seen),
      rPhase' = if (rPhase == "provisional") "refused" else rPhase,
      held' = if (mu.admitOriginal) held.setBy("R", s => s.union(seen)) else held,
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, reissued' = reissued,
      memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot, blockedCloses' = blockedCloses, cut' = cut,
      installed' = installed,
    },
  }

  // A peer sends an unsigned or forged claim of an O vertex at R's next slot. SOUND: R verifies the
  // creator signature and ignores it. trustForged: R believes it (refuses, skips, re-issues its op).
  action forgedClaim = all {
    rPhase == "provisional" or rPhase == "refused" or rPhase == "resumed", nextId <= MAX_V,
    vs' = vs.put(nextId, { author: "O", slot: slotOf(vs, rTip) + 1, op: nextId, deps: Set(), fence: false, genuine: false }),
    knownO' = if (mu.trustForged) knownO.union(Set(nextId)) else knownO, nextId' = nextId + 1,
    rPhase' = if (mu.trustForged and rPhase == "provisional") "refused" else rPhase,
    mu' = mu, oTip' = oTip, rTip' = rTip, held' = held, reissued' = reissued, memberMoves' = memberMoves,
    signedKnownSlot' = signedKnownSlot, blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // Caught up: resume as the creator.
  action catchUp = all {
    rPhase == "refused", knownO != Set(),
    rPhase' = "resumed",
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, knownO' = knownO,
    reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot,
    blockedCloses' = blockedCloses, cut' = cut, installed' = installed,
  }

  // R closes the epoch: SOUND cuts its whole graph, once every verified O operation is re-issued.
  action rCloses = all {
    rPhase == "resumed" or (rPhase == "provisional" and knownO == Set()),
    mu.noReissue or opsOf(vs, knownO).subseteq(reissued),
    val graph = held.get("R")
    val voided = if (mu.excludeDivergence) closure(vs, graph.filter(i => vs.get(i).author == "R")) else Set()
    val c = graph.exclude(voided)
    if (hasCreatorDuplicate(vs, c)) all {
      blockedCloses' = blockedCloses + 1, rPhase' = rPhase, cut' = cut,
    } else all {
      blockedCloses' = blockedCloses, rPhase' = "closed", cut' = c,
    },
    mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, knownO' = knownO,
    reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot, installed' = installed,
  }

  // A member installs the successor: its state is the cut (memberLocalChoice: its own creator copies too).
  action install = all {
    rPhase == "closed",
    nondet m = MEMBERS.oneOf()
    val local = if (mu.memberLocalChoice) held.get(m).filter(i => isCreator(vs.get(i))) else Set()
    all {
      installed' = installed.set(m, opsOf(vs, cut.union(local))),
      mu' = mu, vs' = vs, nextId' = nextId, oTip' = oTip, rTip' = rTip, held' = held, rPhase' = rPhase,
      knownO' = knownO, reissued' = reissued, memberMoves' = memberMoves, signedKnownSlot' = signedKnownSlot,
      blockedCloses' = blockedCloses, cut' = cut,
    },
  }

  action step = any {
    oSigns, restore, rSigns, rReissues, memberReceives, memberIssues, rReceives, memberReachesR, forgedClaim,
    catchUp, rCloses, install,
  }

  // ---- Properties ----
  val sound = mu == SOUND
  val installedMembers = MEMBERS.filter(m => installed.get(m) != Set())
  val convergence = installedMembers.forall(a => installedMembers.forall(b => installed.get(a) == installed.get(b)))
  val closeNotBlocked = blockedCloses == 0
  val cutClosed = rPhase == "closed" implies cut.forall(i => vs.get(i).deps.subseteq(cut))
  val memberWorkKept = rPhase == "closed" implies
    held.get("R").filter(i => not(isCreator(vs.get(i)))).subseteq(cut)
  val creatorOpsConserved = rPhase == "closed" implies
    opsOf(vs, vs.keys().filter(i => vs.get(i).author == "R")).union(opsOf(vs, knownO)).subseteq(opsOf(vs, cut))
  val reissuedOnlyGenuine = reissued.forall(op => vs.keys().exists(i => vs.get(i).author == "O" and vs.get(i).op == op and vs.get(i).genuine))
  val noKnownConflict = signedKnownSlot == 0
  // Creator slots in the cut, ascending, run contiguously from the restore point; a gap is allowed
  // only where the vertex after it is an author fence.
  val frontierValid = rPhase == "closed" implies cut.forall(i =>
    not(isCreator(vs.get(i))) or vs.get(i).slot == 1 or vs.get(i).fence or
      cut.exists(j => isCreator(vs.get(j)) and vs.get(j).slot == vs.get(i).slot - 1))
  val evidenceGenuine = knownO.forall(i => vs.get(i).genuine)
  val allSafety = sound implies (convergence and closeNotBlocked and cutClosed and memberWorkKept and creatorOpsConserved
    and reissuedOnlyGenuine and noKnownConflict and frontierValid and evidenceGenuine)

  // Controls: each must be violated by its mutant.
  val ctlAdmitOriginal = mu.admitOriginal implies closeNotBlocked
  val ctlExcludeDivergence = mu.excludeDivergence implies memberWorkKept
  val ctlNoReissue = mu.noReissue implies creatorOpsConserved
  val ctlTrustForged = mu.trustForged implies reissuedOnlyGenuine
  val ctlTrustForgedEvidence = mu.trustForged implies evidenceGenuine
  val ctlNoSkip = mu.noSkip implies noKnownConflict
  val ctlNoFence = mu.noFence implies frontierValid
  val ctlMemberLocalChoice = mu.memberLocalChoice implies convergence
  val ctlAdmitDependents = mu.admitDependents implies cutClosed

  // Witnesses (negate to find a trace).
  // Recovery: R signed a duplicate, was refused, caught up, re-issued O's move and closed; a member installed.
  val wRecovered = not(sound and rPhase == "closed" and knownO != Set() and installedMembers != Set()
    and vs.keys().exists(i => vs.get(i).author == "R" and creatorSlots(vs, knownO).contains(vs.get(i).slot)))
  // A member move built on R's stale-fork vertex is kept in the cut.
  val wMemberOnStaleForkKept = not(sound and rPhase == "closed" and cut.exists(i => vs.get(i).author != "R" and
    vs.get(i).author != "O" and vs.get(i).deps.exists(d => vs.get(d).author == "R")))
  // Residual: an O vertex no member delivered to R is outside the cut after the close.
  val wResidualLostOriginal = not(sound and rPhase == "closed" and
    vs.keys().exists(i => vs.get(i).author == "O" and vs.get(i).genuine and not(knownO.contains(i))))
}
