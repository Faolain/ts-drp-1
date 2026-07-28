import { ed25519 } from "@noble/curves/ed25519.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import phaseDContract from "./fixtures/phase-n1prime-d/regenerated-reference-contract.json" with { type: "json" };
import grammarDocument from "../docs/protocol/canonical-tag-codec-v1.json" with { type: "json" };
import registryDocument from "../packages/protocol-v3/registry/registry-v1.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = resolve(repositoryRoot, "tests/fixtures/phase-n1prime-d2/blocker-remediation-inputs.json");

type JsonRecord = Record<string, unknown>;

interface ArtifactPin {
	path: string;
	sha256: string;
}

interface RemediationTarget {
	path: string;
	preRemediationSha256: string;
}

interface IssueState {
	anchor: string;
	epoch: number;
	exhausted: boolean;
	lastIssued: number;
}

interface IssueCandidate extends JsonRecord {
	anchor: string;
	authorSequence: number;
	epoch: number;
}

interface IssueRequest {
	before: IssueState;
	candidate: IssueCandidate;
	privateKeyHex?: string;
	publicKeyHex: string;
}

interface Fixture {
	grammarCases: {
		protoKey: { input: JsonRecord; kind: string };
		unpairedSurrogate: { input: JsonRecord; kind: string };
		uppercaseDecode: { value: string };
	};
	immutableArtifacts: Record<string, ArtifactPin>;
	issuance: {
		baseRequest: IssueRequest;
		mismatchedPublicKeyHex: string;
		wrongSequence: number;
	};
	normativeAdjudications: {
		candidateAuthorSequence: { retiresPhaseDNonclaim: string };
		directJsBoundary: { laterObligations: string[]; reason: string };
		uppercasePublicKeyHex: { owner: string; requirement: string };
	};
	redAuthorAttestation: Record<string, boolean | string>;
	remediationTargets: {
		regeneratedProvenance: RemediationTarget;
		regeneratedReference: RemediationTarget;
	};
	runtime: {
		focusedTestTimeoutMs: number;
		peerInvocationMaxMs: number;
	};
	schemaVersion: string;
	verification: {
		canonicalInput: JsonRecord;
		flipByteIndex: number;
		kind: string;
		nonCanonicalReceivedHex: string;
		privateKeyHex: string;
		publicKeyHex: string;
	};
}

interface Grammar {
	primitives: {
		varuint: {
			continuationMask: number;
			payloadMask: number;
		};
	};
	tags: Array<{ name: string; octet: number }>;
}

interface RegistryField {
	const: unknown;
	name: string;
	required: boolean;
	sortRule: string | null;
	type: string;
}

interface RegistryKind {
	domain: string;
	encoding: string;
	fields: RegistryField[];
}

interface Registry {
	domains: Record<string, string>;
	framing: {
		magicHex: string;
	};
	kinds: Record<string, RegistryKind>;
}

interface Probe {
	case: JsonRecord;
	expected: Outcome;
	id: string;
	operation: "decode-corpus" | "encode-corpus" | "issue-next" | "verify-received";
}

type Outcome = { kind: "rejected" } | { kind: "result"; value: JsonRecord };

const fixtureText = readFileSync(fixturePath, "utf8");
// JSON.parse preserves an own inert "__proto__" data key. Vite's generated JS
// object literal does not, so importing this fixture would destroy the case.
const contract = JSON.parse(fixtureText) as Fixture;
const grammar = grammarDocument as Grammar;
const registry = registryDocument as Registry;
const textEncoder = new TextEncoder();

function clone<T>(value: T): T {
	return structuredClone(value);
}

function bytes(...parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

function fromHex(value: string): Uint8Array {
	if (!/^(?:[0-9a-fA-F]{2})*$/u.test(value)) throw new TypeError("invalid hex input");
	return Uint8Array.from(Buffer.from(value, "hex"));
}

function tag(name: string): Uint8Array {
	const octet = grammar.tags.find((candidate) => candidate.name === name)?.octet;
	if (octet === undefined) throw new TypeError(`missing grammar tag ${name}`);
	return Uint8Array.of(octet);
}

function varuint(input: number): Uint8Array {
	if (!Number.isSafeInteger(input) || input < 0) throw new TypeError("invalid varuint input");
	const output: number[] = [];
	let value = input;
	do {
		let octet = value % 128;
		value = Math.floor(value / 128);
		if (value !== 0) octet |= grammar.primitives.varuint.continuationMask;
		output.push(octet & (grammar.primitives.varuint.payloadMask | grammar.primitives.varuint.continuationMask));
	} while (value !== 0);
	return Uint8Array.from(output);
}

function scalarUtf8(value: string): Uint8Array {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("UNPAIRED_SURROGATE");
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			throw new TypeError("UNPAIRED_SURROGATE");
		}
	}
	return textEncoder.encode(value);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const shared = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < shared; index += 1) {
		const difference = (left[index] as number) - (right[index] as number);
		if (difference !== 0) return difference;
	}
	return left.byteLength - right.byteLength;
}

function grammarEncode(value: unknown, active = new Set<object>()): Uint8Array {
	if (value === null) return tag("null");
	if (value === false) return tag("false");
	if (value === true) return tag("true");
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new TypeError("d2 independent encoder requires safe integers");
		const zigzag = value >= 0 ? value * 2 : -value * 2 - 1;
		return bytes(tag("integer"), varuint(zigzag));
	}
	if (typeof value === "string") {
		const payload = scalarUtf8(value);
		return bytes(tag("string"), varuint(payload.byteLength), payload);
	}
	if (typeof value !== "object") throw new TypeError("UNSUPPORTED_TYPE");
	if (active.has(value)) throw new TypeError("CYCLE");
	active.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new TypeError("SPARSE_ARRAY");
			}
			return bytes(tag("array"), varuint(value.length), ...value.map((item) => grammarEncode(item, active)));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError("NON_PLAIN_OBJECT");
		if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError("SYMBOL_KEY");
		const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
			.filter(([, descriptor]) => descriptor.enumerable)
			.map(([key, descriptor]) => {
				if (!Object.hasOwn(descriptor, "value")) throw new TypeError("ACCESSOR_PROPERTY");
				return {
					keyBytes: grammarEncode(key, active),
					valueBytes: grammarEncode(descriptor.value, active),
				};
			})
			.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
		return bytes(
			tag("object"),
			varuint(entries.length),
			...entries.flatMap(({ keyBytes, valueBytes }) => [keyBytes, valueBytes])
		);
	} finally {
		active.delete(value);
	}
}

function registeredValue(kind: string, input: JsonRecord): JsonRecord {
	const definition = registry.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind ${kind}`);
	const normalized: JsonRecord = {};
	for (const field of definition.fields) {
		if (!Object.hasOwn(input, field.name)) {
			if (field.required) throw new TypeError(`${kind} omits ${field.name}`);
			continue;
		}
		const value = input[field.name];
		if (field.const !== null && value !== field.const) throw new TypeError(`${kind}.${field.name} const drift`);
		if (field.sortRule === "codepoint" && Array.isArray(value)) {
			normalized[field.name] = clone(value).sort((left, right) =>
				String(
					typeof left === "object" && left !== null && "signerId" in left ? (left as JsonRecord).signerId : left
				).localeCompare(
					String(
						typeof right === "object" && right !== null && "signerId" in right ? (right as JsonRecord).signerId : right
					)
				)
			);
		} else {
			normalized[field.name] = clone(value);
		}
	}
	return normalized;
}

function registeredParts(kind: string, normalized: JsonRecord): Uint8Array[] {
	const definition = registry.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind ${kind}`);
	switch (definition.encoding) {
		case "canonical-object":
		case "canonical-object-as-single-part":
			return [grammarEncode(normalized)];
		case "canonical-array":
		case "canonical-value-as-single-part": {
			const field = definition.fields[0];
			if (field === undefined || definition.fields.length !== 1) throw new TypeError("single-part shape drift");
			return [grammarEncode(normalized[field.name])];
		}
		default:
			throw new TypeError(`d2 independent encoder does not require ${definition.encoding}`);
	}
}

function u32be(value: number): Uint8Array {
	const output = new Uint8Array(4);
	new DataView(output.buffer).setUint32(0, value, false);
	return output;
}

function u64be(value: number): Uint8Array {
	const output = new Uint8Array(8);
	new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
	return output;
}

function registeredDigest(domain: string, parts: Uint8Array[]): Uint8Array {
	const domainBytes = textEncoder.encode(domain);
	const framed = bytes(
		fromHex(registry.framing.magicHex),
		u32be(domainBytes.byteLength),
		domainBytes,
		...parts.flatMap((part) => [u64be(part.byteLength), part])
	);
	return Uint8Array.from(createHash("sha256").update(framed).digest());
}

function encodeResult(id: string, kind: string, input: JsonRecord): JsonRecord {
	const normalized = registeredValue(kind, input);
	const parts = registeredParts(kind, normalized);
	const domain = registry.kinds[kind]?.domain;
	if (domain === undefined) throw new TypeError("missing registered domain");
	return {
		canonicalHex: hex(grammarEncode(normalized)),
		digestHex: hex(registeredDigest(domain, parts)),
		id,
		normalized,
		partsHex: parts.map(hex),
	};
}

function rejectedIssue(id: string, request: IssueRequest): JsonRecord {
	return {
		accepted: false,
		after: clone(request.before),
		id,
		instrumentation: { digestCalls: 0, publicationCalls: 0, signCalls: 0 },
		published: false,
		registeredDigestHex: null,
		signatureHex: null,
	};
}

function acceptedIssue(id: string, request: IssueRequest): JsonRecord {
	if (request.privateKeyHex === undefined) throw new TypeError("missing private key");
	const normalized = registeredValue("vertex", request.candidate);
	const digest = registeredDigest(registry.domains.vertex as string, registeredParts("vertex", normalized));
	const next = request.before.lastIssued + 1;
	return {
		accepted: true,
		after: {
			...clone(request.before),
			exhausted: next === Number.MAX_SAFE_INTEGER,
			lastIssued: next,
		},
		id,
		instrumentation: { digestCalls: 1, publicationCalls: 1, signCalls: 1 },
		published: true,
		registeredDigestHex: hex(digest),
		signatureHex: hex(ed25519.sign(digest, fromHex(request.privateKeyHex))),
	};
}

function verifyResult(
	id: string,
	domain: string,
	receivedHex: string,
	signatureHex: string,
	publicKeyHex: string
): JsonRecord {
	const digest = registeredDigest(domain, [fromHex(receivedHex)]);
	return {
		accepted: ed25519.verify(fromHex(signatureHex), digest, fromHex(publicKeyHex), { zip215: false }),
		digestHex: hex(digest),
		id,
	};
}

function result(value: JsonRecord): Outcome {
	return { kind: "result", value };
}

function buildProbes(): Probe[] {
	const base = clone(contract.issuance.baseRequest);
	const wrongSequence = clone(base);
	wrongSequence.candidate.authorSequence = contract.issuance.wrongSequence;
	const mismatchedKey = clone(base);
	mismatchedKey.publicKeyHex = contract.issuance.mismatchedPublicKeyHex;
	const missingKey = clone(base);
	delete missingKey.privateKeyHex;
	const uppercaseKey = clone(base);
	uppercaseKey.publicKeyHex = uppercaseKey.publicKeyHex.toUpperCase();

	const verificationKind = contract.verification.kind;
	const verificationNormalized = registeredValue(verificationKind, contract.verification.canonicalInput);
	const canonicalReceived = registeredParts(verificationKind, verificationNormalized)[0];
	if (canonicalReceived === undefined) throw new TypeError("missing verification part");
	const flippedReceived = clone(canonicalReceived);
	const flipIndex = contract.verification.flipByteIndex;
	flippedReceived[flipIndex] = (flippedReceived[flipIndex] as number) ^ 1;
	const domain = registry.kinds[verificationKind]?.domain;
	if (domain === undefined) throw new TypeError("missing verification domain");
	const canonicalDigest = registeredDigest(domain, [canonicalReceived]);
	const flippedDigest = registeredDigest(domain, [flippedReceived]);
	const nonCanonicalDigest = registeredDigest(domain, [fromHex(contract.verification.nonCanonicalReceivedHex)]);
	const privateKey = fromHex(contract.verification.privateKeyHex);
	const canonicalSignature = hex(ed25519.sign(canonicalDigest, privateKey));
	const flippedSignature = hex(ed25519.sign(flippedDigest, privateKey));
	const nonCanonicalSignature = hex(ed25519.sign(nonCanonicalDigest, privateKey));

	const proto = contract.grammarCases.protoKey;
	const unpaired = contract.grammarCases.unpairedSurrogate;
	const uppercaseDecodeHex = hex(grammarEncode(contract.grammarCases.uppercaseDecode.value)).toUpperCase();

	return [
		{
			case: { id: "d2-issue-wrong-sequence", request: wrongSequence },
			expected: result(rejectedIssue("d2-issue-wrong-sequence", wrongSequence)),
			id: "d2-issue-wrong-sequence",
			operation: "issue-next",
		},
		{
			case: { id: "d2-issue-mismatched-keypair", request: mismatchedKey },
			expected: result(rejectedIssue("d2-issue-mismatched-keypair", mismatchedKey)),
			id: "d2-issue-mismatched-keypair",
			operation: "issue-next",
		},
		{
			case: { id: "d2-issue-missing-private-key", request: missingKey },
			expected: result(rejectedIssue("d2-issue-missing-private-key", missingKey)),
			id: "d2-issue-missing-private-key",
			operation: "issue-next",
		},
		{
			case: { id: "d2-issue-uppercase-public-key", request: uppercaseKey },
			expected: result(rejectedIssue("d2-issue-uppercase-public-key", uppercaseKey)),
			id: "d2-issue-uppercase-public-key",
			operation: "issue-next",
		},
		{
			case: {
				domain,
				id: "d2-verify-noncanonical-valid-signature",
				publicKeyHex: contract.verification.publicKeyHex,
				receivedHex: contract.verification.nonCanonicalReceivedHex,
				signatureHex: nonCanonicalSignature,
			},
			expected: result(
				verifyResult(
					"d2-verify-noncanonical-valid-signature",
					domain,
					contract.verification.nonCanonicalReceivedHex,
					nonCanonicalSignature,
					contract.verification.publicKeyHex
				)
			),
			id: "d2-verify-noncanonical-valid-signature",
			operation: "verify-received",
		},
		{
			case: {
				domain,
				id: "d2-verify-flipped-stale-signature",
				publicKeyHex: contract.verification.publicKeyHex,
				receivedHex: hex(flippedReceived),
				signatureHex: canonicalSignature,
			},
			expected: result(
				verifyResult(
					"d2-verify-flipped-stale-signature",
					domain,
					hex(flippedReceived),
					canonicalSignature,
					contract.verification.publicKeyHex
				)
			),
			id: "d2-verify-flipped-stale-signature",
			operation: "verify-received",
		},
		{
			case: {
				domain,
				id: "d2-verify-flipped-resigned",
				publicKeyHex: contract.verification.publicKeyHex,
				receivedHex: hex(flippedReceived),
				signatureHex: flippedSignature,
			},
			expected: result(
				verifyResult(
					"d2-verify-flipped-resigned",
					domain,
					hex(flippedReceived),
					flippedSignature,
					contract.verification.publicKeyHex
				)
			),
			id: "d2-verify-flipped-resigned",
			operation: "verify-received",
		},
		{
			case: { id: "d2-encode-own-proto-key", input: clone(proto.input), kind: proto.kind },
			expected: result(encodeResult("d2-encode-own-proto-key", proto.kind, proto.input)),
			id: "d2-encode-own-proto-key",
			operation: "encode-corpus",
		},
		{
			case: { id: "d2-encode-unpaired-surrogate", input: clone(unpaired.input), kind: unpaired.kind },
			expected: { kind: "rejected" },
			id: "d2-encode-unpaired-surrogate",
			operation: "encode-corpus",
		},
		{
			case: { canonicalHex: uppercaseDecodeHex, id: "d2-decode-uppercase-hex" },
			expected: { kind: "rejected" },
			id: "d2-decode-uppercase-hex",
			operation: "decode-corpus",
		},
	];
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function invokeProbe(sourcePath: string, probe: Probe): Outcome {
	const execution = spawnSync(process.execPath, [sourcePath], {
		cwd: repositoryRoot,
		encoding: "utf8",
		input: `${JSON.stringify({ cases: [probe.case], operation: probe.operation })}\n`,
		timeout: contract.runtime.peerInvocationMaxMs,
	});
	if (execution.error !== undefined) throw execution.error;
	if (execution.status !== 0) return { kind: "rejected" };
	if (execution.stderr !== "") throw new Error(`${probe.id}: peer wrote stderr`);
	const parsed = JSON.parse(execution.stdout) as { results?: JsonRecord[] };
	if (parsed.results?.length !== 1) throw new TypeError(`${probe.id}: peer result cardinality`);
	return result(parsed.results[0] as JsonRecord);
}

function outcomeErrors(probes: Probe[], outcomes: Outcome[]): string[] {
	const errors: string[] = [];
	for (const [index, probe] of probes.entries()) {
		const actual = outcomes[index];
		if (actual === undefined || actual.kind !== probe.expected.kind) {
			errors.push(`${probe.id}: expected ${probe.expected.kind}, received ${actual?.kind ?? "missing"}`);
			continue;
		}
		if (
			actual.kind === "result" &&
			probe.expected.kind === "result" &&
			stableJson(actual.value) !== stableJson(probe.expected.value)
		) {
			errors.push(`${probe.id}: semantic result mismatch`);
		}
	}
	return errors;
}

function mutateOutcome(
	outcomes: Outcome[],
	probes: Probe[],
	id: string,
	mutate: (value: JsonRecord) => void
): Outcome[] {
	const changed = clone(outcomes);
	const index = probes.findIndex((probe) => probe.id === id);
	const outcome = changed[index];
	if (index < 0 || outcome?.kind !== "result") throw new TypeError(`missing result mutant target ${id}`);
	mutate(outcome.value);
	return changed;
}

function sha256(relativePath: string): string {
	return createHash("sha256")
		.update(readFileSync(resolve(repositoryRoot, relativePath)))
		.digest("hex");
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectKeys(item, keys);
	} else if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			keys.add(key);
			collectKeys(item, keys);
		}
	}
	return keys;
}

describe("Phase -1'd2 blocker-remediation RED", () => {
	it("derives a GREEN-satisfiable semantic comparator and kills blocker-preserving mutants", () => {
		expect(contract.schemaVersion).toBe("phase-n1prime-d2-blocker-remediation-inputs-v1");
		expect(contract.redAuthorAttestation).toMatchObject({
			authoredPhaseDRed: false,
			authoredRegeneratedReference: false,
			willAuthorRemediationGreen: false,
		});
		for (const artifact of Object.values(contract.immutableArtifacts)) {
			expect(sha256(artifact.path), artifact.path).toBe(artifact.sha256);
		}
		expect(phaseDContract.explicitNonclaims).toContain(
			contract.normativeAdjudications.candidateAuthorSequence.retiresPhaseDNonclaim
		);
		expect(contract.normativeAdjudications.uppercasePublicKeyHex.owner).toContain(
			"accepted neutral JSON CLI transport contract"
		);
		expect(contract.normativeAdjudications.uppercasePublicKeyHex.requirement).toContain(
			"canonical lowercase transport"
		);
		expect(contract.normativeAdjudications.directJsBoundary.laterObligations).toEqual([
			"sparse-array",
			"non-plain-object",
			"accessor-property",
			"symbol-key",
		]);
		expect(contract.normativeAdjudications.directJsBoundary.reason).toContain("JSON stdin cannot faithfully preserve");
		const protoState = contract.grammarCases.protoKey.input.state as JsonRecord;
		expect(Object.hasOwn(protoState, "__proto__")).toBe(true);
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
		const fixtureKeys = collectKeys(contract);
		for (const forbidden of ["canonicalHex", "digestHex", "signatureHex", "expected"]) {
			expect(fixtureKeys.has(forbidden), `input-only fixture key ${forbidden}`).toBe(false);
		}

		const probes = buildProbes();
		const coherentOutcomes = probes.map(({ expected }) => clone(expected));
		expect(outcomeErrors(probes, coherentOutcomes), "scratch coherent comparator must satisfy GREEN").toEqual([]);

		const idMutant = mutateOutcome(coherentOutcomes, probes, "d2-issue-wrong-sequence", (value) => {
			value.id = "static-output-id";
		});
		expect(outcomeErrors(probes, idMutant)).toContain("d2-issue-wrong-sequence: semantic result mismatch");

		const sequenceOverwrite = mutateOutcome(coherentOutcomes, probes, "d2-issue-wrong-sequence", (value) => {
			Object.assign(value, acceptedIssue("d2-issue-wrong-sequence", contract.issuance.baseRequest));
		});
		expect(outcomeErrors(probes, sequenceOverwrite)).toContain("d2-issue-wrong-sequence: semantic result mismatch");

		const keyIgnored = mutateOutcome(coherentOutcomes, probes, "d2-issue-mismatched-keypair", (value) => {
			Object.assign(value, acceptedIssue("d2-issue-mismatched-keypair", contract.issuance.baseRequest));
		});
		expect(outcomeErrors(probes, keyIgnored)).toContain("d2-issue-mismatched-keypair: semantic result mismatch");

		const missingKeyIgnored = mutateOutcome(coherentOutcomes, probes, "d2-issue-missing-private-key", (value) => {
			Object.assign(value, acceptedIssue("d2-issue-missing-private-key", contract.issuance.baseRequest));
		});
		expect(outcomeErrors(probes, missingKeyIgnored)).toContain(
			"d2-issue-missing-private-key: semantic result mismatch"
		);

		const uppercaseKeyAccepted = mutateOutcome(coherentOutcomes, probes, "d2-issue-uppercase-public-key", (value) => {
			Object.assign(value, acceptedIssue("d2-issue-uppercase-public-key", contract.issuance.baseRequest));
		});
		expect(outcomeErrors(probes, uppercaseKeyAccepted)).toContain(
			"d2-issue-uppercase-public-key: semantic result mismatch"
		);

		const canonicalGate = mutateOutcome(coherentOutcomes, probes, "d2-verify-noncanonical-valid-signature", (value) => {
			value.accepted = false;
		});
		expect(outcomeErrors(probes, canonicalGate)).toContain(
			"d2-verify-noncanonical-valid-signature: semantic result mismatch"
		);

		const resignedRejected = mutateOutcome(coherentOutcomes, probes, "d2-verify-flipped-resigned", (value) => {
			value.accepted = false;
		});
		expect(outcomeErrors(probes, resignedRejected)).toContain("d2-verify-flipped-resigned: semantic result mismatch");

		const staleSignatureAccepted = mutateOutcome(
			coherentOutcomes,
			probes,
			"d2-verify-flipped-stale-signature",
			(value) => {
				value.accepted = true;
			}
		);
		expect(outcomeErrors(probes, staleSignatureAccepted)).toContain(
			"d2-verify-flipped-stale-signature: semantic result mismatch"
		);

		const protoStaticBytes = mutateOutcome(coherentOutcomes, probes, "d2-encode-own-proto-key", (value) => {
			value.canonicalHex = "00";
			value.digestHex = "00".repeat(32);
		});
		expect(outcomeErrors(probes, protoStaticBytes)).toContain("d2-encode-own-proto-key: semantic result mismatch");

		const malformedAccepted = clone(coherentOutcomes);
		const malformedIndex = probes.findIndex(({ id }) => id === "d2-encode-unpaired-surrogate");
		malformedAccepted[malformedIndex] = result({ id: "d2-encode-unpaired-surrogate", value: "accepted" });
		expect(outcomeErrors(probes, malformedAccepted)).toContain(
			"d2-encode-unpaired-surrogate: expected rejected, received result"
		);

		const uppercaseHexAccepted = clone(coherentOutcomes);
		const uppercaseHexIndex = probes.findIndex(({ id }) => id === "d2-decode-uppercase-hex");
		uppercaseHexAccepted[uppercaseHexIndex] = result({
			id: "d2-decode-uppercase-hex",
			value: contract.grammarCases.uppercaseDecode.value,
		});
		expect(outcomeErrors(probes, uppercaseHexAccepted)).toContain(
			"d2-decode-uppercase-hex: expected rejected, received result"
		);

		const staticVerify = clone(coherentOutcomes);
		const firstVerify = probes.findIndex(({ id }) => id === "d2-verify-noncanonical-valid-signature");
		for (const id of ["d2-verify-flipped-stale-signature", "d2-verify-flipped-resigned"]) {
			const index = probes.findIndex((probe) => probe.id === id);
			staticVerify[index] = clone(staticVerify[firstVerify] as Outcome);
		}
		expect(outcomeErrors(probes, staticVerify).length).toBeGreaterThan(0);
	});

	it(
		"requires the frozen regenerated peer to satisfy the independently derived remediation",
		() => {
			const probes = buildProbes();
			const source = resolve(repositoryRoot, contract.remediationTargets.regeneratedReference.path);
			const outcomes = probes.map((probe) => invokeProbe(source, probe));
			expect(outcomeErrors(probes, outcomes)).toEqual([]);
		},
		contract.runtime.focusedTestTimeoutMs
	);
});
