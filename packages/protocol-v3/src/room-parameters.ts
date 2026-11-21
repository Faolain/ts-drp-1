/**
 * The room parameters record's one registered extension: the room's application state limit.
 *
 * The parameters record (registry kind "parameters", domain ts-drp/parameters/v3) is what a creator
 * signs into the room's genesis anchor as parametersDigest. Every successor anchor copies that digest
 * unchanged, and every cut carries the same record, so a field of it is authenticated for every member
 * (G5) and fixed for the room's life: no signed path changes a room's parameters. The frozen
 * registry-v1.json is not changed; like the settlement profile, the extension is registered here, in
 * code, and every validator of the record accepts it only through this owner.
 *
 * `maxApplicationStateBytes` is the largest exact canonical application state the room admits. Absent,
 * it is 32,768 bytes (the record's bytes and digest are then those of every room before the setting).
 * Present, it is a safe integer from 32,768 to the library ceiling. The floor keeps every state the
 * room starts from or inherits (genesis and migration states, 32,768 bytes at most) inside every room's
 * limit.
 *
 * The ceiling (131,072 bytes) is what the room's existing bounded carriers hold unchanged:
 * - the creator's ordinary application-resource sizing material encodes the current base state and the
 *   retained rollback bases in one carrier under the close's 786,432-byte encode cap
 *   (CLOSED_RETIREMENT_BYTES, which does not change): three full bases take half of it at 131,072, the
 *   rest stays for the operations;
 * - the state keeps the canonical item and depth bounds (16,384 items, depth 16): a structured state of
 *   ~13 bytes per item reaches the item bound near 200 KiB, so a larger byte limit is not reachable
 *   without scaling the item bound;
 * - the admission fold encodes the state per move: ~4 ms at 128 KiB against ~9 ms at 256 KiB (measured
 *   decode+encode round trip), the real-time budget's concern.
 * Larger states need the structural changes recorded in docs/realtime-latency (state carried by
 * reference, item bounds scaled with the setting), not a larger constant here.
 */
export const ROOM_APPLICATION_STATE_DEFAULT_BYTES = 32_768 as const;
export const ROOM_APPLICATION_STATE_CEILING_BYTES = 131_072 as const;
export const ROOM_APPLICATION_STATE_LIMIT_PARAMETER = "maxApplicationStateBytes" as const;

/**
 * Whether a parameters record field outside the registry is a registered extension with a valid value.
 * @param name - The field name.
 * @param value - The field value.
 * @returns True only for `maxApplicationStateBytes` with a safe integer in [default, ceiling].
 */
export function isRegisteredRoomParameterExtension(name: string, value: unknown): boolean {
	return (
		name === ROOM_APPLICATION_STATE_LIMIT_PARAMETER &&
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= ROOM_APPLICATION_STATE_DEFAULT_BYTES &&
		value <= ROOM_APPLICATION_STATE_CEILING_BYTES
	);
}

/**
 * The room's application state limit from its (already shape-checked) parameters record.
 * @param parameters - The decoded parameters record.
 * @returns The limit in canonical bytes, or undefined when the declared value is not valid.
 */
export function roomApplicationStateLimit(parameters: Readonly<Record<string, unknown>>): number | undefined {
	if (!Object.hasOwn(parameters, ROOM_APPLICATION_STATE_LIMIT_PARAMETER)) return ROOM_APPLICATION_STATE_DEFAULT_BYTES;
	const value = Object.getOwnPropertyDescriptor(parameters, ROOM_APPLICATION_STATE_LIMIT_PARAMETER)?.value;
	return isRegisteredRoomParameterExtension(ROOM_APPLICATION_STATE_LIMIT_PARAMETER, value) ? (value as number) : undefined;
}
