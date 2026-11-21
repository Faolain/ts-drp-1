// MODEL (owner decision 2026-11-21; feat/room-state-limit-policy): the room's application state limit is
// a per-room setting chosen at room creation. It is the optional `maxApplicationStateBytes` field of the
// room's signed parameters record (protocol-v3 room-parameters): its digest is in the creator-signed
// genesis anchor and every successor anchor copies it, so the value is authenticated (G5) and fixed for
// the room's life. Absent, the limit is the default (32,768 bytes). A declared value outside
// [default, ceiling] is refused by the creator when it builds the invite and by every member that
// authenticates one (a hostile or faulty creator can still sign one).
//
// The admission core (typed refusal, batch split, the seal's fold refusing a state past the limit) is
// room-state-limit-admission.qnt (copied from quint/int7-wo f5149809c), which takes the limit as one
// constant. This model adds what the setting changes: which limit each member enforces.
//
// Abstraction: bytes are small integers; DEFAULT = 2, CEILING = 4. The signed declared value is
// 0 (absent) or 1..5 (1 is below the floor, 5 above the ceiling). Member 0 is the creator (the
// authoritative admitter and sealer); members 1 and 2 are Writers. A Writer's own check is advisory (its
// view), the creator's admission is authoritative, and the creator's seal folds the epoch on a machine
// with the creator's limit (it refuses a state past it: the room is wedged, nothing is signed). A member
// installs a signed successor state on a machine with its own limit (BlueprintStateMachine refuses an
// initial state past it): a refused install leaves that member stuck (wedged). `unavailable` is the
// creator's state check being unavailable (plane closing or folded, no machine): local issue refuses
// and ingress collects the row for later (v3-live), so the move is deferred, not admitted.
//
// Variants (`mutants`):
//   memberLocalDefault   a Writer enforces the library default instead of the room's authenticated limit;
//   creatorLocalDefault  the creator's admission and seal machine use the default (a constant left in);
//   uncheckedCeiling     a member (and creator) accepts an invite whose limit is outside [default, ceiling];
//   admitUnavailable     the creator admits a move unchecked while its state check is unavailable;
//   untyped              a refusal is a plain error (the application cannot tell it from a failure).
// Invariants:
//   joinedOnlyValid   no member joins a room whose declared limit is invalid;
//   limitsAgree       every joined member enforces the room's authenticated limit (so all agree);
//   stateWithinLimit  the creator's admitted state and the signed state are within the room's limit;
//   stateWithinCeiling no admitted or signed state passes the library ceiling;
//   noWedge           no seal refuses and no member refuses a signed state (a full room does not wedge);
//   writerKeepsPlaying every refusal is typed;
//   noOverRefusal     a move is refused only when it does not fit the room's limit.
//   safety = all. signedWithinLimit (the seal's fold as backstop) holds even under admitUnavailable.
//
// Commands (packages/node/formal; JAVA_HOME=/opt/homebrew/opt/openjdk@17, PATH=$JAVA_HOME/bin:$PATH):
//   quint typecheck room-state-limit-policy.qnt
//   quint test room-state-limit-policy.qnt --main roomStateLimitPolicy --match 'Test$'
//   quint run room-state-limit-policy.qnt --main roomStateLimitPolicy --max-steps=12 --max-samples=20000 \
//     --invariant safety                                                   # [ok]
//   V="quint verify room-state-limit-policy.qnt --main roomStateLimitPolicy --step step \
//      --backend apalache --apalache-version=0.56.1 --max-steps=8"
//   $V --init init --invariants safety                                    # [ok]
//   $V --init initMemberLocalDefault --invariants safety                  # violation (limitsAgree)
//   $V --init initCreatorLocalDefault --invariants safety                 # violation (limitsAgree)
//   $V --init initUncheckedCeiling --invariants safety                    # violation (joinedOnlyValid)
//   $V --init initAdmitUnavailable --invariants safety                    # violation (stateWithinLimit)
//   $V --init initAdmitUnavailable --invariants signedWithinLimit         # [ok]: the seal is the backstop
//   $V --init initUntyped --invariants safety                             # violation (writerKeepsPlaying)
//   Outcomes are recorded in .logs/realtime-resume-2026-11-10/agent-status/room-state-policy.md.
module roomStateLimitPolicy {
  pure val DEFAULT = 2
  pure val CEILING = 4
  pure val DECLARED = 0.to(CEILING + 1)   // 0 = absent
  pure val MEMBERS = 0.to(2)              // 0 = creator
  pure val WRITERS = 1.to(2)
  pure val DELTAS = Set(-1, 1, 2)
  pure val MAX_MOVES = 4
  pure val MAX_SEALS = 2
  type Mutants = {
    memberLocalDefault: bool, creatorLocalDefault: bool, uncheckedCeiling: bool, admitUnavailable: bool, untyped: bool,
  }
  pure val SOUND: Mutants = {
    memberLocalDefault: false, creatorLocalDefault: false, uncheckedCeiling: false, admitUnavailable: false, untyped: false,
  }

  // protocol-v3 room-parameters: isRegisteredRoomParameterExtension / roomApplicationStateLimit.
  pure def valid(d: int): bool = d == 0 or (d >= DEFAULT and d <= CEILING)
  pure def effective(d: int): int = if (d == 0) DEFAULT else d
  pure def clamp(v: int): int = if (v < 0) 0 else v

  var declared: int                 // the creator-signed declared value; -1 before the invite exists
  var joined: int -> bool
  var limitOf: int -> int           // the limit each joined member enforces
  var stateBytes: int               // the creator's admitted epoch state
  var signed: int                   // the last signed (sealed) state
  var installedAt: int -> int       // the signed state each member installed (-1: none yet)
  var unavailable: bool             // the creator's state check is unavailable (closing / folded / no machine)
  var moves: int
  var seals: int
  var wedged: bool
  var frozen: bool
  var refusedFitting: bool          // ghost: a move refused although it fit the room's limit
  var mutants: Mutants

  def roomLimit: int = effective(declared)
  // The limit a member reads from the authenticated invite, as each variant reads it.
  def readLimit(m: int): int =
    if (m == 0 and mutants.creatorLocalDefault) DEFAULT
    else if (m != 0 and mutants.memberLocalDefault) DEFAULT
    else effective(declared)
  def accepts: bool = valid(declared) or mutants.uncheckedCeiling
  def refusal: bool = mutants.untyped

  action initWith(mu: Mutants): bool = all {
    declared' = -1, joined' = MEMBERS.mapBy(m => false), limitOf' = MEMBERS.mapBy(m => 0), stateBytes' = 0,
    signed' = 0, installedAt' = MEMBERS.mapBy(m => -1), unavailable' = false, moves' = 0, seals' = 0,
    wedged' = false, frozen' = false, refusedFitting' = false, mutants' = mu,
  }
  action init = initWith(SOUND)
  action initMemberLocalDefault = initWith({ ...SOUND, memberLocalDefault: true })
  action initCreatorLocalDefault = initWith({ ...SOUND, creatorLocalDefault: true })
  action initUncheckedCeiling = initWith({ ...SOUND, uncheckedCeiling: true })
  action initAdmitUnavailable = initWith({ ...SOUND, admitUnavailable: true })
  action initUntyped = initWith({ ...SOUND, untyped: true })

  // The creator signs an invite declaring d (any d: a faulty creator may sign an invalid one). The
  // creator's own room opens only when its check accepts d (createV3RoomCreatorInviteMaterial).
  action createWith(d: int): bool = all {
    declared == -1,
    declared' = d,
    val ok = valid(d) or mutants.uncheckedCeiling
    all {
      joined' = joined.set(0, ok),
      limitOf' = limitOf.set(0, if (not(ok)) 0 else if (mutants.creatorLocalDefault) DEFAULT else effective(d)),
      installedAt' = installedAt.set(0, if (ok) 0 else -1),
    },
    stateBytes' = stateBytes, signed' = signed, unavailable' = unavailable, moves' = moves, seals' = seals,
    wedged' = wedged, frozen' = frozen, refusedFitting' = refusedFitting, mutants' = mutants,
  }
  action create = { nondet d = DECLARED.oneOf() createWith(d) }

  // A Writer authenticates the invite (decodeCreatorInvite): it joins only when the declared limit is valid.
  action joinWith(m: int): bool = all {
    declared >= 0, not(joined.get(m)), accepts,
    joined' = joined.set(m, true), limitOf' = limitOf.set(m, readLimit(m)),
    installedAt' = installedAt.set(m, signed),
    declared' = declared, stateBytes' = stateBytes, signed' = signed, unavailable' = unavailable, moves' = moves,
    seals' = seals, wedged' = wedged, frozen' = frozen, refusedFitting' = refusedFitting, mutants' = mutants,
  }
  action join = { nondet m = WRITERS.oneOf() joinWith(m) }

  // Member m issues a move growing the state by d. Its own check is advisory; the creator judges it.
  action issueWith(m: int, d: int): bool = all {
    joined.get(0), joined.get(m), not(wedged), moves < MAX_MOVES,
    moves' = moves + 1,
    val proposed = clamp(stateBytes + d)
    val fitsRoom = proposed <= roomLimit
    if (unavailable and mutants.admitUnavailable) all {
      stateBytes' = proposed, frozen' = frozen, refusedFitting' = refusedFitting,
    } else if (unavailable) all {
      // Deferred: local issue answers not-active, ingress collects the row for after the install.
      stateBytes' = stateBytes, frozen' = frozen, refusedFitting' = refusedFitting,
    } else if (proposed <= limitOf.get(m) and proposed <= limitOf.get(0)) all {
      stateBytes' = proposed, frozen' = frozen, refusedFitting' = refusedFitting,
    } else all {
      // Refused (V3RoomStateLimitRefused naming the limit; untyped under the variant).
      stateBytes' = stateBytes, frozen' = if (refusal) true else frozen,
      refusedFitting' = if (fitsRoom) true else refusedFitting,
    },
    declared' = declared, joined' = joined, limitOf' = limitOf, signed' = signed, installedAt' = installedAt,
    unavailable' = unavailable, seals' = seals, wedged' = wedged, mutants' = mutants,
  }
  action issue = { nondet m = MEMBERS.oneOf() nondet d = DELTAS.oneOf() issueWith(m, d) }

  // The creator stages the close: its state check becomes unavailable until the seal.
  action closeBegin = all {
    joined.get(0), not(unavailable), not(wedged), seals < MAX_SEALS,
    unavailable' = true,
    declared' = declared, joined' = joined, limitOf' = limitOf, stateBytes' = stateBytes, signed' = signed,
    installedAt' = installedAt, moves' = moves, seals' = seals, wedged' = wedged, frozen' = frozen,
    refusedFitting' = refusedFitting, mutants' = mutants,
  }
  // The seal folds the epoch on the creator's machine: past its limit the fold refuses and the room wedges.
  action seal = all {
    unavailable, not(wedged),
    if (stateBytes > limitOf.get(0)) all {
      wedged' = true, signed' = signed, seals' = seals, installedAt' = installedAt, unavailable' = unavailable,
    } else all {
      wedged' = false, signed' = stateBytes, seals' = seals + 1, installedAt' = installedAt.set(0, stateBytes),
      unavailable' = false,
    },
    declared' = declared, joined' = joined, limitOf' = limitOf, stateBytes' = stateBytes, moves' = moves,
    frozen' = frozen, refusedFitting' = refusedFitting, mutants' = mutants,
  }
  // A Writer installs the signed successor state on a machine with its own limit.
  action installWith(m: int): bool = all {
    joined.get(m), installedAt.get(m) != signed,
    if (signed <= limitOf.get(m)) all { installedAt' = installedAt.set(m, signed), wedged' = wedged }
    else all { installedAt' = installedAt, wedged' = true },
    declared' = declared, joined' = joined, limitOf' = limitOf, stateBytes' = stateBytes, signed' = signed,
    unavailable' = unavailable, moves' = moves, seals' = seals, frozen' = frozen, refusedFitting' = refusedFitting,
    mutants' = mutants,
  }
  action install = { nondet m = WRITERS.oneOf() installWith(m) }

  action step = any { create, join, issue, closeBegin, seal, install }

  val joinedOnlyValid = MEMBERS.forall(m => joined.get(m) implies valid(declared))
  val limitsAgree = MEMBERS.forall(m => joined.get(m) implies limitOf.get(m) == roomLimit)
  val stateWithinLimit = declared < 0 or (stateBytes <= roomLimit and signed <= roomLimit)
  val stateWithinCeiling = stateBytes <= CEILING and signed <= CEILING
  val signedWithinLimit = declared < 0 or signed <= roomLimit
  val noWedge = not(wedged)
  val writerKeepsPlaying = not(frozen)
  val noOverRefusal = not(refusedFitting)
  val safety = joinedOnlyValid and limitsAgree and stateWithinLimit and stateWithinCeiling and noWedge and
    writerKeepsPlaying and noOverRefusal

  // Tests (deterministic traces).
  // A room created without the setting enforces the default; one created with 4 admits past the default.
  run defaultRoomTest = init.then(createWith(0)).then(joinWith(1))
    .then(all { assert(limitOf.get(0) == DEFAULT and limitOf.get(1) == DEFAULT), issueWith(1, 2) })
    .then(issueWith(1, 1))
    .then(all { assert(stateBytes == 2 and not(frozen) and safety), issueWith(1, -1) })
    .then(all { assert(stateBytes == 1 and safety), closeBegin }).then(seal).then(installWith(1))
    .then(all { assert(installedAt.get(1) == 1 and safety), closeBegin })
  // A full room refuses typed and the writer keeps playing (a shrinking move is admitted), and it rolls.
  run fullRoomKeepsPlayingTest = init.then(createWith(4)).then(joinWith(1)).then(joinWith(2))
    .then(issueWith(1, 2)).then(issueWith(2, 2))
    .then(all { assert(stateBytes == 4), issueWith(1, 1) })
    .then(all { assert(stateBytes == 4 and not(frozen) and safety), issueWith(2, -1) })
    .then(all { assert(stateBytes == 3), closeBegin }).then(seal).then(installWith(1)).then(installWith(2))
    .then(all { assert(signed == 3 and installedAt.get(1) == 3 and installedAt.get(2) == 3 and safety), closeBegin })
  // Invalid declared values: the creator does not open the room and no Writer joins it.
  // (`.fail()` ends a trace: it asserts the action is disabled and sets no state.)
  run aboveCeilingRefusedTest = init.then(createWith(5))
    .then(all { assert(not(joined.get(0)) and not(joined.get(1)) and safety), joinWith(1).fail() })
  run aboveCeilingNoIssueTest = init.then(createWith(5)).then(issueWith(0, 1).fail())
  run belowFloorRefusedTest = init.then(createWith(1))
    .then(all { assert(not(joined.get(0)) and safety), joinWith(2).fail() })
  run belowFloorNoCloseTest = init.then(createWith(1)).then(closeBegin.fail())
  // A move while the check is unavailable is deferred, never admitted unchecked.
  run unavailableDefersTest = init.then(createWith(2)).then(issueWith(0, 2)).then(closeBegin).then(issueWith(0, 2))
    .then(all { assert(stateBytes == 2 and safety), seal })
    .then(all { assert(signed == 2 and not(unavailable) and safety), issueWith(0, -1) })
  // Broken variants.
  run memberLocalDefaultTest = initMemberLocalDefault.then(createWith(4)).then(joinWith(1))
    .then(all { assert(not(limitsAgree)), issueWith(1, 2) }).then(issueWith(1, 1))
    .then(all { assert(stateBytes == 2 and not(noOverRefusal)), issueWith(0, 1) })
    .then(closeBegin).then(seal)
    .then(all { assert(signed == 3), installWith(1) })
    .then(all { assert(wedged and not(noWedge)), issueWith(0, -1).fail() })
  run uncheckedCeilingTest = initUncheckedCeiling.then(createWith(5)).then(joinWith(1))
    .then(all { assert(not(joinedOnlyValid)), issueWith(1, 2) }).then(issueWith(1, 2)).then(issueWith(1, 1))
    .then(all { assert(stateBytes == 5 and not(stateWithinCeiling)), closeBegin })
  run admitUnavailableTest = initAdmitUnavailable.then(createWith(0)).then(issueWith(0, 2)).then(closeBegin)
    .then(issueWith(0, 1))
    .then(all { assert(stateBytes == 3 and not(stateWithinLimit) and signedWithinLimit), seal })
    .then(all { assert(wedged and signed == 0 and signedWithinLimit), closeBegin.fail() })
  run untypedTest = initUntyped.then(createWith(0)).then(issueWith(0, 2)).then(issueWith(0, 1))
    .then(all { assert(frozen and not(writerKeepsPlaying)), closeBegin })
}
