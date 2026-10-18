export const ENTITY_DELTA_BATCH_VERSION = 1;
export const ENTITY_DELTA_BATCH_MAX_ENTITIES = 32;

const BATCH_HEADER_BYTES = 2;
const ENTITY_DELTA_BYTES = 16;
const UINT32_MAX = 0xffff_ffff;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;

export const ENTITY_DELTA_BATCH_MAX_BYTES = BATCH_HEADER_BYTES + ENTITY_DELTA_BATCH_MAX_ENTITIES * ENTITY_DELTA_BYTES;

export interface EntityDelta {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

export interface AoiSelectionInput {
	readonly entities: readonly EntityDelta[];
	readonly maxEntities: number;
	readonly observerX: number;
	readonly observerY: number;
	readonly radius: number;
}

interface VisibleEntity {
	readonly delta: EntityDelta;
	readonly squaredDistance: bigint;
}

function requireIntegerInRange(value: unknown, minimum: number, maximum: number, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${name} is outside its integer range`);
	}
	return value;
}

function copyEntityDelta(value: EntityDelta): EntityDelta {
	return Object.freeze({
		entityId: requireIntegerInRange(value.entityId, 0, UINT32_MAX, "entity id"),
		sequence: requireIntegerInRange(value.sequence, 0, UINT32_MAX, "entity sequence"),
		x: requireIntegerInRange(value.x, INT32_MIN, INT32_MAX, "entity x"),
		y: requireIntegerInRange(value.y, INT32_MIN, INT32_MAX, "entity y"),
	});
}

function requireUniqueEntity(entityId: number, seen: Set<number>): void {
	if (seen.has(entityId)) throw new TypeError("entity id is duplicated");
	seen.add(entityId);
}

function squaredDistance(observerX: number, observerY: number, entityX: number, entityY: number): bigint {
	const dx = BigInt(entityX) - BigInt(observerX);
	const dy = BigInt(entityY) - BigInt(observerY);
	return dx * dx + dy * dy;
}

/**
 * Select a detached, deterministic nearest-entity view for one observer.
 * @param input Integer observer, radius, bound, and candidate values.
 * @returns At most the requested number of visible entities, ordered by exact distance and then id.
 */
export function selectAoiEntityDeltas(input: AoiSelectionInput): readonly EntityDelta[] {
	if (input === null || typeof input !== "object" || !Array.isArray(input.entities)) {
		throw new TypeError("AOI selection input differs");
	}
	const observerX = requireIntegerInRange(input.observerX, INT32_MIN, INT32_MAX, "observer x");
	const observerY = requireIntegerInRange(input.observerY, INT32_MIN, INT32_MAX, "observer y");
	const radius = requireIntegerInRange(input.radius, 0, UINT32_MAX, "AOI radius");
	const maxEntities = requireIntegerInRange(input.maxEntities, 1, ENTITY_DELTA_BATCH_MAX_ENTITIES, "AOI entity bound");
	const maximumSquaredDistance = BigInt(radius) * BigInt(radius);
	const seen = new Set<number>();
	const visible: VisibleEntity[] = [];

	for (const value of input.entities) {
		if (value === null || typeof value !== "object") throw new TypeError("entity delta differs");
		const delta = copyEntityDelta(value);
		requireUniqueEntity(delta.entityId, seen);
		const distance = squaredDistance(observerX, observerY, delta.x, delta.y);
		if (distance <= maximumSquaredDistance) visible.push({ delta, squaredDistance: distance });
	}

	visible.sort((left, right) => {
		if (left.squaredDistance < right.squaredDistance) return -1;
		if (left.squaredDistance > right.squaredDistance) return 1;
		return left.delta.entityId - right.delta.entityId;
	});
	return Object.freeze(visible.slice(0, maxEntities).map(({ delta }) => delta));
}

/**
 * Encode a detached fixed-width version-1 entity-delta batch.
 * @param entities Ordered entity deltas selected by the caller's AOI policy.
 * @returns Canonical big-endian bytes.
 */
export function encodeEntityDeltaBatch(entities: readonly EntityDelta[]): Uint8Array {
	if (!Array.isArray(entities) || entities.length > ENTITY_DELTA_BATCH_MAX_ENTITIES) {
		throw new TypeError("entity delta batch count differs");
	}
	const copied: EntityDelta[] = [];
	const seen = new Set<number>();
	for (const value of entities) {
		if (value === null || typeof value !== "object") throw new TypeError("entity delta differs");
		const delta = copyEntityDelta(value);
		requireUniqueEntity(delta.entityId, seen);
		copied.push(delta);
	}

	const bytes = new Uint8Array(BATCH_HEADER_BYTES + copied.length * ENTITY_DELTA_BYTES);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint8(0, ENTITY_DELTA_BATCH_VERSION);
	view.setUint8(1, copied.length);
	for (let index = 0; index < copied.length; index += 1) {
		const delta = copied[index];
		if (delta === undefined) throw new TypeError("entity delta is absent");
		const offset = BATCH_HEADER_BYTES + index * ENTITY_DELTA_BYTES;
		view.setUint32(offset, delta.entityId, false);
		view.setUint32(offset + 4, delta.sequence, false);
		view.setInt32(offset + 8, delta.x, false);
		view.setInt32(offset + 12, delta.y, false);
	}
	return bytes;
}

/**
 * Decode only an exact fixed-width version-1 entity-delta batch.
 * @param bytes Candidate batch bytes.
 * @returns Detached entity values in their encoded order.
 */
export function decodeEntityDeltaBatch(bytes: Uint8Array): readonly EntityDelta[] {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < BATCH_HEADER_BYTES) {
		throw new TypeError("entity delta batch bytes differ");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== ENTITY_DELTA_BATCH_VERSION) throw new TypeError("entity delta batch version differs");
	const count = view.getUint8(1);
	if (count > ENTITY_DELTA_BATCH_MAX_ENTITIES || bytes.byteLength !== BATCH_HEADER_BYTES + count * ENTITY_DELTA_BYTES) {
		throw new TypeError("entity delta batch length differs");
	}

	const entities: EntityDelta[] = [];
	const seen = new Set<number>();
	for (let index = 0; index < count; index += 1) {
		const offset = BATCH_HEADER_BYTES + index * ENTITY_DELTA_BYTES;
		const delta = Object.freeze({
			entityId: view.getUint32(offset, false),
			sequence: view.getUint32(offset + 4, false),
			x: view.getInt32(offset + 8, false),
			y: view.getInt32(offset + 12, false),
		});
		requireUniqueEntity(delta.entityId, seen);
		entities.push(delta);
	}
	return Object.freeze(entities);
}
