// Case 23: one equivocating Writer must not block the creator's close.
//
// Authors: the creator C (the issuance author, a single issuer), honest Writers
// H1, H2 and an equivocating Writer E. Each author issues slots (author
// sequences) above its prior settled boundary; each new vertex depends on the
// author's previous vertex (and may depend on another author's vertex it has
// seen). E may sign a second, distinct vertex at a slot it already used. The
// creator admits any authenticated vertex whose dependencies are admitted, so
// both copies can enter its graph (they have distinct digests).
//
// The close cuts the admitted graph (causally closed) and derives each author's
// settlement boundary (creator-close.ts deriveAuthorIssuanceFrontiers):
//   - an author with two vertices at one slot keeps its prior boundary (frozen);
//   - otherwise the boundary advances over the contiguous run above the prior
//     boundary;
//   - a duplicate slot of the issuance author itself is fatal (it cannot occur:
//     the creator is the single issuer of its own lineage).
//
// Rule under test (v3-live readCreatorClosedArchiveSource, the close's local
// witness capture): BASE (current code) returns no source when ANY author has a
// duplicate slot, so the close throws "creator close original local witnesses
// unavailable" and the epoch never closes. SOUND (proposal): the uniqueness gate
// applies to the issuance author's rows only (they are the only rows the witness
// capture keeps); a foreign duplicate is left to the frontier derivation, which
// freezes that author.
// Broken controls: freezeAll (a duplicate freezes every author), mergeFirstCopy
// (the scan takes one copy of a duplicated slot and continues), advanceBelow
// (the equivocator advances up to the slot below its first duplicate),
// excludeEquivocator (the cut drops E's vertices but keeps their dependents).
//
// Properties: closeNeverRefused (the close is never refused because of a foreign
// duplicate), honestAdvance (every honest author's boundary is its contiguous
// admitted run), equivocatorFrozen (an author with a duplicated slot in the cut
// keeps its prior boundary), neverMerged (no boundary covers a slot with two
// vertices), cutClosed (the cut is causally closed).
module creatorEquivocationClose {
  pure val AUTHORS = Set("C", "H1", "H2", "E")
  pure val HONEST = Set("C", "H1", "H2")
  pure val PRIOR = 0          // every author's prior settled boundary
  pure val MAX_SLOT = 3       // slots PRIOR+1 .. MAX_SLOT
  pure val MAX_VERTICES = 8

  type Vertex = { id: int, author: str, slot: int, deps: Set[int] }
  type Mutants = { refuseForeignDuplicate: bool, freezeAll: bool, mergeFirstCopy: bool, advanceBelow: bool,
                   excludeEquivocator: bool }
  pure val SOUND: Mutants = { refuseForeignDuplicate: false, freezeAll: false, mergeFirstCopy: false, advanceBelow: false,
                              excludeEquivocator: false }

  var vertices: int -> Vertex     // admitted graph, by id
  var nextId: int
  var last: str -> int            // each author's last vertex id (0 = none)
  var closed: bool
  var refusedCloses: int
  var cut: Set[int]
  var boundary: str -> int        // settled boundary per author after the close
  var mutants: Mutants

  pure def ids(vs: int -> Vertex): Set[int] = vs.keys()
  pure def slotsOf(vs: int -> Vertex, members: Set[int], a: str): Set[int] =
    members.filter(i => vs.get(i).author == a).map(i => vs.get(i).slot)
  pure def countAt(vs: int -> Vertex, members: Set[int], a: str, s: int): int =
    members.filter(i => vs.get(i).author == a and vs.get(i).slot == s).size()
  pure def hasDuplicate(vs: int -> Vertex, members: Set[int], a: str): bool =
    1.to(MAX_SLOT).exists(s => countAt(vs, members, a, s) > 1)
  pure def firstDuplicate(vs: int -> Vertex, members: Set[int], a: str): int =
    1.to(MAX_SLOT).fold(MAX_SLOT + 1, (m, s) => if (s < m and countAt(vs, members, a, s) > 1) s else m)
  // Highest b >= PRIOR such that every slot in PRIOR+1..b is present (at least once).
  pure def contiguous(present: Set[int]): int =
    range(1, MAX_SLOT + 1).foldl(PRIOR, (b, s) => if (s == b + 1 and present.contains(s)) s else b)

  pure def deriveBoundary(vs: int -> Vertex, members: Set[int], a: str, anyDuplicate: bool, mu: Mutants): int =
    val present = slotsOf(vs, members, a)
    if (mu.freezeAll and anyDuplicate) PRIOR
    else if (hasDuplicate(vs, members, a))
      if (mu.mergeFirstCopy) contiguous(present)
      else if (mu.advanceBelow) contiguous(present.filter(s => s < firstDuplicate(vs, members, a)))
      else PRIOR
    else contiguous(present)

  action initWith(mu: Mutants): bool = all {
    vertices' = Map(), nextId' = 1, last' = AUTHORS.mapBy(_ => 0), closed' = false, refusedCloses' = 0,
    cut' = Set(), boundary' = AUTHORS.mapBy(_ => PRIOR), mutants' = mu,
  }
  action init = initWith(SOUND)
  action initBase = initWith({ ...SOUND, refuseForeignDuplicate: true })
  action initFreezeAll = initWith({ ...SOUND, freezeAll: true })
  action initMergeFirstCopy = initWith({ ...SOUND, mergeFirstCopy: true })
  action initAdvanceBelow = initWith({ ...SOUND, advanceBelow: true })
  action initExcludeEquivocator = initWith({ ...SOUND, excludeEquivocator: true })

  // An author issues its next slot; it may also depend on one admitted vertex of another author.
  action issue(a: str): bool = all {
    not(closed), nextId <= MAX_VERTICES,
    val prev = last.get(a)
    val slot = if (prev == 0) PRIOR + 1 else vertices.get(prev).slot + 1
    nondet other = ids(vertices).union(Set(0)).oneOf()
    all {
      slot <= MAX_SLOT,
      val d = (if (prev == 0) Set() else Set(prev)).union(if (other == 0) Set() else Set(other))
      vertices' = vertices.put(nextId, { id: nextId, author: a, slot: slot, deps: d }),
      nextId' = nextId + 1,
      last' = last.set(a, nextId),
    },
    closed' = closed, refusedCloses' = refusedCloses, cut' = cut, boundary' = boundary, mutants' = mutants,
  }

  // E signs a second, distinct vertex at a slot it already used (same predecessor).
  action equivocate: bool = all {
    not(closed), nextId <= MAX_VERTICES,
    val used = ids(vertices).filter(i => vertices.get(i).author == "E")
    all {
      used.size() > 0,
      nondet target = used.oneOf()
      val t = vertices.get(target)
      vertices' = vertices.put(nextId, { id: nextId, author: "E", slot: t.slot, deps: t.deps }),
      nextId' = nextId + 1,
    },
    last' = last, closed' = closed, refusedCloses' = refusedCloses, cut' = cut, boundary' = boundary, mutants' = mutants,
  }

  action close: bool = all {
    not(closed),
    val everything = ids(vertices)
    val anyForeignDuplicate = AUTHORS.exclude(Set("C")).exists(a => hasDuplicate(vertices, everything, a))
    val members = if (mutants.excludeEquivocator) everything.filter(i => vertices.get(i).author != "E") else everything
    if (mutants.refuseForeignDuplicate and anyForeignDuplicate) all {
      refusedCloses' = refusedCloses + 1, closed' = closed, cut' = cut, boundary' = boundary,
    } else all {
      refusedCloses' = refusedCloses, closed' = true, cut' = members,
      boundary' = AUTHORS.mapBy(a => deriveBoundary(vertices, members, a, anyForeignDuplicate, mutants)),
    },
    vertices' = vertices, nextId' = nextId, last' = last, mutants' = mutants,
  }

  action stutter: bool = all {
    closed,
    vertices' = vertices, nextId' = nextId, last' = last, closed' = closed, refusedCloses' = refusedCloses, cut' = cut,
    boundary' = boundary, mutants' = mutants,
  }

  action step = any {
    nondet a = AUTHORS.oneOf()
    issue(a),
    equivocate,
    close,
    stutter,
  }

  // ---- Properties ----
  val closeNeverRefused: bool = refusedCloses == 0
  val cutClosed: bool = closed implies cut.forall(i => vertices.get(i).deps.subseteq(cut))
  val honestAdvance: bool =
    closed implies HONEST.forall(a => boundary.get(a) == contiguous(slotsOf(vertices, cut, a)))
  val equivocatorFrozen: bool =
    closed implies AUTHORS.forall(a => hasDuplicate(vertices, cut, a) implies boundary.get(a) == PRIOR)
  val neverMerged: bool =
    closed implies AUTHORS.forall(a => 1.to(MAX_SLOT).forall(s => (s > PRIOR and s <= boundary.get(a)) implies
      countAt(vertices, cut, a, s) == 1))
  val safety: bool = cutClosed and honestAdvance and equivocatorFrozen and neverMerged
  val all_: bool = safety and closeNeverRefused

  // ---- Witness tests (the integration case-23 shape) ----
  run case23BaseTest = initBase
    .then(issue("C")).then(issue("H1")).then(issue("E")).then(equivocate)
    .then(all { assert(hasDuplicate(vertices, ids(vertices), "E")), close })
    .then(all { assert(not(closed) and refusedCloses == 1), issue("H1") })
  run case23SoundTest = init
    .then(issue("C")).then(issue("H1")).then(issue("E")).then(equivocate).then(issue("H1"))
    .then(close)
    .then(all {
      assert(closed and boundary.get("E") == PRIOR and boundary.get("H1") == 2 and boundary.get("C") == 1 and safety),
      stutter,
    })
  run mergeFirstCopyTest = initMergeFirstCopy
    .then(issue("E")).then(equivocate).then(close)
    .then(all { assert(not(neverMerged) and not(equivocatorFrozen)), stutter })
  run freezeAllTest = initFreezeAll
    .then(issue("H1")).then(issue("E")).then(equivocate).then(close)
    .then(all { assert(not(honestAdvance)), stutter })
}
