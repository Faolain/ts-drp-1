import type { ExactSealCarrier } from "../index.js";

export interface SealVoteIntentData {
	readonly anchor: string;
	readonly carrier: ExactSealCarrier;
	readonly epoch: number;
	readonly expectedIncarnation: string;
	readonly expectedRevision: number;
	readonly objectId: string;
	readonly phase: "commit" | "prepare";
	readonly prepareQC: Readonly<{ digest: string; round: number; valueDigest: string }> | null;
	readonly round: number;
	readonly signerId: string;
	readonly valueDigest: string;
}

export interface SealRoundChangeIntentData {
	readonly anchor: string;
	readonly carrier: ExactSealCarrier;
	readonly epoch: number;
	readonly expectedIncarnation: string;
	readonly expectedRevision: number;
	readonly highestPrepareQcBytes: Uint8Array | null;
	readonly objectId: string;
	readonly round: number;
	readonly signerId: string;
}

export interface SealVoterEnrollmentData {
	readonly anchor: string;
	readonly epoch: number;
	readonly expectedIncarnation: string;
	readonly objectId: string;
	readonly signerId: string;
}

declare const sealStorePortBrand: unique symbol;
declare const sealVoterEnrollmentBrand: unique symbol;

export interface SealStorePort {
	readonly [sealStorePortBrand]: true;
}

export interface SealVoterEnrollment {
	readonly [sealVoterEnrollmentBrand]: true;
}

export interface SealStoreAdapter {
	commitQc?(enrollment: SealVoterEnrollment, input: unknown): Promise<unknown>;
	commitRoundChange?(intent: object): Promise<unknown>;
	commitVote(intent: object): Promise<unknown>;
	openSnapshot(enrollment: SealVoterEnrollment): Promise<unknown>;
}

const intentData = new WeakMap<object, SealVoteIntentData>();
const roundChangeIntentData = new WeakMap<object, SealRoundChangeIntentData>();
const enrollmentData = new WeakMap<SealVoterEnrollment, SealVoterEnrollmentData>();
const storeAdapters = new WeakMap<SealStorePort, SealStoreAdapter>();
const voterPorts = new WeakSet<object>();

function copiedCarrier(carrier: ExactSealCarrier): ExactSealCarrier {
	return Object.freeze({
		exactCanonicalPreimageBytes: Uint8Array.from(carrier.exactCanonicalPreimageBytes),
		signature: Uint8Array.from(carrier.signature),
	});
}

function copiedPrepareQC(
	value: Readonly<{ digest: string; round: number; valueDigest: string }> | null
): Readonly<{ digest: string; round: number; valueDigest: string }> | null {
	return value === null ? null : Object.freeze({ ...value });
}

/**
 * Mints one fieldless, destructive-use vote intent.
 * @param data - Fully validated voter transition.
 * @returns One-use opaque intent.
 */
export function mintSealVoteIntent(data: SealVoteIntentData): object {
	const captured = Object.freeze({
		...data,
		carrier: copiedCarrier(data.carrier),
		prepareQC: copiedPrepareQC(data.prepareQC),
	});
	const intent = Object.freeze({});
	intentData.set(intent, captured);
	return intent;
}

/**
 * Destructively resolves one genuine vote intent.
 * @param value - Candidate intent.
 * @returns Detached transition, or undefined for foreign/consumed input.
 */
export function consumeSealVoteIntent(value: unknown): SealVoteIntentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = intentData.get(value);
	if (captured === undefined) return undefined;
	intentData.delete(value);
	return Object.freeze({
		...captured,
		carrier: copiedCarrier(captured.carrier),
		prepareQC: copiedPrepareQC(captured.prepareQC),
	});
}

/**
 * Mints one fieldless, destructive-use round-change intent.
 * @param data - Fully verified signed round-change transition.
 * @returns One-use opaque intent.
 */
export function mintSealRoundChangeIntent(data: SealRoundChangeIntentData): object {
	const captured = Object.freeze({
		...data,
		carrier: copiedCarrier(data.carrier),
		highestPrepareQcBytes: data.highestPrepareQcBytes === null ? null : Uint8Array.from(data.highestPrepareQcBytes),
	});
	const intent = Object.freeze({});
	roundChangeIntentData.set(intent, captured);
	return intent;
}

/**
 * Destructively resolves one genuine round-change intent.
 * @param value - Candidate intent.
 * @returns Detached transition, or undefined for foreign/consumed input.
 */
export function consumeSealRoundChangeIntent(value: unknown): SealRoundChangeIntentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = roundChangeIntentData.get(value);
	if (captured === undefined) return undefined;
	roundChangeIntentData.delete(value);
	return Object.freeze({
		...captured,
		carrier: copiedCarrier(captured.carrier),
		highestPrepareQcBytes:
			captured.highestPrepareQcBytes === null ? null : Uint8Array.from(captured.highestPrepareQcBytes),
	});
}

/**
 * Mints fieldless voter enrollment from authenticated protocol identity.
 * @param data - Certified identity and expected storage incarnation.
 * @returns Opaque enrollment.
 */
export function mintSealVoterEnrollment(data: SealVoterEnrollmentData): SealVoterEnrollment {
	const enrollment = Object.freeze({}) as SealVoterEnrollment;
	enrollmentData.set(enrollment, Object.freeze({ ...data }));
	return enrollment;
}

/**
 * Resolves detached authenticated voter enrollment.
 * @param value - Candidate enrollment.
 * @returns Detached enrollment, or undefined for foreign input.
 */
export function resolveSealVoterEnrollment(value: unknown): SealVoterEnrollmentData | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const captured = enrollmentData.get(value as SealVoterEnrollment);
	return captured === undefined ? undefined : Object.freeze({ ...captured });
}

/**
 * Brands one package-internal mechanical adapter as the only store shape accepted by the voter.
 * @param adapter - Captured mechanical adapter.
 * @returns Fieldless branded store port.
 */
export function mintSealStorePort(adapter: SealStoreAdapter): SealStorePort {
	const port = Object.freeze({}) as SealStorePort;
	storeAdapters.set(
		port,
		Object.freeze({
			...(adapter.commitQc === undefined ? {} : { commitQc: adapter.commitQc.bind(adapter) }),
			...(adapter.commitRoundChange === undefined
				? {}
				: { commitRoundChange: adapter.commitRoundChange.bind(adapter) }),
			commitVote: adapter.commitVote.bind(adapter),
			openSnapshot: adapter.openSnapshot.bind(adapter),
		})
	);
	return port;
}

/**
 * Resolves a genuine branded store port for voter composition.
 * @param value - Candidate store port.
 * @returns Captured adapter, or undefined for foreign input.
 */
export function resolveSealStorePort(value: unknown): SealStoreAdapter | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return storeAdapters.get(value as SealStorePort);
}

/**
 * Registers one genuine voter handle without changing its public shape.
 * @param handle - Frozen voter handle.
 * @returns The same authenticated handle.
 */
export function mintSealVoterPort<T extends object>(handle: T): T {
	voterPorts.add(handle);
	return handle;
}

/**
 * Tests whether a candidate is a voter minted by this package instance.
 * @param value - Candidate voter handle.
 * @returns True only for an authenticated voter.
 */
export function isSealVoterPort(value: unknown): value is object {
	return value !== null && typeof value === "object" && voterPorts.has(value);
}
