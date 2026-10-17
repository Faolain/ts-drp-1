export interface SealSigningRequest {
	readonly __sealSigningRequest?: never;
}

export interface SigningRequestScope {
	readonly objectId: string;
	readonly epoch: number;
	readonly round: number;
	readonly signerId: string;
	readonly publicKey: Uint8Array;
}
export interface SigningNativeAdmission {
	check(): Promise<void>;
	release(): Promise<void>;
}
export class SigningAdmissionRefusal extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "SigningAdmissionRefusal";
	}
}
export type SigningNativeAdmissionFactory = (scope: SigningRequestScope) => Promise<SigningNativeAdmission>;
export interface CapturedSigningRequest {
	readonly digest: Uint8Array;
	readonly scope: SigningRequestScope | undefined;
	readonly admission: SigningNativeAdmissionFactory | undefined;
}

/** Internal-module custody: facts originate in the authenticated codec owner. */
export function captureSigningRequestScope(scope: SigningRequestScope): SigningRequestScope {
	const fields = ["objectId", "epoch", "round", "signerId", "publicKey"];
	if (scope === null || typeof scope !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(scope)))
		throw new TypeError("INVALID_SIGNING_REQUEST_SCOPE");
	const keys = Reflect.ownKeys(scope),
		descriptors = Object.getOwnPropertyDescriptors(scope);
	if (
		keys.length !== fields.length ||
		keys.some(
			(key) =>
				typeof key !== "string" ||
				!fields.includes(key) ||
				!descriptors[key]?.enumerable ||
				!("value" in descriptors[key])
		)
	)
		throw new TypeError("INVALID_SIGNING_REQUEST_SCOPE");
	if (
		typeof scope.objectId !== "string" ||
		!scope.objectId ||
		scope.objectId.includes("\0") ||
		typeof scope.signerId !== "string" ||
		!scope.signerId ||
		scope.signerId.includes("\0") ||
		!Number.isSafeInteger(scope.epoch) ||
		scope.epoch < 0 ||
		!Number.isSafeInteger(scope.round) ||
		scope.round < 0 ||
		Object.getPrototypeOf(scope.publicKey) !== Uint8Array.prototype ||
		scope.publicKey.byteLength !== 32
	)
		throw new TypeError("INVALID_SIGNING_REQUEST_SCOPE");
	return Object.freeze({
		objectId: scope.objectId,
		epoch: scope.epoch,
		round: scope.round,
		signerId: scope.signerId,
		publicKey: Uint8Array.from(scope.publicKey),
	});
}

const requestDigests = new WeakMap<SealSigningRequest, CapturedSigningRequest>();

/**
 * Mints a one-use request for the exact digest authored by the seal codec owner.
 * @param digest - Detached registered seal-vote digest.
 * @returns Fieldless signing authority consumed by finality custody.
 */
export function mintSealSigningRequest(digest: Uint8Array, scope?: SigningRequestScope): SealSigningRequest {
	const request = Object.freeze({}) as SealSigningRequest;
	requestDigests.set(request, {
		digest: Uint8Array.from(digest),
		scope: scope === undefined ? undefined : captureSigningRequestScope(scope),
		admission: undefined,
	});
	return request;
}

/** Trusted original actor binds custody from its resolved genuine native facade. */
export function bindSealSigningRequest(request: SealSigningRequest, admission: SigningNativeAdmissionFactory): void {
	const captured = requestDigests.get(request);
	if (captured?.scope === undefined || captured.admission !== undefined || typeof admission !== "function")
		throw new TypeError("UNTRUSTED_SIGNING_ADMISSION_BINDING");
	requestDigests.set(request, { ...captured, admission });
}

/**
 * Destructively resolves one protocol-authored seal signing request.
 * @param request - Candidate request.
 * @returns Detached digest, or undefined for foreign/already-consumed input.
 */
export function consumeSealSigningRequest(request: unknown): CapturedSigningRequest | undefined {
	if (request === null || typeof request !== "object") return undefined;
	const captured = requestDigests.get(request as SealSigningRequest);
	if (captured === undefined) return undefined;
	requestDigests.delete(request as SealSigningRequest);
	return Object.freeze({
		...captured,
		digest: Uint8Array.from(captured.digest),
		scope: captured.scope === undefined ? undefined : captureSigningRequestScope(captured.scope),
	});
}
