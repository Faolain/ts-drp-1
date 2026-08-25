import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
// eslint-disable-next-line import/no-unresolved -- RED intentionally imports the future finality subpath.
import { createRecoverableFinalitySigner, signSealRegisteredDigest } from "@ts-drp/keychain/finality";
import { installCertifiedAnchorTrustRoot } from "@ts-drp/protocol-v3";
// eslint-disable-next-line import/no-unresolved -- RED intentionally imports the future protocol seal subpath.
import { openSealAuthority, prepareSealVote } from "@ts-drp/protocol-v3/seal";
import { createSealVoter } from "@ts-drp/seal";
// eslint-disable-next-line import/no-unresolved -- RED intentionally imports the future pacemaker subpath.
import { createSealPacemaker } from "@ts-drp/seal/pacemaker";

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
	input: Readonly<Record<string, unknown>>;
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

function observedMetrics(
	events: string[]
): Readonly<{ traceFunc(name: string, operation: (...args: never[]) => unknown): (...args: never[]) => unknown }> {
	return Object.freeze({
		traceFunc(name: string, operation: (...args: never[]) => unknown) {
			return (...args: never[]) => {
				events.push(name);
				return operation(...args);
			};
		},
	});
}

async function openHarness(databaseName: string, events: string[]): Promise<OpenHarnessResult> {
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
	round: number
): Promise<Uint8Array> {
	const genesis = certifiedGenesis();
	const installed = installCertifiedAnchorTrustRoot(genesis.input);
	if (!installed.ok) throw new Error("trust install failed");
	const votes = [];
	let valueDigest = "";
	let proposalHash = "";
	for (const selected of SIGNERS.slice(0, 3)) {
		const finality = await createRecoverableFinalitySigner({ seed: hexBytes(selected.privateKeySeedHex) });
		const authority = openSealAuthority({ signerPublicKey: finality.publicKey, trust: installed.trust });
		if (!authority.ok) throw new Error("authority open failed");
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
	const events: string[] = [];
	const first = await openHarness(databaseName, events);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_150));
	const beforeClose = first.pacemaker.status();
	await first.pacemaker.stop();
	await first.browser.close();
	const reopened = await openHarness(databaseName, events);
	const afterReopen = reopened.pacemaker.status();
	await reopened.pacemaker.stop();
	await reopened.browser.close();
	return { afterReopen, beforeClose, events };
}

async function runQcCustody(databaseName: string): Promise<unknown> {
	const events: string[] = [];
	const opened = await openHarness(databaseName, events);
	try {
		const proposal = await opened.pacemaker.observeProposalBundle(
			await exactProposalBundle(opened.exactCanonicalCutValueBytes)
		);
		const prepare = await opened.pacemaker.observePrepareQc(
			await exactQc(opened.exactCanonicalCutValueBytes, "prepare", 0)
		);
		const beforeFinal = opened.pacemaker.status();
		const finalized = await opened.pacemaker.observeCommitQc(
			await exactQc(opened.exactCanonicalCutValueBytes, "commit", 0)
		);
		return { afterFinal: opened.pacemaker.status(), beforeFinal, events, finalized, prepare, proposal };
	} finally {
		await opened.pacemaker.stop();
		await opened.browser.close();
	}
}

declare global {
	interface Window {
		phase5dPacemaker: Readonly<{
			runQcCustody(databaseName: string): Promise<unknown>;
			runRoundChangeCommit(databaseName: string): Promise<unknown>;
		}>;
	}
}

window.phase5dPacemaker = Object.freeze({ runQcCustody, runRoundChangeCommit });

export {};
