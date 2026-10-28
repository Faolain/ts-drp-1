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
module creatorSuccessorLineageAdmission {
  pure val AUTHORS = Set("alice", "bob")
  pure val STORES = Set("tabs", "copy")
  pure val MAX_SEQUENCE = 3

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
  var currentReissue: bool           // history: an admitted slot re-signed by a store that KNEW the frontier

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
  val issuanceInv = soleCustodianLive  // plus noCurrentReissue (declared with the issuance layer)

  // One origin, two tabs: Alice (slot 0) and Bob (slot 1) share the "tabs"
  // database. The "copy" store starts empty and keyless.
  action init = all {
    lineage' = STORES.mapBy(_ => AUTHORS.mapBy(_ => 0)),
    custody' = Map("tabs" -> AUTHORS, "copy" -> Set()),
    admitted' = AUTHORS.mapBy(_ => -1),
    published' = Set(),
    reissued' = false,
    everHeld' = AUTHORS.mapBy(_ => Set("tabs")),
    known' = STORES.mapBy(_ => AUTHORS.mapBy(_ => -1)),
    backupLineage' = AUTHORS.mapBy(_ => 0),
    backupKnown' = AUTHORS.mapBy(_ => -1),
    currentReissue' = false,
  }

  action issueWith(rule: Rule, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    lineage.get(st).get(a) < MAX_SEQUENCE,
    reopenOk(rule, lineage, admitted, st, a),
    val sequence = lineage.get(st).get(a)
    all {
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      currentReissue' = (currentReissue or sequence <= admitted.get(a)),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld, known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown,
  }

  // A close admits, per author, the highest published sequence.
  action close: bool = all {
    admitted' = AUTHORS.mapBy(a => published.fold(admitted.get(a), (m, v) =>
      if (v._1 == a and v._2 > m) v._2 else m)),
    lineage' = lineage, custody' = custody, published' = published, reissued' = reissued, everHeld' = everHeld,
    known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
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
  }
  action freshSeed(a: str): bool = all {
    lineage' = lineage.set("copy", AUTHORS.mapBy(_ => 0)),
    custody' = custody.set("copy", Set(a)),
    admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld.setBy(a, held => held.union(Set("copy"))),
    known' = known.set("copy", AUTHORS.mapBy(_ => -1)),
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
  }

  // ---- Issuance-time layer ----
  // Guard: "everyIssue" (shipped: v3-live issueOneVertex refuses seq <= known
  // frontier for every local signature) or "reopenOnly" (before the guard: only
  // cold reopen checked the frontier; the install's settlement fence did not).
  pure def signOk(guard: str, kind: str, sequence: int, knownFrontier: int): bool =
    if (guard == "everyIssue") sequence > knownFrontier
    else if (kind == "fence") true
    else sequence > knownFrontier

  // One local signature by store st as author a, against what st knows.
  action signWith(guard: str, kind: str, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    lineage.get(st).get(a) < MAX_SEQUENCE,
    val sequence = lineage.get(st).get(a)
    all {
      signOk(guard, kind, sequence, known.get(st).get(a)),
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      currentReissue' = (currentReissue or (sequence <= admitted.get(a) and known.get(st).get(a) == admitted.get(a))),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld, known' = known, backupLineage' = backupLineage, backupKnown' = backupKnown,
  }
  // Install of the current successor: the store learns the authenticated
  // frontier, then the settlement issues one author fence for a.
  action installWith(guard: str, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    val learned = known.set(st, admitted)
    val sequence = lineage.get(st).get(a)
    if (sequence < MAX_SEQUENCE and signOk(guard, "fence", sequence, admitted.get(a))) all {
      known' = learned,
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      currentReissue' = (currentReissue or sequence <= admitted.get(a)),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    } else all {
      // Fail closed: the generation is adopted, the fence is refused before signing.
      known' = learned, published' = published, reissued' = reissued, currentReissue' = currentReissue,
      lineage' = lineage,
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld,
    backupLineage' = backupLineage, backupKnown' = backupKnown,
  }
  action takeBackup: bool = all {
    backupLineage' = lineage.get("tabs"), backupKnown' = known.get("tabs"),
    lineage' = lineage, custody' = custody, admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld, known' = known, currentReissue' = currentReissue,
  }
  // Another device restored from that backup (same keys, stale lineage and knowledge).
  action restoreBackup: bool = all {
    lineage' = lineage.set("copy", backupLineage), known' = known.set("copy", backupKnown),
    custody' = custody.set("copy", custody.get("tabs")),
    everHeld' = everHeld.keys().mapBy(a => if (custody.get("tabs").contains(a)) everHeld.get(a).union(Set("copy")) else everHeld.get(a)),
    admitted' = admitted, published' = published, reissued' = reissued,
    backupLineage' = backupLineage, backupKnown' = backupKnown, currentReissue' = currentReissue,
  }
  // Every issue source under one guard (the reopen rule stays "frontier").
  action issuanceStepWith(guard: str): bool = any {
    nondet st = STORES.oneOf()
    nondet a = AUTHORS.oneOf()
    nondet kind = Set("ordinary", "fence").oneOf()
    signWith(guard, kind, st, a),
    nondet st = STORES.oneOf()
    nondet a = AUTHORS.oneOf()
    installWith(guard, st, a),
    issueWith("frontier", "tabs", "alice"),
    close,
    takeBackup,
    restoreBackup,
  }
  action issuanceStep = issuanceStepWith("everyIssue")
  action brokenReopenOnly = issuanceStepWith("reopenOnly")
  // Never re-sign an admitted slot with the frontier known; the known gap (a
  // device behind every later close) re-signs only at a closed, inadmissible epoch.
  val noCurrentReissue = not(currentReissue)

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
  // Known gap: before it learns any later close, the restored device re-signs at
  // its stale epoch (reissued, but not with the frontier known).
  run testRestoreBeforeInstallKnownGap =
    init.then(takeBackup).then(signWith("everyIssue", "ordinary", "tabs", "bob")).then(close)
      .then(restoreBackup).then(signWith("everyIssue", "ordinary", "copy", "bob"))
      .expect(reissued and not(currentReissue))
}
