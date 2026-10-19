# Golden-path guarantee checklist (G1–G28)

This checklist collects the safety and correctness guarantees that any change to storage maintenance,
retirement, admission or transition latency must keep. The IDs G1–G28 are short names for statements that
already exist in the specs and the production-hardening plan. The checklist adds no requirements of its own;
where it disagrees with a source, the source wins.

It was compiled during the October 2026 real-time latency work, as Track R in
[docs/realtime-latency](../../docs/realtime-latency/README.md). Every track since then has argued its change
against it. Latency objectives never justify relaxing any of these (G26).

**How to use it.** A change that touches retention, retirement, admission, durability or storage formats states,
for each guarantee it touches, why that guarantee still holds. It names the test or evidence for each claim. If a
change cannot keep a guarantee, it stops and records the counterexample instead of weakening a test or spec.

**Line numbers.** The citations were taken at commit 40c0895b (4c4f192c plus Track R's base patch). They may have
drifted since. Track R3 refreshes them as part of spec slice S1; until then, find each cited passage by its
quoted text.

Abbreviations:

- BSL = [specs/bounded-storage-lifecycle/README.md](README.md)
- R2E = [specs/bounded-storage-lifecycle/requirements-to-evidence.md](requirements-to-evidence.md)
- 6B = [specs/phase-6b-bounded-pruning/README.md](../phase-6b-bounded-pruning/README.md)
- 6B01, 6B04 = specs/phase-6b-bounded-pruning/slices/01-issuance-retention.md and 04-browser-scheduling.md
- E35 = [specs/e3-e5-fabric-golden-path/README.md](../e3-e5-fabric-golden-path/README.md)
- 02D = [slices/02d-declaration-free-shipped-startup.md](slices/02d-declaration-free-shipped-startup.md)
- PLAN = docs/production-hardening/production-hardening-tdd-plan-v2.md

| id | guarantee | source |
|---|---|---|
| G1 | Hot state and protocol overhead do not grow with room age; thousands of epochs without resets | BSL:161-164 "Outcome and limits" |
| G2 | Backpressure before storage exhaustion; admission stops if maintenance cannot drain; accepted work stays finishable | BSL:164-165, BSL:269-272, R2E:697-699 |
| G3 | MMORPG golden path: genuine transitions, all admitted writers, offline/rebase work, crash recovery and next issuance stay correct | BSL:169 golden-path table; E35:155-156, E35:169 |
| G4 | Terminal sessions cannot be resurrected (delayed callbacks, packets, stale signing requests) | BSL:171, BSL:79-86, R2E:373 (R11) |
| G5 | Durable store bytes are untrusted: "carriers, not authenticity"; trust state "reverified on every open" | PLAN:96278-96280, PLAN:6967-6968, PLAN:10974-10981, R2E:202-205 |
| G6 | Whole-origin rollback is not prevented by anything stored in the same origin; keep host freshness/custody model, fail closed | BSL:175-178, 02D:89-91, PLAN:93195-93210, PLAN:92569-92570 |
| G7 | One retirement decision owner; no sweeper; epoch age, TTL, head observation, `adopted: true`, counts, labels are not deletion proof | BSL:182-187 "One owner per decision", R2E:369 (R7), R2E:2581, R2E:2587 |
| G8 | A database watermark or physical deletion alone is not authority under the untrusted-bytes model | PLAN:96895-96899, PLAN:96312 |
| G9 | Each physical owner rechecks its own monotone facts transactionally immediately before its own deletion | 6B:66-67, 6B:84-88, PLAN:88070-88074 |
| G10 | Only immutable syntax and signed facts may outlive a stage; native currency, progress, authority and paid proof may not | R2E:34-36, R2E:56-57, R2E:741-742, creator-closed-rollback-data.ts:21567-21577 |
| G11 | Currency reuse only inside the same held native readonly transaction (browser) / data_version brackets (SQLite); revision/incarnation alone is unsound (modelled counterexample) | R2E:137-140, R2E:1456-1458, R2E:4958-4959 |
| G12 | Foreign READWRITE must be natively excluded; Web Locks / JS locks are not native exclusion; no timer or Promise stands in for exclusion | R2E:4854-4868, R2E:2897, R2E:2426, native-read-reservation.ts HeldReadView |
| G13 | Web Locks are advisory scheduling only; they never decide eligibility or authorize deletion | 6B:64, 6B:180-182, 6B04:97-108 |
| G14 | One bounded resumable retirement intent; ordered idempotent steps across independent DBs; store-local monotone write fences before deletion; absent receipt means retain | BSL:207-211, R2E:366 (R4), 6B:112-115 |
| G15 | Crash atomicity: old XOR new; may retain too much, never delete too much; never deletion without the matching watermark; cleanup never part of commit | PLAN:1277, 6B:183-184, 6B01:144-147 |
| G16 | Strict durability everywhere; no relaxed write ships; downgrade fails closed | PLAN:1277, PLAN:16910, PLAN:4885-4889 |
| G17 | No resurrection: permanent fences against old writers, restores, imports, late acknowledgements | BSL:210-211, R2E:367-368, 6B:165-171, PLAN:93330-93352 |
| G18 | Protected set = current head + exactly two usable rollbacks (baseExpectedHead twice) + bounded pending work + shared bytes; rollback never lowers floors | BSL:251-255, 6B:145-151 |
| G19 | Issuance retention: only paired, published, epoch-bound rows; pending/malformed rows block the owner with no writes | 6B:162-171, 6B01:105-147 |
| G20 | Snapshot lifecycle: verification does not pin forever; TTL is not a dependency lifetime; promotion precedes dependence | BSL:189-191, BSL:204-205 |
| G21 | Bounded work: cardinality/byte bounds, bounded scans/queues, reviewed limits (not post-hoc constants) | BSL:257-267, R2E:1900 |
| G22 | Proof budget: every proof pays full operation-local charges; joined acquisitions are separate lifetimes; no refunds; reservation precedes irreversible effects (maintenanceProofBytes 4 MiB) | BSL:21-24, BSL:264-266, R2E:934-982, packages/storage/src/types.ts:117-132 |
| G23 | Ingress: during a deferrable lull, arriving ingress queues FIFO, nothing dropped, provenance rechecked at admission | v3-room.ts:530-535, v3-live.ts:19367-19369, R2E:1037-1038 |
| G24 | Startup floor is a trusted expectation, never a substitute for proofs; a regressed floor is never repaired | 02D:14-17, 02D:86-99 |
| G25 | Migrations/format changes must be authenticated and fence stale connections; no two authorities in the end state | BSL:216-221, BSL:238-241, R2E:3382-3385 |
| G26 | Latency objectives never justify relaxing safety | PLAN:18309-18312, R2E:71 |
| G27 | No game-specific carve-outs; census-proven pruning | PLAN:19135-19156 |
| G28 | Native requirements need native (three-engine, SIGKILL) evidence | BSL:27-32 |

Stage exclusivity per proof and one generation per pass are implementation choices, not spec requirements
(creator-close.ts `reconcileCreatorBoundedRecoveryMaintenance`; creator-closed-rollback-data.ts:21567-21577).
A fused pass must still satisfy G9, G10, G14, G21 and G22, and its budget must be reviewed policy (BSL:261-263).

## What the checklist has already ruled out

These verdicts come from Tracks R and R2. The reasoning is in
[docs/realtime-latency/tracks/18-track-r-redesign-guarantees](../../docs/realtime-latency/tracks/18-track-r-redesign-guarantees/README.md)
and [20-track-r2-r3-watermark-retirement](../../docs/realtime-latency/tracks/20-track-r2-r3-watermark-retirement/README.md).

- **Web Locks plus revision counters as exclusion or currency:** unsound under G11, G12 and G13.
- **Skipping fresh reads by caching verified state across stages:** unsound under G5, G10 and G11.
- **Fusing maintenance stages:** allowed, but it changes durable formats, so it needs its own spec slice (G25).
- **Single-database watermark retirement:** keeps G1–G27 only under three conditions:
  - rows are re-verified on arrival and on every open;
  - the watermark is only a fence, index and resume point, never authority (G8);
  - the host floor stays a separate database, fenced per owner.

  G28 still needs three-engine and SIGKILL evidence. This design is being specified as slices S1–S6 (Track R3).
