# D.110c-0c1 authenticated issuance-retirement architecture audit

Anchor commit `d6f5de263c5d0bcabe4df25532a0a8d3dcf0ccbd`, tree
`17ecf3edf922ca3b27e96a5c8b25ae7888f67146`.

## Demonstrated seam

`creatorFilteredIssuanceStore()` (`packages/node/src/v3-live.ts:4550-4624`)
can authenticate current/successor-relative rows and the pinned genesis row.
It cannot authenticate the genuine epoch-1 row during epoch-3 reopen.
`recoverV3LiveReplica()` consequently rejects that row at
`v3-live.ts:5097-5098`. Both predecessor and successor views are affected
(`v3-live.ts:7377-7439`), as are later publication and rebase scans through the
registered filtered view.

## Existing proof inventory

- `openCreatorCheckpointTrust()` authenticates pinned genesis plus exactly one
  predecessor/current pair. The current anchor binds only its immediate
  predecessor (`packages/protocol-v3/src/creator-checkpoint.ts:280-297`).
- The hard-cut and epoch-anchor registries commit state, ACL, compact history,
  snapshot, archive, signer, parameters, and the immediate previous anchor.
  Neither schema carries a per-author resolved sequence frontier
  (`packages/protocol-v3/src/creator-close.ts:64-80,387-410`).
- `DurableIssuanceStore` exposes only six ordinary methods and `readLineage()`
  omits the pruning watermark (`packages/issuance-store/src/types.ts:83-90`).
- `prunedThroughAuthorSequence` is local maintenance state. Its receipt is
  bound to a caller-supplied closed epoch, QC ref, snapshot digest, and lineage,
  but it is not signed or authenticated from the pinned room genesis
  (`packages/issuance-store/src/maintenance.ts:14-43`).
- Physical pruning is implemented in Node/browser maintenance and tests, but no
  product path under `packages/` or `examples/` invokes
  `prunePublishedPrefix()`. Deletion alone also cannot authenticate a retained
  or missing prefix after hostile storage rollback.
- The compact RFC 9162 frontier authenticates history-root evolution, not the
  proposition that a particular author's durable sequences through S are
  completely represented and safe to retire.

## Candidate decision

| Family                                                    | Authentication                                                                                                                                 | Epoch growth                                          | Disposition                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Current/immediate-predecessor row filtering               | Authenticates only genesis and the bounded adjacent window                                                                                     | O(1)                                                  | Insufficient for arbitrary old retained rows.                                                     |
| Decode/signature-check a claimed old epoch                | The row signs its own anchor claim but does not prove that anchor belongs to the accepted room lineage or that no unresolved address is hidden | O(1)                                                  | Rejected.                                                                                         |
| Trust the database watermark or require physical deletion | Store-local state is not authenticated from genesis; failure may retain too much                                                               | O(1)                                                  | Rejected as sole authority; retained as an execution mechanism after authenticated authorization. |
| Retain all old anchors/ACLs/cuts/QCs                      | Directly verifies every historical row                                                                                                         | O(N)                                                  | Rejected by the bounded control-state law.                                                        |
| Add a cumulative creator-signed retirement checkpoint     | Stable creator authority signs the current cumulative resolved address frontier and binds it to the authenticated successor checkpoint         | One current candidate plus one transition predecessor | Selected, subject to a separate high-risk protocol-contract RED/GREEN.                            |

## Selected control record

D.110c-0c1a must define one canonical
`drp-creator-issuance-retirement-state` record and a domain-separated
`ts-drp/creator-issuance-retirement/v1` signature. The exact record binds:

- protocol/version, object id, pinned genesis digest, creator issuance author;
- closed/current epoch and anchor;
- successor epoch and anchor;
- exact cut-value, commit-QC, and snapshot-manifest digests;
- the previous retirement-record digest (or the one frozen genesis sentinel);
- previous inclusive resolved author sequence (nullable only for the initial
  checkpoint), new inclusive resolved sequence, and observed lineage next.

The record is signed by the existing stable `creator-trusted-v1` finality key,
whose public key is authenticated by pinned genesis. It is stored as exactly one
replaceable AHE closure candidate. It is not a database watermark and is not
trusted because it is present in storage. Its opener reconstructs the creator
authority from pinned genesis, verifies the detached signature, exact room and
scope, exact current/successor heads, cut/QC/snapshot bindings, monotonic
sequence relation, and previous-candidate digest during transition. Cold reopen
requires the one current record bound to the independently authenticated room
floor. Missing, duplicate, stale, future, cross-room, cross-author, forked, or
malformed records fail closed.

At close, the minting owner starts from the authenticated prior retirement
checkpoint, reads the exact issuance lineage and the complete unretired prefix,
requires issued/outbox byte equality, dense increasing addresses, canonical
vertices, valid signatures, current room/anchor/epoch, `published` state, and
membership of every newly covered digest in the captured close graph and
durable replay. It sets `throughAuthorSequence = observedLineage.next - 1` and
does not mint if any address is missing, pending, substituted, or outside the
closed graph. The successor anchor and Cut/QC/snapshot identities are known
before the deterministic Ed25519 signature is completed. The proposed AHE
closure contains the new record and retires the previous record only through
the shared bounded transition predicate.

During recovery, an authenticated boundary authorizes classification only for
addresses at or below `throughAuthorSequence`. The wrapper still requires an
exact issued/outbox pair, canonical object/author/sequence, valid author
signature and `published` state; it uses the creator certificate—not the row's
claimed old anchor or database watermark—as the authority that the address is
resolved. Rows above the boundary retain current/displaced admission and
offline/rebase behavior. One per-scan combined hidden-row ceiling applies.

Physical pruning remains D.109/D.110c-c execution after verified adoption,
floor commit, snapshot availability, two rollback generations, outbox
completion, and authenticated certificate match. Refusal or crash may retain
certified rows. It may not advance the signed boundary, remove an uncertified
address, or make partial progress look complete.

## Compatibility boundary and required reslice

This choice adds a protocol-v3 control-record/registry contract and a new
protocol-owned finality signing request. It therefore requires the explicit
high-risk D.110c-0c1a prerequisite before any filter implementation. It does
not require a new product API, dependency, cryptographic primitive, epoch
anchor/Cut wire field, or issuance database migration: the signed carrier is a
bounded AHE closure blob and reuses Ed25519 plus the existing finality signer.

Compatibility is limited deliberately. Fresh rooms create the initial
checkpoint during 0→1 while the genuine epoch-0 close graph, durable replay,
and pinned-genesis row are all present. Any inherited epoch≥1 closure without a
retirement checkpoint fails closed and requires an explicit migration/recovery
decision: bounded current trust can authenticate an old row's signature but
does not prove its membership in the already-completed close. The repository
has not shipped a genuine repeated-epoch producer, so it must not invent that
proof silently.

No production implementation is authorized by this audit. The next checkpoint
is the signed plan and governing Grok/Kimi/Opus review of the exact 0c1a design,
followed by a tests-only causal RED.
