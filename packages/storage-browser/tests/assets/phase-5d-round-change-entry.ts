import { ed25519 } from "../../../protocol-v3/node_modules/@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
// eslint-disable-next-line import/no-unresolved -- resolved by the exact test alias to preserve singleton custody.
import { createRecoverableFinalitySigner, signSealRegisteredDigest } from "@ts-drp/keychain/finality";
import { installCertifiedAnchorTrustRoot } from "@ts-drp/protocol-v3";
// eslint-disable-next-line import/no-unresolved -- resolved by the exact test alias to preserve singleton custody.
import {
	openSealAuthority,
	prepareRoundChange,
	prepareSealVote,
	verifyProposalBundle,
	verifySealQC,
} from "@ts-drp/protocol-v3/seal";
import { createSealVoter } from "@ts-drp/seal";
// eslint-disable-next-line import/no-unresolved -- resolved by the exact test alias to preserve singleton custody.
import { createSealPacemaker, leaderForRound } from "@ts-drp/seal/pacemaker";

import law from "../../../../tests/fixtures/phase-5d-v3/pacemaker-law-contract.json" with { type: "json" };
import { openBrowserSealVoteStore } from "../../src/seal-vote.js";

type Signer = Readonly<{
	privateKeySeedHex: string;
	publicKeyHex: string;
	signerId: string;
}>;

type BrowserSealVoteStore = Awaited<ReturnType<typeof openBrowserSealVoteStore>>;
type SealPacemaker = Extract<Awaited<ReturnType<typeof createSealPacemaker>>, { ok: true }>["pacemaker"];
type ProposalBundle = Parameters<SealPacemaker["observeProposalBundle"]>[0];

interface OpenHarnessResult {
	readonly authority: unknown;
	readonly browser: BrowserSealVoteStore;
	readonly exactCanonicalCutValueBytes: Uint8Array;
	readonly pacemaker: SealPacemaker;
}

const ZERO_DIGEST = "0".repeat(64);
const SIGNERS = law.vectors.crypto.signers.slice(0, 4) as readonly Signer[];
const OBJECT_ID = law.vectors.crypto.objectId;

function bytesHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function canonicalDigest(domain: string, value: unknown): string {
	return bytesHex(hashDomain(domain, encodeCanonical(value)));
}

function certifiedGenesis(): Readonly<{
	anchorDigest: string;
	input: Readonly<{
		exactCanonicalCertifiedGenesisCertificateBytes: Uint8Array;
		exactCanonicalGenesisAnchorPreimageBytes: Uint8Array;
		exactCanonicalProfileBytes: Uint8Array;
		exactCanonicalSignerSetBytes: Uint8Array;
		pinnedGenesisAnchorDigest: string;
	}>;
	signerSet: readonly Readonly<{ publicKey: string; signerId: string }>[];
}> {
	const signerSet = SIGNERS.map(({ publicKeyHex, signerId }) => ({ publicKey: publicKeyHex, signerId }));
	const signerSetBytes = encodeCanonical(signerSet);
	const profile = {
		cryptoSuiteId: "ed25519-seal-v3",
		profileId: "attested-bft-v1",
		quorum: 3,
		signers: signerSet,
	};
	const profileBytes = encodeCanonical(profile);
	const anchor = {
		aclDigest: "2".repeat(64),
		archiveIndexRoot: "3".repeat(64),
		blueprintDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
		cutDigest: ZERO_DIGEST,
		epoch: 0,
		historyRoot: "5".repeat(64),
		historySize: 0,
		kind: "drp-epoch-anchor",
		objectId: OBJECT_ID,
		parametersDigest: "6".repeat(64),
		previousAnchor: ZERO_DIGEST,
		profileDigest: canonicalDigest("ts-drp/profile/v3", profile),
		protocolMajor: 3,
		signerSetDigest: bytesHex(hashDomain("ts-drp/signer-set/v3", signerSetBytes)),
		stateDigest: "7".repeat(64),
	};
	const anchorBytes = encodeCanonical(anchor);
	const anchorDigest = bytesHex(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes));
	const certificate = {
		genesisAnchorDigest: anchorDigest,
		kind: "drp-certified-genesis-certificate",
		profileDigest: anchor.profileDigest,
		signatures: SIGNERS.map(({ privateKeySeedHex, publicKeyHex, signerId }) => ({
			publicKey: publicKeyHex,
			signature: ed25519.sign(hexBytes(anchorDigest), hexBytes(privateKeySeedHex)),
			signerId,
		})),
		signerSetDigest: anchor.signerSetDigest,
		version: 1,
	};
	return Object.freeze({
		anchorDigest,
		input: Object.freeze({
			exactCanonicalCertifiedGenesisCertificateBytes: encodeCanonical(certificate),
			exactCanonicalGenesisAnchorPreimageBytes: anchorBytes,
			exactCanonicalProfileBytes: profileBytes,
			exactCanonicalSignerSetBytes: signerSetBytes,
			pinnedGenesisAnchorDigest: anchorDigest,
		}),
		signerSet,
	});
}

function observedMetrics(events: unknown[]): Readonly<{
	traceFunc(name: string, operation: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
}> {
	return Object.freeze({
		traceFunc(name: string, operation: (...args: unknown[]) => unknown) {
			return (...args: unknown[]) => {
				const event = args[0];
				if (event === null || typeof event !== "object" || Reflect.get(event, "kind") !== name) {
					throw new Error("fieldless pacemaker event");
				}
				events.push(structuredClone(event));
				return operation(...args);
			};
		},
	});
}

async function openHarness(databaseName: string, events: unknown[]): Promise<OpenHarnessResult> {
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error(`trust install failed: ${installed.reason}`);
	const leader = SIGNERS[0];
	if (leader === undefined) throw new Error("missing leader");
	const finality = await createRecoverableFinalitySigner({ seed: hexBytes(leader.privateKeySeedHex) });
	const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
	if (!authority.ok) throw new Error(`authority open failed: ${authority.reason}`);
	const browser = await openBrowserSealVoteStore({ databaseName });
	const created = await createSealVoter({
		authority: authority.authority,
		expectedStorageIncarnation: browser.observation.incarnation,
		signer: finality.signer,
		store: browser.store,
	});
	if (!created.ok) throw new Error(`voter open failed: ${created.reason}`);
	const opened = await createSealPacemaker({
		authority: authority.authority,
		metrics: observedMetrics(events),
		store: browser.store,
		voter: created.voter,
	});
	if (!opened.ok) throw new Error(`pacemaker open failed: ${opened.reason}`);
	const exactCanonicalCutValueBytes = encodeCanonical({
		...law.vectors.crypto.cutValue,
		nextSignerSet: genesis.signerSet,
		objectId: OBJECT_ID,
		previousAnchor: genesis.anchorDigest,
	});
	return { authority: authority.authority, browser, exactCanonicalCutValueBytes, pacemaker: opened.pacemaker };
}

async function exactQc(
	exactCanonicalCutValueBytes: Uint8Array,
	phase: "commit" | "prepare",
	round: number,
	signerIndexes: readonly number[] = [0, 1, 2]
): Promise<Uint8Array> {
	const prepareQcBytes =
		phase === "commit" ? await exactQc(exactCanonicalCutValueBytes, "prepare", round, signerIndexes) : null;
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const votes = [];
	let valueDigest = "";
	let proposalHash = "";
	for (const signerIndex of signerIndexes) {
		const selected = SIGNERS[signerIndex];
		if (selected === undefined) throw new Error("missing QC signer");
		const finality = await createRecoverableFinalitySigner({ seed: hexBytes(selected.privateKeySeedHex) });
		const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
		if (!authority.ok) throw new Error("authority open failed");
		if (prepareQcBytes !== null) {
			const verifiedPrepare = verifySealQC({
				authority: authority.authority,
				exactCanonicalQcBytes: prepareQcBytes,
			});
			if (!verifiedPrepare.ok || verifiedPrepare.phase !== "prepare") {
				throw new Error("prepare QC authority hydration failed");
			}
		}
		const prepared = prepareSealVote({ authority: authority.authority, exactCanonicalCutValueBytes, phase, round });
		if (!prepared.ok) throw new Error(`vote prepare failed: ${prepared.reason}`);
		const signature = await signSealRegisteredDigest({ request: prepared.signingRequest, signer: finality.signer });
		valueDigest = prepared.valueDigest;
		proposalHash = prepared.proposalHash;
		votes.push({
			signature: bytesHex(signature),
			signerId: selected.signerId,
			voteDigest: bytesHex(prepared.registeredDigest),
		});
	}
	return encodeCanonical({
		epoch: 0,
		kind: "drp-seal-qc",
		objectId: OBJECT_ID,
		phase,
		proposalDigest: valueDigest,
		proposalHash,
		round,
		votes,
	});
}

async function signedRoundChange(
	signerIndex: number,
	round: number,
	highestPrepareQC: Uint8Array | null
): Promise<Readonly<{ exactCanonicalRoundChangeBytes: Uint8Array; signature: Uint8Array }>> {
	const selected = SIGNERS[signerIndex];
	if (selected === undefined) throw new Error("missing round-change signer");
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const finality = await createRecoverableFinalitySigner({ seed: hexBytes(selected.privateKeySeedHex) });
	const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
	if (!authority.ok) throw new Error("authority open failed");
	const prepared = prepareRoundChange({ authority: authority.authority, highestPrepareQC, round });
	if (!prepared.ok) throw new Error(`round-change prepare failed: ${prepared.reason}`);
	return Object.freeze({
		exactCanonicalRoundChangeBytes: prepared.exactCanonicalPreimageBytes,
		signature: await signSealRegisteredDigest({ request: prepared.signingRequest, signer: finality.signer }),
	});
}

async function exactProposalBundleAtRound(
	exactCanonicalCutValueBytes: Uint8Array,
	round: number,
	newRoundCertificate: readonly Readonly<{
		exactCanonicalRoundChangeBytes: Uint8Array;
		signature: Uint8Array;
	}>[]
): Promise<ProposalBundle> {
	const signerId = leaderForRound(
		SIGNERS.map((signer) => signer.signerId),
		round
	);
	const leader = SIGNERS.find((signer) => signer.signerId === signerId);
	if (leader === undefined) throw new Error("missing leader");
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const finality = await createRecoverableFinalitySigner({ seed: hexBytes(leader.privateKeySeedHex) });
	const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
	if (!authority.ok) throw new Error("authority open failed");
	const prepared = prepareSealVote({
		authority: authority.authority,
		exactCanonicalCutValueBytes,
		phase: "prepare",
		round,
	});
	if (!prepared.ok) throw new Error("leader vote prepare failed");
	return Object.freeze({
		exactCanonicalCutValueBytes,
		exactCanonicalLeaderVotePreimageBytes: prepared.exactCanonicalPreimageBytes,
		exactCanonicalProposalBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-seal-proposal",
			objectId: OBJECT_ID,
			round,
			valueDigest: prepared.valueDigest,
		}),
		leaderVoteSignature: await signSealRegisteredDigest({ request: prepared.signingRequest, signer: finality.signer }),
		newRoundCertificate,
	});
}

async function exactProposalBundle(exactCanonicalCutValueBytes: Uint8Array): Promise<ProposalBundle> {
	const leader = SIGNERS[0];
	if (leader === undefined) throw new Error("missing leader");
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const finality = await createRecoverableFinalitySigner({ seed: hexBytes(leader.privateKeySeedHex) });
	const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
	if (!authority.ok) throw new Error("authority open failed");
	const prepared = prepareSealVote({
		authority: authority.authority,
		exactCanonicalCutValueBytes,
		phase: "prepare",
		round: 0,
	});
	if (!prepared.ok) throw new Error("leader vote prepare failed");
	const signature = await signSealRegisteredDigest({ request: prepared.signingRequest, signer: finality.signer });
	return Object.freeze({
		exactCanonicalCutValueBytes,
		exactCanonicalLeaderVotePreimageBytes: prepared.exactCanonicalPreimageBytes,
		exactCanonicalProposalBytes: encodeCanonical({
			epoch: 0,
			kind: "drp-seal-proposal",
			objectId: OBJECT_ID,
			round: 0,
			valueDigest: prepared.valueDigest,
		}),
		leaderVoteSignature: signature,
	});
}

async function runRoundChangeCommit(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const first = await openHarness(databaseName, events);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_150));
	const beforeStatus = first.pacemaker.status();
	const beforeClose = Object.freeze({
		...beforeStatus,
		enteredRound: beforeStatus.round,
		revision: beforeStatus.durableRevision,
	});
	await first.pacemaker.stop();
	await first.browser.close();
	const reopened = await openHarness(databaseName, events);
	const reopenedStatus = reopened.pacemaker.status();
	const afterReopen = Object.freeze({
		...reopenedStatus,
		enteredRound: reopenedStatus.round,
		revision: reopenedStatus.durableRevision,
	});
	await reopened.pacemaker.stop();
	await reopened.browser.close();
	return { afterReopen, beforeClose, events };
}

async function runQcCustody(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	try {
		const proposal = await opened.pacemaker.observeProposalBundle(
			await exactProposalBundle(opened.exactCanonicalCutValueBytes)
		);
		const afterProposalFirst = opened.pacemaker.status();
		const afterProposalSecond = opened.pacemaker.status();
		const prepare = await opened.pacemaker.observePrepareQc(
			await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0)
		);
		const beforeFinal = opened.pacemaker.status();
		const finalized = await opened.pacemaker.observeCommitQc(
			await exactQc(opened.exactCanonicalCutValueBytes, "commit", 0)
		);
		const afterFinal = opened.pacemaker.status();
		const postFinalProposal = await opened.pacemaker.observeProposalBundle(
			await exactProposalBundle(opened.exactCanonicalCutValueBytes)
		);
		const afterPostFinalProposal = opened.pacemaker.status();
		return {
			afterFinal,
			afterPostFinalProposal,
			afterProposalFirst,
			afterProposalSecond,
			beforeFinal,
			events,
			finalized,
			postFinalProposal,
			prepare,
			proposal,
		};
	} finally {
		await opened.pacemaker.stop();
		await opened.browser.close();
	}
}

async function runSerializedTransitions(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	try {
		const bundle = await exactProposalBundle(opened.exactCanonicalCutValueBytes);
		const prepareQc = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0);
		const [proposal, prepare] = await Promise.all([
			opened.pacemaker.observeProposalBundle(bundle),
			opened.pacemaker.observePrepareQc(prepareQc),
		]);
		return { events, prepare, proposal, status: opened.pacemaker.status() };
	} finally {
		await opened.pacemaker.stop();
		await opened.browser.close();
	}
}

async function runStopFence(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	try {
		const bundle = await exactProposalBundle(opened.exactCanonicalCutValueBytes);
		let settled = false;
		const proposalTask = opened.pacemaker.observeProposalBundle(bundle).then((result) => {
			settled = true;
			return result;
		});
		await opened.pacemaker.stop();
		const settledWhenStopResolved = settled;
		const eventsWhenStopResolved = structuredClone(events);
		const statusWhenStopResolved = opened.pacemaker.status();
		const proposal = await proposalTask;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
		return {
			eventsAfterTurn: events,
			eventsWhenStopResolved,
			proposal,
			settledWhenStopResolved,
			statusAfterTurn: opened.pacemaker.status(),
			statusWhenStopResolved,
		};
	} finally {
		await opened.browser.close();
	}
}

async function runCertificateSelection(): Promise<unknown> {
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const local = SIGNERS[0];
	if (local === undefined) throw new Error("missing local signer");
	const finality = await createRecoverableFinalitySigner({ seed: hexBytes(local.privateKeySeedHex) });
	const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
	if (!authority.ok) throw new Error("authority open failed");
	const primaryCut = encodeCanonical({
		...law.vectors.crypto.cutValue,
		nextSignerSet: genesis.signerSet,
		objectId: OBJECT_ID,
		previousAnchor: genesis.anchorDigest,
	});
	const alternateCut = encodeCanonical({
		...law.vectors.crypto.cutValue,
		closeReason: "timeout",
		nextSignerSet: genesis.signerSet,
		objectId: OBJECT_ID,
		previousAnchor: genesis.anchorDigest,
	});
	const lowerRound = await exactQc(primaryCut, "prepare", 1);
	const sameRoundA = await exactQc(primaryCut, "prepare", 2, [0, 1, 2]);
	const sameRoundB = await exactQc(primaryCut, "prepare", 2, [1, 2, 3]);
	const conflicting = await exactQc(alternateCut, "prepare", 2, [0, 1, 3]);
	const digestA = bytesHex(hashDomain("ts-drp/seal-qc/v3", sameRoundA));
	const digestB = bytesHex(hashDomain("ts-drp/seal-qc/v3", sameRoundB));
	const acceptedCertificate = await Promise.all([
		signedRoundChange(0, 3, lowerRound),
		signedRoundChange(1, 3, sameRoundA),
		signedRoundChange(2, 3, sameRoundB),
	]);
	const conflictCertificate = await Promise.all([
		signedRoundChange(0, 3, sameRoundA),
		signedRoundChange(1, 3, conflicting),
		signedRoundChange(2, 3, null),
	]);
	return Object.freeze({
		accepted: verifyProposalBundle({
			...(await exactProposalBundleAtRound(primaryCut, 3, acceptedCertificate)),
			authority: authority.authority,
		}),
		conflict: verifyProposalBundle({
			...(await exactProposalBundleAtRound(primaryCut, 3, conflictCertificate)),
			authority: authority.authority,
		}),
		expectedSelectedDigest: digestA < digestB ? digestA : digestB,
	});
}

function corruptSignerState(databaseName: string, field: "finalizedCommitQC" | "highestPrepareQC"): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const request = indexedDB.open(databaseName, 2);
		request.addEventListener("error", () => reject(request.error ?? new Error("corrupt reopen failed")), {
			once: true,
		});
		request.addEventListener(
			"success",
			() => {
				const database = request.result;
				const transaction = database.transaction(["signerState"], "readwrite");
				const store = transaction.objectStore("signerState");
				const get = store.get([OBJECT_ID, 0, SIGNERS[0]?.signerId]);
				get.addEventListener(
					"success",
					() => {
						const row = get.result as Record<string, unknown>;
						const qc = row[field] as Record<string, unknown>;
						store.put({ ...row, [field]: { ...qc, exactCanonicalQcBytes: Uint8Array.of(0) } });
					},
					{ once: true }
				);
				transaction.addEventListener(
					"complete",
					() => {
						database.close();
						resolvePromise();
					},
					{ once: true }
				);
				transaction.addEventListener(
					"abort",
					() => reject(transaction.error ?? new Error("corrupt transaction aborted")),
					{ once: true }
				);
			},
			{ once: true }
		);
	});
}

async function runCorruptQcReopen(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	await opened.pacemaker.observeProposalBundle(await exactProposalBundle(opened.exactCanonicalCutValueBytes));
	await opened.pacemaker.observePrepareQc(await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0));
	await opened.pacemaker.observeCommitQc(await exactQc(opened.exactCanonicalCutValueBytes, "commit", 0));
	await opened.pacemaker.stop();
	await opened.browser.close();
	await corruptSignerState(databaseName, "finalizedCommitQC");
	try {
		const reopened = await openHarness(databaseName, events);
		await reopened.pacemaker.stop();
		await reopened.browser.close();
		return Object.freeze({ ok: true as const });
	} catch (error) {
		return Object.freeze({
			message: error instanceof Error ? error.message : String(error),
			ok: false as const,
		});
	}
}

async function runCommitWithoutPrepareQc(databaseName: string): Promise<unknown> {
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const local = SIGNERS[0];
	if (local === undefined) throw new Error("missing local signer");
	const finality = await createRecoverableFinalitySigner({ seed: hexBytes(local.privateKeySeedHex) });
	const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
	if (!authority.ok) throw new Error("authority open failed");
	const browser = await openBrowserSealVoteStore({ databaseName });
	try {
		const created = await createSealVoter({
			authority: authority.authority,
			expectedStorageIncarnation: browser.observation.incarnation,
			signer: finality.signer,
			store: browser.store,
		});
		if (!created.ok) throw new Error(`voter open failed: ${created.reason}`);
		const exactCanonicalCutValueBytes = encodeCanonical({
			...law.vectors.crypto.cutValue,
			nextSignerSet: genesis.signerSet,
			objectId: OBJECT_ID,
			previousAnchor: genesis.anchorDigest,
		});
		const committed = await created.voter.vote({
			exactCanonicalCutValueBytes,
			expectedRevision: 0,
			phase: "commit",
			round: 0,
		});
		return Object.freeze({
			committed,
			exposesEnterRound: Reflect.has(created.voter, "enterRound"),
			status: created.voter.status(),
		});
	} finally {
		await browser.close();
	}
}

async function runEvidencePruning(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	try {
		await opened.pacemaker.observeRoundChange(await signedRoundChange(1, 1, null));
		const beforeCatchup = opened.pacemaker.status();
		const catchup = await opened.pacemaker.observePrepareQc(
			await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 2)
		);
		return Object.freeze({ afterCatchup: opened.pacemaker.status(), beforeCatchup, catchup });
	} finally {
		await opened.pacemaker.stop();
		await opened.browser.close();
	}
}

declare global {
	interface Window {
		phase5dPacemaker: Readonly<{
			runCommitWithoutPrepareQc(databaseName: string): Promise<unknown>;
			runCertificateSelection(): Promise<unknown>;
			runCorruptQcReopen(databaseName: string): Promise<unknown>;
			runEvidencePruning(databaseName: string): Promise<unknown>;
			runQcCustody(databaseName: string): Promise<unknown>;
			runRoundChangeCommit(databaseName: string): Promise<unknown>;
			runSerializedTransitions(databaseName: string): Promise<unknown>;
			runStopFence(databaseName: string): Promise<unknown>;
		}>;
	}
}

window.phase5dPacemaker = Object.freeze({
	runCommitWithoutPrepareQc,
	runCertificateSelection,
	runCorruptQcReopen,
	runEvidencePruning,
	runQcCustody,
	runRoundChangeCommit,
	runSerializedTransitions,
	runStopFence,
});

export {};
