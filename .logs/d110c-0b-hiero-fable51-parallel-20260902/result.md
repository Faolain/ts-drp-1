The audit is complete. Report follows; it is also saved outside the repository at `~/.claude/plans/you-are-the-expressly-fluffy-pie.md`.

**Disclosure.** Model `claude-fable-5-1`, high effort, no subagents or workflows, no permission denials, no repository files changed. Repository HEAD inspected: `c1e443fc9676187c4b02dcd23459a23119de8146`, with an uncommitted working tree carrying in-progress D.110c-0b0a GREEN (new stage/recover subpaths, 8 tracked files modified). Stash count observed is 27, while the plan records 26.

## Upstream pins and what Hiero actually establishes

| Repo | main head (fetched 2026-09-02) | vs. D.110c-0b pin |
| --- | --- | --- |
| hiero-improvement-proposals | `54ccb06659592ab201e7adea632f1019e9faa00e` | unchanged; HIP-1200 blob `08808818…` unchanged |
| hiero-consensus-node | `a97f829a778023aeddd59d30562f0759799e8159` | one commit ahead of `1aa1d6c1…`; zero changed files on history/hints/tss/reconnect/roster/wraps/signed-state paths |
| hiero-cryptography | `39f28f39f609f80e52253d86169e2db5216a713e` | unchanged; wraps `lib.rs` `5beccdf8…` unchanged |

All previously pinned blobs match. Newly pinned for the ledger: `V0730HistorySchema` `b3cb7271…` (a WRAPS proving-key-hash singleton overwritten from config on restart), `WrapsMpcStateMachine` `505e9c58…`, `ProofControllerImpl` `5f5ec0c6…`, `RosterTransitionWeights` `7491ac42…`, `TssConfig` `b7406431…`, `DefaultSignedStateValidator` `191d4873…`, and the handoff/purge/prover tests.

**Proposal vs implementation.** HIP-1200 is Approved and describes the recursive chain of trust and packed sizes. The implemented proto adds a `verification_key` field to `AggregatedNodeSignatures` that the HIP text omits, and `forceMockSignatures` still defaults to true. The recursive proof, verified in the Rust source, establishes exactly this: a Groth16 decider over Nova folding verifies, the initial state equals the genesis address-book hash, and the final state's second element equals the hash of the current hinTS key. It binds neither the final roster hash nor the step counter, so it proves descent from genesis but not latestness or transition count. In-circuit authorization is strictly more than half the previous roster's weight. Off-circuit thresholds differ: R1 advance at more than half, recursive-vote acceptance at one third of source weight, target readiness above two thirds. Retained state includes the ledger id, at most one next construction, proof key sets with rotation, in-flight votes and messages, and the uncompressed proof needed to extend. Handoff refuses a mismatched roster unless forced and complete, purges obsolete votes and messages, removes departed keys, and promotes jointly only when history metadata equals the hinTS key. Freshness is external in every path: reconnect compares learned round and timestamp against the learner's own prior floor.

**Transferable obligations:** one out-of-band pin; age-independent verification that current authority descends from it; that statement binds current metadata; freshness never inherited from the proof; at most one in-flight successor; purge only after completed matching promotion; restart re-derives from the persisted current record, never by replaying transitions. **Non-transferable:** weighted honest-majority arithmetic, trusted setup and multi-gigabyte artifacts, native Rust with no TypeScript verifier, consensus rounds as a clock, key rotation, a global ledger id.

## Decision matrix and recommended 0b0b decision

Local state confirms the gap: the exported opener is genesis-only and the minters are private and only mint epoch plus one, the closure inspector is exactly-one, the advance predicate retains every old cut and QC, cold reopen and the new 0b0a recovery assume the three-generation first-transition shape, two rollback generations are fixed, and Node close still supplies an empty accumulator.

| Criterion | A. genesis signer signs current checkpoint | B. external pin | C. WRAPS-like | D. Merkle/skip | E. unchanged |
| --- | --- | --- | --- | --- | --- |
| Authentication from pin | Yes, via genesis carrier digest binding plus Ed25519 | Only if pin service trusted | Yes, but degenerate for a fixed key | No | Only by O(N) replay |
| Evolving ACL | Inside signed anchor; signer fixed | Same | Supports rotation | Needs certified keys | Same as A |
| Growth | O(1) plus 2 rollback gens, at most 53 peaks | O(1) local, external state | Constant proof, retained uncompressed proof and artifacts | O(log N) | O(N) |
| Cost | One sign, one verify | Round trip | Minutes of folding, native | Hash-only | Grows |
| Browser/TS | Existing primitives | Client feasible | No TS verifier | Feasible | Feasible |
| Dependencies/setup | None | Service, credentials | SNARK lib, CRS, artifacts | None | None |
| Wire/contract | v1 record unchanged; new opener export and closure-law change | New carrier and API | New fields, keys, migration | New schema | None |
| Untrusted restart | Full reverification; 0b0 floor for latestness | Pin supplies latestness | Same gap as A | Same gap | Same gap |
| Rollback/availability | Predecessor-QC check is a fail-closed availability trade | Outage blocks | Lost proof or entropy blocks | Index loss blocks | Any lost link blocks |
| Archive separation | Separate; root pinned | Same | Same | Plausible for Phase 7 | Same |
| Migration | 0→1 law unchanged; epoch≥2 compaction explicit | Scope creation | Bootstrap proof | Index bootstrap | None |
| Replay/substitution/equivocation/skip/stale | Byte and ref equality; pin, objectId, previousAnchor; two records ambiguous, lone fork only via floor; gap code; floor equality | Service-dependent | Cannot detect stale or fork | No | As A but O(N) |
| Safe pruning | After head, floor commit, 2 gens, D.109 gates | Plus service commit | After joint promotion | After rebuild | Never |

The prior conclusion is confirmed from primary sources. WRAPS exists to carry trust across changing keys. With a fixed creator key its statement collapses to one signature under the key committed by the pinned genesis, and it cannot supply freshness. A stays selected; B, C, and D are rejected as the authority solution; E's primitives are reused.

**Recommended 0b0b decision** (design only):
1. Cold reopen at epoch N authenticates as: pinned digest → caller-held genesis anchor preimage and signature (already the reopen input) → current record's profile and signer-set bytes must hash to the genesis anchor's digests → creator key verifies the current anchor signature → all anchor fields are then authenticated → 0b0 floor must equal the head tuple exactly. This keeps exactly one trust record in the active closure and leaves the exactly-one inspectors untouched. Keep the dual-record variant only as fallback.
2. Active closure at epoch N retains only the current trust, cut, and QC plus projection, ACL, manifest, and recovery refs. Prior transition members live only in the two rollback generations. Absence of the retained predecessor record is a typed fail-closed availability result.
3. Change the advance predicate so the proposed closure equals current minus the three retired members plus the three new ones. For 0→1 this is byte-identical to today, so first-transition vectors are unchanged. This alters an exported control-plane predicate and must be declared, or retirement moves into live-generation staging. Choose one in 0b0b.
4. Prune retired bytes only after they leave the two-generation window, the floor has committed at N, and D.109 gates pass.
5. Security assumptions: authentic out-of-band pin, honest uncompromised creator key, strict Ed25519 and domain-separated SHA-256, hostile storage, honest provider for latestness. Not claimed: lone-fork detection without a floor, brand-new-client freshness, chain-verified history evolution, archive-root evolution.

**Required prerequisite.** Yes. An epoch-N opener is a genuinely new protocol-v3 export, so the stop-check deferred to 0b1 has a deterministic answer now. 0b0b must declare that public-contract exception before 0b1 RED, together with the closure-law placement.

**Gates.** RED after a/b GREEN: epoch≥2 reopen fails without replay, census grows by two per transition, stale checkpoint accepted without floor and rejected with it, no fixture record. GREEN: every tampered carrier or binding fails with an exact code before activation or deletion, deleted rollback generation yields a typed availability failure, census is constant through the D.110c-d 100-transition run, archive bytes are counted separately, legacy 0→1 rooms unchanged. Adversarial: foreign-room record, cross-genesis carriers, mismatched previousAnchor, two same-epoch records, epoch gap, floor lag/ahead/conflict, replayed old head, duplicate-candidate versus true fork. Order: 0b0a GREEN, 0b0 GREEN, 0b0b acceptance, a/b GREEN, 0b1, 0c, c, d, then Phase 7 cold join, which must not assume chain-verified history and must reslice archive-root equality.

**Findings.** P0: none. P1: the epoch-N opener needs a new protocol-v3 export and should be declared in 0b0b; and 0b0a's recovery plus hot commit hard-code the genesis-only opener, literal generation kinds, and the linear closure, so 0b0b must state that the six-step protocol generalises under the bounded closure before a/b freeze O(N) into the reviewed seam. P2: HIP omits the proto's verification-key field; the compressed verifier binds neither final roster hash nor counter; add the newly pinned blobs to the ledger; mock signatures still default on; stash count drift; unrelated untracked files in the tree; the closure scan limit equals the record maximum; the D.110c-a empty-accumulator gap remains open.

D110C_0B0B_DESIGN_READY: YES, with the two P1 declarations written into the 0b0b text. Neither adds a dependency, wire field, setup artifact, authority, or migration.
