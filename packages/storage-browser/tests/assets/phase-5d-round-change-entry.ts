import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import {
	createRecoverableFinalitySigner,
	retireRecoverableFinalitySigner,
	signSealRegisteredDigest,
	type FinalitySigner,
} from "@ts-drp/keychain/finality";
import {
	bindSealSigningRequest,
	type SealSigningRequest,
	SigningAdmissionRefusal,
} from "@ts-drp/protocol-v3/internal/seal-signing-request";
import { resolveSealAuthorityIdentity } from "@ts-drp/protocol-v3/internal/seal-authority-identity";
import { installCertifiedAnchorTrustRoot } from "@ts-drp/protocol-v3";
import {
	openSealAuthority,
	captureSealObservationInput,
	prepareRoundChange,
	prepareSealVote,
	verifyProposalBundle,
	verifyRoundChange,
	verifySealQC,
	verifySealVoteCarrier,
	type SealAuthority,
} from "@ts-drp/protocol-v3/seal";
import { createSealVoter, type SealVoterHandle } from "@ts-drp/seal";
import { createSealPacemaker, leaderForRound, type PacemakerEvent } from "@ts-drp/seal/pacemaker";

import law from "../../../../tests/fixtures/phase-5d-v3/pacemaker-law-contract.json" with { type: "json" };
import { Ed25519PrivateKey } from "../../../keychain/node_modules/@libp2p/crypto/dist/src/keys/ed25519/ed25519.js";
import { ed25519 } from "../../../protocol-v3/node_modules/@noble/curves/ed25519.js";
import {
	mintSealVoterEnrollment,
	nativeSigningAdmissionFactory,
	resolveSealStorePort,
	type SealDetailRetirementIntentData,
} from "../../../seal/src/internal/seal-vote-intent.js";

// Browser stores type their port through the built seal package; this entry
// calls the seal source, whose port type carries its own brand.
type SourceSealStorePort = Parameters<typeof nativeSigningAdmissionFactory>[0];
import { createInternalVoteDispatcher } from "../../src/internal/seal-vote-dispatch.js";
import { openInternalSealVoteStore, VOTE_TRANSACTION_STORES } from "../../src/internal/seal-vote-store.js";
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
	readonly voter: SealVoterHandle;
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
	traceFunc(name: string, operation: (event: PacemakerEvent) => unknown): (event: PacemakerEvent) => unknown;
}> {
	return Object.freeze({
		traceFunc(name: string, operation: (event: PacemakerEvent) => unknown) {
			return (event: PacemakerEvent) => {
				if (event === null || typeof event !== "object" || Reflect.get(event, "kind") !== name) {
					throw new Error("fieldless pacemaker event");
				}
				events.push(structuredClone(event));
				return operation(event);
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
	return {
		authority: authority.authority,
		browser,
		exactCanonicalCutValueBytes,
		pacemaker: opened.pacemaker,
		voter: created.voter,
	};
}

// Test-only remote carrier production: genuine enrolled native signing custody,
// NOT a claim that these helper carriers were durably queued before gossip.
// Every signature joins its own actual Browser owner without changing receivers.
async function signFixtureCarrier(
	authority: SealAuthority,
	signer: FinalitySigner,
	request: SealSigningRequest
): Promise<Uint8Array> {
	const identity = resolveSealAuthorityIdentity(authority);
	if (identity === undefined) throw new Error("GENUINE_FIXTURE_AUTHORITY_REQUIRED");
	const browser = await openBrowserSealVoteStore({ databaseName: `phase5d-carrier-${crypto.randomUUID()}` });
	let primary: unknown,
		failed = false,
		signature: Uint8Array | undefined;
	try {
		const enrollment = mintSealVoterEnrollment({ ...identity, expectedIncarnation: browser.observation.incarnation });
		bindSealSigningRequest(request, nativeSigningAdmissionFactory(browser.store as unknown as SourceSealStorePort, enrollment));
		signature = await signSealRegisteredDigest({ request, signer });
	} catch (cause) {
		failed = true;
		primary = cause;
	}
	try {
		await browser.close();
	} catch (cleanup) {
		if (failed)
			throw new AggregateError([primary, cleanup], "fixture carrier and native close failed", { cause: primary });
		throw cleanup;
	}
	if (failed) throw primary;
	if (signature === undefined) throw new Error("FIXTURE_SIGNATURE_UNAVAILABLE");
	return signature;
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
		const signature = await signFixtureCarrier(authority.authority, finality.signer, prepared.signingRequest);
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
		signature: await signFixtureCarrier(authority.authority, finality.signer, prepared.signingRequest),
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
		leaderVoteSignature: await signFixtureCarrier(authority.authority, finality.signer, prepared.signingRequest),
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
	const signature = await signFixtureCarrier(authority.authority, finality.signer, prepared.signingRequest);
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

async function runStalledPacemakerAdmission(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	const original = Object.getOwnPropertyDescriptor(Ed25519PrivateKey.prototype, "sign");
	if (original === undefined || typeof original.value !== "function") throw new Error("original signer required");
	let unblock!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => { unblock = resolve; });
	const began = new Promise<void>((resolve) => { entered = resolve; });
	let signEntries = 0, proposalSettled = false, stopSettled = false;
	const tasks: Promise<unknown>[] = [];
	const settled: { kind: string; result: unknown }[] = [];
	try {
		const bundle = await exactProposalBundle(opened.exactCanonicalCutValueBytes);
		const qc = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0);
		Object.defineProperty(Ed25519PrivateKey.prototype, "sign", { ...original,
			value: async function(this: Ed25519PrivateKey, ...args: Parameters<Ed25519PrivateKey["sign"]>) {
				signEntries++; entered(); await gate;
				return Reflect.apply(original.value, this, args);
			},
		});
		const proposal = opened.pacemaker.observeProposalBundle(bundle).then(value => { proposalSettled = true; return value; });
		tasks.push(proposal);
		await began;
		const before = opened.voter.status();
		// These buffers are already outside the original protocol record limit.
		// They must refuse before entering a stalled queue, not after its drain.
		for (let index = 0; index < 4; index++) {
			tasks.push(opened.pacemaker.observePrepareQc(new Uint8Array(65537)).then(result => {
				settled.push({ kind: "oversized", result }); return result;
			}));
		}
		for (let index = 0; index < 40; index++) {
			tasks.push(opened.pacemaker.observePrepareQc(qc).then(result => {
				settled.push({ kind: "bounded", result }); return result;
			}));
		}
		// Queue custody must be private: every already admitted QC still verifies
		// after its caller mutates the original buffer during the entered job.
		qc.fill(0);
		// Let immediate promise results settle without servicing the signing gate.
		await new Promise(resolve => setTimeout(resolve, 0));
		const beforeRelease = { settled: structuredClone(settled), proposalSettled, signEntries,
			voterUnchanged: JSON.stringify(opened.voter.status()) === JSON.stringify(before) };
		const stopped = opened.pacemaker.stop().then(() => { stopSettled = true; });
		await new Promise(resolve => setTimeout(resolve, 0));
		const stopBeforeRelease = stopSettled;
		const afterStop = await opened.pacemaker.observePrepareQc(qc);
		unblock();
		await Promise.all([...tasks, stopped]);
		return { beforeRelease, stopBeforeRelease, afterStop, proposal: await proposal,
			settled, signEntries, stopSettled, status: opened.pacemaker.status(), events };
	} finally {
		unblock();
		await Promise.allSettled(tasks);
		Object.defineProperty(Ed25519PrivateKey.prototype, "sign", original);
		await opened.pacemaker.stop();
		await opened.browser.close();
	}
}

async function runStalledDirectVoter(databaseName: string): Promise<unknown> {
	const opened = await openHarness(databaseName, []);
	const original = Object.getOwnPropertyDescriptor(Ed25519PrivateKey.prototype, "sign");
	if (original === undefined || typeof original.value !== "function") throw new Error("original signer required");
	let unblock!: () => void, entered!: () => void;
	const gate = new Promise<void>(resolve => { unblock = resolve; });
	const began = new Promise<void>(resolve => { entered = resolve; });
	let signEntries = 0, iteratorCalls = 0, getterCalls = 0, voteSettled = false;
	const tasks: Promise<unknown>[] = [];
	try {
		const qc = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0);
		const cut = Uint8Array.from(opened.exactCanonicalCutValueBytes);
		Object.defineProperty(cut, Symbol.iterator, { value: function* () {
			iteratorCalls++;
			for (let index = 0; index < cut.byteLength; index++) yield cut[index];
		} });
		Object.defineProperty(Ed25519PrivateKey.prototype, "sign", { ...original,
			value: async function(this: Ed25519PrivateKey, ...args: Parameters<Ed25519PrivateKey["sign"]>) {
				signEntries++; entered(); await gate;
				return Reflect.apply(original.value, this, args);
			},
		});
		const originalStatus = opened.voter.status();
		const vote = opened.voter.vote({ exactCanonicalCutValueBytes: cut,
			expectedRevision: originalStatus.revision, phase: "prepare", round: 0
		}).then(result => { voteSettled = true; return result; });
		tasks.push(vote);
		await began;
		// All public direct entry points must refuse at their existing active
		// owner before reading or retaining new caller-controlled arguments.
		const unexpectedRead = () => { getterCalls++; return new Uint8Array(65537); };
		const refs = Array.from({ length: 10 }, () => [
			opened.voter.vote(Object.defineProperty({ expectedRevision: originalStatus.revision, phase: "prepare" as const,
				round: 0 } as { exactCanonicalCutValueBytes: Uint8Array; expectedRevision: number; phase: "prepare"; round: number },
				"exactCanonicalCutValueBytes", { get: unexpectedRead })),
			opened.voter.persistQc(Object.defineProperty({} as { exactCanonicalQcBytes: Uint8Array },
				"exactCanonicalQcBytes", { get: unexpectedRead })),
			opened.voter.roundChange(Object.defineProperty({round: 1} as {expectedRevision: number; round: number},
				"expectedRevision", {get: unexpectedRead})),
			opened.voter.retireDetails(Object.defineProperty({} as {expectedRevision: number},
				"expectedRevision", {get: unexpectedRead})),
		]).flat();
		tasks.push(...refs);
		const refused = await Promise.all(refs);
		const beforeRelease = { iteratorCalls, getterCalls, signEntries, voteSettled,
			voterUnchanged: JSON.stringify(originalStatus) === JSON.stringify(opened.voter.status()), refused };
		// Original complete bytes are already private; caller mutation cannot
		// change the paused registered digest or durable vote.
		cut.fill(0);
		unblock();
		const completedVote = await vote;
		const completedQc = await opened.voter.persistQc({ exactCanonicalQcBytes: qc });
		return { beforeRelease, completedVote, completedQc, status: opened.voter.status(), signEntries };
	} finally {
		unblock();
		await Promise.allSettled(tasks);
		Object.defineProperty(Ed25519PrivateKey.prototype, "sign", original);
		await opened.pacemaker.stop();
		await opened.browser.close();
	}
}

async function runStalledPacemakerTimer(databaseName: string): Promise<unknown> {
	const events: unknown[] = [];
	const opened = await openHarness(databaseName, events);
	let foreign: IDBDatabase | undefined, held = true;
	let joined: Promise<void> | undefined;
	const tasks: Promise<unknown>[] = [];
	try {
		const bundle = await exactProposalBundle(opened.exactCanonicalCutValueBytes);
		const qc = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0);
		await opened.pacemaker.observeProposalBundle(bundle);
		await opened.pacemaker.observePrepareQc(qc);
		foreign = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(databaseName);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const transaction = foreign.transaction(["storageMeta", "signerState"], "readwrite", {durability: "strict"});
		joined = new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
		});
		await new Promise<void>((resolve, reject) => {
			let first = true;
			const pump = () => {
				const request = transaction.objectStore("storageMeta").get("singleton");
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					if (held) pump();
					if (first) { first = false; resolve(); }
				};
			};
			pump();
		});
		let settled = 0;
		for (let index = 0; index < 32; index++) tasks.push(opened.pacemaker.observePrepareQc(qc).then(value => { settled++; return value; }));
		await new Promise(resolve => setTimeout(resolve, 1200));
		const beforeRelease = {settled, round: opened.pacemaker.status().round};
		held = false; await joined;
		const results = await Promise.all(tasks);
		await new Promise(resolve => setTimeout(resolve, 1200));
		return {beforeRelease, results, status: opened.pacemaker.status(), events};
	} finally {
		held = false; await joined;
		await Promise.allSettled(tasks);
		foreign?.close();
		await opened.pacemaker.stop(); await opened.browser.close();
	}
}

async function runPacemakerCaptureBounds(databaseName: string): Promise<unknown> {
	const opened = await openHarness(databaseName, []);
	try {
		const authority = opened.authority as SealAuthority;
		let iteratorCalls = 0, getterCalls = 0;
		const exact = new Uint8Array(65536).fill(7);
		Object.defineProperty(exact, Symbol.iterator, {value: () => {iteratorCalls++; throw new Error("untrusted iterator");}});
		const positive = captureSealObservationInput({authority,kind: "qc",value: exact});
		const oversized = captureSealObservationInput({authority,kind: "qc",value: new Uint8Array(65537)});
		if (!positive.ok || !(positive.value instanceof Uint8Array)) throw new Error("native backing capture refused");
		exact.fill(0);
		const carrier = {exactCanonicalRoundChangeBytes: new Uint8Array(65536).fill(3),signature: new Uint8Array(64).fill(4),
			ignoredMetadata: new Uint8Array(65537)};
		const proposal = {exactCanonicalCutValueBytes: new Uint8Array(65536),exactCanonicalLeaderVotePreimageBytes: new Uint8Array(65536),
			exactCanonicalProposalBytes: new Uint8Array(65536),leaderVoteSignature: new Uint8Array(64),
			newRoundCertificate: [carrier,carrier,carrier]};
		const captured = captureSealObservationInput({authority,kind: "proposal",value: proposal});
		if (!captured.ok || captured.value instanceof Uint8Array) throw new Error("complete quorum capture refused");
		const certificate = captured.value.newRoundCertificate as Record<string,Uint8Array>[];
		const bytes = [captured.value.exactCanonicalCutValueBytes,captured.value.exactCanonicalLeaderVotePreimageBytes,
			captured.value.exactCanonicalProposalBytes,captured.value.leaderVoteSignature,...certificate.flatMap(row=>
				[row.exactCanonicalRoundChangeBytes,row.signature])] as Uint8Array[];
		carrier.exactCanonicalRoundChangeBytes.fill(0);carrier.signature.fill(0);
		const wrongCount = captureSealObservationInput({authority,kind: "proposal",value: {...proposal,newRoundCertificate: [carrier,carrier]}});
		const accessor = {...proposal};
		Object.defineProperty(accessor,"exactCanonicalCutValueBytes",{enumerable:true,get(){getterCalls++;return new Uint8Array(65536);}});
		const accessorRefusal = captureSealObservationInput({authority,kind:"proposal",value:accessor});
		return {iteratorCalls,getterCalls,qcCopiedBytes:positive.value.byteLength,qcPrivate:positive.value.every(byte=>byte===7),
			oversized,wrongCount,accessorRefusal,certificateCount:certificate.length,
			proposalCopiedBytes:bytes.reduce((sum,value)=>sum+value.byteLength,0),
			certificatePrivate:certificate.every(row=>row.exactCanonicalRoundChangeBytes.every(byte=>byte===3)&&row.signature.every(byte=>byte===4)),
			metadataDiscarded:certificate.every(row=>!Object.hasOwn(row,"ignoredMetadata")),
			qualification:"Representation capture only; zero carriers here are not authenticated, accepted, signed or delivered. Genuine queued/QC native controls establish those separate owners."};
	} finally {await opened.pacemaker.stop();await opened.browser.close();}
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
		const request = indexedDB.open(databaseName, 3);
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

async function signingDetailImage(databaseName: string): Promise<
	Readonly<{
		frames: readonly Readonly<{ table: string; key: IDBValidKey; bytes: string }>[];
		safety: string;
		revision: number;
		floor: number;
	}>
> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName);
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error), { once: true });
	});
	try {
		const transaction = database.transaction([...VOTE_TRANSACTION_STORES], "readonly");
		const completed = new Promise<void>((resolve, reject) => {
			transaction.addEventListener("complete", () => resolve(), { once: true });
			transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
		});
		const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
			new Promise((resolve, reject) => {
				request.addEventListener("success", () => resolve(request.result), { once: true });
				request.addEventListener("error", () => reject(request.error), { once: true });
			});
		const tables = await Promise.all(
			[...VOTE_TRANSACTION_STORES].sort().map(async (table) => {
				const store = transaction.objectStore(table);
				const [keys, rows] = await Promise.all([
					requestResult(store.getAllKeys(undefined, 65)),
					requestResult(store.getAll(undefined, 65)),
				]);
				if (rows.length > 64 || keys.length !== rows.length) throw new Error("FIXTURE_NATIVE_CENSUS_BOUND");
				return rows.map((row: unknown, index) => ({ table, key: keys[index] as IDBValidKey, row }));
			})
		);
		await completed;
		const native = tables.flat();
		const selected = native.find(
			({ table, key }) =>
				table === "signerState" &&
				Array.isArray(key) &&
				key[0] === OBJECT_ID &&
				key[1] === 0 &&
				key[2] === SIGNERS[0]?.signerId
		)?.row as Record<string, unknown> | undefined;
		if (selected === undefined || typeof selected.revision !== "number")
			throw new Error("GENUINE_SIGNER_STATE_REQUIRED");
		return Object.freeze({
			frames: native.map(({ table, key, row }) =>
				Object.freeze({ table, key, bytes: bytesHex(encodeCanonical([table, key, row])) })
			),
			safety: bytesHex(encodeCanonical({ ...selected, revision: 0, retiredBeforeRound: 0 })),
			revision: selected.revision,
			floor: typeof selected.retiredBeforeRound === "number" ? selected.retiredBeforeRound : 0,
		});
	} finally {
		database.close();
	}
}

async function runAuthenticatedDetailRetirement(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [];
	const result: Record<string, unknown> = { databaseName, events, published };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	try {
		const opened = await openHarness(databaseName, events);
		owners.push(
			{ name: "voter", close: () => opened.browser.close() },
			{ name: "pacemaker", close: () => opened.pacemaker.stop() }
		);
		result.proposal = await opened.pacemaker.observeProposalBundle(
			await exactProposalBundle(opened.exactCanonicalCutValueBytes)
		);
		// Stop the timer before remote QC production; no synthetic lower-round
		// floor or round-change suppression is passed to the genuine voter.
		await opened.pacemaker.stop();
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({
			name: "dispatch-store",
			close: async () => {
				await internal.close();
			},
		});
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "dispatcher", close: () => dispatcher.close() });
		result.publication = await dispatcher.drain();
		await dispatcher.close();
		const qc = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 2);
		result.verifiedQc = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc });
		result.persistedQc = await opened.voter.persistQc({ exactCanonicalQcBytes: qc });
		result.before = await signingDetailImage(databaseName);
		result.retirement = await opened.voter.retireDetails({ expectedRevision: opened.voter.status().revision });
		result.after = await signingDetailImage(databaseName);
		await opened.browser.close();
		await internal.close();
		const cold = await openHarness(databaseName, events);
		owners.push(
			{ name: "cold-voter", close: () => cold.browser.close() },
			{ name: "cold-pacemaker", close: () => cold.pacemaker.stop() }
		);
		await cold.pacemaker.stop();
		result.reopened = await signingDetailImage(databaseName);
		result.futureVote = await cold.voter.vote({
			exactCanonicalCutValueBytes: cold.exactCanonicalCutValueBytes,
			expectedRevision: cold.voter.status().revision,
			phase: "prepare",
			round: 2,
		});
		const futureStore = await openInternalSealVoteStore({ databaseName });
		owners.push({
			name: "future-store",
			close: async () => {
				await futureStore.close();
			},
		});
		const futureDispatcher = createInternalVoteDispatcher({
			databaseName,
			store: futureStore,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "future-dispatcher", close: () => futureDispatcher.close() });
		result.futurePublication = await futureDispatcher.drain();
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		// Injected publication is an original dispatcher/ACK custody fixture,
		// not a network or quorum-delivery claim. All original owners join.
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dDetailRetirement", result);
	}
	return result;
}

async function runAuthenticatedDetailRetirementBatches(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [];
	const progression: unknown[] = [],
		deleteCalls: unknown[] = [],
		negatives: unknown[] = [];
	const result: Record<string, unknown> = { databaseName, events, published, progression, deleteCalls, negatives };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	const originalDelete = IDBObjectStore.prototype.delete;
	let deletePhase: "abort" | "first" | "second" | undefined;
	let abortDeleteCount = 0;
	const trace = (): readonly unknown[] => Reflect.get(window, "__phase5dTransactions") as readonly unknown[];
	const openStopped = async (name: string): Promise<OpenHarnessResult> => {
		const opened = await openHarness(databaseName, events);
		owners.push(
			{ name: `${name}-voter`, close: () => opened.browser.close() },
			{ name: `${name}-pacemaker`, close: () => opened.pacemaker.stop() }
		);
		await opened.pacemaker.stop();
		return opened;
	};
	const requireSuccess = (value: unknown, operation: string): void => {
		if (value === null || typeof value !== "object" || Reflect.get(value, "ok") !== true)
			throw new Error(`GENUINE_BATCH_PREREQUISITE:${operation}`);
	};
	try {
		const opened = await openStopped("warm");
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "warm-dispatch-store", close: () => internal.close() });
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "warm-dispatcher", close: () => dispatcher.close() });
		let qc7: Uint8Array | undefined;
		for (let round = 0; round < 9; round++) {
			let verifiedQc: unknown, persistedQc: unknown;
			if (round > 0) {
				const qc = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", round);
				verifiedQc = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc });
				requireSuccess(verifiedQc, `verify-qc-${round}`);
				persistedQc = await opened.voter.persistQc({ exactCanonicalQcBytes: qc });
				requireSuccess(persistedQc, `persist-qc-${round}`);
				if (round === 7) qc7 = qc;
			}
			const vote = await opened.voter.vote({
				exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
				expectedRevision: opened.voter.status().revision,
				phase: "prepare",
				round,
			});
			const publication = await dispatcher.drain();
			progression.push({ round, verifiedQc, persistedQc, vote, publication });
			requireSuccess(vote, `vote-${round}`);
			if (publication.sentKeys.length !== round + 1) throw new Error(`GENUINE_BATCH_PREREQUISITE:publication-${round}`);
		}
		await dispatcher.close();
		const qc9 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 9);
		result.verifiedQc9 = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc9 });
		requireSuccess(result.verifiedQc9, "verify-qc-9");
		result.persistedQc9 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc9 });
		requireSuccess(result.persistedQc9, "persist-qc-9");
		if (qc7 === undefined) throw new Error("GENUINE_QC7_REQUIRED");
		const lateRoundChange = await signedRoundChange(0, 8, qc7);
		result.verifiedLateRoundChange = verifyRoundChange({
			authority: opened.authority as SealAuthority,
			...lateRoundChange,
		});
		requireSuccess(result.verifiedLateRoundChange, "late-round-change");
		const before = await signingDetailImage(databaseName);
		result.before = before;
		const voteFrame = before.frames.find(
			({ table, key }) => table === "voteSlots" && Array.isArray(key) && key[2] === 0
		);
		if (voteFrame === undefined) throw new Error("GENUINE_VOTE0_REQUIRED");
		const decoded = decodeCanonical(hexBytes(voteFrame.bytes)) as unknown[];
		const voteRow = decoded[2] as Readonly<{
			carrier: Readonly<{ exactCanonicalPreimageBytes: Uint8Array; signature: Uint8Array }>;
		}>;
		const verifiedVote = verifySealVoteCarrier({ authority: opened.authority as SealAuthority, ...voteRow.carrier });
		result.verifiedLateVote = verifiedVote;
		if (!verifiedVote.ok) throw new Error(`GENUINE_VOTE0_INVALID:${verifiedVote.reason}`);
		const adapter = resolveSealStorePort(opened.browser.store);
		if (adapter?.retireDetails === undefined) throw new Error("GENUINE_DETAIL_ADAPTER_REQUIRED");
		result.foreignIntent = await adapter.retireDetails({});
		result.afterForeignIntent = await signingDetailImage(databaseName);
		// This hook wraps the existing transaction observer, never a native
		// authority/eligibility path. DELETE #1 executes; DELETE #2 aborts the
		// SAME genuine retirement transaction before either can commit.
		Reflect.set(IDBObjectStore.prototype, "delete", function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
			const request = originalDelete.call(this, key);
			if (
				deletePhase !== undefined &&
				this.transaction.db.name === databaseName &&
				(this.name === "voteSlots" || this.name === "voteOutbox")
			) {
				deleteCalls.push({ phase: deletePhase, table: this.name, key: structuredClone(key) });
				if (deletePhase === "abort" && ++abortDeleteCount === 2) this.transaction.abort();
			}
			return request;
		});
		let start = trace().length;
		deletePhase = "abort";
		try {
			result.abortedRetirement = await opened.voter.retireDetails({ expectedRevision: opened.voter.status().revision });
		} finally {
			deletePhase = undefined;
		}
		result.abortTransactions = structuredClone(trace().slice(start));
		result.abortDeleteCount = abortDeleteCount;
		result.abortStatus = opened.voter.status();
		result.afterAbort = await signingDetailImage(databaseName);
		await opened.browser.close();
		await internal.close();
		const first = await openStopped("first-cold");
		result.firstReopened = await signingDetailImage(databaseName);
		start = trace().length;
		deletePhase = "first";
		try {
			result.firstRetirement = await first.voter.retireDetails({ expectedRevision: first.voter.status().revision });
		} finally {
			deletePhase = undefined;
		}
		result.firstTransactions = structuredClone(trace().slice(start));
		result.afterFirst = await signingDetailImage(databaseName);
		await first.browser.close();
		const second = await openStopped("second-cold");
		result.secondReopened = await signingDetailImage(databaseName);
		start = trace().length;
		deletePhase = "second";
		try {
			result.secondRetirement = await second.voter.retireDetails({ expectedRevision: second.voter.status().revision });
		} finally {
			deletePhase = undefined;
		}
		result.secondTransactions = structuredClone(trace().slice(start));
		const afterSecond = await signingDetailImage(databaseName);
		result.afterSecond = afterSecond;
		Reflect.set(IDBObjectStore.prototype, "delete", originalDelete);
		const lateStore = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "late-store", close: () => lateStore.close() });
		const identity = resolveSealAuthorityIdentity(second.authority as SealAuthority);
		if (identity === undefined) throw new Error("GENUINE_REOPENED_AUTHORITY_REQUIRED");
		const signingRead = await lateStore.acquireSigningAdmission({ objectId: identity.objectId });
		let retiredScope: unknown, futureScope: unknown;
		try {
			retiredScope = await signingRead.checkSigningScope({
				epoch: identity.epoch,
				round: 8,
				signerId: identity.signerId,
			});
			futureScope = await signingRead.checkSigningScope({
				epoch: identity.epoch,
				round: 9,
				signerId: identity.signerId,
			});
			await signingRead.check();
		} finally {
			await signingRead.release();
		}
		negatives.push({
			operation: "read-scope",
			retiredScope,
			futureScope,
			before: afterSecond,
			after: await signingDetailImage(databaseName),
		});
		let ackError: unknown;
		try {
			await lateStore.markDispatched([identity.objectId, identity.epoch, 8, "prepare", identity.signerId]);
		} catch (cause) {
			ackError = {
				name: cause instanceof Error ? cause.name : typeof cause,
				message: cause instanceof Error ? cause.message : String(cause),
			};
		}
		negatives.push({
			operation: "delayed-ack",
			error: ackError,
			before: afterSecond,
			after: await signingDetailImage(databaseName),
		});
		// Real original signatures and verified tuples; fresh native revision
		// and incarnation isolate the permanent floor from stale-CAS refusal.
		const nativeIdentity = {
			...identity,
			expectedIncarnation: lateStore.incarnation,
			expectedRevision: afterSecond.revision,
		};
		const lateVote = await lateStore.commitVote({
			...nativeIdentity,
			carrier: voteRow.carrier,
			phase: verifiedVote.phase,
			round: verifiedVote.round,
			valueDigest: verifiedVote.valueDigest,
			prepareQC: null,
		});
		negatives.push({
			operation: "late-vote",
			result: lateVote,
			expectedRevision: afterSecond.revision,
			expectedIncarnation: lateStore.incarnation,
			before: afterSecond,
			after: await signingDetailImage(databaseName),
		});
		const lateRc = await lateStore.commitRoundChange({
			...nativeIdentity,
			round: 8,
			highestPrepareQcBytes: qc7,
			carrier: {
				exactCanonicalPreimageBytes: lateRoundChange.exactCanonicalRoundChangeBytes,
				signature: lateRoundChange.signature,
			},
		});
		negatives.push({
			operation: "late-round-change",
			result: lateRc,
			expectedRevision: afterSecond.revision,
			expectedIncarnation: lateStore.incarnation,
			before: afterSecond,
			after: await signingDetailImage(databaseName),
		});
		result.futureVote = await second.voter.vote({
			exactCanonicalCutValueBytes: second.exactCanonicalCutValueBytes,
			expectedRevision: second.voter.status().revision,
			phase: "prepare",
			round: 9,
		});
		const futureDispatcher = createInternalVoteDispatcher({
			databaseName,
			store: lateStore,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "future-dispatcher", close: () => futureDispatcher.close() });
		result.futurePublication = await futureDispatcher.drain();
		result.afterFuture = await signingDetailImage(databaseName);
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		Reflect.set(IDBObjectStore.prototype, "delete", originalDelete);
		// This is joined original dispatcher/ACK execution, not network receipt.
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dDetailRetirementBatches", result);
	}
	return result;
}

async function runColdDetailRetirementResume(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [],
		batches: unknown[] = [];
	const result: Record<string, unknown> = { databaseName, events, published, batches };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	try {
		// Same-profile fixture already created this database. Point capture is
		// BEFORE any original voter/store opens, not a process-death proof or
		// a grant inferred from a persisted numeric floor.
		result.beforeAnyOwner = await signingDetailImage(databaseName);
		Reflect.set(window, "__phase5dColdDetailRetirement", result);
		const cold = await openHarness(databaseName, events);
		owners.push(
			{ name: "cold-voter", close: () => cold.browser.close() },
			{ name: "cold-pacemaker", close: () => cold.pacemaker.stop() }
		);
		await cold.pacemaker.stop();
		result.reopened = await signingDetailImage(databaseName);
		const highestPrepareQcBytes = cold.voter.status().highestPrepareQcBytes;
		if (highestPrepareQcBytes === null) throw new Error("GENUINE_COLD_PREPARE_QC_REQUIRED");
		const verifiedQc = verifySealQC({
			authority: cold.authority as SealAuthority,
			exactCanonicalQcBytes: highestPrepareQcBytes,
		});
		result.verifiedQc = verifiedQc;
		if (!verifiedQc.ok || verifiedQc.phase !== "prepare" || verifiedQc.round === 0)
			throw new Error("GENUINE_COLD_PREPARE_QC_INVALID");
		let finished = false;
		// Two real max16 batches suffice only for this selected <=18-row
		// fixture. Each invocation independently reauthenticates actual rows.
		for (let index = 0; index < 2; index++) {
			const before = await signingDetailImage(databaseName);
			const retirement = await cold.voter.retireDetails({ expectedRevision: cold.voter.status().revision });
			const after = await signingDetailImage(databaseName);
			batches.push({ index, before, retirement, after });
			if (!retirement.ok) throw new Error(`COLD_DETAIL_RETIREMENT_REFUSED:${retirement.reason}`);
			if (!retirement.remaining) {
				finished = true;
				break;
			}
		}
		if (!finished) throw new Error("COLD_FIXTURE_DETAIL_BATCH_BOUND");
		result.afterRetirement = await signingDetailImage(databaseName);
		result.futureVote = await cold.voter.vote({
			exactCanonicalCutValueBytes: cold.exactCanonicalCutValueBytes,
			expectedRevision: cold.voter.status().revision,
			phase: "prepare",
			round: verifiedQc.round,
		});
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "cold-dispatch-store", close: () => internal.close() });
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "cold-dispatcher", close: () => dispatcher.close() });
		result.futurePublication = await dispatcher.drain();
		result.afterFuture = await signingDetailImage(databaseName);
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dColdDetailRetirement", result);
	}
	return result;
}

async function runAuthenticatedRoundChangeRetirement(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [];
	const result: Record<string, unknown> = { databaseName, events, published };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	try {
		const opened = await openHarness(databaseName, events);
		owners.push(
			{ name: "voter", close: () => opened.browser.close() },
			{ name: "pacemaker", close: () => opened.pacemaker.stop() }
		);
		// Remote genuine crypto production must not race the warm timer. No
		// synthetic native floor or fabricated RC carrier is used by this body.
		await opened.pacemaker.stop();
		const qc0 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0);
		result.verifiedQc0 = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc0 });
		result.persistedQc0 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc0 });
		result.roundChange1 = await opened.voter.roundChange({
			expectedRevision: opened.voter.status().revision,
			round: 1,
		});
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "dispatch-store", close: () => internal.close() });
		const own = (await internal.readPending(5)).find(
			(row) => row.objectId === OBJECT_ID && row.epoch === 0 && row.round === 1 && row.phase === "round-change"
		);
		if (own === undefined || own.signerId !== SIGNERS[0]?.signerId)
			throw new Error("ORIGINAL_NATIVE_ROUND_CHANGE_REQUIRED");
		const oldRc = Object.freeze({
			exactCanonicalRoundChangeBytes: Uint8Array.from(own.carrier.exactCanonicalPreimageBytes),
			signature: Uint8Array.from(own.carrier.signature),
		});
		result.nativeRcKey = [own.objectId, own.epoch, own.round, own.phase, own.signerId];
		result.inlineRc = {
			exactCanonicalRoundChangeBytes: bytesHex(oldRc.exactCanonicalRoundChangeBytes),
			signature: bytesHex(oldRc.signature),
			qc0: bytesHex(qc0),
		};
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "dispatcher", close: () => dispatcher.close() });
		result.publication = await dispatcher.drain();
		await dispatcher.close();
		const qc2 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 2);
		result.verifiedQc2 = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc2 });
		result.persistedQc2 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc2 });
		result.before = await signingDetailImage(databaseName);
		result.retirement = await opened.voter.retireDetails({ expectedRevision: opened.voter.status().revision });
		result.after = await signingDetailImage(databaseName);
		const verifiedInline = verifyRoundChange({ authority: opened.authority as SealAuthority, ...oldRc });
		result.inlineVerification = verifiedInline.ok
			? { ...verifiedInline, highestPrepareQcBytes: bytesHex(verifiedInline.highestPrepareQcBytes ?? new Uint8Array()) }
			: verifiedInline;
		// All real signed bundles precede the NEW active cold owner. A stopped
		// warm pacemaker's STOPPED result cannot establish STALE_ROUND.
		const oldCertificate = [oldRc, await signedRoundChange(1, 1, qc0), await signedRoundChange(2, 1, qc0)];
		const oldProposal = await exactProposalBundleAtRound(opened.exactCanonicalCutValueBytes, 1, oldCertificate);
		const mismatchedProposal = await exactProposalBundleAtRound(opened.exactCanonicalCutValueBytes, 2, oldCertificate);
		const qc1 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 1);
		const currentCertificate = await Promise.all(
			[1, 2, 3].map((signerIndex) => signedRoundChange(signerIndex, 2, qc1))
		);
		const currentProposal = await exactProposalBundleAtRound(opened.exactCanonicalCutValueBytes, 2, currentCertificate);
		result.oldBundleVerification = verifyProposalBundle({ ...oldProposal, authority: opened.authority });
		result.mismatchedBundleVerification = verifyProposalBundle({ ...mismatchedProposal, authority: opened.authority });
		result.currentBundleVerification = verifyProposalBundle({ ...currentProposal, authority: opened.authority });
		await opened.browser.close();
		await internal.close();
		const cold = await openHarness(databaseName, events);
		owners.push(
			{ name: "cold-voter", close: () => cold.browser.close() },
			{ name: "cold-pacemaker", close: () => cold.pacemaker.stop() }
		);
		result.reopened = await signingDetailImage(databaseName);
		result.coldBeforeAdmission = cold.voter.status();
		result.oldProposalAdmission = await cold.pacemaker.observeProposalBundle(oldProposal);
		result.mismatchedProposalAdmission = await cold.pacemaker.observeProposalBundle(mismatchedProposal);
		result.currentProposalAdmission = await cold.pacemaker.observeProposalBundle(currentProposal);
		await cold.pacemaker.stop();
		const futureStore = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "future-store", close: () => futureStore.close() });
		const futureDispatcher = createInternalVoteDispatcher({
			databaseName,
			store: futureStore,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "future-dispatcher", close: () => futureDispatcher.close() });
		result.futurePublication = await futureDispatcher.drain();
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		// Original native/dispatcher owners join even on prerequisite refusal.
		// Injected publication is not a network or quorum-delivery claim.
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dRoundChangeRetirement", result);
	}
	return result;
}

async function runDelayedPhysicalDetailSigning(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [],
		cryptoEntries: unknown[] = [];
	const result: Record<string, unknown> = { databaseName, events, published, cryptoEntries };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	const signDescriptor = Object.getOwnPropertyDescriptor(Ed25519PrivateKey.prototype, "sign");
	let signingPhase: "late" | "current" | undefined;
	try {
		const opened = await openHarness(databaseName, events);
		owners.push(
			{ name: "voter", close: () => opened.browser.close() },
			{ name: "pacemaker", close: () => opened.pacemaker.stop() }
		);
		await opened.pacemaker.stop();
		result.vote0 = await opened.voter.vote({
			exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
			expectedRevision: opened.voter.status().revision,
			phase: "prepare",
			round: 0,
		});
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "dispatch-store", close: () => internal.close() });
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "dispatcher", close: () => dispatcher.close() });
		result.publication = await dispatcher.drain();
		await dispatcher.close();
		const local = SIGNERS[0];
		if (local === undefined) throw new Error("GENUINE_LOCAL_SIGNER_REQUIRED");
		const finality = await createRecoverableFinalitySigner({ seed: hexBytes(local.privateKeySeedHex) });
		owners.push({
			name: "delayed-finality",
			close: () => retireRecoverableFinalitySigner({ signer: finality.signer }),
		});
		const identity = resolveSealAuthorityIdentity(opened.authority as SealAuthority);
		if (identity === undefined) throw new Error("GENUINE_DELAYED_AUTHORITY_REQUIRED");
		const enrollment = mintSealVoterEnrollment({
			...identity,
			expectedIncarnation: opened.browser.observation.incarnation,
		});
		const admission = nativeSigningAdmissionFactory(opened.browser.store as unknown as SourceSealStorePort, enrollment);
		const delayed = prepareSealVote({
			authority: opened.authority as SealAuthority,
			exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
			phase: "prepare",
			round: 0,
		});
		if (!delayed.ok) throw new Error(`GENUINE_DELAYED_REQUEST_REFUSED:${delayed.reason}`);
		// Trusted original composition uses genuine authority + branded native
		// store/enrollment. The ORIGINAL request is bound before retirement and
		// retained unconsumed; neither caller epoch flags nor an actor's lower-
		// entered-round guard authorizes/refuses the eventual direct signing.
		bindSealSigningRequest(delayed.signingRequest, admission);
		result.binding = {
			...identity,
			expectedIncarnation: opened.browser.observation.incarnation,
			publicKey: bytesHex(finality.publicKey),
		};
		result.delayedPreimage = bytesHex(delayed.exactCanonicalPreimageBytes);
		result.delayedTuple = decodeCanonical(delayed.exactCanonicalPreimageBytes);
		result.delayedDigest = bytesHex(delayed.registeredDigest);
		result.boundBeforeRetirement = await signingDetailImage(databaseName);
		const qc2 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 2);
		result.verifiedQc2 = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc2 });
		result.persistedQc2 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc2 });
		result.beforeRetirement = await signingDetailImage(databaseName);
		result.retirement = await opened.voter.retireDetails({ expectedRevision: opened.voter.status().revision });
		const afterRetirement = await signingDetailImage(databaseName);
		result.afterRetirement = afterRetirement;
		if (signDescriptor === undefined || typeof signDescriptor.value !== "function")
			throw new Error("ORIGINAL_CRYPTO_SIGN_DESCRIPTOR_REQUIRED");
		const originalSign = signDescriptor.value as Ed25519PrivateKey["sign"];
		// Installed ORIGINAL keychain dependency, not a crypto double. The
		// healthy current request must expose the actual private-key receiver's
		// SAME prototype/key and delegate entry, making entries0 non-vacuous.
		Object.defineProperty(Ed25519PrivateKey.prototype, "sign", {
			...signDescriptor,
			value: function (this: Ed25519PrivateKey, ...args: Parameters<Ed25519PrivateKey["sign"]>) {
				cryptoEntries.push({
					phase: signingPhase,
					sameOriginalPrototype: Object.getPrototypeOf(this) === Ed25519PrivateKey.prototype,
					publicKey: bytesHex(this.publicKey.raw),
					digest: args[0] instanceof Uint8Array ? bytesHex(args[0]) : undefined,
				});
				return Reflect.apply(originalSign, this, args) as ReturnType<Ed25519PrivateKey["sign"]>;
			},
		});
		signingPhase = "late";
		try {
			result.lateSignature = bytesHex(
				await signSealRegisteredDigest({ request: delayed.signingRequest, signer: finality.signer })
			);
		} catch (cause) {
			result.lateError = {
				name: cause instanceof Error ? cause.name : typeof cause,
				message: cause instanceof Error ? cause.message : String(cause),
				...(cause instanceof SigningAdmissionRefusal ? { reason: cause.reason } : {}),
			};
		}
		result.afterLateSigning = await signingDetailImage(databaseName);
		const current = prepareSealVote({
			authority: opened.authority as SealAuthority,
			exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
			phase: "prepare",
			round: 2,
		});
		if (!current.ok) throw new Error(`GENUINE_CURRENT_REQUEST_REFUSED:${current.reason}`);
		bindSealSigningRequest(current.signingRequest, admission);
		result.currentPreimage = bytesHex(current.exactCanonicalPreimageBytes);
		result.currentTuple = decodeCanonical(current.exactCanonicalPreimageBytes);
		result.currentDigest = bytesHex(current.registeredDigest);
		signingPhase = "current";
		const signature = await signSealRegisteredDigest({ request: current.signingRequest, signer: finality.signer });
		result.currentSignature = bytesHex(signature);
		result.currentVerified = verifySealVoteCarrier({
			authority: opened.authority as SealAuthority,
			exactCanonicalPreimageBytes: current.exactCanonicalPreimageBytes,
			signature,
		});
		result.afterCurrentSigning = await signingDetailImage(databaseName);
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		if (signDescriptor !== undefined) Object.defineProperty(Ed25519PrivateKey.prototype, "sign", signDescriptor);
		// Native admission failure joins its original read before delivery;
		// local finality retirement joins entered work, not a durable seed fence.
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dDelayedPhysicalSigning", result);
	}
	return result;
}

async function runPublicationDebtCustody(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [],
		checkpoints: unknown[] = [];
	const result: Record<string, unknown> = { databaseName, events, published, checkpoints };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	const tasks: Promise<unknown>[] = [];
	const originalTransaction = IDBDatabase.prototype.transaction;
	const originalGetKey = IDBObjectStore.prototype.getKey;
	const originalPut = IDBObjectStore.prototype.put;
	let releasePublisher!: () => void,
		publisherEntered!: () => void,
		reachedPulse!: () => void,
		reachedTerminal!: () => void;
	const gate = new Promise<void>((resolve) => {
		releasePublisher = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		publisherEntered = resolve;
	});
	const pulse = new Promise<void>((resolve) => {
		reachedPulse = resolve;
	});
	const terminal = new Promise<void>((resolve) => {
		reachedTerminal = resolve;
	});
	let latestRead: IDBTransaction | undefined,
		heldRead: IDBTransaction | undefined,
		foreignAck: IDBTransaction | undefined;
	let heldTerminal: string | undefined, ackTerminal: string | undefined;
	let ackWrites = 0,
		publicationCalls = 0;
	let foreignAckArmed = false,
		pulseArmed = false;
	let publisherSettled = false,
		ackSettled = false,
		dispatcherClosed = false,
		storeClosed = false;
	const record = (kind: string): void => {
		checkpoints.push({ index: checkpoints.length, kind });
	};
	const track = <T>(task: Promise<T>): Promise<T> => {
		tasks.push(task);
		void task.catch(() => undefined);
		return task;
	};
	try {
		const opened = await openHarness(databaseName, events);
		owners.push(
			{ name: "voter", close: () => opened.browser.close() },
			{ name: "pacemaker", close: () => opened.pacemaker.stop() }
		);
		await opened.pacemaker.stop();
		result.vote0 = await opened.voter.vote({
			exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
			expectedRevision: opened.voter.status().revision,
			phase: "prepare",
			round: 0,
		});
		const qc2 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 2);
		result.verifiedQc2 = verifySealQC({ authority: opened.authority as SealAuthority, exactCanonicalQcBytes: qc2 });
		result.persistedQc2 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc2 });
		const beforeDebt = await signingDetailImage(databaseName);
		result.beforeDebt = beforeDebt;
		result.debtRetirement = await opened.voter.retireDetails({ expectedRevision: opened.voter.status().revision });
		result.afterDebt = await signingDetailImage(databaseName);
		const dispatchStore = await openInternalSealVoteStore({ databaseName });
		const foreignStore = await openInternalSealVoteStore({ databaseName });
		owners.push(
			{ name: "dispatch-store", close: () => dispatchStore.close() },
			{ name: "foreign-store", close: () => foreignStore.close() }
		);
		const own = (await dispatchStore.readPending(5)).find(
			(row) =>
				row.objectId === OBJECT_ID &&
				row.epoch === 0 &&
				row.round === 0 &&
				row.phase === "prepare" &&
				row.signerId === SIGNERS[0]?.signerId
		);
		if (own === undefined) throw new Error("GENUINE_UNDISPATCHED_VOTE_REQUIRED");
		const key = [own.objectId, own.epoch, own.round, own.phase, own.signerId] as const;
		result.originalKey = key;
		result.originalCarrier = verifySealVoteCarrier({ authority: opened.authority as SealAuthority, ...own.carrier });
		result.expectedAfterAck = {
			...beforeDebt,
			frames: beforeDebt.frames.map((frame) => {
				if (frame.table !== "voteOutbox" || JSON.stringify(frame.key) !== JSON.stringify(key)) return frame;
				const decoded = decodeCanonical(hexBytes(frame.bytes)) as unknown[];
				return {
					...frame,
					bytes: bytesHex(encodeCanonical([frame.table, frame.key, { ...(decoded[2] as object), dispatched: true }])),
				};
			}),
		};
		// All wrappers call the existing observer/original receiver unchanged.
		// A real held native keepalive SUCCESS supplies the pre-release barrier;
		// no timeout/sleep or JS-lock state substitutes for native exclusion.
		Reflect.set(IDBDatabase.prototype, "transaction", function (this: IDBDatabase, ...args: unknown[]) {
			const transaction = Reflect.apply(originalTransaction, this, args) as IDBTransaction;
			if (
				this.name === databaseName &&
				Array.from(transaction.objectStoreNames).join(",") === [...VOTE_TRANSACTION_STORES].sort().join(",")
			) {
				if (transaction.mode === "readonly") {
					latestRead = transaction;
					// Attach before the owner's completion callbacks, so the actual
					// terminal marker precedes promise continuations of its joins.
					for (const kind of ["complete", "abort"] as const)
						transaction.addEventListener(
							kind,
							() => {
								if (transaction !== heldRead) return;
								heldTerminal = kind;
								record(`held-native-${kind}`);
								reachedTerminal();
							},
							{ once: true }
						);
				}
				if (transaction.mode === "readwrite" && foreignAckArmed) {
					foreignAckArmed = false;
					foreignAck = transaction;
					record("foreign-ack-transaction-created");
					result.foreignTransaction = {
						databaseName: this.name,
						mode: transaction.mode,
						durability: transaction.durability,
						stores: Array.from(transaction.objectStoreNames),
						differentConnection: this !== heldRead?.db,
					};
					for (const kind of ["complete", "abort"] as const)
						transaction.addEventListener(
							kind,
							() => {
								ackTerminal = kind;
								record(`foreign-ack-${kind}`);
							},
							{ once: true }
						);
				}
			}
			return transaction;
		});
		Reflect.set(IDBObjectStore.prototype, "getKey", function (this: IDBObjectStore, ...args: unknown[]) {
			const request = Reflect.apply(originalGetKey, this, args) as IDBRequest<IDBValidKey | undefined>;
			request.addEventListener(
				"success",
				() => {
					if (pulseArmed && this.transaction === heldRead) {
						pulseArmed = false;
						record("held-native-success-before-release");
						result.heldCheckpoint = {
							publisherSettled,
							ackSettled,
							ackWrites,
							heldTerminal,
							ackTerminal,
							dispatcherClosed,
							storeClosed,
							publicationCalls,
						};
						reachedPulse();
					}
				},
				{ once: true }
			);
			return request;
		});
		Reflect.set(IDBObjectStore.prototype, "put", function (this: IDBObjectStore, ...args: unknown[]) {
			const request = Reflect.apply(originalPut, this, args) as IDBRequest<IDBValidKey>;
			if (this.transaction === foreignAck) {
				ackWrites++;
				record("foreign-ack-put");
				request.addEventListener("success", () => record("foreign-ack-put-success"), { once: true });
			}
			return request;
		});
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: dispatchStore,
			publish: async ({ key: publishedKey }) => {
				publicationCalls++;
				heldRead = latestRead;
				if (heldRead === undefined || heldRead.mode !== "readonly") throw new Error("ORIGINAL_PUBLICATION_RO_REQUIRED");
				result.heldTransaction = {
					databaseName: heldRead.db.name,
					mode: heldRead.mode,
					stores: Array.from(heldRead.objectStoreNames),
				};
				record("publisher-entered");
				publisherEntered();
				await gate;
				published.push(publishedKey);
				publisherSettled = true;
				record("publisher-settled");
			},
		});
		owners.push({ name: "dispatcher", close: () => dispatcher.close() });
		const drain = track(dispatcher.drain());
		await Promise.race([
			entered,
			drain.then(() => {
				throw new Error("ORIGINAL_PUBLISHER_DID_NOT_ENTER");
			}),
		]);
		foreignAckArmed = true;
		const acknowledgment = track(
			foreignStore.markDispatched(key).then(() => {
				ackSettled = true;
				record("foreign-ack-joined");
			})
		);
		record("dispatcher-close-invoked");
		const closeDispatcher = track(
			dispatcher.close().then(() => {
				dispatcherClosed = true;
				record("dispatcher-close-joined");
			})
		);
		record("store-close-invoked");
		const closeStore = track(
			dispatchStore.close().then(() => {
				storeClosed = true;
				record("store-close-joined");
			})
		);
		try {
			const unexpected = await dispatchStore.acquireSigningAdmission({ objectId: OBJECT_ID });
			await unexpected.release();
			result.unexpectedAdmission = true;
		} catch (cause) {
			result.newAdmissionError = {
				name: cause instanceof Error ? cause.name : typeof cause,
				message: cause instanceof Error ? cause.message : String(cause),
			};
			record("new-admission-refused");
		}
		const closedDrain = track(dispatcher.drain());
		pulseArmed = true;
		await Promise.race([
			pulse,
			terminal.then(() => {
				throw new Error("NATIVE_HOLD_ENDED_BEFORE_PUBLISHER_JOIN");
			}),
		]);
		record("publisher-gate-release");
		releasePublisher();
		result.originalDrain = await drain;
		await acknowledgment;
		await closeDispatcher;
		await closeStore;
		result.closedDrain = await closedDrain;
		result.joined = {
			publisherSettled,
			ackSettled,
			ackWrites,
			heldTerminal,
			ackTerminal,
			dispatcherClosed,
			storeClosed,
			publicationCalls,
		};
		result.afterJoinedPublication = await signingDetailImage(databaseName);
		await opened.browser.close();
		await foreignStore.close();
		const fresh = await openHarness(databaseName, events);
		owners.push(
			{ name: "fresh-voter", close: () => fresh.browser.close() },
			{ name: "fresh-pacemaker", close: () => fresh.pacemaker.stop() }
		);
		await fresh.pacemaker.stop();
		result.freshRetirement = await fresh.voter.retireDetails({ expectedRevision: fresh.voter.status().revision });
		result.afterRetirement = await signingDetailImage(databaseName);
		result.futureVote = await fresh.voter.vote({
			exactCanonicalCutValueBytes: fresh.exactCanonicalCutValueBytes,
			expectedRevision: fresh.voter.status().revision,
			phase: "prepare",
			round: 2,
		});
		const futureStore = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "future-store", close: () => futureStore.close() });
		const futureDispatcher = createInternalVoteDispatcher({
			databaseName,
			store: futureStore,
			publish: async ({ key: publishedKey }) => {
				published.push(publishedKey);
				await Promise.resolve();
			},
		});
		owners.push({ name: "future-dispatcher", close: () => futureDispatcher.close() });
		result.futurePublication = await futureDispatcher.drain();
		result.afterFuture = await signingDetailImage(databaseName);
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		releasePublisher();
		result.taskJoins = (await Promise.allSettled(tasks)).map((entry) => ({
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(IDBDatabase.prototype, "transaction", originalTransaction);
		Reflect.set(IDBObjectStore.prototype, "getKey", originalGetKey);
		Reflect.set(IDBObjectStore.prototype, "put", originalPut);
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dPublicationDebtCustody", result);
	}
	return result;
}

async function runFinalQcMinimumRetirement(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [],
		negatives: unknown[] = [];
	const result: Record<string, unknown> = { databaseName, events, published, negatives };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	const requireSuccess = (value: unknown, operation: string): void => {
		if (value === null || typeof value !== "object" || Reflect.get(value, "ok") !== true)
			throw new Error(`GENUINE_FINAL_QC_PREREQUISITE:${operation}`);
	};
	const trace = (): readonly unknown[] => Reflect.get(window, "__phase5dTransactions") as readonly unknown[];
	try {
		const opened = await openHarness(databaseName, events);
		owners.push(
			{ name: "voter", close: () => opened.browser.close() },
			{ name: "pacemaker", close: () => opened.pacemaker.stop() }
		);
		await opened.pacemaker.stop();
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "dispatch-store", close: () => internal.close() });
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "dispatcher", close: () => dispatcher.close() });
		result.vote0 = await opened.voter.vote({
			exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
			expectedRevision: opened.voter.status().revision,
			phase: "prepare",
			round: 0,
		});
		requireSuccess(result.vote0, "prepare0");
		result.publication0 = await dispatcher.drain();
		const authority = opened.authority as SealAuthority;
		const qc1 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 1);
		result.verifiedPrepare1 = verifySealQC({ authority, exactCanonicalQcBytes: qc1 });
		requireSuccess(result.verifiedPrepare1, "verify-prepare1");
		result.persistedPrepare1 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc1 });
		requireSuccess(result.persistedPrepare1, "persist-prepare1");
		// Produce protected detail1 before finalization, through the original voter.
		result.vote1 = await opened.voter.vote({
			exactCanonicalCutValueBytes: opened.exactCanonicalCutValueBytes,
			expectedRevision: opened.voter.status().revision,
			phase: "prepare",
			round: 1,
		});
		requireSuccess(result.vote1, "prepare1");
		result.publication1 = await dispatcher.drain();
		await dispatcher.close();
		const final1 = await exactQc(opened.exactCanonicalCutValueBytes, "commit", 1);
		result.verifiedCommit1 = verifySealQC({ authority, exactCanonicalQcBytes: final1 });
		requireSuccess(result.verifiedCommit1, "verify-commit1");
		result.persistedCommit1 = await opened.voter.persistQc({ exactCanonicalQcBytes: final1 });
		requireSuccess(result.persistedCommit1, "persist-commit1");
		const qc2 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 2);
		result.verifiedPrepare2 = verifySealQC({ authority, exactCanonicalQcBytes: qc2 });
		requireSuccess(result.verifiedPrepare2, "verify-prepare2");
		result.persistedPrepare2 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc2 });
		requireSuccess(result.persistedPrepare2, "persist-prepare2");
		const identity = resolveSealAuthorityIdentity(authority);
		if (identity === undefined) throw new Error("GENUINE_FINAL_QC_AUTHORITY_REQUIRED");
		const held = await internal.acquireSigningDependencyObservation({ objectId: identity.objectId });
		let request: SealDetailRetirementIntentData | undefined;
		try {
			const frames = held.readExactCanonicalRows();
			const stateFrame = frames
				.map((bytes) => decodeCanonical(bytes) as unknown[])
				.find(
					(frame) =>
						frame[0] === "signerState" &&
						Array.isArray(frame[1]) &&
						frame[1][0] === identity.objectId &&
						frame[1][1] === identity.epoch &&
						frame[1][2] === identity.signerId
				);
			const state = stateFrame?.[2] as
				| Readonly<{
						revision: number;
						enteredRound: number;
						highestPrepareQC: Readonly<{ round: number; exactCanonicalQcBytes: Uint8Array }>;
						finalizedCommitQC: Readonly<{ round: number; exactCanonicalQcBytes: Uint8Array }>;
				  }>
				| undefined;
			if (
				state === undefined ||
				state.highestPrepareQC.round !== 2 ||
				state.finalizedCommitQC.round !== 1 ||
				state.enteredRound !== 2 ||
				state.revision !== opened.voter.status().revision ||
				bytesHex(state.highestPrepareQC.exactCanonicalQcBytes) !== bytesHex(qc2) ||
				bytesHex(state.finalizedCommitQC.exactCanonicalQcBytes) !== bytesHex(final1)
			)
				throw new Error("GENUINE_HELD_FINAL_QC_SOURCE_REQUIRED");
			request = {
				...identity,
				expectedIncarnation: held.control.incarnation,
				expectedRevision: state.revision,
				imageDigest: held.imageDigest,
				retiredBeforeRound: 1,
				highestPrepareQcBytes: Uint8Array.from(state.highestPrepareQC.exactCanonicalQcBytes),
				finalizedCommitQcBytes: Uint8Array.from(state.finalizedCommitQC.exactCanonicalQcBytes),
			};
			result.capture = {
				...request,
				highestPrepareQcBytes: bytesHex(request.highestPrepareQcBytes),
				finalizedCommitQcBytes: bytesHex(final1),
				enteredRound: state.enteredRound,
				frames: frames.map(bytesHex),
				presentFrames: frames.filter((bytes) => (decodeCanonical(bytes) as unknown[])[2] !== null).map(bytesHex),
				absentFrames: frames.filter((bytes) => (decodeCanonical(bytes) as unknown[])[2] === null).map(bytesHex),
			};
			await held.check();
		} finally {
			await held.release();
			result.captureReleaseJoined = true;
		}
		if (request === undefined) throw new Error("GENUINE_HELD_RETIREMENT_CAPTURE_REQUIRED");
		// These raw internal calls test mechanical CAS only. They mint no nominal
		// protocol selection and are never used for successful physical deletion.
		const negative = async (operation: string, raw: SealDetailRetirementIntentData): Promise<void> => {
			const before = await signingDetailImage(databaseName),
				start = trace().length;
			const refused = await internal.retireDetails(raw);
			const transactions = structuredClone(trace().slice(start));
			negatives.push({
				operation,
				result: refused,
				before,
				after: await signingDetailImage(databaseName),
				transactions,
			});
		};
		await negative("wrong-incarnation", {
			...request,
			expectedIncarnation: (request.expectedIncarnation[0] === "0" ? "1" : "0") + request.expectedIncarnation.slice(1),
		});
		await negative("wrong-revision", { ...request, expectedRevision: request.expectedRevision + 1 });
		await negative("wrong-image", {
			...request,
			imageDigest: (request.imageDigest[0] === "0" ? "1" : "0") + request.imageDigest.slice(1),
		});
		const qc3 = await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 3);
		result.verifiedPrepare3 = verifySealQC({ authority, exactCanonicalQcBytes: qc3 });
		requireSuccess(result.verifiedPrepare3, "verify-prepare3");
		result.persistedPrepare3 = await opened.voter.persistQc({ exactCanonicalQcBytes: qc3 });
		requireSuccess(result.persistedPrepare3, "persist-prepare3");
		result.afterHigherQc = await signingDetailImage(databaseName);
		await negative("captured-before-higher-qc", request);
		result.before = await signingDetailImage(databaseName);
		const start = trace().length;
		result.retirement = await opened.voter.retireDetails({ expectedRevision: opened.voter.status().revision });
		result.retirementTransactions = structuredClone(trace().slice(start));
		result.after = await signingDetailImage(databaseName);
		await opened.browser.close();
		await internal.close();
		const cold = await openHarness(databaseName, events);
		owners.push(
			{ name: "cold-voter", close: () => cold.browser.close() },
			{ name: "cold-pacemaker", close: () => cold.pacemaker.stop() }
		);
		await cold.pacemaker.stop();
		result.reopened = await signingDetailImage(databaseName);
		result.coldStatus = cold.voter.status();
		const stateFrame = (result.reopened as Awaited<ReturnType<typeof signingDetailImage>>).frames.find(
			(frame) =>
				frame.table === "signerState" &&
				Array.isArray(frame.key) &&
				frame.key[0] === identity.objectId &&
				frame.key[1] === identity.epoch &&
				frame.key[2] === identity.signerId
		);
		if (stateFrame === undefined) throw new Error("GENUINE_COLD_FINAL_QC_STATE_REQUIRED");
		const state = (decodeCanonical(hexBytes(stateFrame.bytes)) as unknown[])[2] as Readonly<{
			highestPrepareQC: Readonly<{ exactCanonicalQcBytes: Uint8Array }>;
			finalizedCommitQC: Readonly<{ exactCanonicalQcBytes: Uint8Array }>;
		}>;
		result.coldQcBytes = {
			prepare: bytesHex(state.highestPrepareQC.exactCanonicalQcBytes),
			commit: bytesHex(state.finalizedCommitQC.exactCanonicalQcBytes),
			expectedPrepare: bytesHex(qc3),
			expectedCommit: bytesHex(final1),
		};
		result.coldPrepareVerified = verifySealQC({
			authority: cold.authority as SealAuthority,
			exactCanonicalQcBytes: state.highestPrepareQC.exactCanonicalQcBytes,
		});
		result.coldCommitVerified = verifySealQC({
			authority: cold.authority as SealAuthority,
			exactCanonicalQcBytes: state.finalizedCommitQC.exactCanonicalQcBytes,
		});
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dFinalQcMinimum", result);
	}
	return result;
}

async function runStaleHandleDetailRestore(databaseName: string): Promise<unknown> {
	const events: unknown[] = [],
		published: string[] = [],
		negatives: unknown[] = [];
	const result: Record<string, unknown> = { databaseName, events, published, negatives };
	const owners: Array<Readonly<{ name: string; close(): Promise<void> }>> = [];
	const requireSuccess = (value: unknown, operation: string): void => {
		if (value === null || typeof value !== "object" || Reflect.get(value, "ok") !== true)
			throw new Error(`GENUINE_STALE_HANDLE_PREREQUISITE:${operation}`);
	};
	const trace = (): readonly unknown[] => Reflect.get(window, "__phase5dTransactions") as readonly unknown[];
	try {
		const old = await openHarness(databaseName, events);
		owners.push(
			{ name: "old-voter", close: () => old.browser.close() },
			{ name: "old-pacemaker", close: () => old.pacemaker.stop() }
		);
		await old.pacemaker.stop();
		result.vote0 = await old.voter.vote({
			exactCanonicalCutValueBytes: old.exactCanonicalCutValueBytes,
			expectedRevision: old.voter.status().revision,
			phase: "prepare",
			round: 0,
		});
		requireSuccess(result.vote0, "prepare0");
		const internal = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "old-native-store", close: () => internal.close() });
		const dispatcher = createInternalVoteDispatcher({
			databaseName,
			store: internal,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "dispatcher", close: () => dispatcher.close() });
		result.publication0 = await dispatcher.drain();
		await dispatcher.close();
		result.oldStatus = old.voter.status();
		result.oldIncarnation = old.browser.observation.incarnation;
		const qc0 = await exactQc(old.exactCanonicalCutValueBytes, "prepare", 0);
		result.verifiedRestoreQc0 = verifySealQC({ authority: old.authority as SealAuthority, exactCanonicalQcBytes: qc0 });
		requireSuccess(result.verifiedRestoreQc0, "verify-restore-qc0");
		const current = await openHarness(databaseName, events);
		owners.push(
			{ name: "current-voter", close: () => current.browser.close() },
			{ name: "current-pacemaker", close: () => current.pacemaker.stop() }
		);
		await current.pacemaker.stop();
		const qc2 = await exactQc(current.exactCanonicalCutValueBytes, "prepare", 2);
		result.verifiedQc2 = verifySealQC({ authority: current.authority as SealAuthority, exactCanonicalQcBytes: qc2 });
		requireSuccess(result.verifiedQc2, "verify-qc2");
		result.persistedQc2 = await current.voter.persistQc({ exactCanonicalQcBytes: qc2 });
		requireSuccess(result.persistedQc2, "persist-qc2");
		result.before = await signingDetailImage(databaseName);
		result.retirement = await current.voter.retireDetails({ expectedRevision: current.voter.status().revision });
		requireSuccess(result.retirement, "physical-retirement");
		const after = await signingDetailImage(databaseName);
		result.after = after;
		result.currentStatus = current.voter.status();
		// SAME pre-opened genuine owner, with cached entered0/revision1. No
		// caller-supplied old epoch or fake restore capability bypasses admission.
		const negative = async (operation: string, run: () => Promise<unknown>): Promise<void> => {
			const before = await signingDetailImage(databaseName),
				statusBefore = old.voter.status(),
				start = trace().length;
			const refused = await run();
			const transactions = structuredClone(trace().slice(start));
			negatives.push({
				operation,
				result: refused,
				statusBefore,
				statusAfter: old.voter.status(),
				before,
				after: await signingDetailImage(databaseName),
				transactions,
			});
		};
		// Replaying an authentic older QC is the original same-epoch restoration
		// entrypoint. This is NOT peer sealEvidence restoration/epoch retirement.
		await negative("restore-retired-qc0", () => old.voter.persistQc({ exactCanonicalQcBytes: qc0 }));
		await negative("stale-current-qc2", () => old.voter.persistQc({ exactCanonicalQcBytes: qc2 }));
		await negative("old-live-vote0", () =>
			old.voter.vote({
				exactCanonicalCutValueBytes: old.exactCanonicalCutValueBytes,
				expectedRevision: old.voter.status().revision,
				phase: "prepare",
				round: 0,
			})
		);
		const identity = resolveSealAuthorityIdentity(old.authority as SealAuthority);
		if (identity === undefined) throw new Error("GENUINE_OLD_SNAPSHOT_AUTHORITY_REQUIRED");
		const snapshot = await internal.openSnapshot({ ...identity, expectedIncarnation: internal.incarnation });
		if (snapshot === null || typeof snapshot !== "object") throw new Error("GENUINE_OLD_SNAPSHOT_REQUIRED");
		result.oldNativeSnapshot = {
			incarnation: Reflect.get(snapshot, "incarnation"),
			revision: Reflect.get(snapshot, "revision"),
			enteredRound: Reflect.get(snapshot, "enteredRound"),
			retiredBeforeRound: Reflect.get(snapshot, "retiredBeforeRound"),
			highestPrepareQcBytes: bytesHex(Reflect.get(snapshot, "highestPrepareQcBytes") as Uint8Array),
		};
		result.expectedQc2 = bytesHex(qc2);
		result.afterOldSnapshot = await signingDetailImage(databaseName);
		await old.browser.close();
		await current.browser.close();
		await internal.close();
		const cold = await openHarness(databaseName, events);
		owners.push(
			{ name: "cold-voter", close: () => cold.browser.close() },
			{ name: "cold-pacemaker", close: () => cold.pacemaker.stop() }
		);
		await cold.pacemaker.stop();
		result.reopened = await signingDetailImage(databaseName);
		result.coldIncarnation = cold.browser.observation.incarnation;
		result.coldStatus = cold.voter.status();
		result.futureVote = await cold.voter.vote({
			exactCanonicalCutValueBytes: cold.exactCanonicalCutValueBytes,
			expectedRevision: cold.voter.status().revision,
			phase: "prepare",
			round: 2,
		});
		requireSuccess(result.futureVote, "current-prepare2");
		const futureStore = await openInternalSealVoteStore({ databaseName });
		owners.push({ name: "future-store", close: () => futureStore.close() });
		const futureDispatcher = createInternalVoteDispatcher({
			databaseName,
			store: futureStore,
			publish: async ({ key }) => {
				published.push(key);
				await Promise.resolve();
			},
		});
		owners.push({ name: "future-dispatcher", close: () => futureDispatcher.close() });
		result.futurePublication = await futureDispatcher.drain();
		result.afterFuture = await signingDetailImage(databaseName);
	} catch (cause) {
		result.error = {
			name: cause instanceof Error ? cause.name : typeof cause,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	} finally {
		result.cleanup = (await Promise.allSettled(owners.map(({ close }) => close()))).map((entry, index) => ({
			name: owners[index]?.name,
			status: entry.status,
			...(entry.status === "rejected" ? { cause: String(entry.reason) } : {}),
		}));
		Reflect.set(window, "__phase5dStaleHandleRestore", result);
	}
	return result;
}

declare global {
	interface Window {
		phase5dPacemaker: Readonly<{
			runStalledDirectVoter(databaseName: string): Promise<unknown>;
			runPacemakerCaptureBounds(databaseName: string): Promise<unknown>;
			runStalledPacemakerTimer(databaseName: string): Promise<unknown>;
			runStalledPacemakerAdmission(databaseName: string): Promise<unknown>;
			runStaleHandleDetailRestore(databaseName: string): Promise<unknown>;
			runFinalQcMinimumRetirement(databaseName: string): Promise<unknown>;
			runAuthenticatedDetailRetirement(databaseName: string): Promise<unknown>;
			runAuthenticatedDetailRetirementBatches(databaseName: string): Promise<unknown>;
			runColdDetailRetirementResume(databaseName: string): Promise<unknown>;
			runAuthenticatedRoundChangeRetirement(databaseName: string): Promise<unknown>;
			runDelayedPhysicalDetailSigning(databaseName: string): Promise<unknown>;
			runPublicationDebtCustody(databaseName: string): Promise<unknown>;
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
	runStalledDirectVoter,
	runPacemakerCaptureBounds,
	runStalledPacemakerTimer,
	runStalledPacemakerAdmission,
	runStaleHandleDetailRestore,
	runFinalQcMinimumRetirement,
	runAuthenticatedDetailRetirement,
	runAuthenticatedDetailRetirementBatches,
	runColdDetailRetirementResume,
	runAuthenticatedRoundChangeRetirement,
	runDelayedPhysicalDetailSigning,
	runPublicationDebtCustody,
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
