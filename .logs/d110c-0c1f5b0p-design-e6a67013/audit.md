# D.110c-0c1f5b0p removed-author identity-history source audit

## Anchor and scope

- Audited signed/pushed commit and upstream:
  `e6a67013b1f64b7ea2155f59a3d578f52ed84ed6`.
- Audited tree: `488075c6ee680c48e22b639a44957cabd038cb00`.
- Branch: `codex/phase3a1b-p6-golden-path`.
- This is a plan/design checkpoint only. It changes no production source,
  dependency, wire bytes, API, threshold, workload, test, campaign, or consumed
  invocation.
- The rejected first f5b0 review and its immutable evidence remain under
  `.logs/d110c-0c1f5b0-plan-review-fc4b8fc7/`. This audit addresses the one
  blocking removed-key reset problem isolated by the signed amendment at this
  anchor; it does not reopen accepted D.110c evidence.

## Current production owners

1. `packages/protocol-v3/src/latched-acl.ts:120-166` accepts only the current
   canonical ACL and caps it at 64 members. `freezeMembers()` at lines 351-368
   removes a key after its last role/finality key is revoked. Grant/revoke
   staging at lines 376-446 carries no incarnation, prior-appearance bit, or
   sequence boundary. A later grant of the same 32-byte public key is therefore
   indistinguishable from a globally fresh key at this owner.
2. The creator settlement checkpoint proposed by f5b0 can keep exact
   `admittedThrough` and `settledThrough` values for current members, but an
   omitted removed member loses those authenticated facts. Caller-local
   issuance lineage cannot repair this because it is not creator authority and
   may be absent on a cold creator restart.
3. `packages/compaction/src/history-commitment.ts` implements an RFC 9162
   ordinal append-only history commitment. Its leaves bind epoch, object,
   ordinal and vertex hash. It can prove inclusion/consistency of a known
   historical leaf, but it has no public-key index and cannot prove that a key
   never appeared or find that key's last boundary without an additional
   authenticated index.
4. `archiveIndexRoot` is carried through anchors, cuts and snapshots, but the
   audited production paths expose no implemented author-keyed index or proof
   owner behind that digest. Treating the field name as an existing capability
   would be a fixture shortcut.
5. `AheDurableStore` in `packages/storage/src/types.ts:110-150` owns generation
   blobs referenced by an explicit flat closure. The closure verifier at
   `packages/storage/src/internal/closure-verifier.ts:55-122` checks only each
   listed reference's promotion, byte length and digest. Browser reclamation
   derives live blobs from those explicit generation/promotion rows; it does
   not traverse child references inside an indirect authenticated tree.
   Storing a Merkle tree behind one AHE root blob would therefore either leak
   nodes or permit reclamation of reachable nodes. A separate store contract
   and reachability owner is required.
6. The fixed creator trust profile is currently hard-coded as
   `creator-trusted-v1` in protocol trust, creator close, Node live/close and
   room successor authority. The exact profile bytes are hashed into the
   genesis anchor and carried unchanged by successors. A runtime-only
   settlement switch is therefore not genesis-authenticated and would allow an
   old binary to close the same invite using the legacy rules.
7. The room invite already transports exact canonical profile bytes and the
   pinned, creator-signed genesis anchor. A sibling genesis profile can be
   authenticated without changing the invite envelope or public-key authority,
   but accepting that profile is still an explicit protocol/public
   compatibility change and must be reviewed before implementation.

## Capability conclusion

No current component can authenticate both prior nonappearance and the last
boundary for an arbitrary removed public key in sublinear room-age work. The
missing seam is not composition over a dormant implementation. With ordinary
hash primitives, the information must live in an explicitly counted
authenticated dictionary; a constant-size checkpoint can commit to that
dictionary, but the dictionary backing necessarily grows with the number of
currently retired distinct keys. A construction that also makes the backing
constant-size needs a stronger accumulator/recursive-proof assumption.

The selected existing-primitive construction is a creator-authenticated,
content-addressed Merkle AVL dictionary of **currently retired** keys. Its root
and entry count live in the creator settlement checkpoint. The current active
checkpoint remains bounded by the 64-member ACL; ordinary cold reopen does not
load or replay dictionary nodes. The creator needs verified O(log R) paths only
when an ACL transition removes or re-adds a key, where `R` is the number of
currently retired distinct keys. Missing backing state is an availability
failure for that membership-changing close, never permission to treat a key as
fresh.

Every child reference also authenticates its height, subtree size and min/max
key bounds, allowing a root-to-terminal proof to recompute parent balance,
ordering and metadata without opening an entire sibling subtree. An update must
nevertheless open the off-path sibling and, for a double rotation, its inner
child at each deletion-rebalance level. Safe-integer entry count bounds an AVL
path to 76 nodes. A conservative maximum 64-insert/64-delete transition allows
one 76-node insertion path and, per deletion, a 76-node lookup path, 76-node
in-order-successor path and 152 off-path rebalance nodes. It therefore schedules
at most 24,320 visits / 24,903,680 canonical node bytes; shared node bytes are
carried once. The whole-witness cap is 33,554,432 bytes.

This choice is honest about storage. Reachable dictionary nodes are a separately
counted archive-tier control index of O(R) entries, not active bootstrap state
and not historical application data. Old copy-on-write nodes outside the
current and two rollback roots are reclaimable. The live dictionary cannot be
pruned below the information needed to reject a reset. If the governing review
requires O(1) durable bytes even under unbounded distinct-key churn, this hash-
only design cannot satisfy it; stop and open a separate accumulator/recursive-
proof prerequisite rather than disguising the growth.

## Compatibility conclusion

The earlier runtime `authorSettlementVersion?: 1` migration is rejected. The
selected compatibility boundary is a sibling genesis-bound profile,
`creator-trusted-settlement-v1`, with exactly the same one-of-one fixed creator
signer/quorum semantics as `creator-trusted-v1` and with settlement/registry
support mandatory from epoch zero. Existing `creator-trusted-v1` rooms and
bytes remain unchanged and cannot late-opt-in in this slice. Old binaries fail
closed on the unsupported profile. This eliminates the unsafe attempt to infer
settled or removed-author state from a legacy room whose complete historical
author set is not indexed.

The new profile does not add BFT, signer rotation, a new signer, or an external
authority. It does add an explicit profile identifier and widens internal/public
profile unions that currently contain only `creator-trusted-v1`; that change is
part of this high-risk prerequisite and remains unauthorized until the combined
Grok/Kimi/Opus confirmation has an empty P0/P1 union.

Direct workspace canonical measurements establish that the maximum-shaped
two-child registry node is 792 bytes (232 bytes below its proposed 1,024-byte
ceiling) and the maximum-shaped signed 64-frontier settlement checkpoint with
the registry root/count is 7,064 bytes (1,128 bytes below the unchanged
8,192-byte checkpoint ceiling).

## Rejected candidates

| Candidate                                      | Genesis authentication and reset resistance                                                                      | Growth and cost                                                                        | Compatibility, availability and disposition                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbounded checkpoint tombstones                | Creator signature authenticates every prior key/boundary.                                                        | O(lifetime authors) signed bytes and opener work.                                      | Reject: exhausts the checkpoint and ordinary cold reopen.                                                                                                                                                 |
| Lifetime cap of 64 distinct keys               | Refusal can prevent reuse after the cap.                                                                         | O(64), but room permanently exhausts after churn.                                      | Reject: confuses concurrent ACL bound with lifetime identity.                                                                                                                                             |
| Caller-local watermark / author assertion      | Does not authenticate nonappearance or a cold creator's prior boundary.                                          | Locally small; hidden replay/backup assumption.                                        | Reject: wrong authority and restart behavior.                                                                                                                                                             |
| RFC 9162 history proof alone                   | Genesis-authenticated ordinal inclusion/consistency; no keyed absence/last-value proof.                          | O(log history) per known leaf plus O(history) search/index need.                       | Reject unchanged; an authenticated keyed index is still required.                                                                                                                                         |
| Treat `archiveIndexRoot` as implemented        | Field is anchor-authenticated, but no audited author-index contents or verifier exist.                           | Undefined.                                                                             | Reject fixture inference; Phase 7 may later compose the selected index.                                                                                                                                   |
| Authority-signed fresh-incarnation certificate | Creator can sign a new ordinal, but unchanged author identity still needs prior-key nonreuse/boundary knowledge. | O(1) certificate only if identity semantics change.                                    | Reject unchanged; a new author-incarnation contract would touch vertex/issuance schemas and migration.                                                                                                    |
| Reset under new incarnation                    | Genesis creator can allocate a global incarnation counter.                                                       | O(1) current counter/vector.                                                           | Reject here: changes the never-resetting author identity across wire, signing, issuance, ACL and archive owners.                                                                                          |
| Sparse 256-level Merkle dictionary             | Creator-signed root authenticates member/nonmember paths and boundaries.                                         | O(1) root, O(256) proof/update, O(R) backing.                                          | Hash-only/browser-feasible, but ≥8 KiB uncompressed paths and expensive multi-key updates; reject for AVL.                                                                                                |
| Merkle AVL retired-key dictionary              | Creator-signed root authenticates exact member/nonmember paths and last boundaries from genesis.                 | O(1) root/count and O(64) active vector; O(log R) proof/update; explicit O(R) backing. | **Selected.** Hash-only, no setup/dependency; strict store availability needed only for membership-changing creator close. Existing rooms require no migration because the new profile starts at genesis. |
| RSA/pairing/vector accumulator                 | Can offer constant-size root and compact membership/nonmembership with suitable dynamic accumulator.             | Potential O(1) commitment/proof, nontrivial witness updates and setup/manager state.   | Reject unless O(R) backing is ruled out: new crypto dependency/setup, browser performance, wire/proof and migration review.                                                                               |
| WRAPS-like recursive proof                     | Can fold changing authority/history from genesis.                                                                | Constant public proof but nontrivial prover, retained extension proof and artifacts.   | Reject as disproportionate to fixed creator authority; does not itself solve freshness and adds major browser/setup/dependency surface.                                                                   |

## Source identities

- `packages/protocol-v3/src/latched-acl.ts`:
  `a3eb74544c9839649e6dc85326d64c55bbd83bdbd2f83e6874b829649980abb7`.
- `packages/compaction/src/history-commitment.ts`:
  `ef4a865114468559bed76ce075af60ea9f2290ace010999e75d904d3cd99a65b`.
- `packages/storage/src/types.ts`:
  `74590f4cab68a5fce21cca8804d41e77215b164362c67a2ade2036eecd80f6c6`.
- `packages/storage/src/internal/closure-verifier.ts`:
  `435c83f36a84e186ef872deec602e64428d19dc2f1d6c5675881393b32cfe335`.
- `packages/storage-browser/src/internal/ahe-reclamation.ts`:
  `fa73cf9dfe30891349b8e6830443bdbcad1679a6f2ae6bdb97d8333e271428d7`.
- `packages/protocol-v3/src/index.ts`:
  `844176840275f994bb76a8c4fd130e300cfe07f9c69e74f0f71b0ec633e06dfc`.
- `packages/protocol-v3/src/creator-close.ts`:
  `abb54cdabda724888aabed2119df45c8678623e6d701f8366a9f7919f018c95b`.
- `packages/protocol-v3/src/creator-checkpoint.ts`:
  `4a44cb2d12788bb3aec5b692e0ca2479b7ab7e4ca3a64c97f41915a8860e62f2`.
- `examples/v3-room/src/index.ts`:
  `d63a8ab6be34bc6aca85293726982e106d5198c234abf2271aa1195c54d93bd0`.

## Deterministic design-checkpoint validation

1. HEAD and upstream both equal the pinned `e6a67013…ed6` anchor; its tree is
   `488075c6ee680c48e22b639a44957cabd038cb00`.
2. `git diff --check` exits zero. Prettier checks the plan, amended f5b0 packet
   and this audit/design packet at status zero. No production file is modified;
   the targeted status contains only the plan and these two evidence roots.
3. Both self-excluding manifests validate. Their SHA-256 values are recorded in
   the plan after their final audit/design bytes are frozen.
4. Fixed-string searches find neither `creator-trusted-settlement-v1` nor
   `RetiredAuthorRegistryStore` under `packages/` or `examples/`. The design
   does not falsely claim implementation.
5. The amended parent design has exact token counts: settlement action 3,
   checkpoint kind 2, checkpoint domain 1, `settleRebaseSources` 2,
   `authorSettlementVersion` 0, `hasDisplacedOperation` 1,
   `source-dispositions` 1, deleted `author-baseline` rationale 1,
   `zero-intent` 6, `pruneAuthenticatedSettledPrefix` 1, f5b0p reference 1 and
   settlement profile ID 4.
6. The exact workspace-canonical maximum-shape commands report 792 bytes for a
   two-child registry node and 7,064 bytes for the signed 64-frontier
   checkpoint. The arithmetic path bound is 76 nodes at safe-integer maximum
   AVL size. Including lookup, successor and worst-case off-path deletion
   rebalance nodes gives at most 24,320 scheduled visits / 24,903,680 canonical
   node bytes under the node ceiling and a 33,554,432-byte whole-witness cap.
7. Protected `.agents`, `.claude` and `.pnpm-store` are present and untouched;
   stash count is 27. Ports 4174, 4175, 51000 and 51002 are clear. The
   executable-restricted process predicate finds no ts-drp reviewer, test or
   profiler. The unrelated external Fable run is neither inspected nor
   disturbed, and no new Fable/collaboration invocation occurs.

## Next gate

The companion `design.md` freezes the exact dictionary, transaction, profile,
checkpoint, failure, storage and TDD boundaries. It and the amended parent f5b0
design/plan must be signed and pushed, then receive the one already-permitted
material Grok 4.6/high, direct Kimi K3 100-step and Opus xhigh confirmation.
No RED or production edit is authorized before an empty P0/P1 union. Fable and
collaboration subagents remain prohibited without new express authorization.
