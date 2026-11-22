import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import grammarContract from "./fixtures/phase-n1prime-b2a/canonical-grammar-contract.json" with { type: "json" };
import contract from "./fixtures/phase-n1prime-d/regenerated-reference-contract.json" with { type: "json" };
import vectors from "../packages/protocol-v3/conformance/vectors/registry-v1.json" with { type: "json" };
import registry from "../packages/protocol-v3/registry/registry-v1.json" with { type: "json" };

const root = fileURLToPath(new URL("..", import.meta.url));
const originalPath = resolve(root, contract.acceptedInputs.originalReference.path);
const grammarCategories = new Set(grammarContract.decodeNegativeCorpus.map(({ category }) => category));
const malformedDecodeCases = grammarContract.decodeNegativeCorpus.filter(({ limits }) => limits === undefined);
const operations = contract.neutralProtocol.operations;
const challengePrefix = "phase-n1prime-d-semantic-challenge:";
// Each body drives a bounded six-operation differential through many isolated Node processes.
const processDifferentialTimeoutMs = 30_000;
const precedenceCaseIds: Record<string, string> = {
	"varuint-non-minimal-before-post-terminator-value-range":
		"grammar-negative:varuint-non-minimal-beats-post-terminator-value-range",
	"integer-varuint-stage-before-decoded-integer-range":
		"grammar-precedence:integer-varuint-stage-before-decoded-integer-range",
	"float-negative-zero-before-safe-integral": "grammar-negative:scalar-negative-zero",
	"set-order-before-later-element-defect": "grammar-negative:set-order-before-later-unknown",
	"typed-truncation-before-observable-first-element-nonfinite":
		"grammar-negative:typed-truncated-before-complete-nan-element",
	"typed-element-order-before-category-order": "grammar-negative:typed-element-order-negative-zero-before-later-nan",
};

type JsonRecord = Record<string, unknown>;
type Request = { operation: string; cases: JsonRecord[] };
type Response = { results: JsonRecord[] };
type Peer = (request: Request) => Response;
type OperationContract = {
	caseFields: string[];
	inputOnlyExample?: JsonRecord;
	optionalCaseFields?: string[];
	cases?: JsonRecord[];
	requestFields?: string[];
	optionalRequestFields?: string[];
};

const operationContracts = contract.neutralProtocol.operationContracts as Record<string, OperationContract>;

interface ArtifactMetadata {
	author: {
		agentId: string;
		didNotAuthorOriginalReference: boolean;
		didNotAuthorRed: boolean;
		readOnlyNormativeTupleGrammarAndNeutralContract: boolean;
		readNoOriginalPredecessorOrTypescriptSource: boolean;
		readNoVectorOutputs: boolean;
		willNotAuthorTypescriptPort: boolean;
	};
	normativeInputs: typeof contract.acceptedInputs;
	originalExecution: {
		firstExecutedAt: string;
		sourceAndProvenanceFixedAt: string;
		sourceFixedBeforeOriginalExecution: boolean;
	};
	schemaVersion: string;
	source: { path: string; sha256: string };
}

function sha256(path: string): string {
	const result = spawnSync("shasum", ["-a", "256", resolve(root, path)], {
		encoding: "utf8",
		timeout: contract.runtime.peerInvocationMaxMs,
	});
	if (result.error !== undefined || result.status !== 0 || result.stderr !== "") {
		throw new Error(`sha256 process failed for ${path}: ${result.stderr.trim()}`);
	}
	const digest = result.stdout.split(/\s/u, 1)[0];
	if (!/^[0-9a-f]{64}$/u.test(digest ?? "")) throw new TypeError(`invalid sha256 output for ${path}`);
	return digest as string;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function flipHexByte(hex: string, byteIndex = 0): string {
	const offset = byteIndex * 2;
	const byte = Number.parseInt(hex.slice(offset, offset + 2), 16) ^ 1;
	return `${hex.slice(0, offset)}${byte.toString(16).padStart(2, "0")}${hex.slice(offset + 2)}`;
}

function invokeOpaque(sourcePath: string, request: Request): Response {
	const result = spawnSync(process.execPath, [sourcePath], {
		cwd: root,
		encoding: "utf8",
		input: `${JSON.stringify(request)}\n`,
		timeout: contract.runtime.peerInvocationMaxMs,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`peer process failed: ${result.stderr.trim()}`);
	if (result.stderr !== "") throw new Error(`peer wrote stderr: ${result.stderr.trim()}`);
	const parsed = JSON.parse(result.stdout) as Response;
	if (!Array.isArray(parsed.results)) throw new TypeError("peer response must contain results[]");
	return parsed;
}

function invokeOpaqueWithDecodeAdapter(sourcePath: string, request: Request): Response {
	if (request.operation !== "decode-corpus") return invokeOpaque(sourcePath, request);
	const results: JsonRecord[] = [];
	for (const decodeCase of request.cases) {
		const result = spawnSync(process.execPath, [sourcePath], {
			cwd: root,
			encoding: "utf8",
			input: `${JSON.stringify({ operation: request.operation, cases: [decodeCase] })}\n`,
			timeout: contract.runtime.peerInvocationMaxMs,
		});
		if (result.error !== undefined) throw result.error;
		if (result.status === 0) {
			const parsed = JSON.parse(result.stdout) as Response;
			if (result.stderr !== "" || parsed.results.length !== 1) throw new TypeError("invalid decode success response");
			results.push(parsed.results[0] ?? {});
			continue;
		}
		const category = [...grammarCategories].find((candidate) =>
			new RegExp(`(?:CanonicalError: |\\b)${candidate}(?:\\b|$)`, "u").test(result.stderr)
		);
		if (category === undefined) throw new Error(`non-grammar decode process failure: ${result.stderr.trim()}`);
		results.push({ id: decodeCase.id, errorCategory: category });
	}
	return { results };
}

function transportCase(operation: string, candidate: JsonRecord): JsonRecord {
	const operationContract = operationContracts[operation];
	if (operationContract === undefined) throw new TypeError(`missing neutral transport for ${operation}`);
	const allowed = new Set([...operationContract.caseFields, ...(operationContract.optionalCaseFields ?? [])]);
	const projected = Object.fromEntries(
		Object.entries(candidate).filter(([field, value]) => allowed.has(field) && value !== undefined)
	);
	for (const required of operationContract.caseFields) {
		if (!(required in projected)) throw new TypeError(`${operation} case is missing ${required}`);
	}
	return projected;
}

function buildRequests(): Request[] {
	const exactReceived = vectors.receivedCases[0];
	if (exactReceived === undefined) throw new TypeError("missing exact-received case");
	const semanticBase = vectors.vectors.find(({ kind }) => kind === "signerSet");
	if (semanticBase === undefined) throw new TypeError("missing signer-set semantic probe base");
	const semanticInput = clone(semanticBase.input) as {
		signers: Array<{ publicKey: string; signerId: string }>;
	};
	semanticInput.signers[0] = {
		...semanticInput.signers[0],
		signerId: "phase-n1prime-d-semantic-probe",
	};
	const flippedByte = {
		...exactReceived,
		id: "received-vertex-flipped-byte",
		receivedHex: flipHexByte(exactReceived.receivedHex, 1),
	};
	const flippedSignature = {
		...exactReceived,
		id: "received-vertex-flipped-signature",
		signatureHex: flipHexByte(exactReceived.signatureHex),
	};
	const decodeCases = [
		...vectors.vectors.map(({ canonicalHex, id }) => ({
			canonicalHex,
			id: `vector:${id}`,
		})),
		...grammarContract.positiveCorpus.map(({ hex, id }) => ({
			canonicalHex: hex,
			id: `grammar-positive:${id}`,
		})),
		...malformedDecodeCases.map(({ category, hex, id }) => ({
			canonicalHex: hex,
			expectedErrorCategory: category,
			id: `grammar-negative:${id}`,
		})),
		{
			canonicalHex: "03ffffffffffffffff00",
			expectedErrorCategory: "VARUINT_NON_MINIMAL",
			id: "grammar-precedence:integer-varuint-stage-before-decoded-integer-range",
		},
	];
	return [
		{
			operation: "encode-corpus",
			cases: [
				...vectors.vectors.map(({ id, input, kind }) => transportCase("encode-corpus", { id, input, kind })),
				transportCase("encode-corpus", {
					id: "semantic-probe-not-in-vector-output-table",
					input: semanticInput,
					kind: semanticBase.kind,
				}),
			],
		},
		{
			operation: "decode-corpus",
			cases: decodeCases.map((decodeCase) => transportCase("decode-corpus", decodeCase)),
		},
		{
			operation: "validate-cases",
			cases: (operationContracts["validate-cases"]?.cases ?? []).map((validationCase) =>
				transportCase("validate-cases", validationCase)
			),
		},
		{
			operation: "issue-next",
			cases: vectors.issuanceCases.map(({ id, request }) => transportCase("issue-next", { id, request })),
		},
		{
			operation: "digest-received",
			cases: [exactReceived, flippedByte].map(({ domain, id, receivedHex, reencodedHex }) =>
				transportCase("digest-received", { domain, id, receivedHex, reencodedHex })
			),
		},
		{
			operation: "verify-received",
			cases: [exactReceived, flippedByte, flippedSignature].map(
				({ domain, id, publicKeyHex, receivedHex, signatureHex }) =>
					transportCase("verify-received", {
						domain,
						id,
						publicKeyHex,
						receivedHex,
						signatureHex,
					})
			),
		},
	];
}

function challenge(request: Request): Request {
	return {
		...clone(request),
		cases: request.cases.map((item) => ({ ...item, id: `${challengePrefix}${String(item.id)}` })),
	};
}

function unchallengeId(value: unknown): unknown {
	return typeof value === "string" && value.startsWith(challengePrefix) ? value.slice(challengePrefix.length) : value;
}

function bodyKey(operation: string, item: JsonRecord): string {
	const copy = clone(item);
	delete copy.id;
	return JSON.stringify([operation, copy]);
}

function semanticSimulatedPeer(transcript: Map<string, JsonRecord>): Peer {
	return (request) => ({
		results: request.cases.map((item) => {
			const result = transcript.get(bodyKey(request.operation, item));
			if (result === undefined) throw new Error(`unsupported semantic case for ${request.operation}`);
			return { ...clone(result), id: item.id };
		}),
	});
}

function staticExpectedOutputPeer(responses: Map<string, Response>): Peer {
	return (request) => {
		const response = responses.get(request.operation);
		if (response === undefined) throw new Error("one-operation/static table miss");
		return clone(response);
	};
}

function buildTranscript(requests: Request[], responses: Response[]): Map<string, JsonRecord> {
	const transcript = new Map<string, JsonRecord>();
	for (const [requestIndex, request] of requests.entries()) {
		const response = responses[requestIndex];
		if (response === undefined || response.results.length !== request.cases.length) {
			throw new TypeError(`incoherent response cardinality for ${request.operation}`);
		}
		for (const [caseIndex, item] of request.cases.entries()) {
			const result = response.results[caseIndex];
			if (result === undefined || unchallengeId(result.id) !== item.id) {
				throw new TypeError(`incoherent response id/order for ${request.operation}`);
			}
			transcript.set(bodyKey(request.operation, item), { ...clone(result), id: item.id });
		}
	}
	return transcript;
}

function comparePeers(left: Peer, right: Peer, requests: Request[]): void {
	const started = Date.now();
	expect(requests.map(({ operation }) => operation)).toEqual(operations);
	for (const baseRequest of requests) {
		const request = challenge(baseRequest);
		const leftResponse = left(request);
		const rightResponse = right(request);
		expect(rightResponse, baseRequest.operation).toEqual(leftResponse);
		expect(rightResponse.results).toHaveLength(request.cases.length);
		expect(rightResponse.results.map(({ id }) => id)).toEqual(request.cases.map(({ id }) => id));
	}
	expect(Date.now() - started).toBeLessThan(contract.runtime.totalComparatorMaxMs);
}

function mutateTranscript(
	transcript: Map<string, JsonRecord>,
	operation: string,
	predicate: (value: JsonRecord) => boolean,
	mutate: (value: JsonRecord) => void
): Map<string, JsonRecord> {
	const changed = new Map([...transcript].map(([key, value]) => [key, clone(value)]));
	const entry = [...changed.entries()].find(([key, value]) => JSON.parse(key)[0] === operation && predicate(value));
	if (entry === undefined) throw new TypeError(`missing mutation target for ${operation}`);
	mutate(entry[1]);
	return changed;
}

function coherentMetadata(sourceHash = "a".repeat(64)): ArtifactMetadata {
	return {
		author: {
			agentId: "future-distinct-phase-n1prime-d-green-agent",
			didNotAuthorOriginalReference: true,
			didNotAuthorRed: true,
			readOnlyNormativeTupleGrammarAndNeutralContract: true,
			readNoOriginalPredecessorOrTypescriptSource: true,
			readNoVectorOutputs: true,
			willNotAuthorTypescriptPort: true,
		},
		normativeInputs: clone(contract.acceptedInputs),
		originalExecution: {
			firstExecutedAt: "2026-07-28T06:00:01.000Z",
			sourceAndProvenanceFixedAt: "2026-07-28T06:00:00.000Z",
			sourceFixedBeforeOriginalExecution: true,
		},
		schemaVersion: "protocol-v3-regenerated-reference-provenance-v1",
		source: { path: contract.targets.source, sha256: sourceHash },
	};
}

function metadataErrors(metadata: ArtifactMetadata, sourceHash: string): string[] {
	const errors: string[] = [];
	if (JSON.stringify(metadata.normativeInputs) !== JSON.stringify(contract.acceptedInputs)) {
		errors.push("metadata normative hashes mismatch");
	}
	if (metadata.source.path !== contract.targets.source || metadata.source.sha256 !== sourceHash) {
		errors.push("metadata source hash mismatch");
	}
	if (
		!metadata.author.didNotAuthorOriginalReference ||
		!metadata.author.didNotAuthorRed ||
		!metadata.author.readOnlyNormativeTupleGrammarAndNeutralContract ||
		!metadata.author.readNoOriginalPredecessorOrTypescriptSource ||
		!metadata.author.readNoVectorOutputs ||
		!metadata.author.willNotAuthorTypescriptPort
	) {
		errors.push("metadata role firewall mismatch");
	}
	const fixedAt = Date.parse(metadata.originalExecution.sourceAndProvenanceFixedAt);
	const executedAt = Date.parse(metadata.originalExecution.firstExecutedAt);
	if (
		!metadata.originalExecution.sourceFixedBeforeOriginalExecution ||
		!Number.isFinite(fixedAt) ||
		!Number.isFinite(executedAt) ||
		fixedAt >= executedAt
	) {
		errors.push("metadata role chronology mismatch");
	}
	return errors;
}

function corpusErrors(requests: Request[], responses: Response[]): string[] {
	const errors: string[] = [];
	const byOperation = new Map(requests.map((request) => [request.operation, request]));
	const responseByOperation = new Map(
		requests.map((request, index) => [request.operation, responses[index] as Response])
	);
	const encode = byOperation.get("encode-corpus")?.cases ?? [];
	const decode = byOperation.get("decode-corpus")?.cases ?? [];
	const validate = byOperation.get("validate-cases")?.cases ?? [];
	const issue = byOperation.get("issue-next")?.cases ?? [];
	const verify = responseByOperation.get("verify-received")?.results ?? [];
	if (
		encode.length !== 28 ||
		!vectors.vectors.every(({ id }) => encode.some((item) => item.id === id)) ||
		!encode.some(({ id }) => id === "semantic-probe-not-in-vector-output-table") ||
		new Set(vectors.vectors.map(({ kind }) => kind)).size !== 19
	) {
		errors.push("encode registry coverage mismatch");
	}
	const encodeResults = responseByOperation.get("encode-corpus")?.results ?? [];
	for (const vector of vectors.vectors) {
		const actual = encodeResults.find(({ id }) => id === vector.id);
		if (
			actual?.canonicalHex !== vector.canonicalHex ||
			actual.digestHex !== vector.digestHex ||
			stableJson(actual.partsHex) !== stableJson(vector.partsHex) ||
			stableJson(actual.normalized) !== stableJson(vector.normalized)
		) {
			errors.push(`encode vector mismatch: ${vector.id}`);
		}
	}
	for (const [kind, definition] of Object.entries(registry.kinds)) {
		for (const field of definition.fields.filter(({ type }) => type === "enum")) {
			const observed = new Set(
				vectors.vectors
					.filter((vector) => vector.kind === kind)
					.map((vector) => (vector.normalized as JsonRecord)[field.name])
			);
			for (const active of field.constraints.values) {
				if (!observed.has(active)) errors.push(`active enum uncovered: ${kind}.${field.name}=${String(active)}`);
			}
		}
	}
	if (
		decode.length !==
			vectors.vectors.length + grammarContract.positiveCorpus.length + malformedDecodeCases.length + 1 ||
		decode.some(({ id }) => id === "unsafe-integral-scalar-float64-decode")
	) {
		errors.push("decode governed corpus mismatch");
	}
	const decodeResults = responseByOperation.get("decode-corpus")?.results ?? [];
	const negativeResults = decodeResults.filter(({ id }) => String(id).includes("grammar-negative:"));
	const decodeValueMismatch = vectors.vectors.find(({ id, normalized }) => {
		const actual = decodeResults.find(({ id: resultId }) => resultId === `vector:${id}`);
		return stableJson(actual?.value) !== stableJson(normalized);
	});
	const decodeCategoryMismatch = malformedDecodeCases.find(({ category, id }) => {
		const actual = decodeResults.find(({ id: resultId }) => resultId === `grammar-negative:${id}`);
		return actual?.errorCategory !== category;
	});
	const decodePrecedenceMismatch = grammarContract.precedenceProbes.find(({ expectedCategory, id }) => {
		const concreteId = precedenceCaseIds[id];
		return (
			concreteId === undefined ||
			decodeResults.find(({ id: resultId }) => resultId === concreteId)?.errorCategory !== expectedCategory
		);
	});
	if (
		decodeValueMismatch !== undefined ||
		decodeCategoryMismatch !== undefined ||
		negativeResults.length !== malformedDecodeCases.length ||
		decodePrecedenceMismatch !== undefined
	) {
		errors.push(
			`decode category/precedence coverage mismatch:${decodeValueMismatch?.id ?? ""}:${decodeCategoryMismatch?.id ?? ""}:${decodePrecedenceMismatch?.id ?? ""}`
		);
	}
	const validateResults = responseByOperation.get("validate-cases")?.results ?? [];
	const issueResults = responseByOperation.get("issue-next")?.results ?? [];
	if (
		validate.length !== 9 ||
		!vectors.negativeCases.every(({ category, id }) => {
			const actual = validateResults.find(({ id: resultId }) => resultId === id);
			return actual?.accepted === false && actual.reason === category;
		}) ||
		issue.length !== 5 ||
		!vectors.issuanceCases.every(({ expected, id }) => {
			const actual = issueResults.find(({ id: resultId }) => resultId === id);
			return stableJson(actual) === stableJson({ id, ...expected });
		})
	) {
		errors.push("validation/issuance governed result mismatch");
	}
	const digestResults = responseByOperation.get("digest-received")?.results ?? [];
	const exactDigest = digestResults.find(({ id }) => id === "received-vertex-exact-preimage");
	if (
		exactDigest?.receivedDigestHex !== vectors.receivedCases[0]?.expected.digestHex ||
		exactDigest.reencodedDigestHex === exactDigest.receivedDigestHex
	) {
		errors.push("exact-received digest/framing mismatch");
	}
	const exact = verify.find(({ id }) => id === "received-vertex-exact-preimage");
	const byteFlip = verify.find(({ id }) => id === "received-vertex-flipped-byte");
	const signatureFlip = verify.find(({ id }) => id === "received-vertex-flipped-signature");
	if (exact?.accepted !== true || byteFlip?.accepted !== false || signatureFlip?.accepted !== false) {
		errors.push("exact-received/flipped rejection coverage mismatch");
	}
	return errors;
}

function missingTargetsAt(base: string): string[] {
	return Object.entries(contract.targets)
		.filter(([, path]) => !existsSync(resolve(base, path)))
		.map(([name, path]) => `${name}:${path}`);
}

describe("Phase -1'd regenerated v3 reference artifact RED", () => {
	it(
		"proves the neutral comparator is satisfiable and kills semantic, framing, state, metadata and chronology mutants",
		() => {
			expect(contract.schemaVersion).toBe("phase-n1prime-d-regenerated-reference-red-v2");
			expect(contract.redAuthorAttestation).toMatchObject({
				readNoOriginalReferenceImplementationSource: true,
				readNoPredecessorOrTypescriptImplementationSource: true,
				originalReferenceExecutionWasOpaqueCliOnly: true,
				willNotAuthorRegeneratedReference: true,
				willNotAuthorTypescriptPort: true,
			});
			expect(contract.futureGreenAuthorRestriction).toMatchObject({
				mustBeDifferentAgent: true,
				postComparisonCorrection:
					"requires a logged source/provenance re-freeze before any new comparison; silent tuning is forbidden",
			});
			expect(contract.explicitNonclaims).toHaveLength(3);
			expect(Object.keys(operationContracts)).toEqual(operations);
			for (const operation of operations) {
				const operationContract = operationContracts[operation];
				expect(operationContract, operation).toBeDefined();
				expect(operationContract?.caseFields, operation).toContain("id");
				if (operationContract?.inputOnlyExample !== undefined) {
					expect(() => transportCase(operation, operationContract.inputOnlyExample ?? {})).not.toThrow();
				}
			}
			expect(
				stableJson(operationContracts["validate-cases"]?.cases),
				"input-only validation transport must match the authoritative requests"
			).toBe(stableJson(vectors.negativeCases.map(({ id, request }) => ({ id, request }))));
			const issueTransport = operationContracts["issue-next"];
			for (const { request } of vectors.issuanceCases) {
				expect(issueTransport?.requestFields?.every((field) => field in request)).toBe(true);
				expect(
					Object.keys(request).every(
						(field) =>
							issueTransport?.requestFields?.includes(field) === true ||
							issueTransport?.optionalRequestFields?.includes(field) === true
					)
				).toBe(true);
			}
			const fixtureText = readFileSync(
				resolve(root, "tests/fixtures/phase-n1prime-d/regenerated-reference-contract.json"),
				"utf8"
			);
			const forbiddenOutputs = vectors.vectors.flatMap(({ canonicalHex, digestHex, partsHex }) => [
				canonicalHex,
				digestHex,
				...partsHex,
			]);
			forbiddenOutputs.push(
				...vectors.issuanceCases.flatMap(({ expected }) =>
					[expected.registeredDigestHex, expected.signatureHex].filter((value): value is string => value !== null)
				),
				...vectors.receivedCases.flatMap(({ expected, signatureHex }) => [expected.digestHex, signatureHex])
			);
			expect(
				forbiddenOutputs.filter((output) => output.length >= 64 && fixtureText.includes(output)),
				"neutral input fixture must not embed expected bytes, digests, parts or signatures"
			).toEqual([]);
			expect(
				vectors.negativeCases
					.map(({ category }) => category)
					.filter((category) => fixtureText.includes(JSON.stringify(category))),
				"neutral input fixture must not embed validation reasons"
			).toEqual([]);
			const scratchRoot = mkdtempSync(join(tmpdir(), "phase-n1prime-d-target-absent-"));
			try {
				expect(missingTargetsAt(scratchRoot)).toEqual([
					`source:${contract.targets.source}`,
					`provenance:${contract.targets.provenance}`,
				]);
			} finally {
				rmSync(scratchRoot, { force: true, recursive: true });
			}
			for (const input of Object.values(contract.acceptedInputs)) {
				expect(existsSync(resolve(root, input.path)), input.path).toBe(true);
				expect(sha256(input.path), input.path).toBe(input.sha256);
			}

			const requests = buildRequests();
			const opaqueResponses = requests.map((request) => invokeOpaqueWithDecodeAdapter(originalPath, request));
			expect(corpusErrors(requests, opaqueResponses)).toEqual([]);
			const transcript = buildTranscript(requests, opaqueResponses);
			const coherent = semanticSimulatedPeer(transcript);
			comparePeers(coherent, coherent, requests);
			expect(metadataErrors(coherentMetadata(), "a".repeat(64))).toEqual([]);

			const controls: Array<[string, Map<string, JsonRecord>]> = [
				[
					"canonical bytes",
					mutateTranscript(
						transcript,
						"encode-corpus",
						(value) => "canonicalHex" in value,
						(value) => {
							value.canonicalHex = flipHexByte(String(value.canonicalHex));
						}
					),
				],
				[
					"digest/framing",
					mutateTranscript(
						transcript,
						"encode-corpus",
						(value) => "digestHex" in value,
						(value) => {
							value.digestHex = flipHexByte(String(value.digestHex));
						}
					),
				],
				[
					"decode value",
					mutateTranscript(
						transcript,
						"decode-corpus",
						(value) => "value" in value,
						(value) => {
							value.value = { mutant: true };
						}
					),
				],
				[
					"decode error/precedence",
					mutateTranscript(
						transcript,
						"decode-corpus",
						(value) => "errorCategory" in value,
						(value) => {
							value.errorCategory = "UNKNOWN_TAG";
						}
					),
				],
				[
					"validation reason",
					mutateTranscript(
						transcript,
						"validate-cases",
						() => true,
						(value) => {
							value.reason = "mutant-reason";
						}
					),
				],
				[
					"issuance state",
					mutateTranscript(
						transcript,
						"issue-next",
						(value) => value.accepted === true,
						(value) => {
							value.after = { mutant: true };
						}
					),
				],
				[
					"issuance instrumentation/signature",
					mutateTranscript(
						transcript,
						"issue-next",
						(value) => value.accepted === true,
						(value) => {
							value.instrumentation = { digestCalls: 0, publicationCalls: 0, signCalls: 0 };
							value.signatureHex = null;
						}
					),
				],
				[
					"exact-received digest",
					mutateTranscript(
						transcript,
						"digest-received",
						() => true,
						(value) => {
							value.receivedDigestHex = flipHexByte(String(value.receivedDigestHex));
						}
					),
				],
				[
					"signature verification",
					mutateTranscript(
						transcript,
						"verify-received",
						(value) => value.accepted === true,
						(value) => {
							value.accepted = false;
						}
					),
				],
			];
			for (const [label, mutant] of controls) {
				expect(() => comparePeers(coherent, semanticSimulatedPeer(mutant), requests), label).toThrow();
			}

			const staticResponses = new Map(
				requests.map((request, index) => [request.operation, opaqueResponses[index] as Response])
			);
			expect(() => comparePeers(coherent, staticExpectedOutputPeer(staticResponses), requests)).toThrow();
			expect(() =>
				comparePeers(
					coherent,
					staticExpectedOutputPeer(new Map([["encode-corpus", opaqueResponses[0] as Response]])),
					requests
				)
			).toThrow();

			const staleMetadata = coherentMetadata("b".repeat(64));
			staleMetadata.normativeInputs.registry.sha256 = "c".repeat(64);
			expect(metadataErrors(staleMetadata, "a".repeat(64))).toEqual(
				expect.arrayContaining(["metadata normative hashes mismatch", "metadata source hash mismatch"])
			);
			const wrongRole = coherentMetadata();
			wrongRole.author.readNoVectorOutputs = false;
			expect(metadataErrors(wrongRole, "a".repeat(64))).toContain("metadata role firewall mismatch");
			const wrongChronology = coherentMetadata();
			wrongChronology.originalExecution.firstExecutedAt = wrongChronology.originalExecution.sourceAndProvenanceFixedAt;
			expect(metadataErrors(wrongChronology, "a".repeat(64))).toContain("metadata role chronology mismatch");
		},
		processDifferentialTimeoutMs
	);

	it(
		"fails narrowly until the regenerated source and provenance are fixed",
		() => {
			const requests = buildRequests();
			const originalResponses = requests.map((request) => invokeOpaqueWithDecodeAdapter(originalPath, request));
			expect(corpusErrors(requests, originalResponses)).toEqual([]);
			expect(metadataErrors(coherentMetadata(), "a".repeat(64))).toEqual([]);
			const missingTargets = missingTargetsAt(root);
			expect(missingTargets, "Phase -1'd RED: regenerated source + provenance are required").toEqual([]);
			const regeneratedSourceHash = sha256(contract.targets.source);
			const regeneratedProvenance = JSON.parse(
				readFileSync(resolve(root, contract.targets.provenance), "utf8")
			) as ArtifactMetadata;
			expect(metadataErrors(regeneratedProvenance, regeneratedSourceHash)).toEqual([]);
			const originalPeer: Peer = (request) => invokeOpaqueWithDecodeAdapter(originalPath, request);
			const regeneratedPeer: Peer = (request) =>
				invokeOpaqueWithDecodeAdapter(resolve(root, contract.targets.source), request);
			comparePeers(originalPeer, regeneratedPeer, requests);
		},
		processDifferentialTimeoutMs
	);
});
