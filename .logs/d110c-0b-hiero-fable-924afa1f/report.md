# D.110c-0b advisory audit: bounded trust checkpoint vs Hiero/WRAPS

Advisory only. No file outside this report was edited, no test was run, no agent was spawned, and nothing here authorizes a production change. The recommended next step is a governed design prerequisite (D.110c-0b1), not implementation.

## Context

D.110c-0b asks how a room at epoch N can cold-reopen its current trust from the pinned genesis without replaying an O(N) cut/QC chain, without trusting storage bytes, and without hiding growth in another store. The plan already selects a "bounded dual-anchor creator checkpoint plus two rollback generations" and rejects WRAPS, an external pin, and a Merkle proof as the authority solution, conditional on D.110c-0b0 supplying a freshness floor. This audit independently re-inspects the local owners and the Hiero sources, re-pins revisions, and checks the selection against the stated constraints.

## Inspected revisions

Local: `ts-drp` HEAD `685611728ecfe37bbdb09369f245f9a909fcf776` on `codex/phase3a1b-p6-golden-path`, plus an uncommitted working tree (19 files, +627/-39) that carries in-progress D.110c-0b0 GREEN plumbing (`V3RoomHeadAuthority` in `examples/v3-room/src/index.ts`, `expectedRoomHead` in `packages/node/src/creator-adoption-activate.ts`, and the 0b0 RED test rewritten to expect GREEN). Findings below say which state they refer to.

Upstream, fetched 2026-09-02. All three `main` heads still equal the plan's pins:

| Repo | main head (date) | Tree | Matches plan pin |
| --- | --- | --- | --- |
| hiero-improvement-proposals | `54ccb06659592ab201e7adea632f1019e9faa00e` (2026-08-27) | `42ff7d2c…` | yes |
| hiero-consensus-node | `1aa1d6c153907750cfbba6935b7a21867053968e` (2026-09-01) | `7c7adb30…` | yes |
| hiero-cryptography | `39f28f39f609f80e52253d86169e2db5216a713e` (2026-08-25, release 3.15.2) | `909b4696…` | yes |

Blob SHAs I re-read at those commits and confirmed equal to the plan's pins: `HistoryLibrary.java` `c4c998d0…`, `HistoryLibraryImpl.java` `c53deacb…`, `WrapsHistoryProver.java` `fc7c893b…`, `WritableHistoryStoreImpl.java` `58953750…`, `V071HistorySchema.java` `0cb24998…`, `TssHandoffCoordinator.java` `8ca7f9a8…`, `WrapsProvingKeyVerification.java` `e15e6c35…`, wraps `lib.rs` `5beccdf8…`, wraps `Cargo.toml` `f5aba82b…`. Additional files inspected: `history_types.proto`, `HistoryServiceImpl.java`, `ProofControllerImpl.java`, `ProofControllers.java`, `WRAPSLibraryBridge.java` (`d0702b36…`), `TssConfig.java`, `hedera-node/docs/exact-weight-tss.md`, and `DefaultSignedStateValidator.java`, which now lives at `platform-sdk/consensus-reconnect-impl/src/main/java/org/hiero/consensus/reconnect/impl/DefaultSignedStateValidator.java` (blob `191d4873…`), not under `swirlds-platform-core/.../reconnect` as older references suggest. `RosterTransitionWeights.java` was not found at the guessed path, so the exact 1/3 and 2/3 fractions used off-circuit are taken from the design doc and HIP, not re-verified in Java.

Source links (pinned):
- https://github.com/hiero-ledger/hiero-improvement-proposals/blob/54ccb06659592ab201e7adea632f1019e9faa00e/HIP/hip-1200.md
- https://github.com/hiero-ledger/hiero-consensus-node/blob/1aa1d6c153907750cfbba6935b7a21867053968e/hedera-node/docs/exact-weight-tss.md
- https://github.com/hiero-ledger/hiero-consensus-node/tree/1aa1d6c153907750cfbba6935b7a21867053968e/hedera-node/hedera-app/src/main/java/com/hedera/node/app/history
- https://github.com/hiero-ledger/hiero-consensus-node/blob/1aa1d6c153907750cfbba6935b7a21867053968e/hedera-node/hedera-app/src/main/java/com/hedera/node/app/tss/TssHandoffCoordinator.java
- https://github.com/hiero-ledger/hiero-consensus-node/blob/1aa1d6c153907750cfbba6935b7a21867053968e/platform-sdk/consensus-reconnect-impl/src/main/java/org/hiero/consensus/reconnect/impl/DefaultSignedStateValidator.java
- https://github.com/hiero-ledger/hiero-cryptography/blob/39f28f39f609f80e52253d86169e2db5216a713e/cryptography/hedera-cryptography-wraps/src/main/rust/wraps/src/lib.rs

## What the local code does today (HEAD)

- **Genesis-only opener.** `openCurrentAnchorTrust` at `packages/protocol-v3/src/index.ts:1437-1438` rejects any record where `currentAnchorDigest !== genesisAnchorDigest` or `currentEpoch !== 0`. The epoch-relative successor minter at `index.ts:1668-1717` accepts only `epoch === current + 1` with the same profile/signer-set digests and the same public key. So epoch N trust exists only as a chain of in-memory successor mints from genesis.
- **Exactly-one trust record.** `inspectTrustClosure` at `packages/control-plane/src/anchor-trust.ts:404-406` returns `trust-state-ambiguous` when a closure holds two trust records among candidates of at most 8192 bytes. `assertTrustPreserved` (`anchor-trust.ts:439`) only requires the previously selected trust ref to persist; it does not constrain other closure members.
- **Linear closure law.** `exactCombinedClosure` at `packages/control-plane/src/creator-trust-advance.ts:88-99` requires proposed closure = current closure minus current trust plus successor trust plus cut plus commit QC. Callers copy `current.references` wholesale (`packages/node/src/creator-close.ts:560-566`; `creator-adoption-commit.ts:299`; `creator-adoption.ts:344,972`). Each close therefore adds two refs and never removes the older cut/QC.
- **First-transition-only cold reopen.** `reopenCreatorSuccessorMaterial` at `packages/node/src/creator-adoption.ts:901-999` requires the three-generation shape (Superseded, Superseded, Adopted), a unique `v3-live-generation-1` and `-2` projection, opens the genesis record with the genesis-only opener, then opens exactly one successor QC. It cannot open epoch 2 or later.
- **Rollback window.** `packages/storage/src/maintenance.ts:48,162-166,414-428` fixes exactly two distinct `Superseded` rollback generations.
- **History and archive bindings.** `packages/protocol-v3/src/creator-close.ts:369-378` requires `archiveIndexRoot` unchanged and `historySize === previous + closeSetCount`; the cut carries `previousHistoryRoot/Size` and the accumulator snapshot. The accumulator (`packages/compaction/src/ct-merkle.ts`) is a SHA-256 RFC 9162-style peak set with size capped at `Number.MAX_SAFE_INTEGER` (at most 53 peaks).
- **Working tree (uncommitted 0b0).** `reopenCreatorSuccessorAdoption` now fails `D110C_FLOOR_MIGRATION_REQUIRED` without `expectedRoomHead` and `D110C_FLOOR_MISMATCH` when the reopened trust differs from it (`creator-adoption-activate.ts:260-288`). The provider contract and CAS orchestration live in `examples/v3-room/src/index.ts:257-280, 871-979, 3465-3479`.

## What Hiero/Hiero WRAPS actually establishes (implemented vs proposed)

**Proposal layer.** HIP-1200 (status Approved) defines the ledger id as the SHA-256 hash of the genesis address book, describes a recursive SNARK chain-of-trust from the ledger id to the current hinTS verification key, gives packed block-signature sizes (3,432 bytes normal, 2,920 bootstrap), and states that ArkWorks-to-snarkjs verifier compatibility is "currently unconfirmed". It uses "greater than 1/2 of the weight" for the access structure and genesis block, "at least one third of the weight" for roster-change voting, and "strictly more than 2/3" for key readiness, in different sections. `exact-weight-tss.md` is a design document ("high-level design of how Hiero TSS is implemented"); it defines the ledger id as the hash of ids, weights and Schnorr public keys, asks verifiers to validate the ledger id out of band, and states signatures and verification cost are independent of network size.

**Implemented layer (consensus node at the pin).**
- `HistoryLibrary.verifyCompressedProof(compressedProof, ledgerId, metadata)` delegates to the native bridge `verifyCompressedProofImpl(compressedProof, genesisAddressBookHash, tssVerificationKey, wrapsVerificationKey)`.
- The Rust circuit (`lib.rs`) is Nova over BN254/Grumpkin with KZG and Pedersen commitments and a Groth16 `DeciderEth`; the folding state is two field elements `[addressBookHash, hintsVkHash]`; address books are padded to `MAX_AB_SIZE = 128` with zero-weight dummies and hashed with Poseidon; the in-circuit authorization check is `total_weight < 2 * aggregate_weight` (strictly more than one half of the previous roster). The step counter `i` is carried in the IVC state but is not exposed or bound by the verifier.
- `verify_compressed_wraps_proof` checks only three things: the decider proof verifies, `z_0[0] == genesisHash`, and `z_i[1] == hash(hintsVk)`. It does not bind `z_i[0]` (the final address book hash) or the transition count.
- Off-circuit thresholds are read from `RosterTransitionWeights`: vote acceptance is `validWeight >= sourceWeightThreshold()` counting only proofs that pass `verifyCompressedProof`, and assembly after grace uses `publishedWeight() >= targetWeightThreshold()` (`ProofControllerImpl`). The documented fractions (1/3 source votes, >2/3 target readiness) are distinct from the in-circuit >1/2 rule.
- Incremental construction needs the prior **uncompressed** proof (`sourceProof.uncompressedWrapsProof()` in `WrapsHistoryProver`), plus in-flight R1/R2/R3 messages and 32-byte entropy.
- Persistent state (`V071HistorySchema`): `LEDGER_ID`, `ACTIVE_PROOF_CONSTRUCTION`, `NEXT_PROOF_CONSTRUCTION`, `PROOF_KEY_SETS`, `PROOF_VOTES`, `WRAPS_MESSAGE_HISTORIES`; `HistoryProof` carries `target_proof_keys`, `target_history`, `chain_of_trust_proof`, `uncompressed_wraps_proof`.
- Handoff (`WritableHistoryStoreImpl.handoff`) refuses a roster-hash mismatch, refuses a forced handoff without a complete proof, promotes next to active, resets next to default, purges votes and WRAPS message histories for the obsolete construction, and removes proof keys of departed nodes when the roster membership changed. `TssHandoffCoordinator` promotes History and Hints together only when the history proof's `targetMetadata` equals the hinTS verification key; forced handoff is used only in the non-WRAPS mode.
- Reconnect: `ProofControllers.stop()` cancels pending work; `DefaultSignedStateValidator` prunes invalid signatures against the roster, requires verifiability, and `throwIfOld` rejects a learned state whose round or consensus timestamp is behind the learner's pre-reconnect `SignedStateValidationData`.
- Proving artifacts: four files (`nova_pp.bin`, `nova_vp.bin`, `decider_pp.bin`, `decider_vp.bin`) from a multi-gigabyte tarball verified by SHA-384 against `tss.wrapsProvingKeyHash`; the default download is `https://builds.hedera.com/tss/hiero/wraps/v1.0/wraps-v1.0.0.tar.gz`. The compressed proof is 704 bytes; the WRAPS verification key is 1768 bytes.
- `TssConfig` at the pin still defaults `forceMockSignatures = true` ("true in prod until streamMode=BLOCKS") while `hintsEnabled`, `historyEnabled` and `wrapsEnabled` default true. Source presence is not evidence of public-network enablement.

**So WRAPS proves exactly:** "there exists a sequence of roster transitions starting at the pinned genesis hash, each authorized by more than half the previous roster's weight, ending at a roster whose hinTS verification key hashes to this value." It does not prove which roster is latest, how many transitions occurred, or that the presented roster hash is the endpoint (the caller must supply and trust the metadata it checks). Freshness is external: signed-state round/timestamp floors and block numbers.

**Retained state and constant-size claims.** The externally presented proof and its verification cost are constant. The system is not stateless: it retains the ledger id, the active and at most one next construction, proof keys, in-flight votes and signing messages, the target history, and the uncompressed proof needed to extend recursion, plus gigabytes of proving artifacts on every prover. Pruning follows a completed, matching, jointly promoted handoff; nothing is purged for an unadopted next construction.

**Assumptions.** Authentic out-of-band ledger id; sound native cryptography and correct proving/verifying keys (a Groth16 decider implies a circuit-specific trusted setup and a CRS); honest-majority-by-weight source authorization; sufficient target participation for liveness; available state and block distribution for freshness.

## Concept map without conflation

| Hiero concept | Nearest ts-drp concept | Where the analogy breaks |
| --- | --- | --- |
| Ledger id = hash(genesis roster) | Pinned genesis anchor digest (`pinnedGenesisAnchorDigest`) | Both are out-of-band pins; Hiero's binds a weighted roster, ts-drp's binds one creator key plus profile/signer-set digests. |
| Evolving roster + proof keys | Room ACL digest inside the signed anchor | In `creator-trusted-v1` the signer set never changes; only ACL/state/history fields evolve. |
| Roster transition (WRAPS step) | Epoch close: cut + commit QC + successor trust record | Hiero's step is authorized by >1/2 of the previous roster; ts-drp's is authorized by the same single key that signs the anchor, so the QC is a self-certification, not a second authority. |
| Compressed proof `(genesisHash, hintsVkHash)` | A current trust record signed by the genesis-established key | The ts-drp analogue is one signature check, because the authority is fixed. |
| Signed state + `throwIfOld` | D.110c-0b0 account-held room-head floor | Hiero's floor is the learner's own prior state; ts-drp's must come from outside hostile storage because a browser origin can be rolled back wholesale. |
| Block/mirror history | Archived room epochs, segments | Application bytes, not authority proof, in both systems. |
| Handoff purge | D.109 cleanup after adoption and two rollback generations | Both purge only after a completed, matching promotion. |

## Candidate comparison and decision matrix

Constraints applied: untrusted latest self-authentication is insufficient; epoch/anchor/ACL/history/recovery must authenticate from pinned genesis; ordinary cold reopen must not require O(N) control evidence or hide it elsewhere; application history may be separate; no ledger scope.

| Criterion | A. Stable genesis signer signs current checkpoint (dual-anchor v1) | B. Externally pinned periodic checkpoint | C. WRAPS-like recursive transition proof | D. Logarithmic Merkle/skip consistency proof | E. Existing anchor + cut/QC chain unchanged |
| --- | --- | --- | --- | --- | --- |
| Security proof obligations | Genesis pin → profile/signer-set digests → creator key → Ed25519 over current anchor; bind objectId, genesisAnchorDigest, epoch, ACL, history root/size, archive root, snapshot/manifest, recovery. Freshness from 0b0 floor. | Same as A plus trust in the pin service's monotonicity and availability. | Circuit soundness, Groth16 setup/CRS, Poseidon, Schnorr aggregation, native/JNI correctness, plus a separate freshness floor. | Hash preimage resistance only; proves append-consistency between two roots, not who authorized a transition. | Same primitives as A but the opener is epoch-0-only and each QC is verified in sequence. |
| Browser/TypeScript feasibility | Yes; existing `@noble` Ed25519/SHA-256 and canonical codecs. | Yes for the client half; the service is new. | No browser verifier in the inspected source; ArkWorks/snarkjs compatibility unconfirmed (HIP-1200). | Yes, hash-only. | Yes. |
| Dependencies and setup | None new. | New service, credential protocol, availability policy. | Native Rust/JNI, multi-GB proving artifacts, SHA-384-pinned tarball, 128-entry circuit bound, trusted setup. | None new. | None. |
| Schema/API/migration | v1 record already carries `currentEpoch`, `currentAnchorDigest`, `genesisAnchorDigest`, carriers and signature: no wire change. Needs a generalized opener and a Node reopen path (public export behavior change). | New wire carrier and API. | New proof fields, keys, wire, migration. | New proof schema and control-proof semantics. | None, but fails the bound. |
| Cold reopen cost | O(1): genesis preimage (caller-held, hash-pinned), one current record, current cut/QC, floor read. | O(1) local plus network round trip. | O(1) verify, but prover-side O(step) recursion state. | O(log N) proof plus retained index. | O(N) QC replay. |
| Rollback/availability | Two D.109 rollback generations; fail closed on missing floor or generation. | Depends on service uptime. | Not zero-state: uncompressed prior proof and artifacts must be available to extend. | Requires retained accumulator/index. | Full chain must be available. |
| Archive separation | Archive root bound in anchor; bytes separate. | Same. | Same. | Same. | Same. |
| Attack resistance | Tamper, cross-object, cross-genesis, key substitution: rejected by digests/signature. Stale/forked valid record: rejected only by floor. Creator equivocation: out of model. | Adds resistance to rollback if the service is honest. | Adds nothing for a fixed signer; strong only when authority rotates. | No authority resistance. | Same as A minus the bound. |
| Safe pruning | Cut/QC older than N-1 retire after floor advance, head CAS, adoption, two rollback generations, availability/snapshot/outbox gates. | Same as A. | Purge after matching handoff. | N/A. | Cannot prune. |
| Verdict | **Select, as the simplest sufficient construction.** | Reject for 0b (Phase 7 bootstrap candidate). | Reject as disproportionate; revisit only if creator/seal authority rotates. | Reject as authority solution; keep RFC 9162 for history. | Reject unchanged. |

**Independent conclusion.** The plan's selection (A) is correct and is also the simplest construction compatible with the existing anchor/QC/RFC 9162/authority model. With a fixed creator signer, an authority-lineage proof degenerates to one signature under a key that the pinned genesis already commits to. WRAPS solves a problem ts-drp does not have (rotating weighted authority) and cannot supply the one property ts-drp lacks (freshness).

## Recommendation for D.110c-0b

1. **Keep the bounded dual-anchor v1 decision.** Do not import WRAPS, an external pin, or a Merkle authority proof.
2. **Prefer the caller-held genesis-carrier shape for 0b1.** The reopen input already carries the genesis anchor preimage and signature and hash-checks them against the pin (`packages/node/src/v3-live.ts:2166-2180`; `creator-adoption.ts:987-991`). The current record's `exactCanonicalProfileBytes` and `exactCanonicalSignerSetBytes` can be authenticated by digest against that pinned genesis preimage (the same check the epoch-0 opener performs at `index.ts:1445-1446`). Then the creator key verifies the current anchor signature. This keeps exactly one trust record in the active closure, leaves `inspectTrustClosure`/`assertTrustPreserved` exactly-one contracts untouched, needs no new record kind, and satisfies "authenticate from pinned genesis" without a second record in the closure. The plan already files this variant as P2 guidance; this audit recommends making it the primary 0b1 candidate.
3. **Bound the closure in the live-generation path, not in the advance predicate.** `assertTrustPreserved` does not constrain closure membership, so retiring the N-2→N-1 cut/QC can happen in the ordinary post-adoption live generation staging while D.109 keeps them in two rollback generations. `exactCombinedClosure` only requires "current minus trust plus three", so it tolerates a previously compacted closure without modification.
4. **Treat the opener generalization as the declared high-risk prerequisite.** Relaxing `openCurrentAnchorTrust`'s `currentEpoch === 0` and `currentAnchorDigest === genesisAnchorDigest` rules, or adding a private epoch-N opener, and generalizing `reopenCreatorSuccessorMaterial` beyond the three-generation shape are protocol-v3/Node public-behavior changes. Per the plan's own rules this is D.110c-0b1 and must receive its Grok/Kimi/Opus review before RED. Nothing here should be implemented in this session.
5. **State the security claim precisely.** Under bounded reopen, history root/size, ACL digest, archive root and snapshot bindings are authenticated by the creator's signature over the current anchor, not by chain-verified extension from genesis. RFC 9162 consistency proofs remain available only between retained snapshots. The umbrella GREEN bullets should say so to avoid a stronger reading.
6. **Do not ship without 0b0.** A valid older creator-signed checkpoint is indistinguishable from the latest after full rollback; the account-held floor is the only freshness owner and is correctly required on every reopen.

## Risks

**P0.** None found that blocks the design, assuming 0b0's honest external floor.

**P1.**
- **0b1 will trip its own stop-check unless the opener change is pre-declared.** Any epoch-N cold open requires either a semantic change to the exported `openCurrentAnchorTrust` or a new exported opener, plus a Node reopen path that is not first-transition-shaped. The plan says 0b1 "must prefer a private composition" and stops if a public API change is "genuinely required". It is required. Recommend declaring that boundary now so 0b1 RED does not end in a reslice.
- **Acceptance text overstates history authentication.** GREEN requires "history root/size ... authenticated" from genesis. Bounded reopen can only prove creator-signed current values; epoch-by-epoch extension is provable only inside the rollback window. Phase 7 archive cold-join must not assume chain-verified history evolution.
- **Predecessor-QC reopen couples ordinary reopen to rollback-generation availability.** The plan requires reopening the epoch-N-1 trust from the newest `Superseded` generation to verify the N-1→N QC. In creator-only scope the QC is signed by the same key as the anchor, so this is a consistency check, not an added trust root. If it stays mandatory, a hostile store that deletes one rollback generation turns a verifiable current trust into a fail-closed outage. Acceptable if intended, but it should be recorded as an availability trade, not a security requirement.

**P2.**
- Hiero thresholds must not be collapsed: in-circuit >1/2 of source weight; off-circuit vote acceptance `>= sourceWeightThreshold()` (documented as 1/3); target readiness `>= targetWeightThreshold()` (documented as >2/3); HIP text mixes these. None applies to ts-drp's quorum 1.
- The compressed WRAPS verifier does not bind the final roster hash or transition count; any future recursive design for ts-drp would have to add those as public inputs and still needs a separate freshness floor.
- The 0b0 provider contract currently lives in `examples/v3-room`, an example package. The D.110c-c/d census and the public-contract review should name the production owner explicitly.
- `inspectTrustClosure` scans only candidates of at most 8192 bytes; the trust record maximum (`ANCHOR_TRUST_STATE_MAX_RECORD_BYTES`) must stay below that or a valid record silently becomes `candidate-not-scannable`.
- RFC 9162 accumulator ceiling is 53 peaks by construction (size capped at `Number.MAX_SAFE_INTEGER`); the plan's corrected 53 is consistent with `ct-merkle.ts:372`.
- `archiveIndexRoot` is frozen across closes (`protocol-v3/src/creator-close.ts:369`); Phase 7 archive evolution remains a separate wire/authority reslice, as the plan states.
- `DefaultSignedStateValidator` has moved packages upstream; the plan's pinned test-blob references for reconnect should cite the `consensus-reconnect-impl` path at the pin.

## Verification (advisory)

No tests were run. If the user wants to confirm the local findings quickly:

```
grep -n "currentEpoch !== 0" packages/protocol-v3/src/index.ts
grep -n "trust-state-ambiguous" packages/control-plane/src/anchor-trust.ts
grep -n "exactCombinedClosure" packages/control-plane/src/creator-trust-advance.ts
grep -n "v3-live-generation-1\|v3-live-generation-2" packages/node/src/creator-adoption.ts
```
