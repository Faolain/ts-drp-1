import { ed25519 } from "@noble/curves/ed25519.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contractDocument from "./fixtures/phase-n1prime-c/reference-vector-contract.json" with { type: "json" };
import { decodeCanonical, encodeCanonical, hashDomain } from "../packages/protocol-v2/src/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface Provenance {
	path: string;
	sha256: string;
}

interface RegistryField {
	const: unknown;
	constraints: Record<string, unknown>;
	name: string;
	required: boolean;
	sortRule: string | null;
	type: string;
}

interface RegistryKind {
	domain: string;
	encoding: string;
	fields: RegistryField[];
	signedEnvelope: {
		classification: "signed" | "unsigned";
		suiteRole: string | null;
	};
}

interface CryptoSuite {
	domainKinds: string[];
	role: string;
	suiteId: string;
}

interface SuiteAudit {
	disposition: string;
	predecessorSuiteId: string;
	role: string;
	successorSuiteId: string;
}

interface ReservedSuite extends CryptoSuite {
	activation: string;
	status: string;
}

interface Registry {
	canonicalObjectKeyOrder: string;
	cryptoSuites: {
		active: CryptoSuite[];
		predecessorAudit: SuiteAudit[];
		reserved: ReservedSuite[];
		reservedPredecessorAudit: SuiteAudit[];
	};
	domains: Record<string, string>;
	kinds: Record<string, RegistryKind>;
	protocolMajor: number;
	registryVersion: number;
	wireFormat: {
		canonicalPreimage: string;
		digestVerification: string;
		reencodeBeforeDigest: boolean;
		signature: string;
	};
}

interface Decision {
	decisionType: string;
	id: string;
	requirements: Record<string, unknown>;
}

interface Amendments {
	entries: Decision[];
}

interface Contract {
	acceptedInputs: Record<string, Provenance>;
	forbiddenReferenceFragments: string[];
	issuanceEvidence: {
		algorithm: string;
		publicKeyEncoding: string;
		registeredDigest: string;
		signatureEncoding: string;
		zip215: boolean;
	};
	referenceProtocol: {
		operations: string[];
		transport: string;
	};
	redAuthorId: string;
	requiredNegativeCategories: string[];
	schemaVersion: string;
	targetArtifacts: Record<string, string>;
}

interface SchemaProperty {
	"const"?: unknown;
	"enum"?: unknown[];
	"maxItems"?: number;
	"maxLength"?: number;
	"maximum"?: number;
	"minItems"?: number;
	"minLength"?: number;
	"minimum"?: number;
	"type"?: string | string[];
	"uniqueItems"?: boolean;
	"x-registry-constraints": Record<string, unknown>;
	"x-registry-type": string;
}

interface KindSchema {
	"additionalProperties": boolean;
	"properties": Record<string, SchemaProperty>;
	"required": string[];
	"type": string;
	"x-canonical-key-order": string;
	"x-domain": string;
	"x-encoding": string;
}

interface RegistrySchema {
	$defs: Record<string, KindSchema>;
}

interface Vector {
	canonicalHex: string;
	digestHex: string;
	domain: string;
	id: string;
	input: unknown;
	kind: string;
	normalized: unknown;
	partsHex: string[];
	suiteId: string | null;
}

interface NegativeCase {
	category: string;
	expected: {
		accepted: false;
		reason: string;
	};
	id: string;
	request: Record<string, unknown>;
}

interface IssuanceCase {
	expected: {
		accepted: boolean;
		after: Record<string, unknown>;
		published: boolean;
		registeredDigestHex: null | string;
		signatureHex: null | string;
	};
	id: string;
	request: Record<string, unknown>;
}

interface ReceivedByteCase {
	domain: string;
	id: string;
	receivedDigestHex: string;
	receivedHex: string;
	reencodedDigestHex: string;
	reencodedHex: string;
}

interface VectorDocument {
	antiCopyDiscriminator: {
		cases: {
			"activate-reserved-suite": string;
			"omit-authorSequence": string;
			"omit-roundChange-anchor": string;
		};
	};
	issuanceCases: IssuanceCase[];
	negativeCases: NegativeCase[];
	protocolMajor: number;
	provenance: {
		originalReferenceSourceSha256: string;
		referenceFixedAt: string;
		registrySha256: string;
		schemaSha256: string;
		vectorsMintedAt: string;
	};
	receivedByteCases: ReceivedByteCase[];
	registryVersion: number;
	schemaVersion: string;
	vectors: Vector[];
}

interface ReferenceProvenance {
	author: {
		agentId: string;
		didNotAuthorNormativeTuple: boolean;
		didNotAuthorRed: boolean;
		willNotAuthorTypescriptPort: boolean;
	};
	normativeInputs: Record<string, Provenance>;
	schemaVersion: string;
	source: {
		fixedAt: string;
		fixedBeforeVectorMinting: boolean;
		path: string;
		sha256: string;
	};
}

const contract = contractDocument as Contract;

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new TypeError(`${label} is required`);
	return value;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function acceptedPath(name: string): string {
	const provenance = contract.acceptedInputs[name];
	if (provenance === undefined) throw new TypeError(`unknown accepted input ${name}`);
	return join(repositoryRoot, provenance.path);
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

function bytesFromHex(value: string, label: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/u.test(value)) throw new TypeError(`${label} must be lowercase even-length hex`);
	return Uint8Array.from(Buffer.from(value, "hex"));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function hydrateCarrier(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hydrateCarrier);
	if (!isPlainRecord(value)) return value;
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "$bytesHex") {
		if (typeof value.$bytesHex !== "string") throw new TypeError("$bytesHex carrier must contain a string");
		return bytesFromHex(value.$bytesHex, "$bytesHex carrier");
	}
	if (keys.some((key) => key.startsWith("$"))) {
		throw new TypeError("unknown fixture carrier marker");
	}
	return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, hydrateCarrier(nested)]));
}

function compareProtocolStrings(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeField(value: unknown, field: RegistryField, label: string): unknown {
	const constraints = field.constraints;
	switch (field.type) {
		case "safe-integer":
		case "canonical-safe-integer":
			if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
			break;
		case "string":
		case "canonical-string":
			if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
			break;
		case "digest-hex": {
			const byteLength = typeof constraints.bytes === "number" ? constraints.bytes : 32;
			if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${byteLength * 2}}$`, "u").test(value)) {
				throw new TypeError(`${label} must be a lowercase digest`);
			}
			break;
		}
		case "bytes":
			if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be native bytes`);
			break;
		case "enum":
			if (!Array.isArray(constraints.values) || !constraints.values.includes(value)) {
				throw new TypeError(`${label} must be an active enum value`);
			}
			break;
		case "canonical-object":
		case "parameters":
			if (!isPlainRecord(value)) throw new TypeError(`${label} must be a canonical object`);
			encodeCanonical(value);
			break;
		case "canonical-value":
			encodeCanonical(value);
			break;
		case "seal-qc|null":
			if (value !== null && !isPlainRecord(value)) throw new TypeError(`${label} must be a seal QC or null`);
			if (value !== null) encodeCanonical(value);
			break;
		default:
			if (!field.type.startsWith("array<") || !Array.isArray(value)) {
				throw new TypeError(`${label} does not match ${field.type}`);
			}
			encodeCanonical(value);
	}
	if (typeof constraints.minimum === "number" && (typeof value !== "number" || value < constraints.minimum)) {
		throw new TypeError(`${label} violates minimum`);
	}
	if (typeof constraints.maximum === "number" && (typeof value !== "number" || value > constraints.maximum)) {
		throw new TypeError(`${label} violates maximum`);
	}
	if (
		typeof constraints.minimumUtf16Units === "number" &&
		(typeof value !== "string" || value.length < constraints.minimumUtf16Units)
	) {
		throw new TypeError(`${label} violates minimumUtf16Units`);
	}
	if (
		typeof constraints.maximumUtf16Units === "number" &&
		(typeof value !== "string" || value.length > constraints.maximumUtf16Units)
	) {
		throw new TypeError(`${label} violates maximumUtf16Units`);
	}
	if (
		typeof constraints.minimumItems === "number" &&
		(!Array.isArray(value) || value.length < constraints.minimumItems)
	) {
		throw new TypeError(`${label} violates minimumItems`);
	}
	if (constraints.unique === true && Array.isArray(value)) {
		const keys = value.map((entry) => hex(encodeCanonical(entry)));
		if (new Set(keys).size !== keys.length) throw new TypeError(`${label} violates unique`);
	}
	if (Array.isArray(value) && typeof constraints.uniqueBy === "string") {
		const keys = value.map((entry) => {
			if (!isPlainRecord(entry)) throw new TypeError(`${label} has a non-record uniqueBy value`);
			return entry[constraints.uniqueBy as string];
		});
		if (keys.some((entry) => typeof entry !== "string") || new Set(keys).size !== keys.length) {
			throw new TypeError(`${label} violates uniqueBy`);
		}
	}
	if (!Array.isArray(value) || field.sortRule === null) return value;
	switch (field.sortRule) {
		case "codepoint":
			return [...value].sort((left, right) => {
				const leftKey = typeof left === "string" ? left : isPlainRecord(left) ? left.signerId : undefined;
				const rightKey = typeof right === "string" ? right : isPlainRecord(right) ? right.signerId : undefined;
				if (typeof leftKey !== "string" || typeof rightKey !== "string") {
					throw new TypeError(`${label} cannot be codepoint sorted`);
				}
				return compareProtocolStrings(leftKey, rightKey);
			});
		case "index-ascending":
			return [...value].sort((left, right) => {
				if (
					!isPlainRecord(left) ||
					!isPlainRecord(right) ||
					!Number.isSafeInteger(left.index) ||
					!Number.isSafeInteger(right.index)
				) {
					throw new TypeError(`${label} cannot be index sorted`);
				}
				return (left.index as number) - (right.index as number);
			});
		case "linearized-order":
			return [...value];
		default:
			throw new TypeError(`${label} has unknown sort rule`);
	}
}

function buildRegistryValue(registry: Registry, kind: string, carrierInput: unknown): Record<string, unknown> {
	const definition = registry.kinds[kind];
	const hydrated = hydrateCarrier(carrierInput);
	if (definition === undefined || !isPlainRecord(hydrated)) throw new TypeError(`${kind} input is not registered`);
	const allowed = new Set(definition.fields.map(({ name }) => name));
	for (const name of Object.keys(hydrated)) {
		if (!allowed.has(name)) throw new TypeError(`${kind} input contains unregistered field ${name}`);
	}
	const output: Record<string, unknown> = {};
	for (const field of definition.fields) {
		if (!Object.hasOwn(hydrated, field.name)) {
			throw new TypeError(`${kind} vector omits registered field ${field.name}`);
		}
		const value = hydrated[field.name];
		if (field.const !== null && value !== field.const) throw new TypeError(`${kind}.${field.name} const drift`);
		output[field.name] = normalizeField(value, field, `${kind}.${field.name}`);
	}
	return output;
}

function registryParts(registry: Registry, kind: string, value: Record<string, unknown>): Uint8Array[] {
	const definition = registry.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown kind ${kind}`);
	switch (definition.encoding) {
		case "canonical-object":
		case "canonical-object-as-single-part":
			return [encodeCanonical(value)];
		case "canonical-array":
		case "canonical-value-as-single-part": {
			const field = definition.fields[0];
			if (definition.fields.length !== 1 || field === undefined) throw new TypeError(`${kind} single-part shape drift`);
			return [encodeCanonical(value[field.name])];
		}
		case "domain-framed-parts":
			return definition.fields.map((field) => {
				const fieldValue = value[field.name];
				if (field.type === "bytes") {
					if (!(fieldValue instanceof Uint8Array)) throw new TypeError(`${kind}.${field.name} is not bytes`);
					return fieldValue;
				}
				return encodeCanonical(fieldValue);
			});
		default:
			throw new TypeError(`${kind} has unknown encoding`);
	}
}

function lastIssuanceEvidenceErrors(registry: Registry, candidate: IssuanceCase): string[] {
	const errors: string[] = [];
	const before = candidate.request.before;
	const vertex = candidate.request.candidate;
	if (
		!candidate.expected.accepted ||
		!isPlainRecord(before) ||
		before.next !== Number.MAX_SAFE_INTEGER - 1 ||
		before.exhausted !== false
	) {
		errors.push("last successful issuance must start at MAX_SAFE_INTEGER - 1");
		return errors;
	}
	if (!isPlainRecord(vertex) || vertex.authorSequence !== Number.MAX_SAFE_INTEGER - 1) {
		errors.push("last successful candidate must bind authorSequence MAX_SAFE_INTEGER - 1");
		return errors;
	}
	let registeredDigest: Uint8Array;
	try {
		const registeredVertex = buildRegistryValue(registry, "vertex", vertex);
		registeredDigest = hashDomain(
			required(registry.domains.vertex, "vertex domain"),
			...registryParts(registry, "vertex", registeredVertex)
		);
	} catch {
		errors.push("last successful candidate is not a valid registered vertex");
		return errors;
	}
	if (candidate.expected.registeredDigestHex !== hex(registeredDigest)) {
		errors.push("registeredDigestHex is not the registry-built vertex digest");
	}
	try {
		const publicKey = bytesFromHex(
			required(
				typeof candidate.request.publicKeyHex === "string" ? candidate.request.publicKeyHex : undefined,
				"publicKeyHex"
			),
			"publicKeyHex"
		);
		const signature = bytesFromHex(
			required(candidate.expected.signatureHex ?? undefined, "signatureHex"),
			"signatureHex"
		);
		if (
			publicKey.byteLength !== 32 ||
			signature.byteLength !== 64 ||
			!ed25519.verify(signature, registeredDigest, publicKey, { zip215: false })
		) {
			errors.push("signatureHex does not verify over the raw registered digest with zip215=false");
		}
	} catch {
		errors.push("signatureHex does not verify over the raw registered digest with zip215=false");
	}
	if (
		JSON.stringify(candidate.expected.after) !==
		JSON.stringify({ ...before, exhausted: true, next: Number.MAX_SAFE_INTEGER })
	) {
		errors.push("last successful issuance does not advance exactly once into exhaustion");
	}
	if (!candidate.expected.published) errors.push("last successful issuance is not published");
	return errors;
}

function instanceSchemaErrors(
	registry: Registry,
	schema: RegistrySchema,
	kind: string,
	value: Record<string, unknown>
): string[] {
	const errors: string[] = [];
	const definition = registry.kinds[kind];
	const kindSchema = schema.$defs[kind];
	if (definition === undefined || kindSchema === undefined) return [`${kind}: missing registry/schema definition`];
	if (
		kindSchema.type !== "object" ||
		kindSchema.additionalProperties ||
		kindSchema["x-domain"] !== definition.domain ||
		kindSchema["x-encoding"] !== definition.encoding ||
		kindSchema["x-canonical-key-order"] !== "encoded-key-bytes"
	) {
		errors.push(`${kind}: schema envelope drift`);
	}
	const required = definition.fields.filter(({ required }) => required).map(({ name }) => name);
	if (JSON.stringify(kindSchema.required) !== JSON.stringify(required)) errors.push(`${kind}: required fields drift`);
	for (const name of Object.keys(value)) {
		if (!Object.hasOwn(kindSchema.properties, name)) errors.push(`${kind}.${name}: additional property`);
	}
	for (const field of definition.fields) {
		const property = kindSchema.properties[field.name];
		const present = Object.hasOwn(value, field.name);
		if (field.required && !present) errors.push(`${kind}.${field.name}: required value absent`);
		if (property === undefined) {
			errors.push(`${kind}.${field.name}: schema property absent`);
			continue;
		}
		if (property["x-registry-type"] !== field.type) errors.push(`${kind}.${field.name}: x-registry-type drift`);
		if (JSON.stringify(property["x-registry-constraints"]) !== JSON.stringify(field.constraints)) {
			errors.push(`${kind}.${field.name}: x-registry-constraints drift`);
		}
		if (field.type === "bytes" || field.type === "canonical-value") {
			if (property.type !== undefined)
				errors.push(`${kind}.${field.name}: native type was narrowed to a JSON projection`);
		}
		if (!present) continue;
		try {
			normalizeField(value[field.name], field, `${kind}.${field.name}`);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : `${kind}.${field.name}: invalid instance`);
		}
	}
	return errors;
}

function provenanceErrors(
	provenance: ReferenceProvenance,
	sourceBytes: Buffer,
	vectorDocument: VectorDocument
): string[] {
	const errors: string[] = [];
	const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
	if (
		provenance.schemaVersion !== "protocol-v3-original-reference-provenance-v1" ||
		provenance.source.path !== contract.targetArtifacts.referenceSource ||
		provenance.source.sha256 !== sourceHash ||
		!provenance.source.fixedBeforeVectorMinting
	) {
		errors.push("original reference source provenance is stale");
	}
	if (
		provenance.author.agentId.length === 0 ||
		provenance.author.agentId === contract.redAuthorId ||
		!provenance.author.didNotAuthorNormativeTuple ||
		!provenance.author.didNotAuthorRed ||
		!provenance.author.willNotAuthorTypescriptPort
	) {
		errors.push("reference author independence is not attested");
	}
	if (JSON.stringify(provenance.normativeInputs) !== JSON.stringify(contract.acceptedInputs)) {
		errors.push("reference normative-input provenance is stale or circular");
	}
	const fixedAt = Date.parse(provenance.source.fixedAt);
	const mintedAt = Date.parse(vectorDocument.provenance.vectorsMintedAt);
	if (
		vectorDocument.provenance.originalReferenceSourceSha256 !== sourceHash ||
		vectorDocument.provenance.referenceFixedAt !== provenance.source.fixedAt ||
		!Number.isFinite(fixedAt) ||
		!Number.isFinite(mintedAt) ||
		fixedAt >= mintedAt
	) {
		errors.push("reference was not fixed before vectors");
	}
	if (
		vectorDocument.provenance.registrySha256 !== contract.acceptedInputs.registry?.sha256 ||
		vectorDocument.provenance.schemaSha256 !== contract.acceptedInputs.schema?.sha256
	) {
		errors.push("vectors do not point outward to the accepted registry/schema");
	}
	const sourceText = sourceBytes.toString("utf8");
	const frozenVectorOutputs = vectorDocument.vectors.flatMap(({ canonicalHex, digestHex, partsHex }) => [
		canonicalHex,
		digestHex,
		...partsHex,
	]);
	if (
		contract.forbiddenReferenceFragments.some((fragment) => sourceText.includes(fragment)) ||
		sourceText.includes(sourceHash) ||
		sourceText.includes(provenance.source.sha256) ||
		sourceText.includes(contract.targetArtifacts.vectors ?? "") ||
		frozenVectorOutputs.some((output) => output.length >= 16 && sourceText.includes(output))
	) {
		errors.push("reference source imports predecessor/port/vector bytes, embeds outputs, or embeds its own hash");
	}
	return errors;
}

function runReference(sourcePath: string, request: Record<string, unknown>): unknown {
	const isolatedDirectory = mkdtempSync(join(tmpdir(), "protocol-v3-original-reference-"));
	const isolatedSource = join(isolatedDirectory, "reference.mjs");
	try {
		writeFileSync(isolatedSource, readFileSync(sourcePath));
		const result = spawnSync(process.execPath, [isolatedSource], {
			cwd: isolatedDirectory,
			encoding: "utf8",
			input: `${JSON.stringify(request)}\n`,
			timeout: 10_000,
		});
		expect(result.error, "independent reference process error").toBeUndefined();
		expect(result.status, `reference stderr: ${result.stderr}`).toBe(0);
		expect(result.stderr, "reference must keep stdout machine-readable and stderr empty").toBe("");
		expect(result.stdout.trim(), "reference returned no JSON").not.toBe("");
		return JSON.parse(result.stdout) as unknown;
	} finally {
		rmSync(isolatedDirectory, { force: true, recursive: true });
	}
}

function negativeCaseLocallyRejects(registry: Registry, candidate: NegativeCase): boolean {
	const request = candidate.request;
	const kind = typeof request.kind === "string" ? request.kind : "";
	const domain = registry.domains[kind];
	switch (candidate.category) {
		case "reserved-enum": {
			const field = registry.kinds[kind]?.fields.find(({ name }) => name === request.field);
			return (
				Array.isArray(field?.constraints.reservedValues) && field.constraints.reservedValues.includes(request.value)
			);
		}
		case "malformed-author-sequence":
			return (
				!Number.isSafeInteger(request.authorSequence) ||
				(request.authorSequence as number) < 0 ||
				(request.authorSequence as number) > Number.MAX_SAFE_INTEGER
			);
		case "mechanical-v2-author-sequence-omission":
			return request.kind === "vertex" && request.authorSequence === undefined;
		case "mechanical-v2-anchor-omission":
			return request.kind === "roundChange" && request.anchor === undefined;
		case "v2-domain-on-v3":
			return (
				request.expectedMajor === 3 &&
				request.expectedDomain === domain &&
				domain?.endsWith("/v3") === true &&
				request.candidateDomain === domain.replace(/\/v3$/u, "/v2")
			);
		case "v3-domain-on-v2":
			return (
				request.expectedMajor === 2 &&
				request.candidateDomain === domain &&
				domain?.endsWith("/v3") === true &&
				request.expectedDomain === domain.replace(/\/v3$/u, "/v2")
			);
		case "v2-suite-on-v3":
			return (
				request.expectedMajor === 3 &&
				registry.cryptoSuites.predecessorAudit.some(
					({ predecessorSuiteId, successorSuiteId }) =>
						request.candidateSuite === predecessorSuiteId && request.expectedSuite === successorSuiteId
				)
			);
		case "v3-suite-on-v2":
			return (
				request.expectedMajor === 2 &&
				registry.cryptoSuites.predecessorAudit.some(
					({ predecessorSuiteId, successorSuiteId }) =>
						request.candidateSuite === successorSuiteId && request.expectedSuite === predecessorSuiteId
				)
			);
		default:
			return false;
	}
}

function expectedSuiteForKind(registry: Registry, kind: string): string | null {
	const metadata = registry.kinds[kind]?.signedEnvelope;
	if (metadata?.classification !== "signed" || metadata.suiteRole === null) return null;
	return registry.cryptoSuites.active.find(({ role }) => role === metadata.suiteRole)?.suiteId ?? null;
}

function antiCopyErrors(
	discriminator: VectorDocument["antiCopyDiscriminator"],
	negativeCases: NegativeCase[]
): string[] {
	const errors: string[] = [];
	const expectedCategories = {
		"activate-reserved-suite": "reserved-enum",
		"omit-authorSequence": "mechanical-v2-author-sequence-omission",
		"omit-roundChange-anchor": "mechanical-v2-anchor-omission",
	} as const;
	if (
		JSON.stringify(Object.keys(discriminator.cases).sort()) !== JSON.stringify(Object.keys(expectedCategories).sort())
	) {
		errors.push("anti-copy mutation set drift");
	}
	if (new Set(Object.values(discriminator.cases)).size !== Object.keys(expectedCategories).length) {
		errors.push("anti-copy mutations do not own distinct cases");
	}
	for (const [mutation, category] of Object.entries(expectedCategories)) {
		const id = discriminator.cases[mutation as keyof typeof discriminator.cases];
		const candidate = negativeCases.find((entry) => entry.id === id);
		if (candidate?.category !== category) errors.push(`${mutation} does not bind its exact negative category`);
	}
	return errors;
}

function suiteContractErrors(registry: Registry, amendments: Amendments): string[] {
	const errors: string[] = [];
	const decision = amendments.entries.find(({ id }) => id === "PH-N1P-D01");
	const requirements = decision?.requirements;
	if (decision?.decisionType !== "protocol-identity" || requirements === undefined) {
		return ["PH-N1P-D01 protocol-identity decision is absent"];
	}
	const active = Object.fromEntries(registry.cryptoSuites.active.map((suite) => [suite.role, suite.suiteId]));
	const predecessor = Object.fromEntries(
		registry.cryptoSuites.predecessorAudit.map((audit) => [audit.role, audit.predecessorSuiteId])
	);
	const reserved = Object.fromEntries(registry.cryptoSuites.reserved.map((suite) => [suite.role, suite.suiteId]));
	if (JSON.stringify(active) !== JSON.stringify(requirements.activeSuites)) errors.push("D01 active suites drift");
	if (JSON.stringify(predecessor) !== JSON.stringify(requirements.predecessorSuites)) {
		errors.push("D01 predecessor suites drift");
	}
	if (JSON.stringify(reserved) !== JSON.stringify(requirements.reservedSuites))
		errors.push("D01 reserved suites drift");

	const reservedDisposition = requirements.reservedPredecessorDisposition as Record<string, unknown>;
	const reservedSuite = registry.cryptoSuites.reserved[0];
	const reservedAudit = registry.cryptoSuites.reservedPredecessorAudit[0];
	if (
		registry.cryptoSuites.reserved.length !== 1 ||
		registry.cryptoSuites.reservedPredecessorAudit.length !== 1 ||
		reservedSuite === undefined ||
		reservedAudit === undefined ||
		reservedSuite.status !== "reserved" ||
		reservedSuite.role !== reservedAudit.role ||
		reservedSuite.domainKinds.length === 0 ||
		reservedSuite.activation !== reservedDisposition.activation ||
		reservedAudit.predecessorSuiteId !== reservedDisposition.predecessorSuiteId ||
		reservedAudit.successorSuiteId !== reservedDisposition.successorSuiteId ||
		reservedAudit.disposition !== reservedDisposition.disposition
	) {
		errors.push("D01 reserved predecessor disposition drift");
	}

	const activeByRole = new Map(registry.cryptoSuites.active.map((suite) => [suite.role, suite]));
	if (
		activeByRole.size !== registry.cryptoSuites.active.length ||
		new Set(registry.cryptoSuites.active.map(({ suiteId }) => suiteId)).size !== registry.cryptoSuites.active.length
	) {
		errors.push("active suite roles and ids must be unique");
	}
	const signedKinds = Object.entries(registry.kinds).filter(
		([, definition]) => definition.signedEnvelope.classification === "signed"
	);
	for (const audit of registry.cryptoSuites.predecessorAudit) {
		if (audit.disposition !== "replaced" || activeByRole.get(audit.role)?.suiteId !== audit.successorSuiteId) {
			errors.push(`predecessor audit for ${audit.role} does not point to its active successor`);
		}
	}
	for (const suite of registry.cryptoSuites.active) {
		if (suite.role.length === 0 || suite.domainKinds.length === 0)
			errors.push(`active suite ${suite.suiteId} has an empty role`);
		for (const kind of suite.domainKinds) {
			const metadata = registry.kinds[kind]?.signedEnvelope;
			if (metadata?.classification !== "signed" || metadata.suiteRole !== suite.role) {
				errors.push(`active suite ${suite.suiteId} has orphan kind ${kind}`);
			}
		}
	}
	for (const [kind, definition] of signedKinds) {
		const suite = activeByRole.get(definition.signedEnvelope.suiteRole ?? "");
		if (suite === undefined || suite.domainKinds.filter((candidate) => candidate === kind).length !== 1) {
			errors.push(`signed kind ${kind} does not map exactly once`);
		}
	}

	const activeSuiteIds = registry.cryptoSuites.active.map(({ suiteId }) => suiteId).sort();
	const reservedSuiteIds = registry.cryptoSuites.reserved.map(({ suiteId }) => suiteId);
	if (reservedSuiteIds.some((suiteId) => activeSuiteIds.includes(suiteId))) {
		errors.push("active and reserved suite ids overlap");
	}
	for (const [kind, definition] of Object.entries(registry.kinds)) {
		for (const field of definition.fields.filter(({ type }) => type === "enum")) {
			const values = field.constraints.values;
			if (
				field.name === "cryptoSuiteId" &&
				JSON.stringify([...(values as unknown[])].sort()) !== JSON.stringify(activeSuiteIds)
			) {
				errors.push(`${kind}.cryptoSuiteId does not enumerate exactly the active suite ids`);
			}
		}
	}
	return errors;
}

function registryCoverageErrors(registry: Registry): string[] {
	const errors: string[] = [];
	const kinds = Object.keys(registry.kinds);
	if (kinds.length !== 19) errors.push(`expected 19 registry kinds, found ${kinds.length}`);
	if (Object.keys(registry.domains).sort().join() !== kinds.sort().join())
		errors.push("domains and kinds are not bijective");
	for (const [kind, definition] of Object.entries(registry.kinds)) {
		if (registry.domains[kind] !== definition.domain || !definition.domain.endsWith("/v3")) {
			errors.push(`${kind} does not bind one /v3 domain`);
		}
	}
	if (registry.canonicalObjectKeyOrder !== "encoded-key-bytes") errors.push("canonical key order drift");
	if (
		registry.wireFormat.canonicalPreimage !== "bytes" ||
		registry.wireFormat.signature !== "bytes" ||
		registry.wireFormat.digestVerification !== "received-bytes" ||
		registry.wireFormat.reencodeBeforeDigest
	) {
		errors.push("received-byte wire contract drift");
	}
	const vertexFields = registry.kinds.vertex?.fields ?? [];
	const sequence = vertexFields.find(({ name }) => name === "authorSequence");
	if (
		vertexFields.findIndex(({ name }) => name === "authorSequence") !==
			vertexFields.findIndex(({ name }) => name === "author") + 1 ||
		sequence?.type !== "safe-integer" ||
		sequence.constraints.minimum !== 0 ||
		sequence.constraints.maximum !== Number.MAX_SAFE_INTEGER ||
		sequence.constraints.initial !== 0 ||
		sequence.constraints.reset !== "never" ||
		sequence.constraints.overflow !== "reject"
	) {
		errors.push("authorSequence boundary/review contract drift");
	}
	const roundChangeFields = registry.kinds.roundChange?.fields ?? [];
	if (
		roundChangeFields.findIndex(({ name }) => name === "anchor") !==
		roundChangeFields.findIndex(({ name }) => name === "epoch") + 1
	) {
		errors.push("roundChange.anchor is not direct and immediately after epoch");
	}
	return errors;
}

describe("Phase -1'c independent original v3 reference and registry-built vectors RED", () => {
	it("pins every accepted normative input before exercising the absent tuple", () => {
		expect(contract.schemaVersion).toBe("phase-n1prime-c-independent-reference-vectors-v1");
		expect(contract.referenceProtocol.transport).toBe("one-json-request-on-stdin-one-json-response-on-stdout");
		expect(new Set(contract.referenceProtocol.operations)).toEqual(
			new Set(["encode-corpus", "validate-cases", "issue-next", "digest-received"])
		);
		expect(contract.issuanceEvidence).toEqual({
			algorithm: "Ed25519",
			publicKeyEncoding: "lowercase-hex",
			registeredDigest: "raw-32-byte-domain-separated-vertex-digest",
			signatureEncoding: "lowercase-hex",
			zip215: false,
		});
		for (const provenance of Object.values(contract.acceptedInputs)) {
			expect(existsSync(join(repositoryRoot, provenance.path)), provenance.path).toBe(true);
			expect(sha256(join(repositoryRoot, provenance.path)), provenance.path).toBe(provenance.sha256);
		}
	});

	it("derives all 19 kinds, domains, sequence boundaries, direct anchor and received-byte rules from the registry", () => {
		const registry = readJson<Registry>(acceptedPath("registry"));
		expect(registryCoverageErrors(registry)).toEqual([]);

		const omittedSequence = clone(registry);
		const omittedVertex = required(omittedSequence.kinds.vertex, "vertex");
		omittedVertex.fields = omittedVertex.fields.filter(({ name }) => name !== "authorSequence");
		expect(registryCoverageErrors(omittedSequence)).toContain("authorSequence boundary/review contract drift");

		const staleAnchor = clone(registry);
		const staleRoundChange = required(staleAnchor.kinds.roundChange, "roundChange");
		staleRoundChange.fields = staleRoundChange.fields.filter(({ name }) => name !== "anchor");
		expect(registryCoverageErrors(staleAnchor)).toContain(
			"roundChange.anchor is not direct and immediately after epoch"
		);

		const reencode = clone(registry);
		reencode.wireFormat.reencodeBeforeDigest = true;
		expect(registryCoverageErrors(reencode)).toContain("received-byte wire contract drift");
	});

	it("closes D.38 suite gaps mechanically against D01 and kills empty, orphan, stale and extra-role mutants", () => {
		const registry = readJson<Registry>(acceptedPath("registry"));
		const amendments = readJson<Amendments>(acceptedPath("amendments"));
		expect(suiteContractErrors(registry, amendments)).toEqual([]);

		const emptyRole = clone(registry);
		required(emptyRole.cryptoSuites.active[0], "first active suite").domainKinds = [];
		expect(suiteContractErrors(emptyRole, amendments)).not.toEqual([]);

		const orphan = clone(registry);
		required(orphan.cryptoSuites.active[0], "first active suite").domainKinds.push("parameters");
		expect(suiteContractErrors(orphan, amendments)).not.toEqual([]);

		const staleReserved = clone(registry);
		required(staleReserved.cryptoSuites.reserved[0], "reserved suite").suiteId = "stale-reserved-suite";
		expect(suiteContractErrors(staleReserved, amendments)).toContain("D01 reserved suites drift");

		const extraRole = clone(registry);
		extraRole.cryptoSuites.active.push({ domainKinds: [], role: "orphan", suiteId: "orphan-v3" });
		expect(suiteContractErrors(extraRole, amendments)).not.toEqual([]);

		const omittedReservedAudit = clone(registry);
		omittedReservedAudit.cryptoSuites.reservedPredecessorAudit = [];
		expect(suiteContractErrors(omittedReservedAudit, amendments)).toContain(
			"D01 reserved predecessor disposition drift"
		);

		const duplicateRole = clone(registry);
		required(duplicateRole.cryptoSuites.active[1], "second active suite").role = required(
			duplicateRole.cryptoSuites.active[0],
			"first active suite"
		).role;
		expect(suiteContractErrors(duplicateRole, amendments)).toContain("active suite roles and ids must be unique");

		const duplicateId = clone(registry);
		required(duplicateId.cryptoSuites.active[1], "second active suite").suiteId = required(
			duplicateId.cryptoSuites.active[0],
			"first active suite"
		).suiteId;
		expect(suiteContractErrors(duplicateId, amendments)).toContain("active suite roles and ids must be unique");

		const enumDrift = clone(registry);
		const suiteEnum = required(enumDrift.kinds.epochAnchor, "epochAnchor").fields.find(
			({ name }) => name === "cryptoSuiteId"
		);
		required(suiteEnum, "epochAnchor.cryptoSuiteId").constraints.values = ["ed25519-sha256-v3"];
		expect(suiteContractErrors(enumDrift, amendments)).toContain(
			"epochAnchor.cryptoSuiteId does not enumerate exactly the active suite ids"
		);
	});

	it("uses a bounded instance oracle without narrowing native bytes and kills omission, drift and projection mutants", () => {
		const probeRegistry = {
			canonicalObjectKeyOrder: "encoded-key-bytes",
			cryptoSuites: { active: [], predecessorAudit: [], reserved: [], reservedPredecessorAudit: [] },
			domains: { probe: "test/probe/v3" },
			kinds: {
				probe: {
					domain: "test/probe/v3",
					encoding: "canonical-object",
					fields: [
						{
							const: null,
							constraints: { minimum: 0, maximum: 7 },
							name: "ordinal",
							required: true,
							sortRule: null,
							type: "safe-integer",
						},
						{
							const: null,
							constraints: {},
							name: "payload",
							required: true,
							sortRule: null,
							type: "bytes",
						},
					],
					signedEnvelope: { classification: "unsigned", suiteRole: null },
				},
			},
			protocolMajor: 3,
			registryVersion: 1,
			wireFormat: {
				canonicalPreimage: "bytes",
				digestVerification: "received-bytes",
				reencodeBeforeDigest: false,
				signature: "bytes",
			},
		} satisfies Registry;
		const probeSchema = {
			$defs: {
				probe: {
					"additionalProperties": false,
					"properties": {
						ordinal: {
							"maxItems": undefined,
							"maxLength": undefined,
							"maximum": 7,
							"minItems": undefined,
							"minLength": undefined,
							"minimum": 0,
							"type": "integer",
							"uniqueItems": undefined,
							"x-registry-constraints": { minimum: 0, maximum: 7 },
							"x-registry-type": "safe-integer",
						},
						payload: {
							"x-registry-constraints": {},
							"x-registry-type": "bytes",
						},
					},
					"required": ["ordinal", "payload"],
					"type": "object",
					"x-canonical-key-order": "encoded-key-bytes",
					"x-domain": "test/probe/v3",
					"x-encoding": "canonical-object",
				},
			},
		} satisfies RegistrySchema;
		const instance = { ordinal: 7, payload: Uint8Array.of(0, 1, 2) };
		expect(instanceSchemaErrors(probeRegistry, probeSchema, "probe", instance)).toEqual([]);
		expect(instanceSchemaErrors(probeRegistry, probeSchema, "probe", { ordinal: 7 })).toContain(
			"probe.payload: required value absent"
		);
		expect(instanceSchemaErrors(probeRegistry, probeSchema, "probe", { ...instance, extra: true })).toContain(
			"probe.extra: additional property"
		);

		const stale = clone(probeSchema);
		required(required(stale.$defs.probe, "probe schema").properties.ordinal, "ordinal schema")[
			"x-registry-constraints"
		] = { minimum: 1, maximum: 7 };
		expect(instanceSchemaErrors(probeRegistry, stale, "probe", instance)).toContain(
			"probe.ordinal: x-registry-constraints drift"
		);

		const inventedProjection = clone(probeSchema);
		required(required(inventedProjection.$defs.probe, "probe schema").properties.payload, "payload schema").type =
			"string";
		expect(instanceSchemaErrors(probeRegistry, inventedProjection, "probe", instance)).toContain(
			"probe.payload: native type was narrowed to a JSON projection"
		);
	});

	it("verifies the last successful local issuance cryptographically and kills sequence, digest and signature mutants", () => {
		const registry = readJson<Registry>(acceptedPath("registry"));
		const anchor = "00".repeat(32);
		const vertex = {
			anchor,
			author: "independent-reference-author",
			authorSequence: Number.MAX_SAFE_INTEGER - 1,
			dependencies: ["11".repeat(32)],
			epoch: 7,
			kind: "drp-vertex",
			logicalTime: 9,
			objectId: "object:sequence-boundary",
			operation: { action: "set", key: "boundary", value: true },
			protocolMajor: 3,
		};
		const registeredVertex = buildRegistryValue(registry, "vertex", vertex);
		const digest = hashDomain(
			required(registry.domains.vertex, "vertex domain"),
			...registryParts(registry, "vertex", registeredVertex)
		);
		const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
		const before = {
			anchor,
			epoch: 7,
			exhausted: false,
			next: Number.MAX_SAFE_INTEGER - 1,
		};
		const valid: IssuanceCase = {
			expected: {
				accepted: true,
				after: { ...before, exhausted: true, next: Number.MAX_SAFE_INTEGER },
				published: true,
				registeredDigestHex: hex(digest),
				signatureHex: hex(ed25519.sign(digest, privateKey)),
			},
			id: "last-successful-local-issuance-control",
			request: {
				before,
				candidate: vertex,
				publicKeyHex: hex(ed25519.getPublicKey(privateKey)),
			},
		};
		expect(lastIssuanceEvidenceErrors(registry, valid)).toEqual([]);

		const wrongSequence = clone(valid);
		required(wrongSequence.request.candidate as Record<string, unknown>, "candidate").authorSequence =
			Number.MAX_SAFE_INTEGER;
		expect(lastIssuanceEvidenceErrors(registry, wrongSequence)).toContain(
			"last successful candidate must bind authorSequence MAX_SAFE_INTEGER - 1"
		);

		const staleDigest = clone(valid);
		staleDigest.expected.registeredDigestHex = "00".repeat(32);
		expect(lastIssuanceEvidenceErrors(registry, staleDigest)).toContain(
			"registeredDigestHex is not the registry-built vertex digest"
		);

		const invalidSignature = clone(valid);
		invalidSignature.expected.signatureHex = "00".repeat(64);
		expect(lastIssuanceEvidenceErrors(registry, invalidSignature)).toContain(
			"signatureHex does not verify over the raw registered digest with zip215=false"
		);

		const alreadyExhausted = clone(valid);
		required(alreadyExhausted.request.before as Record<string, unknown>, "before").next = Number.MAX_SAFE_INTEGER;
		expect(lastIssuanceEvidenceErrors(registry, alreadyExhausted)).toContain(
			"last successful issuance must start at MAX_SAFE_INTEGER - 1"
		);
	});

	it("kills a mechanical v2 transliteration with an exact mutation-to-negative discriminator", () => {
		const registry = readJson<Registry>(acceptedPath("registry"));
		const reservedValue = required(
			required(registry.kinds.epochAnchor, "epochAnchor").fields.find(({ name }) => name === "cryptoSuiteId")
				?.constraints.reservedValues as unknown[] | undefined,
			"reserved cryptoSuiteId values"
		)[0];
		const cases: NegativeCase[] = [
			{
				category: "mechanical-v2-author-sequence-omission",
				expected: { accepted: false, reason: "v3 vertex requires authorSequence" },
				id: "mechanical-vertex",
				request: { kind: "vertex" },
			},
			{
				category: "mechanical-v2-anchor-omission",
				expected: { accepted: false, reason: "v3 roundChange requires direct anchor" },
				id: "mechanical-round-change",
				request: { kind: "roundChange" },
			},
			{
				category: "reserved-enum",
				expected: { accepted: false, reason: "reserved suite is inactive" },
				id: "mechanical-reserved-suite",
				request: { field: "cryptoSuiteId", kind: "epochAnchor", value: reservedValue },
			},
		];
		const discriminator: VectorDocument["antiCopyDiscriminator"] = {
			cases: {
				"activate-reserved-suite": "mechanical-reserved-suite",
				"omit-authorSequence": "mechanical-vertex",
				"omit-roundChange-anchor": "mechanical-round-change",
			},
		};
		expect(antiCopyErrors(discriminator, cases)).toEqual([]);
		expect(cases.every((candidate) => negativeCaseLocallyRejects(registry, candidate))).toBe(true);

		const mechanicalV2Results = cases.map(({ id }) => ({ accepted: true, id }));
		const requiredV3Results = cases.map(({ expected, id }) => ({ id, ...expected }));
		expect(mechanicalV2Results).not.toEqual(requiredV3Results);

		const swapped = clone(discriminator);
		swapped.cases["omit-authorSequence"] = "mechanical-round-change";
		expect(antiCopyErrors(swapped, cases)).toContain("omit-authorSequence does not bind its exact negative category");
	});

	it("requires executable, noncircular pre-vector source provenance and kills stale, self, import and time mutants", () => {
		const source = Buffer.from("export function encode(value) { return value; }\n");
		const sourceHash = createHash("sha256").update(source).digest("hex");
		const provenance: ReferenceProvenance = {
			author: {
				agentId: "independent-green-agent",
				didNotAuthorNormativeTuple: true,
				didNotAuthorRed: true,
				willNotAuthorTypescriptPort: true,
			},
			normativeInputs: clone(contract.acceptedInputs),
			schemaVersion: "protocol-v3-original-reference-provenance-v1",
			source: {
				fixedAt: "2026-07-27T20:00:00.000Z",
				fixedBeforeVectorMinting: true,
				path: required(contract.targetArtifacts.referenceSource, "referenceSource target"),
				sha256: sourceHash,
			},
		};
		const vectors: VectorDocument = {
			antiCopyDiscriminator: {
				cases: {
					"activate-reserved-suite": "reserved",
					"omit-authorSequence": "sequence",
					"omit-roundChange-anchor": "anchor",
				},
			},
			issuanceCases: [],
			negativeCases: [],
			protocolMajor: 3,
			provenance: {
				originalReferenceSourceSha256: sourceHash,
				referenceFixedAt: provenance.source.fixedAt,
				registrySha256: required(contract.acceptedInputs.registry, "accepted registry").sha256,
				schemaSha256: required(contract.acceptedInputs.schema, "accepted schema").sha256,
				vectorsMintedAt: "2026-07-27T20:00:01.000Z",
			},
			receivedByteCases: [],
			registryVersion: 1,
			schemaVersion: "protocol-v3-registry-v1-vectors-v1",
			vectors: [],
		};
		expect(provenanceErrors(provenance, source, vectors)).toEqual([]);

		const stale = clone(provenance);
		stale.source.sha256 = "0".repeat(64);
		expect(provenanceErrors(stale, source, vectors)).toContain("original reference source provenance is stale");

		const selfHashSource = Buffer.from(`const embeddedSourceHash = "${"a".repeat(64)}";\n`);
		const selfHash = clone(provenance);
		selfHash.source.sha256 = "a".repeat(64);
		expect(provenanceErrors(selfHash, selfHashSource, vectors)).toContain(
			"reference source imports predecessor/port/vector bytes, embeds outputs, or embeds its own hash"
		);

		for (const forbidden of [
			"protocol-v2",
			required(contract.targetArtifacts.vectors, "vectors target"),
			"request.registry",
		]) {
			const imported = Buffer.from(`const forbiddenImport = "${forbidden}";\n`);
			expect(provenanceErrors(provenance, imported, vectors)).toContain(
				"reference source imports predecessor/port/vector bytes, embeds outputs, or embeds its own hash"
			);
		}

		const bakedOutput = "ab".repeat(32);
		const bakedSource = Buffer.from(`const bakedOutput = "${bakedOutput}";\n`);
		const bakedSourceHash = createHash("sha256").update(bakedSource).digest("hex");
		const bakedProvenance = clone(provenance);
		bakedProvenance.source.sha256 = bakedSourceHash;
		const bakedVectors = clone(vectors);
		bakedVectors.provenance.originalReferenceSourceSha256 = bakedSourceHash;
		bakedVectors.vectors = [
			{
				canonicalHex: bakedOutput,
				digestHex: "cd".repeat(32),
				domain: "test/v3",
				id: "baked",
				input: {},
				kind: "state",
				normalized: {},
				partsHex: [],
				suiteId: null,
			},
		];
		expect(provenanceErrors(bakedProvenance, bakedSource, bakedVectors)).toContain(
			"reference source imports predecessor/port/vector bytes, embeds outputs, or embeds its own hash"
		);

		const circular = clone(provenance);
		circular.normativeInputs = { ...circular.normativeInputs, vectors: { path: "vectors", sha256: "0".repeat(64) } };
		expect(provenanceErrors(circular, source, vectors)).toContain(
			"reference normative-input provenance is stale or circular"
		);

		const invalidTime = clone(vectors);
		invalidTime.provenance.vectorsMintedAt = "not-a-time";
		expect(provenanceErrors(provenance, source, invalidTime)).toContain("reference was not fixed before vectors");
	});

	it("requires the independent reference source, pre-vector provenance and real vector corpus as one causal boundary", () => {
		const missing = Object.entries(contract.targetArtifacts)
			.filter(([, relativePath]) => !existsSync(join(repositoryRoot, relativePath)))
			.map(([name, relativePath]) => `${name}: ${relativePath}`);
		expect(
			missing,
			"Phase -1'c GREEN must add the fixed independent original reference, its noncircular provenance, and registry-built vectors"
		).toEqual([]);

		const registry = readJson<Registry>(acceptedPath("registry"));
		const schema = readJson<RegistrySchema>(acceptedPath("schema"));
		const sourcePath = join(
			repositoryRoot,
			required(contract.targetArtifacts.referenceSource, "referenceSource target")
		);
		const provenance = readJson<ReferenceProvenance>(
			join(repositoryRoot, required(contract.targetArtifacts.referenceProvenance, "referenceProvenance target"))
		);
		const vectorDocument = readJson<VectorDocument>(
			join(repositoryRoot, required(contract.targetArtifacts.vectors, "vectors target"))
		);
		const sourceBytes = readFileSync(sourcePath);
		expect(provenanceErrors(provenance, sourceBytes, vectorDocument)).toEqual([]);
		expect(vectorDocument.schemaVersion).toBe("protocol-v3-registry-v1-vectors-v1");
		expect(vectorDocument.protocolMajor).toBe(registry.protocolMajor);
		expect(vectorDocument.registryVersion).toBe(registry.registryVersion);
		expect(new Set(vectorDocument.vectors.map(({ id }) => id)).size).toBe(vectorDocument.vectors.length);
		expect(new Set(vectorDocument.vectors.map(({ kind }) => kind))).toEqual(new Set(Object.keys(registry.kinds)));

		const enumCoverage = new Map<string, Set<unknown>>();
		const sequenceValues = new Set<unknown>();
		for (const vector of vectorDocument.vectors) {
			const definition = registry.kinds[vector.kind];
			expect(definition, `${vector.id}: unregistered kind`).toBeDefined();
			const registeredDefinition = required(definition, `${vector.id} definition`);
			expect(vector.domain, `${vector.id}: domain`).toBe(registeredDefinition.domain);
			expect(vector.suiteId, `${vector.id}: suite`).toBe(expectedSuiteForKind(registry, vector.kind));
			const normalized = buildRegistryValue(registry, vector.kind, vector.input);
			expect(normalized, `${vector.id}: registry-built normalized value`).toEqual(hydrateCarrier(vector.normalized));
			expect(instanceSchemaErrors(registry, schema, vector.kind, normalized), vector.id).toEqual([]);

			const canonicalBytes = encodeCanonical(normalized);
			expect(vector.canonicalHex, `${vector.id}: canonical bytes`).toBe(hex(canonicalBytes));
			expect(decodeCanonical(canonicalBytes), `${vector.id}: canonical round trip`).toEqual(normalized);
			const reversedInsertion = Object.fromEntries(Object.entries(normalized).reverse());
			// The frozen v2 codec is used only as an unchanged canonical-grammar byte oracle. The separately
			// executed v3 reference is forbidden from importing it and must independently match these bytes.
			expect(encodeCanonical(reversedInsertion), `${vector.id}: encoded key-byte order`).toEqual(canonicalBytes);

			const parts = registryParts(registry, vector.kind, normalized);
			expect(vector.partsHex, `${vector.id}: registered parts`).toEqual(parts.map(hex));
			expect(vector.digestHex, `${vector.id}: domain digest`).toBe(hex(hashDomain(vector.domain, ...parts)));
			for (const field of registeredDefinition.fields.filter(({ type }) => type === "enum")) {
				const key = `${vector.kind}.${field.name}`;
				const observed = enumCoverage.get(key) ?? new Set<unknown>();
				observed.add(normalized[field.name]);
				enumCoverage.set(key, observed);
			}
			if (vector.kind === "vertex") sequenceValues.add(normalized.authorSequence);
		}

		for (const [kind, definition] of Object.entries(registry.kinds)) {
			for (const field of definition.fields.filter(({ type }) => type === "enum")) {
				expect(enumCoverage.get(`${kind}.${field.name}`), `${kind}.${field.name}: active enum vectors`).toEqual(
					new Set(field.constraints.values as unknown[])
				);
			}
		}
		for (const boundary of [0, 1, Number.MAX_SAFE_INTEGER]) {
			expect(sequenceValues.has(boundary), `vertex authorSequence ${boundary} vector`).toBe(true);
		}
		const sequenceZero = required(
			vectorDocument.vectors.find((vector) => {
				const value = hydrateCarrier(vector.normalized);
				return vector.kind === "vertex" && isPlainRecord(value) && value.authorSequence === 0;
			}),
			"authorSequence zero vector"
		);
		const sequenceOne = required(
			vectorDocument.vectors.find((vector) => {
				const value = hydrateCarrier(vector.normalized);
				return vector.kind === "vertex" && isPlainRecord(value) && value.authorSequence === 1;
			}),
			"authorSequence one vector"
		);
		const zeroInput = buildRegistryValue(registry, "vertex", sequenceZero.input);
		const oneInput = buildRegistryValue(registry, "vertex", sequenceOne.input);
		delete zeroInput.authorSequence;
		delete oneInput.authorSequence;
		expect(oneInput, "sequence discriminator must change only authorSequence").toEqual(zeroInput);
		expect(sequenceOne.canonicalHex).not.toBe(sequenceZero.canonicalHex);
		expect(sequenceOne.digestHex).not.toBe(sequenceZero.digestHex);

		const roundChangeWithNullQc = vectorDocument.vectors.find((vector) => {
			if (vector.kind !== "roundChange") return false;
			const value = hydrateCarrier(vector.normalized);
			return isPlainRecord(value) && value.highestPrepareQC === null && typeof value.anchor === "string";
		});
		expect(
			roundChangeWithNullQc,
			"roundChange must bind anchor directly even with a null highestPrepareQC"
		).toBeDefined();

		const negativeCategories = new Set(vectorDocument.negativeCases.map(({ category }) => category));
		for (const category of contract.requiredNegativeCategories) {
			expect(negativeCategories.has(category), `${category} negative`).toBe(true);
		}
		for (const candidate of vectorDocument.negativeCases) {
			expect(candidate.expected.accepted, candidate.id).toBe(false);
			expect(candidate.expected.reason.length, candidate.id).toBeGreaterThan(0);
			expect(negativeCaseLocallyRejects(registry, candidate), `${candidate.id}: locally derived rejection`).toBe(true);
		}
		const requiredReservedRejections = new Set(
			Object.entries(registry.kinds).flatMap(([kind, definition]) =>
				definition.fields.flatMap((field) =>
					Array.isArray(field.constraints.reservedValues)
						? field.constraints.reservedValues.map((value) => JSON.stringify([kind, field.name, value]))
						: []
				)
			)
		);
		const observedReservedRejections = new Set(
			vectorDocument.negativeCases
				.filter(({ category }) => category === "reserved-enum")
				.map(({ request }) => JSON.stringify([request.kind, request.field, request.value]))
		);
		expect(observedReservedRejections).toEqual(requiredReservedRejections);
		const malformedSequences = vectorDocument.negativeCases
			.filter(({ category }) => category === "malformed-author-sequence")
			.map(({ request }) => request.authorSequence);
		expect(malformedSequences).toContain(-1);
		expect(malformedSequences).toContain(Number.MAX_SAFE_INTEGER + 1);
		expect(malformedSequences).toContain(1.5);
		expect(malformedSequences).toContain("0");
		expect(malformedSequences).toContain(null);

		expect(antiCopyErrors(vectorDocument.antiCopyDiscriminator, vectorDocument.negativeCases)).toEqual([]);

		const successfulLastOrdinal = vectorDocument.issuanceCases.find((candidate) => {
			const before = candidate.request.before;
			return (
				isPlainRecord(before) &&
				before.next === Number.MAX_SAFE_INTEGER - 1 &&
				before.exhausted === false &&
				candidate.expected.accepted
			);
		});
		const lastIssuance = required(successfulLastOrdinal, "successful local issuance at MAX_SAFE_INTEGER - 1");
		expect(lastIssuanceEvidenceErrors(registry, lastIssuance)).toEqual([]);

		const exhaustionRejections = vectorDocument.issuanceCases.filter((candidate) => {
			const before = candidate.request.before;
			return isPlainRecord(before) && before.next === Number.MAX_SAFE_INTEGER && !candidate.expected.accepted;
		});
		expect(exhaustionRejections.length).toBeGreaterThanOrEqual(2);
		for (const candidate of exhaustionRejections) {
			const attemptedVertex = required(
				isPlainRecord(candidate.request.candidate) ? candidate.request.candidate : undefined,
				`${candidate.id} vertex candidate`
			);
			expect(attemptedVertex.authorSequence, candidate.id).toBe(Number.MAX_SAFE_INTEGER);
			expect(
				buildRegistryValue(registry, "vertex", attemptedVertex).authorSequence,
				`${candidate.id}: receiving MAX remains valid`
			).toBe(Number.MAX_SAFE_INTEGER);
			expect(candidate.expected.after, candidate.id).toEqual(candidate.request.before);
			expect(candidate.expected.signatureHex, candidate.id).toBeNull();
			expect(candidate.expected.registeredDigestHex, candidate.id).toBeNull();
			expect(candidate.expected.published, candidate.id).toBe(false);
		}
		expect(
			exhaustionRejections.some((candidate) => {
				const before = candidate.request.before;
				const attempted = candidate.request.candidate;
				return (
					isPlainRecord(before) &&
					isPlainRecord(attempted) &&
					(attempted.epoch !== before.epoch || attempted.anchor !== before.anchor)
				);
			}),
			"epoch/anchor change must not reset an exhausted sequence"
		).toBe(true);

		expect(vectorDocument.receivedByteCases.length).toBeGreaterThan(0);
		for (const candidate of vectorDocument.receivedByteCases) {
			expect(candidate.receivedHex, candidate.id).not.toBe(candidate.reencodedHex);
			const received = bytesFromHex(candidate.receivedHex, `${candidate.id}.receivedHex`);
			const reencoded = bytesFromHex(candidate.reencodedHex, `${candidate.id}.reencodedHex`);
			expect(candidate.receivedDigestHex, candidate.id).toBe(hex(hashDomain(candidate.domain, received)));
			expect(candidate.reencodedDigestHex, candidate.id).toBe(hex(hashDomain(candidate.domain, reencoded)));
			expect(candidate.receivedDigestHex, candidate.id).not.toBe(candidate.reencodedDigestHex);
		}

		const encodeExpected = vectorDocument.vectors.map(({ canonicalHex, digestHex, id, normalized, partsHex }) => ({
			canonicalHex,
			digestHex,
			id,
			normalized,
			partsHex,
		}));
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.vectors.map(({ id, input, kind }) => ({ id, input, kind })),
				operation: "encode-corpus",
			})
		).toEqual({ results: encodeExpected });
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.negativeCases.map(({ id, request }) => ({ id, request })),
				operation: "validate-cases",
			})
		).toEqual({
			results: vectorDocument.negativeCases.map(({ expected, id }) => ({ id, ...expected })),
		});
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.issuanceCases.map(({ id, request }) => ({ id, request })),
				operation: "issue-next",
			})
		).toEqual({
			results: vectorDocument.issuanceCases.map(({ expected, id }) => ({ id, ...expected })),
		});
		expect(
			runReference(sourcePath, {
				cases: vectorDocument.receivedByteCases.map(({ domain, id, receivedHex, reencodedHex }) => ({
					domain,
					id,
					receivedHex,
					reencodedHex,
				})),
				operation: "digest-received",
			})
		).toEqual({
			results: vectorDocument.receivedByteCases.map(({ id, receivedDigestHex, reencodedDigestHex }) => ({
				id,
				receivedDigestHex,
				reencodedDigestHex,
			})),
		});
	});
});
