import { ed25519 } from "@noble/curves/ed25519.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import contractDocument from "./fixtures/phase-n1prime-c-exhaustion/paired-issuance-contract.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface ArtifactPin {
	path: string;
	sha256: string;
}

interface MutableArtifactTarget {
	historicalPreGreenSha256: string;
	path: string;
}

interface IssueState {
	anchor: string;
	epoch: number;
	exhausted: boolean;
	lastIssued: number;
}

interface IssueCandidate {
	anchor: string;
	author: string;
	authorSequence: number;
	dependencies: string[];
	epoch: number;
	kind: string;
	logicalTime: number;
	objectId: string;
	operation: Record<string, unknown>;
	protocolMajor: number;
}

interface IssueRequest {
	before: IssueState;
	candidate: IssueCandidate;
	privateKeyHex?: string;
	publicKeyHex?: string;
}

interface Instrumentation {
	digestCalls: number;
	publicationCalls: number;
	signCalls: number;
}

interface IssueResult {
	accepted: boolean;
	after: IssueState;
	instrumentation: Instrumentation;
	published: boolean;
	registeredDigestHex: string | null;
	signatureHex: string | null;
}

interface IssueCase {
	expected: IssueResult;
	id: string;
	request: IssueRequest;
}

interface VectorDocument {
	issuanceCases: IssueCase[];
}

interface Contract {
	immutableArtifacts: Record<string, ArtifactPin>;
	mutableTargets: {
		vectorDocument: MutableArtifactTarget;
	};
	pair: {
		exhaustedId: string;
		maximumPermittedLastIssued: number;
		request: IssueRequest;
		successId: string;
	};
	redAuthorAttestation: {
		agentId: string;
		authoredCorrectedC2: boolean;
		authoredFirstVectorMint: boolean;
		authoredOriginalReference: boolean;
		expectedBytesSource: string;
		willMintReplacementVectors: boolean;
	};
	referenceProtocol: {
		expectedInvocationCount: number;
		operation: string;
		timeoutMs: number;
	};
	schemaVersion: string;
}

interface ReferenceOracle {
	invocationCount: number;
	invocationToken?: symbol;
	results: Array<{ id: string } & IssueResult>;
}

const contract = contractDocument as Contract;
const fixedReferenceInvocationToken = Symbol("fixed-reference-invocation");
const resultKeys = ["accepted", "after", "instrumentation", "published", "registeredDigestHex", "signatureHex"].sort();

function clone<T>(value: T): T {
	return structuredClone(value);
}

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(join(repositoryRoot, path)))
		.digest("hex");
}

function exhaustedRequest(successRequest: IssueRequest): IssueRequest {
	const exhausted = clone(successRequest);
	exhausted.before.exhausted = true;
	return exhausted;
}

function expectedAfterSuccess(request: IssueRequest): IssueState {
	return {
		...request.before,
		exhausted: false,
		lastIssued: request.before.lastIssued + 1,
	};
}

function isHex(value: string | null, octets: number): value is string {
	return value !== null && new RegExp(`^[0-9a-f]{${octets * 2}}$`, "u").test(value);
}

function pairErrors(successRequest: IssueRequest, rejectedRequest: IssueRequest, oracle: ReferenceOracle): string[] {
	const errors: string[] = [];
	const normalizedRejected = clone(rejectedRequest);
	normalizedRejected.before.exhausted = successRequest.before.exhausted;
	if (!isDeepStrictEqual(normalizedRejected, successRequest)) {
		errors.push("paired requests differ beyond before.exhausted");
	}
	if (successRequest.before.exhausted !== false || rejectedRequest.before.exhausted !== true) {
		errors.push("pair must flip exhausted false to true");
	}
	const lastIssued = successRequest.before.lastIssued;
	if (
		!Number.isSafeInteger(lastIssued) ||
		lastIssued <= 0 ||
		lastIssued > contract.pair.maximumPermittedLastIssued ||
		successRequest.candidate.authorSequence !== lastIssued + 1
	) {
		errors.push("pair must use a valid non-boundary next sequence");
	}
	if (
		successRequest.candidate.anchor !== successRequest.before.anchor ||
		successRequest.candidate.epoch !== successRequest.before.epoch
	) {
		errors.push("candidate epoch and anchor must match issuance state");
	}
	const privateKeyHex = successRequest.privateKeyHex;
	const publicKeyHex = successRequest.publicKeyHex;
	if (
		!isHex(privateKeyHex ?? null, 32) ||
		!isHex(publicKeyHex ?? null, 32) ||
		Buffer.from(ed25519.getPublicKey(Buffer.from(privateKeyHex ?? "", "hex"))).toString("hex") !== publicKeyHex
	) {
		errors.push("matching Ed25519 private/public keypair required");
	}
	if (
		oracle.invocationCount !== contract.referenceProtocol.expectedInvocationCount ||
		oracle.invocationToken !== fixedReferenceInvocationToken
	) {
		errors.push("expected results must come from exactly one fixed-reference invocation");
	}
	const success = oracle.results.find(({ id }) => id === contract.pair.successId);
	const rejection = oracle.results.find(({ id }) => id === contract.pair.exhaustedId);
	if (success === undefined || rejection === undefined) {
		errors.push("fixed reference must return both paired results");
		return errors;
	}
	if (
		success.accepted !== true ||
		!isDeepStrictEqual(success.after, expectedAfterSuccess(successRequest)) ||
		!isDeepStrictEqual(success.instrumentation, { digestCalls: 1, publicationCalls: 1, signCalls: 1 }) ||
		success.published !== true ||
		!isHex(success.registeredDigestHex, 32) ||
		!isHex(success.signatureHex, 64) ||
		!isDeepStrictEqual(
			Object.keys(success)
				.filter((key) => key !== "id")
				.sort(),
			resultKeys
		)
	) {
		errors.push("non-exhausted control must succeed with exact state, payload and 1/1/1 calls");
	} else if (
		!ed25519.verify(
			Buffer.from(success.signatureHex, "hex"),
			Buffer.from(success.registeredDigestHex, "hex"),
			Buffer.from(publicKeyHex as string, "hex"),
			{ zip215: false }
		)
	) {
		errors.push("non-exhausted control signature must verify with the paired public key");
	}
	if (
		rejection.accepted !== false ||
		!isDeepStrictEqual(rejection.after, rejectedRequest.before) ||
		!isDeepStrictEqual(rejection.instrumentation, { digestCalls: 0, publicationCalls: 0, signCalls: 0 }) ||
		rejection.published !== false ||
		rejection.registeredDigestHex !== null ||
		rejection.signatureHex !== null ||
		!isDeepStrictEqual(
			Object.keys(rejection)
				.filter((key) => key !== "id")
				.sort(),
			resultKeys
		)
	) {
		errors.push("exhausted probe must reject unchanged with no payload and 0/0/0 calls");
	}
	return errors;
}

function runFixedReference(successRequest: IssueRequest, rejectedRequest: IssueRequest): ReferenceOracle {
	const reference = contract.immutableArtifacts.originalReference;
	if (sha256(reference.path) !== reference.sha256) {
		throw new Error("fixed reference hash drift");
	}
	const directory = mkdtempSync(join(tmpdir(), "protocol-v3-exhaustion-red-"));
	const isolatedSource = join(directory, "reference.mjs");
	try {
		writeFileSync(isolatedSource, readFileSync(join(repositoryRoot, reference.path)));
		const result = spawnSync(process.execPath, [isolatedSource], {
			cwd: directory,
			encoding: "utf8",
			input: `${JSON.stringify({
				cases: [
					{ id: contract.pair.successId, request: successRequest },
					{ id: contract.pair.exhaustedId, request: rejectedRequest },
				],
				operation: contract.referenceProtocol.operation,
			})}\n`,
			timeout: contract.referenceProtocol.timeoutMs,
		});
		expect(result.error, "fixed reference process error").toBeUndefined();
		expect(result.status, `fixed reference stderr: ${result.stderr}`).toBe(0);
		expect(result.stderr, "fixed reference stderr").toBe("");
		const parsed = JSON.parse(result.stdout) as { results: ReferenceOracle["results"] };
		return {
			invocationCount: 1,
			invocationToken: fixedReferenceInvocationToken,
			results: parsed.results,
		};
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function integrationError(vectorDocument: VectorDocument, oracle: ReferenceOracle): string | null {
	const successRequest = contract.pair.request;
	const rejectedRequest = exhaustedRequest(successRequest);
	const success = vectorDocument.issuanceCases.find(({ id }) => id === contract.pair.successId);
	const rejection = vectorDocument.issuanceCases.find(({ id }) => id === contract.pair.exhaustedId);
	if (success === undefined || rejection === undefined) {
		return "first vector mint lacks the isolated non-boundary exhausted false/true issuance pair";
	}
	const oracleSuccess = oracle.results.find(({ id }) => id === contract.pair.successId);
	const oracleRejection = oracle.results.find(({ id }) => id === contract.pair.exhaustedId);
	if (
		!isDeepStrictEqual(success.request, successRequest) ||
		!isDeepStrictEqual(rejection.request, rejectedRequest) ||
		!isDeepStrictEqual(success.expected, oracleSuccess && withoutId(oracleSuccess)) ||
		!isDeepStrictEqual(rejection.expected, oracleRejection && withoutId(oracleRejection))
	) {
		return "isolated pair must exactly match the RED-owned inputs and fixed-reference results";
	}
	return null;
}

function withoutId(result: { id: string } & IssueResult): IssueResult {
	return {
		accepted: result.accepted,
		after: result.after,
		instrumentation: result.instrumentation,
		published: result.published,
		registeredDigestHex: result.registeredDigestHex,
		signatureHex: result.signatureHex,
	};
}

function referenceDerivedVectorDocument(
	successRequest: IssueRequest,
	rejectedRequest: IssueRequest,
	oracle: ReferenceOracle
): VectorDocument {
	const success = oracle.results.find(({ id }) => id === contract.pair.successId);
	const rejection = oracle.results.find(({ id }) => id === contract.pair.exhaustedId);
	if (success === undefined || rejection === undefined) {
		throw new Error("fixed reference did not return the complete pair");
	}
	return {
		issuanceCases: [
			{
				expected: withoutId(success),
				id: success.id,
				request: clone(successRequest),
			},
			{
				expected: withoutId(rejection),
				id: rejection.id,
				request: clone(rejectedRequest),
			},
		],
	};
}

describe("Phase -1'c exhaustion hardening RED", () => {
	it("proves the paired controls and mutation strength against the already-fixed reference", () => {
		expect(contract.schemaVersion).toBe("phase-n1prime-c-exhaustion-paired-issuance-v1");
		expect(contract.redAuthorAttestation).toMatchObject({
			authoredCorrectedC2: false,
			authoredFirstVectorMint: false,
			authoredOriginalReference: false,
			willMintReplacementVectors: false,
		});
		expect(contract.redAuthorAttestation.agentId).not.toBe("");
		expect(contract.redAuthorAttestation.expectedBytesSource).toBe(
			"one invocation of the already-fixed original reference"
		);
		for (const artifact of Object.values(contract.immutableArtifacts)) {
			expect(sha256(artifact.path), artifact.path).toBe(artifact.sha256);
		}
		expect(contract.mutableTargets.vectorDocument).toEqual({
			historicalPreGreenSha256: "39b7c4e60fcb550c936be220660c8065b0bccc44ce1c288e0f685ced03b9dfa2",
			path: "packages/protocol-v3/conformance/vectors/registry-v1.json",
		});

		const successRequest = clone(contract.pair.request);
		const rejectedRequest = exhaustedRequest(successRequest);
		const oracle = runFixedReference(successRequest, rejectedRequest);
		expect(pairErrors(successRequest, rejectedRequest, oracle)).toEqual([]);
		const simulatedCorrectMint = referenceDerivedVectorDocument(successRequest, rejectedRequest, oracle);
		expect(integrationError(simulatedCorrectMint, oracle)).toBeNull();
		const wrongPair = clone(simulatedCorrectMint);
		const wrongRejection = wrongPair.issuanceCases.find(({ id }) => id === contract.pair.exhaustedId);
		if (wrongRejection === undefined) throw new Error("missing simulated exhausted pair");
		wrongRejection.request.candidate.logicalTime += 1;
		expect(integrationError(wrongPair, oracle)).toBe(
			"isolated pair must exactly match the RED-owned inputs and fixed-reference results"
		);

		const changedInput = clone(rejectedRequest);
		changedInput.candidate.epoch += 1;
		expect(pairErrors(successRequest, changedInput, oracle)).toContain(
			"paired requests differ beyond before.exhausted"
		);

		const missingKey = clone(successRequest);
		delete missingKey.privateKeyHex;
		expect(pairErrors(missingKey, exhaustedRequest(missingKey), oracle)).toContain(
			"matching Ed25519 private/public keypair required"
		);

		const mismatchedKey = clone(successRequest);
		mismatchedKey.publicKeyHex = "00".repeat(32);
		expect(pairErrors(mismatchedKey, exhaustedRequest(mismatchedKey), oracle)).toContain(
			"matching Ed25519 private/public keypair required"
		);

		const boundary = clone(successRequest);
		boundary.before.lastIssued = Number.MAX_SAFE_INTEGER - 1;
		boundary.candidate.authorSequence = Number.MAX_SAFE_INTEGER;
		expect(pairErrors(boundary, exhaustedRequest(boundary), oracle)).toContain(
			"pair must use a valid non-boundary next sequence"
		);

		const zeroCallPositive: ReferenceOracle = {
			...oracle,
			results: clone(oracle.results),
		};
		const positive = zeroCallPositive.results.find(({ id }) => id === contract.pair.successId);
		if (positive === undefined) throw new Error("missing positive control");
		positive.instrumentation = { digestCalls: 0, publicationCalls: 0, signCalls: 0 };
		expect(pairErrors(successRequest, rejectedRequest, zeroCallPositive)).toContain(
			"non-exhausted control must succeed with exact state, payload and 1/1/1 calls"
		);

		const handFilled: ReferenceOracle = {
			invocationCount: contract.referenceProtocol.expectedInvocationCount,
			results: clone(oracle.results),
		};
		expect(pairErrors(successRequest, rejectedRequest, handFilled)).toContain(
			"expected results must come from exactly one fixed-reference invocation"
		);
	});

	it("requires the first vector document to contain that exact reference-derived isolated pair", () => {
		const successRequest = clone(contract.pair.request);
		const rejectedRequest = exhaustedRequest(successRequest);
		const oracle = runFixedReference(successRequest, rejectedRequest);
		expect(pairErrors(successRequest, rejectedRequest, oracle)).toEqual([]);
		const vectorDocument = JSON.parse(
			readFileSync(join(repositoryRoot, contract.mutableTargets.vectorDocument.path), "utf8")
		) as VectorDocument;
		expect(integrationError(vectorDocument, oracle)).toBeNull();
	});
});
