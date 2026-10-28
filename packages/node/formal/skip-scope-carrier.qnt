// A member's live-journal scopes across skip installs (fix/skip-scope-carrier). Sibling of
// settlement-window.qnt (protected scopes of a silent Writer) and slow-member-follow.qnt (why a
// slow member skips: it installs the newest successor it knows of).
//
// Facts the model takes from the code:
//   - Each epoch the member enters is one journal scope. An install from epoch m closes scope m and
//     opens scope t (the target).
//   - A closed scope holds the creator's received rows; it becomes collectible only once the
//     member has recorded that scope's closed membership with its Cut and the Cut's authority
//     (QC and successor trust): creator-adoption recordReceivedClosedMembership, then the
//     retirement re-verifies it (verifyReceivedClosedJournalAuthority) on every classification.
//   - An adjacent install (t = m + 1) records it from the offer itself (the offer's Cut closes m).
//     A skip install's offer carries the Cut before its target (closes t - 1), not m.
//   - The journal retirement retires an oldest-first prefix of collectible closed scopes, and
//     refuses once more than MAX_SCOPES scopes are protected ("journal retirement refused:
//     malformed-input", LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes = AHE maxObjectGenerations = 7);
//     the session then closes.
//
// FIXED: a skip install also fetches the departed scope's carrier (Cut_m, QC_m, trust_{m+1} and
// closed membership_m) from the creator; the member authenticates Cut/QC/trust against its own
// current trust exactly as an adjacent offer (openCreatorSuccessorTrust), and records it through
// the same path. A carrier that does not authenticate for scope m is dropped (the scope keeps
// today's retention: never wrongly collectible).
// Broken controls:
//   "none"   no carrier (the code before): a skip leaves scope m closed for good;
//   "unauth" the member records whatever carrier arrives, without authenticating it for m: a
//            carrier for another epoch, or one whose Cut is not m's, marks m collectible.
// Assumption C (the residual requirement): the creator still holds the departed scope's carrier
// when the member asks (it keeps the carriers of its last CREATOR_DEPARTED_CARRIERS_RETAINED closed
// epochs in memory; a member that departs an older epoch, or asks a creator that restarted since,
// gets none and that one scope keeps today's retention). Under FIXED the creator's answer is
// therefore authentic; the broken controls see any answer.
module skipScopeCarrier {
  pure val MAX_E = 16
  pure val MAX_SCOPES = 7
  pure val EPOCHS = 0.to(MAX_E)

  var mode: str                       // fixed | none | unauth
  var creator: int                    // creator epoch
  var member: int                     // member epoch (its live scope)
  var scope: int -> str               // absent | live | closed | collectible | retired
  var authentic: Set[int]             // scopes whose recorded membership authenticated for that scope
  var refused: bool                   // the journal retirement refused (session closed)
  var last: str

  def protectedCount: int = EPOCHS.filter(e => scope.get(e) == "live" or scope.get(e) == "closed" or scope.get(e) == "collectible").size()

  action initWith(m: str): bool = all {
    mode' = m, creator' = 0, member' = 0, scope' = EPOCHS.mapBy(e => if (e == 0) "live" else "absent"),
    authentic' = Set(), refused' = false, last' = "init",
  }
  action init = initWith("fixed")
  action initNone = initWith("none")
  action initUnauth = initWith("unauth")

  action creatorRoll = all {
    creator < MAX_E, creator' = creator + 1, last' = "roll",
    mode' = mode, member' = member, scope' = scope, authentic' = authentic, refused' = refused,
  }

  // The retirement pass: retires the oldest-first prefix of collectible closed scopes.
  def retirePrefix(s: int -> str): int -> str =
    range(0, MAX_E + 1).foldl((s, false), (acc, e) =>
      if (acc._2) acc
      else if (acc._1.get(e) == "collectible") (acc._1.set(e, "retired"), false)
      else if (acc._1.get(e) == "absent" or acc._1.get(e) == "retired") acc
      else (acc._1, true))._1
  def protectedIn(s: int -> str): int = EPOCHS.filter(e => s.get(e) == "live" or s.get(e) == "closed" or s.get(e) == "collectible").size()

  // The member's install to target t (adjacent or skip). `carrier`: what the skip fetched for the
  // departed scope: "authentic", "mismatched" or "missing". The install's own retirement pass runs
  // first (on the scopes before this install) and refuses past the bound.
  action install(t: int, carrier: str): bool = all {
    not(refused), t > member, t <= creator, t - member <= 3,
    mode != "fixed" or carrier == "authentic",
    val departed = member
    val adjacent = t == departed + 1
    val records = adjacent or (mode == "fixed" and carrier == "authentic") or (mode == "unauth" and carrier != "missing")
    val authenticRecord = adjacent or (carrier == "authentic" and mode != "none")
    val pruned = retirePrefix(scope)
    val after = pruned.set(departed, if (records) "collectible" else "closed").set(t, "live")
    all {
      if (protectedIn(after) > MAX_SCOPES) all { refused' = true, scope' = pruned, member' = member, authentic' = authentic, last' = "refused" }
      else all {
        refused' = false, scope' = after, member' = t,
        authentic' = if (records and authenticRecord) authentic.union(Set(departed)) else authentic,
        last' = if (adjacent) "adjacent" else "skip",
      },
      mode' = mode, creator' = creator,
    }
  }
  // The retirement retires the oldest collectible closed scope when every older one is retired.
  action retire(e: int): bool = all {
    not(refused), scope.get(e) == "collectible", EPOCHS.forall(o => o >= e or scope.get(o) == "absent" or scope.get(o) == "retired"),
    scope' = scope.set(e, "retired"), last' = "retire",
    mode' = mode, creator' = creator, member' = member, authentic' = authentic, refused' = refused,
  }

  action memberStep = any {
    nondet t = EPOCHS.oneOf()
    nondet c = Set("authentic", "mismatched", "missing").oneOf()
    install(t, c),
    nondet e = EPOCHS.oneOf()
    retire(e),
  }
  action step = any { creatorRoll, memberStep }

  // Safety: a scope is collectible or retired only on an authentic record for that very scope.
  val neverWronglyCollectible = EPOCHS.forall(e => (scope.get(e) == "collectible" or scope.get(e) == "retired") implies authentic.contains(e))
  // The bound: the member never reaches the refusal.
  val scopesBounded = not(refused) and protectedCount <= MAX_SCOPES
  val safety = neverWronglyCollectible and scopesBounded

  val vars = (mode, creator, member, scope, authentic, refused, last)
  // Liveness: every scope the member departed from is eventually retired (under weak fairness of
  // the member's retirement passes; installs and the creator are unconstrained).
  temporal departedCollected =
    EPOCHS.forall(e => weakFair(retire(e), vars))
      implies EPOCHS.forall(e => always((scope.get(e) == "closed" or scope.get(e) == "collectible") implies eventually(scope.get(e) == "retired")))

  // Witnesses.
  action rolls(n: int): bool = n.reps(_ => creatorRoll)
  // Today: skips of two epochs each; the seventh install's retirement refuses.
  run noneLeaksTest = initNone.then(rolls(16))
    .then(install(2, "missing")).then(install(4, "missing")).then(install(6, "missing")).then(install(8, "missing"))
    .then(install(10, "missing")).then(install(12, "missing")).then(all { assert(protectedCount == 7 and not(refused)), install(14, "missing") })
    .then(all { assert(refused), creatorRoll.fail() })
  // FIXED: eight skips stay within the bound; each install's pass retires the scope before.
  run fixedBoundedTest = init.then(rolls(16))
    .then(install(2, "authentic")).then(install(4, "authentic")).then(install(6, "authentic")).then(install(8, "authentic"))
    .then(install(10, "authentic")).then(install(12, "authentic")).then(install(14, "authentic")).then(install(16, "authentic"))
    .then(all { assert(safety and protectedCount == 2 and member == 16), retire(14) })
    .then(all { assert(protectedCount == 1), creatorRoll.fail() })
  // "unauth": a mismatched carrier marks the departed scope collectible without authority.
  run unauthWrongTest = initUnauth.then(rolls(4)).then(install(2, "mismatched"))
    .then(all { assert(scope.get(0) == "collectible" and not(neverWronglyCollectible)), retire(0) })
}

// The installer's coverage rule (fix/skip-scope-chain-invalid). The retirement is two checks over
// one journal image:
//   - the classifier (classifyClosedJournalDetails) selects a closed received scope as a
//     collectible prefix once nothing holds it (the member's own unresolved work, here `held`)
//     and it is authenticated: by a recovery trust, or, outside the retained trust window, by its
//     own signed header with its kept closed authority, reopened against the pinned genesis
//     (fd342d90; `recorded` here: the carrier or the adjacent offer recorded it authentically);
//   - the installer (installClosedRetirementSource) re-checks every selected prefix itself and
//     refuses the whole pass "chain-invalid" (the member's recovery turnover fails, its session
//     closes) on a prefix it does not find covered.
// The recovery trusts are the successor trusts the member's store retains: genesis and its last
// TRUST_WINDOW installs (AHE keeps 7 generations: genesis and about six installs; 3 here).
// Rules:
//   "fixed"      the installer covers a prefix by a recovery trust, or by re-verifying the scope's
//                own header itself (closedJournalHeaderAuthenticates); never by the classifier's word.
//   "mismatch"   (the code before) the installer covers by recovery trusts only, while the
//                classifier also accepts the header: an honest pass is refused chain-invalid.
//   "strict"     both sides recovery trusts only: a scope held past the window is never
//                collectible again (its trust never returns), so it is protected for good.
//   "unverified" (broken control) the installer accepts whatever prefix it is handed.
// `stale(e)` is the adversary's (or a stale classification's) prefix for a scope that is not
// authenticated; `corrupt(e)` replaces a scope's kept record by bytes that do not re-verify.
module skipScopeInstallerCoverage {
  pure val MAX_E = 8
  pure val MAX_SCOPES = 7
  pure val TRUST_WINDOW = 3
  pure val EPOCHS = 0.to(MAX_E)

  var rule: str
  var creator: int
  var member: int
  var scope: int -> str               // absent | live | closed | retired
  var entered: Set[int]               // epochs the member installed into (genesis included)
  var recorded: Set[int]              // scopes whose kept closed authority re-verifies
  var held: Set[int]                  // scopes held by the member's own unresolved work
  var chainInvalid: bool              // the installer refused a pass (session closed)
  var journalRefused: bool            // more than MAX_SCOPES protected (session closed)
  var dishonest: bool                 // a stale or forged prefix was presented
  var retiredWrong: bool              // a scope was retired without authentication

  def trusts: Set[int] = Set(0).union(entered.filter(x => entered.filter(y => y > x).size() < TRUST_WINDOW))
  def authenticated(a: int): bool = trusts.contains(a) or recorded.contains(a)
  def classifierSelects(c: int): bool =
    scope.get(c) == "closed" and not(held.contains(c)) and
    (trusts.contains(c) or (rule != "strict" and recorded.contains(c)))
  def installerCovers(v: int): bool =
    if (rule == "unverified") true
    else if (rule == "fixed") trusts.contains(v) or recorded.contains(v)
    else trusts.contains(v)
  def protectedCount: int = EPOCHS.filter(e => scope.get(e) == "live" or scope.get(e) == "closed").size()
  def alive: bool = not(chainInvalid) and not(journalRefused)

  action initWith(r: str): bool = all {
    rule' = r, creator' = 0, member' = 0, scope' = EPOCHS.mapBy(e => if (e == 0) "live" else "absent"),
    entered' = Set(0), recorded' = Set(), held' = Set(), chainInvalid' = false, journalRefused' = false,
    dishonest' = false, retiredWrong' = false,
  }
  action init = initWith("fixed")
  action initMismatch = initWith("mismatch")
  action initStrict = initWith("strict")
  action initUnverified = initWith("unverified")

  action creatorRoll = all {
    creator < MAX_E, creator' = creator + 1,
    rule' = rule, member' = member, scope' = scope, entered' = entered, recorded' = recorded, held' = held,
    chainInvalid' = chainInvalid, journalRefused' = journalRefused, dishonest' = dishonest, retiredWrong' = retiredWrong,
  }

  // One retirement pass over `prefixes`: the installer refuses the whole pass on any prefix it
  // does not cover, else retires them all. `presented`: the prefixes are not the classifier's.
  action pass(prefixes: Set[int], presented: bool): bool = all {
    alive, prefixes.size() > 0,
    val refused = prefixes.exists(p => not(installerCovers(p)))
    all {
      chainInvalid' = refused,
      scope' = if (refused) scope else EPOCHS.mapBy(m => if (prefixes.contains(m)) "retired" else scope.get(m)),
      retiredWrong' = (retiredWrong or (not(refused) and prefixes.exists(u => not(authenticated(u))))),
      dishonest' = (dishonest or presented),
      rule' = rule, creator' = creator, member' = member, entered' = entered, recorded' = recorded, held' = held,
      journalRefused' = journalRefused,
    }
  }
  // The honest pass: exactly the classifier's selection.
  action retirePass = pass(EPOCHS.filter(h => classifierSelects(h)), false)
  // A prefix for a closed scope that the classifier would not select.
  action stale(target: int): bool = all { scope.get(target) == "closed", not(classifierSelects(target)), pass(Set(target), true) }

  // The member installs target t (adjacent or a skip of two); the departed scope's closed
  // authority is recorded (the offer, or the departed carrier), and `hold` says whether the
  // member's own unresolved work holds it (one such scope at a time). Each install's recovery
  // turnover runs the retirement pass first, so nothing the classifier selects is still pending.
  // The journal refuses past the bound.
  action install(t: int, hold: bool): bool = all {
    alive, t > member, t <= creator, t - member <= 2, not(hold) or held.size() == 0,
    EPOCHS.forall(c => not(classifierSelects(c))),
    val departed = member
    val after = scope.set(departed, "closed").set(t, "live")
    val count = EPOCHS.filter(e => after.get(e) == "live" or after.get(e) == "closed").size()
    all {
      member' = t, scope' = after, entered' = entered.union(Set(t)),
      recorded' = recorded.union(Set(departed)),
      held' = if (hold) held.union(Set(departed)) else held,
      journalRefused' = count > MAX_SCOPES,
    },
    rule' = rule, creator' = creator, chainInvalid' = chainInvalid, dishonest' = dishonest, retiredWrong' = retiredWrong,
  }
  // The member's own work resolves (it lands, expires, or is abandoned).
  action release(e: int): bool = all {
    held.contains(e), held' = held.exclude(Set(e)),
    rule' = rule, creator' = creator, member' = member, scope' = scope, entered' = entered, recorded' = recorded,
    chainInvalid' = chainInvalid, journalRefused' = journalRefused, dishonest' = dishonest, retiredWrong' = retiredWrong,
  }
  // Storage corruption: a scope's kept record no longer re-verifies.
  action corrupt(e: int): bool = all {
    recorded.contains(e), recorded' = recorded.exclude(Set(e)),
    rule' = rule, creator' = creator, member' = member, scope' = scope, entered' = entered, held' = held,
    chainInvalid' = chainInvalid, journalRefused' = journalRefused, dishonest' = dishonest, retiredWrong' = retiredWrong,
  }

  action honestStep = any {
    creatorRoll,
    nondet t = EPOCHS.oneOf()
    nondet h = Set(true, false).oneOf()
    install(t, h),
    retirePass,
    nondet e = EPOCHS.oneOf()
    release(e),
  }
  action step = any {
    honestStep,
    nondet e = EPOCHS.oneOf()
    stale(e),
    nondet e = EPOCHS.oneOf()
    corrupt(e),
  }

  // Safety: nothing is retired without authentication (a recovery trust or a re-verified record),
  // whatever prefix the installer is handed.
  val neverWronglyRetired = not(retiredWrong)
  // An honest pass is never refused: chain-invalid only answers a stale or forged prefix.
  val honestNeverRefused = chainInvalid implies dishonest
  val scopesBounded = not(journalRefused)
  val safety = neverWronglyRetired and honestNeverRefused and scopesBounded

  val vars = (rule, creator, member, scope, entered, recorded, held, chainInvalid, journalRefused, dishonest, retiredWrong)
  // Liveness (honest runs): every closed scope is eventually retired, under weak fairness of the
  // retirement pass and of each hold's resolution (installs and the creator are unconstrained).
  temporal departedCollected =
    (weakFair(retirePass, vars) and EPOCHS.forall(e => weakFair(release(e), vars)))
      implies EPOCHS.forall(e => always(scope.get(e) == "closed" implies eventually(scope.get(e) == "retired")))

  // Witnesses: scope 1 held while the member installs past the trust window, then released.
  action rolls(n: int): bool = n.reps(_ => creatorRoll)
  action heldPastWindowStart = rolls(6).then(install(1, false)).then(retirePass).then(install(2, true))
    .then(install(3, false)).then(retirePass).then(install(4, false)).then(retirePass)
    .then(install(5, false)).then(retirePass).then(install(6, false)).then(retirePass)
  action heldPastWindow = heldPastWindowStart
    .then(all { assert(not(trusts.contains(1)) and recorded.contains(1)), release(1) })
  run fixedRetiresTest = init.then(heldPastWindow)
    .then(all { assert(classifierSelects(1)), retirePass })
    .then(all { assert(scope.get(1) == "retired" and safety), creatorRoll })
  run mismatchRefusesTest = initMismatch.then(heldPastWindow)
    .then(all { assert(classifierSelects(1)), retirePass })
    .then(all { assert(chainInvalid and not(honestNeverRefused)), retirePass.fail() })
  run strictStuckTest = initStrict.then(heldPastWindow)
    .then(all { assert(not(classifierSelects(1)) and scope.get(1) == "closed"), creatorRoll })
  run unverifiedWrongTest = initUnverified.then(heldPastWindowStart)
    .then(corrupt(1)).then(stale(1))
    .then(all { assert(scope.get(1) == "retired" and not(neverWronglyRetired)), creatorRoll })
  run fixedRefusesForgedTest = init.then(heldPastWindowStart)
    .then(corrupt(1)).then(stale(1))
    .then(all { assert(chainInvalid and dishonest and neverWronglyRetired and scope.get(1) == "closed"), creatorRoll })
}
