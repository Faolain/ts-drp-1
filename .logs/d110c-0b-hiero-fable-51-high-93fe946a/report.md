# One-off Fable 5.1/high D.110c-0b comparative audit

- Session: `5d9b90ff-5bca-4284-92fa-a9f1018273ff`
- Model/effort: `claude-fable-5-1` / `high`
- Mode: background, read-only; no edits, tests, commits, pushes, or subagents
- Raw local session JSONL SHA-256:
  `8d4c6cf06f435a814fe1b59cc9d7fec048006811edf37d573590668e1b19219d`
- Result: `P0=0`, `P1=0`; the selected Hiero-informed direction has no
  blocking architecture flaw.

## Independently confirmed upstream pins

The run re-fetched the three pinned upstream heads on 2026-09-02 and confirmed
they still matched the plan:

- `hiero-improvement-proposals`
  `54ccb06659592ab201e7adea632f1019e9faa00e`; HIP-1200 blob
  `088088185786375a1478166bbd61c4021eedc85c`.
- `hiero-consensus-node`
  `1aa1d6c153907750cfbba6935b7a21867053968e`; exact-weight TSS blob
  `c35cb34e6e797719fdb02f8541cb067f64e3972a`.
- `hiero-cryptography`
  `39f28f39f609f80e52253d86169e2db5216a713e`; WRAPS Rust/Cargo blobs
  `5beccdf8fdf35a5da6f55112663faa1b829bd849` and
  `f5aba82bedd5d17b8127e211ecf3d97632eb0a5a`.

It independently inspected implemented HistoryService/HistoryLibrary,
WRAPS proving, writable history handoff/purge, proof controllers, schemas,
handoff coordination, transition weights, TSS config, signed-state validation,
the history protobuf, and the native bridge. It preserved the plan's distinction
between approved proposal text, design documentation, implemented source, and
unproven deployment/enablement. In particular, the pinned default
`forceMockSignatures=true` prevents source inspection from being relabelled as
evidence that real TSS signatures are active on a network.

## Independent conclusion

The audit agrees that WRAPS is solving the changing-signing-authority case and
is disproportionate for the current fixed `creator-trusted-v1` signer. A compact
WRAPS verifier does not by itself establish freshness: the inspected verifier
binds genesis and proof metadata, while current selection/freshness remains with
surrounding signed-state and caller-held-floor owners. The system also retains
active/next construction state, keys, in-flight material, an extendable
uncompressed proof, and hash-pinned native proving artifacts. This confirms the
plan's rejection of silently importing recursive proof machinery, BLS/hinTS,
an SRS, new wire fields, or a native/browser dependency.

The preferred family remains existing Ed25519/genesis/anchor/cut/QC/RFC-9162
primitives plus an independently authenticated monotonic 0b0 floor. Fable
favored the simplest variant: caller-held pin-verified genesis carriers, one
current v1 trust record, exact `(objectId, epoch, anchorDigest)` floor equality,
current cut binding, and only the newest N-1->N QC authenticated through the
bounded rollback predecessor. This is compatible design guidance for the
already frozen D.110c-0b1 private-opener stop-check, not authority to change the
accepted record/API/closure boundary.

## Prospective acceptance clarifications

Two P1-adjacent, nonblocking clarifications should be explicit before D.110c-0b0
RED:

1. An injected deterministic model provider proves protocol correctness given
   an honest monotonic external authority; it does not prove that browser-only
   IndexedDB/localStorage resists rollback. D.110c-c/d and Phase 7 golden-path
   claims remain conditional on a real application/account provider outside the
   hostile room-storage boundary.
2. Advanced non-creator participant reopen currently succeeds without a floor.
   Once 0b0 is enforced, those retained cases must either receive the separately
   authenticated Phase-7 test pin or become exact fail-closed
   `D110C_FLOOR_MIGRATION_REQUIRED`/availability cases. Retained-suite wording
   must not simultaneously demand the old pinless pass and the new mandatory
   floor.

Nonblocking design guidance:

- Classify a missing immediate-predecessor QC/trust record as availability, not
  proof that current authority is invalid.
- Keep the source active until a complete metadata-matching handoff; explicitly
  decide the fail-closed no-abort pending window before adding any cancellation
  or tombstone behavior.
- Census generation lineage so interim O(N) enumeration cannot hide behind the
  final three-generation retention target.
- Keep the already assigned epoch-1/generation-2 projection constants with
  D.110c-a/b.
- Preserve the distinct Hiero thresholds; do not import them into ts-drp's
  creator quorum law.

This report does not reopen completed work, select a new dependency, authorize
production edits, or replace the governing Grok/Kimi/Opus high-risk review.
