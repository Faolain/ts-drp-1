// -*- mode: Bluespec; -*-
//
// DESIGN MODEL (fix/creator-anchor-uncovered): which owner ends the retention that leaves a member's
// held own row demanding an anchor no retained generation authenticates.
//
// Sibling of held-dependency-anchor.qnt (the anchor law itself) and settlement-chain-age.qnt (the
// chain-age proposal). One member author, its own rows by author sequence, the creator's signed
// terminalThrough (tt) for it, the member's settlement plan, the AHE generations, and the received-
// turnover census.
//
// Measured in the 4-author scorecard (ANCHOR_DEBUG dumps, .logs/realtime-resume-2026-11-10/anchor) and
// reproduced without it (tests/creator-fenceless-rebase-entry-anchor-native.test.ts: P1,
// tests/creator-skip-epoch-own-row-anchor-native.test.ts: P2). In every dump the member's plan has no
// author fence because retained work stays unknown: its hand-back records do not fit
// (SETTLEMENT_HAND_BACK_LIMITS.maxRecords, one record per operation; `hb` 51..64) and
// drainSettlementOutbox withholds the fence while unknown retained work remains.
//  P1 (dumps-01..03, dumps-r2, dumps-07): the uncovered anchor belongs to SOURCES THE MEMBER HAS ALREADY
//     RESOLVED (source-authenticated-expiry: displaced, fence-guarded, window-expired, replaced). The
//     retirement closure re-protects them through their plan entry (`entry:35:rebase:r40`): a `rebase`
//     entry with a replacement is prunable only while the plan has a current fence
//     (settlementPlanPermitsAuthenticatedPruning, applied per entry by retirementEntryIsRetained).
//  P2 (dumps-04): the uncovered anchor belongs to a source no own fence of its epoch precedes (a fresh
//     move in a fenceless epoch) above a never-admitted gap. settlementOwnRowFenceGuarded is false, so
//     the window never expires it, tt never reaches it, retirement never covers it, and it is held for as
//     long as tt is stuck.
//  P3 (found by this model's simulation, not yet measured): an own row ADMITTED in a fenceless epoch
//     above a never-admitted gap; tt reaches it only through an admitted own fence above it, so without
//     a fence it is never terminally covered and demands its anchor forever. Only a landed fence ends it.
//
// Rules (`rule`):
//   shipped     the code at perf/integration-7 (4e3c9b41).
//   hold        candidate (a): AHE never retires a generation (or the predecessor link it carries) that
//               is the last coverage of a demanded anchor.
//   chainAge    candidate (c): the settlement window is judged on a chain's ROOT epoch
//               (settlement-chain-age.qnt, proposal 48421007).
//   release     candidate (b): a completed entry (its replacement issued) whose source is resolved
//               (terminal, or displaced + fence-guarded + window-expired) no longer needs the plan's
//               current fence to stop protecting its source.
//   fenceFirst  candidate (b'): a member whose plan has no current fence and that still holds own work
//               above tt issues its own fence before its next own row.
//   releaseFenceFirst  release + fenceFirst.
//   cutProof    candidate (d) with release: an adjacent install (epoch e -> e + 1) installs epoch e's
//               closed history; an own row of epoch e absent from it is recorded never-admitted in the
//               plan (an authenticated resolution, like the frontier's), so the guard accepts it.
//   proveFirst  candidate (f): a retained row the frontier proves never admitted is resolved at once
//               (expire) even when its hand-back records do not fit; only the record waits for capacity.
//               Unknown retained work is then only genuinely unproven work, so the install fences.
//               The proven row stays held (`pending`: it carries the move's intents) until its record is
//               written, so retirement cannot drop the accepted move before it is given back (G3).
//   releaseProveFirst  release + proveFirst.
//   Broken controls:
//   overRelease release that also drops the entry of a source that is NOT resolved.
//   guardAny    release whose guard accepts an own fence of ANY epoch below the row. (On a base that
//               fences every install, no row is ever unguarded and a weakened guard is never exercised:
//               proveAny is vacuous for that reason; the guard's soundness is the frontier's, unchanged.)
//   cutEarly    cutProof that records the proof at a lull, before the row's epoch has closed.
//   proveAny    releaseProveFirst whose proof does not require the guard.
//   proveDrop   releaseProveFirst whose retirement does not keep a proven row awaiting its record.
//
// Retained (skip-install) rows resolve through the creator's frontier (frontierRetainedResolution):
// never-admitted (displaced and guarded) hands the move back, one hand-back record per operation;
// committed needs tt to reach the row with no own fence after it; anything else within tt is manual
// review, which stays held until the user decides (the residual of held-dependency-anchor.qnt; a
// refusal for it is excused). A retained row whose hand-back records do not fit
// (SETTLEMENT_HAND_BACK_LIMITS.maxRecords) stays retained and unknown (`stuck`) until records free
// (`free`: the application offers its given-back moves again). drainSettlementOutbox issues the
// author fence at an install unless unknown retained work remains: an install fences when it replaces,
// or when no retained work is unknown; otherwise the plan has no fence until a later install.
//
// Properties under the honest step (a slow member: the creator admits some of its rows):
//   noUnexcusedRefusal  the anchor law refuses only for an anchor a manual-review row demands.
//   boundedGens         AHE keeps at most CAP generations (G1, G21).
//   boundedAge          after a lull, no held, demanded own row (manual review aside) is older than AGE
//                       epochs (G1).
//   releaseSafe         retirement never releases a row the creator admitted unless tt covers it (G3).
//   noLostMove          retirement never releases a never-admitted move whose intent was neither handed
//                       back nor replaced (G3: accepted work stays finishable).
//   sourceSafe          a replacement is never admitted while its source is released (G5).
//   guardSound          a displaced row the guard calls never-admitted was never admitted.
//   handBackSound       a move is never both handed back and admitted (exactly once).
module heldAnchorRetention {
  pure val MAX_E = 14
  pure val MAX_SEQ = 24
  pure val W = 4
  pure val CAP = 5
  pure val TOP = 3
  pure val GAP = 3
  pure val AGE = 9

  // src: the source a replacement replaces (its chain link). The replacement rows measured in the
  // scorecard carry no portable settlementSource, so the closure's portable clause (unchanged by every
  // rule) is not modelled: a link is protected only through its plan entry.
  type Row = { e: int, fence: bool, src: int, cap: bool }

  var rule: str
  var cur: int
  var gens: Set[int]
  var rows: int -> Row
  var held: Set[int]
  var nextSeq: int
  var planFence: int
  // Completed entries: source -> replacement (`rebase` with a replacement).
  var entries: int -> int
  // Sources resolved by an authenticated expiry or a frontier never-admitted resolution (handed back).
  var expired: Set[int]
  // Retained sources proven committed by the frontier.
  var committed: Set[int]
  var admitted: Set[int]
  var tt: int
  var refusedUnexcused: bool
  var refusedReview: bool
  var unsafeRelease: bool
  var lostMove: bool
  var replayNoSource: bool
  // The last step was a lull (bounded-age is judged where retirement has just run).
  var lulled: bool
  // Retained rows whose hand-back records do not fit: unknown, they withhold the author fence.
  var stuck: Set[int]
  // Own rows an installed closed history proves never admitted (cutProof).
  var cutProven: Set[int]
  // Proven never admitted, hand-back record not yet written (proveFirst): held until records free.
  var pending: Set[int]

  def releases(rl: str): bool =
    rl == "release" or rl == "releaseFenceFirst" or rl == "overRelease" or rl == "guardAny" or rl == "cutProof" or rl == "cutEarly" or
    rl == "releaseProveFirst" or rl == "proveAny" or rl == "proveDrop"
  def cuts(rl: str): bool = rl == "cutProof" or rl == "cutEarly"
  def provesFirst(rl: str): bool = rl == "proveFirst" or rl == "releaseProveFirst" or rl == "proveAny" or rl == "proveDrop"
  def fencesFirst(rl: str): bool = rl == "fenceFirst" or rl == "releaseFenceFirst"

  def isFence(s: int): bool = rows.get(s).fence
  def ep(s: int): int = rows.get(s).e
  def isCap(s: int): bool = rows.get(s).cap
  def displaced(s: int, c: int): bool = ep(s) < c and s > tt
  // A row whose finality the frontier proves: admitted (or a fence, a no-op), or below an admitted
  // fence after it was replaced or handed back. A retained row needs the committed proof instead.
  def terminal(s: int): bool =
    s <= tt and (not(isCap(s)) or committed.contains(s) or expired.contains(s))
  def review(s: int): bool = isCap(s) and s <= tt and not(committed.contains(s)) and not(expired.contains(s))

  // settlementOwnRowFenceGuarded: the first unsettled sequence, or preceded by a retained own fence of
  // its own epoch (guardAny: of any epoch).
  def guarded(s: int): bool =
    s == tt + 1 or cutProven.contains(s) or held.exists(f => isFence(f) and f <= s and (rule == "guardAny" or ep(f) == ep(s)))

  // The census and retirement coverage of one held row.
  def resolved(s: int, c: int): bool =
    terminal(s) or (isFence(s) and s != planFence) or
    (displaced(s, c) and guarded(s) and ep(s) <= c - W and (entries.keys().contains(s) or expired.contains(s)))

  // The retirement closure (closeIssuanceRetirementProtectedRecords) over the selection: through =
  // cur - 1; resolved rows of epochs <= through - 2 are candidates, everything else is kept. A fence is
  // kept while an own row of its epoch is held (ownEpochFences reads retained rows).
  def prunable(s: int): bool =
    planFence >= 0 or (releases(rule) and (rule == "overRelease" or resolved(s, cur)))
  def closeOnce(h: Set[int]): Set[int] =
    h.union(entries.keys().filter(s => held.contains(s) and (not(prunable(s)) or h.contains(s)))
        .fold(Set(), (acc, s) => acc.union(Set(s, entries.get(s)))))
     .intersect(held)
  def kept: Set[int] = {
    val base = held.filter(s => ep(s) > cur - 3 or not(resolved(s, cur)))
    val closed = closeOnce(closeOnce(closeOnce(closeOnce(closeOnce(
      base.union(if (rule == "proveDrop") Set() else held.intersect(pending))
    )))))
    closed.union(held.filter(f => isFence(f) and closed.exists(s => not(isFence(s)) and ep(s) == ep(f))))
  }

  // Demanded anchors: every held own row that is not terminally covered or capsuled (a manual-review
  // row reopens its historical anchor to be replayed). Own fences carry their retained source contract.
  def demandedBy(h: Set[int], c: int): Set[int] =
    h.filter(s => not(isFence(s)) and (review(s) or not(isCap(s))) and not(terminal(s) and ep(s) <= c - 2))
  def demanded(h: Set[int], c: int): Set[int] = demandedBy(h, c).map(s => ep(s))
  def coveredAnchors(g: Set[int], c: int): Set[int] = Set(0, c, c - 1).union(g).union(g.map(e => e - 1))

  // AHE generation retirement: at most CAP, never the three newest.
  def top(g: Set[int]): Set[int] = g.filter(e => g.filter(f => f > e).size() < TOP)
  def minOf(s: Set[int]): int = s.fold(MAX_E + 1, (m, e) => if (e < m) e else m)
  def lastCover(g: Set[int], e: int, c: int, d: Set[int]): bool =
    d.exists(a => coveredAnchors(g, c).contains(a) and not(coveredAnchors(g.exclude(Set(e)), c).contains(a)))
  def retireGens(g: Set[int], c: int, d: Set[int]): Set[int] =
    if (g.size() <= CAP) g
    else {
      val victim = minOf(g.exclude(top(g)))
      if (rule == "hold" and lastCover(g, victim, c, d)) g else g.exclude(Set(victim))
    }

  // The contiguous signed frontier: an admitted fence f lets it reach f - 1, then admitted slots.
  def frontier(adm: Set[int], t: int): int = {
    val base = adm.filter(f => isFence(f)).fold(t, (m, f) => if (f - 1 > m) f - 1 else m)
    0.to(MAX_SEQ).fold(base, (m, s) => if (s == m + 1 and adm.contains(s)) s else m)
  }

  action keepFlags = all {
    refusedUnexcused' = refusedUnexcused, refusedReview' = refusedReview, unsafeRelease' = unsafeRelease,
    lostMove' = lostMove, replayNoSource' = replayNoSource, lulled' = false,
  }

  // A fresh own move in the current epoch (fenceFirst: its fence first, when the plan has none and
  // the member holds own work above tt).
  action move = {
    val needFence = fencesFirst(rule) and planFence < 0 and held.exists(s => s > tt and not(isFence(s)))
    val m = if (needFence) nextSeq + 1 else nextSeq
    all {
      cur > 0, m <= MAX_SEQ,
      rows' = (if (needFence) rows.put(nextSeq, { e: cur, fence: true, src: -1, cap: false }) else rows)
        .put(m, { e: cur, fence: false, src: -1, cap: false }),
      held' = held.union(if (needFence) Set(nextSeq, m) else Set(m)),
      planFence' = if (needFence) nextSeq else planFence,
      nextSeq' = m + 1,
      rule' = rule, cur' = cur, gens' = gens, entries' = entries, expired' = expired, committed' = committed,
      admitted' = admitted, tt' = tt, stuck' = stuck, cutProven' = cutProven, pending' = pending,
      keepFlags,
    }
  }

  // The creator admits own row s while the member is current (ingress admits only the current
  // epoch's anchor); an author's admitted rows of one epoch are causally closed.
  action admit(s: int): bool = all {
    held.contains(s), ep(s) == cur, not(admitted.contains(s)),
    held.forall(r => r >= s or ep(r) != cur or admitted.contains(r)),
    admitted' = admitted.union(Set(s)),
    tt' = frontier(admitted.union(Set(s)), tt),
    replayNoSource' = (replayNoSource or entries.keys().exists(r => entries.get(r) == s and not(held.contains(r)))),
    refusedUnexcused' = refusedUnexcused, refusedReview' = refusedReview, unsafeRelease' = unsafeRelease,
    lostMove' = lostMove, lulled' = false,
    rule' = rule, cur' = cur, gens' = gens, rows' = rows, held' = held, nextSeq' = nextSeq, planFence' = planFence,
    entries' = entries, expired' = expired, committed' = committed, stuck' = stuck, cutProven' = cutProven, pending' = pending,
  }

  // A successor install k epochs ahead: the merge clears the fence. Live (not retained) displaced
  // links past the window and guarded are handed back; the others are replaced in one batch on an
  // adjacent install (fence first) and retained as source contracts on a skip install. Retained rows
  // (not stuck) resolve through the frontier: committed (tt reached them, no own fence after),
  // never-admitted (displaced, guarded: handed back), or unknown. With `ov` the rows this install
  // retains do not fit the hand-back records: stuck. The install fences when it replaces or when no
  // retained work is unknown (fenceFirst: always). AHE then rolls.
  def up(s: int): int = if (rows.get(s).src >= 0) rows.get(s).src else s
  def root(s: int): int = ep(up(up(up(up(up(up(up(up(s)))))))))
  action install(k: int, ov: bool): bool = {
    val c = cur + k
    val proven = if (cuts(rule) and k == 1)
      held.filter(s => not(isFence(s)) and ep(s) == cur and not(admitted.contains(s)))
    else Set()
    val open = held.filter(s => not(isFence(s)) and not(admitted.contains(s)) and
      not(entries.keys().contains(s)) and not(expired.contains(s)) and not(committed.contains(s)))
    val live = open.filter(s => not(isCap(s)) and displaced(s, c))
    val expire = live.filter(s => (if (rule == "chainAge") root(s) else ep(s)) <= c - W and guarded(s))
    val replace = if (k == 1) live.exclude(expire) else Set()
    val retain = if (k == 1) Set() else live.exclude(expire)
    val wouldStick = if (ov) stuck.union(retain) else stuck
    val provedStuck = if (provesFirst(rule))
      wouldStick.filter(s => displaced(s, c) and (guarded(s) or rule == "proveAny"))
    else Set()
    val nowStuck = wouldStick.exclude(provedStuck)
    val capOpen = open.filter(s => isCap(s)).union(retain).exclude(wouldStick)
    val capNever = capOpen.filter(s => displaced(s, c) and (guarded(s) or rule == "proveAny"))
    val capCommitted = capOpen.filter(s => s <= tt and not(held.exists(f => isFence(f) and f > s and f <= tt)))
    val unknown = capOpen.exclude(capNever).exclude(capCommitted).union(nowStuck)
    val settle = replace.size() > 0 or unknown.size() == 0 or fencesFirst(rule)
    val f = nextSeq
    val b = nextSeq + 1
    val batch = replace.size() > 0
    val rep = replace.fold(-1, (m, s) => if (s > m) s else m)
    all {
      k >= 1, k <= GAP, c <= MAX_E, nextSeq + 1 <= MAX_SEQ,
      cur' = c,
      rows' = {
        val withFence = if (settle) rows.put(f, { e: c, fence: true, src: -1, cap: false }) else rows
        val withBatch = if (batch) withFence.put(b, { e: c, fence: false, src: rep, cap: false }) else withFence
        withBatch.keys().mapBy(s => if (retain.contains(s)) withBatch.get(s).with("cap", true) else withBatch.get(s))
      },
      held' = held.union(if (settle) Set(f) else Set()).union(if (batch) Set(b) else Set()),
      nextSeq' = if (batch) b + 1 else if (settle) f + 1 else nextSeq,
      planFence' = if (settle) f else -1,
      entries' = if (batch) replace.fold(entries, (m, s) => m.put(s, b)) else entries,
      expired' = expired.union(expire).union(capNever).union(provedStuck),
      committed' = committed.union(capCommitted),
      gens' = retireGens(gens.union(Set(c)), c, demanded(held, c)),
      rule' = rule, admitted' = admitted, tt' = tt, stuck' = nowStuck, cutProven' = cutProven.union(proven), pending' = pending.union(provedStuck),
      keepFlags,
    }
  }

  // The member's lull: issuance retirement releases resolved rows of epochs <= cur - 3 that nothing
  // keeps, then the received-turnover census meets the recovery certificate.
  def missingIn(h: Set[int]): Set[int] = demandedBy(h, cur).filter(s => not(coveredAnchors(gens, cur).contains(ep(s))))
  action lull = {
    val goneRows = held.exclude(kept)
    val keptRows = held.exclude(goneRows)
    val uncovered = missingIn(keptRows)
    all {
      held' = keptRows,
      unsafeRelease' = (unsafeRelease or goneRows.exists(s => admitted.contains(s) and s > tt)),
      lostMove' = (lostMove or goneRows.exists(s => pending.contains(s)) or goneRows.exists(s => not(isFence(s)) and
        not(admitted.contains(s)) and not(entries.keys().contains(s)) and not(expired.contains(s)) and not(committed.contains(s)))),
      refusedUnexcused' = (refusedUnexcused or uncovered.exists(s => not(demandedBy(keptRows, cur).exists(r => review(r) and ep(r) == ep(s))))),
      refusedReview' = (refusedReview or uncovered.size() > 0),
      replayNoSource' = replayNoSource, lulled' = true,
      rule' = rule, cur' = cur, gens' = gens, rows' = rows, nextSeq' = nextSeq, planFence' = planFence,
      entries' = entries, expired' = expired, committed' = committed, admitted' = admitted, tt' = tt,
      stuck' = stuck,
      cutProven' = if (rule == "cutEarly")
        cutProven.union(held.filter(s => not(isFence(s)) and ep(s) == cur and not(admitted.contains(s))))
      else cutProven,
      pending' = pending,
    }
  }

  // Hand-back records free (the application offered its given-back moves again): the stuck rows are
  // resolvable at the next install.
  action free = all {
    stuck.size() > 0 or pending.size() > 0, stuck' = Set(), cutProven' = cutProven, pending' = Set(),
    rule' = rule, cur' = cur, gens' = gens, rows' = rows, held' = held, nextSeq' = nextSeq, planFence' = planFence,
    entries' = entries, expired' = expired, committed' = committed, admitted' = admitted, tt' = tt,
    keepFlags,
  }

  action initWith(r: str): bool = all {
    rule' = r, cur' = 0, gens' = Set(), held' = Set(), nextSeq' = 1, planFence' = -1,
    rows' = Map(0 -> { e: 0, fence: true, src: -1, cap: false }),
    entries' = Map(), expired' = Set(), committed' = Set(), admitted' = Set(0), tt' = 0,
    refusedUnexcused' = false, refusedReview' = false, unsafeRelease' = false, lostMove' = false,
    replayNoSource' = false, lulled' = false, stuck' = Set(), cutProven' = Set(), pending' = Set(),
  }
  action init = initWith("releaseProveFirst")
  action initReleaseFenceFirst = initWith("releaseFenceFirst")
  action initShipped = initWith("shipped")
  action initHold = initWith("hold")
  action initChainAge = initWith("chainAge")
  action initRelease = initWith("release")
  action initFenceFirst = initWith("fenceFirst")
  action initOverRelease = initWith("overRelease")
  action initGuardAny = initWith("guardAny")
  action initCutProof = initWith("cutProof")
  action initCutEarly = initWith("cutEarly")
  action initProveFirst = initWith("proveFirst")
  action initReleaseProveFirst = initWith("releaseProveFirst")
  action initProveAny = initWith("proveAny")
  action initProveDrop = initWith("proveDrop")

  action step = any {
    move,
    nondet k = 1.to(GAP).oneOf()
    nondet ov = Set(true, false).oneOf()
    install(k, ov),
    free,
    lull,
    nondet s = 0.to(MAX_SEQ).oneOf()
    admit(s),
  }

  // The step with hand-back records that always fit (no stuck rows): what remains without the overflow.
  action stepNoOverflow = any {
    move,
    nondet k = 1.to(GAP).oneOf()
    install(k, false),
    lull,
    nondet s = 0.to(MAX_SEQ).oneOf()
    admit(s),
  }

  val noUnexcusedRefusal = not(refusedUnexcused)
  val boundedGens = gens.size() <= CAP
  val boundedAge = not(lulled) or demandedBy(held, cur).forall(s => review(s) or ep(s) > cur - AGE)
  val releaseSafe = not(unsafeRelease)
  val noLostMove = not(lostMove)
  val sourceSafe = not(replayNoSource)
  val guardSound = held.forall(s => not(displaced(s, cur) and guarded(s) and admitted.contains(s)))
  // A move is never both handed back and admitted (exactly once).
  val handBackSound = expired.forall(s => not(admitted.contains(s)))
  val safety = releaseSafe and noLostMove and sourceSafe and guardSound and handBackSound
  val liveness = noUnexcusedRefusal and boundedGens and boundedAge
  val allProps = safety and liveness

  // ---- Witnesses ----
  action adj = install(1, false).then(lull)
  action adj3 = adj.then(adj).then(adj)

  // P1 (tests/creator-fenceless-rebase-entry-anchor-native.test.ts): a member moves in epoch 1 (never
  // delivered); install 2 replaces it (fence + batch); it moves again in epoch 2 (the test's burst),
  // falls behind and skip-installs epoch 5, retaining its epoch-2 rows, whose hand-back records do not
  // fit (the test's 16-operation row past 59 records): unknown, so no fence from then on. The resolved
  // epoch-1 source stays protected by its `rebase` entry.
  action p1Shape(r: str, ov: bool): bool =
    initWith(r).then(install(1, false)).then(move).then(adj).then(move).then(install(3, ov)).then(lull).then(adj3).then(adj3)
  action p1(r: str): bool = p1Shape(r, true)
  // P2 (dumps-04, tests/creator-skip-epoch-own-row-anchor-native.test.ts): a move in epoch 1, a skip
  // install 1 -> 4 that retains it and cannot hand it back (stuck: no fence), a fresh move in epoch 4
  // (no own fence of epoch 4 precedes it; tt is below it), install 5 replaces it, then adjacent
  // installs with a lull after each.
  action p2(r: str): bool =
    initWith(r).then(install(1, false)).then(move).then(install(3, true)).then(move).then(adj).then(adj3).then(adj3).then(adj3)

  run shippedRefusesP1Test = p1("shipped").then(all { assert(refusedUnexcused), unchangedAll })
  run shippedRefusesP2Test = p2("shipped").then(all { assert(refusedUnexcused), unchangedAll })
  // (a) keeps the anchors covered by keeping generations: more than CAP of them, without bound.
  run holdKeepsP1Test = p1("hold").then(all { assert(not(refusedUnexcused)), assert(not(boundedGens)), unchangedAll })
  run holdKeepsP2Test = p2("hold").then(all { assert(not(refusedUnexcused)), assert(not(boundedGens)), unchangedAll })
  // (c) does not reach either pattern: the work that stays unknown is fresh (its root is young), and
  // the demanded rows are resolved (P1) or unguarded (P2), which no window judgement changes.
  run chainAgeRefusesP1Test = p1("chainAge").then(all { assert(refusedUnexcused), unchangedAll })
  run chainAgeRefusesP2Test = p2("chainAge").then(all { assert(refusedUnexcused), unchangedAll })
  // (b) ends P1's retention; P2's row is not resolved, so (b) alone still refuses.
  run releaseKeepsP1Test = p1("release").then(all { assert(not(refusedUnexcused)), assert(safety), unchangedAll })
  run releaseRefusesP2Test = p2("release").then(all { assert(refusedUnexcused), unchangedAll })
  // (b') guards the skip-install-epoch move; P1's rows still wait for a fence.
  run fenceFirstKeepsP2Test = p2("fenceFirst").then(all { assert(not(refusedUnexcused)), assert(safety), unchangedAll })
  // fenceFirst also ends P1 here: retained work is open at every install, so every install fences.
  run fenceFirstKeepsP1Test = p1("fenceFirst").then(all { assert(not(refusedUnexcused)), assert(safety), unchangedAll })
  // The cost of fenceFirst: the skip install retained an epoch-1 move it cannot hand back yet (stuck);
  // fenceFirst fences anyway, the fence lands, so tt passes the retained move with an own fence after
  // it, and once records free the frontier can no longer prove it never admitted (handed back, as
  // shipped, which withheld the fence) or committed: manual review.
  action p3(r: str): bool =
    initWith(r).then(install(1, false)).then(move).then(install(3, true)).then(move).then(admit(3)).then(free).then(install(1, false))
  run shippedHandsBackRetainedTest = p3("shipped").then(all { assert(expired.contains(2)), assert(not(review(2))), unchangedAll })
  run fenceFirstReviewsRetainedTest = p3("fenceFirst").then(all { assert(review(2)), unchangedAll })
  // Without the overflow, shipped fences at the skip install (its retained work resolves) and keeps
  // both shapes: the trigger is the unknown retained work.
  run shippedKeepsP1WithoutOverflowTest = p1Shape("shipped", false).then(all { assert(not(refusedUnexcused)), unchangedAll })
  run shippedKeepsP2WithoutOverflowTest =
    initWith("shipped").then(install(1, false)).then(move).then(install(3, false)).then(move).then(adj).then(adj3).then(adj3).then(adj3)
      .then(all { assert(not(refusedUnexcused)), unchangedAll })
  // (d) keeps both without fencing over unknown retained work (no manual-review cost: p3 hands back).
  run cutProofKeepsP1Test = p1("cutProof")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  run cutProofKeepsP2Test = p2("cutProof")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  run cutProofHandsBackRetainedTest = p3("cutProof").then(all { assert(expired.contains(2)), assert(not(review(2))), unchangedAll })
  // (f) keeps both: the stuck rows are proven at the skip install, so it fences; no manual-review cost.
  run proveFirstKeepsP1Test = p1("proveFirst")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  run proveFirstKeepsP2Test = p2("proveFirst")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  // p3 under (f): the skip install proves the stuck row at once (nothing waits on `free`), fences, and
  // the fence landing turns nothing into manual review.
  run proveFirstHandsBackRetainedTest =
    initWith("proveFirst").then(install(1, false)).then(move).then(install(3, true)).then(move).then(admit(3))
      .then(all { assert(planFence == 3), assert(expired.contains(2)), assert(not(review(2))), assert(stuck == Set()), unchangedAll })
  // Broken (f): retirement drops the proven row before its hand-back record exists: the move is lost.
  run proveDropLosesMoveTest = p1("proveDrop").then(all { assert(lostMove), unchangedAll })
  run releaseProveFirstKeepsP1Test = p1("releaseProveFirst")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  run releaseProveFirstKeepsP2Test = p2("releaseProveFirst")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  // (b) + (b') keeps both, bounded.
  run releaseFenceFirstKeepsP1Test = p1("releaseFenceFirst")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })
  run releaseFenceFirstKeepsP2Test = p2("releaseFenceFirst")
    .then(all { assert(not(refusedUnexcused)), assert(boundedGens), assert(boundedAge), assert(safety), unchangedAll })

  action unchangedAll = all {
    rule' = rule, cur' = cur, gens' = gens, rows' = rows, held' = held, nextSeq' = nextSeq, planFence' = planFence,
    entries' = entries, expired' = expired, committed' = committed, admitted' = admitted, tt' = tt,
    stuck' = stuck, cutProven' = cutProven, pending' = pending, keepFlags,
  }
}
