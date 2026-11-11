// Creator restore currency (user decision 2026-11-10).
//
// A creator device restored from an old backup still holds the room's creator key. Its local
// lineage (the next slot it would sign: an author sequence, a seal, a successor anchor) is the
// backup's, while the original device may already have signed further slots. Signing again from
// the stale copy puts two different creator-signed values at one slot (equivocation).
//
// Rule under test: a creator that reopens from storage asks the room's members for their view and
// waits a bounded time. A member answers with creator-signed material it holds (a later epoch's
// signed anchor, or the creator's highest signed vertex): self-authenticating evidence. If any
// verified evidence shows a slot at or above the creator's local next slot, the creator refuses
// (V3RoomNotYetCurrent "creator-superseded") and signs nothing for the rest of the session. If
// every member answered with nothing newer, or the bound expires with no answer, it proceeds.
//
// Abstraction: one counter of creator slots (each signature takes the next one). O is the
// original device, R the restored copy (its next slot is the backup's). O stops when R reopens
// (two creator devices live at once is out of scope). The member's view is the highest O slot
// it has received; it may lag O. A malicious member can send unsigned claims of any slot.
//
//   SOUND: only verified (creator-signed) evidence counts; refusal is final; R signs only once
//          the check decided "current".
//   Broken controls:
//     noGate        - today: R signs as soon as it reopens.
//     trustUnsigned - an unsigned claim counts as evidence (a member can lock the creator out).
//     reopenAfterRefusal - a refused session starts signing once the bound passes.
//
// Residual (witnessed, not an invariant): with no member answering, or a member whose view lags
// O, R proceeds and can equivocate at a slot the member's view did not cover.
module creatorRestoreCurrency {
  pure val MAX_SLOT = 5

  type Mutants = { noGate: bool, trustUnsigned: bool, reopenAfterRefusal: bool }
  pure val SOUND: Mutants = { noGate: false, trustUnsigned: false, reopenAfterRefusal: false }

  var mu: Mutants
  var oNext: int           // the original's next slot
  var oRunning: bool
  var backupNext: int      // -1 until a backup is taken
  var memberSeen: int      // highest O slot the member received (-1: none)
  var memberHonest: bool
  var rPhase: str          // "off" | "checking" | "current" | "refused"
  var rNext: int
  var rSignedAfterRefusal: int
  var everRefused: bool
  var coveredAtCheck: bool // the evidence R evaluated covered every slot O signed
  var signedBy: int -> Set[str]

  action init = all {
    nondet m = oneOf(Set(SOUND,
      { noGate: true, trustUnsigned: false, reopenAfterRefusal: false },
      { noGate: false, trustUnsigned: true, reopenAfterRefusal: false },
      { noGate: false, trustUnsigned: false, reopenAfterRefusal: true }))
    nondet honest = oneOf(Set(true, false))
    all {
      mu' = m,
      oNext' = 0,
      oRunning' = true,
      backupNext' = -1,
      memberSeen' = -1,
      memberHonest' = honest,
      rPhase' = "off",
      rNext' = 0,
      rSignedAfterRefusal' = 0,
      everRefused' = false,
      coveredAtCheck' = false,
      signedBy' = 0.to(MAX_SLOT).mapBy(_ => Set()),
    }
  }

  action unchangedR = all {
    rPhase' = rPhase, rNext' = rNext, rSignedAfterRefusal' = rSignedAfterRefusal, coveredAtCheck' = coveredAtCheck,
    everRefused' = everRefused,
  }

  action originalSigns = all {
    oRunning, oNext < MAX_SLOT,
    signedBy' = signedBy.setBy(oNext, s => s.union(Set("O"))),
    oNext' = oNext + 1,
    oRunning' = oRunning, backupNext' = backupNext, memberSeen' = memberSeen, mu' = mu, memberHonest' = memberHonest,
    unchangedR,
  }

  action takeBackup = all {
    oRunning, backupNext == -1,
    backupNext' = oNext,
    oNext' = oNext, oRunning' = oRunning, memberSeen' = memberSeen, mu' = mu, memberHonest' = memberHonest,
    signedBy' = signedBy, unchangedR,
  }

  // The member receives O's signatures up to some slot (it may lag).
  action memberReceives = all {
    oNext > 0,
    nondet upTo = oneOf((memberSeen + 1).to(oNext - 1).union(Set(memberSeen)))
    memberSeen' = upTo,
    oNext' = oNext, oRunning' = oRunning, backupNext' = backupNext, mu' = mu, memberHonest' = memberHonest,
    signedBy' = signedBy, unchangedR,
  }

  // The restored copy reopens: O is gone; R's next slot is the backup's.
  action restore = all {
    backupNext >= 0, rPhase == "off",
    oRunning' = false,
    rNext' = backupNext,
    rPhase' = if (mu.noGate) "current" else "checking",
    oNext' = oNext, backupNext' = backupNext, memberSeen' = memberSeen, mu' = mu, memberHonest' = memberHonest,
    signedBy' = signedBy, rSignedAfterRefusal' = rSignedAfterRefusal, coveredAtCheck' = coveredAtCheck,
    everRefused' = everRefused,
  }

  // An honest member answers with its verified view (the highest creator-signed slot it holds).
  action honestAnswer = all {
    rPhase == "checking", memberHonest,
    rPhase' = if (memberSeen >= rNext) "refused" else "current",
    everRefused' = (everRefused or (memberSeen >= rNext)),
    coveredAtCheck' = (memberSeen == oNext - 1),
    rNext' = rNext, rSignedAfterRefusal' = rSignedAfterRefusal,
    oNext' = oNext, oRunning' = oRunning, backupNext' = backupNext, memberSeen' = memberSeen, mu' = mu,
    memberHonest' = memberHonest, signedBy' = signedBy,
  }

  // A malicious member answers with an unsigned claim of any slot.
  action forgedAnswer = all {
    rPhase == "checking", not(memberHonest),
    nondet claim = oneOf(0.to(MAX_SLOT))
    all {
      rPhase' = if (mu.trustUnsigned and claim >= rNext) "refused" else "current",
      everRefused' = (everRefused or (mu.trustUnsigned and (claim >= rNext))),
      coveredAtCheck' = false,
      rNext' = rNext, rSignedAfterRefusal' = rSignedAfterRefusal,
      oNext' = oNext, oRunning' = oRunning, backupNext' = backupNext, memberSeen' = memberSeen, mu' = mu,
      memberHonest' = memberHonest, signedBy' = signedBy,
    },
  }

  // No answer within the bound: indistinguishable from a solo reopen, so R proceeds.
  action boundExpires = all {
    (rPhase == "checking") or (mu.reopenAfterRefusal and (rPhase == "refused")),
    rPhase' = "current",
    everRefused' = everRefused,
    coveredAtCheck' = coveredAtCheck,
    rNext' = rNext, rSignedAfterRefusal' = rSignedAfterRefusal,
    oNext' = oNext, oRunning' = oRunning, backupNext' = backupNext, memberSeen' = memberSeen, mu' = mu,
    memberHonest' = memberHonest, signedBy' = signedBy,
  }

  action restoredSigns = all {
    rPhase == "current", rNext <= MAX_SLOT,
    signedBy' = signedBy.setBy(rNext, s => s.union(Set("R"))),
    rNext' = rNext + 1,
    rSignedAfterRefusal' = rSignedAfterRefusal + (if (everRefused) 1 else 0),
    rPhase' = rPhase, coveredAtCheck' = coveredAtCheck, everRefused' = everRefused,
    oNext' = oNext, oRunning' = oRunning, backupNext' = backupNext, memberSeen' = memberSeen, mu' = mu,
    memberHonest' = memberHonest,
  }

  action step = any { originalSigns, takeBackup, memberReceives, restore, honestAnswer, forgedAnswer, boundExpires, restoredSigns }

  val equivocated = 0.to(MAX_SLOT).exists(s => signedBy.get(s) == Set("O", "R"))

  // With a responsive honest member whose view covered every slot O signed, R never signs a slot O signed.
  val safeWhenCovered = (mu == SOUND and coveredAtCheck) implies not(equivocated)
  // A refusal always has proof behind it: O really signed at or above R's next slot.
  val refusedOnlyWithProof = (mu == SOUND and rPhase == "refused") implies oNext > rNext
  // A refused session never becomes current again.
  val refusedStays = mu == SOUND implies rSignedAfterRefusal == 0
  val allSafety = safeWhenCovered and refusedOnlyWithProof and refusedStays

  // Controls (each must be violated by its mutant).
  val noGateSafe = (mu.noGate and memberSeen == oNext - 1 and memberHonest and rPhase == "current") implies not(equivocated)
  val unsignedCannotLock = mu.trustUnsigned implies (rPhase == "refused" implies oNext > rNext)
  val refusalFinal = mu.reopenAfterRefusal implies rSignedAfterRefusal == 0

  // Witnesses (negate to find a trace).
  val reachedRefusal = not(mu == SOUND and rPhase == "refused" and coveredAtCheck)
  val reachedCoveredCurrent = not(mu == SOUND and rPhase == "current" and coveredAtCheck and rNext > 0 and signedBy.get(rNext - 1).contains("R"))
  val reachedSilentResidual = not(mu == SOUND and not(coveredAtCheck) and equivocated)
}
