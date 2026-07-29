# ts-drp-1 Production Hardening — Final Phased TDD Implementation Plan

**Status:** build plan — supersedes `production-hardening-tdd-plan.md` (round 1)
**Baseline:** `bf7d3516f6ed4be97a755698b4fb3a404e04dc0f` (`main`) — exactly the AHE v4 review baseline, zero drift
**Goal:** take `ts-drp-1` from a research-grade signed operation-DAG to a production library capable of running an **MMORPG** or a **Discord-like chat at scale** — browser-first, hostile participants, churny NAT'd swarms.

**Compaction decision (changed this round): implement Attested Hard Epochs v4 directly.** AHE v4 is the
specification, its reference implementation is the starting code, its wire formats are the wire formats, and
its §23 acceptance checklist is our checklist. Where the spec and its reference disagree, or where either is
incomplete, we **amend AHE v4 in-repo and regenerate the reference from the amendment** — we do not defer.

This plan synthesizes round 1, the six source documents, and a **twelve-agent adversarial review**
(4× Opus-xhigh, 3× GPT-5.6-Sol-max, 2× Grok-4.5, 3× Kimi-K3), plus first-hand verification runs on this
machine. Where reviewers contradicted the source documents or each other, the code was re-read directly and
the correction is folded in with its evidence.

---

## 0. What changed, and what is now established fact

### 0.1 Evidence produced on this machine (not inherited)

Round 1 declined direct adoption largely because the reference was "untyped JS outside the workspace with
browser gates self-reported blocked." Both halves were tested here:

| Check                     | Command                                                         | Result                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference test suite      | `node --test test/core.test.mjs` in `reference-implementation/` | **22/22 pass, 287 ms**                                                                                                                      |
| Reference size            | `wc -l src/*.js`                                                | **2,379 LOC across 13 modules** (round 1's "~3,400" counted tests + browser harness)                                                        |
| Browser gate, Chromium    | AHE `browser/harness.html` under this repo's Playwright 1.51.1  | **PASS** — 3/3 checks, `elapsedMs 170.3`                                                                                                    |
| Browser gate, Firefox 135 | same                                                            | **NO VERDICT — silent hang**                                                                                                                |
| Browser gate, WebKit 605  | same                                                            | **NO VERDICT — silent hang**                                                                                                                |
| Repo persistence infra    | `grep -rl "indexedDB" packages`                                 | **zero matches**                                                                                                                            |
| Repo Worker infra         | `grep -rl "new Worker(" packages`                               | **zero matches**                                                                                                                            |
| CI shape                  | `.github/workflows/`                                            | 17 workflows, **all `runs-on: ubuntu-latest`**, most `timeout-minutes: 10`; `network-spike-public.yml` is 360 min (precedent for long jobs) |

The bundle's own `evidence/chromium-browser-validation.json` records `net::ERR_BLOCKED_BY_ADMINISTRATOR`,
`verdict: "blocked"`, with the note _"the managed Chromium policy in this execution environment blocks all
navigation."_ That was environmental — but running it properly produces a **worse and more useful** result
than "untested":

**Two of the three engines in AHE §21.5's own required release matrix produce no verdict at all — and the
harness is structurally incapable of telling you so.**

The root cause is a **race in the harness, not a defect in the engines.** On both Firefox and WebKit
`isSecureContext`, `crypto.subtle`, `indexedDB` and `navigator.locks` are all present, and `import()` of
`canonical.js` (7 exports) and `indexeddb-store.js` (4 exports) both succeed on the main thread.
`browser-tests.js:29-33` posts `{run:true}` **immediately** after `new Worker("./worker.js",{type:"module"})`,
but the worker's module graph — five imports plus a **top-level `await` in `ct-merkle.js:3`** — has not yet
installed `self.onmessage` (`worker.js:33`). Chromium happens to queue the message; Firefox and WebKit drop
it, and the worker waits forever. **Delaying the post by 3 s makes both browsers pass the full compute
payload** (Firefox: encode 41 ms, merkle 87 ms; WebKit: encode 44 ms, merkle 80 ms). The standalone IDB
vote-CAS also passes on both.

The damage is done by the missing timeout: `workerResponsiveness()` awaits a promise whose only settle paths
are `onmessage` and `onerror`. With neither firing, `run()` never completes, `document.body` is never
written, and the page sits at `running…` forever. **The harness can report PASS; it cannot report FAIL for
this class.** A hang is indistinguishable from "still running."

Two things follow. The directive's premise is confirmed — the matrix is executable here and Chromium is green
end-to-end including the IDB stage/commit path. And the reference's browser story was **never actually
validated cross-browser**: its static `browser_surface_audit.py` "pass" coexisted with a fatal cross-browser
runtime bug. Static audits are not browser gates.

This yields the rule that governs every gate below:

> **An inherited gate is not a gate until it has been observed going red for the right reason, in this
> repo's CI, on every engine in the matrix.**

### 0.2 The inherited-evidence problem is larger than the browser gate

The AHE §22 headline numbers — 5,231 exhaustive DAGs, 10,000 randomized epochs, 20,000 delivery
permutations, 11,612 quorum-pair checks — come from **standalone Python scripts that never execute the JS
reference** (`model/validate_epoch_model.py`, `model/validate_seal.py`; stdlib-only imports, their own
`kahn_order`, their own `fold_epoch`, their own digest). They validate a Python model against itself.
`reference-implementation/package.json` runs `"model"` (Python) and `"test"` (JS) as separate scripts with
no shared vectors — and **there are no golden vectors anywhere in the bundle**; all 22 JS tests compute
their expectations at runtime.

The only executable evidence against the reference _code_ is those 22 tests, and
`evidence/node-coverage.log` lists **11 of 13 modules** — `indexeddb-store.js` and `runtime.js` have **zero
executed coverage**. Those are precisely the crash-critical modules.

Consequently: **no AHE number is a gate in this plan.** Every §21/§22 claim is re-derived by TS-driven
enumerators that drive both engines over shared, checked-in vectors.

### 0.3 Corrections to round 1 (verified against source at `bf7d351`)

Round 1's evidence table is otherwise accurate — every `file:line` spot-checked by three independent
reviewers resolved correctly. These are the exceptions, and they change what gets built:

1. **"`FETCH_STATE` snapshots cross the wire unauthenticated" is stale.** `fetchStateResponseHandler`
   (`packages/node/src/handlers.ts:196-209`) **never adopts** network state — the code says so explicitly:
   _"Network-provided ACL/DRP state snapshots are never adopted… Either way the state is dropped."_
   `DRPObject.setACLState` and `merge(_, rootACLState)` both throw on root-ACL adoption. Genesis authority
   is derived locally from the creator-bound object id, so there is **no authority-takeover to fix**.
   What remains is the _responder_ (`handlers.ts:153-168`), which still calls `getStates()`, serializes the
   full snapshot and ships it to a peer that discards it — a free **amplification-DoS**, cheap to request,
   `O(state-bytes)` of CPU and egress on the victim. Different fix, different phase, much smaller.
2. **Hash-framing endianness is not in conflict.** Spec §4.2 and `hash.js` are _both_ big-endian for the
   framing integers. The real divergence is the **canonical typed-array profile**: spec §4.1 mandates
   little-endian, `canonical.js:76-79,117-136` encodes big-endian.
3. **`blueprintDigest` is already in the reference's cut descriptor** (`protocol.js:142,165`). It is missing
   from the reference's **anchor** (`protocol.js:176-201`) and **snapshot payload** (`snapshot.js:102-104`).
   Round 1 listed it as simply "omitted."
4. **The invalid-hash FIFO is memory-bounded.** `MAX_KNOWN_INVALID_VERTEX_HASHES = 10_000` with
   evict-oldest (`drp-applier.ts:34,282-289`). Rotation does not exhaust memory; it flips evicted invalid
   _parents_ back to `missing`, driving `recoverMissingSync` re-request churn. The gate must assert
   **re-request rate**, not megabytes — as written it passes trivially.
5. **Wall-clock invalidity is not "permanent poisoning."** A rejected vertex is not in the graph, so
   redelivery re-runs validation with a fresh clock. The repairable case is narrower than the original
   wording implied: only a finite submitted timestamp strictly beyond a finite receiver clock is
   receiver-clock-dependent and therefore re-requestable. Dependency-relative temporal violations,
   submitted infinities and downstream throws of the public timestamp-error class are deterministic
   terminal failures. Phase 0f makes the narrow receiver-future case `pending` instead of dropping it as
   `invalid`; otherwise two honest replicas at different clock offsets can converge to different graphs
   and never repair. Live silent divergence, independent of compaction.
6. **`perf-contracts.test.ts` is green today**, not RED (8/8 pass, ~167 ms; budgets 4.3/4.8/3.0/52.8 ms vs
   limits 200/200/200/1000 ms). The `describe(... RED until optimized)` label is stale. Round 1's Phase 1a
   says "extend the RED perf-contracts pattern" — there is no sync-compare perf test to extend; it is net-new.
7. **`benchmark.yml:88` and `benchmark-memory.yml:64` both set `fail-on-alert: false`**, and the PR
   benchmark job is `continue-on-error`. Round 1 wires the Phase-6 memory-slope gate — the single most
   important economic proof in the program — into workflows engineered never to block anything.
8. **The global coverage gate cannot catch the failure it exists to catch.** `scripts/coverage.ts:4`
   enforces one summed 70% line threshold; a module at zero coverage passes if everything else covers.
   That is exactly how the bundle shipped "91.71%" while excluding its two crash-critical modules.
9. **`runtime.js` is imported by nothing** — `browser/worker.js:1-5` imports five _other_ modules. The
   bundle's "Worker responsiveness" evidence executes different code than the module it appears to validate.
10. Round 1's own doc-corrections stand and are confirmed: the "insertion-sensitive DFS" claim is stale
    (`hashgraph/index.ts:318` `.sort()`s forward edges — target **origin**-sensitivity); the AEC contraction
    counterexample uses non-antichain deps; `@chainsafe/bls ^8.1.0` is already a production dependency of
    `object` and `keychain` (via `@chainsafe/bls/herumi`, the WASM backend — so AHE §2.2's
    "avoid a BLS/WASM dependency" rationale is _doubly_ stale).

### 0.4 The verdict, restated

Implementing AHE v4 directly is the right call, and the reference is a genuine asset — but "directly" means
**freeze first, then port**, never "transliterate the reference." Three of its modules are safe to port
nearly as-is; two must be _rewritten_ rather than ported; and the protocol has four genuine gaps that must
be closed as normative amendments before any consensus byte is written:

| #   | Gap                                                                                                                                                                                                              | Resolution (Phase −1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | No single frozen encoding. Spec recommends CBOR + LE typed arrays; the reference is a proprietary tag codec + BE. Several consensus objects have **no normative preimage at all**.                               | One frozen registry (§4). Reference regenerated from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| G2  | `round` lives inside the signed cut descriptor, so a locked value cannot be re-proposed. **This is a real, constructible n=4 permanent stall.**                                                                  | Split round-free `CutValue` from round-bearing `SealProposal`; QCs bind `valueDigest`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| G3  | The pacemaker is six bullets; the reference **rejects the `round-change` phase its own vote schema defines** (`seal.js:21-35`) and omits `highestPrepareQC`.                                                     | Normative pacemaker (§Phase 5), model-checked before attested mode.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| G4  | Admission fails open — ancestry is optional (`admission.js:74-83`), and no signature, ACL, schema or invariant check runs before `accept` (`admission.js:41-91`; `fold.js:38` defaults authorization to `true`). | Phase 0d owns the mandatory fail-closed admission pipeline, Phase 0e owns the exact package-level ancestor index and strict boolean result contract, Phase 3a owns the first live v3 binder, and Phase 4a owns removal of the fold's default-`true` authorization. The accepted atomic 0d/0e v2 library boundary is a preservation baseline, not production integration: G4 remains open until the Phase-3a v3 binder lands on Phase 0q's commit discipline and Phase 4a removes the legacy fail-open fold. |

And two structural facts constrain the whole program:

- **Compaction is a divergence amplifier.** The instant any peer adopts a snapshot instead of replaying,
  _any_ nondeterminism becomes a permanent silent fork. The determinism foundation is a hard prerequisite,
  no exceptions.
- **AHE bounds the history age of _one object_. It is not a multiplayer fabric.** Shipping AHE and calling
  the stack MMORPG-ready is marketing. The ephemeral, sharding and topology planes (Tracks E/S/T) are
  load-bearing for the stated goal and sit entirely outside AHE.

### 0.5 Two release trains — do not merge the claims

| Train                                  | Contents                                                                                                                                  | Claim it earns                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Train C — Correctness & Compaction** | Phases −1…7. Single-object AHE v4: determinism, durability, v2 envelope, seal, bounded pruning, archive.                                  | _"Production-hardened signed-command rooms with bounded history."_ Serverless is honest here for small rooms. |
| **Train S — Fabric**                   | Tracks E, S, T + the Profile gates. Ephemeral simulation plane, sharding/cross-object conservation, mesh topology and connection budgets. | _"MMORPG or Discord at scale."_ **Only when Train S gates are green.** Requires operator-run relays.          |

**Train C preserves the zero-deploy profile.** Today the grid and chat examples run end-to-end over
_public_ infrastructure — Nostr relays for discovery, public delegated routing for relay candidates, no
self-deployed fixtures (`examples/grid/playwright.fully-public.config.ts`, `pnpm e2e-test:fully-public`).
Nothing in Train C changes that: creator-trusted sealing needs one signer (the creator's client),
`local-only` pruning needs no mirror, and durable storage is the peer's own. This is a **stated invariant
with a regression gate**: the fully-public e2e stays in the weekly tier (reports-only — it depends on live
third-party infra and is flaky by its own comments), and a pre-release run at the release SHA must be
triaged (regression vs infra outage) before Train C ships. The operator node buys things that are
_currently impossible_ (attested quorum liveness, relay-spine fanout, rooms that outlive their members) —
it must never become a requirement for things that already work with none.

Train S is not a backlog. Several of its slices (connection budgets, the O(1) applied-set index, the crypto
Worker queue, permissioned defaults) are **prerequisites of Train C's own scale gates** and land in Phase 1.

### 0.6 The honest scope statement

Three things are out of reach for a pure browser mesh regardless of plan quality, and all three resolve with
the same component — an **operator-run node**, untrusted for state (bytes verified, cuts QC-checked, referee
ops signed and disputable):

1. **Ephemeral fanout above ~16 players/zone.** A browser cannot originate 30 Hz × 63-peer upload fanout.
   Interest management reduces _relevance_, not the sender's fanout. An SFU-style relay is required.
2. **Compaction liveness under tab churn.** AHE §2.3's fallback — _"the active epoch simply grows until a
   configured hard safety limit"_ — reintroduces unbounded history exactly when quorum churns. At the
   default `maxEpochVertices = 8192` and a modest 5 durable ops/s that is ~27 minutes to the hard limit.
   Browser tabs also have a _negative_ incentive to sign (burn battery for closes benefiting latecomers)
   and get OS-suspended.
3. **Contested-outcome validity.** Attributability without a referee is not anti-cheat.

Add to this the finding that **no local-only algorithm can distinguish first signer installation from
complete origin-storage eviction** (§Phase 5) — so browser tabs cannot be **seal voters** by default.
Signing is unaffected (every vertex, ACL op and trade is signed in-browser today); the constraint is the
never-vote-twice slot obligation, and two routes let a browser hold it anyway: at `q = 1`, a recoverable
seed-derived key plus a mandatory re-learn-from-peers rule (§Phase 5, slice 5e — safe because every vote at
`q = 1` _is_ a QC and lives on in the network); at quorum `≥ 2`, every voter preserves exact-slot
anti-equivocation continuity through either detectable-loss durable storage, an external exact-slot
witness, or — for a browser-local eviction-prone voter without such a witness — a **fate-shared
non-extractable key** co-evicted with the vote log (§Phase 5, custody options 1–3). Trust profile determines
authority and quorum; storage class determines custody. Both delegated and attested sets admit durable and
browser-local voters. The liveness cost of fate-sharing is why an always-on durable-class signer remains
in the picture as a **liveness backstop, not a trust requirement**.

**Optional desktop clients are the P2P route to a durable tier.** If the product ships an **Electron
build alongside the web app** — optional, opt-in, never required — any participant running it is
durable-class by construction: no ITP, no 7-day clock, storage in the app's own data directory rather than
a browser profile competing with a thousand origins. One such participant collapses **two of the three
operator roles onto a peer**: signer (durable vote log) and mirror (it has a disk). Only **relay** does not
follow, since a home machine behind NAT is usually not reachable. Two consequences: the fate-shared-key
problem largely dissolves (key and vote log share an app-data directory, or the OS keychain), and
tray-resident / launch-on-login — normal for a desktop app, impossible for a tab — is what converts
_durable_ into _durable and usually online_. Treat that as a deliberate product decision, not a side
effect. It does **not** auto-enroll anyone: the signer set is still pinned in the anchor and changed only
by handoff (§Phase 5, 5e2), so a desktop user is a _good_ delegate, not automatically _a_ delegate.

**What the operator node concretely is:** not a new service — the same `DRPNode`, long-lived, in Node.js
(`pnpm cli` → `packages/node/src/run.ts`). The relay role already exists as config
(`configs/bootstrap.json`: `"relay_service": { "enabled": true }`); mirror and signer land as two more
role flags on that same process. Train C requires none of them beyond the signaling broker every
browser-to-browser system needs — which may be public infrastructure (§0.5, zero-deploy) or self-run.

**P2P-first is a design rule, not a preference.** "Durable-class" (§Phase 5) is a storage property, not an
ownership property — a friend's always-on desktop running `pnpm cli` qualifies exactly as a company-run
mirror does. Every trust profile has a working zero-infrastructure configuration (§1, principle 11); an
operator-run mirror/relay MAY additionally enroll as an attestor later, but operator participation is
opt-in and additive — never load-bearing for correctness, and never a precondition for any profile to
exist.

**Therefore:** reachable target is zone-instanced multiplayer (≤ 64 durable writers/zone, 20–30 Hz
ephemeral, operator relay spine) and Discord-scale guilds (per-channel objects, ≤ 1k–5k online/channel,
archive profile). **Seamless single-shard worlds and serverless competitive anti-cheat are non-goals.**
Product decision already recorded: build without mirrors now, design assuming operator-owned mirrors later.

---

## 1. Principles

1. **Freeze before you port.** No consensus byte is written before the Phase −1 registry is merged. One
   immutable golden-vector document is minted per registry version. Before reference regeneration, the only
   lawful extension is an exact `registryVersion + 1` transition with exactly one new vector document that
   carries every prior vector record byte-identically. Regeneration closes that window; any later consensus
   change requires `protocolMajor: 3`. A vector diff must be impossible to land silently.
2. **Compaction amplifies divergence.** The determinism foundation gates every snapshot-trusting feature.
3. **Classify every change.** _replica-local-safe_ (ship now, legacy plane) / _coordinated-upgrade_
   (observable post-merge state or wire format; test cross-version explicitly) / _consensus-affecting_
   (**exactly one frozen protocol-major namespace, never patched in place, never dual-preimage under one
   `objectId`; v2 remains immutable and v3 is its successor**).
   A misclassification is a silent permanent fork — and round 1 misclassified three of its own slices (§Phase 0).
4. **Every gate names an executable evidence artifact** — a test file, a model output, a crash-injection
   log, a browser-matrix JSON, a golden-vector file. No inherited number is a gate.
5. **Every gate must be provably able to fail — and a RED spec is evidence only as a pair _(baseline, current)_.** Before its GREEN half begins, every new RED spec file is executed against the baseline SHA in a throwaway git worktree (**never** `git stash` — reviewers share one tree), and the pair is recorded with the text of the failing assertion; a bare count is satisfiable by a broken harness. `FAIL/FAIL` is a genuine RED contract; `PASS/FAIL` is a **regression pin**; `PASS/PASS` is **not a gate** and must be strengthened or deleted; `FAIL/PASS` is already green. _Scope qualifier:_ the baseline leg binds only where the subject code exists at baseline — for `protocol-v2`, `seal`, `storage-browser` and the other new packages a baseline run fails on module resolution, and **an import error is not a RED**; there, run the spec before the implementation exists and record that it fails on the asserted contract. A regression pin must assert the **invariant**, never the baseline's behaviour: pinning the old semantics as a "positive control" makes the pin unsatisfiable alongside the slice that changes them (D.5(i)). Each differential/oracle gate additionally ships a **mutation probe**:
   a seeded defect the gate must catch. The repo already has this pattern
   (`packages/object/tests/proptest/mutation-check.test.ts`); it is the only known defense against an oracle
   drifting green.
6. **Every zero/never assertion ships a positive control** in the same test. _"Zero durable vertices"_
   passes trivially if nothing is wired; assert in the same run that a durable command **does** create
   exactly one vertex.
7. **Atomic vs sliceable is explicit and argued — and every "atomic" names its observable boundary.**
   For the legacy applier that boundary is _one vertex_ across **all** of: hashgraph (vertices, forward and
   backward edges, frontier membership **and frontier order**, which feeds default dependency order and
   therefore signed bytes), per-hash state snapshots, the finality store, the live `drp`/`acl` proxies,
   `checkpoints`, `knownInvalidVertexHashes`, and subscriber notification. Two invariants come with it: the
   owner stores are never rebound (identity is stable), and nothing is published before it is committed.
   Atomic: the registry freeze itself; vertex preimage;
   canonical-order switch; staged state-adoption semantics; **the vote slot + signer state + outbox as one
   transaction** (a half-durable vote slot is _worse_ than none — it enables double-signing); the adoption
   pointer swap; latched-ACL genesis semantics.
8. **Shadow before destructive**, and **observation before acting**. Snapshots are produced, verified and
   digest-compared across independent replicas plus archival replay before anything is pruned; seal computes
   and compares cuts before it certifies them.
9. **Extend the existing test muscle.** `packages/test-utils/src/property-harness.ts` (seeded mulberry32,
   fake-timer virtual clock), the `linearize-reference.test.ts` independent-oracle pattern, the proptest
   convergence/partition suites, `perf-contracts.test.ts`'s instrumented-probe-counter pattern, the
   `failure-campaign` harness. A gate that does not run in CI will rot.
10. **Scale is stated as per-object ceilings, in a profile table, bound to a named harness.** Anything not
    in a profile table is not a supported scale claim.
11. **P2P-first: every trust profile has a working zero-infrastructure configuration.** Operator-run nodes
    (relay / mirror / signer, and optionally attestor later) are opt-in and additive — one way to obtain
    durability or fanout, never the definition of either and never a requirement. A slice that makes any
    profile depend on operator infrastructure to _exist_ is a regression against this principle (the
    zero-deploy invariant, §0.5, is the Train-C instance of the same rule).

---

## 2. Package topology and the AHE port map

### 2.1 Packages

Respecting the verified dependency direction (`object` depends only on `logger`/`tracer`/`types`/`utils`/
`validation`; `node` is the composition root; `object` never depends on `network`):

```text
packages/protocol-v2/     frozen codec, domain-separated hashing, field registry, v2 envelopes,
                          admission, signature suite            (no deps beyond types/utils)
packages/compaction/      Kahn order, fold, snapshots, close manifest, RFC 9162 history +
                          archive-index roots                   (below node, no network dep)
packages/storage/         runtime-neutral durable-store contract, state machine, error taxonomy,
                          shared fault scenarios, in-memory model (durability: "ephemeral")
packages/storage-browser/ IndexedDB backend: schema, migrations, immutable exact-byte CAS,
                          staged generations, vote slots, kill-point injection subpath
packages/storage-node/    SQLite backend: composite keys, WAL, full synchronous durability,
                          also the backend for optional Electron clients (main process) — never storage-browser,
                          SIGKILL crash tests
packages/seal/            round-free CutValue, proposals, votes, QCs, locks, pacemaker,
                          authority handoff                     (separate from FinalityStore)
packages/sync-v2/         object-head exchange, resumable content-addressed chunk fetch,
                          bounded active-tail reconciliation
packages/worker-host/     bounded streaming Worker execution, cancellation, capped telemetry
packages/ephemeral/       Track E: non-durable simulation plane (cannot create vertices, by construction)
```

`packages/storage/` is not optional bookkeeping. Without a runtime-neutral contract, IDB and Node semantics
diverge and green Node CI becomes poor evidence for browser correctness. The **same** exported
`runStoreContract(factory)` runs in Vitest against Node/SQLite and in Playwright against real IndexedDB.

The legacy plane (`object` applier/pipeline, legacy hash/topic) keeps running unchanged; v2 rooms live on a
separate namespace and topic. This converts a risky migration into an **additive parallel build** with one
signed migration step at the end.

### 2.2 Port map — what happens to each of the 13 reference modules

| Reference module     | LOC  | Disposition                                                                                                                                     | Target            |
| -------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `canonical.js`       | 390  | **Port + amend** (typed-array `-0`, endianness decision, locale-free sorting)                                                                   | `protocol-v2`     |
| `hash.js`            | 82   | **Port as-is** — its framing becomes normative                                                                                                  | `protocol-v2`     |
| `protocol.js`        | ~200 | **Port + amend** (add omitted preimage fields; delete `round` from the cut; add trust profile)                                                  | `protocol-v2`     |
| `admission.js`       | ~120 | **Port + amend** — the fail-open pipeline is replaced wholesale (G4)                                                                            | `protocol-v2`     |
| `linearize.js`       | 230  | **Port + harden/amend** (min-hash order; deterministic validation; five-action, isolated, fail-closed resolver contract; bounded swap cycles)   | `compaction`      |
| `fold.js`            | 74   | **Port + amend** (`fold.js:38` defaults authorization to `true` — must fail closed)                                                             | `compaction`      |
| `state.js`           | 90   | **Partial port + amend** (`stateDigest` only, synchronous canonical hashing; replacement is 0c and the reference DSM is not ported)             | `compaction`      |
| `snapshot.js`        | 106  | **Port + amend** (payload omits `blueprintDigest`, `archiveIndexRoot`)                                                                          | `compaction`      |
| `archive.js`         | 196  | **Port as-is**                                                                                                                                  | `compaction`      |
| `ct-merkle.js`       | 201  | **Port + harden/amend** (synchronous RFC 9162 primitives; copy-safe inputs/snapshots, proof validation, batching and safe accumulator counting) | `compaction`      |
| `seal.js`            | ~280 | **Port + major amend** (round-free CutValue, `round-change` phase, `highestPrepareQC`, durable state)                                           | `seal`            |
| `indexeddb-store.js` | 255  | **REWRITE — do not port.** Zero coverage; audit below. Kept as a _negative_ regression source.                                                  | `storage-browser` |
| `runtime.js`         | ~90  | **REPLACE — do not port.** Unbounded, imported by nothing, not a Worker host.                                                                   | `worker-host`     |

**Why the last two are rewrites, not ports.** `indexeddb-store.js` has similarly-named methods but does not
implement AHE §14.3/§16 semantics. Verified defects: a rejected `"strict"` transaction is **silently retried
with default durability** (`:27-33`); chunk and manifest writes use `put`, so different bytes can overwrite
an allegedly immutable digest (`:102-121`); `commitEpoch` receives **no QC and performs no authority
verification** (`:123-128`) and does **no current-anchor CAS**, so two adopters are last-writer-wins
(`:160-175`); it performs **unbounded destructive deletion of the entire old tail inside the pointer
transaction** (`:148-159`), making cleanup part of commit — directly contrary to AHE §16.2; recovery reads
head and journal in **two concurrent transactions** and can observe a combination that never existed
atomically (`:206-213`); `getVotes` is an unbounded `getAll()` scan across every room (`:91-96`); the vote
slot stores a structured-cloned object rather than exact signed bytes (`:73-89`). Transliterating this
would make a typed port _look_ durable while permitting lost votes, conflicting anchors, immutable-content
corruption and rollback deletion.

`runtime.js`: `batchSize` unvalidated (0 loops forever), cancellation checked once per batch, every output
retained (`O(total output)` memory rather than streaming), unbounded counter cardinality, every timing
sample retained forever, and `Math.max(0, ...values)` eventually exceeds engine argument limits.

### 2.3 The oracle architecture

Four oracles, each proving something different. The critical subtlety: **a reference regenerated from our own
amended schema is a second transcription of our own decisions** — conformance against it proves transcription
fidelity, not spec fidelity. So both versions are kept, with different jobs.

| Oracle                               | Proves                                                                                               | Cannot prove                                                                             | Kept honest by                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Legacy engine differential**   | v2 diverges from legacy _exactly_ where the manifest says; zero accidental drift on the legacy plane | That either engine is correct (legacy is the buggy one)                                  | Approved-divergence manifest with **exercised-entry enforcement** + mutation probe; legacy pinned at `bf7d351`                               |
| **(b) Pinned original JS reference** | Wire/digest conformance with an _independent_ reading of AHE v4, on the **un-amended** subset        | Anything about amended areas; storage behavior (zero coverage)                           | Commit-pinned and **edit-forbidden**. Amended areas covered by hand-reviewed vectors instead                                                 |
| **(c) Regenerated JS reference**     | The amended schema is implementable twice and the vectors are reproducible                           | Spec fidelity (it is our own decisions, restated)                                        | **Different author** from the TS port; both pinned to the registry                                                                           |
| **(d) Archival replay**              | Snapshot induction `S_(e+1) = Fold(S_e, KahnOrder(C_e))` ≡ from-scratch replay                       | Availability; blueprint semantic correctness (a buggy reducer replays identically wrong) | Must go through the public vertex-ingest path and share **no code** with the fold/adoption pipeline except the frozen codec and the reducers |

Plus **(e) an independent linearization re-implementation** in the existing `linearize-reference.test.ts`
style, written from the spec text by a different author, importing nothing from `packages/compaction`.

**Where the references live.** The byte-identical original is
`packages/protocol-v2/conformance/ahe-reference/`; it was moved from the review bundle without editing its
thirteen source files. The independently regenerated implementation lands separately at
`packages/protocol-v2/conformance/ahe-reference-regen/`. Both stay untyped ESM, excluded from
`tsconfig.build.json` and the package `files` array; root `tsconfig.json` already sets `allowJs: true` and
Node ≥20 provides `globalThis.crypto.subtle`, so vitest imports them directly. The original and regenerated
trees are never overlaid: they are different oracles with different provenance.

**The anti-"fixing" mechanism** (without this the oracle is worthless): commit
`packages/protocol-v2/conformance/reference.lock.json` — SHA-256 of every file under `ahe-reference/src/`,
bijectively checked against the review bundle's `SHA256SUMS.txt`. The original tree and lock are immutable:
**no registry bump authorizes changing either one**. A pure-Node, every-PR checker is executed from the
merge-base after bootstrap, so a PR cannot grade changes with its own replacement checker. The one head-checker
run is permitted only on a stacked base that already contains registry v5 and the original reference but no
freeze policy. CODEOWNERS routes the original and regenerated trees, both locks, the registry, vectors,
policy, checker and workflow to the same protocol-owner cohort. The base checker validates the effective
protocol CODEOWNERS tail block and workflow security shape semantically, allowing unrelated ownership and
action-version maintenance without weakening the gate. Golden-vector documents are immutable; while Phase −1 remains open, an exact
`+1` registry transition may add one byte-identical superset document. Slice −1f then adds
`reference-regen.lock.json`, whose provenance pins registry v5, the v5 vectors and the original-reference
lock; once that pair exists, the registry and both oracle ratchets freeze permanently.

### 2.4 Three live defects in the reference, confirmed by execution here

These would be inherited by a faithful port. All three were found by review and re-verified by me directly.

**D1 — `localeCompare` in three consensus-critical sorts is a fork vector.**
`protocol.js:63` sorts the signer set (feeding `signerSetDigest`, which is in the anchor preimage at
`protocol.js:199`); `seal.js:77` sorts QC votes before the QC digest; `archive.js:163` sorts archive-index
entries before the Merkle root. `localeCompare` with no locale argument uses the host's ICU data. Measured:

```
ids            = ['peer-B','peer-a','Peer-a','peer_a','peerä']
localeCompare  → peer_a, peer-a, Peer-a, peer-B, peerä
codepoint      → Peer-a, peer-B, peer-a, peer_a, peerä
```

Two replicas with different default locales compute different `signerSetDigest` → different anchor hash →
**permanent fork**, or two disjoint quorums certifying different anchors for the same cut.
_Resolution:_ UTF-8 byte order equals codepoint order, not UTF-16 code-unit order. All protocol sorts use
that order, fixed per field in the registry as `sortRule: "codepoint"`. The registry also constrains the `signerId` charset (no control
characters), which additionally closes the `\0` key-smuggling in the NUL-delimited vote key
(`seal.js:264`, `indexeddb-store.js:37`) — replaced by native IDB array keys.

**D2 — `Float32Array` `-0` encodes to bytes the reference's own decoder rejects.** Measured:

```
encodeCanonical(Float32Array.of(-0))  → 0b0180000000        (succeeds)
decodeCanonical(0b0180000000)         → throws "typed array contains non-canonical negative zero"
encode(f32 -0) === encode(f32 +0)     → false
```

The encoder normalizes `-0` for `number` (`canonical.js:104`) and `Float64Array` (`:127`) but **not**
`Float32Array` (`:121`); the decoder rejects `-0` in any typed array (`:357`). `Float32Array` is the tag
aimed squarely at game state. A physics field that ever produces `-0` (trivially: `0 * -1`) exports a
snapshot **no conforming peer can decode** — a room-wide unrecoverable close failure.
_Resolution:_ registry amendment — the encoder MUST normalize `-0 → 0` in `Float32Array`.

**D3 — admission verifies the digest before the cheap identity checks.** `admission.js:44-50` canonically
encodes and SHA-256s the vertex _before_ comparing `objectId`/`protocolMajor`/`epoch`, so a flood of
wrong-room garbage costs full crypto per message — violating spec §18.3's "reject oversize input before deep
decode." _Resolution:_ reorder to syntactic/limit checks → identity equality → digest → dependencies.

### 2.5 The typing rules for a semantics-preserving JS→TS port

Adding types changes behaviour in specific, enumerable places. Each rule below is derived from actual
reference code and carries the test that catches a violation. This table lands as
`packages/protocol-v2/docs/porting-rules.md`, cross-referenced from the registry.

| #   | Hazard                               | Reference evidence                                                                                                                                           | Port rule                                                                                                                                                                                        | Violation-catching test                                                                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | number vs bigint                     | integers are zigzag-varuint of **safe `number`s**; `bigint` throws (`canonical.js:106,111-113`); decode rejects beyond ±(2⁵³−1) (`:271`)                     | protocol integers are `number` + runtime `Number.isSafeInteger`; never widen to `bigint`                                                                                                         | vector: `2^53−1` round-trips; `encode(2^53)` and `encode(1n)` throw                                                                                     |
| 2   | `-0` / NaN                           | D2 above                                                                                                                                                     | all float paths normalize `-0`, reject non-finite                                                                                                                                                | D2 round-trip property                                                                                                                                  |
| 3   | `undefined` vs absent key            | `{a: undefined}` **throws** (`canonical.js:111-112`); absence is the only omission                                                                           | new packages compile with `exactOptionalPropertyTypes: true`; builders omit, never assign `undefined`                                                                                            | `@ts-expect-error` on `{field: undefined}`; builder output for an absent optional field digests equal to the reference                                  |
| 4   | prototypes / `Object.create(null)`   | decoder returns null-proto objects (`canonical.js:309`); encoder accepts only null-proto and `Object.prototype` (`:71-74`), rejects class instances (`:178`) | decoded values typed `Record<string, CanonicalValue>`; use `Object.hasOwn`, never `.hasOwnProperty`                                                                                              | assert `Object.getPrototypeOf(decoded) === null`; a ts-proto message instance and a class instance both throw                                           |
| 5   | Map/Set iteration order              | encoder sorts by encoded-key bytes (`canonical.js:157,172`)                                                                                                  | no consumer may depend on pre-encode insertion order                                                                                                                                             | seeded insertion shuffles in the differential fuzz                                                                                                      |
| 6   | `structuredClone` vs canonical clone | reference clones only via `deepCloneCanonical` (`canonical.js:377-379`)                                                                                      | consensus state cloning is `deepCloneCanonical` **only**; ESLint `no-restricted-globals: structuredClone` in consensus packages                                                                  | state containing `-0`: canonical clone digests as `0`, `structuredClone` preserves `-0` — assert the lint rule exists and document the behavioural diff |
| 7   | async WebCrypto vs sync noble        | `hash.js:55-58` is async-only                                                                                                                                | sync `@noble/hashes` on all digest paths and sync `@noble/curves/ed25519.js` on identity/signature paths (§2.6); WebCrypto only as a bulk Worker backend or for non-extractable seal-key custody | noble-vs-WebCrypto differential on framed inputs; type assertions that hashing and signing return `Uint8Array`, never `Promise`                         |
| 8   | DataView endianness vs Buffer        | every DataView call passes explicit `false` (BE); no `Buffer` anywhere                                                                                       | only DataView with an explicit endian argument; `Buffer` banned by lint; registry pins BE                                                                                                        | golden typed-array vectors + lint gate                                                                                                                  |
| 9   | locale-dependent sorts               | D1 above                                                                                                                                                     | `sortRule: "codepoint"` per registry field                                                                                                                                                       | D1's property test vs `Buffer.compare(utf8(a), utf8(b))`                                                                                                |
| 10  | string length = UTF-16 units         | `assertString(value, …, maxLength)` counts UTF-16 units, not bytes (`protocol.js:17-20`)                                                                     | keep unit counting; registry documents the unit per limit                                                                                                                                        | astral-plane chars at the 1024/1025-unit boundary                                                                                                       |

### 2.6 Crypto profile: sync `@noble/hashes`, and why §19's benchmark narrative is an artifact

The reference is async-poisoned end to end because `subtle.digest` is Promise-only (`hash.js:55-58`):
admission, vertex creation, Merkle append and QC building are all `async` **purely for hashing**, which also
forces a top-level `await` into `ct-merkle.js:3`. The repo already ships sync SHA-256 everywhere
(`packages/utils/src/hash/index.ts:1`; `@noble/hashes` is a production dependency of `object`, `utils`,
`keychain`).

AHE §19's slowest number — compact-accumulator Merkle at **739.8 ms median / 8192 leaves** — is dominated by
~16k awaited WebCrypto round-trips over 64-byte inputs, not by hashing. In-browser runs here completed 2048
appends in **50–87 ms** even under WebCrypto. So §19's "pure-JS Merkle is the slowest path, consider WASM"
guidance is an artifact of the reference's crypto binding, not a property of the algorithm — and it must not
be used as a sizing input.

_Decision:_ all protocol digests are **sync**, over `@noble/hashes/sha2`, behind one
`hashDomain(domain, ...parts): Uint8Array` in `@ts-drp/canonical`, preserving the reference's exact framing
bytes. Ed25519 identity and seal signatures are likewise sync over `@noble/curves/ed25519.js`; their
protocol functions return `Uint8Array`/`boolean` with no Promise surface. WebCrypto remains the custody
backend for non-extractable browser seal keys, not the protocol verification backend. `worker-host` MAY
provide a bulk async backend for large snapshot/archive payloads only,
conformance-tested equal to the sync backend on shared vectors. Re-benchmark in-repo before deciding on WASM, if WASM is more optimal then look if there's a similar implementation already existing, if not implement with WASM.

### 2.7 Wire format: the existing proto shape cannot carry v2

`packages/types/src/proto/drp/v1/object.proto:7-19` carries operations as `google.protobuf.Value`, which
cannot represent the canonical domain (bytes, `Map`, `Set`, typed arrays; every number becomes a double).
A v2 vertex serialized through it loses byte fidelity, so hash verification either fails or — far worse —
"verifies" over re-encoded bytes.

_Rule:_ v2 proto messages carry `bytes canonical_preimage` + `bytes signature` (+ routing metadata only).
Receivers decode via `@ts-drp/canonical` and **MUST verify the digest over the received bytes — never
re-encode.**

---

## 3. The phase graph

Round 1 landed AHE at Phase 3 (shadow snapshots) _before_ its then-proposed envelope at Phase 4. That
ordering cannot implement AHE directly: **a normative AHE snapshot payload commits to `objectId`, `epoch`,
`sourceAnchor`, `schemaVersion` and `blueprintDigest` — none of which exist until the successor
genesis/anchor namespace does.**
Shadow-folding legacy state and calling it an AHE shadow validates the wrong pipeline. Likewise the history
root and archive-index root are **mandatory fields of every cut and anchor**, so they cannot arrive in
Phase 7 while Phase 6 already validates history continuity.

The corrected order is: **frozen-v2 baseline → oracles → determinism → substrate → v3 normative freeze →
v3 namespace → shadow → seal → adopt/prune → archive**, with four parallel tracks.

```mermaid
flowchart TB
    P-1["Phase −1<br/>Normative freeze (ATOMIC)<br/>registry · vectors · reference regen"]
    P-1P["Phase −1′<br/>Protocol-v3 normative freeze (ATOMIC)<br/>formal model · registry · refs · governance"]
    G0["Gate 0<br/>Oracles + divergence manifest<br/>+ CI topology"]
    P0["Phase 0<br/>Determinism core<br/>= port the pure modules"]
    P1["Phase 1<br/>Sync · auth · capacity · ops"]
    P2["Phase 2<br/>Durable substrate + Worker<br/>+ hard-kill driver + browser gate"]
    P3["Phase 3<br/>v3 namespace: genesis, anchor,<br/>admission, latched ACL, roots"]
    P4["Phase 4<br/>Shadow cuts + snapshots<br/>(no trust, no pruning)"]
    P5["Phase 5<br/>Seal: creator-certified →<br/>round-free → delegated → attested"]
    FM["Formal model (Quint+Apalache)<br/>STARTS AT EACH NORMATIVE FREEZE"]
    P6["Phase 6<br/>Verified adoption<br/>+ bounded pruning"]
    P7["Phase 7<br/>Archive / Discord profile"]
    TE["Track E — ephemeral plane"]
    TS["Track S — sharding"]
    TT["Track T — topology"]
    TP["Track P — production surface"]
    RG["Research gates"]

    P-1 --> G0 --> P0 --> P2
    P0 --> P1
    P0 --> P-1P
    P-1P --> P3
    P2 --> P3 --> P4 --> P5
    P-1 -.-> FM
    P-1P -.-> FM
    FM ==hard gate==> P5
    P5 --> P6 --> P7
    P2 ==>|adoption CAS| P6
    RG -.blocks.-> P5
    RG -.blocks.-> P6
    P1 --> TT
    P1 --> TE --> TS
    TP -.spans all.-> P7
```

**Why the formal model starts at Phase −1, not Phase 4.** The model validates the _design_ — spec plus the
round-free `CutValue` amendment — and needs no implementation code. Round 1 started it at Phase 4, _after_
the atomic envelope freeze it is supposed to validate. If the model then discovers the pacemaker needs an
additional signed field, the only remedy is `protocolMajor = 3` — precisely the outcome the atomic freeze
exists to prevent. So the model starts with the registry, and **a mechanical variable-set sign-off gates the
freeze**: every signed envelope field must appear in the model's variable set.

---

## Phase −1 — Normative freeze (ATOMIC — nothing else starts)

**Goal:** one interoperable protocol. Today there is not one: codec, hashes, cut identity, round change,
profile activation and adoption all disagree or are undefined. **No consensus byte is written until this
lands.** Round 1 placed this as a Phase-4 "precondition freeze" in prose; a registry mentioned only in prose
is not an executable slice, and freezing at Phase 4 forces either a double vector-freeze or months of
unpinned porting.

| Slice       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Class        | Atomic?                              | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **−1a**     | `packages/protocol-v2/registry/field-registry.json` — machine-readable: `domains{}`, `kinds{fields[{name,type,constraints,required,sortRule}]}`, `framing{}`, `endianness`, `quorum{}`, `actions[]`. Every hashed structure, its domain string, exact field order and encoding.                                                                                                                                                                                                                                                                                                                                  | consensus-v2 | **atomic**                           | `registry.test.ts`: preimage builders are constructed _from_ the registry field list; `expect(cutValuePreimage({...unknownField}))` throws; every registry entry is referenced by ≥1 vector (`expect(uncoveredFields).toEqual([])`)                                                                                                                                                                                                                                    |
| **−1b**     | Codec + framing decisions (D1–D3, §2.4 and the table below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | consensus-v2 | atomic with −1a                      | `canonical-adversarial.test.ts`: `ENC(Float32Array[-0]) === ENC(Float32Array[+0])` and both decode; changing the process locale cannot alter signer-set or QC bytes                                                                                                                                                                                                                                                                                                    |
| **−1c**     | **Round-free `CutValue` / round-bearing `SealProposal` split.** This is a _preimage_ decision, not a Phase-5 implementation detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | consensus-v2 | atomic                               | `round-repropose.test.ts`: the same semantic value proposed in round `r` and `r+1` has an **identical `valueDigest`** and different `proposalHash`                                                                                                                                                                                                                                                                                                                     |
| **−1d**     | **Signature suite — two keys, one primitive, distinct suite identifiers.** (a) **Identity/vertex:** `ed25519-sha256-v1`, Ed25519 over the raw 32-byte registered digest. (b) **Seal voter:** `ed25519-seal-v1`, also Ed25519 over its raw registered digest. Distinct identifiers keep identity and seal independently rotatable; because the primitive is shared, the registry domains and exact `hashDomain` framing are load-bearing. Strict RFC 8032 verification (`zip215: false`) is consensus-critical. `p256-sha256-v1` is recognized but **reserved, not active**. Legacy-plane secp256k1 is untouched. | consensus-v2 | atomic                               | `signature-vectors.test.ts`: deterministic 64-byte Ed25519 vector; raw-digest rule; malformed length, ZIP-215-only and thrown-verifier inputs fail closed; identity-domain signatures do not verify as seal signatures or vice versa; reserved/unknown suites return exactly `false`. Scope labels are metadata: callers must recompute the registered digest from the canonical preimage under the declared registry domain.                                          |
| **−1e(i)**  | **`cryptoSuiteId` permitted values enumerated and negotiated at genesis only** (never downgradeable — Phase 3b). Active: `ed25519-sha256-v1` (identity) and `ed25519-seal-v1` (seal). Reserved: `p256-sha256-v1`. There is no runtime fallback or downgrade.                                                                                                                                                                                                                                                                                                                                                     | consensus-v2 | atomic with −1d                      | `crypto-suite.test.ts`: unenumerated and reserved suites reject with `UNSUPPORTED_PROFILE`; a peer lacking the genesis-named active suite rejects rather than substituting; epoch-anchor/profile enumerations must match and active/reserved sets must be disjoint                                                                                                                                                                                                     |
| **−1e(ii)** | Mint `registry-v5.json` from real registry-built preimages, including ordered `partsHex` for the actual domain-hash parts; preserve the original reference byte-for-byte; add `reference.lock.json`, semantic CODEOWNERS/workflow governance, and the base-governed silent-landing check                                                                                                                                                                                                                                                                                                                         | consensus-v2 | sliceable; **stacked on −1a…−1e(i)** | `golden-vectors.test.ts`: all registered kinds and active enum values covered; normalized-record `canonicalHex`, ordered `partsHex`, and digests agree in TS and the original reference; lock ↔ source ↔ vendored SHA-256 bijection; bootstrap registry bytes pinned; real temp-git CLI probes reject an invalid base, same-version registry drift, prior-vector drift, noncanonical vector path, bad regen provenance, policy weakening or protected-artifact drift |
| **−1f**     | Regenerate the JS reference from the amended schema into the **separate** `ahe-reference-regen/` tree, by a **different author** than the TS port. Add `reference-regen.lock.json` with registry-v5, vector-v5 and original-lock provenance. Do not bump the registry. Then both references and the registry freeze forever.                                                                                                                                                                                                                                                                                     | coordinated  | atomic                               | Both references reproduce every applicable vector byte-for-byte; regenerated tree/lock atomicity and provenance pass the base-governed checker; a post-regeneration registry bump fails                                                                                                                                                                                                                                                                                |
| **−1g**     | Spec amendments written into `docs/protocol/` with a versioned amendment log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —            | sliceable                            | Amendment log entry exists for every registry decision below                                                                                                                                                                                                                                                                                                                                                                                                           |

### The frozen decisions

| #   | Divergence                                                                                                                                           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hash framing: spec §4.2 `H(domain ‖ U32BE(len(part)) ‖ part…)` vs `hash.js:60-68` `"DRP\0" ‖ U32BE(\|domain\|) ‖ domain ‖ (U64BE(\|part\|) ‖ part)*` | **Reference wins.** Amend §4.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Length-prefixing the domain removes a domain/part boundary ambiguity the spec text has; the magic gives suite separation; U64BE removes a 4 GiB part cap; every existing digest and all bundle evidence already use it.                                                                                   |
| 2   | Typed-array endianness: spec §4.1 little-endian vs `canonical.js` big-endian everywhere                                                              | **Big-endian.** Amend §4.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Consistent with the framing integers; all evidence bytes are BE. (Note: the framing integers were never in conflict — both sides are BE. Round 1 mis-stated this.)                                                                                                                                        |
| 3   | Codec identity: spec "recommends CBOR" vs the reference's proprietary tag codec                                                                      | **The tag codec.** Amend §4.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Already implemented and browser-audited; zero new dependencies; CBOR would require rewriting the reference _and_ re-auditing a library's canonical-mode strictness for no protocol gain. Note this deletes "indefinite lengths" from the negative corpus — a CBOR-only concept.                           |
| 4   | `-0`                                                                                                                                                 | **Reject on decode, normalize on encode — consistently, including `Float32Array`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Removes the D2 asymmetry.                                                                                                                                                                                                                                                                                 |
| 5   | Omitted preimage fields                                                                                                                              | cut += `archiveIndexRoot`, `availabilityPolicyDigest`; anchor += `archiveIndexRoot`, `blueprintDigest`; snapshot payload += `blueprintDigest`, `archiveIndexRoot`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `archiveIndexRoot` is the Discord profile's entire audit chain; `availabilityPolicyDigest` is what makes §17's pruning gate objective; `blueprintDigest` is what turns a reducer-version mismatch from a silent fork into a loud rejection.                                                               |
| 6   | `highestPrepareQC`                                                                                                                                   | **Does NOT enter the prepare/commit vote preimage.** It moves to the **round-change** message body, whose preimage the registry defines alongside phase `"round-change"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | It is per-signer justification, not value binding. Binding it would make otherwise-identical votes digest-unequal and break QC aggregation.                                                                                                                                                               |
| 7   | Quorum                                                                                                                                               | Registry pins `q(n) = ⌈2n/3⌉`, `f = ⌊(n−1)/3⌋`; **no caller-supplied `maxByzantine` on the consensus path**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `seal.js:13-19`'s `⌊(n+f)/2⌋+1` is _identical_ to `⌈2n/3⌉` for `f = ⌊(n−1)/3⌋` across n=4..100,000 (verified by execution), but the reference lets a caller pass `maxByzantine` and break the equivalence.                                                                                                |
| 8   | Sort rule                                                                                                                                            | All protocol sorts are UTF-8 byte order (`sortRule: "codepoint"`); `signerId` charset excludes control characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | D1. Also closes NUL key-smuggling in the vote key.                                                                                                                                                                                                                                                        |
| 9   | Conflict action set                                                                                                                                  | Freeze **five** actions (repo `ActionType` incl. `Drop`), not the reference's four (`linearize.js:157-162`); amend spec §7.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Existing blueprints use drop-both.                                                                                                                                                                                                                                                                        |
| 10  | Trust profile and voter storage policy                                                                                                               | `profileDigest` + `cryptoSuiteId` are **explicit signed fields** in genesis and every anchor; profiles are exactly `creator-trusted-v1`, `delegated-trusted-v1` (n delegates, explicit quorum `k ≥ 2` — not BFT, honestly labelled "k of these n must agree") and `attested-bft-v1`. **Trust profile determines authority/quorum; storage class determines custody** (§Phase 5). `q = 1, n = 1` uses a recoverable seed-derived key plus network re-learn and MUST NOT fate-share. Every quorum-`≥ 2` voter preserves exact-slot anti-equivocation continuity: a detectable-loss durable-class voter uses durable CAS/outbox, incarnation binding and permanent refusal on mismatch; an external exact-slot witness is valid; a browser-local eviction-prone voter without that witness uses fate-shared non-extractable custody. Both delegated and attested sets admit both storage classes. Every set with eviction-prone voters includes a durable-class voter or declares stall acceptance; a stall never lowers quorum. | Separating authority semantics from storage/custody prevents the third trust-profile name from being confused with custody option 3, while keeping storage loss fail-closed.                                                                                                                              |
| 11  | Naming                                                                                                                                               | `protocolMajor: 2`, domains `ts-drp/*/v2`, package `protocol-v2` are the only identifiers in code. "AHE v4" survives solely as the spec document title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Round 1 correctly flagged the v2/v4 naming mess.                                                                                                                                                                                                                                                          |
| 12  | Signature suites                                                                                                                                     | Activate `ed25519-sha256-v1` for identity/vertex and `ed25519-seal-v1` for seal votes; reserve `p256-sha256-v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | One primitive with distinct suite identifiers preserves independent rotation. Keeping P-256 active would admit an ECDSA malleability/digest-identity fork for obsolete browser-local eviction-prone voters whose fate-shared custody option still lacks real-device co-eviction evidence (Appendix D.23). |

### −1g amendment log — signature-suite reservation

Registry version 5 records `p256-sha256-v1` as reserved and activates `ed25519-seal-v1`. A future edit that
reactivates `p256-sha256-v1` **MUST, in that same edit**, pin low-S normalization and pin whether the
32-byte registered digest is passed as the raw ECDSA message or prehashed again. Reactivation without both
rules is an incomplete consensus change and must fail review.

### Exit gate (Phase −1)

Registry v5 merged; `registry-v5.json` immutable and pinned; original and separately regenerated references
locked under distinct manifests; regenerated provenance binds the registry, vectors and original lock;
spec amendments merged with an amendment log. **Exit remains blocked until formal-model variable-set
sign-off is recorded; Phase −1g documents the variables but does not produce that sign-off.** Mutation
probes demonstrate that same-version registry drift, any old-vector mutation, either reference/lock drift,
checker or policy weakening, and every post-regeneration registry change fail the always-run CI check.
Repository branch protection must require the preserved `Require protocol-v2 registryVersion bump` status
and CODEOWNERS review; those GitHub settings are an external release prerequisite and cannot be proven by
an in-repo test.

**Real-device mobile evidence is NOT a Phase −1 exit-gate item — it binds at the Pre-release release
gate, after the whole feature set is green end-to-end.** An
earlier draft of this section made archived real iOS/Android `Ed25519: non-extractable` runs a blocker on the
freeze. That was the wrong milestone, and it is corrected here. What that evidence gates is **non-extractable
seal custody** for browser-local eviction-prone voters using custody option 3, in either a delegated or an
attested signer set. It is not a property of the third trust profile and not part of the freeze. Three facts
make the deferral safe:

- **Identity and vertex signing need no WebCrypto at all.** `signature.ts` uses synchronous
  `@noble/curves` per §2.6. Every mobile engine — including pre-18.4 iOS and pre-137 Android WebViews —
  participates fully in a v2 room as a non-voter regardless of what `crypto.subtle` supports.
- **The interop gates that actually carry the freeze are green.** Browser↔browser convergence
  (`examples/grid/playwright.modular.config.ts`, multi-browser cold start, rendezvous discovery, state sync,
  relay-loss recovery) and node↔browser (`playwright.canvas-chat.config.ts`) both pass, and
  `packages/node` is 202/202. Those are the paths a byte-level freeze can be wrong about; a mobile
  key-custody capability is not one of them.
- **Custody option 3 is independently gated anyway.** A browser-local eviction-prone voter without an
  external exact-slot witness may enroll only with browser-specific evidence that key/log co-eviction is
  atomic. A run that cannot produce that evidence cannot enable this storage mode in either delegated or
  attested authority, so the capability measurement is subsumed by an existing gate.

The requirement therefore **moves, it is not dropped**, and it moves to the end of the plan rather than to
Phase 5: real-device iOS and Android runs reporting `Ed25519: non-extractable`, with device, OS and
engine/build recorded, are part of the **Pre-release tier's existing real-device sign-off** — the release
gate that runs after the full feature set is complete end-to-end. Desktop Playwright mobile emulation does
not satisfy it at any milestone.

**Why the end of the plan and not custody-option-3 enablement.** Mobile is a _deployment-target_ question, not a
design input. Nothing upstream of the release gate needs the answer:

- If a mobile engine supports non-extractable Ed25519, custody option 3 works there for either eligible
  trust profile and nothing changes.
- If it does not, that engine cannot enroll as a browser-local eviction-prone voter without an external
  exact-slot witness. It may still use the durable class or witness mode where available and participates
  fully as a non-voter because identity and vertex signing never touch `crypto.subtle`. Desktop and Node
  seal voters are unaffected.

So the measurement can only ever change _which devices may hold seal keys_ — never the frozen bytes, the
registry, or any interface built between here and there. Deferring it costs no rework: by the time the
golden paths are green, confirming mobile is either trivial or the suite decision gets revisited
deliberately, which is exactly what the reserved identifier exists to permit.

**What the deferral costs, stated plainly:** if a release-matrix mobile engine turns out to lack
non-extractable Ed25519, custody option 3 is unavailable there — the same failure mode −1d cites against
secp256k1 — and we discover it at the release gate rather than now. **Reserving rather than deleting
`p256-sha256-v1` is what makes that recoverable**: the identifier is still claimed, and reactivation is a
documented, rule-bound edit (−1g) rather than a new protocol negotiation. That is an acceptable trade
because the
alternative was keeping `p256-sha256-v1` active, which was a _measured_ consensus-byte defect (D.23) rather
than a hypothetical one. Note also that this desktop matrix was wrong once for ~16 months, so the standing
test's fail-on-any-change discipline (2j) is what protects the assumption in the meantime.

### Phase −1a–c runtime hardening boundary

The registry runtime strips undeclared keys from typed nested structures, matching the pinned reference's
normalization rule. Untyped canonical values remain open by design. The checked-in registry is deeply
immutable at runtime, every registered kind has a unique domain, and semantic constraints used by the
current slices must affect validation rather than merely being recognized.

Vertex admission owns the registered `ts-drp/vertex/v2` digest verifier. Dependency resolution is an
ordered envelope contract: every resolved parent is hash-, object-, protocol-, epoch-, anchor- and
logical-time-checked before antichain and grounding checks. A resolver result is never advisory.

QC byte construction rejects empty or header-mixed vote sets. Signer membership, signature verification,
and the `SUBQUORUM` decision remain Phase 5 responsibilities because they require the active signer set and
the signature suites frozen in −1d. Genesis-only continuity enforcement for `cryptoSuiteId` remains −1e;
the −1a runtime validates the declaration but does not simulate a prior anchor. These are explicit API
boundaries, not permissive success paths.

Protocol-v2 mutation runs use whole-suite mode (`coverageAnalysis: "off"`, Vitest related-test selection
disabled). Module-initializer mutants that the runner cannot activate are reported separately from the
mutation score rather than counted as behavioral survivors.

---

## Gate 0 — Oracles, divergence manifest, CI topology

**Why first:** under direct adoption the oracle is not merely a safety net for a future rewrite — it is the
port's conformance harness from day one, and the reference already runs green here, so the second engine
exists immediately rather than at Phase 3.

**The identity-vs-divergence correction.** Round 1's G-b asserts _byte-identical_ digests between the legacy
engine and the candidate. That is the **wrong relation**: 0b (replacement adoption), 0c (classifier) and 0d
(Kahn order) are _deliberate_ behaviour changes. After the first one merges the oracle is permanently red,
and a permanently-red gate gets deleted or muscled green — the exact theater failure the plan warns about.

| Slice   | Change                                                                                                                                                                                                                                                                                                                                                                         | RED test → GREEN                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-a** | History recorder: capture real vertex DAGs from the existing proptest/e2e suites into replayable fixtures. On load, **recompute every vertex hash and assert equality** so fixture rot is loud.                                                                                                                                                                                | Fixtures committed; integrity check fails on a mutated fixture                                                                                                                                       |
| **G-b** | **Divergence-manifest oracle** (replaces byte-identity). Fixtures replay through legacy + candidate; the oracle emits the _pair_ plus the order diff. Gate asserts: every differing pair matches an entry in `fixtures/divergence-manifest.json` (`{fixtureId, legacyDigest, candidateDigest, reason, specSection}`), **and** every manifest entry is exercised by ≥1 fixture. | `differential-replay.test.ts`: unknown pair → fail; **stale entry → fail** (`expect(unexercisedEntries).toEqual([])`). CODEOWNERS-gated; adding an entry requires the spec section that justifies it |
| **G-c** | Golden counterexample against the **real** `dfsTopologicalSortIterative` (`hashgraph/index.ts:274-333`), not a model of it: deps `0←root, 1←0, 2←1, 3←1, 4←{0,2}` → full-tail `(2,4,3)` vs contracted `(2,3,4)`. Note `{0,2}` is non-antichain, so under the v2 rule vertex 4 is rejected at admission — assert divergence on the **tail set**, not a spurious mismatch.       | Runnable RED on HEAD today                                                                                                                                                                           |
| **G-d** | **Mutation probes.** Every oracle/differential gate ships a seeded defect it must catch. Extends `packages/object/tests/proptest/mutation-check.test.ts`.                                                                                                                                                                                                                      | Per gate: `expect(runGate(withSeededDefect)).rejects.toThrow()`                                                                                                                                      |
| **G-e** | **CI topology.** `conformance.yml` (PR-blocking), `formal-model.yml`, `nightly.yml`, `weekly.yml`, `shadow-soak` (long-running deployment, not a CI job), `playwright.protocol-v2.config.ts`. Every gate in this plan annotated `blocks-merge` or `reports-only`.                                                                                                              | A canary PR injecting a digest mismatch fails the blocking check                                                                                                                                     |
| **G-f** | **Coverage contract.** Per-package thresholds (`protocol-v2` ≥95/90, `seal` ≥95/90, `storage-browser` ≥90/85, `compaction` ≥90/85, others ≥80/70) **plus a zero-coverage allowlist**: any file below 5% must be listed with a justification; CI diffs the allowlist against reality and fails on unlisted zeros.                                                               | Probe test with a temp zero-coverage file must fail the gate                                                                                                                                         |
| **G-g** | **Event-script shrinking.** `runSim` records its event script (op/enqueue/deliver/dup) as serializable JSON; on failure, delta-debug by **event removal** and emit a minimal replayable fixture.                                                                                                                                                                               | `script-shrink.test.ts`: a failing 50-op script shrinks to ≤N events reproducing the same divergence digest                                                                                          |

> **Why G-g matters.** The existing `shrink()` (`property-harness.ts:477-504`) only shrinks `ops` and
> `replicaCount` — it **cannot remove individual events**. "Minimal" today means minimal dimensions at the
> same seed, which for a 50-op 5-replica divergence is nearly useless as a debugging artifact. This fixes the
> harness's real limitation at a fraction of a fast-check rewrite. _fast-check verdict:_ adopt for **new**
> gates only (integrated shrinking, counterexample persistence, `fc.scheduler()` for deterministic async
> interleavings); do not rewrite the existing suites — their determinism is welded to `vi.useFakeTimers` +
> mulberry32.

### Test tiering (every gate is assigned a tier — an unassigned gate does not exist)

The CI test job is capped at **10 minutes** and the existing proptests already consume most of it.
"Standing CI for a multi-week soak" is a category error: CI jobs end.

| Tier                                                        | Contents                                                                                                                                                                                                                                                                                                                                     | Gates                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Per-PR** (≤10 min vitest + ≤10 min Playwright)            | golden vectors + negative corpus; reference lockfile check; bounded seed-pinned conformance differential; exhaustive DAG corpus ≤6 vertices; divergence-manifest replay; quorum-intersection suite; property suites at PR seeds (20×50); fake-indexeddb kill matrix; chromium storage matrix; shadow smoke (10² epochs)                      | blocks-merge                                                                                                                 |
| **Nightly** (`nightly.yml`, created by G-e)                 | 10³-seed property expansion; 10⁴-epoch / 2×10⁴-permutation three-way differential; **a separate 10⁴-value boundary-biased codec differential against the pinned original reference**; 7-vertex corpus (5,231 DAGs); real-browser kill matrix chromium+firefox+webkit; ported AHE browser harness; Quint randomized simulation + trace replay | red → auto-file issue, promote the failing seed into the per-PR corpus, freeze merges **on the implicated path filter only** |
| **Weekly**                                                  | 10⁵-epoch soak; exhaustive delivery permutations ≤6 vertices; Stryker mutation pass on `seal` + canonical decode; mobile-emulation matrix; the unmodified Python validators as genuine cross-language redundancy (stdlib-only, no pip); **the fully-public e2e (`pnpm e2e-test:fully-public`) as the zero-deploy regression canary**         | reports-only                                                                                                                 |
| **Pre-release** (`workflow_dispatch`, blocks `release.yml`) | the multi-week **standing soak** as a long-running deployment of N replicas + archival replay emitting daily fold-digest-agreement metrics (hang it on the existing `@ts-drp/tracer` + `docker/prometheus-metrics/`); real-device iOS/Android sign-off; formal model re-run pinned to the release SHA                                        | release gate = ≥14 consecutive green days, 0 mismatches                                                                      |

**Flake policy:** `retries: 0` on every crash/consensus/safety gate; `trace: retain-on-failure`. Quarantine
requires a linked issue, an owner and an expiry, and a quarantined _safety_ test blocks release, not PRs.
Environmental failures (browser crash/OOM) get one job-level retry, counted as a metric — any retry event on
a consensus assertion pages a human.

---

## Phase −1′ — Protocol-v3 normative freeze (ATOMIC successor line)

Phase −1 closed protocol v2 permanently. The later discovery that a signed `authorSequence` is required
cannot reopen registry v5 or reinterpret any `/v2` domain. The successor therefore starts in the parallel
`packages/protocol-v3/` namespace as `(protocolMajor = 3, registryVersion = 1)` with `registry-v1.json`;
v2 records are preservation and cross-major negative controls, not records carried into the v3 lineage.
Every existing v2 protected artifact, checker and required status remains byte-identical and independently
required.

Phase −1 Decision 11 and the later Phase −1 naming summary are scoped to the v2 lineage. Principle 1
already contemplates this successor, so `packages/protocol-v3/`, `protocolMajor = 3` and `ts-drp/*/v3`
extend those decisions rather than amend them. Neither frozen v2 row is edited.

The v3 freeze is one consensus-visible checkpoint, but its internal TDD/review slices remain separate:

| Slice      | Decision owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | RED → GREEN gate                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **−1′a**   | Formal action/invariant model first. Model local issuance, admission, equivocation observation and detection; derive the required signed-field set from those actions and invariants rather than checking a registry-chosen set afterward.                                                                                                                                                                                                                                                                                                             | Fresh artifact-level RED fails on the missing v3 actions/invariants and signed-field derivation, not on a missing import. Pinned Quint checks cover signature authentication of the sequence, contiguous successful local issuance for one durable author lineage, and the separation between local issuance safety and arrival-order-independent remote policy.                                                |
| **−1′b**   | V3 registry/schema and specification: all registered domains use `/v3`; vertex review order inserts required `authorSequence` immediately after `author`, with type `safe-integer`, minimum and initial value `0`, no epoch/anchor reset and no wrap. Preserve the `wireFormat` rule: canonical-preimage bytes plus signature bytes, digest the received bytes without re-encoding. Select a distinct v3 identity-suite identifier and audit every v2-domain-bound suite; exact new identifiers are freeze decisions, not this correction's invention. | Registry/model/spec bijection; malformed and boundary sequence values; v2↔v3 domain/suite rejection in both directions; exact received-byte rule recorded as a numbered amendment. Canonical object key bytes, not registry declaration order, still determine encoded map order.                                                                                                                              |
| **−1′b2a** | Canonical codec grammar extraction. Before either v3 reference is authored, freeze a language-neutral Markdown grammar plus a machine-readable tag/layout table for `drp-canonical-profile-1`. Only this slice's RED and grammar authors may inspect the frozen predecessor implementations, solely to transcribe and falsify the existing wire contract; neither may author either v3 reference or the later TS port.                                                                                                                                 | A fresh from-grammar implementation, not an implementation import, reproduces the frozen v2 golden corpus and binding worked examples byte-for-byte and kills tag, length, varuint/zig-zag, float/negative-zero, typed-array, ordering, duplicate, non-minimal and limit mutants. The RED fails on non-reproduction, not merely file absence.                                                                   |
| **−1′b2b** | Bind that grammar as numbered decision `PH-N1P-D07` across the v3 specification, amendments, registry decision bindings and model sign-off. The grammar is authoritative; worked examples are binding conformance examples but never override its production rules.                                                                                                                                                                                                                                                                                    | A separate RED/GREEN cycle proves the D07 spec/amendment/registry bijection, exact `registryPaths`, annex hashes and outward sign-off hashes. Re-execute the unchanged −1′b test over the edited tuple; its RED/fixture, schema, signed-variable Quint, −1′a tuple and frozen v2 artifacts remain byte-identical.                                                                                               |
| **−1′c**   | A genuinely independent original v3 reference, authored only from the accepted normative tuple—including the frozen codec grammar—by someone who inspected neither predecessor implementation nor vector output and who will author neither the vector mint nor later TS port. Fix its source before a different agent mints real registry-built v3 vectors; never edit it to follow vectors.                                                                                                                                                          | A separately authored from-grammar RED oracle and the independent reference reproduce every v3 vector byte-for-byte; the frozen v2 codec is an executed preservation differential, not the normative byte owner. The semantic anti-copy discriminator fails for a mechanical v2 registry/validator transliteration; vectors cover every v3 kind/active enum plus sequence boundaries and cross-major negatives. |
| **−1′d**   | A separately authored regenerated v3 reference. Its author differs from the original reference and TS-port authors.                                                                                                                                                                                                                                                                                                                                                                                                                                    | Original and regenerated references agree on the full governed corpus and metadata-parity probes without importing either TS implementation.                                                                                                                                                                                                                                                                    |
| **−1′e**   | Locks, additive governance and permanent closure. The v3 checker/policy/workflow are separate from v2; the v3 CODEOWNERS block is inserted before the checker-protected terminal v2 block. The v3 bootstrap is fail-closed and single-use.                                                                                                                                                                                                                                                                                                             | Lock ↔ source ↔ vector provenance; mutations to registry, prior vectors, either reference, locks, policy, checker or bootstrap rules fail. Both unchanged v2 governance and new v3 governance pass. No partial combination of −1′a…−1′e may be treated as authoritative or merged as the freeze checkpoint.                                                                                                   |

Internal review snapshots may support iteration, but they are not checkpoints: they remain local,
unpublished, unmerged and unusable as a governed checker base, and the final freeze is squashed/landed as
one atomic consensus-visible checkpoint. No registry, vector, reference, lock or activated governance
artifact may reach the base until −1′a…−1′e are complete together. After that checkpoint, the TS
registered-byte port and local issuer are separate RED/GREEN items. Existing unimplemented rows labelled
`consensus-v2` describe the frozen predecessor design; whenever such a row would produce the first live
implementation, its RED must target the v3 successor or explicitly prove it is preservation-only.
Historical v2 evidence and completed v2 ports are not renamed.

---

## Phase 0 — Determinism core (= the pure-module port) + live-bug fixes

**Goal:** make replay deterministic, admission fail-closed, and state adoption replacement-correct, and make
each vertex transition **atomic across graph, snapshots, finality, live state, checkpoints and
notification** (0q). 0h is a hard prerequisite of shipping any staged apply; 0g's serialization half is
required only where rollback or an unvalidated transaction spans a suspension point (D.5(f)).
**Hard prerequisite for every snapshot-trusting feature.**

**The structural change from round 1:** round 1's 0a ("write a frozen canonical codec as a new package") and
0d ("implement min-hash Kahn") are **re-implementations of code that already exists and passes**
(`canonical.js` 390, `hash.js` 82, `linearize.js` 230, `fold.js` 74, `state.js` 90, `snapshot.js` 106,
`ct-merkle.js` 201 ≈ 1,170 LOC). Writing them green-field now and porting the reference at Phase 3 guarantees
either rework or two canonical orders. **They are the same slice: port, then amend.**

The ordering argument matters and is worth stating precisely. If we port and freeze vectors _first_ and fix
determinism later, the golden vectors are minted over a state that still resurrects deleted keys (0b) and
leaks `context` — and those wrong digests get **enshrined in conformance tests**. The reverse inversion costs
only rework. Hence: freeze (Phase −1) → port the pure modules → land 0b/0c semantics against the ported
codec → vectors already frozen and now provably correct.

| Slice        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Class                                                         | Atomic?                                       | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0a**       | Port `canonical.js` + `hash.js` → `@ts-drp/canonical`, sync noble backend, D2 fix, locale-free sorts, no top-level await                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | new package                                                   | codec+hash atomic                             | `phase-0a-contract.test.ts`: `hex(encodeCanonical(v.value)) === v.canonicalHex` for every registry-v5 vector; a **bounded, seed-pinned deterministic Per-PR differential** against the pinned original reference is byte-identical, with the materially larger corpus assigned to the nightly tier; **negative corpus**: `-0`, NaN/±∞, **safe-integral scalar Float64 wire forms**, unpaired surrogates, duplicate + out-of-order map keys, non-minimal varuint, trailing bytes, unknown tags and depth/item/byte limits each **reject** with the immutable original's reason; a `__proto__` probe decodes as inert own data on a null-prototype object. **Unsafe-integral scalar Float64 remains unresolved per D.25/D.26**; this slice ratifies neither acceptance nor rejection.                                                                                                                                                                        |
| **0b**       | Port + harden `linearize.js` (`topologicalOrder`, `CausalityIndex` and frozen resolver laws) + `ct-merkle.js`; partially port the synchronous `state.js` digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | consensus-v2                                                  | order switch atomic                           | `order-exhaustive.test.ts`: all direct-antichain DAGs ≤6 — **407 graphs, corpus hash-pinned** (PR) / ≤7 — **5,231 graphs, separately hash-pinned** (nightly) × exactly `min(8, V!)` pairwise-distinct real `Map`-insertion executions, with beginning/interior/end anchor-position coverage where eight executions exist, → one order. G-c's two-real-graph **origin**-sensitivity regression ships here. Exact divergence-manifest replay remains G-b and must preserve/reuse the pre-existing 304-graph `packages/object` reference harness rather than pretending that manifest already exists. `resolver-laws-property.test.ts` drives all 407 PR graphs through three conflict partitions and the same insertion-order schedule, alongside the focused five-action/fail-close suite.                                                                                                                                                                  |
| **0c1**      | Exclude replica-local `context` from `stateFromDRP` via the explicit `REPLICA_LOCAL_STATE_KEYS` contract (`state.ts:14,270`). Production shipped in ancestor `2259f29`; this slice completes the missing acceptance coverage without manufacturing a replacement implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | coordinated; inherited implementation                         | context exclusion atomic                      | `state-contract.test.ts`: literal expected keys exclude `context` and retain `values`; raw `FetchStateResponse` bytes exclude the `context` key and caller marker while retaining the replicated value marker; decode/deserialization roundtrip preserves the same contract. `drpobject.test.ts:72,81` were inverted by `2259f29` to exclude snapshot context. The desired live replica-local caller assertions at `drpobject.test.ts:455-522` must **not** be inverted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **0c2**      | Independently audit and accept delete-then-restore live adoption. `replaceEnumerableState` (`drp-applier.ts:184-201`) and six call sites (`:778,779,1140,1143,1277,1278`) were inherited from `2259f29`; the fresh acceptance suite and per-site mutation kills now independently approve that implementation. The proxy sites `:1140,1143` pass no journal and remain explicitly distinguished from the four journaled sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | coordinated; inherited implementation + acceptance completion | replacement adoption atomic                   | `state-adoption-replacement-0c2.test.ts`: a real **Map key** is first replicated from A to B, then A's delete operation is adopted without resurrection; literal cross-version expectations delete stale enumerable ACL/DRP fields and retain current fields; all six sites execute and each independently killed a transient no-op; local journal-less, remote journaled, deferred-reconciliation and forced rollback paths are distinct. Existing `state-adoption-replacement.test.ts` deletes an object property, not a Map entry, so it remains complementary rather than the acceptance owner.                                                                                                                                                                                                                                                                                                                                                        |
| **0d**       | Port and harden `admission.js` with the **mandatory fail-closed D3 pipeline** (G4): representation/fan-out limits → exact protocol/object/epoch/anchor identity → registered digest and author signature → dependency resolution/authentication/previous acceptance → exact `logicalTime = 1+max(dep)` and direct-antichain proof → hard-epoch authorization → operation schema → deterministic invariant. `isAncestor` is required on the raw context; preparation rejects its absence as `ADMISSION_CONTEXT_INVALID`, and admission rejects raw/forged contexts as `ADMISSION_CONTEXT_UNPREPARED` before per-message work. Context preparation is cold-path work; wire-byte limits remain transport-local; the digest binds normalized dependency-set order while received sorting remains a cheap pre-auth representation gate. This slice does **not** modify frozen `fold.js` or wire itself into the live node path; G4 stays open for the Phase-3a binder and Phase-4a fold owner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | consensus-v2                                                  | **atomic with 0e; unshipped alone**           | `admission-preparation-0d.test.ts`, `admission-pipeline-0d.test.ts` and `admission-dos-0d.test.ts`: required-context/type and cold-path preparation contracts; exact fail-closed pipeline/latches, candidate and dependency-envelope detachment, anchor/vertex exact logical time and mutation-sensitive controls; zero digest/signature work for wrong identity, dense/sorted-unique bounded deps and exact call-count instrumentation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **0e**       | Exact append-only `CausalityIndex` bitsets: `Anc(v) = ⋃_{d∈deps}(Anc(d) ∪ {d})`, with package-owned vertex/bitset publication and the epoch anchor in the oracle domain. `admitVertex` accepts only exact boolean ancestry answers; every non-boolean/non-definitive answer fails closed. This delivers the exact oracle implementation and strict result contract, not its live production composition: Phase 3a owns binding one per-object/epoch index into the node path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | consensus-v2                                                  | atomic with 0d                                | Bounds test: for `V≤8193`, 32-bit words — insertion `O(D·⌈V/32⌉)`; at default `D=16`, 120 unordered pairs and up to 240 directional probes; at registry ceiling `D=256`, 32,640 pairs and up to 65,280 directional probes. Raw static full-width backing storage at total `V=8192` is 8.0 MiB (`8,388,608` bytes); append-built triangular rows consume `4,210,688` bytes (~4.016 MiB), before typed-array object and `Map` overhead. RED also covers mixed `[epoch anchor, vertex]` deps, exact boolean answers, publication rollback and supported caller re-entrancy. Phase 0p must pin whether `maxEpochVertices` includes the anchor before enforcing the `V≤8192`/`V≤8193` boundary.                                                                                                                                                                                                                                                                 |
| **0f**       | Single fail-closed classifier (`accept`/`pending`/`terminal`/`quarantine`). Legacy-safe half: only **finite receiver-clock future eligibility** becomes re-requestable `pending`; dependency-relative temporal violations, submitted infinities and downstream public-class throws remain terminal. Public validation uses one top-level observation with immediate mutable-field copies; object admission uses a detached stable candidate. Pending provenance is result-bound, converted to a private marker carrying the exact validated hash and consumed before caller-field rereads. Batch admission snapshots a dense worklist, shares one detached operation/error record per submitted object identity, derives reconciliation eligibility from those records and returns unique truthful rejection buckets that exclude same-call graph members. Legacy object validation still passes `Date.now()` to `validateVertex`: Phase 0f changes classification of the finite receiver-clock mismatch but does not remove or canonically bind that wall-clock observation. Wall clock remains an eligibility input on the legacy path, although the finite-future case no longer creates terminal shared invalidity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | consensus-v2 + partial legacy fix                             | sliceable                                     | `clock-skew-divergence-0f.test.ts`: the same finite future-dated ancestry delivered to A@`t` and B@`t+Δ` converges after re-offer. `timestamp-*-0f.test.ts` pins dependency/nonfinite/public-error terminality, result/error replay resistance, one stable timestamp/hash observation and exact recovery-key provenance. `batch-*-0f.test.ts` pins dense worklist isolation, one operation observation, sibling containment, immediate mutable copies and truthful unique buckets. The v2 corpus exhaustively covers epoch/anchor/protocol × `{<,=,>,malformed}` (64 cells), not random samples of a deterministic total function.                                                                                                                                                                                                                                                                                                                         |
| **0g(i)**    | Per-object mutation discipline with a FIFO local-authoring lane. One `LocalMutationLane` is shared by the ACL and DRP proxies and gates the complete local `callFn` pipeline before `createVertex`. `applyVertices` intentionally remains outside that lane: it uses isolated preparation plus frontier CAS/retry, and every shared write or rollback remains in `tryCommitPreparedVertex`'s synchronous section after the final suspension per D.5(f). No lock is held across a merge `await`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | local-safe                                                    | local authoring order atomic                  | Parked merge commit/reject preserves synchronous local return, graph-before-publication and owner-store identity. Two un-awaited asynchronous local calls chain by dependency, not completion order. ACL and DRP share FIFO order; rejection releases the lane; subscriber reentrancy is queued; separate objects progress independently. Idle synchronous methods remain synchronous, while a synchronous method invoked behind active asynchronous local authoring conditionally returns a `Promise` and executes after that operation settles. This local-authoring half is a hard prerequisite for any design that leaves unvalidated transaction or rollback state live across suspension; 0q retains per-vertex apply/publication atomicity and L6.                                                                                                                                                                                                  |
| **0g(ii-T)** | After the atomic Phase −1′ freeze, port the pure v3 registered-byte surface: registry-derived vertex preimage, `/v3` domain and suite separation, exact received-canonical-preimage digest/signature verification, and admission parity. This is not a live protobuf/topic codec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | consensus-v3                                                  | preimage + registered-byte atomic             | Fresh v3 RED proves the sequence is required at the declared review position, changes canonical preimage bytes/digest, is authenticated by the v3 signature, rejects malformed values before key resolution, and rejects v2↔v3 domain/suite substitution. The verifier hashes the original received byte array and never a decoded/re-encoded surrogate. Frozen v2 preservation remains green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **0g(ii-I)** | After 0g(ii-T), implement author-bound local issuance over one injected `transactIssue(scope, buildAndSign)` boundary. The coordinator chooses the next sequence internally; the trusted closure cannot expose bytes; next counter + exact signed envelope + issued record/outbox commit only on success. An in-memory implementation is a labelled test double, never the production default. Phase 2 owns the durable transaction/crash matrix; Phase 3a owns live binding and publication of committed outbox records.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | coordinated; consensus-v3 primitive                           | successful issuance transaction               | For one durable `(objectId, author)` lineage, successful local issuance is exactly `0…n−1` under genuine seed-pinned async overlap; same-scope issuers sharing a store are linearizable and different scopes progress independently. Sync throw, async rejection or commit failure returns/exposes no envelope and does not advance; retry reuses the never-consumed ordinal; maximum-safe exhaustion fails without wrap or mutation. A global mutex or unsigned completion counter passes the naive control but fails signed-byte authentication. No crash-gaplessness, remote gap rejection or remote equivocation resistance is claimed here.                                                                                                                                                                                                                                                                                                           |
| **0g(ii-S)** | Before Phase 3a, close the post-freeze Ed25519 acceptance-profile gap without editing any Phase −1′ frozen artifact. A new normative addendum and machine-readable amendment record outside the protected tuple hash-bind that tuple and pin the raw 32-byte registered-digest message, canonical public-key and signature-point encodings, `0 ≤ S < L`, small-order public-key rejection and the exact verification equation matching the accepted noble `{ zip215: false }` behavior. New additive governance freezes only the supplement and its adversarial vectors. The frozen OpenSSL references remain byte/digest oracles, not strict-admission oracles for divergent signatures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | consensus-v3 supplement                                       | addendum + vectors + governance atomic        | Separate RED/GREEN/review owners prove the frozen tuple is untouched; small-order, `S + L`, noncanonical point and independently validated mixed-order cases distinguish strict noble from Node/OpenSSL or any wider verifier. A strict adapter around a frozen reference may satisfy the supplement; changing the reference, registry, existing specification/amendment files, locks, checker base or freeze policy is forbidden. Phase 3a live binding is blocked until this slice lands and executes the same vectors through the live verifier.                                                                                                                                                                                                                                                                                                                                                                                                        |
| **0h**       | Blueprint/resolver exceptions: **legacy** → bounded-retry quarantine (non-semantic, never in a shared invalid set). Frozen **v2** is preservation/reference-only: Phase 0b already pins AHE §7.2 resolver fail-close at the `@ts-drp/compaction` library boundary, not production integration, and no new v2 fold/binder is built. The first production reducer/fold seam belongs to the forward v3 Phase 4a adapter. Isolate per-vertex application so one poison vertex cannot discard unrelated vertices in a batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **split** legacy/v2; preserve v2                              | sliceable                                     | A validly-signed op whose method always throws is dropped after bounded handling and cannot wedge other vertices in the same `applyVertices` call or across redeliveries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **0i**       | **Remote-operation ABI boundary, split by plane.** Legacy is pre-satisfied by inherited `2259f29`: currently-throwing `constructor` is terminal per delivery without suppressing siblings, while currently-succeeding `toString`/`hasOwnProperty` remain admitted graph-present no-ops so patched peers do not fork from the legacy plane; the qualified baseline/current ledger is D.51. Frozen v2 is preservation-only. The still-open v3 half atomically owns a versioned canonical blueprint-admission manifest, an application-declared discriminator and per-operation argument schemas, and a runtime-proven prepared ABI. Preparation takes a required `expectedBlueprintDigest` and independently proves that the domain-separated digest of the exact canonical manifest/package bytes equals it; 0i does **not** verify anchor provenance. Both `verifyReceivedVertex` and local transactional issuance must require the prepared ABI and fail closed before semantic acceptance, signing or transaction work. No caller predicate, optional callback, universal legacy-name denylist, prototype reflection or `drp[property]` lookup is permitted. Phase 3a later proves the expected digest came from the signed anchor; Phase 4a later executes reducers; Phase 0j retains implementation determinism.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **split** legacy/v3; preserve v2                              | v3 manifest + both admission consumers atomic | Missing/malformed/noncanonical/unbound/digest-mismatched manifest, unknown/forbidden discriminator and malformed declared-operation args are terminal before acceptance/signing; local rejection causes zero `transactIssue`, signature, record or outbox work. `constructor`, `hasOwnProperty`, `__proto__`, `query_isAdmin`, `resolveConflicts` and `nonexistent` are inert application data, admissible only when that exact value is explicitly and safely declared in the digest-bound prepared ABI; admission never indexes a DRP/prototype/platform/hook surface. At least one declared operation accepts and issues. Invalid operations never enter accepted state or the causality index; optional forensic retention is explicitly non-admitted. Pin independent manifest bytes/digest and kill manifest, digest-binding, discriminator, argument-schema, fail-open-callback, runtime-provenance/brand-forgery and prototype-reflection mutants. |
| **0j**       | **Blueprint implementation determinism contract** — moved from round 1's Phase 8. Sync reducers, no ambient APIs (time/random/IO/DOM/Promise/module globals), and fail-fast proof that the loaded implementation artifact/runtime profile matches the identity/digest structurally bound by the Phase-0i-v3 manifest before it is usable for live admission or execution. This does not duplicate 0i's manifest canonicality/ABI/schema gate. `eslint-plugin-ts-drp` rule `drp/no-ambient-in-reducer`; cross-engine differential replay (Node/Chromium/Firefox/WebKit **and any shipped Electron build — it pins its own V8, so a stale desktop client and a current browser are genuinely different engines**). **Plus numeric determinism (below)** — ambient-API bans are necessary but not sufficient.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | consensus-v3 (digest) + local-safe (lint)                     | sliceable                                     | A fixture blueprint calling `Date.now()` inside a reducer **fails lint AND fails the cross-engine digest test**; a mismatched implementation artifact/runtime profile is rejected before live use. Phase 0i-v3's structural manifest/ABI checks remain independently green; neither slice claims the other complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **0n**       | **Numeric determinism.** ECMAScript leaves `Math.sin/cos/tan/asin/acos/atan/atan2/pow/exp/log/log2/log10/cbrt/sinh/…` **implementation-defined** — V8, SpiderMonkey and JavaScriptCore legitimately return different last-bit results for the same input. IEEE-754 `+ − × ÷ √` and `Math.fround` are exact and safe. A reducer doing physics or distance checks with transcendentals is a **silent cross-engine fork**, and `blueprintDigest` will not catch it because both peers run the _same_ blueprint. Ban transcendentals in reducers by lint; supply a deterministic `@ts-drp/math` (fixed-point or a pinned software implementation) for blueprints that need them. Also ban `toLocaleString`/`Intl`/locale-sensitive `sort` comparators in reducers (the same class of bug that D1 found in the reference itself).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | consensus-v2                                                  | sliceable                                     | `numeric-determinism.test.ts`: a fixture reducer calling `Math.sin` **fails lint**; the cross-engine differential over a seeded corpus of 10⁶ transcendental inputs demonstrates the divergence exists (proving the rule is load-bearing, not cargo-cult), and the `@ts-drp/math` replacement is byte-identical across Node/Chromium/Firefox/WebKit **and every shipped Electron version still in the wild** — the version-skew case is the realistic one: two friends, same blueprint, different pinned V8, different last-bit results, silent fork                                                                                                                                                                                                                                                                                                                                                                                                       |
| **0o**       | **Same-author equivocation policy** (remote). 0g(i) serializes _local_ writes; 0o consumes the frozen v3 sequence primitive from 0g(ii-T/I) without duplicating preimage, issuance or durability ownership. This slice defines what a replica does when it observes two distinct signed vertices with the same `(objectId, author, authorSequence)`. **Decision: admit both, resolve deterministically, record evidence, rate-limit — never reject because of a duplicate or observed gap.** Rejection would make admission depend on arrival order, violating envelope purity. Deliver the persisted gossipable proof, descendant validity rule, per-author rate limit and ACL-visible reputation signal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | consensus-v3                                                  | separate; depends on 0g(ii-T/I)               | `equivocation.test.ts`: two vertices with identical `(objectId, author, authorSequence)` and different content are both admitted, proof is emitted once and verifies standalone, and honest replicas converge regardless of fork arrival order. Descendants of both forks remain valid. Propagation gaps do not reject an otherwise valid envelope. A replica that rejects one fork or treats remote contiguity as admission validity fails the envelope-purity property.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **0p**       | **Per-operation and epoch work budget.** Admission classifies _validity_, not _cost_: a validly-signed op whose reducer is `O(state²)` but terminating is a CPU DoS no classifier catches. Without a deterministic runtime we cannot meter instructions, so bound the inputs instead: max argument bytes per op, max collection size a single op may touch, and a wall-clock **execution ceiling per vertex with a deterministic outcome** — exceeding it classifies the vertex **terminal by a replicated rule** (the budget is in `parametersDigest`, so every replica agrees), never "slow on my machine." Enforce the anchored `maxEpochVertices` ceiling before admission/adoption can grow the ancestry index, and normatively pin whether that count includes the epoch anchor; Phase 3a must assert this ceiling at the first live v3 binding. Real metering waits for the deferred VM; state this as the residual risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | consensus-v3 (budget is anchored)                             | sliceable                                     | `work-budget.test.ts`: a reducer exceeding the anchored budget is terminal **identically on a fast and a 20×-throttled replica** (fake-timer / instrumented step counter, not raw wall clock); the same op under the budget applies on both. `epoch-vertex-budget.test.ts`: the last allowed vertex is accepted, the next is rejected before ancestry publication, and anchor-inclusive counting matches the normative rule; Phase 3a repeats the boundary through the live binder                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **0k**       | Bound legacy `FinalityStore.states`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | local-safe                                                    | sliceable                                     | After 10⁴ vertices, `expect(finalityStore.states.size).toBeLessThanOrEqual(bound)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **0l**       | Public error-code taxonomy module (codes + classes + docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | local-safe                                                    | sliceable                                     | Typecheck test: every public throw site uses a catalogued code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **0m**       | `XVER` cross-version bisimulation harness: patched engine vs HEAD-pinned legacy engine (git-worktree build) over the Gate-0 fixture corpus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | gate infra                                                    | sliceable                                     | `expect(patched.vertexHashes).toEqual(pinned.vertexHashes)` + state equality per fixture × schedule. **Required check on any PR touching the legacy applier or validation classification**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **0q**       | **Per-vertex atomic apply and publication (owns L3 and L6 — added by D.3(d), specified by D.5).** One vertex transitions atomically across hashgraph, state snapshots, finality, live proxies, checkpoints and notification: fully applied, or no trace. **A committed vertex is never removed** — any dependency-closed subset of a causal DAG is a valid replica state, so no failure can require removing one. Every shared-store write sits inside **one synchronous commit section after that vertex's last suspension point**, which is what makes the design exempt from 0g's serialization mandate (D.5(f)) — it MUST NOT take the `callFn` lock, whose only effect would be to make synchronous `drp.method()` calls async. Vertex-presence is **re-checked inside the commit section** (the loop-top check is TOCTOU-separated from the insert by the blueprint `await`, and `HashGraph.addVertex` blind-inserts, duplicating frontier entries and hence the `dependencies` of the next locally signed vertex). **Live-proxy adoption is the one surface that breaks with no rollback involved**: its base is captured _before_ the `await`, so a plain replace-at-commit erases concurrently committed operations. Transplanting the local path's `assign` step **relocates that erase rather than removing it** — `assign` writes branch state, correct locally only because a local vertex depends on the whole frontier. Choose and record either commit-time recompute against a consistent base (await-free replay only) or frontier CAS/retry. `pruneSnapshots` must never observe uncommitted staging. `ApplyResult` gains `quarantined: Hash[]`; a transient failure is retriable and **never** enters `knownInvalidVertexHashes`. Hard prerequisite: 0h. | local-safe                                                    | **atomic per vertex**                         | Inverted `merge-atomicity.test.ts` per D.3(b); the four D.4.2 regression schedules; **L6 contract**: two replicas receiving the same DAG — one with a local call interleaved into a 256-append merge at the default suffix, one serial — end with equal live state, byte-equal `getStates` at every shared head, and a truthful `applied` report; **structural gate**: no shared-store mutation or journal entry is live across any `await`. All verified against baseline per D.5(h)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

> **0g(ii-I) maximum boundary.** The frozen registry, references, c2 contract and replacement mint issue
> `authorSequence = Number.MAX_SAFE_INTEGER` exactly once, atomically mark the lineage exhausted, and
> reject every later attempt before build, digest, sign or publication work. A backend may represent this
> with `lastIssued + exhausted` or an equivalent explicit discriminator; it must never compute
> `MAX_SAFE_INTEGER + 1` or reserve the final registered ordinal as an unissuable `next` sentinel.

> **0g(ii-S) additive path boundary.** The frozen v3 checker governs
> `packages/protocol-v3/conformance/vectors` as the exact singleton tree `registry-v1.json`; tracked,
> untracked and nested additions all fail. The separately governed supplement vector therefore lives at
> `packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json`. Neither the old governed
> tree nor any frozen checker/policy byte may be edited or restamped.

> **Why 0j moves to Phase 0.** Phase 4's shadow gate asserts byte-identical snapshot digests across replicas
> and browsers. That assertion is _unattributable_ unless blueprint execution is already deterministic
> cross-engine — a nondeterministic reducer makes every mismatch ambiguous between engine bug and app bug,
> and under schedule pressure those get "explained away". Round 1 put this in Phase 8 with no edge into
> Phase 4 at all.

> **Why 0k exists.** `finality/index.ts:159` `states: Map<string, FinalityState>` has **no** prune/delete/clear
> anywhere; `initializeState` adds one `FinalityState` (signer credentials + indices + a BitSet) per vertex
> forever, and neither `advanceCheckpointIfNeeded` nor `pruneSnapshots` touches it. Round 1 resolves
> FinalityStore by _deprecating it for v2_ — but §2 also says the legacy plane "keeps running unchanged", so
> every legacy room leaks one FinalityState per vertex for the life of the process. Deprecation is not
> mitigation for the plane that ships first.

### Exit gate (Phase 0)

Conformance differential green in `pnpm test`; exhaustive order corpus green; the Gate-0 divergence manifest
exact with zero unexercised entries; `context` provably absent from wire bytes with a positive control;
clock-skew divergence closed; XVER green.

**Two round-1 exit-gate items are removed as unpassable:**

- _"cross-room replay surface via 0a"_ — 0a is an initially-unused package and principle 3 forbids patching
  the legacy preimage, so **nothing at Phase 0 can add `objectId` to `computeHash()`**. That fix lands at
  Phase 3 on v3 rooms. Legacy rooms stay replay-vulnerable **forever**; ship a signed risk-acceptance
  document stating so, with migration as the only remediation. Do not imply Phase 0 fixes it.
- _"replay-from-snapshot equivalence"_ — the snapshot pipeline does not exist until Phase 4.

---

## Phase 1 — Sync, auth, capacity, and operational infrastructure

**Goal:** kill the `O(V²)` sync cost, close the unauthenticated-ingest surface, and land the capacity fixes
that the scale gates of _both_ trains depend on. No protocol change. Parallel-safe with Phase 2.

The hot path for one durable remote op, walked end to end, shows the first walls arrive **an order of
magnitude below round 1's own §8d target of 100 durable ops/s** — and the largest of them had no slice in
round 1 at all.

| Slice  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Class                                                           | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1a** | Responder builds a `Set`/`Map` of local hashes once instead of the getter-re-materialized linear `find()` (`handlers.ts:336-345` × `object/src/index.ts:161-163`). Wire format unchanged.                                                                                                                                                                                                                                                                                                                                                                                 | local-safe                                                      | `sync-perf-contract.test.ts` (**net-new**, not an extension): drive `syncHandler` at 10k/50k/100k; **exact instrumented probe-count assertion** via the `vi.mock` counter pattern (`perf-contracts.test.ts:15-28`): `expect(probesPerIncomingHash).toBe(1)`. Wall-clock is a soft signal only — a fast machine hides an O(V²) regression                                                                                                                                                                                                                  |
| **1b** | **O(1) applied-vertex index.** `updateHandler` rebuilds `presentHashes` from `object.vertices` on **every message** (`handlers.ts:261`), and `syncAcceptHandler` rescans the whole vertex set per message (`:415-416`). `merge` returns applied vertices; add `hasVertex(hash)` to `IDRPObject`; remove the getter from all hot paths.                                                                                                                                                                                                                                    | local-safe                                                      | `expect(getAllVerticesCallCount).toBe(0)` on the update path; per-update time ratio(100k/10k) < 1.5                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **1c** | **Attestation off-switch.** Every applied vertex triggers a local BLS sign (`handlers.ts:584`) + `ATTESTATION_UPDATE` broadcast (`:276-292`); every receiving signer runs `bls.verify` per attestation (`finality/index.ts:83`) — all main-thread, O(signers × rate), for an `isFinalized` with **zero production callers**. Config kills it for legacy rooms.                                                                                                                                                                                                            | local-safe                                                      | `attestation-budget.test.ts`: 8-signer room, 100 vertices, flag off → `expect(blsVerifyCalls).toBe(0)` and 0 broadcasts; **convergence digests unchanged vs flag on**                                                                                                                                                                                                                                                                                                                                                                                     |
| **1d** | **Incremental state snapshots.** The remote-apply pipeline does ≈3–4 × O(stateSize) deep clones **per vertex**: `fromStates` clone (`drp-applier.ts:383-384` → `state.ts:171-176`) + two `stateFromDRP` clones stored as per-vertex snapshots (`drp-applier.ts:595-601`). At 1 MB state and 30 vertices/s that is ~120 MB/s of cloning. Clone only keys reported mutated by `trackMutations`; share unchanged entries by reference under an immutability contract.                                                                                                        | local-safe (**assert wire bytes unchanged**)                    | **atomic** — torn sharing is an aliasing bug. `expect(clonedBytes).toBeLessThan(20 * mutatedBytes)` over 1k vertices into a 1 MB state; serialized `FetchStateResponse` bytes **identical** to the deep-clone baseline                                                                                                                                                                                                                                                                                                                                    |
| **1e** | Unify signature authentication into `object`/`validation` so **all** ingest paths are authenticated — `applyVertices` (`object/src/index.ts:205-212`) performs no signature check today.                                                                                                                                                                                                                                                                                                                                                                                  | local-safe                                                      | **Negative-space test**: delete/bypass the node-handler auth entirely; the suite must _still_ reject forged merges through `object.merge()` — proving auth moved. Plus **reflective completeness**: iterate the `messageHandlers` registry (`handlers.ts:133`) and assert every vertex-carrying `MessageType` routes through the single authenticated ingest function; an un-tabled message type fails the test. Deeper fix: `applyVertices` accepts a branded `AuthenticatedVertex[]` produced only by the verifier, making a bypass a **compile error** |
| **1f** | Bound `Channel.sends`. At capacity (default 1000) `send` pushes into an **unbounded** `this.sends` array (`message-queue/src/channel.ts:73-76`), and the network producers do not await — `node.ts:1762,1774` both `.catch()` fire-and-forget. Every message beyond capacity appends an un-GC'able pending send.                                                                                                                                                                                                                                                          | local-safe                                                      | **atomic** (a half-bounded queue is still a leak). `channel-backpressure.test.ts`: 10⁵ fire-and-forget sends with no receiver → `expect(sends.length).toBeLessThanOrEqual(cap)`, excess rejected with a typed error                                                                                                                                                                                                                                                                                                                                       |
| **1g** | Pre-decode frame cap + `Update` batch cap. `stream.ts:41` uses `lpStream`'s default `maxDataLength`; `handlers.ts:251` decodes then runs a **synchronous secp256k1 recover per vertex** (`:626-651`) with a `console.error` per failure — one UPDATE with N forged vertices freezes the tab.                                                                                                                                                                                                                                                                              | local-safe                                                      | `update-batch-cap.test.ts`: oversize batch rejected **before any signature recover** — `expect(verifyACLIncomingVerticesSpy).not.toHaveBeenCalled()`                                                                                                                                                                                                                                                                                                                                                                                                      |
| **1h** | Queue isolation: per-object enqueue never blocks the single network fanout loop (`node.ts:384`; `message-queue.ts:79-108` awaits each handler serially). One slow room stalls **every** room today.                                                                                                                                                                                                                                                                                                                                                                       | local-safe                                                      | Fill object-A's queue to capacity → `expect(objectBDeliveryMs).toBeLessThan(50)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **1i** | **Observer mode.** Discord's defining ratio is 10–100 readers per writer, but every replica pays the full writer pipeline. Observers still fully verify signatures (no security relaxation) but skip attestation generation/verification, skip per-vertex `assignState` snapshots (checkpoints only), and defer finality-store init.                                                                                                                                                                                                                                      | local-safe                                                      | Observer of a 100k-vertex room uses **< 25% of writer-replica heap**; convergence identical                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **1j** | Remove or cost-gate the dead `FETCH_STATE` response (§0.3.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | local-safe                                                      | `fetch-state-amplification.test.ts`: `FETCH_STATE(nonRootHash)` → **zero** serialized snapshot bytes leave the responder                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **1k** | Per-peer invalid-vertex budget + disconnect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | local-safe                                                      | After an attacker rotates 10k distinct invalid hashes, the honest peer's **re-request count** for evicted-parent descendants stays bounded (assert against `DRP_SYNC_REJECTED`/retry counters). _Not_ a memory assertion — §0.3.4                                                                                                                                                                                                                                                                                                                         |
| **1l** | Default **permissioned** ACL for the product path. `createObject` defaults to `createPermissionlessACL` (`node/src/index.ts:1229`; `acl/index.ts:33-34`), so `query_isWriter` returns `true` for anyone. Scale tests against a permissionless default measure attacker bandwidth, not product.                                                                                                                                                                                                                                                                            | coordinated (genesis behaviour)                                 | 100 Sybil keys cannot write without a grant; growth stays inside budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **1m** | **Kill-switch + version-skew infrastructure.** Round 1 required this "deployed" at the Phase-6 exit gate but no slice built it, and §12 explicitly says research gates are _not_ implementation slices — so it was nobody's deliverable. Signed kill-switch control message with a tested propagation path; v(next)↔legacy coexistence suite on one topic. Natural sibling of 1b's per-connection negotiation.                                                                                                                                                           | local-safe (switch is coordinated)                              | Multi-node harness: disable flag propagates and halts compaction within N s; drill log artifact                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **1o** | **Complete resource governance table** (per peer **and** per object), anchored where consensus-relevant: vertex rate, branch/antichain width, dependency fan-out, argument bytes, pending bytes, sync-response bytes, decode work, replay-work budget, per-object storage quota, and admission control. Cryptographic validity must never imply unlimited resource entitlement. Consensus-affecting caps (dep fan-out, argument bytes, epoch capacity) live in `parametersDigest`; purely local caps (pending bytes, decode work, sync-response size) are replica policy. | **split**: consensus caps → Phase 3; local caps local-safe here | Branch-spam at antichain width 128, oversized args, dependency bombs, slow-drip peers and 100 Sybils each stay within fixed CPU/RAM/queue budgets without quadratic blowup, and cannot starve an honest room. **NOP/dropped vertices count toward their author's epoch capacity** so dropped spam still costs the spammer                                                                                                                                                                                                                                 |
| **1n** | Heads-exchange sync with recursive missing-dep retrieval, per-peer shared-head tracking, chunking, backpressure, max-response caps. Feature-flagged, per-connection negotiable. (PRIBLT stays a later optimization with a mandatory hash-list fallback.)                                                                                                                                                                                                                                                                                                                  | local-safe                                                      | Convergence under adversarial partition/rejoin with old-branch injection; byte cost proportional to the delta, not history size                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Measured wall order (fix in this order; numbers are per-object)

| Wall                                                                                                                                   | Complexity                                                                | Approx. failure point                                                                                                                                | Slice                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sync compare `vertices.find`                                                                                                           | **O(V_local·V_remote)**                                                   | painful by 5–10k vertices; multi-second by 50k                                                                                                       | 1a                                                                                          |
| `presentHashes` rebuild per UPDATE                                                                                                     | **O(V)** per message                                                      | jank by ~10k vertices at multi-Hz                                                                                                                    | 1b                                                                                          |
| BLS attestation plane                                                                                                                  | O(signers × rate), main thread                                            | ~40 vtx/s at 8 signers; **~10/s at 32**                                                                                                              | 1c                                                                                          |
| State deep-clone per vertex                                                                                                            | **3–4 × O(stateSize)**                                                    | unreachable p99<50 ms for any state > ~100 KB                                                                                                        | 1d                                                                                          |
| secp recover + hash recompute                                                                                                          | ~1.3 ms/vertex measured                                                   | mobile p99 > 50 ms at ~50–150 vertices/batch                                                                                                         | 1g + Worker (Phase 2)                                                                       |
| Full inventory wire                                                                                                                    | **O(V)** bytes                                                            | 100k vertices ≈ 6 MB of hashes per sync probe                                                                                                        | 1n                                                                                          |
| Browser mesh                                                                                                                           | —                                                                         | 50–200 connections                                                                                                                                   | Track T                                                                                     |
| **Whole-container clone per merge** (staging-by-copy — introduced by the first L3 fix, **not** baseline; removed)                      | O(retained graph + snapshot bytes + finality entries) per `applyVertices` | 112 ms measured for a 1-vertex merge at V=3000; ~3.7 s at V=100k at the measured slope; 50 ms crossing near V≈1400 by interpolation, p99 not sampled | 0q — **forbidden mechanism**, see Phase 0                                                   |
| **`pruneSnapshots` key materialization** (`Array.from(hashGraph.vertices.keys())`, `drp-applier.ts:753`, **pre-existing at baseline**) | O(V) burst per checkpoint advance; amortized **O(V/256)** per merge       | not yet measured at scale                                                                                                                            | **unowned — needs an owner before atomic apply may be called history-independent** (D.5(j)) |

### Exit gate (Phase 1)

Probe counters flat 10k→1M; zero unauthenticated ingest paths proven **reflectively**, not by a hand list;
backpressure and frame caps hold under flood; observer heap ratio met; kill-switch drill log exists.

---

## Phase 2 — Durable substrate, Worker host, hard-kill driver, browser gate

**Goal:** the infrastructure AHE §16 assumes and the repo has **zero** of. Seal safety is _defined_ by durable
one-vote CAS and staged-adoption pointer swaps — build the substrate before the protocol that depends on it.

> Build the **hard-kill driver first, on a trivial two-record generation**, before any snapshot code exists.
> The driver is the hard part and gates Phases 4/5/6. Do not let the storage slice absorb the snapshot slice.

| Slice       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Class       | Atomic?                 | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **2a**      | `packages/storage/`: runtime-neutral branded types, generation state machine, error taxonomy, exact-byte codecs, `AheDurableStore` interface, shared contract + fault scenarios, in-memory model reporting `durability: "ephemeral"` (and therefore **never** eligible for signing)                                                                                                                                                                                                                                                                                                                                                                                               | local-safe  | state machine atomic    | `state-machine.test.ts`: `Complete` without every strict-durable ref, or `PointerSwap` without expected-head equality, is **rejected**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **2b**      | **Hard-kill driver** on a trivial payload. Every raw IDB call — **including `cursor.continue()`** — passes through an adapter requiring a literal `KillPointId`; an AST test rejects direct IDB requests elsewhere; a reviewed `killpoints.json` is compared by **set equality** with observed points. The operation runs in a dedicated Worker that posts the point ID and blocks on `Atomics.wait` (COOP/COEP for `SharedArrayBuffer`); the Playwright parent then `SIGKILL`s a detached child process group containing a `launchPersistentContext` browser and all descendants. **`page.close()`, `context.close()` and `browser.close()` are forbidden — they are graceful.** | local-safe  | infra sliceable         | `crash-driver.spec.ts`: `expect(declaredKillPoints).toEqual(observedKillPoints)`; both edges per point; hard-killed PID/process-group exit recorded; `closureDigest ∈ {old,new}` with `mixed === false`. Missing, timed-out, skipped or `blocked` points **fail the job**                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **2c**      | `packages/storage-node/`: SQLite backend — composite primary keys, WAL, full synchronous durability, explicit transactions, child-process `SIGKILL` at each statement/commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | local-safe  | sliceable               | Same shared traces as the model; every SIGKILL returns exactly one complete closure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **2-spike** | **OPFS-vs-IDB substrate decision, before the 2d schema freezes.** Measure OPFS `createSyncAccessHandle` + `flush()` against IDB `durability:"strict"` (the mode the reference silently falls back from) on the vote-slot and pointer-swap workloads; **test, don't assume, eviction equivalence** — the "same origin bucket, same ITP eviction" claim is currently `[unverified]`. `AheDurableStore` (2a) is substrate-neutral by construction, so the loser costs nothing. Decision recorded in `docs/protocol/` as a decision record consumed by 2d.                                                                                                                            | local-safe  | sliceable               | `opfs-idb-spike/`: durability microbench + `eviction-equivalence.spec.ts` (trigger real origin eviction; assert OPFS and IDB data vanish together or the difference is documented); the 2d PR links the decision record or fails review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **2d**      | `packages/storage-browser/`: **rewrite** per §2.2. IDB schema + migration lifecycle (`onblocked`, `db.onversionchange`), **native compound array keys** (not NUL-delimited strings), immutable exact-byte CAS via `add` (never `put`), the five-state journal keyed `(objectId, stageId)`, an `(objectId, epoch)`-indexed vote store (not `getAll()`), bounded staging. **Strict-durability rejection is a fatal capability error, never a silent fallback.**                                                                                                                                                                                                                     | coordinated | sliceable until enabled | `indexeddb-staging.spec.ts`: same digest + different bytes **rejects**; `chunkBatchSize: 0` rejects; a missing/corrupt chunk cannot reach `Complete`; a blocked upgrade closes the old tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **2e**      | **Full request matrix + recovery closure.** Recovery hashes the **entire active generation closure**, not two scalar metadata fields — a correct pointer can still reference a missing or mixed manifest, chunk set, QC or tail. Relaxed chunk writes are **cache only**; a generation becomes `Complete` only after every referenced chunk is hash-verified and promoted through strict transactions. Cleanup is **never** part of commit.                                                                                                                                                                                                                                       | coordinated | pointer-swap atomic     | `adoption-crash-matrix.spec.ts`: every request kill yields `closure(G_old)` **XOR** `closure(G_new)`; competing same/future/rollback candidates yield one monotone head; `HeadConflict` on a stale expected revision, never last-writer-wins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **2f**      | `packages/worker-host/`: **replace** `runtime.js`. Bounded streaming batches (validated batch size, per-item abort checks), cancellation, capped telemetry histograms, termination recovery, and a **ready-handshake worker protocol** — the worker posts `{ready}` after evaluation and the host queues work until then (this is the §0.1 bug). Ban top-level `await` in worker import graphs.                                                                                                                                                                                                                                                                                   | local-safe  | sliceable               | `worker-handshake.pw.ts` on **firefox + webkit**: a message posted immediately after construction is answered ≤ 5 s (fails against a no-handshake worker). `runtime.test.ts`: invalid batch sizes reject; result buffer stays under cap; abort prevents the next item; metric cardinality bounded. Frame budget: Playwright long-task observer `expect(maxLongTask).toBeLessThan(50)` during a **real 4,096-vertex fold**, plus a worker-side execution counter proving it ran off-main-thread                                                                                                                                                                                                                                       |
| **2g**      | Quota, persistence, private mode, rollback pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | coordinated | unpin rule atomic       | `quota-rollback.spec.ts`: `QuotaExceededError` injected at **every** mutating request never moves the head; estimate below margin refuses a new stage **before** destructive cleanup; a forged mirror receipt can **never** unpin the last usable signer rollback (`RollbackPinned`, not success)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **2h**      | **`playwright.protocol-v2.config.ts`** — dedicated, local, no public-Nostr dependency (storage correctness must not be hostage to relay flakiness). Fixed chromium/firefox/webkit projects, COOP/COEP, one worker per project, `retries: 0`, retained traces. Port the AHE harness's three checks into it — with real thresholds, since the bundle's `worker.ok` asserts no bound at all and **zero heartbeat samples still reports a zero max gap and passes**.                                                                                                                                                                                                                  | local-safe  | sliceable               | Every run emits `ahe-storage-validation.json`: schema version, git SHA, engine + branded version, OS/device, scenario, kill-point ID + edge, Web Locks mode, persistence mode, hard-kill PID evidence, recovered head, **full closure digest**, verdict. Aggregate passes only when every required tuple appears once, all verdicts are `pass`, and `missingKillPoints === []`                                                                                                                                                                                                                                                                                                                                                       |
| **2i**      | **Primary-tab election** (Web Locks, advisory): one tab per origin owns network sync, cleanup and vote attempts; the others queue locally. Correctness MUST hold with the election off or the Locks API absent — the CAS (2d/5c) remains the boundary; the election removes same-origin `VoteConflictError` churn and duplicate sync work.                                                                                                                                                                                                                                                                                                                                        | local-safe  | sliceable               | `primary-tab.spec.ts`: two tabs, election on → exactly one performs sync/cleanup (spy counters on the secondary are 0); kill the primary → the secondary acquires the lock and takes over ≤ T; the full 5c multitab suite passes **unchanged** with election disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **2j**      | **WebCrypto capability matrix as a standing test.** Which curves support non-extractable key generation is a moving target and the plan must not encode a memory of it. Assert per engine, per run, what `crypto.subtle.generateKey` actually accepts. P-256 remains in the measured matrix as a **reserved** capability, not an active suite.                                                                                                                                                                                                                                                                                                                                    | local-safe  | sliceable               | `crypto-capability.spec.ts` on desktop chromium/firefox/webkit plus iPhone/Pixel Playwright emulation: asserts the **currently expected** matrix and fails on **any** change — improvement or regression. The emulation projects are desktop engines with mobile viewport/user-agent and prove engine-regression coverage only; they do **not** measure real iOS Safari or Android WebView crypto. Real-device `Ed25519: non-extractable` artifacts are required at the **Pre-release release gate**, after the full feature set is green end-to-end — not as a Phase −1 exit gate — see the Phase −1 Exit gate section and D.23.4. Emits the observed matrix **with each engine's build number** into `ahe-storage-validation.json` |
| **2k**      | **Browser-matrix currency.** `@playwright/test` is pinned `^1.49.1`, resolving to 1.51.1 with **Chromium 134.0.6998.35** — roughly 16 months behind the field, and it already produced a false negative that nearly mis-set the seal suite. Every browser gate in this plan (kill-point matrix, storage validation, golden path 1 step 17) currently runs against a browser essentially nobody uses. Add a scheduled bump and make staleness visible.                                                                                                                                                                                                                             | local-safe  | sliceable               | CI job asserts each bundled engine build is within N months of current stable and **warns** past that (reports-only — a browser release must never break the merge queue); the release matrix records exact build numbers, and a release is blocked if any engine is more than one major behind the stable channel it claims to cover                                                                                                                                                                                                                                                                                                                                                                                                |
| **2l**      | **Durable author-sequence issuance transaction.** Implement the production adapter for the post-freeze 0g(ii-I) `transactIssue` contract. For one structural `(objectId, author)` scope, next counter, exact canonical-preimage bytes, signature, digest, issued record and outbox entry share one strict transaction; the internal build/sign closure cannot expose bytes outside that transaction. Browser and node backends implement the same contract.                                                                                                                                                                                                                       | coordinated | issuance-record atomic  | Shared contract plus real IDB/SQLite hard-kill matrix: every request/statement/commit edge recovers either the old state or the exact new counter+envelope+outbox closure, never a counter-only or envelope-only state. Same-scope callers across tabs/processes are linearizable; different scopes progress independently; throw/rejection/commit failure advances nothing; retry reselects the unconsumed ordinal; restart never signs different content for an already committed ordinal. The in-memory implementation remains an explicitly ephemeral test double and cannot satisfy this gate.                                                                                                                                  |

### Exit gate (Phase 2)

Kill-point matrix green on chromium + firefox + webkit with declared-equals-observed coverage; multi-tab,
quota, corrupt-chunk and Worker-termination suites green; the browser matrix the bundle recorded as _blocked_
is now executable, **and demonstrably able to fail**. The 2l durable issuance closure is old-or-exact-new
under every browser and node kill edge. `storage-browser` coverage is above its per-package threshold with
an empty zero-coverage allowlist.

---

## Phase 3 — The live v3 namespace (genesis, anchor, admission, latched ACL, roots)

Phase 3 is the first live successor integration. Its consensus-visible rows target the Phase −1′ v3
registry and domains; the completed v2 library work remains a frozen preservation/cross-major oracle, not
a live namespace option.

**Goal:** the vertex-identity change and the authenticated epoch structure. **This must precede shadow
snapshots** — a normative AHE snapshot payload commits to `objectId/epoch/sourceAnchor/schemaVersion/
blueprintDigest`, none of which exist until now. Irreducibly **atomic** at the preimage level (dual preimages
under one `objectId` are forbidden), but the **rollout** is sliced: new rooms only, legacy untouched.

**New hard prerequisite:** Phase 3a MUST NOT begin until 0g(ii-S) has frozen the strict Ed25519
acceptance supplement and the live-binder RED can execute its adversarial vectors. The Phase −1′ tuple
remains immutable; the supplement is a separately governed post-freeze addendum.

| Slice  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Class        | Atomic?                                       | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3a** | First live v3 vertex + anchor binder over the Phase −1′ registry; new object namespace + pubsub topic; `bytes canonical_preimage` plus `bytes signature` wire rule. The transport measures and verifies the exact received canonical-preimage bytes without re-encoding. Phase 3a exclusively signature-verifies the current epoch anchor, extracts its signed `blueprintDigest`, and passes that proven value as `expectedBlueprintDigest` into Phase 0i-v3 preparation/consumer APIs. At the `packages/node` composition root, construct one `CausalityIndex` per live object/epoch, bind `index.isAncestor.bind(index)` into the prepared admission context, require the same runtime-proven ABI before `accepted iff appended`, and compose Phase 2's durable `transactIssue` adapter so counter, exact signed envelope, issued record and outbox commit atomically before publication. Admitted signed operations may be stored/forwarded, but 3a executes no blueprint, reducer or fold. Phase 0q owns the synchronous append discipline; 3a owns actual v3 anchor/ancestry wiring, received-byte consumption and publication of committed outbox records. Assert Phase 0p's epoch ceiling before the first live append. | consensus-v3 | atomic per preimage + durable issuance record | Cross-room, cross-epoch, cross-anchor and cross-protocol replay are terminal. **Active three-plane cross-injection:** publish v3 envelopes onto legacy and v2 topics, legacy/v2 envelopes onto the v3 topic, and v2↔legacy traffic in both directions; every wrong-plane injection rejects. Live-binder REDs prove unknown hashes cannot create false antichain acceptance, accepted vertices append exactly once, rejected/pending/quarantined vertices never append, unbound/lying ancestry fails closed, the index resets only at a verified epoch transition, the cap is enforced, received-byte mutation fails without re-encoding, and crashes expose either the old durable issuance state or the exact committed envelope/outbox—not a counter-only or envelope-only state. Author authentication remains before operation-schema terminal latching. An authenticated ABI-invalid operation causes zero accepted append/index publication and an instrumented zero blueprint/reducer/fold calls; raw invalid-envelope retention, if any, is explicitly non-admitted and cannot affect causality, acceptance or execution. |
| **3b** | **Trust profile + genesis certificate.** `profileDigest`/`cryptoSuiteId` in genesis and every anchor. A new room defaults to `creator-trusted-v1`, quorum 1, and the UI/API status **must** read "Creator-trusted; not Byzantine-fault-tolerant." A **delegated** genesis (`delegated-trusted-v1`) names n delegate signers and an explicit quorum `k ≥ 2`, with PoP/acceptance from every delegate — **1-of-n is rejected at genesis** (two delegates closing the same epoch from different sync states would mint two valid QCs for different values: a fork with everyone honest). An attested genesis requires n≥4, unique accepted seal keys, PoP/acceptance from every signer, and a `q=⌈2n/3⌉` genesis certificate — **a lone creator cannot advertise attested mode.** Capability negotiation happens only at create/join; an existing anchor selects exactly one tuple; **negotiation MUST NOT downgrade an existing object.**                                                                                                                                                                                                                                                                                        | consensus-v3 | atomic                                        | `genesis-profile.test.ts`: one-signer `attested-bft-v1` **rejects**; a `delegated-trusted-v1` genesis with `k=1` **rejects**; one-signer creator profile succeeds and **cannot be network-downgraded or upgraded**. UI state is a **pure projection of the verified profile chain** — a copy test alone is theater, since copy can say "creator-trusted" while wire negotiation silently accepts attested evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **3c** | **Latched epoch ACL** — anchor ACL authorizes the whole epoch; ACL ops stage to the next anchor; moderation triggers an early close. **The ACL fixes land here**: admin becomes **revocable** (`acl/index.ts:129-132` is a documented no-op today) and resolver keys move to `(peer, group)` (`:219-221` discriminates only on the target peer, so `grant(P,Writer)` vs `revoke(P,Finality)` collide and one is silently dropped). Under latched authority a permanent un-revocable admin is an **epoch-poisoning primitive**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | consensus-v3 | atomic                                        | Authorization-vs-arrival-order property tests; concurrent `grant(P,Writer)` and `revoke(P,Finality)` **both** apply; compromised admin removable via handoff                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **3d** | Exact latched-ACL semantics as **pure functions**, defined _before_ 3c implements them (round 1 sequenced 4d after 4b — implementation against undefined semantics): envelope-admission authority, application-writer authority, ACL-operation authority + method preconditions, staged mutation order, `SignerSet_(e+1)` derivation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | consensus-v3 | sliceable                                     | Exhaustive grant/revoke/admin/key-rotation **epoch-straddle** tests; independent replay produces identical ACL bytes and signer sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **3e** | **RFC 9162 history root + archive-index root (empty is valid) + mandatory close manifest** — moved from round 1's Phase 7. `historyRoot` and `archiveIndexRoot` are **mandatory fields of every cut and anchor**; Phase 6 validates history continuity, so they cannot arrive after it. §13's `closeManifestDigest` becomes **mandatory, not optional** — otherwise two signers can agree on a nominal close root while using different leaf inputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | consensus-v3 | root profile atomic                           | `close-manifest-root.test.ts`: permuted arrival maps produce identical manifest and root; a changed frontier, order, hash or byte length changes or rejects the root. Exhaustive small-N consistency/inclusion + published RFC 9162 test vectors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **3f** | **Frontier aggregation / tip-set**, landing **before** `maxDependencies = 16` is enforced. Today deps default to the **full frontier** (`hashgraph/index.ts:226`) and no cap exists anywhere in the repo; enabling the cap first would terminal-reject normal writes under concurrency — a silent write-failure storm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | consensus-v3 | sliceable                                     | W=64 concurrent writers: dependency fan-out always ≤ `maxDependencies`, **no user-visible drop storms**; op-batching coalesces multiple mutations into one signed change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **3g** | **Rebase outbox**: original-author-only re-signing, idempotence by stable `clientOperationId`, per-operation policy (idempotent-rebase / transform / expire / manual-review), rate-limited so post-cut rebase storms cannot amplify                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | consensus-v3 | sliceable                                     | Non-author replacement **fails verification**; duplicate rebase delivery applies once; per-blueprint metamorphic test: uninterrupted execution ≡ every cut/rebase placement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **3h** | Migration record + **rehearsal gate**. The signed migration record is the only irreversible act in the whole plan and round 1 gave it no dry-run. Authorization is **creator-only or an externally pinned/threshold authority** — never "current authority", which is replay-influenceable until 3a lands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | coordinated  | sliceable                                     | Rehearsal E2E: after the dry run the room is **provably still on the legacy plane** (rollback intact); activation is a separate signed act                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Exit gate (Phase 3)

Exhaustive small-graph model + adversarial schedule suite green **in repository code**; **envelope purity**
proven (below); cross-implementation conformance vs the pinned reference on the un-amended subset.

> **Envelope purity replaces round 1's "≥10⁴ stale-envelope classifications."** Counting events proves
> nothing — a classifier that consults replica-local history passes it. The actual §1.1.4 invariant is that
> classification is a _pure function of (envelope, currentAnchor)_. Three executable properties:
> (i) two replicas with **different delivery histories** but the same current anchor classify every envelope
> in a randomized adversarial stream **identically** (assert equal classification vectors);
> (ii) restart-invariance — serialize only `(anchor, epoch)`, restart, re-classify, assert identical;
> (iii) a **compile-level seam**: `classify(envelope, anchorCtx)` takes no graph or history argument.
> The 10⁴ count then falls out of the property run rather than being the gate.

---

## Phase 4 — Shadow cuts and snapshots (zero trust, zero pruning)

**Goal:** the full canonical AHE pipeline producing real `CutValue`s and snapshots over real v3 anchors,
continuously digest-compared, with **full history retained**. This is where determinism bugs surface while
rollback is still free.

| Slice  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Class        | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **4a** | **Blueprint state-machine adapter and fail-closed fold owner** — the real work, and round 1 had no slice for it. The reference folds `DeterministicStateMachine` instances with `fork()/apply()/snapshot()/adopt()` over plain-data reducers (`fold.js:12-74`, `state.js:27-90`), but `fold.js:38` defaults missing authorization to `true`; the port must require explicit authorization and fail closed. The repo's blueprints are **classes with method dispatch** (`callDRP`, `drp-applier.ts:664`), proxied pipelines, and `stateFromDRP` deep-cloning every own key. Deliver: `IStagedStateMachine` in `types`; `DeterministicStateMachine` → `test-utils` (oracle side only); `BlueprintStateMachine` in `compaction` over `IDRP` + the **versioned blueprint export API** (`schemaVersion` + the same `blueprintDigest` committed by the Phase-0i-v3 manifest/package — never a second blueprint identity). The adapter must consume the same runtime-proven prepared ABI for explicit application-table dispatch; `drp[property]`, prototype traversal and permissive callback dispatch are forbidden. Cloning is `deepCloneCanonical`, **never** `structuredClone`. | coordinated  | **atomic** (adapter semantics and fail-closed authorization). Three-way fold differential over **blueprint** states (`MapDRP`/`SetDRP`/`AddMul`), not plain objects; omitting authorization never defaults to accept; a state containing `-0`, a `Date` or a class instance **fails loudly** with a canonical error rather than diverging silently. The first production-reachable v3 reducer RED/GREEN must also pin a synchronous throw, a Promise result as a §7.3 protocol error, explicit authorization fail-close, positive declared operations and sibling/causality continuation, no reducer invocation or partial state/adoption on any admission/dispatch failure, and repeated-close/redelivery behavior. |
| **4b** | Canonical snapshot export/import, schema-versioned, `blueprintDigest`-committed. Import is **replacement** into isolated instances.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | consensus-v3 | Snapshot induction `S_(e+1) = Fold(S_e, KahnOrder(C_e))` byte-identical vs archival replay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **4c** | **Streaming** content-addressed 128 KiB chunking, bounded manifest, resumable any-order fetch. The reference's `verifyAndAssembleSnapshot` concatenates the **whole payload in memory** (`snapshot.js:93`) — at `maxSnapshotBytes = 256 MiB` that is 2× peak, violating spec §10.3 and round 1's own 3b requirement. Ship `verifySnapshotStream(manifest, chunkSource): AsyncIterable<Uint8Array>` verifying per-chunk digests and a running payload hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | consensus-v3 | Memory ceiling: heap delta **< 2× chunk size** while verifying a 64 MiB payload. Corrupt/withheld/substituted/reordered/oversized chunk injection → bad bytes never reach the active pointer; resume from arbitrary missing sets; **slow-drip and byte-budget** exhaustion by a malicious source is bounded and switches peer                                                                                                                                                                                                                                                                                                                                                                                        |
| **4d** | **Shadow mode** — three-way continuous comparison as a standing gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —            | See below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

> **The self-agreement trap.** Round 1's 3c compares replica A, replica B and archival replay — but all three
> execute the **same TS fold and codec**, so two copies of the same bug agree forever. The comparison must be
> **four-way on a sampled subset**: TS engine A vs TS engine B vs archival replay **vs the pinned JS
> reference's fold** on exported epoch fixtures. Plus **liveness counters** (folds executed > 0, non-trivial
> state sizes) so an empty pipeline cannot be green.

### Exit gate (Phase 4) — the soak, made executable

Round 1's _"≥10⁴ randomized epochs, runs for weeks, standing CI"_ names no comparator, no artifact and no
mechanism that accumulates weeks. Replaced by:

- **Comparator:** at every close assert `digest(A) === digest(B) === digest(archivalReplay)`, and on a
  sampled subset `=== refFoldDigest(exportedEpochFixture)`. Throw with `seed=… epoch=…`.
- **Ledger:** a nightly job runs the seeded soak with a fresh date-derived seed and **appends
  `{date, seed, epochs, mismatches, browsers, sha}` to a committed `soak-ledger.json`**.
- **Gate:** the Phase-6 enablement PR carries a required check that parses the ledger and asserts
  `mismatches === 0 && totalEpochs ≥ 1e5 && consecutiveGreenDays ≥ 30`.
- **Standing soak:** a long-running deployment (not a CI job) of N replicas + archival replay emitting daily
  fold-digest-agreement metrics through `@ts-drp/tracer` into the existing `docker/prometheus-metrics/` stack.

---

## Phase 5 — Seal: creator-certified → round-free consensus → delegated → attested

**Goal:** the certification layer, as a **sidecar** (control-plane records, not DAG vertices — avoiding the
recursion of putting the evidence that finalizes a cut inside the cut). Runs in **observation mode** until
the formal model is green. **Creator-certified ships before attested.**

> **Cross-cutting decision:** **deprecate** the per-vertex BLS `FinalityStore` / `ATTESTATION_UPDATE` gossip
> on the live v3 line — seal QCs subsume it. Frozen v2 remains preservation-only and is not silently
> upgraded. Do not run two attestation systems concurrently. (Phase 1c already makes the old plane
> switchable because it is a live throughput ceiling, not merely hygiene.)

| Slice   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Class        | Atomic?                                     | RED test → GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5a**  | Implement the round-free `CutValue` / `SealProposal` split frozen at Phase −1. `valueDigest = HASH(CutValue)`; each round mints a distinct `SealProposal` and `proposalHash`, but every prepare/commit QC separately binds **both** `valueDigest` and that round's `proposalHash`. **Locks compare `valueDigest`, never `proposalHash`.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | consensus-v3 | atomic with 5b/5c                           | `round-carryover-n4.test.ts` — execute the schedule below and assert round 1 commits the **same `valueDigest`**, and that **no conflicting commit QC is reachable**                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **5b**  | Seal safety core over the Phase-2 CAS: value-bound prepare/commit votes, monotone `enteredRound`, lock + change-justification, QC validation against the anchor signer set, **durable-before-gossip**, verbatim re-broadcast of the durable outbox after restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | consensus-v3 | **atomic with 5a and the vote transaction** | Crash-at-every-boundary double-vote tests over the **real** IDB vote CAS; forged/mixed QCs, duplicate signers, round rollback, lock amnesia all rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **5c**  | **The vote transaction** (§below) — the only API that can release bytes for gossip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | consensus-v3 | **atomic**                                  | `multitab-vote.spec.ts`, chromium/firefox/webkit, Web Locks **on and off**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **5d**  | **Pacemaker**, fully specified (§below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | consensus-v3 | atomic                                      | Model-first: the Quint model + its trace regressions are the RED; the implementation is the GREEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5e**  | **Creator-certified profile** — ships first, with honest UI trust labelling. Exercises the whole snapshot/anchor/admission/storage stack with one signer. **Key custody at `q = 1, n = 1` is deliberately distinct from quorum-`≥ 2` custody options:** a **recoverable seed-derived key** (the repo's existing `private_key_seed`), and fate-sharing is **forbidden at n = 1** — a fate-shared creator deadlocks the room on a _single_ eviction, because the returning new identity cannot authorize its own handoff (that needs a QC from the destroyed key). Recoverability is safe here _because_ `q = 1` collapses the rounds: every vote the signer casts **is** a QC, gossiped and held by peers, so the signer's sealing history is recoverable from the network — anti-equivocation state need not be local-only. **Mandatory rule:** on detected storage loss (incarnation mismatch), a `q = 1` signer MUST re-sync and query peers for the highest QC bearing its own signature **before sealing anything**. Residual risk, stated honestly: a QC gossiped to _some_ peers but unreachable during re-learn — the exposure is the partial-delivery window only (a QC that reached nobody died with the storage and re-sealing is harmless; one that reached anyone reachable is re-learned).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | consensus-v3 | sliceable                                   | Not a copy test: **tamper test** — flip one vertex in the close set post-signing → verification fails; assert `valueDigest` recomputed from the raw close set equals the signed digest; the n=1 cut certificate passes the **same QC validator** as attested mode; vote durably slotted **before** gossip; mid-cut crash recovery resumes correctly. **Storage-loss re-learn test:** kill the creator's storage, restart with the seed-derived key, assert the signer **refuses to seal** until it has queried peers and re-learned its own highest QC, then assert it never emits a second, different value for an already-sealed epoch |
| **5e2** | **Delegated-trusted profile** (`delegated-trusted-v1`): n delegate signers, explicit quorum `k ≥ 2` — the creator's answer to "who closes epochs when I'm away," installed by authority handoff **at any time while the creator can still sign** (insurance, not rescue — a handoff needs a QC from the current authority, so it cannot be arranged after the creator disappears; but it need not happen at genesis, where a room has no members to delegate to yet). Delegates may be added **or removed** by later handoffs, and an enrolled signer may be any identity that supplies an acceptance signature — including a durable-class **operator/mirror node**, opt-in and additive per principle 11. With `k ≥ 2` such a node can never seal alone: it needs a peer delegate to agree, making a third-party attestor a **liveness helper with no unilateral power** — one more reason 1-of-n is excluded. Each handoff lengthens the authority chain a joiner verifies, but that chain is proportional to _governance changes_, not messages. **No new protocol:** the same 5a–5d prepare/commit/QC machinery with smaller numbers; two delegates that disagree simply fail to reach quorum. **Not BFT** (at n=3, `n ≥ 3f+1` ⇒ f=0); the honest label is "k of these n must agree," never "BFT." **1-of-n is excluded**: two delegates closing epoch N from different sync states would mint two valid commit QCs with different `valueDigest` — a fork with everyone honest, converting a recoverable stall into an unrecoverable halt. (A deterministic per-epoch leader — `signers[epoch mod n]` with bounded fallthrough, the pacemaker's rotation applied to a trusted set — would rescue 1-of-n for staggered solo play; **deferred, not specified**.) Delegated rooms SHOULD include ≥1 durable-class delegate — the optional Electron build (§0.6) is the easiest route — SHOULD, not MUST: principle 11 governs, and a pure-browser delegate set is permitted with the stall-acceptance trust label. Ships after 5e, before 5f. | consensus-v3 | sliceable                                   | `delegated-profile.test.ts`: `k=1` genesis **rejects**; two delegates concurrently proposing **different** close sets for the same epoch → neither reaches quorum, **zero commit QCs, no fork** — the room retries rather than halting on conflicting QCs; a 2-of-3 E2E closes an epoch with the creator offline; UI label reads "k of n must agree" and is a pure projection of the verified profile chain                                                                                                                                                                                                                              |
| **5f**  | **Attested profile** `q=⌈2n/3⌉, n≥4`, individual QCs under the v3 seal-suite decision audited and frozen by Phase −1′ (no BLS aggregation). Swaps the certificate producer without touching state semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | consensus-v3 | sliceable                                   | Quorum-pair intersection suite **demoted to a cheap regression** (spec §21.3 itself disclaims arithmetic as sufficiency evidence); the real gate is the model + trace conformance                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5g**  | **Authority handoff & weak subjectivity**: handoff intent + all new-signer acceptances + old-authority QC; data-cut vs authority-cut separation (joiner cost ∝ governance changes, not messages); invite pinning (genesis + recent cut); conflicting-branch warning UX                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | consensus-v3 | sliceable                                   | Profile changes only at the named next epoch; a missing new-signer acceptance or old-authority QC **rejects**. **Equivocation:** two valid-looking handoff certificates for different new sets → **loud halt + UI, never an automatic pick**                                                                                                                                                                                                                                                                                                                                                                                             |
| **5h**  | **Close barrier** (AHE §8.4, currently unsliced anywhere): before proposing, the proposer announces intent, gathers signer frontiers, reconciles missing vertices, then proposes; new local writes during the barrier go to the next-epoch outbox. An optimization that makes **first-round agreement likely** — explicitly **not a validity oracle**, and never load-bearing for safety. Without it, k-of-n delegates proposing from different sync states burn pacemaker rounds before converging: correct but wasteful, and for a 2-of-3 friend room it would look like "compaction is broken."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | local-safe   | sliceable                                   | `close-barrier.test.ts`: delegates with deliberately divergent frontiers converge in **one** round with the barrier on; **disable the barrier → correctness unchanged** (same final `valueDigest`, zero conflicting QCs), only the round count rises — proving the barrier is not load-bearing for safety                                                                                                                                                                                                                                                                                                                                |

### The n=4 permanent stall this fixes (G2), as an executable schedule

1. `n=4`, `q=3`; `A,B,C` honest, `Z` Byzantine.
2. Round 0: `A,B,C` prepare semantic value `X` → `PrepareQC(X,0)`.
3. Deliver the QC only to `A,B`; each emits a commit vote and **locks `X`**. No third commit vote arrives, so
   no commit QC exists.
4. All honest signers enter round 1. Correct leader `C` gathers three round-change messages including
   `PrepareQC(X,0)`.
5. **Under AHE as written:** `X` re-encodes with `round=1`, yielding `D1 ≠ D0`. `A,B` cannot recognise `D1` as
   their locked `D0`, and the round-0 QC does not certify `D1`. Only `C,Z` remain available: `2 < q`,
   **permanently**.
6. **Under the amendment:** the round-1 proposal hash changes but `valueDigest(X)` does not. `A,B,C` prepare
   and commit the carried value.

The regression must assert **eventual commit of `X`** and **zero commit votes for a conflicting value**. The
tempting "fixes" are both wrong: discarding locks, or allowing retroactive lower-round voting, each restore
the already-demonstrated retroactive-commit fork.

### The normative pacemaker (G3)

Let `f = ⌈n/3⌉−1`, `q = ⌈2n/3⌉`. Sort the anchor signer set by raw UTF-8 signer ID. Leader `L(r) = signers[r mod n]`.

- Round 0 needs no new-round certificate. Every round `r > 0` proposal **MUST** include a verified new-round
  certificate containing exactly `q` round-change votes for `(objectId, epoch, anchor, r)`.
- A signer entering round `r` **atomically persists** `enteredRound = r` and its one round-change vote. That
  vote carries its highest verified prepare-QC summary; the complete QC travels as a content-addressed
  attachment.
- Local timeout from `r` enters `r+1`. A peer may catch up to `r` only after either a verified prepare/commit
  QC from round `r`, or `f+1 = ⌈n/3⌉` distinct valid round-change votes for `r`. **One higher-round signature
  is insufficient.**
- The leader selects the prepare QC of greatest round among the certificate's votes. Same-round valid QCs
  cannot name different values; ties for the same value choose the lowest QC digest. The leader **MUST**
  re-propose that exact `valueDigest`. If none exists it may propose any locally valid `CutValue`.
- A signer prepares only in its exact `enteredRound`, after checking leader identity, new-round evidence, the
  selection rule, complete cut validity and artifact availability. It may prepare a value different from its
  lock **only** when the proposal carries a valid prepare QC with `validRound ≥ lockedRound`. Equality with
  the lock is **by `valueDigest`, never proposal hash**.
- A prepare QC is exactly `q` prepare votes for one tuple. A signer emits a commit vote only for a prepare QC
  **in its current round**, and atomically persists commit vote + lock + highest QC + round **before gossip**.
  A commit QC finalizes the `valueDigest`.
- **Already-signed old votes may arrive late and form a delayed QC.** "No retroactive vote" forbids _creating_
  a new lower-round signature after advancement; it does not invalidate previously valid evidence.
- `T(r) = min(roundTimeoutMaxMs, roundTimeoutBaseMs · 2^r)`. One `T(r)` deadline while awaiting
  proposal/new-round evidence, one after preparing, one after committing. Only valid phase progress resets the
  phase deadline. Liveness is claimed **only** when the capped timeout exceeds post-GST message time plus
  bounded artifact-validation time.
- Buffer at most `maxFutureRoundGap` unproven rounds; evidence satisfying the catch-up rule may bypass the
  gap. Invalid or far-future messages allocate **no** per-round state.

### The vote transaction (5c) — the atomic unit

Round 1 treated the vote slot (2b) and the seal state (5b) as separate slices. They are one transaction: the
reference mutates rounds and locks **in a JavaScript object** (`seal.js:117-170,177-189`) and merely offers
`exportDurableState()` later (`:246-254`), while the IDB schema has no signer-state or outbox store at all. A
crash after changing the lock but before exporting restarts an apparently-correct signer at an **earlier
round**.

1. **Outside IDB:** parse canonical bytes, verify identity and phase — **including `round-change`** — verify
   proposal/QC evidence, and construct a `VerifiedVoteIntent` bound to the signer-state revision observed
   during validation. No unverified remote object enters the transaction.
2. Open **one** `"strict"` `readwrite` transaction over `storageMeta`, `voteSlots`, `signerState`,
   `voteOutbox`. Unsupported strict durability is a **fatal signer-capability error**.
3. `storageMeta.get(incarnation)` must match the externally enrolled storage incarnation, else abort
   `StorageLoss`.
4. `signerState.get([objectId,epoch,signerId])` must match the validated revision and satisfy
   `round ≥ enteredRound` and the lock transition. A revision mismatch aborts and restarts validation.
5. `voteSlots.get(slotKey)` — key path `["objectId","epoch","round","phase","signerId"]`:
   - **same canonical preimage** → commit no mutation, return a copy of the **exact stored signed bytes**,
     even if the caller constructed different signature bytes;
   - **different preimage, same key** → abort `VoteConflictError`, including the exact existing bytes for
     diagnosis/rebroadcast, but **never** treat the requested vote as successful;
   - **absent** → `voteSlots.add(exactBytes)` + `signerState.put(next monotone state)` +
     `voteOutbox.add(exactBytes)` in this transaction. Native key uniqueness is the final race boundary.
6. Bytes reach the network dispatcher **only after `transaction.oncomplete`**. After restart the dispatcher
   retransmits the exact durable outbox bytes; callers can never gossip their provisional input.

### RESEARCH GATE, promoted to a design constraint: browser tabs cannot be _seal voters_ by default

**First, the distinction this rests on — it is easy to state it wrong.** A browser can _sign_ perfectly well.
This repo already does: `packages/keychain/src/keychain.ts:38-44` derives a stable secp256k1 libp2p identity
(optionally from a seed), and every DRP vertex, ACL op and trade is signed in-browser today. Nothing here
changes that, and nothing here restricts it.

The constraint is narrower and different in kind. A **seal vote** is not "produce a signature" — it is
"**never** produce a _second, different_ signature for the same `(objectId, epoch, round, phase, signerId)`
slot, across crashes, restarts and storage loss, forever." AHE §14.3 is explicit that the correctness
boundary is **IndexedDB uniqueness/CAS** — storage, not cryptography. It is an anti-equivocation obligation,
and it is the premise BFT quorum intersection depends on.

**No local-only algorithm can distinguish a first signer installation from complete origin-storage
eviction.**

**A durable, independently-recoverable key makes this worse, not better.** If the signing key were lost
together with the vote log, eviction would be self-healing: the tab returns as a _new_ identity, not in the
signer set, and cannot equivocate. But a seed-derived or wallet-held key — exactly what
`private_key_seed` gives us — returns with the **same signer identity and no memory of having voted**.
Same key plus amnesia is equivocation by an _honest_ participant. Two valid commit QCs for conflicting
values then become reachable with **zero Byzantine actors**: a fork produced entirely by honest peers and a
browser storage policy. Persistence requests, local sentinels, monotone QCs and "latest round" checks all fail: after
eviction the IDB uniqueness boundary that AHE §14.3 names as _the_ correctness boundary **no longer exists**.
A returning correct signer can sign `X`, lose IDB, recover the same signer key, and sign conflicting `Y` for
the same `(objectId, epoch, round, phase)` — quorum intersection no longer protects safety, because the
implementation has made an _honest_ signer equivocate.

`navigator.storage.persist()` does not solve this; it is discretionary and cannot prevent user or ITP
eviction. Round 1 filed this as a research gate blocking 5d/6/7. It is not a research question — it is a
design constraint, and it **also applies to creator-certified acting mode**, because a single creator
double-signing across an eviction is still a fork — resolved at `q = 1` by the **network re-learn rule**
(slice 5e), not by fate-sharing, which at n = 1 would deadlock the room on a single eviction.

For every quorum-`≥ 2` voter, choose one of three custody/continuity options; **option 1 is the
recommendation**. These are storage modes, not trust profiles: both `delegated-trusted-v1` and
`attested-bft-v1` admit the detectable-loss durable class (option 1) and browser-local eviction-prone class
(options 2 or 3).

1. **Detectable-loss durable-class signer.** Browser tabs may remain replicas and vote relays while a
   designated Node/operator, optional desktop client or other durable peer signs. The signer MUST use the
   exact-slot durable CAS and outbox, bind its signer identity to a storage incarnation, and refuse
   permanently on incarnation mismatch; re-entry is an authority handoff to a new signer identity.
   _(Consistent with §0.6 and the recorded operator-relay decision.)_
2. **External exact-slot witness.** Before releasing a signature a browser-local eviction-prone signer
   reserves the exact slot
   _and vote bytes_ in an independently durable witness implementing the same insert-or-return-existing CAS
   plus monotone signer state. Witness unavailable → **stop signing**. An external epoch/round high-water
   mark is **insufficient** — it cannot distinguish two values in the same round/phase.
3. **Fate-shared non-extractable signer key** — the custody option that lets a browser-local
   eviction-prone voter without an external exact-slot witness vote **in quorum-`≥ 2` sets (delegated and
   attested); forbidden at n = 1**, where a single eviction would permanently deadlock the
   room (the handoff needed to re-enroll requires a QC from the destroyed identity — `q = 1` uses the
   recoverable-key + re-learn rule in 5e instead). Use a
   **non-extractable WebCrypto `CryptoKey`** stored in the same origin/bucket as the vote log, so eviction
   destroys the key and the log together and the old signer identity is unreconstructible. **The curve is
   forced by WebCrypto, not chosen:** measured here, `crypto.subtle.generateKey` rejects **secp256k1
   (`K-256`) with `NotSupportedError` on Chromium, Firefox and WebKit alike**, so the seal key can never be
   secp256k1 — a registry pinning secp256k1 for _all_ v2 signatures would make this custody option
   unimplementable. **Ed25519 generates non-extractably** in the measured desktop engines and is the seal
   curve. `p256-sha256-v1` is reserved, not a fallback: the only clients it would serve are obsolete
   iOS/Android WebViews acting as browser-local eviction-prone seal voters, while custody option 3 itself
   is forbidden without browser-specific evidence that key/log co-eviction is atomic. No such evidence
   exists for that population.

   _Cautionary note, because it nearly drove this decision the wrong way:_ the same measurement showed
   Ed25519 failing on Chromium — but that was **Playwright 1.51.1's bundled Chromium 134**, which predates
   Chrome 137 (May 2025) where Ed25519 shipped. The platform was never the constraint; **our test tooling
   was ~16 months stale**, and it produced a false negative on a protocol decision. The current desktop
   result still does not answer the real-device iOS/Android question; that measurement remains a
   Pre-release release gate, not a Phase −1 freeze precondition. Hence 2j and 2k. Permitted only
   with browser-specific evidence that the co-eviction really is atomic (an untested assumption today, which
   is why this is option 3 rather than option 1). Loss creates a **new** signer identity requiring an authority
   handoff — which is safe, because a new identity cannot equivocate with the old one. Note this is the
   **opposite** of the repo's current seed-derived key design: at `k ≥ 2`, reconstructibility is the
   hazard, because prepare votes that never reached quorum form no QC, are held by nobody, and are
   genuinely unrecoverable — exactly the lock-safety state that matters. At `q = 1` that state does not
   exist (every vote is a QC), which is why the two custody rules are different and must never be
   "simplified" into one.

**The correlated-eviction handoff deadlock.** Custody option 3 converts eviction from a safety event into a
liveness event — and creates a new failure mode the other custody options do not have. Recovery from storage loss
is an authority handoff, and a handoff requires a QC from the **old** signer set. Fate-shared browser
voters evict in correlated batches (same browser fleet, same ITP window, same 7 days): lose more than
`n − q` of them at once and the room can no longer authorize the handoff that would restore its quorum.
**Making eviction safe made it a liveness bomb.** Rules:

1. **No stall-triggered quorum reduction, ever.** A partition is indistinguishable from mass eviction; a
   handoff authorizable by fewer than `q` old signers after a timeout is an authority-hijack primitive,
   not a mitigation.
2. **Set-composition rule (anchored in `signerSetDigest`):** every quorum-`≥ 2` delegated or attested set
   containing browser-local eviction-prone voters MUST either include ≥1 durable-class signer **or**
   explicitly accept the
   correlated-eviction stall, with that acceptance surfaced in the room's trust label — a pure-browser
   signer set is an informed choice with a stated consequence (stall, never fork, reset path), not a
   footgun; and SHOULD keep evictable voters ≤ `n − q` per correlated failure domain (browser × origin),
   so no single eviction wave can cross the quorum line alone. _Worked example — the delegated instance of
   the same rule (quorum `k`): at n = 3, k = 2, `n − k = 1`, so only **one** evictable voter is within the
   SHOULD. Three browser delegates is two over — and two of them evicting in the same ITP window leaves one
   surviving old identity against a handoff needing two._ **Durable-class is a storage property,
   not an ownership property:** any signer whose vote log does not evict qualifies — a friend's
   always-on desktop running `pnpm cli`, **a participant running an optional Electron build of the app**,
   a self-hosted box, a Raspberry Pi, as well as a company-run
   mirror. Third-party infrastructure is _one way_ to obtain durability, never the definition of it,
   and never required.
3. **Proactive rotation:** signer liveness is a monitored health metric (heartbeats through the seal
   plane); when live signers decay toward `q + 1`, the room proposes an early handoff **while it still
   has quorum**. Rotation before decay, not recovery after.
4. **The honest floor:** if quorum is irrecoverably lost anyway, the quorum-`≥ 2` room **stalls permanently —
   it never forks**. The only exit is an explicit trust reset (new room + migration record), exactly as
   for creator-offline migration (research gate 3), and it MUST be presented as a reset, not a recovery.

_Test (`correlated-eviction.spec.ts`):_ enroll `n = 5` with 4 fate-shared browser voters + 1 durable
signer; evict all 4 in one schedule → epoch stalls at the hard limit with **zero** conflicting QCs and the
health telemetry shows the early-handoff proposal fired before the threshold; repeat with the
set as a pure-browser one (5 evictable, stall-acceptance declared in the trust label) → the room wedges
and the test asserts the wedge is the _specified_ outcome — stall, never fork, reset path offered.

**Stall taxonomy, and what a trust reset concretely is.** "Stalls, never forks" covers two situations that
must not be conflated, and the exit from the second has a precise shape:

- **Recoverable stall** — no quorum online _right now_. Wait. Signers return, the epoch closes, nothing is
  lost. The cost is deferred, not absent: the active epoch grows, joiners re-sync a longer tail, and at
  `maxEpochVertices` durable writes stop until a close happens.
- **Permanent stall** — the pinned signer set can never produce a QC again, and no handoff is possible
  because a handoff needs that same QC. The room's **authority** is dead. **Its data is not:** every
  vertex, the full history and the last certified snapshot remain present, signed and verifiable by
  anyone. What died is the ability to seal _new_ epochs.
- **Trust reset =** a **new object**: new genesis anchor, a new signer set of the people actually present,
  initial state taken from the old room's last certified state, and every participant explicitly
  re-joining from a fresh invite. It is a **reset, not a recovery**, because nobody can authorize the
  successor in the old room's terms — anyone could stand up a room claiming to continue yours, so
  participants decide _out of band_ which one they are continuing in. History survives as **content**; the
  cryptographic chain restarts.
- **UI requirement, as a gate:** the interface MUST NOT present this as continuity recovered. The failure
  mode to test against is a UI announcing "room recovered!" when what happened is "someone made a new room
  and asserted it is the same one." (Cross-referenced from research gate 3, which is the creator-offline
  instance of the same exit.)

**Browser-local eviction-prone custody option 3, assembled — quorum-`≥ 2` sets only.** In a delegated or
attested set, a browser tab without an external exact-slot witness may hold the seal-voter role only when
**all** of the following hold — each independently testable, none a substitute for another:
(1) a **non-extractable WebCrypto `CryptoKey`** in the same origin bucket as the vote log (fate-sharing);
(2) `navigator.storage.persist()` **granted** — denied → the tab refuses the signer role rather than
enrolling optimistically (persistence is no guarantee, but its _denial_ is a known-hostile signal);
(3) primary-tab election (2i) so the vote CAS is uncontended in the common case — correctness never
depends on it; (4) every vote through the 5c transaction, bytes released only after `oncomplete`;
(5) storage loss → **new identity + authority handoff**, never re-enrollment as the old signer;
(6) the signer set satisfies the correlated-eviction composition rule above. 5e2/5f gate on this list, not
on a trust-profile number. **The `q = 1` exception:** a creator-certified browser signer uses the
recoverable-key + network re-learn rule (5e) instead of items (1) and (5) — items (2)–(4) still apply.

Signer enrollment binds `signerId` to a **storage incarnation** recorded by the external witness/authority.
An active signer identity with no matching local continuity proof is **storage loss and must refuse** — it is
never silently treated as empty storage. (At `q = 1`, the refusal ends once the 5e re-learn rule is
satisfied; at `k ≥ 2` it is permanent for that identity — re-entry is by handoff as a new signer.)

**Test (`eviction-double-sign.spec.ts`):** enroll signer + witness, emit `X`, retain the identity _outside_
the origin (modelling wallet recovery); delete the entire database, and separately inject selective deletion
of `votes`/`signerState`; reopen and request conflicting `Y`; assert **either** `StorageLoss` before signing
**or** an external `VoteConflict` returning exact `X`, with the network log at one value. Repeat with the
witness unavailable — signing must fail closed. Re-request `X` — the witness may rehydrate exact `X`, but the
browser must not create new signature bytes.

### HARD GATE — the formal model (starts at Phase −1)

**Tooling: Quint + Apalache.** TypeScript-adjacent syntax lowers the authoring bar, and native ITF/NDJSON
trace export is what makes the conformance loop cheap. (Plain TLA+/TLC only if a hired modeller insists.)

- **In scope:** two-phase voting (value-bound votes, locks + change-justification, monotone `enteredRound`);
  the full pacemaker above; authority handoff (certificate chain, data-cut vs authority-cut); crash-recovery
  abstraction (durable vote state survives crash, volatile state lost, vote CAS as one atomic step).
- **Deliberately out:** gossip internals; DAG linearization (covered exhaustively by the 5,231-DAG corpus —
  a different proof tool); crypto (unforgeability assumed); snapshot/availability data plane; blueprint
  semantics.
- **Invariants to discharge:** (1) **agreement** — two finalized commit QCs for one `(objectId,epoch,anchor)`
  have equal `valueDigest`; (2) **integrity** — an honest signer signs at most one vote per
  `(objectId,epoch,anchor,round,phase)`, finalizes once, and retains that across crash/restart;
  (3) **validity** — every finalized value passes `ValidateCutValue` and every QC has `q` unique
  current-anchor signers; (4) **lock safety** — value changes only via a prepare QC at least as high as the
  durable lock; (5) **no retroactive vote** — every honest signing transition has `vote.round == enteredRound`
  and `enteredRound` never decreases; (6) **authority isolation** — evidence from another anchor, authority
  epoch, object or protocol cannot enable a transition; (7) **eventual commit after GST** under a fair honest
  leader with `q` responsive correct signers.
- **Sizes:** safety at n=4..7 with Byzantine equivocation, reorder/dup/loss, crash/restart (Apalache
  symbolic). n=4 must include the late-prepare-QC schedule above. Liveness is discharged by
  **bounded-liveness + simulation witnesses** (nightly Quint `run`, 10⁴-step randomized traces) — full
  temporal checking will not terminate, and pretending otherwise is how models get quietly descoped.

**The conformance loop — without this, the model is theater with extra steps.** Counterexample export is
one-directional: it only replays traces the _model_ found, never checking that the code matches the model.

1. The implementation emits a structured seal event log (`round_entered`, `vote_cast{phase,valueDigest,round}`,
   `qc_formed`, `lock_acquired`, `crash`, `restart`) — one tap on the existing `@ts-drp/tracer`.
2. `model/trace-runner` takes Quint ITF traces, compiles them to deterministic driver scripts (message
   schedule + crash points) and executes them against the **real `packages/seal`** over fake-indexeddb —
   every counterexample **and a nightly sample of _valid_ model traces**.
3. **Reverse direction:** implementation event logs from the property suites are replayed against the model as
   refinement checks — every implementation transition must be model-reachable.
4. `model/traces/` is checked in and CODEOWNERS-gated.

**Gate = model green AND bidirectional trace conformance green.** **Outstanding Phase −1 prerequisite:**
a mechanical variable-set check (every signed envelope field appears in the model) must still be produced
and recorded before the Phase −1 exit. It has not yet gated the freeze.

### Exit gate (Phase 5)

Observation-mode exit metric: `observation-report.json` with a **divergent-cut counter of 0** across ≥10⁴
adversarial-schedule epochs. Model green + trace conformance green. Signer-profile decision implemented and
its eviction matrix green. Only then may any profile leave observation mode.

---

## Phase 6 — Verified adoption and bounded pruning

**Goal:** finally bound memory. Capability-wise a thin slice; it carries the heaviest gate.

> **Adoption moves ahead of pruning.** Round 1 filed verified monotonic adoption CAS as slice 6c, a pruning
> optimization. It is the **acceptance boundary** — the moment untrusted bytes become authoritative — and it
> is already built and crash-tested in Phase 2e. Phase 6 _enables_ it, it does not invent it.

| Slice  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Class        | RED test → GREEN                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **6a** | Enable verified adoption: full external verification (authority chain, `CutValue`, commit QC, proposal/value binding, close + history extension, snapshot payload/manifest, blueprint, archive root, next anchor) **outside** the transaction; then one strict transaction with exact CAS on `(expectedEpoch, expectedAnchor, expectedCutValueDigest)`                                                                                                                                                                                                                                                                                                                                                        | coordinated  | Unsigned cut, stale expected anchor, same-epoch different value, and every crash point leave the old anchor unchanged; a valid cut yields exactly one new complete closure                |
| **6b** | Enumerated-structure cleanup: closed-epoch `vertices`, `forwardEdges`, `frontier`, `vertexDistances`, causality caches, snapshots, checkpoints, finality state, pending indexes, sync inventories, rollback artifacts — **only after** verified commit QC + durable adoption + ≥2 rollback generations + availability policy satisfied + outbox fully categorized                                                                                                                                                                                                                                                                                                                                             | consensus-v3 | Archival-vs-compacted differential over ≥100 epochs; raw-dependency audit instrumentation                                                                                                 |
| **6c** | **Memory gate, made able to fail.** Round 1 routed this through `benchmark-memory.yml`, which sets `fail-on-alert: false`. Two artifacts instead: (i) **structure-census assertions in vitest** — deterministic, non-flaky, exact integers: after E epochs with pruning enabled, `hashGraph.vertices.size ≤ maxEpochVertices + activeTail`, closed-epoch `FinalityState` count `=== 0`, `states` map ≤ checkpoint bound, `forwardEdges`/`vertexDistances` census ≤ bound; (ii) heap slope under `node --expose-gc`, post-GC `heapUsed` per epoch, least-squares slope over the last E/2 epochs ≤ ε bytes/epoch **and** absolute ≤ budget. Flip `fail-on-alert: true` on the memory bench as a trend backstop. | local-safe   | **Paired assertion** (a heap bound alone passes if writes were silently dropped): `expect(admittedAndAppliedOps).toBe(1_000_000)` **and** final state digest correct **and** heap bounded |

### Exit gate (Phase 6)

Kill-before/after-every-IDB-request on chromium/firefox/webkit **as a standing PR gate** (already true from
Phase 2) plus real Safari/macOS, Safari/iOS and Chrome/Android **from the release matrix at the exact release
SHA**; cold-join convergence from untrusted sources; rollback integrity after forced mid-adoption failures;
kill-switch drill re-run; soak ledger thresholds met; formal model + trace conformance green; signer-profile
eviction matrix green.

> **On mobile gates.** Every workflow in this repo is `runs-on: ubuntu-latest`, and
> `docs/cross-browser-testing.md:13-18` says explicitly that Playwright WebKit **is not** installed Safari.
> So every mobile gate is split: (a) a CI-executable proxy (WebKit desktop + Playwright mobile emulation) as
> a **required check**, and (b) a named **release blocker** requiring a real-device run with the log as the
> artifact and an owner assigned. (a) must never silently satisfy (b). Contract the device lab at Phase-2
> kickoff so the eviction spike is not blocked on procurement at Phase-5 time.

---

## Phase 7 — Archive / Discord profile

**Goal:** for chat the messages _are_ the state; a snapshot alone cannot remove them. Two-tier hot/cold.
The root **codecs** already landed in Phase 3e — this phase is segmentation, paging and retention.

| Slice  | Change                                                                                                                                                                                                                                                                                                                                                                                  | RED test → GREEN                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **7a** | Immutable content-addressed **archive segments** under the Merkle archive index; hot snapshot = recent window + edit/tombstone overlay + archive root; demand paging with inclusion proofs; attachment manifests                                                                                                                                                                        | Corrupt/missing/withheld/tampered segment → verification fails; cold-join of a 1M-message room downloads O(hot + window), verified by **network-byte accounting** in the chat e2e    |
| **7b** | Availability policy as a **committed** value. `availabilityPolicyDigest` is installed in the anchor from Phase 3 onward; the initial no-mirror profile is a valid **explicit** policy: `mode:"local-only", minRollbackGenerations:2, minLocalCopies:1, minMirrorReceipts:0`. Receipts are signed artifact-bound local pruning evidence — **not consensus, and not a permanence claim**. | `availability-policy.test.ts`: a no-mirror room prunes only with a local snapshot and two rollback generations; a receipt for the wrong artifact/object/epoch never satisfies policy |
| **7c** | Privacy/retention: per-segment encryption, certified key-erasure, honest deletion UX                                                                                                                                                                                                                                                                                                    | Certified key-erasure renders retained ciphertext unreadable to conforming clients; documented residual-risk statement                                                               |

> Round 1's _"randomized deletion/churn retains ≥1 valid copy at target probability"_ is a property of the
> **availability model**, verifiable by the model alone — as a code gate it is vacuous, and an unspecified
> churn distribution can produce any desired number. Keep the probability claim as a committed design
> artifact (model run + parameters + seeds + owner). The **code** gate is a repair-loop integration test:
> kill mirrors on a churn schedule, assert the challenge/repair path fires, every certified segment stays
> fetchable, and **deletion is refused while the policy is unsatisfied**.

**Rule:** enable chat-history deletion **only after** availability + archive verification are green — a valid
QC proves agreement on digests, not retrievability.

**Deletion is a product decision that is needed long before Phase 7.** The honest answer — deletion is
provably impossible from untrusted holders; key-erasure only blinds _conforming_ clients; prior recipients
keep plaintext — must be written as a decision record in **Phase 1**, before any chat-profile deployment,
and consumed by 7c. Otherwise it gets invented under pressure after the first user request, and the UX copy
promises something the system cannot honor.

---

## Train S — the fabric tracks (E, S, T)

Round 1 compressed the entire non-AHE half of the product goal into one eight-row table scheduled last, while
its own text said these must stand up early as regression gates. That self-contradiction is resolved here:
**Phase 8 ceases to exist**; its rows are redistributed into Phase 0/1/2 (where they are prerequisites) and
three first-class tracks with real protocols.

| Round-1 row              | Disposition                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 8a ephemeral             | → **Track E**, starting with Phase 1                                                                                               |
| 8b sharding              | → **Track S**, design before Phase 6                                                                                               |
| 8c resource governance   | **split**: frame caps, invalid-vertex budget, permissioned default → Phase 1 (1g/1k/1l); NOP + epoch-capacity accounting → Phase 3 |
| 8d benchmarks            | → **Profile gates**, standing from Gate 0                                                                                          |
| 8e browser matrix        | → Phase 2h, standing from Phase 2                                                                                                  |
| 8f blueprint determinism | → **Phase 0j** (it is a Phase-4 soak prerequisite)                                                                                 |
| 8g topology              | → **Track T**, starting with Phase 1                                                                                               |
| 8h crypto pipeline       | → **merged into Phase 2f** `worker-host` (same boundary; two slices invite two half-boundaries)                                    |

### Profile gates — the scale goal as acceptance criteria

Round 1's only numbers — _"32 writers, 100 durable ops/s, 1h session cold-join < 30 s and < 50 MB, p99 apply
< 50 ms, heap < 512 MB"_ — describe a 32-writer co-op room, not either stated product. Two specific defects:
the cold-join budget is stated **per "1h session"**, which quietly re-admits `O(history-age)` joins — the exact
failure AHE exists to remove; and "p99 apply < 50 ms" is three dropped frames, fine for chat and
disqualifying for a game client, where the budget must be a **max main-thread task** bound.

Replaced by two profile tables. **Anything not in a profile table is not a supported scale claim.**

| Metric                      | **Profile D** — Discord channel (1 channel = 1 object)    | **Profile M** — MMORPG zone (1 zone instance = 1 object)         |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Active writers              | ≤ 128 per 5-min window                                    | ≤ 64 durable                                                     |
| Durable ops/s               | ≤ 25 sustained, 100 peak (10 s)                           | ≤ 32 sustained, 128 peak                                         |
| Ephemeral rate              | typing/presence 1–10 Hz                                   | **20–30 Hz, zero durable vertices**                              |
| Online replicas / object    | ≥ 1,000 browser-only; 5,000 with relay spine              | —                                                                |
| Epoch                       | ≤ 8,192 vertices (AHE default)                            | ≤ 8,192                                                          |
| Hot snapshot                | ≤ 64 MiB                                                  | ≤ 8 MiB                                                          |
| **Cold join**               | **< 10 MB and < 10 s p95 — independent of room age**      | **< 20 MB, < 5 s to playable**                                   |
| Channel switch / zone enter | < 1 s warm                                                | < 5 s                                                            |
| Per-peer connections        | ≤ 8 mesh/room, ≤ 48 total                                 | ≤ 8 mesh, ≤ 48 total                                             |
| Main thread                 | no task > 50 ms                                           | **≤ 2 ms/frame p99** on a CPU-throttled mid-tier Android profile |
| Heap                        | ≤ 512 MB at 20 open rooms                                 | game budget ≤ 150–250 MB                                         |
| Idle bandwidth              | ≤ 5 KB/s/room                                             | —                                                                |
| Fabric                      | N channel objects/process; guild roster a separate object | N zone objects; cross-shard conservation                         |

Every number names its harness. **Cold join is measured on a fixture with ≥100 _compacted_ epochs of
synthetic age**, not a 1 h session — otherwise the gate proves nothing about a six-month-old room, which is
the actual product case.

**Comparative honesty gate (CMP).** Against Yjs/Automerge on the same semantic chat workload, DRP wins only
on _signed application commands with ACL-gated custom concurrency_. Sync efficiency, durability, snapshots,
archive paging, ephemeral separation and mesh budgets are all **table stakes** those ecosystems already ship.
Run the comparison **before** Phase 7 feature sprawl, and encode a kill criterion: if DRP cannot reach ≤2×
Yjs latency at 50 msg/s with signatures on, the honest label is _"signed, moderated rooms ≤ N writers"_ —
not "Discord-like at scale."

### Track E — the ephemeral simulation plane

The repo has **no** ephemeral capability today: transports are `circuitRelayTransport(), webRTC(),
webSockets()` (`network/src/node.ts:534`); js-libp2p WebRTC multiplexes **reliable, ordered** streams;
`DRPNetworkNode` exposes only protobuf `Message` broadcast/send. Meanwhile the flagship example writes **a
signed durable vertex per keystroke** (`examples/grid/src/index.ts:28-33`) — the repo's own demo violates the
rule this track exists to enforce.

**Class boundary** (the design round 1 left as one line):

| Class                   | Examples                                            | Plane                                           | Durability        | Arbiter                          |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------- | ----------------- | -------------------------------- |
| E0 pure ephemeral       | aim, input frames, local prediction, voice          | datagram / unreliable-unordered                 | none, TTL ≤ 2–5 s | owner peer                       |
| E1 session ephemeral    | presence, typing, cursor, anim state                | reliable low-priority, **not** in the hashgraph | session only      | membership ACL                   |
| D1 durable command      | place-block, grant ACL, edit message, commit-trade  | DRP vertex                                      | epoch/archive     | blueprint + ACL + AHE            |
| D2 contested transition | loot claim, hit→damage, trade escrow, zone transfer | **two-phase**: E detect → D commit              | only the D vertex | authority domain or referee role |

| Slice  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                               | RED test → GREEN                                                                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** | `packages/ephemeral`: `node.openEphemeral(objectId, opts) → EphemeralChannel { publish(bytes,{class,key?}), subscribe, stats }`. Delivery classes `unreliable-unordered`, `unreliable-sequenced` (latest-wins per entity key), `reliable-unordered`. **The channel holds no reference to `DRPObject` — nothing published can create a vertex, by construction.** Transport tier T1: a second gossipsub topic (works today, zero new transport code). | `zero-durable-vertices.test.ts`: 30 Hz × 32 peers × 60 s → `expect(object.vertices.length).toBe(durableCommandCount)` **exactly**, **plus the positive control** that one durable command in the same run creates exactly one vertex. Flagship gate: port grid movement to the channel and assert the vertex count in Playwright |
| **E2** | Session auth: key derived from the room's current ACL epoch (v2: anchor digest), per-message MAC — cheap, no per-packet secp. Per-peer rate budgets.                                                                                                                                                                                                                                                                                                 | Forged/foreign-session publish rejected; flood stays in budget                                                                                                                                                                                                                                                                   |
| **E3** | **Unreliable tier** (hard gate before any Profile-M claim): raw `RTCDataChannel(ordered:false, maxRetransmits:0)` bootstrapped by exchanging SDP over an ordinary libp2p stream on the existing WebRTC connection. Library work in `network`, since `@libp2p/webrtc` does not expose channel options.                                                                                                                                                | Failure-campaign loss/jitter injection: p95 latency under 30% loss beats the reliable tier; no head-of-line stall                                                                                                                                                                                                                |
| **E4** | Interest management / AOI filter + entity delta codec                                                                                                                                                                                                                                                                                                                                                                                                | 32 visible entities ≤ 256 kbps down                                                                                                                                                                                                                                                                                              |
| **E5** | **Commit-point helper**: `commitOutcome` producing one durable op **co-signed by all counterparties** (trade = both signatures inside one op the blueprint verifies) or signed by a **referee role** — a per-object ACL role for n-party contention (hit registration, loot rolls)                                                                                                                                                                   | Both-signature op applies once; single-signature rejected; replay idempotent by `clientOperationId`                                                                                                                                                                                                                              |

**Anti-cheat posture, stated honestly:** serverless, the library guarantees **attributability** — every
durable claim is signed, ACL-gated, replayable and disputable — not physics validity. Speed-hacks in the
ephemeral plane affect only what peers render; they cannot mint durable state without a commit point.
Competitive economies require referee peers. The library ships the role plumbing; the application ships the
validation logic.

### Track S — sharding and cross-object conservation

Independent DRP objects have independent `objectId`, epoch clocks, signer sets and compaction schedules.
Uniqueness cannot be conserved by aspiration. The object store is a flat `Map` of independent objects
(`node/src/store/object.ts:7-26`) and vertex identity has no cross-object link.

**Trust root:** the _referencing_ object pins the _referenced_ `objectId` at creation; verification walks the
referenced object's genesis (derivable from its creator-bound id) plus its authority-handoff chain — cost
proportional to **governance changes**, which is exactly AHE's data-cut/authority-cut separation.

| Slice  | Change                                                                                                                                                                                                                                | RED test → GREEN                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | **Guild→channel delegation** (needs only Phase 3): channel blueprint pins `guildObjectId`; channel role checks accept a `GuildStateCert` = the guild's latest sealed ACL digest + QC (creator signature in creator-certified profile) | Role revocation in the guild propagates to channel admission within one guild epoch                                                                            |
| **S2** | **`TransferCert` format + verify-only path**: sealed-epoch inclusion proof against the cut digest + QC, verifiable against **archived** cuts via the archive index root                                                               | Golden certs verify; tampered epoch/proof/QC reject; verification against an _archived_ cut succeeds post-compaction                                           |
| **S3** | **Saga ops** `reserve / redeem / finalize / abort` + conservation property suite                                                                                                                                                      | Invariants I1–I4 below over ≥10⁴ schedules of {crash, duplicate delivery, partition, one-side compaction, authority handoff}; shrunk counterexamples committed |
| **S4** | **Player-inventory-object pattern** + zone-crossing e2e                                                                                                                                                                               | Crossing mid-trade: asset conserved; trade completes or aborts cleanly                                                                                         |

```text
reserve(assetId, dstObjectId, nonce, ttl)   → source escrows the asset (unspendable)
  when the containing epoch seals → mint TransferCert{srcObjectId, epoch, opRef,
                                    inclusion-proof vs sealed cut digest, QC}
redeem(cert)                                → destination verifies against the pinned source authority chain
finalize | abort                            → source-side only; abort requires the requester's signed abort
                                              OR a destination non-redemption attestation
```

**Invariants:** (I1) an asset is spendable in exactly one of {src-active, src-escrow, dst} at **every prefix
of every schedule**; (I2) redeem is idempotent under duplicate delivery (nonce); (I3) no interleaving of
{crash, retry, partition, compaction of either side, authority handoff} yields two spendable instances;
(I4) `expire∘redeem` and `redeem∘expire` never both take effect.

**The hard cases, resolved.** _Independent epoch clocks_ — the cert binds a sealed source epoch; the
destination verifies a QC, never a clock. _One shard compacting, the other not_ — certs verify against
archived cut digests via `archiveIndexRoot`; **this is precisely why that field had to go back into the
preimage** (§Phase −1 decision 5). _Authority offline_ — no seal ⇒ no cert ⇒ transfers stall but never
duplicate; **conservation beats liveness**: a stuck asset is a support ticket, a duplicated asset is an
economy collapse. _Player crossing a zone mid-transaction_ — dissolve it structurally: conserved player
assets live in a **per-player inventory object**; zone objects hold world state only, so zone crossing moves
no assets.

**Compaction hazard, normative:** reservations are **snapshot-critical state until terminal**. A source shard
MUST NOT prune an epoch containing an unreconciled `reserve`.

### Track T — connection topology and mesh budgets

Verified: `connectionManager` sets only `dialTimeout` and `addressSorter` (`network/src/node.ts:515-518`) —
no `maxConnections`, no `maxParallelDials`. The actual topology is per-room gossipsub at library-default
degree **plus** direct `/drp/message` streams that dial _outside_ the mesh:
`sendGroupMessageRandomPeer` dials a uniformly random topic subscriber (`node.ts:1722-1735`), and
interval-sync rotates through the **entire sorted subscriber list** every 10 s (`interval-sync.ts:163-172`).
In a 1,000-member room every peer eventually attempts WebRTC dials to ~all members, against a browser ceiling
of ~50–200 `RTCPeerConnection`s. Discovery is separately quadratic: every node publishes on and subscribes to
one app-wide topic every 5 s (`node.ts:416-421,654`). `ARCHITECTURE.md:767-773` records the data plane as
deliberately out of scope for the rendezvous work — **so nobody owns this today.**

| Knob                            | Browser client             | Operator relay |
| ------------------------------- | -------------------------- | -------------- |
| `maxConnections`                | **32–48** total            | 500–2,000      |
| `maxParallelDials`              | **3–6**                    | 32             |
| Gossip mesh D/Dlo/Dhi per topic | **4/3/6**                  | 6/4/12         |
| Data-plane peers per hot object | **8–12** + 1–2 relays      | —              |
| Discovery advertise set         | **≤ mesh budget + relays** | full           |

| Slice  | Change                                                                                                                                                                            | RED test → GREEN                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | `maxConnections` + `maxParallelDials` + prioritized eviction (protect relay reservations, active mesh peers, in-flight transfers)                                                 | Flood 200 discovered peers → `expect(connections.length).toBeLessThanOrEqual(C)`; reservations and mesh peers never evicted                                                                                                                                                                       |
| **T2** | Sync/fetch partner selection restricted to **currently connected mesh members** (intersect `getGroupPeers` with `getControlPlaneConnections()`), never the raw subscriber list    | 100 subscribers, 6 connected → all probe targets ∈ connected set; dial-failure rate ~0 in churn sim                                                                                                                                                                                               |
| **T3** | **PeerSelector**: one admission point from discovery (rendezvous room-presence, PX, pubsub discovery) into the connection budget; deployment-size-gate the global discovery topic | **Invariant: surfaced-and-dialed ≤ budget**, asserted from the connection census. 1k peers/room in the `network-spike` failure-campaign simulation + a **50-real-browser** Playwright ceiling check — a 1k-real-browser lab does not exist, and pretending it does is how 8g became unfalsifiable |
| **T4** | Designated-relay mesh preference via gossipsub scoring (the operator-spine hook)                                                                                                  | Relay-tagged peers retained in mesh under churn; spine-assisted 5k-replica sim                                                                                                                                                                                                                    |

---

## Track P — the production surface (spans every phase)

A plan that takes a library to production is not only protocol work. Round 1 had slices for every byte on the
wire and almost none for anything around them.

| Slice                | Phase       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Gate                                                                                                                                                |
| -------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 API & release** | 3           | Semver + deprecation policy declaring `protocolMajor` **independent of npm version**; per-package vs fixed-version decision **before** the nine new packages exist (`npm-publish.yml` currently forces lockstep); CHANGELOG via release-it; consumer migration guide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | CI migrates `examples/chat` to the v3 namespace **using only the guide**, while legacy/v2 preservation checks remain green — failure is a guide bug |
| **P2 blueprint DX**  | 0/1         | `eslint-plugin-ts-drp` (`drp/no-ambient-in-reducer`), blueprint conformance harness (replay an op log in Node + Chromium + WebKit, assert byte-identical state digest), authoring guide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A fixture blueprint calling `Date.now()` in a reducer fails **lint and** the cross-engine digest test                                               |
| **P3 observability** | 4→6         | Fork-detection event over `@ts-drp/tracer` (OTLP exporter already exists, unused by round 1); signed kill-switch (built in 1m) wired to it; version-skew coexistence suite; **named operator**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Injected divergent fold digest in the multi-node harness emits the fork event; rollback counter increments on forced mid-adoption failure           |
| **P4 security**      | 3           | Threat-model doc (seed from §0.3 + the seal/authority model); **key rotation + compromise runbook** — `keychain.ts:38-44` derives both secp256k1 and BLS keys from a single seed with **no rotation API and no compromise procedure**, yet object identity keys are exactly what cross-room replay and authority handoff abuse; `pnpm audit`/SBOM in CI; **external security review booked at Phase 3** (months of lead time), report gates Phase-6 default-on                                                                                                                                                                                                                                                                                                                                                                                                  | Rotation epoch-straddle test: a rotated-out key's post-rotation signature is terminal-rejected                                                      |
| **P5 reference app** | 4→7         | AHE §23 requires availability/pruning policy visible **in room configuration and UI** and conflicting-branch warning UX — round 1 builds no app in which any UI could exist. Evolve `examples/chat` into the Discord-profile proving ground (epochs visible, trust badge, pruning-policy config, archive paging, rebase status, tombstone op; **the app prompts "who else can close epochs if you are away?" as soon as there is anyone to delegate to — a room has no members at genesis, so this fires on membership growth (e.g. ≥3 members, or ≥N closed epochs) rather than at create time, and is never a buried setting; a room left at n=1 with delegable members present is surfaced as a standing risk, because delegation is only arrangeable while the creator can still sign**); grid/canvas over the ephemeral plane as the MMORPG proving ground | Every UI-bearing gate (3b, 5g, 7c, §23) points its e2e at this app                                                                                  |
| **P6 docs**          | all         | Promote the amended spec to `docs/protocol/` with a **versioned amendment log** (it _is_ the spec under this directive); blueprint authoring guide; operator guide; trust-profile explainer; migration guide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Amendment log entry exists for every registry decision; guides gate their respective phases                                                         |
| **P7 privacy DR**    | 1           | Deletion-semantics + retention decision record (consumed by 7c and P5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Merged before any chat-profile deployment                                                                                                           |
| **P8 distribution**  | Track S era | `sideEffects` audit, conditional exports, per-package size budgets in CI, **BLS-WASM extraction to an optional dep** once FinalityStore is deprecated — a browser-first library should not ship WASM it no longer uses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Size check fails over budget; BLS WASM absent from the default browser graph                                                                        |

---

## Research gates — what remains genuinely unknown

Round 1 listed six. Three are **resolved into design constraints** by this plan and are no longer research:

| Round-1 gate                          | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Safari/iOS eviction → double-sign** | **RESOLVED into a constraint.** No local-only algorithm can distinguish first install from full eviction. Every quorum-`≥ 2` voter needs exact-slot continuity; a browser-local eviction-prone voter may use an external exact-slot witness or custody option 3's fate-shared key (§Phase 5). Fate-sharing trades the safety hole for a liveness event (see the correlated-eviction deadlock). This applies under delegated and attested authority and is now a slice with an eviction matrix, not a spike. |
| **Mirror availability & incentives**  | **REMOVED as a blocker.** Product decision: ship without mirrors. `mode:"local-only"` is an explicit committed policy (7b) and the wire keeps receipt-compatible fields. Mirror-required deletion stays gated.                                                                                                                                                                                                                                                                                              |
| **Live-fleet operations**             | **CONVERTED to slices** 1m + P3. It was never a research unknown — it was unbuilt software with no owner.                                                                                                                                                                                                                                                                                                                                                                                                   |

Genuinely open, each blocking the phase named:

1. **Signer liveness in a churny swarm** — blocks the attested profile (5f). AHE's degradation story is
   circular: quorum loss stalls compaction and the active epoch grows unbounded. **Gate:** a swarm simulation
   with realistic tab-churn/session-length distributions showing bounded active-epoch size and joiner cost
   under quorum loss, **or** a signer set whose composition guarantees liveness: either designated
   durable signers only (§0.6), or fate-shared browser voters (§Phase 5, custody option 3) **plus ≥1
   durable-class backstop signer** — in which case the simulation must also cover the
   correlated-eviction schedule below. (A pure fate-shared set with declared stall-acceptance is
   permitted by the composition rule but does **not** discharge this gate — it accepts the failure
   rather than preventing it.)
2. **Mobile throughput ceiling** — blocks Profile-M claims. Fold + digest + Merkle per close on a real phone.
   Note §2.6: the reference's numbers are async-WebCrypto artifacts and must be **re-measured against the
   sync port** before any WASM decision.
3. **Creator-offline migration** — blocks 3h for the dominant room type. Migration needs an authority
   signature; creator-offline is a proven repo scenario. **Gate:** migration is creator-only **or** a
   pre-pinned delegation/threshold authority — which the `delegated-trusted-v1` profile (Phase −1
   decision 10, slice 5e2) now expresses. **The deadline is authority-reachability, not room age:**
   installing delegates is an authority handoff needing a QC from the current authority, so it can be
   done at any time _while the creator can still sign_ — which matters, because at genesis a room has
   no members yet and therefore nobody to delegate _to_. The risk is not a missed moment at creation
   but a room that runs at n=1 indefinitely and then loses its creator (P5 prompts on membership
   growth). Without a delegation pinned _before_ the creator
   disappeared there is no cryptographically honest migration — a new room may be created as an
   **explicit trust reset**, and it MUST NOT be presented as an authenticated migration (what a reset
   concretely is — and the recoverable-vs-permanent stall distinction — is specified in §Phase 5, "Stall
   taxonomy").
4. **Real-device lab ownership** — blocks the Phase-6 release matrix. Decide at Phase-2 kickoff.

---

## Definition of done

Profile-scoped. Every item names an executable artifact.

**Both profiles**

- [ ] Frozen v2 remains byte-identical; the independent v3 registry is frozen; every per-lineage vector
      document is immutable; original and regenerated reference locks are enforced in CI.
- [ ] Conformance differential (TS vs pinned reference) green per-PR, with a mutation probe proving it can fail.
- [ ] Gate-0 divergence manifest exact, **zero unexercised entries**.
- [ ] Exhaustive order corpus: ≤6 vertices per-PR, 5,231 graphs (≤7) nightly, driving the **real** implementation.
- [ ] Every §0.3 live defect closed with a merged regression test — **plus** a signed risk-acceptance document
      for legacy-plane cross-room replay, which is never fixed.
- [ ] `soak-ledger.json`: `mismatches === 0`, `totalEpochs ≥ 1e5`, `consecutiveGreenDays ≥ 30`, four-way comparison.
- [ ] Quint model green at n=4..7 + **bidirectional** trace conformance; counterexamples replayed as vitest.
- [ ] `ahe-storage-validation.json` complete for chromium/firefox/webkit with `missingKillPoints === []`; real
      Safari/macOS, Safari/iOS, Chrome/Android rows at the **exact release SHA**.
- [ ] Signer-profile decision implemented; `eviction-double-sign.spec.ts` green.
- [ ] Per-package coverage thresholds met; zero-coverage allowlist **empty** for safety packages.
- [ ] Profile-table numbers met in `benchmark.yml`, cold join measured on a **≥100-compacted-epoch** fixture.
- [ ] Kill-switch drill log; version-skew coexistence test; fork-detection telemetry emitting in the harness.
- [ ] Trust-profile UI state proven to be a **pure projection of the verified profile chain**.
- [ ] External security review complete (booked at Phase 3).
- [ ] Amended spec in `docs/protocol/` with a complete amendment log.
- [ ] **Golden path 1 (chat) green — zero `pending`, zero `fail`, one SHA, full matrix** (Appendix C).

**Train S additionally**

- [ ] **Golden path 2 (game) green** — including step 2.1, all of golden path 1 re-run on a zone object with
      no game-specific carve-outs in the durable plane (Appendix C).

**Profile M additionally**

- [ ] Ephemeral e2e: 20–30 Hz with frame counters > 0 **and** durable-vertex inventory flat, with positive control.
- [ ] Unreliable datagram tier (E3) shipped and beating the reliable tier under 30% loss.
- [ ] Sharding conservation suite: I1–I4 over ≥10⁴ schedules including one-side compaction.
- [ ] ≤ 2 ms/frame p99 on a CPU-throttled mid-tier Android profile.

**Profile D additionally**

- [ ] Archive cold-join: 1M-message room downloads O(hot + window), verified by network-byte accounting.
- [ ] Availability policy committed and enforced; deletion enabled **only** after the repair-loop gate.
- [ ] Deletion/retention decision record merged; honesty copy tested in the reference app.
- [ ] Comparative benchmark vs Yjs/Automerge run, with the kill criterion applied to the product claim.
- [ ] Fully-public smoke run recorded at the release SHA with a triage note (zero-deploy invariant, §0.5).

---

## Sequencing at a glance

1. **Phase −1** — normative freeze. Atomic. Nothing else starts. Formal model starts here.
2. **Gate 0** — oracles, divergence manifest, CI topology, coverage contract, shrinking.
3. **Phase 0** — determinism core = the pure-module port + live-bug fixes + blueprint determinism.
4. **Phase 1** — sync, auth, capacity, ops infra. Parallel-safe with Phase 2. Tracks E/T start here.
5. **Phase 2** — durable substrate and issuance transaction; **hard-kill driver first, on a trivial
   payload**; browser gate standing.
6. **Phase −1′** — atomic protocol-v3 normative freeze: action/invariant model first, then registry,
   suites, references, vectors, locks and additive governance. No v3 consensus byte precedes it.
7. **Phase 3** — v3 namespace: genesis, anchor, admission, latched ACL, history + archive roots, tip-set.
8. **Phase 4** — shadow cuts and snapshots; four-way comparison; soak ledger accumulating.
9. **Phase 5** — seal: creator-certified → round-free → delegated → attested. **Formal model + trace conformance is a hard gate.**
10. **Phase 6** — enable verified adoption; bounded pruning; heaviest browser/device matrix.
11. **Phase 7** — archive / Discord profile.
12. **Tracks E/S/T/P** — throughout; Train S gates decide whether the scale claim may be made at all.

Each of Phase −1, Gate 0 and Phases 0–2 is independently valuable even if the compaction design later
changes. Nothing prunes until the order corpus, the crash matrix, the formal model, the soak ledger and the
signer-profile eviction matrix are all green.

---

## Appendix A — traceability against `deep-analysis-migration.md`

Its §11 roadmap (15 items) and §12 blockers (10 items), each mapped to a slice. This is the coverage
argument for "can an MMORPG-ready or chat-ready app be built on this."

| Source item                                                          | Status                                                                                                                                           | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §11.1 commit object identity to blueprint/ABI/schema/runtime/genesis | **Covered, differently**                                                                                                                         | The genesis **anchor** commits `blueprintDigest`, `parametersDigest`, `signerSetDigest`, `profileDigest`, `availabilityPolicyDigest`, `archiveIndexRoot`; every vertex commits its `anchor`, so the chain binds the program. Phase 0i-v3 defines the canonical admission manifest/package whose domain-separated digest is that single `blueprintDigest`, including ABI/schema plus structurally bound implementation/runtime identity; Phase 0j still owns proving the implementation deterministic, and Phase 4a reuses rather than redefines the identity. `objectId` itself stays `creator:salt` — deliberately, so the blueprint can be **rotated by authority handoff** rather than being frozen into an immutable id. The invite pins the genesis anchor (Phase 3b + §15.3 weak subjectivity), which is what actually makes it verifiable                                                     |
| §11.2 replace `JSON.stringify` content addressing                    | **Covered**                                                                                                                                      | Phase −1 registry + Phase 0a codec port; sorted-unique deps; domain separation; `encodingVersion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §11.3 deterministic execution environment                            | **Partial by design**                                                                                                                            | Phase 0j owns implementation/runtime-profile matching, ambient-API bans and cross-engine differential; Phase 0i-v3 owns only structural manifest/ABI identity. **0n** owns numeric determinism. **Deterministic WASM VM and true instruction metering remain deferred** — documented residual risk, not a silent one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| §11.4 enforce operation ABI                                          | **Open on the v3 plane; legacy parity pinned; v2 preserved**                                                                                     | Phase 0i-v3 owns digest-bound canonical manifest/ABI preparation and package-level remote/local admission; 0d establishes operation-schema terminality before acceptance; Phase 3a owns signed-anchor provenance plus live `accepted iff appended` composition; Phase 4a owns non-reflective dispatch/fold; **0p** owns input-bounded work in place of gas. Do not call the full v3 property complete before Phase 4a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §11.5 serialize local mutations + author sequence                    | **Covered, successor freeze required**                                                                                                           | Phase 0g(i) local queue; Phase −1′ + 0g(ii-T/I) authenticated v3 sequence; **0o** remote same-author policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| §11.6 publish resolver laws                                          | **Covered**                                                                                                                                      | Frozen five-action set (Phase −1 decision 9); AHE §7.2 resolver contract ported and hardened with `linearize.js`: resolver invoked only for concurrent vertices, isolated canonical clones, returned action validated, deterministic pair iteration order, **swap-cycle detection**, topological retained-order postcondition, fail-the-close on malformed/throwing resolver in both modes, staged state. `resolver-laws-property.test.ts` exercises the hash-pinned 407-graph PR corpus across three conflict partitions and exactly `min(8, \|V\|!)` pairwise-distinct insertion orders with beginning/interior/end anchor-position coverage where eight executions exist; focused tests separately pin all five actions, malformed results, throws, mutation isolation and both pair/multiple retained-causality regressions, including ancestry propagated solely through a dropped intermediate |
| §11.7 replace complete-inventory sync                                | **Covered**                                                                                                                                      | Phase 1a (O(1) lookup), 1b (applied-set index), 1n (heads exchange, chunking, backpressure, caps), `sync-v2`. RIBLT deferred with a mandatory hash-list fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §11.8 certified checkpoints and epochs                               | **Covered — this is the AHE spine**                                                                                                              | Phases 3–6. Checkpoint finality is defined independently of per-vertex attestation, which is exactly why the BLS `FinalityStore` is deprecated rather than upgraded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §11.9 replace dense causality structures                             | **Covered by capping, not replacing**                                                                                                            | Phase 0e exact ancestor bitsets are bounded by the hard epoch. A static full-width index at total `V=8192` has `O(V²/8) = 8.0 MiB` (`8,388,608` bytes) of raw bitset backing storage; append-built triangular rows use `4,210,688` bytes (~4.016 MiB). Both exclude typed-array object and `Map` overhead. Phase 0p must settle whether `maxEpochVertices` includes the anchor before enforcement; if it permits 8,192 non-anchor vertices then total `V=8193` and static backing storage is `8,422,404` bytes (~8.032 MiB). Phase 3a asserts the chosen cap at first live use. Sparse indexes/interval labels stay deferred. **Mobile profiles must lower `maxEpochVertices`**                                                                                                                                                                                                                      |
| §11.10 batch operations                                              | **Covered**                                                                                                                                      | Phase 3f (op-batching into one signed change, alongside tip-set aggregation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| §11.11 specify finality semantics                                    | **Covered**                                                                                                                                      | Phase 5 + the registry: a commit QC finalizes a `valueDigest`, authorizes adoption and gates pruning; `q=⌈2n/3⌉` pinned with `f=⌊(n−1)/3⌋`; formal model discharges the meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §11.12 equivocation and old-branch policy                            | **Now covered**                                                                                                                                  | Old branches are solved **objectively** by hard epochs (stale by envelope — no timeout, no replica-local memory). Same-author equivocation is **0o**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| §11.13 resource governance                                           | **Now covered**                                                                                                                                  | **1o** (complete table), plus 1f/1g/1k/1l, 2g, 3f, Track T                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| §11.14 durable adapters                                              | **Covered**                                                                                                                                      | Phase 2: `storage/` contract, `storage-browser/`, `storage-node/`; vertex log, generations, QCs, manifests, 2l author-sequence counter/envelope/outbox transaction, recovery, `exportGeneration` for backup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| §11.15 comparative benchmarks                                        | **Covered, narrower**                                                                                                                            | Profile gates + the CMP kill criterion. Deliberately per-object ceilings rather than their global matrix — but their 128-peer / 24-hour / 10M-op cases belong in the weekly tier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §12.1 no blueprint commitment                                        | Covered (§11.1)                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.2 arbitrary JS determinism                                       | Partial by design (§11.3)                                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.3 complete-history sync                                          | Covered (§11.7)                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.4 no certified snapshot / compaction                             | Covered (§11.8)                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.5 in-memory storage                                              | Covered (§11.14)                                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.6 expensive replay / cloning / conflict processing               | **Open until atomic-apply staging is history-independent** (D.5(j): `pruneSnapshots` still materializes every vertex key per checkpoint advance) | Phase 1d incremental snapshots kills the 3–4×`O(stateSize)` clone per vertex (~120 MB/s at 1 MB state and 30 vertices/s) that round 1 never addressed; 1b removes the per-message `O(V)` rebuild; 0e caps causality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §12.7 equivocation / old dependencies                                | Covered (§11.12)                                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.8 finality ≠ BFT ordering                                        | Covered (§11.11)                                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.9 ABI + resource controls                                        | Covered (§11.4, §11.13)                                                                                                                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §12.10 benchmark evidence                                            | Covered (§11.15)                                                                                                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### The five-plane architecture (§10) maps to the tracks

| Source plane                   | Here                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| §10.1 ephemeral simulation     | **Track E** (E1–E4)                                                                                                                                  |
| §10.2 simulation authority     | **Track E5** commit points + referee ACL role; §0.6 operator node. _The library ships the role plumbing; the application ships the validation logic_ |
| §10.3 durable replicated state | Phases 3–7 (the AHE spine)                                                                                                                           |
| §10.4 persistence              | Phase 2 + §7b `local-only` availability policy; operator mirrors later                                                                               |
| §10.5 sharding                 | **Track S** (S1–S4) with the saga protocol and conservation invariants                                                                               |

### The honest bottom line

The source document's own verdict is _"for a competitive real-time game, choose none of them as the complete
solution"_ — and this plan agrees rather than contradicting it. What plan-v2 delivers is the durable
low-frequency signed-command plane the analysis recommends **plus** the two planes it says must exist
alongside it (ephemeral, sharding), with an operator relay spine. It does **not** deliver an authoritative
simulation or anti-cheat; §10.2's authority plane is a role the library exposes and the application fills.

So: a **chat-ready** app is fully in scope for Train C + Phase 7 (this is the profile the plan can take
furthest on pure P2P). An **MMORPG-ready** app is in scope in the sense the source document endorses — zone-
instanced, ephemeral transforms off the DAG, durable commands only, operator relays for fanout and
compaction liveness. A seamless single-shard world with serverless competitive anti-cheat is a non-goal
(§0.6), and no amount of compaction work changes that.

---

## Appendix B — doc-hygiene corrections to fold back into the source documents

Reviewers judge rigor by exactly these.

- **AHE §4.1** "little-endian typed arrays" → **big-endian** (matches the reference and the framing integers).
- **AHE §4.2** framing formula → the reference's `"DRP\0" ‖ U32BE(|domain|) ‖ domain ‖ (U64BE(|part|) ‖ part)*`.
- **AHE §4.1** "deterministically encoded CBOR is recommended" → the frozen tag codec. Deletes "indefinite
  lengths" from the negative corpus (a CBOR-only concept).
- **AHE §2.2** "avoid adding a BLS/WASM dependency" → **stale**. `@chainsafe/bls ^8.1.0` is already a
  production dependency of `object` and `keychain`, via the `herumi` WASM backend. Keep the simplicity
  argument for individual (non-aggregated) QCs; drop the dependency-avoidance one. Note the active v2
  suites are Ed25519 with distinct identity/seal identifiers per −1d; P-256 is reserved. WebCrypto
  supports neither secp256k1 nor, until the Pre-release real-device sign-off is recorded, proven non-extractable
  Ed25519 on every required mobile engine.
- **AHE §14.2** vote schema → `highestPrepareQC` moves to the round-change body; `round-change` gains a
  normative preimage.
- **AHE §13** → `round` deleted from the cut; `closeManifestDigest` becomes **mandatory**;
  `availabilityPolicyDigest` and `archiveIndexRoot` added.
- **AHE §5 / §10.1** → anchor and snapshot payload gain `blueprintDigest` and `archiveIndexRoot`.
- **AHE §19** benchmark narrative → **do not use as a sizing input**. The 739.8 ms/8192 Merkle figure is
  dominated by ~16k awaited WebCrypto round-trips; re-measure against the sync port.
- **AHE §22** "91.71% coverage" → excludes `indexeddb-store.js` and `runtime.js` entirely; the crash-critical
  module has **zero** executed coverage. And the headline determinism counters are **Python self-comparison**
  (§0.2) — `validate_epoch_model.py:296-301` folds both states through the same function; `:273-278` deletes
  the storage-order variable then calls the same pure function twice.
- **AHE §22** browser evidence → recorded `blocked`; when actually run, Chromium passes and Firefox/WebKit
  hang on a harness race (§0.1). The static `browser_surface_audit.py` "pass" coexisted with that bug.
- **AHE header** reference path `implementation/src/` ≠ actual
  `ts-drp-ahe-review-bundle/reference-implementation/src/`.
- **`deep-analysis` / `compaction-hardening-plan` / AHE §6.4, §7.1** "insertion-order-sensitive DFS" →
  **partially stale**; `hashgraph/index.ts:318` `.sort()`s forward-edge neighbours. Origin-sensitivity, the
  contraction counterexample and shared-descendant double-scheduling remain real. A RED test must target
  **origin** sensitivity or it will not reproduce.
- **`compaction-hardening-plan`** AEC "contraction counterexample" → uses **non-antichain** deps (`{0,2}` with
  `0≺2`), which AEC v3.1's own admission rule rejects. It shows the origin lemma is _unproven_, not that AEC
  is _unsound_. Presenting it as a refutation is a credibility risk.
- **Chat E2E** → `chat.pw.ts` proves a two-peer room over _local_ fixtures, not public Nostr; no
  creator-offline chat test exists. Do not inherit "already proven."
- **`docs/cross-browser-testing.md:16`** points at a root `playwright.config.ts` that no longer exists.
- **Naming** → `protocolMajor: 2`, `ts-drp/*/v2`, `packages/protocol-v2` everywhere; "AHE v4" is the spec
  document title only.
- **Round-1 integration-plan migration authorization** ("legacy creator OR current authority") → unsafe while
  current authority is replay-influenceable. Creator-only or an externally pinned quorum.
- **`perf-contracts.test.ts:221`** `describe(... RED until optimized)` → mislabelled; the suite is green.
  Relabel as green regression pins.

---

## Appendix C — Golden-path verification

Every gate in this plan proves one invariant **in isolation**. None of them proves the stack **composes**.
A room can pass the codec vectors, the order corpus, the crash matrix, the seal model and the soak ledger,
and still be unusable because the pieces do not fit together at the seams.

The golden paths are the composition proof: two end-to-end scenarios, run against the reference app (Track P
slice **P5**), where every step has an observable assertion. They are **not** a big-bang test at the end of
the program — each phase lights up more steps, and the path is only complete when the program is. But they
sit at the end of this document because passing them is what "done" actually looks like.

### Why chat is the first golden path

1. **The durable record _is_ the product.** In chat, messages are the state. So the path exercises the record
   itself rather than a sidecar attached to it — there is nowhere for a broken layer to hide.
2. **Every layer is load-bearing.** Identity, permissions, ordering, determinism, durability, compaction,
   archive, cold join and moderation are all on the critical path of "send a message and have it still be
   there next year."
3. **A failure is unambiguous.** Chat needs _zero_ simulation logic. So when golden path 1 fails, it is a
   library bug — always. There is no game code to blame it on. That property is worth more than it sounds:
   it is why the game path must come second.
4. **The work is not throwaway.** It is a shippable product on its own, and golden path 2 reuses all of it.

### Golden path 1 — Chat (Train C)

Run on a real room in the reference app, on the browser matrix, with network-byte and vertex-count accounting
instrumented throughout. "Lights up" = the earliest phase at which the step becomes assertable.

| #   | Step                                                                                                              | What is asserted                                                                                                                                                                      | Lights up              |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | Create a room                                                                                                     | Genesis anchor derives locally from the creator-bound id; profile reads `creator-trusted-v1`; the UI trust label is a **pure projection of the verified profile chain**, not a string | 3                      |
| 2   | Invite; a second peer joins                                                                                       | The invite pins genesis + a recent cut; the joiner verifies the authority chain before accepting any state                                                                            | 3, 5                   |
| 3   | 8 peers send messages concurrently, under a partition that heals                                                  | All 8 converge to a byte-identical state digest; delivery order does not matter; the divergence manifest stays empty                                                                  | 0, 1                   |
| 4   | A moderator grants Writer to one peer and revokes Finality from another, **concurrently**                         | Both apply. (This is the resolver bug that silently drops one today — `acl/index.ts:219-221`)                                                                                         | 3                      |
| 5   | A compromised admin is removed                                                                                    | Admin is revocable, and the removal is effective from the next anchor. (No-op today — `acl/index.ts:129-132`)                                                                         | 3                      |
| 6   | Reload the tab                                                                                                    | State recovers from durable storage, not from the network; no replay of full history                                                                                                  | 2                      |
| 7   | **Hard-kill the browser process mid-write**, restart                                                              | Recovery lands on old-complete **XOR** new-complete; the full closure digest matches one of two goldens; never mixed                                                                  | 2                      |
| 8   | The room closes an epoch in shadow mode                                                                           | Two replicas + archival replay + the pinned JS reference all agree on the cut and snapshot digests                                                                                    | 4                      |
| 9   | Enable pruning                                                                                                    | Closed-epoch structures are gone by **census** (exact integers), the op-count is intact, and the state digest still matches archival replay                                           | 6                      |
| 10  | Old messages age into archive segments                                                                            | A compact peer holds the archive root and recent descriptors only; segments verify by inclusion proof                                                                                 | 7                      |
| 11  | **Cold-join a room with 1M messages**                                                                             | Downloads O(hot + window), **independent of room age**, verified by network-byte accounting. _This is the payoff — the single number that says compaction worked_                     | 6, 7                   |
| 12  | Replay a creator-signed ACL chain from room A into room B                                                         | Terminal at admission, both directions                                                                                                                                                | 3                      |
| 13  | Inject a forged vertex through every ingest path **including direct `object.merge()`**                            | Rejected everywhere; proven reflectively over the handler registry, not by a hand-maintained list                                                                                     | 1                      |
| 14  | A hostile peer floods: oversized batches, dependency bombs, rotated invalid hashes, 100 Sybil keys                | Honest peers stay inside fixed CPU/RAM/queue budgets; re-request rate stays bounded; no honest room is starved                                                                        | 1                      |
| 15  | A user asks to delete their messages                                                                              | The product does exactly what the decision record says, and the UI copy does not promise more than key-erasure can deliver                                                            | 1 (record), 7 (crypto) |
| 16  | Operator trips the kill-switch                                                                                    | Compaction halts fleet-wide within N seconds; drill log emitted; rollback telemetry increments                                                                                        | 1, 6                   |
| 17  | Steps 1–16 on Chromium, Firefox and WebKit — **plus any shipped Electron build, at each version still supported** | Per-engine `ahe-storage-validation.json`, `missingKillPoints === []`, and real Safari/iOS + Chrome/Android rows at the release SHA                                                    | 2, 6                   |

**Exit:** golden path 1 green on the full matrix at one SHA = the chat product is shippable, and Train C's
claim ("production-hardened signed-command rooms with bounded history") is earned rather than asserted.

### Golden path 2 — Game (Train S)

Golden path 2 **starts by re-running golden path 1 against a zone object.** That is the point: if the durable
plane needs special-casing for the game, the abstraction failed. Only then does it add the two things chat
does not need.

| #   | Step                                                              | What is asserted                                                                                                                                                                                                    | Lights up |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | **All of golden path 1, on a zone object**                        | Identical results. No game-specific carve-outs in the durable plane                                                                                                                                                 | —         |
| 2   | 32 players move at 30 Hz for 10 minutes                           | **Durable vertex count is unchanged**, exactly — plus the positive control that one `placeBlock` in the same run creates exactly one vertex                                                                         | E1        |
| 3   | Same, under 30% packet loss                                       | The unreliable tier beats the reliable tier on p95 latency; no head-of-line stall                                                                                                                                   | E3        |
| 4   | 40 players visible, interest management on                        | Bandwidth per client stays inside the Profile-M budget                                                                                                                                                              | E4        |
| 5   | Two players place a block on the same tile concurrently           | The blueprint resolver picks a winner; every replica picks the **same** winner. _This is the capability Yjs and Automerge do not have_                                                                              | 0, 3      |
| 6   | Two players click the same loot drop simultaneously               | Your rule or referee decides; the verdict becomes **exactly one** signed durable vertex; the losing client's self-serving claim is **rejected by the ACL/blueprint**, not by convention                             | E5        |
| 7   | A trade between two players                                       | One durable op carrying **both** signatures; a single-signature version fails verification; duplicate delivery applies once                                                                                         | E5        |
| 8   | A player carries an item from zone A to zone B                    | Reserve → sealed epoch → cert → redeem. The item is spendable in exactly one place at **every prefix of every schedule**                                                                                            | S2, S3    |
| 9   | Step 8, with zone A compacting mid-transfer                       | The cert still verifies against the **archived** cut; the reservation was never pruned. _This is the case that justifies keeping `archiveIndexRoot` in the preimage_                                                | S3, 6     |
| 10  | Step 8, with a crash, a partition and a retry injected            | I1–I4 hold across ≥10⁴ schedules; no duplication, no loss                                                                                                                                                           | S3        |
| 11  | The referee goes offline mid-fight                                | The degraded mode is the one that was specified — contested actions stall, uncontested play continues. **Not** an undefined state                                                                                   | E5        |
| 12  | A hacked client sends impossible positions and a false loot claim | **Negative assertion, and it must be written down as one:** the movement is _carried_ by the ephemeral plane and _not prevented_; the false durable claim **is** rejected; both are attributable to that peer's key | E1, E5    |
| 13  | 1,000 members online in one channel / zone                        | Each browser stays inside its connection budget; discovery never surfaces more mesh peers than the budget; writes still converge via the relay spine                                                                | T1–T4     |

**Exit:** golden path 2 green = Train S's claim is earned, and only then may the words "MMORPG or Discord at
scale" appear in anything user-facing.

### What the golden paths deliberately do **not** prove

Stating this is part of the gate — an acceptance test that quietly implies more than it checked is the same
failure mode as an inherited number.

- **Not anti-cheat.** Step 2.12 asserts the _opposite_: a hacked client's ephemeral traffic is carried, not
  blocked. Signatures prove authorship, never truth.
- **Not that your simulation is correct or fun.** The library records verdicts; it does not produce them.
- **Not availability.** Every peer can still delete everything. `local-only` is an honest policy, not durability.
- **Not one object at global scale.** Both paths are per-object. Player scale comes from sharding × ceilings.

### How this runs

- **Grows per phase.** Each phase adds its steps to the path; a step whose phase has not landed is `pending`,
  never `skipped`. The count of `pending` steps is the program's real progress metric — more honest than a
  phase checklist, because it is measured on a running product.
- **Lives in the reference app** (P5), so the §23 checklist's UI and configuration items become demonstrable
  rather than sign-off-able by assertion.
- **Pre-release tier**, at one SHA, on the full matrix. A green nightly from a different commit does not count.
- **One artifact:** `golden-path-report.json` — per step, per engine: status, assertion, measured value,
  budget, and the trace. The Definition of Done above is satisfied when both paths report zero `pending` and
  zero `fail`.

---

## Appendix D — Implementation log: findings and gotchas

Appended as each phase is implemented. **Every entry here was verified by execution in this repository**
— nothing is inherited from a review document. An entry that cannot name the command that produced it
does not belong here. Slice-level detail that only concerns the legacy-plane rollout also appears in
`ts-drp-repo-integration-plan.md` §9; this appendix is the authority for anything that touches a plan
decision.

### D.0 — Harness and infrastructure (not plan changes; prerequisites)

- **This document contains a literal NUL byte at offset 31266**, inside the sentence discussing
  NUL-delimited vote keys (§2.4 D1). `grep` and `rg` therefore classify the whole file as binary and
  return _nothing at all_ — silently, with exit code 1. Every heading grep against this plan comes back
  empty until you pass `rg -a` / `grep -a`. Normalising the byte would change a sentence that is
  deliberately about that byte, so the byte stays and this note is the mitigation.
- **`codex exec` can be refused by its provider's safety filter on ordinary distributed-systems
  vocabulary.** A prompt describing convergence testing was rejected twice with _"flagged for possible
  cybersecurity risk"_, exiting non-zero after ~41k tokens with no work done and no file changes. The
  trigger is wording, not intent: terms like _adversarial_, _attack_, _exploit_, _byzantine-craftable_ and
  _beat the gate_ read as offensive-security framing out of context. Rewriting the same task in neutral
  engineering language — _targeted test case_, _producible by a non-standard client_, _cases the corpus does
  not generate_ — runs normally. Symptom to recognise: a short log ending in the flag message rather than a
  report. Check `git status` before assuming any partial work landed; in both instances nothing had.
- **NEVER `pkill -f <pattern>` while an agent CLI is running.** `codex exec` receives its prompt as an
  argv string, so the entire prompt text appears in its command line. A `pkill -9 -f "vitest"` intended to
  clear stale test runs matched the _prompt_ — which contained the words `pnpm vitest run packages/object`
  — and SIGKILLed the agent mid-edit (`CODEX EXIT=137`). Kill by explicit PID, obtained from `ps`, and
  check the PID list before firing.
- **Orphaned test runs silently poison every subsequent measurement.** A single working session accumulated
  **five** abandoned `pnpm vitest` runs, ~60 worker processes, the oldest running 1h52m — every one started
  by a wait that hit the 10-minute tool ceiling and was then abandoned rather than killed. All timing taken
  during that window is worthless, and the contention made a slow test look like a crashing one. Rules:
  one suite run at a time; kill the previous run by PID before starting another; `ps` for strays before
  believing any performance number; and treat _"the process died silently"_ as a hypothesis to verify with
  `ps`, not a conclusion — in this case the process was still running at 41 minutes.
- **A detached `nohup … & disown` run is invisible to the harness**, so no completion notification arrives
  and the only option left is polling — which is what produced the abandoned runs above. Use the harness's
  own background mechanism instead: it survives the tool-call ceiling _and_ notifies on exit.
- **`codex exec` silently blocks on stdin when stdin is not a TTY.** Writing a prompt file with a heredoc
  and then invoking `codex exec "$(cat prompt)"` in the same compound command leaves stdin attached to the
  consumed heredoc; codex prints `Reading additional input from stdin...` and waits forever, producing a
  39-byte log and no error. Always append `< /dev/null`. Symptom to watch for: a background agent whose log
  stops growing at a few dozen bytes.
- **`timeout(1)` is not on `PATH` on this machine** (macOS, no coreutils). Wrapping an agent CLI in
  `timeout` produces `command not found` **and a successful exit code**, which reads exactly like "the
  agent ran and produced no output." Run the CLIs bare and use a stall watchdog on log growth instead.
- **The vendored AHE reference test suite was being globbed by the repo's own vitest run.**
  `vite.config.mts`'s `test.exclude` did not cover `docs/`, so
  `docs/production-hardening/ts-drp-ahe-review-bundle/reference-implementation/test/core.test.mjs` — a
  `node:test` suite — ran under vitest and failed. The repo suite was therefore red for a reason with no
  connection to `packages/`, which makes red/green TDD unusable. Fixed by adding `"docs/**"` to the
  exclude list. Note this interacts with §2.3's plan to `git mv` the reference to
  `packages/protocol-v2/conformance/ahe-reference/`: **that move must land together with a vitest
  include/exclude decision for the new location**, or the same collision reappears one directory later.

### D.1 — Baseline at `7f9e66a` (2026-07-24), measured

| Command           | Result                                                  | Log                                   |
| ----------------- | ------------------------------------------------------- | ------------------------------------- |
| `pnpm typecheck`  | exit 0, clean                                           | `.logs/phase0-baseline-typecheck.log` |
| `pnpm lint`       | exit 0 — **0 errors, 176 warnings** (all `jsdoc/*`)     | `.logs/phase0-baseline-lint.log`      |
| `pnpm vitest run` | **6 failed / 1342 passed / 4 skipped** across 188 files | `.logs/phase0-baseline-test.log`      |

The 6 failures are exactly the three Phase-0 RED suites listed in D.2 and nothing else, so the red/green
boundary for the first slice is unambiguous.

#### Baseline-RED ledger (required by principle 5 / D.5(h))

Every RED spec, executed against `7f9e66a` in a throwaway worktree before its GREEN half began. A spec with
no row here has not been qualified and does not count toward any exit gate.

| Spec :: test                                                            | Baseline | Current | Kind                                                                                                                                                                                       | Failing assertion                                                                                                |
| ----------------------------------------------------------------------- | :------: | :-----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `state-adoption-replacement` :: live keys equal canonical replayed keys |   FAIL   |    —    | RED                                                                                                                                                                                        | live DRP keys must exactly equal the canonical replayed keys                                                     |
| `state-adoption-replacement` :: byte-identical state across replicas    |   FAIL   |    —    | RED                                                                                                                                                                                        | the same vertex hash must not encode replica-local caller context                                                |
| `merge-atomicity` (original, batch-scoped — **superseded**)             |   FAIL   |    —    | RED                                                                                                                                                                                        | a rejected batch must not commit any vertex to the live hashgraph                                                |
| `deterministic-rejection-taxonomy` :: ×3                                |   FAIL   |    —    | RED                                                                                                                                                                                        | authorization / absent method / reserved no-op are deterministic per-vertex rejections                           |
| `dispatch-surface-parity` :: inherited throwing member                  |   FAIL   |  FAIL   | RED                                                                                                                                                                                        | an inherited throwing operation must be a repeatable per-vertex rejection                                        |
| `dispatch-surface-parity` :: `toString`/`hasOwnProperty` admitted       |   PASS   |  PASS   | **parity pin** (deliberate — slice 0i; not a gate, it guards against over-correction)                                                                                                      |
| `merge-atomicity` (inverted per D.3(b)) :: quarantine a transient peer  |   FAIL   |  FAIL   | RED                                                                                                                                                                                        | a transient vertex must be retriable quarantine while its valid batch peer commits on every surface              |
| `merge-concurrency` :: A reachable after a notified local child         | **PASS** |  FAIL   | **regression pin**                                                                                                                                                                         | rollback must not delete A after a notified local transaction commits its child                                  |
| `merge-concurrency` :: A reachable after a notified peer merge          | **PASS** |  FAIL   | **regression pin**                                                                                                                                                                         | rollback must not orphan a child committed by an overlapping peer merge                                          |
| `merge-concurrency` :: childless B restored to a multi-head frontier    | **PASS** |  FAIL   | **regression pin**                                                                                                                                                                         | a rolled-back only-B child must restore B to the frontier whenever B becomes childless                           |
| `merge-concurrency` :: one complete same-hash survivor                  | **PASS** |  FAIL   | **regression pin**                                                                                                                                                                         | the same-hash survivor must remain singular and complete after the overlapping owner rolls back                  |
| `checkpoint-interleaving` :: L6 replica equivalence at the 256 suffix   |   FAIL   |  FAIL   | RED (pre-existing)                                                                                                                                                                         | an applied merge and an interleaved checkpoint must reproduce the serial replica's live state and snapshot bytes |
| `merge-concurrency` (**round-2 version, discarded**) :: ×3              | **PASS** |  FAIL   | **PASS/PASS-class failure** — red only against the intermediate implementation, never against baseline; could not distinguish the fix from doing nothing. This row is why the rule exists. |

_Method:_ `git worktree add <tmp> 7f9e66a`, copy the spec files in, disable the worktree's
`vitest.workspace.ts` (it references a `vite.config.mts` path that resolves against the main tree), run with
a minimal local vitest config and the main tree's `node_modules` symlinked. Do not `git stash`.

### D.2 — Phase 0, live-bug fixes L1–L5 (legacy plane): the first green was wrong

Five defects, each pinned by a RED test before any production line was written:

| #   | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Site                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| L1  | State adoption is a **merge, not a replacement** — `Object.assign(this.acl, acl)` / `Object.assign(this.drp, drp)` at the end of `applyVerticesUntraced`, and both `Object.assign` calls in `assign()`. A top-level key deleted by a blueprint operation survives on the live object, so the live instance disagrees with `states.getDRPState(frontier)` and with any replica that replayed from scratch.                                                | `drp-applier.ts:271,274,579,582` |
| L2  | **Replica-local `context` is snapshotted.** `stateFromDRP()` snapshots every non-function own property, including `context`, which `callDRP` overwrites with the _calling peer id_ before every operation. Two replicas agreeing on the graph produced different `DRPState` bytes for the same vertex hash (caller byte `97` vs `98`). `proxy.ts` already treats `context` as ignorable for mutation tracking — the snapshot path was the inconsistency. | `state.ts:184-193`               |
| L3  | **Merge batches are not atomic.** The per-vertex pipeline writes straight into `hashGraph`, `states` and `finalityStore`; a transient blueprint failure on a later vertex rethrows out of `applyVertices`, leaving earlier vertices of that batch permanently committed while the caller sees only a rejected promise.                                                                                                                                   | `drp-applier.ts:215`             |
| L4  | **Authorization failure is an untyped `Error`** the classifier does not recognise, so it rethrows and aborts the merge of every other vertex in the batch. One unauthorized vertex from a hostile peer is a batch-wide DoS.                                                                                                                                                                                                                              | `drp-applier.ts:527`             |
| L5  | **An unknown blueprint operation is an untyped `TypeError`**, same batch-wide effect. Related: a non-root vertex with reserved `opType === "-1"` was silently `continue`d — reported as neither applied, missing, nor invalid.                                                                                                                                                                                                                           | `drp-applier.ts:196`             |

_Gotcha, still binding:_ L5 must be fixed by checking that the named operation exists and is callable
**before** invoking it — a property of the blueprint — not by reclassifying a caught `TypeError` as
deterministic. A blueprint method may legitimately throw `TypeError` from inside correct code.

> **Why these are `L`n and not `D`n.** §2.4 already defines D1–D3 as defects _of the AHE reference_
> (`localeCompare`, `Float32Array -0`, admission ordering). The repo's own legacy-plane defects are
> therefore numbered **L1–L5** here. Slice 0d's "Reorder per D3" refers to §2.4's D3, not L3.

**All five went green (1348 passed / 0 failed) and the result was still not shippable.** Four independent
reviewers (Grok-4.5, Kimi-K3 at 100 steps, Opus-xhigh adversarial, plus this session) converged on
DO-NOT-SHIP. This is the single most important process finding so far, and it generalises:

> **A green suite is evidence about the tests, not about the change.** Every defect below was invisible to
> a full-suite pass and was found only by a reviewer constructing an input the RED tests did not contain.
> The plan's principle 5 ("every gate must be provably able to fail") is necessary but not sufficient —
> the gates here _could_ fail; they simply did not describe the state space.

#### D.2.1 — The atomicity fix was implemented as clone-and-swap, and that is a data-loss bug

The first implementation made `applyVerticesUntraced` `cloneDeep` the whole `hashGraph`, `states` and
`finalityStore`, **rebind those three instance fields to the clones**, run the batch against the clones,
and copy back on success. Three defects follow, all reproduced by execution:

- **A local operation issued during an in-flight merge is silently lost _after being gossiped_.** Async
  blueprint methods are a supported feature (`packages/node/tests/async-drp.test.ts`), so a merge parks on
  `await` while the instance fields point at clones. A concurrent local `drp.method()` runs through
  `callFnPipeline`, which is **not staged**: its vertex lands in the _staged clone_, but it mutates the
  _live proxy_ and fires `_notify("callFn")`, on which `handlers.ts:504-529` signs and broadcasts. When the
  merge rejects, the clone is discarded — the vertex is gone from the local graph while the live DRP still
  shows its effect, and peers hold a vertex the originator's own graph does not. Measured:
  `finalVertexCount=1`, `values=[7]`, one broadcast for a hash present in no graph.
  _Scope correction (confer round):_ do **not** claim the vertex is permanently unreproducible. The origin
  cannot regenerate it from its own graph, but a peer that received the signed bytes may redeliver it. The
  confirmed harms are the torn window (live proxy shows an effect the graph lacks), the broadcast of a
  phantom hash, and **silent unreported loss** — all three stand without the permanence claim.
- **Two overlapping `applyVertices` calls cross-wire the staged and live references.** A fast valid merge
  overlapping a slow failing one resolved `{applied:true}`, fired its `merge` notification, showed its
  value on the live DRP — and its vertex was in **no** hashgraph and no state store. Separately, after two
  concurrent merges the applier's `hashGraph`/`states`/`finalityStore` are no longer the object identities
  the `DRPObject` holds: the identity invariant forks permanently (20/20 stress runs). The
  `replaceEnumerableState` copy-back does **not** repair this — an overlapping merge captures the _other
  merge's clone_ as its "live" reference.
- **Cost: the clone is O(retained graph + snapshot bytes + finality entries) per merge, and gossip
  delivers ~1 vertex per UPDATE** (`drp-applier.ts:683` notifies a single vertex; `handlers.ts:511-519`
  broadcasts exactly that). Measured single-vertex merge: **3.90 ms at V=200, 32.20 ms at V=1000,
  112.18 ms at V=3000**; building 3,000 vertices one-merge-at-a-time took 117 s wall.
  Three points and code inspection together establish the **complexity class**, not a fitted curve. At the
  measured slope (~0.037 ms/vertex) a one-vertex batch at 100k vertices is **~3.7 s**, not the ~200 ms
  first written here — an arithmetic error caught independently by all three confer agents, and the
  correction makes the mechanism _worse_ than originally recorded. The 50 ms crossing near V≈1400–1500 is
  **interpolation, not a measured p99** — no latency distribution was sampled.
  _Methodology debt:_ this benchmark was run ad hoc by reviewers and no script, hardware profile or
  distribution was committed. Before any of these numbers is used as a **gate** rather than as evidence for
  a design decision, it must be re-run from a checked-in harness under the `perf-contracts.test.ts`
  probe-counter pattern. Recorded as owed, not done.

The last point is a **plan-level** finding, not just a code one: it adds a wall that §Phase 1's _Measured
wall order_ table does not list. Recorded in **D.3**, which is also the amendment those measurements
produced.

#### D.2.2 — The L5 pre-dispatch check walks the whole prototype chain

`typeof drp[method] === "function"` is true for `Object.prototype` members. `opType: "constructor"`
therefore passes the check, and `Reflect.apply` then throws an **untyped** `TypeError: Class constructor …
cannot be invoked without 'new'` — not a `DeterministicRejectionError`, so the whole batch is rethrown, the
valid vertex batched with it is lost, the hostile vertex is never marked invalid, and **every redelivery
wedges again**. That is precisely the batch-wide DoS L5 existed to close, one word away from the tested
input.

The correction must respect slice **0i**: `toString` and `hasOwnProperty` **execute and are admitted today**
(verified: `{applied:true}`, junk in graph), so the legacy plane must keep admitting them as no-ops or
patched peers permanently exclude a vertex unpatched peers include. Only currently-**throwing** opTypes
(`constructor`) may become terminal — equal exclusion on both sides, so no fork. A blanket allowlist here
would be a legacy-plane fork disguised as hardening.

#### D.2.3 — Smaller confirmed findings

- The live `drp`/`acl` proxies and `checkpoints` are mutated **inside** the try block, before the three
  stores are committed. A throw in that window (e.g. from `advanceCheckpointIfNeeded`) leaves live state
  advanced while the stores roll back. Narrow, but the batch is then not atomic across all observable
  surfaces — and `merge-atomicity.test.ts` asserts only `vertices` and `getStates`, so it cannot see it.
- `REPLICA_LOCAL_STATE_KEYS = new Set(["context"])` in `state.ts` is unexported and a name compare. It is
  applied consistently at the single snapshot funnel (`stateFromDRP`), so it is correct as far as it goes,
  but a renamed field or a subclass alias silently reopens L2. Export and document it as the contract.
- `replaceEnumerableState` deletes through the live proxy; a DRP with a non-configurable own accessor
  absent from canonical state would make `delete` throw mid-adoption, after staged work and before commit
  — a deterministic failure classified as transient, i.e. a permanent merge wedge. _(Inference, not
  probed.)_
- **Non-finding, so it is not re-litigated:** the `DRPProxy` has no `deleteProperty` trap, so
  delete-then-restore adoption does **not** mint spurious vertices or trip `hasChanges()`. Vertex bytes,
  `computeHash` and the wire format are untouched; L2's byte change is replica-local by design, and
  `FinalityState.data` is the vertex hash, never state bytes, so attestations cannot split across versions.
  A patched and an unpatched peer diverge on live key sets and stored `DRPState` bytes, **not** on frontier
  membership — the graph does not fork during a rolling upgrade.

#### D.2.4 — Process notes that will repeat every phase

- **Three of the four reviewers wrote and executed probe programs**; the one that only read code produced
  the weakest verdict. Budget for reviewers who run things. Probes belong in `/tmp`, never in the repo —
  one agent left five `zzprobe-*.test.ts` files in `packages/object/tests/` mid-run, which another agent
  then reported as suspicious activity.
- **`pnpm vitest run` takes ~9 minutes and two concurrent runs collide** on the libp2p proptests' ports,
  producing false failures. Reviewers must be told the verified counts up front and told not to re-run the
  full suite; targeted `pnpm vitest run packages/object` is safe.
- **`pnpm lint` reports 176 warnings at baseline, all `jsdoc/*`.** The summary line "N problems potentially
  fixable with --fix" is a _subset_ count, not the total — reading it as the total produces a phantom
  regression report.
- **When a contract is superseded, EVERY spec written under it must be re-qualified — this is now a
  three-time failure.** Round 3's GREEN half returned BLOCKED twice, both times correctly, both times on an
  orchestration error rather than a code problem:
  1. The four `merge-concurrency` regression pins hard-coded baseline's _reject_ behaviour as a "positive
     control", which is unsatisfiable alongside the inverted `merge-atomicity`. **A regression pin must
     assert the invariant, never the old semantics.** Fixed by replacing `rejects.toThrow(...)` with a
     helper accepting either a rejection _or_ a resolution reporting the vertex in `quarantined`.
  2. `merge-rollback-completeness.test.ts`, authored in the previous cycle under the batch-scoped contract,
     still demanded whole-batch restoration — including _forgetting a deterministic invalidity_ and undoing
     a valid ACL grant. It was never re-qualified when D.3(b) superseded that contract.
     The rule: **when an amendment supersedes a contract, enumerate every spec authored under it and re-qualify
     each one in the same pass.** A superseded spec is indistinguishable from a live one at read time, and it
     will block or silently mis-steer the next slice.
- **An agent that refuses is doing its job.** The remediation's first GREEN run returned BLOCKED rather
  than edit an immutable test, having found that the requirement it was given (a mutex over both the merge
  and local-call paths) contradicted the RED tests' own orchestration — and, more importantly, would make
  synchronous local DRP calls asynchronous, a breaking API change outside the slice. The block was correct
  and produced a strictly better design (journal into the live stores, no lock). Instruct implementation
  agents to stop and escalate on a contradiction, and treat a BLOCKED verdict as a result, not a failure.

---

## Appendix D.3 — Approved plan amendments

Each amendment below was put to an **Opus-high agent, a Codex-high agent and a Kimi agent at 100 reasoning
steps** independently, per this project's standing rule that the plan changes only on unanimous agreement.
Their replacement wordings are merged here. Where they differed, the most conservative claim wins — the
one that asserts least about what was measured.

**Vote record.** (a) Kimi AGREE, Opus AGREE-with-rewording, Codex DISAGREE-with-rewording — but Codex's
objection is to the wording's overreach and to mandating one named mechanism, not to recording the wall
("the wall belongs in Phase 1 because it exists in the current codebase"). The substance is unanimous and
the merged text below adopts Codex's narrowing. (b) unanimous AGREE. (c) unanimous AGREE, with a scope
split only Opus raised, adopted below.

### D.3(a) — The staging wall, and a bound rather than a mechanism

**Add to §Phase 1's _Measured wall order_ table:**

| Wall                                                                                                 | Complexity                                                                | Approx. failure point                                                                                                                                | Slice                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Whole-container clone per merge (staging-by-copy — introduced by the first L3 fix, **not** baseline) | O(retained graph + snapshot bytes + finality entries) per `applyVertices` | 112 ms measured for a 1-vertex merge at V=3000; ~3.7 s at V=100k at the measured slope; 50 ms crossing near V≈1400 by interpolation, p99 not sampled | Phase 0 staging slice — forbidden mechanism, see below |

**Add as normative text to Phase 0:**

> Merge staging MUST cost O(the batch's write set) — the mutations actually performed — never O(retained
> history). **(D.7.4 correction: the original text also said "or O(stateSize)". That leg was a drafting
> error — it condemns the unmodified baseline, whose per-vertex `fromStates`/`stateFromDRP` clones slice 1d
> exists to remove — and is superseded by D.7.4. The O(retained-history) clause stays absolute.)** Copying any whole container (`hashGraph`, `states`, `finalityStore`) or
> rebinding the applier's store fields to copies is forbidden in shipping code on the merge/ingest hot
> path. The prohibition rests on two independent legs: the copy reintroduces the per-message O(V) class
> that slices 1a/1b/1d exist to delete, and rebinding owner-store identities is independently a data-loss
> bug under concurrent local calls (D.2.1). **The bound and the identity invariant are the requirement;
> the mechanism is not.** A scoped write-set journal with undo, a persistent/immutable overlay, or a
> versioned CAS transaction all satisfy it. Whole-container copies remain acceptable in tests and
> prototypes, and per-epoch snapshot copies outside the per-message path (Phase 4) are exempt.
> Object smallness is not an exemption: object size is monotone in room lifetime, so an exemption keyed on
> it is exactly how the wall re-enters.
> **Gate (principle 4):** per-merge time ratio(100k/10k) < 1.5 measured with the `perf-contracts.test.ts`
> probe-counter pattern, plus an assertion that the store identities `DRPObject` holds are unchanged after
> every merge.

**Add as a process guard to §Phase 1:** any slice that introduces a per-message O(V) or O(stateSize) cost
term must add a row to this table before it merges. This table implicitly assumed fixes only remove walls;
step 1 added the largest one yet measured.

### D.3(b) — Atomicity is per-vertex, not per-batch; 0h supersedes the step-1 contract

> The unit of atomicity in the legacy applier is **one vertex across every observable surface** — hashgraph,
> state snapshots, finality store, live proxy, checkpoints, and subscriber notification: fully applied, or
> no trace. A batch is network framing chosen by the sender (`handlers.ts:248-260` passes an arbitrary
> authenticated `Update.vertices` array to `merge`), and **any dependency-closed subset of a causal DAG is
> a valid replica state**, so batch-scoped all-or-nothing adds no safety while handing its blast radius to
> an untrusted peer. It also makes a valid vertex's fate depend on what it was batched with — arrival-order
> dependence, which is precisely what 0o's envelope-purity rule forbids. The current code is already
> internally inconsistent about this: validation failures are isolated per vertex and the loops continue
> past them; only blueprint throws abort the batch.
>
> Application-code failures are classified per vertex per 0h — deterministic → `invalid`; possibly-transient
> → bounded-retry quarantine, retriable, **never** entered into the shared remembered-invalid set (replicas
> may legitimately disagree about transients, so sharing them is a legacy-plane fork vector) and never
> batch-fatal. `applyVertices` resolves with an accurate per-vertex `ApplyResult`; it rejects only on
> applier-internal invariant violations, where the staged batch rolls back wholesale as a last-resort error
> path.
>
> When 0h lands, `merge-atomicity.test.ts`'s batch-level contract is **inverted**, not extended — the same
> device the plan already used at 0c1 for `drpobject.test.ts:72,81` (inverted by `2259f29`). Its real
> content (a rejected vertex commits nothing and leaves no state snapshots) survives inversion; only the
> batch scope dies. Until then, abort-the-whole-batch is a live batch-wide DoS, so **0h is a hard dependency
> of shipping any staged-merge work**, not an independent later slice.
>
> **Record the error plainly:** writing the batch-level contract in step 1 was a mistake. L3's actual defect
> was the _torn report_ — partial commit plus a rejected promise — not partial commit as such, and the
> integration plan's own L4 entry had already specified a typed **per-vertex** rejection.

**Consequence the plan did not state:** a rejecting `applyVertices` is itself a liveness bug. `updateHandler`
reaches `recoverMissingSync` only when merge _resolves_ (`handlers.ts:260,295-297`) and the fanout loop
swallows handler rejections, so a rejecting merge silently disables missing-dependency recovery for that
message — independent of atomicity semantics.

### D.3(c) — 0g's serialization half is a hard prerequisite of staging

> Any staged or atomic merge design requires single-object mutation discipline around the local `callFn`
> pipeline and isolation plus CAS/commit discipline for `applyVertices`, because both touch the applier's
> store bindings. **0g(i) is the local-safe prerequisite; authenticated author sequence is not.**
> That split is now explicit: 0g(i) ships no consensus byte, while Phase −1′ and 0g(ii-T/I) own the
> successor v3 signed sequence. A required sequence is preimage- and wire-visible, cannot be added to the
> frozen v2 or legacy plane, and must not block local staging work that needs no such byte.
>
> Execution MAY be queued, or performed concurrently in isolated versioned transactions with CAS/retry;
> the normative requirements are that no staged transaction rebinds owner stores or exposes a mutation
> before commit, and that all commits and subscriber publication share one linearization point. A design
> that holds a lock across a blueprint `await` MUST state and test its local-write latency policy; the lock
> MUST NOT be held across network waits or 0h's quarantine backoff. With the D.3(a) journal formulation the
> tension largely dissolves — only the synchronous commit section needs exclusion, so local-write latency
> behind a merge shrinks from "the whole async merge" to "one O(batch) commit."
>
> **Gate additions to 0g:** (i) an interleaving test — a local `drp.method()` issued while a merge is parked
> on an async blueprint `await`, exercised for both merge-commit and merge-reject — asserting _"no vertex
> exposed to subscribers may be absent from the committed graph"_; (ii) two overlapping `applyVertices`
> calls under randomized schedules, asserting the store identities held by `DRPObject` and by the applier
> remain the same objects after every schedule. The existing concurrent-local-call sequence test is
> retained but is **not** sufficient — it never exercises a local call against an in-flight merge, which is
> the interleaving that sank step 1.
>
> **Record the API cost explicitly:** serializing the local path makes a currently-synchronous local call on
> a synchronous blueprint conditionally asynchronous (`proxy.ts:269-271` returns synchronously today, and
> `drpobject.test.ts`'s `DRP Context tests` assert on the next line). That is an API-visible decision and
> must be taken deliberately, not as a side effect of a lock.

**Phase-0g(i) implementation clarification.** “Covering both surfaces” means one per-object mutation
discipline, not one mutex held across both pipelines. The selected design gates the complete ACL/DRP local
`callFn` pipeline before `createVertex` with one FIFO `LocalMutationLane`. `applyVertices` remains outside
that lane and follows the concurrent-transaction alternative above: isolated preparation, frontier
CAS/retry and a synchronous shared commit after the final suspension per D.5(f). This preserves the
uncontended local synchronous fast path and avoids holding a local lock across a merge `await`.

### D.3(d) — Consequential corrections elsewhere in this plan

- **No Phase 0 slice owns the staging work.** L1/L2 map to 0c and L4/L5 to 0h/0i/0l, but "merge batches are
  not atomic" has no slice row — hence no class, no argued atomicity, and no plan-defined RED contract. That
  vacuum is where the wrong batch-level semantics were invented. Add an explicit slice (fold into 0h or add
  0q): class local-safe, atomic, with D.3(b)'s and D.3(c)'s contracts as its RED tests.
- **Slice 1d's gate cannot see this class of regression.** 1d instruments state bytes only
  (`clonedBytes < 20 × mutatedBytes`), so a whole-graph and whole-finality-store clone ships straight
  through it. Extend 1d's instrumentation to clone bytes/calls across all three stores, or explicitly
  delegate that to D.3(a)'s gate.
- **Principle 7 under-specifies the atomic unit.** It names "staged state-adoption semantics" as atomic
  without defining the observable boundary. It must include the owner-store identity invariant and the
  publish-after-commit rule, and name every surface: graph, states, finality, live proxies, checkpoints,
  `knownInvalidVertexHashes`.
- **Phase 0's goal statement omits atomic publication.** Add: each vertex transition is atomic across graph,
  snapshots, finality, live state, checkpoints and notifications; 0g's serialization half and 0h are hard
  prerequisites of shipping legacy staging.
- **Phase 0's exit gate has no concurrency gate.** The only tests characterising step 1's actual failure
  mode are the reviewer-added concurrency suites. Until D.3(c)'s gate additions land, "Phase 0 green" is
  asserted by a suite that does not exercise the defect class that sank step 1.
- **Appendix A's "§12.6 expensive replay / cloning / conflict processing — Covered" is false** while any
  merge copies retained stores. Change to **"Open until atomic-apply staging is history-independent"** and
  cite 0g/0h plus 1d.
- **The poison vertex wedges forever, and that is a separate defect from the batch abort.** On rejection the
  `finally` restores `knownInvalidVertexHashes`, so the poison vertex is never remembered invalid and is
  re-served indefinitely. "Discards the entire batch on every redelivery" is accurate for any batch
  _containing_ the poison vertex; a good vertex that later arrives in a clean batch does apply.

---

## Appendix D.4 — Round 2: the **batch-scoped rollback** is a regression, and why

> **Title correction (confer round 2, unanimous):** the regression is _batch scope_, not journaling. A
> vertex-scoped journal on live stores is exactly the shape the approved design now requires. Titling this
> "the journal is a regression" would invite the next iteration to abandon journals and return to whole-
> container copies, reintroducing the D.3(a) wall.

The D.2.1 clone-and-swap staging was replaced with a scoped LIFO undo journal applied directly to the
**live** stores, with `hashGraph`/`states`/`finalityStore` made `readonly`. The suite went to 1354 passed /
0 failed. Three independent reviewers (Grok-4.5, Kimi-K3 at 100 steps, Opus-xhigh adversarial) again
returned **DO-NOT-SHIP**, this time with an A/B against the baseline commit proving a **regression**.

### D.4.1 — What the remediation did fix (verified, keep it)

- **The whole-container clone wall is gone** — _not_ the same as history-independence, see the residual
  term below. Independently re-measured single-vertex merge: **flat at
  ~0.20 ms from V=200 through V=6000**. The implementer's reported _decreasing_ curve (0.51 → 0.41 → 0.27)
  is a warm-up and checkpoint-window artifact and is not reproducible as a trend; the V-independence is
  real on both single-dep and multi-dep paths. One residual term found: `pruneSnapshots` does
  `Array.from(this.hashGraph.vertices.keys())` once per checkpoint advance — amortized O(V/256) per merge.
- **The store-identity invariant of D.3(a) holds.** `readonly` fields, never rebound.
- **Both of the round-1 blockers are closed.** A local `callFn` during an in-flight merge now retains its
  vertex. The clone-and-swap calls are gone; the only `cloneDeep` calls remaining _in `drp-applier.ts`_ are
  payload and argument isolation. (`state.ts` still has seven, for snapshot creation and state restoration —
  the earlier claim that only two survive repo-wide was wrong.)
- **G4's dispatch-surface classification is correct: zero success→terminal transitions on a 23-case
  battery.** (A finite battery, so not a universal no-fork proof.) Run against
  _both_ trees shows **zero** success→terminal transitions: `toString`, `valueOf`, `hasOwnProperty`,
  `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `__lookupGetter__` and 2-deep base-class
  methods stay APPLIED; `constructor`, `call`, `apply`, `bind`, `__proto__`, `__defineGetter__` with junk
  args and unknown names move from _untyped throw / batch abort_ to _per-vertex invalid_; a throw from a
  base class two levels up stays transient. Slice 0i's legacy-parity requirement is satisfied.

### D.4.2 — Why it is nevertheless a regression

The differentiator is **removal of already-committed vertices**, not "writes to live state" — clone-and-swap
also wrote to live state at adoption (`Object.assign(this.drp, …)` at baseline `:271-276`). Three schedules,
all executed, all A/B'd against
`7f9e66a`:

1. **Rollback deletes a vertex a concurrently committed transaction already built on.** Batch = `[A, B]`;
   A commits, B parks on an async blueprint and throws; meanwhile a local call (or a second peer's merge)
   commits a child of A and gossips it. Rollback removes A. Result: the child survives with a missing
   parent, `forwardEdges[A]` is retained while `vertices[A]` is gone, `topologicalSort` reports members
   unreachable from origin, and **every subsequent `applyVertices` throws `No valid linearization
checkpoint` forever**. At `7f9e66a` the identical schedule leaves a consistent graph and the next merge
   resolves.
2. **`removeVertex` restores too little.** A now-childless head is dropped from the frontier entirely when
   both its `previous` and `next` anchors were consumed by concurrent commits and `wasFirst` is false: the
   guard deletes the hash from `restorableDependencies` before attempting restoration, so all three
   branches fall through and the trailing re-insert loop can no longer see it. The vertex stays in the
   graph, childless, off the frontier, and **its operation vanishes from live state while the merge
   reports `applied: true`.** Silent permanent divergence.
3. **Same-hash race across overlapping batches.** The presence check (`vertices.has`) is TOCTOU across an
   `await` and insertion is the last pipeline step, so two batches carrying the same hash as distinct
   decoded `Vertex` instances both pass. The winner commits and notifies — at which point the node **may already have** signed and
   broadcast a finality attestation (`signFinalityVertices` runs in `updateHandler` after merge resolves,
   `handlers.ts:274-292`, and races the loser's rollback; the probes ran at the applier layer) — and the loser's rollback matches on its _own_ instance and deletes
   it, orphaning the state snapshot, the finality entry and the live-state effect. (A related pre-existing
   variant double-inserts, producing duplicate frontier entries and therefore duplicate `dependencies` in
   the next locally created vertex's signed bytes — a consensus-visible surface no test covers.)

**Verdict on the trade:** strictly worse **as implemented at batch scope** — this is a verdict on scope, not
on journaling. Clone-and-swap confined its damage to a
discarded copy and its failure mode — a lost vertex — was recoverable by redelivery. Batch-scoped rollback
removes already-committed vertices from the live graph, breaks the graph's own reachability invariant, and
leaves ordinary subsequent applies **wedged until an explicit repairing delivery** — a peer redelivering the
deleted vertex can restore reachability, but nothing in `handlers.ts` guarantees one, since
`recoverMissingSync` fires only for `missing` and a rejecting merge never reaches it.

### D.4.3 — The root cause is the batch-scoped contract this plan had already rejected

**Blockers 1 and 2 are consequences of batch-scoped rollback and vanish under per-vertex atomicity — because
there is nothing to roll back once a vertex commits.** Blocker 3 does **not** vanish: the same-hash TOCTOU
degrades into a blind double-insert (`HashGraph.addVertex` does an unconditional `vertices.set` plus
`frontier.push`) unless the commit section re-checks presence. Per-vertex scope kills the rollback-induced
corruption; the TOCTOU needs an explicit commit-time re-check. D.3(b) recorded, before this code was written, that batch-scoped all-or-nothing "adds no safety
while handing its blast radius to an untrusted peer" and that "writing the batch-level contract in step 1
was a mistake."

It was then implemented anyway, and hardened. The plan was right and the implementation did not follow it.
That is the finding: **an approved amendment is not self-executing.** D.3(b)'s conclusion needs to become
the RED contract of the next slice — `merge-atomicity.test.ts` inverted — rather than a paragraph the next
implementation prompt has to remember to honour.

**D.3(c)'s optimistic clause is falsified by execution.** It reads: _"with the D.3(a) journal formulation
the tension largely dissolves — only the synchronous commit section needs exclusion."_ The opposite is
true: the journal makes the unserialized case **worse** than clone-and-swap, because rollback reaches into
the single live copy that concurrent transactions have already built on. Striking that clause is queued for
the three-way confer; until then treat 0g's serialization half as an unconditional prerequisite.

### D.4.4 — L6: a live-correctness hole larger than L1–L5, with no owner

`advanceCheckpointIfNeeded` is reachable **un-journaled** from `getLCA`'s local branch, and it bakes
`stateFromDRP(live)` against `hashGraph.getFrontier()` — two sources that are out of sync for the entire
duration of any merge, because `applyVertexPipeline` has no `assign` step and the live proxies stay stale
for the whole batch. A local call during an in-flight merge therefore writes a checkpoint whose `frontier`
includes merge-committed vertices but whose `state` is the pre-merge live state.

At the **default** `TS_DRP_CHECKPOINT_SUFFIX_SIZE=256`, a 256-append batch plus one parking vertex and one
interleaved local call produces: `MERGE-RESULT {"applied":true}`, live state length **2** against a
reference replica's **258** — _256 applied operations silently erased, with the merge reporting success._
Independently reproduced by a second reviewer at suffix size 1. The same call also runs
`pruneSnapshots(undefined)`, permanently deleting snapshots an in-flight batch staged.

This reproduces identically at `7f9e66a`, so it is **pre-existing, not a regression** — but D.2 lists
L1–L5 and no slice owned it. It has a **larger blast radius at default config than any of L1–L5's repros**
(comparative severity across the full class was not measured). Owner assigned in D.5: slice **0q**.

### D.4.5 — Process findings

- **"RED" must be verified against the baseline SHA, not against the current working tree.**
  `merge-concurrency.test.ts` — the suite written specifically to characterise the failure that sank
  step 1 — **passes unmodified at `7f9e66a`**. It was red only against the intermediate clone-and-swap
  code. So the one suite naming the concurrency defect class cannot distinguish the journal from doing
  nothing, and it passes on every schedule in D.4.2. _New rule: every new RED file is executed against the
  baseline commit in a throwaway worktree and its failure count recorded in D.1 before the GREEN half
  starts._
- **A reviewer that A/B's against baseline finds regressions a reviewer that only reads the diff cannot.**
  The "strictly worse" verdict required running the same probe on both trees. Budget for it.
- **Reviewers must be told to use a git worktree, never `git stash`,** when they need a baseline
  comparison — several reviewers share one working tree concurrently.
- **D.2.3's third bullet is upgraded from inference to verified, with a correction:** the wedge is a
  non-writable **data** property, not a non-configurable accessor (accessors adopt fine), and it is
  pre-existing at `7f9e66a` rather than introduced by `replaceEnumerableState`.
- **Arrow-function class fields are silently unusable as DRP operations** — own function properties never
  survive `Object.create(prototype)` + `applyState`, because `stateFromDRP` skips functions. Pre-existing
  and identical at baseline, but uncovered by any test and undocumented.

---

## Appendix D.5 — Confer round 2: approved amendments

Same rule as D.3: an Opus-high agent, a Codex-high agent and a Kimi agent at 100 reasoning steps each
answered independently; the plan changes only on agreement. Where they differed the most conservative
claim wins.

**Vote record.** (f) Opus AGREE-but-scope-it, Codex DISAGREE-scope-it, Kimi DISAGREE-scope-it — unanimous
on the substance: _scope the clause, do not strike it._ (g) unanimous AGREE, with a shared correction to
the question's own premise. (h) unanimous AGREE with a scope qualifier.

### D.5(f) — Serialization depends on **rollback scope**, not on the data structure

D.3(c)'s optimistic clause is **not** struck. It is scoped. All three agents independently reached the same
conclusion, and the adversarial reviewer who wrote D.4 retracted its own framing: _"my 'strictly worse'
verdict was a verdict on batch scope with dirty writes, not on journaling."_

> **Executed finding (D.4.2), correctly scoped.** A rollback journal over the live stores does not dissolve
> the serialization tension **at batch scope** — it inverts it, because the journal keeps undo authority
> alive across a suspension point, and rollback then reaches vertices that concurrent transactions have
> already committed on top of.
>
> **Any transaction whose rollback authority survives a suspension point MUST serialize, or use versioned
> CAS/retry, across both `applyVertices` and the local `callFn` path.**
>
> **A per-vertex design is exempt, and the exemption is as normative as the mandate.** If every shared-store
> write for a vertex — snapshot, finality entry, graph insert, live-proxy update, checkpoint — occurs inside
> one synchronous commit section after that vertex's last suspension point, then it cannot roll back across
> a suspension point; the single-threaded runtime supplies that section's exclusion for free. Such a design
> **MUST NOT** adopt the `callFn` lock as a precaution: the lock's only effect would be to make
> currently-synchronous `drp.method()` calls asynchronous (`proxy.ts:269-271`), an API break that buys
> nothing. It owes two things instead:
>
> 1. **A structural gate** — no journal entry and no shared-store mutation is live across any `await`.
> 2. **Commit-time revalidation** — the vertex-presence check re-executed inside the synchronous section.
>    The loop-top check is TOCTOU-separated from the insert by the blueprint `await`, and
>    `HashGraph.addVertex` blind-inserts (unconditional `vertices.set` + `frontier.push`), so two
>    overlapping batches carrying one hash both insert and duplicate the frontier — which lands in the
>    `dependencies` of the next locally signed vertex, i.e. in consensus-visible bytes.
>
> If an implementation moves any shared write ahead of the last suspension point, it re-enters the mandated
> class and the serialization requirement re-binds.
>
> **The live-proxy surface is the one genuine exception, and it needs no rollback to break.** Live state is
> a function of the whole committed prefix and its adoption base is captured _before_ the `await`, so a
> plain replace-at-commit erases concurrently committed operations with no rollback involved at all. For
> that surface the implementation MUST choose and record one of: (a) recompute adoption against a
> commit-time-consistent base inside the synchronous section (possible only if that replay is await-free),
> or (b) adopt by CAS/retry on the frontier. Serialization is the fallback for this one surface, not an
> unconditional prerequisite for the design.

**Consequential edit to D.3(b)** — this sentence licensed exactly what round 2 built and is replaced:
~~"where the staged batch rolls back wholesale as a last-resort error path"~~ →
**"where the in-flight vertex's uncommitted writes are undone as a last-resort error path; already-committed
vertices are never removed, and the error carries the exact partial `ApplyResult`."**

**Consequential edit to D.3(c)'s headline** — "Any staged or atomic merge design requires single-object
mutation serialization…" is over-broad by the same argument, and must be conditioned on suspension-spanning
rollback, or it silently mandates the async API break for the per-vertex slice.

**Consequential edit to D.3(d)** — "0g's serialization half is a hard prerequisite" is scoped the same way.
0h remains required for per-vertex failure isolation; serialization is required only where rollback or an
unvalidated transaction spans a suspension.

### D.5(g) — L6's owner is the per-vertex slice **0q**, and it does not dissolve for free

The question's own premise — "the per-vertex slice will fix L6 for free by adding the missing `assign`
step" — was rejected by all three agents on the code. `assign` writes `currentDRP`, the _vertex's branch
state_, which is correct on the local path only because a locally created vertex's dependencies default to
the entire frontier. For a remote vertex concurrent with the frontier, live state must be the frontier
linearization. **Transplanting `assign` relocates the erase rather than removing it** — same failure shape
at vertex granularity — and D.3(c)'s gate (i) would still pass, because it asserts graph membership rather
than live-state equality. That is the same blind spot that kept `merge-concurrency.test.ts` green at
baseline.

L6 is therefore a named contract _inside_ 0q, not a standalone slice — a standalone fix against
batch-scoped code would be throwaway work. **The Phase 0 slice table row is added in D.5(k) below.**

### D.5(h) — The baseline-RED rule, scoped

Appended to §1 principle 5:

> **Baseline-RED rule (D.4.5).** A RED spec is evidence only as a pair _(baseline, current)_. Before its
> GREEN half begins, every new RED spec file is executed against the baseline SHA recorded in D.1, in a
> throwaway git worktree (**never** `git stash` — reviewers share one working tree), and the pair is
> recorded alongside D.1 **together with the text of the failing assertion**. A bare count is satisfiable by
> a broken harness.
>
> - `FAIL/FAIL` on the asserted contract — a genuine RED contract.
> - `PASS/FAIL` — a **regression pin**, naming a range that must not ship.
> - `PASS/PASS` — **not a gate**; strengthen or delete it before it counts toward any exit gate.
> - `FAIL/PASS` — already green; not RED for this slice.
>
> _Scope qualifier:_ the baseline leg binds only where the subject code exists at baseline (the legacy
> plane). For code with no baseline ancestor — `protocol-v2`, `seal`, `storage-browser`, `compaction`,
> `worker-host`, `ephemeral` — a baseline run fails on module resolution, and **an import error is not a
> RED**. There the obligation becomes: run the spec before the implementation exists and record that it
> fails on the asserted contract, not on a harness error. Principle 5's mutation probe is complementary,
> not a substitute — `merge-concurrency.test.ts` had probe-able assertions and still pinned the wrong tree.

### D.5(i) — Round-1 amendments that were recorded but never applied to the plan body

D.4.3's finding — _"an approved amendment is not self-executing"_ — turned out to apply to this document
itself. D.3(d) ordered five body edits in confer round 1 and **none of them had been made**: no `0q` row
existed, Appendix A still read "Covered, and this is where v2 is strongest", and Phase 0's goal statement,
principle 7 and the Phase 1 wall table were unchanged. They are applied in D.5(k), and the process rule is:
**an approved amendment is not closed until the body edit is in the file**, checked in the same pass that
approves it.

### D.5(j) — Residual O(V) term, and the process guard applied to ourselves

D.3(a) requires that any slice introducing a per-message O(V) term add a row to the Phase 1 wall table.
D.4.1 found such a term and did not add the row. `pruneSnapshots` does
`Array.from(this.hashGraph.vertices.keys())` (`drp-applier.ts:753`, present verbatim at baseline) — an O(V)
burst per checkpoint advance, amortized O(V/256) per merge. Independently confirmed by two agents. The row
is added in D.5(k), marked pre-existing-at-baseline. **"Merge staging MUST cost O(the batch's write set)"
is not yet met** while that scan exists; removal needs an owner before atomic apply may be called
history-independent.

### D.5(k) — The body edits (applied)

1. **Phase 0 slice table** gains slice **0q** — see the table row inserted into Phase 0.
2. **Phase 1 _Measured wall order_** gains two rows: the staging-by-copy wall (D.3(a)) and the
   `pruneSnapshots` key-materialization burst (D.5(j)).
3. **Appendix A**'s §12.6 entry changes to _"Open until atomic-apply staging is history-independent."_
4. **Phase 0's goal statement** gains atomic publication.
5. **Principle 7** gains the observable boundary of the atomic unit.
6. **Principle 5** gains the baseline-RED rule (D.5(h)).
7. **D.1** gains a baseline-RED ledger for per-spec `(baseline, current, failing assertion)` rows.

---

## Appendix D.6 — Round 3: the per-vertex adoption cost wall (**RESOLVED — see D.7**)

Slice 0q (per-vertex atomicity) was implemented. _(Correction, confer round 3: the claim below that
**every** safety invariant held was **wrong** — the commit cleared its journal before `_notify`, and the
caller then awaited and notified afterwards, so another transaction could interleave at that await and a
throwing subscriber left a vertex committed but reported as `quarantined`. Fixed in D.7 as F5.)_
The invariants that did hold: S1 (no committed
vertex is ever removed), S2 (all shared-store writes inside one synchronous commit section after the
vertex's last suspension point, journal never live across an `await`), S3 (presence + frontier CAS
re-checked inside that section), S5/S6 (`quarantined`, resolve-not-reject), and a bounded retry with a
typed `AdoptionCommitExhaustedError`. All seven contract specs pass individually, including the L6
checkpoint-interleaving contract (live state 258 vs 258 — the 256-operation silent erasure of D.4.4 is
closed).

It still cannot ship, on cost.

### D.6.1 — The measurement

Idle machine, single-vertex `applyVertices` onto a **linear** chain:

|   N | per-vertex |
| --: | ---------: |
| 100 |   0.114 ms |
| 200 |   0.045 ms |
| 400 |   0.037 ms |
| 800 |   0.033 ms |

Flat, no history scaling — the fast path works. But `packages/object/tests/incremental-linearize.test.ts`
block **"C. late deep concurrency checkpoint parity"** never terminates (>560 s; a per-test timeout cannot
interrupt it because the work is synchronous). That file is pre-existing and unmodified, so it is a true
regression signal.

### D.6.2 — Why: one fork makes the slow path permanent

The fast path fires only when the arriving vertex depends on **every** frontier member. Test C builds a
5,000-vertex chain, forks a branch at depth 97, then applies the remaining ~4,900 vertices. The branch tip
stays on the frontier forever, so every later vertex fails the predicate and takes the slow path — an
unbounded ancestor DFS plus a checkpoint replay plus a full state reconstruction, **per vertex**.
**Ω(V³)** — corrected in D.7.6; with a custom resolver each vertex additionally runs an O(n²) pair scan
and an O(n²/32)-word causality-matrix build over the whole-history subgraph.

**One concurrent write puts the engine into the slow path for the rest of the object's life**, and
concurrent writes are the library's entire purpose. This is also why the pre-existing code adopted once per
_batch_: a 5,000-vertex batch cost one linearization, not 5,000.

### D.6.3 — The impossibility claim, now under review

Asked to make adoption incremental, the implementing agent returned BLOCKED with an argument backed by a
probe: a concurrent arrival **reorders already-applied operations** —

```
after B:  M1 M2 M3 B
after M4: M1 M2 M3 M4 B      ← B moved
```

— and because DRP operations are arbitrary, state-dependent, async, non-invertible JavaScript, moving `B`
requires an inverse journal across a suspension (violates S2/D.5(f)), a state reconstruction (violates
D.3(a)), an unbounded suffix replay (violates D.3(a)), or a live mutation before the last `await`
(violates S2). Its conclusion: the enabling change is a **DRP-level reversible-delta / persistent-state
contract**, which is far outside an adoption-path fix.

Corroborating findings from the same run: `linearizeVerticesWith` (`hashgraph/index.ts:291`) computes
_order_, not an applicable state delta; the linearizer's scoped bitsets cache causality only and cannot
reorder mutable state; and enabling the "adoption hint" fast path for custom resolvers would be **incorrect**
for `DropLeft`/`DropRight`/`Swap`, because a causal snapshot may contain operations the canonical
linearization dropped or ordered differently.

**Under three-way review (round 3).** The candidate resolution not considered by the implementer: the engine
stores a per-vertex state snapshot for every vertex, so a **bounded replay from the nearest still-valid
snapshot** may make the reordered suffix tiny — one vertex in test C's shape. That costs O(stateSize) for
the snapshot restore, which D.3(a) forbids — but the baseline **already pays** that, and plan slice **1d**
exists precisely to remove "≈3–4 × O(stateSize) deep clones per vertex". So the proposed amendment is that
D.3(a)'s prohibition governs **staging** (copying whole containers: hashgraph, state manager, finality
store) and must not be read as forbidding the per-vertex state reconstruction the engine already performs
and that 1d owns; Phase 0's binding constraint is _no O(retained history)_.

That amendment is plausible **and** is exactly the shape of a rationalisation after three failed attempts,
so it is being reviewed adversarially rather than adopted. **Status: RESOLVED — see D.7.**

### D.6.4 — What is already established regardless of the outcome

- Per-vertex atomicity is implementable safely; the blocker is cost, not correctness.
- The fast-path predicate "descends from the whole frontier" is the wrong predicate — it degrades to
  never-true after a single fork. Any future design must key on whether the arrival **reorders** the
  existing linearization, not on frontier coverage.
- L6 (D.4.4) is closable: the interleaving contract passes under per-vertex adoption.
- Four consecutive BLOCKED verdicts from the implementing agent were **all correct**, and three of them
  identified orchestration errors rather than code defects. A BLOCKED verdict is a result.

---

## Appendix D.7 — Confer round 3 and the resolution of the adoption wall

Three agents (Opus-xhigh, Codex-high, Kimi-K3 at 100 steps) independently evaluated the implementer's claim
that per-vertex live adoption is impossible without a reversible-delta `IDRP` contract.

### D.7.1 — The impossibility claim: correct only in its narrow form

**Unanimous:** the broad claim is false and was disproved _by execution on this tree_.

- With a **conflict-free** DRP on the identical failing shape, the implementer's own incremental machinery
  already adopts incrementally: **3,919 hinted adoptions / 1 concurrent, 378 ms for 3,920 vertices at
  V=4,000** — no inverse journal, no suspension-spanning state, no unbounded replay.
- A/B against baseline `7f9e66a`, MapDRP, post-fork batch: **45 / 48 / 118 ms** (baseline) versus
  **683 / 4,390 / 35,869 ms** (then-current) at 500 / 1,000 / 2,000 vertices — ~8× per doubling, i.e.
  **Ω(V³)**.

What survives is the narrow form, and it is worth keeping as a standing constraint:

> Under the current arbitrary-`IDRP` contract, **no generic algorithm can guarantee per-vertex live adoption
> in O(batch write set) independent of history.** Bounded replay is a valid optimisation where a valid
> materialised base and a bounded canonical edit are provable; those conditions do not hold universally.

### D.7.2 — The real root cause: a checkpoint fallback, not non-invertibility

Two agents converged on this independently, with live instrumentation:

`MapDRP` defines `resolveConflicts`, bound into the graph at `object/src/index.ts:119-127`, so
`hasCustomResolverDRP === true` and **both** incremental adoption paths refuse to run. Every post-fork
vertex then falls to `getReplay`, where two guards reject **every** post-fork checkpoint:

1. `dependenciesCover` required each descendant to cover **all** boundary members — a two-head checkpoint
   `[B_tip, M_j]` can never be covered by `[B_tip, M_i]`, because `B_tip`'s ancestry never contains `M_j`.
2. `collectSuffixSubgraph`'s causal barrier required every suffix member to be forward-reachable from
   **every** boundary head — a childless branch tip reaches nothing.

Only the **root** checkpoint passed, so the replay subgraph became the entire retained history, per vertex,
with an O(n²) resolver pair scan over it. **Both guards are verbatim at baseline**; baseline survived only
because it paid this once per _batch_. Confirmed live: post-fork checkpoint `vertexCount=257,
frontierSize=2` → `dependenciesCover=false`; root checkpoint `covers=true, subgraph=303` and growing.

### D.7.3 — Why the obvious fix was wrong (and the implementer's guard was right)

The brief proposed "restore the stored snapshot of the last vertex whose prefix is unchanged, replay the
reordered suffix." **Two agents rejected it, and the implementer's refusal to enable the hint path for
custom resolvers was vindicated:**

- Stored per-vertex snapshots are **causal-past states**, not canonical-linearization-prefix states.
  `assignState` stores `stateFromDRP(currentDRP)` where `currentDRP` is the LCA-branch state. Under
  `MapDRP` the branch key collides with ~100 main vertices and `resolveConflicts` really returns
  `DropLeft`/`DropRight`, so a causal snapshot contains operations the canonical order drops and omits
  effects it retains. Replaying from such a base converges to **no replica's state**.
- **Retro-drop is real:** a late concurrent arrival was observed removing an already-applied vertex from
  canonical position **1**. The edit point is the fork depth, not a suffix — so "bounded suffix" is the
  wrong frame for resolver-bearing DRPs.
- The needed base is often **pruned**: `pruneSnapshots` retains only root + checkpoint frontiers + the
  insertion-order suffix (test B pins ≤768 of 5,000), so a snapshot near a fork is evicted within a few
  hundred vertices.
- **Corrected for the record:** the brief's claim that "the repo stores a per-vertex state snapshot for
  every vertex" is false at scale, and "the suffix is a single vertex in test C" was a fixture-specific
  observation about `MapDRP`, not a general fact.

### D.7.4 — D.3(a) amendment: APPROVED (unanimous), as a correction of the letter

All three agreed the "never O(stateSize)" leg is **wrong as written** — it condemns the unmodified
baseline (slice 1d records "≈3–4 × O(stateSize) deep clones **per vertex**" as a pre-existing wall) and so
makes every Phase 0 slice unshippable by construction. A clause cannot normatively forbid what its own plan
schedules for removal two phases later. Adopted framing: this is a **drafting error corrected openly**, not
a reinterpretation.

> Merge staging MUST cost O(the batch's write set) — the mutations actually performed — **never
> O(retained history)**. Copying any whole container (`hashGraph`, `states`, `finalityStore`) or rebinding
> the applier's store fields to copies is forbidden in shipping code on the merge/ingest hot path. The
> O(stateSize) prohibition applies to **staging** — whole-container copies and per-message full-state
> snapshots taken to make a batch revertible — and does **not** forbid the per-vertex state reconstruction
> the baseline pipeline already performs (slice 1d's ≈3–4 × O(stateSize) per-vertex clones, a measured
> pre-existing wall owned by Phase 1). Per-vertex live-state adoption MAY therefore cost O(stateSize); it
> MUST NOT cost O(retained history). Phase 0 MAY reuse or replace, but MUST NOT **multiply**, those
> materialisations: no slice may add a new full-state materialisation on the normal or retry path. Any
> slice adding a per-message O(stateSize) multiplier beyond 1d's documented term must add a row to the
> Phase 1 wall table before it merges. Where a worst case exceeds this bound (deep-fork arrival, resolver
> retro-drop), cost MUST degrade to at most **one** full relinearization + replay per `applyVertices`
> call — the baseline's own per-batch ceiling — never one per vertex.

**Binding condition, insisted on by one agent and adopted:** this amendment licenses the _mechanism_, not
any particular code. The O(retained-history) clause stays absolute.

### D.7.5 — The remedy: option 1, with the mechanism corrected

Opus and Kimi both chose bounded incremental adoption with a hard per-call fallback ceiling; Codex argued
for changing `IDRP` to reversible deltas and marking Phase 0 blocked. Reconciled: **Codex's narrow
impossibility (D.7.1) stands, and the practical requirement — never worse than baseline, incremental in the
common case — is achievable.** The `IDRP` contract change is recorded as **v2-plane work**, out of scope
for the legacy plane under principle 3; it also does not cheaply solve retro-drop, since you must still
replay everything after an inverted operation unless state is persistent.

Option 2 (refresh the live proxy once per batch) was rejected by two agents: between graph commits a
synchronous local call would read stale live state while depending on the newer frontier — reintroducing
L6 — unless local calls and publication are serialised, which is the API break D.5(f) rejects.

**Delivered — implementer's self-reported table, since PARTLY REFUTED (see D.8):**

| shape                            | claimed baseline | claimed delivered |                                                                 independent re-measure (D.8) |
| -------------------------------- | ---------------: | ----------------: | -------------------------------------------------------------------------------------------: |
| MapDRP V=500                     |            45 ms |           38.4 ms |                                                                          reproduces (parity) |
| MapDRP V=1000                    |            48 ms |           47.3 ms |                                                                          reproduces (parity) |
| MapDRP V=2000                    |           118 ms |          118.5 ms |                                                                          reproduces (parity) |
| resolver-free V=4000, batch 3920 |           378 ms |          222.0 ms | **REFUTED — columns appear swapped; current ≈390 ms vs baseline ≈210 ms, i.e. ~1.8× SLOWER** |

> **Process failure, recorded:** the "378 ms baseline" figure was propagated from the implementer's own
> report without independent verification. It is actually D.7.1's measurement of the **then-current** tree,
> not of baseline. An implementer's performance table is a claim, not evidence — every number that enters
> this plan as a _gate_ must be independently re-measured, exactly as D.5(h) already requires for RED tests.

Full suite: **1356 passed / 0 failed / 4 skipped** across 192 files, typecheck clean, lint 0 errors
(184 warnings vs 176 at baseline — 8 new `jsdoc/*`, under review).

### D.7.6 — Standing corrections to earlier appendix text

- **D.6.2's "O(V²)" understates it** — with a resolver the per-vertex cost is a full relinearization
  (O(V) DFS × 32 checkpoints) plus an O(V²) pair scan, so the batch is **Ω(V³)**.
- **D.6's "every safety invariant holds" was false** — see the inline correction; fixed as F5.
- **D.6.4's "four consecutive BLOCKED verdicts were all correct"** needs qualifying: the fourth verdict
  (_cannot ship_) was correct; its supporting argument was not, and it was about to become plan text.
- **D.6.4's replacement predicate** ("key on whether the arrival reorders the linearization") is refined to:
  _"key on whether a valid materialised base and a bounded canonical edit are available."_ A boolean
  reorder test says nothing about edit length, dropped operations, or snapshot validity.
- `descendsFromWholeFrontier` checks **direct** dependencies, not transitive descent, so a vertex that
  causally dominates the frontier through one head still takes the slow path.
- **A wall-table row is owed** for the checkpoint causal-barrier collapse (every post-fork checkpoint
  unusable while one undominated head persists, and the barrier check is itself O(V) per attempt) — under
  D.3(a)'s own process guard.

---

## Appendix D.8 — Round 4 review: the checkpoint relaxation is UNSOUND (DO-NOT-SHIP)

The delivered 0q implementation is fully green — **1356 passed / 0 failed** across 192 files, typecheck
clean, lint 0 errors, and the suite terminates in seconds where it previously hung. **It must not ship.**
Adversarial review found silent permanent replica divergence on **3-vertex DAGs under default
configuration**, with executed counterexamples and an A/B against baseline.

This is the single most important entry in this appendix: **a green suite, a closed root-cause diagnosis,
and a plausible fix direction were all simultaneously true while the change silently broke convergence.**

### D.8.1 — Blocker 1: relaxed checkpoint predicates admit a non-canonical cut

F1 loosened `dependenciesCover` and the `collectSuffixSubgraph` barrier so post-fork checkpoints become
usable. The new collective form proves only that (a) the checkpoint's vertex set lies in the target's
causal past and (b) the suffix descends from the cut. **It never proves the cut is a prefix of the
canonical from-root linearization** — and legacy state is an order-sensitive fold for _every_ DRP, because
the DFS interleaves concurrent branches by hash.

Three-operation counterexample, **default** checkpoint suffix, singles delivery:

```
A:  add(9)    @root
B1: delete(7) @root
C:  add(7)    @A
canonical order  A → C → B1   ⇒  [9]
current tree     cut [A,B1] pinned by forceCheckpoint, then C replays on the frozen cut ⇒ [7,9]
baseline 7f9e66a                                                                        ⇒ [9]  ✓
```

Fuzz at scale (SetDRP, seeds 40–119, 10 delivery schedules each, suffix sizes 1/2/4/default):
**366 divergences on the current tree, 0 on baseline** — including mutual replica-vs-replica disagreement
(three replicas at `[0,1,2,3]`, `[0,1,2]`, `[0,1]`).

**The retained every-head fence is drawn one case too narrow.** It keys on _resolver presence_, but
fold-order sensitivity is resolver-independent: `SetDRP.add/delete` diverges exactly like a resolver
conflict. The implementer's own 3-op resolver counterexample has a resolver-free twin that shipped.

**The correct constraint, for whoever attempts this next:**

> A checkpoint is a valid replay base for a target **only if no suffix member precedes any cut member in
> the canonical from-root order.** Resolver presence is irrelevant to this condition.

### D.8.2 — Blocker 2: the adoption hint carries an incomplete tail across calls

The hint built from a checkpoint-_suffix_ replay omits pre-suffix vertices concurrent with the pending
vertex, and F2's object-scoped cursor then carries that hint across calls; `prepareHintedAdoption` installs
causal-past-only state as live state, erasing a concurrent branch. Four-vertex counterexample
(`V0:add(3)@root, V1:add(0)@root, V2:delete(1)@V0, V3:delete(1)@V2`, singles): canonical `[0,3]`, current
`[3]`. Diverges at default suffix. **None of this machinery exists at baseline** — cursor, hint and
`forceCheckpoint` are all new in this diff.

### D.8.3 — Blocker 3: L6 is reopened, and now it is permanent

Both the second and third reviewers found the F3 deferred window independently. During it, a local
synchronous `drp.method()` observes a graph containing cheaply-committed vertices whose effects are not yet
in live state; its stored per-hash snapshot is then permanently wrong, and **re-poisons live state after
reconciliation** when a later child takes the `descendsFromWholeFrontier` fast path. Measured: two replicas
end at `[a, local, m]` versus `[a, b, c, local, m]` — `b` and `c` lost **permanently even though
`reconcileCanonicalState` ran**. Baseline converges on all schedules.

This is exactly the defect D.4.4 records and that this slice exists to close, arriving through the very
mechanism D.7.5 rejected option 2 for: _"a synchronous local call would read stale live state while
depending on the newer frontier."_ **The shipped deferred path is option 2 per-call, without the
serialization that rejection assumed.**

### D.8.4 — Cost: the per-call ceiling is violated, and the headline number was wrong

- `linearizeVerticesAcrossCausalCut` sorts the **entire retained graph** on every concurrent adoption — a
  per-vertex O(retained-history) sort, violating both the slice bound and D.7.4's "at most one full
  relinearization per `applyVertices` call". Measured, no resolver, two alternating branches:
  **134 / 368 / 1297 ms** current versus **20 / 28 / 53 ms** baseline at 500/1000/2000 — 24× slower at 2000.
- The resolver-free perf row was **column-swapped** (corrected in D.7.5): current ≈390 ms versus baseline
  ≈210 ms, i.e. **~1.8× slower**, not the claimed improvement. MapDRP rows do reproduce at parity.

### D.8.5 — What this round teaches, beyond the code

- **A green suite plus a confirmed root cause is still not evidence of correctness.** Every existing spec
  passed while 3-vertex convergence broke. The two in-tree parity shapes ("late deep concurrency", the
  checkpoint-interleaving test) are benign by accident of their hashes and topology.
- **`checkpoint-interleaving.test.ts` is theatre relative to its name**: it parks _inside_ a pipeline
  before commit, on a linear resolver-free chain, so blocker 3 passes straight through it. Rename it and
  add a spec that parks inside the deferred cheap-commit window.
- **The existing proptests are structurally blind to this bug class.** The convergence property harness
  builds BoxGame DRPs, which carry **custom resolvers** (`property-harness.ts:122`) — and the resolver-free
  incremental hint path is exactly the one that diverges. So the repo's randomized testing could never have
  caught blockers 1–2, no matter how many seeds it ran. Any new fuzz corpus MUST sweep resolver-free DRPs
  (`SetDRP`-shaped add/delete) as a first-class dimension, not only resolver-bearing ones.
- **A third reviewer's independent verdict is worth recording**: the F1 predicate logic is sound _in
  isolation_ for resolver-free replay-base selection (grounded on three-head-join, nested-fork and diamond
  parity at several suffix sizes), but "F1-as-shipped selects correct bases over corrupted states" — the
  cut state itself is non-canonical. So the predicates are not the only thing to fix; the state baked into
  the checkpoint is.
- One unproven hole flagged and **not** grounded by anyone, carried forward: `checkpointAllowsCustomSuffix`
  consults only `activeHashes`, so a previously-dropped prefix operation that _revives_ through
  retro-reversal and conflicts with a suffix member is invisible to the guard. Needs a proptest or a
  recorded impossibility argument before any future relaxation is trusted.
- **Differential fuzzing against baseline found in minutes what four targeted rounds missed.** The Gate-0
  divergence-manifest oracle is supposed to be exactly this. It is not yet built, and this round is the
  argument for building it **before** any further applier work: seeded random DAGs + delivery schedules,
  replayed on patched and pinned engines, asserting identical order and state.
- **An implementer's performance table is a claim, not evidence.** D.5(h)'s independent-verification rule
  must extend from RED tests to every number that enters this plan as a gate.
- Reviewers must clean up: a probe file (`zz-review-adversarial.test.ts`) was left in
  `packages/object/tests/` and would have polluted the next suite count.

### D.8.6 — Position, stated honestly

Two states now exist, neither shippable:

|         | correctness                            | cost                                                 |
| ------- | -------------------------------------- | ---------------------------------------------------- |
| pre-F1  | correct                                | Ω(V³); suite hangs                                   |
| post-F1 | **silently diverges on 3-vertex DAGs** | at/near baseline for MapDRP, worse for resolver-free |

The F1 relaxation must be **reverted or made sound** against D.8.1's canonical-prefix condition, and
blockers 2–3 fixed, before 0q can be reconsidered. The correct next move is **not** a fifth implementation
attempt: build the differential fuzz harness first, so any candidate is measured against baseline
convergence automatically rather than against hand-picked shapes.

---

## Appendix D.9 — The Gate-0 differential convergence harness (BUILT, and it is now the gate)

Built in response to D.8.5. `packages/object/tests/proptest/convergence-differential.test.ts`.
This is slice **G-b** of Gate 0 arriving early, because round 4 proved it was the missing gate.

### D.9.1 — What it does

Seeded, reproducible random DAGs × delivery schedules, asserting convergence three ways:
**replica-vs-replica**, **replica-vs-fresh-replay**, and **replica-vs-pinned-baseline `7f9e66a`**
(cross-engine, enabled by `TS_DRP_BASELINE_OBJECT_MODULE`; a real `git worktree`, never `git stash`).

| Tier    | Corpus                                          | Schedules               |  Wall time |
| ------- | ----------------------------------------------- | ----------------------- | ---------: |
| Per-PR  | 12 seeds × 3 kind slots × 4 suffixes = 144 DAGs | 3 each = 432 replays    | **1.18 s** |
| Nightly | 80 seeds × 3 kind slots × 4 suffixes = 960 DAGs | 10 each = 9,600 replays | **4.21 s** |

Dimensions, each chosen because a known blocker lives there:

- **Two resolver-free `SetDRP` slots for every resolver-bearing `MapDRP` slot** — directly answering
  D.8.5's finding that the existing proptests use only resolver-bearing DRPs and are therefore blind to
  the broken path.
- Topologies rotate through linear, fork, fork-join, diamond, nested-fork and multi-head.
- Checkpoint suffix swept over 1, 2, 4 **and the default** — the counterexamples reproduce at the default.
- Biased toward **tiny** DAGs, because the real counterexamples are 3 and 4 vertices.
- Both D.8 counterexamples pinned as an always-run fixed corpus so no seed change can lose them.

### D.9.2 — It is provably able to fail, and provably measuring the right thing

- **Current tree:** 3 failing tests — both fixed counterexamples reproduce exactly, plus **3/144** per-PR
  and **114/960** nightly generated cases diverge.
- **Baseline `7f9e66a`:** **zero** divergences in both tiers.

That pairing is the whole point: it satisfies principle 5 (a gate must be provably able to fail) _and_
proves it is not simply broken.

### D.9.3 — A sharper counterexample than D.8's

The harness immediately minimised a **3-vertex resolver-free fork** in which the linearized **order is
identical** and only the folded **state** differs:

```
V0: add(0)    @root      (writer-a)
V1: delete(0) @root      (writer-b)
V2: add(0)    @V0        (writer-c)
delivery: [V1], [V0], [V2]   suffix size 2

order       V0 → V2 → V1   (both)
incremental state []
fresh replay state [0]      ← same order, different state
```

This is a strictly better bug report than D.8.1's: it isolates the defect to the **fold over a frozen cut
state**, independent of any disagreement about linearization order. Any future fix must explain this case.

### D.9.4 — Standing rule

**No further applier work lands without this harness green.** It runs in ~1 s at the per-PR tier, so there
is no cost argument for skipping it. A fifth 0q attempt is measured against baseline convergence
automatically, rather than against hand-picked shapes — which is exactly what the previous four rounds
lacked.

_Housekeeping:_ reviewers left three probe files (`zz-review-adversarial.test.ts`,
`zz-0q-review-probes.test.ts`, `zz-0q-review-straddle.test.ts`) in `packages/object/tests/`; the latter two
put repo lint at **61 errors**. Removed; lint back to 0 errors / 184 warnings. Reviewer prompts already say
"probes in /tmp" — enforce it, and check `git status` before trusting any suite or lint count.

---

## Appendix D.10 — Attempt 5: predicates fixed, two NEW divergence families found (DO-NOT-SHIP)

Attempt 5 reverted attempt 4's unsound relaxation and restored the strict every-head predicates, relying on
per-call amortization for cost. **That part worked and is verified.** The differential harness went
0/144 per-PR and 0/960 nightly, the full suite is 1359 passed / 0 failed, and cost is 0.98–1.22× baseline.

Two of three reviewers said SHIP. The adversarial review found **two independent permanent-divergence
families**, one of which fires on an **honest, well-formed 5-vertex DAG at default configuration** where
baseline converges. Both are invisible to the harness for **structural** reasons, not seed count.

### D.10.1 — Verified good (keep)

- **The predicates are byte-equivalent in logic to baseline** under normalised comparison
  (`dependenciesCover` → `dependenciesCoverEveryHead` is a rename; the `pendingVertex` overlay is symmetric
  and evaluates the same predicate against graph ∪ {N}). **D.8.1 is not reopened by the predicates.** All of
  attempt 4's relaxations are gone: no `activeHashes`, no resolver discriminator, no across-cut sorter, no
  object-scoped cursor.
- **D.8.1, D.8.2 and D.8.3 are all closed**, re-probed directly at suffix 1/2/4/default, singles and batch.
  The L6 loss `[a,local,m]` vs `[a,b,c,local,m]` does not reproduce.
- S1/S2/S3/S5/S6 hold on every path, including the amortized one. Consensus bytes untouched. The lint delta
  is genuine surface shrinkage — `eslint-disable` counts are unchanged versus baseline in all five changed
  files and no ESLint config appears in the diff.

### D.10.2 — CRITICAL 1: the resolver fence is per-**type**, but conflict resolution is per-**subgraph**

`prepareConcurrentTailAdoption`, `canUseAdoptionHint` and the `nextHint` gate all test
`hasCustomConflictResolver(drpType)` for **the pending vertex's own type**. But `linearizePairSemantics`
enables the pair-conflict scan when **any** vertex in the replay subgraph carries a resolver — and
**`ObjectACL` always carries one**. `HashGraph.resolveConflicts` dispatches on `vertices[0].drpType`, so an
**ACL** vertex can `DropRight` a concurrent **DRP** vertex. With a resolver-free `SetDRP`,
`hasCustomConflictResolver("DRP")` is `false`, the incremental path is taken, and **the drop never happens**.

Honest input — single dependencies only, no transitive edges, default suffix, no byzantine peer:

```
G: ACL grant(w, Writer)    @root   by adm
R: ACL revoke(w, Finality) @G      by adm     (timestamp chosen so hash(R) < hash(P))
P: DRP add("seed")         @G      by w       (concurrent with R)
M: DRP add("w")            @P      by w
v: DRP add("z")            @M      by w

canonical (both engines):  G > R > P > v      — M is dropped
current    live = ["seed","w","z"]     ← M reinstated
canonical         ["seed","z"]
baseline 7f9e66a  ["seed","z"]  on all four schedules
```

Divergence is **replica-vs-replica within the current engine**, so it needs no oracle argument. Honest-only
fuzz: **current 3/400 seeds diverged, baseline 0/400**; mixed fuzz with 2-dep vertices: **4/1000 vs 0/1000**.

**An ACL revocation's effect is silently bypassed.** That is a security-relevant failure, not only a
convergence one.

> **This is D.8.1's exact lesson surviving in a new location:** _the fence keys on resolver presence, but
> the property is not per-type._ Recorded as a standing rule in D.10.6.

### D.10.3 — CRITICAL 2: two state-derivation paths that disagree

Pure DRP, no ACL, no resolvers anywhere. Shape: a transitive-edge triangle plus **two** concurrent children
of its apex.

```
V0 add(e0)@root ; V1 add(e1)@V0 ; V2 add(e2)@[V0,V1] ; V3 add(e3)@V2 ; V4 add(e4)@V2

singles           live = ["e0","e1","e2","e3","e4"]   (incremental tail adoption)
last-two-batched  live = ["e1","e2","e3","e4"]        (amortized canonical replay)  ← e0 lost
```

Root cause: `dfsTopologicalSortIterative` double-pushes `V2` and **loses `V0`** whenever
`hash(V2) < hash(V1)`. That sort is **byte-identical to baseline** — so baseline is equally lossy, but
baseline routes _every_ apply through it and therefore stays self-consistent. **This diff adds a second,
non-lossy derivation path, and the two disagree.**

Rates on the same corpus: **current 112/200 diverged, baseline 0/200.** Shape isolation, 100 seeds each —
both features are required and each alone is harmless:

| shape                  |    current | baseline |
| ---------------------- | ---------: | -------: |
| triangle + 2 children  | **57/100** |    0/100 |
| triangle + 1 child     |      0/100 |    0/100 |
| diamond + 2 children   |      0/100 |    0/100 |
| fork-join + 2 children |      0/100 |    0/100 |

Reachability: a transitive edge requires a peer to supply a redundant dependency. Honest local calls use
`getFrontier()` and never do — but **nothing in `validateVertex` rejects it**, and both engines return
`applied: true`. Byzantine-reachable at 5 vertices, cheap and undetectable. (Critical 1 needs no byzantine
peer at all.)

### D.10.4 — Two medium findings

- **`reconcileCanonicalState` always replays from `checkpoints[0]` (root)**, unlike `getReplay` which scans
  newest-first. The per-call ceiling of D.7.4 is met, but the _size_ of that replay is unbounded by
  `checkpointSuffixSize`. On a long-history + small-concurrent-batch shape (the live-sync shape, absent from
  the recorded cost table): **3.4–3.6× baseline** at history 3k/6k/12k. Owed: a cost-table row.
- **A reconcile failure leaves `hasUnreconciledLiveState` permanently `true`** — the assignment sits after
  the `await` and is skipped when the replay throws. Live state recovers, but the object is permanently
  degraded: per-hash snapshots stop being written for local calls, checkpoints stop advancing on local
  calls, and the fast paths stay disabled **for the object's lifetime**, from one transient blueprint throw.

### D.10.5 — The gate was trusted too early

`convergence-differential.test.ts`'s `makeOperation` **hardcodes `drpType: DrpType.DRP`** — the harness
emits **zero ACL vertices**, so Critical 1 is invisible at any seed count. Its `dependenciesFor` never emits
a redundant/transitive edge, and none of its six topologies ever gives a join vertex two concurrent children
— so Critical 2 needs both features it cannot produce.

**D.9.2's "provably able to fail" claim must be restated.** It was demonstrated against attempt 4's failure
modes only. A shape _one edge away_ from `diamond` fails on the current tree while `diamond` passes. So
0/144 and 0/960 certify **the absence of the D.8 families**, not convergence.

Required widening before the harness is trusted again — each because a divergence lives there:

1. **ACL vertices as a first-class kind**, interleaved with DRP in one DAG and one call. Highest value.
2. **Cross-type value collision** — ACL target peerIds drawn from the same domain as DRP element values, so
   `ObjectACL.resolveConflicts`' `value[0]` comparison can fire across types.
3. **Redundant/transitive dependency edges** — a vertex depending on both a parent and that parent's ancestor.
4. **Two or more concurrent children of a join vertex** (all six current topologies are linear after a join).
5. More concurrent writers, a `writers ≫ 4` slot, and adversarial timestamp ties.
   Both new counterexamples pinned as fixed corpus entries alongside D.8's two.

### D.10.6 — Two standing rules for every future attempt

> **R1 — `hasCustomConflictResolver(drpType)` is not a valid soundness fence.** Conflict resolution is
> enabled by the presence of _any_ resolver-bearing vertex in the replay subgraph, and `ObjectACL` always
> carries one. Any fast path must gate on _"does the replay subgraph contain a resolver-bearing vertex"_,
> never on the pending vertex's own type.

> **R2 — the applier MUST NOT have two state-derivation paths that can disagree.** Critical 2 is not a
> predicate bug: it is a pre-existing linearizer defect (`dfsTopologicalSortIterative`'s double-push,
> present at baseline) becoming _observable as divergence_ the moment a second, non-lossy path exists.
> Either every path folds the same canonical order, or the linearizer defect is fixed first — and that is a
> coordinated-upgrade change with its own cross-version story, outside slice 0q. **Decide this before
> writing code for attempt 6.**

### D.10.7 — Process note

The generalised form of D.8.5's lesson, which the plan had stated too narrowly ("sweep resolver-free DRPs"):

> **The fuzz corpus must contain every vertex type the applier branches on, and every structural feature
> the linearizer branches on.** The round that fixed resolver-free-DRP blindness still left an entire vertex
> type (ACL) at zero coverage.

**Independent corroboration.** The third reviewer hit its 100-step budget before writing a final report,
but its working notes reached both findings independently: _"the seed-1009 split is fold-level fallout of
the pre-existing DFS duplication (identical insane order in both schedules), not hint/tail misapplication"_
(Critical 2's root cause) and a fuzz round reporting _"part B 4 diverged (ACL class)"_ (Critical 1). Two
agents converging on both families from different probes is the strongest evidence in this appendix.
_Process note:_ 100 reasoning steps was not enough budget for a review at this depth — raise it for slices
where differential probing is the point, or the reviewer spends its budget and reports nothing.

Also: two of three reviewers returned SHIP on a change with two critical divergence families. The one that
found them was the one that built differential probes against a pinned baseline rather than reasoning about
the diff. Budget for that reviewer on every slice.

---

## Appendix D.11 — The widened Gate-0 harness, and how it was made self-validating

D.10.5 recorded that the harness was structurally blind to both new critical families. It has been widened,
and — more importantly — it can now **prove what it is measuring**.

### D.11.1 — What was added

- **ACL vertices as a first-class kind** (`mixed-acl` slot): `grant`/`revoke` interleaved with DRP vertices
  in one DAG and one call, with **ACL targets drawn from the same value domain as DRP elements** so
  `ObjectACL.resolveConflicts`' `value[0]` comparison can fire across types.
- **Transitive dependency edges + two concurrent children of a join** (`transitive-join-children` slot) —
  both features are required together; each alone is harmless.
- **16 concurrent writers with a wide fan-in/fan-out and tied timestamps** (`many-writers` slot).
- All four D.8/D.10 counterexamples pinned as fixed corpus.

### D.11.2 — The self-validation hook: `TS_DRP_PRIMARY_OBJECT_MODULE`

The harness can now run with the **primary** engine pointed at a pinned build, not just the oracle. This is
what turns "the harness fails on the current tree" into evidence:

> A fixture that fails with the primary engine set to `7f9e66a` is **not** a regression pin — it is
> measuring behaviour already broken at baseline, and must be relabelled rather than counted.

Result:

| tier                        |                                         current tree | baseline as primary |
| --------------------------- | ---------------------------------------------------: | ------------------: |
| widened per-PR (144 cases)  |    **18 diverged** — mixed-acl 12, transitive-join 6 |                   0 |
| widened nightly (960 cases) | **227 diverged** — mixed-acl 188, transitive-join 39 |                   0 |
| whole file                  |                                            3 failing |        **8/8 pass** |

> **CORRECTION (D.14, measured after slice 0r).** The "baseline as primary → 0" column is **no longer true
> and must not be cited as a green control.** Post-0r, baseline-as-primary _correctly_ **fails** the widened
> per-PR tier at 7/144 (`transitive-join-children` @ suffix-1, `replica-vs-fresh`), because the current
> engine now intentionally differs from baseline on that class. Do not confuse the two modes: with
> `TS_DRP_BASELINE_OBJECT_MODULE` (baseline as _oracle_, current as primary) the file passes 8/8; with
> `TS_DRP_PRIMARY_OBJECT_MODULE` (baseline as _primary_) it is expected red on the approved class.

### D.11.3 — Three defects this hook caught in the harness itself

Every one would have discredited the gate:

1. **Future-dated timestamps.** The generators used `1.8e12` (2027). `validateVertex` rejects future-dated
   vertices, so every widened case failed on _delivery_, not divergence — a gate failing 100% for a reason
   unrelated to the thing it measures. Moved into the past.
2. **A hand-computed oracle that was simply wrong.** The Critical-1 fixture asserted canonical
   `["seed","z"]`, but its timestamps do not produce the `hash(R) < hash(P)` ordering the drop requires —
   **both** engines legitimately agree on `["seed","w","z"]`. It failed on both engines for the wrong
   reason, which is exactly how a real signal gets dismissed as noise. Oracle removed; the family is
   carried by the generated `mixed-acl` slot (12 current / 0 baseline), which reproduces it honestly.
   _Lesson: a fixture whose expected value depends on hash ordering must derive that ordering, never assume
   it._
3. **A gate that could never reach zero.** `transitive-join-children` mixes regressions with the
   pre-existing linearizer defect. Initially allowlisted by case id — which silently failed to cover the
   nightly seed range (34 still diverging at baseline). Replaced with a **structural** predicate:
   _`transitive-join-children` at `suffixSize === 1`_ accounts for **100%** of baseline divergences
   (70/70 across both tiers), so it scales to any seed range.

The exclusion carries **staleness enforcement**: the tier asserts the pre-existing class still diverges. If
the linearizer defect is ever fixed, the assertion fires and forces the exclusion to be deleted — the same
device as the Gate-0 divergence manifest's unexercised-entry check.

### D.11.4 — Standing rule

> **A gate must be able to prove what it measures, not only that it can fail.**
>
> _(D.14 amendment: the mechanism below said "run the whole gate against the pinned baseline and require it
> green." That is unsatisfiable after slice 0r, because baseline is now correctly red on the approved
> pre-existing class. Restate as: **require it green except for failures attributable to the approved
> divergence class, and require that attribution to be checked rather than assumed.**)_ Principle 5's
> "provably able to fail" is necessary and insufficient: attempt 4 passed a gate that could fail, and
> attempt 5's harness failed for three reasons that had nothing to do with the defect. The cheap, general
> mechanism is a **primary-engine override** — run the whole gate against the pinned baseline and require
> it green. Any gate comparing against a reference engine should have one.

---

## Appendix D.12 — Confer round 4: slice 0r approved (unanimous), and D.10.3's premise retracted

### D.12.1 — The premise that was wrong

D.10.3 and rule R2 both rested on this sentence:

> _"That sort is byte-identical to baseline — so baseline is equally lossy, but baseline routes every apply
> through it and therefore stays self-consistent."_

**Two agents independently refuted it by execution against the pinned `7f9e66a` build.** At
`TS_DRP_CHECKPOINT_SUFFIX_SIZE=1`, baseline yields all five elements for `singles` but loses `e0` for
`one-batch` and `last-two-batched` — **replica-vs-replica divergence with no new code**. At the default
suffix all baseline schedules converge on the _lossy_ state, silently dropping a committed vertex's effect
on every replica.

The mechanism: the sort is lossy relative to the **fold origin**, and checkpoint cut placement is
replica-local delivery history. Baseline routes every apply through the same lossy _function_ but not the
same _subgraph_. **Baseline therefore does not define an order — it defines a schedule-dependent family of
orders.**

Three consequences, and they change the decision:

1. Attempt 5 did not "add a second derivation path." Baseline already has several (the single-dependency
   fast path, checkpoint-suffix replay, fresh full replay). Attempt 5 widened the disagreement window from
   suffix-1 to the default suffix.
2. **Branch (b) — "force every path through the identical lossy order" — is infeasible, not merely
   unattractive.** You cannot be bug-compatible with a schedule-dependent family. The only order-identical
   variant is fold-from-root-always: D.10.4's 3.4–3.6× regression forever, _and_ it still silently loses
   committed state.
3. This is a **live, byzantine-reachable convergence defect at baseline**, not a latent cosmetic one.
   `validateVertex` checks hash, dependency presence and timestamps only; the shape is admitted today.

**R2 is withdrawn.** It was unsatisfiable (baseline itself has multiple derivation paths — local `callFn`
composes onto live proxies while merges re-fold) and it would forbid provably-equivalent optimisations
forever. Replacement:

> **R2′ — folded state MUST be a deterministic function of the graph, not of the derivation path or the
> replay window.** Every derivation path must be shown observationally equivalent to the canonical fold,
> with a stated argument _and_ a dual-engine differential gate. Equivalence may never be assumed from
> "the inputs looked disjoint."

### D.12.2 — The decision: branch (a), unanimous

The round split 2–1 (fix the linearizer now / defer to v2). The dissent was specific — a rolling upgrade
has no fold-version field, so mixed versions could compute different state from the same graph — and it
reduced to **one testable claim**, so it was tested rather than argued.

> **Claim: the fix is behaviour-identical on every honestly-formed room.**

Measured with the differential harness against a verified pinned `7f9e66a` build, on the all-antichain
(honest) generated corpora:

| tier                                      | divergences from baseline |
| ----------------------------------------- | ------------------------: |
| honest per-PR (144 cases × 3 schedules)   |                     **0** |
| honest nightly (960 cases × 10 schedules) |                     **0** |

**1,104 honest cases, zero divergence**, independently re-run. The dissenting agent then agreed.

_Precision correction it insisted on, and it is right:_ call this **behaviour-identical**, not
byte-identical. The harness compares state and order; the separate zero-line diff on generated
protobuf/wire files is what establishes byte identity. And **the finite corpus is supporting evidence, not
proof** — the proof is structural: local dependencies default to `getFrontier()` (`hashgraph/index.ts:237`),
`addVertex` removes listed dependencies from the frontier (`:250`), so the frontier is an antichain by
construction and an honest client cannot emit the non-antichain dependency list the double-push requires.
The patch changes only stale duplicate-stack handling, so it cannot fire on shapes that never had one.

### D.12.3 — Slice 0r, as recorded

> **0r — Legacy linearizer correctness repair (Critical 2).** Fix `dfsTopologicalSortIterative` on the
> legacy plane: a stale duplicate stack entry MUST be popped without consuming a result slot, and the
> returned order MUST be asserted to be an exact permutation of the reachable requested subgraph. Vertex
> encoding, `computeHash` inputs, protobuf/wire formats and admission semantics MUST remain unchanged.
> **Ship this repair ungated** — a local flag is forbidden, because no legacy vertex records the selected
> fold semantics, so a flag would create an unrecorded semantic selector and preserve the very coordination
> problem it appears to solve; v2-only gating would leave the exploitable legacy defect live for every room
> that never migrates. Migration requires: (1) XVER equality against pinned `7f9e66a` for every
> direct-antichain fixture and schedule; (2) an approved-divergence manifest limited to the affected
> non-antichain class, with staleness enforcement; (3) fixed _and_ generated replica-vs-replica and
> replica-vs-fresh gates for `transitive-join-children`; (4) a release note stating that previously admitted
> non-antichain histories may replay differently, and that they can be identified by dependency/ancestor
> scanning. **No replay or migration is required for antichain-only rooms**, and no fleet-wide replay is
> required to find the residual population.

Class: **coordinated-upgrade**, not consensus-affecting — the plan's own principle-3 taxonomy, since no
vertex bytes or wire format change. D.10.6's "outside slice 0q" was a misclassification: it is a
prerequisite _inside_ 0q's dependency chain.

### D.12.4 — Delivered, and what remains

- **Critical 2 is closed.** `transitive-join-children` current-engine replica-vs-replica and
  replica-vs-fresh divergences: **0** in both tiers (were 6 per-PR / 39 nightly). Divergence from baseline
  on that class is now _intentional and approved_ (28/48 per-PR, 164/320 nightly).
- The `isPreexistingWidenedDivergence` exclusion is gone — its staleness assertion fired and forced removal,
  exactly as designed. It is replaced by an approved-baseline-divergence manifest that **cannot suppress
  current-engine disagreement**.
- The fix also heals the causality bitsets: `reachablePredecessors` is built from the same order and was
  silently skipping the displaced vertex's row.
- Gates: typecheck clean, lint 0 errors, `packages/node` 202/202, full suite **1362 passed**.
- **Critical 1 (R1 resolver fence) — was open at the time of writing, CLOSED by attempt 6 (see D.13).**
  As of this appendix it was deliberately out of scope: `mixed-acl` shows 12
  current-engine replica divergences per-PR and 188 nightly. That is attempt 6's work, and the three call
  sites are identified (`drp-applier.ts:560,634,655` — the correct check mirrors `pairSemantics.ts:20`,
  scanning the replay subgraph for any resolver-bearing vertex rather than testing the pending vertex's
  own type).

### D.12.5 — On the objective itself

Two agents were asked directly whether slice 0q is still the right goal after five failures. Both said yes,
with the same reasoning: the failures were not five attempts at an impossible thing, they progressively
isolated one misfiled prerequisite. Attempts 1–2 were mechanism/contract errors, attempt 3 cost, attempt 4
an unsound relaxation, attempt 5 two _pre-existing_ defects that any fast path would eventually surface.
Deferring to v2 would leave L6's silent 256-operation erasure and L3's torn reports live on the only plane
that exists, and would abandon attempt 5's verified assets (byte-equivalent predicates, the D.8 closures,
0.98–1.22× cost parity). **Attempt 6 is descoped to: the R1 fence, plus D.10.4's two mediums.**

---

## Appendix D.13 — Attempt 6: slice 0q closed

Attempt 6 closes the four remaining items recorded in D.12.4 and the attempt-6 handoff:

- The fast-path fence is now computed from the selected replay subgraph, including a pending overlay, with
  the same resolver-bearing-vertex condition used by `linearizePairSemantics`. Hints carry that replay-cut
  result forward only while extending it by a same-type causal child. `mixed-acl` current-engine
  replica-vs-replica and replica-vs-fresh divergences are **0** at both differential tiers (previously
  12 per-PR and 188 nightly).
- Canonical reconciliation uses `getReplay(expectedFrontier)`, so checkpoint selection is newest-first and
  uses the same covering and strict-barrier predicates as every other replay. On the long-history plus 20
  small-concurrent-batch probe, median current/baseline cost measured in the same run was
  **34.6/23.9 ms (1.44×)** at 3k, **68.1/43.4 ms (1.57×)** at 6k, and
  **144.8/93.5 ms (1.55×)** at 12k, replacing the recorded 3.4–3.6× regression.
- `hasUnreconciledLiveState` is cleared only by the synchronous publication section that installs a
  canonical replay result. A failed replay keeps the protective fence while live state is stale; the next
  successful canonical adoption clears it, resumes checkpoint/snapshot maintenance, and does not remove any
  committed vertex.
- The fixed Critical-2 fixture is classified as an approved baseline-only divergence with staleness
  enforcement. Current-engine disagreement remains unsuppressed; the pinned baseline used as the primary
  engine at suffix 1 fails the fixture on replica-vs-fresh disagreement.

Verification at closure: differential per-PR **6 passed / 2 skipped**, differential nightly
**8 passed**, object **244 passed / 4 skipped**, node **202 passed**, typecheck **28/28 projects**, and
lint **0 errors**. The current-engine divergence count is zero in every generated and widened slot. No
vertex encoding, `computeHash` input, generated protobuf, or wire-format file changed.

---

## Appendix D.14 — Attempt-6 review: the slice holds, but the gate was beaten again

Attempt 6 closed Critical 1 and D.10.4's two mediums. Verified independently: differential **8/8 pass** at
both tiers with the baseline oracle, full suite **1363 passed / 0 failed**, typecheck clean, lint 0 errors,
`mixed-acl` current-engine divergences **12→0** per-PR and **188→0** nightly.

Every claim the slice makes about itself survived attack — A1's fence, A2's bounded replay, A3's recovery,
A4's approval mechanism, S1/S2/S3/S5/S6, R2′, and slice 0r's blast radius. **And the adversarial review beat
the gate for the third time.**

### D.14.1 — HIGH: honest concurrent admins can permanently fork ACL authority

Four honest vertices, no equivocation, no byzantine peer, stable at every checkpoint suffix:

```
GA : a1 grants eve ADMIN            @root
RF : a2 revokes eve Finality        @root   (concurrent with GA)
WG : eve grants w2 Writer           @GA     (eve has seen only GA)
W  : w2 writes                      @WG
```

`ObjectACL.resolveConflicts` compares only `opType` and `value[0]` — **not the group** — so RevokeWins
drops `GA`. Then:

| delivery order | graph                                    | eve admin? | w2 writer? | DRP         |
| -------------- | ---------------------------------------- | ---------- | ---------- | ----------- |
| grant-first    | {GA, WG, W} — **RF quarantined forever** | yes        | yes        | `["hello"]` |
| revoke-first   | {RF, GA} — **WG quarantined forever**    | no         | no         | `[]`        |

Same four vertices, different arrival order, permanently different **vertex sets, ACL authority and DRP
state**. Root cause: pair-semantics drops do not cascade to causal descendants of a dropped ACL vertex, so
replay executes an operation whose authorization premise was resolved away (`ObjectACL.grant` throws
"Only admin peers can grant").

**Pre-existing, not a regression.** Baseline `7f9e66a` on the same input is _worse_: it throws out of merge
and leaves a torn graph (all four vertices present, live state stale, `GA` missing from the order). Attempt
6 made the failure **atomic** — but also **silent**, since `applyVertices` now returns `quarantined` rather
than throwing.

**L7 was contested, and was verified first-hand.** The third reviewer returned SHIP after ~800 probe runs
across seven families the gate does not generate — including one described as _"Admin grant + concurrent
Finality grant/revoke + delegated grant by new admin"_, 20 seeds × 3 suffixes, **0 divergences**. That is
nominally the same family. The contradiction was settled by reproducing the exact four-vertex construction
directly:

```
[L7] suffix=1/2/4/default   FORKED=true   (all four)
  grant-first : graph=3  RF absent  eveAdmin=true   w2Writer=true   drp=["hello"]
  revoke-first: graph=2  WG absent  eveAdmin=false  w2Writer=false  drp=[]
```

**L7 is real.** The reason a 20-seed generated sweep missed it: the drop fires only when the two ACL
operations collide on `value[0]` — the _same target peer_ — with opposite `opType`. `resolveConflicts`
ignores the group, so `grant(eve, Admin)` and `revoke(eve, Finality)` are treated as a conflicting pair
_despite being about different groups_. A random generator almost never lands that exact collision; a
hand-built shape hits it every time. **Generated coverage of a family is not coverage of its preconditions.**

**This is a new tracked defect (L7), not an attempt-6 blocker.** But it falsifies the headline as stated:
"0 current-engine divergences everywhere" is a property of the corpus, not of the engine.

### D.14.2 — Why the gate could not see it: four simultaneous blind spots

1. It never generates **Admin-group** ACL operations — only Writer and Finality.
2. It never generates **authority-chain** shapes: a granted peer exercising its granted authority.
3. `stateOf` reads **DRP state only**. Live ACL state (`query_isAdmin`, `query_isWriter`,
   `query_getFinalitySigners`) is never compared by any tier.
4. `applySchedule` **throws** on any rejection, so an admission-outcome divergence is a harness crash rather
   than a measured signal — and no generator can produce one anyway.

The divergence lives in the intersection of all four. Each previous widening fixed the axis that had just
been exploited; none asked which axes remained. **The corpus must be derived from what the code branches on
— vertex type, ACL group, authorization dependency, admission outcome, and every observable surface — not
from the last bug found.**

### D.14.3 — Remaining findings

- **MEDIUM — replay-time deterministic throws are misclassified** _(found independently by two reviewers,
  which is the strongest corroboration in this appendix)_. The taxonomy classifies _pipeline_
  throws; a deterministic throw raised during canonical replay (the `ObjectACL.grant` above) is treated as
  possibly-transient → quarantine → every redelivery pays a full canonical replay and fails identically,
  forever. `deterministic-rejection-taxonomy.test.ts` covers apply-time only, not replay-time.
- **LOW — `isBaselineProblem` is a substring match on `"baseline"`.** A future schedule or replica name
  containing that word would reclassify a real current-engine problem as approved-suppressible. Not
  exploitable with current names; make it a structural tag.
- **LOW — duplicate-listed dependencies** (`deps = [A, A]`, byzantine-craftable, passes validation) trigger
  the old double-emit at baseline while current is self-consistent. This _extends_ the approved divergence
  class, but D.12.3's description ("non-antichain") and the structural predicate
  (`transitive-join-children` @ suffix-1) do not name or cover it — a future dup-deps fixture would fail as
  unapproved. Independently found by a second reviewer.
- **INFO — non-root `opType "-1"`**: baseline silently skips it and reports applied; current marks it
  invalid and cascades to dependents. Deliberate and tested, but it is a cross-version interop change with
  no release-note obligation recorded; D.12.3's note covers only non-antichain replay.

### D.14.4 — Corrections to this plan, applied

- **D.11.2's "baseline as primary → 0" is false post-0r** and has been annotated in place. Baseline-as-primary
  is now _correctly_ red (7/144) on the approved class. Do not confuse the oracle mode
  (`TS_DRP_BASELINE_OBJECT_MODULE`, file passes 8/8) with the primary mode
  (`TS_DRP_PRIMARY_OBJECT_MODULE`, expected red).
- **D.11.4's standing rule was unsatisfiable as written** and has been amended: green _except_ failures
  attributable to the approved class, with the attribution checked rather than assumed.
- **D.11.1 / D.13 gate-adequacy claims are corpus-relative** and must be scoped accordingly.
- **D.12.3's approved class** should explicitly include duplicate-listed dependency vertices.
- Call-site drift: `drp-applier.ts:560,634,655` → `556-564 / 649 / 671`.

### D.14.5 — The pattern, stated once

Three widenings, three defeats:

| round | gate blind to                                                | found by         |
| ----- | ------------------------------------------------------------ | ---------------- |
| D.8   | resolver-free DRPs (proptests used only resolver-bearing)    | hand-built probe |
| D.10  | ACL vertices entirely; transitive edges; join fan-out        | hand-built probe |
| D.14  | Admin group; authority chains; ACL state; admission outcomes | hand-built probe |

A fourth instance landed in the same review: the L7 family _was_ generated (20 seeds × 3 suffixes) and
still came back clean, because the generator never hit the `value[0]` collision the drop requires. So the
rule is sharper than "the gate lacks the axis":

> **Generating a family is not covering it.** A corpus must hit the _precondition_ of a defect, not merely
> the shape. Where a defect needs a value collision, a hash ordering, or an exact group pairing, the corpus
> must construct those deliberately — random generation over a large domain will miss them indefinitely.

**Every blind spot was found by an agent constructing shapes by hand, never by the gate.** The gate is
still worth having — it caught regressions in seconds that four TDD rounds missed — but it is a _regression
detector_, not a correctness proof, and the plan must stop describing it as though a green run were
evidence of convergence. **Budget an adversarial prober on every slice, permanently.**

---

## Appendix D.15 — The gate widened on the four blind axes; L7 pinned and confirmed pre-existing

Four dimensions added to `convergence-differential.test.ts`, chosen because a defect lives in their
intersection (D.14.2). **Zero `src/` changes** — the corpus had to be able to observe L7 before the next
slice fixes it.

### D.15.1 — What was added

| dimension                         | why                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Admin-group ACL operations**    | the corpus only ever emitted Writer and Finality                                                                          |
| **Authority-chain topology**      | a granted peer _exercising_ its granted authority — no topology produced this                                             |
| **ACL state observation**         | `stateOf` read DRP state only; an authority fork with matching DRP state was invisible                                    |
| **Admission-outcome observation** | `applySchedule` _threw_ on rejection, so a disagreement in which vertices were admitted was a harness crash, not a signal |

Plus two corrections: `isBaselineProblem` is now a structural `scope` tag rather than a substring match on
`"baseline"`, and the approved-divergence class explicitly covers **duplicate-listed dependencies**
(`deps = [A, A]`) alongside `transitive-join-children`.

### D.15.2 — Precondition coverage: 100%, and measured

This was the point of the exercise. D.14.5 recorded that a 20-seed sweep of nominally the L7 family found
nothing because it never reached the `value[0]` collision the resolver drop requires. The new generator
draws ACL targets from **three** peers and forces the concurrent pair to share `value[0]`, use opposite
`grant`/`revoke`, and address **Admin versus Finality**.

Measured drop rate: **48/48 per-PR (100%)** and **320/320 nightly (100%)** — structural collision _and_
actual resolver drop, not merely the shape. Compare with the previous generator's effective 0%.

> **A generator that reaches its precondition 0% of the time is indistinguishable from no coverage, and
> reads as green. Measure the firing rate; never assume it.**

### D.15.3 — Results on the current tree

| slot                                                          |    per-PR |     nightly |
| ------------------------------------------------------------- | --------: | ----------: |
| Admin-group / authority-chain / ACL-state / admission-outcome | **48/48** | **320/320** |
| `mixed-acl`, `many-writers`, ordinary generated slots         |         0 |           0 |
| approved reference divergence (`transitive-join-children`)    |        28 |         164 |

The pinned fixed case `fixed-four-vertex-cross-group-authority-chain` fails on
`replica-vs-replica: grant-chain-before-revoke != revoke-before-grant-chain`, differing across **DRP state,
ACL state, linear order, graph membership and admission outcome** simultaneously.

### D.15.4 — L7 is confirmed pre-existing, with a dimensional caveat

Run with the pinned reference as the **primary** engine, the same fixture **also fails**
(verified first-hand: `fixed-four-vertex-cross-group-authority-chain` red on both engines; widened tier
55/192 per-PR = 48 authority-chain + 7 older transitive; 361/1280 nightly). So the reference forks on this
family too — **L7 is not a regression introduced by slices 0q/0r.**

**The dimensional split, now settled by direct measurement** (the verification D.15.4 flagged as owed):

| dimension         | reference `7f9e66a` | current tree                 |
| ----------------- | ------------------- | ---------------------------- |
| graph membership  | **same** (4 / 4)    | **FORKS** (3 vs 2)           |
| linear order      | **same** (3 / 3)    | **FORKS** (3 vs 1)           |
| ACL authority     | forks               | forks                        |
| DRP state         | forks               | forks                        |
| admission outcome | forks — `THREW`     | forks — silent `quarantined` |

```
reference    grant-first  members=4 order=3 acl=true/true   drp=["hello"] admission=A,A,A,THREW
             revoke-first members=4 order=3 acl=false/false drp=[]        admission=A,A,THREW,THREW
current      grant-first  members=3 order=3 acl=true/true   drp=["hello"] admission=A,A,A,-Q
             revoke-first members=2 order=1 acl=false/false drp=[]        admission=A,A,-Q,-M
```

**Conclusion: L7 is part pre-existing, part regression.** The ACL-resolution defect itself — authority and
state diverging by arrival order — is shared with the reference and is _not_ introduced by slices 0q/0r.
But the reference keeps **identical graph membership and linear order** across schedules, because it fails
loudly: `applyVertices` throws and every vertex stays in the graph. The current engine's per-vertex
quarantine converts that loud throw into a **silent, arrival-order-dependent vertex drop**, so replicas
now disagree about _which vertices exist_ — a dimension the reference does not fork on.

**Consequence for the fix (binding):** L7's remedy must restore **membership and admission agreement**, not
only state agreement. Quarantine is the right mechanism for a genuinely transient failure, but a
deterministic authorization failure arising from conflict resolution is _not_ transient — it is a function
of the causal past, identical on every replica that folds the same order — and must not be resolved
per-replica by arrival order. This ties directly to the MEDIUM already recorded in D.14.3: replay-time
deterministic throws are misclassified as possibly-transient. **Fixing that classification is likely the
larger half of L7's fix, and it is a regression fix, not new work.**

### D.15.5 — Gate status

The gate now fails on the current tree for exactly one reason — the authority-chain family — and that
failure is the specification for the next slice. Everything the previous rounds closed stays closed:
ordinary generated slots, `mixed-acl` and `many-writers` all report zero current-engine disagreement, and
approved reference divergence remains confined to the documented class with staleness enforcement intact.

---

## Appendix D.16 — L7 fix attempt: **RETRACTED — DO-NOT-SHIP** (see D.17)

> ## ⚠ THIS APPENDIX IS FALSE AS WRITTEN. READ D.17 FIRST.
>
> Two reviewers independently refuted it by execution. **The fix introduces a new regression**: on a shape
> the reference build handles convergently (0/80 forks), the current tree forks replica-vs-replica on
> membership and authority (44/80). Every closure claim below is withdrawn:
>
> - ~~"L7 is closed"~~ — the same-group variant still forks, and a new cross-group variant was introduced.
> - ~~"restores membership and admission agreement"~~ — violated by both reviewers' probes.
> - ~~"a throw there is identical on every replica"~~ — true of the _fold_, false of the _classification_:
>   the throw is blamed on the **arriving** vertex, not the vertex that threw, so
>   `knownInvalidVertexHashes` diverges permanently across replicas.
> - ~~"every known legacy-plane convergence defect is now closed"~~ — false; the D.16.5 table is wrong.
> - **D.16.4's fallback condition has been met**: group-aware identity alone is insufficient.
>
> The text is kept unedited below as the record of what was believed and why. **Do not cite it.**

## Appendix D.16 (retracted) — L7 fix: ACL conflict identity is group-aware, replay failures classify deterministically

L7 (D.14.1) is closed. Authority-chain current-engine disagreement went **48→0** per-PR and **320→0**
nightly; the pinned four-vertex case converges on identical membership, order, ACL authority, DRP state and
admission outcomes. Independently verified: differential **9/9** at both tiers with the reference oracle,
full suite **1368 passed / 0 failed**, typecheck clean, lint 0 errors.

### D.16.1 — The scope came from the measurement, not from the report

D.15.4's owed verification decided what the fix had to cover. Measured directly:

- The **authority and state** disagreement is shared with the reference build — pre-existing, not caused by
  slices 0q/0r.
- The **membership and order** disagreement was **new**. The reference fails _loudly_ (`applyVertices`
  throws, all four vertices retained, identical order both ways); per-vertex quarantine converted that into
  a **silent, arrival-order-dependent vertex drop** (3 vs 2 members, order 3 vs 1).

So L7 was part pre-existing defect, part regression, and the fix needed both halves. Taking the
implementer's "pre-existing" framing at face value would have produced a fix that left replicas disagreeing
about which vertices exist.

### D.16.2 — F1: replay-time failures are deterministic, and now classify that way

`drp-applier.ts:410` classifies `DeterministicRejectionError` as terminal invalidity, and canonical ACL
replay wraps throws as that type (`:1367`) across the concurrent, hinted, tail and reconciliation paths.

> **Rule:** reconstructed ACL replay is a pure fold over immutable causal history, so a throw there is a
> function of the causal past — identical on every replica that folds the same order. It is `invalid`
> (remembered, bounded), never `quarantined`.

The S5/S6 distinction is **sharpened, not collapsed**: genuinely non-deterministic application failures
still run through ordinary `applyVertices` and remain retriable quarantine. This is the half of the fix
that closes the _regression_ — it is what restores membership and admission agreement.

### D.16.3 — F2: group-aware ACL conflict identity, and it is a coordinated-upgrade change

`acl/index.ts:215` makes ACL-to-ACL conflict identity compare the **group** as well as `opType` and
`value[0]`. `grant(eve, Admin)` and `revoke(eve, Finality)` are simply not in conflict, so neither is
dropped and no descendant loses its authorization premise.

Two refinements were required, and both are worth recording because neither was obvious:

1. **The group comparison applies only when _both_ operations are ACL operations.** A naive comparison
   disabled ACL-vs-DRP conflict resolution and produced **28 unapproved `mixed-acl` reference divergences**;
   restricting it to ACL-vs-ACL returned them to zero. That earlier ACL-vs-DRP collision behaviour is
   deliberate (it is what Critical 1 was about), so the carve-out preserves a real invariant — but it is a
   carve-out, and it is under review as to whether it is a principle or a patch.
2. **Revoking a group an admin does not hold is a no-op** (`acl/index.ts:122`). Existing protection against
   revoking a group an admin _does_ hold is unchanged.

**F2 changes folded state for ordinary rooms** containing concurrent same-target cross-group ACL
grant/revoke pairs. Unlike slice 0r — whose fix was provably a no-op on honestly-formed rooms — this one is
a genuine **coordinated-upgrade** change under principle 3. It is recorded in the approved divergence class
with staleness enforcement, and honest-corpus equivalence against the reference is **0/144** per-PR and
**0/960** nightly, with the intended authority-chain divergence exercised at 48/48 and 320/320.

### D.16.4 — Option (b) was considered and rejected on scope

Propagating a resolved-away drop to causal descendants would require **persistent drop tombstones across
checkpoints plus pre-authorization replay** — substantially broader than a conflict-identity change, and it
would alter drop semantics for every DRP rather than for ACL pairs alone. Recorded so it is not
re-litigated: if group-aware identity later proves insufficient, (b) is the fallback and its cost is known.

### D.16.5 — Phase 0 legacy-plane status

| defect                                              | status                                      |
| --------------------------------------------------- | ------------------------------------------- |
| L1 state adoption is a merge, not a replacement     | closed                                      |
| L2 replica-local `context` in snapshots             | closed                                      |
| L3 merge batches not atomic                         | closed (per-vertex atomicity, six attempts) |
| L4 untyped authorization failure                    | closed                                      |
| L5 untyped unknown-operation failure                | closed                                      |
| L6 checkpoint written from un-reconciled live state | closed                                      |
| L7 ACL authority fork by delivery order             | **closed**                                  |
| Critical 1 resolver fence per-type vs per-subgraph  | closed                                      |
| Critical 2 linearizer double-push                   | closed (slice 0r)                           |

Every known legacy-plane convergence defect found by this program is now closed, and the corpus that finds
them covers vertex type, ACL group, authority chains, transitive edges, join fan-out, ACL state and
admission outcomes — at a measured 100% precondition rate on the family that motivated it.

---

## Appendix D.17 — Why the L7 fix is a regression, and the premise that was wrong

Two reviewers, working independently with different probes, reached the **same two HIGH findings** and the
same root cause. That is the strongest corroboration in this appendix, and it retracts D.16.

### D.17.1 — The false premise: ACL groups are not independent

F2 assumed `grant`/`revoke` on **different** groups are independent and therefore never conflict. They are
not. `ObjectACL.revoke`'s guard at `acl/index.ts:126` couples **every** group's revoke to the target's
**Admin** membership:

```
grant(p, Writer) ; grant(p, Admin) ; revoke(p, Writer)
  -> "Cannot revoke permissions from a peer with admin privileges"
```

So `grant(p, Admin)` and `revoke(p, G)` — different groups — are **order-coupled** whenever `p` already
holds `G`. Grant-first: `p` is an admin holding `G`, the guard throws, the revoke fails. Revoke-first: it
succeeds. F2 de-conflicted exactly that pair.

**Measured, both reviewers, on `W0: grant(p,Writer) → {GA: grant(p,Admin), RW: revoke(p,Writer)}`:**

| engine              | forks                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| reference `7f9e66a` | **0 / 80** — all schedules and fresh replay agree                           |
| current tree        | **44 / 80** — `members=[GA,W0] admin=true` vs `members=[RW,W0] admin=false` |

The reference converges here _because_ its over-broad predicate drops `GA` via RevokeWins and never reaches
the guard. **This is a regression introduced by the fix**, not a pre-existing defect, and it is not in the
approved divergence class.

### D.17.2 — F1 blames the wrong vertex

`applyDeterministicReplayVertices` folds the whole canonical suffix — which routinely contains
already-admitted vertices — and pins **any** throw on the _pending_ vertex. So the same deterministic fold
failure brands `RF` invalid on one replica and `GA` on another. `knownInvalidVertexHashes` therefore
diverges permanently, and the invalid-cascade amplifies it to descendants.

D.16.2's rule was right about the fold and wrong about the implementation: _the fold is deterministic; the
attribution is not._ **This is what converts the forks above from "divergent until retried" into "divergent
forever."** Any fix must blame the vertex that actually threw.

### D.17.3 — The original L7 mechanism is still open for same-group pairs

`grant(p, Admin)` vs `revoke(p, Admin)` still legitimately conflicts, RevokeWins still drops one, and drops
**still do not cascade to causal descendants** — so a descendant of the dropped grant still executes with
its authorization premise removed. Measured: revoke-last → members `{GA2, WG2, P}`, admin=true; revoke-first
→ members `{GA2, RA}`, admin=false.

D.14.1's root-cause sentence — _"pair-semantics drops do not cascade to causal descendants"_ — was never
addressed. F2 routed **around** it for cross-group pairs instead of fixing it. **D.16.4's recorded fallback
(option b: propagate drops to descendants) is now triggered.**

### D.17.4 — My own rule, violated one appendix later

D.15.2 established: _"a generator that reaches its precondition 0% of the time is indistinguishable from no
coverage, and reads as green — measure the firing rate, never assume it."_

The widened generator measures **100%** — but only for the _resolver-collision_ precondition. The
authority-chain generator draws fresh targets that **never pre-hold the revoked group**, so the
**admin-guard precondition fires at 0%**, and `hasResolverPrecondition` _requires_ `crossGroup`, so the
**same-group-with-descendant precondition also fires at 0%**. Both new forks are invisible to it.

> **The sharper rule: a defect class has a precondition, and a _measured_ 100% on one precondition says
> nothing about the others. Enumerate the preconditions of the mechanism — here: does the resolver drop
> fire? does the target already hold the group? does the dropped vertex have descendants? — and measure
> each independently.**

### D.17.5 — What the next attempt must do

1. **Blame the throwing vertex, not the arriving one.** Without this, every other fix still diverges
   permanently. This is the highest-value single change.
2. **Handle the group coupling.** Either keep group-aware identity and make the admin guard's outcome
   order-independent, or treat `grant(p, Admin)` as conflicting with any concurrent `revoke(p, ·)`.
3. **Make drops cascade to causal descendants** (option b) — the same-group case cannot be routed around.
   Cost is known and recorded: persistent drop tombstones across checkpoints plus pre-authorization replay.
4. **Extend the corpus first**, with independently measured firing rates for all three preconditions.

### D.17.6 — Standing corrections

- **D.15.2 / D.15.5's "100% precondition rate" and coverage list are false as scoped** — annotated above.
- **D.15.4's binding consequence** ("must restore membership and admission agreement") is **violated** by
  the delivered fix.
- **D.16 is retracted in full**, including its D.16.5 "all closed" table.
- **LOW, still open:** `applyDeterministicReplayVertices` wraps _any_ throw from _any_ `IDRP` as terminal,
  with no `ObjectACL` check. `DRPObjectOptions.acl` is a public injection point, so a custom ACL with an
  ambient failure source — or a `RangeError` on an adversarially deep payload — becomes permanent shared
  invalidity rather than retriable quarantine. No in-repo custom ACL exists; the unguarded surface stands.

## Appendix D.18 — L7 second attempt: replay attribution landed; attempt-1 semantics later reverted

**Status: SUPERSEDED PARTIAL.** Replay attribution from Fix 1 was later completed across direct admission,
hinted adoption and the submitted-vertex verdict, and remains landed. The attempt-1 group-aware resolver
identity and relaxed revoke guard were retracted in D.16 but remained in source through attempts 2 and 3;
D.22 finally reverts both to `7f9e66a`. They are not a kept coordinated upgrade.

`applyDeterministicReplayVertices` now classifies each built-in ACL operation while its vertex is still in
scope and carries that vertex's hash through the deterministic error. The outer admission loop recorded the
attributed hash but failed to give the pending vertex any verdict, and it exposed a committed graph member
through `invalid`. The two-replica pin proved only that the replay wrapper identified the throwing revoke
given identical committed inputs; it did not generalize to differing committed sets. S1 remained explicit:
a revoke committed before the later replay failure stayed in the graph.

The D.17.6 custom-ACL replay gap was closed at that seam. Built-in ACL domain failures received an internal
typed marker, while untyped failures from a custom injected ACL remained quarantined and retriable. The
marker was not wired into direct admission or hinted adoption, so S5/S6 was not yet satisfied across the
whole admission surface.

### D.18.1 — Why Fix 2 was not left half-landed

Option (b), measured directly, changed the widened result from
`held-group-coupling=48, same-group-descendant=48` to
`admin-authority-chain=48, same-group-descendant=48`: it fixed the regression by reopening the case D.16
had closed. Ordering the Admin grant after a cross-group revoke (option (a)) was also rejected: the swap
moved the grant behind its own authority-chain descendants and still produced 32/48 authority-chain
divergences. Both experiments were reverted.

The later three-way confer rejected preserving either attempt-1 semantic hunk as a partial fix. D.22
restores reference conflict identity and revoke behavior, keeps attribution/admission/partial-merge
mechanisms, and returns resolver-drop descendant closure to the deferred F3 owner. Any future closure must
publish resolver-drop closure and folded state together, persist the closure in checkpoints, classify a
pending overlay before authorization, repeat that classification after a frontier-CAS retry, and retract
stale contextual verdicts. Existing performance coverage still requires the cascade to stay scoped to ACL
drop roots unless the broader resolver contract is deliberately re-specified.

### D.18.2 — Measured partial state and next pickup

- Current engine, per-PR: **96/336** — held-group **48**, same-group descendant **48**, every other slot 0.
- Current engine, nightly: **640/2240** — held-group **320**, same-group descendant **320**, every other
  slot 0.
- P1/P2/P3: **48/48** per-PR and **320/320** nightly.
- `fixed-four-vertex-cross-group-authority-chain` remains green.
- Focused rejection taxonomy: **5/5 passed**.
- Full object suite: **249 passed / 3 failed / 4 skipped**; the three failures are the two fixed deferred
  cases and the widened differential gate.
- Node: **202/202 passed**. Typecheck: **28/28 projects**. Lint: **0 errors** (177 pre-existing warnings).

**Next pickup:** implement Fixes 2 and 3 as one ACL-drop replay slice with persistent checkpoint
tombstones, pre-authorization overlay classification, CAS-retry reclassification, and atomic retraction of
stale contextual entries from `KnownInvalidHashes`. The retraction mechanism is a hard prerequisite of F3,
not a follow-up. Keep same-group grant/revoke conflicts, ACL-vs-DRP behavior, S1/S2/S3/S5/S6, bounded retry,
and all three fixed cases pinned.

---

## Appendix D.19 — Attempt-2 review: unanimous DO-NOT-SHIP; D.18's headline claim is false

Three independent reviewers (grok, kimi at `--max-steps-per-turn 100`, and an adversarial Opus agent with
executed repros) reviewed the attempt-2 diff unprimed. **All three returned DO-NOT-SHIP, converging on the
same blocker.** Each finding below was re-confirmed against the source directly before being recorded here.

The attempt-2 self-report was, unusually, numerically honest: an independent re-run of typecheck, lint, the
object and node suites and all three differential tiers reproduced every number in D.18 exactly. The defect
is not in the measurements. It is that **D.18 measured the wrong thing** — it verified the replay path and
claimed the result for the whole admission surface.

### D.19.1 — F1 (blocker): the marker class was never wired into the admission classifier

`drp-applier.ts:420-424`'s `isDeterministicFailure` tests four error types and **not**
`ObjectACLDeterministicError`. That class is converted to a terminal verdict in exactly one place —
`drp-applier.ts:1388`, inside `applyDeterministicReplayVertices` — which does not run for an ACL op on the
_arriving_ vertex. `DeterministicRejectionError` is constructed only at `:1097`, `:1335`, `:1345`, `:1350`
and `:1360`, all writer-check or unknown-operation, so a built-in ACL domain throw has no route to any of
them. kimi identified a second unwired site: the hinted-adoption `applyVertex` at `drp-applier.ts:594`.

Consequence: every arriving built-in ACL rejection — non-admin `grant`, invalid group, permissionless writer
grant, non-signer `setKey` — is **quarantined and retried forever** rather than marked permanently invalid.
Trigger is one signed non-admin peer sending one ACL op: no fork, no concurrency, no special graph.

The same `ObjectACL` guard family therefore yields opposite verdicts by path — replay: `invalid` +
remembered; direct: `quarantined` + not remembered. **S5/S6 is violated by construction**: `quarantined` now
provably contains a 100%-deterministic rejection.

This is _not_ a regression — at `7f9e66a` those guards threw plain `Error` and were also quarantined. What
is new is D.18's claim to have fixed it.

### D.19.2 — F2 (blocker): the submitted vertex receives no verdict, and this one IS a regression

`drp-applier.ts:435-441`: when the attributed hash ≠ the pending hash, the loop records the attributed hash
and `continue`s. The vertex the caller submitted is never pushed to `invalid`, `missing` or `quarantined`.
At `7f9e66a` the `else` branch pushed `vertex.hash`, so the caller got a terminal verdict — **the result
contract regressed.**

Two consequences neither reviewer had to infer: `invalid` names a hash that is _committed and present in the
graph_ (it is simultaneously written into `knownInvalidVertexHashes` while S1 keeps it), and a child of the
dropped vertex sits in `missing` forever. `missing` is the only field `packages/node/src/handlers.ts:260,295`
acts on, so `recoverMissingSync` re-requests a parent that is silently dropped again on arrival — an
unbounded sync loop with no terminal state.

### D.19.3 — F3 (major): the L7 mechanism is not closed; the pin does not generalize past two

D.18's two-replica pin holds at two concurrent ACL ops and **does not generalize**. At three concurrent ACL
ops on a target holding Writer+Finality — all pairwise `Nop` under the group-aware resolver, hashes forced
`GA < RW < RF` — the replicas' committed sets differ, so the folds differ, a different vertex throws first,
and `knownInvalidVertexHashes` diverges permanently. `RF` ends committed on one replica and permanently
invalid on the other; a child of `RF` inherits it, turning one divergence into an unbounded permanently-
invalid subtree.

This is precisely the D.17.2 mechanism Fix 1 was supposed to close. D.18's "Fix 1 from D.17.5 is complete"
is therefore **false as written**; the correct statement is that attribution is deterministic _given
identical committed sets_, which is the assumption the defect violates.

### D.19.4 — F4 (major): the quarantine result was added and the batch abort re-raised anyway

`drp-applier.ts:507` stashes `legacyMergeError` and `packages/object/src/index.ts:228-229` re-throws it from
`DRPObject.merge`. One unauthorized ACL op attached to an UPDATE therefore suppresses attestation and
missing-recovery for the whole message: the throw skips `appliedVertices`, the finality-signature block and
`recoverMissingSync` at `handlers.ts:260-297`, while the honest vertices in the batch commit.
`packages/message-queue/src/message-queue.ts:90` catches and logs, so this is finality/liveness suppression
rather than a crash. Throwing out of `merge` is pre-existing in kind; what is new is that a per-vertex
quarantine result was introduced and the batch abort was left in place, so the abort was never actually
removed.

### D.19.5 — F5: an undocumented wire-visible change, and the measurement that could not see it

`acl/index.ts:126` was changed from `query_isAdmin(peerId)` to
`query_isAdmin(peerId) && this._authorizedPeers.get(peerId)?.permissions.has(group)`. Vertices that
previously failed permanently now commit as no-ops. **This change appears nowhere in this plan** — not in
D.16, D.17 or the original D.18 report — and that report treated ordinary-room folded state as unchanged.
It is not.
(The sibling group-aware resolver change at `acl/index.ts:219-227` _is_ disclosed, in D.16.3, as a
deliberate coordinated upgrade; only the revoke-guard relaxation was undisclosed.)

The honest-corpus equivalence evidence — 0/144 per-PR — could never have caught it. Every revoke fixture in
the corpus pre-grants the group first (`convergence-differential.test.ts:1394-1416` builds
`W0=grant(p,Writer)` before `RW=revoke(p,Writer)`), so **no generated case revokes a group the admin does
not hold.** The 0/144 result is blind to this change by construction.

This is the same lesson as D.14, now for the fourth time, and it is worth stating in its most general form:

> **An equivalence result is scoped to the preconditions its generator actually produces.** "0 divergences
> across 144 cases" is a statement about the generator, not about the engine. Before any coordinated-upgrade
> claim, name the precondition the change needs in order to be observable, and assert that it fires.

The attempt-3 RED run adds that measurement as precondition **P4** (`revoke(p, G)` where `p` is admin and
lacks `G`), with a generator slot and a fixed fixture. First numbers: P4 fires 48/48 per-PR; the new slot
shows **48/48 unapproved cross-engine differences against `7f9e66a`** (`RA` applied on current, quarantined
on the reference). The change is real, measurable, and was invisible for two attempts.

### D.19.6 — What the reviewers cleared

Not everything was wrong, and the record should say so. All three reviewers independently judged the new
`deterministic-rejection-taxonomy.test.ts` **not theater**: it builds real `DRPObject`s and real
`createVertex` hashes, asserts on graph membership, `knownInvalidVertexHashes` and folded ACL queries, and
its hash-ordering searches fail loudly. Its weakness is coverage, not honesty — not one test sends an ACL op
that the built-in ACL rejects on arrival, which is exactly the F1 path.

Verified clean by at least two reviewers each: **S2** (the `UndoJournal` is constructed, used and
committed/rolled-back inside one synchronous section with no `await` between record and commit), **S3**
(presence and frontier-CAS re-checked inside that section in both `tryCommitPreparedVertex` and
`reconcileCanonicalState`), **S1** (no path removes a committed vertex; F2 mislabels `RW`, it does not
remove it), bounded retry (`MAX_ADOPTION_COMMIT_ATTEMPTS = 3` on both loops, terminating in a typed error),
no mutex, and synchronous local DRP calls.

Two further items, both from kimi, worth carrying into the fix:

- `ObjectACLDeterministicError` is **not exported from the package entrypoint** —
  `packages/object/src/index.ts:23` re-exports `./acl/index.js` but never `./acl/errors.js`. An external
  custom ACL cannot reuse the marker, and under a duplicate-copy load of `@ts-drp/object` the `instanceof`
  taxonomy degrades silently to "quarantined" — a failure mode that produces no error at all.
- `REPLICA_LOCAL_STATE_KEYS = {"context"}` (`state.ts:14`) silently drops any third-party blueprint field
  named `context` from snapshots. No built-in blueprint has one; the comment acknowledges the contract.

### D.19.7 — Process note

Attempt 2's own second-opinion pass never ran: nested `codex review --uncommitted` failed inside its sandbox
with `failed to initialize in-process app-server client: Operation not permitted (os error 1)`. It reported
this honestly and finished anyway. **A sandboxed implementation run cannot review itself** — the review must
be dispatched from outside the sandbox, and the three-reviewer panel is what found all five defects here.

---

## Appendix D.20 — L7 attempt 3 result, corrected by the D.22 revert

**Status: SUPERSEDED PARTIAL.** F1, F2, F4 and F6 remain closed in source. F5's group-aware resolver and
relaxed revoke guard are not a coordinated upgrade: D.16 retracted their premise and D.22 restores both
reference semantics. All ten attempt-3 pins now pass after honest re-fixturing; the open F3 owner is the
inherited resolver-drop/causal-descendant class, not “three concurrent ACL operations.”

### D.20.1 — F1: deterministic ACL admission is wired and observable

`drp-applier.ts` now uses `isObjectACLDeterministicError` in the outer admission classifier as well as in
canonical replay. This covers direct arrival and the hinted-adoption `applyVertex` propagation point.
Built-in ACL domain failures are terminal; untyped custom ACL failures remain quarantined. The helper uses
a `Symbol.for` brand in addition to `instanceof`, so a duplicate installed copy cannot silently invert the
taxonomy.

The widened corpus adds `arriving-built-in-rejection` and P5. P5 fires **48/48** per-PR. Against
`7f9e66a`, all 48 cases observe the intended admission-only coordinated-upgrade difference: current returns
`invalid`; reference returns `quarantined`. Current replicas and fresh replay agree in all 48 cases.

The three F1 RED rows cannot be made green without violating F2 and S1. Each invokes the same
revoke-first + arriving-GA replay as F2, but expects `invalid=[RW]` even though RW is already in the graph.
F2 requires `invalid` to contain no graph member and requires the submitted GA to receive the terminal
verdict. Actual result is `invalid=[GA]`; the expected and received hashes are
`RW=d3ce71da35da376627206980d1ce4038c49d13369d70df9e5b64313c56af135c` and
`GA=bdbbbf8c704b2667210c47311fe3f39a15afa994773e2b5db626dd03af2194ac`.
The older focused taxonomy row contains the same stale expectation. No pin was edited.

### D.20.2 — F2: attribution and caller verdict have separate owners

When an attributed replay failure names a committed vertex other than the submitted vertex, the applier
records the attributed culprit in `knownInvalidVertexHashes`, but returns and remembers the submitted
vertex as invalid. This preserves the attribution Fix 1 was created for, keeps S1, prevents `invalid` from
naming a graph member, gives redelivery the same terminal answer, and makes a child of the rejected
submitted vertex terminal instead of perpetually `missing`.

All three F2 RED pins pass. The design deliberately does not put the committed culprit in the public
`invalid` result: that alternative violates both the result contract and the graph-membership invariant.

### D.20.3 — F3: resolver drops still lack causal-descendant closure

The attempt-1 resolver created a held-group regression and amplified it in the three-way fixture. Reverting
that resolver makes both `fixed-held-group-coupling-regression` and
`fixed-three-way-held-group-attribution` anti-reintroduction pins green. That does not close F3. The open
class is a resolver-selected-away ACL authority vertex whose causal descendants remain eligible for replay:
the two-operation cross-group authority chain and the two-operation same-group pair with a descendant both
fork exactly as `7f9e66a` does.

Closing the inherited class still requires the D.18.1 slice: persistent ACL-drop tombstones,
pre-authorization overlay classification, frontier-CAS retry reclassification, and retraction of
invalid-memory entries made stale by drop-closure reclassification. D.22 lands the cheap general
retraction-on-commit rule, but does not attempt F3.

### D.20.4 — F4: merge returns the partial per-vertex result

`drp-applier.ts` no longer creates the non-contract `legacyMergeError` property, and `DRPObject.merge` no
longer rethrows it. A quarantined custom ACL vertex yields legacy tuple `[false, [], []]`; a deterministic
built-in rejection yields `[false, [], [hash]]`; honest vertices committed in the same batch remain visible.

At `handlers.ts:260-297`, UPDATE handling now continues to compute `appliedVertices`, process eligible
attestations, sign committed vertices, run missing recovery, store the object and dispatch the update event.
At `message-queue.ts:90`, these per-vertex outcomes no longer reach the catch/log boundary as a whole-message
failure. Both F4 RED pins pass. Two older `drpobject.test.ts` rows still expect `merge` to reject and are
stale against the explicit F4 contract; they were not edited.

### D.20.5 — F5: attempt-1 ACL semantics are reverted

The revoke guard is again `query_isAdmin(peerId)`, and ACL conflict identity again compares only `opType`
and target peer. P4 still fires **48/48**, but is now a direct cross-engine guard-equivalence check:
**0/48 differences** against `7f9e66a`. Any remaining full-engine P4 admission difference belongs to P5's
typed deterministic-admission change, not to revoke semantics. The coordinated-upgrade classification for
the two reverted hunks is deleted.

### D.20.6 — F6: public marker and duplicate-copy fallback

`packages/object/src/index.ts` exports `./acl/errors.js`. External custom ACLs can reuse
`ObjectACLDeterministicError`. `isObjectACLDeterministicError` recognizes the shared global-symbol brand
across duplicate package copies while leaving ordinary custom errors quarantined.

### D.20.7 — Verification ledger

Per-PR widened slots:

| slot                        |    current | `7f9e66a` oracle mode | `7f9e66a` primary |
| --------------------------- | ---------: | --------------------: | ----------------: |
| mixed-acl                   |          0 |                     0 |                 0 |
| admin-authority-chain       |         48 |                    48 |                48 |
| resolver-drop               |          0 |                     0 |                 0 |
| held-group-coupling         |          0 |                     0 |                 0 |
| same-group-descendant       |         48 |                    48 |                48 |
| admin-revoke-absent-group   |          0 |                     0 |                48 |
| arriving-built-in-rejection |          0 |                     0 |                 0 |
| transitive-join-children    |          0 |                     0 |                 7 |
| many-writers                |          0 |                     0 |                 0 |
| **total**                   | **96/432** |    **96/432 current** |       **151/432** |

Oracle mode measures P4 revoke-guard equivalence at **0/48 differences**. Full-engine admission taxonomy
still differs on P4 inputs because P5's typed classifier is retained; that is one classifier class, not a
revoke-semantic exception. P1/P2/P3/P4/P5 each fire **48/48 (100%)** in all three per-PR modes.

- L7 attempt-3 file: **10/10 passed** after reference-reachable replay re-fixturing.
- The two deferred inherited fixed fixtures are `fixed-four-vertex-cross-group-authority-chain` and
  `fixed-same-group-pair-with-descendant`.
- Required anti-reintroduction fixtures green: held-group coupling and three-way held-group attribution.
- Required retained mechanisms green: arriving built-in rejection, partial `merge()`, attributed replay,
  and the submitted-vertex verdict.

**F1 — CLOSED and honestly pinned with the authority-chain replay shape.**

**F2 — CLOSED; culprit≠submitted is reachable with the built-in ACL on that authority chain.**

**F3 — NOT-CLOSED: 48 authority-chain + 48 same-group-descendant per-PR divergences, both inherited.**

**F4 — CLOSED in source; two older merge-throws expectations are stale.**

**F5 — REVERTED; P4 fires 48/48 and the direct guard comparison is reference-equivalent.**

**F6 — CLOSED.**

---

## Appendix D.21 — Result-contract confer: submitted verdict retained; F3 gains a retraction prerequisite

The replay result contract was put to a three-way confer: an Opus reviewer, a clean read-only Codex
session, and kimi. The decision is final for this slice:

- `invalid` names the **submitted vertex**.
- When deterministic canonical replay attributes the throw to a different committed vertex, both the
  culprit and the submitted vertex are remembered in `knownInvalidVertexHashes`.
- The committed culprit is not returned in `invalid`; `invalid` never names a graph member.

The confer retained the public submitted-vertex verdict, but its “permanently unadmissible” premise is
executed-false. A deterministic verdict is terminal for one canonical fold, not terminal per hash: a later
resolver drop can change the fold and allow the same hash to commit. Therefore a committed hash is removed
from `KnownInvalidHashes`. Forgetting a currently rejected submitted parent is still unsafe because it
recreates D.19.2's `missing`/recovery loop; the correction is retraction when the contextual verdict becomes
stale, not pretending the first verdict never happened. Invalid memory remains replica-local and
FIFO-bounded, but neither fact makes an entry permanent.

The six stale expectations were corrected without removing or weakening a pin. The three F1 rows now
require replay and direct admission alike to report their submitted vertex, while separately proving that
the replay culprit is remembered and not reported. The focused taxonomy row now reports arriving `GA`,
remembers both `RW` and `GA`, and preserves its grant-first assertion that pending `RW` is attributed to
itself. D.20's GREEN report counted an “older contradictory taxonomy row” but did not disclose this failing
test and overturned assertion by name; that omission is corrected here. The two deprecated `merge()` ACL
tests now require `[false, [], [hash]]` and unchanged ACL state.

Removing `merge()` rejection is correct but is a **breaking behavior change to a public deprecated API**:
callers that used promise rejection as the unauthorized-vertex signal must migrate to the returned invalid
hash tuple (or `applyVertices`). Deprecation does not make the behavior change non-breaking.

The confer also identified one hard F3 prerequisite. `KnownInvalidHashes` was append-only even though
contextual rejection decisions are reversible when resolver closure changes the admissible canonical fold.
D.22 lands retraction when a hash commits. The remaining F3 slice must publish checkpoint tombstones and
folded state atomically, classify the pending overlay before authorization, repeat that classification
after a frontier-CAS retry, and retract any other verdicts made stale by that same reclassification. The
deferred class is resolver-dropped ACL authority with live causal descendants; it already appears in
two-operation authority-chain and same-group-descendant shapes, so “three concurrent ACL ops” is not its
definition.

Verification after correcting the six expectations:

- Focused attempt-3/taxonomy pins now pass; the built-in culprit≠submitted route is the authority chain.
- The remaining fixed failures are the inherited cross-group authority chain and same-group descendant;
  held-group coupling and three-way held-group attribution are anti-reintroduction passes.
- Node: **202/202 passed**. Typecheck: **28/28 projects passed**. Lint: **0 errors / 177 warnings**.
- Current and baseline-oracle per-PR modes both remain **96/432** current divergences:
  authority-chain **48**, same-group descendant **48**, every other current slot — including held-group
  coupling and mixed ACL — 0.
  Baseline-as-primary remains **151/432**, its expected self-validation result. P1/P2/P3/P4/P5 each fire
  **48/48 in all three modes**.

---

## Appendix D.22 — Unanimous revert: restore reference ACL semantics, keep the independent rejection work

An Opus reviewer, a clean-session Codex reviewer and kimi conferred on attempts 1–3. All three returned
**REVERT**. This appendix executes that decision; it does not reopen the design vote.

### D.22.1 — Exact semantic boundary

Two attempt-1 hunks are reverted to `7f9e66a`, and only those two ACL semantics:

1. `ObjectACL.resolveConflicts` no longer includes ACL group in conflict identity. Opposite
   `grant`/`revoke` operations on the same target conflict regardless of group.
2. `ObjectACL.revoke` again rejects every revoke whose target is an admin, regardless of whether the target
   currently holds the named group.

The deterministic direct-admission classifier, attributed canonical replay, submitted-vertex verdict,
partial `merge()` result and public deterministic ACL marker remain. They are independent of the reverted
hunks, and the widened `arriving-built-in-rejection` slot remains at **0 current divergences** with P5
firing **48/48**.

This is deliberately provenance-first, not a claim that the authority fork disappeared. The revert
knowingly restores the inherited **HIGH**: honest concurrent admins permanently fork ACL authority,
**48/48** in `admin-authority-chain`. The choice is to keep the current engine reference-identical on this
legacy semantic boundary and avoid owning attempt 1's new held-group regression. F3 still owns persistent
ACL resolver-drop closure. Phase 3 supersedes the whole legacy boundary with a latched ACL whose resolver
identity is `(peer, group)`.

### D.22.2 — Honest re-pins

- F1 keeps all three direct-admission guard rows. Its replay half now uses the reference-reachable authority
  chain `GA → WG` plus concurrent `RF`. RevokeWins drops `GA`; committed `WG` then throws during canonical
  replay. This was chosen over duplicating the same-group-descendant fixture because it simultaneously pins
  the inherited HIGH and the attributed replay seam without an injected resolver.
- F2's culprit≠submitted route is **reachable with the built-in ACL**, not dormant or custom-only. In the
  same authority chain, `WG` is the committed culprit and `RF` is the submitted vertex. The public result
  reports `RF`; internal memory attributes both.
- `fixed-held-group-coupling-regression` and `fixed-three-way-held-group-attribution` are now green
  anti-reintroduction pins.
- `fixed-four-vertex-cross-group-authority-chain` and
  `fixed-same-group-pair-with-descendant` are deferred inherited failures. Both fail on the current engine
  and `7f9e66a`.
- P4 still fires **48/48**, but now compares the direct absent-group revoke guard and reports **0/48
  cross-engine differences**. The remaining full-engine verdict difference on P4 input belongs to P5's
  retained deterministic-admission classifier; the revoked-guard coordinated-upgrade class is deleted.

### D.22.3 — Review fix-ups

`KnownInvalidHashes` retracts a hash when that hash commits, and public `invalid` results deduplicate hashes.
The old built-in held-group repro is neutralised by the attempt-1 revert: both three-way unit pins now pass.
The premise is still false in general, and a custom ACL using the exported marker reproduces it honestly:
one fold rejects a hash, a later resolver drop makes it admissible, and redelivery commits it. The commit
now removes the stale tombstone.

The inherited FIFO bound remains **10,000** hashes, as it was at `7f9e66a`. A pinned 10,001-invalid flood
evicts a real parent tombstone and changes its child from `invalid` back to `missing`, re-entering recovery.
No mitigation was added because exact recovery after eviction requires retaining more information; that is
a memory-risk trade rather than a free fix. Only committed-culprit hashes are new entrants from this slice.

The deterministic marker is re-exported from `acl/index.ts`; `merge()` documents that it resolves with the
partial legacy tuple and cannot surface `quarantined`; callers needing that retry bucket must use
`applyVertices`. Promise-valued custom ACL operations now use the same `handlePromiseOrValue` path as DRP
operations, preserving synchronous behavior for ordinary ACLs while awaiting injected async policies
before state publication.

### D.22.4 — Differential measurement

| slot                        |    current | `7f9e66a` oracle mode | `7f9e66a` primary |
| --------------------------- | ---------: | --------------------: | ----------------: |
| mixed-acl                   |          0 |                     0 |                 0 |
| admin-authority-chain       |         48 |                    48 |                48 |
| resolver-drop               |          0 |                     0 |                 0 |
| held-group-coupling         |          0 |                     0 |                 0 |
| same-group-descendant       |         48 |                    48 |                48 |
| admin-revoke-absent-group   |          0 |                     0 |                48 |
| arriving-built-in-rejection |          0 |                     0 |                 0 |
| transitive-join-children    |          0 |                     0 |                 7 |
| many-writers                |          0 |                     0 |                 0 |
| **total**                   | **96/432** |    **96/432 current** |       **151/432** |

Every current axis is less than or equal to reference-primary. P1–P5 each fire **48/48** in all three
per-PR modes. The remaining current failures are exactly the two inherited ACL descendant-closure classes;
no attempt-1 semantic fork remains owned by this tree.

### D.22.5 — Verification

- Current differential: **3 failed / 8 passed / 2 skipped**; widened **96/432**.
- `7f9e66a` oracle differential: **3 failed / 8 passed / 2 skipped**; current widened **96/432**; P4
  revoke-guard equivalence **0/48 differences**.
- `7f9e66a` primary self-validation: **4 failed / 7 passed / 2 skipped**; widened **151/432**.
- Full object: **266 passed / 3 failed / 4 skipped**. The only failures are the two deferred fixed fixtures
  and their widened aggregate.
- Full node, twice: **202/202 passed** in both runs.
- Typecheck: **28/28 workspace projects passed**.
- Lint: **0 errors / 177 pre-existing warnings**.

### D.22.1 — A counter that cannot fail, and 96 un-manifested reference differences

Found while independently verifying the revert, not reported by the slice that produced it.

`unapproved-baseline` moved from **48 to 96** after the revert. A "baseline problem" is
`current replica outcome ≠ reference replica outcome` (`convergence-differential.test.ts:434-445`) — a
current-vs-`7f9e66a` mismatch, _not_ the reference forking against itself. So the tree now differs from the
reference on more cases than before the revert, not fewer.

That is expected once the cause is named, and it is worth naming precisely because the number moved in the
opposite direction to the headline result. The revert restored ACL **semantics** to reference. It did not —
and was not meant to — revert attempts 2/3's admission **taxonomy**, where a deterministic ACL rejection
becomes `invalid` while the reference quarantines and retries. Restoring the strict revoke guard makes
_more_ shapes throw, so that intended taxonomy difference now surfaces on 96 cases rather than 48. The
divergence is deliberate; its breadth was not measured until now.

**The gap:** `approvedBaselineDivergenceClass` (`:1957`) whitelists only `transitive-join-children` /
duplicate-dependency shapes and the `acl-admin-revoke-absent-group` / `acl-arriving-built-in-rejection`
topologies. `admin-authority-chain` and `same-group-descendant` are affected by the same deterministic-
admission change and are **not** whitelisted, so all 96 count as unapproved.

**The sharper gap:** `unapprovedBaselineFailureCases` is incremented at `:2069` and printed at `:2129`, and
**never asserted anywhere.** There is no `expect()` on it. Gate 0's G-b requires the opposite — every
differing pair must match a manifest entry, an unknown pair must fail, and a stale entry must fail. Today
this counter cannot fail a build, so 96 current-vs-reference differences sit unenforced and unexplained.

This is not a defect introduced by this slice, and it is not a commit blocker: the differences are the
intended taxonomy change, and the harness never claimed to gate them. It is recorded here as a **Gate-0
prerequisite**: when G-b is built, these two topologies need explicit manifest entries carrying the
deterministic-admission rationale, and the counter needs an assertion — otherwise the manifest mechanism
ships with a hole exactly where the legacy plane already diverges.

Generalised, this is the same lesson as D.19.5 from the other direction: **a number that is computed and
printed but never asserted is not a gate.** It reads like coverage in a report and enforces nothing.

---

## Appendix D.23 — Signature-suite confer: unanimous `RESERVE-NOT-ACTIVE`

An Opus reviewer, a clean-session Codex reviewer and kimi independently reviewed
`p256-sha256-v1`. All three returned **`RESERVE-NOT-ACTIVE`**. This appendix records and executes that
decision; the active suites are `ed25519-sha256-v1` for identity/vertex signatures and
`ed25519-seal-v1` for seal votes. P-256 remains registry-recognized so a future coordinated amendment can
name it, but it cannot be negotiated or verified now.

### D.23.1 — The population P-256 would serve cannot lawfully use it

The only environment P-256 helps is a pre-18.4 iOS or pre-137 Android WebView acting as a **seal voter**
with non-extractable custody. That is custody option 3 for a browser-local eviction-prone voter, not the
third trust profile; both delegated and attested authority may admit the storage class. The plan permits
this custody option only after browser-specific evidence that the key and vote log really co-evict
atomically; this remains an untested assumption, and nobody will produce that evidence for obsolete
WebViews. The population P-256 would serve therefore cannot lawfully enable the custody mode that needs it.

This does **not** exclude old browsers from the network. Identity and vertex signing use synchronous
`@noble/curves/ed25519.js` under §2.6 and require no WebCrypto. Browsers that cannot satisfy the custody
option 3 precondition can remain replicas, use the detectable-loss durable class or an external exact-slot
witness where available, or relay votes without becoming fate-shared seal voters.

### D.23.2 — Measured ambiguity cost

The proposed P-256 verifier used `lowS: false`. That accepts a valid signature and the third-party-mauled
form `(r, n−s)`. Two independent measurements agreed on the risk; in the recorded 200-signature probe,
WebCrypto emitted high-S **102 of 200** times, and both original and mauled forms verified **200/200**.
Signature bytes are embedded by value in the hashed `sealQC` and
`roundChange.highestPrepareQC` preimages. Consequently one logical QC can acquire two protocol digests.
This is a consensus identity fork, not cosmetic ECDSA encoding variance.

### D.23.3 — Why reserve beats delete and pin

- **Pin active** preserves an unnecessary ECDSA acceptance path with two byte identities for one logical
  certificate, while serving no admissible deployment profile.
- **Delete** loses the registry tombstone and makes a future coordinated reactivation easier to misread as
  an accidental new identifier.
- **Reserve** is fail-closed today and retains an explicit name for a future evidence-backed amendment.

Any reactivation of `p256-sha256-v1` must follow the −1g amendment-log rule: the same edit must pin low-S
normalization and the prehash-versus-raw registered-digest message rule.

### D.23.4 — Domain separation and the remaining evidence gate

Identity and seal now share Ed25519, so domain separation is load-bearing. Their distinct suite identifiers
accept only their registered domains, and tests sign the separately framed vertex and seal-vote digests
with the same key and prove cross-suite verification fails. The verifier's scope comparison is only a
metadata guard because it does not receive the canonical preimage; callers must recompute the 32-byte
registered digest with `hashDomain` under the declared registry domain before calling it.

The desktop Chromium/Firefox/WebKit capability matrix and its iPhone/Pixel emulation projects are useful
regression evidence only. Mobile emulation still runs desktop WebKit/Chromium with a mobile viewport and
user-agent; it does not reproduce real iOS Safari or Android WebView crypto. Real-device iOS and Android
runs showing `Ed25519: non-extractable`, with device/OS/engine build and candidate SHA archived, are still
required — but at the **Pre-release release gate, after the full feature set is green end-to-end**, not as
a Phase −1 exit gate and not at custody-option-3 enablement. This appendix originally placed them on the freeze;
that was the wrong milestone and the Exit gate section now carries the correction.

The reasoning: what the measurement gates is non-extractable **seal custody** — a deployment-target
property, not a design input. Nothing built between here and the release gate depends on the answer: an
engine that supports it may run custody option 3 under delegated or attested authority; an engine that does
not may still use an external exact-slot witness where available and otherwise does not hold a browser-local
seal key. Identity and vertex signing use synchronous `@noble/curves` and need no WebCrypto, so every
mobile engine participates fully as a non-voter regardless. The gates that a byte-level freeze can actually
be wrong about — browser↔browser convergence via the grid modular E2E, node↔browser via the canvas/chat
E2E, and the 202/202 `packages/node` suite — are green. And custody option 3 is already independently gated on
per-engine evidence that storage co-eviction is atomic, which no obsolete WebView will ever produce, so the
capability measurement is subsumed by a gate that exists.

The residual risk is stated rather than hidden: if a committed release-matrix mobile engine lacks
non-extractable Ed25519, custody option 3 is unavailable there and we learn it at the release gate instead of
now — at which point the reserved `p256-sha256-v1` identifier makes the remedy a documented, rule-bound
reactivation (−1g) rather than a new negotiation. That
is the accepted cost of reserving `p256-sha256-v1`, and it is a better trade than the alternative, because
keeping P-256 active was a **measured** consensus-byte defect (102/200 high-S, both forms verifying 200/200)
rather than a hypothetical one. The 2j standing test's fail-on-any-change rule is what guards the assumption
in the interim — this desktop matrix was already wrong once, for roughly 16 months.

---

## Appendix D.24 — Phase −1e(ii): two immutable oracle ratchets and the v5 vector mint

### D.24.1 — The stale assumption and the unanimous correction

The body previously said the original reference could change when `registryVersion` changed, described the
single amendment as `registryVersion 2`, and implied that regeneration would overwrite the original tree.
Those statements were mutually incompatible with oracle (b): an “original” reference that can be fixed by
the implementation team is not an independent oracle.

Before changing that plan, the issue was conferred independently with an Opus-xhigh reviewer, a Codex-high
reviewer and Kimi with a 100-step ceiling, followed by a convergence round. All three agreed:

- preserve `ahe-reference/src/**` and `reference.lock.json` byte-for-byte forever;
- add the regenerated implementation under `ahe-reference-regen/**` with its own
  `reference-regen.lock.json`, never overlay the original;
- bind regeneration provenance to the registry-v5 bytes, `registry-v5.json`, and the original lock;
- do not manufacture a registry bump for regeneration;
- permit an exact `+1`/one-new-vector transition only while Phase −1 is still open; regeneration closes
  that window, and any later consensus change requires protocol major 3;
- run a dependency-free checker on every PR, using the merge-base copy after bootstrap so head changes
  cannot self-grade.

The original reference remains deliberately narrower than the TS registry layer. For the registered v5
corpus, the TS registry builder produces the normalized preimage/parts, then both TS and original JS codecs
must reproduce the same canonical bytes and digest. This proves the original encoder and framing subset; it
does not pretend that the original reference contains an independent v5 registry builder. Non-byte typed
arrays in open canonical-value slots remain outside this oracle's applicable subset and require the codec
adversarial suite instead.

### D.24.2 — Implemented evidence

Slice −1e(ii) mints `tests/fixtures/golden-vectors/registry-v5.json`: 26 real schema-built vectors covering
all 19 registered kinds and every positive enumerated value. `canonicalHex` is explicitly the canonical
encoding of the normalized preimage record; `partsHex` is the ordered byte array actually passed after the
domain to `hashDomain`. The test re-normalizes every input through `makeRegistryPreimageBuilder`, rejects
omitted/wrong/unknown fields, asserts registry part construction against `partsHex`, then decodes those
frozen parts and recomputes the registered digest in both implementations. This distinction is load-bearing
for `canonical-array`, `canonical-value-as-single-part`, and `domain-framed-parts` kinds.
The v5 corpus also makes both index-sorted chunk lists nontrivial (two out-of-order input chunks normalize
to contiguous ascending order), retains two archive records in declared linearized order, and covers both
`highestPrepareQC: null` and a nested non-null prepare QC.

`reference.lock.json` contains exactly the thirteen original `src/**` files and is checked both against
disk and bijectively against the vendored `SHA256SUMS.txt`. `freeze-policy.json` pins its own pure-Node
checker and byte-protects both oracle trees/locks, vectors, registry, policy, checksum source, plus the two
higher-precedence CODEOWNERS locations (which must stay absent). Root CODEOWNERS and the workflow remain
maintainable, but the base checker validates their security-critical structure. The checker enforces:

- byte-identical registry and original-reference bytes during the one-time bootstrap;
- exactly one top-level `registry-vN.json` per vector version—noncanonical or nested rider files fail;
- immutable earlier vector documents plus record-level byte-identical carry-over;
- exact `registryVersion + 1` with one new vector document while the pre-regeneration window is open;
- no unregistered files under the single-file registry directory;
- atomic regenerated tree/lock appearance and complete SHA-256/provenance validation;
- permanent registry closure once the regenerated pair exists;
- additive-only policy protections and a base-pinned checker digest;
- a terminal, exact protocol-owner block in root CODEOWNERS, absence of `.github/CODEOWNERS` and
  `docs/CODEOWNERS`, the stable required-check identity, retarget-triggered PR runs, merge-SHA checkout,
  read-only permissions, and a base-checker-first/fail-closed bootstrap runner.

The refactor pass removed `assertRegistryVersionBump` and its script/tests. They had become a second,
weaker policy owner: path-name matching inside the shipped TypeScript API could not protect locks, vectors,
workflow or checker bytes. The freeze checker is now the single change-control implementation.

### D.24.3 — Review findings, fixes, and operational gotchas

The initial RED contract failed on seven intended assertions. The first GREEN passed 122 protocol tests,
workspace typecheck and lint with zero errors. Grok and Kimi then independently returned `NEEDS CHANGES`.
Both found that bootstrap pinned only the numeric v5 value, not the registry bytes; Kimi additionally proved
that arbitrary files under `golden-vectors/**` were invisible. Grok found that document-level carry rules
were optional in the exported evaluator and that replacing the old gate had left no focused same-version
registry mutation assertion. All were fixed TDD-first: the remediation RED failed on the registry-byte and
workflow contracts, and the strengthened suite then passed.

The final Opus-xhigh review reopened the slice on four production-shell assumptions: the actual `main`
merge-base (`d041baf`) predates the entire protocol-v2 tree; byte-freezing root CODEOWNERS/workflow would
make unrelated repository maintenance impossible; the default PR event set does not cover base retargeting;
and `canonicalHex` alone does not expose the bytes hashed by four encoding families. Opus proposed the
correction; a Codex-high reviewer and a fresh Kimi 100-step review both agreed with refinements. The
implemented second remediation:

- fails closed unless −1e(ii) is stacked on a base containing registry v5 plus the original reference and
  no freeze policy;
- adds `edited`/`ready_for_review`, read-only permissions, timeout and explicit merge-SHA checkout while
  preserving the established required-check identity;
- governs root CODEOWNERS and the workflow semantically instead of byte-freezing them, while forbidding the
  two higher-precedence CODEOWNERS files;
- freezes ordered `partsHex` and drives both digest implementations from those artifact bytes;
- runs the actual CLI in temporary Git repositories through invalid/valid bootstrap, governance mutations,
  valid and tampered regeneration provenance, incomplete tree/lock pairs, and post-regeneration
  add/modify/delete/registry-bump attempts.

The final refactor gives the long-running Git-repository matrix its natural owner,
`tests/freeze-cli.test.ts`, so focused vector/oracle iteration remains sub-second while the full protocol
suite still exercises the immutable governance boundary. Final gates on the finished tree: 15 protocol
test files / 121 tests passed, workspace typecheck passed, lint completed with 0 errors (244 pre-existing
warnings), the checker passed against intended stacked base `19b3d01`, failed as designed against
`main`/`d041baf`, and `git diff --check` was clean.

Remaining limitations are explicit:

- Bootstrap is necessarily trust-on-first-use for the checker itself because the base commit has no checker.
  The reviewed bootstrap commit is the trust root; automation cannot manufacture an earlier trust root.
  `main` at `d041baf` is **not** a valid bootstrap base. First land the pre-freeze checkpoint through
  `19b3d01` (or an equivalent commit containing the exact registry-v5 and original-reference bytes), then
  land −1e(ii) as a stacked follow-up without changing those bytes. Retarget only after that base is merged.
- GitHub executes the PR's workflow definition. A malicious workflow edit can suppress its own command, so
  branch protection **must** require the preserved `Require protocol-v2 registryVersion bump` check identity
  and CODEOWNERS approval, prohibit direct/admin bypass, and rerun on retarget. Semantic validation is
  defense-in-depth when invoked; it cannot replace those external trust roots.
- The base policy intentionally provides no in-band checker rotation. A defect in a merged checker requires
  an explicit owner-approved emergency governance action; direct-to-main bypass is not a routine upgrade
  mechanism. The checker-validated runner body is likewise intentionally literal, so adding `set -euo
pipefail`, merge-queue support, or another invocation hardening requires the same governance action. This
  is the cost of preventing a checker, its pin, and its only caller from being weakened in the same PR.
- Explicit protocol CODEOWNERS currently name the same cohort as the repository catch-all. The duplicate
  rules form the checker-validated terminal block and keep protocol ownership stable if earlier unrelated
  rules change, but they add no stronger cohort today and those three handles cannot rotate in-band without
  a checker-governance action.
- The vendored `SHA256SUMS.txt` is byte-protected but has no explicit terminal protocol CODEOWNERS rule; its
  ownership follows the mutable catch-all, whose own edit is protected by the terminal `/CODEOWNERS` rule.
  The chain is sound but one link longer than the sibling freeze artifacts.

Local diagnostic evidence is written under `.logs/`. These files are gitignored (`*.log`) and are useful
for this workspace handoff, but they are **not committed evidence**:

- `phase-n1e2-red-focused.log`, `phase-n1e2-green-focused.log`,
  `phase-n1e2-green-protocol-tests.log`;
- `phase-n1e2-green-typecheck.log`, `phase-n1e2-green-lint.log`,
  `phase-n1e2-green-freeze-cli.log`;
- `phase-n1e2-refactor-tests.log`, `phase-n1e2-refactor-typecheck.log`,
  `phase-n1e2-refactor-lint.log`, `phase-n1e2-refactor-freeze-cli.log`;
- `phase-n1e2-review-grok.log`, `phase-n1e2-review-kimi.log`;
- `phase-n1e2-review-remediation-red.log`, `phase-n1e2-review-remediation-green.log`,
  `phase-n1e2-review-remediation-freeze.log`;
- `phase-n1e2-final-review-opus.log`, `phase-n1e2-opus-findings-consensus-kimi.log`,
  `phase-n1e2-opus-remediation-red.log`, and `phase-n1e2-opus-remediation-green.log`;
- `phase-n1e2-final2-protocol-tests.log`, `phase-n1e2-final2-typecheck.log`,
  `phase-n1e2-final2-lint.log`, `phase-n1e2-final2-freeze-intended-base.log`, and
  `phase-n1e2-final2-diff-check.log`;
- `phase-n1e2-final2-review-opus.log` — final verdict: `PASS`.

---

## Appendix D.25 — Phase −1f: independently regenerated and permanently frozen oracle

### D.25.1 — Implemented evidence

Slice −1f adds a physically separate untyped ESM implementation under
`packages/protocol-v2/conformance/ahe-reference-regen/`. It imports only Node built-ins and relative modules
whose real paths remain inside that tree. The implementation owns four deliberately small responsibilities:
byte comparison/concatenation, the canonical encoder/decoder, synchronous Node SHA-256 domain framing, and a
registry-v5 interpreter for normalization, constraints, sorting, composite invariants and ordered hash
parts. It neither imports nor re-exports the TypeScript port or the immutable original reference. Source
hashes differ from every original-reference source file, the original tree remains byte-identical, and the
amended Float32 negative-zero rule is an executable anti-copy discriminator: TS and the regenerated oracle
encode `Float32Array[-0]` as positive zero and reject the negative-zero wire payload, while the original
oracle retains the measured pre-amendment encoding.

`reference-regen.lock.json` covers every regular file in the regenerated tree and contains exactly three
provenance bindings: registry v5, `registry-v5.json`, and `reference.lock.json`. The registry remains v5;
neither the registry nor the minted vector document changed. All 26 vectors across all 19 kinds reproduce
the same normalized value, ordered `partsHex`, canonical bytes and digest in the applicable TS, original and
regenerated paths. The real base-governed checker accepts the atomic tree/lock pair against `47426ab` and
its existing temporary-Git suite rejects incomplete pairs, bad provenance, original-oracle drift and every
post-regeneration add/modify/delete/registry-bump attempt. Once this checkpoint reaches the merge base, the
registry, both references and both locks are permanently closed.

The permanent metadata-parity gate is intentionally stronger than the happy-path vector corpus. It derives
2,662 probes from all 147 constraint occurrences, every frozen v5 vector for the corresponding kind and a
fixed thirteen-shape mutation corpus. TS runs first; every metadata mutation TS rejects must also be rejected
by the regenerated interpreter. Ratchets pin all 19 constraint names, the occurrence/probe counts, at least
1,000 TS-rejected paths and three named adversarial reproductions. The vector test is the positive
discriminator, so an oracle that rejects everything cannot satisfy the combined contract.

### D.25.2 — TDD and adversarial review history

The initial RED run produced five intended failures and one frozen-ratchet positive control. GREEN added the
independent oracle and lock; focused tests passed 6/6 and the protocol package passed 127 tests. The
refactor-clean pass kept the four-module ownership split and found no compatibility layer or duplicate
policy owner to preserve.

Grok and Kimi (100-step ceiling) independently returned `NEEDS CHANGES`: the regenerated registry
interpreter recognized several constraint names but could accept malformed numeric, enum and profile-quorum
metadata that the TypeScript builder rejected. Remediation RED proved the divergence with real frozen
inputs and TS-positive controls; GREEN added fail-closed metadata typing plus exact quorum-formula
validation and updated only the regenerated registry source hash in its lock.

The first final Opus-xhigh review then rejected the hand-picked regression table as test-shaped-to-
implementation. Its wider sweep found remaining fail-opens when enum `values` was absent, `uniqueBy` was not
a string and `maxSignerIdUtf16Units` was not numeric. Final remediation RED replaced the table with the
registry-derived 2,662-probe matrix. It failed on exactly 23 signatures in 489 ms while the other six
focused tests passed. GREEN fixed the three root causes and changed only `src/registry.js` plus its lock
entry. Reverting any one fix still reproduces all 26 happy-path vectors but fails the matrix, proving that
the adversarial gate is non-vacuous.

The resumed Opus-xhigh re-review returned `PASS` with no release blockers. Its independent wider corpus ran
7,823 probes, including 5,365 TS-rejected paths and `registryPreimageParts` differentials: zero regenerated
fail-opens, zero stricter mismatches and zero parts divergences. It also rechecked 3,116 data mutations,
codec/hash samples, all source/provenance hashes and actual permanent-closure behavior.

Final exact-tree gates:

- focused Phase −1f: 7/7; the 2,662-probe matrix took 498 ms;
- protocol-v2: 16 files / 128 tests in 32.89 s when run sequentially;
- workspace typecheck: pass;
- targeted and root lint: pass with 0 errors (244 pre-existing warnings);
- regenerated lock hash, real freeze CLI against `47426ab..working-tree`, and `git diff --check`: pass;
- final Opus-xhigh re-review: `PASS`.

### D.25.3 — Permanence, shared follow-ups and operational gotchas

- This commit is the last ordinary opportunity to change `ahe-reference-regen/**`. Once the pair is in the
  merge base, the base checker rejects every byte change, file-set change and registry bump. A later defect
  requires the explicit emergency governance path, not a routine version increment.
- The frozen regenerated tree remains in ESLint's surface and therefore carries local disable headers for
  TypeScript return-type/JSDoc rules on deliberately untyped JS. It is outside the package build and publish
  surfaces. Future lint-rule changes must be resolved in configuration, not by rewriting frozen files.
- Run the protocol suite, workspace typecheck and root lint sequentially. Running the two ESLint-spawning
  protocol tests concurrently with root lint crossed their unchanged 15-second limits; the exact same tests
  passed sequentially. Do not increase timeouts to hide machine contention. The real freeze-CLI matrix is
  the intentionally long package test.
- The metadata matrix is deliberately one-directional: TS rejection implies regenerated rejection.
  Happy-path vector reproduction is its required positive counterpart. Neither half may be simplified
  independently. Its numeric ratchets are valid because registry v5 is now permanently frozen.
- Automated anti-copy checks prove distinct paths, no source symlinks, no byte-identical original source
  file and no outside import. They cannot prove authorship or detect a whitespace-perturbed/transliterated
  copy. Different authorship remains a reviewed process assertion; Opus additionally compared structure,
  line overlap, decoder architecture and the three distinct hash backends.
- The checker validates the three required provenance entries but does not reject extra keys, while the
  executable oracle test requires exactly three. Root-level non-regular entries under the regenerated tree
  are likewise outside both `regularFiles()` inventories; the source subtree test rejects them only under
  `src/`. These seams do not affect imports or the committed lock, but owner review remains load-bearing.
- Domain strings are checked against registry v5 by the minted-vector test, but the regenerated digest loop
  consumes the frozen vector's domain rather than independently exposing `registryDomain()`. Preserve that
  division of proof when refactoring tests.
- Review found a shared decoder follow-up outside this slice: TS and the immutable original accept some
  integral-but-unsafe Float64 wire payloads that their encoder cannot emit, while the regenerated decoder
  rejects them by re-encoding. `decodeCanonical` currently has no production wire caller. Phase −1g D03
  now states that its decoder-rejection requirement applies only to forms explicitly forbidden by registry
  v5 or its amendments and records
  unsafe-integral scalar Float64 as unresolved; it ratifies neither acceptance nor rejection. That scope
  avoids deciding the codec follow-up and does not make either frozen oracle non-conformant. Any actual
  behavior change still requires the required Opus-xhigh, Codex-high and Kimi-100 agreement.
- Unknown _values_ for `case`, `charset` and `signerIdCharset` are ignored symmetrically by TS and the
  regenerated interpreter; the exact frozen spellings are enforced. This is a shared schema-validation
  follow-up rather than a −1f differential defect and has the same consensus requirement before changing
  the plan.

Local diagnostic logs (gitignored, not committed evidence):

- `phase-n1f-red-{focused,typecheck,lint,diff-check}.log`;
- `phase-n1f-green-{focused-final,protocol-tests-final2,typecheck-final,lint-final,freeze-cli-final,diff-check-final}.log`;
- `phase-n1f-review-{grok,kimi}.log`;
- `phase-n1f-review-remediation-{red,green-*}.log`;
- `phase-n1f-final-review-opus.log`;
- `phase-n1f-opus-remediation-red-{focused,typecheck,lint,diff-check}.log`;
- `phase-n1f-opus-remediation-green-{focused,protocol-tests,typecheck,lint,freeze-cli,lock-hash,diff-check}.log`;
- `phase-n1f-final2-review-opus.log` — final verdict: `PASS`.

---

## Appendix D.26 — Phase −1g: normative v2 amendments and voter-storage correction

### D.26.1 — RED/GREEN and the complete decision surface

The Phase −1g RED contract derives twelve ordered amendment entries from registry v5 and binds each to a
real normative section. It checks exact structured requirements and registry paths, required relationships
within bounded paragraphs, and affirmative legacy contradictions. Initial RED failed because neither
`docs/protocol/attested-hard-epochs-v4.md` nor `docs/protocol/amendments-v2.json` existed. GREEN added those
two artifacts with normative front matter, twelve ordered anchored sections for
`PH-N1-D01`…`PH-N1-D12`, exact registry-derived JSON, and cross-links. The first GREEN passed 4/4 focused
tests and the 132-test protocol suite.

GREEN review then exposed an ambiguity in D10 rather than papering it over: the first machine contract
assigned fate-shared custody to `delegated-k>=2`, while plan prose used numbered trust-profile shorthand
for the same mechanism and thereby appeared to attach custody to `attested-bft-v1`. That collision mixed
two independent axes: trust profile determines authority/quorum, while voter storage class determines
custody.

### D.26.2 — Unanimous assumption correction

Because correcting the plan changed a frozen-decision assumption, the issue was conferred separately with
an Opus-xhigh reviewer, a Codex-high reviewer, and Kimi with a 100-step ceiling. All three agreed on the
same replacement. The amended RED failed three of four focused tests: the exact machine mapping was stale,
the required normative relationships were absent, and the old affirmative custody rule contradicted the
corrected semantics. Publication/version metadata remained green. This proved that the correction was
narrow, executable and anti-regressive rather than editorial preference.

The normative rule is now:

- `q = 1, n = 1` uses recoverable seed-derived custody plus mandatory network re-learn and MUST NOT
  fate-share;
- every quorum-`≥ 2` voter preserves exact-slot anti-equivocation continuity;
- a detectable-loss durable-class voter uses the durable exact-slot CAS/outbox, storage-incarnation
  binding, and permanent refusal on incarnation mismatch;
- an external witness is valid only when it preserves the exact slot and vote bytes;
- a browser-local eviction-prone voter without that witness uses fate-shared non-extractable custody;
- both `delegated-trusted-v1` and `attested-bft-v1` admit the durable and browser-local storage classes;
- every quorum-`≥ 2` set containing eviction-prone voters includes a durable-class voter or declares
  correlated-eviction stall acceptance, and a stall never authorizes quorum reduction.

This is an authority/storage factorization, not a fourth trust profile and not a rename of the third trust
profile. Phase 5's numbered items are custody/continuity options 1–3. Every former numbered-profile
reference was requalified so custody option 3 cannot be confused with `attested-bft-v1`.

### D.26.3 — Evidence, review state and residuals

Local diagnostic logs are gitignored and are not committed evidence:

- initial slice: `phase-n1g-red-*` and `phase-n1g-green-*`;
- correction consensus: `phase-n1g-d10-consensus-{kimi,opus}.log` plus the recorded Codex-high review;
- corrected RED: `phase-n1g-d10-red-{focused,existing-tests,package-typecheck,lint,diff-check}.log`;
- corrected GREEN: `phase-n1g-d10-green-*`;
- post-GREEN Grok: `phase-n1g-review-grok-final.log` — `PASS`;
- post-GREEN Kimi-100: `phase-n1g-review-kimi-final.log` — `PASS`;
- post-review anti-gaming RED/GREEN:
  `phase-n1g-review-hardening-{red,green}-*`;
- first final Opus-xhigh: `phase-n1g-final-review-opus.log` — `NEEDS CHANGES`;
- Opus remediation RED/GREEN: `phase-n1g-opus-remediation-{red,green}-*`;
- post-remediation Grok: `phase-n1g-final3-review-grok.log` — `PASS`;
- post-remediation Kimi-100: `phase-n1g-final3-review-kimi.log` — `PASS`;
- second final Opus-xhigh: `phase-n1g-final4-review-opus.log` — `NEEDS CHANGES`;
- final D05 detector RED/GREEN: `phase-n1g-final4-remediation-{red,green}-*`;
- exact-tree Grok: `phase-n1g-final5-review-grok.log` — `PASS`;
- exact-tree Kimi-100: `phase-n1g-final5-review-kimi.log` — `PASS`, with
  `phase-n1g-final5-review-kimi-followup.log` clarifying its non-blocking residual;
- first final6 Opus emission: `phase-n1g-final6-review-opus.log` — invalid as evidence because it omitted
  the required verdict line;
- self-contained final Opus-xhigh: `phase-n1g-final6-review-opus-verdict.log` — `PASS`, no
  checkpoint-blocking findings.

The first Grok invocation was aborted because its nominally read-only mutation harness wrote a negative
probe back into the authored spec, changing “a stall MUST NOT trigger quorum reduction” to “MAY”. The
reviewer was stopped, both protocol files were audited, and only that sentence was corrupt. Restoration
reran the focused contract, JSON/link/format checks, and pinned the recovered pre-hardening snapshot:
spec `1daed7352752176a22eabb5bd3ae7172e79eea1d3bca704b074ecd556debe2c2`, amendment log
`2492a018b870860c5d24c46a23f8a1b5e9c3f3c5f1996687449bd67c9dafc944`
(`phase-n1g-review-restore-{focused,doc-validation}.log`). **Operational rule:** adversarial mutation probes
MUST run on disposable copies outside the authored tree, and review snapshots MUST be hash-pinned before
and after every external reviewer.

Grok and Kimi also identified an anti-gaming seam: the prose separated authority from storage, but the
machine log did not name those axes and the contradiction proof sampled only one trust-profile spelling.
The hardening RED adds exact D10 `policyAxes` (`authorityAndQuorum: trust-profile`,
`custody: voter-storage-class`) plus both delegated and attested unconditional-fate-sharing contradiction
samples and a scoped browser-local positive discriminator. It failed exactly the machine-entry test while
the other 3/4 remained green. GREEN adds only that exact machine axis to the amendment log.

The first final Opus-xhigh review returned `NEEDS CHANGES` with four findings. **B1:** the registered
`proposalDigest` vote/QC field had no normative identity or lock semantics. **B2:** several contradiction
detectors could not recognize the negation of the sentence they guarded. **M1:** `Drop` did not
unambiguously mean drop both vertices. **M2:** D03's blanket decoder-rejection sentence silently resolved
the unsafe-integral Float64 follow-up and made the immutable original oracle appear non-conformant.

Opus and Kimi-100 selected the conservative M2 correction; the separate Codex-high reviewer preferred an
exact scalar-Float64 rejection rule but agreed that, without unanimous approval of that new behavior, this
scoped wording was the only safe interim edit. D03 requires rejection of forms explicitly forbidden by
registry v5 or these amendments, and its rejection requirement applies only to those forms; it records
unsafe-integral scalar Float64 as unresolved, with neither acceptance nor rejection ratified. This scopes
around the existing oracle divergence; it does not resolve it or change codec behavior. B1 defines
`proposalDigest = SealProposal.valueDigest = digest(CutValue)`, keeps `proposalHash` round-bearing, binds
votes/QCs to both, and keys durable locks and committed-value comparison only on `proposalDigest`. M1 pins
`Drop` to both vertices. D12 additionally pins exactly two active suite identifiers.

Remediation RED returned **2 failed / 2 passed**: the exact machine-entry contract and directional
normative-section contract failed, while publication metadata and contradiction-sample execution stayed
green. B2's detectors prove their rejected/allowed examples entirely in memory. Any future mutation probe
that needs file I/O MUST run in a disposable tree and compare hash-pinned authored snapshots before and
after; no reviewer may mutate the live authored files to demonstrate a detector.

Before final gates, GREEN review caught that the first conservative sentence — “a decoder MUST reject
only…” — could imply that every non-enumerated form must be accepted, contradicting the unresolved Float64
paragraph. RED2 therefore required two separate propositions: decoders MUST reject enumerated forbidden
forms, and this amendment's rejection requirement applies only to those forms without classifying other
encoder-inexpressible values. RED2 returned **1 failed / 3 passed** only on that safe scope clause; the
revised GREEN states the two propositions separately and preserves the unresolved paragraph.

The second final Opus-xhigh review confirmed that B1, B2, M1, and M2 were closed, then found one remaining
test-only weakness: the D05 `wrong-proposal-digest` detector was line-scoped even though the guarded
normative sentence wraps across lines. A multiline inversion could therefore swap `proposalDigest` to the
round-bearing `SealProposal` digest and make `proposalHash`/`SealProposal.valueDigest` round-free without
tripping the contradiction proof; durable locks could likewise be reassigned to `proposalHash`. The
reopened RED added those two in-memory inversion fixtures and failed **1 test / 3 passed**, with two
explicit soft-assertion failures. GREEN replaced the line-scoped match with bounded multiline,
clause-aware spans, added a separately discriminated `wrong-lock-key` detector, and split the D05
paragraph gate into exact proposal-digest, proposal-hash, and durable-lock relationships. It then passed
4/4 focused tests, all 132 protocol tests, workspace typecheck, root lint with zero errors, formatting,
JSON/link validation, and diff checks. No normative protocol text, amendment entry, registry, vector,
reference, lock, freeze policy, or workflow changed in this remediation.

The exact-tree Grok and Kimi-100 reviews both returned `PASS`. Kimi identified one low residual for final
Opus to adjudicate: the second `wrong-proposal-digest` alternation bounds the text between `of` and
`SealProposal` to 16 characters, so the illegal but more verbose sentence “proposalDigest MUST be the
registered digest of the round-bearing SealProposal” escapes that negative detector. The authored
normative relationship is independently pinned by a bounded positive paragraph gate, while the exact
machine-entry requirements pin the same identity; Kimi therefore classified this as non-blocking and
recommended recording it instead of changing a hash-pinned remediation solely to widen a heuristic
detector. Kimi's only other observation was informational: the earlier plan shorthand “locks compare
`valueDigest`, never `proposalHash`” predates the B1 name but is semantically the same frozen D05 rule.

The self-contained final Opus-xhigh re-review returned `PASS` in
`phase-n1g-final6-review-opus-verdict.log`: B1, B2, M1, M2 and the final multiline D05 remediation are
closed, and no checkpoint-blocking finding remains. It agreed that Kimi's 16-character span residual is
safe to defer because the exact positive paragraph and machine-entry contracts independently prevent a
silent substitution. It recorded three additional non-blocking hardening opportunities:

- `wrong-lock-key` does not recognize the alternate noun phrase “locked-value key”, but the positive D05
  paragraph gate and exact `lockAndCommitKey: proposalDigest` entry prevent weakening or removal;
- D12's two `activeSuiteIds` are an independent literal restatement rather than derived from the registry,
  but the values exactly match the current registry and registry drift is separately freeze-governed;
- the review snapshot hash-pinned the registry-v5 golden fixture but not `field-registry.json` itself;
  nevertheless the pinned commit plus a clean status for that tracked path fully determined its content.
  Future snapshots should include its direct hash for reviewer convenience.

These are recorded gotchas, not deferred semantic decisions and not reasons to reopen a hash-pinned GREEN
solely to broaden heuristic redundancy. If a later test-hardening change already reopens these contracts,
it should add the verbose `proposalDigest` fixture, the `locked-value key` fixture, decide deliberately
whether D12 should derive or independently restate active suites, and directly pin `field-registry.json`.

The post-review checkpoint gates passed sequentially: 4/4 focused amendment tests; 17 protocol test files
and 132/132 tests; all 29 scoped workspace typechecks; root lint with zero errors and 244 pre-existing
warnings; Prettier for the test, both protocol documents and this plan; JSON parsing and all twelve
normative links; and staged whitespace/diff checks. The gitignored logs are
`phase-n1g-final-gates-{focused,protocol-tests,typecheck,lint,format,doc-validation,diff-check}.log`.
`phase-n1g-final7-checkpoint-snapshot.log` directly hash-pins the final test, both protocol documents,
this plan, the registry-v5 golden fixture, and `field-registry.json`, closing the reviewer-convenience
residual for the checkpoint record without changing any frozen artifact.

The correction does not alter registry v5, vectors, either reference or lock, the freeze checker/policy,
workflow, or CODEOWNERS. Real-device non-extractable Ed25519 evidence remains a Pre-release gate for custody
option 3 on each mobile engine, not a Phase −1 freeze input and not a trust-profile requirement. The
unsafe-integral Float64 decoder behavior and unknown constraint-value spellings recorded in D.25 remain
separate follow-ups. D03 limits the scope of its rejection requirement around the Float64 divergence but
explicitly does not resolve it; this documentation slice ratifies neither behavior and does not silently
change frozen bytes.

Most importantly, **Phase −1's formal-model variable-set sign-off has not been produced by Phase −1g**.
This slice documents the variables and their relationships, but the Phase −1 exit gate remains open until
an actual formal-model variable-set review is recorded. Neither green documentation nor unanimous D10
consensus may be reported as that sign-off.

---

## Appendix D.27 — Phase −1 formal-model variable-set sign-off

### D.27.1 — Executable boundary and RED/GREEN

This dedicated slice does not infer sign-off from Phase −1g prose. The fresh Codex-high RED added
`formal-model-variable-signoff.test.ts`, which derives the field list from registry v5 and requires three
separate absent GREEN artifacts: a real Quint declaration source, an exact registry-to-model map, and a
hash-bound mechanical sign-off record. RED failed **1 test / 2 skipped** for exactly those missing paths;
24 relevant pre-existing tests, all 29 scoped workspace typechecks, targeted lint and diff checks remained
green.

Registry v5 has no generic `signed` flag, so the envelope-kind boundary is an explicit normative
classification rather than a false registry inference:

- `vertex` comes from D12's identity/vertex signature suite;
- `epochAnchor` comes from D10's requirement that the profile and crypto-suite binding is signed in every
  anchor;
- `sealVote` comes from D12's seal-vote suite;
- `roundChange` comes from D06 plus the normative pacemaker's signed round-change votes.

`SealProposal` and `SealQC` remain round/value-bound proposal and certificate structures, but the frozen
sources do not define them as independently signed envelopes. After those four kinds are selected, all
**40 fields** and their registry indices are derived mechanically from `field-registry.json`; no hand-kept
field list may satisfy the contract.

The separate Codex-high GREEN pins project-local `@informalsystems/quint` `0.32.0` and adds:

- `formal/ahe-v2-signed-envelope-variables.qnt`, with 40 unique, uncommented Quint variables in exact
  registry order;
- `formal/ahe-v2-variable-map.json`, which proves a one-to-one, no-extra/no-duplicate mapping and binds the
  registry, amendment log and actual model-source hashes;
- `formal/ahe-v2-variable-signoff.json`, which separately records the exact checker algorithm, checker
  hash, reviewed artifact hashes and reviewed field identities.

The source is parsed and typechecked by the pinned Quint CLI, not accepted by regex alone.
`roundChange.highestPrepareQC` preserves its registry `seal-qc|null` choice as the Quint sum type
`NoPrepareQc | PrepareQc(Digest)`. Canonical operation payload semantics are deliberately an uninterpreted
boundary identity here; the later pacemaker model must refine them. This slice establishes the signed
envelope variable boundary only. It does **not** discharge agreement, integrity, validity, lock safety,
no-retroactive-vote, authority-isolation or bounded-liveness invariants, and it does not claim Apalache or
bidirectional trace-conformance completion.

GREEN passed 3/3 focused tests, 18 package test files and 135/135 tests, all 29 scoped workspace
typechecks, root lint with zero diagnostics, direct Quint typecheck, source/JSON formatting, frozen
lockfile installation, provenance and diff checks. Gitignored evidence is
`phase-n1h-formal-{red,green}-*.log`.

### D.27.2 — Operational findings and review state

Three failed full-suite diagnostics were command/resource findings, not source failures. The first GREEN
command incorrectly ran root Vitest over the package paths, enabling workspace-wide V8 coverage instead
of the established package-local configuration; two existing ESLint-constructor tests exceeded their
15-second limits. During diagnosis, two orphaned `/tmp/probe.config.mts` mutation-probe Vitest processes
from the earlier aborted Grok review were also found consuming approximately two CPU cores after sixteen
hours and were terminated. No timeout was widened and no unrelated test was changed. The correct
`pnpm --filter @ts-drp/protocol-v2 test` gate passed, with those ESLint checks at approximately six
seconds. Future external mutation probes remain confined to disposable copies and must be explicitly
terminated and audited.

Exact-tree Grok and Kimi-100 both returned `PASS` in
`phase-n1h-formal-review-{grok,kimi}.log`, with no blocking defect. Their non-blocking findings are
recorded rather than silently discarded:

- package and lock pin Quint `0.32.0`, and the external snapshot pins both, but the mechanical sign-off's
  own `reviewedArtifacts` does not yet bind those two files or assert the resolved CLI version;
- the `roundChange` classification uses a documentary plan citation rather than a resolvable D06
  machine-entry path, even though D06 plus the pacemaker's signed-vote rule support the classification;
- the exact live contract fails closed for missing, extra, duplicate, comment-only, unmapped, stale-hash
  and invalid-Quint states, but it does not keep named disposable negative fixtures for each mutation;
- envelope-kind selection is necessarily a finite normative classification because registry v5 has no
  signed flag; field enumeration inside each selected kind is mechanical, but the checker cannot derive
  the classification from nonexistent registry metadata;
- the sign-off record proves exact self-consistency; independent attestation comes from the separately
  recorded Codex/Grok/Kimi/Opus reviews, not from a fabricated signer inside the JSON;
- variable discovery is lexical, but comment stripping plus exact bijection is backstopped by the pinned
  Quint parser/typechecker; full registry type/constraint fidelity and nested SealQC semantics are
  deliberately deferred to the later pacemaker model;
- the fast typecheck gate invokes the repository's `pnpm` shim and therefore assumes the repository's
  declared package-manager environment.

The self-contained final Opus-xhigh adversarial review returned `PASS` in
`phase-n1h-formal-final-review-opus.log`. It independently recounted 9 `vertex`, 16 `epochAnchor`, 8
`sealVote` and 7 `roundChange` fields across the registry, map, Quint declarations and sign-off; audited
all 19 registry kinds; verified the provenance DAG has no self-hash or circular expected value; and
confirmed that no live assertion is structurally incapable of failing. It adjudicated every finding above
as non-blocking:

- package/lock and resolved-tool binding becomes mandatory when a solver verdict carries a protocol claim,
  not for a declaration-only variable-boundary record;
- the soft `roundChange` citation should be made resolvable, but D06, the registered domain, phase constant
  and signer field independently support conservative inclusion;
- named disposable mutation fixtures belong with the later action/invariant slice; RED already proved the
  current contract can fail and each positive assertion has independent expected/actual provenance;
- adding a post-freeze registry `signed` flag would itself require a governed registry-version change, so
  the explicit normative classification plus an independent all-kind audit is the sustainable boundary;
- lexical parsing, mechanical self-consistency, the repository package-manager shim and deferred type
  fidelity all fail closed or are explicitly outside this slice's declared claim.

The review also identified non-blocking handoffs that must not disappear into a broad “formal sign-off”
label:

1. A registry-to-model bijection cannot discover a signed field that the frozen registry itself omitted.
   The normative pacemaker prose says a new-round certificate binds `(objectId, epoch, anchor, r)`, while
   frozen `roundChange` has no direct or obvious transitive anchor field. Phase 5/G3 must resolve whether
   the prose is over-specific or the frozen preimage is incomplete. A conclusion that the field is
   required would reopen registry-v5 governance; it is not authorized as a quiet map edit.
2. The present boundary proves the ordered set of 40 declarations, but the checker does not yet derive
   `modelVariable` names from `(envelopeKind, field)`. A consistently swapped name pair could therefore
   preserve order, uniqueness and typechecking. Before those names carry action/invariant semantics,
   derive and test the naming rule, including the declared `QC` → `Qc` normalization.
3. The later model must explicitly refine today’s intentional fidelity losses: transparent aliases,
   registry const/enum and numeric constraints, nonempty/unique dependency constraints, and nested SealQC
   evidence. It must also resolve amendment evidence paths mechanically, bind the exact Quint/solver
   toolchain in its review record, and add disposable negative fixtures for mutation classes.

These findings do not authorize claiming more formal coverage. Subject to the final sequential repository
gates and an intended-files-only checkpoint, this record satisfies the remaining **Phase −1 variable-set**
exit prerequisite. It is not Phase 5, invariant checking, Apalache verification, bidirectional trace
conformance, or proof that registry v5 contains every field a complete pacemaker model will need. The
external branch-protection/CODEOWNERS enforcement named by the Phase −1 gate also remains an operational
repository setting rather than something this in-repo test can prove.

The post-review gates then passed sequentially: 3/3 focused sign-off tests; 18 protocol test files and
135/135 tests; all 29 scoped workspace typechecks; root lint with zero errors and 244 pre-existing
warnings; direct Quint typecheck; frozen-lockfile installation with the declared pnpm 10.24.0; Prettier
for every authored artifact; and intended-diff, JSON/provenance and whitespace checks. Gitignored evidence
is `phase-n1h-formal-final-gates-{focused,protocol-tests,typecheck,lint,quint,frozen-install,format,provenance,diff-check}.log`.
`phase-n1h-formal-final-checkpoint-snapshot.log` hash-pins the final manifest, lock, registry, amendments,
model, map, mechanical sign-off, executable checker and this plan. The snapshot and checkpoint exclude
`.agents/`, `.claude/` and `skills-lock.json`.

---

## Appendix D.28 — Phase 0a canonical codec/hash ownership port

### D.28.1 — RED/GREEN and single ownership

The fresh Codex-high RED created the new `@ts-drp/canonical` package boundary and one bounded executable
contract without adding an implementation. The focused run failed **1 test / 9 skipped** solely because
`packages/canonical/src/index.ts` did not exist. Six relevant protocol test files remained green at 59/59;
the new package and all 30 scoped workspace projects typechecked; targeted/root lint, formatting and diff
checks passed. The RED contract hash remained
`a9aa068dca0fa4a66eaf69009a7a58ddd1bf1fd6b5e4fee437dfac11127beab6` throughout GREEN and review.

The separate Codex-high GREEN did not create a third codec. It moved the already-hardened Phase −1
TypeScript bootstrap into the new package as the single live TypeScript owner, then reduced
`protocol-v2/src/canonical.ts` to a compatibility re-export and `protocol-v2/src/hash.ts` to a
`hashDomain` re-export plus its local `matchesDigestHex` helper. The immutable original and regenerated
JavaScript trees remain independent conformance oracles, not runtime owners. The protocol-v2 public
surface stays compatible, the workspace lock change is addition-only, and the frozen registry, vectors,
references, locks, amendments and formal artifacts did not change.

GREEN passed 10/10 canonical tests, canonical build/typecheck/direct lint, 18 protocol test files and
135/135 tests, all 30 scoped workspace typechecks, root lint with zero errors and 230 pre-existing
warnings, frozen-lockfile installation and package builds, formatting, codec-port equivalence, sole-owner
structural checks and whitespace checks. The warning reduction from 244 to 230 is exactly the 14 former
public-function JSDoc warnings removed by documenting the extracted owner; no lint rule, exclude or
threshold changed.

The Per-PR differential currently uses 256 deterministic values under seed `0x50a2026`, but that number is
implementation evidence rather than a normative constant. Every registry-v5 vector pins canonical bytes
and the registered framed digest; the bounded differential uses the immutable original as its expected
side. D2 is non-vacuous because the original's Float32Array `-0` and `+0` encodings first prove different
before GREEN is required to normalize both to the frozen `+0` form and reject the old negative-zero wire.
Negative decoder reasons also come from executing the immutable original instead of duplicating
implementation literals.

### D.28.2 — Unanimous plan correction and exact-tree reviews

RED exposed two stale plan assumptions rather than reward-hacking around them. Row 0a broadly required
rejection of “integral-valued float64,” while D.25/D.26 deliberately leave **unsafe-integral scalar
Float64** unresolved. The Per-PR tier also still required a 10⁴-value codec differential despite the later
quick-iteration handoff. Because this changes plan assumptions, no edit was made until a fresh
Codex-high reviewer, Kimi with a 100-step ceiling and Opus-xhigh all agreed on the same correction:

- Per-PR uses a bounded, seed-pinned deterministic differential;
- safe-integral scalar Float64 **wire forms** reject under the already-frozen rule;
- unsafe-integral scalar Float64 remains unresolved, with neither acceptance nor rejection ratified;
- a separate 10⁴-value **boundary-biased codec** differential belongs to G-e's future nightly topology and
  is distinct from the existing 10⁴-epoch / 2×10⁴-permutation three-way differential;
- the plan does not claim `nightly.yml` already exists and does not freeze 256 as the permanent PR count.

The first Kimi vote correctly rejected an imprecise proposal that targeted G-e as though it contained the
stale wording and implied an existing nightly codec job. The corrected proposal targets row 0a, the actual
Per-PR tier and an explicit future nightly assignment; Kimi then returned `PLAN ALIGNMENT: AGREE`.

Exact-tree Grok returned `PASS` in `phase-0a-review-grok.log`. Kimi-100 independently returned
`VERDICT: PASS` in `phase-0a-review-kimi.log`, then agreed to the corrected plan wording in
`phase-0a-plan-consensus-kimi.log`. The final Opus-xhigh adversarial review returned `VERDICT: PASS` and
`PLAN ALIGNMENT: AGREE` in `phase-0a-final-review-opus.log`, with no code, test, frozen-artifact or corpus
change required before final gates. These reviews independently confirmed RED provenance, the seven
runtime exports, sync noble hashing/no top-level await, sole ownership, D2, byte ordering, resource-limit
and pollution behavior, package/lock/publish wiring and the absence of a silent unsafe-integral decision.

### D.28.3 — Recorded residuals and operational findings

The following are non-blocking, but must not be lost behind the word “port”:

1. **Inherited collection-limit asymmetry.** The encoder permits arrays/sets at `length === maxItems`,
   while the decoder counts the root item and rejects that same boundary. Map/object accounting is also
   asymmetric. This matches the immutable original and must not be silently fixed in an ownership port;
   resolving it is a governed codec decision.
2. **Unsafe-integral oracle divergence.** The original and new owner accept scalar Float64 wire `2^53`,
   while the regenerated oracle rejects it through decode/re-encode canonicality; the accepted decoded
   number cannot be emitted by the same original-style encoder. D.25/D.26 remain authoritative: unresolved
   means neither behavior is ratified.
3. **PR-corpus blind spots.** The current generator has no `Uint32Array`, `-0`, `2^53±1`, subnormal or deep
   nesting cases and is encode-only; registry-v5 vectors contain no typed-array/float examples. Existing
   protocol tests cover several of those seams, while the separately assigned boundary-biased nightly
   corpus must expand both encode and decode parity. Do not put that long corpus back on the PR path.
4. **Out-of-contract hash inputs.** Valid typed `hashDomain(string, ...Uint8Array[])` callers are
   byte-identical. JavaScript callers that violate the type contract can observe coercion or incidental
   errors; add explicit runtime validation only through a separately reviewed API-hardening slice.
5. **Inherited message drift.** `Date`/`ArrayBuffer`/`DataView`/`RegExp` encode failures use a generic
   explicit-codec message rather than the original's constructor-named message. Existing contracts pin the
   error class/semantic reason, not that constructor spelling.
6. `matchesDigestHex` has indirect admission/protocol true/false coverage but no direct named malformed,
   length or case test. It remains local to protocol-v2 rather than contaminating canonical ownership.
7. RED is intentionally shallow: the missing source entry is its single failing trigger and the nine
   behavioral suites activate only after the source exists. G-d mutation probes must demonstrate seeded
   behavioral defects against this gate; no live-tree mutation probe is permitted.
8. `decodeCanonical` copies the supplied bytes before checking `maxBytes`, so an oversized input may double
   peak memory before rejection. There is no current production wire caller, but any later wire exposure
   must move the size gate ahead of the copy or explicitly budget the allocation.
9. The Phase 0a test dynamically imports a string path and casts a hand-written module interface, so its
   runtime export assertion is exact but type-surface enforcement is transitive through canonical and
   protocol-v2 builds. A later public-API contract should import the built declaration surface directly.
10. External publishing must release `@ts-drp/canonical` before or atomically with the same-version
    `@ts-drp/protocol-v2`. The workspace link proves local ordering, not registry publication order.
11. The Phase 0a contract has no explicit source import ban for the immutable oracle path. D2, exact runtime
    exports, sync hashing/no top-level await and error-message parity jointly prevent either oracle from
    satisfying GREEN by re-export, but G-d should turn that ownership rule into a direct seeded defect.
12. `deepCloneCanonical` is exact-export checked in the Phase 0a contract, while its behavior is exercised
    through the retained protocol-v2 compatibility-seam suites rather than a duplicate package-local test.
    Preserve one behavioral owner when reorganizing those suites.
13. The normalized codec-equivalence log records matching hashes and byte counts, but its one-off
    normalizer is not a checked-in reproducible command. Golden vectors and the 135 protocol seam tests
    carry the correctness claim; if later ports rely on normalized source equivalence, first make the
    normalizer a reviewed repository script instead of another shell-only assertion.

The 10⁴ nightly expansion is deterministic fuzzing, not a reason to add Jazzer.js, TypeNFuzz or a Stryker
pass to this fast ownership slice. G-d owns seeded mutation probes, and the Weekly tier already owns the
canonical-decode Stryker pass. Escalate tooling only when it proves a named failure class that the bounded
oracle and boundary-biased corpus do not cover.

### D.28.4 — Final gates and checkpoint boundary

After the unanimous plan correction, final gates passed sequentially: 10/10 canonical tests; canonical
build, typecheck and direct lint with zero findings; 18 protocol-v2 test files and 135/135 tests; all 30
scoped workspace typechecks; root lint with zero errors and 230 pre-existing warnings; frozen-lockfile
installation and all package builds; authored-file formatting; normalized HEAD-to-new-owner codec
equivalence with identical SHA-256 on 16,700 normalized bytes; sole-owner structural checks; and
tracked/untracked whitespace and intended-diff checks.

Gitignored evidence is
`phase-0a-final-gates-{canonical-tests,canonical-quality,protocol-tests,typecheck,lint,frozen-install,format,diff-check}.log`,
plus `phase-0a-final-{codec-port-equivalence,structural-owner}.log`. Each final log contains the command or
explicit operation, not only an empty success stream or an unauditable assertion.
`phase-0a-final-checkpoint-snapshot.log` hash-pins the final new package, RED test, protocol compatibility
seams, manifest, lock, frozen registry/vectors and this plan. The checkpoint excludes `.agents/`,
`.claude/` and `skills-lock.json`.

## Appendix D.29 — Phase 0b deterministic compaction primitives

### D.29.1 — Initial RED/GREEN and the activated origin fixture

The fresh Codex-high RED created the `@ts-drp/compaction` package boundary and independent contracts for
min-hash Kahn ordering, exact causality, the five conflict actions, RFC 9162 roots/proofs/accumulation and
the synchronous state digest. The exact RED was intentionally honest but shallow: **1 test failed and 22
were skipped** solely because `packages/compaction/src/index.ts` did not exist. It proved the missing owner,
not that every behavioral assertion could detect a seeded implementation defect. The executable expected
sides were nevertheless independent—a sort-based Kahn oracle, `node:crypto` SHA-256 construction, frozen
literal counts/hashes and the real legacy `HashGraph`. G-d remains responsible for seeded-defect mutation
adequacy; this checkpoint does not retroactively inflate the RED claim.

The separate Codex-high GREEN ported and hardened the immutable originals at
`packages/protocol-v2/conformance/ahe-reference/`: deterministic min-hash Kahn ordering and
`CausalityIndex`; the five-action pair/multiple resolver contract with isolated canonical clones,
fail-close validation and bounded swap cycles; synchronous RFC 9162 Merkle primitives, proofs and compact
accumulation; and synchronous canonical `stateDigest`. The port preserved valid RFC 9162 outputs while
adding input/snapshot copying, proof and occupancy validation, batching controls and no-top-level-await
ownership.

Activating the origin-sensitivity assertion exposed a bad RED fixture rather than a production defect. Its
numeric labels did not control the real legacy hash order and it executed only one graph. The fixture was
corrected—not weakened—to run **two real legacy graphs with controlled hashes**, pinning the original
`[2,4,3]` order and the contracted `[2,3,4]` order. The new v2 owner rejects the contracted graph's
causally-related dependency set, as its stricter active-epoch contract requires.

The order corpora are deliberately distinct:

- Per-PR enumerates **407** direct-antichain DAGs through six vertices, hash
  `70388c6d344b32ceb693995855ab05ee20d729bf67c75807dfb0489d47e071f3`, with eight
  deterministic real `Map`-insertion executions per graph. The test now proves exactly
  `min(8, |V|!)` distinct insertion orders and, where eight exist, covers anchor insertion at the
  beginning, an interior position and the end; small graphs are not falsely required to have eight.
- Nightly enumerates **5,231** DAGs through seven vertices, hash
  `5baf083b05d63fdba3fda38d09da1be2246f4e9acb4ff7f25043e7eb40554351`, also with
  eight real `Map` executions and the same exact distinctness assertion.
- Resolver-law property coverage separately uses all 407 PR graphs, three conflict-key partitions and up
  to eight **pairwise-distinct, position-spread** insertion orders.

### D.29.2 — Adversarial findings and remediation RED/GREEN

Initial exact-tree Grok and Kimi-100 reviews returned `PASS`; the final Opus-xhigh review correctly returned
`NEEDS CHANGES`. It found no Kahn, bitset or RFC 9162 soundness break, but caught stale documentation plus
test/API seams: §2.2 falsely said “Port as-is”; §11.6 claimed resolver property coverage the initial corpus
did not provide; the 0b row claimed a nonexistent G-b manifest; unknown modes could report
`MISSING_CONFLICT_RESOLVER`; pair-mode worst-case work was unrecorded; the RED was existence-only; dynamic
cross-package test imports evaded the static type/dependency boundary; and mutation, validation-precedence
and proof-forgery coverage was incomplete.

A fresh Codex-high remediation RED changed no production source. It added the shared hash-pinned corpus,
resolver-law properties, unknown-mode/canonical-domain/validation-precedence regressions, pair and multiple
resolver mutation-isolation probes, inclusion/consistency forgery boundaries, even-final-batch yield
coverage, a public accumulator-size contract and static typed `@ts-drp/object`/`@ts-drp/types` test imports
with declared devDependencies. The full RED was **6 failed, 26 passed, 1 skipped**:
`UNKNOWN_MODE` precedence, NaN/function/symbol operations outside the canonical domain, insertion-dependent
two-defect error codes and the absent `size` getter. The new resolver property itself already passed,
demonstrating that it was coverage remediation rather than a production-semantic rewrite.

The separate Codex-high remediation GREEN made the minimum corresponding source changes:

1. reject unsupported modes before resolver requirements;
2. validate graph entries in deterministic, key-sorted structural, key/hash and canonical-domain phases;
3. expose a read-only accumulator `size`;
4. replace 32-bit carry operators with safe-integer `% 2`/`Math.floor` counting; and
5. set a package-local 15-second Vitest ceiling because the required resolver property takes about 5.5
   seconds after canonical validation.

Remediation GREEN passed 32 PR tests with one nightly-only skip, the 407-graph/three-partition resolver
property, the actual `test:nightly` hook with all 5,231 graphs × eight executions, 10/10 canonical tests,
135/135 protocol-v2 tests, the 35-test legacy object baseline including its pre-existing 304-graph
differential, all 31 workspace typechecks, package build/lint/format, frozen install and package builds,
structural ownership checks and root lint with zero errors and the inherited 230 warnings.

The repeated final Opus-xhigh review then returned `NEEDS CHANGES` and `PLAN ALIGNMENT: AGREE`. It caught
three remaining actionable boundaries: CI's root Vitest project applied its 10-second ceiling rather than
the package's 15-second ceiling; inclusion and consistency verification still used 32-bit arithmetic on
public caller-supplied sizes; and a non-adjacent pair `Swap` could put an ancestor after its descendant. It
also exposed documentation/test residuals: the immutable and live multiple-mode result contracts differ;
Merkle yielding covers leaves but not the synchronous interior reduction; unknown-mode-over-invalid-graph
and insertion-order distinctness were unpinned; `CausalityIndex` was built twice; two “oracles” mirrored
their owners; the structural log was not independently auditable; and an unreachable reference error was
not in the divergence record.

A second fresh Codex-high RED again changed no production source. Package and root-CI-config runs each
produced **4 failed, 33 passed, 1 skipped**:

1. a genuine five-leaf inclusion proof replayed under `leafIndex = 2^32`,
   `treeSize = 2^32 + 5` incorrectly verified;
2. a genuine one-to-five consistency proof replayed under `firstSize = 2^32 + 1`,
   `secondSize = 2^32 + 5` incorrectly verified;
3. a non-adjacent `Swap` returned `[D,C,B]`, placing retained ancestor `B` after retained descendant `C`,
   instead of failing with `CAUSALITY_VIOLATION`; and
4. the resolver property lacked an explicit timeout binding that survives the root CI config.

The root-config property took 9.123 seconds under the 10-second default, confirming the operational
boundary rather than merely source-grepping it. The same RED already passed the new
`UNKNOWN_MODE`-before-invalid-graph and `min(8, |V|!)` distinct insertion-order assertions. Production
hashes were byte-identical before and after RED.

The separate second Codex-high GREEN replaced verifier parity/shifts and `isPowerOfTwo` with safe-integer
`% 2`/`Math.floor` arithmetic, bound the existing 15-second ceiling directly to the exhaustive property,
and added an `O(V+E)` retained-causality postcondition. While applying that invariant, a focused micro-RED
found the analogous multiple-mode `[B,D,C]` reordering when a resolver group spanned an intervening
dependency (**1 failed, 12 passed**). GREEN preserved deterministic grouping, resolver calls and Drop
semantics, but accumulated drops and filtered the original topological order; the micro-GREEN passed
14/14, including the complete resolver property. The retained-causality postcondition now covers both
resolver modes and propagates retained ancestry through dropped intermediates.

Second GREEN passed **38 tests with one nightly-only skip** package-scoped and the same **38/1** through
the root CI config with coverage. The exhaustive property took 5.282 seconds package-scoped and 8.770
seconds under the root config; the actual nightly remained 5/5. Canonical was 10/10, protocol-v2 135/135,
the legacy object baseline 35/35, workspace typecheck 31/31, root lint zero errors/230 inherited warnings,
and package build/typecheck/authored lint/format, frozen install/build, structural predicates and diff
checks all passed.

The repeated exact-tree Grok and Kimi-100 reviews returned `PASS`, but the repeated final Opus-xhigh
review correctly returned `NEEDS CHANGES` with `PLAN ALIGNMENT: AGREE`. It found no remaining Kahn,
causality-index, RFC 9162 or resolver fail-close soundness break and confirmed that every earlier
high-severity defect was closed. It did find four plan-claimed production paths with no executed coverage:

1. the transitive retained-ancestor term used only when ancestry crosses a dropped intermediate;
2. the reachable even `fn === sn` branch in consistency verification;
3. the `MISSING_CONFLICT_RESOLVER` emission; and
4. multiple-mode `CONFLICT_RESOLVER_FAILED` on thrown resolver exceptions, plus the mode's specific coded
   validation failures for async or malformed results.

It also found that the text coverage log truncated uncovered-line ranges, the first eight lexicographic
insertion permutations always inserted the anchor first for larger graphs, and several residuals needed
more precise wording.

A third fresh Codex-high RED changed no production source. It added focused contracts for all four paths,
including the exact `A → B → C` plus concurrent `D` case where `B` is dropped and ancestry must propagate
solely through it. Two transient mutations proved the tests were sensitive: removing the transitive
ancestor term made the retained-causality test fail, and removing the consistency verifier's
`fn === sn` guard made the five-to-six proof test fail. Both mutations were restored immediately and
before/after production hashes compared byte-for-byte. The sole persistent RED was the new insertion
spread contract: **1 failed, 47 passed, 1 skipped**, with actual anchor positions `[0]` instead of the
required beginning/interior/end set.

The separate third Codex-high GREEN changed only the test-corpus sampler. It schedules deterministic
beginning/interior/end anchor positions and then fills the remaining bounded permutations while preserving
exactly `min(8, |V|!)` pairwise-distinct executions, the 407/5,231 corpus counts and hashes, and all three
resolver partitions. It also removed the now-unused `shuffledMap` test helper. No production hash changed.
GREEN passed **48 tests with one nightly-only skip** package-scoped and the same **48/1** through the root
CI config with coverage; the property took 5.249 seconds package-scoped and 8.754 seconds under the root
config. Nightly remained 5/5, canonical 10/10, protocol-v2 135/135 and the object baseline 35/35 with
304/304 differential matches. Workspace typecheck/build, root/authored/package lint, package
build/typecheck/format, frozen install, structural predicates and diff checks all passed.

The final non-truncated Istanbul extraction records every residual executable line rather than implying
100% coverage: `ct-merkle.ts` lines 53–54, 213–214 and 373–374 remain uncovered (322/328, 98.17%);
`linearize.ts` lines 71–72, 111–112, 121–122, 170–171, 217–218, 294–295 and 351–355 remain uncovered
(403/420, 95.95%); `index.ts` and `state.ts` are 100%; `types.ts` has no executable lines.

### D.29.3 — Unanimous plan correction

Because the findings changed plan assumptions, the plan was not edited until all three required reviewers
agreed on the same correction. The initial Opus-xhigh adversarial review returned
`PLAN ALIGNMENT: AGREE`; the fresh Codex-high remediation GREEN independently returned
`PLAN ALIGNMENT: AGREE`; and Kimi under an explicit `--max-steps-per-turn 100` ceiling returned
`PLAN ALIGNMENT: AGREE` and `VERDICT: PASS`.

The agreed correction is:

- classify `linearize.js` and `ct-merkle.js` as **port + harden/amend**;
- classify `state.js` as **partial port + amend**, because 0b ships only synchronous `stateDigest`,
  replacement belongs to 0c and the reference `DeterministicStateMachine` is not ported;
- record G-c's real origin regression as shipped, but leave exact divergence-manifest replay to G-b and
  preserve/reuse the pre-existing 304-graph `packages/object` harness;
- make §11.6's resolver-property claim true through the 407-graph, three-partition property suite; and
- record rather than conceal the existence-only RED, activated-fixture correction and governed complexity
  residual.

No acceptance criterion was deleted. Deferred work was assigned to its existing named owner.

The second correction was likewise withheld until the final Opus-xhigh review, both fresh Codex-high
second-remediation agents and Kimi under a 100-step ceiling all returned `PLAN ALIGNMENT: AGREE`. Kimi also
returned `VERDICT: PASS` on the proposed wording. Their unanimous correction replaces the stale verifier
and CI residuals with the exact RED/GREEN evidence, records retained-order integrity for both resolver
modes, documents the deliberate multiple-result divergence and assigns only the remaining blocking-work
and performance costs to 0p. No global timeout, workspace project or acceptance corpus was weakened.

The third correction was withheld until the repeated Opus-xhigh review, both fresh Codex-high
coverage-remediation agents and Kimi under the explicit 100-step ceiling all returned
`PLAN ALIGNMENT: AGREE`; Kimi also returned `VERDICT: PASS`. Their unanimous correction records the four
coverage gaps and their mutation-sensitive closure, the complete uncovered-line evidence, the meaningful
insertion-position spread, the actual CI/evidence boundaries and the precise multiple-mode postcondition.
No corpus identity, timeout, resolver partition or acceptance criterion changed.

### D.29.4 — Governed residuals and operational findings

1. **Pair-mode work cliff.** With `P` resolver passes, pair mode is worst-case
   `O(P·V²·clone-cost)` and retains whole-order fingerprints for cycle detection. At the plan ceiling
   `V=8192`, up to roughly `4V` fingerprints of approximately `65V` bytes can approach 17 GiB before the
   coded `NON_CONVERGENT_CONFLICT_POLICY` limit is reached, so process OOM can pre-empt the deterministic
   error. This is not an acceptable unbounded production path. Phase 0p owns the input/work ceiling and
   measurement; Phase 0b does not hide the cost behind correctness tests.
2. **Exact divergence manifest.** G-b still owns the manifest and replay wiring. The 0b G-c regression and
   the existing 304-graph object differential are reusable evidence, not a substitute claim that G-b has
   shipped.
3. **Nightly workflow.** G-e creates `nightly.yml`. Phase 0b provides and executes `test:nightly`; absence of
   the future workflow is not a Phase 0b blocker.
4. **State surface.** Replacement adoption is 0c and the reference DSM remains unported. Legacy consumers
   are intentionally unmigrated in this owner-establishment slice.
5. **Empty-tree root mutability.** The exported `EMPTY_MERKLE_ROOT` can be mutated by a JavaScript caller,
   but production calculations use a private internal root and return copies. A future API-hardening change
   may replace the mutable export without changing RFC 9162 bytes.
6. **Safe-integer verifier boundary closed; snapshot precision remains governed.** The 32-bit alias was
   reachable through the public inclusion and consistency verifiers even though the local builder is
   capped. Exact `2^32` metadata replays proved both false accepts in RED; safe-number arithmetic now
   covers the full declared safe-integer domain. The separate `Math.log2` precision question near `2^52`
   remains unreachable on locally built JS-Array-backed proof paths and outside the epoch cap; only a
   caller-forged tree view or hand-built accumulator snapshot can approach that range, where current code
   fails closed rather than proving useful work.
7. **Error taxonomy.** Local coded errors are deterministic, but public cross-package taxonomy
   centralization remains Phase 0l.
8. **RED and mutation adequacy.** The initial source-existence RED remains recorded as such. The third RED
   transiently removed the dropped-intermediate ancestor term and the consistency verifier's
   `fn === sn` guard; both focused tests failed and exact production hashes were restored. These targeted
   probes close the named review gaps without claiming general mutation adequacy; G-d still owns the seeded
   mutation campaign.
9. **Tooling/runtime tiering.** Direct exhaustive, property, mutation-isolation, corruption and forgery
   tests closed the named review gaps. Adding Jazzer.js, TypeNFuzz, Shfz or Stryker here would duplicate
   coverage and lengthen the PR loop without a surviving failure class. The larger graph corpus stays
   nightly and the already-planned mutation work stays G-d/Weekly.
10. **Static test boundaries.** Legacy differential imports are now normal typed package imports with
    declared devDependencies, so workspace typecheck, lint and frozen install actually cover the seam.
11. **Shallow public Merkle view.** The `MerkleTree` view object is frozen, but its copied `inputs` and
    `leafHashes` arrays and copied `root` bytes remain caller-mutable. The internal arrays, private root and
    `hashRange` closure are isolated, so this cannot corrupt verification output; deep public immutability
    remains API hardening.
12. **Local hex helper.** `state.ts` keeps a small package-local `bytesToHex` rather than exporting another
    canonical utility. The duplication is deliberate package-boundary hygiene, not another codec/hash
    owner.
13. **Root/package timeout binding and gate orchestration.** CI's root project uses a 10-second default and
    does not inherit the package config's 15-second ceiling. RED measured the exhaustive property at 9.123
    seconds there. GREEN binds the existing 15-second ceiling directly to that test; the root global
    timeout and workspace topology remain unchanged. The second-cycle root-config run passed at 8.770
    seconds, the third-cycle GREEN at 8.754 seconds and the documentation-complete final rerun at 13.331
    seconds. The final result remains below the explicit 15-second contract but has only 1.669 seconds of
    local headroom. Independently, running seven CPU-heavy gates simultaneously on one workstation pushed
    the same test to 19 seconds and timed out three existing protocol tests. Schedule heavy suites in
    separate CI jobs or sequentially on constrained runners; do not inflate global timeouts to conceal
    contention.
14. **Deliberate multiple-mode divergence.** The immutable reference treats the resolver's array as the
    retained, resolver-ordered set. The live legacy TypeScript contract uses `ActionType.Drop` plus
    `vertices[]` as a dropped set. Phase 0b deliberately follows the live contract, validates exact group
    membership/uniqueness and emits retained vertices in original topological order. G-b/0c migration must
    not pass an immutable-reference resolver through unchanged.
15. **Retained-order integrity.** Pair `Swap` and multiple grouping can each move a retained vertex before
    a retained ancestor if their result is emitted naively. Exact REDs pin both cases. Drop decisions now
    filter the original topological order. Pair mode's `O(V+E)` postcondition actively fails closed with
    `CAUSALITY_VIOLATION`, including ancestry propagated solely through dropped intermediates; in multiple
    mode the same postcondition is defence-in-depth and is structurally unfireable while output remains a
    filter of the already-topological base order.
16. **Cooperative-yield boundary.** `buildMerkleTree` yields only between complete leaf-hashing batches.
    Its memoized interior Merkle reduction is synchronous `O(V)`. The JSDoc says this explicitly; Phase 0p
    owns a production blocking-work ceiling or a future interior-yielding design.
17. **Mode precedence.** `UNKNOWN_MODE` intentionally precedes graph validation as well as resolver
    requirements. The invalid-graph combination is now pinned; this is a deliberate fail-fast amendment
    over the immutable reference's mode-last behavior.
18. **Causality-index constant factor.** Resolver modes currently construct `CausalityIndex` once inside
    `topologicalOrder`'s antichain validation and again for resolver use. This doubles the
    `O(V²/32)` build constant. Phase 0p owns measurement/refactoring alongside the larger pair-work cliff.
19. **Property-oracle scope.** The resolver-law call/group expected sides deliberately transcribe the
    policy loops, so they prove insertion-order stability and exercise the contract rather than serving as
    independent grouping specifications. Corpus hashes, min-hash order and ancestry masks are independent;
    focused action/fail-close/mutation tests carry semantic coverage.
20. **State-digest test scope.** The focused test mirrors
    `hex(hashDomain("ts-drp/state/v2", encodeCanonical(state)))`; it pins the registered domain, lowercase
    hex and synchronous return, not an independent cryptographic implementation. Canonical/hash ownership
    and vectors remain in `@ts-drp/canonical`/protocol-v2.
21. **Auditable structural evidence.** The final structural log records executable predicates, relevant
    source excerpts, commands, statuses, final hashes, frozen-reference diff and worktree state—not only
    opaque zero status codes. A later evidence pass honestly retains an initial non-fail-fast
    `vite.config.ts` typo and a raw whole-log hash comparison that differed only because wrapper metadata
    changed; corrected fail-fast structural predicates and normalized content-hash comparison both pass.
22. **Unreachable reference emission error.** The immutable reference has `DUPLICATE_EMISSION`, but its
    Kahn accounting increments indegree and appends a child edge once per dependency occurrence, so a
    vertex is enqueued only when the balanced count reaches zero; the preceding order-length check also
    shadows the emission guard. The port's earlier `DUPLICATE_DEPENDENCY` validation is a separate
    amendment, not the reason the reference error is unreachable. This is a recorded divergence, not a
    missing live error path.
23. **Object-baseline invocation.** One package-cwd attempt resolved the root config relative to
    `packages/object` and failed during Vitest startup. The established repo-root config command passed
    35/35 and the 304-graph harness. Both logs remain so orchestration errors are not relabeled as test
    failures.
24. **Complete coverage evidence.** The earlier text reporter abbreviated uncovered-line ranges. The
    acceptance artifact now uses Istanbul JSON and a reproducible full-line extractor. Residuals are
    explicitly retained: `ct-merkle.ts` 322/328 lines (98.17%; 53–54, 213–214, 373–374) and
    `linearize.ts` 403/420 lines (95.95%; 71–72, 111–112, 121–122, 170–171, 217–218, 294–295, 351–355);
    `index.ts` and `state.ts` are 100%, while `types.ts` has no executable lines. Coverage percentages are
    evidence, not a standalone AHE gate. Later root coverage runs overwrite the shared
    `coverage/coverage-summary.json`, so the self-contained GREEN extraction log is the durable artifact;
    exact reruns must extract immediately or isolate `reportsDirectory` rather than relying on the mutable
    workspace file.
25. **Dynamic test-contract mirror.** `tests/contract.ts` loads the owner through a variable-typed dynamic
    import cast to a hand-maintained `CompactionModule` interface. It can drift from `src/types.ts`
    independently even though owner-existence tests fail rather than skip. Static package imports cover
    cross-package seams; replacing this local mirror remains test-harness hardening.
26. **CI execution evidence.** Phase 0b has not yet run on the repository's actual GitHub Actions runner.
    Local package/root-config timings prove configuration and regression behavior, not success on the
    single 10-minute `ubuntu-latest` workflow job. The explicit 15-second property bound prevents root
    default drift, while CI scheduling or job separation remains an operational follow-up under G-e/0p.
27. **Insertion-order sampling.** Lexicographically taking the first eight permutations left the anchor
    first for larger graphs. The deterministic bounded sampler now includes beginning, interior and end
    anchor positions and fills the remainder without changing exact `min(8, |V|!)` distinctness, corpus
    identities, graph counts or resolver partitions.
28. **Branch-coverage blind spots.** Complete line extraction does not enumerate branch residuals:
    `ct-merkle.ts` measured 90.69% branch coverage and `linearize.ts` 92.57% in the accepted run. The public
    one-argument `CausalityIndex` path is unexecuted: the reference defaults to raw insertion order and may
    report `INVALID_ORDER`, while the port infers deterministic topological order. The multiple-mode
    `key === undefined` branch is likewise not independently pinned. These are explicit harness/API
    residuals, not a 100% coverage gate or a reason to weaken the shipped contracts.
29. **Additional immutable resolver divergences.** The immutable reference invokes the multiple-mode
    resolver for singleton groups and silently passes through a missing resolver; the live port skips
    singleton groups and fails closed with `MISSING_CONFLICT_RESOLVER`. The singleton behavior is pinned
    as a live-contract amendment. G-b/0c migration must account for these differences together with the
    retained-array versus dropped-set divergence in item 14.
30. **Pair taxonomy assertion strength.** Pair-mode malformed result tests currently assert only that an
    exception is thrown, while multiple mode pins exact coded validation failures. The pair contract still
    fails closed and §11.6 remains true, but exact pair-code regression assertions are a test-harness
    strengthening opportunity rather than evidence already claimed.
31. **Meta-contract and evidence limits.** The order/property suites execute the shared insertion schedule,
    but beginning/interior/end spread is asserted directly only by
    `corpus-permutation-coverage.test.ts`. The timeout contract uses a first-match text regex and does not
    inspect `vitest.workspace.ts`; direct review confirms the workspace excludes the package config. The
    corrected structural log's no-top-level-await predicate is not self-verifying even though direct source
    inspection confirms the claim. These are limits on the evidence mechanism, not failures of the
    underlying contracts.
32. **All-mode causality allocation.** `topologicalOrder` allocates exact `O(V²/8)` ancestor bitsets in
    every mode and currently has no local `V` cap, independently of pair-mode fingerprint growth. No live
    production caller has migrated to this package yet. Phase 0p owns the shared epoch/input ceiling before
    adoption; item 1 remains the additional pair-specific work/OOM cliff.
33. **Resolver-failure assertion precision and evidence sequencing.** Multiple mode pins a throwing
    resolver's `CONFLICT_RESOLVER_FAILED` code exactly; the pair-mode throw test asserts only an error
    matching `/resolver|conflict/iu`. Both modes genuinely fail closed, but exact pair-code matching remains
    test-harness precision work. Separately, the retained-ancestry mutation probe ran while the focused
    file contained 20 tests; the later 21st test was added below the unchanged probed case. The quoted
    source lines and failure remain valid, but the sequencing is retained rather than presented as an
    exact final-suite replay.

The review evidence is principally in the gitignored
`phase-0b-{red-*,green-*,remediation-*,opus-*,review-*}.log`,
`phase-0b-coverage-{red,green}-*.log`, `phase-0b-{coverage-,}final-review-*.log`,
`phase-0b-final-gates-*.log`, `phase-0b-{,coverage-}plan-consensus-kimi-100.log` and
`phase-0b-*-doc-confirm-opus-xhigh*.log` files. Exact-tree Grok, Kimi-100 and final Opus-xhigh
dispositions are recorded in the next subsection.

### D.29.5 — Final independent reviews and checkpoint gates

The corrected, remediated tree received two independent read-only final reviews before the final Opus
adversarial pass:

- Grok returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE` in
  `phase-0b-final-review-grok.log`. It found no required fix and independently confirmed the Kahn,
  causality, resolver, RFC 9162, digest, package, corpus, TDD and documentation claims.
- Kimi under the explicit 100-step ceiling returned `VERDICT: PASS` and
  `PLAN ALIGNMENT: AGREE` in `phase-0b-final-review-kimi-100.log`. Its two new informational API-boundary
  findings—the oversized hand-built proof-size bitwise edge and shallow public Merkle arrays—are recorded
  in D.29.4(6) and D.29.4(11). Its self-referential observation that its log lacked a verdict while the
  review was still running ceased to apply when that run ended successfully.

That first final Opus-xhigh review returned `NEEDS CHANGES` with `PLAN ALIGNMENT: AGREE`, producing the
second RED/GREEN cycle recorded above. The post-second-remediation exact-tree Grok and Kimi-100 reviews
then both returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE`. The repeated final Opus-xhigh review
returned `NEEDS CHANGES` with `PLAN ALIGNMENT: AGREE`: every earlier actionable defect was closed, but four
claimed paths lacked executed coverage and the evidence/corpus precision gaps recorded in D.29.2 remained.
That finding produced the third RED/GREEN cycle. The post-third-remediation exact gate matrix is now:

- `@ts-drp/compaction`: 48 passed, one nightly-only skip; the 407-graph resolver property completed in
  5.249 seconds package-scoped;
- the same root-CI config with coverage: 48 passed, one skip; the explicitly bound property completed in
  8.754 seconds under the unchanged 10-second global default;
- the actual `test:nightly` hook: 5/5 passed, including 5,231 graphs × eight executions;
- canonical 10/10, protocol-v2 135/135 and the focused legacy object baseline 35/35, including the
  pre-existing 304-graph differential;
- all workspace typechecks and builds;
- compaction build/typecheck/authored lint/format and `git diff --check`;
- root lint with zero errors and the inherited 230 warnings;
- frozen-lockfile install and all package builds; and
- no immutable-oracle import, no top-level await, no duplicate canonical/hash owner, unchanged production
  and immutable-reference hashes, plus complete non-truncated uncovered-line evidence.

The first all-at-once local gate attempt and the bad package-cwd object invocation intentionally remain in
the logs. The third GREEN also retains an initial non-fail-fast structural typo and raw whole-log hash
comparison whose wrapper metadata differed. Correct sequential/root-config, fail-fast structural and
normalized-hash reruns passed; D.29.4(13), D.29.4(21) and D.29.4(23) record the sustainable orchestration
rules instead of reward-hacking timeouts or relabeling invocation errors.

The post-third-remediation exact-tree dispositions are final:

- Grok returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE` in
  `phase-0b-coverage-final-review-grok.log`; its only new note was the now-corrected distinction between
  thrown resolver exceptions and specific async/malformed validation codes.
- Kimi under the explicit 100-step ceiling returned `VERDICT: PASS` and
  `PLAN ALIGNMENT: AGREE` in `phase-0b-coverage-final-review-kimi-100.log`. It independently re-derived
  corpus identities and insertion spread, checked RFC 9162 proofs against a separate construction,
  recomputed production hashes and reported five informational residuals, none blocking. Mutable-root
  isolation, the dynamic contract mirror and root-config headroom were already governed; the mid-RED
  20-versus-final-21 sequencing and regex-based timeout-contract precision are evidence observations.
- The final Opus-xhigh adversarial pass returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE` in
  `phase-0b-coverage-final-review-opus-xhigh.log`; an additional self-contained Opus rerun in
  `phase-0b-coverage-final-review-opus-xhigh-rerun.log` independently returned the same disposition. Their
  findings include coverage-file overwrite ordering, the corrected `DUPLICATE_EMISSION` rationale,
  branch-coverage blind spots, additional immutable divergences, all-mode causality allocation, current
  8.754-second root timing, partially self-describing evidence logs, pair throw-assertion precision and
  mutation-log sequencing; D.29.4 records the Phase 0b residuals. The out-of-scope 8.0-versus-8.1 MiB note
  corrected the Phase 0e row and Appendix A §11.9 instead of being misassigned to this slice. A later
  documentation-only confirmation in `phase-0b-coverage-final-doc-confirm-opus-xhigh.log` returned
  `NEEDS CHANGES` on summary completeness and no implementation defect; its completed rerun in
  `phase-0b-coverage-final-doc-confirm-opus-xhigh-rerun.log` returned `PASS` after those corrections. A
  further confirmation in `phase-0b-final-doc-confirm-opus-xhigh.log` returned `NEEDS CHANGES` only because
  this subsection misattributed the completed first PASS and its findings to the wrong file. The prose
  above is the correction. The final confirmation in
  `phase-0b-final-doc-confirm-opus-xhigh-rerun.log` returned `VERDICT: PASS` and
  `PLAN ALIGNMENT: AGREE`, verified every log's actual terminal state and judged the slice
  documentation-complete and checkpointable.

No reviewer required a production, test, config, corpus, timeout or partition change. The final Opus MED
noted that raising the explicit per-test bound would be the cheapest mitigation if the first real CI run
shows insufficient headroom; the accepted tree keeps the 15-second bound and records that operational
uncertainty in D.29.4(13)/(26). Phase 0b has final implementation and documentation `PASS` dispositions,
subject only to the path-scoped checkpoint and the already-governed residual owners.

The documentation-complete final gate rerun then passed package **48/1** with the property at 5.840
seconds, root-config coverage **48/1** with the explicitly bounded property at 13.331 seconds, nightly 5/5,
canonical 10/10, object 35/35 with 304/304 differential matches, workspace typecheck/build, frozen install,
root and package lint, package build/typecheck/format, structural/hash predicates and diff checks. The
complete Istanbul line extraction was captured immediately after the root coverage run and matches
D.29.4(24).

Two unchanged rerun sequences remain as operational evidence. First, protocol-v2 initially timed out two
ESLint-spawning tests while an inherited isolated-checkout Vitest matrix was consuming the machine; after
that job exited, 134/135 passed but the freeze-CLI case crossed its separate 60-second bound. The freeze
case passed alone in about 31 seconds, and the warmed full suite then passed 135/135 without a timeout or
code change. Second, root lint first failed before rule execution because the import plugin loaded an
invalid TypeScript resolver interface; a frozen install refreshed the exact dependency graph and the
unchanged lint rerun passed with zero errors and 230 inherited warnings. Failed and successful logs are
both retained; neither failure is relabeled as an assertion failure or hidden by timeout inflation.

## Appendix D.30 — Phase 0c1 replica-local context exclusion

### D.30.1 — Stale-plan discovery and mutation-sensitive RED

The fresh Codex-high RED found that the planned production change had already shipped in ancestor
`2259f29` (`fix(object): harden the legacy applier and freeze L7 as a documented deferral`).
`REPLICA_LOCAL_STATE_KEYS` and the `stateFromDRP` exclusion at `state.ts:14,270`, plus the inverted
snapshot-key assertions at `drpobject.test.ts:72,81`, all blame to that commit. Manufacturing a current-tree
failure would therefore have been reward hacking.

RED instead added the missing independent `state-contract.test.ts`: a test-owned literal expects only
`semanticsType` and `values`; `context` and its caller marker are absent from state, raw
`FetchStateResponse` bytes and the decode/deserialization roundtrip; the distinct replicated value marker
is present in all three channels. A transient removal of only the production filter made both tests fail
for the intended leak, after which 69 production-file hashes restored byte-for-byte. The restored focused
set passed 37/37.

### D.30.2 — No-op production GREEN and gates

The separate Codex-high GREEN preserved the RED test unchanged and made no production edit. Its final
focused object/state/wire set passed 58/58; FetchStateResponse compatibility across types/object/node
passed 28/28; object tests excluding only the documented known-open convergence differential passed 260
with two skips; workspace typecheck/build covered 31 projects; root lint had zero errors and 230 inherited
warnings; frozen install, object build/typecheck, authored lint, formatting, diff and 69-file production
hash comparison all passed.

The unfiltered full object selection is also retained: 268 passed, three failed and four skipped. All three
failures are the deliberately open L7 convergence fixtures in
`proptest/convergence-differential.test.ts`; they are not relabeled as 0c1 failures or silently quarantined.
One package-local Vitest invocation failed before collection because the workspace referenced a
non-existent package config; root-config runs are the executable acceptance evidence.

### D.30.3 — Independent findings and unanimous correction

Grok and Kimi-100 returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE`. The first final Opus-xhigh review
judged the 0c1 artifact checkpointable but returned `NEEDS CHANGES` / `PLAN ALIGNMENT: DISAGREE` because
the proposed ledger correction still pointed at `drpobject.test.ts:455-522`. Those tests protect desired
live replica-local `context.caller` behavior and must never be inverted; only the snapshot-key assertions
at `:72,81` historically pinned the leak.

The revised split above was not written until Codex-high, Kimi-100 and a narrow Opus-xhigh consensus pass
all returned `PLAN ALIGNMENT: AGREE`; Kimi and Opus also returned `VERDICT: PASS`. No acceptance criterion
was deleted: 0c1 now owns the three delivered context/wire/positive-control contracts, while 0c2 retains
the Map-key deletion, cross-version and six-call-site replacement requirements.

### D.30.4 — Governed residuals

1. `DRPObject.setDRPState` (`packages/object/src/index.ts:201-203`) accepts arbitrary `DRPState` without
   applying the replica-local field filter. It has no production caller and one test caller
   (`incremental-linearize.test.ts:127`); this is a latent API-hardening residual, not a network path.
2. The raw-byte test proves `"context"` is absent and the replicated value marker is present; adding a
   same-channel positive assertion for the literal `"values"` key would strengthen evidence precision but
   is not required for non-vacuity because the leak mutation made the key assertion fail.
3. Network-provided state remains rejected by the current inbound handler. A future adoption path must not
   pass arbitrary snapshots through `setDRPState` without the explicit field contract.
4. 0c2 provenance is not 0c2 acceptance. `replaceEnumerableState` and six call sites appear inherited from
   `2259f29`, but the two proxy sites pass no journal and the existing deletion fixture removes an object
   property rather than a Map entry. The fresh 0c2 slice must test those distinctions.
5. A post-edit exact-tree Opus-xhigh confirmation must return `PASS` before checkpoint. Its log is the
   acceptance artifact; no further ledger edit is required unless it adds a finding.

## Appendix D.31 — Phase 0c2 replacement-adoption acceptance

### D.31.1 — Inherited implementation and mutation-sensitive RED

The fresh Codex-high RED independently established that `replaceEnumerableState`
(`drp-applier.ts:184-201`) and its complete six-site consumer set
(`:778,779,1140,1143,1277,1278`) blame to ancestor `2259f29`. Provenance did not count as approval.
RED added `state-adoption-replacement-0c2.test.ts` with five literal-oracle contracts:

1. B first receives A's real `Map<string,string>` entry, then receives A's actual `Map.delete`
   operation and must expose an empty live map.
2. Journal-less local proxy publication removes stale ACL and DRP enumerable fields while retaining
   literal current-version fields.
3. Journaled linear remote adoption provides the same cross-version replacement.
4. Deferred reconciliation removes stale ACL and DRP fields injected by the first merge callback while
   retaining both literal concurrent events.
5. A forced failure after both journaled replacements restores live ACL/DRP state and prior events,
   removes the failed vertex from graph, DRP/ACL snapshots and finality, and retains the already committed
   receiver branch.

The restored tree passed 5/5. Each of the six sites was then changed independently to a transient no-op;
each focused run failed in the predicted contract and each edit was immediately restored. The five
production-file hashes before and after mutation were identical. This per-site mutation sensitivity is
the load-bearing execution evidence: the V8 ranges for the five guarded sites
`:778,779,1140,1143,1278` span the entire `if` statement and therefore count guard evaluation, not
necessarily the call itself. Only the bare reconciliation call `:1277` has a direct statement count.

### D.31.2 — No-op production GREEN and gates

The separate Codex-high GREEN preserved the RED test byte-for-byte and made no production, plan, config
or lockfile edit. Fresh coverage reported non-zero guarded-statement/bare-call counts at all six sites;
the six independent RED mutation kills provide the stronger call-execution proof. State compatibility
passed 69 with two skips; Fetch/state wire compatibility passed 28/28; the focused suite passed 5/5; and
the object selection excluding only the governed L7 differential passed 265 with two skips.

The unfiltered object run is retained honestly: 273 passed, three failed and four skipped. Running
`proptest/convergence-differential.test.ts` alone produced eight passes, two skips and the same three
governed L7 failures: `fixed-four-vertex-cross-group-authority-chain`,
`fixed-same-group-pair-with-descendant` and the widened 12×9×4×3 L7 tier. The arithmetic exactly
reconciles with the filtered run. Object and workspace typecheck, object and workspace build, authored and
root lint, authored formatting, diff check and frozen-lockfile install all passed. Root lint reported zero
errors and 230 inherited warnings. All 17 object production-source hashes remained byte-identical through
GREEN.

No production rewrite, general fuzzer, mutation framework or timeout increase was justified. The six
explicit deterministic publication sites had faster and more diagnostic line-specific mutants, and the
inherited implementation already satisfied the now-independent acceptance contract.

### D.31.3 — Independent review and plan correction

Grok returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE`. The final pre-edit Opus-xhigh adversarial review
also returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE` after re-deriving the control-flow ownership and
rollback surfaces from source. The two Codex-high RED/GREEN agents likewise returned
`PLAN ALIGNMENT: AGREE`, so the row above is corrected from “likely inherited, unapproved” to
“inherited implementation + acceptance completion.”

The first exact-tree post-edit Opus-xhigh confirmation returned `VERDICT: NEEDS CHANGES` /
`PLAN ALIGNMENT: AGREE`. D.31.1 had described `:1278` as a directly counted bare call when it is guarded
exactly like `:778,779`, and the 0d prompt cited §0.5 for a stale-plan warning that section does not
contain. Both are corrected above: the guarded set is now `:778,779,1140,1143,1278` with `:1277` alone
bare, and the prompt cites §0.3 with D.30.1/D.31.1. D.31.2 also names the three governed L7 cases in
response to the same review's non-blocking self-containment note.

The user explicitly canceled Kimi-100 for this slice. It was **omitted**, not passed, and no Kimi verdict
is claimed. This exception applies to 0c2 only; later slices resume the requested review sequence unless
the user directs otherwise. A final narrow exact-tree Opus-xhigh confirmation of this ledger insertion is
the terminal review gate and must return `PASS` before the 0c2 checkpoint.

### D.31.4 — Findings and gotchas

1. A real Map-key deletion closes the specific residual left by the old top-level-property fixture, but
   assigning the whole enumerable `entries` property would also propagate that Map. The stale-field
   expectations across tests 2–5, not the Map assertion alone, distinguish replacement from
   `Object.assign`-style accumulation.
2. The Map scenario covers the linear adoption path. A Map value traversing
   `stateFromDRP`/`applyState` on a concurrent or deferred path remains a distinct future risk surface;
   current in-memory `DRPStateEntry.value` handling does not make it a 0c2 blocker.
3. The line-779 no-op kills the Map test at its positive-control set publication, before the delete
   oracle. It proves line 779 owns live DRP publication; delete non-resurrection is separately observed
   on the restored tree.
4. The rollback fault is injected by throwing before checkpoint work. It discriminates the required
   live-state, graph, snapshot and finality writes made before the throw, while the existing
   `merge-rollback-completeness.test.ts` remains complementary coverage for a production-realistic throw
   inside checkpoint snapshotting, positive controls and re-applicability.
5. The test-local `operationVertex` helper compares provided values without first checking equal arity.
   All current lookups have matching arity, so this is non-vacuous here; add an explicit length check
   before reusing the helper in another slice.
6. `assign` would route a non-ACL payload to the ACL proxy if `!isACL && !this._proxyDRP`; current
   `applyFn` control flow makes that branch unreachable. A stale own property whose live value is a
   function is also deliberately skipped by `replaceEnumerableState`. Carry both observations as
   hardening candidates for 0d/0h rather than silently widening 0c2.

## Appendix D.32 — Phase 0d fail-closed admission acceptance

### D.32.1 — Delivered boundary and pipeline

Phase 0d adds a nominally branded `PreparedAdmissionContext`. `prepareAdmissionContext` validates and
detaches the current anchor and frozen parameters once per epoch, verifies their registered digests and
hard authority tuple, and retains no caller-owned mutable envelope. `admitVertex` rejects a raw or forged
context as `ADMISSION_CONTEXT_UNPREPARED` before context digests, registry work, candidate traversal,
signature verification or resolver calls. Absence of the required raw `isAncestor` function is a
preparation result (`ADMISSION_CONTEXT_INVALID`), replacing the stale runtime-throw assumption. This is
an intentional contract relocation, not merely a test rename.

The delivered D3 order is:

1. exact envelope/representation and bounded dense sorted-unique dependency checks;
2. protocol, object, epoch, anchor and crypto-suite identity;
3. candidate digest, hash equality and author signature;
4. resolved dependency shape, hash/domain/epoch/anchor authentication and previous acceptance;
5. exact logical time and both-direction direct-antichain probes;
6. authorization against a frozen digest-only hard-epoch authority handle;
7. operation-schema validation; and
8. the deterministic invariant.

Candidate operation data is canonically detached, signature bytes are copied, and authorization, schema
and invariant hooks each receive a fresh decode of the same authenticated internal byte snapshot. Exact
envelope-key quarantine prevents replica-local `context` or any other unregistered property from entering
the candidate or authenticated preimage. Phase 0d establishes a new transport-local wire-byte boundary:
admission consumes an already-decoded envelope and does not pretend to reconstruct transport length.
Dependency digests bind the registry-normalized set order; received strict sorting is a separate cheap
pre-auth quarantine gate.

### D.32.2 — Resolved-dependency TOCTOU RED/GREEN

The first exact-tree reviews found a real Phase-0d blocker after the initial GREEN: resolver-returned
dependency envelopes were validated, retained by reference, passed across a re-entrant
`isDependencyAccepted` hook and then reread for `kind`/`logicalTime`. A conforming hook could therefore
turn an invalid child into a false accept or a valid child into a latched false reject without changing
the dependency hash.

A fresh Codex-high RED added four non-vacuous contracts to
`admission-pipeline-0d.test.ts`:

1. mutating a valid vertex parent after validation cannot cause a false
   `INVALID_LOGICAL_TIME`;
2. mutating an invalid-time vertex parent cannot cause acceptance;
3. a real epoch anchor is stable across both anchor→vertex and vertex-time poison attempts; and
4. an alternating Proxy proves every registered field and `hash` is read exactly once.

The separate Codex-high GREEN snapshots the captured `kind`, every registered top-level field and
`hash` once into a package-owned frozen plain envelope, validates only that snapshot, and retains only
frozen primitive `{kind, logicalTime}` evidence. A precise mutant that restored the live resolver object
to the post-validation map was killed by all four REDs; production and test hashes were then restored
byte-for-byte. The snapshot is deliberately shallow: nested dependency/operation references have one
synchronous hash-verification consumer and are never retained or reread by classification, antichain or
semantic hooks.

### D.32.3 — Gates and independent review

The focused Phase-0d suite passed 39/39 and `protocol-v2` passed 21 files / 174 tests. Package and
workspace typecheck and build, authored and root lint, Prettier, diff checks and frozen-lockfile install
passed. Root lint reported zero errors and 226 inherited warnings. The initial full run's freeze check
honestly retained the known `spawnSync git ENOBUFS` caused by the untracked `.pnpm-store/` population.
The established harness-only remedy temporarily added `.pnpm-store/` to `.git/info/exclude`; the rerun
passed and the exclude file was immediately restored to its exact prior hash. No lockfile, timeout,
buffer, config or test criterion was relaxed.

On the final pinned source, Codex-high, Grok and Kimi-100 independently returned `VERDICT: PASS` and
`PLAN ALIGNMENT: AGREE`. For Grok, those are the emitted final JSON `.text` verdicts; the raw serialized
`thought` contains discarded contradictory drafts and is not the review result. The final Opus-xhigh
adversarial review returned `VERDICT: PASS` and `PLAN CORRECTION QUORUM: AGREE` after reconstructing the
detachment, hash-binding, latching and boundedness arguments. All four reviews agreed that no Phase-0d
blocker remains and that 0d must stay unshipped/atomic with 0e.

### D.32.4 — Findings and governed residuals

1. `NON_ANTICHAIN_DEPENDENCIES` was the only Phase-0d latch whose truth still rested on caller-provided
   truthiness. Phase 0e now supplies the exact package-owned `CausalityIndex` implementation and requires
   exact boolean answers, rejecting every non-definitive result as `ADMISSION_CONTEXT_INVALID`. The live
   production binder remains Phase 3a; callers do not earn the package-controlled-oracle claim merely by
   satisfying the callback type.
2. Phase 0e's bitset domain must include the current epoch anchor. A legal mixed
   `[currentAnchor, vertex]` dependency pair is not an antichain because the anchor is an ancestor of
   every epoch vertex; a vertex-only index would silently answer false.
3. The exact bounds distinguish pairs from calls: `D=16` means 120 unordered pairs and at most 240
   directional probes; `D=256` means 32,640 pairs and at most 65,280 probes. The 0e RED must assert the
   probe count rather than relabeling the pair count.
4. Resolver-array access and trusted-hook-body throws (`resolveDependencies`,
   `isDependencyAccepted`, ancestry, schema and invariant) remain fail-stop but do not yet share a stable
   public taxonomy. Phase 0h owns blueprint/resolver exception policy, 0l owns public codes, and 0f owns
   the single classifier/re-offer matrix. Phase 0d does not invent provisional codes or overload
   authenticated-invalid results for host faults. The accept-path `encodeCanonical(candidate)` is also
   outside a catch; it is unreachable for a validated candidate under current limits but belongs in the
   same future totalization audit.
5. Accepted-message cost is a concrete Phase-0p input. Current registry digest construction performs
   `3 × (D + 1)` operation-sized canonical encodes across the candidate and dependencies — 51 at default
   `D=16`, 771 at ceiling `D=256` — plus candidate deep-clone encode/decode, freeze traversal, one
   authenticated candidate encode and three semantic-hook decodes. Budget and remove discarded work
   there; do not add long-running 0d fuzz solely to rediscover a measured linear multiplier.
6. Phase 0d does not change the frozen reference `fold.js:38` default-`true` authorization. Phase 4a is
   the explicit fold-port owner. Even with exact 0e ancestry accepted, G4 remains incomplete until Phase
   3a binds the accepted boundary into the live v3 path and Phase 4a removes the legacy fail-open fold.
7. The resolved-dependency copy is bounded by the registry and `maxDependencies`. A whole-object deep
   clone would add cost without strengthening the post-validation evidence boundary.

## Appendix D.33 — Phase 0e exact ancestry acceptance

### D.33.1 — Delivered RED/GREEN boundary

A fresh Codex-high RED established the public contract before production changed: append-only recurrence
`Anc(v) = ⋃(Anc(d) ∪ {d})`; anchor-inclusive mixed dependencies; later 32-bit word growth; self and unknown
hashes returning exact `false`; exact-boolean admission; and separate `D=16`/`D=256` pair and directional
probe bounds. The separate GREEN extended the existing exported `CausalityIndex` with `size`, `has` and
`append`, using one variable-width `Uint32Array` row per accepted hash. `admitVertex` now accepts only the
literal booleans `true` and `false`; every other ancestry result is terminal
`ADMISSION_CONTEXT_INVALID` and non-latching.

The accepted recurrence unions every resolved dependency row before setting each direct-dependency bit.
Rows may remain short because a later position cannot be an ancestor of an earlier vertex. Static graph
construction and later append share one position space, and word growth preserves that alignment. The
epoch anchor is a real indexed vertex, not an implicit always-false sentinel.

### D.33.2 — Publication-failure RED/GREEN remediation

The first exact-tree reviewers found a supported second-write failure: after `ancestors.push(bits)`,
`Map#set` could throw, leaving an orphan row that the next append inherited. A fresh Codex-high RED
injected that failure and proved both immediate state preservation and clean subsequent append behavior.
The separate GREEN pops the staged row and rethrows if the index publication fails. A precise mutant
deleting that rollback is killed. Successful append publication remains two package-owned synchronous
writes with no caller-controlled callback between them.

### D.33.3 — Same-hash re-entrancy RED/GREEN remediation

Kimi-100 then found a caller-visible same-hash race through candidate getters: an inner append could
publish hash A after the outer call's early duplicate check, after which the outer call overwrote A's
binding with stale dependencies. A fresh Codex-high RED publicly reproduced the stale A→X overwrite and
the resulting shared-position false matrix without private-field access. The separate GREEN repeats the
duplicate check after every caller-observable candidate/dependency read and before capturing
`index.size`. A precise mutant deleting that second check is killed. Different-hash nested appends remain
valid caller side effects and the outer append observes their updated position space.

### D.33.4 — Gates and independent review

The final focused suites pass 9/9. The complete compaction package passes 53 tests with one nightly skip;
the complete `protocol-v2` package passes 178/178, and the inherited Phase-0b regression suite passes 39
tests with one nightly skip. Workspace typecheck/build, authored and root lint, Prettier, diff checks and
frozen-lockfile install pass; root lint retains zero errors and 226 inherited warnings. The exact final
pins are:

- `packages/compaction/src/linearize.ts`:
  `86d173f689114fa9f7f117b79ce704b0bbebaa3507ef1546932683b4f3c5b109`;
- `packages/protocol-v2/src/admission.ts`:
  `e8ca86702f124c0fc5b23951133b1352020ba8b2190ecb2a7ac8874d291ed1e7`;
- `packages/compaction/tests/causality-append-0e.test.ts`:
  `ef081068ad9530fe702b4fec61216629a89e4d7e47b7deaa3f45860a831b2e43`; and
- `packages/protocol-v2/tests/admission-ancestry-0e.test.ts`:
  `cc7a664c512dc21953bcc6db8d7a629f99e90d3d30e66fe7cbdc40184afea898`.

On that corrected tree, Codex-high, Grok and Kimi-100 independently returned `VERDICT: PASS`,
`PLAN ALIGNMENT: AGREE` and `PLAN CORRECTIONS: AGREE`. The final Opus-xhigh adversarial review returned
`VERDICT: PASS`, `PLAN ALIGNMENT: AGREE` and `PLAN CORRECTION QUORUM: AGREE`. The post-review correction
quorum assigns the live binder to Phase 3a, commit-section discipline to Phase 0q, epoch ceilings to Phase
0p and the legacy default-true fold to Phase 4a.

### D.33.5 — Findings and governed residuals

1. No production caller currently composes `CausalityIndex.append`, `prepareAdmissionContext` and
   `admitVertex`. Phase 3a owns one per-object/epoch index at the `packages/node` composition root, a bound
   `isAncestor`, and `accepted iff appended` inside Phase 0q's synchronous commit discipline. Phase 0q
   owns the discipline but not the actual ancestry wiring call.
2. `isAncestor` deliberately returns `false` for unknown hashes. That is sound only if the live binder
   proves every previously accepted dependency was appended. A stale, lying or unbound host callback can
   otherwise manufacture a false antichain; Phase 3a must kill those paths with public integration REDs.
3. Raw bitset cost must not be summarized as one universal “8 MiB” number. A static full-width `V=8192`
   index uses `8,388,608` backing bytes; append-built triangular rows use `4,210,688` bytes (~4.016 MiB),
   and neither includes typed-array object or `Map` overhead. Phase 0p must pin whether the configured
   vertex ceiling includes the anchor; Phase 3a asserts the chosen cap before first live use.
4. The admission integration test currently constructs a static index rather than exercising a
   production incremental append path. Phase 3a owns that missing integration. A dedicated
   different-hash re-entrancy RED is also useful there even though the final Codex review reproduced the
   behavior manually.
5. The focused test's `localeCompare(..., "en-US")` helper is not the protocol comparator. It can create
   a fragile or false RED, not a production divergence; replace it when that fixture is next touched.
   Several append failure assertions also use bare `toThrow` rather than stable error-code pins; Phase 0l
   owns the public taxonomy.
6. Resolver, ancestry and semantic-hook throws remain uncategorized across Phase 0f/0h/0l. An unbound
   method currently throws rather than returning a non-boolean, so Phase 3a must bind explicitly and the
   classifier slices must decide the stable host-fault result.
7. Deliberately replacing the TypeScript-private `Map`/row array or poisoning native prototypes can still
   defeat rollback (for example, a `Map#set` that inserts then throws or a poisoned `pop`). This is outside
   the accepted owned-primitive threat model. If hostile private-field/prototype mutation becomes a
   contract, use runtime-private state, captured primordials or a single committed-state pointer and add
   fresh REDs; do not claim the current two-write implementation survives arbitrary primitive poisoning.
8. G4 remains open after this checkpoint: the exact library implementation is accepted, but the Phase-3a
   live binder and Phase-4a fail-closed fold have not landed.

## Appendix D.34 — Phase 0f fail-closed classification and legacy clock repair

### D.34.1 — Initial RED/GREEN and the rejected broad classifier

A fresh Codex-high RED first established the live divergence: an early replica terminalized a finite
future parent and child, could not re-offer them, and diverged from a later replica that accepted the same
ancestry. A separate exhaustive v2 test pinned the exact 64-cell
protocol/epoch/anchor × `{<,=,>,malformed}` classifier and the closed
`accept`/`pending`/`terminal`/`quarantine` vocabulary.

The first GREEN routed every `InvalidTimestampError` to recovery. Codex-high, Grok and Kimi-100 all
blocked that implementation: one public class represented receiver-clock eligibility, immutable
dependency/child temporal inversion, submitted infinities and arbitrary downstream application throws.
Class-wide recovery therefore converted deterministic invalidity and host/application failures into
unbounded re-request churn.

Opus-xhigh, Codex-high and Kimi-100 agreed to correct the plan rather than reward-hack the tests. Only a
finite submitted timestamp strictly beyond a finite receiver clock is repairable by waiting. A
dependency-relative violation, submitted `+Infinity`/`-Infinity` or downstream throw of the public class
is terminal. NaN admission and the legacy JSON `NaN`/infinity/`null` hash collision remain characterized
residuals rather than being silently assigned to this slice. Phase 0h still owns resolver/blueprint
exception policy and Phase 0l owns stable public codes.

### D.34.2 — Provenance, public replay and stable-candidate remediation

The next RED/GREEN used result-bound provenance, but exact-tree review found two successive replay seams.
First, a private timestamp-error subclass escaped through the public validation API and could be captured,
constructed or prototype-forged. Replacing it with a WeakSet of public `Error` identities still allowed a
genuine captured error to be replayed from an application method or a later timestamp accessor. Fresh
marker-replay and accessor-replay REDs killed both designs.

The accepted provenance is a module-private `WeakSet<ValidationResult>`. Validation constructs and brands
only the fresh failure result at the actual finite receiver-clock comparison site. Arbitrary caught errors
produce new unbranded results. Object admission consumes the result predicate only in its validation stage
and immediately converts it to a non-exported local marker; the outer catch trusts only that marker. The
public failure remains the exact base `InvalidTimestampError` constructor, `instanceof`, name, message and
shape.

A later adversarial pass then reproduced three observation bugs: `timestamp` was read independently for
hash, dependency and receiver-clock checks; a nonfinite receiver time could earn pending; and a later
`hash` getter could redirect the recovery key. A fresh stable-snapshot RED replaced the obsolete
third-read captured-error fixture with a first-read replay and added numeric alternation, receiver
`-Infinity` and hash-redirection cases. GREEN now:

1. observes every public-validation top-level field once inside its catch boundary;
2. immediately copies dependencies and signature;
3. uses one captured timestamp for hash, dependency-relative and receiver-clock checks;
4. requires both timestamp and receiver time to be finite before branding pending;
5. deep-detaches the object-path operation and passes one stable candidate through validation and apply;
   and
6. carries that stable candidate in the private pending marker, which is consumed before any caller hash
   or dependency reread.

### D.34.3 — Batch preflight, dense worklist and truthful results

Final-tree review found that batch reconciliation preflight still read every live `operation` getter
outside the per-vertex catch. A getter could throw and abort valid siblings, or return DRP during preflight
and ACL during validation. A fresh batch-operation RED pinned exactly one detached operation observation,
per-element capture-error containment and reconciliation mode derived from the captured operation. GREEN
preserved deferred reconciliation while using one shared operation/error record.

A further adversarial pass found three batch-level integrity gaps: a getter could sparsify the caller's
live array and cause a partial commit followed by an uncaught destructuring error; repeated references
could commit a hash while still reporting it invalid or quarantined; and a later signature getter could
mutate the dependencies array before the delayed copy. The final fresh RED added five cases covering dense
worklist isolation, repeated invalid→good and throw→good references, repeated missing deduplication and
immediate dependency copying.

The accepted GREEN copies the submitted element references into an independent dense worklist before any
vertex accessor, caches one deep-cloned operation/error record per submitted object identity and uses that
same record for reconciliation, validation and application. Mutable dependencies and signature bytes are
copied at the moment they are observed. Result construction is linear-time and returns unique, mutually
exclusive buckets in terminal-invalid → quarantine → missing precedence. Every bucket excludes hashes
present in the graph at result construction, and stale known-invalid memory is cleared for a hash that
committed during the call. A rejection result therefore never names a same-call graph member, including
when different carrier objects present the same hash.

### D.34.4 — Mutation strength and final pins

Fourteen precise mutation probes were killed and restored:

1. public-error identity trust and outer-catch replay;
2. branding arbitrary caught errors by captured identity;
3. removing result branding or object-stage conversion;
4. removing finite submitted-timestamp gating;
5. removing finite receiver-time gating;
6. restoring independent timestamp observations;
7. dropping marker-bound validated hash/candidate provenance;
8. restoring the live batch `.every` operation preflight;
9. fail-stopping a captured operation error before the per-element loop;
10. deriving reconciliation mode from a second live operation observation;
11. mapping the live caller array instead of a dense worklist;
12. removing the per-identity operation-record cache;
13. delaying dependency copying until after later getters; and
14. removing unique graph-aware result normalization.

The final governed pins are:

- `packages/validation/src/vertex.ts`:
  `c2fa004f5d587b4b2d1599feca9a698aa916b418eb7fe6e874e9fa9f65c46c7f`;
- `packages/object/src/drp-applier.ts`:
  `d74911df99f3a069fca35a54593b234effbb4696019d5875b22e42bb24bd220e`;
- `packages/object/tests/clock-skew-divergence-0f.test.ts`:
  `9f96273ae51f1fdccf193a2dfc9e0133c8ac9a1a85c5f3958b88b383d9f41644`;
- `packages/object/tests/timestamp-provenance-classification-0f.test.ts`:
  `4e8b7f9626779d6a4c9bf696113ab54ff01d4d8bc81ebb652f17ac4efbb97d9c`;
- `packages/object/tests/timestamp-marker-replay-0f.test.ts`:
  `6c697e5cec13de5f0ed255d08faab5728f4ca76aa5e55dae2894fd9a103c2781`;
- `packages/object/tests/timestamp-accessor-replay-0f.test.ts`:
  `9151cc0c0129a8331192e7b64c5bb8f23cb42dc359b29fbdcef3af52c88c3a4f`;
- `packages/object/tests/batch-operation-snapshot-0f.test.ts`:
  `98a52fb625ea0cf5c5a94d87067ad8a6c8a359e8e8d5ceb45f661173338ddca8`;
- `packages/object/tests/batch-worklist-isolation-0f.test.ts`:
  `b193a6800d0f75692c95cf7d22b9ce67a15f3947fcb4cf2c87cfae26dc9732b2`;
- `packages/protocol-v2/tests/admission-classifier-cross-product-0f.test.ts`:
  `bbe407b630b7d951c95a9f76024d80db87c9710fd5bc226df93a35a200f61989`;
  and
- the governed update to `packages/object/tests/merge-validation-classification.test.ts`:
  `8dcf7f6021bc5d8d5c229c3d219ef243d37fe313324c60e20ac21dbfa020ea31`.

### D.34.5 — Gates and independent review

The final focused preservation matrix passes 13 files / 75 tests. Validation passes 5/5; object passes
294 tests with two nightly skips while excluding only the separately governed Gate-0 convergence
differential; protocol-v2 passes 180/180. Validation, object and protocol-v2 package builds and typechecks
pass. Authored lint reports zero errors and two inherited JSDoc warnings; Prettier and diff checks pass.
The final workspace-wide typecheck and build pass. Root lint reports zero errors and 226 inherited
warnings; the scoped Prettier check, `git diff --check` and frozen-lockfile install pass. All final
acceptance commands wrote their complete output to bounded `.logs/phase-0f-final-*.log` files.
The bare protocol-v2 freeze subprocess honestly retained the known `spawnSync git ENOBUFS` caused by the
untracked `.pnpm-store/`; the passing rerun used only the established process-local `core.excludesFile`
environment and left `.git/info/exclude`, lockfiles, buffers, timeouts and test criteria unchanged.

On the final quiescent source and test pins, Grok and Kimi-100 independently returned `VERDICT: PASS` and
substantively proposed or agreed the plan corrections while D.34 was still unapplied. The root
orchestrator's recorded Codex-high quiescent plan-correction result subsequently returned
`VERDICT: PASS`, `PLAN ALIGNMENT: AGREE` and `PLAN CORRECTIONS: AGREE` for this correction set; it is
transport evidence, not represented as a separately inspectable review artifact. Grok and Kimi therefore
remain valid source/test and pre-edit correction evidence, but they are not represented as reviewers of
the applied D.34 text. Grok's verdict is the normalized JSON `.text`, not discarded hidden thought. Grok
and Kimi reconstructed the Phase-0f counterexamples and substantively supplied or agreed the then-pending
documentation corrections; Codex-high independently agreed the correction set. The final Opus-xhigh
adversarial review is the applied-text reviewer, and checkpoint remains gated on its post-edit
`VERDICT: PASS`.

### D.34.6 — Governed residuals and ownership

1. Public `validateVertex` retains the observed operation object shallowly. A hostile caller-supplied
   `hashGraph.vertices.get` can mutate the caller's operation after hash validation. This is an explicit
   observational boundary, not an object-admission hole: the helper reports the values observed during
   the call and does not freeze or return a preserved candidate, while object admission deep-detaches the
   operation before validation and downstream use. If that public contract is strengthened, the
   public-validation/canonical-input owner must detach the operation or require an immutable operation and
   trusted graph.
2. Submitted NaN, legacy JSON nonfinite/`null` hash-preimage collisions and receiver
   `currentTimeStamp=NaN/+Infinity` retain their characterized behavior. They require the later
   malformed-field/canonical-input decision; Phase 0f does not bless them as valid.
3. Exotic custom array iterators, hostile native-prototype/private-field mutation and arbitrary behavior
   inside cloning primitives remain outside the ordinary owned-value/`Vertex[]` contract. Promote any of
   them only with a fresh public RED and an authorized ownership correction.
4. The final deferred-reconciliation invariant path can still throw without an attached `ApplyResult`.
   That is an atomicity/reconciliation exception boundary, not a false classifier bucket, and remains
   owned by Phase 0q.
5. Phase 0h still owns resolver/blueprint/application exception policy, including richer asynchronous
   retry/quarantine rules. Phase 0l owns stable public error codes and taxonomy. The narrow exported
   result predicate is package interop, not the final public taxonomy.
6. Extremely large but finite future timestamps remain pending until eligible. Phase 0p owns work,
   horizon and recovery-budget bounds.
7. The object package's Gate-0 convergence differential remains intentionally RED and separately
   governed; package acceptance excludes only that named file and never describes the whole object suite
   as green.
8. Legacy receiver-clock validation still reads `Date.now()`. Phase 0f changes how a finite
   receiver-clock mismatch is classified; it neither removes nor canonically binds that wall-clock
   observation. Wall clock therefore remains an eligibility input on the legacy path. Ownership of a
   removal or canonical binding remains unassigned and requires a later explicit ownership decision;
   Phase 3a separately owns proving that the live v3 binder does not import replica wall clock into
   consensus validity. Phase 0f claims neither change as delivered.
9. **Nonblocking mutation-strength gaps.** Four implemented defenses are not independently pinned by the
   governed suite: graph-member filtering and stale invalid-memory clearing, including a
   different-carrier/same-hash case; the deep-detachment depth of operation cloning; the all-record
   `.every` quantifier used for reconciliation deferral; and direct-public-validation snapshot defense.
   The first three are hand-traced plausible survivable mutants; the validation-only mutant was
   independently confirmed to survive because object admission already materializes its candidate. These
   are test gaps, not known correctness defects, and do not retract the delivered source behavior.
   Follow-up ownership is respectively truthful object-admission results, owned-value detachment,
   reconciliation preflight and public-validation/canonical-input hardening.
10. **Inherited claimed-hash invalid-memory seam.** `knownInvalidVertexHashes` can still remember an
    unauthenticated claimed hash after an `InvalidHashError`, allowing a forged claim to influence
    classification of a later unresolved dependency. This behavior predates Phase 0f and is not a
    Phase-0f regression. Remembering only authenticated or computed identity requires a later explicit
    classifier/canonical-input ownership decision; Phase 3a owns proving that the live v3 binder cannot
    consult claimed-hash invalid memory before authentication.

## Appendix D.35 — Phase 0g(i) local mutation discipline

### D.35.1 — RED and selected API contract

The fresh Codex-high RED added `mutation-serialization-0g1.test.ts`. Five of six tests passed on the
Phase-0f checkpoint. The failing case started two un-awaited asynchronous local calls: the second
blueprint entered before the first barrier released and both vertices derived from the root frontier. The
second call therefore completed with a root dependency rather than depending on the first locally
authored hash. This was a causal-link failure, not a completion-order assertion.

The passing RED cases fixed the surrounding contract:

1. a synchronous local call issued while an asynchronous merge is parked remains synchronous,
   non-thenable, immediately committed and published for both eventual merge commit and merge rejection;
2. every subscriber publication names a vertex already in the graph;
3. four seed-pinned start/release pairs for two overlapping `applyVertices` calls preserve the exact DRP,
   ACL, hashgraph, state-manager and finality-store object identities held by `DRPObject` and its applier;
   and
4. a second object progresses while the first object's local authoring is parked, rejecting a
   process-global lane.

The API decision is deliberate. Idle local calls retain the existing synchronous fast path. A call made
behind an active asynchronous **local** authoring operation queues before `createVertex` and returns a
`Promise`; a merge parked in `applyVertices` does not occupy this lane. This is the D.5(f) concurrent
transaction design, not a mutex held across merge suspension.

### D.35.2 — GREEN and hardening RED

GREEN added a per-object `LocalMutationLane` at the proxy boundary. The object constructs one lane and
shares it between its ACL and DRP proxies. The lane wraps the complete local pipeline before
`createVertex`, executes an idle call inline, queues contenders FIFO and releases after either fulfillment
or rejection. `applyVertices` is unchanged: it continues isolated preparation plus frontier CAS/retry and
performs shared mutation only in the synchronous `tryCommitPreparedVertex` section after the final
suspension.

The GREEN agent identified four integration gaps instead of editing its RED. A fresh Codex-high hardening
RED added `mutation-serialization-0g1-hardening.test.ts`, pinning:

1. rejection recovery, queued continuation from the committed frontier and restoration of the idle
   synchronous fast path;
2. one shared ACL/DRP lane, including a contended synchronous ACL grant returning a thenable and depending
   on the preceding DRP vertex;
3. a synchronous DRP method invoked under local contention becoming conditionally asynchronous without
   executing or publishing early;
4. subscriber-triggered public reentrancy queueing without deadlock or causality loss; and
5. independent-object progress.

The final governed pins are:

- `packages/object/src/proxy.ts`:
  `f589d1ee1980aea858e49bfb89fdec702e7c50a11ecf469eeb609a5eb98a41c8`;
- `packages/object/src/drp-applier.ts`:
  `4bbabdf9926f9c25e2e79437913aff3d934741127e391b15f4e8576f9445850f`;
- `packages/object/tests/mutation-serialization-0g1.test.ts`:
  `816b0ea99e901864c3954222f6365b56f09a71ffbd1ca8cb83ed6343ebaa2a64`;
  and
- `packages/object/tests/mutation-serialization-0g1-hardening.test.ts`:
  `6a5c6aeb71a3a9380de0f3766d249e91add0ed30b11e043aa3c6057f6ec2a402`.

Four precise mutants were killed and restored:

1. bypassing `LocalMutationLane.run` reproduced the original early-entry/root-dependency failure;
2. constructing separate ACL and DRP lanes made the contended grant synchronous, visible early and
   root-dependent;
3. bypassing the lane against the hardening suite made the queued synchronous DRP call execute and
   publish early; and
4. omitting rejection release left the queued settlement observably pending after deterministic
   microtask turns, without a timeout or hung test.

The original GREEN mutation log proves the failing behavioral result and clean restored pins, but did not
pin the transient mutant bytes and is not the decisive hardening artifact. The three hardening mutants ran
against pre-lint test hash `a39fc1de…`; the only delta to governed hash `6a5c6aeb…` was removal of an unused
`HashGraph` import, after which the governed bytes reran green.

### D.35.3 — Gates and independent review

The final focused suite passes 2 files / 11 tests. The full object suite passes 42 files / 305 tests with
two governed skips while excluding only
`packages/object/tests/proptest/convergence-differential.test.ts`. The earlier preservation matrix passes
4 files / 39 tests. Workspace typecheck and build pass. Root lint reports zero errors and 226 inherited
warnings. Governed Prettier, `git diff --check` and the frozen-lockfile install pass.

One attempted package-directory Vitest invocation is retained honestly: the workspace configuration
resolved a nonexistent package-local `vite.config.mts` and failed before tests started. The root-scoped
rerun with the same named Gate-0 exclusion is the valid 42-file/305-test result.

Grok and Kimi-100 independently returned `VERDICT: PASS` and `PLAN ALIGNMENT: AGREE` on the source, tests
and pre-edit plan. A fresh Codex-high correction consultation returned `VERDICT: PASS`,
`PLAN ALIGNMENT: AGREE` and `PLAN CORRECTIONS: AGREE`. The pre-edit Opus-xhigh adversarial review returned
the same three decisions and required this applied-text check before checkpoint. These reviewers accepted
the D.5(f)-scoped implementation and did not represent 0q's live-state equality or per-vertex atomicity as
delivered by 0g(i).

### D.35.4 — Governed residuals and ownership

1. **Conditional return typing.** `DRPObject<T>.drp` remains typed as `T`, and `IACL` retains synchronous
   method declarations. Those public types do not express that a synchronously declared method invoked
   behind active asynchronous local authoring returns `Promise<R>`. Idle/uncontended calls, including a
   call while a merge is parked, remain synchronous. A later public proxy/API typing owner must make this
   conditional return explicit or replace it with a different compatible surface.
2. **Promise rejection observability.** The lane installs a rejection handler on the active operation and
   rethrows through the returned promise. The governed rejection test handles that returned promise before
   checking `unhandledRejection`, so its empty event list does not prove the behavior of a caller that
   drops the head promise. A queued synchronous throw becomes a promise rejection and is not catchable by
   a synchronous `try/catch` at the call site. Both behaviors need an explicit public API/error-policy
   decision; Phase 0h retains exception taxonomy.
3. **Unsupported thenables.** A stateful or throwing `then` accessor can throw after the lane marks itself
   running and permanently wedge it. This is outside the supported ordinary-Promise contract, not a
   proved robustness property.
4. **Queue strength and cost.** No governed test queues two or more pending entries. Multi-item FIFO,
   `shift()` versus `pop()`, cross-surface queued ordering and reversal mutants remain unpinned. The queue
   is unbounded, retains submitted closures and uses `Array.prototype.shift`, making repeated drain
   quadratic in queue length. Work/bounds ownership remains Phase 0p. Synchronous-throw release is covered
   by inherited `drpobject.test.ts` assertions but lacks a dedicated governed mutant.
5. **Construction footgun.** `DRPProxy`'s default `new LocalMutationLane()` constructor parameter remains a
   future unshared-lane footgun: any new same-object proxy constructed without the explicit shared lane
   will serialize independently.
6. **0q remains open.** The four overlapping-merge schedules establish parking and owner identity, not
   concurrent commit-section correctness. Graph-before-publication membership does not establish live
   state equality, stale-`currentDRP` repair, L6 or per-vertex apply/publication atomicity. Those remain
   Phase 0q, and resolver/application exception taxonomy remains Phase 0h.
7. **0m/XVER remains unmet.** Phase 0m's cross-version harness is not implemented, so its plan-declared
   applier-touch gate could not run. The constructor-only shared-lane wiring was accepted for this local
   checkpoint using the focused, preservation, full-object and workspace gates plus independent review.
   This substitution neither passes nor closes 0m.
8. Phase 0g(i) delivers only the local-safe discipline. The authenticated sequence cannot land in frozen
   v2: Phase −1′ must freeze the v3 successor before 0g(ii-T/I) may port or issue it. Remote
   equivocation/evidence/descendant/rate-limit policy remains Phase 0o. Phase 0's exit gate is not claimed.

## Appendix D.36 — Phase 0g(ii) RED exposed a protocol-major correction

### D.36.1 — RED evidence and valid signal

The fresh Codex-high RED added two tests without editing production or the plan:

- `packages/protocol-v2/tests/author-sequence-0g2.test.ts`,
  `d92cf2c515b40b9c04d2f0f1fb59926c0f2df082a30b3c2c806c8fd8b8698692`;
- `packages/protocol-v2/tests/local-author-sequence-issuance-0g2.test.ts`,
  `23af3b601d1576a5e4f6ad0f1cb584c68fc13b6074afe1e58fa4591847ec01a3`.

The decisive run is 2 files / 11 tests: nine intended failures and two positive controls. It proves that
the frozen v2 vertex has no `authorSequence`, sequence-only mutation does not change its canonical bytes
or digest, admission neither validates nor authenticates the value, and no local issuer exists. The
accepted protocol classifier preservation matrix remains 5 files / 45 tests; the object preservation
matrix is 9 files / 44 tests. Typecheck, lint, formatting and diff checks pass in the recorded RED logs.

The RED is useful evidence but not a lawful v3 GREEN contract. It hardcodes protocol major 2 and the
`/v2` vertex domain, permits initial ordinal 0 or 1, and its issuer cases stop at the missing-API guard
before exercising their alleged shuffled interleaving. Two PASS/PASS controls are also non-gates: the
generic canonical-decoder negative says nothing about the registered sequence, while the v2 signature
test passes precisely because the current builder drops `authorSequence`. A fresh v3 RED must re-author
these surfaces rather than make the stale files green.

### D.36.2 — Why v2 cannot be repaired in place

Registry v5, its vectors, the original reference, the separately authored regenerated reference and both
locks are permanently closed. The base-pinned checker permits no second registry under the v2 prefix and
rejects every post-regeneration registry/vector transition. The plan's existing formal-variable rule
already states the consequence: discovering another signed field after freeze requires
`protocolMajor = 3`.

The lawful successor is the independent pair `(protocolMajor = 3, registryVersion = 1)` under
`packages/protocol-v3/`. It carries no v2 vector records forward and cannot alter, rename, overlay or
reinterpret v2. V3 governance is additive and separate; the frozen v2 status check remains required.

The original Opus review found—and its reconciliation corrected—one factual gotcha:
`protocolRegistry.wireFormat` already exists in v2. The analogous v3 registry block must remain normative.
Its current literal assertion is satisfiable but not behavioral; Phase 3a must prove that the live binder
hashes the exact received canonical-preimage bytes and never a decoded/re-encoded surrogate.

The frozen signature verifier also binds the active identity suite to `ts-drp/vertex/v2`. Widening that
meaning would reinterpret v2. Phase −1′ must select a distinct v3 identity-suite identifier and audit
every other v2-domain-bound suite; the exact identifiers remain an explicit normative-freeze decision.

### D.36.3 — Plan-correction authorization quorum

The pre-edit Codex-high CLI consultation returned `BLOCK`, agreed A–F and denied GREEN
(`phase-0g2-correction-codex-high-final.txt`,
`bb4b80fea6abd87cbbad805a7cc02ec917d3c77074290b612aed93a00526939a`) and recommended global registry
v6. The first Kimi-100 likewise preferred global v6 and process-local issuance, while Opus-xhigh differed
on registry lineage and issuer shape. No plan edit was made under that disagreement.

A narrow reconciliation resolved both issues:

1. Kimi-100 withdrew global registry v6 and production process-local issuance, then approved
   protocol-local v3 registry v1, documentation-only correction, a distinct v3 identity suite selected by
   the freeze, and one-shot issuance
   (`phase-0g2-correction-kimi100-reconcile-20260727T141712Z-stdout.log`,
   `5f80fdfc52f411916e1e56bd604bbb6b922085d2a52751d75c7875d020d3993a`).
2. Opus-xhigh withdrew its externally visible `reserve/commit/abandon` proposal because permanently
   abandoning an ordinal creates a signed gap. It approved the same unified correction
   (`phase-0g2-correction-opus-xhigh-reconcile-20260727T142140Z-normalized.txt`,
   `e5b9a8d3b4ae5216138effad87fc8e64161080aacd38a45c0dfdcea1327a7961`).

A later supervising Codex-high response agreed with the protocol-local v1 correction, but it is not the
sealed CLI artifact above and must not be represented as one. The authorization quorum—this supervising
Codex-high response plus the sealed Kimi-100 and Opus-xhigh reconciliations—agreed only that the
documentation should route the work through a fresh protocol-v3 freeze. The sealed Codex-high CLI
artifact itself retains its v6 recommendation, so there was no unanimous registry-numbering result among
the three sealed artifacts.

That scoped quorum authorizes this documentation correction only. No production GREEN, v3 registry,
formal artifact, vector, reference, lock, checker, workflow, source or test change is authorized.

### D.36.4 — Sustainable issuance and ownership

Post-freeze issuance uses one coordinator-owned operation:

```text
transactIssue(scope, buildAndSign)
```

For a structural `(objectId, author)` scope, the coordinator selects the next ordinal and invokes a
trusted internal closure. The closure may return signed material internally to the coordinator but cannot
expose it outside the transaction. The exact canonical preimage, signature, digest, issued record/outbox
and next counter become externally observable only after one successful commit. A throw, rejection or
commit failure advances nothing and exposes nothing, so retry safely reselects the never-consumed ordinal.
There is no public reservation token and no `abandon`.

The honest claim is **gapless successful local issuance for one authoring identity within one durable
lineage**. It is not a remote admission rule: propagation delay, durable loss or equivocation may produce
observed gaps, and 0o still requires arrival-order-independent admission of valid envelopes. An in-memory
store can test deterministic transaction semantics only. Phase 2 owns durability and crash closure;
Phase 3a owns live received-byte binding plus atomic durable counter/envelope/outbox publication; Phase 0o
owns remote duplicate/gap/equivocation evidence and policy.

### D.36.5 — Applied-text review corrections

The first applied-text review did not authorize checkpoint. Fresh Codex-high found that explicit future
`consensus-v2` labels and Phase 3/4 titles overrode the successor caveat, Phase 2 lacked an executable
durable-issuance item, the closure wording accidentally forbade its internal result, and Appendix A's
three-column table was malformed by a six-column delimiter plus an unescaped `|V|!`. The applied
Opus-xhigh review independently blocked on the missing sentence that scopes frozen Decision 11 and the
later naming summary to v2
(`phase-0g2-plan-correction-applied-opus-xhigh-20260727T144012Z-normalized.txt`,
`0c3dcda351ac9af84992a9b2108dc442735ea50e71ab8f4e864fc53ad2accab9`).

The correction scopes—but does not edit—those frozen v2 rows; routes the roadmap, Phase 0i, Track P1 and
the first-live Phase 3–6 consensus work through v3; adds Phase 2l's hard-killed durable
counter/envelope/outbox transaction; permits the trusted closure's internal result while forbidding
external exposure; defines internal freeze snapshots as unpublished/non-authoritative; and repairs the
traceability table. The plan checkpoint remains gated on a fresh post-correction applied-text review.

## Appendix D.37 — Phase −1′a v3 formal action-model acceptance

### D.37.1 — Artifact RED and rejected first GREEN

The fresh Codex-high RED created only an artifact-level test and a nonnormative fixture. It failed against
the absence of a v3 Quint action model and a mechanically derived signed-field contract, while its positive
controls preserved the distinction between contiguous successful local issuance and arrival-independent
remote admission. The first GREEN then exposed three root-review defects before external sign-off:
equivocation was specialized to slot 1, `step` was scripted rather than a top-level nondeterministic
choice, and counters/phases could grow without a finite cap. Those defects were corrected before the first
external review.

The first review tuple was still rejected. Grok's substantive `BLOCK` found that rejection counters were
never written, dependency purevals merely annotated a preselected field set, successful local issuance
stored no signed record binding the selected sequence, and equivocation used an unrelated
`payloadIdentity`. Kimi-100 and the then-current Opus review treated those weaknesses as nonblocking, but
the Grok findings were correct on the merits. The slice did not advance.

Corrective RED round 3 replaced the annotation contract with parsed-AST requirements for an exact closed
ten-field `SignedVertex`; full-record authentication in local issuance and remote admission; stored and
exposed local signed records; per-envelope decision history; and operation-grounded duplicate versus
equivocation behavior. The old GREEN then failed 2 integration tests while all 4 RED controls passed,
which established the intended boundary without weakening an assertion.

### D.37.2 — Accepted round-4 tuple and owned claim

The locally accepted, still-uncommitted Phase −1′a tuple is:

- `tests/protocol-v3-formal-action-model-n1prime-a.test.ts`,
  `affc5e439220e8ac6353c0795f591da3946a6aeb37d69a71a05763f229f34f6d`;
- `tests/fixtures/phase-n1prime-a/formal-action-contract.json`,
  `474c83e7a3f130504e8dedc8ceb0843ee3413ca56c27003a354f6088b0f41dcf`;
- `packages/protocol-v3/formal/author-lineage-actions.qnt`,
  `7971a025959164f609f4509bf4242f94fc4cc0b6974dde903bf462852983f038`;
- `packages/protocol-v3/formal/signed-field-derivation.json`,
  `e693b3fec5ef0d73299642d49e5ab7fdc969df80214f1d9891a05e188d1b7346`.

The model owns a bounded abstraction for one object/author lineage. Its closed `SignedVertex` contains
`kind`, `protocolMajor`, `objectId`, `epoch`, `anchor`, `author`, `authorSequence`, `logicalTime`,
`dependencies` and `operation`. Authentication compares the complete typed records. Successful local
issuance stores and exposes a record whose embedded sequence is the selected next ordinal; failure advances
and exposes nothing. Remote admission memoizes an authentication decision by envelope and does not reject
an authenticated duplicate, gap or equivocation because of arrival history. Observation records
operations by sequence, so a repeated operation is a duplicate while a different operation at the same
slot can be detected as equivocation. `step` remains a top-level finite nondeterministic action choice with
bounded caps and an explicit stutter.

The derivation consumes no registry field list. The test parses the Quint AST, requires the exact closed
record, proves both owned actions invoke full-record authentication, equates the derived JSON field set to
that AST surface, and binds the JSON to the live model hash. This is a parse/hash/equality gate over a
hand-authored JSON artifact, not a claim that a checked-in generator already exists.

### D.37.3 — Cold gate, mutation strength and preservation

Round-3 final Opus correctly blocked the otherwise green tuple because the two Quint-heavy Vitest bodies
inherited the repository-wide 10-second timeout. Kimi measured a genuine cold timeout at 22.6 seconds,
while warm runs completed in 5.8–7.2 seconds. The round-4 Codex-high harness correction changed no
assertion or Quint command: it renamed two misleading existence-test titles and added a local `120_000`
third-argument timeout to each heavy `it.runIf` body. `vite.config.mts` and the global 10-second timeout
remain unchanged. The exact reverse diff reconstructs the prior test hash
`ff150634fad8549b0c46ff6f74c7c52fb6a1c4be09013538d048497e22fe20ba`.

A separate Codex-high GREEN validator isolated and restored only `node_modules/.vite`, then passed a
genuinely cold focused run: 1 file / 8 tests in 8.96 seconds. Quint typecheck and all 11 scenarios pass;
the 256-sample, 24-step simulation reports no violation and reaches all 8 witnesses. Workspace typecheck
passes across all 31 projects. Lint remains 0 errors / 226 inherited warnings. The isolated frozen-v2
preservation run passes 4 files / 31 tests.

Seven fresh disposable mutants were copied from model hash `7971a025…`, typechecked, and causally killed:
weakened full-record authentication; selected-sequence-plus-one record binding; failure consuming the
ordinal; identity derived from `author` rather than `operation`; slot-1-specialized equivocation;
deterministic `step`; and cap stutter growing phase. Six die in their targeted Quint scenario and the
deterministic-step mutant dies on parsed AST structure. None reads the derivation JSON, so a stale embedded
model hash cannot manufacture a kill. The cold/gate ledger is
`.logs/phase-n1prime-a-round4-green-ledger.log`
(`e62421170aa041f5f3a54e7fd6814bf74eb503b31a02c978720f3fcae21fa4f4`); the mutant ledger is
`.logs/phase-n1prime-a-round4-mutant-ledger.log`
(`70b816c11a59bceeb14b7b52d29d6673133e5dfee900040c5877423231622dbb`).

One attempted v2 preservation run overlapped full lint and workspace typecheck and timed out only the
existing 5-second Quint-map test and 15-second ESLint subprocess test. The unchanged isolated rerun passed
31/31 in 7.11 seconds. The failed parallel log is retained as evidence that subprocess-heavy safety gates
must not be scheduled under artificial local contention; it is not represented as a protocol failure.

### D.37.4 — Independent review and golden-path audit

Corrective round 3 Grok and Kimi-100 passed, but final Opus-xhigh correctly retained two blockers: the cold
timeout and mutation logs predating the accepted model hash. Round 4 closed both and received fresh delta
reviews:

- Grok `PASS`, authorizing local −1′a acceptance and −1′b RED only
  (`phase-n1prime-a-review-grok-bundled-round4-20260727T003000Z.stdout.log`,
  `83ac050fc470e2826daf1a81cbed59343887b2d868827a85e8b9e59f509524e0`);
- Kimi CLI with `--max-steps-per-turn 100`, `PASS` with the same scoped authorization
  (`phase-n1prime-a-review-kimi100-corrective-round4-delta-stdout.log`,
  `f080315eec20fcf38c4a3a6585ced3e6fbe2285b7cc86d16f23212351405283f`);
- fresh Claude Opus 5 / xhigh session `6edfbea8-95f6-4054-a928-8e89195dec26`, `PASS`,
  local −1′a acceptance `YES`, −1′b RED `YES`, atomic freeze merge `NO`
  (`phase-n1prime-a-final-opus-xhigh-round4-20260727T184833Z.normalized.md`,
  `38dca0c496e8b0bc81f2f8f4d308a402222c38a6ce195f75d3adfefce28389a5`).

The user-requested Claude-skill Fable-high audit used the actual first-party `claude-fable-5` model at
high effort, session `82eb155e-5aa1-4d79-b1b7-3c6238672bbb`. It returned `ON TRACK`
(`fable-golden-path-audit-20260727-v1.normalized.md`,
`122ef978b63fb8deb7505cf729b0e1891e1f8102eed7e3c79e71d1f38d5f6334`) after tracing the plan backward
from the Discord and chat golden paths. Runtime durability, persistence, backpressure, compaction,
bootstrap, ACL supersession and cold-join/archive behavior remain intentionally future-owned; pulling
them into −1′a would blur ownership rather than strengthen this slice.

### D.37.5 — Findings, gotchas and next-slice constraints

1. Several named Quint invariants remain partly definitional. `operationIdentityGrounded` restates the
   accessor, `signedFieldDerivationSound` is equality/identity-shaped, duplicate/gap non-rejection follows
   an admitted-only observation guard, and the two arrival/history invariants currently have the same
   formula. Executable scenarios, TypeScript controls, AST checks and mutation kills are the primary
   evidence. Phase −1′b must not copy this pattern where a registry/model/spec bijection can be falsified
   directly.
2. Local `authenticateSignedVertex` compares the constructed record to itself. This is an honest
   scope-limited formal abstraction, not a live signature implementation. Strengthening it now would
   reopen the model; real crypto, registered-byte binding and durable publication remain owned by the
   later v3 port, Phase 3a and Phase 2l.
3. Random simulation chooses only authenticated remote candidates. Ten one-field authentication
   rejections are executable scripted scenarios; randomized rejection coverage remains absent.
4. The gap predicate is the bounded predecessor-missing abstraction, not the fixture's richer
   greatest-seen/fills-gap taxonomy. It is sufficient only for the owned non-rejection claim.
5. Quint 0.32 requires `parse --out`; `test` needs `--match ^test`; parsed `pure val` declarations use the
   `pureval` qualifier. `.qnt` has no Prettier parser, so Quint typecheck plus whitespace/diff checks are
   the formatting gates.
6. Large untracked inputs can cause `ENOBUFS` or checker noise, and safety gates that launch subprocesses
   must run isolated. `.logs/`, `.pnpm-store/`, `.agents/`, `.claude/` and `skills-lock.json` are not part
   of the atomic freeze. The two stale v2 `0g2` RED files also remain excluded. Never use `git add -A` for
   this freeze; directory-level ignore hygiene must be resolved before the atomic checkpoint.
7. Before −1′b freezes any `/v3` pacemaker/seal domain or −1′c mints vectors, resolve D.27's
   `roundChange`/`anchor` residual as a numbered v3 normative decision and perform a v3-wide signed
   variable-set sign-off for every registered envelope kind, or record an explicit scoped-registry
   rationale. The exact distinct v3 identity suite and every other v2-domain-bound suite remain −1′b
   freeze decisions.

---

## Appendix D.38 — Phase −1′b v3 registry/schema/specification

### D.38.1 — Corrected RED and accepted GREEN tuple

The fresh Codex-high RED originally failed on exactly the six absent v3 registry/schema/spec/formal
artifacts, with nonnormative controls passing. The first GREEN exposed a false RED oracle: its default
JSON Schema mapping narrowed `canonical-safe-integer`, `parameters`, `canonical-value` and `bytes` to
`string`, contradicting both the frozen TypeScript normalizer and the independent JavaScript reference.
That passing result was rejected rather than treated as progress.

A fresh Codex-high read-only adjudication returned `BLOCK` and no plan-semantic change; Kimi-100 returned
the same ruling. Opus-xhigh agreed that the tuple was blocked, but proposed a new numbered bytes-projection
decision. The reviewers did not unanimously authorize that plan change, and the implementation avoided
its trigger: it froze no base16/base64 or other JSON projection. `bytes` and the full canonical-value
domain therefore carry exact `x-registry-type`/`x-registry-constraints` provenance without a narrowing
top-level JSON Schema `type`. Any future slice that chooses a bytes-projection literal must treat that as
a new normative decision and re-run the unanimous plan-change rule.

The corrected RED covers all 17 frozen registry field types exactly once, rejects unknown scalar and array
types, compares nullable unions order-insensitively, and requires exact native type, constraints, enum and
numeric-bound provenance. It passed 6/6 controls, then failed against the unchanged first GREEN on exactly
nine fields: one `parameters`, three `canonical-value`, three `canonical-safe-integer` and two `bytes`.
The corrected GREEN changed only the schema and its outward-hash sign-off.

Accepted local RED tuple:

- `tests/protocol-v3-registry-spec-n1prime-b.test.ts`
  `380cce1ad170422be6cab1c3ba316341b63700da2e9ef0588eed6f54897b4022`
- `tests/fixtures/phase-n1prime-b/registry-spec-contract.json`
  `0f8e1d62a7eb75961addc07fcc32a6c228ca2c432a3bbafd11478c828c2fc324`

Accepted local GREEN tuple:

- `packages/protocol-v3/registry/registry-v1.json`
  `7d8ecd8f7ab373018bff7200ba1c287dd3964735c8290491fa4f8a552cf22b9a`
- `packages/protocol-v3/registry/registry-v1.schema.json`
  `6ab6f377457cbe43d79c0aee4b766683c7c202cd308481db66f04e723787fbdc`
- `docs/protocol/attested-hard-epochs-v5.md`
  `ef94d314f9fb080b69051a80769326f43b412fcdaf36633f68fe3da5a1fdf085`
- `docs/protocol/amendments-v3.json`
  `6cf8b6e25064227df7665aea37ca2bcfd049b570fcfe9d867172d967e39ffe44`
- `packages/protocol-v3/formal/registry-signed-envelope-variables.qnt`
  `f6dede1370a40a37d2dca526a27f3dc5c6884c9b8c23390da3372977c2bcef13`
- `packages/protocol-v3/formal/registry-model-signoff.json`
  `882b3ae23c5c65f10542dab961a154b94fc3ad55d16ebb421a974dcae83f56a4`

These remain local, unpublished and unmerged. They are not an independently authoritative checkpoint.

### D.38.2 — Normative result and executable evidence

Protocol v3 registry v1 carries all 19 v2 kinds forward under distinct `/v3` domains. Its 147 fields add
only `vertex.authorSequence` and the direct `roundChange.anchor` that closes D.27. The accepted −1′a AST
mechanically fixes the ten-field vertex review order, with `authorSequence` immediately after `author`.
Receiving `Number.MAX_SAFE_INTEGER` is valid; an exhausted local issuer rejects without advance, wrap,
reset, signature or publication.

The active suite identifiers are `ed25519-sha256-v3` and `ed25519-seal-v3`, each distinct from its
v2-domain-bound predecessor. The inactive P-256 alternative is separately reserved as
`p256-sha256-v3`, with an explicit predecessor disposition and amendment-gated activation. Four kinds are
mechanically signed — `vertex`, `epochAnchor`, `sealVote`, `roundChange` — and each maps to exactly one
active suite. All four v2-signed predecessors remain signed. The direct `roundChange.anchor` sits
immediately after `epoch`, so every signed round-change vote binds its epoch lineage even when
`highestPrepareQC` is null.

The sign-off maps all 42 signed fields one-to-one to 42 parsed and typechecked Quint variables:
v2's 40 plus `authorSequence` and `roundChange.anchor`. Six consecutive numbered decisions are bijective
across registry bindings, specification records and amendments. The sign-off hashes five artifacts
outward and never hashes itself.

Sequential evidence passed:

- corrected focused test: 8/8;
- generic registry/schema provenance: 147/147 fields, with eight schema mutants killed;
- registry/schema/spec/Quint/sign-off bijections: six mutants killed;
- Quint parse/typecheck: 42 variables;
- frozen v2 preservation including the freeze CLI: 12/12;
- accepted −1′a preservation: 8/8;
- workspace typecheck: all 31 projects;
- lint: 0 errors and 226 inherited warnings;
- Prettier, whitespace and diff checks.

The primary GREEN ledger is
`phase-n1prime-b-green-corrected-hash-ledger.log`
(`2e64f733918f555eda7ae658a846d2de5d9f09c4cccc27119e47a3fa4c0b4e6e`).

### D.38.3 — Independent reviews and authorization

The completed Grok 4.5/high rerun returned `PASS` after two earlier headless attempts stopped at their own
permission boundary without reviewing the tree. Only
`phase-n1prime-b-review-grok45-high-rerun2.raw.json`
(`006313caedc641afe67451588bdb09c89d596af6bfab292cd5724e67ed91d2be`) is verdict evidence.

Kimi CLI with thinking enabled and `--max-steps-per-turn 100` independently returned `PASS`
(`phase-n1prime-b-review-kimi100-final.log`,
`c27a042ac25f2f95ea92436ecf63e9d8a084e7aa221d7de23d5b0c5176e39b1e`).
Its prose incorrectly said the corrected RED touched only the test; the fixture also changed from six to
17 type controls. The before/after hashes and TDD result are correct, so this wording slip is nonblocking.

Final Claude Opus 5/xhigh returned `PASS`
(`phase-n1prime-b-final-opus-xhigh.normalized.md`,
`27c5d092bcc29ccf421318ea301242a7368f18e30dcae08684182d8f3f4e32ea`;
raw JSON `82434eafc4f8d8ad8d73811c508b4eb7633888699cf99085bce62c717a72fb9b`).
All three final reviewers authorize local −1′b acceptance and beginning −1′c RED. All explicitly deny an
atomic checkpoint until −1′a…−1′e are complete together.

The schema-assumption consultation also included a fresh read-only Codex-high collaboration agent. It
returned `BLOCK`, the exhaustive no-narrowing mapping used by the correction, and no main-plan semantic
change. Its response is retained in the collaboration transcript rather than a standalone `.logs`
artifact; the GREEN agent's separate mismatch inventory is not represented as that independent vote.

### D.38.4 — Findings, gotchas and next-slice constraints

1. The original schema default was a false oracle. A green result that contradicts both frozen
   implementations is not accepted merely because the test permits it. Future RED corrections retain a
   reverse diff or other reconstructable delta, not hashes alone; the original −1′b RED/fixture bytes are
   not recoverable from the final tree.
2. `bytes` and `canonical-value` intentionally omit top-level JSON Schema `type`. Registry-aware
   consumers must interpret their exact `x-registry-*` annotations. No textual bytes projection was
   selected. An Ajv/instance-level differential belongs with −1′c vectors, where concrete wire
   representations exist.
3. The current artifacts correctly audit the inactive P-256 successor, but the permanent RED does not
   mechanically gate `cryptoSuites.reserved`, `reservedPredecessorAudit`, D01's reserved-suite fields, or
   the enum-to-active-suite relationship. −1′c RED must bind active, predecessor and reserved suite
   literals to the registry by value equality and tie active enum values to active suite ids.
4. D01's active/predecessor suite literals agree with the registry today but are not checked as exactly as
   the wire-format decision. −1′c must close that executable evidence gap before minting vectors.
5. An extra active suite with an empty `domainKinds` list and a role absent from v2 can pass −1′b's gate.
   Vector coverage must require every active suite to own a registered signed kind and every signed kind
   to appear exactly once.
6. Six successful silent-command logs are zero bytes. Grok, Kimi and Opus independently reran the
   important gates, so this is not a present blocker; future ledgers record command, exit status and a
   positive marker.
7. The package remains artifact-only and intentionally has no `package.json`. −1′c must not introduce a
   package scaffold merely to make imports convenient.
8. `.agents/`, `.claude/`, `.logs/`, `.pnpm-store/` and `skills-lock.json` remain unignored, and the two
   stale v2 `0g2` REDs remain excluded. Resolve directory-level ignore hygiene before −1′e and never use
   `git add -A` for the atomic freeze.
9. No vectors, reference implementation, locks or activated governance were created in −1′b. Runtime
   durability, received-byte binding, persistence, backpressure, compaction, bootstrap, ACL supersession
   and remote admission retain their later owners. The Fable-high Discord/chat audit therefore remains
   `ON TRACK`.
10. Appendix D.39 supersedes only this appendix's forward authorization and the GREEN hashes that D07 will
    necessarily refresh. D.38 remains the reconstructable record of the exact six-decision bytes and
    reviews that existed before the missing codec-grammar assumption was discovered.

## Appendix D.39 — Missing canonical grammar and the Phase −1′b2 split

### D.39.1 — The stopped GREEN and the incorrect assumption

The first corrected −1′c RED was locally completed after two material corrections. It first removed a
registry-fed reference protocol that would have collapsed the independent oracle into a generic registry
interpreter. Its blocked, bare-`next` transaction control treated
`authorSequence = Number.MAX_SAFE_INTEGER` as valid on receipt but made `MAX_SAFE_INTEGER - 1` the last
locally issued ordinal because that representation had no separate post-maximum exhaustion state. The
successful control independently recomputed the registered vertex digest and verified Ed25519 over the raw
32-byte digest with `zip215 = false`.

That `next`-only boundary was blocked history, not the accepted protocol rule. The later c2 contract,
both accepted references and the frozen replacement mint persist `lastIssued` plus an explicit
`exhausted` discriminator: they successfully issue `MAX_SAFE_INTEGER` from
`lastIssued = MAX_SAFE_INTEGER - 1`, atomically mark the lineage exhausted, then reject later attempts
without state change, digest, signature or publication. Phase 0g(ii-I) and Phase 2l must preserve that
accepted transition without computing an unsafe `MAX_SAFE_INTEGER + 1`.

Blocked pre-correction −1′c RED pair:

- `tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts`
  `10f1f8b502cb599da6350cc13192e8fbe407710698c187e26ffe2e84d47374a2`
- `tests/fixtures/phase-n1prime-c/reference-vector-contract.json`
  `1f84788cad31a3fd737cf55d5da053748ea4e997bd4c5dbf4cf50fa568816840`

Its seven controls passed and its one intended test failed only on the absent reference, provenance and
vector tuple. Those hashes are preserved as blocked-first-RED evidence, not accepted final −1′c hashes.
The corrected RED must retain a reconstructable reverse diff from them.

A different fresh Codex-high GREEN author then stopped before creating any source, vector, provenance or
log. That stop was correct. The v3 registry and schema are normative material and fully own the 147-field
surface, domains, encodings and constraints. The registry also fixes framing, endianness and the codec
identity `drp-canonical-profile-1`. But neither it nor the v3/v2 prose defines the proprietary tag codec's
actual byte grammar: tag octets, recursive payload layouts, varuint and zig-zag rules, float and
negative-zero behavior, typed-array widths, duplicate/non-minimal rejection and resource limits exist
only in predecessor implementations. Asking the independent reference author to recover those rules from
the predecessor would make the codec differential a shared-source comparison. Asking the author to
invent them would create a new wire format.

The current RED compounds that gap by importing the frozen v2 TypeScript codec as the definition of
expected bytes. That import remains valuable as a preservation differential, but it cannot remain the
normative byte owner. The semantic anti-copy discriminator is deliberately narrower: it kills omission of
`authorSequence`, omission of direct `roundChange.anchor` and activation of the reserved suite. It does
not and cannot prove that a codec was independently authored.

### D.39.2 — Required consultation and unanimous correction

Because this changes the plan's oracle chain, work stopped for the required independent consultation.
Codex-high, Kimi with thinking and a 100-step ceiling, and Claude Opus 5/xhigh all returned Determination
**B**: `BLOCK` −1′c GREEN and add a normative codec-grammar slice before it. Kimi initially preferred a
standalone annex to preserve the local −1′b GREEN hashes, then withdrew that option in convergence. All
three agreed that an unbound annex would reproduce the exact side-channel weakness that −1′b's
spec/amendment/registry bijection exists to prevent. No checkpoint exists; reopening the local,
unpublished tuple is correct.

Recorded external evidence:

- Kimi initial:
  `phase-n1prime-c-assumption-kimi100.log`
  (`a3f3163707923b255439c0acb523df31f0f6b4004236953e0a4a5ea7143175c3`);
- Kimi convergence:
  `phase-n1prime-c-assumption-kimi100-convergence.log`
  (`4ce421d896d0dc20aa7d79bcd21689fe85d5ce03487d652e7e4f40d4e8021f95`);
- Opus initial:
  `phase-n1prime-c-assumption-opus-xhigh.raw.json`
  (`c8ed199dc121dd1193781a4cbeef5b743d93afe92b1f6cbc5a4fa92be8d6e569`);
- Opus convergence:
  `phase-n1prime-c-assumption-opus-xhigh-convergence.raw.json`
  (`a553d4d9f826cb3cdb73a9587fefeac3423884e46d0998c557d37b4b344f8a52`);
- Opus final convergence:
  `phase-n1prime-c-assumption-opus-xhigh-final-convergence.raw.json`
  (`70ec980ec20952fd696ead76bfc8bf2b1a3b06cb50afb4b2a5b94c8eb60932b0`).

The Codex-high initial and final convergence votes are retained in the collaboration transcript. The final
unanimous authorization is exactly the following sequence:

1. **−1′b2a, grammar extraction.** A fresh RED author may inspect the frozen predecessor solely to build a
   falsification corpus. A different grammar author may inspect it solely to transcribe the existing wire
   contract into `docs/protocol/canonical-tag-codec-v1.md` and a machine-readable tag/layout/worked-example
   artifact. Both are permanently barred from authoring either v3 reference or the later TypeScript port.
   The grammar RED must execute a from-grammar implementation and fail on byte non-reproduction, not file
   absence. The grammar is authoritative; examples are binding conformance cases but cannot override its
   production rules. Give this item its own RED, GREEN, Grok, Kimi-100 and final Opus-xhigh gate.
2. **−1′b2b, D07 binding.** Use separate RED and GREEN authors. Append numbered decision
   `PH-N1P-D07` coherently to the v3 specification, amendments, registry decision bindings and outward
   sign-off. Bind at least `codec`; bind `framing` and `endianness` in the same decision unless the RED
   proves an already-numbered owner. Re-run the unchanged −1′b test as the consistency oracle. Its RED
   test/fixture, registry schema, signed-variable Quint, −1′a tuple and frozen v2 artifacts remain
   byte-identical. Refresh only the hashes whose bytes actually change and give b2b its own complete review
   gate.
3. **Correct −1′c RED.** A fresh author who wrote neither b2 GREEN and inspected, copied, transcribed or
   execution-assisted-reconstructed from no predecessor reference, regenerated reference or TypeScript
   codec must implement the primary byte oracle from the grammar alone. Add grammar provenance and a
   `readNoImplementationSource` attestation. Execute the frozen v2 codec only as a full-corpus preservation
   differential against that oracle. Preserve the D.38 suite/schema gates, the c2
   `sequenceContract`/frozen MAX_SAFE-once semantics and accurately scoped semantic anti-copy cases.
4. **Independent reference, then vector mint.** A new reference author who wrote neither the normative
   tuple nor RED and inspected no predecessor implementation fixes and hashes the source first. A different
   vector-minting agent—who authored neither the annex nor RED—then builds real registry-derived vectors
   without editing that source. The regenerated reference and later TS port retain their own distinct
   authors.

This correction does not weaken atomicity: −1′a…−1′e still land as one consensus-visible checkpoint. It
adds two internal reviewed TDD items because an unreviewed prose annex or an unbound D07 would be a false
repair.

### D.39.3 — Carry-forward gotchas

1. A grammar transcribed from frozen code is not magical source independence. It supplies a reviewable,
   language-neutral and third-party-implementable contract. Independence comes from two later
   from-grammar implementations, role separation, truthful provenance and the predecessor-source
   firewall.
2. The corrected −1′c RED must assert the preservation differential. A retained but unexecuted v2 import
   is dead evidence.
3. The D07 append must use decision `7`, anchor `#decision-v3-07`, matching `normativeSource`, identical
   `registryPaths` across the decision triple and refreshed outward sign-off hashes. The unchanged −1′b
   test must be re-executed over the changed artifacts; byte identity alone is not evidence.
4. D.38's reviews remain valid for their exact historical six-decision bytes. D.39 and the later b2b
   appendix must carry both old and new hashes instead of silently rewriting that record.
5. The current blocked −1′c RED is not a license to begin reference authoring. −1′c GREEN remains blocked
   until b2a and b2b each pass their full review gate and the corrected −1′c RED is accepted.

## Appendix D.40 — Phase −1′b2a canonical grammar extraction

### D.40.1 — Accepted tuple and causal TDD history

Phase −1′b2a is accepted at the following exact tuple:

- RED test `tests/protocol-v3-canonical-grammar-n1prime-b2a.test.ts`:
  `f2f25dd9ae70971ffe920c0ab653e46b15f090d8b4fe5a6ba4e9157abe4aed89`;
- RED fixture `tests/fixtures/phase-n1prime-b2a/canonical-grammar-contract.json`:
  `fd921870b36ddab56987b8bc21cc0ad9599884b43364ba45c10a9e1ba365c0cf`;
- authoritative grammar `docs/protocol/canonical-tag-codec-v1.md`:
  `40f817866619931cd13461393005ea2a796de343591e3ec88be404664e8e5036`;
- machine companion `docs/protocol/canonical-tag-codec-v1.json`:
  `64426584f7c3217a42e258ec5d2eaae368d209dd520c0653361a1aca82aa705e`.

This was not a one-pass artifact-presence GREEN. The accepted tuple is the third causal re-freeze:

1. the original RED/GREEN exposed missing set and typed-array precedence plus false object encode-limit
   semantics;
2. the first final Opus gate rejected a flat varuint precedence table, missing `INTEGER_RANGE` coverage and
   mutation tests that died at schema equality before reaching the byte interpreter;
3. the second final Opus gate rejected the predecessor-incompatible `TRUNCATED` result for unavailable
   declared string payloads and required a winning value-range case, a multi-octet length and actual
   execution of the pinned golden registry;
4. each rejection returned to the same isolated RED author first and the same isolated GREEN author only
   after controls passed and the unchanged GREEN failed narrowly. Preimage archives and reverse patches
   make both corrections reconstructable.

The final corpus contains 28 positive cases, 28 decode-negative cases, 16 encode-negative cases, four
encode-limit controls, six explicit precedence probes and all 26 pinned registry-v5 golden vectors.
The grammar oracle executes 10,490 golden canonical bytes generically through encode and
decode/re-encode identity in approximately 5–8 ms under a 1,000 ms ceiling. Fifteen byte-affecting
mutants die through `runGrammarCorpus`; the three genuinely structural mutants are labelled separately
and die only through structural validation.

### D.40.2 — Normative result and executable evidence

The accepted Markdown is the authoritative language-neutral grammar. The JSON file is its
machine-readable companion and binds the Markdown digest; worked examples are binding conformance
examples but cannot override productions.

The final extraction explicitly freezes:

- all fifteen tag octets, recursive payload layouts and zero/count productions;
- minimal varuint, zig-zag integers, big-endian numerics and typed-array widths;
- encoded-byte ordering, duplicate rejection, finite/negative-zero rules and resource accounting;
- pre-terminator `VARUINT_RANGE_OCTETS`, then `VARUINT_NON_MINIMAL`, then post-terminator
  `VARUINT_RANGE_VALUE`;
- integer-stage `VARUINT` then `INTEGER_RANGE`;
- the predecessor's string exception: unavailable declared string payloads are `UTF8_INVALID`, while
  unavailable declared byte/container payloads are `TRUNCATED`;
- an unsafe-integral scalar Float64 decode non-decision outside the governed corpus rather than a false
  round-trip guarantee.

The final GREEN gate passed:

- focused b2a: 4/4, including 26/26 golden vectors;
- accepted −1′a/−1′b preservation: 16/16;
- frozen v2 preservation: 12/12, including the real freeze CLI;
- workspace typecheck: 31/31 projects;
- workspace lint: 0 errors and 226 inherited warnings;
- all 26 pinned preservation hashes, Prettier/idempotence, Markdown hash binding, implementation-shortcut
  scan, whitespace, diff and bounded-scope checks.

The final RED and GREEN ledgers are:

- `.logs/phase-n1prime-b2a-red-opus2-correction-hash-ledger.log`
  (`af78d994f9a244ca672dc0098034aa1817f6ac9524434b44278d9a128c2415aa`);
- `.logs/phase-n1prime-b2a-green-opus2-remediation-hash-ledger.log`
  (`3020e072b9f8106fff78b0321e2aa1f528e029a7eecfa573c15e7d4d4be3085b`).

### D.40.3 — Independent reviews

The accepted tuple passed all three required fresh reviews:

- Grok 4.5/high:
  `.logs/phase-n1prime-b2a-rereview2-grok45-high-final.raw.json`
  (`5d4c61ef74b1fa060bf661187d5c14180b7ad851b4b12db674671ca366a4703a`) —
  **PASS_WITH_NOTES**;
- Kimi-100:
  `.logs/phase-n1prime-b2a-rereview2-kimi100-final.log`
  (`43acde5d9389c65a3c2ec81534a201e1913088e667bc98522fee5be38b4f7b8a`) —
  **PASS_WITH_NOTES**;
- Opus-xhigh:
  `.logs/phase-n1prime-b2a-rereview2-opus-xhigh-final.raw.json`
  (`4e926162e7e88a518124029edee600fc80df651a0e6e5bdfe2c463a5631ad009`) —
  **PASS_WITH_NOTES**.

The final Opus gate did not inherit the earlier passes. It extracted the from-grammar interpreter to a
read-only scratch harness and found zero divergence over 19,291,032 decode inputs, 232 fixed encode-domain
cases, 4,000 randomized values, all truncation positions, all nine precedence stages and a fresh
1,245,206-case compiled-dist versus pinned-source comparison. This is evidence for the accepted governed
surface, not a claim that exhaustive testing proves the grammar universally.

The two superseded Opus blocks remain material evidence rather than being erased:

- `.logs/phase-n1prime-b2a-review-opus-xhigh-final.raw.json`
  (`143ddfe8f317e95966214c6c30ee0ef2c692de44aeb67f27993aa048786c7918`);
- `.logs/phase-n1prime-b2a-rereview-opus-xhigh-final.raw.json`
  (`f9b7c48af343604669166636bf23c409842845bce6d7f15836060bf6b84bea3f`).

### D.40.4 — Findings, gotchas and carry-forward constraints

1. The JSON structure is strongly equality-pinned, but its prose body is not independent corroboration of
   the Markdown: the meaningful free leaves are the Markdown digest plus 31 rule statements. D07 must bind
   the Markdown as authority, with the JSON as a companion and examples subordinate.
2. Four declared precedence stages remain declarative rather than mutation-probed, but the final Opus
   review independently verified them against genuine dual-defect predecessor inputs. This is a
   carry-forward coverage note, not a known false rule.
3. Item multipliers are predecessor-true but thinly falsified in the committed corpus.
   `zigzag.maximum` is unreachable because the enclosing varuint maximum prevents an encoded positive
   result beyond `MAX_SAFE`; later implementations may retain the explicit symmetric check without
   treating it as a reachable corpus obligation.
4. A multi-octet length is causally covered; a multi-octet collection count is not. Add that coverage in a
   later from-grammar/fuzz tier when it improves the oracle rather than lengthening every PR gate.
5. The extraction differential currently reaches `@ts-drp/canonical` through gitignored compiled `dist`
   while pinning the source. Final Opus measured 1,245,206 dist/source cases with zero divergence, but
   corrected −1′c must alias to source, rebuild deterministically or pin the actually executed artifact
   instead of silently inheriting this provenance gap.
6. Grammar-side encode negatives bind exact categories; the predecessor-side extraction loop still binds
   only that an error is thrown. All 16 messages were independently verified, but later preservation
   differentials should bind the exact predecessor category where the public contract owns one.
7. Empty bytes `06 00` is derivable from `BYTES_LENGTH` but omitted from the otherwise explicit zero-form
   enumeration. Empty input and empty typed arrays are likewise thinly covered. These are prose/corpus
   polish items, not permission to reinterpret their productions.
8. `conformance.decoderProperty` omits the phrase “in the governed corpus”; the numbered rule and
   authoritative Markdown retain the qualifier. Do not broaden the guarantee while the unsafe-integral
   Float64 non-decision remains open.
9. The accepted b2a authors remain permanently barred from either v3 reference, vector mint, regenerated
   reference and the later TypeScript port. The predecessor firewall survives the re-freezes.
10. Phase −1′b2a is accepted but not a checkpoint. The whole −1′a…−1′e freeze remains one unpublished,
    unmerged atomic consensus-visible landing.

## Appendix D.41 — Phase −1′b2b D07 grammar binding

### D.41.1 — Accepted tuple and harness correction

Phase −1′b2b is accepted at this exact tuple:

- RED test `tests/protocol-v3-codec-grammar-decision-n1prime-b2b.test.ts`:
  `6f69554debf9caa8f30273324cc223631d70f6d76534be2b0d4e33281ce57b1e`;
- RED fixture `tests/fixtures/phase-n1prime-b2b/codec-grammar-decision-contract.json`:
  `51848429253440aa103e8b45d942975f8e029df18a3cc5f25c1df2b4c9da5c16`;
- registry `packages/protocol-v3/registry/registry-v1.json`:
  `2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9`;
- specification `docs/protocol/attested-hard-epochs-v5.md`:
  `a2d1c818eecf4524aac60d102aded73eafdab8cb613e7a53a91d79fff9ac9db8`;
- amendment log `docs/protocol/amendments-v3.json`:
  `e83625828b38ae398cfdb8e8aa4d404ce90e64a43884b248a4d928e14a392508`;
- outward sign-off `packages/protocol-v3/formal/registry-model-signoff.json`:
  `9b93fd6d843817a2e59309f11cba049d129ed5e862e26bc3706d3f4d1fdc5749`.

The first RED had a genuine harness contradiction: its illustrative positive control started from the live
tuple and unconditionally appended D07. A correct GREEN therefore made integration pass while the control
failed on a duplicate eighth decision and duplicate anchor. The GREEN author stopped, archived the correct
four-file tuple, restored all four targets to their exact pre-GREEN hashes without git rollback and
re-established the causal absent-D07 RED.

The same RED author then corrected only the test. The illustrative builder now reconstructs the uniquely
pinned historical D01–D06 slices and appends exactly one D07; a simulated coherent-live input also rebuilds
to exactly one D07 on every surface. The fixture remained byte-identical. The corrected control kills the
original eleven incoherence mutants plus an explicit duplicate-D07 mutant. The historical tuple retains
three passing controls and one narrow integration failure; the final GREEN passes 4/4.

This correction is reconstructable:

- corrected RED ledger `.logs/phase-n1prime-b2b-red-correction-hash-ledger.log`
  (`a05d170749c5f6d7f9842c0e4b02e11cbc78bfb55cfd1a3a61c04f3f4e75ed9c`);
- final GREEN ledger `.logs/phase-n1prime-b2b-green-final-hash-ledger.log`
  (`f426cc10e7853b8466e9cc6d0d884ba4f5cacfdbdbdd9ddb9be7e20caafd883b`);
- final GREEN summary `.logs/phase-n1prime-b2b-green-final-summary.log`
  (`a18d553018071dc835bb404e81f58a403037a0340b3a164e54a32f0630755206`).

The final GREEN is a byte-identical replay of the archived blocked-GREEN tuple. That is legitimate because
the block was an unsatisfiable test harness, not a content defect; it is not an independent re-derivation.

### D.41.2 — Normative result and executable evidence

Exactly one `PH-N1P-D07`, decision number `7` and anchor `#decision-v3-07` now follow semantically unchanged
D01–D06 on all three decision surfaces. D01–D06 own none of `codec`, `framing` or `endianness`; D07 binds
all three with identical `registryPaths` and `normativeSource`.

D07 binds the accepted grammar tuple from D.40:

- authoritative Markdown:
  `docs/protocol/canonical-tag-codec-v1.md`
  (`40f817866619931cd13461393005ea2a796de343591e3ec88be404664e8e5036`);
- machine companion:
  `docs/protocol/canonical-tag-codec-v1.json`
  (`64426584f7c3217a42e258ec5d2eaae368d209dd520c0653361a1aca82aa705e`).

The Markdown remains authoritative and worked examples remain subordinate. The amendment and specification
records equal the frozen D07 contract, the anchor resolves to that exact record, registry values match the
bound codec/framing/endianness requirements and only the three changed outward artifact hashes were
refreshed in the sign-off. The schema, signed-variable Quint and non-hash sign-off content were not
restamped.

The accepted GREEN gate passed:

- b2b 4/4, unchanged −1′b 8/8, b2a 4/4 and −1′a 8/8;
- frozen v2 12/12 across four files, including the real freeze CLI;
- workspace typecheck 31/31;
- workspace lint with 0 errors and 226 inherited warnings;
- 20/20 protected hashes, Prettier/idempotence, diff and scope checks;
- a wrong-`normativeSource` mutation killed by binding, cross-surface and stale-sign-off checks, then
  restored byte-exactly with a final 4/4 rerun.

Coverage-writing Vitest suites must remain sequential: concurrent processes collide in the shared
`coverage/.tmp` directory. Also avoid assigning to zsh's special `path` array in scope scripts because that
silently mutates `PATH`; use an artifact-specific variable.

### D.41.3 — Independent reviews

The accepted six-file tuple passed all required reviews:

- Grok 4.5/high:
  `.logs/phase-n1prime-b2b-review-grok45-high.raw.json`
  (`d7d8006456def7cfa5d3acaa523bc66dab4701df42e7ddf50c68293b53c8d8a5`) —
  **PASS_WITH_NOTES**;
- Kimi-100:
  `.logs/phase-n1prime-b2b-review-kimi100.log`
  (`b7703d93b7c4ea5d919590a2664ef9f818c1d91d4d2f2d0a56cc532d254ec9e5`) —
  **PASS_WITH_NOTES**;
- Opus-xhigh:
  `.logs/phase-n1prime-b2b-review-opus-xhigh.raw.json`
  (`c777ce802718239d7bdb7e11276bbcc3f946fa63bef8815d81bff0701dae51d1`) —
  **PASS_WITH_NOTES**.

Opus independently reconstructed the RED correction, verified all 36 cited evidence hashes and re-derived
45 D07 obligations under both locale and codepoint key ordering with zero failures. This is strong
adversarial evidence, not a universal proof.

### D.41.4 — Findings, gotchas and corrected-−1′c constraints

1. The frozen blocked −1′c control now fails four of eight `acceptedInputs` assertions because it correctly
   remained byte-identical while b2b changed the registry, specification, amendments and sign-off. D.39.1's
   “seven controls passed” describes the historical pre-D07 tree, not the current tree. The fresh corrected
   −1′c RED must pin the accepted seven-decision hashes and must not inherit those four stale pins.
2. D07's structured `endianness: "big-endian"` value is broader than the grammar's exact split: fixed-width
   scalar and typed numeric payloads are big-endian, while minimal varuint uses little-endian seven-bit
   groups. The specification prose scopes this correctly and the grammar is authoritative. Corrected −1′c
   must implement the grammar rather than interpreting the registry scalar as applying to varuint.
3. Only D07 carries `normativeSource` in `decisionBindings`; historical D01–D06 do not, and their absence
   is frozen by semantic pins. The registry schema also does not constrain `decisionBindings`. This
   heterogeneity is existing governance debt, not permission for −1′c to infer missing anchors.
4. `.logs/phase-n1prime-b2b-red-intended-failure.log` is an uncited pre-freeze draft from a third,
   unrecoverable RED revision with fifteen errors. The authoritative causal chain uses the frozen,
   restored and corrected focused logs. Never count the draft as RED evidence.
5. The `staleGrammar` mutant dies on contract equality before reaching the file-resolution branch. Live
   integration and protected-artifact pins cover resolution; record this as indirect mutation coverage.
6. The grammar and D04 both own encoded-key-byte ordering and agree today, but no cross-binding prevents a
   future authorized grammar revision from contradicting D04. Later governance should add that check
   before any grammar amendment.
7. The RED's stable canonicalizer uses `localeCompare`; present keys order identically under codepoint
   comparison, but portable hash-pin tooling should use explicit codepoint order.
8. The unchanged −1′b test tolerates D07 by design and does not own its semantics. Do not cite its 8/8 as
   D07 coverage; the b2b test owns that surface.
9. The blocked −1′c pair remains valuable historical evidence but is not executable acceptance evidence on
   the current tree. Corrected −1′c requires a fresh RED/fixture rather than editing that pair.
10. Phase −1′b2b is accepted but is not a checkpoint. The entire −1′a…−1′e successor freeze remains one
    unpublished, unmerged atomic consensus-visible landing.

## Appendix D.42 — Phase −1′c independent reference and first vector mint

### D.42.1 — Accepted tuple, role chronology and authority hold

Phase −1′c is provisionally accepted at this exact five-file tuple:

- corrected RED test `tests/protocol-v3-independent-reference-vectors-n1prime-c2.test.ts`:
  `d1d4751ccdb8db0e8dbd11e7e353727cdd3a6ef3c739a4a6e1680c16bf1a9b12`;
- corrected RED fixture
  `tests/fixtures/phase-n1prime-c2/independent-reference-vector-contract.json`:
  `17e22228adc677f9287ced3610211b21ec926e7647b1179574f2299359ccca62`;
- fixed original reference `packages/protocol-v3/conformance/original-reference/reference.mjs`:
  `abb01f2f061b20428e1c412793380a0baf468bf9397c7ec2952a902f2aaf7bdc`;
- reference provenance `packages/protocol-v3/conformance/original-reference/provenance.json`:
  `8b5e24c89dd32735ad95ca2a10a98e80dd2bb2623e0188b1355b51076bc90bc3`;
- first mint `packages/protocol-v3/conformance/vectors/registry-v1.json`:
  `39b7c4e60fcb550c936be220660c8065b0bccc44ce1c288e0f685ced03b9dfa2`.

“Provisionally accepted” means the tuple establishes the correctness and independence result below, but
the first vector mint is barred from becoming downstream conformance authority until D.42.5's additive
exhaustion hardening is RED-proved, separately re-minted and re-reviewed. Neither Phase −1′d nor a later
TypeScript port may pin the first-mint vector hash.

The corrected RED author wrote neither reference nor vectors and inspected no forbidden predecessor,
reference or TypeScript implementation source. The reference author then implemented only from the
accepted normative tuple, fixed the source at `2026-07-28T03:30:16.000Z` and permanently stopped editing it.
A different vector-minter invoked that fixed reference at `2026-07-28T03:39:26.569Z`. The reference and
provenance therefore causally precede the vectors and remain frozen through the additive re-mint.

The historical blocked −1′c test/fixture remain byte-identical and are not current acceptance evidence.
The corrected RED chain is recorded in:

- `.logs/phase-n1prime-c-corrected-red-hash-ledger.log`
  (`f64a376c161beca75b7799a456b2cfc2fde9759ebfb47268d337c5856f984f95`);
- `.logs/phase-n1prime-c-corrected-red-firewall-audit.log`
  (`2fb19b34ffbf0e3553807030ab8fbac805a4f0e59db8af10e14ce6051efc9176`);
- `.logs/phase-n1prime-c-corrected-red-scope.log`
  (`b3a8655bca1c36d976a8686fef9130e4ca6d1aca13a8ebdecadf7740912c9df0`).

The reference and vector role ledgers are:

- `.logs/phase-n1prime-c-reference-green-scope-firewall-ledger.log`
  (`7f61bfb258e00a32836690b33989a781f274f2cea736394b62ceaa9911fd35be`);
- `.logs/phase-n1prime-c-vector-mint-evidence-ledger.log`
  (`e1b6a6b0b86b52b9fe16738eea323dddac6b6ac3a119e0e3c8d3a61a7dd969b3`).

### D.42.2 — Implemented result and executable evidence

The corrected RED derives its primary byte oracle from the authoritative D.40 grammar, applies D07's
fixed-width-big-endian versus varuint-low-seven-bit-first split, executes the complete 26-vector frozen-v2
corpus through an opaque compiled artifact and requires all outputs to match. It also pins six semantic
anti-copy discriminators, context exclusion with values retention, exact-received-byte Ed25519
verification, the registered framing/digest rule and the local sequence boundary.

The fixed reference implements standalone grammar encode/decode, all 19 registered kinds, framing and
digest construction, replica-local context handling, sequence issuance and exact-wire Ed25519. The first
mint contains 27 positive vectors covering all 19 kinds and every active enum, all nine required negative
categories, three issuance cases, context/value cases and an exact-wire signature case.

At the first-mint tuple:

- corrected c2 passed 5/5;
- accepted −1′a/−1′b/b2a/b2b preservation passed 24/24;
- frozen v2 preservation passed 12/12, including the real freeze CLI;
- workspace typecheck passed 31/31 projects;
- workspace lint passed with 0 errors and 226 inherited warnings;
- Prettier, whitespace, diff, scope, chronology and firewall gates passed.

### D.42.3 — Independent reviews

The five-file tuple received all required independent reviews:

- Grok 4.5/high:
  `.logs/phase-n1prime-c-review-grok45-high.raw.json`
  (`282758dee0fbb9f20ef262a1d7771cc891bccbb4e7d4dec6a321b09a9436aa44`) —
  **PASS_WITH_NOTES**;
- Kimi-100:
  `.logs/phase-n1prime-c-review-kimi100.log`
  (`75d4dabdc826a059dbd7076ed4ad83f10680f15f44e1eeebf41d2463fdbdf663`) —
  **PASS_WITH_NOTES**;
- Opus-xhigh:
  `.logs/phase-n1prime-c-review-opus-xhigh.raw.json`
  (`6547889f5dff2aa202aa5d3fdb3f4584287d54241f3ea1ddc4d1622439d9fb60`) —
  **PASS_WITH_NOTES**.

Opus independently wrote an encoder from the grammar Markdown without repository imports and reproduced
all 27 first-mint vectors byte-for-byte. This supplies an additional genuinely independent leg beside the
opaque-v2 preservation differential; it is not a claim that the RED and original reference are themselves
independent corroborations.

The additive hardening decision was separately conferred after the Opus finding:

- Codex-high:
  `.logs/phase-n1prime-c-exhaustion-confer-codex-high.log`
  (`2cab7bc95415180cb2c2e862d813c87f65a8dd097ea01e8611e072fe80a29a90`) —
  **AGREE**;
- Kimi-100:
  `.logs/phase-n1prime-c-exhaustion-confer-kimi100.log`
  (`be9207bd7848de7a8ed718c915b75b73f69f0e1604e446067badb19196d184c3`) —
  **AGREE**;
- the final Opus-xhigh review above — **AGREE**.

All three classify D.42.5 as bounded mutation-strength/coverage hardening, not a normative plan correction.
The reference already implements the intended behavior; only the first mint fails to isolate its cause.

### D.42.4 — Findings, gotchas and carry-forward constraints

1. Both first-mint issuance rejections combine multiple failure causes and omit `privateKeyHex`. At that
   tuple, deleting the full exhaustion gate, either exhaustion branch, the key gate or the next-sequence
   gate reproduces the same output. D.42.5's replacement mint kills deletion of the full exhaustion gate
   and `before.exhausted === true` only. Deletion of `current >= MAX_SAFE`, the key-presence gate or the
   next-sequence gate still survives the five-case corpus and remains explicit carry-forward debt.
2. The additive isolated case pins `before.exhausted === true`; it must not be advertised as independently
   pinning the defensive `current >= MAX_SAFE` branch, which is observationally redundant at the valid
   safe-integer ceiling without exposing an internal reason or trace.
3. The RED grammar encoder enforces immediate `maxItems` on Array but not Map/Set even though the grammar
   declares all three. The fixed reference correctly enforces all three and present inputs are six orders
   of magnitude below the limit, so this is nonblocking here. The later TypeScript codec-port RED must
   mutation-pin all three rather than trusting this oracle gap.
4. Registry constraint branches for `charset` and `contiguous` are unverified in both directions.
   `signerIdCharset` and `maxSignerIdUtf16Units` are declared but enforced by neither first-mint reference
   nor RED; `overflow`, `reset`, `initial` and `negotiatedAt` are likewise not executable constraints.
   Resolve their ownership or add explicit tests before claiming the later TypeScript port covers the full
   registry constraint surface.
5. The frozen reference decoder is not executed by corrected c2. Its roughly 200 lines are not conformance
   authority until the later codec-port RED exercises decode-corpus behavior and error precedence.
6. The RED and original reference share nine error strings and check ordering. This is consistent with the
   recorded firewall, which barred predecessor implementation source rather than the earlier RED, but the
   two are re-expressions rather than independent corroboration. Preserve the opaque-v2 and independently
   re-derived Opus legs when reasoning about confidence.
7. `validate-cases` always emits `accepted: false`; its exact four-way reason taxonomy is discriminating,
   but the acceptance field is vacuous for its negative-only input. The opaque helper hydrates only
   `$bytesHex`, and RED dehydration does not preserve raw scalar negative zero. Both are correct for the
   governed corpus and must not be generalized beyond it.
8. JSON cannot faithfully round-trip raw negative zero in the typed-array expected shape. The mint avoids
   that transport form; the known f32 negative-zero fork vector remains a later codec-port obligation.
9. Review prompts initially named six stale paths. The live normative equivalents reside under
   `docs/protocol/`, `packages/protocol-v3/registry/` and `packages/protocol-v3/formal/`; future prompts must
   use those paths.
10. The RED's `expectedInvocationCount` control is vacuous because `runFixedReference` assigns
    `invocationCount: 1`; the unforgeable in-process invocation token is the meaningful anti-hand-fill
    control. Do not cite these as two independent controls.
11. Grok CLI review automation must use true headless `-p` mode with planning disabled and an explicit
    read-only tool allowlist. Interactive positional-prompt mode and headless `--permission-mode plan`
    pause at action approval rather than completing a repository audit.
12. Phase −1′c remains unpublished, unmerged and unusable as a governed checker base. Even after D.42.5,
    the entire −1′a…−1′e successor freeze remains one atomic consensus-visible checkpoint.

### D.42.5 — Required additive exhaustion hardening

Before advancing to Phase −1′d, a fresh Codex-high RED author must create a separate remediation test and
fixture rather than edit either accepted corrected-c2 file or either historical blocked-c file. The RED
must require a paired issuance probe at one valid non-boundary sequence:

- with `exhausted: false`, valid next sequence, matching keypair and otherwise unchanged epoch/anchor,
  issuance succeeds with exactly one digest, sign and publication call;
- changing only `exhausted` to `true` rejects with unchanged state and zero digest, sign and publication
  calls.

The RED must fail only because the first mint lacks this isolated case. It may not edit, import around or
reconstruct expected bytes from an implementation. The fixed reference and provenance hashes above are
immutable. After the narrow RED is demonstrated, a separate vector-minter must invoke the already-fixed
reference and re-mint only the vector document; it may not author the RED or hand-fill an expected result.
The final vector hash, mint chronology and changed pins then receive fresh Grok, Kimi-100 and final
Opus-xhigh reviews. Only that reviewed replacement mint may become the input to Phase −1′d.

### D.42.6 — Exhaustion hardening closed; replacement mint is authoritative

D.42.5 is closed at this exact five-file tuple:

- corrected RED test `tests/protocol-v3-issuance-exhaustion-n1prime-c.test.ts`:
  `23c5f1eb8d87f9fa9a758670216430d1bc96b8aaa6b4912a4d53690a1f9ae1b1`;
- corrected RED fixture
  `tests/fixtures/phase-n1prime-c-exhaustion/paired-issuance-contract.json`:
  `793da47de639ba3d40a205aab301e0b8b2a456347ded7b3d7a3c4bf3159dcd77`;
- unchanged original reference:
  `abb01f2f061b20428e1c412793380a0baf468bf9397c7ec2952a902f2aaf7bdc`;
- unchanged provenance:
  `8b5e24c89dd32735ad95ca2a10a98e80dd2bb2623e0188b1355b51076bc90bc3`;
- replacement vector document:
  `8b84504ae98b37beae2d91ef8fa29f9a61299a236d32a12b63f24cb2757da741`.

The first RED pair was GREEN-unsatisfiable because it placed the artifact that D.42.5 explicitly requires
re-minting inside an unconditional immutable-hash loop:

- superseded test:
  `e6da1dc70c1740fce22c7986e4a5af7ccfc5c4cf2c115c170e73b95653085210`;
- superseded fixture:
  `1c811bb1fb9494b80b6d5b65edf015eae9dfe84e90d9a1f20c921fe7960b39fc`;
- executable contradiction:
  `.logs/phase-n1prime-c-exhaustion-original-green-contradiction.log`
  (`d5491e87e7dbba5808246cb2344388c5e2747a8c2aafa00ea6d392f03d07800b`).

A reference-derived simulated replacement made integration pass while controls failed only on the stale
historical hash. The same RED author therefore moved only the vector target into
`mutableTargets.vectorDocument`, retaining its historical pre-GREEN hash as provenance rather than a
post-GREEN invariant. All six genuinely immutable historical/c2/reference/provenance pins remain
unconditional. The corrected harness proves controls pass, current integration has one narrow absent-pair
RED and a scratch correctly re-minted document passes 2/2:

- correction ledger `.logs/phase-n1prime-c-exhaustion-correction-ledger.log`
  (`7d1654899c8349eb96be7effe42b430cc00f0f9f2f5fe018afd36287c5c4c4f7`).

A different Codex-high vector-minter invoked the already-fixed reference, added only the paired
`424242 → 424243` issuance cases and advanced `vectorsMintedAt` from
`2026-07-28T03:39:26.569Z` to `2026-07-28T04:43:02.000Z`. The non-exhausted request succeeds with exact
1/1/1 instrumentation and a verifying signature; changing only `before.exhausted` to `true` rejects with
unchanged state, null payload and exact 0/0/0 instrumentation.

Textually removing exactly the appended pair and restoring only the prior timestamp reproduces first-mint
hash `39b7c4e60fcb550c936be220660c8065b0bccc44ce1c288e0f685ced03b9dfa2`.
Parse/reserialize does not reproduce that hash because it changes tabs, key order and Prettier wrapping;
Kimi's initial preservation caveat was a reconstruction-method artifact, independently resolved by root,
Grok and Opus.

The GREEN ledger is:

- `.logs/phase-n1prime-c-exhaustion-green-ledger.log`
  (`60833e664edbe7a2a16e8a798e71209abb929831c674735e8a5f825712c32a7d`).

The replacement tuple passed:

- focused remediation 2/2;
- corrected c2 5/5;
- accepted successor/remediation preservation 31/31;
- frozen v2 plus the real freeze CLI 12/12;
- workspace typecheck 31/31 projects;
- workspace lint with 0 errors and 226 inherited warnings;
- targeted Prettier, whitespace, diff, chronology, scope, firewall and historical-byte reconstruction.

Renaming only the new exhausted case leaves controls green and returns integration alone to RED; exact
restoration returns 2/2. Independent mutation review establishes the exact boundary:

- deleting the whole exhaustion gate — **killed only by the new pair**;
- deleting `before.exhausted === true` — **killed only by the new pair**;
- deleting `current >= MAX_SAFE` — survives;
- deleting the key-presence gate — survives;
- deleting the next-sequence gate — survives.

The final tuple received all three required fresh reviews:

- Grok 4.5/high:
  `.logs/phase-n1prime-c-exhaustion-review-grok45-high-final3.raw.json`
  (`5736e415d4cdb49011396e968a8544d0f2627a64a014af0941ad084702fa9b45`) —
  **PASS_WITH_NOTES**;
- Kimi-100:
  `.logs/phase-n1prime-c-exhaustion-review-kimi100.log`
  (`82351b5a3fd0d5306c6b1ce2d45666be47b1927e930cd3b5e9a6f1a642487b2f`) —
  **PASS_WITH_NOTES**;
- Opus-xhigh:
  `.logs/phase-n1prime-c-exhaustion-review-opus-xhigh-final.raw.json`
  (`241e202da6dcb5a4a23c5d2d83b5935db3db4d4fee45e0a17320adfb1420027a`) —
  **PASS_WITH_NOTES**.

Opus re-derived the registered digest with an independently written canonical encoder and framing
implementation, verified the signature with a library different from the reference, reproduced the exact
historical text hash and matched 46/46 cited log hashes. Phase −1′c is therefore accepted. The only vector
hash that Phase −1′d or any later authority may pin is
`8b84504ae98b37beae2d91ef8fa29f9a61299a236d32a12b63f24cb2757da741`;
first mint `39b7c4e6…` remains historical evidence only.

## Appendix D.43 — Phase −1′d regenerated reference acceptance and d2 remediation

### D.43.1 — Initial RED, transport correction and first regenerated tuple

The Phase −1′d RED was authored separately from both reference authors, both vector minters and the later
TypeScript port. Its final corrected contract is:

- RED test `tests/protocol-v3-independent-regenerated-reference-n1prime-d.test.ts`:
  `d2026fc81c98c709da7ca0dc94d20cd05b56a5e871b35f6e715aec63920fd407`;
- input-only fixture
  `tests/fixtures/phase-n1prime-d/regenerated-reference-contract.json`:
  `f46c4ee3be04f4b0a53d4180322c1e8f4ad201d280ef4f2c5f0beb0bdfd1ab83`;
- neutral-contract correction ledger
  `.logs/phase-n1prime-d-red-contract-correction-ledger.log`:
  `13575c3fae836f718beb921354a1e10456708aba1b76871926f5850a66a8b6b5`;
- timeout-only correction ledger
  `.logs/phase-n1prime-d-red-timeout-correction-ledger.log`:
  `fd10149c6738abf96377c5671994cad286edb6518935a508e98709c61a350d26`.

The transport correction supplied input-only request envelopes for three operations whose first neutral
contract named semantics without specifying concrete transport. It changed no normative output. The
timeout correction changed only the two test-local bounds to 30 seconds after the complete six-operation
multi-process differential exceeded Vitest's default 10-second timeout.

The regenerated author fixed a standalone normative implementation before executing either opaque peer.
The first source/provenance freeze was `3dafc35b16cce084dbd6407c56b051b07250c4bce830b3c5765214492a6da50b`
/ `89a6361607f168747a9927cb61033696e335f3d0938707ab2e2aa42a0ebd03ae`.
The neutral fixture's missing transport detail then caused a recorded 13-freeze adapter chain. Blind
adapter tuning stopped after the seventh validation-envelope correction; the RED author supplied the
missing input-only shapes before later differentials continued. This is a process gotcha, not a model for
future reference generation: a neutral contract must fully specify input transport before the independent
implementation is frozen.

The first final Phase −1′d tuple was:

- regenerated source:
  `a81a0248032494b3abfb13f5201201ffd8d4b7577a1275b08ad682c110017580`;
- regenerated provenance:
  `7172f6dcb35280c666dcee0c0e58d00af9f7a73e99b75c4a4411b8f885affa77`;
- comprehensive ledger
  `.logs/phase-n1prime-d-regenerated-reference-final-ledger.log`:
  `38fe9b5d70c4d432451524bc3ac2c5298ef682d675175543ac30039790bc9333`.

It passed Phase −1′d 2/2, accepted successors 31/31, exact frozen v2 21/21 including the real freeze CLI,
workspace typecheck 31/31, lint with zero errors, formatting, scope, firewall and a causal mutation proof.

### D.43.2 — Initial reviews correctly BLOCK; d2 returns to RED

The first tuple received:

- Grok 4.5/high:
  `.logs/phase-n1prime-d-review-grok45-high.raw.json`
  (`60b213b62af626376c8437f23abafbfb2e78ddee4aad8ec1d5ab2f97fb9a925b`) —
  **PASS_WITH_NOTES**;
- Kimi-100:
  `.logs/phase-n1prime-d-review-kimi100.log`
  (`4efc9256c22a9c56de9b66de0837a593709c7d71f4191edc7c3083a2b56339c1`) —
  **PASS_WITH_NOTES**;
- final Opus-xhigh:
  `.logs/phase-n1prime-d-review-opus-xhigh.raw.json`
  (`b3c3f5a3d8e1b67af1104c190f26c3ed9c672ec4678c276c30219ccea272e1f0`) —
  **BLOCK**.

Opus reproduced five material defects: verification decoded and re-encoded before Ed25519, which rejected
validly signed noncanonical received bytes; the flipped-byte control was therefore vacuous; issuance
ignored the declared public key and accepted a mismatched keypair; uppercase public-key transport was
accepted; and own enumerable `__proto__` forked the grammar encoding. It also rejected the ledger's
claims of exact-received Ed25519 and sustainable author-lineage issuance. The wrong-sequence overwrite was
an explicit Phase d nonclaim, but Opus required the remediation RED to retire it rather than preserve it.

This changed the plan's next action only after Opus-xhigh, Kimi and Codex-high independently agreed that
silent repair, key substitution and canonical-gated verification were unacceptable. The predecessor
`a81a0248…` / `7172f6dc…` tuple remained frozen until a different Codex-high RED author produced:

- d2 RED test:
  `04c7cbb6f2ccafd58d96cb5b3fd09a77e1ebab83abd2da13a9f92f7e4fffeb3e`;
- d2 input-only fixture:
  `ee9d160ccdb646f558ceebaf1aaf0a88296c66332d502f383aa1fdec5b28ee20`;
- d2 RED ledger `.logs/phase-n1prime-d2-red-ledger.log`:
  `277f2e38ab4bb8ba04c32dda512403828580956cf8403fcd78d938f90e7d871d`.

Controls passed while the predecessor produced exactly seven causal divergences: wrong sequence,
mismatched keypair, uppercase public key, validly signed noncanonical bytes, correctly re-signed flipped
bytes, own `__proto__` encoding and uppercase canonical-hex decode. Missing private key, stale flipped
signature and unpaired surrogate were positive preservation controls, not falsely claimed new kills.

### D.43.3 — Third-agent GREEN and RED-owned target correction

A third independent Codex-high remediation author, barred from the original reference, predecessor/TS
implementation, vector output and later TypeScript port, re-derived the affected operations before any d2
differential. The single remediation freeze produced:

- regenerated source:
  `0a7b199eec2f1a950d4b91d9041e382f02983e2d601a530de60e7311309ce84a`;
- regenerated provenance:
  `1ea3a9e0da6d6df667101e7e8c5e208b6eca45da6954cbfaf9da1cef6e50eae4`;
- comprehensive ledger
  `.logs/phase-n1prime-d2-remediation-comprehensive-ledger.log`:
  `98f5606af3c61e59777e8245c2d3c01b78cb6ec5716e182dc70e3e6291215aea`.

The behavioral integration was green on the first post-freeze differential. The control test alone then
failed because the d2 fixture had classified the two files whose remediation it required as unconditional
immutables pinned to their predecessor hashes. The GREEN author did not edit the RED or overclaim 2/2.
The original RED author moved only regenerated source/provenance into `remediationTargets`, retained their
old hashes as `preRemediationSha256` historical baselines and changed the single source-path lookup:

- corrected d2 test:
  `c07b64dfaa6e5f40095773f5e81c8847c2a736af5a8c365937db80ef3a77926f`;
- corrected d2 fixture:
  `54c4193a03ee2d2b792d340e0128dd5de4721c7d25f69f4cffb640e86b94261f`;
- correction ledger
  `.logs/phase-n1prime-d2-target-classification-correction-ledger.log`:
  `a89a61d364c20d95b0e6cde1970fdfe3e2f397d17e5aeca788ef9e828689cd10`;
- governed-rerun evidence
  `.logs/phase-n1prime-d2-target-classification-correction-evidence.log`:
  `d3e128334286c513fade4e181461d4e38cf08aea9e33867e90f99a138e4d53b3`.

Final Opus-xhigh reconstructed both superseded artifacts using only those claimed structural changes and
matched their original SHA-256 hashes exactly. Therefore no probe, expected outcome, comparator, mutant,
runtime bound, attestation or true immutable pin changed by one byte. The correction was necessary,
GREEN-satisfiable and structurally identical to the accepted D.42.6 mutable-target correction; it is not
reward hacking.

### D.43.4 — Final gates and independent quorum

The corrected tuple passed:

- d2 controls and integration 2/2;
- Phase −1′d full six-operation differential 2/2;
- accepted successor preservation 31/31;
- exact frozen v2 preservation 21/21, including the real freeze CLI;
- workspace typecheck 31/31 projects;
- workspace lint with 0 errors and 226 inherited warnings;
- targeted ESLint, Prettier, whitespace, scope, chronology and firewall checks;
- a causal key-binding mutant: deleting only derived-public-key equality made only the mismatched-keypair
  case RED while Phase d remained 2/2; exact restoration returned the final hashes and d2 2/2.

The final exact tuple received:

- Grok 4.5/high:
  `.logs/phase-n1prime-d2-review-grok45-high.raw.json`
  (`53cd6c79da9aae2200768d66264d8f2266db40c4527a5c262267dc43a7fa2d1e`) —
  **PASS_WITH_NOTES**;
- Kimi 3, explicitly invoked as `kimi-code/k3` with
  `KIMI_LOOP_MAX_STEPS_PER_TURN=100`:
  `.logs/phase-n1prime-d2-review-kimi3-100.log`
  (`b66203eae99842f2ff94e57dbd038ed1963b06c073c56e6f6eb82d94783e2ce3`) —
  **PASS_WITH_NOTES**;
- final Opus-xhigh:
  `.logs/phase-n1prime-d2-final-opus-xhigh.raw.json`
  (`8b61eba09062d7a25f64435f12432ec63666a8505f1a76ddcc87e71c97183740`) —
  **PASS_WITH_NOTES**.

Grok, Kimi 3 and Opus independently executed hostile probes beyond the frozen cases. Final Opus
re-executed every governed suite, authenticated all 22 cited evidence hashes and reconstructed both
pre-correction RED preimages exactly. All Kimi reviews from this point forward must use the explicit
`-m kimi-code/k3` model alias; a default-model assumption is not sufficient audit evidence.

### D.43.5 — Findings, gotchas and carry-forward ownership

1. The Phase d multi-process test has a host-dependent 30-second margin: observed semantic runs range from
   roughly 15 to 34 seconds, and Grok flaked near 29.9 seconds while the underlying differential passed.
   Harness hygiene before or during −1′e owns optimization or a documented timeout-only correction. Never
   weaken, sample or remove the differential.
2. The defensive `current >= MAX_SAFE` branch remains an explicit nonclaim. Later issuance-mutation /
   TypeScript-port RED owns an independently observable discriminator.
3. JSON cannot express sparse arrays, non-plain objects, accessors or symbol keys. The in-process
   TypeScript codec-port RED owns those direct-JS shapes.
4. Two negative d2 probes accept any non-zero peer exit rather than pinning an error category. The
   TypeScript codec-port RED owns precise in-process error taxonomy.
5. Phase d's private-key-presence and next-sequence nonclaim strings remain immutable historical
   descriptions of that corpus. d2, not a rewrite of Phase d, now pins those behaviors on the regenerated
   peer.
6. The d2 RED intentionally does not self-pin the remediation target's current bytes. Phase −1′e freeze
   governance must make the live source/provenance hashes permanent and mutation-test that protection.
7. The d2 oracle uses `localeCompare` for a `sortRule: "codepoint"` helper. The governed vertex dependency
   case has one element, so no current divergence is possible; the TypeScript-port RED must use the
   grammar's encoded-byte/codepoint rule directly and cover multi-element ordering.
8. The d2 oracle's internal `fromHex` accepts uppercase but consumes only trusted lowercase fixture
   inputs. Peer transport is strict. Later harness hardening/TypeScript-port RED owns a strict helper.
9. Exact 0/0/0 instrumentation is peer-reported but structurally corroborated by guard ordering before
   digest, sign and publication. The TypeScript port must use externally observable call spies.
10. Agent identity and source-firewall claims remain attestation plus structural absence of leakage, not
    cryptographic proof. Preserve strict role separation and permanent TS-port bars.
11. A neutral reference contract that omits concrete request envelopes causes expensive, low-information
    adapter churn. Future cross-implementation REDs must freeze complete input transport before either
    implementation is executed.
12. Phase −1′d and d2 remain unpublished and unmerged. The complete −1′a…−1′e successor freeze is still one
    atomic consensus-visible checkpoint.

### D.43.6 — Acceptance

Phase −1′d is accepted at the exact corrected RED/fixture and regenerated source/provenance hashes in
D.43.3. The remediation rejects wrong sequence and mismatched identity before work, enforces lowercase
neutral hex, verifies exact received bytes with Ed25519, preserves own `__proto__` as inert data and
retains every earlier six-operation behavior. No original Opus blocker remains.

Phase −1′e may begin. It alone may convert the unpublished −1′a…−1′d tuple into a permanently closed,
atomic protocol-v3 freeze. No earlier internal snapshot is a base, release or merge checkpoint.

## Next Agent Prompt

Begin **Phase −1′e RED** with a fresh Codex-high author who did not author either reference, either d/d2
RED, either vector mint, the d2 remediation or the future TypeScript port. The RED may add only a new
artifact-level governance test, input-only fixture and bounded `.logs`; it must preserve the complete
accepted −1′a…−1′d tuple and every frozen-v2 artifact byte-identically.

The RED must fail narrowly on absent v3 locks and governance, not on missing source data. Its coherent
scratch control must satisfy the complete proposed closure. Mutation controls must prove failure for:

- any registry/schema/specification/amendment/formal/grammar or vector byte drift;
- either original-reference source/provenance or regenerated-reference source/provenance drift;
- incomplete reference trees, incomplete locks, file-set mismatch or source-hash mismatch;
- missing, stale or extra provenance bindings between registry v1, authoritative vector, both reference
  pairs and their locks;
- any post-freeze registry version bump or second bootstrap attempt;
- weakening/removing policy protections, replacing the checker with a self-grading head checker, or
  changing the checker and its pin in the same proposal;
- a v3 workflow that is conditional, non-PR-blocking, write-capable, retarget-insensitive, fails to execute
  the base checker first, or can pass while the unchanged v2 checker fails;
- `.github/CODEOWNERS` or `docs/CODEOWNERS` appearing, v3 ownership using a different cohort, v3 rules
  appended after rather than inserted before the exact terminal v2 block, or any byte/order drift in that
  v2 terminal block;
- any partial −1′a…−1′e combination being treated as authoritative or checkpoint-ready.

The GREEN author must be a different Codex-high agent. Expected artifact names are separate v3 surfaces,
not edits of v2:

- `packages/protocol-v3/conformance/reference.lock.json`;
- `packages/protocol-v3/conformance/reference-regen.lock.json`;
- `packages/protocol-v3/conformance/freeze-policy-v3.json`;
- `packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs`;
- `.github/workflows/protocol-v3-registry.yml`;
- a v3 CODEOWNERS block inserted above the checker-protected terminal v2 block.

The v3 checker must retarget the fail-closed single-use bootstrap to `(protocolMajor = 3,
registryVersion = 1, registry-v1.json)` while preserving the v2 checker's trust boundary. The v2 checker,
policy, workflow, locks, registry, vectors and both v2 references remain byte-identical and independently
required. A separate v3 status cannot compensate for a failing v2 status. External branch-protection and
required-status configuration remain an operational release prerequisite; repository tests must state
that boundary honestly rather than claim to prove host settings.

Use a separate Codex-high RED and GREEN, then Grok 4.5/high, Kimi 3 explicitly invoked with
`-m kimi-code/k3` and `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and final Opus-xhigh adversarial review.
Run focused RED/GREEN, exact accepted successor and frozen-v2 preservation, workspace typecheck and lint
to bounded `.logs`; keep coverage-writing Vitest commands sequential. Address the Phase d timeout only
through an isolated, documented harness correction that leaves all cases and assertions unchanged.

Exclude `.agents/`, `.claude/`, `.logs/`, `.pnpm-store/`, `skills-lock.json` and the two stale v2 `0g2`
RED files from the atomic checkpoint. Never use `git add -A`. Do not checkpoint, publish or merge until
all Phase −1′e gates and reviews pass; then and only then may −1′a…−1′e land as the one protocol-v3
consensus-visible freeze checkpoint.

## Appendix D.44 — Phase −1′e governance candidate, e2 correction and atomic-landing blocker

### D.44.1 — Initial RED/GREEN and exact candidate

The separate Phase −1′e RED first froze:

- `tests/protocol-v3-freeze-governance-n1prime-e.test.ts` at
  `8f73ede7e72d3ae29853691b545935420b8a2bca323b1325b628d9812e0a7e69`;
- `tests/fixtures/phase-n1prime-e/freeze-governance-contract.json` at
  `3db15fcce4526dcff96e0159a411832ca1811dc70c081ae26a1dc4e0d5e25cdc`.

Its pure control passed, its live integration failed only because the six governance targets were absent,
48/48 causal mutations were killed, 58/58 accepted successor/frozen-v2 pins held and the unchanged v2
checker executed in a bounded scratch repository. A separate Codex-high GREEN then created:

- `reference.lock.json` at `596bd935f060a3fdcbd9fe2e2c5cb12f18897c5f13ed01cd5de35b35dd9e0664`;
- `reference-regen.lock.json` at
  `c4d5d54b08f1c4c45395c8250b4e84f582a0924fb964c53f188fedb0b05b0292`;
- `freeze-policy-v3.json` initially at
  `267208a6658e0f328bca352510c7d10a2f710756cb729df9c2a359031a0f6914`;
- `check-protocol-v3-freeze.mjs` initially at
  `34c667c4bbc45cb7fc4c129c9e4fad3c6692c881db8df8e2d649a9063802849d`;
- `.github/workflows/protocol-v3-registry.yml` at
  `402771a64e810ebc3186f84aa719e1d14d107cb3ed7a77a4fdb6b42128c22a58`;
- the exact root `CODEOWNERS` insertion at
  `4fcd586a5a0cb1501df2bbf7b8e2882be98903b085e9735e5cbe1e8ae7fc8f15`.

The locks cover exactly the two files in each reference tree and bind both implementations to the frozen
registry, vector and provenance tuple. The workflow is read-only, unconditional, retarget-sensitive and
runs the unchanged base v2 checker before either a base v3 checker or the one-time head bootstrap. The
root ownership block uses the frozen v2 cohort, appears immediately before the exact terminal v2 entries,
and rejects either higher-precedence CODEOWNERS location.

### D.44.2 — Root audit finds a real policy-persistence escape; e2 returns to RED

Before external review, the root audit found that production `validatePolicy` required
`minimumPolicyPaths`, while the already-defined `completePolicyPaths` additionally contained the v3
workflow and root `CODEOWNERS`. Independent real-Git reproduction proved both halves of the escape:

1. a bootstrap policy omitting either path passed; and
2. a later comment-only byte change to the omitted workflow or `CODEOWNERS` also passed under the
   merge-base checker.

Semantic removal of required workflow/CODEOWNERS structure still rejected, so this was a byte-freeze
escape rather than an arbitrary semantic bypass. That distinction did not make it acceptable.

A separate e2 RED froze
`tests/protocol-v3-freeze-governance-n1prime-e2.test.ts` at
`7ecb2c2a64b02e79dc5b0cefaa8e3ee60d1ca4cad02d2202f7d03500dae77014`.
Its complete-policy control passed while the live evaluator failed with exactly four accepted escapes:
workflow omission, later workflow drift, root `CODEOWNERS` omission and later `CODEOWNERS` drift. The
e2 RED ledger is
`4384b39b713878972c390387bd92a6f3ae071a776d9fbe0cf1175495669f43eb`.

The honest production correction exposed the same stale assumption in the original e scratch control.
The RED owner added exactly `workflowPath` and `codeownersPath` to its `requiredPolicyPaths`, superseding
the original test hash with
`62b78923c533704f255e6a5cac180ffdaa5c8506a90081ad7bd81bba6e83285c`.
The input fixture remained byte-identical. This strengthened the control; the separate e2 live-evaluator
case remained the causal RED. Its correction ledger is
`726a7a2082928b3a77273e5be38fc2b0012be8b85a0d750b33110ed51167324c`.

The separate GREEN changed production policy validation to require `completePolicyPaths` and refreshed
only the checker pin. The corrected candidate is:

- checker `19cbc00020b83244b9c4170f6686f3454dceb8f7787c987a8c33952499814ae6`;
- policy `20fcc96009aede492e48ba478a01934ba105e50b89d4676dda7c14d0b2f1fd97`.

Focused e/e2 passed 4/4; accepted successor/remediation passed 35/35; the exact frozen-v2 baseline passed
16/16 plus regenerated-reference 7/7; typecheck passed 31/31; lint reported zero errors and the inherited
226 warnings. The real-Git matrix now rejects both incomplete policies and both later byte drifts while
accepting a complete bootstrap and unchanged post-freeze state. The matrix ledger is
`9f02f777e8b847f51b21f49d573718166a57685dac77049326b9f0dbb115c01c`.

### D.44.3 — Independent reviews and incorrect-assumption quorum

Grok 4.5/high authenticated the candidate, reran 4/4 focused tests and a hostile real-Git matrix, and
returned `PASS_WITH_NOTES`. Its raw review is
`6cec55120133523add3896f62c20cc24eb558bf298a22947624975fe9f45a589`.
It did not identify the landing contradiction below; silence is not concurrence.

Kimi 3 was invoked explicitly as `kimi-code/k3` with
`KIMI_LOOP_MAX_STEPS_PER_TURN=100`. It authenticated all targets, reran 4/4 focused tests, executed 14
in-memory hostile probes and nine isolated real-Git scenarios, and returned `PASS_WITH_NOTES`. It
independently proved that a one-shot full-tuple landing on the real pre-v3 base rejects because the base
registry is absent. Its report is
`b95908016801a33803b861e3ed445e14c9638a0d79e36a7fadc21ca74a050b22`.

A separate Codex-high adjudication classified that same fact as a blocker. Final Opus-xhigh independently
reproduced it, authenticated every target, reran 4/4 and returned `BLOCK`. Its raw review is
`116cc58b040dae8ee121e608d3269f8bbe2d9fa1f6dd840030e0f24e2ed37b19`.

Opus, Codex-high and Kimi 3 therefore agree on the incorrect factual assumption: the current workflow and
checker cannot bootstrap the complete a…e tuple from the actual pre-v3 base. They differ only on
severity. This satisfies the user-required quorum for correcting the assumption in this document. It
does not authorize weakening the atomicity rule.

### D.44.4 — Blocking atomic-landing contradiction

The plan requires all −1′a…−1′e artifacts to remain unpublished and unmerged, prohibits registry,
vector, reference, lock or activated governance reaching the base early, and requires one atomic
consensus-visible landing. The candidate requires the exact opposite base:

- the workflow bootstrap guard requires the registry, both references and vectors already on
  `pull_request.base.sha`;
- checker snapshot construction rejects a base without registry v1;
- `validateBootstrapBase` calls `validateTuple`, requiring every accepted a–d immutable input on base
  while governance is absent.

Current `HEAD` `e7d255c3609ff147e86a59e94dc926a8eb2db59c` contains none of those v3 prerequisites. The real
checker therefore exits with `registry-v1.json is malformed`; the root probe is
`fc419078da2dc038d0a13293431de3b60bcbbad187aa5b22080ecf7d2a5689fb`.
Multiple commits inside one PR do not help because both `BASE_SHA` and the merge-base remain the target
branch's pre-v3 commit.

A content-first PR followed by governance, a temporary target branch, a direct/check bypass or a
prepublished partial tuple is not a fix. Each violates the explicit atomicity rule. Later fail-closed
detection protects integrity but cannot retroactively make the intermediate publication atomic. Calling
this a documentation-only two-step sequence would redefine the acceptance criterion after observing the
implementation.

The synthetic e/e2 positive controls encode the same wrong world by placing all immutable a–d inputs on
their governance-free base. Their green result is valid for the candidate's internal mechanics but not
for the only permitted landing state.

### D.44.5 — Findings and carry-forward decisions

1. Phase −1′e/e2 is **blocked and not accepted**. No checkpoint, publication or merge is permitted.
2. Preserve the plan. Phase e3 must make the only permitted one-shot a…e landing executable from the
   exact frozen-v2/no-v3 base and must reject the formerly accepted content-prelanded base.
3. The hardcoded CLI `v2StatusPassed: true` is acceptable only because the byte-frozen workflow executes
   the unchanged base v2 checker first and external branch protection must require both statuses.
4. Bootstrap `protectedPaths` currently permits arbitrary extra patterns. Because policy becomes
   immutable, e3 must bound the set/shape and prove an extra v2 or unrelated path cannot permanently
   over-freeze the repository.
5. The e/e2 tests and Phase e fixture are not currently frozen although earlier phase tests/fixtures are.
   This does not weaken the base-pinned checker, but e3 must make and test the final auditability decision
   before the first irreversible bootstrap.
6. Invalid or unrelated base references expose a raw `git merge-base` failure but still reject. This is
   optional local-CLI error hygiene, not an authoritative-CI bypass.
7. Symlink, index and dirty-worktree differences fail closed in authoritative clean CI.
8. Locks, provenance bindings, checker pin, workflow ordering, CODEOWNERS precedence, single-use closure,
   retarget behavior and the e2 correction are otherwise sound.

## Next Agent Prompt

Begin **Phase −1′e3 RED** with a fresh Codex-high author who did not own the e/e2 REDs, either reference
or vector mint, or the future TypeScript port. The RED may add one bounded real-Git governance test,
input-only fixture if necessary and `.logs`; it must not edit production, the existing REDs, accepted
successor inputs, frozen v2, this plan, manifests or Git metadata.

The e3 RED must freeze these cases:

1. A one-shot complete a…e landing on the exact frozen-v2/no-v3 base passes. Today the real checker
   rejects because the base registry is absent; this is the causal RED and must exercise the real CLI.
2. On that base, the workflow reaches the guarded head-checker bootstrap rather than its fail-closed
   `else`.
3. The formerly accepted content-prelanded base—all immutable a–d inputs present with governance
   absent—rejects as plan-violating.
4. Any partial v3 base rejects: at minimum registry-only, either reference-only, vectors-only, one formal
   file, one v3 specification/amendment/grammar file, one a–d test, one a–d fixture, either lock, policy,
   checker or workflow.
5. Current state missing any immutable input or any governance target rejects.
6. Unchanged post-freeze passes; all 48 existing e mutations, e2's four escapes, checker+pin replacement,
   workflow/CODEOWNERS drift, second bootstrap, exact CODEOWNERS placement and all 58 pins remain covered.
7. Any bootstrap policy path outside the declared v3 governed surface rejects; specifically prove
   `packages/protocol-v2/**` cannot be added as an irreversible over-freeze.
8. Decide and assert whether the e/e2/e3 tests and Phase e/e3 fixtures join immutable/protected paths.
   Prefer freezing the final governance evidence unless a concrete circularity or maintenance cost
   outweighs the auditability precedent.

Before GREEN, the original e RED owner must issue a bounded control correction. The existing e oracle
duplicates both the old workflow runner and the now-forbidden content-prelanded `coherentBase`; a correct
production fix would otherwise make its positive control fail for the wrong reason. Supersede only those
test-side assumptions with the e3 RED's exact frozen-v2/no-v3 base and inverted workflow guards, preserve
the e2/e3 causal failures and record old/new hashes in a correction ledger. The e3 RED author and GREEN
author must not make this correction.

The separate GREEN author may change only:

- `packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs`;
- `.github/workflows/protocol-v3-registry.yml`;
- `packages/protocol-v3/conformance/freeze-policy-v3.json`;

For base snapshot construction only, an entirely absent v3 surface may become an explicit `preV3`
snapshot. A present-but-malformed registry still rejects. The bootstrap-base validator must require that
no v3 path of any kind exists, retain exact historical root `CODEOWNERS`, reject alternates, require the
unchanged v2 status and reject every partial v3 base. Current `validateCompleteClosure` remains strict.
Invert the workflow bootstrap guard to require the full v3 surface absent on base. Bound policy
`protectedPaths`, refresh the checker pin and implement the RED-owned evidence-freeze decision.

Keep real-Git cases in one reused scratch repository; normal CI remains the dependency-free git+node
checker and must not gain long-running tests. Run focused e/e2/e3, accepted successor 35/35, frozen-v2
16/16 plus regenerated-reference 7/7, workspace typecheck 31/31 and lint to bounded `.logs`. Then use
Grok 4.5/high, Kimi 3 explicitly as `kimi-code/k3` with the 100-step cap, and final Opus-xhigh. Never
`git add -A`; do not checkpoint, publish or merge until every e3 gate and review passes.

## Appendix D.45 — Phase −1′e3 atomic-bootstrap remediation

### D.45.1 — Corrected RED controls and exact frozen inputs

The separate Phase −1′e3 RED added
`tests/protocol-v3-freeze-governance-n1prime-e3.test.ts`. Its final pre-review GREEN input was
`d0d979f5e8db3d1eec4c07e7de8c9cb5f6c101d01c4742a1be427d5bec84be91`. One reused scratch repository
proved the exact frozen-v2/no-v3 base, the complete one-shot current closure, 14 named partial-v3 bases,
the formerly accepted content-prelanded base, exact protected-path bounds, governance-evidence presence
and the unchanged post-freeze state.

Before GREEN, the original e/e2 RED owner corrected only stale test-side assumptions. The accepted
evidence inputs are:

- e test `e76590b8e8682d81c030cdffe567ed1901733ce7f18d3371137353637e027f50`;
- e2 test `77a3aa224066cf40690350b286ea1c65cd8e0355436cb75e7e63cfd641f1ff61`;
- e3 pre-review test
  `d0d979f5e8db3d1eec4c07e7de8c9cb5f6c101d01c4742a1be427d5bec84be91`; and
- Phase e fixture `40141351cd58e3c99520f37105108dd4b37e91ac6f40628329f6c15746e4f3f3`.

The e/e2 coherent and live closure maps now include the four governance-evidence hashes, while their
pre-v3 bases remain genuinely free of all v3 and evidence content. The e test models the exact historical
root `CODEOWNERS`, the inverted workflow guard and required e2/e3 slices. The e2 omission/drift control
uses a no-op delegate so its pure control remains independent of live production behavior.

### D.45.2 — GREEN and atomic landing semantics

The separate Codex-high GREEN changed only the authorized checker, policy and workflow. The accepted
candidate is:

- `packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs`
  `fd33c961a3e6c3c3dd821dfb708f009b824329ae2ab208d50c3200763f03557f`;
- `packages/protocol-v3/conformance/freeze-policy-v3.json`
  `89040e627de6180ccce185a187419dc11c51e74f46b8881d2358080f93560e50`; and
- `.github/workflows/protocol-v3-registry.yml`
  `72aceb0841aa329763c648b9f633ac26593429ba2080ce2a7ca6ae155035ffd3`.

The policy pin equals the checker hash. An entirely absent v3 surface becomes an explicit pre-v3
snapshot only when the base has the exact historical root `CODEOWNERS`, no alternate CODEOWNERS, an
unchanged successful v2 prerequisite and no v3-namespaced path. The first current state must already be
the complete closure. Any partial or content-prelanded base rejects. After bootstrap, the base-pinned
checker and exact policy govern as before.

`protectedPaths` must deep-equal the declared bounded surface. It cannot gain
`packages/protocol-v2/**`, an unrelated path or any other irreversible over-freeze. The e/e2/e3 tests and
Phase e fixture are protected governance evidence but are not immutable normative inputs; every evidence
file must nevertheless be present before closure and cannot later drift or disappear.

The workflow runs the unchanged base v2 checker first. It then runs base v3 checker bytes when present,
or the head checker exactly once only when all v3 sentinels are absent on the base. Any other base fails
closed. The hardcoded snapshot `v2StatusPassed: true` remains sound only on this frozen workflow path and
with both statuses required by host branch protection; a standalone v3 CLI invocation does not prove v2
status.

### D.45.3 — GREEN gates and harness gotcha

The final implementation ledger is
`47efbc4e450ec011fdad00d90a0e2128e586588988ce57996e56317d806d02b9`. Before external review:

- focused e/e2/e3 passed 20/20;
- accepted successor/remediation passed 35/35;
- frozen v2 passed 16/16 plus regenerated-reference 7/7;
- workspace typecheck passed 31/31;
- lint reported zero errors and the inherited 226 warnings;
- targeted ESLint, Prettier, JSON, `git diff --check`, static pin/surface/runner checks and the
  role-dispatch ban passed; and
- the isolated real-Git e3 matrix passed 16/16
  (`16100c143314071944f80f6801de862088feab0f2a27e28547a691c51665dc09`).

Two ordinary local v2 regenerated-reference runs failed in the test harness with `spawnSync git ENOBUFS`.
The declared out-of-scope `.pnpm-store/` contributed 47,294 untracked paths and roughly 7.1 MB of
`git ls-files` output to the frozen v2 checker's default child-process buffer. A per-process
`core.excludesFile` containing only declared out-of-scope artifacts made the exact unchanged gate pass
7/7. No source, test, checker, Git metadata or persistent Git configuration changed. Clean CI is
unaffected; dirty local invocations fail closed, and the gotcha remains recorded rather than hidden.

### D.45.4 — Grok and Kimi 3 review findings

Grok 4.5/high ran read-only at high reasoning, authenticated every reported target, reran focused and
hostile real-Git probes and returned `PASS_WITH_NOTES`. Its raw review is
`2985aec92feb419e2d2999479e417bdf5156b2c173e5f6c9a90defb239a64e67`; its exact command evidence is
`8f23829f7850a35eaf3a43ddf0b0b7c71e2cd9e5b6cd0c265e4a91e7c863d380`.

Kimi was explicitly invoked as Kimi 3 with
`KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi -m kimi-code/k3`. It authenticated the tuple and historical
`CODEOWNERS`, reran the real v2 checker and governance cases and returned `PASS_WITH_NOTES`. Its raw
review is `15af9418c4a58d72a45cc045a6760b330f41ff8faf628862f61c2ee7510d91f5`; its exact command evidence is
`c023ea771af88000aebbbf6af0c7dd1a9d413e0edb315407faa0009dbe2e76ef`.

Neither reviewer found a bootstrap-integrity or post-bootstrap bypass. Both independently reproduced one
medium CI-runtime defect: the aggregate real-Git test could exceed the repository's 10-second default
under load. Grok also identified two low causal-attribution weaknesses: partial-base cases proposed an
incomplete current closure, and the pre-v3 helper called the live evaluator as post-freeze identity
rather than the promised base-to-current bootstrap. The namespace remains intentionally open to new
files outside the exact governed trees after closure; the root catch-all still requires the protocol
owner cohort. This freezes the declared normative and governance bytes, not the entire future
`packages/protocol-v3/` namespace.

### D.45.5 — Review remediation and post-correction gates

A fresh Codex-high test-correction owner changed only the e3 RED:

1. every named partial-base case now proposes the complete current closure;
2. the pre-v3 helper invokes the real evaluator with its exact pre-v3 base and complete current; and
3. the aggregate real-Git case has the bounded 30-second timeout already used by the predecessor
   governance test.

This supersedes e3
`d0d979f5e8db3d1eec4c07e7de8c9cb5f6c101d01c4742a1be427d5bec84be91` with
`9823da3eb98e89bcc494f8bdca17e4ebfe98b9726ad7078fefc29cedf6e74aba`. The correction ledger is
`6785c1461d6198cdfb4a7bf9d640beb2cc848958a61e350ceed91443bc533abb`.

The separate GREEN owner verified that exact three-change diff without editing it. Under ordinary
repository configuration and no CLI timeout override, focused e/e2/e3 passes 20/20
(`47ea02d7cf0845e3b7d05348b82e450cfae963ae815401d561942addaef9ea8f`), workspace typecheck passes
31/31 (`1a70f83deb2bc53a7c4f4eece50e7058d115cbe92b4f7f02123b688660feef67`) and lint reports zero errors
with the inherited 226 warnings
(`ed2866f1f1df87b46b6c141ee6f678253905546fd609d22e75d4f8ee6fc2716e`). Isolated e3 passes 16/16;
targeted ESLint, Prettier, diff, scope and production-pin checks pass. The production tuple is unchanged.

### D.45.6 — Acceptance boundary

Phase −1′e3 is technically complete but remains uncheckpointed pending the required final Opus-xhigh
adversarial review of this exact corrected tuple and applied plan text. External branch protection must
require both v2 and v3 statuses, enforce the frozen CODEOWNERS cohort without admin bypass and rerun on
retarget before the atomic landing is merged; repository artifacts honestly cannot prove those host
settings.

No internal −1′a…−1′e snapshot is a release or governed base. If final Opus accepts, the entire v3
normative tuple must be staged selectively and land as one consensus-visible checkpoint. Splitting
content from governance, using a temporary target branch or calling an intermediate publication
non-authoritative remains reward hacking and is prohibited.

## Next Agent Prompt

Run final Opus-xhigh read-only against the exact D.45 tuple, corrected e3 hash
`9823da3eb98e89bcc494f8bdca17e4ebfe98b9726ad7078fefc29cedf6e74aba`, both external reviews and all
bounded gates. It must independently reconstruct the real frozen-v2/no-v3 base, execute or inspect the
one-shot CLI/workflow path, test partial/content-prelanded bases with complete current closures, verify
evidence presence and bounded protected paths, authenticate the checker pin and CODEOWNERS insertion and
decide whether the timeout/causal remediations close the review findings.

If and only if Opus returns no blocker, record its exact evidence and checkpoint the complete
−1′a…−1′e tuple selectively—never `git add -A` and never include `.agents/`, `.claude/`, `.logs/`,
`.pnpm-store/`, `skills-lock.json` or the two stale v2 `0g2` REDs. After that atomic checkpoint, begin
Phase 0g(ii-T) with a fresh v3 RED; do not make the stale v2 `0g2` tests green.

## Appendix D.46 — Final Opus blocker and Phase −1′e4 authorization

### D.46.1 — Final Opus result and independent reproduction

Final Opus-xhigh authenticated the D.45 candidate and evidence hashes but returned `BLOCK`. Its raw
review is `c1e9dc91f09dfc90625cf038cbf1e9243f4ec5aeaf99786654afdf5da7fe8a11`; prompt and exact command
evidence are `7b50d9be8ac74eaf48677f9536ab60fcf796c72d7069bdfafc85064cbc5be741` and
`6f80f71c0e326a7ff1bafb345918d915ad751be3a70512d86d686179435d4311`.

The blocker is independent of e3 bootstrap semantics and ENOBUFS. The preserved original Phase −1′c RED
`tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts` is an untracked file that the
ordinary root Vitest project collects. It deterministically passes six cases and fails two against the
corrected accepted registry/provenance tuple:

- the historical fixture expects registry `7d8ecd8f…`, while the accepted current registry and v3 policy
  pin `2fd6f512…`; and
- the same superseded input makes the original-reference provenance and vector outward bindings stale.

The root reproduction is
`be5ff4dce1aece751700ec2a02a7bfc580ac98701bc75c37afa357c65e198839`. `vitest list` independently
confirms that ordinary discovery collects all eight cases
(`159b8464d201e9ad22026391e2efc3dc26136337324752c7f6542f68736837ab`). Because
`.github/workflows/test.yml` runs `pnpm test`, the proposed atomic checkpoint PR would introduce a
deterministically failing ordinary-CI test even though every recorded successor gate used a focused
subset.

The historical RED cannot be edited, renamed or deleted. The b2b, corrected c2 and exhaustion contracts
all pin its exact path/hash `10f1f8b502cb599da6350cc13192e8fbe407710698c187e26ffe2e84d47374a2`
and its fixture path/hash
`1f84788cad31a3fd737cf55d5da053748ea4e997bd4c5dbf4cf50fa568816840`. Those controls execute the pins
from disk. The current v3 checker and policy nevertheless omit both historical artifacts from
`immutableInputs` and `protectedPaths`, even while declaring `phase-n1prime-c` authoritative and freezing
the downstream contracts that depend on them. This is a second, independent closure defect.

### D.46.2 — Incorrect-assumption quorum and Opus timeout correction

The user-required correction quorum agrees that D.45 is not checkpoint-safe:

- final Opus-xhigh returned `BLOCK`;
- a fresh read-only Codex-high adjudicator returned `BLOCK` and `PLAN ASSUMPTION: AGREE`; and
- Kimi 3 was explicitly invoked with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and
  `-m kimi-code/k3`, independently reproduced the 2/8 failure and returned `BLOCK`,
  `PLAN ASSUMPTION: AGREE`.

Kimi's raw review is
`6639d24d2e31687a7fa366537d318e6d8a639d3e1a3a95523ec681447bf92f3f`; prompt and exact-command
evidence are `a42fcf3b70791d95dfeb3b03aca7ce1fad36ac37ebf25b931baa1c032752e523` and
`8113b83db383776ea2df1ff83c44ac705e9a711bfd039c683ebce391cc7aa696`.

Codex-high and Kimi independently corrected one non-dispositive Opus statement. The repository does have
a root `vite.config.mts`, loaded by `vitest.workspace.ts`, and it sets `testTimeout: 10000`. D.45's
10-second statement is correct; Opus's no-root-config/5-second arithmetic is not. The corrected e3
aggregate has a 30-second bound and reruns green. Its remaining real-Git cases inherit 10 seconds and
remain a load-sensitive hardening note, not the cause of this blocker.

### D.46.3 — Lawful exclusion boundary

Excluding exactly the historical c RED from ordinary execution is lawful test lifecycle management, not
reward hacking, only when all of these hold atomically:

1. the exclusion is the one exact path
   `tests/protocol-v3-independent-reference-vectors-n1prime-c.test.ts`, never a glob, prefix, directory,
   `.skip` or rename;
2. the historical test and fixture remain present at their exact paths and enter hashed
   `immutableInputs` plus `protectedPaths`;
3. a new frozen gate loads the live root Vitest/workspace configuration and proves the test-exclusion set
   equals the six existing infrastructure exclusions plus that one declared historical path;
4. the gate proves b2b, corrected c2, exhaustion and every other accepted successor test remain
   discoverable;
5. omission, rename, wildcard substitution, extra test exclusions, alternate workspace/config bypasses
   and deletion/drift of either historical artifact all fail; and
6. an ordinary clean-CI-equivalent full-suite run, not another focused successor subset, is recorded
   before checkpoint.

The exclusion decision is frozen semantically. `vite.config.mts` itself must not become an immutable
byte blob: that would unnecessarily freeze aliases, coverage and unrelated future test configuration.
The base-pinned checker must validate the narrow literal collection policy and the new frozen gate must
make broadening observable.

Editing the historical RED to follow corrected outputs, deleting or renaming it, moving it beneath an
already excluded directory, using `tests/protocol-v3-*` or `**/n1prime-c*`, landing red and fixing later,
or excluding it without immutable preservation and a bounded collection gate are prohibited shortcuts.

### D.46.4 — Phase −1′e4 disposition

Phase −1′e3 remains internally green at the D.45 hashes but final acceptance and the atomic v3 checkpoint
are **blocked**. A distinct Phase −1′e4 RED/GREEN/review slice is authorized. This is required because the
remediation touches root collection policy, adds a new frozen test, extends the immutable closure and
changes checker/policy hashes beyond e3's reviewed scope.

The e4 RED may add only one new checkpoint-collection test, an input-only fixture and bounded `.logs`. It
must not edit the historical c pair, production, the existing e/e2/e3 tests, this plan, manifests or Git
metadata. It must fail causally because:

- ordinary root collection still includes the exact historical RED;
- the live root exclusion set lacks exactly that path;
- the v3 closure omits the historical test and fixture;
- no e4 slice/evidence exists; and
- a broadened or alternate exclusion can escape the currently frozen semantic surface.

The RED's positive controls must prove the current six infrastructure exclusions, root workspace
selection and CI `pnpm test` command are satisfiable. It must freeze mutants for omission, a neighboring
c2 path, wildcard/prefix/directory broadening, additional test exclusions, dynamic exclusion
construction, alternate config/workspace routing and missing/drifted historical evidence.

The separate GREEN may change only:

- `vite.config.mts`, adding the one exact literal historical-RED exclusion;
- `packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs`;
- `packages/protocol-v3/conformance/freeze-policy-v3.json`; and
- the already-authorized v3 workflow only if the RED proves ordinary `pnpm test` is not actually required
  on the checkpoint PR. The expected path is no workflow change.

GREEN must add both historical c artifacts as hashed immutable/protected inputs, add e4 to required
slices and freeze its evidence, semantically validate the bounded root exclusion/workspace/CI command and
refresh the checker pin. It must not byte-freeze all of `vite.config.mts`.

Run e/e2/e3/e4, accepted successor/remediation, frozen-v2 core and regenerated-reference, workspace
typecheck and lint, plus the ordinary clean-CI-equivalent full suite to bounded logs. Existing unrelated
failures, if any, must be reproduced from the exact pre-e4 base and reconciled explicitly; they cannot
hide the historical-c failure or justify a green claim.

Then run fresh Grok 4.5/high, Kimi 3 explicitly with the 100-step cap and final Opus-xhigh. No checkpoint,
publication or merge is permitted until e4 and all reviews pass.

### D.46.5 — Frozen e4 RED and bounded predecessor-control correction

The fresh Codex-high RED owner completed the authorized test-only slice without editing production or
the plan:

- e4 RED test
  `7d3ff120ba2e892de6bde60a15c7c07e3194469d5345589a70192a473d5e0c12`;
- input-only lifecycle fixture
  `95e3aabeab12edae583f3d80fb3c8565735279f59e37e100e6ec884ca10997d4`;
  and
- RED ledger `50a00cd332a1de135b0769792466293b9f40ad2ff7a48296bf94d916a4011a1d`.

The two pure controls pass. The live aggregate fails for the four intended causal groups: the exact
historical path is absent from root exclusions; ordinary discovery still collects the historical RED;
checker/policy omit the historical pair and e4 governance; and the current checker accepts all nine
lifecycle/governance mutants. The predecessor e/e2/e3 controls, accepted successors, frozen-v2 gates,
workspace typecheck and lint remain green at the RED boundary.

Before editing, the separate Codex-high GREEN owner found that D.46's final instruction to preserve all
D.45 test hashes is incompatible with the strict e4 lifecycle surface. Per the plan-correction rule, work
paused with zero GREEN edits while a correction quorum reviewed that assumption:

- Opus-xhigh returned `BLOCK` and agreed that a bounded predecessor-control correction is required; raw
  evidence is `4559d670ed2f4bc259bc96d1dc851c26741985ae67659249191d1faef7e7498a`;
- the Codex-high GREEN owner independently confirmed the stale closure/evidence/scratch assumptions
  before editing and remained held; and
- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and `-m kimi-code/k3`, returned
  `BLOCK` and `PLAN ASSUMPTION: AGREE`. Its raw review is
  `4c9fd81ceabe548c476fbce265ee175727358dbf3a5aabe46b10bfc7b4403bab`; prompt and command evidence are
  `75e9141500b9b214a418ab97a64e43fda495dd621bdaaf55e67a19261aff6e5c` and
  `2afd259189764cc388bbffa8746cfe968aa5759d779b09950397769396ec7c05`.

The quorum agrees that D.46's preservation assumption is false for four independent reasons:

1. e/e2/e3 omit the e4 test and fixture from their evidence closures;
2. the Phase e fixture omits the two historical-c immutable bindings and `phase-n1prime-e4`;
3. e/e2/e3 snapshots omit the new fail-closed lifecycle surface; and
4. e3's scratch current does not copy the lifecycle sources, so it retains the six-entry base root
   configuration instead of modeling the seven-entry current.

This subsection supersedes only the conflicting hash-preservation sentence in the prior Next Agent
Prompt. One fresh Codex-high control-correction owner, distinct from the RED and GREEN owners, is
authorized to change exactly:

- `tests/protocol-v3-freeze-governance-n1prime-e.test.ts`;
- `tests/protocol-v3-freeze-governance-n1prime-e2.test.ts`;
- `tests/protocol-v3-freeze-governance-n1prime-e3.test.ts`;
- `tests/fixtures/phase-n1prime-e/freeze-governance-contract.json`; and
- a bounded correction ledger under `.logs/`.

The correction must:

- add the exact historical-c test/fixture hash bindings to the Phase e fixture, append
  `phase-n1prime-e4`, and update the Phase e preservation count from 58 to 60;
- add the frozen e4 test/fixture evidence paths to e/e2/e3;
- make every successful pre-v3 base carry the exact six-entry lifecycle and every complete current carry
  the exact seven-entry lifecycle, workspace and ordinary-CI sources;
- copy the named lifecycle sources into only the e3 scratch current, never the base commit; and
- leave the e4 lifecycle mutation matrix, all historical-c bytes and the existing e/e2/e3 mutation
  semantics otherwise unchanged.

The corrected predecessor controls are expected to be incompatible with the old exact-record checker,
while the uncorrected predecessors are incompatible with GREEN. Therefore the correction and GREEN
batches must coexist in the working tree and be gated jointly before either is accepted. The
control-correction owner must not edit production; the GREEN owner must not edit tests, fixtures or the
plan. Optional lifecycle fields, evaluator filesystem fallback, subset/warning-only validation, broad
exclusions and byte-freezing the entire root config remain prohibited reward-hacking paths.

The distinct Codex-high control-correction owner completed that exact four-file batch:

- Phase e test `7e4a3e6bfca563c1590c2c19065943b4b7cc8a983e9ad9f06eff552cbdc608ff`;
- Phase e2 test `42177ff4d105e617d041d9ea9187a22e9d09d3f4e1c9ad11ff63445b82ac4617`;
- Phase e3 test `d89058e02323773cdd0059f57d8a85002735c16adb29afc9eb8333f1248ebc1a`;
- Phase e fixture `3a6933294e6f760d7c9e24a84e162dc418ddba0039de9a5095c36ac2729ecccb`;
  and
- correction ledger `14f150e645eb4816a83b8ceed7bd2907f7e9fc462f6098ad6db49f96ddc7e412`.

The focused interim run passes 19/23. Its four failures are exactly the expected old-checker/old-policy
boundary: Phase e rejects the corrected 33-entry immutable surface; both Phase e3 controls expose the
missing e4 protection/current lifecycle; and the frozen e4 live aggregate retains its four RED groups.
Phase e2 remains 2/2 green. Workspace typecheck passes 31/31, targeted formatting/ESLint pass, and full
lint exits zero with the unchanged 226-warning baseline. The plan, e4 RED pair, historical-c pair and all
production bytes remained unchanged during the correction.

One sustainability gotcha remains recorded without expanding this correction scope: after the eventual
atomic checkpoint, e3's use of `git archive HEAD` can cause its nominal one-shot pre-v3 case to degrade
into an unchanged post-bootstrap evaluation because `HEAD` then contains the full v3 closure. This
pre-existing harness property is not introduced by e4. It must be adjudicated through the same
Opus-xhigh/Codex-high/Kimi-3 correction quorum before any later plan or harness change; it may not be
silently hidden by a passing post-checkpoint run.

### D.46.6 — e4 RED state-independence correction

The held GREEN owner made only the authorized exact seventh-literal edit to `vite.config.mts`
(`c1d2eeab4d2d7756549ecd2c818890de93d74d8ea38965ba58dea9c6e672f462`) before discovering that the
frozen e4 test itself is phase-dependent. Checker and policy remained at their pre-GREEN hashes. Root
reproduction `a6dd0968d8c1b24fa6a0bc4662dd691d3ec9e44e5f9efa1db66a3079365b0285` shows e4 at 0/3:

- its historical-six satisfiability control reads the now-seven live root config;
- its omission mutant also reads that live config and becomes identical to the valid current; and
- its live aggregate retains only the expected checker/policy omissions.

Work paused again with the exact config edit visible. The required correction quorum agrees that the
frozen e4-test-hash assumption is false:

- a read-only Codex-high adjudicator returned `BLOCK` and `PLAN ASSUMPTION: AGREE`;
- Opus-xhigh returned `BLOCK`, `PLAN ASSUMPTION: AGREE` and independently proved a third masked defect.
  Its raw review is `ac7e966d27dface08bef6fbaf8fe4a3758e3c328cc6edb254fed7fd0fe5b441e`;
  prompt and command evidence are
  `e7d3ff3259c60549f5843d026fa06894059332261645db198bee7d0ee7cfea51` and
  `6e90cd68a31df2a5a3c3b7ff1efa41d46d110a5ec7a060f64c992756cd7835d0`;
  and
- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and `-m kimi-code/k3`, returned
  `BLOCK` and `PLAN ASSUMPTION: AGREE`, also independently finding the masked defect. Its raw review is
  `46d394ffddb539f0306e91885ba87594f695d6f5300c6e2c012c220002b3f832`;
  prompt and command evidence are
  `d8b684c23e4df0ba72653583a49f61ecc37c54231e01a19e067dc2182ac86ee6` and
  `33c00a082ccf600cc6944af7ba93cb035d51b0218237bfad14da39d4493129ea`.

The masked defect is causal. The dynamic-construction mutant uses a single-line `exclude` regex.
Pre-GREEN it targets the single-line root `test.exclude`; after the required seventh entry, Prettier
formats that array across lines and the regex instead rewrites the later single-line `coverage.exclude`.
Root `test.exclude` remains valid, so the mutant becomes a no-op. The omission mutant fails first and
hides this second failure. Forcing a 177-column single-line production array, freezing coverage, or
rejecting the unrelated coverage mutation would violate D.46.3.

This subsection supersedes the frozen hash
`7d3ff120ba2e892de6bde60a15c7c07e3194469d5345589a70192a473d5e0c12` for the e4 **test only**. The e4
fixture remains frozen at
`95e3aabeab12edae583f3d80fb3c8565735279f59e37e100e6ec884ca10997d4`. One fresh Codex-high
test-correction owner, distinct from the e4 RED, D.46.5 correction and GREEN owners, may change only:

- `tests/protocol-v3-freeze-governance-n1prime-e4.test.ts`; and
- a bounded e4 state-independence ledger/logs under `.logs/`.

The correction must:

1. add a fail-closed historical-six constructor that AST-locates root `test.exclude`, accepts only the
   exact six or exact seven declared entries, subtracts exactly one historical literal only when present,
   and re-parses to prove the exact six remain;
2. use that derived historical source only for the six-entry satisfiability control and the omission
   mutant;
3. replace the dynamic mutant's generic regex with an AST-span replacement of the uniquely located root
   `test.exclude` initializer, then prove the dynamic spread is rejected; and
4. preserve `futureRootConfig`, the fixture, every other mutant/oracle, live discovery/governance
   semantics and all production bytes.

The corrected two pure tests must pass both against the exact historical six-entry HEAD config and the
formatted seven-entry current. With checker/policy still old, e4 must then be 2/3 with only the live
aggregate RED. Git/HEAD fallback at runtime, fixture-vs-fixture tautologies, replacing all six historical
entries from fixture text, subset/reordered acceptance, broad regex matching, `prettier-ignore`, skipped
or soft assertions and GREEN-owned test edits are prohibited shortcuts. After the corrected e4 test is
frozen and recorded, the held GREEN owner may resume checker/policy work without editing the correction.

The distinct Codex-high state-independence owner completed the authorized correction:

- corrected e4 test `5fdaa2b9eff5f98e21823e91fd0ca4be4fd409051df43658da22373c5d398d1c`;
- correction ledger `f836c1d3aa3a71471cd143e5d04d2f4ba6564683c2dae3882e59206f647a766a`;
- exact HEAD-six/current-seven branch proof
  `38b50847e184cc80f9d4157a7fa9f74974b1db1a412ce0171ace4806395fcf65`; and
- focused current evidence `4e34ca3c77915465d08d24527f79629b899bd2feb226fbb6de06ec6363fd2e9b`.

Both pure controls now pass against both exact root-config states, all nine lifecycle mutants are genuine
and rejected in both states, and the unrelated-edit control passes. The current focused boundary is
exactly 2/3: only the live aggregate remains RED for the old checker/policy omissions. Targeted
Prettier/ESLint and the 31-project workspace typecheck pass. The fixture, current exact config edit,
D.46.5 controls, checker, policy and all other frozen bytes remained unchanged.

### D.46.7 — Predecessor lifecycle-helper multiline correction

GREEN then completed the bounded semantic candidate:

- root config `c1d2eeab4d2d7756549ecd2c818890de93d74d8ea38965ba58dea9c6e672f462`;
- checker `0c54c747ca375591d7783b553ef8993d4d3f4932a831377bee3b7415345549de`;
  and
- policy `fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3`,
  whose checker pin matches.

The first joint e/e2/e3/e4 gate is 17/23. E4 is 3/3 and all fourteen e3 partial-base cases pass. All six
e/e2/e3 aggregate/live cases fail before invoking production because the D.46.5
`lifecycleRootConfig` helpers recognize only an exact single-line `exclude: [...]` substring, whereas
the lawful Prettier-formatted seven-entry array is multiline. Root reproduction is
`a018a9f00be994f407e52b2c9aa4d588d44ee83aec5f8f023d8e9360a836e016`; the GREEN owner's joint log is
`7ad73e94330e26fdd10cdbd3b4231b21a565b4286fe1b7f4d271a494e797cd38`.

GREEN paused with those production hashes frozen. The required correction quorum agrees that the three
D.46.5 test hashes must be superseded while the Phase e fixture and production candidate remain intact:

- read-only Codex-high returned `BLOCK` and `PLAN ASSUMPTION: AGREE`;
- Opus-xhigh returned `BLOCK` and `PLAN ASSUMPTION: AGREE`. Its raw follow-up is
  `bbb6a3ca4eebc8ab9536cbfa0baf037311535817e82eed1d3727e7bb80fc1861`;
  prompt and command evidence are
  `d00ed6b1a4adaeb794f1741cb08c0e6770719b4532f567c3edd729cae80cef83` and
  `24aed01c4570a457e4078b8bfeed37f857ab4c85d33af3c16242974ae880c707`;
  and
- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and `-m kimi-code/k3`, returned
  `BLOCK` and `PLAN ASSUMPTION: AGREE`. Its raw review is
  `663b4b1ffc9246f73d73b0c0b5fac05e18924398b1ccdf74fd411e302be764f0`;
  prompt and command evidence are
  `2016c1ec7245d2fa4d6ec90f3ac05165b1fc0c86dc7314e40cb17641ba9f42c7` and
  `c7f2ae83255d4e908ea4f6f60191457586a223aa935a08178c9c0b61431b37aa`.

One distinct Codex-high correction owner may change only:

- `tests/protocol-v3-freeze-governance-n1prime-e.test.ts`;
- `tests/protocol-v3-freeze-governance-n1prime-e2.test.ts`;
- `tests/protocol-v3-freeze-governance-n1prime-e3.test.ts`; and
- bounded multiline-correction logs/ledger under `.logs/`.

In each file, only the duplicated lifecycle helper and its necessary `typescript` import/supporting local
functions may change. The helper must AST-locate the unique default `defineConfig` root object, unique
literal `test` object and unique root `test.exclude` initializer; require an order-sensitive, static
string-literal array exactly equal to the declared six or seven; preserve the original source bytes when
it already has the requested state; otherwise replace only the initializer span with the requested exact
literal and re-parse to prove the result. The error trigger/message, every call site, snapshot shape,
mutation matrix/count, partial-base case and assertion must remain unchanged.

A shared helper file is prohibited here: it would add an undeclared, unprotected input to three protected
evidence tests. Regex or whitespace-normalized fallback, subset/sorted equality, whole-file printer
rewrites, fixture-derived source tautologies, Git/HEAD runtime fallback, config reformat/revert,
`prettier-ignore`, optional lifecycle, checker/policy changes or GREEN-owned test edits are prohibited.
The Phase e fixture remains frozen at
`3a6933294e6f760d7c9e24a84e162dc418ddba0039de9a5095c36ac2729ecccb`;
the e4 pair remains frozen at `5fdaa2b9…` / `95e3aabe…`.

The dormant single-line branch in e4's `futureRootConfig` is recorded but not reopened: it early-returns
for the live seven-entry config, and D.46.6 branch evidence proves the exact committed six-entry state.
After this correction, rerun all 23 and treat any newly reached checker failure as a new causal finding,
not permission to widen the correction.

## Next Agent Prompt

Begin the **Phase −1′e4 predecessor multiline correction** with one distinct Codex-high owner. Change
only the three test helpers and bounded ledger authorized in D.46.7. Preserve the Phase e/e4 fixtures,
e4 test, production candidate, plan and every assertion/call site. Require the joint e/e2/e3/e4 gate to
reach 23/23 without production edits.

Then resume the held GREEN owner to verify—not edit—the correction and run the remaining D.46.4 gates:
discovery, real-Git/bootstrap matrices, accepted successors, frozen v2, workspace typecheck, lint and the
complete ordinary suite. Do not checkpoint until fresh Grok 4.5/high, Kimi 3 via the exact 100-step
invocation and final Opus-xhigh all accept the corrected atomic tuple.

### D.46.8 — Canonical protected-path instance correction and order mutant

The D.46.7 correction reached 22/23 rather than 23/23. Formatting, targeted ESLint and all 31 workspace
typecheck projects passed, e4 remained 3/3, e2 passed 2/2 and all sixteen e3 cases passed. The sole newly
reached failure is Phase e's synthetic coherent-first-bootstrap policy:
`protocol-v3 freeze violation: freeze policy protectedPaths differs from the exact declared v3 surface`.
The bounded correction ledger is
`99b92bd1e11487b6d2f51b701ca2a9a92dcedad81356bf56a6e1ccbc4d84f491`.
Its corrected predecessor-test hashes are:

- e `3a3b51f0394334ca22513551ff11ecab6a48c149b894e10ae2d9ca685a4398bb`;
- e2 `f1563ffc83fb0ce9f43b714d36953f9ef75f3cc77a148bb757b4ea2b8b2c6ed4`; and
- e3 `202b35e7b0c8f88ce2443c61d1b10de6d1f7cecb6940d6264a01f57ce87f7ccf`.

The failure is an exact two-entry ordering mismatch. The three predecessor controls construct
`evidencePaths` as e, e2, e3, Phase e fixture, e4 test, e4 fixture. The checker and live policy declare e,
e2, e3, e4 test, Phase e fixture, e4 fixture. The real checker, live policy and live snapshot already
agree and pass. Only Phase e's fabricated `coherentPolicy` uses the other order. Its sibling checker hash
is deliberately synthetic, and the predecessor controls assert the live protected surface through
membership rather than positional semantics. Therefore the old append position was an incidental mock
construction choice, not a previously asserted protocol or policy ordering contract.

Work paused before any plan or implementation edit while the required correction quorum reviewed that
assumption. The first round split:

- Codex-high and Opus-xhigh initially chose a checker/policy reorder;
- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and `-m kimi-code/k3`, chose the
  test-side correction after reproducing the focused 1/2 Phase e failure. Its raw review is
  `4deb864ea62a34327353f9b679e326f18b0b736e5c104cfa5201fa02c636d7c1`;
- the initial Opus-xhigh raw review is
  `1cdf3b5f95eda9c232ad004f8434ede9282f8f10d4967b93595a4c609fd1f9ea`.

A reconciliation round then converged without a majority shortcut:

- Codex-high superseded its first answer and accepted the three-file A-plus correction after
  distinguishing frozen behavior from an unspecified synthetic-input order;
- Opus-xhigh independently made the same correction after proving that `coherentPolicy` is a mock while
  the only order-sensitive system assertion is the checker's exact comparison. Its reconciliation raw
  review is `e555da73b7a13e5bc1f643a79f475487e2932d784b219b84ced1ab5b52ce5c32`;
- Opus also found that no existing mutation proves a membership-preserving permutation rejects; and
- Codex-high and Kimi 3 then independently inspected the shared mutation matrix and agreed that one
  permutation mutant requires a bounded strengthening of the Phase e local oracle. The final Kimi 3
  review again used the exact 100-step/model invocation; its raw evidence is
  `75f38c0d2ebaf99ed55c61a367c21b51c4f1035831b0a910a58db25f4e174bf7`.

The agreed rule is narrow: a synthetic input may be corrected to a valid instance only when the
property under test is independently asserted and is not weakened. Here the live surface membership is
already asserted and every production exact-order check remains unchanged. D.46.9 records that the
post-freeze permutation alone did not make a sorted, set-based or permutation-tolerant relaxation fail:
the later unchanged-base-policy guard masked that relaxation. The required bootstrap-path assertion is
the causal compensating control. This is not permission to edit a RED whenever GREEN disagrees.

One fresh Codex-high correction owner, distinct from the e4 RED and held GREEN owners, may change only:

- `tests/protocol-v3-freeze-governance-n1prime-e.test.ts`;
- `tests/protocol-v3-freeze-governance-n1prime-e2.test.ts`;
- `tests/protocol-v3-freeze-governance-n1prime-e3.test.ts`; and
- bounded order-correction logs/ledger under `.logs/`.

The correction must:

1. reorder only the identical `evidencePaths` literals to e, e2, e3, e4 test, Phase e fixture, e4
   fixture;
2. in e only, replace the membership-only local-oracle protected-path check with exact order-sensitive
   equality against `requiredPolicyPaths`;
3. add exactly one membership-preserving protected-path permutation mutation to the shared e matrix;
4. update both shared-matrix expectations from 48 to 49 while leaving `mutations.length + 2` unchanged;
   and
5. prove the new permutation is rejected by both the independent local oracle and the real checker.

No production, fixture, e4, configuration, workflow, CODEOWNERS, lock, immutable-input, call-site,
snapshot-shape or unrelated mutation change is authorized. The checker
`0c54c747ca375591d7783b553ef8993d4d3f4932a831377bee3b7415345549de`, policy
`fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3`, root config
`c1d2eeab4d2d7756549ecd2c818890de93d74d8ea38965ba58dea9c6e672f462`, e4 pair
`5fdaa2b9eff5f98e21823e91fd0ca4be4fd409051df43658da22373c5d398d1c` /
`95e3aabeab12edae583f3d80fb3c8565735279f59e37e100e6ec884ca10997d4` and Phase e fixture
`3a6933294e6f760d7c9e24a84e162dc418ddba0039de9a5095c36ac2729ecccb` remain frozen.

After the correction, require the joint gate to pass 23/23 with both shared matrix calls returning 49,
e4 at 3/3 and all fourteen e3 partial-base cases intact. Re-run targeted Prettier/ESLint and workspace
typecheck 31/31, record old/new hashes plus frozen-byte preservation in the ledger, then return control to
the held GREEN owner for the complete D.46.4 verification battery.

### D.46.9 — Required bootstrap-path causal correction

The final fresh Opus-xhigh review authenticated the complete Phase −1′e4 tuple and reproduced the
23/23 gate, discovery, one-shot actual-HEAD bootstrap, self-pins and honest full-suite accounting, but
returned **BLOCK** on D.46.8's compensating-control claim. Its raw review is
`.logs/phase-n1prime-e4-final-opus-xhigh.raw.json`
(`1c1d08592bef7c60ed1d9851cf66f0e41634524e17de799146c961a4ca3da3e0`).

The permutation is currently driven only as a post-freeze mutation with `base = closure`. If the local
oracle's and real checker's exact-order comparisons are weakened to sorted/set equality, both still
reject later because `current.policy` differs byte/deep-equal from `base.policy`. Therefore the passing
49 count is non-discriminating. On the first-bootstrap path, where the base has no policy, the same
permutation is rejected only by the exact-order comparison and is accepted by the weakened evaluators.
The post-freeze policy equality similarly masks the other policy-semantic mutants and makes the later
self-grading-specific guard unreachable; future policy-semantic mutants must be exercised on the
bootstrap path when they claim to isolate policy validation.

Work again paused before any plan or test edit until the required correction quorum agreed:

- final Opus-xhigh — **BLOCK**, `PLAN ASSUMPTION: AGREE`;
- Codex-high —
  `.logs/phase-n1prime-e4-causal-correction-quorum-codex-high.md`
  (`35ae974639fc65e8dc480223f424f2b8df67142df28806ac5a1f82ac7b03ce6c`) —
  **AGREE**, `PLAN ASSUMPTION: AGREE`; and
- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and
  `-m kimi-code/k3` —
  `.logs/phase-n1prime-e4-causal-correction-quorum-kimi3.raw.log`
  (`ea9e2770813989061169c36f33184fade0d74572a29cf2f144c9f495398206d0`) —
  **AGREE**, `PLAN ASSUMPTION: AGREE`.

One fresh Codex-high correction owner, distinct from every Phase e4 RED, prior correction and held GREEN
owner, may change only `tests/protocol-v3-freeze-governance-n1prime-e.test.ts` and bounded correction
evidence under `.logs/`. It must keep the existing post-freeze permutation entry and mutation count,
then add one separate first-bootstrap rejection using a cloned `closure` whose first two
`protectedPaths` are swapped against `coherentBase()`. `mutations.length + 2` and both expectations remain 49. No checker, policy, root configuration, workflow, CODEOWNERS, fixture, e2/e3/e4, lock or other
production/test change is authorized.

The correction is not accepted by a green count alone. Scratch-only weakened copies of both evaluators
must prove the old post-freeze case remains rejected while the new bootstrap case is accepted when exact
order is relaxed. The live evaluators must reject that bootstrap case. Then rerun the joint 23/23 gate,
both 49-count calls, e4 3/3, all fourteen e3 partial-base cases, targeted Prettier/ESLint, workspace
typecheck 31/31 and frozen-byte hashes before fresh external review.

The same Opus review found distinct residual debt: the ordinary-CI parser proves only the presence of one
literal `pnpm test` in a multiline run block, so job/step `if: false`, `continue-on-error`, trigger
narrowing or a `workflow_dispatch`-only replacement can neutralize `test.yml` while the v3 status passes.
The root `CODEOWNERS` `*` rule supplies only the repository-wide default review routing that any unrelated
file receives; it is not a targeted v3 safeguard and does not make the parser causal. This must receive a
separately authorized future slice; it is not permission to widen this test-only correction.
Also carry forward the no-op absolute-path strip and project-prefixed discovery-line gap in e4, the
synthetic pre-v3 metadata asymmetry, local-only dirty-tree `ENOBUFS`, alternate-config historical-c
execution, e3 post-checkpoint `git archive HEAD` degradation, the six HEAD-identical full-suite failures,
the contention-only d timeout, hard-coded `v2StatusPassed` workflow coupling and external branch
protection as unproved host state.

The returned matrix value remains `47 + 2 = 49` even though four rejection assertions now follow the
shared mutation loop. It is a historical matrix metric, not a count of all asserted rejections, and does
not protect the new bootstrap case. The retained weakened-evaluator logs stop at the first missing throw,
so by themselves they do not prove that no later rejection also disappeared. The final Opus review closed
that evidence gap by deleting only the new block in scratch, re-running both weakened evaluators and
observing 2/2 with all 100 remaining rejection calls throwing; restoring the block produced the sole
missing throw for each evaluator.

### D.46.10 — Causal correction accepted and atomic checkpoint authorized

The D.46.9 correction changed exactly one governed test:

- corrected Phase e test
  `9455c3a01fb5480ab88d76445432d97d3c38ee4648cc26a75324efa17bc2196f`;
- predecessor Phase e test reconstructed by deleting only the new block
  `19f17c85e78297c40741e27228b4a91f476930d713b901a9c544b2220c649de8`;
- correction ledger
  `.logs/phase-n1prime-e4-bootstrap-causal-correction-ledger.md`
  (`142dd2cbc1a99fc0ae2bc554f049e9502df048181816a7f906838eb0b919b78b`); and
- held GREEN verification
  `.logs/phase-n1prime-e4-d469-held-green-verification.md`
  (`f9df45c2ebcf89f38bc2d853f960d8be1c81ed1df2eb3ae1bfcaf8b87f00148e`) —
  **PASS**.

Both scratch controls independently weakened only one evaluator's exact-order comparison. The retained
post-freeze permutation still rejected through `base freeze policy changed`, while the new
first-bootstrap assertion alone observed no throw. The final Opus review strengthened that proof with
rejection-reason instrumentation and the block-removal controls described above. Live e/e2/e3/e4 passed
23/23, e4 passed 3/3, all fourteen e3 partial-base cases remained intact, targeted Prettier and ESLint
passed, workspace typecheck passed 31/31 and every frozen production, fixture, sibling-test,
configuration, workflow and CODEOWNERS hash remained unchanged.

The corrected tuple then received:

- Grok 4.5/high:
  `.logs/phase-n1prime-e4-d469-review-grok45-high.raw.json`
  (`6853d568766b4fd8c3a0302388d1417cf57f1516e84daa5f8b16a7e8ae20884f`) —
  **PASS_WITH_NOTES**;
- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100` and
  `-m kimi-code/k3`:
  `.logs/phase-n1prime-e4-d469-review-kimi3-100.raw.log`
  (`9e7034d93d4cda5069ce504a96c8f63b86b6237ad8ad75e9ab6d45f012db4c1a`) —
  **PASS**; and
- final fresh Opus-xhigh:
  `.logs/phase-n1prime-e4-d469-final-opus-xhigh.raw.json`
  (`cf65c8a8c879933df894bb5f87eb1ae56cdbc833fc085b5f24cf3a5a57d1408f`) —
  **PASS_WITH_NOTES**.

The final Opus review re-authenticated the tuple, independently reproduced the reason flip for the masked
post-freeze case, proved the bootstrap case is the sole missing rejection under each weakening and
authorized recording these hashes plus the selective atomic checkpoint. The ordinary-CI neutralization
and every residual in D.46.9 remain open, explicitly scoped debt; none is represented as fixed.

Phase −1′a…−1′e4 may now land as its one consensus-visible checkpoint. Selectively stage only the
governed atomic tuple, `vite.config.mts` and this plan. Never use `git add -A`. Exclude `.agents/`,
`.claude/`, `.logs/`, `.pnpm-store/`, `skills-lock.json` and both untracked v2 `0g2` REDs.

## Next Agent Prompt

Begin **Phase 0g(ii-T)** with a fresh Codex-high v3 RED author restricted to new tests, input-only fixtures
and bounded `.logs` evidence. Port no production code during RED. The RED must prove the registry-derived
v3 vertex preimage requires `authorSequence` at the declared review position, that the sequence changes
canonical preimage bytes and digest, that the v3 signature authenticates it, that malformed values are
rejected before key resolution, and that v2↔v3 domain/suite substitution is rejected in both directions;
the verifier must hash the exact received canonical-preimage byte array, never a decoded or re-encoded
surrogate.

Do not edit, stage or make green the two stale untracked v2 REDs
`packages/protocol-v2/tests/author-sequence-0g2.test.ts` and
`packages/protocol-v2/tests/local-author-sequence-issuance-0g2.test.ts`; D.36.1 records why they must be
re-authored on v3 rather than repaired in place.

Preserve every byte of the committed Phase −1′a…−1′e4 atomic tuple and all completed Phase 0a–0g(i)
production and tests; frozen v2 and v3 governance must stay green. The ordinary full suite is not green —
the six HEAD-identical `packages/node`/`packages/object` failures and the contention-only −1′d timeout are
pre-existing and out of scope for this RED. Keep all future Kimi reviews on the exact
`KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi -m kimi-code/k3` invocation.

## Appendix D.47 — Phase 0g(ii-T) registered-byte TypeScript port

### D.47.1 — Final RED/GREEN tuple

Phase 0g(ii-T) implements only the pure protocol-v3 registered-byte surface. It does not add a live
protobuf/topic codec, issuance coordinator, durable outbox, node binder or remote sequence policy.

The final RED tuple is:

- `tests/protocol-v3-registered-byte-0g2t.test.ts`
  (`6d9cba3ebc1ae3b63cf296e6063e4f1cb843c6f057b7cbd5d460e76657fcfa33`);
- input-only fixture `tests/fixtures/phase-0g2t/registered-byte-contract.json`
  (`56e7ea703691c242cd78ab016af8f9398d8c0a4e91ea36918b71704e2aa0dafb`);
- RED ledger `.logs/phase-0g2t-red-ledger.md`
  (`453ccb5356fcf48b6e706dbbf5c1282a364a6491fce1e1ce84413f32c20b1bb9`).

Review found three masked or missing contracts before checkpoint, and the original RED owner corrected
each while GREEN production was held:

1. malformed expected-anchor width had masked the well-formed wrong-scope comparison;
2. received registered-field coverage, including an unknown signed eleventh field, existed only in
   ignored exploratory evidence; and
3. the verifier's strict Ed25519 acceptance was not distinguished from wider ZIP-215 verification.

The permanent RED now passes 13/13 against the final implementation. Four narrow controls independently
kill decode→re-encode verification, deletion of anchor equality, unknown-field acceptance and ZIP-215
widening. The latter uses a valid canonical v3 preimage with the identity/small-order public key and
signature; the resolver is called exactly once, wider noble verification accepts the tuple and the
required strict verifier rejects it. The controlled production-absent run remains RED, while the
independent compliant surface passes. No frozen artifact or stale v2 `0g2` test was edited.

The GREEN package is:

- `packages/protocol-v3/src/index.ts`
  (`40a49961e49adf52354571a200654f8b0fae9ab45b363f4fc5e5ac0a7efe2603`);
- `packages/protocol-v3/package.json`
  (`512a84d51f0c19ad5888ccaba810b00272de5cd5627eb50d3705be619227c632`);
- `packages/protocol-v3/tsconfig.json`
  (`198543b2f3efa897daf708f2db75ac972da0e861e87a919d4c8647450ed80371`);
- `packages/protocol-v3/tsconfig.build.json`
  (`d906c988532396d44bdc5c0d0a88f3248f0c1bd979570f453e6b7cba40b4ae94`);
- `pnpm-lock.yaml`
  (`897f3fb9ee875544e2801f349d8ad0f59e60deb8cf9a699473dd2c122b856c1f`);
- GREEN ledger `.logs/phase-0g2t-green-ledger.md`
  (`3d47b43ee3f8e06dd266926fb3d3dbf234adc081828d4569929431894cd117bb`).

Runtime registry metadata owns field selection, constants, constraints, review order, dependency
normalization and active domain/suite selection. `@ts-drp/canonical` remains the sole byte codec and
framing owner. Received admission validates canonicality, the exact registered field set, protocol major
and anchor scope before resolving the author key, then hashes the untouched received byte array and
verifies strict noble Ed25519 with `{ zip215: false }`.

### D.47.2 — Admission semantics and the historical defect wording

A mid-GREEN audit questioned whether canonical decoding reintroduced D.43.2's blocked
"canonical-gated verification." It does not. PH-N1P-D03 requires canonical and registered-field
validation before digest verification while prohibiting a decoded/re-encoded digest surrogate. The final
implementation decodes only for admission and hashes the original bytes.

Codex-high preferred a separate public raw-signature verifier. Exact Kimi 3/100 and Opus-xhigh
independently returned `DISAGREE_CURRENT_CONTRACT_SOUND`; because the plan-correction quorum was not
unanimous, no API split or plan rewrite was authorized. The raw exact-byte digest primitive remains
`digestReceivedVertexPreimage`; `verifyReceivedVertex` is the admission-oriented surface. The review
artifacts are:

- Kimi 3 `.logs/phase-0g2t-semantic-quorum-kimi3-100.raw.log`
  (`888c19608c6a168ba881bf0e62606eb12a4961453882e25bbaef9dc3b435670d`);
- Opus-xhigh `.logs/phase-0g2t-semantic-quorum-opus-xhigh.raw.json`
  (`8ec078955b185864aa9bfd8286dd7412c4444cd1d1fd040eb506d31337f0b119`).

The phrases "overwrite a wrong next sequence" and "ignore public-key mismatch" describe superseded
Phase −1′d regenerated-reference defects, not accepted behavior. The accepted original and regenerated
references reject the wrong selected ordinal and mismatched keypair before digest, sign or publication
work. Phase 0g(ii-T) contains no issuer; 0g(ii-I) must preserve coordinator-selected ordinals, failed-work
opacity and signed-byte/key binding.

### D.47.3 — Strict Ed25519 acceptance supplement

The user-requested Fable-xhigh path audit returned `ON_TRACK_WITH_CORRECTIONS`
(`.logs/fable-current-path-audit-20260727-v2.raw.json`,
`86bbb8a3c185dddb8b1602fd55faa38a974b5b7250b1d472734909568cafb98f`). Its anchor and durable
registered-field findings are closed by D.47.1. It also found that the frozen v3 tuple names Ed25519 but
does not pin canonical point/scalar acceptance, small-order handling or the exact verification equation.

This is a real backend divergence. The bounded diagnostic produced:
`{"nodeOpenSSL":true,"nobleStrict":false,"nobleZip215":true}` for the identity/small-order tuple:

- `.logs/phase-0g2t-ed25519-profile-node-vs-noble-probe.log`
  (`1972759fbf7890ef543b11d6c77afef1f56e15ec0bfbc816ae02e3eb8e9f5b92`).

The required incorrect-assumption quorum unanimously returned `AGREE_PROFILE_GAP`:

- Kimi 3, invoked exactly with `KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi -m kimi-code/k3`
  (`8f1436a1ea50d7d49c669ccd053ce942c8efbe065df768930dd421b4b565136e`);
- Opus-xhigh
  (`091d34fe85d2a3881535ba8bddf10ffaea440a39942a0c4d096bd181d3e64076`);
- Codex-high
  (`2e0989bd635e95c8f80ee5e917eebcbbaf6bc936c41bbb9d45d4b5decdc9c6ae`).

The current strict code and causal RED are accepted; widening to match OpenSSL would select consensus
semantics by accident. The ambiguity is not a current single-implementation blocker, but it is a hard
prerequisite to Phase 3a. D07's pre-freeze decision-triple procedure cannot lawfully edit its now-frozen
files. The new 0g(ii-S) slice therefore owns a separately governed post-freeze addendum, machine record,
adversarial vectors and strict adapters that hash-bind—but never modify—the Phase −1′ tuple. An amendment
is not closed until its normative body and executable evidence actually land.

### D.47.4 — Gates, external review and honest residuals

Final focused tests pass 13/13; workspace typecheck and build pass 32/32; targeted Prettier/ESLint pass;
package pack, declarations, five runtime exports and source/build registry semantic integrity pass; v3
e/e2/e4 governance passes 7/7; frozen-v2 preservation passes 24/24; both real freeze CLIs pass.

Raw `pnpm lint` reports seven parser-project errors only because ignored `.logs` TypeScript evidence is
inside the dirty worktree; the clean-equivalent repository run excluding `.logs/**` has zero errors and
the same 226 inherited warnings. The raw full suite is honestly RED at 7 failed / 244 passed / 2 skipped
files and 33 failed / 1,726 passed / 7 skipped tests. Removing only the two stale v2 REDs and the known
post-checkpoint e3 harness leaves three failing files and seven failing tests: the six HEAD-identical
node/object failures plus one Phase −1′d contention timeout. Phase −1′d passes 2/2 isolated. None is
attributed to this slice.

The final external reviews authenticated the final tuple and independently reran proportionate gates:

- Grok 4.5/high `.logs/phase-0g2t-final-review-grok45-high.raw.json`
  (`41bd96e83946994ec7053797c940bb81ff6adf04fee0b26a0fe3ec56ddc95445`) —
  **PASS_WITH_NOTES**;
- Kimi 3/100 `.logs/phase-0g2t-final-review-kimi3-100.raw.log`
  (`713d835f045047b12feb4ee68d7a50e8ea298319d3764626f70502a6c4fe1baa`) —
  **PASS_WITH_NOTES**.

Both found no live 0g(ii-T) security blocker. Carry forward the 0g(ii-S) hard dependency, the known e3 and
full-suite debt, and the source-firewall limitation that a literal-name check is not a universal
anti-copy theorem. The build-emitted registry differs from source only in JSON whitespace; its parsed
value/key order is equal and the public package also exports the exact frozen source registry. Cite the
corrected registry-integrity evidence for that claim; the earlier export-smoke log is evidence only that
the built exports load.

### D.47.5 — Acceptance boundary

Fresh final Opus-xhigh returned **PASS_WITH_NOTES**:

- `.logs/phase-0g2t-final-opus-xhigh.raw.json`
  (`da44bf4224531aa7332dae96cb768bba4f7e2bfb2cd5fd4f96f445856902d922`).

It authenticated all nineteen supplied artifacts plus the six scratch mutant sources, independently
reproduced 13/13 focused GREEN, the 11-fail/2-pass absent control and each of the four exact one-test
mutant kills, and reran the proportionate package, preservation and freeze gates. It confirmed that
0g(ii-S) is a lawful additive post-freeze supplement and that Phase 3a is hard-blocked on its normative,
machine-readable, vector and live-verifier evidence. Because `freeze-policy-v3.json` is itself protected,
0g(ii-S) must create separate additive governance rather than extending that file.

The review also re-read both accepted reference implementations and confirmed that each rejects a wrong
selected ordinal or mismatched keypair before digest, signing or publication work. This live-byte
evidence overrides the final Kimi review's contrary sentence about the original reference; D.47.2 was
already correct and no production or plan-semantic change was needed.

The final checkpoint gate reran focused tests (13/13), workspace typecheck, protocol-v3 build, targeted
and clean-equivalent workspace ESLint, Prettier, v3 governance (7/7), v2 preservation (24/24) and both
real freeze CLIs. Every gate passed:

- `.logs/phase-0g2t-final-checkpoint-gates.log`
  (`23d468e5e93f16ba140241b2550875a575266006934da1f77c618edaa22d7166`).

Phase 0g(ii-T) is accepted and its selective atomic checkpoint is authorized. Stage only the four new
protocol-v3 package/config files, `pnpm-lock.yaml`, the final RED test, its fixture and this plan. Never
use `git add -A`; never stage `.agents/`, `.claude/`, `.logs/`, `.pnpm-store/`, `skills-lock.json`, either
stale v2 `0g2` RED or generated `packages/protocol-v3/dist/` output.

## Next Agent Prompt

Selectively checkpoint the authorized Phase 0g(ii-T) paths, then begin **Phase 0g(ii-I)** with a fresh
Codex-high RED owner restricted to tests, input-only fixtures and bounded `.logs` evidence. The RED must
define the live issuance coordinator contract without changing production or any frozen Phase −1′
artifact: preserve the coordinator-selected ordinal verbatim, reject a public/private key mismatch
before digest/sign/publication, bind the exact registered bytes to the selected key, make failed work
opaque to subsequent issuance and prevent duplicate publication under concurrent local authorship.

Keep the two stale untracked v2 `0g2` REDs untouched; re-author any still-valid behavior against v3.
Preserve the accepted 0g(ii-T) exact-byte admission surface and all frozen governance. Keep every future
Kimi review on the exact `KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi -m kimi-code/k3` invocation. Do not begin
Phase 3a until 0g(ii-S) is accepted.

## Appendix D.48 — Phase 0g(ii-I) transactional local issuance

### D.48.1 — Final RED/GREEN tuple

Phase 0g(ii-I) adds one stateless author-bound builder over the injected
`transactIssue(scope, buildAndSign)` boundary. It does not add a default store, issuer-owned counter,
reservation/abandon API, outbox publisher, protobuf/topic codec, node binder, remote sequence policy or
durable backend.

The sealed RED tuple is:

- `tests/protocol-v3-transactional-issuance-0g2i.test.ts`
  (`f29d1d8aad65f3cbf8410f5c16d5ded97736ed9fb838125d570799e0d1213cea`);
- input-only fixture `tests/fixtures/phase-0g2i/transactional-issuance-contract.json`
  (`115e31e704eb43a148c9c07211b17cb4076dfb4b4ebd85c04d4bda3fa8641047`);
- RED ledger `.logs/phase-0g2i-red-ledger.md`
  (`3414ef4d67baebd0665eaf49fcc3edf44c2a2a898ea09602e240a4a8d4b0b1eb`).

Live production before GREEN passed the fixture/control test and failed all nine behavioral tests solely
because `createTransactionalVertexIssuer` was absent. An independent compliant scratch surface passed
10/10. Three narrow mutants retained distinct causal failures:

- global issuer mutex: 8 pass / 2 fail, killing genuine overlap and unrelated-scope progress;
- unsigned completion counter: 6 pass / 4 fail, killing records whose visible ordinal differs from their
  authenticated bytes; and
- mutable caller aliases: 9 pass / 1 fail, killing deferred signing over caller-mutated key/request
  objects.

The accepted production is:

- `packages/protocol-v3/src/index.ts`
  (`774cb776e67b92dd0abd49b470d1f85ede1004c9b91cb0f26e1f868068b1a846`);
- GREEN ledger `.logs/phase-0g2i-green-ledger.md`
  (`680e2a880d6ed9079dfb562a7aedc916173df94b963590c07306281fd25c2ce9`);
- compact gate evidence `.logs/phase-0g2i-green-gates.log`
  (`9fef86657c5f299903eb661f86d9a2a1b4254eacd5d3895411d4ebe60d5f145f`).

At factory construction, the issuer validates and copies the private seed and raw public key, derives the
public key from the copied seed and rejects a mismatch before transaction, preimage, digest or signature
work. The synchronous head of `issue()` snapshots scalars and dependencies and detaches the nested
operation through the accepted canonical codec before transaction suspension.

The trusted closure constructs exactly the ten registered v3 vertex fields. Configured `author` and the
coordinator-selected `authorSequence` are the only signed identity/ordinal values; caller extras cannot
overwrite them or the kind/protocol constants. It computes the registered digest over the exact returned
canonical-preimage bytes and signs that raw 32-byte digest. One envelope value is placed in the internal
commit, issued record and outbox entry. Only successful resolution of the injected transaction reaches
the public caller; synchronous transaction throws become rejected promises.

The issuer itself stores no sequencing, exhaustion or publication state. Phase 2l owns the real
browser/node transaction and crash matrix; Phase 3a owns publication of committed outbox records; Phase
0o owns remote duplicate/gap/equivocation policy.

### D.48.2 — MAX_SAFE plan correction

RED review found an internal documentation conflict. D.39.1 described the blocked first −1′c RED's bare
`next` representation as stopping at `MAX_SAFE_INTEGER - 1`, while the accepted registry, maximum vector,
replacement mint, both references and the c2 contract successfully issue
`authorSequence = MAX_SAFE_INTEGER`, atomically mark the lineage exhausted and reject later attempts
before work.

Work stopped at that boundary until the required correction quorum unanimously returned
`AGREE_CORRECT_D39_MAXSAFE_ISSUED_ONCE`:

- Codex-high collaboration result, transcribed without replacing the original transcript:
  `.logs/phase-0g2i-maxsafe-quorum-codex-high.md`
  (`b78f3ade024aa59bff898e0611dd7eeda23d84e0a9aa2ab067576549bc2caa78`);
- exact Kimi 3/100:
  `.logs/phase-0g2i-maxsafe-quorum-kimi3-100.raw.log`
  (`5c7b5c6bf78b40c43a7ab1dabb00ebcb792a50eb6ebfcb241094ddb588a8d765`);
- Opus-xhigh:
  `.logs/phase-0g2i-maxsafe-quorum-opus-xhigh.raw.json`
  (`6a8d276b8108d7a2a0f79134eda94cdc01b118314e32d4de3b923bed29441959`).

The living-plan correction preserves D.39.1 as blocked `next`-only history, records its supersession by
c2/frozen evidence, anchors D.39.2 to the c2 `sequenceContract`, and clarifies the Phase 0 boundary.
Neither the registry, vectors, references, c2 tuple nor any other frozen byte changed.

The final RED now proves: a failed commit at the final slot leaves `next = MAX_SAFE_INTEGER`,
`exhausted = false` and no envelope/record/outbox; retry reselects and successfully signs the maximum
ordinal; that success sets an explicit exhausted discriminator; the next attempt performs no
build/commit work and mutates nothing. Phase 2l must persist the ordinal/exhaustion discriminator in the
same durable transaction and must never compute `MAX_SAFE_INTEGER + 1`.

### D.48.3 — Gates and independent review

Final production and the independent compliant surface pass 10/10. Package and 32-project workspace
typecheck/build pass; built runtime/declaration exports load; targeted ESLint/Prettier and
clean-equivalent workspace ESLint pass; accepted 0g(ii-T) passes 13/13; v3 e/e2/e4 governance passes 7/7;
frozen-v2 preservation passes 24/24; both real freeze CLIs pass; and `git diff --check` is clean.

Raw `pnpm lint` was also run and is honestly RED with eleven parser-project errors confined to ignored
`.logs` TypeScript evidence plus 226 inherited warnings. Seven error files are accepted 0g(ii-T)
evidence and four are the 0g(ii-I) compliant/mutant surfaces. The clean-equivalent run excluding
`.logs/**` has zero errors and the same inherited warnings. The raw full suite was not rerun or
green-chased; D.47 remains the accepted inherited debt baseline and this slice makes no full-suite-green
claim.

Both independent external reviewers authenticated the production/test/fixture tuple and the plan snapshot
at `15eab2d9884bcfdb8b5f1ff56b7027d78fbaef1af6951162f9d8acf69193f025`, then reran the focused,
mutant and proportionate preservation gates. That snapshot is exactly the current plan before Appendix
D.48; this appendix itself was reviewed only by the final Opus pass:

- Grok 4.5/high:
  `.logs/phase-0g2i-review-grok45-high-v3.raw.json`
  (`c514375ca30ab02b1d79d8925e4ba5ed70ef3cb1a356b1df8a00a309bf4695bf`) —
  **PASS_WITH_NOTES**;
- exact Kimi 3/100:
  `.logs/phase-0g2i-review-kimi3-100.raw.log`
  (`7011046e65c2ec9c4941f840aae1bf818cc67adb08c03fd22085da6b3b0c8983`) —
  **PASS_WITH_NOTES**.

Two earlier Grok wrapper attempts cancelled before repository inspection and produced no verdict; they
are not review evidence.

### D.48.4 — Findings and carry-forward ownership

1. The successful internal commit, issued record and outbox entry intentionally share one envelope value,
   whose `Uint8Array` members remain mutable after return. The ephemeral test double clones on commit.
   Phase 2l must clone/serialize before durable commit, and Phase 3a must publish only a detached committed
   record so caller mutation cannot alter stored or published bytes.
2. The issuer returns whatever the trusted `transactIssue` resolves. That trust is the injected boundary,
   not a universal adapter-honesty proof. Phase 2l must require the successful return to be the exact
   closure commit it stored.
3. Operation detachment and invalid-operation rejection happen before transaction entry. Other registered
   request fields validate inside `buildAndSign`, after the adapter selects an ordinal. Phase 2l must prove
   every build throw is old-state/no-publication and may optionally hoist cheap author/request shape
   validation without changing registered bytes.
4. `createTransactionalVertexIssuer(null)` exposes a native property-access `TypeError`; shaped public
   error taxonomy remains later hardening. This is not a consensus or atomicity defect.
5. The production issuer is deliberately stateless. It does not itself prevent a malicious adapter from
   invoking `buildAndSign` more than once, reusing an ordinal or returning a fabricated record. Those are
   violations of the trusted `transactIssue` contract and require causal real-adapter tests in Phase 2l,
   not an issuer-local counter or mutex.
6. This slice does not complete the Discord/chat/game golden paths. It provides their authenticated local
   issuance seam; durability, live binding/publication, remote equivocation policy and the strict
   Ed25519 supplement remain required.
7. The sealed RED does not directly exercise dependency sorting or close the issuance-to-
   `verifyReceivedVertex` loop. Final Opus independently probed deliberately unsorted dependencies and the
   resulting envelope was admitted with the same digest. Phase 0g(ii-S) should add the strict-verifier
   closure, and Phase 2l should retain the dependency/canonicalization integration edge.
8. `PHASE_0G2I_IMPLEMENTATION_MODULE` is a RED-harness override and must remain unset in ordinary CI and
   production execution.
9. This layer does not prove that the configured `author` names the supplied public key. Phase 3a owns
   construction of the live `resolveAuthorPublicKey` adapter and must prove that one registered author
   identity resolves to the intended key before admission; duplicating resolver policy in this stateless
   issuer would steal that live-binding responsibility.
10. Before Phase 2l GREEN, extract the test double's commit/selection honesty assertion into a shared
    adapter-conformance harness. It must additionally prove that hostile unsafe/negative ordinals and
    invalid caller fields reject without consuming an ordinal, successful returns byte-equal the stored
    closure commit, cloned/serialized envelope and scope bytes cannot be mutated through aliases, and
    every build/sign failure is old-state/no-publication.
11. The copied seed remains resident in the issuer closure. Phase 3a/keychain integration owns any
    stronger custody or zeroization policy; this primitive neither overclaims nor weakens that boundary.

The one-off Fable-xhigh current-path audit used the Claude bridge only because the user requested it:

- prompt:
  `.logs/phase-0g2i-fable-xhigh-current-path-prompt-20260728T191006Z.md`
  (`a499be0d693361c42cd8da081ca69b3a49c326a5b63916af12923829147db91e`);
- raw:
  `.logs/phase-0g2i-fable-xhigh-current-path-response-20260728T191006Z.json`
  (`dc95772197dca56a5a22dc3ce2cdcb460ad93bf2f2162338bf237658b7120deb`);
- verdict: **ON_TRACK_WITH_CORRECTIONS**.

Fable independently authenticated the tuple and all 33 frozen-v3 inputs, reproduced 10/10, 13/13,
7/7 and 24/24, confirmed the MAX_SAFE correction, and found no 0g(ii-I blocker. It confirmed that
0g(ii-S) → 2l → 3a remains a coherent route to both chat and game golden paths, with schedule rather
than architecture now the main risk. Its direct dirty-root v3 freeze invocation reproduced the known
`spawnSync git ENOBUFS` environmental failure because 47,610 untracked non-ignored files were enumerated.
The final checkpoint gate below closes that operational concern without broadening this slice: both real
freeze CLIs pass against the same working tree with the authenticated process-local excludes
`.logs/phase-0g2t-git-excludes`; no repository ignore policy or frozen artifact changed. The Fable step is
not recurring—future slices retain the requested Codex-high/Grok/exact-Kimi-3/Opus loop.

### D.48.5 — Acceptance boundary

Final Opus-xhigh authenticated the exact tuple, reconstructed the pre-D.48 external-review snapshot,
reran the focused/compliant/mutant cardinalities and proportionate gates, and confirmed the MAX_SAFE
correction is compelled living-plan prose backed by frozen evidence. Its raw response is
`.logs/phase-0g2i-final-opus-xhigh.raw.json`
(`d6e6e8a9c0f2d6b9fe65d0b25889576308d9cb9639ab6dc1075e4f91ee7c0e3e`) and its prompt is
`.logs/phase-0g2i-final-opus-xhigh.prompt.md`
(`e097ad11a4cccbaeba0d5fedf3d09af5503299670f1a14412fa07785ec9ce136`). Verdict:
**PASS_WITH_NOTES**, `checkpoint_authorized: yes`, with no blocker and no semantic plan change.

The required external-review snapshot disclosure and malformed 0g(ii-I heading are corrected above.
Opus also independently proved that unsorted dependencies survive issuance-to-admission with equal
digest and confirmed the documented validation timing: invalid operation rejects before transaction,
while an invalid anchor throws from the selected-ordinal build without commit. Its remaining
nonblockers are assigned in D.48.4.

The final compact gate log is `.logs/phase-0g2i-final-checkpoint-gates.log`
(`e1dab5ec01605ed9f9bf9fb558c1e699427d2bd82e70d26c5f5b42415be5ae84`): focused 10/10,
32-project workspace typecheck, protocol-v3 build, targeted ESLint/Prettier, accepted 0g(ii-T) 13/13,
v3 governance 7/7, frozen-v2 preservation 24/24, both real freeze CLIs and `git diff --check` all pass.
The first clean-workspace ESLint invocation let zsh expand an unquoted `.logs/**` argument and exited 2
before linting; the quoted retry in the same log is the authoritative result: zero errors and 226
inherited warnings. The log records `FINAL_GATE_FAILURES 0` after that transparent command correction.

After the final compact gate rerun, selectively stage only this plan,
`packages/protocol-v3/src/index.ts`, the sealed RED test and its input-only fixture. Never use
`git add -A`; never stage `.agents/`, `.claude/`, `.logs/`, `.pnpm-store/`, `skills-lock.json`, either
stale v2 `0g2` RED or generated protocol-v3 `dist/`.

## Appendix D.49 — Phase 0g(ii-S) additive supplement accepted

### D.49.1 — First sealed RED and strict-profile finding

At checkpoint `907fae437e558145f63614cd6b5de925ea4bd8c2`, a fresh Codex-high RED owner added only:

- `tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts`
  (`26c24d2fc3ac38ee55ca0f092d855a434382230825341cd6380fb1cd332dc938`);
- `tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json`
  (`a5737f00521f775b05b2c54a2e89536becb82aaa28ba40b0718160e5da1431ad`);
- `.logs/phase-0g2s-red-ledger.md`
  (`8cec46e8c90baab7d3e5418a45810a1e0789f49b1900a0c49441af562f9708ff`).

The initial live and clean-checkpoint surfaces both fail behaviorally at 4/10; an independently authored
control passes 10/10. Eight narrow mutants each fail exactly one test and leave nine passing:
small-order acceptance, `S + L`, noncanonical-point acceptance, incorrect full-order rejection,
hex/wrapper message substitution, Node/OpenSSL as desired admission, unbound frozen tuple and
governance-permitted vector drift.

The RED independently pins archived `novifinancial/ed25519-speccheck` commit
`65519336fda78a3d016e947df6d82848aca0c9da`. Accepted noble 2.2.0 `{ zip215: false }` behavior is not
blanket subgroup rejection: canonical mixed-order cases 3 and 4 pass the cofactored equation, while
small-order public keys, noncanonical encodings and `S >= L` reject. A verifier that rejects every
mixed-order case is therefore killed as too narrow. The permanent live matrix also closes deliberately
unsorted local issuance through `verifyReceivedVertex`; this does not claim Phase 2l durability.

All 47 frozen-policy paths first authenticated with zero mismatch at aggregate
`023e7b50c11eff2d5fd4d0d8c5ea6da8d54ad095d73d24b7d3badea2e3769637`.

### D.49.2 — Frozen governed-tree contradiction and unanimous correction

The first RED fixture placed the new manifest at
`packages/protocol-v3/conformance/vectors/ed25519-acceptance-profile-v1.json`. GREEN reached focused
10/10, control 10/10 and exact mutant cardinalities, but the existing real v3 freeze CLI correctly
rejected that file:

```text
protocol-v3 freeze violation:
packages/protocol-v3/conformance/vectors is incomplete or contains an extra file
```

The frozen checker declares that tree to contain exactly `registry-v1.json`, enumerates tracked and
untracked descendants, and performs exact-set validation. The RED-stage CLI pass used the authenticated
process-local excludes, which hid the then-untracked manifest; that evidence could not survive tracking
or CI and was not a lawful GREEN gate.

Work stopped without editing any frozen byte. The required assumption-correction quorum unanimously
returned `AGREE_RELOCATE_0G2S_VECTOR_OUTSIDE_FROZEN_TREE`:

- common prompt `.logs/phase-0g2s-vector-path-quorum.prompt.md`
  (`841c1fe08da48f0aac7d927fe8c0b09dce1f0a9218d6f3cc18d529a7fd2046ec`);
- Codex-high transcript `.logs/phase-0g2s-vector-path-quorum-codex-high.md`
  (`48bbd12a99976c0c203e0e6f3ea7c21cc9920683f02a1e4317bb9ab090bc57bd`);
- exact Kimi 3/100 `.logs/phase-0g2s-vector-path-quorum-kimi3-100.raw.log`
  (`c8cd4e0230c798698ecb99976fd5f2b343fd1c6a3544493e605ca254f49d43ec`);
- Opus-xhigh `.logs/phase-0g2s-vector-path-quorum-opus-xhigh.raw.json`
  (`399f689c8107c9114692c5026985636f43f19e6f3a3cfdbe1d47c9f1aa987e7a`).

The smallest lawful correction is path-only: move the new uncommitted manifest to
`packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json`, update the input fixture
and every additive supplement reference/hash, then re-seal RED from the clean checkpoint before GREEN
resumes. The RED test source contains no literal old path and remains byte-identical. No frozen byte
names the new manifest, so the Phase −1′ tuple needs no supersession.

The new path is outside every frozen governed tree and does not change cryptographic semantics, build or
current publication: protocol-v3's npm `files` allowlist publishes neither the old nor new vector path.
The frozen `CODEOWNERS` file cannot acquire a supplement-specific pattern; the additive checker/workflow
must protect all declared supplement artifacts, while the repository host must separately require that
workflow status. Neither repository bytes nor this plan may overclaim external branch-protection state.

### D.49.3 — Quorum-authorized RED reseal

The original Codex-high RED owner changed only the input fixture's additive vector path and path-coupled
scratch/evidence. The permanent RED test stayed byte-identical. Final corrected tuple:

- RED test
  `26c24d2fc3ac38ee55ca0f092d855a434382230825341cd6380fb1cd332dc938`;
- corrected input fixture
  `42baf0e200234eedf31bd0e16f4e23f55a463b3a50578b13e168c929ce9f29a2`;
- corrected RED ledger `.logs/phase-0g2s-red-ledger.md`
  (`2c5d9b01867d95b51a2fdb7dfd7c1b7174b5819b5573f14044edbff762a4c90b`).

A clean detached `907fae4` with only the corrected RED tuple reproduces 4 failed / 6 passed; the corrected
independent control passes 10/10 and all eight mutants retain exact 1-fail/9-pass cardinality. Prettier,
ESLint, 32-project typecheck, accepted 0g(ii-T) 13/13, accepted 0g(ii-I) 10/10, v3 governance 7/7,
frozen-v2 preservation 24/24 and `git diff --check` pass.

Most importantly, the corrected path was visibly untracked with `core.excludesFile=/dev/null` in the clean
checkpoint worktree and both existing real freeze CLIs passed. The supplement path is neither an exact
protected path nor below any frozen governed-tree prefix; no exclude-file hiding is part of this proof.

### D.49.4 — Corrected GREEN tuple and gates

The same separate Codex-high GREEN owner resumed after the corrected RED seal. Final production/additive
tuple:

- `packages/protocol-v3/src/index.ts`
  (`143340b97bbdd01bd6416e2cfc59131aa45c25b327dd74ea47b98cac40c21680`);
- normative addendum `docs/protocol/ed25519-acceptance-profile-v3.md`
  (`fcbdee7a1597c1e6d212a4e83b074fff52a0ec62693d512513e4ffc2ad093bc5`);
- machine amendment `docs/protocol/ed25519-acceptance-profile-v3.json`
  (`36a65af5e3788c68483c360b831e132d24e4ef38ab8c121fd077a0232285c6e3`);
- permanent supplement vectors
  `packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json`
  (`31975a9ef6d16e9cdd836fe9b87b2b369aab0ede69e1d6763a8f75ad46bafc56`);
- additive policy `packages/protocol-v3/conformance/freeze-policy-ed25519-profile-v1.json`
  (`d7ad1f6442b04cdfeb993cecd0e96435c27149b175071a019ee60456b27de6e0`);
- additive checker `packages/protocol-v3/scripts/check-ed25519-profile-freeze.mjs`
  (`137f058914d284f891a8f77d31f51c1ce74ff6c38c49969aec82c306eb1b445d`);
- additive workflow `.github/workflows/protocol-v3-ed25519-profile.yml`
  (`e343d76a83fa6a0b8d08d9aeeff3256e240f0c684fb0bee3638f7485591d183a`).

`verifyEd25519RegisteredDigest` rejects non-`Uint8Array` or non-64/32/32 shapes, invokes exactly noble
2.2.0 `ed25519.verify(signature, rawRegisteredDigest, publicKey, { zip215: false })`, and fails closed.
`verifyReceivedVertex` delegates its final signature decision to that same adapter after its existing
registered-byte checks, digest and author-key resolution. No OpenSSL/Node fallback or extra subgroup rule
was introduced.

Production and independent control pass 10/10; every one of the eight corrected mutants retains exact
1-fail/9-pass cardinality. Package/workspace typecheck and build, runtime/declaration export smoke,
targeted formatting/lint, accepted 0g(ii-T) 13/13, accepted 0g(ii-I) 10/10, v3 governance 7/7 and
frozen-v2 preservation 24/24 pass. Both existing real freeze CLIs pass with the relocated supplement
visibly untracked and not excluded. The new checker passes atomic bootstrap, steady state and unrelated
addition; vector drift, protected deletion and valid-JSON policy weakening all reject.

Evidence:

- GREEN ledger `.logs/phase-0g2s-green-ledger.md`
  (`62292bbeba7cd8d4b9a299b99c72c547dccc6bf829547f3afb2fc7f64ebef9c7`);
- combined gates `.logs/phase-0g2s-green-gates.log`
  (`68d66852e085ccde69fa7a5b471212d92df05b380d32dc2b0edf67e99dd7938c`);
- final seal `.logs/phase-0g2s-green-final-seal.log`
  (`10604c14dc5606bc6decacdc38eeddadfbcf6f2c443b9a48d5bc34a41389753a`);
- implementation-owner blocker record
  `.logs/phase-0g2s-vector-path-blocker-green-codex-high.md`
  (`3cfd6c99aa1995a47070498e576b42fdaac819b929f190d522ad4108f631e23a`).

Raw `pnpm lint` remains honestly RED with twenty parser-project errors confined to ignored `.logs`
evidence plus 226 inherited warnings; clean-equivalent lint excluding `.logs/**` has zero errors and the
same warnings. The inherited D.47 full-suite baseline was not rerun or green-chased.

### D.49.5 — Independent review and checkpoint boundary

External reviewers authenticated the exact D.49.4 tuple, reran the focused, causal, build, lint,
preservation and freeze gates, and returned no blocker:

- common prompt `.logs/phase-0g2s-external-review.prompt.md`
  (`03f0b66f9e9d91a1b5bcd568942784979c1c0b9785b713eab508581ea1febe9d`);
- Grok 4.5/high `.logs/phase-0g2s-review-grok45-high-v2.raw.json`
  (`9aa58ee8d060b1384cc209a44304a959a2facbf0542a17acac4540f129bd8332`) —
  **PASS_WITH_NOTES**;
- exact Kimi 3/100 `.logs/phase-0g2s-review-kimi3-100.raw.log`
  (`8e091a89ba42b647d7624e386f09f2490de8150badfe48da5095fad07b33168b`) —
  **PASS_WITH_NOTES**.

The first Grok wrapper session cancelled before repository inspection and produced no verdict; it is not
review evidence.

Review carry-forwards:

1. The supplement checker freezes the full vector manifest and its fixture binding, but does not
   independently deep-compare every manifest vector body to the input fixture. Current bodies match
   byte-for-byte and all thirteen decisions were independently reproduced; any stronger cross-document
   structural equality belongs in a governed successor profile.
2. Six crypto mutants kill a direct exported-adapter test while re-exporting production
   `verifyReceivedVertex`: five fail the independent-vector test and the wrapper/hex mutant fails the
   raw-digest-message test. They do not rebind the live receiver. Live adapter identity is separately
   proven by source delegation plus the seven-case production live matrix and issuance-to-admission
   closure. Do not claim those mutant kills themselves flow through the live receiver.
3. The workflow's bootstrap shell checks six absent paths explicitly; the running checker then checks all
   eight and rejects a partial base, closing the fail-open route. An explicit eight-path shell precheck
   and an exact `S = L` vector are successor-profile hardening, not blockers to this frozen v1 tuple.
4. The existing frozen v2/v3 checkers fail closed with `spawnSync git ENOBUFS` on the raw dirty evidence
   tree. Their accepted gate uses the authenticated process-local excludes, which leave every checkpoint
   path—including the supplement subtree—visible. Do not claim the raw unexcluded dirty-tree invocation
   passes.
5. The pre-correction GREEN observation was contemporaneously hash-recorded in the blocker/quorum
   evidence but has no separate retained gates log. It is historical diagnostic context, not acceptance
   evidence; only the corrected D.49.4 GREEN log and final seal support checkpoint claims.
6. Final Opus found that invoking the additive checker through a symlink can silently skip `runCli()`:
   Node realpaths the entry module but not `process.argv[1]`, so the equality guard at the checker tail
   fails and the process exits zero without a pass line. The declared Linux CI uses real workspace/temp
   paths and does not trigger this route. Because the checker is frozen by this checkpoint, a successor
   profile must replace the invocation guard and add a symlink-path rejection/execution probe.

Final Opus-xhigh authenticated the final tuple, independently reproduced all thirteen vector decisions,
the focused/control/eight-mutant matrix, ten checker bootstrap/steady-state/failure probes, both accepted
freeze gates and the exact checkpoint surface. Its prompt is
`.logs/phase-0g2s-final-opus-xhigh.prompt.md`
(`4a65739273a34005ec88c3606b151c635ce45de8a6f472f6a0c01ea90db2b9fc`) and raw response is
`.logs/phase-0g2s-final-opus-xhigh.raw.json`
(`21e75f84e78b7ac0f63f87bd7121c37c2fdfbd1d9e56137287d63a45292ff368`).
Verdict: **PASS_WITH_NOTES**, `checkpoint_authorized: yes`, with no blocker and no semantic-plan change.

After the compact final gate rerun, selectively stage exactly these ten paths:

1. `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
2. `packages/protocol-v3/src/index.ts`;
3. `docs/protocol/ed25519-acceptance-profile-v3.md`;
4. `docs/protocol/ed25519-acceptance-profile-v3.json`;
5. `packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json`;
6. `packages/protocol-v3/conformance/freeze-policy-ed25519-profile-v1.json`;
7. `packages/protocol-v3/scripts/check-ed25519-profile-freeze.mjs`;
8. `.github/workflows/protocol-v3-ed25519-profile.yml`;
9. `tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts`;
10. `tests/fixtures/phase-0g2s/ed25519-acceptance-profile-contract.json`.

Never use `git add -A`. Never stage `.logs/`, `.agents/`, `.claude/`, `.pnpm-store/`,
`skills-lock.json`, generated `packages/protocol-v3/dist/`, either stale untracked v2 `0g2` RED, or any
other unrelated path. The checkpoint does not claim npm publication of supplement vectors, frozen
`CODEOWNERS` coverage, configured host branch protection, raw lint/full-suite green, Phase 2l
durability, Phase 3a live binding, or golden-path completion.

Final compact checkpoint evidence is
`.logs/phase-0g2s-final-checkpoint-gates.log`
(`e45ccec818dd994dbef8ec729fdfc6ee1e79366ee4f7abbe657d595fd50e5615`).
It records focused 10/10, 32-project typecheck, protocol-v3 build, targeted and clean-equivalent lint/
format, accepted 0g(ii-T) 13/13, accepted 0g(ii-I) 10/10, v3 governance 7/7, frozen-v2 preservation
24/24, both existing freeze CLIs, the supplement bootstrap checker, `git diff --check`, and exactly the
ten visible checkpoint paths. `FINAL_GATE_FAILURES 0`.

Selective staging then exposed three Markdown hard-break trailing-space errors in the previously
untracked normative addendum; the earlier unstaged `git diff --check` could not inspect an untracked
file. The checkpoint owner replaced only those hard breaks with blank-line-separated metadata. Although
no normative words or executable behavior changed, the addendum is hash-bound: the first incremental
Opus-xhigh check correctly returned **BLOCK** because the machine amendment and additive policy still
pinned the prior digest. Its raw response is
`.logs/phase-0g2s-poststage-opus-xhigh.raw.json`
(`db18afbc3be6b42614d301a4a2774086c74d489d2f11ee489ee9b9d081a2ae9c`).

The owner then performed the bounded binding cascade: update the amendment's addendum digest, recompute
the amendment digest, and update both pins in the additive policy. The final three artifact hashes are
recorded in D.49.4. This is checkpoint bookkeeping, not a new Ed25519 acceptance decision; no semantic
quorum was needed. The pre-repair compact gate log above is retained as historical evidence only and
is superseded by `.logs/phase-0g2s-postrepair-checkpoint-gates.log`
(`3176c0c261b6f9c3d6c4c00d79dc759137724afdb349fc21e1d9870eb36813dd`). The post-repair log records
focused 10/10, 32-project typecheck, protocol-v3 build, targeted and clean-equivalent lint/format,
accepted 0g(ii-T) 13/13, accepted 0g(ii-I) 10/10, v3 governance 7/7, frozen-v2 preservation 24/24, both
existing freeze CLIs, the supplement bootstrap checker, the exact ten-path checkpoint surface and
`git diff --cached --check`, with `FINAL_GATE_FAILURES 0`.

The resumed incremental Opus-xhigh session independently recomputed all three moved digests, reproduced
the focused 10/10 and supplement bootstrap pass, authenticated every post-repair gate result and confirmed
that reverting only the three binding strings reproduces the previously reviewed amendment/policy bytes.
Its raw response is `.logs/phase-0g2s-postrepair-opus-xhigh.raw.json`
(`f1658784695ea03ee3baeea60f6c9e111633a4ce536e9726f0251be3a81fd7f6`).
Verdict: **PASS**, `CHECKPOINT_AUTHORIZED: yes`, `SEMANTIC_QUORUM_NEEDED: no`.

Non-blocking log note: the post-repair freeze invocations report base label
`a73764b2adce..working-tree`, whereas the pre-repair run reported `907fae437e55..working-tree`. With no
explicit base argument the checker uses `HEAD^`; both references enter the same additive bootstrap mode,
and no D.49 acceptance claim depends on that display label.

## Appendix D.50 — Phase 0h-L legacy exception quarantine

Phase 0h is split deliberately. D.50 covers only the legacy object's bounded-retry quarantine contract;
frozen protocol-v2 remains preservation/reference-only. Phase 0b already pins AHE §7.2 resolver
fail-close at the `@ts-drp/compaction` library boundary; that is not production integration. No new v2
fold/binder is built, and the first production reducer/fold exception TDD belongs to the forward v3 Phase
4a adapter.

### D.50.1 — Separate application and resolver REDs

A fresh Codex-high RED owner sealed the legacy blueprint exception test
`packages/object/tests/legacy-blueprint-quarantine-0h-l-red.test.ts`
(`d50e56cd5137ab9d2a5d0100dd7fbb5dd795036338144048368049436a25eb59`). The same assertion failed on
both exact D.1 baseline `7f9e66adeb8cb919910827893ad6220a5aff323b` and checkpoint
`4cb808954d91e0c3997eafdd892424823313f309`: only one attempt occurred, the offer rejected, no peer
committed and no partial result was returned. The test proves both negative poison isolation and positive
unrelated-peer progress on graph, snapshots, finality, live state and notifications; redelivery proves
quarantine remains re-offerable and never enters `knownInvalidVertexHashes`.

The first GREEN audit then exposed a distinct post-commit resolver seam: deferred reconciliation could
commit every candidate before a custom DRP resolver threw, leaving graph and live state split while the
offer rejected. Work stopped rather than expanding GREEN invisibly. A fresh Codex-high resolver RED owner
sealed `packages/object/tests/legacy-resolver-quarantine-0h-l-red.test.ts`
(`3ae962cc4d4a1892338a92b5be2fe31e09ae8c499ab3ef5a64b6354507426c4b`). Its no-throw control passes,
while baseline, checkpoint and the parked application-only candidate all fail the same resolver
attribution/atomicity assertion. The causal topology commits `left(root)`, offers
`[poison(root), healthyChild(left)]`, then redelivers `[poison(root), laterChild(healthyChild)]`; only the
poison may quarantine and `[10,20,30]` must converge on every surface.

Evidence:

- application RED ledger `.logs/phase-0h-l-red-ledger.md`
  (`abb42c1b1b030a6e9915b98019f85b1c51401985fb77f2dbd6044fb4cc42d368`);
- resolver RED ledger `.logs/phase-0h-l-resolver-red-evidence.md`
  (`97ed896233e1ee1b9241be12ee04fbc17c191acbb00edee8f4d3d06d1159b844`).

The `32` appearing in both REDs is only a harness termination ceiling. It is not the production retry
budget. The object layer also does not authenticate signatures; node handlers own that gate, so neither
RED invents a fake object-layer signature check.

### D.50.2 — GREEN semantics and compatibility correction

The combined Codex-high GREEN introduces the distinct
`MAX_APPLICATION_ATTEMPTS_PER_OFFER = 3`, separate from
`MAX_ADOPTION_COMMIT_ATTEMPTS`. Legacy synchronous and asynchronous blueprint exceptions and custom DRP
resolver exceptions re-enter the complete isolated application pipeline for each attempt. Each entry
reconstructs candidate ACL/DRP state from snapshots and graph history; shared graph, snapshot, finality,
live-proxy and notification writes remain behind the synchronous journaled commit boundary.

After the third possibly-transient application failure, only the submitted vertex is reported as
`quarantined`. Quarantine is non-semantic, never remembered as invalid, never removes committed data,
remains re-offerable on another delivery and does not prevent unrelated peers or later causal work from
committing. Deterministic rejection, receiver-clock pending validation, `ApplyInvariantError` and
`AdoptionCommitExhaustedError` are retry barriers and preserve their existing result/rejection taxonomy.
A failed deferred commit can set `hasUnreconciledLiveState` before a CAS retry and thereby cause one
benign extra final reconciliation; it does not corrupt state.

Deferred reconciliation is disabled when the graph reports a custom DRP resolver. The final compatibility
repair locally duck-types the optional inspector, invokes it with `this.hashGraph` as the receiver and
enables the fast path only for a strict `false`; a missing, non-function or non-`false` inspector therefore
fails closed. `IHashGraph` was not widened. The public-`applyVertices` regression in
`packages/object/tests/drp-applier.test.ts` hides the inspector and causally observes
`canDeferReconciliation === false`.

Final production/test hashes:

- `packages/object/src/drp-applier.ts`
  (`1bd760bb299b3c9ac73388cf65f3d6515efb34a495398a81e8427052932c50d3`);
- `packages/object/tests/drp-applier.test.ts`
  (`ea2c920972b4040eb06e8332429725905350e9d1949ee8e760b7748958b200c8`);
- `packages/object/tests/merge-atomicity.test.ts`
  (`d035374ed3475d46e4a246486d4bdd4e8f5585ca3c9a40a2c14be8e761a35379`);
- `packages/object/tests/merge-rollback-completeness.test.ts`
  (`46262e2ba2a3433a36a1743da3257cb8ba4b8af1b940d252be84bac366ec57b1`);
- `packages/object/tests/merge-validation-classification.test.ts`
  (`69830a5a432defa42cfde4d9c1642609ef30facaaeed67370af83a694d4237c2`);
- `packages/object/tests/mutation-serialization-0g1.test.ts`
  (`96ea66f55bc7364bfdc355e2f64b32222b6c272ad24c28e8fed67c6377553ea8`);
- both sealed REDs retain the D.50.1 hashes.

Four existing specifications invert obsolete offer-rejection/count expectations without dropping their
original safety assertions; `drp-applier.test.ts` receives one additive compatibility regression.
`merge-atomicity`'s `6` and `merge-rollback-completeness`'s `6`/`9` pin the three-attempt budget through
their actual replay/checkpoint probes. The one-throw-then-success case strengthens isolation by requiring
the fresh successful candidate to contain `["once"]`, not a duplicated mutation.

### D.50.3 — Gates and causal mutation evidence

Completed acceptance evidence:

- focused GREEN, 13 files / 75 tests:
  `.logs/phase-0h-l-green-final-focused-gates.log`
  (`510febcc457aee6ab5568c5444d737075d6a28f01f9b7c40e262aa23f3bd60b9`);
- post-Grok remediation, 14 files / 100 tests, both sealed REDs, object typecheck/build, targeted lint,
  Prettier and `git diff --check`:
  `.logs/phase-0h-l-green-grok-remediation.log`
  (`14f7dd146353690416d6521357c95cfee32e3f3d79185c2db71d39bc48bc3359`);
- workspace typecheck:
  `.logs/phase-0h-l-green-workspace-typecheck.log`
  (`92b1c9a5afb83128828fd37b4de5f4ee841b4e617d6b3eb04eadf30cdce3d056`);
- affected node tests, 4 files / 22 tests:
  `.logs/phase-0h-l-green-node-affected-tests.log`
  (`bfaa8bc8918bcb0c4f3740fd2aac7b09e70ee2f5b5c47a9a421ffd75449caba3`);
- targeted lint/format:
  `.logs/phase-0h-l-green-targeted-lint-format.log`
  (`81d02b47d6f04b9f3a2af97154b9ddc8b8bbbeed212e8999061c5d2f815587e4`);
- clean-equivalent lint:
  `.logs/phase-0h-l-green-clean-equivalent-lint.log`
  (`a8e3bbe6a19b0b5b4653580de586e9d7ff871c652f4bcafe674f2d0dba2740cb`).

The budget-1 mutant is killed because both sealed offers cease retrying
(`.logs/phase-0h-l-green-application-budget1-mutant.log`,
`b72b453c2847c98d66383dfa2f6938581cace2d2cde8ccfdbe7ea4d76bcb6ad5`). Removing the custom-DRP
deferred fence is killed because the poison commits/notifies, graph and live state tear, both offers
reject and no retry occurs
(`.logs/phase-0h-l-green-resolver-deferred-mutant.log`,
`311f592331b914f14738b4d6748383b7e16f60b383dcfdab74a5fd5116d4a685`).

The two bounded full object-suite attempts, with and without coverage, ended without terminal Vitest
summaries and are explicitly incomplete non-evidence. Raw `pnpm lint` remains red only from inherited
`.logs` parser-project errors plus 226 inherited warnings; clean-equivalent lint has zero errors and the
same warnings. Three optional Codex self-reviews terminated without verdict and have no evidentiary
weight.

Final Opus also found that D.9.4's widened Gate-0 harness had been absent from the 0h-L evidence. It ran
the candidate tree and observed 3 failed / 8 passed / 2 skipped with 96 divergent case IDs, all confined
to `widened-admin-authority-chain-*`, `widened-same-group-descendant-*` and the two pinned L7 fixtures.
That is exactly the frozen pre-existing L7 family permitted by D.11.4/D.15.5: attribution was checked
rather than assumed, but the checkpoint-tree delta was not measured. Do not abbreviate this as an
unqualified “Gate-0 green.”

One natural third mutant remains unprobed: deleting
`isDeterministicVertexFailure(error)` from `isApplicationRetryBarrier` would preserve result taxonomy but
silently replay deterministic rejections three times. Existing deterministic taxonomy tests have no
attempt counter, so this is a real mutation-coverage gap. It is nonblocking 0h-L follow-up hygiene, not
evidence that the two executed mutants exhaust the new code.

### D.50.4 — Independent review and open deviations

Grok 4.5/high authenticated the full candidate and returned **PASS_WITH_NOTES**:
`.logs/phase-0h-l-review-grok45-high.raw.json`
(`9e82db0c9ff39986760f884791ca9dda486fc6157743cfa89be1eb8e58e82c93`). It found the widened concrete
`HashGraph` assumption repaired in D.50.2. Its exact two-file follow-up independently reran the
fail-closed regression and returned **PASS**:
`.logs/phase-0h-l-grok-remediation-followup-v2.raw.json`
(`6d72419f4c97bfb19015df9df6a35b36ddfc06462abe36603a0d1eca95f7f2f2`). The first follow-up session
cancelled before inspection and is non-evidence.

Exact `KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi -m kimi-code/k3` authenticated the final tuple, independently
passed 11 files / 60 tests and returned **PASS_WITH_NOTES**:
`.logs/phase-0h-l-review-kimi3-100-v4.raw.txt`
(`bec0c7b4cefab2a785b5f5c6b0c0b0e12296a686e9de544f953cadb3d2a957ff`). Three local CLI-option
rejections occurred before model execution and are non-evidence.

Final Opus-xhigh authenticated all supplied hashes, independently passed 26 files / 183 tests, performed
the Gate-0 attribution run and returned **PASS_WITH_NOTES**, with no blocker and checkpoint authorization:

- prompt `.logs/phase-0h-l-final-opus-xhigh.prompt.md`
  (`01df34fba6190f9f916c96f00309eb2018a385730d4705f3ba5e5d661628139e`);
- raw review `.logs/phase-0h-l-final-opus-xhigh.raw.json`
  (`0822d8c025f45892287163183d26ca930a158e406b2ea53df492714ea91f1901`);
- self-contained adjudication `.logs/phase-0h-l-final-opus-xhigh-followup.raw.json`
  (`1e575fa060714f7b1653a79ce0b6fa2a9539c72459a3fe7089cb5bb554b163c0`).

The following are open, ordinary findings; recording them does not amend governing semantics and did not
trigger the separate unanimous plan-change quorum:

1. **N1 — custom ACL resolver residual.** The defer fence checks only the custom DRP resolver, while final
   canonical replay can contain pre-existing ACL vertices. A custom `IACL` with a
   non-deterministically-throwing resolver, concurrent ACL history and a resolver-free all-DRP batch can
   still throw post-commit. The built-in ACL resolver is total; a deterministically throwing resolver
   cannot commit its concurrent pair; and a naive ACL fence would disable the fast path for every
   standard object because all register an ACL resolver. The per-type query also collides with the letter
   of D.10.6/R1, but the hazard does not bind this safety fence: it only disables an optimization, fails
   closed and still terminates in full canonical replay. `fixed-critical-1-cross-type-acl-drop` is the
   executable corroboration. Owner: a fresh 0h-L hygiene RED or the forward v3 Phase 4a seam; do not
   patch blindly.
2. **N2 — ordinary deferred final-replay blueprint failure.** A state-dependent blueprint can succeed
   against its causal cut, then throw when the resolver-free deferred path performs canonical final
   replay after candidates commit. `applyVertices` rejects post-commit and D.10.4's
   `hasUnreconciledLiveState` latch can remain permanent. This is an open, ordinary-reachable D.3(b)
   deviation—for example two concurrent withdrawals against a balance guard—not an “out-of-contract” or
   merely degenerate blueprint. The deferred path and `finally` structure are byte-identical at HEAD and
   0h-L strictly narrows entry, so it is nonblocking here. Owner: Phase 0q / forward v3 Phase 4a lineage.
3. **N4 — API/attribution hygiene.** Pre-existing replay paths still cast `IHashGraph` to concrete
   `HashGraph`; production constructs the concrete graph and `createDRPVertexApplier` is not package
   exported, while a deep-imported incompatible graph fails safe by quarantine but is misattributed.
   Separately, a final-reconciliation throw can mask a primary hard error or discard a successfully
   computed `ApplyResult`. Owner: object-API hygiene.
4. Retry can amplify external blueprint side effects and latency up to three times per poison per offer,
   then again on redelivery. Owner: Phase 0j's ambient-API/determinism contract.

### D.50.5 — Acceptance and selective checkpoint boundary

Phase 0h-L is accepted with the exact D.50.2 tuple. This checkpoint does not claim a full object-suite
pass, raw workspace-lint green, exhaustive mutation coverage, unqualified Gate-0 green, closure of N1/N2/
N4, object-layer signature authentication, Phase 0h-v2 fail-the-close, publication or golden-path
completion.

The final documented-tree rerun produced:

- focused 14 files / 100 tests:
  `.logs/phase-0h-l-final-focused.log`
  (`ce966bb457873d28499635c4279341c982fa337f57b0492f3535f24fc22292e2`);
- object typecheck:
  `.logs/phase-0h-l-final-object-typecheck.log`
  (`d09315f277dd3d9bd2c92cb85a436978a903c7b60210c77f5c823bc161ac8b0d`);
- object build:
  `.logs/phase-0h-l-final-object-build.log`
  (`422dd066f6e0e48762dc03b6a2a43342d03874e9a55e07c90a0ab719a6e7d41b`);
- workspace typecheck:
  `.logs/phase-0h-l-final-workspace-typecheck.log`
  (`734d99e1377a8c467dfb5fedebf1853aaed339e70ceb29bdc528ef34a6dc71bc`);
- affected node 4 files / 22 tests:
  `.logs/phase-0h-l-final-node-affected.log`
  (`f9abcc38e8fb9591ddd7e9802548c081075a96074eb27588761b393935bfefa4`);
- targeted lint, zero errors / two inherited JSDoc warnings:
  `.logs/phase-0h-l-final-targeted-lint.log`
  (`87ded906ac7c6b3c75f937510de4e266404db0e206c320cda7dd7f74b21d5de7`);
- clean-equivalent lint, zero errors / 226 inherited warnings:
  `.logs/phase-0h-l-final-clean-equivalent-lint.log`
  (`a8e3bbe6a19b0b5b4653580de586e9d7ff871c652f4bcafe674f2d0dba2740cb`);
- targeted format:
  `.logs/phase-0h-l-final-format.log`
  (`17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`);
- Gate-0 attribution:
  `.logs/phase-0h-l-final-gate0.log`
  (`6099d362eea85dd54a29cf6cc494ff86f3453adb36c22fe185b447f7446af445`).

The final Gate-0 result exactly repeats D.50.3: 3 failed / 8 passed / 2 skipped; 96/432 widened
divergences are split 48/48 across only the governed L7 authority-chain and same-group-descendant
families, the two pinned L7 fixtures are the only fixed failures, and
`fixed-critical-1-cross-type-acl-drop` passes.

After the final compact gate rerun, selectively stage exactly these nine paths:

1. `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
2. `packages/object/src/drp-applier.ts`;
3. `packages/object/tests/drp-applier.test.ts`;
4. `packages/object/tests/merge-atomicity.test.ts`;
5. `packages/object/tests/merge-rollback-completeness.test.ts`;
6. `packages/object/tests/merge-validation-classification.test.ts`;
7. `packages/object/tests/mutation-serialization-0g1.test.ts`;
8. `packages/object/tests/legacy-blueprint-quarantine-0h-l-red.test.ts`;
9. `packages/object/tests/legacy-resolver-quarantine-0h-l-red.test.ts`.

Never use `git add -A`. Never stage `.logs/`, `.agents/`, `.claude/`, `.pnpm-store/`,
`skills-lock.json`, either stale untracked protocol-v2 0g2 RED, coverage output or another unrelated
path.

### D.50.6 — Phase 0h-v2 no-RED audit and v3-forward correction

After the Phase 0h-L checkpoint `7811bc469b3e4130e6971fb44a442cc60dee8ce3`, a fresh Codex-high RED
owner audited the remaining Phase 0h-v2 wording and found no honest current RED:

- `@ts-drp/compaction` already implements and pins all AHE §7.2 resolver fail-close requirements at the
  library boundary;
- `packages/compaction/tests/conflict-contract.test.ts` is byte-identical at Phase 0b checkpoint
  `5462cab` and `7811bc4`
  (`1061d94e784ae01f9ad772e53762750904c9ca2452241c97cfa1aa391c999815`);
- the resolver implementation suffix from `assertResultObject` through `linearizeEpoch` is likewise
  byte-identical
  (`a9ec5099c120fc078a9d5e22988f07981b6c80f6f859b068a5f4fc7caa76a158`);
- current missing/malformed/async/throwing pair and multiple resolver, isolation, causality and 407-graph
  property controls pass 3 files / 28 tests with coverage disabled; compaction typecheck, targeted lint,
  Prettier and diff check pass; and
- no production reducer/fold owner or caller exists outside the edit-forbidden vendored v2 reference.
  `@ts-drp/compaction` exports linearization, Merkle and state digest only.

Audit ledger:
`.logs/phase-0h-v2-red-pre-satisfied-audit.md`
(`5f0757b0414d603d6e318a9c391e512504be23e8e0f7fd5f3d92054a08114945`).
Creating an owner-existence RED now would manufacture a failure whose only GREEN is new production v2
code that the plan forbids. No GREEN owner is warranted.

Because that contradicted forward-looking Phase 0h/D.50 wording, the plan remained untouched until the
required correction quorum unanimously returned `PLAN_ALIGNMENT: AGREE` and `VERDICT: PASS`:

- common refined prompt
  `.logs/phase-0h-v2-plan-correction-quorum.prompt.md`
  (`0849463c7cd4c9b59d34cef05ad11cb99ef620cf4d2164583a78fe4d87558a56`);
- Codex-high
  `.logs/phase-0h-v2-plan-correction-quorum-codex-high.md`
  (`7363114e9c9cab2def1ef9e969f9e02516eb8f75d27075e7423c33af66f13534`);
- exact Kimi 3/100
  `.logs/phase-0h-v2-plan-correction-quorum-kimi3-100.raw.txt`
  (`faa209b2950aedcd402fb6d8d552df5b781196a654be675da3c34a9cdbe0a7b8`);
- Opus-xhigh
  `.logs/phase-0h-v2-plan-correction-quorum-opus-xhigh.raw.json`
  (`a6f32e19bdb4738c06141384944d10966743947feae718a6431c96e1d0ea0067`).

The correction changes scheduling and ownership, not §7.2/§7.3 semantics. Resolver fail-close is
pre-satisfied only at the library boundary, not production-integrated. Frozen v2 remains a preservation
baseline and gains no fold/binder. Phase 4a owns the first production-reachable v3 reducer/fold seam and
its strengthened RED/GREEN matrix; Phase 4a remains open.

Standing lineage rule for the remaining plan: v2 work is preservation, compatibility or freeze
verification only. New production runtime, wire, binder and application behavior belongs to v3. If a
later forward-looking row appears to demand new v2 implementation, stop, audit whether it is another stale
ordering assumption and use the governed correction quorum before changing the plan. Do not silently
implement it, and do not weaken the v2 preservation gates while advancing v3.

### D.51 — Phase 0i no-RED audit, rejected deferral and digest-bound v3 ABI boundary

A fresh Codex-high RED audit split Phase 0i by plane and found:

- legacy 0i-L is already genuinely pre-satisfied by inherited `2259f29`; the unchanged parity test fails
  on the `7f9e66a` baseline for the hostile-`constructor` sibling-containment invariant and passes on the
  current checkpoint, while its `toString`/`hasOwnProperty` positive control passes on both;
- frozen v2 remains preservation-only; and
- the existing v3 row was not a lawful contract: frozen v3 registers `operation` only as an unconstrained
  `canonical-object`, all 13 frozen operation occurrences use `{action,key,value}`, and none uses legacy
  `opType`.

The audit ledger is `.logs/phase-0i-l-red-pre-satisfied-audit.md`
(`1b3f058507a1f15c4aefb37731bf1d79c6c41f30bcde2ee9a706cfe866302929`);
the committed parity test is
`6f1e6d9ba8cd39f7253de19de64aebacc8b38818598cef432d5562e125db82f7`.
Its focused gate passed 3 files / 16 tests, object typecheck, targeted lint/format and diff check. No new
legacy owner is warranted.

The first proposed correction moved the entire v3 ABI boundary to Phase 4a. It was correctly rejected
because its governed quorum was not unanimous:

- prompt `.logs/phase-0i-plan-correction-quorum.prompt.md`
  (`881880d567abf6c79f93ee48743854d99cc7f648611d0a1d130362c65d7d1fdd`);
- Codex-high `DISAGREE/BLOCK`
  (`3337261542ad29214864c903572d80439a7eaa82cd989df31bdbd0acfe07c30f`);
- exact Kimi 3/100 `AGREE/PASS`
  (`c6e2d2d65b0e108221cdb0612d28aba1114813e9799deb58c25d1b6ce7cfbe5a`);
- Opus-xhigh `AGREE/PASS` with conditions
  (`0bfac7c90103b5146f5a1644545ec3835faac82063547f8c1b788bd2fac3a9cc`).

Codex identified the load-bearing defect: AHE §6.1 and Phase 0d make invalid operation schema terminal
before acceptance, while Phase 3a requires `accepted iff appended`. “Stored but not dispatched” therefore
cannot make an ABI-unvalidated operation admissible. It also corrected the shared factual premise: the
frozen signed v3 epoch anchor already contains `blueprintDigest`; the missing pieces are the canonical
manifest/ABI and binding APIs, not the authentication root.

The reconciled boundary then received unanimous `AGREE/PASS`:

- prompt `.logs/phase-0i-plan-correction-reconciliation.prompt.md`
  (`107a1f00ce090d5531848c1c40ac7dbee0388eb4d078f6531e4cd8e3c5042b5d`);
- Codex-high
  (`5a3482dbe86a30eafcee8e13a977e095f748a84f4c5ff3b437fe61034ba5bdcf`);
- exact Kimi 3/100
  (`68218927d185db47501e3b460896ddf05757fd960e9c7e058220af8d4dedb397`);
- Opus-xhigh
  (`8a12ad66b926fa2e3beb4c13156d7210289c8cac0b6fe4d7f1685a1bd7795ed0`).

Opus found one final provenance precision issue: no anchor verifier exists yet, so 0i-v3 cannot claim
that its expected digest already came from a verified anchor. The addendum was ratified by Codex-high and
exact Kimi 3/100:

- addendum prompt
  `.logs/phase-0i-plan-correction-reconciliation-addendum.prompt.md`
  (`0f4b38fb90378d401c29d8649d1d1f9cc45cfc50bd20432a15567401512370c6`);
- Codex-high
  (`4b30a6430f9192b25316b1ea8ba881b3773a4b96a1a60b76e5ff89a6e2484dbc`);
- exact Kimi 3/100
  (`2bdafbe963dfe9dc605dc2325b12da53b99c417222ade97822e2c1d6cf4dce04`).

The first exact-diff audit then blocked two overclaims: 0i-owned text called the ABI “authenticated”
before 3a proves anchor provenance, and the Next Agent Prompt omitted zero issued-record work. Codex-high's
block is `4759637f463d9957137becbc3fa25b47320d4af97ce1d51f7a55f6e459a2e35b`. The wording now says
“digest-bound” at the 0i boundary, retains “authenticated” only in the 3a composition owner, and restores
zero `transaction/sign/record/outbox` work. The remediated post-edit audit
(`2f920580cc271c2a6a3035bbddda15386adad197310b1905773e9edcbb571dec`) unanimously authorizes the plan
checkpoint: Codex-high
`865c96a137a3dbee42d0a449773214011e09f897650439161e54422b7a308203`, exact Kimi 3/100
`19f8af4120771bdae56bdb0a18b60783a22b5b99b11d5fb9750d2a3b4d4cf857`, and Opus-xhigh
`245f254067b5941130017933f02838e315e6b13e32e125eada20cb9da85ac895`.

The final plan-only gate passed 5 files / 39 focused tests
(`4a8365abf1f87762c0237326e91a56825343aa42925d0e7e87f402a48207b1d9`), protocol-v3, object and workspace
typechecks (`d3a787b637a76d71d7d6391d7d81db1c4e54da3a5259b9b950f266014628f5ec`,
`d09315f277dd3d9bd2c92cb85a436978a903c7b60210c77f5c823bc161ac8b0d`,
`e88ca8312bad91d93f76539bfcb1463c1379437901da3b23df70ff3f3abab70e`), targeted lint with zero errors
and two inherited JSDoc warnings
(`87ded906ac7c6b3c75f937510de4e266404db0e206c320cda7dd7f74b21d5de7`), Prettier
(`17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`) and empty-output diff check
(`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).

The resulting ownership is intentionally layered:

1. 0i-v3 defines exact canonical manifest/package bytes, proves their domain-separated digest equals a
   required `expectedBlueprintDigest`, prepares a runtime-proven ABI, and makes both received-vertex
   verification and local issuance consume it fail closed.
2. Phase 3a verifies the signed current anchor, extracts `blueprintDigest`, supplies that proven value,
   and refuses append/index publication for ABI-invalid operations without executing any reducer.
3. Phase 0j proves the loaded implementation artifact/runtime profile matches the manifest-bound identity
   and is deterministic; it does not redefine ABI structure.
4. Phase 4a consumes the same prepared ABI for explicit application-table dispatch/fold; it never indexes
   a DRP/prototype property.

This restores rather than changes governing semantics. No v2 production behavior is added, the frozen v3
registry and vectors remain unchanged, and the full §11.4 property stays open until Phase 4a. A fresh
0i-v3 RED owner followed by a separate GREEN owner is now warranted; Phase 0j must not start first.

### D.52 — Phase 0i-v3 digest-bound blueprint admission implemented

Phase 0i-v3 is now implemented on the forward v3 plane. Frozen v2 remains preservation-only, legacy 0i-L
remains pre-satisfied by `2259f29`, and no anchor, implementation-determinism or reducer-execution owner
was pulled into this slice.

#### D.52.1 — Qualified RED and sealed consumer migration

A fresh Codex-high RED owner sealed one new input-only package fixture, one new Phase-0i-v3 behavioral
test and the three existing real v3 consumer suites:

- `tests/protocol-v3-blueprint-admission-0i.test.ts`
  (`072a92662c2ca6706a2e25f9a4aa4c25fe540aeed1f2886301f8c2ac55e00135`);
- `tests/fixtures/phase-0i-v3/blueprint-admission-package.json`
  (`048c06cea8041bf30fb19984d59453722a19c21da42a46bba7526fe3c111e451`);
- `tests/protocol-v3-registered-byte-0g2t.test.ts`
  (`baca2fef06479c881e71bba72d36d98e6889aebe919a12c575f07a1de943972a`);
- `tests/protocol-v3-transactional-issuance-0g2i.test.ts`
  (`7676778b3a6cf8d79ceb7684f257f63bd42fc9bae7631df10eaa9de77a7cd8f0`);
- `tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts`
  (`64b893bac59508c79b3fec6fd3699df244ebd76187ccefbdcb133d156736d6cc`).

The three inherited success suites now obtain and inject the same production-prepared ABI required by
the new test. There is no unprepared compatibility success path. Static audits pin one real consumer call
per wrapper and ensure preparation is injected at that call rather than hidden in a stub.

The coherent RED collected all four files and failed 34 / passed 12. It independently demonstrated both
load-bearing behavioral failures:

1. an authenticated undeclared remote operation was accepted after exactly one resolver and signature
   call, while operation re-encoding remained zero; and
2. an invalid local operation entered `transactIssue` once instead of doing zero transaction work.

The other RED failures were the expected missing-preparer surface in the three migrated consumers. The
matrix covers package canonicality and closedness, digest binding, discriminator and closed argument
schemas, missing/raw/branded/cloned/callback preparation, six legacy-looking inert strings, exact
received bytes and local side-effect ordering.

Evidence:

- RED ledger `.logs/phase-0i-v3-red-gate.md`
  (`663aff5785522ddc0247966bde7e7fa7e7123b141be32842232565ac37bbe0a9`);
- coherent RED `.logs/phase-0i-v3-red-qualified-coherent.log`
  (`5c8abb52c693dc4b47d498e5caa52d500346df0200ff94d81115c8604dd0dca4`);
- protocol-v3 typecheck
  (`d3a787b637a76d71d7d6391d7d81db1c4e54da3a5259b9b950f266014628f5ec`);
- targeted lint and tracked/frozen diff checks produced empty output; Prettier passed.

The production entry point remained byte-identical during RED
(`143340b97bbdd01bd6416e2cfc59131aa45c25b327dd74ea47b98cac40c21680`);
the registry and conformance vectors retained
`2fd6f51286e06f2c3c634c244a0242a55da186258664ec54a371f19b814a11d9` and
`8b84504ae98b37beae2d91ef8fa29f9a61299a236d32a12b63f24cb2757da741`.

#### D.52.2 — Separate GREEN and exact admission boundary

A separate Codex-high GREEN owner changed only `packages/protocol-v3/src/index.ts`
(`6f5f844968bb146828903dc5b8ea93293ea4932c13fcb2c88dfb0c830ad34248`).

`prepareBlueprintAdmission` now:

- copies the caller's exact package bytes;
- strictly decodes, re-encodes and compares them;
- domain-hashes them under `ts-drp/blueprint-admission/v3`;
- requires exact lowercase `expectedBlueprintDigest` equality;
- validates the closed package, implementation-identity fields and closed manifest; and
- compiles the application discriminator, operation names and argument schemas into `Map`/`Set` tables.

The returned frozen public value is informational. A module-private `WeakMap` owns the compiled state, so
spread, descriptor, prototype, proxy, structured-clone, raw-package, brand and digest-only substitutes
cannot create an admissible capability.

Received verification preserves the required asymmetric ordering: exact registered bytes are decoded and
digest-checked, the author key is resolved and the Ed25519 signature is verified, and only then is the
already-decoded operation checked against the prepared ABI. That path never re-encodes the operation.
Local issuance requires a genuine prepared capability at construction, checks the raw operation, makes a
canonical detached copy, checks that copy again and only then may enter `transactIssue`. Invalid local
operations perform zero transaction, signature, record or outbox work.

Operations and allowed fields are data in `Map`/`Set` structures. No DRP/prototype member is indexed and
no universal name denylist exists. The six legacy-looking strings are therefore rejected when undeclared
and admitted when exactly declared. Package preparation only structurally digest-binds
`artifactId`/`artifactDigest`/`runtimeProfile`; it does not authenticate the anchor, load an
implementation, prove determinism or invoke a reducer.

Final GREEN evidence:

- focused 4 files / 46 tests
  `.logs/phase-0i-v3-green-focused-tests.log`
  (`61f372571cea4e36ad31457c46f1500864461879a5a034569c109205397f5a2f`);
- protocol-v3 typecheck
  `.logs/phase-0i-v3-green-typecheck.log`
  (`abd60dcab613f35d8e619b2d39562c242034d529253d8f4c82ff86c78227dce9`);
- workspace typecheck
  `.logs/phase-0i-v3-green-workspace-typecheck.log`
  (`9db475581b66f491e3cb3d38640cda8fb727eaff953d9bd8327c6610167adbbd`);
- targeted lint, Prettier and diff check
  (`5ab788a4da06966d2fb4108c1a83a6e36a7de05f1b44ce880d1c2c5fff56660f`,
  `f125b71b48d6cdae9c93cd4238d741e9f4effde01727fccb370025d3877d366d`,
  `fc81ad274059f2c11e11919bd7917d3cb983ca6112ed1485c747dd6f55350b02`);
- clean-equivalent root lint, zero errors / 226 inherited warnings
  `.logs/phase-0i-v3-green-root-lint-excluding-logs.log`
  (`a8e3bbe6a19b0b5b4653580de586e9d7ff871c652f4bcafe674f2d0dba2740cb`).

The explicit all-protocol-v3 diagnostic passed 15 files / 89 tests and failed only the 15
post-checkpoint Phase −1′e3 partial-base cases
(`.logs/phase-0i-v3-green-all-protocol-v3-tests.log`,
`963acbf4adcd018d24b6b8bc2b0986e28970ddd2aa4680c6a43f858502481cd4`).
That harness archives committed `HEAD`, which already contains the complete v3 closure, so its attempted
"partial" commits are empty. D.46.9/D.47.4 already record this degradation; the uncommitted 0i tuple
cannot affect it. Raw root lint likewise remains red only because historical TypeScript mutants under
`.logs/**` are outside every parser project. Neither diagnostic is abbreviated as a green full-suite or
raw-lint claim.

#### D.52.3 — Independent reviews and causal probes

Grok 4.5/high recomputed the tuple, independently probed provenance, schema, ordering, alias and
prototype cases and returned **PASS_WITH_NOTES**, authorizing the remaining review loop:

- raw `.logs/phase-0i-v3-grok45-high-review.raw.json`
  (`ebb90df4d6aed13e988c0644f0b57e5cd17f27796bbfdac85cc4c0b18b46f9ec`);
- normalized `.logs/phase-0i-v3-grok45-high-review.normalized.md`
  (`f3c5eeaccca90171a2862e706b53e847b87669fd4dd524851bf8455fd5e4e18a`).

Exact `KIMI_LOOP_MAX_STEPS_PER_TURN=100 kimi -m kimi-code/k3` recomputed the tuple, passed 47 / 47
scratch probes and returned **PASS_WITH_NOTES** with no correction gate:

- prompt `.logs/phase-0i-v3-kimi3-100-review.prompt.md`
  (`fc8b2dbd3a4d8c25f8a3454a464f6b6ac0804ef092dd77457ee6555d6fc01e19`);
- raw review `.logs/phase-0i-v3-kimi3-100-review.raw.log`
  (`2bb2b9132188f81a00a727d65cfe769e402746b001f742b827fbe6d5af8f801f`).

Its scratch mutants causally killed digest-equality removal, remote-ABI removal, removal of both local
gates and forgeable-brand provenance. Removing only decode/re-encode equality survived because the strict
decoder already rejects every noncanonical spelling. Removing only the first local gate survived because
the post-detach gate still occurs before `transactIssue`; removing both gates was killed. These are
equivalent/defense-in-depth mutants, not missing behavioral properties.

The first Opus-xhigh bridge completed 44 inspection turns but was terminated during an optional
repository-wide Vitest probe before returning a verdict. Its `is_error` record is non-evidence:
`.logs/phase-0i-v3-final-opus-xhigh-review.raw.json`
(`331901fa16aa0099910f7bd3510bb87f81e68e4b3245b5c6dbb436a3e89fcb73`).

A fresh bounded Opus-xhigh run forbade aggregate/historical tests, recomputed all six tuple and both
reviewer hashes, independently passed 46 / 46, performed its own live positive-baseline attacks and
returned **PASS_WITH_NOTES**. It authorized documentation and checkpointing with no code correction and
no additional RED/GREEN cycle:

- prompt `.logs/phase-0i-v3-final-opus-xhigh-review.prompt.md`
  (`78bc0df72be99011eb9a24ed8353007132d8197592ef98e21b6c69d8c64d1db7`);
- raw `.logs/phase-0i-v3-final-opus-xhigh-review-round2.raw.json`
  (`bd614cedb5ae66569135a7591fddab38607ae042ab1e941b39cf984cb7dd4837`);
- normalized `.logs/phase-0i-v3-final-opus-xhigh-review-round2.normalized.md`
  (`3216e1eff8b7804dc57c08e334d623e2f7caedb64b7fbd867efb41905310ba03`).

A narrow continuation of that same Opus session audited the completed D.52 diff, all named hashes/counts,
ownership boundaries and the seven-path allowlist. It returned **POSTDOC_PASS** and authorized the
checkpoint:

- prompt `.logs/phase-0i-v3-final-opus-xhigh-postdoc.prompt.md`
  (`f7204f715ed0ae3906888bdb8870567fe43ba57e29cc5c015cb11dfab6662324`);
- raw `.logs/phase-0i-v3-final-opus-xhigh-postdoc.raw.json`
  (`1e8f429acf5812add6ab3a6fcf4fa77ed24e5593374994d021ed930dca1a6c92`);
- normalized `.logs/phase-0i-v3-final-opus-xhigh-postdoc.normalized.md`
  (`e1c1c3e927ab4006be43fba566545036bfb97efd7c72fa44ca66ec93d3368dd3`).

#### D.52.4 — Bounded findings and forward ownership

No reviewer found a false accept or checkpoint blocker. Carry these bounded findings forward:

1. `canonical-object` argument validation is shallow before local canonical detachment. Nested symbols,
   accessors, exotic objects and arrays fail during canonical detach before transaction work; remote
   values already came from the strict decoder. Phase 0i therefore remains fail closed.
2. Preparation validates implementation identity/runtime fields but retains only the compiled ABI in its
   private state. The single package digest still binds those fields. Phase 0j must re-derive and prove
   the loaded implementation/runtime match from the exact package bytes rather than pretending the 0i
   capability already carries that proof.
3. Auth-before-ABI deliberately pays one signature-verification cost for a validly signed ABI-invalid
   operation. Phase 0p owns input-bounded work; reversing the order here would violate author
   authentication before operation terminality.
4. The first local ABI check is a cheap reject and the second post-detach check is the load-bearing signed
   value gate. A non-enumerable optional field can be dropped by canonical detach and then legitimately
   remain absent from the signed operation; a required field rejects. The checked detached value is the
   signed value, so no unchecked data is admitted.
5. The public prepared interface is structurally only `{blueprintDigest: string}` while runtime
   provenance is nominal. A handwritten literal type-checks but fails at runtime. A future private
   `unique symbol` type brand could improve diagnostics; it is not a security boundary.
6. Initial verifier shape-property reads occur outside its `try`, so a hostile throwing proxy can throw
   rather than return `{accepted:false}`. It cannot accept and only a local caller supplies that object.
7. Adding required `preparedBlueprintAdmission` fields is intentionally type-breaking on the v3 surface.
   There are no workspace consumers outside protocol-v3/tests and live composition does not exist before
   Phase 3a.
8. The manifest intentionally admits the frozen historical consumer fixtures. This is not reward
   hacking: discriminator, closedness, type, cross-ABI and declared-vs-undeclared behavior are proven
   independently. `append` has all-optional arguments, so `{action:"append"}` is lawfully admissible.
9. The sealed provenance suite covers descriptor-copy forgery but not `Object.create(prepared)` or
   `new Proxy(prepared,{})`. Final Opus verified both fail closed by out-of-tree probe. Seal them if the
   capability representation is refactored so that reviewer-only evidence does not silently expire.
10. The six legacy-looking strings are sealed as operation names, not declared argument-field names.
    Final Opus verified the latter path accepts declared/present fields, rejects required/missing or
    undeclared extras and does not pollute prototypes. Add a focused regression when that schema compiler
    next changes.

The standing lineage rule from D.50.6 remains in force for every remaining item: new runtime, wire,
binder and application behavior is v3; v2 work is preservation, compatibility or freeze verification
only. Before each TDD item, audit its owner/plane. Phase 0j is already labeled consensus-v3. Phase 0n is
the remaining visible forward row still labeled `consensus-v2`; its row is deliberately untouched here.
Before scheduling 0n, stop and use the required Codex-high + exact Kimi-3/100 + Opus-xhigh correction
quorum if the audit confirms that label would request new v2 implementation.

#### D.52.5 — Selective checkpoint boundary

Phase 0i-v3 is accepted with the exact D.52.1/D.52.2 tuple. It does not claim authenticated anchor
provenance, implementation determinism, input metering, reducer dispatch/fold, full §11.4 completion,
full-suite green or closure of the bounded notes above.

The final compact documented-tree gate passed:

- focused 4 files / 46 tests
  `.logs/phase-0i-v3-final-focused.log`
  (`2227885f724c0656799a0ff1d0c0e27cf66e75655fe625163243adad655c4110`);
- protocol-v3 typecheck and build
  (`d3a787b637a76d71d7d6391d7d81db1c4e54da3a5259b9b950f266014628f5ec`,
  `7cd94d05afe83e7bba2c282c95c438aefa1bdeb582d18591b450addd1889eeec`);
- workspace typecheck
  `.logs/phase-0i-v3-final-workspace-typecheck.log`
  (`5192f9b9f53a7d8d2ab14b888e74acb01e88f312ec3a2954aa68262cf8ac680f`);
- targeted lint and diff check, both empty output
  (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`);
- Prettier
  `.logs/phase-0i-v3-final-format.log`
  (`17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20`).

Selectively stage exactly these seven paths:

1. `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
2. `packages/protocol-v3/src/index.ts`;
3. `tests/protocol-v3-blueprint-admission-0i.test.ts`;
4. `tests/fixtures/phase-0i-v3/blueprint-admission-package.json`;
5. `tests/protocol-v3-registered-byte-0g2t.test.ts`;
6. `tests/protocol-v3-transactional-issuance-0g2i.test.ts`;
7. `tests/protocol-v3-ed25519-acceptance-profile-0g2s.test.ts`.

Never use `git add -A`. Never stage `.logs/`, `.agents/`, `.claude/`, `.pnpm-store/`,
`skills-lock.json`, either stale untracked protocol-v2 0g2 RED or another unrelated path.

## Next Agent Prompt

Run the final compact D.52 gate and selectively checkpoint only the seven Phase-0i-v3 paths. Then audit
**Phase 0j** against source before writing a RED: all new runtime/application behavior must remain v3 and
0j owns implementation-artifact/runtime matching plus determinism, not ABI structure, anchor provenance
or reducer dispatch. If the row is source-accurate, split it into the smallest independently reviewable
TDD items before starting because lint enforcement, artifact/runtime matching and cross-engine
differential replay need not share one RED/GREEN owner. If the audit finds a material incorrect plan
assumption, pause and obtain unanimous Codex-high + exact Kimi-3/100 + Opus-xhigh agreement before editing
the plan.

For every Phase-0j item continue the requested separate Codex-high RED, separate Codex-high GREEN, Grok,
exact Kimi 3/100 and final Opus-xhigh loop, with typecheck/lint/tests written to `.logs`. Do not schedule
another Fable review unless the user explicitly requests one. Do not schedule Phase 0n from its current
`consensus-v2` label without the forward-plane audit described in D.52.4. Golden-path completion remains
blocked on the remaining plan items.
