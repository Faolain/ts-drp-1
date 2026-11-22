# Track Y map: the library's five in-memory caches

Base: 760607d9 (codex/phase3a1b-p6-golden-path, Track U merged). Line numbers are at base.

All five are module-level `Map`s, filled and read synchronously, never written to storage, never read back from
storage, and never shared across realms (each browser realm / worker / Node process has its own). A reopen in a new
realm starts with all five empty. A crash loses them with the process and nothing depends on them afterwards. In
Node, every room and every client in one process shares one set (one process = one budget).

## 1. The caches

### 1.1 `hashMemo` — canonical framed SHA-256 memo

- Where: `packages/canonical/src/internal/codec.ts` 1391–1505, inside `hashDomain(domain, ...parts)`.
- Key: `domain + ("\0" + byteLength per part) + "\0" + two 32-bit FNV-style lanes over every byte`. The key only
  locates a candidate; a hit additionally requires `sameMemoBytes` (full byte comparison) of every part against the
  PRIVATE copies taken at the miss.
- Value: `{ parts: frozen private copies, digest: private copy, bytes }`. A hit returns `digest.slice()`.
- Bounds: entries of 64 B .. 4 MiB of parts (others bypass the memo); total 32 MiB of part bytes and 32,768
  entries. Eviction: LRU (touch = delete + set; evict the oldest Map entries until under both bounds).
- Callers: 263 `hashDomain(` call sites in 25+ source files (node v3-live 34, protocol-v3 index 19, protocol-v3
  creator-close 18, node creator-close 15, seal 13, creator-transition-advance 10, creator-adoption 9,
  creator-closed-rollback-data 8, compaction archive 8, ...). Every path uses it: open, per-move issue and admission
  (vertex, state, latched ACL), seal (seal votes/QC/proposal, cut, snapshot chunk/payload/manifest), adoption,
  export, install, lull (retirement images, retention decisions, live-journal rows/order/snapshot), reopen.
- What fills it (Grid LULL=1, 64 rollovers, all realms, resident at the end): retirement images
  (live-journal 47 MB, issuance 14 MB, storage 7 MB, snapshot 7 MB), retention decisions 24 MB, blobs 5 MB, ...
  Those big, mostly write-once entries are why the creator realm reaches the 32 MiB ceiling.
- Pure-cache argument: SHA-256 of the framed bytes is a pure function of (domain, exact part bytes). The key
  encodes the domain, the part count and every part length; the hit compares every byte of every part against a
  private copy (caller mutation after hashing only misses); the digest returned is a fresh copy (callers cannot
  poison it). Exotic carriers (`plainMemoView` false: subclasses, own accessors, shared buffers) take the frozen
  uncached algorithm. Eviction only forces a recomputation of the same digest. Caveat (pre-existing, unchanged):
  exactness of the part count relies on domain strings containing no NUL; every production domain is a code or
  registry constant (no NUL).

### 1.2 `transitionMemo` — creator transition VERIFY memo

- Where: `packages/node/src/internal/creator-transition-advance.ts` 1380–1545: `transitionMemoKey`,
  `inspectCreatorTransitionAdvanceExact`, exported as `inspectCreatorTransitionAdvance`. The module's own internal
  callers (recheck at 1803/1827, 2301, 2608) use the uncached local wrapper `inspectCreatorTransitionAdvance` at 1374.
- Key: only `mode: "verify"` inputs that are plain closed records / dense plain arrays / exact `Uint8Array`s:
  `verify|T[current trust public fields + registered material scalars]|T[successor ...]|P<n>|refs...|C<n>|refs|D<n>|...
  |A±|B<byte lengths>`. The current trust's `currentEpoch` and `(genesisAnchorDigest, objectId)` are in the key.
- Value: `{ bytes: private copies of every candidate, material and ACL byte, retained, kind: "successor" }`. A hit
  requires byte-for-byte equality of every one of those byte strings and returns
  `{ kind, ok: true, proposed: <the caller's own proposed closure> }`. Only successes whose `result.proposed` is the
  input's own `proposed` are stored; refusals and everything else run the original every time.
- Bounds: entry ≤ 4 MiB, total 16 MiB of retained bytes. Eviction: LRU. No epoch bound at base: entries for epochs
  the room has left stay until the 16 MiB ceiling (about epoch 190 in Grid, ~17 MB per client).
- Callers of the memoized export (path):
  - creator-adoption.ts: `receiveCreatorSuccessorAdoption` 1299/1337 (stage mode: bypasses the memo),
    `verifyChain` 1949 (adoption, install, reopen), `verifyCreatorSuccessorAdoption` 2370 (adoption),
    `reopenCreatorSuccessorMaterial` 2740/2887 (reopen/export), `authenticateReceivedCandidateCustody` 3183 (stage),
    `authenticatePendingCandidate` 3460/3602 (install, pending discovery);
  - creator-adoption-commit.ts `validTrustChain` 479 (adoption commit, install);
  - creator-close.ts `bindCreatorLiveClose` 4205 (close);
  - creator-closed-rollback-data.ts: `authenticateExcludedHistoricalGenerations` 8770,
    `creatorOrdinaryNativeAdvanceResourceFacts` 8934, `composeProspectiveCreatorMaintenancePrefixesForSizing` 16322,
    `authenticateRoomRetentionExcludedGenerations` 21658, `authenticateHeldPendingRole` 24190, `authenticateRole`
    24411, `observeCreatorProtectedRecoveryRoles` 24637 (lull / maintenance / retention / role recovery).
- Pure-cache argument: the original predicate is a pure function of the keyed data: it reads trusts only through
  their immutable registered material (`resolveSealRecoveryTrust`; an unregistered trust gives no key), and every
  byte it reads is in `bytes` and compared on a hit. Inputs it might treat differently (accessors, extra keys,
  holes, subclassed or instrumented views, shared buffers) give no key and run the original. On a hit the result
  is the one the original returns for success (`kind`, `ok`, and the caller's own `proposed`). Eviction only forces
  the original to run again on the same data, which returns the same result.

### 1.3 `trustRecordVerdicts` — anchor-trust state record classification

- Where: `packages/protocol-v3/src/index.ts` 1180–1211, inside `createAnchorTrustApi()` (one instance per API; the
  library's single instance is `packages/protocol-v3/src/anchor-trust-singleton.ts:12`).
- Key: latin1 string of the complete copied record bytes (no digest, no identity). Value: boolean verdict
  (`decodeExact` ok, closed record with the trust keys, `kind === "drp-anchor-trust-state"`).
- Bounds: records 1 .. 8,192 bytes (ANCHOR_TRUST_STATE_MAX_RECORD_BYTES), 1,024 entries and 2,097,152 key
  characters. Eviction: FIFO.
- Callers: only `isAnchorTrustStateRecordBytes`, reached from control-plane `anchor-trust.ts:418`
  `inspectCopiedClosure` ← `inspectTrustClosure`, used by `assertTrustPreserved`,
  `createCurrentAnchorTrustStore` (openAtHead, install), `inspectCreatorTrustAdvance`,
  `inspectBoundedCreatorTrustAdvance`, and creator-close `inspectCreatorCloseHead`: seal, adoption, install, per
  move (issue/admit trust checks), lull, open/reopen.
- Pure-cache argument: the verdict is a pure function of the exact bytes and the key IS the bytes; shared-backing
  and out-of-range inputs return false before the memo, exactly as without it. Eviction recomputes the same boolean.

### 1.4 `memo` (ed25519) — strict Ed25519 verify memo

- Where: `packages/protocol-v3/src/internal/ed25519-verify.ts` (whole file, 36 lines), `verifyEd25519`.
- Key: `"<sig len>.<msg len>.<pk len>:" + one char per byte of signature, message and public key`. Value: the
  boolean from `ed25519.verify(..., { zip215: false })` (true and false both cached).
- Bounds: messages ≤ 256 bytes (others bypass), 4,096 entries. Eviction: FIFO.
- Callers: protocol-v3 index.ts 903 and 3473, creator-author-issuance-frontiers 411/486/878/951,
  creator-issuance-retirement 401/469, seal.ts 535/801/903, received-vertex-authentication 32: per move (vertex
  signatures), seal (votes, QC), adoption/install (anchor, settlement, issuance frontiers), lull, reopen.
- Pure-cache argument: strict verification is a pure function of the three byte strings and the key spells every
  byte with its length. Caveat (pre-existing, unchanged, in-process only): unlike `plainMemoView`, there is no guard
  against a `Uint8Array` subclass whose `byteLength` getter lies; every caller passes decoded, copied or computed
  bytes, so no network input can reach it. Eviction recomputes the same boolean.

### 1.5 `closureDigests` — storage closure digest memo

- Where: `packages/storage/src/values.ts` 102–131, `digestClosure`.
- Key: `${digest}${byteLength},` per reference of the validated, copied, digest-sorted closure (HEX_64 digests and
  safe-integer lengths; -0 excluded); closures over 64 references bypass. Value: the closure digest (hex).
- Bounds: 4,096 entries. Eviction: FIFO.
- Callers: about 22 production sites: creator-adoption, creator-adoption-commit, creator-close
  `stageCombinedGeneration`, closed-epoch-cleanup, closed-rollback-data `acquireClosedData`, transition-advance
  lineage, v3-live `prepareV3LiveGeneration`, storage capacity/codecs/contract/transition/maintenance/
  retirement-control: seal, adoption, install, lull, reopen, per move (live generation).
- Pure-cache argument: the digest is `hashDomain("ts-drp-storage/closure/v1", encodeCanonical(copied))`, a pure
  function of the copied closure, and the key spelling is injective over validated closures. Eviction recomputes.

### 1.6 Persistence and crash behaviour

None of the five is persisted, exported, or consulted by any storage code; grep finds no serialisation of them.
Each lives in module scope, so a reopen (new realm or new process) starts empty, and a crash has nothing to
recover. Trimming or lowering a ceiling cannot change what is stored, what a reopen sees, or crash behaviour.

## 2. Pins: tests, fixtures, frozen artifacts, registries, vectors, specs

Searched (two independent sweeps plus targeted greps): every tracked file naming the constants
(`HASH_MEMO_*`, `TRANSITION_MEMO_*`, `MEMO_LIMIT`, `MEMO_MAX_MESSAGE_BYTES`, `CLOSURE_MEMO_*`, `2_097_152`, `1024`
near the trust memo), the Map names, the four source files as text, any hash of them, and specs/.

No tracked file pins any ceiling, entry bound or key format of these caches, and no file hashes these source files.
Nothing in specs/ (G1–G28, registries, vectors) fixes them.

(i) Unaffected (behaviour holds for any ceiling and for the trim):
- `packages/canonical/tests/codec-differential.test.ts` "hashDomain exact-input memo" (results equal the frozen
  reference for repeated/mutated/sliced/exotic inputs; the 12 × 4 MiB case only checks digests after eviction).
- `packages/node/tests/creator-closed-rollback-proof-accounting.test.ts` extracts named top-level functions from
  creator-transition-advance.ts (`inspectCreatorTransitionAdvanceOwned`, the uncached wrapper
  `inspectCreatorTransitionAdvance`, settlement functions), never the memo. Safe while the trim adds no top-level
  function with an extracted name, no `const SETTLEMENT_*`, leaves the recheck text and the 1374 wrapper as they are.
- `tests/fixtures/startup-discovery/canonical-capture-observation.test.ts` (transpiles codec.ts; imports must
  resolve from canonical) and `tests/fixtures/startup-discovery/build.ts` critical profiling (exactly 4
  encode/decode call sites in codec.ts): a ceiling change touches only constants.
- `phase-0a-contract` source rules (canonical src must not contain the standalone word "Buffer", etc.) and
  `protocol-v3-anchor-trust-3a0` zero-effects rules (no "append", "setTimeout", `globalThis` in index.ts): a
  ceiling change touches only numbers.
- pending-discovery auth-transform test: exactly 2 `inspectCreatorTransitionAdvance(` sites in
  `authenticatePendingCandidate` (no caller is touched).
- Behavioural tests that depend on hit/miss semantics or `proposed` identity (d110c corrective RED, phase-6b
  boundaries, retirement-checkpoint RED, forward-promotion RED): the trim keeps the hit path and the result shape.
- `tests/fixtures/phase-6c/retained-heap-contract.ts` heap limits: lower ceilings only lower the heap.
- `packages/node/tests/healthy-grid-profiler-validation.test.ts` reads `tests/fixtures/startup-discovery/
  r8-source-binding.pw.ts` and `healthy-grid.ts` as text (profiler/trace control sequences, `128*1024*1024`,
  `traceBufferSizeInKb:65536`, the order inside the `apiEnd` finally block). Found in step 6 (missed in the first
  sweep, which looked for readers of the cache files). The probe hooks and the endurance opt-in touch none of the
  strings it reads: 20/20 after each change.

(ii) RED / governance / frozen / registry / vector — never edited; amendments for the owner:
- Tests counting `@noble` `ed25519.verify` calls beneath the memo: `tests/protocol-v3-admitted-vertex-extraction-
  3a1b-seam1-red.test.ts` (821/840/920/1316/1458 expect `verify: 1`; 7 of its tests already fail at base),
  `tests/protocol-v3-blueprint-admission-0i.test.ts` (521/547; 1 test fails at base, unrelated),
  `tests/protocol-v3-blueprint-operation-budget-0p2.test.ts` (566/576; 1 test fails at base, a registry hash).
  A lower ed25519 ceiling could change these counts only if a test made more than the new ceiling's worth of
  distinct verifications between a first verification and a counted repeat. No amendment needed unless the step-8
  per-test diff shows a change; if it does, the amendment is to count with the memo cleared, which needs owner
  approval (they are RED tests).
- None for the transition-memo trim.

(iii) Code to change:
- Trim: `packages/node/src/internal/creator-transition-advance.ts` memo section only (`TransitionMemoEntry`,
  `transitionMemoKey`'s return, `inspectCreatorTransitionAdvanceExact`'s insert). No caller changes.
- Ceilings (only if approved): the constants in codec.ts (`HASH_MEMO_MAX_BYTES`, `HASH_MEMO_MAX_ENTRIES`),
  protocol-v3 index.ts (1024 / 2_097_152 in `isAnchorTrustStateRecordBytes`), ed25519-verify.ts (`MEMO_LIMIT`),
  storage values.ts (`CLOSURE_MEMO_ENTRIES`). Each in its own commit; dist rebuilt for canonical, storage,
  protocol-v3 (then compaction) after each.
- Docs citing these line ranges (realtime-latency tracks) are historical records; not edited.

## 3. Measurement hook (what and why)

- `tests/fixtures/cache-probe/plugin.ts`: an esbuild plugin that, in the bundle only, rewrites each cache's
  declaration `const <name> = new Map(...)()` into `probeCache("<name>", new Map(...)())`, and refuses to build if
  any declaration is not found exactly once. The library sources are never changed, so the library has no hook, no
  flag and no cost when the probe is off: a shipped build or a default test bundle is byte-identical to before.
- `tests/fixtures/cache-probe/probe.ts`: a `Map` subclass with identical behaviour that records hit / miss / insert /
  evict / per-miss recomputation time per cache, phase (the harness's measured API), role and epoch, and flushes
  packed events to a harness sink.
- Enabled only by explicit build flags in measurement harnesses: `STARTUP_CACHE_PROBE=1` (Grid,
  tests/fixtures/startup-discovery; refused together with profiling, fault or shadow builds),
  `TRACK_M_APPS_CACHE_PROBE=1` (Canvas/Chat browser long room, tests/fixtures/track-m-apps/browser), and
  `tests/fixtures/cache-probe/build-node.ts` (Node long room, both roles in one process). Defaults unchanged.
- Residency-only mode (step 7, endurance runs): `cacheProbePlugin({ residencyOnly: true })`,
  `STARTUP_CACHE_PROBE=residency`, `build-node.ts <out> residency`. No events and no key table, so the probe's own
  memory is bounded by the caches' entries; flushes carry each cache's resident entries/size only.
- Endurance past 128 rollovers: `STARTUP_HEALTHY_GRID_ENDURANCE_MAX` (129..1024), a separately named opt-in; unset,
  the spec's and healthy-grid.ts's rollover checks are unchanged for every value.
- Why this design: the brief requires hooks off by default, zero cost off, never on a shipped hot path and behind a
  flag the library never reads. A source-level counter would sit on the hash path (hundreds of thousands of calls
  per run); a bundle rewrite puts nothing in the library at all.
