# Phase 0: prior art for non-stalling epochs

**Outcome:** Research only. Watermark-triggered retirement and verify-once caching were carried into Tracks E, R and R2.

### Brief (plan given to the agent) (2026-10-19 07:27 UTC)

Research task (web search + reasoning; do NOT modify any files in <repo> — you may read them). Context: a TypeScript library (DRP — "distributed replicated program", runs in browsers with IndexedDB and in Node with SQLite) is meant to power real-time multiplayer games. It is an authenticated, signed, epoch-based replicated object: a 'creator' periodically closes an epoch (seals it with signatures / QC / hard cut + snapshot), recipients install the successor epoch, and a bounded-storage lifecycle retires/garbage-collects old epochs (snapshots, journals, signing evidence, generation records) once a bound like maxRecoveryScopes is reached. Today that retirement runs synchronously inside the epoch close, stalling gameplay ~4 s per epoch transition; recipient install takes ~2 s; ordinary per-move issuance is ~20-150 ms. A large share of CPU is re-authentication: re-reading every stored blob and re-hashing it with pure-JS SHA-256 (noble) many times per transition to prove storage 'currency' / that borrowed buffers were not mutated, plus repeated canonical encode/decode and Ed25519 verification of the same immutable records.

Find and summarize prior art / proven techniques that address these issues, with links and a 1-3 sentence applicability note each. Cover:
1. Moving compaction/GC/retirement off the critical path without violating storage bounds: LSM background compaction with soft/hard stall thresholds (RocksDB write stall/slowdown triggers), Raft/etcd async snapshot + log compaction, CometBFT/Tendermint pruning, Ethereum client state pruning, Aptos/Diem/Sui epoch reconfiguration and how they avoid stalling consensus, Narwhal/Bullshark GC, CRDT garbage collection under causal stability, incremental/concurrent GC ideas (headroom/hysteresis: start GC at a low watermark so the hard cap is never hit on the critical path).
2. Making epoch/view changes fast in BFT/blockchain systems (pipelining reconfiguration, precomputing the next epoch's state, double buffering).
3. Avoiding repeated cryptographic re-verification: verify-once caches keyed by exact bytes, immutable buffers (e.g. JS ArrayBuffer.prototype.transferToImmutable proposal status / browser support in 2026), content-addressed stores that trust their own write path, Merkle caching, WebCrypto subtle.digest vs pure-JS SHA-256 throughput in browsers, WASM SHA-256 (hash-wasm) throughput, BLAKE3 in WASM, batched Ed25519 verification.
4. How real-time game networking stacks (e.g. Photon Quantum, deterministic lockstep/rollback netcode, Colyseus, Croquet/Multisynq, Braid/Automerge/Yjs performance work) keep per-tick latency in ms while doing state snapshots/compaction — e.g. snapshots taken asynchronously, compaction amortized across frames, separating the authenticated/durable path from the latency-critical path (optimistic local apply, async durability/attestation).
Finish with a ranked list of the 5 most applicable strategies for this library, each with expected impact and main risk. Keep the report under ~1000 words.

### Report returned by the agent

#### Prior art for moving DRP's epoch work off the critical path

No files were modified. One grounding observation from the repo: retirement is triggered at the hard cap on the close path (`owner.recoveryScopes >= owner.limits.maxRecoveryScopes || resume || capacityMaintenance`, packages/node/src/creator-close.ts:3768). That is the pattern the sources below avoid.

##### 1. Compaction, GC and retirement off the critical path
- **RocksDB write stalls** ([wiki](https://github.com/facebook/rocksdb/wiki/Write-Stalls), [summary](https://www.mintlify.com/facebook/rocksdb/advanced/write-stall)): background compaction is the normal path. The soft limits (`level0_slowdown_writes_trigger`, `soft_pending_compaction_bytes_limit`) throttle writes, and only the hard limits stop them. Extra compaction threads start at about 1/4 of the soft limit. *Applies directly:* add a low watermark below `maxRecoveryScopes`, and keep synchronous retirement only as the "stop writes" backstop.
- **Raft §7** ([paper](https://raft.github.io/raft.pdf)): "writing a snapshot can take a significant amount of time, and we do not want this to delay normal operations". The fix is copy-on-write snapshots, persisting first and truncating afterwards. etcd-raft's `AsyncStorageWrites` ([docs](https://pkg.go.dev/go.etcd.io/raft/v3)) moves log appends and applies onto separate ordered threads. *Applies:* make retirement a journaled, resumable job that runs in order after the close.
- **CometBFT retain heights** ([pruning service](https://docs.cometbft.com/main/explanation/data-companion/pruning), [ADR-101](https://github.com/cometbft/cometbft/blob/main/docs/references/architecture/adr-101-data-companion-pull-api.md)): the close only advances a durable *retain height*, and a background pruner deletes everything below it. The docs say to raise the height only after the data has been verified elsewhere. *Applies:* the close commits "retire ≤ epoch N" as one small durable record, and a worker does the deletes.
- **Geth path-based state** ([ethresear.ch](https://ethresear.ch/t/ethereum-path-based-storage-model-and-newly-inline-state-prune/14932), [v1.13](https://blog.ethereum.org/2023/09/12/geth-v1-13-0)) and **Sui** ([data management](https://docs.sui.io/guides/operator/data-management)): Geth keeps 128 diff layers in memory and prunes online. Sui finds prunable objects per checkpoint, prunes them in the background, and drops whole per-epoch databases. *Applies:* give each epoch its own store so retiring it is a single bulk delete, not a per-record walk.
- **Narwhal GC** ([arXiv 2105.11827](https://arxiv.org/abs/2105.11827) §3): validators agree on a GC round through consensus, move older blocks off the main store, and ignore later messages for those rounds. Their notes record a GC bug that used 120 GB of RAM against a normal 700 MB. *Applies:* derive the retirement frontier from the signed epoch sequence so peers never need to coordinate it.
- **CRDT causal stability** ([Pure op-based CRDTs](https://arxiv.org/abs/1710.04469)): metadata is compacted only once operations are causally stable.
- **Go GC pacer** ([redesign](https://go.googlesource.com/proposal/+/HEAD/design/44167-gc-pacer-redesign.md)): the trigger is set early enough that mutator assists, the equivalent of critical-path stalls, are rarely needed. This is the case for headroom plus hysteresis.

##### 2. Fast epoch and view changes
- **Lighthouse state-advance timer** ([source](https://github.com/sigp/lighthouse/blob/stable/beacon_node/beacon_chain/src/state_advance_timer.rs)): near the end of each slot it advances the head state, so the next epoch's shuffling is known before the first block arrives and per-slot processing is off the import path. eth2fastspec's `EpochsContext` ([pypi](https://pypi.org/project/eth2fastspec/0.0.1)) rotates precomputed next-epoch data in at the boundary. *Applies:* build the successor snapshot, encodings and retirement plan in idle time, then sign and flip a pointer at close.
- **Aptos staged configs** ([consensus_config](https://aptos.dev/move-reference/mainnet/aptos-framework/consensus_config)): pending config is buffered during the epoch and applied in `on_new_epoch`. **Sui** ([epochs](https://docs.sui.io/develop/sui-architecture/epochs)) calls the epoch close "the only fully synchronous event" and keeps it small.
- **Gauss "dirty logs"** ([arXiv 2602.09441](https://arxiv.org/pdf/2602.09441)): about 93% of epoch-change latency was the Ready-to-Handover commit. The design separates the inner consensus log from the outer log the state machine sees. *Applies:* recipients can stage-verify the successor in the background and swap it in atomically (double buffering).

##### 3. Avoiding repeated verification
- **Verify-once caches:** Bitcoin Core's [SignatureCache](https://doxygen.bitcoincore.org/class_signature_cache.html) stores only successful checks, salted, 32 MiB by default. Kubo's [`Datastore.HashOnRead`](https://github.com/ipfs/kubo/blob/master/docs/config.md#datastorehashonread) defaults to `false`: a content-addressed store trusts its own write path.
- **Immutable ArrayBuffer** ([TC39](https://github.com/tc39/proposal-immutable-arraybuffer)): the README says Stage 2.7 and the May 2026 spec draft is still 2.7. I found no shipping V8, SpiderMonkey or JSC implementation, so it can't be relied on in 2026; only the endo polyfill exists. The practical substitute is to copy once on the way in and never hand out the internal buffer. A copy runs at GB/s, far faster than re-hashing at 110–300 MB/s.
- **Hash throughput:**
  - noble sha256 on M4: about 297 MiB/s at 1 MB, 438 ns per 32 B hash ([README](https://github.com/paulmillr/noble-hashes)).
  - hash-wasm vs noble, Chrome 131: 426 vs 110 MB/s at 1 MB, and 64 vs 25 MB/s at 32 B ([table](https://github.com/Daninet/hash-wasm)).
  - WebCrypto `digest` beats hash-wasm 3–13× on 1 KB inputs ([measurethat](https://www.measurethat.net/benchmarks/Show/32592/1/hash-wasm-vs-web-crypto-api)). It is async, though, and per-call overhead hurts very small inputs.
  - In Node, `crypto.hash()` is synchronous, native, and 1.2–1.6× faster than `createHash` ([PR 51044](https://github.com/nodejs/node/pull/51044)).
  - BLAKE3 in WASM claims 6–10 GB/s ([awasm-noble](https://paulmillr.com/awasm/)), but adopting it is a protocol/format change.
- **Ed25519:** WebCrypto Ed25519 is now in all engines: Chrome 137+, Firefox 129+, Safari 17+ ([IPFS blog](https://blog.ipfs.tech/2025-08-ed25519/)). In an older benchmark node:crypto ran about 7.1k verifies/s against about 0.5–0.9k for noble ([bench](https://deno.land/x/ed25519_dalek@1.1.14)). noble's `verifyBatch` gained only about 15% ([older README](https://github.com/xetareality/noble-ed25519)), so going native beats batching.
- **Merkle caching:** keep subtree hashes so an update rehashes only O(log n) nodes. `packages/compaction/src/ct-merkle.ts` already exists.

##### 4. Game networking stacks
- **Photon Quantum:** separates predicted frames from verified frames. `ChecksumInterval` sends state checksums only periodically, and the docs advise setting it to zero in release ([config](https://doc-api.photonengine.com/en/quantum/current/class_photon_1_1_deterministic_1_1_deterministic_session_config.html), [prediction culling](https://doc.photonengine.com/quantum/v3/video-tutorials/prediction-culling)). *Applies:* attest at intervals, not on every move.
- **Croquet** ([snapshots](https://croquet.io/sdk/docs/tutorial-2_7_snapshots.html)): the reflector periodically asks one client to snapshot, and late joiners load the snapshot and replay events after it. The docs admit unoptimized snapshots cause a hitch, which is the same failure as DRP's.
- **Colyseus** ([optimization](https://docs.colyseus.io/state/optimization)): delta patches go out on a `patchRate` separate from the simulation tick.
- **Yjs** ([forum](https://discuss.yjs.dev/t/throttling-yjs-updates-with-garbage-collection/1423)): GC runs only when updates are applied, so heavy compaction is throttled or done on a clone document.
- **GGPO** ([repo](https://github.com/pond3r/ggpo)): per-frame save and load of state are memcpy-cheap, and verification is decoupled from rendering.

##### Five most applicable strategies, ranked
1. **Watermark-triggered background retirement with hysteresis** (RocksDB, Go pacer, CometBFT). Start at `max − k` scopes, commit a durable "retire ≤ N" record at close, and run deletes in time-budgeted slices (`scheduler.yield`, `setImmediate`). Keep synchronous retirement only as the hard-cap backstop.
   - *Impact:* removes most of the ~4 s close stall.
   - *Risk:* crash consistency of a half-retired epoch, plus proving k is at least the worst-case number of closes before the worker catches up.
2. **Verify-once and trust-own-writes** (Bitcoin sigcache, Kubo HashOnRead). Cache verified digests per process generation. Replace the "re-hash borrowed buffer" proofs with copy-on-ingress ownership.
   - *Impact:* likely the largest CPU cut, during both transitions and install.
   - *Risk:* stale cache if another tab or process writes to the store. Fence it with Web Locks or a generation counter.
3. **Native crypto.** Use `crypto.hash` in Node, WebCrypto for batched or large digests and for Ed25519, and hash-wasm for small synchronous hashes. Keep SHA-256.
   - *Impact:* 3–10× on whatever hashing remains, about 8× on Ed25519.
   - *Risk:* async WebCrypto breaks code that relies on synchronous atomic sections, and native paths lose noble's audited single implementation.
4. **Precompute and double-buffer the successor** (Lighthouse, Aptos). Build the successor snapshot, encodings and Merkle roots before close. Recipients pre-verify in the background and swap atomically.
   - *Impact:* close and install drop to roughly signing plus one atomic write, about tens of ms.
   - *Risk:* precomputed work goes stale if state changes afterwards, so a cheap delta re-validation is needed.
5. **Split the latency path from the attestation path** (Quantum verified/predicted frames, Croquet, etcd async writes). Apply moves optimistically and pipeline signing and persistence.
   - *Impact:* per-move cost falls from 20–150 ms toward under 5 ms.
   - *Risk:* rollback semantics if an attestation fails, and a harder security argument.
