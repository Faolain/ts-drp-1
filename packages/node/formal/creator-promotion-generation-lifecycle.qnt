module creatorPromotionGenerationLifecycle {
  // Native AHE generation lifecycle above an installed creator forward promotion.
  //
  // A promotion is decided by the close of epoch F (its Cut F carries the signed
  // forward promotion, source s = F-1 or F-2, and no recovery roles) and installed
  // as epoch E = F+1. Generations are named by kind and projection epoch:
  //   L(e)  adopted live generation of epoch e: projection e, carries Cut e-1;
  //   Q(e)  close generation of epoch e: projection e, carries Cut e.
  // closureAt(x+1) = L(x+1) is the generation a certificate reads for snapshot
  // scope x (its Cut x and projection x+1).
  //
  // Consumers (what a recovery, cold reopen or rollback actually reads):
  //  * reopen of the promoted epoch E re-verifies the promotion decision
  //    (acquireInstalledPromotion at n' = F): L(E), current L(F), decision Q(F),
  //    ancestry link Q(F-1) and prior L(F-1) (historical Cut F-2);
  //  * reopen of an ordinary epoch e > E authenticates L(e), Q(e-1), L(e-1)
  //    (the two newest Cuts are the two usable rollback slots e-1, e-2);
  //  * the first certificate above the promotion (epoch E+1) checks the closed
  //    promoted projection of E against the operational source s: closure L(s+1);
  //  * every certificate at e reads one closure per operational and classified
  //    scope of the signed Cut e-1, and the prior Cut's previous close.
  //
  // The planner (the rule under test) computes protection from the structures
  // the code holds: forward rows, installed promotion support, certificate
  // source bindings (and, on the original route, the re-acquired support).
  // Snapshot turnover and classification follow the readback law's allowed set.
  pure val HEADROOM = 5 // AHE maxObjectGenerations (7) - 2: rows a close may start from
  pure val MAX_ROWS = 7
  pure val MAX_SCOPES = 4
  pure val STEPS = 4

  type Row = { k: str, e: int }
  type Roles = { op: Set[int], cl: Set[int], prev: int }
  type Rule = {
    original: bool,                 // first certificate re-acquires the installed promotion and inherits its support (shipped 1b)
    retireAtPromoted: bool,         // installed support is unprotected while E is still the live epoch
    ignoreClassified: bool,         // certificate does not retain classified scope closures
    dropOperational: bool,          // first certificate does not retain the operational source closure
    dischargeOperational: bool,     // E+2 planner treats the old operational source as discharged
    forecastIgnoresClassified: bool, // promoted-epoch forecast uses the genesis shape (no classified scopes)
  }
  pure val SOUND: Rule = { original: false, retireAtPromoted: false, ignoreClassified: false, dropOperational: false,
    dischargeOperational: false, forecastIgnoresClassified: false }

  pure def L(e: int): Row = { k: "L", e: e }
  pure def Q(e: int): Row = { k: "Q", e: e }
  pure def closure(x: int): Row = L(x + 1)

  var floorF: int
  var source: int
  var epoch: int
  var phase: str            // "maintain" | "close"
  var rows: Set[Row]
  var snaps: Set[int]
  var cuts: int -> Roles    // signed roles of Cut e, e >= E (Cut F has none)
  var forecast: Set[Row]    // rows the promoted epoch's sizing counted droppable after its close
  var wedged: bool          // a close found no headroom (MAINTENANCE_AUTHENTICATED_SOURCE_HEADROOM)
  var retired: Set[Row]

  def promoted: int = floorF + 1
  def present(x: int): bool = x >= 0
  // acquireInstalledPromotion supportGenerations: current, proposed, pending, prior.
  def support: Set[Row] = Set(L(floorF), Q(floorF), Q(floorF - 1), L(floorF - 1))
  // installed authenticatedSourceGenerations: scope -> the generation carrying its Cut.
  def bind(x: int): Row = if (x == floorF) Q(floorF) else L(x + 1)
  def retainedSources: Set[int] = Set(floorF - 1, floorF - 2).filter(x => present(x) and x != source)

  // ---- Consumers ----
  def need(e: int): Set[Row] =
    val base = if (e == promoted) Set(L(promoted)).union(support) else Set(L(e), Q(e - 1), L(e - 1))
    val continuity = if (e == promoted + 1) Set(closure(source)) else Set()
    val signed = if (e >= promoted + 1) cuts.get(e - 1).op.union(cuts.get(e - 1).cl).map(closure) else Set()
    val priorPrevious = if (e >= promoted + 2) Set(closure(cuts.get(e - 2).prev)) else Set()
    base.union(continuity).union(signed).union(priorPrevious)
  def needSnapshots(e: int): Set[int] =
    if (e == promoted) Set(source, floorF, floorF - 1, floorF - 2).filter(present)
    else Set(e - 1, e - 2).union(cuts.get(e - 1).op)

  // ---- Planner (rule under test) ----
  def protectedRows(e: int, m: Rule): Set[Row] =
    if (e == promoted)
      if (m.retireAtPromoted) Set(L(promoted), Q(floorF), L(floorF)) else Set(L(promoted)).union(support)
    else
      val roles = cuts.get(e - 1)
      val cl = if (m.ignoreClassified) Set() else roles.cl
      val op = if (m.dropOperational) Set() else roles.op
      val prior = if (e >= promoted + 2) Set(closure(cuts.get(e - 2).prev)) else Set()
      val discharged = if (m.dischargeOperational and e == promoted + 2) cuts.get(promoted).op.map(closure) else Set()
      val inherited = if (m.original and e == promoted + 1) support else Set()
      Set(L(e), Q(e - 1), L(e - 1)).union(op.union(cl).map(closure)).union(prior).exclude(discharged).union(inherited)
  def protectedSnapshots(e: int): Set[int] =
    if (e == promoted) Set(source, floorF, floorF - 1, floorF - 2).filter(present)
    else Set(e - 1, e - 2).union(cuts.get(e - 1).op)
  // Readback law: scopes the certificate of Cut e may classify.
  def allowed(e: int): Set[int] =
    if (e == promoted) retainedSources
    else
      val prior = cuts.get(e - 1)
      val parent = if (e - 2 >= promoted) Set(cuts.get(e - 2).prev).intersect(prior.cl) else Set()
      Set(prior.prev).union(prior.op).union(parent)
  // Issue sizing at E: installed support outside the future certificate's closures.
  def forecastAt(m: Rule, cl: Set[int]): Set[Row] =
    val scopes = if (m.forecastIgnoresClassified) Set(source) else Set(source).union(cl)
    support.exclude(Set(L(promoted)).union(scopes.map(bind)))

  // ---- Properties ----
  val safety = not(wedged) implies need(epoch).subseteq(rows)
  val snapshotSafety = not(wedged) implies needSnapshots(epoch).subseteq(snaps)
  val neverRetireNeeded = not(wedged) implies retired.intersect(need(epoch)).size() == 0
  val classificationValid = cuts.keys().forall(e => cuts.get(e).cl.subseteq(allowed(e)))
  val forecastSound = (epoch == promoted + 1 and phase == "maintain") implies
    (forecast.intersect(need(epoch)).size() == 0 and rows.exclude(forecast).size() <= HEADROOM)
  val noWedge = not(wedged)
  val bounded = rows.size() <= MAX_ROWS and snaps.size() <= MAX_SCOPES
  val prePromotionRetired = (epoch >= promoted + STEPS and phase == "close") implies rows.filter(r => r.e <= floorF) == Set()
  val inv = safety and snapshotSafety and neverRetireNeeded and classificationValid and forecastSound and noWedge and bounded and
    prePromotionRetired

  // ---- Actions ----
  action init = {
    nondet f = 2.to(4).oneOf()
    nondet s = Set(f - 1, f - 2).oneOf()
    nondet header = Set(true, false).oneOf() // an older normalized pre-promotion header L(F-2)
    all {
      floorF' = f, source' = s, epoch' = f + 1, phase' = "maintain",
      rows' = Set(L(f + 1), Q(f), L(f), Q(f - 1), L(f - 1)).union(if (header) Set(L(f - 2)) else Set()),
      snaps' = Set(f, f - 1, f - 2, s).filter(x => x >= 0),
      cuts' = Map(), forecast' = Set(), wedged' = false, retired' = Set(),
    }
  }

  // Capacity maintenance drains every row the planner leaves unprotected (the
  // most aggressive retirement; any real selection is a subset of it).
  action maintain(m: Rule): bool = all {
    phase == "maintain", not(wedged), epoch < promoted + STEPS + 1,
    val kept = rows.intersect(protectedRows(epoch, m))
    all { rows' = kept, retired' = retired.union(rows.exclude(kept)) },
    phase' = "close",
    floorF' = floorF, source' = source, epoch' = epoch, snaps' = snaps, cuts' = cuts, forecast' = forecast, wedged' = wedged,
  }

  // The close of `epoch`: snapshot turnover, signed roles, new Q/L pair.
  action close(m: Rule): bool = all {
    phase == "close", not(wedged), epoch < promoted + STEPS,
    val e = epoch
    val op: Set[int] = if (e == promoted) Set(source) else Set()
    val clPrev: Set[int] = if (e == promoted) Set() else cuts.get(e - 1).cl
    val candidates = protectedSnapshots(e).union(clPrev).exclude(Set(e - 1)).exclude(op)
    val keepable = protectedSnapshots(e).union(candidates.intersect(allowed(e)))
    nondet extra = candidates.intersect(allowed(e)).exclude(protectedSnapshots(e)).powerset().oneOf()
    val after = snaps.intersect(keepable.exclude(extra))
    val cl = candidates.intersect(after)
    if (rows.size() > HEADROOM or after.size() + 1 > MAX_SCOPES) all {
      wedged' = true,
      floorF' = floorF, source' = source, epoch' = epoch, phase' = phase, rows' = rows, snaps' = snaps, cuts' = cuts,
      forecast' = forecast, retired' = retired,
    } else all {
      cuts' = cuts.put(e, { op: op, cl: cl, prev: e - 1 }),
      snaps' = after.union(Set(e)),
      rows' = rows.union(Set(Q(e), L(e + 1))),
      forecast' = if (e == promoted) forecastAt(m, cl) else forecast,
      epoch' = e + 1, phase' = "maintain",
      floorF' = floorF, source' = source, wedged' = false, retired' = retired,
    }
  }

  action done = all {
    epoch >= promoted + STEPS, phase == "close",
    floorF' = floorF, source' = source, epoch' = epoch, phase' = phase, rows' = rows, snaps' = snaps, cuts' = cuts,
    forecast' = forecast, wedged' = wedged, retired' = retired,
  }
  action stuck = all {
    wedged,
    floorF' = floorF, source' = source, epoch' = epoch, phase' = phase, rows' = rows, snaps' = snaps, cuts' = cuts,
    forecast' = forecast, wedged' = wedged, retired' = retired,
  }

  action stepWith(m: Rule): bool = any { maintain(m), close(m), done, stuck }
  action step = stepWith(SOUND)
  action brokenOriginal = stepWith(SOUND.with("original", true))
  action brokenRetireAtPromoted = stepWith(SOUND.with("retireAtPromoted", true))
  action brokenIgnoreClassified = stepWith(SOUND.with("ignoreClassified", true))
  action brokenDropOperational = stepWith(SOUND.with("dropOperational", true))
  action brokenDischargeOperational = stepWith(SOUND.with("dischargeOperational", true))
  action brokenForecastIgnoresClassified = stepWith(SOUND.with("forecastIgnoresClassified", true))

  // ---- Deterministic scenarios ----
  action initWith(f: int, s: int, header: bool): bool = all {
    floorF' = f, source' = s, epoch' = f + 1, phase' = "maintain",
    rows' = Set(L(f + 1), Q(f), L(f), Q(f - 1), L(f - 1)).union(if (header) Set(L(f - 2)) else Set()),
    snaps' = Set(f, f - 1, f - 2, s).filter(x => x >= 0),
    cuts' = Map(), forecast' = Set(), wedged' = false, retired' = Set(),
  }

  // Floor 2, slot 1 (the measured gate case): four sound epochs retire the whole
  // pre-promotion chain with no needed row ever missing.
  run testSoundFloor2Slot1 =
    initWith(2, 1, false).then(maintain(SOUND)).then(close(SOUND)).expect(inv and forecast == Set(Q(2), Q(1)))
      .then(maintain(SOUND)).expect(inv and rows == Set(L(4), Q(3), L(3), L(2), L(1)))
      .then(close(SOUND)).expect(inv and cuts.get(4).cl == Set(1, 2))
      .then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND))
      .expect(inv and epoch == 7 and rows.filter(r => r.e <= 2) == Set())
  // Floor 2, slot 0 (source two below the floor; retained source F-1 has a closure).
  run testSoundFloor2Slot0 =
    initWith(2, 0, false).then(maintain(SOUND)).then(close(SOUND)).expect(inv and forecast == Set(Q(2), Q(1)))
      .then(maintain(SOUND)).expect(inv and rows == Set(L(4), Q(3), L(3), L(1), L(2)))
      .then(close(SOUND)).then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND)).then(close(SOUND))
      .then(maintain(SOUND)).expect(inv and epoch == 7 and rows.filter(r => r.e <= 2) == Set())
  // Floor 6, slot 4 with an older normalized header: still bounded and drained.
  run testSoundFloor6Slot4Header =
    initWith(6, 4, true).then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND)).then(close(SOUND))
      .then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND))
      .expect(inv and epoch == 11 and rows.filter(r => r.e <= 6) == Set())
  // The shipped route wedges at the first post-promotion close (defect 1b).
  run testOriginalWedges =
    initWith(2, 1, false).then(maintain(SOUND.with("original", true))).then(close(SOUND.with("original", true)))
      .then(maintain(SOUND.with("original", true))).then(close(SOUND.with("original", true)))
      .expect(wedged)
  // Retiring installed support while E is live loses the decision's prior L.
  run testRetireAtPromotedCaught =
    initWith(3, 1, false).then(maintain(SOUND.with("retireAtPromoted", true))).expect(not(safety))
  // A classified retained source loses its closure at E+1.
  run testIgnoreClassifiedCaught =
    initWith(2, 1, false).then(maintain(SOUND)).then(close(SOUND))
      .then(maintain(SOUND.with("ignoreClassified", true))).expect(not(safety))
  // The promoted projection's source closure is lost at E+1.
  run testDropOperationalCaught =
    initWith(3, 1, false).then(maintain(SOUND)).then(close(SOUND))
      .then(maintain(SOUND.with("dropOperational", true))).expect(not(safety))
  // Retiring too early, one epoch later: the E+2 certificate still reads the old
  // operational source as a classified scope.
  run testDischargeOperationalCaught =
    initWith(2, 1, false).then(maintain(SOUND)).then(close(SOUND)).then(maintain(SOUND)).then(close(SOUND))
      .then(maintain(SOUND.with("dischargeOperational", true))).expect(not(safety))
  // A promoted-epoch forecast that ignores the classified retained source counts
  // its closure droppable although the E+1 certificate reads it.
  run testForecastIgnoresClassifiedCaught =
    initWith(2, 0, false).then(maintain(SOUND)).then(close(SOUND.with("forecastIgnoresClassified", true)))
      .expect(not(forecastSound))
}
