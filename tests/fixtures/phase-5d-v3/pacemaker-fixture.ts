import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { installCertifiedAnchorTrustRoot } from "@ts-drp/protocol-v3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
	ItfTrace,
	ItfTraceState,
	PacemakerCandidateModules,
	PacemakerStatus,
	PacemakerTraceDriver,
	SealPacemakerHandle,
} from "./pacemaker-types.js";
import { installInput, makeCertifiedGenesis } from "../phase-3b-v3/certified-genesis-contract.js";
import { EXACT_CUT_VALUE_BYTES } from "../phase-5-v3/seal-contract.js";

export const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

export interface PacemakerProductContract {
	readonly actionCoverage: readonly string[];
	readonly events: readonly string[];
	readonly limits: Readonly<{
		readonly activeSignerCounts: readonly number[];
		readonly futureWindow: number;
		readonly maxBufferedRounds: number;
		readonly safeRoundMaximum: number;
	}>;
	readonly model: Readonly<{
		readonly invariants: readonly string[];
		readonly module: string;
		readonly path: string;
		readonly runs: readonly string[];
		readonly sha256: string;
	}>;
	readonly mutantRejections: Readonly<Record<string, string>>;
	readonly phases: readonly string[];
	readonly profile: Readonly<{
		readonly apalacheVersion: string;
		readonly epoch: number;
		readonly id: string;
		readonly maxFutureRoundGap: number;
		readonly minimumLivenessSteps: number;
		readonly minimumSymbolicSteps: number;
		readonly roundTimeoutBaseMs: number;
		readonly roundTimeoutMaxMs: number;
	}>;
	readonly requiredRuntimeExports: Readonly<Record<string, readonly string[]>>;
	readonly runtimeOwners: readonly string[];
	readonly storage: Readonly<{
		readonly completeCommitQcRequired: boolean;
		readonly completeHighestQcRequired: boolean;
		readonly qcTransactionStores: readonly string[];
		readonly roundChangePhase: string;
		readonly schemaVersion: number;
		readonly voteTransactionStores: readonly string[];
	}>;
	readonly traces: readonly Readonly<{
		readonly n: number;
		readonly path: string;
		readonly requiredEvents: readonly string[];
		readonly sha256: string;
	}>[];
}

export const PRODUCT_CONTRACT = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "pacemaker-contract.json"), "utf8")
) as PacemakerProductContract;

/**
 * Returns the SHA-256 digest of one frozen fixture owner.
 * @param path - Absolute path to the owner.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Reports the single production-owner readiness boundary for the RED.
 * @returns Frozen readiness state and missing-owner roster.
 */
export function runtimeReadiness(): Readonly<{ readonly missing: readonly string[]; readonly ready: boolean }> {
	const missing = PRODUCT_CONTRACT.runtimeOwners.filter((path) => !existsSync(resolve(REPOSITORY_ROOT, path)));
	if (missing.length === 0) {
		const sealPackage = JSON.parse(
			readFileSync(resolve(REPOSITORY_ROOT, "packages/seal/package.json"), "utf8")
		) as Readonly<{ readonly exports?: Readonly<Record<string, unknown>> }>;
		if (sealPackage.exports?.["./pacemaker"] === undefined) {
			missing.push("packages/seal/package.json#exports./pacemaker");
		}
		const viteSource = readFileSync(resolve(REPOSITORY_ROOT, "vite.config.mts"), "utf8");
		const pacemakerAlias = viteSource.indexOf('"@ts-drp/seal/pacemaker"');
		const bareAlias = viteSource.indexOf('"@ts-drp/seal"');
		if (pacemakerAlias < 0 || bareAlias < 0 || pacemakerAlias > bareAlias) {
			missing.push("vite.config.mts#specific-before-bare-pacemaker-alias");
		}
	}
	return Object.freeze({ missing: Object.freeze(missing), ready: missing.length === 0 });
}

/**
 * Proves that the hash manifest closes the complete trace directory.
 * @returns True only when no additional or missing JSON trace exists.
 */
export function traceManifestIsExact(): boolean {
	const traceDirectory = resolve(REPOSITORY_ROOT, "packages/seal/model/traces");
	const actual = readdirSync(traceDirectory)
		.filter((name) => name.endsWith(".itf.json"))
		.map((name) => `packages/seal/model/traces/${name}`)
		.sort();
	const expected = PRODUCT_CONTRACT.traces.map(({ path }) => path).sort();
	return actual.length === expected.length && actual.every((path, index) => path === expected[index]);
}

/**
 * Reads one hash-bound closed ITF trace.
 * @param path - Repository-relative trace path.
 * @returns Parsed trace fixture.
 */
export function readTrace(path: string): ItfTrace {
	return JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8")) as ItfTrace;
}

/**
 * Returns the sorted enumerable and non-enumerable string-key roster.
 * @param value - Object whose own keys are inspected.
 * @returns Sorted string-key roster.
 */
export function exactKeys(value: object): readonly string[] {
	return Object.freeze(
		Reflect.ownKeys(value)
			.filter((key): key is string => typeof key === "string")
			.sort()
	);
}

/**
 * Loads the future production entry points after the readiness boundary opens.
 * @returns Candidate production modules.
 */
export async function loadPacemakerCandidateModules(): Promise<PacemakerCandidateModules> {
	const specifiers = [
		"@ts-drp/storage-browser/seal-vote",
		"@ts-drp/keychain/finality",
		"@ts-drp/seal/pacemaker",
		"@ts-drp/protocol-v3/seal",
		"@ts-drp/seal",
	] as const;
	const [browser, keychain, pacemaker, protocol, seal] = await Promise.all([
		import(specifiers[0]),
		import(specifiers[1]),
		import(specifiers[2]),
		import(specifiers[3]),
		import(specifiers[4]),
	]);
	return { browser, keychain, pacemaker, protocol, seal } as unknown as PacemakerCandidateModules;
}

/**
 * Independently evaluates the frozen exponential timeout profile.
 * @param round - Non-negative safe round number.
 * @returns Governed timeout in milliseconds.
 */
export function expectedTimeout(round: number): number {
	if (!Number.isSafeInteger(round) || round < 0) throw new TypeError("invalid round");
	if (round >= 5) return 30_000;
	return Math.min(30_000, 1000 * 2 ** round);
}

/**
 * Compares signer identifiers by their UTF-8 byte encodings.
 * @param left - Left signer identifier.
 * @param right - Right signer identifier.
 * @returns Negative, zero, or positive bytewise comparison result.
 */
export function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

interface PreparedSignedRecord {
	readonly exactCanonicalPreimageBytes: Uint8Array;
	readonly proposalHash: string;
	readonly registeredDigest: Uint8Array;
	readonly signature: Uint8Array;
	readonly signerId: string;
	readonly valueDigest: string;
}

function requireRecord<T extends object>(value: unknown, label: string): T {
	if (value === null || typeof value !== "object") throw new Error(label);
	return value as T;
}

/**
 * Creates the genuine fake-IDB product driver used by every checked trace once GREEN is ready.
 * @param modules - Resolved production modules.
 * @param trace - Hash-bound trace whose signer count controls the certified roster.
 * @param databaseName - Isolated primary browser database name.
 * @returns Product-backed trace driver with real registered carriers.
 */
export async function createProductTraceDriver(
	modules: PacemakerCandidateModules,
	trace: ItfTrace,
	databaseName: string
): Promise<PacemakerTraceDriver> {
	const n = trace.states[0]?.n;
	if (n === undefined) throw new Error("TRACE_TOO_SHORT");
	const material = makeCertifiedGenesis({
		objectId: "phase5d:dddddddddddddddddddddddddddddddd",
		profileId: "attested-bft-v1",
		quorum: n === 7 ? 5 : n - 1,
		signerIds: Array.from({ length: n }, (_, index) => String.fromCharCode(65 + index)),
	});
	const exactCanonicalCutValueBytes = encodeCanonical({
		...(decodeCanonical(EXACT_CUT_VALUE_BYTES) as Record<string, unknown>),
		nextSignerSet: material.signerSet,
		objectId: material.anchor.objectId,
		previousAnchor: material.anchorDigest,
	});
	const exactValueDigest = Buffer.from(hashDomain("ts-drp/hard-epoch-cut/v3", exactCanonicalCutValueBytes)).toString(
		"hex"
	);
	let browser: Awaited<ReturnType<typeof modules.browser.openBrowserSealVoteStore>> | undefined;
	let pacemaker: SealPacemakerHandle;
	let trust: unknown;

	const openAuthority = async (index: number): Promise<Readonly<{ authority: unknown; signer: unknown }>> => {
		const selected = material.signers[index];
		if (selected === undefined) throw new Error("missing certified signer");
		const finality = await modules.keychain.createRecoverableFinalitySigner({ seed: selected.privateKey });
		const opened = requireRecord<Readonly<{ ok: boolean; authority?: unknown; reason?: string; signerId?: string }>>(
			modules.protocol.openSealAuthority({ signerPublicKey: finality.publicKey, trust }),
			"authority-open-failed"
		);
		if (!opened.ok || opened.authority === undefined || opened.signerId !== selected.signerId) {
			throw new Error(opened.reason ?? "authority-open-failed");
		}
		return Object.freeze({ authority: opened.authority, signer: finality.signer });
	};

	const signedVote = async (
		index: number,
		phase: "commit" | "prepare",
		round: number
	): Promise<PreparedSignedRecord> => {
		const selected = material.signers[index];
		if (selected === undefined) throw new Error("missing certified signer");
		const opened = await openAuthority(index);
		const prepared = requireRecord<
			Readonly<{
				exactCanonicalPreimageBytes?: Uint8Array;
				ok: boolean;
				proposalHash?: string;
				reason?: string;
				registeredDigest?: Uint8Array;
				signingRequest?: unknown;
				valueDigest?: string;
			}>
		>(
			modules.protocol.prepareSealVote({
				authority: opened.authority,
				exactCanonicalCutValueBytes,
				phase,
				round,
			}),
			"vote-prepare-failed"
		);
		if (
			!prepared.ok ||
			prepared.exactCanonicalPreimageBytes === undefined ||
			prepared.registeredDigest === undefined ||
			prepared.proposalHash === undefined ||
			prepared.valueDigest === undefined
		) {
			throw new Error(prepared.reason ?? "vote-prepare-failed");
		}
		const signature = await modules.keychain.signSealRegisteredDigest({
			request: prepared.signingRequest,
			signer: opened.signer,
		});
		return Object.freeze({
			exactCanonicalPreimageBytes: prepared.exactCanonicalPreimageBytes,
			proposalHash: prepared.proposalHash,
			registeredDigest: prepared.registeredDigest,
			signature,
			signerId: selected.signerId,
			valueDigest: prepared.valueDigest,
		}) satisfies PreparedSignedRecord;
	};

	const exactQc = async (phase: "commit" | "prepare", round: number): Promise<Uint8Array> => {
		const votes = await Promise.all(
			Array.from({ length: n === 7 ? 5 : n - 1 }, (_, index) => signedVote(index, phase, round))
		);
		const first = votes[0];
		if (first === undefined) throw new Error("empty quorum");
		return encodeCanonical({
			epoch: 0,
			kind: "drp-seal-qc",
			objectId: material.anchor.objectId,
			phase,
			proposalDigest: first.valueDigest,
			proposalHash: first.proposalHash,
			round,
			votes: votes.map(({ registeredDigest, signature, signerId }) => ({
				signature: Buffer.from(signature).toString("hex"),
				signerId,
				voteDigest: Buffer.from(registeredDigest).toString("hex"),
			})),
		});
	};

	const roundChange = async (
		index: number,
		round: number
	): Promise<Parameters<SealPacemakerHandle["observeRoundChange"]>[0]> => {
		const opened = await openAuthority(index);
		const prepared = requireRecord<
			Readonly<{
				exactCanonicalPreimageBytes?: Uint8Array;
				ok: boolean;
				reason?: string;
				signingRequest?: unknown;
			}>
		>(
			modules.protocol.prepareRoundChange({ authority: opened.authority, highestPrepareQC: null, round }),
			"round-change-prepare-failed"
		);
		if (!prepared.ok || prepared.exactCanonicalPreimageBytes === undefined) {
			throw new Error(prepared.reason ?? "round-change-prepare-failed");
		}
		return Object.freeze({
			exactCanonicalRoundChangeBytes: prepared.exactCanonicalPreimageBytes,
			signature: await modules.keychain.signSealRegisteredDigest({
				request: prepared.signingRequest,
				signer: opened.signer,
			}),
		});
	};

	const proposalBundle = async (
		round: number
	): Promise<Parameters<SealPacemakerHandle["observeProposalBundle"]>[0]> => {
		const leaderId = modules.pacemaker.leaderForRound(
			material.signers.map(({ signerId }) => signerId),
			round
		);
		const leaderIndex = material.signers.findIndex(({ signerId }) => signerId === leaderId);
		const vote = await signedVote(leaderIndex, "prepare", round);
		return Object.freeze({
			exactCanonicalCutValueBytes,
			exactCanonicalLeaderVotePreimageBytes: vote.exactCanonicalPreimageBytes,
			exactCanonicalProposalBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-seal-proposal",
				objectId: material.anchor.objectId,
				round,
				valueDigest: vote.valueDigest,
			}),
			leaderVoteSignature: vote.signature,
			...(round === 0
				? {}
				: {
						newRoundCertificate: await Promise.all(
							Array.from({ length: n === 7 ? 5 : n - 1 }, (_, index) => roundChange(index, round))
						),
					}),
		});
	};

	const open = async (): Promise<void> => {
		const installed = installCertifiedAnchorTrustRoot(
			installInput(material) as unknown as Parameters<typeof installCertifiedAnchorTrustRoot>[0]
		);
		if (!installed.ok) throw new Error("certified trust install failed");
		trust = installed.trust;
		const local = await openAuthority(0);
		browser = await modules.browser.openBrowserSealVoteStore({ databaseName });
		const created = await modules.seal.createSealVoter({
			authority: local.authority,
			expectedStorageIncarnation: browser.observation.incarnation,
			signer: local.signer,
			store: browser.store,
		});
		if (!created.ok) throw new Error(created.reason);
		const opened = await modules.pacemaker.createSealPacemaker({
			authority: local.authority,
			metrics: { traceFunc: (_name, operation) => operation },
			store: browser.store,
			voter: created.voter,
		});
		if (!opened.ok) throw new Error(opened.reason);
		pacemaker = opened.pacemaker;
	};

	await open();
	let roundChangeSigner = 1;
	const modelStatus = (status: PacemakerStatus): PacemakerStatus =>
		Object.freeze({
			...status,
			finalizedValueDigest: status.finalizedValueDigest === exactValueDigest ? "value-X" : status.finalizedValueDigest,
			lockedValueDigest: status.lockedValueDigest === exactValueDigest ? "value-X" : status.lockedValueDigest,
		});
	return Object.freeze({
		async apply(step: ItfTraceState): Promise<PacemakerStatus> {
			if (
				step.lastEvent === "init" ||
				step.lastEvent === "prepare-vote" ||
				step.lastEvent === "commit-vote" ||
				step.lastEvent === "round-change" ||
				step.lastEvent === "finalized"
			) {
				return modelStatus(pacemaker.status());
			}
			switch (step.lastEvent) {
				case "proposal":
					await pacemaker.observeProposalBundle(await proposalBundle(step.round));
					break;
				case "prepare-qc":
					await pacemaker.observePrepareQc(await exactQc("prepare", step.round));
					break;
				case "commit-qc":
					await pacemaker.observeCommitQc(await exactQc("commit", step.round));
					break;
				case "timeout":
					await new Promise((resolvePromise) =>
						setTimeout(resolvePromise, modules.pacemaker.roundTimeoutMs(step.round - 1) + 100)
					);
					break;
				case "one-round-change":
				case "f-plus-one-catchup":
				case "far-future-one":
					await pacemaker.observeRoundChange(
						await roundChange(
							roundChangeSigner++ % n,
							step.lastEvent === "far-future-one" ? 10 : step.round + (step.lastEvent === "one-round-change" ? 1 : 0)
						)
					);
					break;
				case "far-future-qc":
					await pacemaker.observePrepareQc(await exactQc("prepare", step.round));
					break;
				case "crash":
					await browser?.close();
					break;
				case "restart":
					await open();
					break;
				default:
					throw new Error(`TRACE_EVENT_UNSUPPORTED:${step.lastEvent}`);
			}
			return modelStatus(pacemaker.status());
		},
		async close(): Promise<void> {
			await pacemaker.stop();
			await browser?.close();
		},
	});
}
