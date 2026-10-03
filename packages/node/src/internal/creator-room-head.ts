const ROOM_HEAD_KEYS = Object.freeze(["currentAnchorDigest", "epoch", "objectId"]);
const LOWER_HEX_256 = /^[0-9a-f]{64}$/u;

export interface CreatorExpectedRoomHead {
	readonly currentAnchorDigest: string;
	readonly epoch: number;
	readonly objectId: string;
}

/**
 * Captures one exact copied room-head expectation.
 * @param value - Candidate room-head value.
 * @returns Detached exact head or undefined.
 */
export function captureCreatorExpectedRoomHead(value: unknown): CreatorExpectedRoomHead | undefined {
	try {
		if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
			return undefined;
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== ROOM_HEAD_KEYS.length || keys.some((key) => !ROOM_HEAD_KEYS.includes(key as string))) {
			return undefined;
		}
		const record = value as Readonly<Record<string, unknown>>;
		for (const key of ROOM_HEAD_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
		}
		if (
			typeof record.currentAnchorDigest !== "string" ||
			!LOWER_HEX_256.test(record.currentAnchorDigest) ||
			!Number.isSafeInteger(record.epoch) ||
			(record.epoch as number) < 0 ||
			typeof record.objectId !== "string" ||
			record.objectId.length === 0
		) {
			return undefined;
		}
		return Object.freeze({
			currentAnchorDigest: record.currentAnchorDigest,
			epoch: record.epoch as number,
			objectId: record.objectId,
		});
	} catch {
		return undefined;
	}
}

/**
 * Returns whether an expected room head matches authenticated trust.
 * @param left - Independently authenticated expected head.
 * @param right - Authenticated protocol trust.
 * @returns Whether every identity field matches.
 */
export function sameCreatorRoomHead(
	left: CreatorExpectedRoomHead,
	right: Readonly<{ readonly currentAnchorDigest: string; readonly currentEpoch: number; readonly objectId: string }>
): boolean {
	return (
		left.currentAnchorDigest === right.currentAnchorDigest &&
		left.epoch === right.currentEpoch &&
		left.objectId === right.objectId
	);
}

function exactFloorRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const actual = Reflect.ownKeys(value);
	if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)))
		return undefined;
	const output: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
		output[key] = descriptor.value;
	}
	return Object.freeze(output);
}

export type CreatorCapturedFloor =
	| Readonly<{ ok: false; kind: "floor-unavailable" | "floor-invalid" | "floor-pending"; reason?: string }>
	| Readonly<{ ok: true; stable: CreatorExpectedRoomHead }>;

/**
 * Captures an exact actual host result under the existing stable/pending adjacency laws.
 * @param value - Result from the trusted host read port.
 * @param objectId - Captured object scope.
 * @param pin - Captured genesis identity.
 * @returns Detached stable head or a distinct floor refusal.
 */
export function captureCreatorRoomFloor(value: unknown, objectId: string, pin: string): CreatorCapturedFloor {
	try {
		const failure = (
			kind: "floor-unavailable" | "floor-invalid" | "floor-pending",
			reason?: string
		): CreatorCapturedFloor => Object.freeze({ ok: false, kind, ...(reason === undefined ? {} : { reason }) });
		const result = exactFloorRecord(value, ["ok", "state"]) ?? exactFloorRecord(value, ["ok", "reason"]);
		if (result === undefined) return failure("floor-invalid");
		if (result.ok === false && (result.reason === "conflict" || result.reason === "unavailable"))
			return failure("floor-unavailable", result.reason);
		if (result.ok !== true || !Object.hasOwn(result, "state")) return failure("floor-invalid");
		if (result.state === null) return failure("floor-unavailable");
		const state = exactFloorRecord(result.state, ["stable", "pending"]);
		const stable = captureCreatorExpectedRoomHead(state?.stable);
		const valid = (head: CreatorExpectedRoomHead): boolean =>
			head.objectId === objectId && (head.epoch !== 0 || head.currentAnchorDigest === pin);
		if (state === undefined || stable === undefined || !valid(stable)) return failure("floor-invalid");
		if (state.pending !== null) {
			const pending = exactFloorRecord(state.pending, ["previous", "next"]);
			const previous = captureCreatorExpectedRoomHead(pending?.previous);
			const next = captureCreatorExpectedRoomHead(pending?.next);
			if (
				previous === undefined ||
				next === undefined ||
				!valid(previous) ||
				!valid(next) ||
				previous.epoch !== stable.epoch ||
				previous.currentAnchorDigest !== stable.currentAnchorDigest ||
				next.epoch !== stable.epoch + 1 ||
				next.currentAnchorDigest === stable.currentAnchorDigest
			)
				return failure("floor-invalid");
			return failure("floor-pending");
		}
		return Object.freeze({ ok: true, stable });
	} catch {
		return Object.freeze({ ok: false, kind: "floor-invalid" });
	}
}
