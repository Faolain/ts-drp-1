// Own-fence freshness (G6 follow-up to G5's own-fence authentication). Measurement model: no fix
// is merged; FIXED below is the proposed guard.
//
// Design notes (WIP, G6 report pending). Probes (tests/own-fence-freshness-probe-native.test.ts):
// a deleted own row or truncated suffix is refused at reopen by journal replay authentication;
// an older restored store opens, and install adopts the successor and rewrites the settlement
// plan BEFORE D.108d1b (V3_LOCAL_LINEAGE_BEHIND_FRONTIER) refuses at first signature (the RED).
// Smallest guard (MINIMAL): run lineage.next > creator-signed admittedAuthorSequence right after
// the successor authenticates, before adoption and the plan write; refuse with the existing
// V3LocalLineageBehindFrontier / decision B "behind-frontier" path, no state change. The creator's
// signed frontier is the out-of-origin high-water mark already delivered with every successor
// (reuses D.108d1b + decision B; no new crypto or wire format). Optional gapCheck (FIXED): own
// sequences in (prune watermark, T] must all be present, only needed if journal retention may
// miss a deleted fence behind a deferred row (ce972d7f). Residual (inherent to G6): a restored
// copy can re-sign slots of lost rows; if an original escaped, sequence-based frontier commit
// can resolve the wrong move (witness reachedOrphanFalseCommit).
//
// A Writer's own rows are moves and author fences, at contiguous author sequences. The creator
// admits a row only in the epoch it was signed in: a move at T + 1, or a fence above T, where T is
// the author's frontier (deriveCreatorAuthorSettlementFrontier). A fence moves the boundary, so the
// moves it skips are never admitted. On each install the Writer resolves every pending own move
// against the creator's signed frontier T, then signs its epoch fence at its lineage's next
// sequence:
//   - an own fence after the move is in its store: exact (admitted -> committed; else given back);
//   - otherwise, with the move at or below T: "committed" (the frontier rule: T counts a contiguous
//     run of admitted slots, so a move under it with no own fence after it was admitted);
//   - otherwise, with the move's epoch closed: never admitted -> given back (hand-back record);
//   - otherwise still pending.
// The frontier rule is only sound if every own fence the creator admitted is in the store. Losses:
//   - deleteRow: one own row lost from the issuance store alone; the live journal (same origin)
//     still names it, and replay refuses the reopen (v3-live recovery "journal replay
//     authentication failed");
//   - restore: whole-origin restore of an earlier backup. Nothing in the origin notices (G6). The
//     restored session is not yet current (sync before sending) until it installs.
// Rules compared:
//   CURRENT: the code today. The journal refuses deleteRow. Install resolves and persists the plan,
//            then signs the fence; the D.108d1b guard refuses that signature when next <= T
//            (V3_LOCAL_LINEAGE_BEHIND_FRONTIER). The plan rewrite stays.
//   MINIMAL: the D.108d1b check (next > T) moved before resolution: a refused install changes
//            nothing. The journal still refuses deleteRow.
//   FIXED:   MINIMAL plus a gap check: every own sequence <= T is present in the store (so the
//            journal's retention is not relied on).
//   Configurations checked:
//     FIXED, MINIMAL, FIXED without the journal          - expected to hold;
//     MINIMAL without the journal (noJournal)            - a deleted fence behind a deferred row
//                                                          misleads the frontier rule;
//     signOnly (CURRENT)                                 - the plan is rewritten before refusal;
//     noGuard                                            - no frontier check, no sync before sending.
// Invariants:
//   noFalseCommit  - a move the Writer resolved "committed" is admitted (G2: never silently lost),
//                    unless a lost row escaped and the restored copy re-signed its slot (residual);
//   noResign       - no copy signs at or below the frontier it installed (D.108d1b). A restored copy
//                    may still re-sign a slot whose lost row never reached the creator: G6's
//                    residual, witnessed by reachedOrphanedResign, not an invariant;
//   refusedIntact  - a refused install changed no resolution (fail closed).
module ownFenceFreshness {
  pure val MAX_SEQ = 4
  pure val MAX_E = 2
  pure val SEQS = 0.to(MAX_SEQ)
  pure val IDS = Set(0, 1)

  type Row = { kind: str, id: int, epoch: int }
  type Mutants = { noGuard: bool, noJournal: bool, signOnly: bool, gapCheck: bool }
  pure val FIXED: Mutants = { noGuard: false, noJournal: false, signOnly: false, gapCheck: true }
  pure val MINIMAL: Mutants = { ...FIXED, gapCheck: false }

  var mu: Mutants
  // Every row ever signed at a sequence, by any copy of the Writer.
  var signed: int -> Set[Row]
  // The Writer's store (one origin): rows present, lineage next (lnext), resolutions, hand-back records.
  var local: int -> Row
  var lnext: int
  var res: int -> str                 // pending | committed | handBack (move rows only)
  var handed: Set[int]                // move ids given back
  var wEpoch: int
  var wT: int                         // the frontier of the Writer's last install
  var current: bool
  var halted: bool
  // A whole-origin backup (one slot).
  var bk: { valid: bool, local: int -> Row, next: int, res: int -> str, handed: Set[int], wEpoch: int, wT: int }
  // The creator.
  var cEpoch: int
  var cT: int                         // frontier: -1 when nothing admitted
  var cRow: int -> Row                // admitted row per sequence
  var refusedChanged: bool            // a refused install changed a resolution
  var resigned: bool                  // a copy signed at or below the creator's frontier (D.108d1b)
  var last: str

  def present(s: int): bool = local.keys().contains(s)
  def admitted(s: int): bool = cRow.keys().contains(s)

  action initWith(m: Mutants): bool = all {
    mu' = m, signed' = SEQS.mapBy(s => Set()), local' = Map(), lnext' = 0, res' = Map(), handed' = Set(),
    wEpoch' = 0, wT' = -1, current' = true, halted' = false,
    bk' = { valid: false, local: Map(), next: 0, res: Map(), handed: Set(), wEpoch: 0, wT: -1 },
    cEpoch' = 0, cT' = -1, cRow' = Map(), refusedChanged' = false, resigned' = false, last' = "init",
  }
  action init = initWith(FIXED)
  action initNoGuard = initWith({ ...FIXED, noGuard: true })
  action initMinimal = initWith(MINIMAL)
  action initFixedNoJournal = initWith({ ...FIXED, noJournal: true })
  action initMinimalNoJournal = initWith({ ...MINIMAL, noJournal: true })
  action initSignOnly = initWith({ ...MINIMAL, signOnly: true })

  action keepCreator = all { cEpoch' = cEpoch, cT' = cT, cRow' = cRow }
  action keepBackup = all { bk' = bk }

  // The Writer signs a move (only while current: sync before sending, unless noGuard).
  action issueMove(id: int): bool = all {
    not(halted), current or mu.noGuard, lnext <= MAX_SEQ,
    val row = { kind: "move", id: id, epoch: wEpoch }
    all {
      signed' = signed.setBy(lnext, rows => rows.union(Set(row))),
      local' = local.put(lnext, row), lnext' = lnext + 1, res' = res.put(lnext, "pending"),
      handed' = handed, wEpoch' = wEpoch, wT' = wT, current' = current, halted' = halted,
      mu' = mu, keepCreator, keepBackup, refusedChanged' = refusedChanged, resigned' = (resigned or lnext <= wT), last' = "issue",
    },
  }

  // A signed row reaches the creator (any copy, any time); admitted only in its own epoch.
  action deliver(s: int): bool = all {
    not(admitted(s)), s > cT,
    nondet row = signed.get(s).oneOf()
    all {
      row.epoch == cEpoch,
      if (row.kind == "move") s == cT + 1 else true,
      cRow' = cRow.put(s, row), cT' = s, cEpoch' = cEpoch,
      mu' = mu, signed' = signed, local' = local, lnext' = lnext, res' = res, handed' = handed,
      wEpoch' = wEpoch, wT' = wT, current' = current, halted' = halted, keepBackup, refusedChanged' = refusedChanged, resigned' = resigned,
      last' = "deliver",
    },
  }

  action close = all {
    cEpoch < MAX_E, cEpoch' = cEpoch + 1, cT' = cT, cRow' = cRow,
    mu' = mu, signed' = signed, local' = local, lnext' = lnext, res' = res, handed' = handed,
    wEpoch' = wEpoch, wT' = wT, current' = current, halted' = halted, keepBackup, refusedChanged' = refusedChanged, resigned' = resigned,
    last' = "close",
  }

  def fenceAfter(s: int): bool = local.keys().exists(f => f > s and local.get(f).kind == "fence")
  // `defer`: the install fences over retained work it cannot prove yet (ce972d7f), leaving a
  // closed-epoch row pending behind the new fence.
  def resolve(s: int, defer: bool): str =
    if (res.get(s) != "pending") res.get(s)
    else if (fenceAfter(s)) (if (admitted(s) and cRow.get(s) == local.get(s)) "committed" else "handBack")
    else if (s <= cT) "committed"
    else if (local.get(s).epoch < cEpoch) (if (defer) "pending" else "handBack")
    else "pending"
  def resolved(defer: bool): int -> str = res.keys().mapBy(s => resolve(s, defer))
  def handedBy(r: int -> str): Set[int] = r.keys().filter(s => r.get(s) == "handBack").map(s => local.get(s).id)
  // The store covers the frontier: next > T, and with gapCheck every own sequence at or below T
  // is present.
  def covers: bool = lnext > cT and (not(mu.gapCheck) or SEQS.forall(s => s > cT or present(s)))

  // Install of the creator's current successor: resolve, then sign the epoch fence at next.
  action install = all {
    not(halted), wEpoch < cEpoch or not(current), lnext <= MAX_SEQ,
    val fence = { kind: "fence", id: -1, epoch: cEpoch }
    nondet defer = Set(true, false).oneOf()
    val r = resolved(defer)
    val refuse = not(mu.noGuard) and (if (mu.signOnly) lnext <= cT else not(covers))
    val changed = res.keys().exists(q => r.get(q) != res.get(q))
    if (refuse) all {
      // CURRENT persists the plan before its signing guard refuses; FIXED refuses first.
      res' = if (mu.signOnly) r else res,
      handed' = handed,
      refusedChanged' = (refusedChanged or (mu.signOnly and changed)), resigned' = resigned,
      halted' = true, current' = current, wEpoch' = if (mu.signOnly) cEpoch else wEpoch, wT' = if (mu.signOnly) cT else wT,
      signed' = signed, local' = local, lnext' = lnext,
      mu' = mu, keepCreator, keepBackup, last' = "install-refused",
    } else all {
      res' = r, handed' = handed.union(handedBy(r)),
      signed' = signed.setBy(lnext, rows => rows.union(Set(fence))),
      local' = local.put(lnext, fence), lnext' = lnext + 1,
      wEpoch' = cEpoch, wT' = cT, current' = true, halted' = false,
      mu' = mu, keepCreator, keepBackup, refusedChanged' = refusedChanged, resigned' = (resigned or lnext <= cT), last' = "install",
    },
  }

  action backup = all {
    not(bk.valid),
    bk' = { valid: true, local: local, next: lnext, res: res, handed: handed, wEpoch: wEpoch, wT: wT },
    mu' = mu, signed' = signed, local' = local, lnext' = lnext, res' = res, handed' = handed,
    wEpoch' = wEpoch, wT' = wT, current' = current, halted' = halted, keepCreator, refusedChanged' = refusedChanged, resigned' = resigned,
    last' = "backup",
  }

  // Whole-origin restore and reopen: not yet current until it installs.
  action restore = all {
    bk.valid,
    local' = bk.local, lnext' = bk.next, res' = bk.res, handed' = bk.handed, wEpoch' = bk.wEpoch, wT' = bk.wT,
    current' = mu.noGuard, halted' = false,
    mu' = mu, signed' = signed, keepCreator, keepBackup, refusedChanged' = refusedChanged, resigned' = resigned, last' = "restore",
  }

  // One own row lost from the issuance store alone; the journal refuses the reopen unless noJournal.
  action deleteRow(s: int): bool = all {
    present(s), s < lnext - 1,
    if (mu.noJournal) all {
      local' = SEQS.filter(q => present(q) and q != s).mapBy(q => local.get(q)),
      res' = res.keys().filter(q => q != s).mapBy(q => res.get(q)), halted' = halted, last' = "delete-silent",
    } else all { local' = local, res' = res, halted' = true, last' = "delete-refused" },
    lnext' = lnext, handed' = handed, wEpoch' = wEpoch, wT' = wT, current' = current,
    mu' = mu, signed' = signed, keepCreator, keepBackup, refusedChanged' = refusedChanged, resigned' = resigned,
  }

  action step = any {
    nondet id = IDS.oneOf()
    issueMove(id),
    nondet s = SEQS.oneOf()
    deliver(s),
    close,
    install,
    backup,
    restore,
    nondet s = SEQS.oneOf()
    deleteRow(s),
  }

  val falseCommitFree = res.keys().forall(s =>
    res.get(s) != "committed" or not(present(s)) or (admitted(s) and cRow.get(s) == local.get(s)))
  // A slot two copies signed: the restored copy re-signed a slot whose lost row escaped (G6 residual).
  val orphaned = SEQS.exists(q => signed.get(q).size() > 1)
  val noFalseCommit = not(orphaned) implies falseCommitFree
  val noResign = not(resigned)
  val refusedIntact = not(refusedChanged)
  val allSafety = noFalseCommit and noResign and refusedIntact

  // Witnesses (expected violated: the scenario is reachable).
  val reachedOrphanedResign = not(mu == FIXED and orphaned)
  // The residual's G2 face: the escaped original is admitted at a slot the restored copy re-signed
  // with another move, and the frontier rule resolves the copy's move "committed" (it compares
  // sequences, not digests).
  val reachedOrphanFalseCommit = not(mu == FIXED and orphaned and not(falseCommitFree))
  val reachedRestoreRefused = not(mu == FIXED and halted and last == "install-refused" and bk.valid)
  val reachedHandBackAfterRestore = not(mu == FIXED and bk.valid and handed.size() > 0 and wEpoch == MAX_E and not(halted))
}
