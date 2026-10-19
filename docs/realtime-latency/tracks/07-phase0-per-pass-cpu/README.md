# Phase 0: cut per-pass re-authentication CPU

**Outcome:** Landed in 4c4f192c (codec fast paths, hashDomain / Ed25519 / transition-verify memos).

### Brief (plan given to the agent) (2026-10-19 07:36 UTC)

You are a fork working DIRECTLY in the main tree <repo>. Goal: per-pass CPU reduction in the retirement/maintenance + adoption paths, EXCLUDING hashing (I, the parent, own hashing). The user explicitly asked for this.

FILE OWNERSHIP (strict): you may edit only packages/node/src/** and packages/protocol-v3/src/** (and add/adjust tests under packages/node/tests or a new protocol-v3 test dir). Do NOT edit packages/canonical/**, packages/storage/**, packages/storage-browser/**, packages/storage-node/** (I am editing those for hashing: canonical hashDomain memo, storage bounded-read baselineIntact/materialSteps). A separate agent prototypes the retirement-scheduling redesign in its own worktree — do not implement watermark/background scheduling. Never use rm -rf (hook blocks it). Don't commit.

TARGETS (from the latest whole-run CPU profile <evidence>/prof8memo.cpuprofile; analyze with scratchpad/prof.py and scratchpad/callers.py <profile> <fn> <depth>):
- inspectCreatorTransitionAdvanceOwned ~3.6 s inclusive, inspectBoundedCreatorTrustAdvance/inspectTrustClosure ~2.4 s, copyCandidates→copyDetachedBytes ~1.46 s SELF (likely byte-by-byte copies or repeated detach copies — find it, it's probably in packages/node/src/internal or protocol-v3), canonicalCreatorDataRecord ~1.3 s, authenticatedSettlementPair ~1.2 s, acquireRecoveryRoleCertificate ~1.5 s, observeCreatorProtectedRecoveryRoles ~1.3 s, extractAuthorizedV3Vertex ~0.74 s, compareBytes ~1.0 s self.
- Redundant per-pass re-authentication in the maintenance loop: uncached openCreatorSnapshotRecoverySourceTrust at packages/node/src/internal/creator-closed-rollback-data.ts ~7712 and ~20668 bypassing parsing.recoverySourceTrust (~2269); repeated checkpoint/QC/cut/ACL opens; native images read twice; ~8 checkCurrentSource runs per pass; verifyCompleted repeated.
- Adoption fence cold path (creator-close.ts maintenanceConsumer ~3398+, prepareCreatorIssuanceMaintenanceQuote, acquireCreatorIssuanceMaintenanceProof, captureCreatorOrdinaryIssuanceProofSourceForFence) re-authenticating E→E+1 Cut/QC a third time.
Approach: prefer exact-byte memoization of PURE authentication/parse results (key = exact input bytes + all parameters; verify full byte equality against private copies, bounded size), routing existing uncached calls through existing caches, and removing true duplicate work. Preserve every refusal/error message and ordering, every resource charge (accounting.charge calls must still happen with identical bytes — caching may skip recomputation, never skip charging), and every currency/revocation check. This codebase has many source-introspection tests that extract private functions by name and execute them (e.g. packages/node/tests/creator-closed-rollback-proof-accounting.test.ts `declaration([...names])`, creator-ordinary-*.test.ts) — do not rename functions or variables those tests look up; grep tests for any identifier you change; avoid introducing module-level references inside functions that tests extract by text (or add them to the test's execution context if necessary).
VALIDATION: run affected unit tests via `pnpm exec vitest run <files> --coverage.enabled=false` from repo root (zsh: ${=VAR}). Known pre-existing failures: scratchpad/fails-base.txt (compare; any new failure is yours). Benchmark with `scratchpad/bench.sh <unique-name> 8` (NEW unique names prefixed `pp-`; never reuse; it builds then runs the healthy Grid Playwright test, ~2.5 min). Current reference (8 rollovers): run `scratchpad/run-memo1r8.log`/summary: seal t4..t7 ≈ 3.4-4.1 s, adoption t4..t7 ≈ 0.8-1.3 s, recipient install t3..t7 ≈ 1.4-2.0 s. Other benchmarks may run concurrently (noise) — rerun if a result looks off.
REPORT (≤700 words): each change (file:function), why it is semantically identical, tests run + results, measured before/after.

### Follow-up instruction — Offer exactness decode primitive to per-pass agent (2026-10-19 07:56 UTC)

New canonical primitive available for your lane: `decodeCanonicalExactness(bytes, limits?)` from "@ts-drp/canonical/exact" (dist rebuilt). It decodes exactly like decodeCanonical (same value, same errors, same limits) and returns {value, exact}. exact===true GUARANTEES encodeCanonical(value) with DEFAULT limits reproduces the input byte-for-byte (fuzz-verified against the frozen v1 codec); exact===false means "unknown" → keep the original re-encode+compare. Use it to skip the decode→re-encode→compare canonicality check in node/protocol-v3 helpers, keeping every other check in its original order (only skip the encode+compare when exact; never reorder refusals). Profile shares (whole run, creator page): canonicalCreatorDataRecord ~730 ms encode, protocol-v3 index.ts decodeExact ~460 ms, protocol-v3 snapshot-transfer.ts decodeRecord ~220 ms, protocol-v3 creator-close.ts exactCanonicalRecord ~150 ms, exactRecord ~100 ms, checkedRecord ~90 ms. Caveat: only valid when the caller re-encodes with DEFAULT limits (or limits ≥ defaults) and doesn't mutate the value between decode and re-encode. Storage's decodeEnvelope already uses it (I did that one). Also FYI: canonical compareBytes now has an aligned word-prefix fast path, and hashDomain has an exact-input memo (full byte equality vs private copies) — hashing went from ~8.5 s to ~2.4 s inclusive over the run. Machine load is extremely high (load avg 30-110 from other projects), so compare benchmarks pairwise back-to-back (scratchpad/runonly.sh <unique-run> <build-name> [rollovers] reuses an existing build).

### Report returned by the agent (2026-10-19 08:34 UTC)

I was asked to cut CPU per pass in the retirement/maintenance and adoption paths (hashing excluded), without changing behaviour. I made 8 changes, the full test comparison shows no new failures, and CPU in the targeted code drops a lot, but the wall-clock benchmark can't confirm a speedup under current machine load.

**Changes**
1. `node/src/internal/creator-transition-advance.ts`: an exact-input memo for the `verify` mode of `inspectCreatorTransitionAdvance`.
   - The original function is now unexported but its text is unchanged; the memo wrapper is exported under the same name. Internal callers (readback, recheck) still call the original.
   - The key is the trust material from `resolveSealRecoveryTrust` (trusts can only be reached through it), plus refs and settlement ACLs. Every byte array is compared in full against private copies.
   - Only successful results are stored (≤4 MiB per entry, 16 MiB total, LRU). A hit returns the same frozen `{kind, ok, proposed}` shape the original returns.
   - Someone else edited this memo at 04:30, after my last snapshot (tighter key checks: hex digests, safe integers, plain objects). I kept their edit; it typechecks and the transition tests pass.
2. `protocol-v3/src/index.ts`, `isAnchorTrustStateRecordBytes`: the yes/no answer is memoized, keyed on the full copied bytes (≤1024 entries, 2M key chars). All earlier checks and the catch-all `false` are unchanged.
3. Using your `decodeCanonicalExactness`: the re-encode-and-compare step is skipped only when the decode reports `exact`. All other checks keep their order and their refusal reasons. Any view whose length or backing could be intercepted (subclass, own `byteLength`/`length`/`buffer`/`byteOffset`, shared memory) falls back to the original path.
   - `node/.../creator-snapshot-data.ts`, `canonicalCreatorDataRecord`: tests extract this function by name, so its text is unchanged and unexported. The exported name is now a wrapper that uses exactness.
   - `protocol-v3`: `decodeExact` (index.ts), `exactCanonicalRecord` and `decodeCanonicalValue` (creator-close.ts), `exactRecord` (creator-checkpoint.ts), `openCreatorAuthorSettlement` (creator-author-issuance-frontiers.ts) and `openCanonicalLatchedAclSnapshot` (latched-acl.ts).
   - snapshot-transfer.ts `decodeRecord`: this one re-encodes with a smaller `maxBytes`, outside your stated condition. It is still safe: every byte-limit check in the encoder measures part of an output that equals the input, and the input already passed the same ceiling.
   - New shared helper: `protocol-v3/src/internal/canonical-exactness.ts`. I did not import it into index.ts, so the 3a0 import-graph test gets no new entry.

**Tests**
- New `packages/node/tests/creator-canonical-exactness.test.ts`: checks the wrapper against the original declaration, extracted from source, across canonical inputs, leading-BOM and large integral float inputs (which decode but don't re-encode identically), truncated, trailing-byte and offset inputs, views with a fake length, and subclass views. It also checks that exactness decoding matches `decodeCanonical` values and errors under three limit settings. It passes.
- The tree's own suites (38 files), compared failure-by-failure against my changes swapped out, show no test failing only with my changes:
  - 21 node/protocol-v3 suites, including proof-accounting, generation-closure, readiness-producer, 5e close/actor, 6a activation, 0c1a, 3a0 and 4c stream: identical failure sets.
  - One baseline proof-accounting failure now passes.
  - `d110c-0c1f5b0a-settlement-codec`: without my changes all 10 tests fail (one TDZ, nine time-outs). With them, 8 pass; 2 fail the same way as before: one TDZ, and one assertion that fails because the module only partially loaded. The TDZ comes from an existing protocol-v3 import cycle (index → owned-signing-request → creator-close).
- Proof-accounting's "preserves codec/refusal/node-depth-item" test passes but takes 19 s, so it times out at the 10 s default under load. It runs canonical codec code only and doesn't touch my files.
- Run with `--exclude ".claude/**"`: otherwise the filters also pick up the redesign agent's worktree.

**Measured** (CPU profiles of baseline and mine taken back-to-back, whole 8-rollover run, creator page, ms)

| Function | Baseline | Mine |
|---|---|---|
| `inspectCreatorTransitionAdvanceOwned` | 3368 | 1395 |
| exported `inspectCreatorTransitionAdvance` | 2340 | 570 |
| `validTrustChain` | 777 | 102 |
| `observeCreatorProtectedRecoveryRoles` | 1128 | 324 |
| `canonicalCreatorDataRecord` | 1272 | 490 |
| `decodeExact` | 749 | 28 |
| latched ACL opener | 565 | 255 |
| author settlement opener | 497 | 256 |
| `authenticatedSettlementPair` | 800 | 391 |
| `encodeCanonical` total | 7844 | 6312 |
| non-idle CPU | 39.3 s | 37.4 s |

The mine profile ran at load average 116 versus 61 for baseline.

Wall-clock, two baseline/mine pairs at load average 59–116, mean of t4–t7:
- **Adoption:** 1287/1110 ms baseline vs 1233/1031 mine. An earlier pair with only changes 1–2 showed −32% (1220 → 828).
- **Sealing (~4.0–4.4 s) and install (~1.7–2.0 s):** within noise.

**For you (outside my files)**
- **control-plane `anchor-trust.ts` `copyDetachedBytes`:** still 798 ms after my changes, the largest remaining cost inside inspect. It reads a property descriptor for every byte. Once the intrinsic `buffer`/`byteLength` getters succeed, confirm the real type via the `%TypedArray%.prototype[Symbol.toStringTag]` getter returning "Uint8Array", then copy with `.set` or an index loop. Integer-indexed reads on a genuine Uint8Array can't be intercepted.
- **control-plane `creator-trust-checkpoint-advance.ts` `exactRecord`:** 125 ms, a decode-then-re-encode check that could use exactness.
- **node `createCreatorCanonicalSyntaxReader.checkedRecord`:** about 160 ms. Tests extract it and run it in a fixed context, so exactness needs those test contexts extended.
- **Remaining encode cost:** dominated by encoding retirement images — `closedRetirementEqual` encodes both sides to compare them (~0.6 s) — plus storage and issuance-store retirement codecs. These belong to the scheduling redesign or to you.

Validation logs and scripts are in `<evidence>` (`pp-*`). Nothing is committed.
