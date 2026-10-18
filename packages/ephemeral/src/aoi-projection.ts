export const AOI_PROJECTION_VERSION = 1;
export const AOI_PROJECTION_HEADER_BYTES = 25;
export const AOI_PROJECTION_RECORD_BYTES = 17;
export const AOI_PROJECTION_KEYFRAME_INTERVAL = 30;
export const AOI_PROJECTION_MAX_CHUNKS = 32;
export const AOI_PROJECTION_MAX_ASSEMBLIES = 4;
export const AOI_PROJECTION_MAX_BUFFERED_BYTES = 32_768;
export const AOI_PROJECTION_ASSEMBLY_LIFETIME_MS = 1_000;

const KEYFRAME_KIND = 1;
const DELTA_KIND = 2;
const UPSERT_OPERATION = 1;
const LEAVE_OPERATION = 2;
const UINT32_MAX = 0xffff_ffff;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const RECORD_COUNT_MAX = 0xff;

export interface AoiProjectionEntity {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

export interface AoiProjectionSender {
	encode(
		input: Readonly<{ readonly entities: readonly AoiProjectionEntity[]; readonly sequence: number }>
	): readonly Uint8Array[];
}

export interface AoiProjectionReceiverSnapshot {
	readonly authorityGeneration: number;
	readonly baseKeyframeId: number | null;
	readonly baseKeyframeSequence: number | null;
	readonly entities: readonly AoiProjectionEntity[];
	readonly generation: number | null;
	readonly lastSequence: number | null;
	readonly pendingAssemblies: number;
	readonly pendingBytes: number;
	readonly waitingForKeyframe: boolean;
}

export interface AoiProjectionReceiver {
	expire(nowMs: number): void;
	ingest(
		input: Readonly<{
			readonly authorityGeneration: number;
			readonly bytes: Uint8Array;
			readonly receivedAtMs: number;
		}>
	): boolean;
	nextExpiryAtMs(): number | null;
	resetAuthority(authorityGeneration: number): void;
	snapshot(): AoiProjectionReceiverSnapshot;
}

interface ProjectionRecord {
	readonly entity: AoiProjectionEntity;
	readonly operation: 1 | 2;
}

interface ProjectionPacket {
	readonly baseKeyframeId: number;
	readonly baseKeyframeSequence: number;
	readonly batchId: number;
	readonly chunkCount: number;
	readonly chunkIndex: number;
	readonly generation: number;
	readonly kind: 1 | 2;
	readonly records: readonly ProjectionRecord[];
	readonly sequence: number;
}

interface PendingAssembly {
	readonly baseKeyframeId: number;
	readonly baseKeyframeSequence: number;
	readonly batchId: number;
	readonly chunkCount: number;
	readonly chunks: Map<
		number,
		Readonly<{ readonly byteLength: number; readonly records: readonly ProjectionRecord[] }>
	>;
	readonly createdAtMs: number;
	readonly generation: number;
	readonly kind: 1 | 2;
	readonly sequence: number;
	bytes: number;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${label} differs`);
	}
	return value;
}

function copyEntity(value: AoiProjectionEntity): AoiProjectionEntity {
	if (value === null || typeof value !== "object") throw new TypeError("AOI projection entity differs");
	return Object.freeze({
		entityId: integer(value.entityId, 0, UINT32_MAX, "AOI projection entity id"),
		sequence: integer(value.sequence, 0, UINT32_MAX, "AOI projection entity sequence"),
		x: integer(value.x, INT32_MIN, INT32_MAX, "AOI projection entity x"),
		y: integer(value.y, INT32_MIN, INT32_MAX, "AOI projection entity y"),
	});
}

function copyEntities(values: readonly AoiProjectionEntity[]): readonly AoiProjectionEntity[] {
	if (!Array.isArray(values)) throw new TypeError("AOI projection entities differ");
	const copied = values.map(copyEntity).sort((left, right) => left.entityId - right.entityId);
	for (let index = 1; index < copied.length; index += 1) {
		if (copied[index - 1]?.entityId === copied[index]?.entityId) {
			throw new TypeError("AOI projection entity id is duplicated");
		}
	}
	return Object.freeze(copied);
}

function sameEntity(left: AoiProjectionEntity, right: AoiProjectionEntity): boolean {
	return (
		left.entityId === right.entityId && left.sequence === right.sequence && left.x === right.x && left.y === right.y
	);
}

function recordsRelativeToBase(
	base: readonly AoiProjectionEntity[],
	current: readonly AoiProjectionEntity[]
): readonly ProjectionRecord[] {
	const baseById = new Map(base.map((entry) => [entry.entityId, entry]));
	const currentById = new Map(current.map((entry) => [entry.entityId, entry]));
	const records: ProjectionRecord[] = [];
	for (const entry of current) {
		const prior = baseById.get(entry.entityId);
		if (prior === undefined || !sameEntity(prior, entry)) {
			records.push(Object.freeze({ entity: entry, operation: UPSERT_OPERATION }));
		}
	}
	for (const entry of base) {
		if (!currentById.has(entry.entityId)) {
			records.push(
				Object.freeze({
					entity: Object.freeze({ entityId: entry.entityId, sequence: entry.sequence, x: 0, y: 0 }),
					operation: LEAVE_OPERATION,
				})
			);
		}
	}
	records.sort((left, right) => left.entity.entityId - right.entity.entityId);
	return Object.freeze(records);
}

function encodePacket(
	metadata: Omit<ProjectionPacket, "chunkIndex" | "records">,
	chunkIndex: number,
	records: readonly ProjectionRecord[]
): Uint8Array {
	const bytes = new Uint8Array(AOI_PROJECTION_HEADER_BYTES + records.length * AOI_PROJECTION_RECORD_BYTES);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint8(0, AOI_PROJECTION_VERSION);
	view.setUint8(1, metadata.kind);
	view.setUint32(2, metadata.generation, false);
	view.setUint32(6, metadata.batchId, false);
	view.setUint32(10, metadata.sequence, false);
	view.setUint32(14, metadata.baseKeyframeId, false);
	view.setUint32(18, metadata.baseKeyframeSequence, false);
	view.setUint8(22, chunkIndex);
	view.setUint8(23, metadata.chunkCount);
	view.setUint8(24, records.length);
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === undefined) throw new TypeError("AOI projection record is absent");
		const offset = AOI_PROJECTION_HEADER_BYTES + index * AOI_PROJECTION_RECORD_BYTES;
		view.setUint8(offset, record.operation);
		view.setUint32(offset + 1, record.entity.entityId, false);
		view.setUint32(offset + 5, record.entity.sequence, false);
		view.setInt32(offset + 9, record.entity.x, false);
		view.setInt32(offset + 13, record.entity.y, false);
	}
	return bytes;
}

function decodePacket(input: Uint8Array): ProjectionPacket | undefined {
	if (!(input instanceof Uint8Array)) return undefined;
	const bytes = input.slice();
	if (bytes.byteLength < AOI_PROJECTION_HEADER_BYTES) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== AOI_PROJECTION_VERSION) return undefined;
	const kind = view.getUint8(1);
	if (kind !== KEYFRAME_KIND && kind !== DELTA_KIND) return undefined;
	const chunkIndex = view.getUint8(22);
	const chunkCount = view.getUint8(23);
	const recordCount = view.getUint8(24);
	if (
		chunkCount < 1 ||
		chunkCount > AOI_PROJECTION_MAX_CHUNKS ||
		chunkIndex >= chunkCount ||
		bytes.byteLength !== AOI_PROJECTION_HEADER_BYTES + recordCount * AOI_PROJECTION_RECORD_BYTES
	) {
		return undefined;
	}
	const records: ProjectionRecord[] = [];
	const seen = new Set<number>();
	for (let index = 0; index < recordCount; index += 1) {
		const offset = AOI_PROJECTION_HEADER_BYTES + index * AOI_PROJECTION_RECORD_BYTES;
		const operation = view.getUint8(offset);
		if (operation !== UPSERT_OPERATION && operation !== LEAVE_OPERATION) return undefined;
		const entityId = view.getUint32(offset + 1, false);
		if (seen.has(entityId)) return undefined;
		seen.add(entityId);
		const entity = Object.freeze({
			entityId,
			sequence: view.getUint32(offset + 5, false),
			x: view.getInt32(offset + 9, false),
			y: view.getInt32(offset + 13, false),
		});
		if (operation === LEAVE_OPERATION && (entity.x !== 0 || entity.y !== 0)) return undefined;
		if (kind === KEYFRAME_KIND && operation !== UPSERT_OPERATION) return undefined;
		records.push(Object.freeze({ entity, operation }));
	}
	return Object.freeze({
		baseKeyframeId: view.getUint32(14, false),
		baseKeyframeSequence: view.getUint32(18, false),
		batchId: view.getUint32(6, false),
		chunkCount,
		chunkIndex,
		generation: view.getUint32(2, false),
		kind,
		records: Object.freeze(records),
		sequence: view.getUint32(10, false),
	});
}

function sameAssemblyMetadata(assembly: PendingAssembly, packet: ProjectionPacket): boolean {
	return (
		assembly.baseKeyframeId === packet.baseKeyframeId &&
		assembly.baseKeyframeSequence === packet.baseKeyframeSequence &&
		assembly.chunkCount === packet.chunkCount &&
		assembly.generation === packet.generation &&
		assembly.kind === packet.kind &&
		assembly.sequence === packet.sequence
	);
}

/** Create one deterministic AOI packet sender for an authenticated authority generation. */
export function createAoiProjectionSender(
	input: Readonly<{ readonly generation: number; readonly maxPayloadBytes: number }>
): AoiProjectionSender {
	if (input === null || typeof input !== "object") throw new TypeError("AOI projection sender input differs");
	const generation = integer(input.generation, 0, UINT32_MAX, "AOI projection generation");
	const maxPayloadBytes = integer(
		input.maxPayloadBytes,
		AOI_PROJECTION_HEADER_BYTES + AOI_PROJECTION_RECORD_BYTES,
		UINT32_MAX,
		"AOI projection payload bound"
	);
	const recordsPerChunk = Math.min(
		RECORD_COUNT_MAX,
		Math.floor((maxPayloadBytes - AOI_PROJECTION_HEADER_BYTES) / AOI_PROJECTION_RECORD_BYTES)
	);
	let batchId = 0;
	let lastSequence: number | undefined;
	let baseEntities: readonly AoiProjectionEntity[] = Object.freeze([]);
	let baseKeyframeId = 0;
	let baseKeyframeSequence = 0;

	return Object.freeze({
		encode({
			entities,
			sequence,
		}: Readonly<{
			readonly entities: readonly AoiProjectionEntity[];
			readonly sequence: number;
		}>): readonly Uint8Array[] {
			const selectedSequence = integer(sequence, 0, UINT32_MAX, "AOI projection sequence");
			if (lastSequence !== undefined && selectedSequence <= lastSequence) {
				throw new TypeError("AOI projection sequence is stale");
			}
			if (batchId > UINT32_MAX) throw new RangeError("AOI projection batch id exhausted");
			const copied = copyEntities(entities);
			const keyframe = batchId % AOI_PROJECTION_KEYFRAME_INTERVAL === 0;
			const records: readonly ProjectionRecord[] = keyframe
				? Object.freeze(copied.map((entry) => Object.freeze({ entity: entry, operation: 1 as const })))
				: recordsRelativeToBase(baseEntities, copied);
			const chunkCount = Math.max(1, Math.ceil(records.length / recordsPerChunk));
			if (chunkCount > AOI_PROJECTION_MAX_CHUNKS) throw new TypeError("AOI projection chunk count differs");
			const encodedBytes = records.length * AOI_PROJECTION_RECORD_BYTES + chunkCount * AOI_PROJECTION_HEADER_BYTES;
			if (encodedBytes > AOI_PROJECTION_MAX_BUFFERED_BYTES) {
				throw new TypeError("AOI projection batch bytes differ");
			}
			const selectedBaseId = keyframe ? batchId : baseKeyframeId;
			const selectedBaseSequence = keyframe ? selectedSequence : baseKeyframeSequence;
			const metadata = {
				baseKeyframeId: selectedBaseId,
				baseKeyframeSequence: selectedBaseSequence,
				batchId,
				chunkCount,
				generation,
				kind: keyframe ? KEYFRAME_KIND : DELTA_KIND,
				sequence: selectedSequence,
			} as const;
			const packets = Array.from({ length: chunkCount }, (_value, chunkIndex) =>
				encodePacket(
					metadata,
					chunkIndex,
					records.slice(chunkIndex * recordsPerChunk, (chunkIndex + 1) * recordsPerChunk)
				)
			);
			if (keyframe) {
				baseEntities = copied;
				baseKeyframeId = batchId;
				baseKeyframeSequence = selectedSequence;
			}
			lastSequence = selectedSequence;
			batchId += 1;
			return Object.freeze(packets);
		},
	});
}

/** Create one bounded atomic AOI receiver for an authenticated authority generation. */
export function createAoiProjectionReceiver(
	input: Readonly<{ readonly authorityGeneration: number }>
): AoiProjectionReceiver {
	if (input === null || typeof input !== "object") throw new TypeError("AOI projection receiver input differs");
	let authorityGeneration = integer(input.authorityGeneration, 0, UINT32_MAX, "AOI projection authority generation");
	let generation: number | null = null;
	let baseKeyframeId: number | null = null;
	let baseKeyframeSequence: number | null = null;
	let lastBatchId: number | null = null;
	let lastSequence: number | null = null;
	let waitingForKeyframe = true;
	let baseEntities: readonly AoiProjectionEntity[] = Object.freeze([]);
	let entities: readonly AoiProjectionEntity[] = Object.freeze([]);
	let pendingBytes = 0;
	const assemblies = new Map<number, PendingAssembly>();

	const removeAssembly = (batchId: number): void => {
		const assembly = assemblies.get(batchId);
		if (assembly === undefined) return;
		pendingBytes -= assembly.bytes;
		assemblies.delete(batchId);
	};
	const clearAssemblies = (): void => {
		assemblies.clear();
		pendingBytes = 0;
	};
	const expire = (nowMs: number): void => {
		integer(nowMs, 0, Number.MAX_SAFE_INTEGER, "AOI projection expiry time");
		let expired = false;
		for (const [batchId, assembly] of assemblies) {
			if (nowMs - assembly.createdAtMs >= AOI_PROJECTION_ASSEMBLY_LIFETIME_MS) {
				removeAssembly(batchId);
				expired = true;
			}
		}
		if (expired) waitingForKeyframe = true;
	};
	const snapshot = (): AoiProjectionReceiverSnapshot =>
		Object.freeze({
			authorityGeneration,
			baseKeyframeId,
			baseKeyframeSequence,
			entities: Object.freeze(entities.map((entry) => ({ ...entry }))),
			generation,
			lastSequence,
			pendingAssemblies: assemblies.size,
			pendingBytes,
			waitingForKeyframe,
		});

	return Object.freeze({
		expire,
		ingest({
			authorityGeneration: selectedAuthority,
			bytes,
			receivedAtMs,
		}: Readonly<{
			readonly authorityGeneration: number;
			readonly bytes: Uint8Array;
			readonly receivedAtMs: number;
		}>): boolean {
			if (integer(selectedAuthority, 0, UINT32_MAX, "AOI projection authority generation") !== authorityGeneration) {
				return false;
			}
			expire(receivedAtMs);
			const packet = decodePacket(bytes);
			if (packet === undefined) return false;
			if (generation !== null && packet.generation < generation) return false;
			if (waitingForKeyframe && packet.kind !== KEYFRAME_KIND) return false;
			if (
				packet.kind === KEYFRAME_KIND &&
				(packet.baseKeyframeId !== packet.batchId || packet.baseKeyframeSequence !== packet.sequence)
			) {
				return false;
			}

			let assembly = assemblies.get(packet.batchId);
			if (assembly !== undefined && !sameAssemblyMetadata(assembly, packet)) {
				removeAssembly(packet.batchId);
				waitingForKeyframe = true;
				return false;
			}
			if (assembly === undefined) {
				if (assemblies.size >= AOI_PROJECTION_MAX_ASSEMBLIES) return false;
				assembly = {
					baseKeyframeId: packet.baseKeyframeId,
					baseKeyframeSequence: packet.baseKeyframeSequence,
					batchId: packet.batchId,
					bytes: 0,
					chunkCount: packet.chunkCount,
					chunks: new Map(),
					createdAtMs: receivedAtMs,
					generation: packet.generation,
					kind: packet.kind,
					sequence: packet.sequence,
				};
				assemblies.set(packet.batchId, assembly);
			}
			const priorChunk = assembly.chunks.get(packet.chunkIndex);
			if (priorChunk !== undefined) return false;
			if (pendingBytes + bytes.byteLength > AOI_PROJECTION_MAX_BUFFERED_BYTES) return false;
			const chunk = Object.freeze({ byteLength: bytes.byteLength, records: packet.records });
			assembly.chunks.set(packet.chunkIndex, chunk);
			assembly.bytes += bytes.byteLength;
			pendingBytes += bytes.byteLength;
			if (assembly.chunks.size !== assembly.chunkCount) return false;

			const records: ProjectionRecord[] = [];
			const seen = new Set<number>();
			for (let index = 0; index < assembly.chunkCount; index += 1) {
				const selectedChunk = assembly.chunks.get(index);
				if (selectedChunk === undefined) return false;
				for (const record of selectedChunk.records) {
					if (seen.has(record.entity.entityId)) {
						removeAssembly(assembly.batchId);
						waitingForKeyframe = true;
						return false;
					}
					seen.add(record.entity.entityId);
					records.push(record);
				}
			}
			removeAssembly(assembly.batchId);

			if (
				generation !== null &&
				assembly.generation === generation &&
				(lastSequence === null || assembly.sequence <= lastSequence)
			) {
				return false;
			}
			if (assembly.kind === DELTA_KIND) {
				if (
					generation !== assembly.generation ||
					baseKeyframeId !== assembly.baseKeyframeId ||
					baseKeyframeSequence !== assembly.baseKeyframeSequence ||
					lastBatchId === null ||
					assembly.batchId !== lastBatchId + 1 ||
					lastSequence === null ||
					assembly.sequence !== lastSequence + 1
				) {
					waitingForKeyframe = true;
					return false;
				}
				const next = new Map(baseEntities.map((entry) => [entry.entityId, entry]));
				for (const record of records) {
					if (record.operation === UPSERT_OPERATION) next.set(record.entity.entityId, record.entity);
					else next.delete(record.entity.entityId);
				}
				entities = Object.freeze([...next.values()].sort((left, right) => left.entityId - right.entityId));
			} else {
				if (generation !== null && assembly.generation === generation && lastSequence !== null) {
					if (assembly.sequence <= lastSequence || (lastBatchId !== null && assembly.batchId <= lastBatchId)) {
						return false;
					}
				}
				entities = Object.freeze(
					records.map(({ entity }) => entity).sort((left, right) => left.entityId - right.entityId)
				);
				baseEntities = entities;
				baseKeyframeId = assembly.baseKeyframeId;
				baseKeyframeSequence = assembly.baseKeyframeSequence;
				clearAssemblies();
			}
			generation = assembly.generation;
			lastBatchId = assembly.batchId;
			lastSequence = assembly.sequence;
			waitingForKeyframe = false;
			return true;
		},
		nextExpiryAtMs(): number | null {
			let next: number | null = null;
			for (const assembly of assemblies.values()) {
				const expiresAt = assembly.createdAtMs + AOI_PROJECTION_ASSEMBLY_LIFETIME_MS;
				if (next === null || expiresAt < next) next = expiresAt;
			}
			return next;
		},
		resetAuthority(selectedAuthority: number): void {
			authorityGeneration = integer(selectedAuthority, 0, UINT32_MAX, "AOI projection authority generation");
			generation = null;
			baseKeyframeId = null;
			baseKeyframeSequence = null;
			lastBatchId = null;
			lastSequence = null;
			waitingForKeyframe = true;
			baseEntities = Object.freeze([]);
			entities = Object.freeze([]);
			clearAssemblies();
		},
		snapshot,
	});
}
