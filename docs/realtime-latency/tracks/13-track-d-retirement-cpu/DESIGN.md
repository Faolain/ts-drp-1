# Track D — recovery-pool retirement maintenance: what changed and why it is sound

Base: 4c4f192c. Patch: `work-b3.patch` / `patch.diff` (same content) in this directory. Nothing committed.

## Where the per-epoch ~3 s goes (measured, not assumed)

One lull = signing census + 4 maintenance passes (journal+evidence drain, summary drain,
generation drain start, generation drain+ack) + psource (~250–300 ms, out of scope).
Each pass = `seal()` + `maintenance.reconcile()`: recovery acquire (racq ~130–160 ms,
116–124 IDB transactions), plan/select/classify (~100 ms), install
(`applyClosedEpochRetirementIntent`, ~145 ms, 56–58 transactions), stage (55–85 ms).

CPU profile of the lull windows (8 windows, rd2-prof-b2): ~33% idle (IDB round trips),
~67% CPU, of which the canonical codec is the largest single owner (~27% of CPU self time:
encode ~1.5 s inclusive, decode ~0.6 s, hashDomain ~0.7 s), then `(program)` (IDB/structured
clone), GC, the HeldReadView `#pump` keep-alive loop (out of scope), and dozens of 10–60 ms
verifiers spread over every participant. There is no single dominant in-scope cost; each
pass legitimately re-reads and re-verifies ~6 participants at fresh native boundaries.

## Changes and soundness, per reused / pipelined fact

All read changes keep the SAME native transaction, the SAME rows in the SAME order, and
every existing check at its original step. No authorization, currency check, proof charge
or writer is reused across transactions or passes.

1. **AHE admission census blob prefetch** (`storage/src/internal/bounded-read.ts`,
   `storage-browser/src/internal/retirement-control.ts`, `idb-adapter.ts`).
   Browser-mode census now yields one `blob-preflight` step naming exactly the uncertified
   blob references its blob loop reads next; the browser loader issues those `get`s ahead
   (sliding window of 16) in the same transaction and the `blob` step consumes its own.
   Sound because: (a) requests in one IDB transaction execute in issue order, and the
   driver issues no write between preflight and the blob steps (every caller awaits the
   whole admission before writing; a fresh admission after a mutation gets a fresh
   prefetch object), so an early `get` returns exactly what the step's `get` would;
   (b) row shape, digest equality and length checks run unchanged at the consuming step;
   (c) a prefetched request's failure is delivered to its consuming step; unconsumed
   requests are never observed (as if never issued); a synchronous refusal (store not in
   scope, e.g. head-only transaction) falls back to the step's own `get`, which reports it.
   Non-browser drivers never see the new step; the storage mock driver answers it `true`.

2. **Generation-record prefetch** (same files). After the `keys` step, the `get`s for the
   returned generation ids are issued; each `generation` step consumes its own. Same
   argument as 1; at most `maxObjectGenerations + 1` = 8 records (≤ 7.3 KB each).

3. **`keys` step: bounded `getAllKeys` instead of a key cursor.** Range
   `[objectId] … [objectId + "\0")` (upper-open) is exactly the set of array keys whose first
   component is `objectId` (no string sorts strictly between `s` and `s + "\0"`; non-string
   first components sort outside). Limit `maxObjectGenerations + 1`, first malformed key
   pushes `null` and stops — the same ordered output the cursor produced.

4. **Promotion membership** from one `getAllKeys` over the object's exact promotion range,
   limit `maxPromotions + 1`; an incomplete (`≥ limit`) or failed read returns `undefined`
   and the step uses its own exact `getKey`. Only all-string array keys are compared, by
   injective JSON of the key.

5. **Bounded bulk reads replacing cursor walks** in `live-journal.ts`
   (`retirementSnapshot`), `browser-issuance-store.ts` (`browserRetirementRows`),
   `snapshot-transfer.ts` (`nativeImage` scopes, `roleInventory`), `signing-retirement.ts`
   (native image). Each runs after the existing `count()` in the same transaction and
   reads `getAll`/`getAllKeys(range, count + 1)` — the same rows in key order as a forward
   cursor over the same range. A synchronous `collect` then applies the original per-row
   parse/key/budget checks in the original order, and the existing `rows.length === count`
   check still detects divergence. Memory: rows are bounded by the already-enforced count
   limit (previously read one at a time, now held together for one synchronous pass). The
   `chunks` cursor (payload bytes) is unchanged. Signing reads keys first, then values in a
   window of 16 ahead of the row being checked.

6. **Canonical codec** (`canonical/src/internal/codec.ts`), bytes identical by construction
   and by the frozen-reference differential tests:
   - `finishSorted`: unsorted entries are staged past the output inside the writer's own
     buffer (`copyWithin`) instead of `slice` + per-entry `subarray`; the local entries
     array is sorted in place (stable sort, same comparator, array unused afterwards);
     the LEB128 count header is written directly instead of via a BigInt `encodeVarUint`.
   - `encodeVarUint`: Number fast path for safe non-negative integers (exact arithmetic).
   - `encodeInternal` integers: zig-zag in Number over the writer's exact range
     (non-negative: `2v` is an even double ≤ 2^54, exact; negative ≥ −2^52), BigInt
     otherwise — the same bytes as `zigZagEncode`.
   Microbench (same process, interleaved): object-heavy encode −25…−30%.

## Not done (and why)

- Merging maintenance passes or reusing a pass's recovery acquisition: each pass's fresh
  sealed census and native currency checks are the protocol boundary; out of bounds.
- `Object.getOwnPropertyDescriptors` replacement in the encoder: ~10% of encoder time, but
  exact proxy-trap/key-order equivalence is subtle for <1% of lull; not worth the risk.
- Out-of-scope costs that remain on the lull: HeldReadView `#pump` keep-alive
  (`native-read-reservation.ts`, >half of all IDB requests per pass, ~0.4–0.7 s CPU per
  8 lulls), v3-live `readCreatorRecoveryDependencyCensus` (readIssued×23 +
  readSettlementPlan×23 transactions per pass), psource (~250–300 ms per lull).
