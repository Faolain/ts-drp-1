// A creator's own epoch close across process death (SIGKILL after any native
// commit), and the recovery rules that let the reopened creator finish it.
//
// The close at the current epoch h runs, each step its own commit:
//   open    the close's snapshot quarantine scope h (temporary); before opening,
//           a full pool (counting every retained scope) runs turnover;
//   retain  that scope into the bounded recovery pool (a no-op slot-wise when
//           the scope is already retained: same scope, same incarnation);
//   bind    the Cut (membership + seal evidence): it carries the close's
//           recovery roles, classified = every pool scope below the previous
//           close (e < h - 1);
//   adopt   the staged successor head: h advances, the binding is consumed.
// Turnover retires the scopes the last certificate classified (e < h - 2).
// Readiness maintenance (maintain) may run turnover at any idle point, whatever
// the pool size; in steady state it runs right after every reopen.
// Death keeps every durable row and drops the close's volatile progress. The
// reopened creator runs readiness, then retries the same close.
// Admission (admit) of ordinary work changes the epoch's application state;
// the close's scope carries the state it was opened at, and a scope at epoch h
// with another state conflicts with the retry's declaration (identity is the
// epoch and anchor). While the close's own scope is on disk (temporary or
// retained, unadopted) admission is refused, retryably, until the close adopts.
//
// Rules under test (packages/node, creator-closed-rollback-data.ts):
//   readinessAdmits (acquireCreatorIssuanceMaintenanceProof)
//     every temporary scope outside the pool is at e >= h (the current close's
//     in-flight quarantine); the base required no scope outside the pool.
//   turnover        (selectAuthenticatedSnapshotTurnoverInventory)
//     an unprotected, unclassified retained scope above the certificate's
//     predecessor (e >= h) is the interrupted close's own: keep the whole pool
//     and retire nothing until it adopts. The base refused it (chain-invalid).
//     (Protected and classified scopes are never treated as in flight; in this
//     model every scope at e >= h is unknown to the last certificate.)
//   admission       (v3-live creatorInterruptedClosePending)
//     no ordinary local or received work enters an epoch whose own close
//     scope is on disk; the base admitted it.
// Mutants: strictReadiness (base readiness), refuseInFlight (base turnover),
// retireUnderBinding (tolerate the in-flight scope but still retire the
// classified scopes: the roles then change under the bound Cut),
// admitBeforeRetry (base admission: work admitted before the retry).
module creatorCloseCrashRecovery {
  pure val MAX_POOL = 4
  pure val LAST_EPOCH = 7
  pure val MAX_STATE = 1
  type Binding = { bound: bool, m: int, classified: Set[int] }
  type Mutants = { strictReadiness: bool, refuseInFlight: bool, retireUnderBinding: bool, admitBeforeRetry: bool }
  type Turnover = { ok: bool, pool: Set[int] }
  pure val SOUND: Mutants = { strictReadiness: false, refuseInFlight: false, retireUnderBinding: false, admitBeforeRetry: false }
  pure val NONE: Binding = { bound: false, m: 0, classified: Set() }

  var epoch: int
  var pool: Set[int]        // recovery-retained scopes (by epoch)
  var temps: Set[int]       // temporary quarantine scopes
  var binding: Binding      // the Cut bound by membership/seal evidence at epoch
  var phase: int            // volatile: 0 idle, 1 opened, 2 retained, 3 bound
  var wedged: bool          // a step refused where the protocol must progress
  var state: int            // the current epoch's admitted application state version
  var scopeState: int       // the state the close's own scope at epoch was opened at
  var mutants: Mutants

  pure def ownOnDisk(p: Set[int], ts: Set[int], h: int): bool = p.contains(h) or ts.contains(h)
  // The retry's declaration conflicts with an own scope opened at another state.
  pure def declarationAdmits(p: Set[int], ts: Set[int], h: int, m: int, sm: int): bool =
    if (ownOnDisk(p, ts, h)) sm == m else true

  pure def readinessAdmits(ts: Set[int], h: int, mu: Mutants): bool =
    if (mu.strictReadiness) ts.size() == 0 else ts.forall(t => t >= h)
  pure def turnover(p: Set[int], h: int, mu: Mutants): Turnover =
    val inFlight = p.exists(e => e >= h)
    val kept = p.filter(e => e >= h - 2)
    if (not(inFlight)) { ok: true, pool: kept }
    else if (mu.refuseInFlight) { ok: false, pool: p }
    else if (mu.retireUnderBinding) { ok: true, pool: kept }
    else { ok: true, pool: p }
  pure def roles(p: Set[int], h: int): Set[int] = p.filter(e => e < h - 1)
  // The pool after this close's pre-open capacity check (turnover when full).
  pure def checked(p: Set[int], h: int, mu: Mutants): Turnover =
    if (p.size() >= MAX_POOL) turnover(p, h, mu) else { ok: true, pool: p }

  // Whether the reopened creator can finish the close from durable state alone,
  // after a readiness maintenance pass (r) or without one.
  pure def retryFrom(h: int, m: int, sm: int, p: Set[int], ts: Set[int], b: Binding, mu: Mutants): bool =
    val c = checked(p, h, mu)
    val after = c.pool.union(Set(h))
    readinessAdmits(ts, h, mu) and c.ok and after.size() <= MAX_POOL and declarationAdmits(p, ts, h, m, sm) and
      (if (b.bound) b.classified == roles(after, h) and b.m == m else true)
  pure def retryCompletes(h: int, m: int, sm: int, p: Set[int], ts: Set[int], b: Binding, mu: Mutants): bool =
    val r = turnover(p, h, mu)
    retryFrom(h, m, sm, p, ts, b, mu) and r.ok and retryFrom(h, m, sm, r.pool, ts, b, mu)

  action initWith(mu: Mutants): bool = all {
    epoch' = 2, pool' = Set(0, 1), temps' = Set(), binding' = NONE, phase' = 0, wedged' = false,
    state' = 0, scopeState' = 0, mutants' = mu,
  }
  action init = initWith(SOUND)
  action initStrictReadiness = initWith({ ...SOUND, strictReadiness: true })
  action initRefuseInFlight = initWith({ ...SOUND, refuseInFlight: true })
  action initRetireUnderBinding = initWith({ ...SOUND, retireUnderBinding: true })
  action initAdmitBeforeRetry = initWith({ ...SOUND, admitBeforeRetry: true })

  action open: bool = all {
    phase == 0, epoch < LAST_EPOCH,
    val c = checked(pool, epoch, mutants)
    val ok = readinessAdmits(temps, epoch, mutants) and c.ok and declarationAdmits(pool, temps, epoch, state, scopeState)
    all {
      wedged' = if (wedged) true else not(ok),
      pool' = if (ok) c.pool else pool,
      temps' = if (ok and not(c.pool.contains(epoch))) temps.union(Set(epoch)) else temps,
      phase' = if (ok) 1 else phase,
      scopeState' = if (ok) state else scopeState,
    },
    epoch' = epoch, binding' = binding, state' = state, mutants' = mutants,
  }
  action retain: bool = all {
    phase == 1,
    val after = pool.union(Set(epoch))
    all {
      wedged' = if (wedged) true else after.size() > MAX_POOL,
      pool' = if (after.size() <= MAX_POOL) after else pool,
      temps' = if (after.size() <= MAX_POOL) temps.exclude(Set(epoch)) else temps,
      phase' = if (after.size() <= MAX_POOL) 2 else phase,
    },
    epoch' = epoch, binding' = binding, state' = state, scopeState' = scopeState, mutants' = mutants,
  }
  action bind: bool = all {
    phase == 2,
    val cut = { bound: true, m: state, classified: roles(pool, epoch) }
    val ok = if (binding.bound) binding == cut else true
    all {
      wedged' = if (wedged) true else not(ok),
      binding' = if (ok) cut else binding,
      phase' = if (ok) 3 else phase,
    },
    epoch' = epoch, pool' = pool, temps' = temps, state' = state, scopeState' = scopeState, mutants' = mutants,
  }
  action adopt: bool = all {
    phase == 3,
    epoch' = epoch + 1, binding' = NONE, phase' = 0, state' = 0, scopeState' = 0,
    pool' = pool, temps' = temps, wedged' = wedged, mutants' = mutants,
  }
  // Readiness maintenance at an idle point (in steady state, after every reopen).
  action maintain: bool = all {
    phase == 0,
    val r = turnover(pool, epoch, mutants)
    val ok = readinessAdmits(temps, epoch, mutants) and r.ok
    all {
      wedged' = if (wedged) true else not(ok),
      pool' = if (ok) r.pool else pool,
    },
    epoch' = epoch, temps' = temps, binding' = binding, phase' = phase, state' = state, scopeState' = scopeState,
    mutants' = mutants,
  }
  // Ordinary local or received work offered at an idle point (after a reopen,
  // before the retry). Refused, retryably and without a wedge, while the close's
  // own scope is on disk; otherwise it changes the epoch's state.
  action admit: bool = all {
    phase == 0, state < MAX_STATE,
    val refused = if (mutants.admitBeforeRetry) false else ownOnDisk(pool, temps, epoch)
    state' = if (refused) state else state + 1,
    epoch' = epoch, pool' = pool, temps' = temps, binding' = binding, phase' = phase, wedged' = wedged,
    scopeState' = scopeState, mutants' = mutants,
  }
  action die: bool = all {
    phase != 0, phase' = 0,
    epoch' = epoch, pool' = pool, temps' = temps, binding' = binding,
    wedged' = wedged, state' = state, scopeState' = scopeState, mutants' = mutants,
  }
  action keep: bool = all {
    epoch' = epoch, pool' = pool, temps' = temps, binding' = binding,
    phase' = phase, wedged' = wedged, state' = state, scopeState' = scopeState, mutants' = mutants,
  }
  action step = any { open, retain, bind, adopt, maintain, admit, die }

  // Safety: no step ever refuses, and from every idle durable state the retry
  // finishes, with or without a readiness maintenance pass first.
  val noWedge = not(wedged)
  // if-forms: the quint 0.32 evaluator mis-evaluated some `or` chains (see received-quarantine-supersede.qnt).
  val recoverable = if (phase != 0) true else if (epoch >= LAST_EPOCH) true
    else retryCompletes(epoch, state, scopeState, pool, temps, binding, mutants)
  val boundedPool = pool.size() <= MAX_POOL
  val safety = if (not(noWedge)) false else if (not(recoverable)) false else boundedPool

  // Witnesses: death after each committed boundary at a full pool (h = 3) and in
  // steady state (h = 5, maintenance after every adopt), then the retry and one more epoch.
  run close = open.then(retain).then(bind).then(adopt)
  run diesAfterOpenTest = init.then(close).then(open).then(die)
    .then(all { assert(safety), open }).then(retain).then(bind).then(adopt).then(all { assert(safety), open })
  run diesAfterRetainTest = init.then(close).then(open).then(retain).then(die)
    .then(all { assert(safety), open }).then(retain).then(bind).then(adopt).then(all { assert(safety), open })
  run diesAfterBindTest = init.then(close).then(open).then(retain).then(bind).then(die)
    .then(all { assert(safety), maintain }).then(all { assert(safety), open }).then(retain).then(bind).then(adopt)
    .then(all { assert(safety), open })
  run steadyDiesAfterBindTest = init.then(close).then(maintain).then(close).then(maintain).then(close).then(maintain)
    .then(open).then(retain).then(bind).then(die).then(all { assert(safety), maintain }).then(all { assert(safety), open })
    .then(retain).then(bind).then(adopt).then(all { assert(safety and epoch == 6), maintain })
  // Broken controls: each base rule wedges at its own boundary.
  run strictReadinessBrokenTest = initStrictReadiness.then(close).then(open).then(die)
    .then(all { assert(not(recoverable)), open }).then(all { assert(wedged), keep })
  run refuseInFlightBrokenTest = initRefuseInFlight.then(close).then(open).then(retain).then(bind).then(die)
    .then(all { assert(not(recoverable)), open }).then(all { assert(wedged), keep })
  // Work offered before the retry, at each boundary: refused, then the retry,
  // then the same work admitted in the next epoch.
  run offeredAfterOpenTest = init.then(close).then(open).then(die).then(admit)
    .then(all { assert(safety and state == 0), open }).then(retain).then(bind).then(adopt)
    .then(admit).then(all { assert(safety and state == 1), open })
  run offeredAfterBindTest = init.then(close).then(open).then(retain).then(bind).then(die).then(admit)
    .then(all { assert(safety and state == 0), maintain }).then(open).then(retain).then(bind).then(adopt)
    .then(admit).then(all { assert(safety and state == 1), open })
  run admitBeforeRetryBrokenTest = initAdmitBeforeRetry.then(close).then(open).then(die).then(admit)
    .then(all { assert(not(recoverable)), open }).then(all { assert(wedged), keep })
  run admitBeforeRetryAfterBindBrokenTest = initAdmitBeforeRetry.then(close).then(open).then(retain).then(bind)
    .then(die).then(admit).then(all { assert(not(recoverable)), open }).then(all { assert(wedged), keep })
  run retireUnderBindingBrokenTest = initRetireUnderBinding.then(close).then(open).then(retain).then(bind).then(die)
    .then(all { assert(not(recoverable)), open }).then(retain).then(all { assert(not(wedged)), bind })
    .then(all { assert(wedged), keep })
}
