// C03 layer 3: a Writer's startup drain commits its author fence (published only after
// readiness) and dies before publishing it.
//
// At the next epoch that fence is an own row of a closed epoch: displaced, unpublished, and
// with no settlement plan entry (a fence carries no intents, so the plan merge gives it no
// disposition). Every replacement preparation seals the recovery dependency census, which must
// classify every own outbox row. The shipped census accepts a displaced own row only when it is
// published, open in the plan, inherited, or terminal-covered, so it refuses this fence, and the
// startup drain fails at every reopen (the Writer is wedged).
//
// Rule under test: a committed but unpublished own fence of a closed epoch is classifiable. It
// is a signed no-op: no plane can admit it any more (its epoch is closed), it has nothing to
// replan, and the install's own fence in the new epoch supersedes it. The census retains it as
// a historical author fence (custody kept, charged, anchored like a published one); it never
// refuses on it and never drops it.
//   SOUND: the census also classifies an unpublished own fence of an earlier epoch.
//   Broken controls:
//     base       - the shipped census: refuses it (the reopen is wedged at every epoch).
//     silentDrop - the shipped census, but the drain "resolves" the refusal by dropping the row:
//                  committed, signed custody disappears without retirement.
//     anyKind    - the census accepts any unpublished own row of an earlier epoch, including an
//                  application row the plan has not taken: its moves are then never replaced.
module creatorUnpublishedFenceCensus {
  pure val MAX_EPOCH = 3
  pure val MAX_SEQ = 6

  type Mutants = { base: bool, silentDrop: bool, anyKind: bool }
  pure val SOUND: Mutants = { base: false, silentDrop: false, anyKind: false }

  // An own outbox row. planned: the settlement plan holds an open entry for it.
  type Row = { seq: int, kind: str, epoch: int, published: bool, planned: bool }

  var mu: Mutants
  var epoch: int
  var rows: Set[Row]
  var committed: Set[int]     // every ordinal this author committed (signed custody)
  var nextSeq: int
  var phase: str              // "running" | "crashed" | "draining" | "refused"
  var planCapacity: bool      // whether the plan merge can take every displaced application row

  action initWith(m: Mutants): bool = all {
    mu' = m, epoch' = 0, rows' = Set(), committed' = Set(), nextSeq' = 0, phase' = "running",
    planCapacity' = true,
  }
  action init = initWith(SOUND)
  action initBase = initWith({ ...SOUND, base: true })
  action initSilentDrop = initWith({ ...SOUND, silentDrop: true })
  action initAnyKind = initWith({ ...SOUND, anyKind: true })

  // Commit an own row (a fence or an application move) at the current epoch, unpublished.
  action issue(kind: str): bool = all {
    phase == "running",
    nextSeq < MAX_SEQ,
    rows' = rows.union(Set({ seq: nextSeq, kind: kind, epoch: epoch, published: false, planned: false })),
    committed' = committed.union(Set(nextSeq)),
    nextSeq' = nextSeq + 1,
    mu' = mu, epoch' = epoch, phase' = phase, planCapacity' = planCapacity,
  }

  // Publication only reaches the plane of the row's own epoch.
  action publish(r: Row): bool = all {
    phase == "running",
    rows.contains(r),
    r.epoch == epoch,
    not(r.published),
    rows' = rows.exclude(Set(r)).union(Set({ ...r, published: true })),
    mu' = mu, epoch' = epoch, committed' = committed, nextSeq' = nextSeq, phase' = phase, planCapacity' = planCapacity,
  }

  // The tab dies at any point (e.g. after the fence commit, before publication).
  action crash: bool = all {
    phase == "running",
    phase' = "crashed",
    mu' = mu, epoch' = epoch, rows' = rows, committed' = committed, nextSeq' = nextSeq, planCapacity' = planCapacity,
  }

  // Reopen in the same epoch or after the creator closed it. The plan may be full.
  action reopen(nextEpoch: bool, capacity: bool): bool = all {
    phase == "crashed",
    not(nextEpoch) or epoch < MAX_EPOCH,
    epoch' = if (nextEpoch) epoch + 1 else epoch,
    phase' = "draining",
    planCapacity' = capacity,
    mu' = mu, rows' = rows, committed' = committed, nextSeq' = nextSeq,
  }

  def displaced(r: Row): bool = r.epoch < epoch and not(r.published)
  // The census's classification of one own row.
  def classifiable(r: Row): bool =
    r.epoch == epoch or r.published or r.planned or
    (not(mu.base) and not(mu.silentDrop) and r.kind == "fence" and r.epoch < epoch) or
    (mu.anyKind and r.epoch < epoch)

  // The startup drain: merge the plan (each displaced application row gets an open entry when
  // the plan has room; a fence gets none), seal the census, then issue the new epoch's fence.
  action drain: bool = {
    val merged = rows.map(r => if (r.kind == "move" and displaced(r) and planCapacity) { ...r, planned: true } else r)
    val refused = merged.filter(r => not(classifiable(r)))
    val kept = if (mu.silentDrop) merged.exclude(refused) else merged
    all {
      phase == "draining",
      if (refused.size() > 0 and not(mu.silentDrop)) all {
        phase' = "refused", rows' = merged, committed' = committed, nextSeq' = nextSeq,
      } else if (nextSeq < MAX_SEQ) all {
        // The install's fence for this epoch, at the next ordinal: it supersedes older fences.
        rows' = kept.union(Set({ seq: nextSeq, kind: "fence", epoch: epoch, published: false, planned: false })),
        committed' = committed.union(Set(nextSeq)),
        nextSeq' = nextSeq + 1,
        phase' = "running",
      } else all {
        rows' = kept, committed' = committed, nextSeq' = nextSeq, phase' = "running",
      },
      mu' = mu, epoch' = epoch, planCapacity' = planCapacity,
    }
  }

  action step = any {
    nondet kind = Set("fence", "move").oneOf()
    issue(kind),
    nondet r = rows.oneOf()
    publish(r),
    crash,
    nondet nextEpoch = Set(true, false).oneOf()
    nondet capacity = Set(true, false).oneOf()
    reopen(nextEpoch, capacity),
    drain,
  }

  // The census never wedges a reopen on an unpublished own fence. (A full plan with a displaced
  // move is a separate, correct refusal: the move must be replaced, not dropped.)
  val noFenceRefusal: bool =
    phase != "refused" or rows.exists(r => r.kind == "move" and displaced(r) and not(r.planned))
  // Signed custody never disappears: every committed ordinal is still an outbox row.
  val custodyKept: bool = rows.map(r => r.seq) == committed
  // No move is lost: once a drain completes, every displaced move is open in the plan.
  val noLostMove: bool =
    phase != "running" or rows.forall(r => not(r.kind == "move" and displaced(r)) or r.planned)
  // After a completed drain at a later epoch, a fence of this epoch supersedes every older one.
  val fenceSuperseded: bool =
    phase != "running" or nextSeq >= MAX_SEQ or
    rows.forall(r => not(r.kind == "fence" and displaced(r)) or
      rows.exists(f => f.kind == "fence" and f.epoch == epoch and f.seq > r.seq))
  val safety: bool = noFenceRefusal and custodyKept and noLostMove and fenceSuperseded

  // The C03 layer-3 shape: fence and first replacement committed, the tab dies before
  // publishing them, the creator closes, the Writer reopens in the next epoch.
  run layer3Test = init
    .then(issue("fence")).then(issue("move")).then(crash).then(reopen(true, true)).then(drain)
    .expect(phase == "running" and safety and rows.exists(r => r.kind == "fence" and r.epoch == 1))
  run publishedFenceControlTest = init
    .then(issue("fence")).then(publish({ seq: 0, kind: "fence", epoch: 0, published: false, planned: false }))
    .then(crash).then(reopen(true, true)).then(drain)
    .expect(phase == "running" and safety)
  run fullPlanRefusesMoveTest = init
    .then(issue("move")).then(crash).then(reopen(true, false)).then(drain)
    .expect(phase == "refused" and safety)
  run baseWedgesTest = initBase
    .then(issue("fence")).then(issue("move")).then(crash).then(reopen(true, true)).then(drain)
    .expect(phase == "refused" and not(noFenceRefusal))
  run silentDropLosesCustodyTest = initSilentDrop
    .then(issue("fence")).then(crash).then(reopen(true, true)).then(drain)
    .expect(phase == "running" and not(custodyKept))
  run anyKindLosesMoveTest = initAnyKind
    .then(issue("move")).then(crash).then(reopen(true, false)).then(drain)
    .expect(phase == "running" and not(noLostMove))
}
