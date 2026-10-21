# Track Y: trim the library caches and size their ceilings

- Worktree: `<worktree agent-a9be4231f2bd8f2ac>/`, branch `worktree-agent-a9be4231f2bd8f2ac`, from
  `codex/phase3a1b-p6-golden-path` at **760607d9** (Track U merged), rebased onto **af342318** (the owner's
  decisions, rows 42–46; `docs/realtime-latency/README.md` only). Nothing was pushed. The commit ids below are the
  rebased ones; the measurements ran on the same trees before the rebase, which changed no file outside that
  README.
- Working notes: `<evidence>/track-y/PROGRESS.md`. Map: `<evidence>/track-y/MAP.md`. Grid runs:
  `<evidence>/track-y/grid/`. Canvas and Chat (browser): `<evidence>/track-y/apps/`. Node long rooms:
  `<evidence>/track-y/node/`. Heap diffs: `<evidence>/track-y/heap/`. Suite reports: `<evidence>/track-y/tests/`.
  Logs: `<evidence>/track-y/logs/`. Scripts: `<evidence>/track-y/bin/`. Base tree for comparisons:
  `<evidence>/track-y/base/` (a detached worktree at 760607d9, built the same way).
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
- "Base" is 760607d9. "Head" is this branch with the trim and the three approved ceilings.

## 1. Outcome in brief

- **Per client, the library's caches at their ceilings go from about 64.5 MB to about 41.7 MB.** The trim
  saves about 18.6 MB, and the three lowered ceilings about 4.2 MB. The hash memo, kept at 32 MiB by the owner's
  decision, is about 40.6 MB of the 41.7 (§6.1).
- **All five caches are pure performance caches** (§3). Each key is the exact input bytes, a hit only skips
  recomputing a pure function of them, and an eviction only makes that computation run again. None persists, so
  a reopen starts empty and crash behaviour is unchanged. No tracked test, artifact, registry, vector or spec pins
  a ceiling. The three RED tests that count `ed25519.verify` calls kept their counts at 2,048.
- **The trim** (a3891f11): the transition memo keeps only a room's newest two epochs. Every measured hit is on
  those two, so it loses nothing: over 256 Grid epochs and 256 Canvas epochs at head, its hits equal those of an
  unbounded memo. The memo now holds 4 entries (about 0.18 MB) per client at every epoch, instead of growing to
  16 MiB (G1). No check is relaxed: a dropped entry only means the full predicate runs again.
- **Ceilings applied** (owner decision, row 44): trust-record verdicts 128 records / 262,144 characters, ed25519
  2,048 entries, closure digests 512 entries, each in its own commit. Over 256 Grid epochs they lost no hit, except
  4 ed25519 re-verifications in lulls (about 2 ms in total for 4 clients). **Kept:** the hash memo, 32 MiB / 32,768.
- **Memory levels off past 256 epochs** (§7), through a new opt-in, `STARTUP_HEALTHY_GRID_ENDURANCE_MAX`, that
  leaves the existing 128-rollover check unchanged:
  - **Grid**, 4 clients in one renderer: JS heap after GC 105.6 MB at e128 and 107.3 MB at e256, a late slope of
    0.012–0.016 MB per epoch (base: 115.8 MB, 0.035 from e128). Everything reachable, ArrayBuffers included, grows
    0.013 MB per epoch between e150 and e250, against 0.202 at base; ArrayBuffer data is flat. Every cache is at
    its ceiling or steady state, and no store's rows change after e8.
  - **Canvas** (browser, 256 epochs): late slope 0.012 (creator) and 0.005 MB per epoch (recipient), against
    0.023 and 0.018 at base; 3.9–4.1 MB less JS heap at e256.
  - **Chat** (browser, 56 epochs, the app's limit): late slope 0.010 and 0.081, against 0.029 and 0.101 at base. The
    recipient's hash memo is still filling when the run ends.
  - **Node long room** (both roles in one process, 256 epochs): the caches are flat from e32, and the remaining
    heap slope is the harness's own records and V8 code (heap snapshots). The process holds 18.5 MB less than base
    at e256.
- **Latency is unchanged** (§8). Over 7 interleaved pairs per mode (8 rollovers, room database with retention),
  head/base is 0.93–1.01 for seal, adoption, install, per-move issue, lulls and reopen, inside the 1.03–1.085 band
  of a same-build control.
- **Suites** (§9): compared per test against base, every difference is a load timeout that passes alone on both
  trees. The three RED tests that count `ed25519.verify` calls are unchanged at 2,048. Canvas and Chat e2e: 9 of 9
  on both. `pnpm -r typecheck`: 0 errors. The shadowed-sources guard is silent.

## 2. Commits

| Commit   | Kind             | What                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6bbd0aac | measurement only | Cache probe (`tests/fixtures/cache-probe/`): an esbuild plugin that, in a measurement bundle only, wraps each cache's `new Map()` in a recording `Map` subclass. Enabled by `STARTUP_CACHE_PROBE=1` (Grid), `TRACK_M_APPS_CACHE_PROBE=1` (Canvas and Chat in the browser) and `tests/fixtures/cache-probe/build-node.ts` (Node long room). |
| 333a7744 | RED test         | `packages/node/tests/creator-transition-memo-epoch-retention-red.test.ts`: across 300 epochs the transition memo holds only a lineage's newest epochs, releases the rest to the collector, keeps other rooms' entries, and returns exactly the original predicate's result. 2 of 4 fail at base.                                           |
| b74b7807 | RED test fix     | The RED test's collector check takes its weak references in a synchronous frame (a suspended async frame kept the last entry alive). Still RED at base: 10 of 10 old entries survive.                                                                                                                                                      |
| a3891f11 | library          | **The trim.** The transition memo keeps only a room's newest two epochs (`TRANSITION_MEMO_EPOCHS = 2` per lineage, applied when an entry is stored). The 16 MiB ceiling stays as a backstop.                                                                                                                                               |
| 5c49dd8e | library          | Trust-record verdicts: 128 records and 262,144 key characters (was 1,024 and 2,097,152). Owner decision, row 44.                                                                                                                                                                                                                           |
| 8f77597e | library          | ed25519 verify memo: 2,048 entries (was 4,096). Owner decision, row 44.                                                                                                                                                                                                                                                                    |
| 0702f6c5 | library          | Closure digests: 512 entries (was 4,096). Owner decision, row 44.                                                                                                                                                                                                                                                                          |
| 88b29074 | measurement only | `STARTUP_HEALTHY_GRID_ENDURANCE_MAX` (an explicit integer from 129 to 1024): the only way a Grid run may exceed 128 rollovers. Unset, both rollover checks are unchanged for every value.                                                                                                                                                  |
| 00efcc53 | measurement only | Residency-only probe (`STARTUP_CACHE_PROBE=residency`, `cacheProbePlugin({ residencyOnly: true })`): no events and no key table, so the probe's own memory stays bounded in long runs.                                                                                                                                                     |
| 864cc983 | measurement only | The Node long-room runner, under `node --expose-gc`, records the process's memory after a forced GC at every epoch.                                                                                                                                                                                                                        |
| RESULT   | docs             | This file.                                                                                                                                                                                                                                                                                                                                 |

The hash memo is unchanged, by the owner's decision (row 44).

## 3. The five caches (map summary)

The full map, with every caller and path, is `<evidence>/track-y/MAP.md`.

| Cache                 | Where (base)                                             | Key                                                                         | Bound at base                           | Eviction |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- | -------- |
| `hashMemo`            | canonical `internal/codec.ts` 1391–1505, `hashDomain`    | domain, part count and lengths, two 32-bit lanes; a hit compares every byte | 32 MiB of parts, 32,768 entries         | LRU      |
| `transitionMemo`      | node `internal/creator-transition-advance.ts` 1380–1545  | every trust field and registered material scalar, every ref; bytes compared | 16 MiB of copied bytes, 4 MiB per entry | LRU      |
| `trustRecordVerdicts` | protocol-v3 `index.ts` 1180–1211, `createAnchorTrustApi` | latin1 string of the complete record bytes                                  | 1,024 records, 2,097,152 key characters | FIFO     |
| ed25519 `memo`        | protocol-v3 `internal/ed25519-verify.ts`                 | lengths plus every byte of signature, message and public key                | 4,096 entries (messages up to 256 B)    | FIFO     |
| `closureDigests`      | storage `values.ts` 102–131, `digestClosure`             | digest and length of every reference of the copied, sorted closure          | 4,096 entries (closures up to 64 refs)  | FIFO     |

**Each is a pure performance cache** (MAP.md §1):

- The cached value is a pure function of the key's exact bytes: a SHA-256 digest, the success of the strict
  transition predicate, a decode verdict, a strict Ed25519 verdict, a closure digest.
- The key is exact. The hash memo and the transition memo also compare every byte of the input against private
  copies on a hit. The other three spell every byte (or every digest and length) into the key.
- A hit cannot skip a check whose result could differ. Inputs a cache cannot key exactly (accessors, subclassed or
  shared buffers, unregistered trusts, oversize inputs) bypass it and run the original.
- Evicting an entry only makes the original computation run again on the same bytes. It cannot change a verdict,
  an admission, a digest, an ordering or a stored byte.
- **Nothing persists.** All five are module-level `Map`s, never serialised, never read from or written to storage.
  A reopen (new realm or new process) starts with all five empty, and a crash has nothing to recover.
- In Node, every room and client in one process shares one set. In a browser, each realm (tab, worker) has its
  own.

Two pre-existing caveats, unchanged and in-process only: the hash memo's key relies on domain strings containing
no NUL (every production domain is a constant without one), and the ed25519 memo does not guard against a
`Uint8Array` subclass whose `byteLength` getter lies (every caller passes decoded, copied or computed bytes).

**Pins** (MAP.md §2). No tracked test, fixture, frozen artifact, registry, vector or spec pins any ceiling, key
format or bound of these caches, and no file hashes their sources.

- Class (ii), never edited: three RED tests count `@noble` `ed25519.verify` calls beneath the memo
  (`tests/protocol-v3-admitted-vertex-extraction-3a1b-seam1-red.test.ts`, `tests/protocol-v3-blueprint-admission-0i.test.ts`,
  `tests/protocol-v3-blueprint-operation-budget-0p2.test.ts`). A lower ceiling could change a count only if a test
  made more distinct verifications than the ceiling between a first check and a counted repeat. At 2,048 no count
  changed (§9). No amendment is needed.
- Class (i), read as text or depending on behaviour that every ceiling keeps: the codec differential test, the
  proof-accounting test that extracts functions from creator-transition-advance.ts (the trim adds no top-level
  function and leaves the uncached wrapper as it was), the startup-discovery capture tests that transpile codec.ts,
  the phase-0a and 3a0 source rules, the pending-discovery transform test (2 call sites, untouched), and
  `packages/node/tests/healthy-grid-profiler-validation.test.ts`, which reads the Grid spec and `healthy-grid.ts`
  as text (20/20 after every harness change).

## 4. Measurement at base

### 4.1 The probe, and why this design

- `tests/fixtures/cache-probe/plugin.ts` is an esbuild plugin. In a measurement bundle only, it rewrites each
  cache's declaration `const <name> = new Map(...)` into `probeCache("<name>", new Map(...))`. It refuses to build
  if any declaration is not found exactly once.
- `tests/fixtures/cache-probe/probe.ts` is a `Map` subclass with identical behaviour. It records hit, miss, insert,
  eviction and the time to recompute after a miss, per cache, phase (the harness's measured API), role and epoch,
  and flushes packed events to a harness sink.
- The library sources carry no hook, flag or branch, so the library has no cost when the probe is off: a shipped
  build or a default test bundle is unchanged. A counter in the library would sit on the hash path, which runs
  hundreds of thousands of times per run.
- Enabled only by explicit build options in measurement harnesses: `STARTUP_CACHE_PROBE=1` or `residency` (Grid),
  `TRACK_M_APPS_CACHE_PROBE=1` (Canvas and Chat in the browser), and `build-node.ts` (Node long room, both roles in
  one process on the Node SQLite host).
- Model replays: `bin/probe_report.py` replays each cache's recorded access trace through a model of its own
  eviction rule at candidate ceilings. The model at the run's real ceiling reproduces the real hit count exactly,
  which checks the model.

### 4.2 Hit rates (base, all paths and roles)

| Run                        | hash  | closure | ed25519 | trust | transition |
| -------------------------- | ----- | ------- | ------- | ----- | ---------- |
| Grid LULL=1, 64 epochs     | 0.968 | 0.998   | 0.959   | 0.971 | 0.714      |
| Grid concurrent, 64 epochs | 0.965 | 0.998   | 0.961   | 0.971 | 0.714      |
| Canvas browser, 64 epochs  | 0.981 | 0.999   | 0.986   | 0.983 | 0.815      |
| Chat browser, 56 epochs    | 0.981 | 0.999   | 0.984   | 0.985 | 0.827      |
| Node Canvas, 128 epochs    | 0.995 | 1.000   | 0.995   | 0.994 | 0.933      |
| Node Chat, 56 epochs       | 0.994 | 1.000   | 0.994   | 0.994 | 0.937      |

Every cache earns its place, so all five stay. Evidence: `grid/run-probe-lull-64`, `grid/run-probe-conc-64`,
`apps/probe-canvas-64`, `apps/probe-chat-56`, `node/base-canvas-node-128`, `node/base-chat-node-56` (each with
`probe-report.txt`), and `ceilings-base.txt` (the model replays at every candidate ceiling).

### 4.3 How old the entries that hit are (Grid LULL=1, 64 epochs)

- **Transition memo:** by the epoch the key names, adoption hits the current transition (511) or the previous one
  (60), install and export the current one, the lull the previous one (93) or the one before (60), and reopen the
  previous one. Nothing older than 2 epochs is ever read again.
- **Trust verdicts:** every hit is on a record inserted at most 2 epochs earlier.
- **Closure digests:** 88% at most 4 epochs old; the oldest is 6.
- **Hash memo and ed25519:** 88% at most 4 epochs old and 95% at most 8. The rest is a small set of constant
  entries re-read every epoch (for ed25519, about 15 hits per epoch in adoption and 13 in seal across the five
  realms).

### 4.4 What fills each cache at base

- **Hash memo:** full (32 MiB of parts) by about epoch 16 on the creator and 48 on recipients. Most of it is
  write-once retirement images and retention decisions.
- **Transition memo:** 2 entries (about 88 KB) per epoch until 16 MiB, around epoch 190.
- **Trust verdicts:** about 7 records per epoch until the 2,097,152-character cap, around epoch 106.
- **ed25519:** 16–66 inserts per epoch per realm.
- **Closure digests:** about 2 inserts per epoch.

### 4.5 Cost of a miss (browser, 100 µs clock; `grid/run-probe-cost-lull-16`, `apps/probe-cost-apps-24`)

Transition 2.2–2.5 ms (5.6 ms at reopen), ed25519 about 0.6 ms, trust and closure under 0.1 ms, hash mostly under
0.1 ms (about 10 µs plus 7 µs per KiB, so up to a few ms for the largest entries).

## 5. The transition-memo trim (a3891f11)

### 5.1 The change

In `packages/node/src/internal/creator-transition-advance.ts`, memo section only:

- `TRANSITION_MEMO_EPOCHS = 2`.
- `transitionMemoKey` also returns the entry's lineage, `JSON.stringify([genesisAnchorDigest, objectId])` of the
  current trust, and the current trust's `currentEpoch`. Both are already part of the key. An input without a
  current trust gives no key, as before.
- `TransitionMemoEntry` carries `lineage` and `epoch`.
- When `inspectCreatorTransitionAdvanceExact` stores a check, it drops the same lineage's entries whose epoch is at
  least 2 below the lineage's newest. The 16 MiB LRU ceiling still applies afterwards, as a backstop for processes
  holding many rooms.
- The key, the hit path, the stored result, the uncached wrapper and every caller are unchanged. No caller file
  (creator-adoption\*, creator-close, closed-rollback-data, v3-live, room-network) was edited.

### 5.2 Why it is safe, guarantee by guarantee

- **No check is relaxed (G3, G5, G26).** A dropped entry only means that a later identical check runs the full
  predicate again. A hit still requires byte equality of every candidate, material and ACL byte. Nothing is
  admitted without full authentication.
- **G1.** The memo now holds a constant number of entries per room: at most 2 epochs × the checks per epoch (4
  entries, about 0.18 MB per realm in every run), instead of growing to 16 MiB.
- **G5, G15 (untrusted bytes, crash atomicity).** The memo is never persisted, so stored bytes, reopen and crash
  behaviour are unchanged. Every store's rows and bytes were identical to base at every epoch (§5.3).
- **G21 (bounded work).** The insert-time scan is bounded by the memo's entry count, itself bounded by the 16 MiB
  ceiling. It costs under 1 µs at the real size (4 entries) and 7 µs with a full 16 MiB memo (380 entries), and
  it only follows a miss that has just run the full ~2.3 ms predicate (`bin/trim_bench.mjs`).
- **G27 (no game-specific carve-outs).** The window is per lineage, from fields every room has; nothing depends on
  the game.

### 5.3 Proof

- **RED test** (`packages/node/tests/creator-transition-memo-epoch-retention-red.test.ts`): 4/4 at head; 2 of 4
  fail at base.
- **Keep-2 is lossless.** Replaying every base run (Grid LULL and concurrent, Canvas, Chat, Node Canvas 128, Node
  Chat 56) loses 0 hits; keep-1 would lose 120–620 hits per run at about 2.3 ms each. At head, the 256-epoch Canvas
  run's real hits equal an unbounded memo's (5,626, §7.3).
- **Shadow mode.** Node long rooms in which every cache hit is re-checked against the uncached computation
  (Canvas 64, Chat 48 epochs, trim and base, `node/shadow/`): 0 mismatches over 3.76M hash, 271K closure, 96K
  ed25519, 123K trust and 2,610 transition hits. Transition hits are identical to base (2,610 and 2,118).
- **Storage identical.** In the same runs, every table's rows and bytes are identical to base at every epoch, as
  are the lull kinds, retention outcomes and declines, and event kinds (`bin/census_detail.py`). Only the database
  file plus WAL size differs, and two base runs differ the same way (checkpoint timing).
- **Transition tests per test** (11 files, 474 tests, `bin/transition-tests.sh`): 472 identical; the 2 that
  differ are load timeouts in opposite directions, and both time out alone at base too. Repeated at the final,
  rebased head (`suites/transition-rebased.json`): the same results as base except 4 proof-accounting tests that hit
  the 10 s default timeout at load 60; alone, all 4 pass on head and on base (`tests/rerun-tr-proof-*.json`).

## 6. Ceilings

### 6.1 Applied and kept (owner decision, row 44)

| Cache                 | Base                                 | Head                                       | Per client at the ceiling (`bin/footprint.mjs`) |
| --------------------- | ------------------------------------ | ------------------------------------------ | ----------------------------------------------- |
| Hash memo             | 32 MiB / 32,768                      | **kept**                                   | 40.6 MB → 40.6 MB                               |
| Transition memo       | 16 MiB (full near epoch 190)         | newest 2 epochs per room (16 MiB backstop) | 18.8 MB → 0.2 MB                                |
| Trust-record verdicts | 1,024 records / 2,097,152 characters | 128 / 262,144                              | 2.14 MB → 0.27 MB                               |
| ed25519 verify memo   | 4,096                                | 2,048                                      | 0.81 MB → 0.39 MB                               |
| Closure digests       | 4,096                                | 512                                        | 2.18 MB → 0.27 MB (largest keys: 18.9 → 2.4)    |
| **Total**             |                                      |                                            | **about 64.5 MB → about 41.7 MB**               |

The footprint counts each cache's own bytes, keys and Map overhead (the hash memo's private part copies are most
of its 40.6 MB). Measured in the 256-epoch Grid (`grid/run-endure-fin-res-256/residency.txt`), each client realm
holds 33.9–34.3 MB of hash memo by the probe's count (parts plus keys and digests), 0.18 MB of transition memo,
0.26 MB of trust-record keys, 2,048 ed25519 entries (0.28 MB of keys) and up to 512 closure digests (0.24 MB).

**Per client at the ceilings: about 41.7 MB, against about 64.5 MB before. The saving is about 22.8 MB, 18.6 MB
of it from the trim.**

### 6.2 What each lowered ceiling costs

Each cache is a pure speed-up, so a lower ceiling can only make some work run again. Model replays of every base
run at the new ceilings lost no hit (`ceilings-base.txt`). At head, the long runs confirm it (§7.3): over 256
epochs of Grid, 256 of Canvas and 56 of Chat, the trust verdicts and the closure digests lost no hit against an
unbounded memo, and the ed25519 memo lost 4 hits against its old ceiling, in the Grid only.

- **Trust verdicts, 128 / 262,144.** A steady room re-reads at most about 50 distinct records per client; 32
  entries is already lossless in every run. A miss costs under 0.1 ms.
- **ed25519, 2,048.** At most 1,417 distinct inputs live per client over 64 epochs. Because eviction is FIFO, a
  constant signature re-read every epoch is evicted once per 2,048 inserts (about every 90–130 epochs in the Grid,
  about 290 in Canvas) and costs one re-verification, about 0.6 ms in a browser. Measured over 256 Grid epochs:
  4 more re-verifications than at 4,096, about 2 ms in total for 4 clients.
- **Closure digests, 512.** At most 131 distinct closures live per client (259 in one Node process holding both
  roles); every hit is at most 6 epochs old. A miss costs under 0.1 ms.
- **Cold reopen and the first transition after a long lull:** unchanged. Every cache starts empty on reopen either
  way, and the caches age only by new entries, never by time.
- **Node hosts with many rooms:** in Node, a ceiling is per process and shared by every room. The measured
  per-room working sets (trust about 30 records, ed25519 a few hundred entries, closure about 130 entries) fit a few
  simultaneously active rooms at the new ceilings; past that, a miss costs at most 0.6 ms (ed25519) or 0.1 ms. The
  hash memo, which matters most for that case, is kept at 32 MiB. A multi-room host was not measured.

## 7. Memory over 256 epochs

### 7.1 Grid: 256 rollovers, head and base (`STARTUP_HEALTHY_GRID_ENDURANCE_MAX=256`)

Method (Track U's): the healthy native Grid, 4 clients, concurrent moves, room database with retention, harness
records counted, M2's proof-event kinds, no task trace, a forced GC at every adopted-N checkpoint, and heap
snapshots after adopted-150 and adopted-250. The heap figure is CDP's `JSHeapUsedSize` for the one renderer (the
4 client realms and the parent page). It excludes ArrayBuffer backing stores, which hold the hash memo's and the
transition memo's byte copies; the heap snapshots count those too. Base uses the base tree plus only the endurance
opt-in's `healthy-grid.ts` hunk (`bin/base_endurance_patch.py`, bundle `grid/base-end-1`).

| Run (bundle)                             | Result        | JS heap after GC, MB (e8 / e50 / e128 / e192 / e256) | Slope MB/epoch (e50+ / e128+ / e192+) |
| ---------------------------------------- | ------------- | ---------------------------------------------------- | ------------------------------------- |
| Head (`grid/fin-1`)                      | pass, 2,320 s | 84.4 / 102.5 / 105.6 / 106.3 / 107.3                 | 0.023 / 0.012 / 0.016                 |
| Head, residency probe (`grid/fin-res-1`) | pass, 2,247 s | 84.9 / 103.7 / 107.5 / 108.1 / 109.5                 | 0.025 / 0.012 / 0.017                 |
| Base (`grid/base-end-1`)                 | pass, 2,636 s | 84.6 / 104.5 / 111.3 / 114.3 / 115.8                 | 0.055 / 0.035 / 0.019                 |

Both runs reached epoch 256 in phase `continued-gameplay`, with the receipt valid and no proof events truncated.
Retention applied every pass (creator 252, recipients 759) with the same declines in both trees (ahe-birth 4,
journal-same-epoch 1, signing-same-epoch 2). Evidence: `grid/endure-fin-256.txt`, `grid/endure-base-256.txt`
(`bin/endurance.py`), `bin/grid_heap.py`.

**All memory, from the heap snapshots (adopted-150 → adopted-250, `bin/heapdiff.mjs`):**

|                                   | Head                      | Base                      |
| --------------------------------- | ------------------------- | ------------------------- |
| Everything reachable, at a250     | 417.9 MB                  | 492.5 MB                  |
| Everything reachable, a150 → a250 | +1.33 MB (0.013 MB/epoch) | +20.2 MB (0.202 MB/epoch) |
| JS heap only, a150 → a250         | 0.0115 MB/epoch           | 0.030 MB/epoch            |
| ArrayBuffer data, a150 → a250     | +0.13 KB/epoch (flat)     | +170 KB/epoch             |

- At a250 the renderer holds 74.6 MB less at head, about 18.7 MB per client realm.
- **Head, per client realm, at a150 and at a250 (the same objects):** hash memo 35.3–37.4 MB (full, unchanged
  between the snapshots), transition memo 0.18 MB (4 entries), ed25519 memo 2,048 entries (0.31 MB of keys),
  trust verdicts 82–93 records (0.26 MB of keys). The closure digests hold at most 512 entries (0.24 MB, from the
  residency probe).
- **Base, per client realm, at a250:** the transition memo is 17.9 MB and still growing (13.3 MB at a150), the
  ed25519 memo is full at 4,096 entries (0.62 MB of keys), and the trust verdicts hold 649–743 records (2.1 MB of
  keys).
- **What still grows at head**, per epoch for the whole renderer: V8 optimized code about 5.8 KB
  (InstructionStream, TrustedByteArray, ProtectedFixedArray), strings 2.4 KB, plain objects, heap numbers and
  property arrays about 3 KB, and the harness's long-task and long-animation-frame observer entries about
  0.6 KB (`STARTUP_HEALTHY_GRID_LONGTASKS=1`). None of it is a library cache: every named cache is the same size in
  both snapshots. The 1.6 MB per epoch of "new retained" objects under the caches is churn (new entries replacing
  evicted ones), not growth. Track U's run B grew 420 KB per epoch in all memory, mostly transition-memo copies.

**Every cache at its ceiling or steady state** (residency probe, `grid/run-endure-fin-res-256/residency.txt`,
per client realm):

| Cache           | e8              | e64             | e128            | e256            | Steady from                                         |
| --------------- | --------------- | --------------- | --------------- | --------------- | --------------------------------------------------- |
| Hash memo       | 6.7–26.2 MB     | 33.9–34.3 MB    | 33.8–34.3 MB    | 33.9–34.3 MB    | e32 (creator), e64                                  |
| Transition memo | 4 / 0.18 MB     | 4 / 0.18 MB     | 4 / 0.18 MB     | 4 / 0.18 MB     | e2 (newest epochs 254, 255 at the end)              |
| Trust verdicts  | 50–58 / 0.16 MB | 79–91 / 0.26 MB | 80–92 / 0.26 MB | 79–91 / 0.26 MB | e32 (character cap)                                 |
| ed25519         | 185–193         | 1,361–1,425     | 2,048           | 2,048           | about e100                                          |
| Closure digests | 11–19           | 67–131          | 131–259         | 259–512         | creator 512 at e256; recipients reach 512 near e510 |

**Storage is flat** in both trees: no store's rows change after adopted-8 on any client, and IndexedDB's allocated
size moves between 3 and 27 MB with LevelDB compaction, with no trend (slope 0.017 MB/epoch at head, 0.003 at
base).

### 7.2 Canvas and Chat: Track M's browser long room

Room database with retention, reader lulls, a forced-GC used-heap figure per page per epoch (`TRACK_M_APPS_HEAP=1`,
JS heap only), `bin/tma_heap.py`. Canvas runs 256 epochs. Chat stops at 56 epochs: at 2 messages per epoch its
state reaches the app's own limit (Track W is replacing it with a rolling window).

| Run              | Role      | JS heap after GC, MB (e8 / e64 or e56 / e256) | Slope, late half (MB/epoch) | Rows (flat) |
| ---------------- | --------- | --------------------------------------------- | --------------------------- | ----------- |
| Canvas 256, head | creator   | 21.5 / 27.9 / 30.6                            | 0.012                       | 129         |
| Canvas 256, base | creator   | 21.6 / 29.0 / 34.5                            | 0.023                       | 129         |
| Canvas 256, head | recipient | 14.8 / 19.6 / 24.3                            | 0.005                       | 94          |
| Canvas 256, base | recipient | 14.9 / 20.6 / 28.4                            | 0.018                       | 94          |
| Chat 56, head    | creator   | 22.7 / 27.9 (e56)                             | 0.010                       | 135         |
| Chat 56, base    | creator   | 22.8 / 28.7 (e56)                             | 0.029                       | 135         |
| Chat 56, head    | recipient | 16.3 / 22.0 (e56)                             | 0.081                       | 129         |
| Chat 56, base    | recipient | 16.4 / 22.9 (e56)                             | 0.101                       | 129         |

- Canvas at head is 3.9–4.1 MB lighter in JS heap at e256 (the trust keys, transition-memo keys and ed25519 keys;
  the byte copies are outside this figure), and its late slope is a half to a third of base's.
- Chat's recipient is still filling at e56: its hash memo holds 27.7 MB and grows 0.54 MB per epoch
  (`apps/fin-probe-chat-56`), as Grid recipients do until about e64. The run ends before the plateau. Chat's
  snapshot bytes grow 1.1 KB per epoch in both trees: that is the messages themselves (application state, as Track
  U found), not protocol overhead.
- Residency at head (full probe, `apps/fin-probe-canvas-256/residency.txt`): the Canvas recipient's hash memo
  fills at about e128 (34.9 MB) and stays there; the transition memo holds 4 entries (0.09 MB) throughout; trust
  verdicts reach 128 records at e32; ed25519 reaches 1,795 entries at e256 (it would reach 2,048 near e290); the
  creator's closure digests reach 512 at e256.

### 7.3 Hits lost at the new ceilings, measured over the long runs

With the full probe at head, the model replay at "unbounded" (no eviction at all) gives the most hits any ceiling
could give. Where the real run's hits equal it, the ceiling lost nothing.

| Run (head, full probe)                     | Transition (keep 2) | Trust (128)         | ed25519 (2,048)                                        | Closure (512)                  | Hash (32 MiB, kept)    |
| ------------------------------------------ | ------------------- | ------------------- | ------------------------------------------------------ | ------------------------------ | ---------------------- |
| Canvas 256 (`apps/fin-probe-canvas-256`)   | 5,626 = unbounded   | 193,776 = unbounded | 316,373 = unbounded (peak 1,795)                       | 542,336 = unbounded (peak 515) | 4,601,441 of 4,601,442 |
| Chat 56 (`apps/fin-probe-chat-56`)         | 1,336 = unbounded   | 49,701 = unbounded  | 65,311 = unbounded                                     | 118,058 = unbounded            | 1,188,878 = unbounded  |
| Grid 256 (`grid/run-endure-fin-probe-256`) | 6,958 = unbounded   | 217,007 = unbounded | 702,489: 4 fewer than at 4,096, 8 fewer than unbounded | 897,271 = unbounded (peak 515) | 7,196,449 of 7,196,479 |

- The Grid is the only run in which the ed25519 memo fills (at about e100; unbounded, a realm would hold 5,641
  entries by e256). Against the old 4,096 ceiling it re-verified 4 more signatures over 256 epochs, all in lulls,
  across the 4 clients: about 2 ms in total, at most 0.7 ms in any one epoch of one client. These are the constant
  signatures of §4.3, evicted once per 2,048 inserts because eviction is FIFO.
- The transition memo's model at the old 16 MiB ceiling also gives 6,958, and keeping only 1 epoch would have lost
  504 hits (about 880 ms over the run). Keep-2 is exactly lossless over 256 epochs.
- The 30 hash-memo hits short of unbounded are lulls re-reading old retirement images. That is the kept 32 MiB
  ceiling, unchanged.

### 7.4 Node long room (both roles in one process, Node SQLite host)

Track M's long room run in one Node process (`tests/fixtures/cache-probe/node-long-room.ts`, residency probe,
reader lulls, the default Node SQLite host), with the process's memory after a forced GC at every epoch
(`bin/node_heap.py`). Both roles share one set of caches, as every room of a Node host would.

| Run              | heapUsed after GC, MB (e8 / e64 / e128 / e192 / e256) | heapUsed slope e128+ (last quarter) | ArrayBuffers, MB (e64 / e128 / e256) |
| ---------------- | ----------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Canvas 256, head | 44.0 / 55.3 / 60.0 / 64.2 / 67.2                      | 0.057 (0.048)                       | 35.6 / 36.1 / 37.0 (flat)            |
| Canvas 256, base | 44.1 / 56.9 / 63.3 / 69.1 / 74.1                      | 0.082 (0.080)                       | 52.0 / 43.8 / 48.6                   |
| Chat 56, head    | 46.5 / 57.8 (e56)                                     | last quarter 0.119                  | 36.5 (e32) / 41.1 (e56)              |
| Chat 56, base    | 46.6 / 59.2 (e56)                                     | last quarter 0.127                  | 46.9 (e32) / 40.2 (e56)              |

- **Every cache at its ceiling or steady state** (head, `node/fin-canvas-node-256-residency.txt`): the hash memo
  holds 34.0 MB from e32 to e256; the transition memo 4 entries (0.09 MB) throughout; the trust verdicts 128
  records from e32; the ed25519 memo 1,795 entries at e256 (filling 7 per epoch, to 2,048 near e290); the closure
  digests 512 at e256. The ArrayBuffer figure, which holds the memos' byte copies, is flat from e32.
- **Base, the same run** (`node/base-canvas-node-256-residency.txt`): the transition memo holds 512 entries and
  11.2 MB at e256 and still grows 44 KB per epoch (it would reach 16 MiB near e370), and the trust verdicts reach
  1,024 records (1.24 MB) near e180. At e256 the process holds 74.1 MB of heap and 122.7 MB of heap plus
  ArrayBuffers at base, against 67.2 and 104.2 MB at head.
- **What the remaining heap slope is.** Heap snapshots of the same process at e24 and e56 (`--heapsnapshot-signal`,
  `bin/node_snap.sh`, `heap/node-fin-canvas-e24-e56.txt`) attribute the growth, per epoch, to the harness: the
  observer's event array (+19.6 KB), the driver's per-epoch records (+14.3 KB) and the set of snapshot-chunk
  ports it closes only at the end (+16.6 KB); to V8's optimized code for library functions (+27.5 KB in the module
  context, early in the run); and to the ed25519 and closure memos still filling below their ceilings (+2.7 KB).
  No library cache grows past its bound.
- **Storage is flat** (`bin/node_census.py` over the same run's census): rows constant (creator 130, recipient 93),
  table bytes +7 B per epoch; the SQLite files (database plus WAL) settle at 21.1 MB (creator) from e32 and
  13.8–14.9 MB (recipient).
- **Chat** fills its hash memo by e16 and holds it at 34.0 MB in both trees; at head the transition memo holds 4
  entries and the trust verdicts 128, where base reaches 112 entries (2.5 MB) and 394 records by e56. Over 56
  epochs the ArrayBuffer figure moves between 36 and 47 MB in both trees without a common trend (head rises 4.6 MB
  from e32 to e56, base falls 6.7 MB), so this run is too short to show a Chat plateau in Node. Chat's own state
  grows with its messages until Track W's window lands.

## 8. Paired latency against base

Healthy native Grid, 8 rollovers, room database with retention, ABBA order (`bin/pairs.sh`), A = base
(`grid/base-1`), B = head (`grid/fin-1`, the trim and the three ceilings). Medians are per run, then the median of
the per-pair B/A ratios; "B slower" counts the pairs where head was slower (`bin/paired.py`, all transitions;
`grid/paired-pf.txt`, `grid/paired-pf-steady2.txt` for transitions 2 onwards). The load average ran from 40 to
235 during these runs. Pair 8 was lost to load in both trees (Playwright's 600 s suite timeout and a teardown
timeout at load 235) and is left out.

| Path (median, ms) | LULL=1, 7 pairs: base → head | B/A (B slower) | Concurrent, 7 pairs: base → head | B/A (B slower) |
| ----------------- | ---------------------------- | -------------- | -------------------------------- | -------------- |
| Seal              | 358.9 → 352.8                | 0.959 (1/7)    | 365.4 → 353.6                    | 0.943 (2/7)    |
| Creator adoption  | 666.6 → 636.6                | 0.958 (1/7)    | 724.6 → 692.3                    | 0.948 (3/7)    |
| Recipient install | 410.9 → 409.8                | 0.996 (2/7)    | 472.1 → 438.4                    | 0.929 (1/7)    |
| Per-move issue    | 48.3 → 47.9                  | 1.005 (4/7)    | 60.5 → 54.3                      | 0.939 (2/7)    |
| Creator lull      | 579.7 → 572.4                | 0.988 (3/7)    | 696.1 → 627.5                    | 0.935 (1/7)    |
| Recipient lull    | 300.1 → 302.1                | 0.971 (2/7)    | 360.8 → 345.5                    | 0.958 (3/7)    |
| Persisted reopen  | 1,312 → 1,286                | 0.966 (3/7)    | 1,389 → 1,397                    | 0.974 (2/7)    |

- **No path is slower.** Every ratio is between 0.93 and 1.01. The same-build control (two copies of the base
  bundle, interleaved, `grid/paired-paa.json`) came out at 1.03–1.085, so differences of this size are noise. Head
  was slower in at most 4 of 7 pairs for any path.
- **The trim alone**, measured before the ceilings (`grid/paired-pt-pu-pv.json`): LULL=1, 14 pairs, seal 1.018
  (pooled 261.5 vs 260.3 ms), adoption 1.013, install 1.020, move issue 0.993; concurrent, 8 pairs, seal 1.005,
  adoption 1.027, install 0.993, move issue 0.985. The trim's insert-time scan costs under 1 µs per insert.
- **The lowered ceilings add almost no recomputation** (§7.3): none for the trust verdicts and the closure
  digests in any run, and 4 ed25519 re-verifications in lulls over 256 Grid epochs (about 2 ms in total for 4
  clients). The worst case of each is in §6.2.

## 9. Suites, typecheck and the shadowed-sources guard

Each set ran on head and then on base (`bin/ysuite.sh`, `bin/suites_chain.sh`), from the repository root with
`--exclude ".claude/**" --no-coverage`, and was compared per test (`bin/vcompare.py`). Every difference was rerun
alone on both trees (`bin/rerun.sh`, `bin/reruns.sh`, `bin/reruns2.sh`; `tests/rerun-*.json`). The load average
was 60–300 during the full sets and about 25 during the reruns.

| Set                                                        | Base (pass / fail / skip) | Head              | Per-test differences                                                                                                                                | Alone, head and base                                                                  |
| ---------------------------------------------------------- | ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| RED tests counting `ed25519.verify` (seam1-red, 0i, 0p2)   | 45 / 9                    | 45 / 9            | none; the 9 failures' full messages are identical (`bin/fullmsg.py`)                                                                                | —                                                                                     |
| node (`packages/node`)                                     | 1,020 / 51 / 0            | 1,025 / 50 / 0    | +4 (the new RED test, passing); 2 network tests failed at head (a partial-outage count, a 25 s timeout); 3 proof-accounting tests timed out at base | all pass on both                                                                      |
| Root room and native tests (129 files, Tracks K–T)         | 1,447 / 364 / 107         | 1,431 / 365 / 122 | 3 head timeouts (4c snapshot stream, p2-a eslint spawn, p2-c engines); 15 head skips (a 10 s `beforeAll` timeout in p2-a-authoring-emitter-lint)    | identical: all pass, except 2 p2-a-lint tests that fail on both with the same message |
| canonical, protocol-v3, storage                            | 303 / 1                   | 303 / 1           | none                                                                                                                                                | —                                                                                     |
| storage-node retirement (6 files)                          | 156 / 51 / 2              | 157 / 50 / 2      | D.109b failed at head and D.93.34, D.109c at base: child-process timeouts                                                                           | all pass on both                                                                      |
| startup-discovery observers and profiler validation        | 54 / 0                    | 54 / 0            | none                                                                                                                                                | —                                                                                     |
| Transition tests (11 files reading or exercising the memo) | see §5.3                  |                   | 4 proof-accounting 10 s timeouts at the rebased head                                                                                                | all pass on both                                                                      |
| Canvas and Chat e2e (`playwright.canvas-chat.config.ts`)   | 9 / 0                     | 9 / 0             | none                                                                                                                                                | —                                                                                     |

- **The three RED tests that count `ed25519.verify` beneath the memo kept every count at 2,048.** Their 9
  failures (7 in seam1-red, 1 in 0i, 1 in 0p2, a registry hash) exist at base with the same messages. No RED or
  governance test was edited.
- The Canvas and Chat e2e ran at the rebased head and at base back to back, once no other track's e2e servers
  held their fixed ports (`tests/head-e2e.log`, `tests/base-e2e.log`; `bin/e2e_when_free2.sh`).
- Files that fail to load are the same in both trees (`creator-ordinary-generation-closure-capacity`,
  `proptest/spawn-scaling`, `protected-recovery-role-node-red`, `r11-real-game-terminal-native`,
  `r9-rpc-v3-room-native`).
- **`pnpm -r typecheck`: exit 0, 0 errors** at the rebased head (131 s, `logs/typecheck-rebased.log`; also 0 at
  864cc983's tree before the rebase). Its fixture sub-scripts run `tsc -p` on tsconfigs that all set
  `noEmit: true`.
- **`node scripts/check-shadowed-sources.mjs`: exit 0**, silent.
- The startup-discovery fixture's own tsconfig gives 123 errors at head against 122 at base; the extra one is
  `build.ts` resolving `@jridgewell/trace-mapping` types differently in the two checkouts (an environment
  difference, `logs/sd-b.txt`, `logs/sd-w.txt`). It is not part of `pnpm -r typecheck`.

## 10. What remains, and the risks

- **The hash memo is now most of the library's cache memory**: 35–37 MB per client realm, almost all of it
  private byte copies. It stays at 32 MiB by the owner's decision. The base measurement (`ceilings-base.txt`, and
  the 256-epoch Grid at head in §7.3) says 8 MiB would lose a few hundred lull hits per 256 epochs (about 4.5 ms in
  total) and save about 30 MB per client, if a memory budget (mobile, many tabs) ever needs it.
- **Node hosts with many rooms.** A Node process shares one set of caches across every room it serves. A host
  with many active rooms was not measured. With the hash memo kept at 32 MiB, the lowered caches matter little
  there (a miss costs at most 0.6 ms for ed25519 and under 0.1 ms for the others), but the hit rates of a busy
  multi-room host are unknown.
- **ed25519 eviction is FIFO.** Constant signatures that are re-read every epoch are evicted once per 2,048 inserts
  and verified again (about 4 extra verifications per 256 Grid epochs). An LRU touch on hit would avoid it; it was
  not changed, because the measured cost is about 2 ms per 256 epochs.
- **Growth that is not the library caches.** In the Grid renderer, about 13 KB per epoch remains for 4 clients at
  head, mostly V8's optimized code, strings and the harness's long-task observer entries. In the Node long room,
  the harness's own records and V8 code account for the slope. Neither was followed past 256 epochs.
- **Chat stops at 56 epochs**: its state reaches the app's limit before the recipient's hash memo is full, so
  Chat's plateau is not observed. The same library code reaches it in Canvas and the Grid. Track W's rolling
  window should let Chat run longer.
- **Conflicts.** Track W edits `tests/fixtures/track-m-apps/browser/entry.ts` and `long-room.pw.ts`, which carry
  this track's measurement-only probe hunks. Track X's library fix does not touch any file changed here.
- **The machine was heavily loaded** (load average 40–300) through every measurement. All latency claims rest on
  paired runs and on a same-build control; single numbers are noisy.

## 11. Files and functions touched

Library (each change in its own commit):

- `packages/node/src/internal/creator-transition-advance.ts` (a3891f11), memo section only:
  `TRANSITION_MEMO_EPOCHS`, `TransitionMemoEntry` (`lineage`, `epoch`), the return of `transitionMemoKey`, and the
  insert in `inspectCreatorTransitionAdvanceExact`. The uncached wrapper `inspectCreatorTransitionAdvance` and every
  caller are unchanged.
- `packages/protocol-v3/src/index.ts` (5c49dd8e): the two bounds in `isAnchorTrustStateRecordBytes`, inside
  `createAnchorTrustApi`.
- `packages/protocol-v3/src/internal/ed25519-verify.ts` (8f77597e): `MEMO_LIMIT`.
- `packages/storage/src/values.ts` (0702f6c5): `CLOSURE_MEMO_ENTRIES`.

Tests and measurement harnesses (off by default; every existing default and check unchanged):

- New: `packages/node/tests/creator-transition-memo-epoch-retention-red.test.ts`;
  `tests/fixtures/cache-probe/plugin.ts`, `probe.ts`, `build-node.ts`, `node-long-room.ts`.
- `tests/fixtures/startup-discovery/build.ts`: `STARTUP_CACHE_PROBE` (`1` or `residency`; refused with
  profiling, fault or shadow builds).
- `tests/fixtures/startup-discovery/r8-source-binding.pw.ts`: the probe sink binding;
  `STARTUP_HEALTHY_GRID_ENDURANCE_MAX` (refused unless an integer from 129 to 1024) handed to the page as
  `__r8EnduranceMax`; the rollover check accepts more than 128 only under it.
- `tests/fixtures/startup-discovery/healthy-grid.ts` (`runHealthyGrid`): the same opt-in in the page's rollover
  check.
- `tests/fixtures/track-m-apps/browser/build.ts`, `entry.ts` (`probedCall` around each endpoint method) and
  `long-room.pw.ts` (`TRACK_M_APPS_CACHE_PROBE=1` sink): measurement only. Track W also edits `entry.ts` and
  `long-room.pw.ts`, so expect a textual conflict there; the Track Y hunks are self-contained.

Not touched: creator-adoption\*, creator-close, creator-closed-rollback-data, v3-live, room-network, v3-room,
issuance-store, any example, any RED or governance test, frozen artifact, registry, vector or spec, and
`docs/realtime-latency/README.md`.
