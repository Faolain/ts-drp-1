# D.110c current-course Fable 5.1/high review

**Verdict: `ON_TRACK_WITH_CORRECTIONS`.** No P0. Two P1 corrections, both at
the plan/RED-design level rather than in the staged code.

## Verified current position

- HEAD is `907a0499` and the causal RED is `59330d85`. Both are GPG-signed and
  present on `origin/codex/phase3a1b-p6-golden-path`.
- The index holds exactly 27 staged paths: the pending authenticator in
  `packages/node/src/creator-adoption.ts`, the fixture guard and test
  refinements, the plan ledger hunk, and the three evidence roots. Production
  diff is confined to `creator-adoption.ts`. No tracked file has unstaged
  changes.
- All four manifests verify entry-by-entry, and the manifest digests equal the
  plan's stated values: RED root `ec7bfe57…`, masked focused run `3b42a052…`,
  one-order diagnostic `49090023…`, and two-order diagnostic `53c39e46…`.
- The two-order reporter and corrected validator match the plan: one Chromium
  test in one file, stats 0/0/1/0, two soft failures carrying
  `D110C_0C_EPOCH3_COLD_REOPEN_BLOCKED`, both orderings `active-new` with floor
  2/pending 3 to stable 3/no pending, exact AHE deltas, and identical
  post-commit detail ending in `creator predecessor recovery failed:
  admission-rejected`.
- The root cause is structural. `extractAuthorizedV3Vertex` at
  `packages/node/src/v3-live.ts:3688-3717` binds every row to the payload's
  anchor digest and requires current scope. `creatorFilteredIssuanceStore` at
  `v3-live.ts:4550-4624` hides only rows authenticated by the successor payload
  above `excludedAfterEpoch` plus pinned-genesis rows. At epoch-3 reopen the
  genuine epoch-1 row reaches `recoverV3LiveReplica`; `classifyPlaneVertex`
  returns undefined and `v3-live.ts:5097-5098` returns `admission-rejected`.
  The successor view uses `Number.MAX_SAFE_INTEGER` at `v3-live.ts:7418`, so it
  also cannot classify that row.
- Creator close issues no local outbox row, so the fixture's one local row per
  epoch is accurate. The activation vertex digest is only a migration-handoff
  concept.

## Findings

The project is on the correct causal path: generalize pending authentication
through durable commit, then use a separate reviewed prerequisite for
intermediate-epoch rows before any `v3-live.ts` edit. Nothing here reopens
D.110c-0b0/0b1 or requires a new recovery entry.

The staged authenticator is the smallest correct closure of the original RED.
Its epoch-N branch uses `openCreatorCheckpointTrust` with the independently
authenticated expected-next head, checks both room heads, uses the shared
classifier in verify mode, and applies the same projection bindings as
`reopenCreatorSuccessorMaterial`. Epoch-0 and epoch-N authority checks are
preserved. It is appropriate to sign it as an explicitly non-GREEN checkpoint,
after P1-1 is corrected.

### P1-1 — plan/diff predicate mismatch

Plan lines 95282-95285 and 95351-95354 promise the epoch-0 branch is
byte-preserved and retains an additive transition predicate. The staged diff
does neither literally. Epoch 0 now delegates through
`inspectCreatorTransitionAdvance({ mode: "verify" })`, which calls
`inspectCreatorTrustAdvance` at epoch 0, and it newly applies projection-binding
checks to epoch-0 pending candidates. These changes are semantically sound and
strengthening, but the retained 0→1 pending matrix has not been rerun. Correct
the plan to require semantic preservation through delegation plus additive
projection bindings, proven by the retained 0→1 matrix at the GREEN gate,
before signing the non-GREEN checkpoint.

### P1-2 — proposed differential control can fail earlier for another reason

Omitting the epoch-1 issued row leaves epoch 1 with zero local rows.
`recoverV3LiveReplica` at `v3-live.ts:5307-5321` can then fail closed with
`issuance-rejected: v3 recovery issued record chain is empty`. Hot adoption
1→2 and cold reopen both traverse `consumeCreatorSuccessorLive`, so the control
may fail during the earlier 1→2 adoption rather than isolate epoch-3 reopen.

Use a non-shortcut prefix control instead: same room and same message inputs,
but stop one transition earlier. The control performs 0→1 with rows r0 and r1,
crashes in pending 1→2, recovers, and reopens at epoch 2. The treatment adds one
genuine transition and reopens at epoch 3. At the store boundary already owned
by the fixture, record every `readOutboxPage`/`readIssued` call and returned row
key/digest plus pre-crash issue results. The trace must show identical r1 bytes
accepted as current in the control and rejected in the treatment, with the
treatment ending on r1. This makes the causal differential exact without
fixture-side deletion or changed production errors. If an empty-epoch control
is retained, first prove that scenario separately with a bounded tests-only
probe and a stop condition.

### P2 — nonblocking guidance

- GREEN must fix both predecessor and successor issuance views. Fixing only the
  predecessor view can move failure to `creator successor recovery failed`.
  Name the live `publishPending` and `readRebaseOutbox` scans in the D.110c-0c1
  owner set; the fourth-message publish gate exercises them.
- The current genesis filter ignores publish state and can hide an unpublished
  epoch-0 row. D.110c-0c1 must not copy that behavior: an old pending row must
  fail closed or be explicitly resolved.
- The no-pending reopen guard in `examples/v3-room/src/index.ts:1573-1581` is
  pinned to stable epoch 1. Until D.110c-c owns the later restart, D.110c-0c1
  should claim same-process post-commit reopen, not an unqualified cold reopen.
- The family-independent tests-only differential can precede the formal design
  review so reviewers inspect exact causal row evidence; production edits still
  wait for an empty blocking union.
- For symmetry, GREEN should filter the N≥1 pending QC set by commit phase and
  current epoch as `reopenCreatorSuccessorMaterial` already does.
- `diagnosis-audit.mjs` uses file-global string checks and must not be reused as
  a function-slice source-shape gate.

## Construction decision boundary

At epoch-N reopen, existing authenticated O(1) material covers the pinned
genesis anchor, predecessor trust for N-1 whose preimage carries N-2's anchor,
current trust for N, the retiring N-2 cut/QC/ACL in the predecessor closure,
and latched ACLs for N-1/N. Because row signature verification requires a known
expected anchor, current data authenticates rows only for epochs 0, N-2, N-1,
and N. That happens to cover the epoch-3 fixture through the previous-anchor
window but is not a general age-independent construction.

No current authenticated carrier says that author A's sequences through S are
resolved as of closed epoch K. `prunedThroughAuthorSequence` exists durably but
is store-held and untrusted for hiding rows; D.109b treats a row at or below the
watermark as corruption, and production does not call `prunePublishedPrefix`.
Physical deletion alone cannot handle fail-safe retention, while retaining old
authority is O(N).

The architecture audit should therefore decide explicitly between:

1. Carrier-free discard-only classification: hide a row only after signature
   verification with author identity from current latched ACL, claimed epoch
   no newer than N-2, sequence preceding the first authenticated N-1/N row,
   published state, lineage completeness, and one bounded per-scan count. This
   carries residual risk around rollback-orphaned old rows and reliance on
   store-held publish state; the formal review must decide whether that is
   acceptable.
2. A creator-signed resolved boundary: carry a per-author resolved sequence in
   the hard-epoch cut or anchor preimage and retain it through the N-2 closure.
   This is a protocol-v3 signed-wire change and therefore must stop as its own
   explicit high-risk prerequisite.

The evidence supports this two-way decision slice; it does not yet justify
selecting one family.

## Smallest justified next step and stop conditions

Correct P1-1 in the plan hunk, then sign and push the labeled non-GREEN
checkpoint. Perform the bounded architecture audit and author the corrected
prefix-control differential RED from P1-2. Stop if the control fails before its
target reopen, the treatment trace does not end on r1, the treatment does not
produce predecessor `admission-rejected`, or observing the row would require a
production-store or error-string change.

Rejected shortcuts: filtering on `previousAnchor` alone; retaining older
anchors/trust records; skipping rows from decoded epoch without signature,
author, sequence, publish-state, and ceiling checks; trusting the store
watermark or publish state as authority; making D.109 pruning mandatory in the
close path; fixture-side pruning or deletion; synthetic displaced authority;
accepting floor commit as GREEN; deferring same-process reopen; or widening
production errors merely to observe RED causality.

## Provenance

Effective model `claude-fable-5-1`, high effort, session
`6aaf4f98-77ca-42ab-a71e-721c11f781d1`, 61 turns, 690,343 API ms. Read-only
tools used: Read, Grep/rg, Glob, and Bash limited to Git inspection, hashing,
`sed`, `ls`, `cat`, and `wc`. Inspected HEAD `907a0499`, the staged index, and
the named evidence roots. No subagent, workflow, test, service, or repository
mutation occurred. The reviewer did not inspect the prior Fable evidence root;
it only encountered that run's summary in the plan.
