# Creator catch-up and dormant local custody

An accepted local operation must remain either committed, durably pending, or explicitly disposed of by its policy when a replica misses checkpoints or loses its Writer role. Membership removal changes authority; it does not prove completion. Re-admission changes current authority; it does not revive an old runtime or erase old intent.

## Implementation and remaining verification

Updated 2026-10-23. The public native room path now installs a bounded checkpoint after missed epochs and retains visible accepted work through removal, re-admission and cold reopen. The repeated-gap gate reaches epoch 16 through eight two-epoch jumps, preserving eight independently accepted unknown sources and allowing fresh current issue. This is a finite admitted workload; unresolved sources remain bounded by the original plan and issuance quota.

The native role and custody slice has completed independent review; its two reported regressions have focused corrections. Native role and absence tampering, receipt-only recovery before a complete candidate, and mixed adjacent/checkpoint histories have focused regressions. Remaining gates are all owner bounds, both usable rollback forward promotions, genuine SQLite process death, browser verification, and explicit source expiry. The full-removal completion case (an author with both a signed-close committed source and an omitted source, then same-key re-admission) is corrected at `01944b66`: exact signed completion travels in the original settlement plan, is re-verified cryptographically on cold reopen, and is released only after its last consumer; `tests/creator-rejoin-recovery-composition-native.test.ts` covers the shared and non-shared lifecycles. A removed author's committed entries with no plan fence are not yet prunable; that liveness gap is tracked with explicit source expiry. Fault exceptions around floor writes are not process-death evidence. Proof-level parameter and blueprint substitution controls do not replace the outstanding application-level historical-ABI test.

- [Authenticated checkpoint and transition model](slices/01-authenticated-chain.md)
- [Bounded native attachment receipt](slices/02-successor-evidence.md)
- [Received catch-up publication and reopen](slices/03-catchup-publication.md)
- [Dormant custody and re-admission](slices/04-dormant-custody.md)
- [Durable policy resolution and independent current issuance](slices/05-policy-resolution.md)

## Independent design synthesis

All three drafts identify the same existing conflation: `predecessor` means both actual local ancestry and the remote checkpoint predecessor, while historical issuance requires a latest per-author frontier. Use one discriminated adjacent/checkpoint transition in the original adoption owner. Its material names `localBase`, `remoteCheckpoint` and `target` explicitly. Adjacent transitions retain their stronger classification. The original historical source owner authenticates custody independently of current Writer permission and optional commitment evidence; a removed writer does not become the existing empty-issuance observer mode.

All three drafts also reject permanent retention of one AHE generation per pending source epoch. Transfer minimal immutable source proof into the existing settlement plan before its old generation retires, charge its complete native representation before acceptance, and retain it until the last source consumer releases it. The full transport checkpoint exceeds one AHE blob's ceiling. Its compact native point proof stores only remote predecessor trust and predecessor settlement; the final closure already owns the exact predecessor ACL. This keeps seven references, one current-trust record and the existing per-record and union limits. Use separately requested adjacent-membership and checkpoint response variants so a gap never fetches irrelevant final-close membership as if it classified local work; existing response ceilings remain unchanged.

Native publication continues through the original intent, stage/CAS and floor owners. The mechanical floor codec may represent a monotone gap only after Node authenticates the exact attachment. Reopen reconstructs original signed proof and native currency, not stored labels. G18 is judged against the original contract and current adjacent recovery behavior: actual local rollback payloads remain protected, and a higher floor never permits an old writable session. Verify usable recovery, not just generation counts.

The original user-selected rollback mechanism is [authenticated forward promotion at a new epoch](../bounded-storage-lifecycle/handoff-history.md), preserving current roles and safety floors. Its [recorded native continuation](../bounded-storage-lifecycle/requirements-to-evidence.md) promotes source 5 at floor 7 to epoch 8 and source 6 at floor 8 to epoch 9. Apply that same mechanism to actual local rollback bases after a jump. Same-floor reconstruction of a corrupted target from historical payloads is not the existing G18 requirement.

Unknown commitment cannot support automatic retry for a general non-idempotent application after compaction. The public recovery regression must preserve visible pending work and then use an explicit policy disposition, unless a test provides authenticated noncommitment or durable application idempotency. Durable decisions bind exact source identity and must authenticate again after restart. Independent current issuance requires auditing every terminal frontier, capacity preview, fence and pruning consumer; deleting the room's blanket manual-review hold alone is insufficient.

## Ownership

One received-transition owner validates the original installed trust and the existing pinned-genesis checkpoint proof for the remote latest predecessor/current pair. It checks the exact ACL, signed settlement and final snapshot. This fixed-creator authority is already the checkpoint opener’s premise. Re-attachment grants the target’s current authority; it makes no claim that uncertain old local work belongs to a remote closed Cut. The ordinary adjacent path retains its stronger source-classification evidence. Native storage supplies exact immutable carriers and mechanical CAS; it cannot mint trust from a watermark, epoch, admission label, or successful write.

The native base head is the replica's actual installed generation. The final Cut's remote predecessor is a separate proof input. A snapshot jump must preserve two usable local rollback generations through the existing `baseExpectedHead` lineage; it must not synthesize intermediate application snapshots or mislabel a remote proof as a local generation.

Original signed source identity includes object, author, sequence, digest and epoch. A current ACL can forbid new writes while the recovery owner retains and exposes old sources. Only authenticated commitment or an explicit application policy resolution can settle them. Terminal runtime handles remain terminal after a new session obtains authority.

The original recovery owner derives usable local roles from exact native publication edges for received adjacent heads and checkpoint jumps. Adjacent heads retain their original signed edge and full snapshot checks; jumps additionally require the nominal checkpoint attachment. It authenticates current and first-rollback birth receipts, then opens the oldest rollback as an independent signed point. A historical signature authenticates DATA; it cannot choose a current native partition, revive a session, or authorize deletion. The exported semantic readback alone supplies no native read custody. The original Node acquisition joins it to the exact current bounded reader, floor, full census, held snapshots and currentness checks before the existing retirement coordinator may act.

A native absence receipt identifies an immutable publication: fixed genesis, exact native head tuple and current anchor. Its identity excludes predecessor pointers that authorized cleanup may normalize. A historical receipt can establish absence for an independently classified old point; it cannot classify a currently present scope or excuse a missing protected payload. Current deletion still requires fresh current role proof, exact native image and intent binding, and joined last-consumer release.

## Bound and refusal

Re-attachment must work after arbitrarily many missed epochs using bounded current checkpoint evidence. The earlier seven-certificate proposal is rejected: seven was provisional, a missing certificate could strand old intent, and full membership plus signed carriers exceeds the existing journal image bound at capacity. Do not add a new certificate ring or require an age-sized chain.

The receipt retains the original signed local source and its pending rows. Pending custody has explicit count/byte limits and reserves its original proof before new acceptance; room age is not a charge. When an old Cut is unavailable, no latest frontier, omitted member or snapshot absence supplies its membership. Unknown old work remains exposed for explicit policy resolution. Current accepted work may proceed when its reserve fits; an unrelated manual-review row must not create a blanket issuance hold.

The existing journal image has a 2 MiB ceiling and the AHE closure has seven references. Preserve these bounds while deciding which receipt lives in snapshot recovery metadata and which old native generations remain protected. No global limit increase is implied. Failure preserves source custody and reports a typed actionable result.

## Evidence and review

The public native regression is the runnable review surface. The focused Quint model covers transition sequencing, retained intent, exact old/new floor recovery and stale runtime fencing. It does not model Ed25519, native transaction exclusion, or prove the full settlement contract. Native evidence remains mandatory for those boundaries.

The focused model's six deterministic tests and 3,000 randomized runs of 40 steps pass. Its finite `stepSmall` projection exhaustively checked 598,740 generated / 143,522 distinct states, with no states left on the queue and graph depth 27. This projection limits the model to three epochs, two accepted identities and five runtime incarnations; these are verification bounds, not product lifetime limits. Deliberate intent-loss and old-session-revival transitions each produce a shortest counterexample. The public gap path now has native positive evidence; the remaining verification list above limits the completion claim.

Keep G1–G28, particularly bounded overhead and reserve-before-acceptance (G1/G2/G21/G22), original proof custody and untrusted native bytes (G5–G12), rollback/floor/crash behavior (G14–G18/G24/G28), and terminal session fencing (G4/G17).
