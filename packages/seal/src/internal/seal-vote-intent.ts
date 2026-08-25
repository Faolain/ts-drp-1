import type { ExactSealCarrier } from "../index.js";

export interface SealVoteIntentData {
	readonly anchor: string;
	readonly carrier: ExactSealCarrier;
	readonly expectedIncarnation: string;
	readonly expectedRevision: number;
	readonly objectId: string;
	readonly phase: "commit" | "prepare";
	readonly prepareQC: Readonly<{ digest: string; round: number; valueDigest: string }> | null;
	readonly round: number;
	readonly signerId: string;
	readonly valueDigest: string;
}

export interface SealVoterEnrollmentData {
	readonly anchor: string;
	readonly epoch: 0;
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
	commitVote(intent: object): Promise<unknown>;
	commitRound?(enrollment: SealVoterEnrollment, input: unknown): Promise<unknown>;
	openSnapshot(enrollment: SealVoterEnrollment): Promise<unknown>;
}

const intentData = new WeakMap<object, SealVoteIntentData>();
const enrollmentData = new WeakMap<SealVoterEnrollment, SealVoterEnrollmentData>();
const storeAdapters = new WeakMap<SealStorePort, SealStoreAdapter>();

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
			commitVote: adapter.commitVote.bind(adapter),
			...(adapter.commitRound === undefined ? {} : { commitRound: adapter.commitRound.bind(adapter) }),
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
