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
