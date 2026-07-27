import { decodeCanonical, deepCloneCanonical, encodeCanonical } from "./canonical.js";
import type { ActiveCryptoSuiteId } from "./crypto-suite.js";
import { matchesDigestHex } from "./hash.js";
import { verifyVertexHash, vertexDigest } from "./protocol.js";
import {
	compareProtocolStrings,
	digestRegistryPreimage,
	makeRegistryPreimageBuilder,
	protocolRegistry,
	registryDomain,
} from "./registry.js";
import { type SignaturePublicKey, verifyRegisteredSignature } from "./signature.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const registry = protocolRegistry();
const vertexSignatureDomain = registryDomain(registry, "vertex");
const vertexDefinition = registry.kinds.vertex;
const vertexKind = vertexDefinition?.fields.find(({ name }) => name === "kind")?.const;
const epochAnchorDefinition = registry.kinds.epochAnchor;
const epochAnchorKind = epochAnchorDefinition?.fields.find(({ name }) => name === "kind")?.const;
const buildParameters = makeRegistryPreimageBuilder(registry, "parameters");
const vertexEnvelopeKeys = new Set([...(vertexDefinition?.fields.map(({ name }) => name) ?? []), "hash", "signature"]);
declare const preparedAdmissionContextBrand: unique symbol;
const preparedAdmissionContexts = new WeakSet<object>();

type RegisteredDependencyKind = "drp-epoch-anchor" | "drp-vertex";

interface ResolvedDependencySnapshot {
	readonly envelope: Readonly<Record<string, unknown>>;
	readonly kind: RegisteredDependencyKind;
}

type ResolvedDependencySnapshotResult =
	| { readonly ok: true; readonly snapshot: ResolvedDependencySnapshot }
	| { readonly ok: false; readonly reason: "invalid" | "missing" };

interface ValidatedDependencyEvidence {
	readonly kind: RegisteredDependencyKind;
	readonly logicalTime: unknown;
}

/** Anchor-bound protocol parameters consumed by vertex admission. */
export interface AdmissionParameters {
	readonly maxDependencies: number;
	readonly maxEpochBytes: number;
	readonly maxEpochVertices: number;
	readonly maxPendingBytes: number;
	readonly maxPendingEntries: number;
	readonly maxSnapshotBytes: number;
	readonly snapshotChunkBytes: number;
}

/** Identity and capacity expected by the vertex admission path. */
export interface AdmissionContext {
	cryptoSuiteId: ActiveCryptoSuiteId;
	currentAnchor: string;
	currentEpoch: number;
	currentEpochAnchor: Readonly<Record<string, unknown>>;
	isAncestor(left: string, right: string): boolean;
	objectId: string;
	parameters: AdmissionParameters;
	protocolMajor: number;
}

/** Immutable anchor-time authority handle for deterministic authorization. */
export interface HardEpochAuthority {
	readonly aclDigest: string;
	readonly anchor: string;
	readonly epoch: number;
	readonly objectId: string;
}

/** Package-prepared, detached epoch evidence accepted by the admission classifier. */
export interface PreparedAdmissionContext {
	readonly [preparedAdmissionContextBrand]: true;
	readonly cryptoSuiteId: ActiveCryptoSuiteId;
	readonly currentAnchor: string;
	readonly currentEpoch: number;
	readonly currentEpochAnchor: Readonly<Record<string, unknown>>;
	readonly epochAuthority: HardEpochAuthority;
	readonly isAncestor: AdmissionContext["isAncestor"];
	readonly objectId: string;
	readonly parameters: AdmissionParameters;
	readonly protocolMajor: number;
}

/** Stable result of validating and detaching raw epoch admission evidence. */
export type PrepareAdmissionContextResult =
	| { readonly context: PreparedAdmissionContext; readonly ok: true }
	| { readonly code: "ADMISSION_CONTEXT_INVALID"; readonly ok: false };

/** Trusted integration operations invoked only after their preceding admission stages pass. */
export interface AdmissionHooks {
	/**
	 * Resolves and evaluates the immutable anchor-time ACL state identified by
	 * `epochAuthority.aclDigest`. Implementations must never consult live epoch ACL state. The
	 * authority is a verified digest handle; it is not an unverified ACL snapshot.
	 */
	authorize(vertex: Readonly<Record<string, unknown>>, epochAuthority: HardEpochAuthority): boolean;
	isDependencyAccepted(dependencyHash: string): boolean;
	resolveAuthorPublicKey(author: string): SignaturePublicKey | undefined;
	resolveDependencies(dependencies: readonly string[]): readonly unknown[];
	validateDeterministicInvariant(vertex: Readonly<Record<string, unknown>>): boolean;
	validateOperationSchema(operation: unknown): boolean;
}

/** A stable admission classification. */
export interface AdmissionResult {
	code: string;
	latchByHash: boolean;
	status: "accept" | "pending" | "quarantine" | "terminal";
}

function terminal(code: string, latchByHash = false): AdmissionResult {
	return Object.freeze({ status: "terminal", code, latchByHash });
}

function pending(code: string): AdmissionResult {
	return Object.freeze({ status: "pending", code, latchByHash: false });
}

function quarantine(code: string): AdmissionResult {
	return Object.freeze({ status: "quarantine", code, latchByHash: false });
}

function accept(code: string): AdmissionResult {
	return Object.freeze({ status: "accept", code, latchByHash: false });
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

function snapshotResolvedDependency(value: unknown): ResolvedDependencySnapshotResult {
	try {
		const raw = asDependencyEnvelope(value);
		if (raw === undefined) return { ok: false, reason: "missing" };
		const kind = raw.kind;
		const definition =
			kind === vertexKind ? vertexDefinition : kind === epochAnchorKind ? epochAnchorDefinition : undefined;
		if (definition === undefined || (kind !== "drp-vertex" && kind !== "drp-epoch-anchor")) {
			return { ok: false, reason: "invalid" };
		}
		const envelope = Object.fromEntries(
			definition.fields.map((field) => [field.name, field.name === "kind" ? kind : raw[field.name]])
		);
		envelope.hash = raw.hash;
		return Object.freeze({
			ok: true,
			snapshot: Object.freeze({
				envelope: Object.freeze(envelope),
				kind,
			}),
		});
	} catch {
		return { ok: false, reason: "invalid" };
	}
}

function validateKnownDependency(
	dependencyHash: string,
	dependency: ResolvedDependencySnapshot,
	context: PreparedAdmissionContext
): AdmissionResult | undefined {
	const { envelope, kind } = dependency;
	if (envelope.hash !== dependencyHash) return terminal("INVALID_DEPENDENCY_ENVELOPE");
	const isAnchor = kind === "drp-epoch-anchor";
	if (isAnchor ? !verifyEpochAnchorHash(envelope) : !verifyVertexHash(envelope)) {
		return terminal("INVALID_DEPENDENCY_ENVELOPE");
	}
	if (envelope.objectId !== context.objectId || envelope.protocolMajor !== context.protocolMajor) {
		return terminal("DEPENDENCY_DOMAIN_MISMATCH");
	}
	if (isAnchor) {
		if (envelope.hash !== context.currentAnchor) return terminal("DEPENDENCY_WRONG_ANCHOR");
	} else if (envelope.epoch !== context.currentEpoch || envelope.anchor !== context.currentAnchor) {
		return terminal("DEPENDENCY_WRONG_EPOCH");
	}
	return undefined;
}

function computeVertexDigest(vertex: Readonly<Record<string, unknown>>): Uint8Array | undefined {
	try {
		return vertexDigest(vertex as never);
	} catch {
		return undefined;
	}
}

function isStrictlySorted(dependencies: readonly string[]): boolean {
	for (let index = 1; index < dependencies.length; index++) {
		if (compareProtocolStrings(dependencies[index - 1] as string, dependencies[index] as string) >= 0) {
			return false;
		}
	}
	return true;
}

function hasOnlyVertexEnvelopeKeys(vertex: Readonly<Record<string, unknown>>): boolean {
	return Reflect.ownKeys(vertex).every((key) => typeof key === "string" && vertexEnvelopeKeys.has(key));
}

function freezeDetachedCanonical(value: unknown): unknown {
	if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
	for (const key of Reflect.ownKeys(value)) {
		freezeDetachedCanonical((value as Record<PropertyKey, unknown>)[key]);
	}
	return Object.freeze(value);
}

function makeDetachedCanonicalView<T>(value: T): () => T {
	const authenticatedBytes = encodeCanonical(value);
	return () => decodeCanonical(authenticatedBytes) as T;
}

/**
 * Validates raw epoch evidence and creates a detached immutable admission snapshot.
 * @param raw - Mutable integration evidence to validate and detach.
 * @returns A branded prepared context or the stable preparation failure.
 */
export function prepareAdmissionContext(raw: AdmissionContext): PrepareAdmissionContextResult {
	try {
		const stable = Object.freeze({
			cryptoSuiteId: raw.cryptoSuiteId,
			currentAnchor: raw.currentAnchor,
			currentEpoch: raw.currentEpoch,
			isAncestor: raw.isAncestor,
			objectId: raw.objectId,
			parameters: raw.parameters,
			protocolMajor: raw.protocolMajor,
		});
		const suppliedAnchor = asDependencyEnvelope(raw.currentEpochAnchor);
		if (suppliedAnchor === undefined) return { ok: false, code: "ADMISSION_CONTEXT_INVALID" };
		const anchor: Readonly<Record<string, unknown>> = {
			...registeredEnvelopePreimage("epochAnchor", suppliedAnchor),
			hash: suppliedAnchor.hash,
		};
		if (
			anchor.kind !== "drp-epoch-anchor" ||
			!verifyEpochAnchorHash(anchor) ||
			anchor.hash !== stable.currentAnchor ||
			anchor.objectId !== stable.objectId ||
			anchor.protocolMajor !== stable.protocolMajor ||
			anchor.epoch !== stable.currentEpoch ||
			anchor.cryptoSuiteId !== stable.cryptoSuiteId ||
			typeof stable.isAncestor !== "function"
		) {
			return { ok: false, code: "ADMISSION_CONTEXT_INVALID" };
		}

		const parameters = buildParameters(stable.parameters as unknown as Readonly<Record<string, unknown>>);
		const digest = digestRegistryPreimage(registry, "parameters", parameters);
		if (!matchesDigestHex(anchor.parametersDigest, digest)) {
			return { ok: false, code: "ADMISSION_CONTEXT_INVALID" };
		}
		const frozenAnchor = Object.freeze({ ...anchor });
		const epochAuthority: HardEpochAuthority = Object.freeze({
			aclDigest: anchor.aclDigest as string,
			anchor: stable.currentAnchor,
			epoch: stable.currentEpoch,
			objectId: stable.objectId,
		});
		const prepared = Object.freeze({
			cryptoSuiteId: stable.cryptoSuiteId,
			currentAnchor: stable.currentAnchor,
			currentEpoch: stable.currentEpoch,
			currentEpochAnchor: frozenAnchor,
			epochAuthority,
			isAncestor: stable.isAncestor,
			objectId: stable.objectId,
			parameters: parameters as unknown as AdmissionParameters,
			protocolMajor: stable.protocolMajor,
		}) as PreparedAdmissionContext;
		preparedAdmissionContexts.add(prepared);
		return Object.freeze({ ok: true, context: prepared });
	} catch {
		return { ok: false, code: "ADMISSION_CONTEXT_INVALID" };
	}
}

function missingHook(hooks: AdmissionHooks, name: keyof AdmissionHooks): boolean {
	return typeof hooks?.[name] !== "function";
}

/**
 * Applies the D3-compatible fail-closed pipeline. The author signature covers the raw registered
 * vertex digest; `hash` and `signature` remain outside that registered preimage.
 *
 * Wire-byte measurement and rejection are transport-local obligations and occur before this function.
 * `vertex` contains exactly the registered vertex fields plus `hash` and `signature`; transport metadata
 * is never embedded in the consensus envelope.
 * @param vertex - Exact decoded canonical vertex envelope.
 * @param context - Current object, epoch, cryptographic, and exact-ancestry context.
 * @param hooks - Required trusted resolvers and deterministic semantic validators.
 * @returns A stable accept, pending, quarantine, or terminal classification,
 * including whether the authenticated envelope hash may be latched.
 */
export function admitVertex(
	vertex: Readonly<Record<string, unknown>>,
	context: PreparedAdmissionContext,
	hooks: AdmissionHooks
): AdmissionResult {
	if (!preparedAdmissionContexts.has(context as object)) return terminal("ADMISSION_CONTEXT_UNPREPARED");
	if (vertex === null || typeof vertex !== "object" || Array.isArray(vertex)) return terminal("MALFORMED_VERTEX");
	if (!hasOnlyVertexEnvelopeKeys(vertex)) return quarantine("NON_CANONICAL_ENVELOPE");
	let candidateKind: unknown;
	try {
		candidateKind = vertex.kind;
	} catch {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	if (candidateKind !== vertexKind) return quarantine("NON_CANONICAL_ENVELOPE");
	if (!Object.hasOwn(vertex, "dependencies")) {
		return terminal("MISSING_DEPENDENCIES");
	}
	let rawDependencies: unknown;
	try {
		rawDependencies = vertex.dependencies;
	} catch {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	if (!Array.isArray(rawDependencies)) return quarantine("NON_CANONICAL_ENVELOPE");
	const dependencyCount = rawDependencies.length;
	if (dependencyCount === 0) return terminal("MISSING_DEPENDENCIES");
	if (dependencyCount > context.parameters.maxDependencies) return terminal("LIMIT_EXCEEDED");
	const dependencySnapshot: unknown[] = [];
	try {
		for (let index = 0; index < dependencyCount; index++) {
			if (!Object.hasOwn(rawDependencies, index)) return quarantine("NON_CANONICAL_ENVELOPE");
			dependencySnapshot.push(rawDependencies[index]);
		}
	} catch {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	const dependencies = Object.freeze(dependencySnapshot);
	if (!dependencies.every((dependency) => typeof dependency === "string" && digestPattern.test(dependency))) {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	// Representation quarantine must precede registry uniqueness, which otherwise reports INVALID_HASH.
	if (new Set(dependencies).size !== dependencies.length) {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	if (!isStrictlySorted(dependencies as readonly string[])) return quarantine("NON_CANONICAL_ENVELOPE");
	if (
		vertexDefinition === undefined ||
		vertexDefinition.fields.some((field) => field.required && !Object.hasOwn(vertex, field.name))
	) {
		return terminal("INVALID_HASH");
	}
	let identity: Readonly<Record<"anchor" | "epoch" | "kind" | "objectId" | "protocolMajor", unknown>>;
	try {
		identity = Object.freeze({
			anchor: vertex.anchor,
			epoch: vertex.epoch,
			kind: candidateKind,
			objectId: vertex.objectId,
			protocolMajor: vertex.protocolMajor,
		});
	} catch {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	if (identity.objectId !== context.objectId) return terminal("WRONG_OBJECT");
	if (identity.protocolMajor !== context.protocolMajor) {
		return typeof identity.protocolMajor === "number" && identity.protocolMajor > context.protocolMajor
			? pending("FUTURE_PROTOCOL")
			: terminal("LEGACY_PROTOCOL");
	}
	if (identity.epoch !== context.currentEpoch) {
		return typeof identity.epoch === "number" && identity.epoch > context.currentEpoch
			? pending("FUTURE_EPOCH")
			: terminal("STALE_EPOCH");
	}
	if (identity.anchor !== context.currentAnchor) return terminal("WRONG_ANCHOR");

	if (context.cryptoSuiteId !== "ed25519-sha256-v1") return terminal("CRYPTO_SUITE_UNAVAILABLE");

	let candidate: Readonly<Record<string, unknown>>;
	try {
		const signature = vertex.signature;
		const operation = freezeDetachedCanonical(deepCloneCanonical(vertex.operation));
		candidate = Object.freeze({
			...Object.fromEntries(
				vertexDefinition.fields.map((field) => [
					field.name,
					field.name === "dependencies"
						? dependencies
						: field.name === "operation"
							? operation
							: Object.hasOwn(identity, field.name)
								? identity[field.name as keyof typeof identity]
								: vertex[field.name],
				])
			),
			hash: vertex.hash,
			signature: signature instanceof Uint8Array ? new Uint8Array(signature) : signature,
		});
	} catch {
		return quarantine("NON_CANONICAL_ENVELOPE");
	}
	const registeredDigest = computeVertexDigest(candidate);
	if (registeredDigest === undefined || !matchesDigestHex(candidate.hash, registeredDigest)) {
		return terminal("INVALID_HASH");
	}

	if (missingHook(hooks, "resolveAuthorPublicKey")) return terminal("AUTHOR_KEY_RESOLVER_UNAVAILABLE");
	const publicKey = typeof candidate.author === "string" ? hooks.resolveAuthorPublicKey(candidate.author) : undefined;
	if (
		publicKey === undefined ||
		!(candidate.signature instanceof Uint8Array) ||
		!verifyRegisteredSignature({
			expectedScope: { anchor: context.currentAnchor, domain: vertexSignatureDomain },
			publicKey,
			registeredDigest: {
				anchor: candidate.anchor as string,
				bytes: registeredDigest,
				domain: vertexSignatureDomain,
			},
			signature: candidate.signature,
			suiteId: context.cryptoSuiteId,
		})
	) {
		return terminal("INVALID_SIGNATURE");
	}

	const dependencyHashes = dependencies as readonly string[];
	if (missingHook(hooks, "resolveDependencies")) return terminal("DEPENDENCY_RESOLVER_UNAVAILABLE");
	const resolved = hooks.resolveDependencies(dependencyHashes);
	if (!Array.isArray(resolved) || resolved.length !== dependencyHashes.length) {
		return pending("MISSING_CURRENT_EPOCH_DEPENDENCIES");
	}
	const known = new Map<string, ValidatedDependencyEvidence>();
	for (let index = 0; index < dependencyHashes.length; index++) {
		const dependencyHash = dependencyHashes[index] as string;
		const captured = snapshotResolvedDependency(resolved[index]);
		if (!captured.ok) {
			return captured.reason === "missing"
				? pending("MISSING_CURRENT_EPOCH_DEPENDENCIES")
				: terminal("INVALID_DEPENDENCY_ENVELOPE");
		}
		const dependency = captured.snapshot;
		const invalid = validateKnownDependency(dependencyHash, dependency, context);
		if (invalid !== undefined) return invalid;
		known.set(
			dependencyHash,
			Object.freeze({
				kind: dependency.kind,
				logicalTime: dependency.envelope.logicalTime,
			})
		);
	}

	if (missingHook(hooks, "isDependencyAccepted")) {
		return terminal("DEPENDENCY_ACCEPTANCE_ORACLE_UNAVAILABLE");
	}
	for (const dependencyHash of dependencyHashes) {
		if (hooks.isDependencyAccepted(dependencyHash) !== true) return pending("UNACCEPTED_DEPENDENCIES");
	}

	const maximumDependencyTime = dependencyHashes.reduce((maximum, dependencyHash) => {
		const dependency = known.get(dependencyHash);
		const logicalTime = dependency?.kind === "drp-epoch-anchor" ? 0 : dependency?.logicalTime;
		return typeof logicalTime === "number" && Number.isSafeInteger(logicalTime)
			? Math.max(maximum, logicalTime)
			: Number.NaN;
	}, 0);
	if (!Number.isSafeInteger(maximumDependencyTime) || candidate.logicalTime !== maximumDependencyTime + 1) {
		return terminal("INVALID_LOGICAL_TIME", true);
	}

	for (let left = 0; left < dependencyHashes.length; left++) {
		for (let right = left + 1; right < dependencyHashes.length; right++) {
			const a = dependencyHashes[left] as string;
			const b = dependencyHashes[right] as string;
			const aIsAncestor = context.isAncestor(a, b);
			if (typeof aIsAncestor !== "boolean") return terminal("ADMISSION_CONTEXT_INVALID");
			if (aIsAncestor) return terminal("NON_ANTICHAIN_DEPENDENCIES", true);
			const bIsAncestor = context.isAncestor(b, a);
			if (typeof bIsAncestor !== "boolean") return terminal("ADMISSION_CONTEXT_INVALID");
			if (bIsAncestor) return terminal("NON_ANTICHAIN_DEPENDENCIES", true);
		}
	}

	if (missingHook(hooks, "authorize")) return terminal("AUTHORIZATION_UNAVAILABLE");
	const detachedCandidateView = makeDetachedCanonicalView(candidate);
	let authorized: boolean;
	try {
		authorized = hooks.authorize(detachedCandidateView(), context.epochAuthority);
	} catch {
		return terminal("AUTHORIZATION_EXCEPTION");
	}
	if (authorized !== true) return terminal("UNAUTHORIZED", true);
	if (missingHook(hooks, "validateOperationSchema")) return terminal("OPERATION_SCHEMA_VALIDATOR_UNAVAILABLE");
	if (hooks.validateOperationSchema(detachedCandidateView().operation) !== true) {
		return terminal("INVALID_OPERATION_SCHEMA", true);
	}
	if (missingHook(hooks, "validateDeterministicInvariant")) {
		return terminal("DETERMINISTIC_INVARIANT_VALIDATOR_UNAVAILABLE");
	}
	if (hooks.validateDeterministicInvariant(detachedCandidateView()) !== true) {
		return terminal("INVARIANT_VIOLATION", true);
	}
	return accept("ADMISSIBLE");
}
