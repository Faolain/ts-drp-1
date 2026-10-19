# Track E — why recovery-pool maintenance takes ~2.7 s per epoch

Base: 4c4f192c plus the integrated A+B+D tree (`base-int.patch`). Healthy-native Grid bench,
8 rollovers, `STARTUP_HEALTHY_GRID_POOL_LULL=1` (creator maintains at a lull, gameplay idle).
Every number below comes from a run whose report is in this directory (`run-<name>/report.json`).

## Verdict: architectural, not a hotspot

Maintenance time is spent proving the state again, not on the retirement itself. For one
maintained epoch, the system:

* makes **103 row writes** (61 puts, 42 deletes), the actual retirement;
* to do that, it issues **11,217 IndexedDB requests** in **1,398 readonly + 57 strict readwrite
  transactions** across **6 separate IndexedDB databases**, plus **~26,800 keep-alive sentinel
  requests**;
* runs **19,100 canonical decodes (34 MB)**, **38,100 encodes (39.5 MB)**, **7,400 capture-encodes
  (25 MB)** and **17,000 hash-memo lookups over 58 MB**, which is about **150 MB of byte
  processing**;
* of which only **410 distinct inputs are decoded (1.0 MB)** and **1,586 distinct outputs are
  encoded (3.2 MB)**. That makes **97.9 % of decodes and 95.8 % of encodes recomputations of a
  result already computed earlier in the same maintenance**. Within passes 1–3, 99.7 % of decodes
  repeat earlier ones; each of those passes decodes only about 15 new byte strings.

Direct ablation: one extra maintenance pass that finds **nothing to retire** costs **0.44–0.86 s**
(`patches/whatif-extra-pass.patch`; runs `wi3-mx-wxp1-*`). A real pass costs 0.53–0.79 s, so
nearly the entire per-pass cost is fixed re-proof overhead.

The counts are deterministic run to run. The table below shows t6–t8 from `mx-diag1-l1`
(diagnostic build without fingerprinting); the redundancy columns come from `mx-diag2fp-l1`.

| t | lull ms | passes | ro tx | rw tx | rw commit ms | IDB requests | sentinels | decodes (MB) | distinct | encodes (MB) | distinct | puts+deletes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 | 2696 | 4 | 1398 | 57 | 244 | 11216 | 26869 | 19055 (33.5) | 409 | 37493 (37.8) | 1577 | 61+41 |
| 7 | 2787 | 4 | 1398 | 57 | 243 | 11217 | 26703 | 19105 (34.2) | 410 | 38113 (39.5) | 1586 | 61+42 |
| 8 | 2723 | 4 | 1398 | 57 | 251 | 11217 | 26751 | 19106 (34.2) | 411 | 38061 (39.5) | 1586 | 61+42 |

## Where the 2.7 s goes (mean of t5–t8, ms)

One lull consists of a signing census (~5 ms), **4 passes**, each a sealed census followed by
`maintenance.reconcile`, and the post-boundary readiness capture (~200–270 ms).

| pass | stage it retires | seal | reconcile | re-acquire + authenticate world¹ | install: 2PC participants + apply | stage drain |
|---|---|---|---|---|---|---|
| 0 | journal prefix + signing evidence | 27 | 792 | ~300 | 245 | 102 + 84 |
| 1 | signing summaries (5) | 22 | 534 | ~280 | 188 | 64 |
| 2 | AHE generation 7→6 | 15 | 560 | ~300 | 197 | 61 |
| 3 | AHE generation 6→5 + journal ack | 16 | 571 | ~310 | 175 | 55 + 31 |

¹ `acquireClosedData` 124–162, protected union ~20, select 20–36, readback 16–29, images 15–23,
classify 22–45, plus reservations and release.

* **~1.2 s (45 %)** goes to re-acquiring and re-authenticating the whole recovery state four
  times. Each pass starts from nothing: fresh held read views, fresh census, fresh
  `acquireClosedData`, and re-derivation of every image digest from rows.
* **~0.8 s (30 %)** goes to four separate cross-database two-phase commits: coordinator intents,
  per-participant prepare fence, commit, and readback, across the AHE, snapshot, journal,
  issuance, floor and main databases.
* **~0.4 s (15 %)** is stage-specific drain work, itself proof-laden.
* **~0.25 s (8 %)** is the post-boundary readiness capture (`captureCreatorOrdinarySourceWithoutForecast`),
  which re-proves the same state once more.

The CPU profile of the lull windows (`mx-base1-prof1`; 5 windows, 16.1 s of wall time) splits as
follows:

* 30 % idle, waiting on IndexedDB;
* 23 % canonical codec and hashing (2.85 s self in the `dist` codec plus 0.38 s in the `src`
  copy; the bundle ships both);
* 14 % `(program)`, i.e. IPC and structured clone;
* 6 % `native-read-reservation.ts` (held-view pump and turn queue);
* 3 % GC;
* the rest spread across dozens of verifiers, each 1–4 %.

No single function is worth optimising. The cost is the shape of the work.

## Why it is shaped this way (the architecture)

1. **Proof-carrying local operations with bounded proof budgets.** Every local operation builds
   a self-contained, byte-bounded proof of its inputs from fresh native reads. The maintenance
   budget is 4 MiB (`LOCAL_WORKLOAD_CAPACITY.maintenanceProofBytes`). Charges are canonical
   encoded lengths, so values are re-encoded just to be charged (`accounting.charge(encode…)`,
   `closedRetirementBytes`), and `canonicalValueResourceForSizing` encodes and then re-decodes
   only to measure size.
2. **Stages are mutually exclusive per pass.** `creatorClosedRetirementCapacityBranches` allows
   either a journal and/or evidence drain, or a summary drain, or one generation drain per
   proof. The generation selector picks one excluded generation per pass. Each epoch adds two
   generations, so steady state needs two generation passes. The result is four passes per
   epoch.
3. **No trusted state survives a pass.** Each pass is "freshly sealed census + original native
   currency/planning/effect checks; no paid proof or writer is reused" (creator-close.ts:2419).
   The job object reuses syntax facts only. Passes 1–3 therefore redo pass 0's authentication;
   each changes only about 15 new byte strings.
4. **Six mutually distrusting IndexedDB databases.** AHE, snapshot-quarantine, live-journal,
   issuance, startup-floor and the main room database are separate. Atomic retirement needs an
   application-level 2PC with durable prepare fences, coordinator intents and readbacks: 13–17
   strict commits per pass, 57 per epoch. IndexedDB already makes multi-store transactions
   atomic, but only within one database.
5. **Exclusion by keeping readonly transactions alive.** `HeldReadView` holds an all-store
   readonly transaction open by spinning a sentinel `getKey("")`. That spin runs at
   ~20,700 requests/s while idle (measured) and produced ~26,800 sentinels per epoch. Facts are
   cached per held transaction identity, so the view is load-bearing: the no-pump ablation below
   breaks the lull path.
6. **Images are re-derived by re-encoding rows.** Native rows are stored as structured objects.
   Each read re-encodes every row to recompute the image digest. The `live-journal` `append`
   capture alone is the top codec caller.

## Alternatives and the evidence for each

See `ALTERNATIVES.md` for the measured experiments and the model benchmarks.

## Files

* `diag-e.py`: applies or restores the temporary counters. `apply`, `apply fp` (redundancy
  fingerprints) and `apply stacks` (transaction callers). Its source diff is
  `patches/diag-counters.patch`.
* `te-analyze.py`, `te-totals.py`, `stacks.py`, `callers.py`, `compare.py`, `extra.py`: analysis
  scripts.
* `whatif.py`: applies the ablations (`nopump`, `freeze`, `encmemo`, `extrapass`); diffs are in
  `patches/whatif-*.patch`. Measurement only, not shippable.
* `idbmodel/`: the Chromium IndexedDB cost models (`page.js` for 2PC, re-proof reads and the
  held-view pump; `page2.js` for watermark retirement v2), with results in `out2-disk.json` and
  `out3-v2.json`.
