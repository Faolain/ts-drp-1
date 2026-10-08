# D.110c-0c1f5b0 governing design review

## Reviewed checkpoint

- signed/pushed commit: `fc4b8fc78148e5211b09dc32e3f27f32756653ec`
- design evidence manifest:
  `a5dbd4f4bfd4df8d8b838ce057ac524706ab583a93e63cf527dd2a941ca87011`
- scope: exact author-settlement carrier, checkpoint, compatibility, recovery,
  pruning, and bounded-state design; f5b0a RED authorization only

## Reviewer terminals

- Grok 4.6/high: process exited 0 after 735.43 seconds with `end_turn` and a
  complete `CHANGES_REQUIRED` JSON object in `grok/public.txt`. The wrapper
  classified the stream `NO_VERDICT` because explanatory prose preceded the
  JSON; this was a parser classification, not a service cancellation and not
  an absent substantive verdict. Findings: two P1 and two P2. RED denied. The
  byte-exact Grok directory is preserved in `grok-session.zip` with SHA-256
  `8545840b4ee5ee66e56d32b7c10721261abeb2129fc42074b377619c57d38c5a`.
- direct Kimi K3, `KIMI_LOOP_MAX_STEPS_PER_TURN=100`: session
  `session_93fa96df-228b-46f9-9fe9-dcc4fe557476` completed `APPROVED` with
  zero P0/P1 and six P2. RED authorized only for f5b0a. The exact exported
  session ZIP has SHA-256
  `18ec2bd803fc59bc1748b2ee2eb78f5b6c5e0f6d4477e0856433cb6b15bae4e8`.
- Opus xhigh: session `0fc1546e-2300-452c-9f74-f2ab7e1deba2`
  completed `CHANGES_REQUIRED` with two P0, five P1, and five P2. RED denied.
  Its exact session JSONL has SHA-256
  `4fa9e8ca20523ed13b8e6ec95e307844a5a8795b13e0ffa7b6f18fd8561c0006`.

The blocking union is nonempty. No RED, production edit, retained test, or
campaign was run.

## Blocking-union disposition

1. The advertised 16-source/16-intent/16-replacement maximum exceeded the
   unchanged 8,192-byte operation ceiling. The amendment reduces each total
   count to eight and records a 6,003-byte exact maximum-shape measurement,
   leaving 2,189 bytes of margin.
2. Honest zero-intent Node slots were unrepresentable. The amendment adds one
   exact `zero-intent` source for `join`, `causalJoin`, and `acl`; it is
   author-signed negative authority and never claims an application effect.
3. The current close-graph map is also the blueprint fold map. The amendment
   assigns f5b0b an exact control/application split: the complete union owns
   index, charge, frontier, close-set, history, and creator scanning, while
   only the application subset reaches the unchanged compaction fold.
4. The baseline relied on caller-local lineage and permitted a removed key to
   reset. The amendment deletes it. The repository lacks a bounded
   creator-authenticated way to prove whether an absent key appeared before;
   this is isolated as blocking prerequisite D.110c-0c1f5b0p. Unbounded
   tombstones, fixture claims, and a lifetime-64-author cap are rejected.
5. Existing issuance pruning rejects a mixed-epoch prefix. f5b0d now owns an
   exact storage-neutral `pruneAuthenticatedSettledPrefix` CAS/delete contract,
   memory/browser implementations, conformance, and cleanup integration; all
   v1 pruning remains unchanged.
6. Every blueprint-bound authentication/recovery path would reject a control
   row. The amendment enumerates local issue, ingress, pinned-genesis,
   covered-historical, displaced/current, and journal-replay disposition and
   assigns the dedicated control issuer/authenticator to f5b0b.
7. A replacement ref could not identify an inner batched operation. It now
   binds exact `entryCount`, `entryIndex`, inner operation digest, and vertex
   ref; creator expansion verifies all four and causal ancestry.
8. The legacy creator retirement record hard-stopped creator-owned displaced
   rows. Migration uses it only to authenticate the initial admitted boundary;
   later settlement-mode closures omit it and settle the creator uniformly.
9. Direct v1-frontier seeding would silently terminalize pending
   covered-historical rows. The checkpoint now separates `admittedThrough`
   from `settledThrough`: migration copies only admitted state and initializes
   settled state to null, preserving shipped reissue until an author-signed
   settlement exists.

## P2 disposition

- Reserve `$drp.author-settlement.v1` against blueprint registration and
  recognize it by its own `action` property: f5b0a.
- Disable the retirement fallback and use the settlement checkpoint for all
  authors in settlement mode: f5b.
- Remove baseline triggering/ordering because the baseline was deleted:
  closed by the amendment, with re-entry owned by f5b0p.
- Put issuer-side reserved-operation discrimination in f5b0a and Node durable
  issue in f5b0b: ownership corrected.
- Keep cross-object migration-import satisfaction in explicit manual review:
  f5b0c; no fabricated same-object receipt.
- Ensure settlement controls are present in close/history but excluded from
  application fold: f5b0b.
- Correct the old-binary aggregate-requirement citation from line 327 to the
  `proposedMatches.length !== 1` check at the audited line 398 on this evidence
  touch.

## Gate result

The carrier/lifecycle corrections are bounded, but the authority correction
is intentionally not papered over. f5b0a RED remains unauthorized until
D.110c-0c1f5b0p selects an exact age-independent identity-history boundary and
the amended combined design receives the one material confirmation with an
empty P0/P1 union.
