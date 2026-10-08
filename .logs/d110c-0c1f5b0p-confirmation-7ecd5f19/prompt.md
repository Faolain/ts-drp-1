Perform the one permitted material high-risk confirmation for the combined
D.110c-0c1f5b0p/f5b0 author-settlement design at signed/pushed commit
`7ecd5f19bea4e6e0350bd307fbf2374c0f5a4970`. Work read-only. Do not edit, run
tests/workloads, invoke reviewers, or spawn subagents. Return exactly one JSON
object matching the supplied schema.

Read completely:

- `.logs/d110c-0c1f5b0p-design-e6a67013/audit.md`, `design.md`, and
  `manifest.sha256`;
- amended `.logs/d110c-0c1f5b0-design-00a860ab/audit.md`, `design.md`, and
  `manifest.sha256`;
- immutable first-review ledger
  `.logs/d110c-0c1f5b0-plan-review-fc4b8fc7/review.md`;
- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially
  D.110c-0c1f5a, f5b0, f5b0p, f5b, D.110c-0b and the ≥100-transition/Phase-7
  requirements;
- commit diff
  `e6a67013b1f64b7ea2155f59a3d578f52ed84ed6..7ecd5f19bea4e6e0350bd307fbf2374c0f5a4970`;
- current sources named by the two audits, especially protocol-v3 ACL/trust/
  creator-close, RFC 9162 history, AHE storage/closure/reclamation, Node close/
  transition/recovery, issuance store and v3-room invite/session owners.

Do not reopen accepted evidence. The first review's P0/P1 union is preserved.
This confirmation decides whether the combined corrections close it and are
exact enough to authorize only the first tests-only RED slice. No production
GREEN or long campaign is authorized by this review.

The combined corrected design now does all of the following:

1. Limits settlement statements to eight sources/intents/replacement refs,
   binds replacement batch entry count/index/inner digest, adds explicit
   zero-intent control-source dispositions, separates complete close/history
   graph from application fold, uses a dedicated Node settlement issuer, and
   gives admitted/settled boundaries distinct semantics.
2. Deletes the unsafe caller-local author baseline and the legacy late-upgrade
   migration. Existing `creator-trusted-v1` rooms/bytes remain unchanged and
   cannot opt in.
3. Adds a sibling genesis-bound `creator-trusted-settlement-v1` profile. It has
   the identical fixed one-of-one creator signer/quorum, Ed25519 suite and
   creator-trusted/not-BFT meaning, but requires settlement state from epoch
   zero. The existing genesis `profileDigest` authenticates the selection; old
   binaries reject the unknown profile.
4. Adds one signed settlement checkpoint with ≤64 current-member
   `{admittedThrough,settledThrough}` frontiers plus a retired-author registry
   root/count. Its only predecessors are the implicit genesis sentinel or one
   adjacent settled-v1 checkpoint. Settlement-profile closures never contain
   the v1 aggregate or legacy creator retirement.
5. Selects a deterministic content-addressed Merkle AVL dictionary of currently
   retired public keys. Canonical nodes bind author, boundaries, child
   byteLength/digest/height/subtreeSize/min/max metadata, node height and size.
   Membership restores the last boundaries; verified nonmembership alone lets
   a genuinely new key begin at sequence zero.
6. Uses exact pure lookup/batch-witness/update verification, deterministic AVL
   rotations and sorted unique `assert-absent | insert | delete` mutations.
   Every evolving intermediate root is checked. Safe-integer size bounds a path
   to 76 nodes; a maximum 64-insert/64-delete transition schedules at most
   14,592 visits. The internal canonical witness is capped at 20,971,520 bytes
   and is not a vertex/network/checkpoint record.
7. Adds a neutral `RetiredAuthorRegistryStore` with memory and dedicated strict
   IndexedDB implementations. It does not hide an indirect tree in AHE's flat
   closure GC. Strict expected-root transition commits before creator signature;
   ambiguous outcomes authenticate exact root/count/mutation/witness digest.
   At most one serialized candidate, one current and two rollback roots exist.
8. Keeps the active checkpoint O(64) and ordinary issue/publish/restart/cold
   reopen independent of dictionary nodes and room age. Membership-changing
   creator close requires verified O(log R) paths; unavailable/corrupt backing
   stalls that close rather than treating a key as fresh.
9. Explicitly counts reachable dictionary backing as O(R) archive-tier control
   index state for currently retired distinct keys, plus current rollback/
   candidate reachability. It is not application archive and is not needed for
   ordinary cold reopen. If the accepted contract instead requires O(1) total
   durable bytes under unlimited distinct-key churn, the plan stops and
   reslices to a cryptographic accumulator/recursive-proof prerequisite.
10. Direct canonical measurements are 792 bytes for the maximum-shaped node
    under 1,024 and 7,064 bytes for the signed maximum 64-frontier checkpoint
    under the unchanged 8,192 ceiling.

Review the exact design rather than proposing a preferred rewrite. In
particular decide:

1. Does fixed genesis-rooted creator authority adequately authenticate the
   current registry root/count to ordinary openers without replaying every
   update, under the already accepted creator-trusted D.110c-0b model and
   external freshness floor?
2. Do the node/ref bounds, exact child metadata, proof/witness grammar,
   intermediate-root checks, deletion successor path and deterministic AVL
   operations suffice for membership, nonmembership and update verification?
3. Is it sound to let only verified nonmembership initialize a truly fresh key
   and restore exact boundaries on same-key re-entry, including null boundary,
   retained-role and remove/re-add-in-one-staged-ACL cases?
4. Does write-before-sign, candidate serialization, authenticated unknown-
   outcome recovery, current/two-rollback reachability and delayed reclamation
   fail closed across crashes and untrusted bytes?
5. Is the explicit O(R) backing consistent with the stated non-negotiable:
   bounded active/current checkpoint and age-independent ordinary cold reopen,
   with no hidden mandatory O(history) bootstrap state? If not, cite the exact
   plan requirement that requires constant total durable bytes despite
   unbounded distinct public keys.
6. Does the genesis-only sibling profile safely avoid unverifiable legacy
   migration and preserve old rooms, while honestly accounting for its public
   profile-union/storage compatibility impact?
7. Do the f5b0p-a pure protocol/profile and f5b0p-b store slices have causal
   REDs and clean ownership before the existing carrier/Node/room/pruning/
   integration slices?
8. Are any earlier P0/P1 findings still open: control/application graph split,
   removed-key reset, mixed-epoch pruning, blueprint-bound auth paths,
   replacement batch identity, creator legacy retirement, or unsafe v1
   admitted→settled migration?
9. Is any asserted operation impossible from the named current seams or does it
   silently require a new cryptographic dependency, setup, signer/authority,
   vertex/wire field, threshold, workload, or ordinary-cold-open archive replay?

Only P0/P1 findings block. Every finding must cite concrete file/section
evidence and a minimal required correction. P2 must name its owner/disposition
and does not trigger recursive prose review. Set `verdict` to
`CHANGES_REQUIRED` iff at least one P0/P1 exists. Set `red_authorized=true`
only if f5b0p-a tests-only RED may begin exactly as sliced. Do not authorize
production edits, f5b0a RED, multi-epoch workload or campaign. Preserve an
honest NO_VERDICT outside the JSON if the service cannot complete; never infer
approval from silence.
