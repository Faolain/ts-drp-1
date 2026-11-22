// Focused transition model, not a cryptographic or native-storage proof.
// A fixed-creator checkpoint grants current authority but does not classify an
// old local source. Reattachment keeps that source until positive commitment or
// an explicit policy disposition. Native receipt/floor/head facts survive crash.
module creatorCheckpointReattachment {
  type State = {
    room: int, head: int, floor: int, pending: int,
    writerAt: int -> bool, receipt: bool, receiptSource: int, receiptTarget: int,
    active: bool, session: int, terminal: Set[int], lastIssueSession: int,
    next: int, accepted: Set[int], local: Set[int], sourceProof: Set[int],
    committed: Set[int], commitmentProof: Set[int], disposed: Set[int], review: Set[int]
  }
  var s: State
  pure val CAPACITY = 4
  pure val MAX_EPOCH = 12

  action init = s' = {
    room: 0, head: 0, floor: 0, pending: -1,
    writerAt: Map(0 -> true), receipt: false, receiptSource: -1, receiptTarget: -1,
    active: true, session: 0, terminal: Set(), lastIssueSession: -1,
    next: 0, accepted: Set(), local: Set(), sourceProof: Set(),
    committed: Set(), commitmentProof: Set(), disposed: Set(), review: Set()
  }

  action issue = all {
    s.active, not(s.receipt), s.pending == -1, s.writerAt.get(s.head),
    s.local.size() < CAPACITY, s.next < 6,
    s' = s.with("next", s.next + 1)
      .with("accepted", s.accepted.union(Set(s.next)))
      .with("local", s.local.union(Set(s.next)))
      .with("sourceProof", s.sourceProof.union(Set(s.next)))
      .with("lastIssueSession", s.session)
  }

  action seal(writer: bool): bool = all {
    s.room < MAX_EPOCH,
    s' = s.with("room", s.room + 1).with("writerAt", s.writerAt.put(s.room + 1, writer))
  }

  // Caller does not get an ancestry or completion claim from this point proof.
  // The epoch is shorthand for the exact signed target checkpoint identity.
  action prepare = all {
    s.active, not(s.receipt), s.pending == -1, s.room > s.head,
    s' = s.with("receipt", true).with("receiptSource", s.head).with("receiptTarget", s.room)
      .with("active", false).with("terminal", s.terminal.union(Set(s.session)))
      .with("review", s.review.union(s.local.exclude(s.commitmentProof).exclude(s.disposed)))
  }

  action beginFloor = all {
    s.receipt, s.pending == -1, s.floor == s.receiptSource, s.head == s.receiptSource,
    s' = s.with("pending", s.receiptTarget)
  }

  action publish = all {
    s.receipt, s.pending == s.receiptTarget, s.floor == s.receiptSource,
    s.head == s.receiptSource,
    s' = s.with("head", s.receiptTarget)
  }

  action commitFloor = all {
    s.receipt, s.pending == s.receiptTarget, s.head == s.receiptTarget,
    s' = s.with("floor", s.receiptTarget).with("pending", -1)
  }

  action activate = all {
    s.receipt, s.pending == -1, s.head == s.receiptTarget, s.floor == s.receiptTarget,
    s' = s.with("receipt", false).with("receiptSource", -1).with("receiptTarget", -1)
      .with("session", s.session + 1).with("active", true)
  }

  action crash = all {
    s.active or s.receipt,
    s' = s.with("active", false).with("terminal", s.terminal.union(Set(s.session)))
  }

  action reopenOld = all {
    not(s.active), not(s.receipt), s.pending == -1, s.head == s.floor,
    s' = s.with("active", true).with("session", s.session + 1)
  }

  action proveCommit(id: int): bool = all {
    s.local.contains(id),
    s' = s.with("committed", s.committed.union(Set(id)))
      .with("commitmentProof", s.commitmentProof.union(Set(id)))
      .with("review", s.review.exclude(Set(id)))
  }

  action resolvePolicy(id: int): bool = all {
    s.active, not(s.receipt), s.review.contains(id),
    s' = s.with("disposed", s.disposed.union(Set(id))).with("review", s.review.exclude(Set(id)))
  }

  action prune(id: int): bool = all {
    s.local.contains(id), s.commitmentProof.contains(id) or s.disposed.contains(id),
    s' = s.with("local", s.local.exclude(Set(id))).with("sourceProof", s.sourceProof.exclude(Set(id)))
  }

  action step = any {
    issue, seal(true), seal(false), prepare, beginFloor, publish, commitFloor,
    activate, crash, reopenOld,
    nondet id = 0.to(5).oneOf()
    any { proveCommit(id), resolvePolicy(id), prune(id) }
  }

  // Finite exhaustive projection: up to three room epochs, two accepted
  // identities, and five runtime incarnations. The unrestricted step above
  // remains the randomized long-offline surface. These guards bound the model,
  // not the product's supported lag or lifetime.
  action stepSmall = any {
    all { s.next < 2, issue },
    all { s.room < 3, seal(true) },
    all { s.room < 3, seal(false) },
    prepare, beginFloor, publish, commitFloor,
    all { s.session < 4, activate },
    crash,
    all { s.session < 4, reopenOld },
    nondet id = 0.to(1).oneOf()
    any { proveCommit(id), resolvePolicy(id), prune(id) }
  }

  val noIntentLoss = s.accepted.subseteq(s.local.union(s.committed).union(s.disposed))
  val sourceCustody = s.local.subseteq(s.sourceProof)
  val boundedPending = s.local.size() <= CAPACITY and s.sourceProof.size() <= CAPACITY
  val floorSafe = if (s.pending == -1) s.floor == s.head
    else s.receipt and s.floor == s.receiptSource and s.pending == s.receiptTarget and
      (s.head == s.receiptSource or s.head == s.receiptTarget)
  val receiptBound = not(s.receipt) or
    (s.receiptSource >= 0 and s.receiptTarget > s.receiptSource and s.receiptTarget <= s.room)
  val noResurrection = not(s.active) or not(s.terminal.contains(s.session))
  val allSafety = noIntentLoss and sourceCustody and boundedPending and floorSafe and receiptBound and noResurrection

  run twoMissedInstallsTest = init.then(issue).then(seal(true)).then(seal(true))
    .then(prepare).then(beginFloor).then(publish).then(commitFloor).then(activate)
    .expect(s.head == 2 and s.review == Set(0) and s.local == Set(0) and allSafety)
    .then(issue).expect(s.accepted == Set(0, 1) and allSafety)

  run longOfflineTest = init.then(issue)
    .then(seal(true)).then(seal(true)).then(seal(true)).then(seal(true))
    .then(seal(true)).then(seal(true)).then(seal(true)).then(seal(true))
    .then(prepare).then(beginFloor).then(publish).then(crash).then(commitFloor).then(activate)
    .expect(s.head == 8 and s.local == Set(0) and s.review == Set(0) and allSafety)
    .then(resolvePolicy(0)).then(prune(0)).expect(s.disposed == Set(0) and s.local == Set() and allSafety)

  run removedReadmittedSameStoreTest = init.then(issue).then(seal(false))
    .then(prepare).then(beginFloor).then(publish).then(commitFloor).then(activate)
    .expect(not(s.writerAt.get(s.head)) and s.review == Set(0) and allSafety)
    .then(crash).then(reopenOld).then(seal(true)).then(prepare).then(beginFloor)
    .then(publish).then(commitFloor).then(activate).then(issue)
    .expect(s.writerAt.get(s.head) and s.next == 2 and s.local == Set(0, 1) and allSafety)

  run crashBeforePublicationTest = init.then(issue).then(seal(true)).then(seal(true))
    .then(prepare).then(beginFloor).then(crash)
    .expect(s.head == 0 and s.floor == 0 and s.pending == 2 and allSafety)
    .then(publish).then(commitFloor).then(activate).expect(s.head == 2 and allSafety)

  // Mutation controls demonstrate why missing frontier/old incarnation is not Done.
  action abandonUnresolved = s' = s.with("local", Set()).with("sourceProof", Set()).with("review", Set())
  run missingFrontierIsNotDoneTest = init.then(issue).then(seal(false)).then(prepare)
    .then(beginFloor).then(publish).then(commitFloor).then(activate)
    .then(abandonUnresolved).expect(not(noIntentLoss))

  action reviveOldSession = s' = s.with("active", true)
  run oldHandleCannotReviveTest = init.then(issue).then(seal(true)).then(prepare)
    .then(reviveOldSession).expect(not(noResurrection))

  action stepSmallLoseIntent = any { stepSmall, abandonUnresolved }
  action stepSmallReviveSession = any { stepSmall, reviveOldSession }
}
