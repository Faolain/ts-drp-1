module scheduledLullExportOrder {
  // The creator session's lifecycle FIFO (v3-room.ts enqueueLifetimeTransition) with the
  // scheduled recovery-pool lull (internal/recovery-pool-scheduled.ts) and the shipped rollover
  // policy (examples/v3-room/src/rollover.ts: seal, adopt, export, publish).
  //
  // Every admitted transition runs to completion, one at a time, in admission order. The
  // adoption schedules one lull for the epoch it produced. The policy's export is its
  // microtask continuation after the adoption resolves, so no macrotask (the held lull's 0 ms
  // timer) can run between the adoption's completion and the export's admission. Application
  // calls (an explicit lull) may be admitted at any time.
  //
  // Held lull (the fix): the adoption only holds the lull. The export is admitted ahead of a
  // held lull, which is then requested right behind it; every other admission requests a held
  // lull first; the timer requests it if nothing else does; close drops it.
  //
  // Properties:
  //   trackZ     - the scheduled lull of an epoch runs before the seal that closes that epoch
  //                (the scheduled lull's own contract: before any later transition).
  //   offerFirst - no scheduled lull runs while its epoch's export is pending (the offer a
  //                member installs from is not published behind a pool turnover). The export's bytes do not
  //                depend on the lull (measured: offers exported before and after the lull are
  //                byte-identical), so only the order is modelled.
  //   lullRuns   - with the FIFO and the timer weakly fair, every scheduled lull runs unless the
  //                session closes.
  //
  // Mutants (broken controls):
  //   inlineSchedule         - c08d8680: the adoption appends the lull to the FIFO itself, so it
  //                            precedes the export (violates offerFirst).
  //   noFlushBeforeAdmission - a non-export admission does not request a held lull first, so
  //                            after an adoption no export follows a seal can overtake it
  //                            (violates trackZ).
  //   noTimer                - a held lull is only requested by a later admission (violates
  //                            lullRuns: an idle creator never turns its pool over).
  pure val MAX_EPOCH = 3

  type Mutants = { inlineSchedule: bool, noFlushBeforeAdmission: bool, noTimer: bool }
  pure val SOUND: Mutants = { inlineSchedule: false, noFlushBeforeAdmission: false, noTimer: false }

  var fifo: List[str]        // admitted, not yet run: "seal" | "adopt" | "export" | "lull" | "xlull"
  var epoch: int             // the creator's adopted epoch
  var stage: str             // policy: "play" | "sealing" | "sealed" | "adopting" | "adopted" | "exporting"
  var held: bool             // a scheduled lull request is held
  var requested: int         // the last epoch whose lull was scheduled (0: none)
  var lullDone: Set[int]
  var exported: Set[int]
  var sealedBeforeLull: bool // a seal ran at an epoch whose scheduled lull had not run
  var lullBeforeOffer: bool  // a scheduled lull ran while its epoch's export was pending
  var closed: bool
  var m: Mutants

  // enqueueLifetimeTransition(transition, aheadOfScheduledLull)
  pure def admit(q: List[str], h: bool, t: str, ahead: bool, mu: Mutants): { q: List[str], h: bool } =
    if (ahead)
      { q: if (h) q.append(t).append("lull") else q.append(t), h: false }
    else if (h and not(mu.noFlushBeforeAdmission))
      { q: q.append("lull").append(t), h: false }
    else
      { q: q.append(t), h: h }

  // One init per configuration (the TLC translation needs each init spelled out).
  action init = all {
    fifo' = List(),
    epoch' = 0,
    stage' = "play",
    held' = false,
    requested' = 0,
    lullDone' = Set(),
    exported' = Set(),
    sealedBeforeLull' = false,
    lullBeforeOffer' = false,
    closed' = false,
    m' = SOUND,
  }
  action initInline = all {
    fifo' = List(),
    epoch' = 0,
    stage' = "play",
    held' = false,
    requested' = 0,
    lullDone' = Set(),
    exported' = Set(),
    sealedBeforeLull' = false,
    lullBeforeOffer' = false,
    closed' = false,
    m' = { ...SOUND, inlineSchedule: true },
  }
  action initNoFlush = all {
    fifo' = List(),
    epoch' = 0,
    stage' = "play",
    held' = false,
    requested' = 0,
    lullDone' = Set(),
    exported' = Set(),
    sealedBeforeLull' = false,
    lullBeforeOffer' = false,
    closed' = false,
    m' = { ...SOUND, noFlushBeforeAdmission: true },
  }
  action initNoTimer = all {
    fifo' = List(),
    epoch' = 0,
    stage' = "play",
    held' = false,
    requested' = 0,
    lullDone' = Set(),
    exported' = Set(),
    sealedBeforeLull' = false,
    lullBeforeOffer' = false,
    closed' = false,
    m' = { ...SOUND, noTimer: true },
  }

  action unchangedFlags = all {
    sealedBeforeLull' = sealedBeforeLull,
    lullBeforeOffer' = lullBeforeOffer,
    closed' = closed,
    m' = m,
  }

  // The policy's budget is reached: it seals (after its previous rollover settled).
  action policySeal = all {
    not(closed),
    epoch < MAX_EPOCH,
    stage == "play",
    val r = admit(fifo, held, "seal", false, m)
    all { fifo' = r.q, held' = r.h },
    stage' = "sealing",
    epoch' = epoch, requested' = requested, lullDone' = lullDone, exported' = exported,
    unchangedFlags,
  }

  action policyAdopt = all {
    not(closed),
    stage == "sealed",
    val r = admit(fifo, held, "adopt", false, m)
    all { fifo' = r.q, held' = r.h },
    stage' = "adopting",
    epoch' = epoch, requested' = requested, lullDone' = lullDone, exported' = exported,
    unchangedFlags,
  }

  // The policy's microtask continuation of the adoption.
  action policyExport = all {
    not(closed),
    stage == "adopted",
    val r = admit(fifo, held, "export", true, m)
    all { fifo' = r.q, held' = r.h },
    stage' = "exporting",
    epoch' = epoch, requested' = requested, lullDone' = lullDone, exported' = exported,
    unchangedFlags,
  }

  // An adoption that no export follows (a member's install schedules its lull the same way; a
  // refused or skipped export): only flush-before-admission or the timer requests its lull.
  action skipExport = all {
    not(closed),
    stage == "adopted",
    stage' = "play",
    fifo' = fifo, held' = held, epoch' = epoch, requested' = requested, lullDone' = lullDone, exported' = exported,
    unchangedFlags,
  }

  // An application's explicit maintainRecoveryPool() call (any macrotask; never inside the
  // adoption's microtask continuation). It settles the epoch too, but it is the application's
  // own request, so offerFirst does not count it.
  action explicitLull = all {
    not(closed),
    stage != "adopted",
    fifo.length() < 4,
    val r = admit(fifo, held, "xlull", false, m)
    all { fifo' = r.q, held' = r.h },
    stage' = stage, epoch' = epoch, requested' = requested, lullDone' = lullDone, exported' = exported,
    unchangedFlags,
  }

  // The held lull's 0 ms timer: a macrotask, so never between the adoption and the export.
  action timer = all {
    not(closed),
    not(m.noTimer),
    held,
    stage != "adopted",
    fifo' = fifo.append("lull"),
    held' = false,
    stage' = stage, epoch' = epoch, requested' = requested, lullDone' = lullDone, exported' = exported,
    unchangedFlags,
  }

  // closeSession: cancels a held request; nothing runs after.
  action close = all {
    not(closed),
    held' = false,
    closed' = true,
    fifo' = fifo, stage' = stage, epoch' = epoch, requested' = requested, lullDone' = lullDone,
    exported' = exported, sealedBeforeLull' = sealedBeforeLull, lullBeforeOffer' = lullBeforeOffer, m' = m,
  }

  // The FIFO head runs to completion.
  action runHead = all {
    not(closed),
    fifo.length() > 0,
    val t = fifo.head()
    val rest = fifo.tail()
    any {
      all {
        t == "seal",
        fifo' = rest, held' = held, epoch' = epoch, requested' = requested, lullDone' = lullDone,
        exported' = exported, stage' = "sealed",
        // (if-form: the TLA+ translation drops the parentheses of an `or` right of an assignment)
        sealedBeforeLull' = if (requested == epoch and epoch > 0 and not(lullDone.contains(epoch))) true else sealedBeforeLull,
        lullBeforeOffer' = lullBeforeOffer, closed' = closed, m' = m,
      },
      all {
        t == "adopt",
        epoch' = epoch + 1,
        requested' = epoch + 1,
        // c08d8680 appends the lull inside the adoption; the fix holds it.
        fifo' = if (m.inlineSchedule) rest.append("lull") else rest,
        held' = not(m.inlineSchedule),
        lullDone' = lullDone, exported' = exported, stage' = "adopted",
        unchangedFlags,
      },
      all {
        t == "export",
        exported' = exported.union(Set(epoch)),
        fifo' = rest, held' = held, epoch' = epoch, requested' = requested, lullDone' = lullDone,
        stage' = "play",
        unchangedFlags,
      },
      all {
        t == "lull" or t == "xlull",
        // One lull per epoch; a settled epoch answers later calls with that result.
        lullDone' = if (epoch > 0) lullDone.union(Set(epoch)) else lullDone,
        lullBeforeOffer' =
          if (t == "lull" and epoch > 0 and not(lullDone.contains(epoch)) and (stage == "adopted" or stage == "exporting")) true
          else lullBeforeOffer,
        fifo' = rest, held' = held, epoch' = epoch, requested' = requested, exported' = exported,
        stage' = stage, sealedBeforeLull' = sealedBeforeLull, closed' = closed, m' = m,
      },
    },
  }

  action stutter = all {
    fifo' = fifo, held' = held, epoch' = epoch, requested' = requested, lullDone' = lullDone,
    exported' = exported, stage' = stage, unchangedFlags,
  }

  action step = any { policySeal, policyAdopt, policyExport, skipExport, explicitLull, timer, close, runHead, stutter }
  // Random simulation: without close or the explicit lull (which settles an epoch early and
  // so hides the mutants in random traces), so traces reach the later epochs.
  action stepOpen = any { policySeal, policyAdopt, policyExport, skipExport, timer, runHead }

  val vars = (fifo, epoch, stage, held, requested, lullDone, exported, sealedBeforeLull, lullBeforeOffer, closed, m)

  val trackZ = not(sealedBeforeLull)
  val offerFirst = not(lullBeforeOffer)
  val safety = trackZ and offerFirst

  // Weak fairness of the FIFO and the timer: a scheduled lull eventually runs or the session closes.
  temporal lullRuns = (weakFair(runHead, vars) and weakFair(timer, vars) and weakFair(policyExport, vars)) implies
    always(requested > 0 implies eventually(lullDone.contains(requested) or closed))
}
