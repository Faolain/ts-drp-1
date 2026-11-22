# Track R: verdict per redesign step

Guarantee ids refer to GUARANTEES.md in this directory.

## Step 1: revision counters + Web Locks replacing the keep-alive pump

As proposed, this step cannot be done without weakening guarantees.

* Exclusion. A Web Lock only excludes code that asks for it. The spec says explicitly that "Neither scope
  Web Locks nor a recovery reader is relabeled full native exclusion" (R2E:2897, G12). It also says Web Locks are
  "advisory scheduling" that "never decide eligibility" and that there is "No deletion by a Web Lock" (6B:64,
  6B:180-182, G13).
  * The held all-store readonly transaction is what makes a foreign READWRITE transaction (another tab, a stale or
    legacy connection, or a worker) wait natively. A lock that every writer is supposed to take is cooperative.
    A stale connection running older code would not take it.
  * Making it equivalent would also mean every readwrite site in six stores takes a lock, plus a schema-version
    fence for old connections (G25). That would add a lock round trip to every gameplay write.
* Cache currency. A per-database revision counter written by cooperating writers fails two ways:
  * it rolls back together with the data (G6);
  * the spec models a counterexample: "a different eligible native head with unchanged control
    revision/incarnation was incorrectly accepted" (R2E:4958-4959, G11).
  * Browser currency reuse is allowed only "while that exact original all-store transaction remains held"
    (R2E:137-140, R2E:1456-1458).
* The sentinel spin cannot be paced. An IndexedDB transaction auto-commits at the first task boundary with no
  pending request, and requests can only be placed while it is active. The spin rate is one round trip per
  sentinel, which is intrinsic.

What can be done soundly is reduce what the pump costs without changing what it guarantees. See "Landed" below.

## Step 2: carry verified facts across passes (revision-stamp currency check)

As proposed (skip the fresh read when a stamp is unchanged), this step cannot be done.

* G10: "Immutable syntax and signed facts may outlive one stage; native currency, progress and authority may not"
  (R2E:34-36).
* G5: durable bytes are untrusted.
* G11: currency comes only from the held transaction.

The part that is allowed is already in the base:

* the job-scoped syntax/evidence owner (3c5bb123);
* exact-byte memos for Ed25519, transition inspection, anchor trust verdicts and canonical exactness (4c4f192c).

Track E measured that further codec-level memoization does not move lull time.

The irreducible per-pass work under G5/G10/G11 is:

1. a fresh native read of what the pass relies on, under held native views;
2. an exact comparison against carried signed facts;
3. a fresh proof book (G22);
4. the participant two-phase commit (G9, G14).

The remaining waste is re-encoding structured rows only to compare or charge them. Removing it needs rows stored
as exact canonical bytes, which is a storage-format change (see Step 4).

## Step 3: fuse the four passes into one

The spec allows it: stage exclusivity is an implementation choice, not a requirement. It cannot land as a code
change in this cycle, because it changes durable, protocol-visible formats:

* The decision carrier encodes one `policy` string chosen by precedence
  (`closedRetirementDecisionCarrierFields`: generation > summary > evidence > journal). A fused decision needs a
  new policy value and new source-proof digest domains:
  * `ts-drp/closed-retirement-source/v1|v2|v3`;
  * `closed-retirement-resume-basis/v2`;
  * `closed-ahe-retirement-resume-basis/v3`.
* The AHE control holds exactly one `completed.generationDrain` (`packages/storage/src/retirement-control.ts`
  `AheRetirementControl`). Two generation drains in one pass need a list there: a new control kind with
  migration.
* A summary drain's `eligibilityFence` is the completed evidence preparation
  (`seal/src/internal/signing-storage-codec.ts` `preparation()`: every summary entry must already be
  `retired(captured, …)` and `monotone(eligibilityFence, captured)`). Evidence and summaries are causally
  sequential in the durable format: summaries become eligible only after the evidence retirement has committed.
* The fused proof book must fit `maintenanceProofBytes` (4 MiB), or a new budget must be reviewed policy
  (G21, G22, BSL:261-263).
* Phase 6b scopes "No wire-format, digest-domain … change" (6B:63), so this needs its own spec slice with
  three-engine native and SIGKILL evidence (G28).

Expected gain, from Track E's no-op extra-pass ablation (0.44–0.86 s per pass of fixed cost): about
2.7 s → 0.9–1.1 s.
