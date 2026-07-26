import { matchesDigestHex } from "./hash.js";
import { verifyVertexHash } from "./protocol.js";
import { digestRegistryPreimage, protocolRegistry } from "./registry.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const registry = protocolRegistry();

/** Identity and capacity expected by the vertex admission path. */
export interface AdmissionContext {
	currentAnchor: string;
	currentEpoch: number;
	maxBytes: number;
	maxDependencies: number;
	objectId: string;
	protocolMajor: number;
}

/** Dependency operations invoked only after cheap identity and digest checks. */
export interface AdmissionHooks {
	isAncestor(left: string, right: string): boolean;
	resolveDependencies(dependencies: readonly string[]): readonly unknown[];
}

/** A stable admission classification. */
export interface AdmissionResult {
	code: string;
	status: "accept" | "pending" | "terminal";
}

function terminal(code: string): AdmissionResult {
	return Object.freeze({ status: "terminal", code });
}

function pending(code: string): AdmissionResult {
	return Object.freeze({ status: "pending", code });
}

function registeredEnvelopePreimage(
	kind: string,
	envelope: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
	const definition = registry.kinds[kind];
	if (definition === undefined) throw new TypeError(`unknown registry kind: ${kind}`);
	return Object.fromEntries(definition.fields.map((field) => [field.name, envelope[field.name]]));
}

function verifyEpochAnchorHash(envelope: Readonly<Record<string, unknown>>): boolean {
	try {
		return matchesDigestHex(
			envelope.hash,
			digestRegistryPreimage(registry, "epochAnchor", registeredEnvelopePreimage("epochAnchor", envelope))
		);
	} catch {
		return false;
	}
}

function asDependencyEnvelope(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function validateKnownDependency(
	vertex: Readonly<Record<string, unknown>>,
	dependencyHash: string,
	dependency: Readonly<Record<string, unknown>>,
	context: AdmissionContext
): AdmissionResult | undefined {
	if (dependency.hash !== dependencyHash) return terminal("INVALID_DEPENDENCY_ENVELOPE");
	const isAnchor = dependency.kind === "drp-epoch-anchor";
	if (
		isAnchor ? !verifyEpochAnchorHash(dependency) : dependency.kind !== "drp-vertex" || !verifyVertexHash(dependency)
	) {
		return terminal("INVALID_DEPENDENCY_ENVELOPE");
	}
	if (dependency.objectId !== context.objectId || dependency.protocolMajor !== context.protocolMajor) {
		return terminal("DEPENDENCY_DOMAIN_MISMATCH");
	}
	if (isAnchor) {
		if (dependency.hash !== context.currentAnchor || dependency.epoch !== context.currentEpoch) {
			return terminal("DEPENDENCY_WRONG_ANCHOR");
		}
	} else if (dependency.epoch !== context.currentEpoch || dependency.anchor !== context.currentAnchor) {
		return terminal("DEPENDENCY_WRONG_EPOCH");
	}
	if (!isAnchor && (dependency.logicalTime as number) >= (vertex.logicalTime as number)) {
		return terminal("NON_MONOTONE_LOGICAL_TIME");
	}
	return undefined;
}

/** Applies checks in the frozen cheap-syntax → identity → digest → dependency order. */
export function admitVertex(
	vertex: Readonly<Record<string, unknown>>,
	context: AdmissionContext,
	hooks: AdmissionHooks
): AdmissionResult {
	if (vertex === null || typeof vertex !== "object" || Array.isArray(vertex)) return terminal("MALFORMED_VERTEX");
	const encodedByteLength = vertex.encodedByteLength;
	if (typeof encodedByteLength !== "number" || !Number.isSafeInteger(encodedByteLength) || encodedByteLength < 0) {
		return terminal("MALFORMED_VERTEX");
	}
	if (encodedByteLength > context.maxBytes) return terminal("LIMIT_EXCEEDED");
	if (!Object.hasOwn(vertex, "dependencies")) {
		return terminal("MISSING_DEPENDENCIES");
	}
	if (!Array.isArray(vertex.dependencies)) return terminal("MALFORMED_VERTEX");
	if (vertex.dependencies.length === 0) return terminal("MISSING_DEPENDENCIES");
	if (vertex.dependencies.length > context.maxDependencies) return terminal("LIMIT_EXCEEDED");
	if (!vertex.dependencies.every((dependency) => typeof dependency === "string" && digestPattern.test(dependency))) {
		return terminal("MALFORMED_VERTEX");
	}
	if (new Set(vertex.dependencies).size !== vertex.dependencies.length) return terminal("MALFORMED_VERTEX");
	const vertexDefinition = registry.kinds.vertex;
	if (
		vertexDefinition === undefined ||
		vertexDefinition.fields.some((field) => field.required && !Object.hasOwn(vertex, field.name))
	) {
		return terminal("INVALID_HASH");
	}

	if (vertex.objectId !== context.objectId) return terminal("WRONG_OBJECT");
	if (vertex.protocolMajor !== context.protocolMajor) {
		return typeof vertex.protocolMajor === "number" && vertex.protocolMajor > context.protocolMajor
			? pending("FUTURE_PROTOCOL")
			: terminal("LEGACY_PROTOCOL");
	}
	if (vertex.epoch !== context.currentEpoch) {
		return typeof vertex.epoch === "number" && vertex.epoch > context.currentEpoch
			? pending("FUTURE_EPOCH")
			: terminal("STALE_EPOCH");
	}
	if (vertex.anchor !== context.currentAnchor) return terminal("WRONG_ANCHOR");
	if (!verifyVertexHash(vertex)) return terminal("INVALID_HASH");

	const dependencyHashes = vertex.dependencies as readonly string[];
	const resolved = hooks.resolveDependencies(dependencyHashes);
	const known = new Map<string, Readonly<Record<string, unknown>>>();
	for (let index = 0; index < dependencyHashes.length; index++) {
		const dependencyHash = dependencyHashes[index] as string;
		const dependency = asDependencyEnvelope(resolved[index]);
		if (dependency === undefined) return pending("MISSING_CURRENT_EPOCH_DEPENDENCIES");
		const invalid = validateKnownDependency(vertex, dependencyHash, dependency, context);
		if (invalid !== undefined) return invalid;
		known.set(dependencyHash, dependency);
	}

	for (let left = 0; left < dependencyHashes.length; left++) {
		for (let right = left + 1; right < dependencyHashes.length; right++) {
			const a = dependencyHashes[left] as string;
			const b = dependencyHashes[right] as string;
			if (hooks.isAncestor(a, b) || hooks.isAncestor(b, a)) {
				return terminal("NON_ANTICHAIN_DEPENDENCIES");
			}
		}
	}
	if (!dependencyHashes.includes(context.currentAnchor)) {
		const reachesAnchor = dependencyHashes.every((dependencyHash) => {
			const envelope = known.get(dependencyHash);
			return envelope?.kind === "drp-epoch-anchor" || envelope?.anchor === context.currentAnchor;
		});
		if (!reachesAnchor) return terminal("NOT_GROUNDED_IN_ANCHOR");
	}
	return Object.freeze({ status: "accept", code: "ADMISSIBLE" });
}
