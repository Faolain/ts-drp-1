// Creator restore currency (user decision 2026-11-10; wait cut and connectivity hold 2026-11-11).
//
// A creator device restored from an old backup still holds the room's creator keys. Its local
// lineage is the backup's, while the original device may already have signed further values.
// Signing again from the stale copy puts two creator-signed values at one slot (equivocation):
// a move at an author sequence (author key), or a seal/successor anchor at an epoch (finality key).
//
// Rule under test: a creator that reopens from storage asks the room's members for their view. A
// member answers with creator-signed material it holds (its epoch anchor, the creator's highest
// vertex): self-authenticating evidence. Verified evidence of a slot at or above the creator's next
// one refuses it ("creator-superseded") for the rest of the session.
//   - Connectivity-unresolved hold: unless the stored roster names nobody but the creator, R starts
//     "checking" (nothing is signed) with its connectivity unresolved, until the hold bound passes
//     from open or the transport reports it reached nobody (only possible with nobody connected).
//   - A member connected at reopen, or connecting while R watches, is asked and awaited. Assumption:
//     an honest connected member answers within its answer window (the window abstracts that; it
//     can only close on a dishonest member).
//   - Connectivity resolved and nobody awaited, with no attested view: "provisional". Moves may be
//     signed; the finality key may not, until a member attests a view or the finality bound passes.
//     A solo stored roster is provisional at reopen.
//   - Members are watched until one attests: a member that connects later is asked, and its
//     verified newer view refuses the creator from then on (also after the finality bound).
//   - Unverifiable (unsigned or forged) answers count as no answer: they neither refuse nor attest.
//
// Abstraction: two counters of creator slots, moves (author sequence) and epochs (finality). O is
// the original device, R the restored copy (its next slots are the backup's). O stops when R
// reopens (two creator devices live at once is out of scope). The member's view is the highest O
// move and epoch it has received; it may lag O.
//
//   SOUND: as above.
//   Broken controls:
//     noGate             - R signs everything as soon as it reopens.
//     trustUnsigned      - an unsigned claim counts as evidence (a member can lock the creator out).
//     reopenAfterRefusal - a refused session starts signing again once a bound passes.
//     forgedAttests      - an unverifiable answer counts as an attested view (releases the finality key).
//     finalityWhileProvisional - the finality key is not held while provisional.
//     noHold             - no connectivity hold: provisional at reopen when nobody is connected
//                          (the zero-wait lone rule).
//     ignoreAwaiting     - provisional without waiting for an asked member's answer window (a
//                          round that ends on a timer before a slower member answers).
//
// Residual (witnessed, not an invariant): with no member connected until the hold has passed (or a
// solo stored roster), R signs moves (and, after the finality bound, finality) before any view; a
// member connecting later refuses it, but a value R signed before that may sit at a slot O signed.
module creatorRestoreCurrency {
  pure val MAX_SLOT = 4

  type Mutants = { noGate: bool, trustUnsigned: bool, reopenAfterRefusal: bool, forgedAttests: bool, finalityWhileProvisional: bool, noHold: bool, ignoreAwaiting: bool }
  pure val SOUND: Mutants = { noGate: false, trustUnsigned: false, reopenAfterRefusal: false, forgedAttests: false, finalityWhileProvisional: false, noHold: false, ignoreAwaiting: false }

  var mu: Mutants
  var oMove: int              // the original's next move slot
  var oEpoch: int             // the original's next epoch slot (seals)
  var oRunning: bool
  var backupMove: int         // -1 until a backup is taken
  var backupEpoch: int
  var memberMove: int         // highest O move the member received (-1: none)
  var memberEpoch: int        // highest O epoch the member received (-1: none)
  var memberHonest: bool
  var memberConnected: bool
  var connectedAtReopen: bool
  var rPhase: str             // "off" | "checking" | "provisional" | "current" | "refused"
  var attested: bool          // an honest member attested a view (watching ends)
  var forgedRelease: bool     // the finality key was released by an unverifiable answer
  var rMove: int
  var rEpoch: int
  var rSignedAfterRefusal: int
  var rFinalityWhileProvisional: int
  var everRefused: bool
  var coveredAtReopen: bool   // a connected honest member's view covered every O slot when R reopened
  var rosterSolo: bool        // the stored roster names nobody but the creator
  var unresolved: bool        // R's connectivity is unresolved: inside the hold bound and no unreachable report
  var awaiting: bool          // the connected member was asked and its answer window is open
  var rMovesWhileHeld: int    // R moves signed while its connectivity was unresolved
  var coveredInsideHold: bool // an honest member whose view covered every O slot connected inside the hold
  var moveSigners: int -> Set[str]
  var epochSigners: int -> Set[str]

  action init = all {
    nondet m = oneOf(Set(SOUND,
      { ...SOUND, noGate: true },
      { ...SOUND, trustUnsigned: true },
      { ...SOUND, reopenAfterRefusal: true },
      { ...SOUND, forgedAttests: true },
      { ...SOUND, finalityWhileProvisional: true },
      { ...SOUND, noHold: true },
      { ...SOUND, ignoreAwaiting: true }))
    nondet honest = oneOf(Set(true, false))
    nondet solo = oneOf(Set(true, false))
    all {
      mu' = m,
      oMove' = 0, oEpoch' = 0, oRunning' = true,
      backupMove' = -1, backupEpoch' = -1,
      memberMove' = -1, memberEpoch' = -1, memberHonest' = honest, memberConnected' = false, connectedAtReopen' = false,
      rPhase' = "off", attested' = false, forgedRelease' = false,
      rMove' = 0, rEpoch' = 0, rSignedAfterRefusal' = 0, rFinalityWhileProvisional' = 0,
      everRefused' = false, coveredAtReopen' = false,
      rosterSolo' = solo, unresolved' = false, awaiting' = false, rMovesWhileHeld' = 0, coveredInsideHold' = false,
      moveSigners' = 0.to(MAX_SLOT).mapBy(_ => Set()),
      epochSigners' = 0.to(MAX_SLOT).mapBy(_ => Set()),
    }
  }

  action keepO = all {
    oMove' = oMove, oEpoch' = oEpoch, oRunning' = oRunning, backupMove' = backupMove, backupEpoch' = backupEpoch,
    rosterSolo' = rosterSolo,
  }
  action keepHold = all {
    unresolved' = unresolved, awaiting' = awaiting, rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
  }
  action keepMember = all {
    memberMove' = memberMove, memberEpoch' = memberEpoch, memberHonest' = memberHonest, memberConnected' = memberConnected,
    connectedAtReopen' = connectedAtReopen,
  }
  action keepR = all {
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, rMove' = rMove, rEpoch' = rEpoch,
    rSignedAfterRefusal' = rSignedAfterRefusal, rFinalityWhileProvisional' = rFinalityWhileProvisional,
    everRefused' = everRefused, coveredAtReopen' = coveredAtReopen, keepHold,
  }
  action keepSigners = all { moveSigners' = moveSigners, epochSigners' = epochSigners }

  action originalMoves = all {
    oRunning, oMove < MAX_SLOT,
    moveSigners' = moveSigners.setBy(oMove, s => s.union(Set("O"))), epochSigners' = epochSigners,
    oMove' = oMove + 1, oEpoch' = oEpoch, oRunning' = oRunning, backupMove' = backupMove, backupEpoch' = backupEpoch,
    rosterSolo' = rosterSolo, mu' = mu, keepMember, keepR,
  }

  action originalSeals = all {
    oRunning, oEpoch < MAX_SLOT,
    epochSigners' = epochSigners.setBy(oEpoch, s => s.union(Set("O"))), moveSigners' = moveSigners,
    oEpoch' = oEpoch + 1, oMove' = oMove, oRunning' = oRunning, backupMove' = backupMove, backupEpoch' = backupEpoch,
    rosterSolo' = rosterSolo, mu' = mu, keepMember, keepR,
  }

  action takeBackup = all {
    oRunning, backupMove == -1,
    backupMove' = oMove, backupEpoch' = oEpoch,
    oMove' = oMove, oEpoch' = oEpoch, oRunning' = oRunning, rosterSolo' = rosterSolo,
    mu' = mu, keepMember, keepR, keepSigners,
  }

  // The member receives O's signatures up to some slots (it may lag).
  action memberReceives = all {
    nondet upToMove = oneOf((-1).to(MAX_SLOT))
    nondet upToEpoch = oneOf((-1).to(MAX_SLOT))
    all {
      upToMove >= memberMove, upToMove <= oMove - 1,
      upToEpoch >= memberEpoch, upToEpoch <= oEpoch - 1,
      (upToMove != memberMove) or (upToEpoch != memberEpoch),
      memberMove' = upToMove, memberEpoch' = upToEpoch,
      memberHonest' = memberHonest, memberConnected' = memberConnected, connectedAtReopen' = connectedAtReopen,
      mu' = mu, keepO, keepR, keepSigners,
    },
  }

  // The member connects to R's device (before or after R reopens). While R watches, it is asked.
  action memberConnects = all {
    not(memberConnected),
    memberConnected' = true,
    val asked = watching(rPhase, attested)
    all {
      awaiting' = asked,
      coveredInsideHold' = (coveredInsideHold or (unresolved and memberHonest
        and memberMove == oMove - 1 and memberEpoch == oEpoch - 1)),
      unresolved' = unresolved, rMovesWhileHeld' = rMovesWhileHeld,
    },
    memberMove' = memberMove, memberEpoch' = memberEpoch, memberHonest' = memberHonest, connectedAtReopen' = connectedAtReopen,
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, rMove' = rMove, rEpoch' = rEpoch,
    rSignedAfterRefusal' = rSignedAfterRefusal, rFinalityWhileProvisional' = rFinalityWhileProvisional,
    everRefused' = everRefused, coveredAtReopen' = coveredAtReopen,
    mu' = mu, keepO, keepSigners,
  }

  // The restored copy reopens: O is gone; R's next slots are the backup's.
  action restore = all {
    backupMove >= 0, rPhase == "off",
    oRunning' = false,
    rMove' = backupMove, rEpoch' = backupEpoch,
    rPhase' = if (mu.noGate) "current"
      else if (memberConnected) "checking"
      else if (rosterSolo or mu.noHold) "provisional"
      else "checking",
    // Environment: inside the hold bound from open (R itself ignores it under noHold).
    unresolved' = (not(mu.noGate) and not(rosterSolo)),
    awaiting' = (memberConnected and not(mu.noGate)),
    rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
    connectedAtReopen' = memberConnected,
    coveredAtReopen' = (memberConnected and memberHonest and memberMove == oMove - 1 and memberEpoch == oEpoch - 1),
    oMove' = oMove, oEpoch' = oEpoch, backupMove' = backupMove, backupEpoch' = backupEpoch, rosterSolo' = rosterSolo,
    memberMove' = memberMove, memberEpoch' = memberEpoch, memberHonest' = memberHonest, memberConnected' = memberConnected,
    mu' = mu, attested' = attested, forgedRelease' = forgedRelease, rSignedAfterRefusal' = rSignedAfterRefusal,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, everRefused' = everRefused, keepSigners,
  }

  pure def watching(phase: str, att: bool): bool =
    phase == "checking" or phase == "provisional" or (phase == "current" and not(att))

  // An honest connected member answers with its verified view, while R still watches.
  action honestAnswer = all {
    memberConnected, memberHonest, watching(rPhase, attested),
    val newer = memberMove >= rMove or memberEpoch >= rEpoch
    all {
      rPhase' = if (newer) "refused" else "current",
      attested' = not(newer),
      everRefused' = (everRefused or newer),
      forgedRelease' = forgedRelease,
      rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
      rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen,
      awaiting' = false, unresolved' = unresolved, rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
      mu' = mu, keepO, keepMember, keepSigners,
    },
  }

  // A malicious connected member answers with an unsigned or forged claim of any slot.
  action forgedAnswer = all {
    memberConnected, not(memberHonest), watching(rPhase, attested),
    nondet claim = oneOf(0.to(MAX_SLOT))
    val lock = mu.trustUnsigned and claim >= rMove
    all {
      rPhase' = if (lock) "refused" else if (mu.forgedAttests) "current" else rPhase,
      attested' = if (mu.forgedAttests and not(lock)) true else attested,
      forgedRelease' = (forgedRelease or (mu.forgedAttests and not(lock) and rPhase != "current")),
      everRefused' = (everRefused or lock),
      rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
      rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen,
      awaiting' = false, unresolved' = unresolved, rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
      mu' = mu, keepO, keepMember, keepSigners,
    },
  }

  // The hold bound passes from open: connectivity is resolved (time; any moment after reopen).
  action holdExpires = all {
    unresolved,
    unresolved' = false, awaiting' = awaiting, rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, everRefused' = everRefused,
    rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen,
    mu' = mu, keepO, keepMember, keepSigners,
  }

  // The transport reports its own first attempts reached nobody (only with nobody connected).
  action transportUnreachable = all {
    unresolved, not(memberConnected),
    unresolved' = false, awaiting' = awaiting, rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, everRefused' = everRefused,
    rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen,
    mu' = mu, keepO, keepMember, keepSigners,
  }

  // A dishonest member's answer window closes without a verifiable answer (an honest one answers in it).
  action answerWindowCloses = all {
    awaiting, not(memberHonest),
    awaiting' = false, unresolved' = unresolved, rMovesWhileHeld' = rMovesWhileHeld, coveredInsideHold' = coveredInsideHold,
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, everRefused' = everRefused,
    rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen,
    mu' = mu, keepO, keepMember, keepSigners,
  }

  // Connectivity resolved and nobody awaited, with no attested view: moves only.
  action becomeProvisional = all {
    rPhase == "checking", not(unresolved) or mu.noHold, not(awaiting) or mu.ignoreAwaiting,
    rPhase' = "provisional",
    attested' = attested, forgedRelease' = forgedRelease, everRefused' = everRefused,
    rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen, keepHold,
    mu' = mu, keepO, keepMember, keepSigners,
  }

  // The finality bound passes with no attested view: the finality key is released (still watching).
  action finalityBoundExpires = all {
    (rPhase == "provisional") or (mu.reopenAfterRefusal and rPhase == "refused"),
    rPhase' = "current",
    attested' = attested, forgedRelease' = forgedRelease, everRefused' = everRefused,
    rMove' = rMove, rEpoch' = rEpoch, rSignedAfterRefusal' = rSignedAfterRefusal,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, coveredAtReopen' = coveredAtReopen, keepHold,
    mu' = mu, keepO, keepMember, keepSigners,
  }

  action restoredMoves = all {
    rPhase == "provisional" or rPhase == "current", rMove <= MAX_SLOT,
    moveSigners' = moveSigners.setBy(rMove, s => s.union(Set("R"))), epochSigners' = epochSigners,
    rMove' = rMove + 1,
    rSignedAfterRefusal' = rSignedAfterRefusal + (if (everRefused) 1 else 0),
    // An attested view resolves the member's connection (the connected-peer rule); until then the hold
    // applies. After it, a late member is asked while moves continue (the residual).
    rMovesWhileHeld' = rMovesWhileHeld + (if (unresolved and not(attested)) 1 else 0),
    unresolved' = unresolved, awaiting' = awaiting, coveredInsideHold' = coveredInsideHold,
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, rEpoch' = rEpoch,
    rFinalityWhileProvisional' = rFinalityWhileProvisional, everRefused' = everRefused, coveredAtReopen' = coveredAtReopen,
    mu' = mu, keepO, keepMember,
  }

  action restoredSeals = all {
    rPhase == "current" or (mu.finalityWhileProvisional and rPhase == "provisional"), rEpoch <= MAX_SLOT,
    epochSigners' = epochSigners.setBy(rEpoch, s => s.union(Set("R"))), moveSigners' = moveSigners,
    rEpoch' = rEpoch + 1,
    rSignedAfterRefusal' = rSignedAfterRefusal + (if (everRefused) 1 else 0),
    rFinalityWhileProvisional' = rFinalityWhileProvisional + (if (rPhase == "provisional") 1 else 0),
    rPhase' = rPhase, attested' = attested, forgedRelease' = forgedRelease, rMove' = rMove,
    everRefused' = everRefused, coveredAtReopen' = coveredAtReopen, keepHold,
    mu' = mu, keepO, keepMember,
  }

  action step = any {
    originalMoves, originalSeals, takeBackup, memberReceives, memberConnects, restore,
    honestAnswer, forgedAnswer, holdExpires, transportUnreachable, answerWindowCloses, becomeProvisional,
    finalityBoundExpires, restoredMoves, restoredSeals,
  }

  val movesEquivocated = 0.to(MAX_SLOT).exists(s => moveSigners.get(s) == Set("O", "R"))
  val epochsEquivocated = 0.to(MAX_SLOT).exists(s => epochSigners.get(s) == Set("O", "R"))
  val equivocated = movesEquivocated or epochsEquivocated

  // An honest member connected at reopen whose view covered every slot O signed: R never equivocates.
  // Also when it connected while R's connectivity was unresolved (inside the hold bound).
  val safeWhenCovered = (mu == SOUND and (coveredAtReopen or coveredInsideHold)) implies not(equivocated)
  // No move signature while R's connectivity is unresolved: inside the hold bound, no unreachable
  // report and no attested view. (Becoming provisional also waits for every asked member's answer
  // window: safeWhenCovered with coveredInsideHold.)
  val noMoveWhileUnresolved = mu == SOUND implies rMovesWhileHeld == 0
  // A refusal always has proof behind it: O really signed at or above one of R's next slots.
  val refusedOnlyWithProof = (mu == SOUND and rPhase == "refused") implies (oMove > rMove or oEpoch > rEpoch)
  // A refused session signs nothing more.
  val refusedStays = mu == SOUND implies rSignedAfterRefusal == 0
  // The finality key is never used while provisional, and never released by an unverifiable answer.
  val finalityHeld = mu == SOUND implies (rFinalityWhileProvisional == 0 and not(forgedRelease))
  val allSafety = safeWhenCovered and noMoveWhileUnresolved and refusedOnlyWithProof and refusedStays and finalityHeld

  // Controls (each must be violated by its mutant).
  val noGateSafe = (mu.noGate and coveredAtReopen) implies not(equivocated)
  val unsignedCannotLock = mu.trustUnsigned implies (rPhase == "refused" implies (oMove > rMove or oEpoch > rEpoch))
  val refusalFinal = mu.reopenAfterRefusal implies rSignedAfterRefusal == 0
  val forgedCannotRelease = mu.forgedAttests implies not(forgedRelease)
  val finalityHeldWhileProvisional = mu.finalityWhileProvisional implies rFinalityWhileProvisional == 0
  // A member covering O's slots that connects inside the bound is asked before anything is signed.
  val holdProtectsLateConnect = (mu.noHold and coveredInsideHold) implies not(equivocated)
  // An asked member's answer window is waited for before anything is signed.
  val awaitProtects = (mu.ignoreAwaiting and coveredInsideHold) implies not(equivocated)

  // Witnesses (negate to find a trace).
  val reachedRefusalAtReopen = not(mu == SOUND and rPhase == "refused" and coveredAtReopen)
  val reachedLateRefusal = not(mu == SOUND and rPhase == "refused" and not(connectedAtReopen) and rMove > backupMove)
  val reachedRefusalInsideHold = not(mu == SOUND and rPhase == "refused" and coveredInsideHold and rMove == backupMove)
  val reachedSoloImmediate = not(mu == SOUND and rosterSolo and not(connectedAtReopen) and rMove > backupMove and rPhase == "provisional")
  val reachedCoveredCurrent = not(mu == SOUND and rPhase == "current" and coveredAtReopen and rMove > backupMove)
  val reachedLoneResidual = not(mu == SOUND and not(connectedAtReopen) and movesEquivocated)
}
