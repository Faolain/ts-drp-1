// -*- mode: Bluespec; -*-
/**
 * Maintenance native image capacity: rules A + B + D, and the agreement between
 * ordinary admission and creator maintenance on ONE forecast.
 *
 * Census image (one bounded native read) = envelopes + own settlement plan +
 * issuance retirement control carriers. Units are abstract bytes.
 *
 * Forecast F (shared by admission and maintenance):
 *   F = ENV*|rows| + PR + max(PR, exact completed BEFORE bytes)
 *   PR = FIXED + sum over entries of entryReserve + |potential sources| * perSource
 * The last term is the single plan carrier the control may hold.
 *
 * A1  A preparation stores BEFORE plan bytes and only a digest of AFTER; the
 *     committed target image digest binds AFTER, and reconstruction checks it.
 * A2  Preparing a new retirement compacts the previous completed preparation
 *     (drops BEFORE bytes). It is enabled only when the coordinator has globally
 *     completed that decision; otherwise prepare is refused (abort paths only).
 * B   Potential sources: own rows without an entry whose epoch is after the last
 *     close applied to the plan. A close adds entries only for rows of its epoch.
 * D   perSource = ENTRY + max(MEMBER, EXPIRY): a committed entry never gains an
 *     expiry; an unresolved entry is reserved as a future expiry.
 *
 * Invariants (allProperties):
 *   imageWithinForecast - actual census bytes never exceed F.
 *   maintenanceAdmits   - F <= CAP in every reachable state: anything admitted
 *                         is never refused later by maintenance sizing.
 *   forecastOnlyGrowsByAdmission - no non-admission step raises F.
 *   neverStuck, restoresTrueSource - resume of a committed participant.
 *
 * Mutant controls (each must violate allProperties):
 *   keepAfterBytes, prepareKeepsCompleted (A: two plan carriers),
 *   compactAlways, skipTargetCheck (A2, A1),
 *   excludeClosing, historicalSource (B),
 *   committedLaterExpires (D),
 *   admissionWithoutCarrier (admission/maintenance disagreement).
 * Witnesses (must be reachable): noCustodySeen, noCompactionSeen,
 *   noReconstructSeen, noAdmissionRefusalSeen.
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
  pure val CAP = 24
  pure val DECISIONS = Set(0, 1)
  pure val NONE = -1

  type Row = { id: int, ep: int }
  // res: "manual" (unresolved), "committed", "expire", "both" (mutant only)
  type Entry = { id: int, res: str }

  type Mut = {
    keepAfterBytes: bool, prepareKeepsCompleted: bool, compactAlways: bool, skipTargetCheck: bool,
    excludeClosing: bool, historicalSource: bool, committedLaterExpires: bool, admissionWithoutCarrier: bool,
  }
  pure val SOUND: Mut = {
    keepAfterBytes: false, prepareKeepsCompleted: false, compactAlways: false, skipTargetCheck: false,
    excludeClosing: false, historicalSource: false, committedLaterExpires: false, admissionWithoutCarrier: false,
  }

  var epoch: int
  var applied: int
  var rows: Set[Row]
  var entries: Set[Entry]
  var nextId: int
  var aheActive: int
  var aheCompleted: int
  var ctlActive: int
  var activeThrough: int
  var activeBefore: Set[Entry]
  var activeAfterBytes: bool
  var ctlCompleted: int
  var completedFull: bool
  var completedBefore: Set[Entry]
  var completedAfter: Set[Entry]
  var completedAfterBytes: bool
  var targetRows: Set[int]
  var trueSourceRows: Set[int]
  var trueSourcePlan: Set[Entry]
  var forecastGrew: bool
  var stuck: bool
  var wrongSource: bool
  var compacted: bool
  var reconstructed: bool
  var admissionRefused: bool

  pure def rowIds(rs: Set[Row]): Set[int] = rs.map(r => r.id)
  pure def entryIds(es: Set[Entry]): Set[int] = es.map(e => e.id)
  pure def sum(xs: Set[Entry], f: Entry => int): int = xs.fold(0, (acc, e) => acc + f(e))

  pure def cost(e: Entry): int =
    ENTRY + (if (e.res == "committed") MEMBER else if (e.res == "expire") EXPIRY
      else if (e.res == "both") MEMBER + EXPIRY else 0)
  pure def planBytes(es: Set[Entry]): int = if (es.size() == 0) 0 else FIXED + sum(es, cost)

  // D: an unresolved entry may still gain an expiry; resolved entries are exact.
  pure def entryReserve(e: Entry): int =
    ENTRY + (if (e.res == "committed") MEMBER else if (e.res == "both") MEMBER + EXPIRY else EXPIRY)
  pure val PER_SOURCE = ENTRY + (if (MEMBER > EXPIRY) MEMBER else EXPIRY)

  // B: rows that can still become sources.
  pure def potential(rs: Set[Row], es: Set[Entry], appliedEpoch: int, excludeClosing: bool): Set[Row] =
    rs.filter(r => not(entryIds(es).contains(r.id)) and r.ep > appliedEpoch + (if (excludeClosing) 1 else 0))

  pure def planReserve(rs: Set[Row], es: Set[Entry], appliedEpoch: int, m: Mut): int =
    FIXED + sum(es, entryReserve) + PER_SOURCE * potential(rs, es, appliedEpoch, m.excludeClosing).size()

  // The control carries at most one plan: an active BEFORE (bounded by the plan
  // reservation) or a completed BEFORE, whose exact bytes are known.
  pure def forecast(rs: Set[Row], es: Set[Entry], appliedEpoch: int, full: bool, before: Set[Entry], m: Mut): int = {
    val pr = planReserve(rs, es, appliedEpoch, m)
    val carrier = if (full and planBytes(before) > pr) planBytes(before) else pr
    ENV * rs.size() + pr + carrier
  }

  // What admission checks. The mutant forgets the control's plan carrier.
  pure def admissionForecast(rs: Set[Row], es: Set[Entry], appliedEpoch: int, full: bool, before: Set[Entry], m: Mut): int =
    if (m.admissionWithoutCarrier) ENV * rs.size() + planReserve(rs, es, appliedEpoch, m)
    else forecast(rs, es, appliedEpoch, full, before, m)

  pure def retiredPlan(es: Set[Entry], rs: Set[Row], through: int): Set[Entry] =
    es.filter(e => rs.exists(r => r.id == e.id and r.ep > through))

  def actualImage: int =
    ENV * rows.size() + planBytes(entries) +
    (if (ctlActive != NONE) planBytes(activeBefore) +
      (if (activeAfterBytes) planBytes(retiredPlan(activeBefore, rows, activeThrough)) else 0) else 0) +
    (if (completedFull) planBytes(completedBefore) else 0) +
    (if (completedAfterBytes) planBytes(completedAfter) else 0)

  action init = all {
    epoch' = 0, applied' = -1, rows' = Set(), entries' = Set(), nextId' = 0,
    aheActive' = NONE, aheCompleted' = NONE,
    ctlActive' = NONE, activeThrough' = NONE, activeBefore' = Set(), activeAfterBytes' = false,
    ctlCompleted' = NONE, completedFull' = false, completedBefore' = Set(), completedAfter' = Set(),
    completedAfterBytes' = false, targetRows' = Set(), trueSourceRows' = Set(), trueSourcePlan' = Set(),
    forecastGrew' = false, stuck' = false, wrongSource' = false, compacted' = false,
    reconstructed' = false, admissionRefused' = false,
  }

  action keepCtl = all {
    aheActive' = aheActive, aheCompleted' = aheCompleted,
    ctlActive' = ctlActive, activeThrough' = activeThrough, activeBefore' = activeBefore,
    activeAfterBytes' = activeAfterBytes, ctlCompleted' = ctlCompleted, completedFull' = completedFull,
    completedBefore' = completedBefore, completedAfter' = completedAfter,
    completedAfterBytes' = completedAfterBytes, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
  }
  action keepFlags = all {
    stuck' = stuck, wrongSource' = wrongSource, compacted' = compacted, reconstructed' = reconstructed,
  }

  // ---- Ordinary admission: the only step allowed to raise the forecast. ----
  action issue(m: Mut): bool = {
    val grown = rows.union(Set({ id: nextId, ep: epoch }))
    all {
      rows.size() < MAXROWS,
      if (admissionForecast(grown, entries, applied, completedFull, completedBefore, m) <= CAP) all {
        rows' = grown, nextId' = nextId + 1, admissionRefused' = admissionRefused,
      } else all {
        rows' = rows, nextId' = nextId, admissionRefused' = true,
      },
      epoch' = epoch, applied' = applied, entries' = entries, forecastGrew' = forecastGrew,
      keepCtl, keepFlags,
    }
  }

  action advance = all {
    epoch < EPOCHS - 1,
    epoch' = epoch + 1,
    applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
    forecastGrew' = forecastGrew, admissionRefused' = admissionRefused, keepCtl, keepFlags,
  }

  // ---- Non-admission steps: none may raise the forecast. ----
  action planStep(m: Mut, nextApplied: int, nextEntries: Set[Entry], nextFull: bool, nextBefore: Set[Entry]): bool = all {
    applied' = nextApplied,
    entries' = nextEntries,
    forecastGrew' = (forecastGrew or forecast(rows, nextEntries, nextApplied, nextFull, nextBefore, m) >
      forecast(rows, entries, applied, completedFull, completedBefore, m)),
    epoch' = epoch, rows' = rows, nextId' = nextId, admissionRefused' = admissionRefused,
  }

  // Close of epoch applied+1 applied to the plan (CAS refuses it under a prepared checkpoint).
  action closeApply(m: Mut): bool = {
    val e = applied + 1
    val candidates = rows.filter(r => not(entryIds(entries).contains(r.id)) and
      (if (m.historicalSource) r.ep <= e else r.ep == e))
    all {
      e < epoch, ctlActive == NONE,
      nondet added = candidates.powerset().oneOf()
      nondet res = Set("manual", "committed", "expire").oneOf()
      planStep(m, e, entries.union(added.map(r => { id: r.id, res: res })), completedFull, completedBefore),
      keepCtl, keepFlags,
    }
  }

  // Frontier resolution: an unresolved entry expires. Mutant: a committed one too.
  action frontierResolve(m: Mut): bool = all {
    ctlActive == NONE,
    nondet e = entries.oneOf()
    all {
      e.res == "manual" or (m.committedLaterExpires and e.res == "committed"),
      planStep(m, applied, entries.exclude(Set(e)).union(Set({ id: e.id, res: if (e.res == "manual") "expire" else "both" })), completedFull, completedBefore),
    },
    keepCtl, keepFlags,
  }

  // ---- Coordinator. ----
  action aheBegin = all {
    aheActive == NONE,
    nondet d = DECISIONS.oneOf()
    all { d != aheCompleted, aheActive' = d },
    aheCompleted' = aheCompleted,
    ctlActive' = ctlActive, activeThrough' = activeThrough, activeBefore' = activeBefore,
    activeAfterBytes' = activeAfterBytes, ctlCompleted' = ctlCompleted, completedFull' = completedFull,
    completedBefore' = completedBefore, completedAfter' = completedAfter,
    completedAfterBytes' = completedAfterBytes, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
    epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
    forecastGrew' = forecastGrew, admissionRefused' = admissionRefused, keepFlags,
  }

  // Adversarial: the coordinator may abandon its active intent at any time.
  action aheAbort = all {
    aheActive != NONE,
    aheActive' = NONE, aheCompleted' = aheCompleted,
    ctlActive' = ctlActive, activeThrough' = activeThrough, activeBefore' = activeBefore,
    activeAfterBytes' = activeAfterBytes, ctlCompleted' = ctlCompleted, completedFull' = completedFull,
    completedBefore' = completedBefore, completedAfter' = completedAfter,
    completedAfterBytes' = completedAfterBytes, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
    epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
    forecastGrew' = forecastGrew, admissionRefused' = admissionRefused, keepFlags,
  }

  action aheComplete = all {
    aheActive != NONE, ctlActive == NONE, ctlCompleted == aheActive,
    aheCompleted' = aheActive, aheActive' = NONE,
    ctlActive' = ctlActive, activeThrough' = activeThrough, activeBefore' = activeBefore,
    activeAfterBytes' = activeAfterBytes, ctlCompleted' = ctlCompleted, completedFull' = completedFull,
    completedBefore' = completedBefore, completedAfter' = completedAfter,
    completedAfterBytes' = completedAfterBytes, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
    epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
    forecastGrew' = forecastGrew, admissionRefused' = admissionRefused, keepFlags,
  }

  // ---- Issuance retirement participant. ----
  action issPrepare(m: Mut): bool = {
    val compactable = ctlCompleted == NONE or not(completedFull) or aheCompleted == ctlCompleted
    val compacting = ctlCompleted != NONE and completedFull and not(m.prepareKeepsCompleted)
    all {
      ctlActive == NONE, aheActive != NONE, ctlCompleted != aheActive, applied >= 0,
      m.compactAlways or m.prepareKeepsCompleted or compactable,
      nondet t = 0.to(applied).oneOf()
      all {
        ctlActive' = aheActive,
        activeThrough' = t,
        activeBefore' = entries,
        activeAfterBytes' = m.keepAfterBytes,
        completedFull' = if (m.prepareKeepsCompleted) completedFull else false,
        completedAfterBytes' = if (m.prepareKeepsCompleted) completedAfterBytes else false,
        compacted' = (compacted or compacting),
      },
      aheActive' = aheActive, aheCompleted' = aheCompleted, ctlCompleted' = ctlCompleted,
      completedBefore' = completedBefore, completedAfter' = completedAfter, targetRows' = targetRows,
      trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
      epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
      forecastGrew' = forecastGrew, admissionRefused' = admissionRefused,
      stuck' = stuck, wrongSource' = wrongSource, reconstructed' = reconstructed,
    }
  }

  action issAbort = all {
    ctlActive != NONE,
    ctlActive' = NONE, activeBefore' = Set(), activeAfterBytes' = false, activeThrough' = NONE,
    aheActive' = aheActive, aheCompleted' = aheCompleted, ctlCompleted' = ctlCompleted,
    completedFull' = completedFull, completedBefore' = completedBefore, completedAfter' = completedAfter,
    completedAfterBytes' = completedAfterBytes, targetRows' = targetRows,
    trueSourceRows' = trueSourceRows, trueSourcePlan' = trueSourcePlan,
    epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
    forecastGrew' = forecastGrew, admissionRefused' = admissionRefused, keepFlags,
  }

  // Commit rewrites only the plan: entries of retired epochs leave it.
  action issCommit(m: Mut): bool = {
    val after = retiredPlan(entries, rows, activeThrough)
    all {
      ctlActive != NONE,
      ctlActive' = NONE, activeBefore' = Set(), activeAfterBytes' = false, activeThrough' = NONE,
      ctlCompleted' = ctlActive, completedFull' = true, completedBefore' = entries,
      completedAfter' = after, completedAfterBytes' = activeAfterBytes,
      targetRows' = rowIds(rows), trueSourceRows' = rowIds(rows), trueSourcePlan' = entries,
      planStep(m, applied, after, true, entries),
      aheActive' = aheActive, aheCompleted' = aheCompleted, keepFlags,
    }
  }

  // Pruning removes retired-epoch rows once no resume can need them.
  action prune = all {
    ctlActive == NONE, ctlCompleted != NONE, aheActive != ctlCompleted,
    nondet t = 0.to(applied).oneOf()
    val kept = rows.filter(r => r.ep > t or entryIds(entries).contains(r.id))
    all {
      rows' = kept,
      forecastGrew' = forecastGrew,
    },
    epoch' = epoch, applied' = applied, entries' = entries, nextId' = nextId,
    admissionRefused' = admissionRefused, keepCtl, keepFlags,
  }

  // Resume of an active coordinator intent whose participant already committed.
  action reconstruct(m: Mut): bool = all {
    ctlActive == NONE, ctlCompleted != NONE, aheActive == ctlCompleted,
    m.skipTargetCheck or (rowIds(rows) == targetRows and entries == completedAfter),
    stuck' = (stuck or not(completedFull)),
    wrongSource' = (wrongSource or (completedFull and
      (rowIds(rows) != trueSourceRows or completedBefore != trueSourcePlan))),
    reconstructed' = true,
    compacted' = compacted,
    epoch' = epoch, applied' = applied, rows' = rows, entries' = entries, nextId' = nextId,
    forecastGrew' = forecastGrew, admissionRefused' = admissionRefused, keepCtl,
  }

  action stepWith(m: Mut): bool = any {
    issue(m), advance, closeApply(m), frontierResolve(m),
    aheBegin, aheAbort, aheComplete,
    issPrepare(m), issAbort, issCommit(m), prune, reconstruct(m),
  }

  action step = stepWith(SOUND)
  action stepKeepAfterBytes = stepWith(SOUND.with("keepAfterBytes", true))
  action stepPrepareKeepsCompleted = stepWith(SOUND.with("prepareKeepsCompleted", true))
  action stepCompactAlways = stepWith(SOUND.with("compactAlways", true))
  action stepSkipTargetCheck = stepWith(SOUND.with("skipTargetCheck", true))
  action stepExcludeClosing = stepWith(SOUND.with("excludeClosing", true))
  action stepHistoricalSource = stepWith(SOUND.with("historicalSource", true))
  action stepCommittedLaterExpires = stepWith(SOUND.with("committedLaterExpires", true))
  action stepAdmissionWithoutCarrier = stepWith(SOUND.with("admissionWithoutCarrier", true))

  def soundForecast: int = forecast(rows, entries, applied, completedFull, completedBefore, SOUND)
  val imageWithinForecast = actualImage <= soundForecast
  val maintenanceAdmits = soundForecast <= CAP
  val forecastOnlyGrowsByAdmission = not(forecastGrew)
  val neverStuck = not(stuck)
  val restoresTrueSource = not(wrongSource)
  val allProperties = imageWithinForecast and maintenanceAdmits and forecastOnlyGrowsByAdmission and
    neverStuck and restoresTrueSource

  // Witnesses: violated means reachable.
  val noCustodySeen = entries.size() == 0
  val noCompactionSeen = not(compacted)
  val noReconstructSeen = not(reconstructed)
  val noAdmissionRefusalSeen = not(admissionRefused)
}
