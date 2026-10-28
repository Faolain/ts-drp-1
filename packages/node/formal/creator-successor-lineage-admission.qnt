// Cold reopen of a creator successor: which local issuance lineages may bind
// the selected author's issuance scope (creator-adoption.ts
// authenticatedSuccessorIssuanceScope, plan D.108d1b as amended).
//
// A device store holds one lineage per (author, object). Since ea4eb158 one
// browser origin hosts several identities (Web Lock slots) that share ONE
// room database, so a store legitimately holds other writers' nonzero
// lineages. A store can also be a stale copy, or a fresh database next to a
// copied seed: it then holds the selected author's key but not the rows that
// key already issued.
//
// The room's authenticated closed frontier `admitted[a]` is the highest
// sequence of author a the last close admitted (-1: none). A reopen issues the
// selected author's next sequence from its local lineage.
//
// Rules under test:
//   frontier (shipped)  refuse when the SELECTED author's local next is at or
//                       below its authenticated frontier; other authors'
//                       lineages are never consulted for authority.
//   noCheck (mutant)    ea4eb158 as found: any lineage reopens.
//   oldRule (mutant)    D.108d1b before ea4eb158: refuse when any OTHER author's
//                       lineage in the store is nonzero.
// Properties:
//   noAdmittedReissue   no store ever issues a sequence the room already
//                       admitted from that author (a same-slot equivocation
//                       that a close can only detect after the fact).
//   soleCustodianLive   a store that is the only holder of an author's key
//                       can always reopen as that author, whatever other
//                       writers' lineages share its database.
// Out of scope (inherent): two stores with the same key issuing concurrently
// before any close admits either; the creator close detects that duplicate
// slot ("author slot is ambiguous").
//
// Owner decisions of 2026-10-28, layered on top:
//   A  one room database per player. The shared "tabs" layout above is kept as
//      the broken control; per-player databases ("aliceDb", "bobDb") each have
//      exactly one writing author (singleWriter). A migration copies one
//      author's lineage out of the shared database, which then only reads
//      (retired); the unfiltered copy (every author's rows) is a mutant.
//   B  sync before sending. A store that reopened a lineage from storage (a
//      copy, a restored backup, a migrated database) is not current: it signs
//      nothing until it installs the room's current successor (it then knows
//      the closed frontier) or confirms the creator's statement: the store is
//      at the room's epoch and its lineage is above the author's admitted
//      sequence in it (liveAdmitted). The creator's live admission is explicit
//      (deliver), so a vertex still in flight is not in the statement.
//      noCurrentReissue is now the strong property: no store signs a slot the
//      room has admitted at that moment (closed or live), with or without the
//      frontier known. A fresh lineage (freshSeed) starts current, as shipped:
//      it assumes a fresh lineage holds a fresh key (testFreshSeedResidual).
//   Found by this model: the shipped install proves the closed frontier only, so a
//   device restored from a backup taken before the original signed in the epoch it
//   installs re-signs that slot with its install fence (perPlayerStep, known gap,
//   testRestoreInstallReissuesLiveSlotKnownGap). Checking the creator's statement for
//   the installed epoch before the fence (installRule "live", not shipped) closes it
//   (perPlayerStepLiveInstall). Currency is per database here, so the shared layout
//   (one database, two authors) also breaks it: decision A is required for B.
//   Residuals by construction: the dead device's vertex still in flight after the
//   restore became current (testInFlightResidual); two live devices holding one key.
module creatorSuccessorLineageAdmission {
  pure val AUTHORS = Set("alice", "bob")
  pure val STORES = Set("tabs", "copy", "aliceDb", "bobDb")
  pure val PLAYER_DB = Map("alice" -> "aliceDb", "bob" -> "bobDb")
  pure val MAX_SEQUENCE = 3
  pure val MAX_EPOCH = 2

  type Rule = str // "frontier" | "noCheck" | "oldRule"

  var lineage: str -> (str -> int)   // store -> author -> next
  var custody: str -> Set[str]          // store -> identities whose key it holds
  var admitted: str -> int           // authenticated closed frontier per author
  var published: Set[(str, int, str)] // (author, sequence, issuing store)
  var reissued: bool                 // history: an admitted slot was issued again
  var everHeld: str -> Set[str]      // history: author -> every store that ever held its key
  // Issuance-time layer (every local signature, not only reopen):
  var known: str -> (str -> int)     // store -> the authenticated frontier its adopted generation carries
  var backupLineage: str -> int      // a backup of the tabs database (lineage per author)
  var backupKnown: str -> int        // ... and the frontier that backup knew
  var currentReissue: bool           // history: a slot the room had admitted (closed or live) signed again
  // Decision B (sync before sending):
  var current: str -> bool           // store -> may sign new moves
  var liveAdmitted: str -> int       // author -> highest sequence the creator admitted in the open epoch (-1: none)
  var roomEpoch: int                 // the creator's current epoch
  var epochOf: str -> int            // store -> the epoch its plane is at
  var backupEpoch: int               // ... the epoch the backup's plane was at
  var backupFrom: str                // ... the store it was taken from
  // Decision A (per-player databases):
  var retired: Set[str]              // databases that only read (the migrated shared one)

  pure def reopenOk(rule: Rule, l: str -> (str -> int), adm: str -> int, st: str, a: str): bool =
    if (rule == "frontier") l.get(st).get(a) > adm.get(a)
    else if (rule == "oldRule") AUTHORS.forall(other => other == a or l.get(st).get(other) == 0)
    else true

  // ---- Properties ----
  val noAdmittedReissue = not(reissued)
  def soleHolder(st: str, a: str): bool = everHeld.get(a) == Set(st)
  def soleCustodianLiveWith(rule: Rule): bool =
    STORES.forall(st => AUTHORS.forall(a =>
      (custody.get(st).contains(a) and soleHolder(st, a)) implies reopenOk(rule, lineage, admitted, st, a)))
  val soleCustodianLive = soleCustodianLiveWith("frontier")
  val oldRuleLive = soleCustodianLiveWith("oldRule") // broken-control target only
  val inv = noAdmittedReissue and soleCustodianLive
  def roomFrontier(a: str): int = if (admitted.get(a) > liveAdmitted.get(a)) admitted.get(a) else liveAdmitted.get(a)
  // Decision A: an author writes in a database when it holds the key there or its lineage rows are there.
  def writersOf(st: str): Set[str] = AUTHORS.filter(a => custody.get(st).contains(a) or lineage.get(st).get(a) > 0)
  val singleWriter = STORES.forall(st => retired.contains(st) or writersOf(st).size() <= 1)
  val issuanceInv = soleCustodianLive  // plus noCurrentReissue (declared with the issuance layer)

  // One origin, two tabs: Alice (slot 0) and Bob (slot 1) share the "tabs"
  // database. The "copy" store starts empty and keyless.
  action init = all {
    lineage' = STORES.mapBy(_ => AUTHORS.mapBy(_ => 0)),
    custody' = STORES.mapBy(st => if (st == "tabs") AUTHORS else Set()),
    admitted' = AUTHORS.mapBy(_ => -1),
    published' = Set(),
    reissued' = false,
    everHeld' = AUTHORS.mapBy(_ => Set("tabs")),
    known' = STORES.mapBy(_ => AUTHORS.mapBy(_ => -1)),
    backupLineage' = AUTHORS.mapBy(_ => 0),
    backupKnown' = AUTHORS.mapBy(_ => -1),
    currentReissue' = false,
    current' = STORES.mapBy(st => st == "tabs"),
    liveAdmitted' = AUTHORS.mapBy(_ => -1),
    roomEpoch' = 0,
    epochOf' = STORES.mapBy(_ => 0),
    backupEpoch' = 0,
    backupFrom' = "tabs",
    retired' = Set(),
  }
  // Decision A as shipped from the start: each player on its own new database.
  action initPerPlayer = all {
    lineage' = STORES.mapBy(_ => AUTHORS.mapBy(_ => 0)),
    custody' = Map("tabs" -> Set(), "copy" -> Set(), "aliceDb" -> Set("alice"), "bobDb" -> Set("bob")),
    admitted' = AUTHORS.mapBy(_ => -1),
    published' = Set(),
    reissued' = false,
    everHeld' = Map("alice" -> Set("aliceDb"), "bob" -> Set("bobDb")),
    known' = STORES.mapBy(_ => AUTHORS.mapBy(_ => -1)),
    backupLineage' = AUTHORS.mapBy(_ => 0),
    backupKnown' = AUTHORS.mapBy(_ => -1),
    currentReissue' = false,
    current' = STORES.mapBy(st => st == "aliceDb" or st == "bobDb"),
    liveAdmitted' = AUTHORS.mapBy(_ => -1),
    roomEpoch' = 0,
    epochOf' = STORES.mapBy(_ => 0),
    backupEpoch' = 0,
    backupFrom' = "aliceDb",
    retired' = Set(),
  }
  action unchangedB = all {
    current' = current, liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch, epochOf' = epochOf,
    backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }

  action issueWith(rule: Rule, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    lineage.get(st).get(a) < MAX_SEQUENCE,
    reopenOk(rule, lineage, admitted, st, a),
    val sequence = lineage.get(st).get(a)
    all {
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      currentReissue' = (currentReissue or sequence <= roomFrontier(a)),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld, known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown,
    unchangedB,
  }

  // A close admits, per author, the highest published sequence.
  // (Decision B: the epoch advances and the open epoch's live admission is folded in.)
  action close: bool = all {
    roomEpoch < MAX_EPOCH,
    admitted' = AUTHORS.mapBy(a => published.fold(admitted.get(a), (m, v) =>
      if (v._1 == a and v._2 > m) v._2 else m)),
    lineage' = lineage, custody' = custody, published' = published, reissued' = reissued, everHeld' = everHeld,
    known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
    current' = current, liveAdmitted' = AUTHORS.mapBy(_ => -1), roomEpoch' = roomEpoch + 1, epochOf' = epochOf,
    backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }
  // Decision B: the creator admits, live, every vertex published so far (what its statement reports).
  action deliver: bool = all {
    liveAdmitted' = AUTHORS.mapBy(a => published.fold(liveAdmitted.get(a), (m, v) =>
      if (v._1 == a and v._2 > m and v._2 > admitted.get(a)) v._2 else m)),
    lineage' = lineage, custody' = custody, admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld, known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown,
    currentReissue' = currentReissue, current' = current, roomEpoch' = roomEpoch, epochOf' = epochOf,
    backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }

  // The "copy" store becomes a stale copy of the tabs database (profile copy),
  // or a fresh database beside a copied seed of one identity.
  action copyTabs: bool = all {
    lineage' = lineage.set("copy", lineage.get("tabs")),
    custody' = custody.set("copy", custody.get("tabs")),
    admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld.keys().mapBy(a => if (custody.get("tabs").contains(a)) everHeld.get(a).union(Set("copy")) else everHeld.get(a)),
    known' = known.set("copy", known.get("tabs")),
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
    // Decision B: a copied lineage reopens not current.
    current' = current.set("copy", false), liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch,
    epochOf' = epochOf.set("copy", epochOf.get("tabs")), backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }
  action freshSeed(a: str): bool = all {
    lineage' = lineage.set("copy", AUTHORS.mapBy(_ => 0)),
    custody' = custody.set("copy", Set(a)),
    admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld.setBy(a, held => held.union(Set("copy"))),
    known' = known.set("copy", AUTHORS.mapBy(_ => -1)),
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
    // As shipped: a lineage this open created starts current (it assumes a fresh key).
    current' = current.set("copy", true), liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch,
    epochOf' = epochOf.set("copy", 0), backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }

  // ---- Issuance-time layer ----
  // Guard: "everyIssue" (shipped: v3-live issueOneVertex refuses seq <= known
  // frontier for every local signature) or "reopenOnly" (before the guard: only
  // cold reopen checked the frontier; the install's settlement fence did not).
  // Guard "syncBeforeSending" (shipped, decision B): everyIssue, and only a current store signs.
  pure def signOk(guard: str, kind: str, sequence: int, knownFrontier: int, isCurrent: bool): bool =
    if (guard == "syncBeforeSending") isCurrent and sequence > knownFrontier
    else if (guard == "everyIssue") sequence > knownFrontier
    else if (kind == "fence") true
    else sequence > knownFrontier

  // One local signature by store st as author a, against what st knows.
  action signWith(guard: str, kind: str, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    lineage.get(st).get(a) < MAX_SEQUENCE,
    val sequence = lineage.get(st).get(a)
    all {
      not(retired.contains(st)),
      signOk(guard, kind, sequence, known.get(st).get(a), current.get(st)),
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      currentReissue' = (currentReissue or sequence <= roomFrontier(a)),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld, known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown,
    unchangedB,
  }
  // Install of the current successor: the store learns the authenticated
  // frontier, then the settlement issues one author fence for a.
  // (Decision B: the store adopts the room's current epoch and is current from then on.)
  // installRule "closed" (shipped): the install learns the closed frontier only. "live" (proposed,
  // not shipped): before the fence the store also checks the creator's statement for the epoch it
  // installs (the live frontier); at or below it, the fence is refused and the store stays
  // read-only (behind-frontier).
  action installWith(guard: str, st: str, a: str): bool = installRuleWith("closed", guard, st, a)
  action installRuleWith(installRule: str, guard: str, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    not(retired.contains(st)),
    epochOf.get(st) < roomEpoch,
    val learned = known.set(st, admitted)
    val sequence = lineage.get(st).get(a)
    val liveOk = installRule == "closed" or sequence > liveAdmitted.get(a)
    if (sequence < MAX_SEQUENCE and liveOk and signOk(guard, "fence", sequence, admitted.get(a), true)) all {
      known' = learned,
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      currentReissue' = (currentReissue or sequence <= roomFrontier(a)),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    } else all {
      // Fail closed: the generation is adopted, the fence is refused before signing.
      known' = learned, published' = published, reissued' = reissued, currentReissue' = currentReissue,
      lineage' = lineage,
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld,
    backupLineage' = backupLineage, backupKnown' = backupKnown,
    current' = current.set(st, installRule == "closed" or lineage.get(st).get(a) > liveAdmitted.get(a)),
    liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch,
    epochOf' = epochOf.set(st, roomEpoch), backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }
  // Decision B: the store confirms the creator's statement. "frontier" (shipped): it is at the
  // room's epoch and its lineage is above the author's live-admitted sequence; "noFrontier"
  // (mutant): the epoch alone.
  action confirmWith(rule: str, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    not(current.get(st)),
    epochOf.get(st) == roomEpoch,
    rule == "noFrontier" or lineage.get(st).get(a) > liveAdmitted.get(a),
    current' = current.set(st, true),
    lineage' = lineage, custody' = custody, admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld, known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown,
    currentReissue' = currentReissue, liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch, epochOf' = epochOf,
    backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }
  // Decision A: author a's lineage moves out of the shared database into its own ("filtered":
  // shipped, only a's rows; "whole": mutant, every author's rows). The shared database then only
  // reads. The migrated database reopens not current (decision B).
  action migrateWith(rule: str, a: str): bool = all {
    custody.get("tabs").contains(a) or retired.contains("tabs"),
    everHeld.get(a).contains("tabs"),
    custody.get(PLAYER_DB.get(a)) == Set(),
    val target = PLAYER_DB.get(a)
    val rows = if (rule == "filtered") AUTHORS.mapBy(other => if (other == a) lineage.get("tabs").get(a) else 0)
               else lineage.get("tabs")
    all {
      lineage' = lineage.set(target, rows),
      custody' = custody.set(target, Set(a)).setBy("tabs", held => held.exclude(Set(a))),
      known' = known.set(target, known.get("tabs")),
      everHeld' = everHeld.setBy(a, held => held.union(Set(target))),
      // New code never writes the shared database again: it only reads, for the next migration.
      current' = current.set(target, false).set("tabs", false),
      epochOf' = epochOf.set(target, epochOf.get("tabs")),
      retired' = retired.union(Set("tabs")),
    },
    admitted' = admitted, published' = published, reissued' = reissued,
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
    liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch, backupEpoch' = backupEpoch, backupFrom' = backupFrom,
  }
  action takeBackupOf(src: str): bool = all {
    backupLineage' = lineage.get(src), backupKnown' = known.get(src),
    backupEpoch' = epochOf.get(src), backupFrom' = src,
    lineage' = lineage, custody' = custody, admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld, known' = known, currentReissue' = currentReissue,
    current' = current, liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch, epochOf' = epochOf, retired' = retired,
  }
  action takeBackup: bool = takeBackupOf("tabs")
  // Another device restored from that backup (same keys, stale lineage and knowledge). It
  // reopened a lineage from storage, so it is not current (decision B).
  action restoreBackup: bool = all {
    lineage' = lineage.set("copy", backupLineage), known' = known.set("copy", backupKnown),
    custody' = custody.set("copy", custody.get(backupFrom)),
    everHeld' = everHeld.keys().mapBy(a => if (custody.get(backupFrom).contains(a)) everHeld.get(a).union(Set("copy")) else everHeld.get(a)),
    admitted' = admitted, published' = published, reissued' = reissued,
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
    current' = current.set("copy", false), epochOf' = epochOf.set("copy", backupEpoch),
    liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch, backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }
  // The restored device replaces the original: the original stops. Its vertices the creator has
  // admitted remain; those it had not delivered die with it (the crash). A vertex of the dead
  // device that is still in flight and reaches the creator after the restore became current is
  // the documented residual (inFlight = true; testInFlightResidual): no statement can name it.
  action restoreReplacing: bool = restoreReplacingWith(false)
  action restoreReplacingWith(inFlight: bool): bool = all {
    lineage' = lineage.set("copy", backupLineage), known' = known.set("copy", backupKnown),
    custody' = custody.set("copy", custody.get(backupFrom)).set(backupFrom, Set()),
    everHeld' = everHeld.keys().mapBy(a => if (custody.get(backupFrom).contains(a)) everHeld.get(a).union(Set("copy")) else everHeld.get(a)),
    admitted' = admitted, reissued' = reissued,
    published' = if (inFlight) published else published.filter(v => v._3 != backupFrom or v._2 <= roomFrontier(v._1)),
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
    current' = current.set("copy", false).set(backupFrom, false), epochOf' = epochOf.set("copy", backupEpoch),
    liveAdmitted' = liveAdmitted, roomEpoch' = roomEpoch, backupEpoch' = backupEpoch, backupFrom' = backupFrom, retired' = retired,
  }
  // Every issue source under one guard (the reopen rule stays "frontier").
  // (With decision B's state threaded through; the shared tabs layout, no confirmations.)
  action issuanceStepWith(guard: str): bool = issuanceStepRuleWith("closed", guard)
  action issuanceStepRuleWith(installRule: str, guard: str): bool = any {
    nondet st = STORES.oneOf()
    nondet a = AUTHORS.oneOf()
    nondet kind = Set("ordinary", "fence").oneOf()
    signWith(guard, kind, st, a),
    nondet st = STORES.oneOf()
    nondet a = AUTHORS.oneOf()
    installRuleWith(installRule, guard, st, a),
    deliver,
    issueWith("frontier", "tabs", "alice"),
    close,
    takeBackup,
    // The restored device replaces the original (decision B is about a reopened or cold-started
    // device). Two live devices holding one key and signing concurrently stay out of scope: no
    // guard on either device can see the other's unadmitted vertex (the creator close detects
    // the ambiguous slot).
    all { custody.get("copy") == Set(), restoreReplacing },
  }
  action issuanceStep = issuanceStepWith("syncBeforeSending")
  // Known gap of the shipped install (found by this model, 2026-10-28): the install proves the
  // closed frontier, not the open epoch's. A device restored from a backup taken before the
  // original signed in the epoch it installs re-signs those slots (its fence first).
  // The proposed live check closes it:
  action issuanceStepLiveInstall = issuanceStepRuleWith("live", "syncBeforeSending")
  action brokenReopenOnly = issuanceStepWith("reopenOnly")
  // Decision B, broken control: the frontier guard alone (8b857b4a), no currency gate.
  action brokenIssueBeforeCurrent = issuanceStepWith("everyIssue")
  // Never sign a slot the room has admitted (closed or live), frontier known or not. Before
  // decision B this held only for stores that knew the frontier; the restored device behind
  // every later close was the known gap.
  val noCurrentReissue = not(currentReissue)

  // ---- Decision A + B: per-player databases, sync before sending ----
  // Every player issues from its own database; backups, restores (replacing the original device),
  // the creator's live admission, closes, installs and statement confirmations interleave.
  action perPlayerStepWith(guard: str, confirm: str): bool = perPlayerStepRuleWith("closed", guard, confirm)
  action perPlayerStepRuleWith(installRule: str, guard: str, confirm: str): bool = any {
    nondet a = AUTHORS.oneOf()
    nondet kind = Set("ordinary", "fence").oneOf()
    nondet st = Set(PLAYER_DB.get(a), "copy").oneOf()
    signWith(guard, kind, st, a),
    nondet a = AUTHORS.oneOf()
    nondet st = Set(PLAYER_DB.get(a), "copy").oneOf()
    installRuleWith(installRule, guard, st, a),
    nondet a = AUTHORS.oneOf()
    nondet st = Set(PLAYER_DB.get(a), "copy").oneOf()
    confirmWith(confirm, st, a),
    deliver,
    close,
    nondet src = Set("aliceDb", "bobDb").oneOf()
    takeBackupOf(src),
    all { custody.get("copy") == Set(), restoreReplacing },
  }
  action perPlayerStep = perPlayerStepWith("syncBeforeSending", "frontier")
  action perPlayerStepLiveInstall = perPlayerStepRuleWith("live", "syncBeforeSending", "frontier")
  action brokenPerPlayerIssueBeforeCurrent = perPlayerStepRuleWith("live", "everyIssue", "frontier")
  action brokenConfirmWithoutFrontier = perPlayerStepRuleWith("live", "syncBeforeSending", "noFrontier")
  val perPlayerInv = noCurrentReissue and singleWriter
  // The migration out of the shared layout: both tabs write, then each migrates and carries on.
  action migrationStepWith(rule: str): bool = any {
    nondet a = AUTHORS.oneOf()
    all { not(retired.contains("tabs")), signWith("syncBeforeSending", "ordinary", "tabs", a) },
    nondet a = AUTHORS.oneOf()
    migrateWith(rule, a),
    nondet a = AUTHORS.oneOf()
    nondet kind = Set("ordinary", "fence").oneOf()
    signWith("syncBeforeSending", kind, PLAYER_DB.get(a), a),
    nondet a = AUTHORS.oneOf()
    installWith("syncBeforeSending", PLAYER_DB.get(a), a),
    nondet a = AUTHORS.oneOf()
    confirmWith("frontier", PLAYER_DB.get(a), a),
    deliver,
    close,
  }
  action migrationStep = migrationStepWith("filtered")
  action brokenWholeCopyMigration = migrationStepWith("whole")
  // The shared layout violates singleWriter from its first state; after the migrations the
  // per-player databases each have one writer and the shared one only reads.
  val playerDbSingleWriter = PLAYER_DB.keys().forall(a => writersOf(PLAYER_DB.get(a)).size() <= 1)
  val migrationInv = noCurrentReissue and playerDbSingleWriter

  action stepWith(rule: Rule): bool = any {
    nondet st = STORES.oneOf()
    nondet a = AUTHORS.oneOf()
    issueWith(rule, st, a),
    close,
    copyTabs,
    nondet a = AUTHORS.oneOf()
    freshSeed(a),
  }
  action step = stepWith("frontier")
  action brokenNoCheck = stepWith("noCheck")
  action brokenOldRule = stepWith("oldRule")

  // ---- Deterministic scenarios ----
  // Both tabs issue and a close admits them; the shared database reopens as
  // either identity under the shipped rule.
  run testMultiTabFrontierLive =
    init.then(issueWith("frontier", "tabs", "alice")).then(issueWith("frontier", "tabs", "bob")).then(close)
      .then(issueWith("frontier", "tabs", "bob")).then(issueWith("frontier", "tabs", "alice"))
      .expect(inv and admitted.get("bob") == 0 and lineage.get("tabs").get("bob") == 2)
  // Broken control: the old D.108d1b rule refuses Bob's legitimate shared database.
  run testMultiTabOldRuleRefuses =
    init.then(issueWith("oldRule", "tabs", "alice")).then(close)
      .expect(not(reopenOk("oldRule", lineage, admitted, "tabs", "bob")) and not(soleCustodianLiveWith("oldRule")))
  // A fresh database beside Bob's copied seed, after the room admitted Bob 0:
  // the shipped rule refuses it.
  run testStaleCloneFrontierRefuses =
    init.then(issueWith("frontier", "tabs", "bob")).then(close).then(freshSeed("bob"))
      .expect(not(reopenOk("frontier", lineage, admitted, "copy", "bob")) and inv)
  // Broken control: without the check the clone issues Bob 0 again.
  run testStaleCloneNoCheckReissues =
    init.then(issueWith("frontier", "tabs", "bob")).then(close).then(freshSeed("bob"))
      .then(issueWith("noCheck", "copy", "bob"))
      .expect(reissued)
  // A stale profile copy behind the frontier is refused for every identity it
  // is behind on, and accepted for one the room has not advanced.
  run testStaleProfileCopy =
    init.then(issueWith("frontier", "tabs", "alice")).then(copyTabs)
      .then(issueWith("frontier", "tabs", "alice")).then(close)
      .expect(not(reopenOk("frontier", lineage, admitted, "copy", "alice")) and
        reopenOk("frontier", lineage, admitted, "copy", "bob") and inv)

  // ---- Issuance layer scenarios (backup restore, D.108d1b extended) ----
  // Device A (tabs) issues Bob 0, a close admits it; device B restored from the
  // pre-issue backup installs: the guarded fence refuses, nothing is re-signed.
  run testRestoreInstallGuardRefuses =
    init.then(takeBackup).then(signWith("everyIssue", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(installWith("everyIssue", "copy", "bob"))
      .expect(not(reissued) and known.get("copy").get("bob") == 0 and lineage.get("copy").get("bob") == 0)
  // ... and ordinary work on the installed device is refused too.
  run testRestoreInstalledOrdinaryRefused =
    init.then(takeBackup).then(signWith("everyIssue", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(installWith("everyIssue", "copy", "bob"))
      .then(signWith("everyIssue", "ordinary", "copy", "bob")).fail()
  // Broken control (before the guard): the install's fence re-signs Bob 0.
  run testRestoreInstallReopenOnlyReissues =
    init.then(takeBackup).then(signWith("everyIssue", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(installWith("reopenOnly", "copy", "bob"))
      .expect(currentReissue)
  // The former known gap, closed by decision B: before it learns any later close the restored
  // device is not current, so it cannot sign at all.
  run testRestoreBeforeInstallNotCurrent =
    init.then(takeBackup).then(signWith("syncBeforeSending", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(signWith("syncBeforeSending", "ordinary", "copy", "bob")).fail()
  // Broken control: issuing before current (the frontier guard alone) re-signs Bob 0.
  run testRestoreIssueBeforeCurrentReissues =
    init.then(takeBackup).then(signWith("everyIssue", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(signWith("everyIssue", "ordinary", "copy", "bob"))
      .expect(reissued and currentReissue and not(noCurrentReissue))
  // ... and once it installed the current successor it is current, and the guard holds.
  run testRestoreInstallThenCurrent =
    init.then(takeBackup).then(signWith("syncBeforeSending", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(installWith("syncBeforeSending", "copy", "bob"))
      .expect(current.get("copy") and noCurrentReissue)

  // ---- Decision B, same epoch: the statement's live frontier ----
  // Bob's device signs Bob 0, the creator admits it live; a device restored from the pre-issue
  // backup at the same epoch cannot confirm the statement, so it stays read-only.
  run testSameEpochRestoreCannotConfirm =
    initPerPlayer.then(takeBackupOf("bobDb")).then(signWith("syncBeforeSending", "ordinary", "bobDb", "bob"))
      .then(deliver).then(restoreReplacing).then(confirmWith("frontier", "copy", "bob")).fail()
  // Broken control: confirming on the epoch alone lets it re-sign Bob 0.
  run testSameEpochNoFrontierReissues =
    initPerPlayer.then(takeBackupOf("bobDb")).then(signWith("syncBeforeSending", "ordinary", "bobDb", "bob"))
      .then(deliver).then(restoreReplacing).then(confirmWith("noFrontier", "copy", "bob"))
      .then(signWith("syncBeforeSending", "ordinary", "copy", "bob"))
      .expect(not(noCurrentReissue))
  // A reopened database at the room's epoch with nothing admitted above it confirms and issues.
  run testReopenConfirmsAndIssues =
    initPerPlayer.then(signWith("syncBeforeSending", "ordinary", "bobDb", "bob")).then(deliver)
      .then(takeBackupOf("bobDb")).then(restoreReplacing).then(confirmWith("frontier", "copy", "bob"))
      .then(signWith("syncBeforeSending", "ordinary", "copy", "bob"))
      .expect(perPlayerInv and lineage.get("copy").get("bob") == 2)
  // Known gap of the shipped install: Bob's device installs epoch 1 (fence Bob 0, admitted live);
  // a device restored from the epoch-0 backup replaces it and installs epoch 1 too: its fence
  // re-signs Bob 0. With the proposed live check the restored device stays read-only.
  run testRestoreInstallReissuesLiveSlotKnownGap =
    initPerPlayer.then(takeBackupOf("bobDb")).then(close).then(installWith("syncBeforeSending", "bobDb", "bob"))
      .then(deliver).then(restoreReplacing).then(installWith("syncBeforeSending", "copy", "bob"))
      .expect(not(noCurrentReissue))
  run testRestoreLiveInstallRefuses =
    initPerPlayer.then(takeBackupOf("bobDb")).then(close).then(installWith("syncBeforeSending", "bobDb", "bob"))
      .then(deliver).then(restoreReplacing).then(installRuleWith("live", "syncBeforeSending", "copy", "bob"))
      .expect(noCurrentReissue and not(current.get("copy")) and epochOf.get("copy") == 1)
  // Residual: Bob 0 is still in flight from the dead device when the restored one confirms; the
  // creator then admits it and the restored device re-signs that slot.
  run testInFlightResidual =
    initPerPlayer.then(takeBackupOf("bobDb")).then(signWith("syncBeforeSending", "ordinary", "bobDb", "bob"))
      .then(restoreReplacingWith(true)).then(confirmWith("frontier", "copy", "bob")).then(deliver)
      .then(signWith("syncBeforeSending", "ordinary", "copy", "bob"))
      .expect(not(noCurrentReissue))
  // Residual, as shipped: a fresh lineage beside a key that already signed starts current.
  run testFreshSeedResidual =
    init.then(signWith("syncBeforeSending", "ordinary", "tabs", "bob")).then(close).then(freshSeed("bob"))
      .then(signWith("syncBeforeSending", "ordinary", "copy", "bob"))
      .expect(not(noCurrentReissue))

  // ---- Decision A: one writing author per database ----
  // Broken control: the shared layout has two writers in one database.
  run testSharedLayoutTwoWriters =
    init.then(signWith("syncBeforeSending", "ordinary", "tabs", "alice")).then(signWith("syncBeforeSending", "ordinary", "tabs", "bob"))
      .expect(not(singleWriter))
  // The migration moves each author's own lineage, continuous, into its own database.
  run testMigrationFiltered =
    init.then(signWith("syncBeforeSending", "ordinary", "tabs", "alice")).then(signWith("syncBeforeSending", "ordinary", "tabs", "bob"))
      .then(close).then(migrateWith("filtered", "alice")).then(migrateWith("filtered", "bob"))
      .then(installWith("syncBeforeSending", "aliceDb", "alice")).then(installWith("syncBeforeSending", "bobDb", "bob"))
      .then(signWith("syncBeforeSending", "ordinary", "aliceDb", "alice"))
      .expect(singleWriter and noCurrentReissue and lineage.get("aliceDb").get("alice") == 3
        and lineage.get("aliceDb").get("bob") == 0 and lineage.get("bobDb").get("bob") == 2)
  // ... a migrated database is not current until it installs or confirms.
  run testMigratedNotCurrent =
    init.then(signWith("syncBeforeSending", "ordinary", "tabs", "alice")).then(migrateWith("filtered", "alice"))
      .then(signWith("syncBeforeSending", "ordinary", "aliceDb", "alice")).fail()
  // Broken control: the whole copy puts Bob's rows in Alice's database.
  run testMigrationWholeCopyTwoWriters =
    init.then(signWith("syncBeforeSending", "ordinary", "tabs", "alice")).then(signWith("syncBeforeSending", "ordinary", "tabs", "bob"))
      .then(migrateWith("whole", "alice"))
      .expect(not(singleWriter))
}
