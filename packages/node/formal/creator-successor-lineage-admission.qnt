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

  // One origin, two tabs: Alice (slot 0) and Bob (slot 1) share the "tabs"
  // database. The "copy" store starts empty and keyless.
  action init = all {
    lineage' = STORES.mapBy(_ => AUTHORS.mapBy(_ => 0)),
    custody' = Map("tabs" -> AUTHORS, "copy" -> Set()),
    admitted' = AUTHORS.mapBy(_ => -1),
    published' = Set(),
    reissued' = false,
    everHeld' = AUTHORS.mapBy(_ => Set("tabs")),
  }

  action issueWith(rule: Rule, st: str, a: str): bool = all {
    custody.get(st).contains(a),
    lineage.get(st).get(a) < MAX_SEQUENCE,
    reopenOk(rule, lineage, admitted, st, a),
    val sequence = lineage.get(st).get(a)
    all {
      published' = published.union(Set((a, sequence, st))),
      reissued' = (reissued or sequence <= admitted.get(a)),
      lineage' = lineage.setBy(st, row => row.setBy(a, n => n + 1)),
    },
    custody' = custody, admitted' = admitted, everHeld' = everHeld,
  }

  // A close admits, per author, the highest published sequence.
  action close: bool = all {
    admitted' = AUTHORS.mapBy(a => published.fold(admitted.get(a), (m, v) =>
      if (v._1 == a and v._2 > m) v._2 else m)),
    lineage' = lineage, custody' = custody, published' = published, reissued' = reissued, everHeld' = everHeld,
  }

  // The "copy" store becomes a stale copy of the tabs database (profile copy),
  // or a fresh database beside a copied seed of one identity.
  action copyTabs: bool = all {
    lineage' = lineage.set("copy", lineage.get("tabs")),
    custody' = custody.set("copy", custody.get("tabs")),
    admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld.keys().mapBy(a => if (custody.get("tabs").contains(a)) everHeld.get(a).union(Set("copy")) else everHeld.get(a)),
  }
  action freshSeed(a: str): bool = all {
    lineage' = lineage.set("copy", AUTHORS.mapBy(_ => 0)),
    custody' = custody.set("copy", Set(a)),
    admitted' = admitted, published' = published, reissued' = reissued,
    everHeld' = everHeld.setBy(a, held => held.union(Set("copy"))),
  }

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
}
