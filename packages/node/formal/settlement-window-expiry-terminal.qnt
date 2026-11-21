// MODEL (fix/int7-c3-source-differs): the settlement window's expiry of a displaced own row is terminal
// across plan merges.
//
// Observed: cand/int7-c3 browser gate m71 r2, a member's install threw "v3 room settlement plan source
// differs" (v3-room.ts mergedSettlementPlan) and every later install refused its kept moves with it.
//
// Facts taken from the code:
//   - Every install's settlement drain merges the plan (writeMergedSettlementPlan). The window
//     (settlementWindowExpired) expires a frontier-displaced unreplaced row once its move's origin is
//     V3_SETTLEMENT_OWN_WINDOW_EPOCHS (W) old. The origin is the oldest epoch on the plan's replacement
//     links back from the row; a link whose source row is already retired counts as expired. The
//     merge recomputes this on every install from the current plan and the issued rows.
//   - An expiry gives the move back in that same write (durable hand-back records). `expire` is never
//     replayed (the drain's `eligible`).
//   - Once the chain ends (its newest row expired), its older link is no longer protected and is retired;
//     the next merge prunes that completed entry (completedSettlementSourcesPruned, decision row 60 R5).
//   - mergedSettlementPlan re-derives each prior entry's disposition for a row still in the rebase scan
//     and refuses a changed one; it allows only an unreplaced replacement decision becoming the window's
//     expiry. A refused merge throws out of the drain: the install fails and is retried, and every kept
//     move's re-offer is refused with it (the room is stuck).
//
// One move: root row A (epoch eA), displaced; its replacement row B (epoch eB = eA + gap), displaced. A
// gap of two or more epochs comes from a skip install or a rule R deferral (the replacement waits for
// the next install). `active` is the member's installed epoch at its latest merge.
//
// Variants (`mode`):
//   pre   (cand/int7-c3 49a20afe) the merge re-derives B's disposition from the window it reads now; once
//         A's entry is pruned the window reads B's own younger epoch, finds it not expired, derives
//         `rebase` for an entry held as `expire`, and refuses.
//   fix   a prior `expire` stays `expire` (terminal, like a refused replay's hand-back).
//
// Invariants:
//   neverRefused     no merge is refused (pre: violated);
//   expiryTerminal   an expired row is never a replacement decision again;
//   givenBackOnce    the move is given back at most once;
//   safety = all three.
//
// Commands (packages/node/formal; JAVA_HOME=$(brew --prefix openjdk@17), PATH=$JAVA_HOME/bin:$PATH):
//   quint typecheck settlement-window-expiry-terminal.qnt
//   quint test settlement-window-expiry-terminal.qnt --main=settlementWindowExpiryTerminal --match 'Test$'
//   quint run settlement-window-expiry-terminal.qnt --main=settlementWindowExpiryTerminal --init init \
//     --step step --invariant safety --max-samples 20000 --max-steps 12 --seed 7                    # [ok]
//   quint run ... --init initPreFix ... --invariant neverRefused                                   # violation
//   quint verify settlement-window-expiry-terminal.qnt --main=settlementWindowExpiryTerminal --init init \
//     --step step --backend apalache --apalache-version=0.56.1 --max-steps=10 --invariants safety   # [ok]
//   quint verify ... --init initPreFix ... --invariants neverRefused                               # violation
module settlementWindowExpiryTerminal {
  pure val W = 4          // V3_SETTLEMENT_OWN_WINDOW_EPOCHS
  pure val MAX_EPOCH = 14
  pure val EA = 1         // the root row's epoch

  var active: int         // the member's installed epoch at its latest merge
  var eB: int             // the replacement row's epoch
  var entryA: bool        // the plan holds A's completed entry (A replaced by B)
  var rowA: bool          // row A is not retired
  var rowB: bool          // row B is not retired (still in the rebase scan)
  var dispB: str          // B's entry: "rebase" (unreplaced replacement decision) | "expire"
  var expiredOnce: bool   // ghost: B's entry has been `expire`
  var givenBack: int      // ghost: hand-backs of the move
  var refused: bool       // a merge was refused ("settlement plan source differs")
  var mode: str

  // B was signed (and displaced) at the install that reached eB; the merges below are the later installs.
  action initGap(m: str, gap: int): bool = all {
    eB' = EA + gap, active' = EA + gap,
    entryA' = true, rowA' = true, rowB' = true, dispB' = "rebase", expiredOnce' = false, givenBack' = 0,
    refused' = false, mode' = m,
  }
  action init = { nondet gap = Set(1, 2, 3).oneOf() initGap("fix", gap) }
  action initPreFix = { nondet gap = Set(1, 2, 3).oneOf() initGap("pre", gap) }

  // settlementWindowExpired for B at `at`: through A's link while the plan holds it (a retired A counts as
  // expired), else from B's own epoch.
  def windowExpired(at: int): bool =
    if (entryA) (not(rowA) or EA <= at - W) else eB <= at - W

  // An install reaching a later epoch (one or more: a skip install) and its plan merge.
  action install(stepBy: int): bool = all {
    not(refused), active + stepBy <= MAX_EPOCH,
    val at = active + stepBy
    val pruneA = entryA and not(rowA)
    val inScan = rowB
    val derived = if (mode == "fix" and dispB == "expire") "expire" else if (windowExpired(at)) "expire" else "rebase"
    // mergedSettlementPlan's check: only an unreplaced replacement decision may become the expiry.
    val refuse = inScan and dispB == "expire" and derived != "expire"
    if (refuse) all {
      refused' = true, active' = at,
      eB' = eB, entryA' = entryA, rowA' = rowA, rowB' = rowB, dispB' = dispB, expiredOnce' = expiredOnce,
      givenBack' = givenBack, mode' = mode,
    } else all {
      active' = at, refused' = false,
      dispB' = if (inScan) derived else dispB,
      expiredOnce' = (expiredOnce or (inScan and derived == "expire")),
      givenBack' = if (inScan and dispB == "rebase" and derived == "expire") givenBack + 1 else givenBack,
      entryA' = (entryA and not(pruneA)),
      eB' = eB, rowA' = rowA, rowB' = rowB, mode' = mode,
    },
  }

  // The chain ended (B expired): A is no longer protected by a later link, and is retired.
  action retireA: bool = all {
    rowA, dispB == "expire",
    rowA' = false,
    active' = active, eB' = eB, entryA' = entryA, rowB' = rowB, dispB' = dispB, expiredOnce' = expiredOnce,
    givenBack' = givenBack, refused' = refused, mode' = mode,
  }

  // B itself is retired (after its expiry): it leaves the rebase scan.
  action retireB: bool = all {
    rowB, dispB == "expire", not(rowA),
    rowB' = false,
    active' = active, eB' = eB, entryA' = entryA, rowA' = rowA, dispB' = dispB, expiredOnce' = expiredOnce,
    givenBack' = givenBack, refused' = refused, mode' = mode,
  }

  action step = any {
    nondet stepBy = Set(1, 2).oneOf()
    install(stepBy),
    retireA,
    retireB,
  }

  val neverRefused = not(refused)
  val expiryTerminal = expiredOnce implies dispB == "expire"
  val givenBackOnce = givenBack <= 1
  val safety = neverRefused and expiryTerminal and givenBackOnce

  // Witness (violated = reachable): the move is given back by the window.
  val neverGivenBack = givenBack == 0

  // The m71 shape: B signed three epochs after A (deferred), the chain origin expires B at epoch 5, A is
  // retired, the merge at 6 prunes A's entry (a retired link still reads as expired), the merge at 7 meets
  // B with no link. The fix keeps the expiry; the pre-fix merge refuses.
  run fixKeepsExpiryTest = initGap("fix", 3).then(install(1))
    .then(all { assert(dispB == "expire" and givenBack == 1), retireA })
    .then(install(1)).then(all { assert(not(entryA) and dispB == "expire"), install(1) })
    .then(all { assert(dispB == "expire" and not(refused) and safety), retireB })
  run preFixRefusesTest = initGap("pre", 3).then(install(1))
    .then(all { assert(dispB == "expire"), retireA })
    .then(install(1)).then(all { assert(not(entryA) and not(refused)), install(1) })
    .then(all { assert(refused and not(neverRefused)), retireB })
  // A one-epoch chain (installs every epoch, no deferral) never meets it, before the fix too.
  run preFixAdjacentChainTest = initGap("pre", 1).then(install(1)).then(install(1)).then(install(1))
    .then(all { assert(dispB == "expire"), retireA }).then(install(1)).then(install(1))
    .then(all { assert(not(refused) and safety), retireB })
}
