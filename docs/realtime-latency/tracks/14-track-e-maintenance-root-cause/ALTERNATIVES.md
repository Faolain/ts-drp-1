# Track E — alternatives to the current maintenance design, and the evidence for each

Read with `ROOT-CAUSE.md`. Bench and machine are as stated there (shared machine, 1-minute load
20–30). Real-system experiments run as interleaved ABC/CBA sets against the same base bundle
(`mx-base1`). Models run in Playwright Chromium against an on-disk persistent profile, which is
how the bench runs: ephemeral contexts keep IndexedDB in memory and hide fsync cost.

## Results at a glance (one maintained creator epoch, steady state t5–t8)

| # | Alternative | Kind | How it was tested | Effect | Gets to ms? |
|---|---|---|---|---|---|
| 0 | Current, after Tracks A+B+D | — | `mx-base1`, 6 runs | lull **2.1–4.2 s** per epoch; run means 2.4–3.4 s, load-dependent | — |
| 1 | Verify-once at the **codec** layer (byte-exact decode memo returning deep-frozen values; identity memo for frozen encodes) | local | real system, `mx-wfz2` / `mx-wfe1`, interleaved | **no measurable change**: interleaved pair means are base 2,848 ms, decode memo 2,781 ms (−2 %), decode + encode memo 2,833 ms (−0.5 %), all inside noise; single runs of the same bundle differ by up to 35 % as load drifts, which is why only ABC/CBA pair means are compared | **no** |
| 2 | Remove the sentinel pump (held views reserve nothing) | storage | real system, `mx-wnp1` | **breaks the lull path**: every lull becomes `deferred/busy`, maintenance falls back inline at close, seal t4–t7 goes 0.3 s → 2.7–4.1 s and adoption ~0.6 s → 0.8–1.2 s. Held views are load-bearing because fact caches are keyed by transaction identity | no |
| 3 | **Stage fusion**: one pass per epoch instead of four | protocol | per-pass decomposition, plus an extra-pass ablation (`mx-wxp1`) that measures one no-op pass | **one pass that retires nothing costs 0.44–0.86 s** (median ~0.61 s); a real pass costs 0.53–0.79 s. Per-pass cost is fixed re-proof overhead, so fusing 4 → 1 saves ~3 × 0.6 s: **2.7 s → ~0.9–1.1 s (≈ −60 %)** | no |
| 4 | **Carried authenticated state** across passes and operations (verify once, recheck currency through per-store revision stamps) | protocol + storage | redundancy counters: passes 1–3 decode ~15 new inputs out of ~3,000–4,700 decodes | removes the ~1.2 s of re-acquisition plus most within-pass recomputation; estimated **~0.6–0.9 s** left (2PC + drains + readiness) | no (alone) |
| 5 | **Single-database atomic retirement** (no cross-database 2PC) | storage | Chromium model `idbmodel/out2-disk.json` | 2PC round (13 strict commits + 8 readbacks over 6 DBs) **12.8 ms → 1.3 ms** in one transaction; in the real system the 2PC phase is ~0.8 s per epoch (iparticipants + iapply) | partially |
| 6 | **Watermark retirement v2** (epoch-keyed key ranges, one monotone retirement watermark, verify at ingress, incremental digests) | architecture | Chromium model `idbmodel/out3-v2.json` | **2.5 ms median (max 4.3 ms)** per retired epoch with one DB and one strict transaction; **6.2 ms (max 10.6 ms)** with six DBs and coordinator-free per-DB watermarks; surviving rows verified exact | **yes** |
| 7 | Run maintenance in a Worker | runtime | not tested here (covered by the long-task track) | duration unchanged; removes main-thread contention only | n/a |

## 1. Verify-once at the codec layer: does not help

About 98 % of decodes and 96 % of encodes recompute an earlier result, so the obvious fix is to
memoise the codec. Both what-ifs passed the full bench. The decode memo's soundness tripwire is
deep freezing: no caller mutated a decoded value on this workload, and storage, journal and seal
package tests passed with it (264/264).

Neither memo moved lull time beyond noise (table above). The repeats are not cheap to detect at
this layer:

* each pass reads fresh structured-clone objects from IndexedDB and rebuilds new objects, so an
  identity-keyed encode memo misses;
* a byte-keyed decode memo must fingerprint and compare every input, which costs about as much
  as decoding it. The existing hash memo shows the same thing: 17,000 hits over 58 MB per epoch,
  every hit a full fingerprint plus byte compare;
* the codec is ~23 % of lull CPU, so even a perfect memo is bounded at about −23 %.

Conclusion: the redundancy has to be removed at the protocol layer, by not re-reading and not
reconstructing. It cannot be cached away underneath.

## 2. Sentinel pump: real cost, but load-bearing

Measured cost:

* the `HeldReadView` spin runs at **20,700 `getKey("")` requests/s** while idle (model);
* it issued ~26,800 sentinels per maintained epoch (counters);
* it accounts for ~190 ms per epoch of main-thread self time in `native-read-reservation.ts`
  (profile), plus IPC.

Removing it naïvely breaks the lull. Stores cache validated images and facts per held
transaction (`retained.matches(this, tx, …)`, `#validatedOutboxReadImages`, live-journal
`basis.transaction`), so those caches vanish and paths refuse.

A sound replacement needs two parts:

* **exclusion**: Web Locks (`navigator.locks`, shared for readers, exclusive for writers), which
  the codebase already uses in `creator-adoption-activate.ts`, or optimistic validation. Either
  way, hold no transaction;
* **cache validity**: a per-database revision stamp that every readwrite transaction bumps,
  instead of transaction identity.

Value: about 6–10 % of the lull. It is a prerequisite for (4), not a fix in itself.

## 3. Stage fusion

Today `creatorClosedRetirementCapacityBranches` admits one of the following per proof:

* journal and/or evidence;
* summaries;
* one generation.

The generation selector picks a single excluded generation, and each epoch adds two
generations. So every epoch costs 4 passes. Each pass's fixed part is re-acquire plus
authenticate (~300 ms) and a 2PC (~175–245 ms). Stage drains themselves are 55–186 ms.

**Measured with an extra-pass ablation** (`patches/whatif-extra-pass.patch`, runs
`wi3-mx-wxp1-{2,3}` against `wi3-mx-base1-{1,4}`). After the schedule completes, one more sealed
census and reconcile runs; it finds nothing to retire and returns `complete`. That no-op pass
costs **0.44–0.86 s** (t4–t8 across both runs), and the lull pair mean rises 2,992 → 3,943 ms.
Real passes cost 0.53–0.79 s, so almost all of a pass is fixed re-proof cost.

A fused pass is about one such fixed cost plus a small marginal per effect. Pass 0 carries two
effects and costs ~0.2 s more than single-effect passes. Estimate: ~0.6–0.8 s plus the ~0.25 s
readiness capture, so **~0.9–1.1 s against ~2.7 s (≈ −60 %)**.

Cost: the proof budget (4 MiB per pass) must cover the combined effects. The generation partition,
AHE generation-drain control and capacity branches are durable, protocol-visible formats.

## 4. Carried authenticated state (verify once, check currency by watermark)

Prior art:

* OCC validation (Kung & Robinson 1981);
* ETag / If-Match conditional writes;
* git / Nix / Bazel content-addressed stores, which verify on ingest, not on every read.

Design:

* keep the authenticated recovery facts of a maintenance job, and of the room session, in
  memory;
* every native writer bumps a per-database revision row in the same transaction;
* a pass or operation rechecks currency with one `get` per database (model: **6 control reads =
  0.3 ms**, versus **~52 ms** for 250 transactions × 10 reads on the same machine; the real system
  issues ~1,400 such transactions per epoch);
* only the delta it wrote itself is reapplied (incremental view maintenance);
* image digests stop being recomputed by re-encoding every row. Maintain them incrementally on
  write with a homomorphic multiset hash (LtHash, Lewi et al. 2019, as used by Facebook for
  update integrity; MSet-Add-Hash, Clarke et al. 2003), so an image check becomes a stored-digest
  compare.

## 5. One database, one transaction

IndexedDB transactions are atomic across object stores of one database (IndexedDB spec, transaction
lifetime and atomicity), but not across databases. The six-database layout forces durable intents,
prepare fences, commit records and readbacks.

Model, on disk, strict durability, same write set:

* 6-database 2PC (13 rw + 8 readbacks): median **12.8 ms**;
* one database, one rw transaction: median **1.3 ms** (relaxed: 3.3 ms → 0.7 ms).

In the real system the 2PC phase per epoch is ~0.8 s, because each participant acquisition and
readback is itself a re-authentication.

If separate databases must stay, retirement below a *stable* epoch is **monotone and idempotent**.
Each database can therefore retire independently under its own `throughEpoch` watermark, written in
the same local transaction, in parallel and without a coordinator. Crash replay re-runs the
idempotent deletes. This is model variant V2b.

## 6. Watermark retirement v2: the design that reaches milliseconds

Same invariants, cheaper mechanisms:

| Invariant today | Mechanism today | v2 mechanism |
|---|---|---|
| crash atomicity across stores | app-level 2PC over 6 IDB databases | one IDB transaction (or per-DB monotone idempotent watermarks) |
| no writer interleaves with a retirement decision | held all-store readonly views kept alive by a sentinel spin | decision computed inside the readwrite transaction from the watermark row (or Web Locks + OCC) |
| retained data is authentic | re-authenticate everything on every pass/operation | authenticate once at ingress (signature + digest), store the verified record; integrity by stored digest |
| image currency | re-encode all rows and re-hash | incremental (LtHash-style) image digest maintained on write; compare one value |
| retire only what is safe | per-row census + classification + bounded proof | epoch-granular keys `[objectId, epoch, …]`: retiring epoch e is one `delete(range)` per store, gated by the stability condition (successor adopted, pool > K) |
| no resurrection | permanent fences per scope | writers refuse keys below the monotone watermark |

Model `idbmodel/page2.js`:

* seeded with the per-epoch retirement set the bench retires at t5–t7: 12 journal rows,
  1 snapshot scope (manifest + 4 × 32 KB chunks), 2 AHE generations, 6 signing rows, 20 issuance
  rows, 1 floor row;
* 4 live epochs are kept;
* each epoch is retired with strict durability, then row counts are verified.

Results (`idbmodel/out3-v2.json`, 40 epochs each):

* **V2a**, one database and one strict readwrite transaction (watermark CAS, 6 range deletes,
  watermark put): median **2.5 ms**, max 4.3 ms;
* **V2b**, six databases with an independent idempotent watermark transaction each, in parallel:
  median **6.2 ms**, max 10.6 ms;
* surviving rows equal exactly 4 live epochs in every store, for both variants.

Against today's ~2,700 ms, that is about 1,000× (V2a) or 400× (V2b).

Prior art for watermark-triggered retirement:

* PostgreSQL VACUUM below the xmin horizon;
* Kafka log retention / log-start-offset;
* RocksDB compaction filters under snapshot sequence numbers;
* most directly, CRDT log compaction at **causal stability** (Baquero, Almeida & Shoker, *Pure
  operation-based replicated data types*, 2017). A DRP epoch that every member has adopted is a
  causally stable cut, so everything below it can be pruned locally, without re-proof.

## What this means for the real-time goal

* **Codec and pump optimisations** (1, 2): at most ~−10–25 %. They cannot reach milliseconds.
* **Protocol work inside the current storage design** (3 + 4): roughly 2.7 s → **~0.6–1.1 s**.
* **Milliseconds per epoch** need the storage and trust changes in 5 + 6: one atomic transaction,
  epoch-keyed ranges, verify-at-ingress, and monotone watermarks.

  The trust-model change is that local IndexedDB contents are trusted after ingress verification.
  This is the standard client model: an attacker who can write this origin's IndexedDB can
  already run code in the origin.

Suggested order:

1. revision stamps plus Web Locks, replacing the held-view pump and transaction-keyed caches;
2. carry verified facts across passes;
3. fuse stages;
4. migrate the six databases into one with epoch-keyed stores and a watermark row.

Each step is independently measurable with the counters in `diag-e.py`.
