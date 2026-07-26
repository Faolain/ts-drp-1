import { encodeCanonical } from "./canonical.js";
import { matchesDigestHex } from "./hash.js";
import {
	digestRegistryPreimage,
	makeRegistryPreimageBuilder,
	protocolRegistry,
	type RegistryField,
} from "./registry.js";

const registry = protocolRegistry();
const buildSignerSet = makeRegistryPreimageBuilder(registry, "signerSet");
const buildVertex = makeRegistryPreimageBuilder(registry, "vertex");
const buildSealVote = makeRegistryPreimageBuilder(registry, "sealVote");
const buildSealQc = makeRegistryPreimageBuilder(registry, "sealQC");
const digestPattern = /^[0-9a-f]{64}$/u;

function requiredRegistryField(kind: string, name: string): RegistryField {
	const field = registry.kinds[kind]?.fields.find((candidate) => candidate.name === name);
	if (field === undefined) throw new TypeError(`registry field ${kind}.${name} is missing`);
	return field;
}

function assertRegistrySort(kind: string, name: string, expected: string): void {
	const field = requiredRegistryField(kind, name);
	if (field.sortRule !== expected) {
		throw new TypeError(`registry field ${kind}.${name} must use sortRule ${expected}`);
	}
}

/** A normalized signer in the canonical signer set. */
export interface Signer {
	publicKey: string;
	signerId: string;
}

/** A signed prepare or commit vote. */
export interface QcVote {
	epoch: number;
	objectId: string;
	phase: "prepare" | "commit";
	proposalDigest: string;
	proposalHash: string;
	round: number;
	signature: string;
	signerId: string;
}

/** A quorum certificate whose votes are canonicalized by signer id. */
export interface QuorumCertificate {
	epoch: number;
	objectId: string;
	phase: "prepare" | "commit";
	proposalDigest: string;
	proposalHash: string;
	round: number;
	votes: readonly QcVote[];
}

/** Input accepted by the reference-compatible vertex builder. */
export interface VertexInput {
	anchor: string;
	author: string;
	dependencies: readonly string[];
	epoch: number;
	logicalTime: number;
	objectId: string;
	operation: Readonly<Record<string, unknown>>;
	protocolMajor?: number;
}

function fieldConstraintNumber(field: RegistryField, name: string, fallback: number): number {
	const value = field.constraints[name];
	return typeof value === "number" ? value : fallback;
}

function assertSafeInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
	}
	return value;
}

function assertDigest(value: unknown, name: string): string {
	if (typeof value !== "string" || !digestPattern.test(value)) {
		throw new TypeError(`${name} must be a lowercase 32-byte hex digest`);
	}
	return value;
}

/** Validates a reference-compatible non-empty string using UTF-16 code units. */
export function validateProtocolString(value: string, maximumUtf16Units: number): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!Number.isSafeInteger(maximumUtf16Units) ||
		maximumUtf16Units < 0 ||
		value.length > maximumUtf16Units
	) {
		throw new TypeError(`protocol string must be non-empty and at most ${maximumUtf16Units} UTF-16 units`);
	}
	return value;
}

function normalizeSigners(signers: readonly Signer[]): readonly Signer[] {
	assertRegistrySort("signerSet", "signers", "codepoint");
	const signerField = requiredRegistryField("signerSet", "signers");
	const maximum = fieldConstraintNumber(signerField, "maxSignerIdUtf16Units", 512);
	const normalized = signers.map(({ publicKey, signerId }) => {
		if (typeof publicKey !== "string") throw new TypeError("signer publicKey must be a string");
		return Object.freeze({ publicKey, signerId: validateProtocolString(signerId, maximum) });
	});
	const preimage = buildSignerSet({ signers: normalized });
	if (!Array.isArray(preimage.signers)) {
		throw new TypeError("registry signerSet.signers must produce an array");
	}
	return preimage.signers as unknown as readonly Signer[];
}

/** Encodes a signer set sorted by the registry's fixed UTF-8 byte rule. */
export function signerSetBytes(signers: readonly Signer[]): Uint8Array {
	if (!Array.isArray(signers)) throw new TypeError("signer set must be an array");
	return encodeCanonical(normalizeSigners(signers));
}

type SignedVotePreimage = Readonly<Record<string, unknown>> & { readonly signerId: string };

function normalizeVote(vote: QcVote): SignedVotePreimage {
	const signerField = requiredRegistryField("sealVote", "signerId");
	const preimage = buildSealVote({
		objectId: validateProtocolString(vote.objectId, 1024),
		epoch: assertSafeInteger(vote.epoch, "epoch", 0),
		round: assertSafeInteger(vote.round, "round", 0),
		phase: vote.phase,
		proposalDigest: assertDigest(vote.proposalDigest, "proposalDigest"),
		proposalHash: assertDigest(vote.proposalHash, "proposalHash"),
		signerId: validateProtocolString(vote.signerId, fieldConstraintNumber(signerField, "maximumUtf16Units", 512)),
	});
	if (typeof vote.signature !== "string") throw new TypeError("vote signature must be a string");
	return Object.freeze({ ...preimage, signature: vote.signature, signerId: vote.signerId });
}

/** Encodes QC bytes with votes sorted by the registry's signer-id rule. */
export function quorumCertificateBytes(certificate: QuorumCertificate): Uint8Array {
	assertRegistrySort("sealQC", "votes", "codepoint");
	if (!Array.isArray(certificate.votes)) throw new TypeError("sealQC.votes must be an array");
	const votes = certificate.votes.map(normalizeVote);
	const preimage = buildSealQc({
		objectId: validateProtocolString(certificate.objectId, 1024),
		epoch: assertSafeInteger(certificate.epoch, "epoch", 0),
		round: assertSafeInteger(certificate.round, "round", 0),
		phase: certificate.phase,
		proposalDigest: assertDigest(certificate.proposalDigest, "proposalDigest"),
		proposalHash: assertDigest(certificate.proposalHash, "proposalHash"),
		votes,
	});
	if (votes.length === 0) throw new TypeError("EMPTY_QC: quorum certificate must contain at least one vote");
	const boundFields = ["objectId", "epoch", "round", "phase", "proposalDigest", "proposalHash"] as const;
	for (const vote of votes) {
		for (const field of boundFields) {
			if (vote[field] !== preimage[field]) {
				throw new TypeError(`MIXED_QC: vote ${vote.signerId} disagrees with certificate ${field}`);
			}
		}
	}
	return encodeCanonical(preimage);
}

/** Builds a validated vertex preimage in registry field order. */
export function vertexPreimage(input: VertexInput): Readonly<Record<string, unknown>> {
	const definition = registry.kinds.vertex;
	if (definition === undefined) throw new Error("vertex registry kind is missing");
	const fields = Object.fromEntries(definition.fields.map((field) => [field.name, field])) as Record<
		string,
		RegistryField
	>;
	const dependencies = input.dependencies.map((dependency) => assertDigest(dependency, "dependency"));
	if (input.operation === null || typeof input.operation !== "object" || Array.isArray(input.operation)) {
		throw new TypeError("operation must be a canonical object");
	}
	const protocolMajor = input.protocolMajor ?? fields.protocolMajor?.const;
	return buildVertex({
		protocolMajor,
		objectId: validateProtocolString(
			input.objectId,
			fieldConstraintNumber(fields.objectId as RegistryField, "maximumUtf16Units", 1024)
		),
		epoch: assertSafeInteger(input.epoch, "epoch", 0),
		anchor: assertDigest(input.anchor, "anchor"),
		author: validateProtocolString(
			input.author,
			fieldConstraintNumber(fields.author as RegistryField, "maximumUtf16Units", 1024)
		),
		logicalTime: assertSafeInteger(input.logicalTime, "logicalTime", 1),
		dependencies,
		operation: input.operation,
	});
}

/** Computes the registered ts-drp/vertex/v2 digest from a validated vertex envelope. */
export function vertexDigest(input: VertexInput): Uint8Array {
	const preimage = vertexPreimage(input);
	return digestRegistryPreimage(registry, "vertex", preimage);
}

/** Verifies a declared vertex hash using the package-owned registered digest implementation. */
export function verifyVertexHash(vertex: unknown): boolean {
	if (vertex === null || typeof vertex !== "object" || Array.isArray(vertex)) return false;
	try {
		const envelope = vertex as Readonly<Record<string, unknown>>;
		const definition = registry.kinds.vertex;
		if (
			definition === undefined ||
			envelope.kind !== "drp-vertex" ||
			definition.fields.some((field) => field.required && !Object.hasOwn(envelope, field.name))
		) {
			return false;
		}
		return matchesDigestHex(envelope.hash, vertexDigest(envelope as unknown as VertexInput));
	} catch {
		return false;
	}
}

/** Returns the registry-pinned BFT quorum q(n) = ceil(2n/3). */
export function quorumSize(signerCount: number): number {
	if (!Number.isSafeInteger(signerCount) || signerCount <= 0) {
		throw new RangeError("signerCount must be a positive safe integer");
	}
	if (registry.quorum.callerSuppliedMaxByzantine !== false || registry.quorum.q !== "ceil(2*n/3)") {
		throw new Error("registry must forbid caller-supplied maxByzantine");
	}
	return Math.ceil((2 * signerCount) / 3);
}
