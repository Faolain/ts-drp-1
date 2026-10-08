import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { installCertifiedAnchorTrustRoot } from "@ts-drp/protocol-v3";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { installInput, makeCertifiedGenesis } from "./fixtures/phase-3b-v3/certified-genesis-contract.js";
import {
	ANCHOR,
	CUT_VALUE,
	CUT_VALUE_FIELDS,
	EXACT_CUT_VALUE_BYTES,
	OBJECT_ID,
	proposalHash,
	QUORUM,
	VALUE_DIGEST,
	votePreimage,
} from "./fixtures/phase-5-v3/seal-contract.js";
import {
	carrierDigest,
	emptyOracleState,
	loadCandidateSealModules,
	oracleCarrier,
	oracleCommit,
	ownerReadiness,
	REPOSITORY_ROOT,
} from "./fixtures/phase-5-v3/seal-fixture.js";
import { EXPECTED_EXPORTS, type SealStorePort } from "./fixtures/phase-5-v3/seal-types.js";
import {
	consumeSealVoteIntent,
	mintSealStorePort,
	resolveSealVoterEnrollment,
} from "../packages/seal/src/storage-port.js";

interface SafetyContract {
	readonly limits: {
		readonly dispatchConcurrency: number;
		readonly epoch: number;
		readonly phases: readonly string[];
		readonly signatureBytes: number;
	};
	readonly model: { readonly module: string; readonly path: string; readonly runs: readonly string[] };
	readonly mutants: readonly string[];
	readonly requiredOwners: readonly string[];
	readonly schema: {
		readonly currentVersion: number;
		readonly legacyStores: readonly string[];
		readonly voteStores: readonly string[];
		readonly voteTransactionStores: readonly string[];
	};
}

const contract = JSON.parse(
	readFileSync(resolve(REPOSITORY_ROOT, "tests/fixtures/phase-5-v3/seal-safety-contract.json"), "utf8")
) as SafetyContract;
const readiness = ownerReadiness();

function exactKeys(value: object): string[] {
	return Reflect.ownKeys(value)
		.filter((key): key is string => typeof key === "string")
		.sort();
}

function boundSealIdentity(
	input: Readonly<{
		phase: "prepare" | "commit";
		previousAnchor: string;
		round: number;
		signerId: string;
	}>
): Readonly<{
	exactCanonicalCutValueBytes: Uint8Array;
	exactCanonicalVotePreimageBytes: Uint8Array;
	proposalHash: string;
	valueDigest: string;
}> {
	const exactCanonicalCutValueBytes = encodeCanonical({
		...(decodeCanonical(EXACT_CUT_VALUE_BYTES) as Record<string, unknown>),
		previousAnchor: input.previousAnchor,
	});
	const valueDigest = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", exactCanonicalCutValueBytes)).toString("hex");
	const proposalHashValue = Buffer.from(
		hashDomain(
			"ts-drp/seal-proposal/v3",
			encodeCanonical({ epoch: 0, kind: "drp-seal-proposal", objectId: OBJECT_ID, round: input.round, valueDigest })
		)
	).toString("hex");
	return Object.freeze({
		exactCanonicalCutValueBytes,
		exactCanonicalVotePreimageBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-seal-vote",
			objectId: OBJECT_ID,
			phase: input.phase,
			proposalDigest: valueDigest,
			proposalHash: proposalHashValue,
			round: input.round,
			signerId: input.signerId,
		}),
		proposalHash: proposalHashValue,
		valueDigest,
	});
}

function createOracleStore(
	initialState = emptyOracleState()
): Readonly<{ port: SealStorePort; state(): ReturnType<typeof emptyOracleState> }> {
	let state = initialState;
	const port = mintSealStorePort({
		commitVote(raw: unknown) {
			if (raw === null || typeof raw !== "object" || Reflect.ownKeys(raw).length !== 0) {
				return Promise.resolve({ ok: false, reason: "NON_OPAQUE_VOTE_INTENT" });
			}
			const input = consumeSealVoteIntent(raw);
			if (input === undefined) return Promise.resolve({ ok: false, reason: "UNTRUSTED_VOTE_INTENT" });
			if (consumeSealVoteIntent(raw) !== undefined) {
				return Promise.resolve({ ok: false, reason: "REUSABLE_VOTE_INTENT" });
			}
			const result = oracleCommit({ ...input, state });
			if (result.ok) state = result.state;
			return Promise.resolve(result);
		},
		openSnapshot(enrollment: unknown) {
			const scope = resolveSealVoterEnrollment(enrollment);
			if (scope === undefined) return Promise.reject(new TypeError("untrusted enrollment"));
			return Promise.resolve(
				Object.freeze({
					enteredRound: state.enteredRound,
					incarnation: state.incarnation,
					revision: state.revision,
				})
			);
		},
	});
	return Object.freeze({ port, state: () => state });
}

describe.sequential("Phase 5a-c atomic seal safety RED", () => {
	it("executes independent registry, identity, schema and transaction controls before readiness", () => {
		const registry = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/protocol-v3/registry/registry-v1.json"), "utf8")
		) as { readonly kinds: { readonly cutValue: { readonly fields: readonly { readonly name: string }[] } } };
		expect(CUT_VALUE_FIELDS).toEqual(registry.kinds.cutValue.fields.map(({ name }) => name).sort());
		expect(Reflect.ownKeys(CUT_VALUE).sort()).toEqual(CUT_VALUE_FIELDS);
		expect(contract.requiredOwners).toEqual([
			"packages/protocol-v3/src/seal.ts",
			"packages/keychain/src/finality.ts",
			"packages/seal/src/index.ts",
			"packages/storage-browser/src/seal-vote.ts",
		]);
		expect(contract.schema).toEqual({
			currentVersion: 2,
			legacyStores: ["blobs", "generations", "objects", "promotions"],
			voteStores: ["signerState", "storageMeta", "voteOutbox", "voteSlots"],
			voteTransactionStores: ["signerState", "storageMeta", "voteOutbox", "voteSlots"],
		});
		expect(contract.limits).toEqual({
			dispatchConcurrency: 4,
			epoch: 0,
			phases: ["prepare", "commit"],
			signatureBytes: 64,
		});
		expect(new Set(contract.mutants).size).toBe(contract.mutants.length);
		expect(contract.mutants).toEqual([
			"round-in-cut-value",
			"proposal-hash-lock",
			"mixed-qc",
			"signature-length-only",
			"duplicate-signer-count",
			"validation-after-write",
			"state-only-commit",
			"vote-only-commit",
			"outbox-only-commit",
			"provisional-byte-release",
			"put-overwrite",
			"revision-ignore",
			"incarnation-ignore",
			"default-durability",
			"async-signing-after-transaction-start",
			"lock-as-authority",
			"empty-takeover",
			"raw-seeded-outbox-dispatch",
			"queue-coalescing",
			"prefix-only-outbox-recovery",
			"late-upgrade-after-timeout",
			"graceful-close-as-crash",
		]);

		expect(VALUE_DIGEST).toBe(
			Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", EXACT_CUT_VALUE_BYTES)).toString("hex")
		);
		expect(proposalHash(0)).not.toBe(proposalHash(1));
		expect(votePreimage({ phase: "prepare", round: 1, signerId: "A" })).toMatchObject({
			epoch: 0,
			objectId: OBJECT_ID,
			proposalDigest: VALUE_DIGEST,
			proposalHash: proposalHash(1),
		});
		expect(encodeCanonical(decodeCanonical(EXACT_CUT_VALUE_BYTES))).toEqual(EXACT_CUT_VALUE_BYTES);
		expect(ANCHOR).toHaveLength(64);
		expect(QUORUM).toBe(3);

		const first = oracleCarrier({ phase: "prepare", round: 0, signerId: "A" });
		const committed = oracleCommit({
			carrier: first,
			expectedIncarnation: "incarnation-A",
			expectedRevision: 0,
			phase: "prepare",
			round: 0,
			signerId: "A",
			state: emptyOracleState(),
		});
		expect(committed.ok).toBe(true);
		if (!committed.ok) return;
		expect(committed.duplicate).toBe(false);
		expect(committed.state.revision).toBe(1);
		expect(committed.state.slots.size).toBe(1);
		expect(committed.state.outbox.size).toBe(1);

		const duplicate = oracleCommit({
			carrier: Object.freeze({
				exactCanonicalPreimageBytes: Uint8Array.from(first.exactCanonicalPreimageBytes),
				signature: new Uint8Array(64).fill(0xee),
			}),
			expectedIncarnation: "incarnation-A",
			expectedRevision: 1,
			phase: "prepare",
			round: 0,
			signerId: "A",
			state: committed.state,
		});
		expect(duplicate.ok && duplicate.duplicate).toBe(true);
		if (duplicate.ok) expect(carrierDigest(duplicate.stored)).toBe(carrierDigest(first));

		const conflictCarrier = oracleCarrier({ phase: "prepare", round: 0, signerId: "A" });
		conflictCarrier.exactCanonicalPreimageBytes[conflictCarrier.exactCanonicalPreimageBytes.length - 1] ^= 1;
		const conflict = oracleCommit({
			carrier: conflictCarrier,
			expectedIncarnation: "incarnation-A",
			expectedRevision: 1,
			phase: "prepare",
			round: 0,
			signerId: "A",
			state: committed.state,
		});
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.reason).toBe("VOTE_CONFLICT");
		expect(
			oracleCommit({
				carrier: first,
				expectedIncarnation: "recreated",
				expectedRevision: 1,
				phase: "prepare",
				round: 0,
				signerId: "A",
				state: committed.state,
			})
		).toEqual({ ok: false, reason: "STORAGE_LOSS" });
	});

	it("typechecks and executes the exact bounded n=4 Quint witness", () => {
		const modelPath = resolve(REPOSITORY_ROOT, contract.model.path);
		const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", modelPath], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
		});
		expect(typecheck.status, `${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
		const executed = spawnSync(
			"pnpm",
			[
				"exec",
				"quint",
				"test",
				modelPath,
				"--main",
				contract.model.module,
				"--match",
				"^test",
				"--backend",
				"typescript",
			],
			{ cwd: REPOSITORY_ROOT, encoding: "utf8" }
		);
		expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
		for (const run of contract.model.runs) expect(`${executed.stdout}\n${executed.stderr}`).toContain(run);
	});

	it("[RED readiness] requires the complete four-owner atomic product graph", () => {
		expect(readiness, `missing D.105b owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.runIf(readiness.ready)("binds a genuine certified roster key to its independent signer ID", async () => {
		const modules = await loadCandidateSealModules();
		expect(exactKeys(modules.browser)).toEqual(EXPECTED_EXPORTS.browser);
		expect(exactKeys(modules.protocol)).toEqual(EXPECTED_EXPORTS.protocol);
		expect(exactKeys(modules.keychain)).toEqual(EXPECTED_EXPORTS.keychain);
		const material = makeCertifiedGenesis({ objectId: OBJECT_ID, profileId: "attested-bft-v1", quorum: 3 });
		const installed = installCertifiedAnchorTrustRoot(installInput(material));
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		const selected = material.signers[1];
		const finality = await modules.keychain.createRecoverableFinalitySigner({ seed: selected.privateKey });
		expect(Buffer.from(finality.publicKey).toString("hex")).toBe(selected.publicKey);
		const opened = modules.protocol.openSealAuthority({
			signerPublicKey: finality.publicKey,
			trust: installed.trust,
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.signerId).toBe(selected.signerId);
		const identity = boundSealIdentity({
			phase: "prepare",
			previousAnchor: material.anchorDigest,
			round: 1,
			signerId: selected.signerId,
		});
		const prepared = modules.protocol.prepareSealVote({
			authority: opened.authority,
			exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
			phase: "prepare",
			round: 1,
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.exactCanonicalPreimageBytes).toEqual(identity.exactCanonicalVotePreimageBytes);
		expect(prepared.valueDigest).toBe(identity.valueDigest);
		expect(prepared.proposalHash).toBe(identity.proposalHash);
		expect(prepared.registeredDigest).toEqual(
			hashDomain("ts-drp/seal-vote/v3", identity.exactCanonicalVotePreimageBytes)
		);
		const signature = await modules.keychain.signSealRegisteredDigest({
			request: prepared.signingRequest,
			signer: finality.signer,
		});
		expect(signature).toHaveLength(64);
		expect(ed25519.verify(signature, prepared.registeredDigest, finality.publicKey, { zip215: false })).toBe(true);
		await expect(
			modules.keychain.signSealRegisteredDigest({ request: prepared.signingRequest, signer: finality.signer })
		).rejects.toThrow(/consumed/u);
		await expect(
			modules.keychain.signSealRegisteredDigest({
				request: Uint8Array.from(prepared.registeredDigest),
				signer: finality.signer,
			})
		).rejects.toThrow(/untrusted/u);
	});

	it.runIf(readiness.ready)(
		"authenticates an exact sorted 3-of-4 QC and rejects mixed or duplicate votes",
		async () => {
			const modules = await loadCandidateSealModules();
			const material = makeCertifiedGenesis({ objectId: OBJECT_ID, profileId: "attested-bft-v1", quorum: 3 });
			const installed = installCertifiedAnchorTrustRoot(installInput(material));
			expect(installed.ok).toBe(true);
			if (!installed.ok) return;
			const identities = new Map<string, ReturnType<typeof boundSealIdentity>>();
			const authorities = await Promise.all(
				material.signers.slice(0, 3).map(async (selected) => {
					const finality = await modules.keychain.createRecoverableFinalitySigner({ seed: selected.privateKey });
					const opened = modules.protocol.openSealAuthority({
						signerPublicKey: finality.publicKey,
						trust: installed.trust,
					});
					if (!opened.ok) throw new Error(`failed to bind ${selected.signerId}`);
					const identity = boundSealIdentity({
						phase: "prepare",
						previousAnchor: material.anchorDigest,
						round: 0,
						signerId: selected.signerId,
					});
					identities.set(selected.signerId, identity);
					const prepared = modules.protocol.prepareSealVote({
						authority: opened.authority,
						exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
						phase: "prepare",
						round: 0,
					});
					if (!prepared.ok) throw new Error(`failed to prepare ${selected.signerId}`);
					const signature = await modules.keychain.signSealRegisteredDigest({
						request: prepared.signingRequest,
						signer: finality.signer,
					});
					return {
						authority: opened.authority,
						vote: {
							signature: Buffer.from(signature).toString("hex"),
							signerId: selected.signerId,
							voteDigest: Buffer.from(prepared.registeredDigest).toString("hex"),
						},
					};
				})
			);
			const qcIdentity = identities.get(material.signers[0].signerId);
			if (qcIdentity === undefined) throw new Error("missing independent QC identity");
			const qcBytes = encodeCanonical({
				epoch: 0,
				kind: "drp-seal-qc",
				objectId: material.anchor.objectId,
				phase: "prepare",
				proposalDigest: qcIdentity.valueDigest,
				proposalHash: qcIdentity.proposalHash,
				round: 0,
				votes: authorities.map(({ vote }) => vote),
			});
			expect(
				modules.protocol.verifySealQC({ authority: authorities[0].authority, exactCanonicalQcBytes: qcBytes })
			).toEqual({
				ok: true,
				phase: "prepare",
				proposalHash: qcIdentity.proposalHash,
				round: 0,
				valueDigest: qcIdentity.valueDigest,
			});
			const decoded = decodeCanonical(qcBytes) as Record<string, unknown>;
			expect(
				modules.protocol.verifySealQC({
					authority: authorities[0].authority,
					exactCanonicalQcBytes: encodeCanonical({
						...decoded,
						votes: [authorities[0].vote, authorities[0].vote],
					}),
				})
			).toMatchObject({ ok: false });
			const mixedSigner = material.signers[2];
			const mixedFinality = await modules.keychain.createRecoverableFinalitySigner({
				seed: mixedSigner.privateKey,
			});
			const mixedOpened = modules.protocol.openSealAuthority({
				signerPublicKey: mixedFinality.publicKey,
				trust: installed.trust,
			});
			expect(mixedOpened.ok).toBe(true);
			if (!mixedOpened.ok) return;
			const mixedIdentity = boundSealIdentity({
				phase: "prepare",
				previousAnchor: material.anchorDigest,
				round: 1,
				signerId: mixedSigner.signerId,
			});
			const mixedPrepared = modules.protocol.prepareSealVote({
				authority: mixedOpened.authority,
				exactCanonicalCutValueBytes: mixedIdentity.exactCanonicalCutValueBytes,
				phase: "prepare",
				round: 1,
			});
			expect(mixedPrepared.ok).toBe(true);
			if (!mixedPrepared.ok) return;
			const mixedSignature = await modules.keychain.signSealRegisteredDigest({
				request: mixedPrepared.signingRequest,
				signer: mixedFinality.signer,
			});
			const mixedVote = {
				signature: Buffer.from(mixedSignature).toString("hex"),
				signerId: mixedSigner.signerId,
				voteDigest: Buffer.from(mixedPrepared.registeredDigest).toString("hex"),
			};
			expect(
				modules.protocol.verifySealQC({
					authority: authorities[0].authority,
					exactCanonicalQcBytes: encodeCanonical({
						...decoded,
						votes: [authorities[0].vote, authorities[1].vote, mixedVote],
					}),
				})
			).toMatchObject({ ok: false });
			expect(
				modules.protocol.verifySealQC({
					authority: authorities[0].authority,
					exactCanonicalQcBytes: encodeCanonical({
						...decoded,
						votes: authorities.map(({ vote }, index) =>
							index === 0 ? { ...vote, signature: vote.signature.slice(0, -2) } : vote
						),
					}),
				})
			).toMatchObject({ ok: false });
		}
	);

	it.runIf(readiness.ready)(
		"releases only a detached durable carrier after the exact state-slot-outbox commit",
		async () => {
			const modules = await loadCandidateSealModules();
			expect(exactKeys(modules.seal)).toEqual(EXPECTED_EXPORTS.seal);
			const material = makeCertifiedGenesis({ objectId: OBJECT_ID, profileId: "attested-bft-v1", quorum: 3 });
			const installed = installCertifiedAnchorTrustRoot(installInput(material));
			expect(installed.ok).toBe(true);
			if (!installed.ok) return;
			const selected = material.signers[0];
			const finality = await modules.keychain.createRecoverableFinalitySigner({ seed: selected.privateKey });
			const opened = modules.protocol.openSealAuthority({
				signerPublicKey: finality.publicKey,
				trust: installed.trust,
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			const store = createOracleStore();
			const created = await modules.seal.createSealVoter({
				authority: opened.authority,
				expectedStorageIncarnation: "incarnation-A",
				signer: finality.signer,
				store: store.port,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const identity = boundSealIdentity({
				phase: "prepare",
				previousAnchor: material.anchorDigest,
				round: 0,
				signerId: selected.signerId,
			});
			const voted = await created.voter.vote({
				exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
				expectedRevision: 0,
				phase: "prepare",
				round: 0,
			});
			expect(voted).toMatchObject({ duplicate: false, ok: true });
			expect(store.state().revision).toBe(1);
			expect(store.state().slots.size).toBe(1);
			expect(store.state().outbox.size).toBe(1);
		}
	);

	it.runIf(readiness.ready)(
		"rejects wrong authority, stale revision and conflicting same-slot bytes without release",
		async () => {
			const modules = await loadCandidateSealModules();
			const material = makeCertifiedGenesis({ objectId: OBJECT_ID, profileId: "attested-bft-v1", quorum: 3 });
			const installed = installCertifiedAnchorTrustRoot(installInput(material));
			expect(installed.ok).toBe(true);
			if (!installed.ok) return;
			const foreign = await modules.keychain.createRecoverableFinalitySigner({ seed: new Uint8Array(32).fill(99) });
			expect(
				modules.protocol.openSealAuthority({ signerPublicKey: foreign.publicKey, trust: installed.trust })
			).toMatchObject({
				ok: false,
			});
			const selected = material.signers[0];
			const finality = await modules.keychain.createRecoverableFinalitySigner({ seed: selected.privateKey });
			const opened = modules.protocol.openSealAuthority({
				signerPublicKey: finality.publicKey,
				trust: installed.trust,
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			const identity = boundSealIdentity({
				phase: "prepare",
				previousAnchor: material.anchorDigest,
				round: 0,
				signerId: selected.signerId,
			});
			const store = createOracleStore();
			const created = await modules.seal.createSealVoter({
				authority: opened.authority,
				expectedStorageIncarnation: "incarnation-A",
				signer: finality.signer,
				store: store.port,
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(
				await created.voter.vote({
					exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
					expectedRevision: 1,
					phase: "prepare",
					round: 0,
				})
			).toMatchObject({ ok: false, reason: "REVALIDATION_REQUIRED" });
			expect(store.state().revision).toBe(0);
			expect(
				await created.voter.vote({
					exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
					expectedRevision: 0,
					phase: "prepare",
					round: 0,
				})
			).toMatchObject({ duplicate: false, ok: true });
			expect(
				await created.voter.vote({
					exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
					expectedRevision: 1,
					phase: "prepare",
					round: 0,
				})
			).toMatchObject({ duplicate: true, ok: true });

			const conflictingValue = decodeCanonical(identity.exactCanonicalVotePreimageBytes) as Record<string, unknown>;
			const conflictingCarrier = Object.freeze({
				exactCanonicalPreimageBytes: encodeCanonical({ ...conflictingValue, proposalHash: "ff".repeat(32) }),
				signature: new Uint8Array(64).fill(0xa5),
			});
			const seededConflict = oracleCommit({
				carrier: conflictingCarrier,
				expectedIncarnation: "incarnation-A",
				expectedRevision: 0,
				phase: "prepare",
				round: 0,
				signerId: selected.signerId,
				state: emptyOracleState(),
			});
			expect(seededConflict.ok).toBe(true);
			if (!seededConflict.ok) return;
			const conflictStore = createOracleStore(seededConflict.state);
			const conflictVoter = await modules.seal.createSealVoter({
				authority: opened.authority,
				expectedStorageIncarnation: "incarnation-A",
				signer: finality.signer,
				store: conflictStore.port,
			});
			expect(conflictVoter.ok).toBe(true);
			if (!conflictVoter.ok) return;
			const conflict = await conflictVoter.voter.vote({
				exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
				expectedRevision: 1,
				phase: "prepare",
				round: 0,
			});
			expect(conflict).toMatchObject({ ok: false, reason: "VOTE_CONFLICT" });
			if (!conflict.ok) expect(conflict.existing).toEqual(conflictingCarrier);

			let ambiguousCalls = 0;
			const ambiguousStore = mintSealStorePort({
				commitVote() {
					ambiguousCalls += 1;
					return Promise.reject(new Error("unknown transaction outcome"));
				},
				openSnapshot(enrollment: unknown) {
					if (resolveSealVoterEnrollment(enrollment) === undefined) {
						return Promise.reject(new TypeError("untrusted enrollment"));
					}
					return Promise.resolve({ enteredRound: 0, incarnation: "incarnation-A", revision: 0 });
				},
			});
			const ambiguousVoter = await modules.seal.createSealVoter({
				authority: opened.authority,
				expectedStorageIncarnation: "incarnation-A",
				signer: finality.signer,
				store: ambiguousStore,
			});
			expect(ambiguousVoter.ok).toBe(true);
			if (!ambiguousVoter.ok) return;
			expect(
				await ambiguousVoter.voter.vote({
					exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
					expectedRevision: 0,
					phase: "prepare",
					round: 0,
				})
			).toMatchObject({ ok: false });
			expect(ambiguousVoter.voter.status().terminal).toBe(true);
			expect(
				await ambiguousVoter.voter.vote({
					exactCanonicalCutValueBytes: identity.exactCanonicalCutValueBytes,
					expectedRevision: 0,
					phase: "prepare",
					round: 0,
				})
			).toMatchObject({ ok: false });
			expect(ambiguousCalls).toBe(1);
		}
	);
});
