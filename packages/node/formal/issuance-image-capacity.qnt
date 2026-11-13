// -*- mode: Bluespec; -*-
/**
 * Maintenance native image capacity: one forecast shared by ordinary admission
 * and creator maintenance, and the rules that keep it a bound.
 *
 * Census image (one bounded native read) = envelopes + own settlement plan
 * (entries, contexts, hand-backs) + issuance retirement control (labels and
 * protection). Units are abstract bytes.
 *
 * Forecast F (one function; admission refuses with a typed reason when the
 * post-admission F exceeds CAP, before signing):
 *   F  = ENV*|rows| + PR + HOLE*(|PH| + max(|PH|, |completed holes|)), PH including active exceptions
 *   PR = FIXED + sum(entryReserve) + PER_SOURCE*|potential| + HB*(handBacks + free hand-back slots
 *        any unresolved entry or potential source could still take)
 *   PH = rows that can still need an explicit protection record: pending, with an
 *        unresolved entry, or after the last applied close.
 *
 * A (full) A preparation's BEFORE plan lives in a side row outside the census,
 *     read only on mandatory resume; the control holds digests. The previous
 *     completed side row is deleted at the next prepare only when the
 *     coordinator has globally completed that decision (otherwise prepare is
 *     refused, which only abort paths reach). Resume checks the committed target.
 * B   Potential sources: own rows without an entry whose epoch is after the last
 *     close applied to the plan; a close adds entries only for rows of its epoch.
 * D   PER_SOURCE = ENTRY + max(MEMBER, EXPIRY): a committed entry never gains an
 *     expiry; an unresolved entry is reserved as a future expiry.
 * H   Protection is an epoch floor plus explicit exceptions (pending rows and
 *     rows of unresolved entries at or below the floor), not one record per row.
 * HB  Frontier resolution may add a hand-back record (at most HBMAX in a plan);
 *     every unresolved entry and potential source reserves one while slots remain.
 * R   Replaced source: a close may add a completed replacement entry ("replaced"), which may
 *     later gain its replaced-source resolution and one receipt (EXPIRY), exactly once. Each such
 *     entry reserves that receipt (replacedSourceResolvable in the sizing). A potential source that
 *     ends replaced stays within PER_SOURCE.
 *
 * Invariants (allProperties):
 *   imageWithinForecast, maintenanceAdmits (F <= CAP everywhere: what admission
 *   admits maintenance never refuses), forecastOnlyGrowsByAdmission,
 *   neverStuck, restoresTrueSource, noPendingLost.
 *
 * Mutant controls (each must violate allProperties):
 *   beforeInControl, compactAlways, skipTargetCheck            (A)
 *   excludeClosing, historicalSource                           (B)
 *   committedLaterExpires                                      (D)
 *   holesForWindow, floorSkipsPending                          (H)
 *   noHandBackReserve                                          (HB)
 *   replacedReceiptUncharged                                   (R)
 *   admissionOmitsHoles                    (admission/maintenance disagreement)
 * Witnesses (must be reachable): noCustodySeen, noCompactionSeen,
 *   noReconstructSeen, noAdmissionRefusalSeen, noHandBackSeen, noPruneSeen, noReplacedSourceSeen.
 */
module issuanceImageCapacity {
  // NOTE: write `x' = (a or b)`; unparenthesized, `x' = a or b` parses as `(x' = a) or b`.
  pure val EPOCHS = 3
  pure val MAXROWS = 4
  pure val ENV = 1
  pure val FIXED = 2
  pure val ENTRY = 1
  pure val MEMBER = 1
  pure val EXPIRY = 2
  pure val HB = 1
  pure val HBMAX = 1
  pure val HOLE = 1
  pure val CAP = 26
  pure val DECISIONS = Set(0, 1)
  pure val NONE = -1

  type Row = { id: int, ep: int, pub: bool }
  // res: "manual" (unresolved), "committed", "expire", "replaced" (completed replacement, source
  // unresolved), "replacedResolved" (with its replaced-source receipt), "both" (mutant only)
  type Entry = { id: int, res: str }

  type Mut = {
    beforeInControl: bool, compactAlways: bool, skipTargetCheck: bool,
    excludeClosing: bool, historicalSource: bool, committedLaterExpires: bool,
    holesForWindow: bool, floorSkipsPending: bool, noHandBackReserve: bool, admissionOmitsHoles: bool,
    replacedReceiptUncharged: bool,
  }
  pure val SOUND: Mut = {
    beforeInControl: false, compactAlways: false, skipTargetCheck: false,
    excludeClosing: false, historicalSource: false, committedLaterExpires: false,
    holesForWindow: false, floorSkipsPending: false, noHandBackReserve: false, admissionOmitsHoles: false,
    replacedReceiptUncharged: false,
  }

  var epoch: int
  var applied: int
  var rows: Set[Row]
  var entries: Set[Entry]
  var handBacks: int
  var nextId: int
  var aheActive: int
  var aheCompleted: int
  var ctlActive: int
  var activeThrough: int
  var activeHoles: Set[int]
  var activeBeforeInControl: bool
  var sideActive: Set[Entry]
  var ctlCompleted: int
  var completedThrough: int
  var completedHoles: Set[int]
  var completedBeforeInControl: bool
  var sideCompleted: Set[Entry]
  var sidePresent: bool
  var completedAfter: Set[Entry]
  var targetRows: Set[int]
  var trueSourceRows: Set[int]
  var trueSourcePlan: Set[Entry]
  var forecastGrew: bool
  var stuck: bool
  var wrongSource: bool
  var compacted: bool
  var reconstructed: bool
  var admissionRefused: bool
  var pendingLost: bool
  var handBackSeen: bool
  var pruneSeen: bool
  var replacedSourceSeen: bool

  pure def rowIds(rs: Set[Row]): Set[int] = rs.map(r => r.id)
  pure def entryIds(es: Set[Entry]): Set[int] = es.map(e => e.id)
  pure def sum(xs: Set[Entry], f: Entry => int): int = xs.fold(0, (acc, e) => acc + f(e))
  pure def min2(a: int, b: int): int = if (a < b) a else b
  pure def max2(a: int, b: int): int = if (a > b) a else b

  pure def cost(e: Entry): int =
    ENTRY + (if (e.res == "committed") MEMBER else if (e.res == "expire" or e.res == "replacedResolved") EXPIRY
      else if (e.res == "both") MEMBER + EXPIRY else 0)
  pure def planBytes(es: Set[Entry], hb: int): int =
    (if (es.size() == 0) 0 else FIXED + sum(es, cost)) + HB * hb

  pure def entryReserve(e: Entry, m: Mut): int =
    ENTRY + (if (e.res == "committed") MEMBER else if (e.res == "both") MEMBER + EXPIRY
      else if (e.res == "replaced" and m.replacedReceiptUncharged) 0 else EXPIRY)
  pure val PER_SOURCE = ENTRY + max2(MEMBER, EXPIRY)

  pure def manualIds(es: Set[Entry]): Set[int] = es.filter(e => e.res == "manual").map(e => e.id)

  pure def potential(rs: Set[Row], es: Set[Entry], appliedEpoch: int, m: Mut): Set[Row] =
    rs.filter(r => not(entryIds(es).contains(r.id)) and r.ep > appliedEpoch + (if (m.excludeClosing) 1 else 0))

  pure def planReserve(rs: Set[Row], es: Set[Entry], hb: int, appliedEpoch: int, m: Mut): int = {
    val p = potential(rs, es, appliedEpoch, m).size()
    val slots = if (m.noHandBackReserve) 0 else min2(HBMAX - hb, manualIds(es).size() + p)
    FIXED + sum(es, e => entryReserve(e, m)) + PER_SOURCE * p + HB * (hb + slots)
  }

  // Rows that can still need an explicit protection record (H).
  pure def protectable(rs: Set[Row], es: Set[Entry], appliedEpoch: int): Set[int] =
    rs.filter(r => not(r.pub) or manualIds(es).contains(r.id) or r.ep > appliedEpoch).map(r => r.id)

  // Active exceptions stay charged until commit even if their rows publish meanwhile.
  pure def forecast(rs: Set[Row], es: Set[Entry], hb: int, appliedEpoch: int, ch: Set[int], ah: Set[int], m: Mut): int = {
    val ph = protectable(rs, es, appliedEpoch).union(ah).size()
    ENV * rs.size() + planReserve(rs, es, hb, appliedEpoch, m) + HOLE * (ph + max2(ph, ch.size()))
  }

  pure def admissionForecast(rs: Set[Row], es: Set[Entry], hb: int, appliedEpoch: int, ch: Set[int], ah: Set[int], m: Mut): int =
    if (m.admissionOmitsHoles) ENV * rs.size() + planReserve(rs, es, hb, appliedEpoch, m)
    else forecast(rs, es, hb, appliedEpoch, ch, ah, m)

  // Explicit exceptions at or below the floor `t`.
  pure def exceptions(rs: Set[Row], es: Set[Entry], t: int, m: Mut): Set[int] =
    rs.filter(r => r.ep <= t and (
      (not(r.pub) and not(m.floorSkipsPending)) or manualIds(es).contains(r.id) or
      (m.holesForWindow and r.ep > t - 2))).map(r => r.id)

  def actualImage: int =
    ENV * rows.size() + planBytes(entries, handBacks) +
    HOLE * (completedHoles.size() + (if (ctlActive != NONE) activeHoles.size() else 0)) +
    (if (ctlActive != NONE and activeBeforeInControl) planBytes(sideActive, 0) else 0) +
    (if (completedBeforeInControl) planBytes(sideCompleted, 0) else 0)

  action init = all {
    epoch' = 0, applied' = -1, rows' = Set(), entries' = Set(), handBacks' = 0, nextId' = 0,
    aheActive' = NONE, aheCompleted' = NONE,
    ctlActive' = NONE, activeThrough' = NONE, activeHoles' = Set(), activeBeforeInControl' = false, sideActive' = Set(),
    ctlCompleted' = NONE, completedThrough' = NONE, completedHoles' = Set(), completedBeforeInControl' = false,
    sideCompleted' = Set(), sidePresent' = false, completedAfter' = Set(),
    targetRows' = Set(), trueSourceRows' = Set(), trueSourcePlan' = Set(),
    forecastGrew' = false, stuck' = false, wrongSource' = false, compacted' = false, reconstructed' = false,
    admissionRefused' = false, pendingLost' = false, handBackSeen' = false, pruneSeen' = false,
    replacedSourceSeen' = false,
  }

  action keepAhe = all { aheActive' = aheActive, aheCompleted' = aheCompleted }
  action keepCtl = all {
    ctlActive' = ctlActive, activeThrough' = activeThrough, activeHoles' = activeHoles,
    activeBeforeInControl' = activeBeforeInControl, sideActive' = sideActive,
    ctlCompleted' = ctlCompleted, completedThrough' = completedThrough, completedHoles' = completedHoles,
    completedBeforeInControl' = completedBeforeInControl, sideCompleted' = sideCompleted, sidePresent' = sidePresent,
    completedAfter' = completedAfter, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
  }
  action keepFlags = all {
    stuck' = stuck, wrongSource' = wrongSource, compacted' = compacted, reconstructed' = reconstructed,
    admissionRefused' = admissionRefused, pendingLost' = pendingLost, handBackSeen' = handBackSeen, pruneSeen' = pruneSeen,
    replacedSourceSeen' = replacedSourceSeen,
  }
  action keepData = all {
    epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, handBacks' = handBacks, nextId' = nextId,
    forecastGrew' = forecastGrew,
  }

  // A non-admission data step: records whether it raised the forecast.
  action dataStep(m: Mut, nRows: Set[Row], nEntries: Set[Entry], nHb: int, nApplied: int, nCh: Set[int], nAh: Set[int]): bool = all {
    rows' = nRows, entries' = nEntries, handBacks' = nHb, applied' = nApplied,
    forecastGrew' = (forecastGrew or forecast(nRows, nEntries, nHb, nApplied, nCh, nAh, m) >
      forecast(rows, entries, handBacks, applied, completedHoles, activeHoles, m)),
    epoch' = epoch, nextId' = nextId,
  }

  // ---- Ordinary admission: the only step allowed to raise the forecast. ----
  action issue(m: Mut): bool = {
    val grown = rows.union(Set({ id: nextId, ep: epoch, pub: false }))
    all {
      rows.size() < MAXROWS,
      if (admissionForecast(grown, entries, handBacks, applied, completedHoles, activeHoles, m) <= CAP) all {
        rows' = grown, nextId' = nextId + 1, admissionRefused' = admissionRefused,
      } else all {
        // ISSUANCE_CAPACITY_FORECAST_EXCEEDED: refused before signing; nothing changes.
        rows' = rows, nextId' = nextId, admissionRefused' = true,
      },
      epoch' = epoch, applied' = applied, entries' = entries, handBacks' = handBacks, forecastGrew' = forecastGrew,
      keepAhe, keepCtl,
      stuck' = stuck, wrongSource' = wrongSource, compacted' = compacted, reconstructed' = reconstructed,
      pendingLost' = pendingLost, handBackSeen' = handBackSeen, pruneSeen' = pruneSeen, replacedSourceSeen' = replacedSourceSeen,
    }
  }

  action advance = all {
    epoch < EPOCHS - 1, epoch' = epoch + 1,
    applied' = applied, rows' = rows, entries' = entries, handBacks' = handBacks, nextId' = nextId,
    forecastGrew' = forecastGrew, keepAhe, keepCtl, keepFlags,
  }

  action publish(m: Mut): bool = all {
    nondet r = rows.filter(x => not(x.pub)).oneOf()
    dataStep(m, rows.exclude(Set(r)).union(Set({ id: r.id, ep: r.ep, pub: true })), entries, handBacks, applied, completedHoles, activeHoles),
    keepAhe, keepCtl, keepFlags,
  }

  // Close of epoch applied+1 applied to the plan (CAS refuses it under a prepared checkpoint).
  action closeApply(m: Mut): bool = {
    val e = applied + 1
    val candidates = rows.filter(r => not(entryIds(entries).contains(r.id)) and
      (if (m.historicalSource) r.ep <= e else r.ep == e))
    all {
      e < epoch, ctlActive == NONE,
      nondet added = candidates.powerset().oneOf()
      nondet res = Set("manual", "committed", "expire", "replaced").oneOf()
      dataStep(m, rows, entries.union(added.map(r => { id: r.id, res: res })), handBacks, e, completedHoles, activeHoles),
      keepAhe, keepCtl, keepFlags,
    }
  }

  // Frontier resolution: an unresolved entry expires, possibly handing intents back.
  // With no free hand-back record a never-admitted source stays unresolved.
  action frontierResolve(m: Mut): bool = all {
    ctlActive == NONE,
    nondet e = entries.oneOf()
    nondet neverAdmitted = Set(true, false).oneOf()
    val resolved = entries.exclude(Set(e)).union(Set({ id: e.id, res: if (e.res == "manual") "expire" else "both" }))
    all {
      e.res == "manual" or (m.committedLaterExpires and e.res == "committed"),
      not(neverAdmitted) or handBacks < HBMAX,
      dataStep(m, rows, resolved, handBacks + (if (neverAdmitted) 1 else 0), applied, completedHoles, activeHoles),
      handBackSeen' = (handBackSeen or neverAdmitted),
    },
    keepAhe, keepCtl,
    stuck' = stuck, wrongSource' = wrongSource, compacted' = compacted, reconstructed' = reconstructed,
    admissionRefused' = admissionRefused, pendingLost' = pendingLost, pruneSeen' = pruneSeen, replacedSourceSeen' = replacedSourceSeen,
  }

  // Replaced-source resolution (R): a completed replacement's source is released once, with one
  // signed receipt. Its reserve was taken when the entry was added, so this never raises the forecast.
  action replacedSourceResolve(m: Mut): bool = all {
    ctlActive == NONE,
    nondet e = entries.filter(x => x.res == "replaced").oneOf()
    all {
      entries.exists(x => x.res == "replaced"),
      dataStep(m, rows, entries.exclude(Set(e)).union(Set({ id: e.id, res: "replacedResolved" })), handBacks, applied,
        completedHoles, activeHoles),
    },
    replacedSourceSeen' = true,
    keepAhe, keepCtl,
    stuck' = stuck, wrongSource' = wrongSource, compacted' = compacted, reconstructed' = reconstructed,
    admissionRefused' = admissionRefused, pendingLost' = pendingLost, handBackSeen' = handBackSeen, pruneSeen' = pruneSeen,
  }

  // The application takes a hand-back record back.
  action consumeHandBack(m: Mut): bool = all {
    handBacks > 0, ctlActive == NONE,
    dataStep(m, rows, entries, handBacks - 1, applied, completedHoles, activeHoles),
    keepAhe, keepCtl, keepFlags,
  }

  // ---- Coordinator. ----
  action aheBegin = all {
    aheActive == NONE,
    nondet d = DECISIONS.oneOf()
    all { d != aheCompleted, aheActive' = d },
    aheCompleted' = aheCompleted, keepCtl, keepFlags, keepData,
  }

  // Adversarial: the coordinator may abandon its active intent at any time.
  action aheAbort = all {
    aheActive != NONE, aheActive' = NONE, aheCompleted' = aheCompleted, keepCtl, keepFlags, keepData,
  }

  action aheComplete = all {
    aheActive != NONE, ctlActive == NONE, ctlCompleted == aheActive,
    aheCompleted' = aheActive, aheActive' = NONE, keepCtl, keepFlags, keepData,
  }

  // ---- Issuance retirement participant. ----
  action issPrepare(m: Mut): bool = {
    val deletable = ctlCompleted == NONE or not(sidePresent) or aheCompleted == ctlCompleted
    val deleting = ctlCompleted != NONE and sidePresent
    all {
      ctlActive == NONE, aheActive != NONE, ctlCompleted != aheActive, applied >= 0,
      m.compactAlways or deletable,
      nondet t = 0.to(applied).oneOf()
      all {
        ctlActive' = aheActive,
        activeThrough' = t,
        activeHoles' = exceptions(rows, entries, t, m),
        activeBeforeInControl' = m.beforeInControl,
        sideActive' = entries,
      },
      sidePresent' = if (deleting) false else sidePresent,
      sideCompleted' = if (deleting) Set() else sideCompleted,
      completedBeforeInControl' = if (deleting) false else completedBeforeInControl,
      compacted' = (compacted or deleting),
      keepAhe, keepData,
      ctlCompleted' = ctlCompleted, completedThrough' = completedThrough, completedHoles' = completedHoles,
      completedAfter' = completedAfter, targetRows' = targetRows,
      trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
      stuck' = stuck, wrongSource' = wrongSource, reconstructed' = reconstructed,
      admissionRefused' = admissionRefused, pendingLost' = pendingLost, handBackSeen' = handBackSeen, pruneSeen' = pruneSeen, replacedSourceSeen' = replacedSourceSeen,
    }
  }

  action issAbort = all {
    ctlActive != NONE,
    ctlActive' = NONE, activeThrough' = NONE, activeHoles' = Set(), activeBeforeInControl' = false, sideActive' = Set(),
    ctlCompleted' = ctlCompleted, completedThrough' = completedThrough, completedHoles' = completedHoles,
    completedBeforeInControl' = completedBeforeInControl, sideCompleted' = sideCompleted, sidePresent' = sidePresent,
    completedAfter' = completedAfter, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
    keepAhe, keepFlags, keepData,
  }

  // Commit rewrites only the plan: terminal entries of retired rows leave it.
  action issCommit(m: Mut): bool = {
    val retired = rows.filter(r => r.ep <= activeThrough and not(activeHoles.contains(r.id))).map(r => r.id)
    val after = entries.filter(e => not(retired.contains(e.id)) or e.res == "manual")
    all {
      ctlActive != NONE,
      ctlActive' = NONE, activeThrough' = NONE, activeHoles' = Set(), activeBeforeInControl' = false, sideActive' = Set(),
      ctlCompleted' = ctlActive, completedThrough' = activeThrough, completedHoles' = activeHoles,
      completedBeforeInControl' = activeBeforeInControl, sideCompleted' = entries, sidePresent' = true,
      completedAfter' = after, targetRows' = rowIds(rows), trueSourceRows' = rowIds(rows), trueSourcePlan' = entries,
      dataStep(m, rows, after, handBacks, applied, activeHoles, Set()),
      keepAhe, keepFlags,
    }
  }

  // Pruning removes retired rows once no resume can need them, honouring the
  // completed and active protection.
  action prune(m: Mut): bool = {
    val removable = rows.filter(r => r.ep <= completedThrough and not(completedHoles.contains(r.id)) and
      not(ctlActive != NONE and activeHoles.contains(r.id)) and not(entryIds(entries).contains(r.id)))
    all {
      ctlActive == NONE, ctlCompleted != NONE, aheActive != ctlCompleted, removable.size() > 0,
      dataStep(m, rows.exclude(removable), entries, handBacks, applied, completedHoles, activeHoles),
      pendingLost' = (pendingLost or removable.exists(r => not(r.pub))),
      pruneSeen' = true,
      keepAhe, keepCtl,
      stuck' = stuck, wrongSource' = wrongSource, compacted' = compacted, reconstructed' = reconstructed,
      admissionRefused' = admissionRefused, handBackSeen' = handBackSeen, replacedSourceSeen' = replacedSourceSeen,
    }
  }

  // Resume of an active coordinator intent whose participant already committed:
  // reads the BEFORE side row and checks the committed target first.
  action reconstruct(m: Mut): bool = all {
    ctlActive == NONE, ctlCompleted != NONE, aheActive == ctlCompleted,
    m.skipTargetCheck or (rowIds(rows) == targetRows and entries == completedAfter),
    stuck' = (stuck or not(sidePresent)),
    wrongSource' = (wrongSource or (sidePresent and
      (rowIds(rows) != trueSourceRows or sideCompleted != trueSourcePlan))),
    reconstructed' = true,
    compacted' = compacted, admissionRefused' = admissionRefused, pendingLost' = pendingLost,
    handBackSeen' = handBackSeen, pruneSeen' = pruneSeen, replacedSourceSeen' = replacedSourceSeen,
    keepAhe, keepCtl, keepData,
  }

  action stepWith(m: Mut): bool = any {
    issue(m), advance, publish(m), closeApply(m), frontierResolve(m), replacedSourceResolve(m), consumeHandBack(m),
    aheBegin, aheAbort, aheComplete,
    issPrepare(m), issAbort, issCommit(m), prune(m), reconstruct(m),
  }

  action step = stepWith(SOUND)
  action stepBeforeInControl = stepWith(SOUND.with("beforeInControl", true))
  action stepCompactAlways = stepWith(SOUND.with("compactAlways", true))
  action stepSkipTargetCheck = stepWith(SOUND.with("skipTargetCheck", true))
  action stepExcludeClosing = stepWith(SOUND.with("excludeClosing", true))
  action stepHistoricalSource = stepWith(SOUND.with("historicalSource", true))
  action stepCommittedLaterExpires = stepWith(SOUND.with("committedLaterExpires", true))
  action stepHolesForWindow = stepWith(SOUND.with("holesForWindow", true))
  action stepFloorSkipsPending = stepWith(SOUND.with("floorSkipsPending", true))
  action stepNoHandBackReserve = stepWith(SOUND.with("noHandBackReserve", true))
  action stepAdmissionOmitsHoles = stepWith(SOUND.with("admissionOmitsHoles", true))
  action stepReplacedReceiptUncharged = stepWith(SOUND.with("replacedReceiptUncharged", true))

  def soundForecast: int = forecast(rows, entries, handBacks, applied, completedHoles, if (ctlActive != NONE) activeHoles else Set(), SOUND)
  val imageWithinForecast = actualImage <= soundForecast
  val maintenanceAdmits = soundForecast <= CAP
  val forecastOnlyGrowsByAdmission = not(forecastGrew)
  val neverStuck = not(stuck)
  val restoresTrueSource = not(wrongSource)
  val noPendingLost = not(pendingLost)
  val allProperties = imageWithinForecast and maintenanceAdmits and forecastOnlyGrowsByAdmission and
    neverStuck and restoresTrueSource and noPendingLost

  // Witnesses: violated means reachable.
  val noCustodySeen = entries.size() == 0
  val noCompactionSeen = not(compacted)
  val noReconstructSeen = not(reconstructed)
  val noAdmissionRefusalSeen = not(admissionRefused)
  val noHandBackSeen = not(handBackSeen)
  val noPruneSeen = not(pruneSeen)
  val noReplacedSourceSeen = not(replacedSourceSeen)
}
