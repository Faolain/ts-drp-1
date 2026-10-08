import type { DurableIssuancePruningReceipt } from "@ts-drp/issuance-store/maintenance";
import type { AheReclamationReceipt } from "@ts-drp/storage/maintenance";

const INPUT_KEYS = Object.freeze(["aheReceipt", "issuanceReceipt", "successor"] as const);

export const D109D_RUNTIME_RECLAMATION_ERROR_CODES = Object.freeze([
	"D109D_INVALID_ARGUMENT",
	"D109D_RECEIPT_MISMATCH",
	"D109D_IDENTITY_MISMATCH",
	"D109D_RUNTIME_NOT_READY",
	"D109D_INTERNAL_INVARIANT",
] as const);

export type D109dRuntimeReclamationErrorCode = (typeof D109D_RUNTIME_RECLAMATION_ERROR_CODES)[number];

export type D109dRuntimeCensus = Readonly<{
	applicationAuthors: number;
	applicationCharges: number;
	applicationVertices: number;
	blueprintState: boolean;
	causalityIndex: number;
	creatorCloseDerivedCommitment: boolean;
	creatorCloseDurableReplay: boolean;
	creatorCloseGraph: boolean;
	creatorClosePersistedSnapshot: boolean;
	creatorCloseStagedSnapshot: boolean;
	displacedRebaseCursor: boolean;
	displacedSource: boolean;
	epochBytes: number;
	graphVersion: number;
	hotPredecessor: boolean;
	latchedOperations: number;
	pendingIngress: number;
	pendingIngressBytes: number;
	publication: boolean;
	quarantine: number;
	rebase: boolean;
	retainedPayloadMetadata: boolean;
}>;

export type D109dRuntimeReclamationResult =
	| Readonly<{
			after: D109dRuntimeCensus;
			before: D109dRuntimeCensus;
			closedEpoch: number;
			objectId: string;
			ok: true;
			replay: boolean;
			successorEpoch: number;
	  }>
	| Readonly<{ readonly code: D109dRuntimeReclamationErrorCode; readonly ok: false }>;

export type D109dRuntimeReclamationInput = Readonly<{
	readonly aheReceipt: AheReclamationReceipt;
	readonly issuanceReceipt: DurableIssuancePruningReceipt;
	readonly successor: object;
}>;

export type CreatorCloseRuntimeReleaseCensus = Readonly<{
	readonly derivedCommitment: boolean;
	readonly durableReplay: boolean;
	readonly graph: boolean;
	readonly persistedSnapshot: boolean;
	readonly stagedSnapshot: boolean;
}>;

export type CreatorCloseRuntimeReleasePlan = Readonly<{
	readonly after: CreatorCloseRuntimeReleaseCensus;
	readonly before: CreatorCloseRuntimeReleaseCensus;
	release(): boolean;
}>;

type RuntimeReclamationKernel = (input: D109dRuntimeReclamationInput) => Promise<D109dRuntimeReclamationResult>;
type CreatorCloseRuntimeReleaseOwner = (plane: object) => CreatorCloseRuntimeReleasePlan | undefined;

let runtimeKernel: RuntimeReclamationKernel | undefined;
let creatorCloseReleaseOwner: CreatorCloseRuntimeReleaseOwner | undefined;

function invalid(): D109dRuntimeReclamationResult {
	return Object.freeze({ code: "D109D_INVALID_ARGUMENT" as const, ok: false as const });
}

function captureInput(value: unknown): D109dRuntimeReclamationInput | undefined {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== INPUT_KEYS.length ||
			keys.some((key) => typeof key !== "string" || !INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number]))
		) {
			return undefined;
		}
		const captured = Object.create(null) as Record<string, unknown>;
		for (const key of INPUT_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
			captured[key] = descriptor.value;
		}
		if (captured.successor === null || typeof captured.successor !== "object") return undefined;
		return Object.freeze({
			aheReceipt: captured.aheReceipt as AheReclamationReceipt,
			issuanceReceipt: captured.issuanceReceipt as DurableIssuancePruningReceipt,
			successor: captured.successor,
		});
	} catch {
		return undefined;
	}
}

/**
 * Installs the sole v3 registration reclamation kernel.
 * @param owner - Private runtime owner.
 * @returns Whether the first owner was installed.
 */
export function installV3RuntimeReclamationKernel(owner: RuntimeReclamationKernel): boolean {
	if (runtimeKernel !== undefined || typeof owner !== "function") return false;
	runtimeKernel = owner;
	return true;
}

/**
 * Installs the sole creator-close duplicate-release owner.
 * @param owner - Private creator-close owner.
 * @returns Whether the first owner was installed.
 */
export function installCreatorCloseRuntimeRelease(owner: CreatorCloseRuntimeReleaseOwner): boolean {
	if (creatorCloseReleaseOwner !== undefined || typeof owner !== "function") return false;
	creatorCloseReleaseOwner = owner;
	return true;
}

/**
 * Prepares a no-throw creator-close release before runtime mutation starts.
 * @param plane - Genuine retired predecessor handle.
 * @returns Prepared release and exact before/after census when ready.
 */
export function prepareCreatorCloseRuntimeRelease(plane: object): CreatorCloseRuntimeReleasePlan | undefined {
	try {
		return creatorCloseReleaseOwner?.(plane);
	} catch {
		return undefined;
	}
}

/**
 * Releases receipt-covered installed-v3 predecessor retention.
 * @param value - Exact receipt pair and genuine current successor handle.
 * @returns Frozen success census or a closed fail-closed refusal.
 */
export function reclaimInstalledV3Runtime(value: unknown): Promise<D109dRuntimeReclamationResult> {
	const input = captureInput(value);
	if (input === undefined) return Promise.resolve(invalid());
	if (runtimeKernel === undefined) {
		return Promise.resolve(Object.freeze({ code: "D109D_INTERNAL_INVARIANT" as const, ok: false as const }));
	}
	try {
		return Promise.resolve(runtimeKernel(input)).catch(() =>
			Object.freeze({ code: "D109D_INTERNAL_INVARIANT" as const, ok: false as const })
		);
	} catch {
		return Promise.resolve(Object.freeze({ code: "D109D_INTERNAL_INVARIANT" as const, ok: false as const }));
	}
}
