// Track J (decision rows 61-66 and R7): which journal scopes a Writer may collect when its own or
// another Writer's rows, or its replacements, arrive late relative to a seal. A finite adjunct to
// journal-retirement.qnt, which models the retirement lifecycle and assumes classification; this model
// assumes the lifecycle (one cleanup pass is one atomic step) and models classification.
// Signatures are given facts (cut membership, plan entries, derivation equality), digests are identities
// (a row is its author, incarnation and sequence; the seq-identity mutation shows that author and
// sequence alone are not), and storage atomicity is the lifecycle model's unless an instance splits
// the cross-store commit (H5). The predicates, their
// code sources and the scaling argument are in
// docs/realtime-latency/tracks/38-track-j-late-arrival-retirement-model/RESULT.md.
//
// Encoding: every Writer's rows, plan and replacements are functions over a fixed range of sequences
// (a row is issued iff its sequence is below `next`), so the Apalache encoding stays bounded. A
// Writer's rows of its current epoch are one contiguous sequence range starting at its install fence,
// and a cut holds a per-author prefix of each epoch, so the rows an install displaces are a contiguous
// range too and their replacements take consecutive sequences after the fence, in source order.
module settlementReplacementRetirementSpec {
  // The rule set under test. The decided rules: every bool true except recvA2; planDrop "pruned".
  //  outsideLocal: row 62, own outside rows replaced into a later signed cut (option A).
  //  chain: row 65, follow a replaced outside replacement (option C1).
  //  recvB2: row 64, a received outside row after this Writer's successor install (option B2).
  //  recvA2: the rejected alternative, a received outside row once its author's replacement lands.
  //  r6a: row 66, the census recognises completion of a source older than the closed epoch (R6-A).
  //  minusOwn: row 62 piece (1), the carrier subtracts this author's own rows outside the cut.
  //  minusOthers: row 64, the carrier subtracts other authors' rows beyond their signed frontiers.
  //  fenceRule: R7 (owner, 2026-10-22, approved on condition this model and Track X's safety argument
  //    hold): an outside own fence is collectible once a later own fence is a member of a signed cut
  //    this Writer knows.
  //  w1: W1 (owner, 2026-10-22). A scope with unresolved outside rows keeps the signed Cut authorities
  //    it needs (its own and later ones) until it is collected, so it is classified at every later
  //    install. false: today's window, a scope e is classified at install e+3 only (it has a recovery
  //    trust only then), with evidence from later scopes of the same image.
  //  planDrop: piece (2) drops a completed entry once its source reads as physically pruned ("pruned",
  //    decided), once its source is logically retired ("source", a question), or once its source or its
  //    replacement is logically retired ("either", the owner's (B), approved only if the model clears it).
  //  fenceFrontier: remedy (b) for fences that miss every cut: an outside fence is collectible once the
  //    creator-signed per-author frontier of a later cut this Writer knows covers its sequence (the
  //    frontier is cut membership: the cut's last row of this author in that epoch).
  //  fenceReceipt: remedy (c): each signed cut also carries the creator's per-author receipt frontier
  //    (rows it holds, whether or not they made their own cut); an outside fence is collectible once a
  //    later cut this Writer knows covers it.
  //  truthReceipt: not a rule but the ground truth (c) needs: a fence the creator signed as received is
  //    settled. false: a fence is needed until a later own fence is a member of a signed cut (R7's truth).
  //  carrierProof: the closed-membership carrier is recorded from signed membership evidence that does not
  //    need the Writer to hold every member (astra A1's action). false: today, the Writer's own graph (minus
  //    the pieces' subtractions) must equal the cut's commitment, so a missing member records nothing.
  //  expireDone: the census and the journal classifier recognise an authenticated expire entry (no
  //    replacement) as completed work (astra A2's action). false: today, both require a replacement.
  //  contract: Track X's completion contract (CONTRACT.md, draft of 2026-10-22; a PROPOSAL pending the
  //    owner, changing rows 62 and 65). "full": an own outside row x (move, replacement, fence or expired
  //    move) is Done once T(x) and Settled(x), with no replacement chain walked and no later Cut authority
  //    read. T(x), signed terminal: the cumulative per-author terminal frontier of the Settle record the
  //    Writer installed (the signed cuts up to its installed epoch - 1) covers x. Settled(x): x is a fence;
  //    or an expire entry (with expireDone); or a complete entry whose replacement is a present,
  //    derivation-equal own row. The contract instance also sets w1 (F2: the scope's own authority is
  //    durable, so every later install classifies), carrierProof (F1: Membership(e) comes with the
  //    successor offer), expireDone and planDrop "either" (its section 3.4, step 3). Mutations:
  //    "terminalOnly" (T without Settled) and "settledOnly" (Settled without T). "": the decided rules.
  //  truthIntent: not a rule but the ground truth the contract needs (its I3, no intent loss). An own
  //    outside move or replacement is needed until it is signed terminal and its intent survives: some
  //    link of its derivation-equal replacement chain is a cut member, a present row not logically retired,
  //    or an expire entry. false: needed until the chain lands in a signed cut (the truth of rows 62/65).
  //  w1Volatile: W1's kept authorities live in memory (Track X's S3, a8bfbe64), so a crash loses them.
  //    After a crash at install n, a scope e <= n - 3 is classified again only through today's window.
  //  contract "seqIdentity" (a mutation): the contract with rows identified by (author, sequence) only. A
  //    fresh replica's sequences restart, and its snapshot holds its earlier incarnation's cut members, so
  //    the old-incarnation clause, reading x's epoch through (author, sequence), finds the earlier row of an
  //    epoch before admissionEpoch and reads x as terminal (natively today's digest match prevents this).
  //  oldInc: the contract's T includes the old-incarnation clause (a row of an epoch before the author's
  //    admissionEpoch is terminal). false: a re-admitted author's T is its reset frontier only (D8).
  //  planDrop "settled" (a mutation): drop a completed entry as soon as its replacement is durable, before
  //    its source is signed terminal. planDrop "eitherGuarded" (candidate (b), the contract instances'
  //    baseline pending astra's review; not decided): "either", and the issuance retirement keeps a
  //    replacement that a live entry with an unretired source still names.
  //  carrierLife (astra H2): where the membership proof of a scope (its F1 carrier and F2 authority) lives
  //    once J has collected the scope. "": kept (the decided rules; today's I does not consult it). "scope":
  //    cleared with the scope (the contract's 3.4 step 4 as drafted), so I, which re-derives Done(x) for an
  //    own cut member, has no proof once J has committed. "consumers" (a candidate fix): kept until every
  //    J and I consumer has discharged it (every own member of the scope is logically retired). "handoff"
  //    (the other candidate): J's commit also persists, for I, a per-row membership fact; then cleared.
  //  iCommit (astra H5): the contract's I step, logical retirement (3.4 step 2) and the plan rewrite that
  //    drops the entries naming retired work (step 3). "atomic": one commit. "retireFirst" / "planFirst":
  //    two commits in that order, with a crash point between them. The replacement issue (plan entry,
  //    issued row, outbox) is one commit throughout, as in SQLite natively. "": the decided rules (no plan
  //    rewrite in cleanup; piece (2) drops at the next merge).
  //  readmitPolicy (astra H3): on re-admission as a fresh replica, the old incarnation's unfinished work
  //    (an own move or replacement outside every cut with no replacement, or pending manual review) is
  //    "abandon": lost with the old replica's store (no policy); "expire": expired by an authenticated,
  //    durable incarnation-replacement fact (H3 (i)); "preserve": exposed to the application, which resolves
  //    it (expire, or a replacement row) in the new incarnation (H3 (ii)).
  type Rules = { outsideLocal: bool, chain: bool, recvB2: bool, recvA2: bool, r6a: bool,
    minusOwn: bool, minusOthers: bool, fenceRule: bool, w1: bool, planDrop: str,
    fenceFrontier: bool, fenceReceipt: bool, truthReceipt: bool, carrierProof: bool, expireDone: bool,
    contract: str, truthIntent: bool, w1Volatile: bool, oldInc: bool,
    carrierLife: str, iCommit: str, readmitPolicy: str }
  const RULES: Rules
  const WRITERS: Set[str]
  // Epochs 0..MAX_EPOCH; the creator seals at most epochs 0..MAX_EPOCH-1.
  const MAX_EPOCH: int
  // LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes (7 natively), scaled down; also the C1 walk bound.
  const MAX_SCOPES: int
  // The bound for G1's count after a completed pass.
  const G1_BOUND: int
  // Each Writer issues sequences 0..MAX_SEQ; MAX_MOVES moves; MAX_CRASH skipped cleanup passes.
  const MAX_SEQ: int
  const MAX_MOVES: int
  const MAX_CRASH: int
  // Delivery assumption: a replacement chain misses at most MAX_MISS seals (a move outside its cut is
  // the first miss). The creator does not seal an epoch that would make a chain miss more often.
  const MAX_MISS: int
  // Creator-side fence pacing: a live Writer's fences miss at most FENCE_PACE seals in a row (the creator
  // holds the next seal for that Writer's fence). Greater than MAX_EPOCH: no pacing.
  const FENCE_PACE: int
  // A live Writer is at most LAG installs behind the epoch the creator seals (1: its install output may
  // miss the next cut; 2 or more: it was offline across seals and catches up afterwards).
  const LAG: int
  // Inject replacements whose operations differ from the policy derivation.
  const ALLOW_MISMATCH: bool
  // One Writer may leave (or crash for good) and never install or replace again.
  const ALLOW_LEAVE: bool
  // Schedule control: every seal holds each live Writer's fence of that epoch (the creator seals only
  // after the Writer installed and its fence arrived). Off except in the fence-in-cut control.
  const FENCE_IN_CUT: bool
  // Partial cut receipt (astra A1): an install may succeed while the Writer never received some member of
  // the cut it closes (a creator row); its graph then cannot equal the cut's commitment.
  const ALLOW_PARTIAL: bool
  // The immutable policy expires every displaced move (astra A2): its plan entry has disposition expire and
  // no replacement row. false: every displaced row is rebased (one replacement row per source).
  const EXPIRE: bool
  // ---- Track X's contract: schedule and lifecycle options (off in every decided instance) ----------
  // Rejoin through a chain of retained successor certificates: a live Writer lagging 2..REJOIN_K installs
  // installs the creator's latest successor directly. 0: no rejoin (natively today a lag of 2 or more is
  // refused at the adjacency check).
  const REJOIN_K: int
  // Removal and re-admission: a removed Writer, or one lagging beyond REJOIN_K (the typed rejoin-required),
  // rejoins as a new incarnation: admissionEpoch = the successor's epoch, its frontier reset, its displaced
  // work expired through the policy.
  const ALLOW_READMIT: bool
  // The policy sends every displaced move to manual review (an entry with no replacement, Settled false)
  // until the application resolves it (expire, or a replacement row). The application resolves a review
  // before the seal of the source's epoch + FENCE_PACE + 1 (the contract's 6.3 bound).
  const MANUAL_REVIEW: bool
  // Physical pruning is its own step and may lag the logical retirement (a crash between the two).
  const PRUNE_LAG: bool
  // Native adjacency: an ordinary install only at lag 1 (the creator serves only its current successor).
  // A Writer at lag 2 or more is offline: fence pacing and LAG do not hold the creator for it.
  const ADJACENT_ONLY: bool
  // Re-admission, and rejoin beyond REJOIN_K, run as a fresh replica (Track X, CONTRACT.md 1.4: a
  // re-admitted Writer's own replica cannot come back): an empty local store; the old replica is abandoned
  // with its rows, which only other peers hold; author sequences restart at 0 (rows keep a global index,
  // and a row's native sequence is its index minus its incarnation's first index). false: the contract's
  // proposal, the same replica continues as a new incarnation. At most one re-admission per Writer.
  const READMIT_FRESH: bool

  // An issued row of a Writer. kind: "move", "fence" (the install's author fence: a control row with no
  // intents, so no plan entry) or "repl" (a replacement of the row at sequence src). depth: how many
  // replacement links lead to this row.
  type Row = { ep: int, kind: str, src: int, deriv: bool, depth: int }
  type Entry = { src: int, repl: int }
  type State = {
    sealed: int,                       // epochs 0..sealed-1 are sealed; the creator adopted `sealed`
    cutFront: int -> (str -> int),     // signed per-author frontier of cut(e); -1 = no rows
    rows: str -> (int -> Row),         // Writer -> sequence -> row (issued iff sequence < next)
    cutIn: str -> (int -> bool),       // the row is a member of its epoch's signed cut (set at the seal)
    rcvIn: str -> (int -> int),        // the first signed cut whose receipt frontier covers the row, or -1
    maxLag: str -> int,                // the most installs this Writer was behind a seal
    next: str -> int,
    start: str -> int,                 // first sequence of the Writer's installed epoch (its fence)
    moves: str -> int,
    epoch: str -> int,                 // installed (durable) epoch
    scopes: str -> Set[int],           // journal scopes still present
    carrier: str -> Set[int],          // scopes with a recorded closed-membership carrier
    lacked: str -> Set[int],           // closed epochs the Writer installed past without every cut member
    recv: str -> (int -> (str -> int)), // Writer -> epoch -> author -> admitted outside rows through seq
    replOf: str -> (int -> int),       // the replacement issued for a source, or -1 (ground truth)
    plan: str -> (int -> int),         // settlement plan: source -> replacement, or -1 for no entry
    retired: str -> Set[int],          // own sequences the issuance retirement logically retired
    wm: str -> int,                    // physical prune watermark (prunedThroughAuthorSequence)
    term: str -> str,                  // "" live, or the refusal that made the Writer terminal
    cleaned: str -> bool,              // the last install's cleanup pass ran
    crashes: str -> int,
    left: str -> bool,
    lostThrough: str -> int,           // w1Volatile: the scopes up to here lost W1's kept authority in a crash
    admitted: str -> int,              // the author's admissionEpoch in the Settle record (re-admission)
    tSeen: str -> Set[int],            // ghost for I5: every own row the Writer has seen signed terminal
    incStart: str -> int,              // first row (global index) of the replica's incarnation (fresh replica)
    iProof: str -> Set[int],           // carrierLife "handoff": own members whose membership I holds per row
    jNew: str -> Set[int],             // ghost: the scopes the last J commit collected (I has not run on them)
    exposed: str -> Set[int],          // readmitPolicy "preserve": old-incarnation work awaiting the application
  }
  var s: State

  pure val EPOCHS = 0.to(MAX_EPOCH)
  pure val SEQS = 0.to(MAX_SEQ)
  // Sequences plus -1 ("none"), -2 (an expire entry: no replacement row) and -3 (a pending manual-review
  // entry), so a lookup of any of them stays inside every domain.
  pure val SLOTS = (-3).to(MAX_SEQ)
  pure val NOROW: Row = { ep: -1, kind: "none", src: -1, deriv: true, depth: 0 }
  pure def min2(a: int, b: int): int = if (a < b) a else b
  pure def max2(a: int, b: int): int = if (a > b) a else b

  // ---- Facts -------------------------------------------------------------------------------------
  pure def row(st: State, w: str, q: int): Row = st.rows.get(w).get(q)
  pure def issued(st: State, w: str, q: int): bool = q >= 0 and q < st.next.get(w)
  pure def inCut(st: State, w: str, q: int): bool = st.cutIn.get(w).get(q)
  pure def outside(st: State, w: str, q: int): bool = issued(st, w, q) and not(inCut(st, w, q))
  pure def ownOutAt(st: State, w: str, q: int, e: int): bool = outside(st, w, q) and row(st, w, q).ep == e
  // b's row q of epoch e, admitted by w outside its cut.
  pure def recvRow(st: State, w: str, e: int, b: str, q: int): bool =
    q <= st.recv.get(w).get(e).get(b) and ownOutAt(st, b, q, e)
  pure def live(st: State, w: str): bool = st.term.get(w) == "" and not(st.left.get(w))
  pure def present(st: State, w: str, q: int): bool = q > st.wm.get(w)
  // A row of the replica's current incarnation (a fresh replica abandoned the older ones).
  pure def held(st: State, w: str, q: int): bool = issued(st, w, q) and q >= st.incStart.get(w)
  // The native author sequence: restarts at 0 with each fresh replica.
  pure def nseq(st: State, w: str, q: int): int = if (q >= st.incStart.get(w)) q - st.incStart.get(w) else q
  // seqIdentity: a row whose native sequence equals an earlier incarnation's cut member reads as a member.
  pure def seqAlias(st: State, w: str, q: int): bool = RULES.contract == "seqIdentity" and q >= st.incStart.get(w) and
    SEQS.exists(p => p < st.incStart.get(w) and inCut(st, w, p) and nseq(st, w, p) == nseq(st, w, q))
  pure def planEntries(st: State, w: str): Set[Entry] =
    SEQS.filter(q => st.plan.get(w).get(q) != -1).map(q => { src: q, repl: st.plan.get(w).get(q) })

  // ---- The decided rules (rows 62, 64, 65, R7), over one image captured before any deletion ------
  // Today: the later scope is in this image with its carrier, so its signed cut's membership opens.
  // W1: the signed Cut authority of every later epoch is kept as data while the scope is unresolved.
  pure def known(st: State, w: str, m: int): bool =
    m <= st.epoch.get(w) - 1 and ((RULES.w1 and (not(RULES.w1Volatile) or m > st.lostThrough.get(w))) or
      (st.carrier.get(w).contains(m) and st.scopes.get(w).contains(m)))
  // replacedLocalSourceFacts: this author's entry names y, both rows readable, derivation equal.
  pure def link(st: State, w: str, x: int, y: int): bool =
    y >= 0 and st.plan.get(w).get(x) == y and row(st, w, y).kind == "repl" and row(st, w, y).src == x and
    row(st, w, y).deriv and present(st, w, x) and present(st, w, y)
  // C1: an intermediate link is a replaced outside row of a later scope in the image (W1: outside its
  // signed cut, checked against the kept authority).
  pure def mid(st: State, w: str, c: int): bool =
    not(inCut(st, w, c)) and (RULES.w1 or st.scopes.get(w).contains(row(st, w, c).ep))
  pure def landed(st: State, w: str, c: int): bool = inCut(st, w, c) and known(st, w, row(st, w, c).ep)
  pure def chainOk(st: State, w: str, x: int, e: int): bool = {
    val y1 = st.plan.get(w).get(x)
    val y2 = st.plan.get(w).get(y1)
    val y3 = st.plan.get(w).get(y2)
    link(st, w, x, y1) and row(st, w, y1).ep > e and (landed(st, w, y1) or
      (RULES.chain and MAX_SCOPES >= 2 and mid(st, w, y1) and link(st, w, y1, y2) and
        (landed(st, w, y2) or (MAX_SCOPES >= 3 and mid(st, w, y2) and link(st, w, y2, y3) and landed(st, w, y3)))))
  }
  pure def localOk(st: State, w: str, x: int, e: int): bool =
    if (RULES.contract != "") contractDone(st, w, x)
    else if (row(st, w, x).kind == "fence")
      (RULES.fenceRule and SEQS.exists(f => f > x and issued(st, w, f) and row(st, w, f).kind == "fence" and
        present(st, w, f) and landed(st, w, f))) or
      (RULES.fenceFrontier and EPOCHS.exists(m => m > e and known(st, w, m) and st.cutFront.get(m).get(w) >= x)) or
      (RULES.fenceReceipt and st.rcvIn.get(w).get(x) >= 0 and known(st, w, st.rcvIn.get(w).get(x)))
    else (RULES.outsideLocal and chainOk(st, w, x, e)) or
      (RULES.expireDone and st.plan.get(w).get(x) == -2 and present(st, w, x))
  // The contract's T(x): the cumulative per-author terminal frontier of the signed cuts through cutThrough
  // covers x (an own fence F in a signed cut makes every own row below F terminal, admitted or not, and the
  // walk passes the cut's own members). The rule reads it from the installed Settle record (cutThrough =
  // installed epoch - 1), which is always held: no Cut authority is needed.
  // A re-admitted author's frontier restarts at its admissionEpoch; the old-incarnation clause (oldInc)
  // covers its earlier rows.
  pure def terminalBy(st: State, w: str, x: int, cutThrough: int): bool =
    EPOCHS.exists(m => m >= st.admitted.get(w) and m <= cutThrough and m < st.sealed and st.cutFront.get(m).get(w) >= x) or
    (RULES.oldInc and issued(st, w, x) and (row(st, w, x).ep < st.admitted.get(w) or seqAlias(st, w, x)))
  // The truth: x is never admitted once a later own row is in any signed cut (frontiers aside), or once
  // its author was re-admitted after x's epoch (an old-incarnation row is never admitted).
  pure def terminalTruth(st: State, w: str, x: int, cutThrough: int): bool =
    EPOCHS.exists(m => m <= cutThrough and m < st.sealed and st.cutFront.get(m).get(w) >= x) or
    (issued(st, w, x) and row(st, w, x).ep < st.admitted.get(w))
  // The contract's Settled(x), a local fact for an own row: a fence; an expire entry (expireDone); or a
  // complete entry whose replacement is a present, derivation-equal own row.
  pure def settledLocal(st: State, w: str, x: int): bool =
    if (row(st, w, x).kind == "fence") true
    else if (st.plan.get(w).get(x) == -2) RULES.expireDone and present(st, w, x)
    else link(st, w, x, st.plan.get(w).get(x))
  pure def contractDone(st: State, w: str, x: int): bool =
    (RULES.contract == "settledOnly" or terminalBy(st, w, x, st.epoch.get(w) - 1)) and
    (RULES.contract == "terminalOnly" or settledLocal(st, w, x))
  // The membership proof of an own cut member, as I can read it: its scope's carrier, or a handed-off fact.
  pure def memberProof(st: State, w: str, q: int): bool =
    inCut(st, w, q) and (st.carrier.get(w).contains(row(st, w, q).ep) or st.iProof.get(w).contains(q))
  // Done(x) as I re-derives it when it logically retires an own row (the contract's 3.4 step 2).
  pure def iDone(st: State, w: str, q: int): bool =
    (memberProof(st, w, q) and st.epoch.get(w) > row(st, w, q).ep) or
    (terminalBy(st, w, q, st.epoch.get(w) - 1) and settledLocal(st, w, q))
  // An own member that still needs its scope's proof: present, not logically retired, not a fence (a fence
  // is Done by T alone).
  pure def proofConsumer(st: State, w: str, q: int, ret: Set[int]): bool =
    held(st, w, q) and inCut(st, w, q) and row(st, w, q).kind != "fence" and not(ret.contains(q)) and q > st.wm.get(w)
  // The store's plan check (IS:1635-1655): no entry names retired or absent work.
  pure def planClean(st: State, w: str, pl: int -> int): bool =
    SEQS.forall(q => pl.get(q) != -1 implies (q > st.wm.get(w) and not(st.retired.get(w).contains(q)) and
      (pl.get(q) < 0 or (pl.get(q) > st.wm.get(w) and not(st.retired.get(w).contains(pl.get(q)))))))
  pure def recvOk(st: State, w: str, b: str, q: int, e: int): bool =
    if (RULES.recvB2) st.epoch.get(w) >= e + 1
    else if (RULES.recvA2) {
      val r = st.replOf.get(b).get(q)
      r >= 0 and row(st, b, r).deriv and inCut(st, b, r) and known(st, w, row(st, b, r).ep)
    }
    else false
  pure def collectible(st: State, w: str, e: int): bool =
    (if (RULES.w1) e <= st.epoch.get(w) - 3 and
      (not(RULES.w1Volatile) or e > st.lostThrough.get(w) or e == st.epoch.get(w) - 3)
     else e == st.epoch.get(w) - 3) and st.carrier.get(w).contains(e) and
    SEQS.forall(q => ownOutAt(st, w, q, e) implies localOk(st, w, q, e)) and
    WRITERS.forall(b => SEQS.forall(q => recvRow(st, w, e, b, q) implies recvOk(st, w, b, q, e)))

  // ---- Ground truth: what a Writer still needs (independent of the rules) -----------------------
  pure def tlink(st: State, a: str, x: int, y: int): bool =
    y >= 0 and st.replOf.get(a).get(x) == y and row(st, a, y).deriv
  // cutThrough bounds the cuts considered: every signed cut (truth) or the cuts w has installed past.
  pure def hit(st: State, a: str, c: int, cutThrough: int): bool = inCut(st, a, c) and row(st, a, c).ep <= cutThrough
  pure def reaches(st: State, a: str, x: int, cutThrough: int): bool = {
    val y1 = st.replOf.get(a).get(x)
    val y2 = st.replOf.get(a).get(y1)
    val y3 = st.replOf.get(a).get(y2)
    tlink(st, a, x, y1) and (hit(st, a, y1, cutThrough) or (tlink(st, a, y1, y2) and
      (hit(st, a, y2, cutThrough) or (tlink(st, a, y2, y3) and hit(st, a, y3, cutThrough)))))
  }
  // A scan of x's derivation-equal replacement chain (at most MAX_EPOCH links, one epoch each): does some
  // link land in a signed cut through cutThrough, or (durable) is some link a present row not logically
  // retired, or an expire entry?
  pure def chainScan(st: State, a: str, x: int, cutThrough: int, durable: bool): bool =
    1.to(MAX_EPOCH).fold({ cur: x, alive: true, ok: false }, (acc, i) => {
      val y = st.replOf.get(a).get(acc.cur)
      val stepOk = acc.alive and tlink(st, a, acc.cur, y)
      { cur: if (stepOk) y else acc.cur, alive: stepOk,
        ok: acc.ok or (stepOk and (hit(st, a, y, cutThrough) or (durable and (st.replOf.get(a).get(y) == -2 or
          (present(st, a, y) and not(st.retired.get(a).contains(y))))))) }
    }).ok
  pure def needsLocal(st: State, a: str, x: int, cutThrough: int): bool =
    // Under the contract's truth a fence is needed until signed terminal (a later own row in a signed cut,
    // which for a fence is a later own fence, or the old-incarnation fact).
    if (row(st, a, x).kind == "fence" and RULES.truthIntent) not(terminalTruth(st, a, x, cutThrough))
    else if (row(st, a, x).kind == "fence")
      not(SEQS.exists(f => f > x and issued(st, a, f) and row(st, a, f).kind == "fence" and hit(st, a, f, cutThrough))) and
      not(RULES.truthReceipt and st.rcvIn.get(a).get(x) >= 0 and st.rcvIn.get(a).get(x) <= cutThrough)
    // I3: needed until signed terminal and its intent survives in its chain (or it expired by policy).
    else if (RULES.truthIntent)
      not(terminalTruth(st, a, x, cutThrough) and (st.replOf.get(a).get(x) == -2 or chainScan(st, a, x, cutThrough, true)))
    else not(reaches(st, a, x, cutThrough)) and st.replOf.get(a).get(x) != -2
  pure def needsRecv(st: State, w: str, e: int): bool = st.epoch.get(w) <= e

  // ---- The cleanup pass (journal then issuance retirement), at the end of an install -----------
  pure def cleanupState(st: State, w: str): State = cleanupUpTo(st, w, 0)
  // One pass: J's commit (the scope details; per carrierLife the carrier, or the handoff), then I. A crash
  // at crashPoint 2 stops after J's commit; at 3, between I's two commits (iCommit "retireFirst"/"planFirst").
  pure def cleanupUpTo(st: State, w: str, crashPoint: int): State = {
    val n = st.epoch.get(w)
    val image = st.scopes.get(w)
    val collect = EPOCHS.filter(e => image.contains(e) and collectible(st, w, e))
    val kept = EPOCHS.filter(e => image.contains(e) and e <= n - 1 and not(collect.contains(e)))
    // Today the recovery dependency hold of a scope being classified cannot classify an expired displaced
    // source (an entry with no replacement), and the install refuses (astra A2: "creator recovery dependency
    // hold unavailable:outbox-classification:<seq>:displaced:published", at install e+3).
    val holdFails = not(RULES.expireDone) and EPOCHS.exists(e => image.contains(e) and
      (if (RULES.w1) e <= n - 3 else e == n - 3) and SEQS.exists(q => ownOutAt(st, w, q, e) and st.plan.get(w).get(q) == -2))
    if (holdFails) st.with("term", st.term.set(w, "census"))
    else if (kept.size() > MAX_SCOPES) st.with("term", st.term.set(w, "scopes"))
    else {
      val clear = RULES.carrierLife == "scope" or RULES.carrierLife == "handoff"
      val stJ = st.with("scopes", st.scopes.set(w, EPOCHS.filter(e => image.contains(e) and not(collect.contains(e)))))
        .with("carrier", if (clear) st.carrier.set(w, st.carrier.get(w).filter(e => not(collect.contains(e)))) else st.carrier)
        .with("iProof", if (RULES.carrierLife == "handoff") st.iProof.set(w, st.iProof.get(w).union(
            SEQS.filter(q => held(st, w, q) and inCut(st, w, q) and collect.contains(row(st, w, q).ep))))
          else st.iProof)
        .with("jNew", st.jNew.set(w, collect))
      if (crashPoint == 2) stJ else iPass(stJ, w, image, crashPoint)
    }
  }
  // I: closedIssuanceProtectedRecordsForRetirement (through = n - 1; epoch <= through - 2; its scope absent
  // from the image captured before this pass's journal drain), and under the contract Done(x) re-derived.
  pure def iPass(st: State, w: str, image: Set[int], crashPoint: int): State = {
    val n = st.epoch.get(w)
    // Under the contract the store checks the stored plan at admission (IS:1652-1653): stale references refuse.
    val stale = RULES.contract != "" and not(planClean(st, w, st.plan.get(w)))
    val cand = SEQS.filter(q => st.retired.get(w).contains(q) or
      (issued(st, w, q) and row(st, w, q).ep <= n - 3 and not(image.contains(row(st, w, q).ep)) and
        (RULES.contract == "" or iDone(st, w, q))))
    // "eitherGuarded" (A-1): a replacement named by a live entry stays unretired unless that entry's source
    // is retired in the same step. That is the greatest fixpoint of the guard over the candidates; since a
    // replacement always follows its source (L4, L5), deciding the rows in sequence order (each source before
    // its replacements) reaches it in one pass. "eitherGuardedOnePass" (a mutation): the guard judged once,
    // against the candidates instead of the rows actually retired.
    val retired1 =
      if (RULES.planDrop == "eitherGuarded")
        range(0, MAX_SEQ + 1).foldl(Set(), (r, q) =>
          if (cand.contains(q) and (st.retired.get(w).contains(q) or
            SEQS.forall(x => st.plan.get(w).get(x) == q implies r.contains(x)))) r.union(Set(q)) else r)
      else if (RULES.planDrop == "eitherGuardedOnePass")
        cand.filter(q => st.retired.get(w).contains(q) or
          not(SEQS.exists(x => st.plan.get(w).get(x) == q and not(cand.contains(x)))))
      else cand
    // The node store prunes a contiguous prefix only (prunedThroughAuthorSequence).
    val wm0 = st.wm.get(w)
    val wm1 = SLOTS.filter(q => q >= wm0 and q < st.next.get(w) and
      SEQS.forall(p => (p > wm0 and p <= q) implies retired1.contains(p))).fold(wm0, (acc, q) => max2(acc, q))
    // carrierLife "consumers": a collected scope's proof goes once no own member of it needs it.
    val carrier1 = if (RULES.carrierLife != "consumers") st.carrier.get(w)
      else st.carrier.get(w).filter(e => st.scopes.get(w).contains(e) or
        SEQS.exists(q => row(st, w, q).ep == e and proofConsumer(st, w, q, retired1)))
    // The contract's 3.4 step 3: the plan write drops each entry whose source or replacement is retired here.
    val plan0 = st.plan.get(w)
    val plan1 = if (RULES.contract == "") plan0
      else SLOTS.mapBy(q => if (q >= 0 and plan0.get(q) != -1 and droppable(q, plan0.get(q), wm0, retired1)) -1 else plan0.get(q))
    val stR = st.with("retired", st.retired.set(w, retired1)).with("wm", st.wm.set(w, if (PRUNE_LAG) wm0 else wm1))
      .with("carrier", st.carrier.set(w, carrier1))
    val stRP = stR.with("plan", st.plan.set(w, plan1))
    if (stale or not(RULES.contract == "" or planClean(stRP, w, plan1))) st.with("term", st.term.set(w, "plan"))
    else if (crashPoint == 3 and RULES.iCommit == "retireFirst") stR
    else if (crashPoint == 3 and RULES.iCommit == "planFirst") st.with("plan", st.plan.set(w, plan1))
    else stRP
  }

  // The node store's physical prune: the contiguous prefix of logically retired rows.
  pure def pruneState(st: State, w: str): State = {
    val wm0 = st.wm.get(w)
    val wm1 = SLOTS.filter(q => q >= wm0 and q < st.next.get(w) and
      SEQS.forall(p => (p > wm0 and p <= q) implies st.retired.get(w).contains(p))).fold(wm0, (acc, q) => max2(acc, q))
    st.with("wm", st.wm.set(w, wm1))
  }

  // ---- Install of epoch n+1 by w: carrier, plan merge and write, fence, replacements, census -----
  // The rows the install displaces: own rows of epoch n outside cut(n), other than the fence. They are
  // the sequences lowDisplaced..next-1 (the creator has sealed n before w installs n+1).
  pure def lowDisplaced(st: State, w: str): int = {
    val n = st.epoch.get(w)
    max2(st.cutFront.get(n).get(w) + 1, if (n >= 1) st.start.get(w) + 1 else 0)
  }
  pure def displacedCount(st: State, w: str): int = max2(0, st.next.get(w) - lowDisplaced(st, w))
  pure def droppable(src: int, repl: int, wm: int, ret: Set[int]): bool =
    src <= wm or (RULES.planDrop == "source" and ret.contains(src)) or
    ((RULES.planDrop == "either" or RULES.planDrop == "eitherGuarded" or RULES.planDrop == "eitherGuardedOnePass") and
      (ret.contains(src) or ret.contains(repl))) or
    (RULES.planDrop == "settled" and repl >= 0)
  pure def installState(st: State, w: str, recvT: str -> int, mismatch: bool, crash: bool, partial: bool): State =
    installTo(st, w, st.epoch.get(w) + 1, false, recvT, mismatch, crash, partial)
  // The install of epoch `target` (n + 1, or the creator's latest successor on a rejoin). newInc: the
  // Writer rejoins as a new incarnation (admissionEpoch = target; its displaced work is expired).
  pure def installTo(st: State, w: str, target: int, newInc: bool, recvT: str -> int, mismatch: bool, crash: bool,
      partial: bool): State = installToAt(st, w, target, newInc, recvT, mismatch, if (crash) 1 else 0, partial)
  // crashPoint: 0 none; 1 before the cleanup pass; 2 after J's commit; 3 between I's two commits.
  pure def installToAt(st: State, w: str, target: int, newInc: bool, recvT: str -> int, mismatch: bool,
      crashPoint: int, partial: bool): State = {
    val crash = crashPoint >= 1
    val n = st.epoch.get(w)
    val nx = st.next.get(w)
    val wm = st.wm.get(w)
    val ret = st.retired.get(w)
    val lo = lowDisplaced(st, w)
    // The disposition of the displaced rows: expire (the expire policy, or a new incarnation's unsent work),
    // manual review, or rebase (one replacement row each).
    val disp = if (EXPIRE or newInc) -2 else if (MANUAL_REVIEW) -3 else 0
    val k = installReplacementCount(st, w, newInc)
    val nx1 = nx + 1 + k
    val adm1 = if (newInc) target else st.admitted.get(w)
    // creatorReceivedCutCandidate / B2: the candidate equals the cut iff the pieces subtract the rows.
    val ownOutN = SEQS.exists(q => ownOutAt(st, w, q, n))
    val anyPicked = WRITERS.exists(b => recvT.get(b) != -1)
    // A1: a Writer missing a member of cut(n) cannot match the commitment from its own graph.
    val carrierOk = RULES.carrierProof or
      ((RULES.minusOwn or not(ownOutN)) and (RULES.minusOthers or not(anyPicked)) and not(partial))
    // completedSettlementSourcesPruned: drop a completed entry whose source reads as pruned (or, in the
    // variants, whose source, or source or replacement, is logically retired).
    val plan0 = st.plan.get(w)
    val keptPlan = SLOTS.mapBy(q =>
      if (q >= 0 and plan0.get(q) != -1 and
        (if (RULES.contract != "") q <= wm else droppable(q, plan0.get(q), wm, ret))) -1 else plan0.get(q))
    // assertIssuanceRetirementPlanAllowed: every named row present and not logically retired.
    val planOk = SEQS.forall(q => keptPlan.get(q) != -1 implies (q > wm and not(ret.contains(q)) and
      (keptPlan.get(q) < 0 or (keptPlan.get(q) > wm and not(ret.contains(keptPlan.get(q)))))))
    val rows0 = st.rows.get(w)
    val rowsW = SLOTS.mapBy(q =>
      if (q == nx) { ep: target, kind: "fence", src: -1, deriv: true, depth: 0 }
      else if (q > nx and q < nx1)
        { ep: target, kind: "repl", src: lo + (q - nx - 1), deriv: not(mismatch), depth: rows0.get(lo + (q - nx - 1)).depth + 1 }
      else rows0.get(q))
    // Each displaced row gets its replacement (rebase) or an expire entry with no replacement (EXPIRE).
    val replW = SLOTS.mapBy(q => if (q >= lo and q < nx) (if (disp < 0) disp else nx + 1 + (q - lo)) else st.replOf.get(w).get(q))
    val plan1 = SLOTS.mapBy(q => if (q >= lo and q < nx) (if (disp < 0) disp else nx + 1 + (q - lo)) else keptPlan.get(q))
    // The census visits every own row the store still holds above the signed frontier (rows at or below
    // it are "terminal", settlementOwnRowClass), except the new epoch's rows and fences (fences have their
    // own class). A displaced row needs a completed entry (completedBranch), else the census is
    // unclassified and the install fails on every retry.
    // Under the contract the census's terminal class is T read from the new Settle record (cuts through n,
    // admissionEpoch adm1): a row is Done, open (an entry), or settled awaiting T.
    val stAdm = st.with("admitted", st.admitted.set(w, adm1))
    val censused = SEQS.filter(q => q < nx and q > wm and rows0.get(q).ep <= n and rows0.get(q).kind != "fence" and
      (if (RULES.contract != "") not(terminalBy(stAdm, w, q, n)) else SEQS.forall(p => inCut(st, w, p) implies p < q)))
    val censusOrphan = censused.exists(q => plan1.get(q) == -1)
    val censusMismatch = censused.exists(q => plan1.get(q) >= 0 and not(rowsW.get(plan1.get(q)).deriv))
    // R4 recognises a source of the closed epoch n; R6-A one older than n.
    val censusOld = censused.exists(q => rows0.get(q).ep < n)
    if (not(planOk)) st.with("term", st.term.set(w, "plan"))
    else if (censusOrphan) st.with("term", st.term.set(w, "orphan"))
    else if (censusMismatch) st.with("term", st.term.set(w, "mismatch"))
    else if (censusOld and not(RULES.r6a)) st.with("term", st.term.set(w, "census"))
    else {
      val st1 = st.with("rows", st.rows.set(w, rowsW))
        .with("next", st.next.set(w, nx1))
        .with("start", st.start.set(w, nx))
        .with("epoch", st.epoch.set(w, target))
        .with("scopes", st.scopes.set(w, EPOCHS.filter(e => st.scopes.get(w).contains(e) or e == target)))
        .with("admitted", st.admitted.set(w, adm1))
        .with("left", st.left.set(w, st.left.get(w) and not(newInc)))
        .with("carrier", st.carrier.set(w, EPOCHS.filter(e => st.carrier.get(w).contains(e) or (carrierOk and e == n))))
        .with("lacked", st.lacked.set(w, EPOCHS.filter(e => st.lacked.get(w).contains(e) or (partial and e == n))))
        .with("recv", st.recv.set(w, st.recv.get(w).set(n, recvT)))
        .with("replOf", st.replOf.set(w, replW))
        .with("plan", st.plan.set(w, plan1))
        .with("cleaned", st.cleaned.set(w, not(crash)))
        .with("crashes", st.crashes.set(w, st.crashes.get(w) + (if (crash) 1 else 0)))
        .with("lostThrough", if (crash and RULES.w1Volatile) st.lostThrough.set(w, max2(st.lostThrough.get(w), target - 3))
          else st.lostThrough)
      seenT(if (crashPoint == 1) st1 else cleanupUpTo(st1, w, crashPoint), w)
    }
  }

  // Re-admission (or rejoin beyond K) as a fresh replica: it installs the creator's latest successor with an
  // empty store; its sequences restart (the first new row is its incarnation's sequence 0).
  pure def freshState(st: State, w: str, target: int, crash: bool): State = {
    val nx = st.next.get(w)
    // The old incarnation's unfinished work: outside every cut, not a fence, no replacement (or pending review).
    val ends = SEQS.filter(q => q < nx and issued(st, w, q) and row(st, w, q).kind != "fence" and not(inCut(st, w, q)) and
      (st.replOf.get(w).get(q) == -1 or st.replOf.get(w).get(q) == -3))
    val repl1 = SLOTS.mapBy(q => if (ends.contains(q) and RULES.readmitPolicy == "expire") -2
      else if (ends.contains(q) and RULES.readmitPolicy == "preserve") -3 else st.replOf.get(w).get(q))
    val st1 = st.with("replOf", st.replOf.set(w, repl1))
      .with("exposed", st.exposed.set(w, if (RULES.readmitPolicy == "preserve") ends else Set()))
      .with("iProof", st.iProof.set(w, Set()))
      .with("jNew", st.jNew.set(w, Set()))
      .with("rows", st.rows.set(w, st.rows.get(w).set(nx, { ep: target, kind: "fence", src: -1, deriv: true, depth: 0 })))
      .with("next", st.next.set(w, nx + 1))
      .with("start", st.start.set(w, nx))
      .with("epoch", st.epoch.set(w, target))
      .with("scopes", st.scopes.set(w, Set(target)))
      .with("carrier", st.carrier.set(w, Set()))
      .with("lacked", st.lacked.set(w, Set()))
      .with("recv", st.recv.set(w, EPOCHS.mapBy(e => WRITERS.mapBy(b => -1))))
      .with("plan", st.plan.set(w, SLOTS.mapBy(q => -1)))
      .with("retired", st.retired.set(w, Set()))
      .with("wm", st.wm.set(w, nx - 1))
      .with("admitted", st.admitted.set(w, target))
      .with("incStart", st.incStart.set(w, nx))
      .with("tSeen", st.tSeen.set(w, Set()))
      .with("left", st.left.set(w, false))
      .with("cleaned", st.cleaned.set(w, not(crash)))
      .with("crashes", st.crashes.set(w, st.crashes.get(w) + (if (crash) 1 else 0)))
    seenT(if (crash) st1 else cleanupState(st1, w), w)
  }
  // I5's ghost: add every own row the Writer now reads as signed terminal.
  pure def seenT(st: State, w: str): State =
    if (RULES.contract == "") st
    else st.with("tSeen", st.tSeen.set(w, st.tSeen.get(w).union(
      SEQS.filter(x => held(st, w, x) and terminalBy(st, w, x, st.epoch.get(w) - 1)))))

  // ---- Schedule constraints ---------------------------------------------------------------------
  // A front names a prefix of w's rows of the epoch being sealed (rows issued before the seal).
  pure def validFront(st: State, w: str, f: int): bool =
    f == -1 or (issued(st, w, f) and row(st, w, f).ep == st.sealed)
  // Delivery assumptions. A live Writer lags the creator by at most LAG installs (the creator seals E
  // only once the Writer installed E-LAG), so its install outputs may miss the cuts. A replacement at
  // depth >= MAX_MISS lands: the seal holds it, and the creator does not seal while a lagging Writer's
  // catch-up installs would issue one after the seal.
  pure def attached(st: State, w: str): bool =
    live(st, w) and (not(ADJACENT_ONLY) or st.epoch.get(w) >= st.sealed - 1)
  pure def sealRespectsMisses(st: State, fronts: str -> int): bool = WRITERS.forall(w => not(attached(st, w)) or (
    st.epoch.get(w) >= st.sealed - LAG and
    (st.epoch.get(w) < st.sealed implies SEQS.forall(q => (q >= lowDisplaced(st, w) and q < st.next.get(w)) implies
      row(st, w, q).depth + (st.sealed - st.epoch.get(w)) <= MAX_MISS - 1)) and
    SEQS.forall(q => (issued(st, w, q) and row(st, w, q).ep == st.sealed and row(st, w, q).depth >= MAX_MISS) implies
      q <= fronts.get(w))))
  // A front of -1 for a Writer misses its fence of that epoch (the fence is its first row there; epoch 0
  // has none). After FENCE_PACE misses in a row the next seal holds it.
  pure def sealBoundsFenceMisses(st: State, fronts: str -> int): bool = WRITERS.forall(w =>
    not(attached(st, w)) or st.sealed == 0 or fronts.get(w) != -1 or
    1.to(FENCE_PACE).exists(j => st.sealed - j < 1 or st.cutFront.get(st.sealed - j).get(w) != -1))
  // Manual review: the application resolves a pending review before the seal of its source's epoch +
  // FENCE_PACE + 1, so it costs no more scopes than a run of fence misses.
  pure def sealBoundsReviews(st: State): bool = WRITERS.forall(w => not(attached(st, w)) or
    SEQS.forall(x => (st.replOf.get(w).get(x) == -3 and
      ((MANUAL_REVIEW and x >= st.incStart.get(w)) or st.exposed.get(w).contains(x))) implies
      st.sealed - max2(row(st, w, x).ep, if (st.exposed.get(w).contains(x)) st.admitted.get(w) else 0) <= FENCE_PACE))
  pure def sealHoldsFences(st: State, fronts: str -> int): bool = not(FENCE_IN_CUT) or WRITERS.forall(w =>
    not(live(st, w)) or st.sealed == 0 or
    (st.epoch.get(w) >= st.sealed and SEQS.forall(q => (issued(st, w, q) and row(st, w, q).kind == "fence" and
      row(st, w, q).ep == st.sealed) implies q <= fronts.get(w))))
  pure def sealChoices(st: State): Set[str -> int] =
    WRITERS.setOfMaps(SLOTS).filter(m => WRITERS.forall(w => validFront(st, w, m.get(w))) and
      sealRespectsMisses(st, m) and sealHoldsFences(st, m) and sealBoundsFenceMisses(st, m) and sealBoundsReviews(st))
  pure def recvChoices(st: State, w: str): Set[str -> int] =
    WRITERS.setOfMaps(SLOTS).filter(m => WRITERS.forall(b =>
      m.get(b) == -1 or (b != w and ownOutAt(st, b, m.get(b), st.epoch.get(w)))))

  // ---- Actions ----------------------------------------------------------------------------------
  action init = s' = {
    sealed: 0,
    cutFront: EPOCHS.mapBy(e => WRITERS.mapBy(w => -1)),
    rows: WRITERS.mapBy(w => SLOTS.mapBy(q => NOROW)),
    cutIn: WRITERS.mapBy(w => SLOTS.mapBy(q => false)),
    rcvIn: WRITERS.mapBy(w => SLOTS.mapBy(q => -1)),
    maxLag: WRITERS.mapBy(w => 0),
    next: WRITERS.mapBy(w => 0),
    start: WRITERS.mapBy(w => 0),
    moves: WRITERS.mapBy(w => 0),
    epoch: WRITERS.mapBy(w => 0),
    scopes: WRITERS.mapBy(w => Set(0)),
    carrier: WRITERS.mapBy(w => Set()),
    lacked: WRITERS.mapBy(w => Set()),
    recv: WRITERS.mapBy(w => EPOCHS.mapBy(e => WRITERS.mapBy(b => -1))),
    replOf: WRITERS.mapBy(w => SLOTS.mapBy(q => -1)),
    plan: WRITERS.mapBy(w => SLOTS.mapBy(q => -1)),
    retired: WRITERS.mapBy(w => Set()),
    wm: WRITERS.mapBy(w => -1),
    term: WRITERS.mapBy(w => ""),
    cleaned: WRITERS.mapBy(w => true),
    crashes: WRITERS.mapBy(w => 0),
    left: WRITERS.mapBy(w => false),
    lostThrough: WRITERS.mapBy(w => -1),
    admitted: WRITERS.mapBy(w => 0),
    tSeen: WRITERS.mapBy(w => Set()),
    incStart: WRITERS.mapBy(w => 0),
    iProof: WRITERS.mapBy(w => Set()),
    jNew: WRITERS.mapBy(w => Set()),
    exposed: WRITERS.mapBy(w => Set()),
  }
  // A move in the Writer's current epoch: before the creator's seal it may or may not reach the cut,
  // after it (during the seal or adoption) it is outside. A Writer behind the creator moves in a sealed
  // epoch, and the move then misses every cut until the Writer catches up: at most MAX_MISS of them.
  action move(w: str): bool = all {
    live(s, w), s.moves.get(w) < MAX_MOVES, s.next.get(w) <= MAX_SEQ,
    s.sealed - s.epoch.get(w) <= MAX_MISS,
    s' = s.with("rows", s.rows.set(w, s.rows.get(w).set(s.next.get(w),
        { ep: s.epoch.get(w), kind: "move", src: -1, deriv: true, depth: 0 })))
      .with("next", s.next.set(w, s.next.get(w) + 1))
      .with("moves", s.moves.set(w, s.moves.get(w) + 1)),
  }
  // The creator seals epoch `sealed` with a cut holding each author's chosen prefix, and adopts the
  // successor (row 61: a Writer installs only after this). Its receipt frontier (read only by remedy (c))
  // assumes a row reaches the creator before the next seal after it is issued: it covers every issued row
  // of an earlier epoch, and the cut's own rows.
  pure def sealEnabled(st: State, fronts: str -> int): bool =
    st.sealed < MAX_EPOCH and sealChoices(st).contains(fronts)
  pure def sealState(st: State, fronts: str -> int): State =
    st.with("cutFront", st.cutFront.set(st.sealed, fronts)).with("sealed", st.sealed + 1)
      .with("cutIn", WRITERS.mapBy(w => SLOTS.mapBy(q => st.cutIn.get(w).get(q) or
        (issued(st, w, q) and row(st, w, q).ep == st.sealed and q <= fronts.get(w)))))
      .with("rcvIn", WRITERS.mapBy(w => SLOTS.mapBy(q =>
        if (st.rcvIn.get(w).get(q) == -1 and issued(st, w, q) and (row(st, w, q).ep < st.sealed or q <= fronts.get(w)))
          st.sealed
        else st.rcvIn.get(w).get(q))))
      .with("maxLag", WRITERS.mapBy(w => if (live(st, w)) max2(st.maxLag.get(w), st.sealed - st.epoch.get(w))
        else st.maxLag.get(w)))
  action seal(fronts: str -> int): bool = all { sealEnabled(s, fronts), s' = sealState(s, fronts) }
  // Capacity follows the actual disposition. Expiry, review and readmission allocate only a fence;
  // counting displaced rows in those cases would exclude legal schedules near the finite bound.
  pure def installReplacementCount(st: State, w: str, newInc: bool): int =
    if (EXPIRE or MANUAL_REVIEW or newInc) 0 else displacedCount(st, w)
  pure def installEnabled(st: State, w: str, recvT: str -> int, mismatch: bool, crash: bool, partial: bool): bool = and {
    partial implies ALLOW_PARTIAL,
    live(st, w), st.sealed >= st.epoch.get(w) + 1, st.epoch.get(w) + 1 <= MAX_EPOCH,
    ADJACENT_ONLY implies st.sealed == st.epoch.get(w) + 1,
    st.next.get(w) + installReplacementCount(st, w, false) <= MAX_SEQ,
    recvChoices(st, w).contains(recvT),
    mismatch implies (ALLOW_MISMATCH and displacedCount(st, w) > 0),
    crash implies st.crashes.get(w) < MAX_CRASH,
  }
  // partial: the Writer installs without having received some member of the cut it closes (A1).
  action installP(w: str, recvT: str -> int, mismatch: bool, crash: bool, partial: bool): bool = all {
    installEnabled(s, w, recvT, mismatch, crash, partial), s' = installState(s, w, recvT, mismatch, crash, partial),
  }
  action install(w: str, recvT: str -> int, mismatch: bool, crash: bool): bool = installP(w, recvT, mismatch, crash, false)
  // An install whose cleanup pass crashes after J's commit (2) or between I's two commits (3). Contract only.
  action installMid(w: str, recvT: str -> int, crashPoint: int): bool = all {
    RULES.contract != "", crashPoint >= 2, crashPoint <= 3,
    installEnabled(s, w, recvT, false, true, false),
    s' = installToAt(s, w, s.epoch.get(w) + 1, false, recvT, false, crashPoint, false),
  }
  // Reopen after a crash: the cleanup pass runs again before the next install (contract only).
  action resume(w: str): bool = all {
    RULES.contract != "", s.term.get(w) == "", not(s.left.get(w)), not(s.cleaned.get(w)),
    s' = seenT(cleanupState(s.with("cleaned", s.cleaned.set(w, true)), w), w),
  }
  // A seal immediately followed by one Writer's install, as one step (two steps of `step`). Every run of
  // stepMacro is a run of step, so a violation it finds is real; it halves the depth Apalache needs.
  action sealInstall(fronts: str -> int, w: str, recvT: str -> int, mismatch: bool, crash: bool, partial: bool): bool = {
    val mid = sealState(s, fronts)
    all { sealEnabled(s, fronts), installEnabled(mid, w, recvT, mismatch, crash, partial),
      s' = installState(mid, w, recvT, mismatch, crash, partial) }
  }
  action sealInstallMid(fronts: str -> int, w: str, recvT: str -> int, crashPoint: int): bool = {
    val mid = sealState(s, fronts)
    all { RULES.contract != "", crashPoint >= 2, crashPoint <= 3,
      sealEnabled(s, fronts), installEnabled(mid, w, recvT, false, true, false),
      s' = installToAt(mid, w, mid.epoch.get(w) + 1, false, recvT, false, crashPoint, false) }
  }
  // A Writer that leaves (or crashes for good) never installs or replaces again. With ALLOW_READMIT it is
  // removed from the ACL and may be re-admitted as a new incarnation.
  action leave(w: str): bool = all {
    ALLOW_LEAVE or ALLOW_READMIT, live(s, w), ALLOW_READMIT or WRITERS.size() > 1, WRITERS.forall(v => not(s.left.get(v))),
    s' = s.with("left", s.left.set(w, true)),
  }
  // Rejoin (the contract's 6.2). In place: a live Writer lagging 2..REJOIN_K installs verifies the chain of
  // retained successor certificates and installs the creator's latest successor. As a new incarnation: a
  // removed Writer re-admitted, or one lagging beyond REJOIN_K (typed rejoin-required).
  pure def rejoinEnabled(st: State, w: str, newInc: bool, recvT: str -> int, crash: bool): bool = and {
    st.term.get(w) == "", st.sealed <= MAX_EPOCH, st.sealed >= st.epoch.get(w) + 1,
    st.next.get(w) + installReplacementCount(st, w, newInc) <= MAX_SEQ,
    recvChoices(st, w).contains(recvT),
    crash implies st.crashes.get(w) < MAX_CRASH,
    if (newInc) ALLOW_READMIT and st.admitted.get(w) == 0 and (st.left.get(w) or st.sealed - st.epoch.get(w) > REJOIN_K) and
      (st.left.get(w) or st.sealed - st.epoch.get(w) >= 2)
    else REJOIN_K >= 2 and not(st.left.get(w)) and st.sealed - st.epoch.get(w) >= 2 and st.sealed - st.epoch.get(w) <= REJOIN_K,
  }
  action rejoin(w: str, newInc: bool, recvT: str -> int, crash: bool): bool = all {
    rejoinEnabled(s, w, newInc, recvT, crash),
    s' = if (newInc and READMIT_FRESH) freshState(s, w, s.sealed, crash)
      else installTo(s, w, s.sealed, newInc, recvT, false, crash, ALLOW_PARTIAL),
  }
  // The application resolves a pending manual review: expire, or a replacement row in the current epoch.
  pure def resolveEnabled(st: State, w: str, x: int, toExpire: bool): bool =
    live(st, w) and x >= 0 and st.replOf.get(w).get(x) == -3 and
    ((MANUAL_REVIEW and st.plan.get(w).get(x) == -3) or st.exposed.get(w).contains(x)) and
    (toExpire or st.next.get(w) <= MAX_SEQ)
  // The resolution changes what is needed, so the last pass no longer counts as completed (G1 is measured
  // again after the next pass).
  pure def resolveState(st: State, w: str, x: int, toExpire: bool): State = resolveRows(st, w, x, toExpire)
    .with("cleaned", st.cleaned.set(w, false))
  pure def resolveRows(st: State, w: str, x: int, toExpire: bool): State =
    // Exposed old-incarnation work (readmitPolicy "preserve"): its source is not in this replica's store, so
    // the resolution names no plan entry; a replacement is an ordinary row of the new incarnation.
    if (st.exposed.get(w).contains(x)) {
      val q = st.next.get(w)
      val st1 = st.with("exposed", st.exposed.set(w, st.exposed.get(w).exclude(Set(x))))
      if (toExpire) st1.with("replOf", st.replOf.set(w, st.replOf.get(w).set(x, -2)))
      else st1.with("rows", st.rows.set(w, st.rows.get(w).set(q,
          { ep: st.epoch.get(w), kind: "repl", src: x, deriv: true, depth: row(st, w, x).depth + 1 })))
        .with("next", st.next.set(w, q + 1))
        .with("replOf", st.replOf.set(w, st.replOf.get(w).set(x, q)))
    }
    else if (toExpire)
      st.with("replOf", st.replOf.set(w, st.replOf.get(w).set(x, -2))).with("plan", st.plan.set(w, st.plan.get(w).set(x, -2)))
    else {
      val q = st.next.get(w)
      st.with("rows", st.rows.set(w, st.rows.get(w).set(q,
          { ep: st.epoch.get(w), kind: "repl", src: x, deriv: true, depth: row(st, w, x).depth + 1 })))
        .with("next", st.next.set(w, q + 1))
        .with("replOf", st.replOf.set(w, st.replOf.get(w).set(x, q)))
        .with("plan", st.plan.set(w, st.plan.get(w).set(x, q)))
    }
  action resolve(w: str, x: int, toExpire: bool): bool = all {
    resolveEnabled(s, w, x, toExpire), s' = resolveState(s, w, x, toExpire),
  }
  // The node store's physical prune, when it lags the logical retirement.
  action prune(w: str): bool = all { PRUNE_LAG, s.term.get(w) == "", s' = pruneState(s, w) }
  // Once the creator has sealed its last epoch, the run may idle.
  action stutter = all { s.sealed == MAX_EPOCH, s' = s }
  action step = {
    nondet w = WRITERS.oneOf()
    any {
      move(w),
      { nondet fronts = sealChoices(s).oneOf() seal(fronts) },
      {
        nondet recvT = recvChoices(s, w).oneOf()
        nondet mismatch = (if (ALLOW_MISMATCH) Set(false, true) else Set(false)).oneOf()
        nondet crash = Set(false, true).oneOf()
        nondet partial = (if (ALLOW_PARTIAL) Set(false, true) else Set(false)).oneOf()
        installP(w, recvT, mismatch, crash, partial)
      },
      leave(w),
      {
        nondet newInc = Set(false, true).oneOf()
        nondet recvT = recvChoices(s, w).oneOf()
        nondet crash = Set(false, true).oneOf()
        rejoin(w, newInc, recvT, crash)
      },
      { nondet x = SEQS.oneOf() nondet toExpire = Set(false, true).oneOf() resolve(w, x, toExpire) },
      prune(w),
      { nondet recvT = recvChoices(s, w).oneOf() nondet cp = Set(2, 3).oneOf() installMid(w, recvT, cp) },
      resume(w),
      stutter,
    }
  }
  // `step`, one action family at a time: the inductive step can be checked per family (their union is `step`;
  // stutter keeps every state invariant). Smaller SMT problems than the whole disjunction.
  action stepMove = { nondet w = WRITERS.oneOf() move(w) }
  action stepSeal = { nondet fronts = sealChoices(s).oneOf() seal(fronts) }
  action stepInstall = {
    nondet w = WRITERS.oneOf()
    nondet recvT = recvChoices(s, w).oneOf()
    nondet mismatch = (if (ALLOW_MISMATCH) Set(false, true) else Set(false)).oneOf()
    nondet crash = Set(false, true).oneOf()
    nondet partial = (if (ALLOW_PARTIAL) Set(false, true) else Set(false)).oneOf()
    installP(w, recvT, mismatch, crash, partial)
  }
  action stepRejoin = {
    nondet w = WRITERS.oneOf()
    nondet newInc = Set(false, true).oneOf()
    nondet recvT = recvChoices(s, w).oneOf()
    nondet crash = Set(false, true).oneOf()
    rejoin(w, newInc, recvT, crash)
  }
  action stepOther = {
    nondet w = WRITERS.oneOf()
    any {
      leave(w),
      { nondet x = SEQS.oneOf() nondet toExpire = Set(false, true).oneOf() resolve(w, x, toExpire) },
      prune(w),
      { nondet recvT = recvChoices(s, w).oneOf() nondet cp = Set(2, 3).oneOf() installMid(w, recvT, cp) },
      resume(w),
    }
  }
  action stepMacro = {
    nondet w = WRITERS.oneOf()
    nondet fronts = WRITERS.setOfMaps(SLOTS).oneOf()
    nondet recvT = WRITERS.setOfMaps(SLOTS).oneOf()
    nondet mismatch = (if (ALLOW_MISMATCH) Set(false, true) else Set(false)).oneOf()
    nondet crash = Set(false, true).oneOf()
    nondet partial = (if (ALLOW_PARTIAL) Set(false, true) else Set(false)).oneOf()
    any {
      move(w),
      seal(fronts),
      installP(w, recvT, mismatch, crash, partial),
      sealInstall(fronts, w, recvT, mismatch, crash, partial),
      leave(w),
      { nondet newInc = Set(false, true).oneOf() rejoin(w, newInc, recvT, crash) },
      { nondet x = SEQS.oneOf() nondet toExpire = Set(false, true).oneOf() resolve(w, x, toExpire) },
      prune(w),
      { nondet cp = Set(2, 3).oneOf() any { installMid(w, recvT, cp), sealInstallMid(fronts, w, recvT, cp) } },
      resume(w),
      stutter,
    }
  }

  // ---- Invariants -------------------------------------------------------------------------------
  // (a) No collected scope held a row its Writer still needs; no needed own row is retired or pruned.
  // One conjunct per own row (its scope collected, or the row retired or pruned), so each row's need is
  // evaluated once.
  pure def safetyOf(st: State): bool = WRITERS.forall(w =>
    EPOCHS.forall(e => (e <= st.epoch.get(w) and not(st.scopes.get(w).contains(e))) implies
      WRITERS.forall(b => SEQS.forall(q => recvRow(st, w, e, b, q) implies not(needsRecv(st, w, e))))) and
    SEQS.forall(q => (outside(st, w, q) and q >= st.incStart.get(w) and
      ((row(st, w, q).ep >= 0 and row(st, w, q).ep <= st.epoch.get(w) and not(st.scopes.get(w).contains(row(st, w, q).ep))) or
       (row(st, w, q).ep < st.sealed and (q <= st.wm.get(w) or st.retired.get(w).contains(q))))) implies
      not(needsLocal(st, w, q, MAX_EPOCH))))
  val safety = safetyOf(s)
  // (b) G1: after a completed pass, the protected count is bounded and every retained scope older than
  // the replay window holds a row the Writer still needs by what it knows (no protection without need).
  pure def protectedCount(st: State, w: str): int =
    EPOCHS.filter(e => st.scopes.get(w).contains(e) and e <= st.epoch.get(w) - 1).size()
  pure def retainedForNeed(st: State, w: str, e: int): bool =
    SEQS.exists(q => ownOutAt(st, w, q, e) and needsLocal(st, w, q, st.epoch.get(w) - 1)) or
    (WRITERS.exists(b => SEQS.exists(q => recvRow(st, w, e, b, q))) and needsRecv(st, w, e))
  pure def g1CountOf(st: State): bool =
    WRITERS.forall(w => (live(st, w) and st.cleaned.get(w)) implies protectedCount(st, w) <= G1_BOUND)
  // retainedForNeed for every scope, with each own row's need evaluated once.
  pure def g1NoLeakOf(st: State): bool = WRITERS.forall(w => (live(st, w) and st.cleaned.get(w)) implies {
    val neededEps = SEQS.filter(q => outside(st, w, q) and needsLocal(st, w, q, st.epoch.get(w) - 1)).map(q => row(st, w, q).ep)
    EPOCHS.forall(e => st.scopes.get(w).contains(e) implies (e > st.epoch.get(w) - 3 or neededEps.contains(e) or
      (WRITERS.exists(b => SEQS.exists(q => recvRow(st, w, e, b, q))) and needsRecv(st, w, e))))
  })
  val g1Count = g1CountOf(s)
  val g1NoLeak = g1NoLeakOf(s)
  val g1 = g1Count and g1NoLeak
  // (c) The plan never names retired or absent work unless the next merge drops it, no plan write is
  // refused, and the census never refuses a completed (derivation-equal) replacement or leaves a held
  // source unclassified.
  pure def planSoundOf(st: State): bool = WRITERS.forall(w => st.term.get(w) == "" implies
    if (RULES.contract != "") planClean(st, w, st.plan.get(w)) else
    SEQS.forall(q => st.plan.get(w).get(q) != -1 implies
      (droppable(q, st.plan.get(w).get(q), st.wm.get(w), st.retired.get(w)) or
        (q > st.wm.get(w) and not(st.retired.get(w).contains(q)) and (st.plan.get(w).get(q) < 0 or
          (st.plan.get(w).get(q) > st.wm.get(w) and not(st.retired.get(w).contains(st.plan.get(w).get(q)))))))))
  pure def noPlanRefusalOf(st: State): bool = planSoundOf(st) and WRITERS.forall(w => st.term.get(w) != "plan")
  // "census": a completed source the census does not recognise (R6); "orphan": a source the store still
  // holds above the signed frontier with no completed entry left to classify it.
  pure def noCensusRefusalOf(st: State): bool =
    WRITERS.forall(w => st.term.get(w) != "census" and st.term.get(w) != "orphan")
  val planSound = planSoundOf(s)
  val noPlanRefusal = noPlanRefusalOf(s)
  val noCensusRefusal = noCensusRefusalOf(s)
  val noTerminal = noPlanRefusal and noCensusRefusal
  // (d) No install refused by the journal bound.
  pure def withinMaxScopesOf(st: State): bool = WRITERS.forall(w => st.term.get(w) != "scopes")
  val withinMaxScopes = withinMaxScopesOf(s)
  // I5 (the contract), restricted to authors present in the installed ACL (astra H3): T never turns false
  // for a row the Writer has seen as signed terminal.
  pure def tMonotoneOf(st: State): bool = WRITERS.forall(w => not(st.left.get(w)) implies
    st.tSeen.get(w).forall(x => terminalBy(st, w, x, st.epoch.get(w) - 1)))
  val tMonotone = tMonotoneOf(s)
  // Need as owner-specific obligations (astra's point on 3.3): each store keeps its own copy for its own
  // consumers. The J copy of x: x's scope is in the replay window or x is not Done by the truth (safety).
  // The I copy: x's intent rests on it (safety, noIntentLoss), a live plan entry names it (planSound), the
  // census must classify it while it is present (noCensusRefusal). The proof of a member's scope: an I
  // copy whose Done needs it (proofHeld). A present I copy needed by the census does not keep the J copy.
  // H2: every own member of a collected scope that I has not yet retired still has its membership proof.
  pure def proofHeldOf(st: State): bool = WRITERS.forall(w => live(st, w) implies
    SEQS.forall(q => (proofConsumer(st, w, q, st.retired.get(w)) and row(st, w, q).ep <= st.epoch.get(w) and
      not(st.scopes.get(w).contains(row(st, w, q).ep))) implies memberProof(st, w, q)))
  val proofHeld = proofHeldOf(s)
  // I2 for the issuance store: after a completed pass, every own row of a scope collected before the last J
  // commit is logically retired, unless candidate (b) keeps it as a live entry's replacement.
  pure def guardedRow(st: State, w: str, q: int): bool =
    (RULES.planDrop == "eitherGuarded" or RULES.planDrop == "eitherGuardedOnePass") and
    SEQS.exists(x => st.plan.get(w).get(x) == q and not(st.retired.get(w).contains(x)))
  pure def iNoLeakOf(st: State): bool = WRITERS.forall(w => (live(st, w) and st.cleaned.get(w)) implies
    SEQS.forall(q => (held(st, w, q) and row(st, w, q).ep <= st.epoch.get(w) - 3 and
      not(st.scopes.get(w).contains(row(st, w, q).ep)) and not(st.jNew.get(w).contains(row(st, w, q).ep))) implies
      (st.retired.get(w).contains(q) or q <= st.wm.get(w) or guardedRow(st, w, q))))
  val iNoLeak = iNoLeakOf(s)
  // I3, over every incarnation: every own move ever issued is a Cut member, expired (by policy or by the
  // application), pending (held by its live replica or exposed to the application), or has a
  // derivation-equal replacement chain one of whose links is.
  pure def alive(st: State, w: str, q: int): bool =
    issued(st, w, q) and q >= st.incStart.get(w) and q > st.wm.get(w) and not(st.retired.get(w).contains(q))
  pure def intentHere(st: State, w: str, q: int): bool =
    inCut(st, w, q) or st.replOf.get(w).get(q) == -2 or alive(st, w, q) or st.exposed.get(w).contains(q)
  pure def intentOk(st: State, w: str, x: int): bool = intentHere(st, w, x) or
    1.to(MAX_EPOCH).fold({ cur: x, live: true, ok: false }, (acc, i) => {
      val y = st.replOf.get(w).get(acc.cur)
      val stepOk = acc.live and tlink(st, w, acc.cur, y)
      { cur: if (stepOk) y else acc.cur, live: stepOk, ok: acc.ok or (stepOk and intentHere(st, w, y)) }
    }).ok
  pure def noIntentLossOf(st: State): bool = WRITERS.forall(w =>
    SEQS.forall(q => (issued(st, w, q) and row(st, w, q).kind == "move") implies intentOk(st, w, q)))
  val noIntentLoss = noIntentLossOf(s)
  // The physical membership carriers a Writer holds (scopes held or awaiting I), against bounds 3-5.
  pure def carrierCount(st: State, w: str): int = st.carrier.get(w).filter(e => e <= st.epoch.get(w) - 1).size()
  val carriersAtMost3 = WRITERS.forall(w => live(s, w) implies carrierCount(s, w) <= 3)
  val carriersAtMost4 = WRITERS.forall(w => live(s, w) implies carrierCount(s, w) <= 4)
  val carriersAtMost5 = WRITERS.forall(w => live(s, w) implies carrierCount(s, w) <= 5)
  // The corrected contract's invariants beyond (a)-(d).
  val contractInvariants = tMonotone and proofHeld and iNoLeak and noIntentLoss
  val allInvariants = safety and g1 and noTerminal and withinMaxScopes
  // The root of the plan wedge: an own row the issuance retirement retired but the contiguous
  // watermark cannot prune, because a protected own row sits below it. Diagnostic, not in allInvariants.
  pure def noProtectedHoleOf(st: State): bool =
    WRITERS.forall(w => live(st, w) implies st.retired.get(w).forall(q => q <= st.wm.get(w)))
  val noProtectedHole = noProtectedHoleOf(s)
  // W1's kept authorities: the signed Cuts from the oldest held scope outside the replay window through
  // the latest the Writer installed past (its own and later ones). Measured against bounds 3, 4 and 5.
  pure def authoritiesKept(st: State, w: str): int =
    EPOCHS.filter(m => m <= st.epoch.get(w) - 1 and
      EPOCHS.exists(e => e <= m and e <= st.epoch.get(w) - 3 and st.scopes.get(w).contains(e))).size()
  val authoritiesAtMost3 = WRITERS.forall(w => live(s, w) implies authoritiesKept(s, w) <= 3)
  val authoritiesAtMost4 = WRITERS.forall(w => live(s, w) implies authoritiesKept(s, w) <= 4)
  val authoritiesAtMost5 = WRITERS.forall(w => live(s, w) implies authoritiesKept(s, w) <= 5)

  // ---- Inductive proof (Apalache) -----------------------------------------------------------------
  // indInv = the invariants (a)-(d) and noProtectedHole, plus the structural and delivery lemmas below.
  // Base: verify --init init --max-steps 0. Step: verify --init indInit --max-steps 1, where indInit is
  // an arbitrary state of the right shape satisfying indInv. Both passing proves every invariant in every
  // reachable state of the instance (any number of steps), not only along sampled or bounded runs.
  // The safety-only proof (indSafety) needs L0-L6; the full proof (indInv) needs all of them.
  pure def firstOfEpoch(st: State, w: str, q: int): bool =
    issued(st, w, q) and row(st, w, q).ep >= 1 and (q == 0 or row(st, w, q - 1).ep < row(st, w, q).ep)
  // L0-L6: structure. Enough for (a) safety.
  pure def structureOf(st: State, w: str): bool = and {
    // L0: ranges.
    st.epoch.get(w) >= 0, st.epoch.get(w) <= st.sealed,
    st.next.get(w) >= 0, st.next.get(w) <= MAX_SEQ + 1,
    st.wm.get(w) >= -1, st.wm.get(w) < st.next.get(w),
    st.start.get(w) >= 0, st.start.get(w) <= st.next.get(w),
    // L1: the installed epoch's rows run from its first row on; earlier rows are older.
    st.epoch.get(w) == 0 implies st.start.get(w) == 0,
    SEQS.forall(q => issued(st, w, q) implies and {
      row(st, w, q).ep >= 0, row(st, w, q).ep <= st.epoch.get(w),
      (q >= st.start.get(w)) iff (row(st, w, q).ep == st.epoch.get(w)),
    }),
    // L2: the installed epoch's scope is present; no scope is newer.
    st.scopes.get(w).contains(st.epoch.get(w)),
    st.scopes.get(w).forall(e => e <= st.epoch.get(w)),
    // L3: cut membership only for issued rows of sealed epochs.
    not(st.cutIn.get(w).get(-1)), not(st.cutIn.get(w).get(-2)), not(st.cutIn.get(w).get(-3)),
    SEQS.forall(q => st.cutIn.get(w).get(q) implies (issued(st, w, q) and row(st, w, q).ep < st.sealed)),
    // L4: a replacement link names an issued replacement of that source, one epoch later; an expire entry
    // (-2) names an issued row and exists only under the expire policy.
    st.replOf.get(w).get(-1) == -1, st.replOf.get(w).get(-2) == -1, st.replOf.get(w).get(-3) == -1,
    SEQS.forall(q => st.replOf.get(w).get(q) == -2 implies ((EXPIRE or ALLOW_READMIT or MANUAL_REVIEW) and issued(st, w, q))),
    st.carrier.get(w).forall(e => e <= st.epoch.get(w)),
    SEQS.forall(q => st.replOf.get(w).get(q) == -3 implies ((MANUAL_REVIEW or st.exposed.get(w).contains(q) or
      (q < st.incStart.get(w) and RULES.readmitPolicy == "abandon")) and issued(st, w, q))),
    st.admitted.get(w) <= st.epoch.get(w), ALLOW_READMIT or st.admitted.get(w) == 0,
    st.incStart.get(w) <= st.start.get(w), st.wm.get(w) >= st.incStart.get(w) - 1,
    (ALLOW_READMIT and READMIT_FRESH) or st.incStart.get(w) == 0,
    st.incStart.get(w) > 0 implies (st.admitted.get(w) > 0 and
      SEQS.forall(q => (issued(st, w, q) and q >= st.incStart.get(w)) implies row(st, w, q).ep >= st.admitted.get(w))),
    SEQS.forall(q => st.replOf.get(w).get(q) >= 0 implies and {
      issued(st, w, q), st.replOf.get(w).get(q) > q, issued(st, w, st.replOf.get(w).get(q)),
      row(st, w, st.replOf.get(w).get(q)).kind == "repl", row(st, w, st.replOf.get(w).get(q)).src == q,
      if (MANUAL_REVIEW or REJOIN_K >= 2 or q < st.incStart.get(w)) row(st, w, st.replOf.get(w).get(q)).ep >= row(st, w, q).ep + 1
      else row(st, w, st.replOf.get(w).get(q)).ep == row(st, w, q).ep + 1,
    }),
    st.exposed.get(w).forall(q => q < st.incStart.get(w) and issued(st, w, q) and st.replOf.get(w).get(q) == -3),
    RULES.readmitPolicy == "preserve" or st.exposed.get(w) == Set(),
    st.iProof.get(w).forall(q => issued(st, w, q) and inCut(st, w, q)),
    RULES.carrierLife == "handoff" or st.iProof.get(w) == Set(),
    // L5: a plan entry names the source's actual replacement.
    st.plan.get(w).get(-1) == -1, st.plan.get(w).get(-2) == -1, st.plan.get(w).get(-3) == -1,
    SEQS.forall(q => st.plan.get(w).get(q) != -1 implies st.plan.get(w).get(q) == st.replOf.get(w).get(q)),
    // L6: retired rows are issued rows of collected scopes; the watermark covers retired rows only.
    st.retired.get(w).forall(q => issued(st, w, q) and row(st, w, q).ep <= st.epoch.get(w) - 3 and
      not(st.scopes.get(w).contains(row(st, w, q).ep))),
    SEQS.forall(q => (q <= st.wm.get(w) and q >= st.incStart.get(w)) implies st.retired.get(w).contains(q)),
  }
  // L7-L13: what the rest of the invariants need. The schedule's facts (fences, depth, cuts as prefixes),
  // the order of collection, and the delivery assumptions as state facts.
  pure def scheduleOf(st: State, w: str): bool = and {
    // L7: rows. Sequences are issued in epoch order; a fence is exactly the first row of each epoch
    // from 1, and every installed epoch has rows; a replacement is one link deeper than its source,
    // other rows are depth 0; without injected mismatches every row derives from the policy.
    SEQS.forall(q => issued(st, w, q) implies and {
      Set("move", "fence", "repl").contains(row(st, w, q).kind),
      (row(st, w, q).kind == "fence") iff firstOfEpoch(st, w, q),
      row(st, w, q).kind != "repl" implies row(st, w, q).depth == 0,
      row(st, w, q).kind == "repl" implies (row(st, w, q).src >= 0 and row(st, w, q).src < q and
        st.replOf.get(w).get(row(st, w, q).src) == q),
      ALLOW_MISMATCH or row(st, w, q).deriv,
    }),
    SEQS.forall(q => SEQS.forall(p => (issued(st, w, p) and q < p) implies row(st, w, q).ep <= row(st, w, p).ep)),
    EPOCHS.forall(e => (e >= 1 and e <= st.epoch.get(w)) implies
      SEQS.exists(q => issued(st, w, q) and row(st, w, q).ep == e)),
    // L8: cuts. cut(m) holds a prefix of w's epoch-m rows; nothing is signed for an unsealed epoch.
    EPOCHS.forall(m => m >= st.sealed implies st.cutFront.get(m).get(w) == -1),
    EPOCHS.forall(m => st.cutFront.get(m).get(w) != -1 implies
      (issued(st, w, st.cutFront.get(m).get(w)) and row(st, w, st.cutFront.get(m).get(w)).ep == m)),
    SEQS.forall(q => inCut(st, w, q) iff (issued(st, w, q) and row(st, w, q).ep < st.sealed and
      q <= st.cutFront.get(row(st, w, q).ep).get(w))),
    // L9: replacements. A replaced row was outside its cut and not a fence, and its replacement is one
    // link deeper; every row the Writer displaced (outside its sealed cut, not a fence, of an epoch it
    // installed past) has its replacement.
    SEQS.forall(q => st.replOf.get(w).get(q) != -1 implies and {
      row(st, w, q).kind != "fence", not(inCut(st, w, q)),
      st.replOf.get(w).get(q) >= 0 implies row(st, w, st.replOf.get(w).get(q)).depth == row(st, w, q).depth + 1,
    }),
    SEQS.forall(q => (issued(st, w, q) and q >= st.incStart.get(w) and row(st, w, q).kind != "fence" and
      not(inCut(st, w, q)) and row(st, w, q).ep < st.epoch.get(w)) implies st.replOf.get(w).get(q) != -1),
    // L10: piece (2). A completed entry stays until piece (2) may drop it.
    SEQS.forall(q => st.replOf.get(w).get(q) != -1 implies (st.plan.get(w).get(q) == st.replOf.get(w).get(q) or
      droppable(q, st.replOf.get(w).get(q), st.wm.get(w), st.retired.get(w)))),
    // L11: no orphan. A held non-fence row of an epoch the Writer installed past, above every own cut
    // member, keeps its completed entry (the census classifies it).
    SEQS.forall(q => (issued(st, w, q) and row(st, w, q).kind != "fence" and row(st, w, q).ep < st.epoch.get(w) and
      q > st.wm.get(w) and SEQS.forall(p => inCut(st, w, p) implies p < q)) implies st.plan.get(w).get(q) != -1),
    // L12: collection order. Only scopes outside the replay window are collected, oldest first (the
    // collected scopes are a prefix), and every closed epoch has its carrier (pieces (1) and row 64).
    EPOCHS.forall(e => (e <= st.epoch.get(w) and not(st.scopes.get(w).contains(e))) implies
      (e <= st.epoch.get(w) - 3 and EPOCHS.forall(d => d < e implies not(st.scopes.get(w).contains(d))))),
    (RULES.carrierProof or (RULES.minusOwn and RULES.minusOthers and not(ALLOW_PARTIAL))) implies
      EPOCHS.forall(e => e < st.epoch.get(w) implies st.carrier.get(w).contains(e)),
    // L13: delivery, for a live Writer. An outside row of a sealed epoch is at most MAX_MISS - 1 links
    // deep; a row of the installed epoch still to be replaced has room for the seals the Writer is
    // behind; no MAX_MISS + 1 sealed epochs in a row miss its fence (epoch 0 has none).
    live(st, w) implies and {
      SEQS.forall(q => (issued(st, w, q) and row(st, w, q).kind != "fence" and not(inCut(st, w, q)) and
        row(st, w, q).ep < st.sealed) implies row(st, w, q).depth <= MAX_MISS - 1),
      SEQS.forall(q => (issued(st, w, q) and row(st, w, q).kind != "fence" and not(inCut(st, w, q)) and
        row(st, w, q).ep == st.epoch.get(w)) implies row(st, w, q).depth + (st.sealed - st.epoch.get(w)) <= MAX_MISS),
      EPOCHS.forall(m => (m >= 1 and m <= st.sealed - 1) implies
        0.to(FENCE_PACE).exists(j => m - j < 1 or st.cutFront.get(m - j).get(w) != -1)),
    },
  }
  pure def indSafetyOf(st: State): bool =
    st.sealed >= 0 and st.sealed <= MAX_EPOCH and WRITERS.forall(w => structureOf(st, w)) and safetyOf(st)
  pure def indLemmasOf(st: State): bool =
    st.sealed >= 0 and st.sealed <= MAX_EPOCH and WRITERS.forall(w => structureOf(st, w) and scheduleOf(st, w))
  pure def indInvOf(st: State): bool = and {
    indLemmasOf(st), safetyOf(st), g1CountOf(st), g1NoLeakOf(st), noPlanRefusalOf(st), noCensusRefusalOf(st),
    withinMaxScopesOf(st), noProtectedHoleOf(st), WRITERS.forall(w => st.term.get(w) == ""),
  }
  val indSafety = indSafetyOf(s)
  val indLemmas = indLemmasOf(s)
  val noTerm = WRITERS.forall(w => s.term.get(w) == "")
  val indInv = indInvOf(s)
  pure val EPX = (-1).to(MAX_EPOCH)
  pure val KINDS = Set("none", "move", "fence", "repl")
  pure val TERMS = Set("", "plan", "orphan", "mismatch", "census", "scopes")
  pure val BOOLS = Set(false, true)
  // An arbitrary state of the right shape (the start of the inductive step), before the hypothesis.
  action anyState(hyp: State => bool): bool = {
    nondet sealed = 0.to(MAX_EPOCH).oneOf()
    nondet cutFront = EPOCHS.setOfMaps(WRITERS.setOfMaps(SLOTS)).oneOf()
    nondet rEp = tuples(WRITERS, SLOTS).setOfMaps(EPX).oneOf()
    nondet rKind = tuples(WRITERS, SLOTS).setOfMaps(KINDS).oneOf()
    nondet rSrc = tuples(WRITERS, SLOTS).setOfMaps(SLOTS).oneOf()
    nondet rDeriv = tuples(WRITERS, SLOTS).setOfMaps(BOOLS).oneOf()
    nondet rDepth = tuples(WRITERS, SLOTS).setOfMaps(0.to(MAX_EPOCH)).oneOf()
    nondet cutIn = tuples(WRITERS, SLOTS).setOfMaps(BOOLS).oneOf()
    nondet rcvIn = tuples(WRITERS, SLOTS).setOfMaps(EPX).oneOf()
    nondet gNext = WRITERS.setOfMaps(0.to(MAX_SEQ + 1)).oneOf()
    nondet start = WRITERS.setOfMaps(0.to(MAX_SEQ + 1)).oneOf()
    nondet moves = WRITERS.setOfMaps(0.to(MAX_MOVES)).oneOf()
    nondet epoch = WRITERS.setOfMaps(EPOCHS).oneOf()
    nondet scopes = tuples(WRITERS, EPOCHS).setOfMaps(BOOLS).oneOf()
    nondet carrier = tuples(WRITERS, EPOCHS).setOfMaps(BOOLS).oneOf()
    nondet lacked = tuples(WRITERS, EPOCHS).setOfMaps(BOOLS).oneOf()
    nondet recv = tuples(WRITERS, EPOCHS, WRITERS).setOfMaps(SLOTS).oneOf()
    nondet replOf = tuples(WRITERS, SLOTS).setOfMaps(SLOTS).oneOf()
    nondet plan = tuples(WRITERS, SLOTS).setOfMaps(SLOTS).oneOf()
    nondet retired = tuples(WRITERS, SEQS).setOfMaps(BOOLS).oneOf()
    nondet wm = WRITERS.setOfMaps(SLOTS).oneOf()
    nondet term = WRITERS.setOfMaps(TERMS).oneOf()
    nondet cleaned = WRITERS.setOfMaps(BOOLS).oneOf()
    nondet crashes = WRITERS.setOfMaps(0.to(MAX_CRASH)).oneOf()
    nondet left = WRITERS.setOfMaps(BOOLS).oneOf()
    nondet maxLag = WRITERS.setOfMaps(0.to(MAX_EPOCH)).oneOf()
    nondet lostThrough = WRITERS.setOfMaps(EPX).oneOf()
    nondet admitted = WRITERS.setOfMaps(EPOCHS).oneOf()
    nondet tSeen = tuples(WRITERS, SEQS).setOfMaps(BOOLS).oneOf()
    nondet incStart = WRITERS.setOfMaps(0.to(MAX_SEQ + 1)).oneOf()
    nondet iProof = tuples(WRITERS, SEQS).setOfMaps(BOOLS).oneOf()
    nondet jNew = tuples(WRITERS, EPOCHS).setOfMaps(BOOLS).oneOf()
    nondet exposed = tuples(WRITERS, SEQS).setOfMaps(BOOLS).oneOf()
    val st: State = {
      sealed: sealed,
      cutFront: cutFront,
      rows: WRITERS.mapBy(w => SLOTS.mapBy(q => { ep: rEp.get((w, q)), kind: rKind.get((w, q)),
        src: rSrc.get((w, q)), deriv: rDeriv.get((w, q)), depth: rDepth.get((w, q)) })),
      cutIn: WRITERS.mapBy(w => SLOTS.mapBy(q => cutIn.get((w, q)))),
      rcvIn: WRITERS.mapBy(w => SLOTS.mapBy(q => rcvIn.get((w, q)))),
      maxLag: maxLag,
      next: gNext,
      start: start,
      moves: moves,
      epoch: epoch,
      scopes: WRITERS.mapBy(w => EPOCHS.filter(e => scopes.get((w, e)))),
      carrier: WRITERS.mapBy(w => EPOCHS.filter(e => carrier.get((w, e)))),
      lacked: WRITERS.mapBy(w => EPOCHS.filter(e => lacked.get((w, e)))),
      recv: WRITERS.mapBy(w => EPOCHS.mapBy(e => WRITERS.mapBy(b => recv.get((w, e, b))))),
      replOf: WRITERS.mapBy(w => SLOTS.mapBy(q => replOf.get((w, q)))),
      plan: WRITERS.mapBy(w => SLOTS.mapBy(q => plan.get((w, q)))),
      retired: WRITERS.mapBy(w => SEQS.filter(q => retired.get((w, q)))),
      wm: wm,
      term: term,
      cleaned: cleaned,
      crashes: crashes,
      left: left,
      lostThrough: lostThrough,
      admitted: admitted,
      tSeen: WRITERS.mapBy(w => SEQS.filter(q => tSeen.get((w, q)))),
      incStart: incStart,
      iProof: WRITERS.mapBy(w => SEQS.filter(q => iProof.get((w, q)))),
      jNew: WRITERS.mapBy(w => EPOCHS.filter(e => jNew.get((w, e)))),
      exposed: WRITERS.mapBy(w => SEQS.filter(q => exposed.get((w, q)))),
    }
    all { hyp(st), s' = st }
  }
  action indInitSafety = anyState(indSafetyOf)
  action indInit = anyState(indInvOf)
  // Candidate induction hypothesis for the contract, with no delivery lemma. indContract = indSafety (L0-L6 and
  // safety) + the lemmas below + every invariant of the class: planSound, noPlanRefusal, noCensusRefusal,
  // tMonotone (I5), proofHeld (H2), iNoLeak (I2 for I), I3 over every move and replacement, and g1NoLeak (a
  // retained scope always holds a needed row: no leak, whatever the delays; only the count bound needs
  // delivery). No lemma states a delivery assumption. Fresh-replica instances with F1 and carrierLife
  // "consumers" only.
  // The install displaces a contiguous suffix after the epoch fence. The hypothesis must preserve the
  // row shape established by move/install/freshState: otherwise an impossible epoch-zero fence can be
  // displaced and evade the non-fence census when a mismatched replacement is injected.
  pure def contractRowShapeOf(st: State, w: str): bool = SEQS.forall(q => issued(st, w, q) implies and {
    Set("move", "fence", "repl").contains(row(st, w, q).kind),
    (row(st, w, q).kind == "fence") iff firstOfEpoch(st, w, q),
    st.replOf.get(w).get(q) != -1 implies (row(st, w, q).kind != "fence" and not(inCut(st, w, q))),
  })
  pure def contractLemmasOf(st: State, w: str): bool = and {
    // C9: fences occupy their epoch's first slot and never have settlement-plan entries.
    contractRowShapeOf(st, w),
    // L8: cut membership is the per-epoch signed prefix; nothing is signed for an unsealed epoch.
    EPOCHS.forall(m => m >= st.sealed implies st.cutFront.get(m).get(w) == -1),
    EPOCHS.forall(m => st.cutFront.get(m).get(w) != -1 implies
      (issued(st, w, st.cutFront.get(m).get(w)) and row(st, w, st.cutFront.get(m).get(w)).ep == m)),
    SEQS.forall(q => inCut(st, w, q) iff (issued(st, w, q) and row(st, w, q).ep < st.sealed and
      q <= st.cutFront.get(row(st, w, q).ep).get(w))),
    // C1: every issued row derives from the policy (a mismatched replacement refuses its own install).
    SEQS.forall(q => issued(st, w, q) implies row(st, w, q).deriv),
    // C2: the replica's rows are of its incarnation's epochs; the old incarnation's are older.
    SEQS.forall(q => held(st, w, q) implies row(st, w, q).ep >= st.admitted.get(w)),
    SEQS.forall(q => (issued(st, w, q) and q < st.incStart.get(w)) implies row(st, w, q).ep < st.admitted.get(w)),
    // C3 (L9 for held rows): a displaced held row of an epoch the Writer installed past has its
    // replacement, expire or review entry.
    SEQS.forall(q => (held(st, w, q) and row(st, w, q).kind != "fence" and not(inCut(st, w, q)) and
      row(st, w, q).ep < st.epoch.get(w)) implies st.replOf.get(w).get(q) != -1),
    // C4 (L10 for the contract): a held source keeps its entry until it is logically retired or pruned.
    SEQS.forall(q => (held(st, w, q) and st.replOf.get(w).get(q) != -1) implies
      (st.plan.get(w).get(q) == st.replOf.get(w).get(q) or q <= st.wm.get(w) or st.retired.get(w).contains(q))),
    // C5: a logically retired row is signed terminal by the installed cuts (I retires Done rows only).
    st.retired.get(w).forall(q => terminalBy(st, w, q, st.epoch.get(w) - 1)),
    // C6: an absent scope holding held rows was collected, so it is older than the replay window.
    SEQS.forall(q => (held(st, w, q) and not(st.scopes.get(w).contains(row(st, w, q).ep))) implies
      row(st, w, q).ep <= st.epoch.get(w) - 3),
    // C7: a held row of a collected scope that I has not retired or pruned is Done as I re-derives it.
    live(st, w) implies SEQS.forall(q => (held(st, w, q) and not(st.scopes.get(w).contains(row(st, w, q).ep)) and
      not(st.retired.get(w).contains(q)) and q > st.wm.get(w)) implies iDone(st, w, q)),
    // C8 (F1): every present scope of a closed epoch has its membership proof.
    st.scopes.get(w).forall(e => e < st.epoch.get(w) implies st.carrier.get(w).contains(e)),
  }
  // I3 over every own move and replacement (noIntentLoss is over moves): the induction needs the links.
  pure def noIntentLossAllOf(st: State): bool = WRITERS.forall(w =>
    SEQS.forall(q => (issued(st, w, q) and row(st, w, q).kind != "fence") implies intentOk(st, w, q)))
  val noIntentLossAll = noIntentLossAllOf(s)
  pure def indContractOf(st: State): bool = and {
    indSafetyOf(st), WRITERS.forall(w => contractLemmasOf(st, w)),
    planSoundOf(st), noPlanRefusalOf(st), noCensusRefusalOf(st), tMonotoneOf(st), proofHeldOf(st), iNoLeakOf(st),
    noIntentLossAllOf(st), g1NoLeakOf(st),
  }
  val indContract = indContractOf(s)
  val contractLemmas = WRITERS.forall(w => contractLemmasOf(s, w))
  action indInitContract = anyState(indContractOf)
  // Non-vacuity: the hypothesis admits rich states (a Writer three epochs on, with a collected scope and
  // a held outside row). Expected VIOLATED from indInit at --max-steps 0.
  val indRichStateAbsent = not(WRITERS.exists(w => s.epoch.get(w) >= 4 and s.scopes.get(w).size() >= 2 and
    not(s.scopes.get(w).contains(0)) and SEQS.exists(q => outside(s, w, q) and row(s, w, q).ep < s.epoch.get(w) and
    s.scopes.get(w).contains(row(s, w, q).ep))))
  // The same for the reduced instance (epochs 0-3): scope 0 collected, a held outside row of a kept scope.
  val indRichStateAbsent3 = not(WRITERS.exists(w => s.epoch.get(w) >= 3 and not(s.scopes.get(w).contains(0)) and
    SEQS.exists(q => held(s, w, q) and outside(s, w, q) and row(s, w, q).ep < s.epoch.get(w) and
    s.scopes.get(w).contains(row(s, w, q).ep))))

  // ---- Witnesses (each must be reachable) -------------------------------------------------------
  pure def collectedOutside(st: State, w: str, q: int): bool =
    outside(st, w, q) and row(st, w, q).ep < st.sealed and row(st, w, q).ep < st.epoch.get(w) and
    not(st.scopes.get(w).contains(row(st, w, q).ep))
  // A late move whose scope its Writer collected.
  val reachedLateMove = WRITERS.exists(w => SEQS.exists(x => row(s, w, x).kind == "move" and collectedOutside(s, w, x)))
  // A double miss (the replacement missed too, its replacement landed) whose source scope was collected.
  val reachedDoubleMiss = WRITERS.exists(w => SEQS.exists(x => row(s, w, x).kind == "move" and collectedOutside(s, w, x) and {
    val r = s.replOf.get(w).get(x)
    r >= 0 and row(s, w, r).ep < s.sealed and not(inCut(s, w, r)) and inCut(s, w, s.replOf.get(w).get(r))
  }))
  // A whole install output (fence and replacement) outside the next cut, and the Writer installed past it.
  val reachedWholeInstallMiss = WRITERS.exists(w => SEQS.exists(f => row(s, w, f).kind == "fence" and
    outside(s, w, f) and row(s, w, f).ep < s.sealed and row(s, w, f).ep + 1 < s.epoch.get(w) and
    SEQS.exists(r => row(s, w, r).kind == "repl" and row(s, w, r).ep == row(s, w, f).ep and outside(s, w, r))))
  // Two Writers both late in one epoch, one admitting the other's outside row, both live past it.
  val reachedTwoWritersLate = WRITERS.exists(a => WRITERS.exists(b => a != b and EPOCHS.exists(e =>
    s.recv.get(a).get(e).get(b) != -1 and SEQS.exists(q => ownOutAt(s, a, q, e)) and live(s, a) and live(s, b) and
    s.epoch.get(a) >= e + 3)))
  // A crash between install and cleanup, then a completed pass.
  val reachedCrashThenCleanup = WRITERS.exists(w => s.crashes.get(w) > 0 and s.cleaned.get(w) and live(s, w))
  // A triple miss (a move and two replacements outside their cuts, the third landed), source scope collected.
  val reachedTripleMiss = WRITERS.exists(w => SEQS.exists(x => row(s, w, x).kind == "move" and collectedOutside(s, w, x) and {
    val r1 = s.replOf.get(w).get(x)
    val r2 = s.replOf.get(w).get(r1)
    r1 >= 0 and r2 >= 0 and outside(s, w, r1) and row(s, w, r1).ep < s.sealed and outside(s, w, r2) and
      row(s, w, r2).ep < s.sealed and inCut(s, w, s.replOf.get(w).get(r2))
  }))
  // A Writer offline across at least two seals that caught up and collected a scope with an outside fence.
  val reachedOfflineAcrossWindow = WRITERS.exists(w => s.maxLag.get(w) >= 2 and live(s, w) and s.cleaned.get(w) and
    SEQS.exists(f => row(s, w, f).kind == "fence" and collectedOutside(s, w, f)))
  // A Writer's fences of two epochs in a row both outside their cuts, and both scopes collected.
  val reachedFenceDoubleMiss = WRITERS.exists(w => SEQS.exists(f => row(s, w, f).kind == "fence" and
    collectedOutside(s, w, f) and SEQS.exists(g => row(s, w, g).kind == "fence" and
      row(s, w, g).ep == row(s, w, f).ep + 1 and collectedOutside(s, w, g))))
  // A scope with an outside fence and an outside move whose replacement also missed, collected.
  val reachedFenceAndChain = WRITERS.exists(w => SEQS.exists(f => row(s, w, f).kind == "fence" and
    collectedOutside(s, w, f) and SEQS.exists(x => row(s, w, x).kind == "move" and row(s, w, x).ep == row(s, w, f).ep and
      outside(s, w, x) and {
        val r = s.replOf.get(w).get(x)
        r >= 0 and row(s, w, r).ep < s.sealed and not(inCut(s, w, r))
      })))
  // A1: a scope whose cut the Writer closed without every member, collected by a live Writer.
  val reachedPartialCollected = WRITERS.exists(w => live(s, w) and s.lacked.get(w).exists(e =>
    e <= s.epoch.get(w) and not(s.scopes.get(w).contains(e))))
  // A2: an expired outside move whose scope a live Writer collected.
  val reachedExpiredCollected = WRITERS.exists(w => live(s, w) and SEQS.exists(x => s.replOf.get(w).get(x) == -2 and
    collectedOutside(s, w, x)))
  // The contract: a source collected before its replacement chain lands in any signed cut (it waits only
  // for its terminal frontier and a durable replacement). This is the change to rows 62/65.
  val reachedCollectedBeforeLanding = WRITERS.exists(w => SEQS.exists(x => row(s, w, x).kind != "fence" and
    collectedOutside(s, w, x) and s.replOf.get(w).get(x) >= 0 and not(chainScan(s, w, x, MAX_EPOCH, false))))
  // A move whose chain missed four cuts in a row (the move and three replacements), source scope collected.
  val reachedQuadMissCollected = WRITERS.exists(w => SEQS.exists(x => row(s, w, x).kind == "move" and
    collectedOutside(s, w, x) and {
      val r1 = s.replOf.get(w).get(x)
      val r2 = s.replOf.get(w).get(r1)
      val r3 = s.replOf.get(w).get(r2)
      r1 >= 0 and r2 >= 0 and r3 >= 0 and outside(s, w, r1) and row(s, w, r1).ep < s.sealed and
        outside(s, w, r2) and row(s, w, r2).ep < s.sealed and outside(s, w, r3) and row(s, w, r3).ep < s.sealed
    }))
  // A Writer re-admitted as a new incarnation that collected a scope holding rows its replica holds (the
  // same replica: a scope of its old incarnation; a fresh replica: a scope of its new incarnation).
  val reachedReadmitCollected = WRITERS.exists(w => live(s, w) and s.admitted.get(w) > 0 and
    EPOCHS.exists(e => e >= 1 and e <= s.epoch.get(w) and not(s.scopes.get(w).contains(e)) and
      SEQS.exists(q => held(s, w, q) and row(s, w, q).ep == e)))
  // A fresh replica (sequences restarted) whose new row has the native sequence of an earlier incarnation's
  // cut member, the case (author, sequence) identity confuses.
  val reachedSeqCollision = WRITERS.exists(w => s.incStart.get(w) > 0 and SEQS.exists(q => held(s, w, q) and
    SEQS.exists(p => p < s.incStart.get(w) and inCut(s, w, p) and nseq(s, w, p) == nseq(s, w, q))))
  // A Writer that rejoined in place (lag of 2 or more, no new incarnation) and later completed a pass.
  val reachedRejoinInPlace = WRITERS.exists(w => live(s, w) and s.admitted.get(w) == 0 and s.maxLag.get(w) >= 2 and
    s.cleaned.get(w) and s.epoch.get(w) >= 2)
  // A manual review resolved (expired or replaced) whose source scope a live Writer collected.
  val reachedReviewCollected = WRITERS.exists(w => live(s, w) and SEQS.exists(x => row(s, w, x).kind == "move" and
    collectedOutside(s, w, x) and s.replOf.get(w).get(x) != -1))
  // H2: after a crash, a completed pass in which I retired an own cut member (not a fence).
  val reachedMemberRetiredAfterCrash = WRITERS.exists(w => s.crashes.get(w) > 0 and s.cleaned.get(w) and live(s, w) and
    s.retired.get(w).exists(q => inCut(s, w, q) and row(s, w, q).kind != "fence"))
  // A collected scope whose proof is still held for I (carrierLife "consumers"), or handed off per row.
  val reachedProofAfterScope = WRITERS.exists(w => SEQS.exists(q => proofConsumer(s, w, q, s.retired.get(w)) and
    not(s.scopes.get(w).contains(row(s, w, q).ep)) and row(s, w, q).ep < s.epoch.get(w) and memberProof(s, w, q)))
  // H3: old-incarnation work expired by the re-admission, or exposed and then resolved by a replacement row.
  val reachedOldWorkExpired = WRITERS.exists(w => s.incStart.get(w) > 0 and
    SEQS.exists(q => q < s.incStart.get(w) and row(s, w, q).kind != "fence" and s.replOf.get(w).get(q) == -2))
  val reachedExposedResolved = WRITERS.exists(w => s.incStart.get(w) > 0 and
    SEQS.exists(q => q < s.incStart.get(w) and s.replOf.get(w).get(q) >= s.incStart.get(w)))
  // Need: the J copy is gone while the I copy is still present and unretired (the census still reads it).
  val reachedJGoneIPresent = WRITERS.exists(w => live(s, w) and SEQS.exists(q => held(s, w, q) and
    q > s.wm.get(w) and not(s.retired.get(w).contains(q)) and row(s, w, q).ep < s.epoch.get(w) and
    not(s.scopes.get(w).contains(row(s, w, q).ep))))
  // Need: own rows are physically pruned (the I copy is deletable).
  val reachedOwnPruned = WRITERS.exists(w => live(s, w) and s.wm.get(w) >= s.incStart.get(w) + 1)
  // A logically retired own row still physically present (the prune lags).
  val reachedRetiredPresent = WRITERS.exists(w => s.retired.get(w).exists(q => q > s.wm.get(w)))
  // A live Writer whose fences missed more than maxScopes cuts in a row, and which installed past them.
  val reachedLongFenceRun = WRITERS.exists(w => live(s, w) and s.cleaned.get(w) and EPOCHS.exists(m =>
    m >= 1 and m + MAX_SCOPES < s.sealed and s.epoch.get(w) >= m + MAX_SCOPES + 1 and
    0.to(MAX_SCOPES).forall(j => s.cutFront.get(m + j).get(w) == -1)))
}
