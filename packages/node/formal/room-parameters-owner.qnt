// MODEL (feat/room-state-limit-policy): one owner of the room parameters record as the native plane opens it.
//
// A room's parameters record carries the registry fields and, optionally, the room's application state limit
// (protocol-v3 room-parameters). The native plane opens the record at room open (v3-live: the registry fields
// within their ranges, the registered extension, exact canonical bytes). The room's invite authentication
// (v3-room authenticateCreatorInviteMaterial) judges the same record before any host acquisition, so an
// invite the plane would refuse never acquires a host. The two must agree on every record, and the
// judgement must not widen @ts-drp/node/v3-live's public surface (its export roster is pinned).
//
// Abstraction: a record is one of five shapes; the plane opens exactly `valid` and `validLimit`. The invite
// check is wired once (`wire`), choosing where its judgement comes from; then any record can be authenticated.
//
// Variants (the `wiring` the model starts with):
//   exportBridge  (the branch before the fix) v3-room reaches the plane's judgement through a new public
//                 v3-live export: the judgements agree but the public surface grows;
//   limitOnly     (the shortcut: drop the export and judge only the limit through the protocol owner) the
//                 surface is unchanged, but the invite check ignores unknown and out-of-range registry fields
//                 the plane refuses: such an invite acquires a host and only fails at plane open.
// Fixed design: an internal owner (packages/node/src/internal/v3-room-parameters.ts) used by both.
// Invariants:
//   inviteAgreesWithPlane  every record that passed invite authentication is one the plane opens;
//   surfaceUnchanged       v3-live's public surface is its base roster;
//   safety = both.
//
// Commands (packages/node/formal; JAVA_HOME=$(brew --prefix openjdk@17), PATH=$JAVA_HOME/bin:$PATH):
//   quint typecheck room-parameters-owner.qnt
//   quint test room-parameters-owner.qnt --main roomParametersOwner --match 'Test$'
//   V="quint verify room-parameters-owner.qnt --main roomParametersOwner --step step --backend apalache \
//      --apalache-version=0.56.1 --max-steps=6"
//   $V --init init --invariants safety                          # [ok]
//   $V --init initExportBridge --invariants safety              # violation (surfaceUnchanged)
//   $V --init initLimitOnly --invariants safety                 # violation (inviteAgreesWithPlane)
module roomParametersOwner {
  type Shape = Valid | ValidLimit | UnknownField | OutOfRange | BadLimit
  pure val SHAPES = Set(Valid, ValidLimit, UnknownField, OutOfRange, BadLimit)
  type Source = Unwired | InternalOwner | PublicBridge | LimitOwnerOnly
  type Variant = Sound | ExportBridge | LimitOnly
  pure val BASE_SURFACE = Set("roster")

  // v3-live's open of the record (and the internal owner, which is that judgement moved out of v3-live).
  pure def planeOpens(r: Shape): bool = r == Valid or r == ValidLimit
  // protocol-v3 roomApplicationStateLimit alone: it judges only the declared limit.
  pure def limitOwnerAccepts(r: Shape): bool = r != BadLimit
  pure def judge(source: Source, r: Shape): bool = match source {
    | Unwired => false
    | InternalOwner => planeOpens(r)
    | PublicBridge => planeOpens(r)
    | LimitOwnerOnly => limitOwnerAccepts(r)
  }

  var wiring: Variant
  var source: Source
  var surface: Set[str]
  var acquired: Set[Shape]   // records whose invite authenticated and acquired a host

  action initWith(v: Variant): bool = all {
    wiring' = v, source' = Unwired, surface' = BASE_SURFACE, acquired' = Set(),
  }
  action init = initWith(Sound)
  action initExportBridge = initWith(ExportBridge)
  action initLimitOnly = initWith(LimitOnly)

  // v3-room wires its invite check's parameters judgement.
  action wire = all {
    source == Unwired,
    val chosen = match wiring { | Sound => InternalOwner | ExportBridge => PublicBridge | LimitOnly => LimitOwnerOnly }
    all {
      source' = chosen,
      surface' = if (chosen == PublicBridge) surface.union(Set("v3RoomParametersApplicationStateLimit")) else surface,
    },
    wiring' = wiring, acquired' = acquired,
  }
  // A member authenticates an invite whose parameters record has shape r; it acquires a host only if accepted.
  action authenticateWith(r: Shape): bool = all {
    source != Unwired,
    acquired' = if (judge(source, r)) acquired.union(Set(r)) else acquired,
    wiring' = wiring, source' = source, surface' = surface,
  }
  action authenticate = { nondet r = SHAPES.oneOf() authenticateWith(r) }
  action step = any { wire, authenticate }

  val inviteAgreesWithPlane = acquired.forall(r => planeOpens(r))
  val surfaceUnchanged = surface == BASE_SURFACE
  val safety = inviteAgreesWithPlane and surfaceUnchanged

  run soundTest = init.then(wire).then(authenticateWith(UnknownField)).then(authenticateWith(OutOfRange))
    .then(authenticateWith(BadLimit)).then(authenticateWith(ValidLimit))
    .then(all { assert(acquired == Set(ValidLimit) and safety), authenticateWith(Valid) })
  run exportBridgeTest = initExportBridge.then(wire)
    .then(all { assert(not(surfaceUnchanged) and inviteAgreesWithPlane), authenticateWith(Valid) })
  run limitOnlyTest = initLimitOnly.then(wire)
    .then(all { assert(surfaceUnchanged), authenticateWith(UnknownField) })
    .then(all { assert(not(inviteAgreesWithPlane)), authenticateWith(Valid) })
}
