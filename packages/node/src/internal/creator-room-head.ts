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
