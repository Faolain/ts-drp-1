import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { V3OperationAdmissionPolicy, V3OperationAdmissionReservation } from "@ts-drp/node/v3-live";

import { captureShippingChatOperation, type ShippingChatMessage } from "./v3-chat-message.js";

export const SHIPPING_CHAT_RETAINED_BYTES = 32_768;
export type ShippingChatAllocation = readonly [author: string, ceilingBytes: number, allocationEpoch: number];
export type ShippingChatSettlementFrontier = readonly [
	author: string,
	admissionEpoch: number,
	terminalThrough: number | null,
];
export interface ShippingChatCapacity {
	readonly version: 1;
	readonly basisObjectId: string;
	readonly allocations: readonly ShippingChatAllocation[];
}
export interface ShippingChatState {
	readonly version: 3;
	readonly messages: readonly ShippingChatMessage[];
	readonly capacity: ShippingChatCapacity;
}

const LIMITS = Object.freeze({ maxBytes: SHIPPING_CHAT_RETAINED_BYTES, maxDepth: 16, maxItems: 16_384 });
const AUTHOR = /^[0-9a-f]{64}$/u;
function objectId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024)
		throw new TypeError("Chat capacity basis object is invalid");
	return value;
}
function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
	)
		throw new TypeError("Chat capacity record is invalid");
	const own = Reflect.ownKeys(value);
	if (
		own.length !== keys.length ||
		own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
		keys.some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable !== true || !("value" in descriptor);
		})
	)
		throw new TypeError("Chat capacity fields are invalid");
	return value as Readonly<Record<string, unknown>>;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Chat capacity integer is invalid");
	return value === 0 ? 0 : value;
}
function dense(value: unknown): readonly unknown[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		throw new TypeError("Chat capacity array is invalid");
	return value;
}
/**
 * Exact selected ACL data; native signature/root/epoch authentication remains the room owner's job.
 * @param exactCanonicalLatchedAclBytes
 */
export function shippingChatWriters(exactCanonicalLatchedAclBytes: Uint8Array): readonly string[] {
	const decoded = decodeCanonical(exactCanonicalLatchedAclBytes);
	if (compareBytes(encodeCanonical(decoded), exactCanonicalLatchedAclBytes) !== 0)
		throw new TypeError("Chat ACL is not canonical");
	const acl = record(decoded, ["epoch", "kind", "members", "objectId", "permissionless", "version"]);
	if (acl.kind !== "drp-v3-latched-acl" || typeof acl.permissionless !== "boolean")
		throw new TypeError("Chat ACL is invalid");
	objectId(acl.objectId);
	integer(acl.epoch);
	const writers: string[] = [];
	let previous = "";
	for (const value of dense(acl.members)) {
		const member = record(value, ["author", "finalityKey", "groups"]);
		if (typeof member.author !== "string" || !AUTHOR.test(member.author) || member.author <= previous)
			throw new TypeError("Chat ACL authors are invalid");
		previous = member.author;
		const groups = dense(member.groups);
		if (acl.permissionless || groups.includes("writer")) writers.push(member.author);
	}
	return Object.freeze(writers);
}
/**
 * Charges complete retained message records, not text length or operation/proof bytes.
 * @param messages
 */
export function shippingChatMessageCharges(messages: readonly ShippingChatMessage[]): ReadonlyMap<string, number> {
	const charges = new Map<string, number>();
	for (const message of messages)
		charges.set(message.author, (charges.get(message.author) ?? 0) + encodeCanonical(message).byteLength);
	return charges;
}
/**
 * Validates the complete authenticated state; no capacity authority is inferred from unverified bytes.
 * @param value
 */
export function captureShippingChatCapacityState(value: unknown): ShippingChatState {
	const state = record(value, ["version", "messages", "capacity"]);
	const capacity = record(state.capacity, ["version", "basisObjectId", "allocations"]);
	if (state.version !== 3 || capacity.version !== 1) throw new TypeError("Chat capacity version is invalid");
	let previous = "";
	const allocations: ShippingChatAllocation[] = [];
	for (const value of dense(capacity.allocations)) {
		const row = dense(value);
		if (row.length !== 3 || typeof row[0] !== "string" || !AUTHOR.test(row[0]) || row[0] <= previous)
			throw new TypeError("Chat allocation is invalid");
		previous = row[0];
		allocations.push(Object.freeze([row[0], integer(row[1]), integer(row[2])] as const));
	}
	const messages: ShippingChatMessage[] = [];
	let priorIdentity = "";
	for (const value of dense(state.messages)) {
		const row = record(value, ["author", "clientOperationId", "displayTimeMs", "text"]);
		if (
			typeof row.author !== "string" ||
			!AUTHOR.test(row.author) ||
			typeof row.clientOperationId !== "string" ||
			!/^[A-Za-z0-9._:-]{1,128}$/u.test(row.clientOperationId) ||
			typeof row.text !== "string" ||
			row.text.length === 0
		)
			throw new TypeError("Chat retained message is invalid");
		const key = `${row.author}\u0000${row.clientOperationId}`;
		if (key <= priorIdentity) throw new TypeError("Chat retained identities are not canonical");
		priorIdentity = key;
		messages.push(
			Object.freeze({
				author: row.author,
				clientOperationId: row.clientOperationId,
				displayTimeMs: integer(row.displayTimeMs),
				text: row.text,
			})
		);
	}
	const result: ShippingChatState = Object.freeze({
		version: 3,
		messages: Object.freeze(messages),
		capacity: Object.freeze({
			version: 1,
			basisObjectId: objectId(capacity.basisObjectId),
			allocations: Object.freeze(allocations),
		}),
	});
	const ceilingByAuthor = new Map(allocations.map(([author, ceiling]) => [author, ceiling]));
	for (const [author, charge] of shippingChatMessageCharges(messages))
		if (charge > (ceilingByAuthor.get(author) ?? -1))
			throw new TypeError("Chat retained capacity entitlement is exceeded");
	// Charge the complete ledger and reserve the largest possible messages-array
	// count framing under the unchanged canonical item limit (two extra bytes).
	const emptyBytes = encodeCanonical({ ...result, messages: [] }, LIMITS).byteLength;
	if (emptyBytes + 2 + allocations.reduce((sum, row) => sum + row[1], 0) > SHIPPING_CHAT_RETAINED_BYTES)
		throw new TypeError("Chat capacity entitlements are overbooked");
	encodeCanonical(result, LIMITS);
	return result;
}
/**
 *
 * @param value
 */
export function shippingChatCapacityStateBytes(value: unknown): Uint8Array {
	return encodeCanonical(captureShippingChatCapacityState(value), LIMITS);
}
/**
 *
 * @param bytes
 */
export function restoreShippingChatCapacityState(bytes: Uint8Array): ShippingChatState {
	const state = captureShippingChatCapacityState(decodeCanonical(bytes, LIMITS));
	if (compareBytes(shippingChatCapacityStateBytes(state), bytes) !== 0)
		throw new TypeError("Chat capacity state is not canonical");
	return state;
}
/**
 * Sole NEW-genesis allocation/framing owner. It grants no portable authentication.
 * @param input
 */
export function createShippingChatGenesisStateBytes(
	input: Readonly<{ exactCanonicalLatchedAclBytes: Uint8Array }>
): Uint8Array {
	const acl = decodeCanonical(input.exactCanonicalLatchedAclBytes) as Readonly<Record<string, unknown>>;
	if (acl.epoch !== 0) throw new TypeError("Chat capacity genesis requires epoch zero");
	// Dormant lifetime shares belong to the exact initially enrolled ACL roster.
	// Only the native current-Writer owner may activate authoring authority.
	shippingChatWriters(input.exactCanonicalLatchedAclBytes);
	const writers = dense(acl.members).map((value) => (value as Readonly<{ author: string }>).author);
	// A receive-only genesis is legitimate. No author obtains an implicit share.
	const maximumRows = writers.map((author) => [author, SHIPPING_CHAT_RETAINED_BYTES, 0] as const);
	const basisObjectId = objectId(acl.objectId);
	const overhead =
		encodeCanonical(
			{ version: 3, messages: [], capacity: { version: 1, basisObjectId, allocations: maximumRows } },
			LIMITS
		).byteLength + 2;
	const available = SHIPPING_CHAT_RETAINED_BYTES - overhead;
	if (available < 0) throw new TypeError("Chat capacity metadata exceeds retained budget");
	const quotient = writers.length === 0 ? 0 : Math.floor(available / writers.length);
	const remainder = writers.length === 0 ? 0 : available % writers.length;
	return shippingChatCapacityStateBytes({
		version: 3,
		messages: [],
		capacity: {
			version: 1,
			basisObjectId,
			allocations: writers.map((author, index) => [author, quotient + (index < remainder ? 1 : 0), 0]),
		},
	});
}

/**
 * A published new admission incarnation retires the older source namespace.
 * Mere revocation, a high terminal sequence or local completion never releases
 * unknown old-source reservations. Missing evidence retains the full ceiling.
 * @param input
 */
export function reallocateShippingChatCapacity(
	input: Readonly<{
		state: ShippingChatState;
		exactCanonicalLatchedAclBytes: Uint8Array;
		authenticatedSettlementFrontiers: readonly ShippingChatSettlementFrontier[];
	}>
): ShippingChatCapacity {
	const state = captureShippingChatCapacityState(input.state);
	const acl = decodeCanonical(input.exactCanonicalLatchedAclBytes) as Readonly<Record<string, unknown>>;
	if (state.capacity.basisObjectId !== objectId(acl.objectId))
		throw new TypeError("Chat capacity release requires its authenticated source basis");
	const epoch = integer(acl.epoch),
		writers = shippingChatWriters(input.exactCanonicalLatchedAclBytes);
	const used = shippingChatMessageCharges(state.messages);
	const frontiers = new Map<string, ShippingChatSettlementFrontier>();
	let previous = "";
	for (const value of input.authenticatedSettlementFrontiers) {
		if (
			value.length !== 3 ||
			!AUTHOR.test(value[0]) ||
			value[0] <= previous ||
			integer(value[1]) > epoch ||
			(value[2] !== null && integer(value[2]) !== value[2])
		)
			throw new TypeError("Chat settlement frontier is invalid");
		previous = value[0];
		frontiers.set(value[0], value);
	}
	const carried = new Map<string, ShippingChatAllocation>();
	for (const [author, ceiling, allocationEpoch] of state.capacity.allocations) {
		const frontier = frontiers.get(author);
		const released = frontier !== undefined && frontier[1] > allocationEpoch;
		carried.set(
			author,
			Object.freeze([author, released ? (used.get(author) ?? 0) : ceiling, released ? frontier[1] : allocationEpoch])
		);
	}
	for (const author of writers) if (!carried.has(author)) carried.set(author, Object.freeze([author, 0, epoch]));
	const rows = [...carried.values()].sort((left, right) => left[0].localeCompare(right[0]));
	// Reserve maximum encoded integer widths for every proposed ceiling. This
	// is finite metadata conservatism, not a dropped unknown-source charge.
	const maximumRows = rows.map(([author, , allocationEpoch]) => [
		author,
		SHIPPING_CHAT_RETAINED_BYTES,
		allocationEpoch,
	]);
	const available =
		SHIPPING_CHAT_RETAINED_BYTES -
		encodeCanonical(
			{
				version: 3,
				messages: [],
				capacity: { version: 1, basisObjectId: state.capacity.basisObjectId, allocations: maximumRows },
			},
			LIMITS
		).byteLength -
		2 -
		rows.reduce((sum, row) => sum + row[1], 0);
	if (available < 0) throw new TypeError("Chat capacity has no allocation metadata headroom");
	const quotient = writers.length === 0 ? 0 : Math.floor(available / writers.length),
		remainder = writers.length === 0 ? 0 : available % writers.length;
	const grants = new Map(writers.map((author, index) => [author, quotient + (index < remainder ? 1 : 0)]));
	const capacity: ShippingChatCapacity = Object.freeze({
		version: 1,
		basisObjectId: state.capacity.basisObjectId,
		allocations: Object.freeze(
			rows.map(([author, ceiling, allocationEpoch]) =>
				Object.freeze([author, ceiling + (grants.get(author) ?? 0), allocationEpoch] as const)
			)
		),
	});
	captureShippingChatCapacityState({ ...state, capacity });
	return capacity;
}

/**
 * One exact native reservation owner. Writer identity/signatures/causal ordering
 * stay native. Same-author accepted source work must drain through the existing
 * replacement chain before fresh target issue; no cross-author pool is spent.
 * @param input
 */
export function createShippingChatCapacityAdmissionPolicy(
	input: Readonly<{
		aclDigest: string;
		epoch: number;
		exactCanonicalLatchedAclBytes?: Uint8Array;
		authenticatedApplicationStateBytes?: Uint8Array;
		authenticatedClosedApplicationStateBytes?: Uint8Array;
		authenticatedSettlementFrontiers?: readonly ShippingChatSettlementFrontier[];
		exactCanonicalGenesisStateBytes: Uint8Array;
	}>
): V3OperationAdmissionPolicy {
	if (input.exactCanonicalLatchedAclBytes === undefined)
		throw new TypeError("Chat capacity requires the native-selected current ACL");
	const aclBytes = new Uint8Array(input.exactCanonicalLatchedAclBytes);
	const digest = Array.from(hashDomain("ts-drp/latched-acl/v3", aclBytes), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	const acl = decodeCanonical(aclBytes) as Readonly<Record<string, unknown>>;
	if (digest !== input.aclDigest || acl.epoch !== input.epoch) throw new TypeError("Chat capacity ACL scope differs");
	shippingChatWriters(aclBytes);
	const closedPostimage =
		input.authenticatedClosedApplicationStateBytes === undefined
			? undefined
			: restoreShippingChatCapacityState(input.authenticatedClosedApplicationStateBytes);
	let state = restoreShippingChatCapacityState(
		input.authenticatedApplicationStateBytes ??
			input.authenticatedClosedApplicationStateBytes ??
			input.exactCanonicalGenesisStateBytes
	);
	let capacity = state.capacity;
	const entries = new Map<
		string,
		{ message: ShippingChatMessage; bytes: Uint8Array; committed: boolean; owners: number }
	>();
	for (const message of state.messages)
		entries.set(`${message.author}\u0000${message.clientOperationId}`, {
			message,
			bytes: encodeCanonical(message),
			committed: true,
			owners: 0,
		});
	const snapshot = (): ShippingChatState =>
		captureShippingChatCapacityState({
			version: 3,
			capacity,
			messages: [...entries.values()]
				.filter((entry) => entry.committed)
				.map((entry) => entry.message)
				.sort((left, right) =>
					left.author < right.author
						? -1
						: left.author > right.author
							? 1
							: left.clientOperationId < right.clientOperationId
								? -1
								: left.clientOperationId > right.clientOperationId
									? 1
									: 0
				),
		});
	return Object.freeze({
		reserve(
			operation: Readonly<Record<string, unknown>>,
			context?: Readonly<{ author: string }>
		): V3OperationAdmissionReservation {
			try {
				encodeCanonical(operation, { maxBytes: 65_536, maxDepth: 16, maxItems: 16_384 });
				if (operation.action === "capacityAllocation") {
					const candidate = record(operation, ["action", "capacity", "epoch", "aclDigest"]);
					const members = dense(acl.members) as readonly Readonly<Record<string, unknown>>[];
					if (
						candidate.epoch !== input.epoch ||
						candidate.aclDigest !== input.aclDigest ||
						!members.some((member) => member.author === context?.author && dense(member.groups).includes("admin"))
					)
						return Object.freeze({ kind: "rejected" });
					if ([...entries.values()].some((entry) => !entry.committed)) return Object.freeze({ kind: "rejected" });
					const exactClosedAllocation =
						closedPostimage !== undefined &&
						compareBytes(encodeCanonical(closedPostimage.capacity), encodeCanonical(candidate.capacity)) === 0 &&
						compareBytes(encodeCanonical(capacity), encodeCanonical(candidate.capacity)) === 0;
					const expected = exactClosedAllocation
						? capacity
						: reallocateShippingChatCapacity({
								state: snapshot(),
								exactCanonicalLatchedAclBytes: aclBytes,
								authenticatedSettlementFrontiers: input.authenticatedSettlementFrontiers ?? [],
							});
					if (compareBytes(encodeCanonical(expected), encodeCanonical(candidate.capacity)) !== 0)
						return Object.freeze({ kind: "rejected" });
					let released = false;
					return Object.freeze({
						kind: "fresh",
						commit: () => {
							if (released) throw new TypeError("Chat capacity reservation was released");
							capacity = expected;
							state = snapshot();
							return "committed";
						},
						release: () => {
							released = true;
						},
					});
				}
				if (operation.action === "causalJoin") {
					if (
						operation.capacity !== undefined &&
						compareBytes(encodeCanonical(operation.capacity), encodeCanonical(capacity)) !== 0
					)
						return Object.freeze({ kind: "rejected" });
					return Object.freeze({ kind: "fresh", commit: () => "committed", release: () => undefined });
				}
				if (operation.action === "acl" || operation.action === "migrationActivation")
					return Object.freeze({ kind: "fresh", commit: () => "committed", release: () => undefined });
				if (operation.action === "migrationRecord") {
					const recordValue = operation.record as Readonly<Record<string, unknown>>;
					if (recordValue?.version !== 2) return Object.freeze({ kind: "rejected" });
					const inherited = captureShippingChatCapacityState(recordValue.applicationState);
					// The room wrapper independently authenticates exact source/target and
					// prefix membership. This does not grant ordinary author admission.
					if (entries.size !== 0) {
						const exactClosedInheritance =
							closedPostimage !== undefined &&
							compareBytes(encodeCanonical(inherited.capacity), encodeCanonical(closedPostimage.capacity)) === 0 &&
							inherited.messages.every((message) => {
								const retained = entries.get(`${message.author}\u0000${message.clientOperationId}`);
								return retained?.committed === true && compareBytes(retained.bytes, encodeCanonical(message)) === 0;
							});
						return exactClosedInheritance
							? Object.freeze({ kind: "fresh", commit: () => "committed", release: () => undefined })
							: Object.freeze({ kind: "rejected" });
					}
					let released = false;
					return Object.freeze({
						kind: "fresh",
						commit: () => {
							if (released) throw new TypeError("Chat inheritance was released");
							capacity = inherited.capacity;
							state = inherited;
							for (const message of inherited.messages)
								entries.set(`${message.author}\u0000${message.clientOperationId}`, {
									message,
									bytes: encodeCanonical(message),
									committed: true,
									owners: 0,
								});
							return "committed";
						},
						release: () => {
							released = true;
						},
					});
				}
				const author = context?.author;
				if (typeof author !== "string" || !AUTHOR.test(author)) return Object.freeze({ kind: "rejected" });
				let operations: readonly unknown[] = [operation];
				if (operation.action === "applicationBatch") {
					const outer = record(operation, ["action", "batch"]),
						batch = record(outer.batch, ["version", "entries"]),
						values = dense(batch.entries);
					if (batch.version !== 1 || values.length < 2 || values.length > 16)
						return Object.freeze({ kind: "rejected" });
					let previous = -1;
					operations = values.map((value) => {
						const entry = record(value, ["logicalTime", "operation"]),
							time = integer(entry.logicalTime);
						if (time <= previous) throw new TypeError("Chat batch order is invalid");
						previous = time;
						return entry.operation;
					});
				}
				const planned = new Map<string, ShippingChatMessage>(),
					outputs: ShippingChatMessage[] = [];
				for (const value of operations) {
					const command = captureShippingChatOperation(value, author),
						message: ShippingChatMessage = Object.freeze({
							author,
							clientOperationId: command.clientOperationId,
							displayTimeMs: command.displayTimeMs,
							text: command.text,
						}),
						key = `${author}\u0000${message.clientOperationId}`,
						prior = planned.get(key) ?? entries.get(key)?.message;
					if (prior !== undefined && compareBytes(encodeCanonical(prior), encodeCanonical(message)) !== 0)
						return Object.freeze({ kind: "conflict" });
					planned.set(key, message);
					outputs.push(message);
				}
				encodeCanonical(outputs, LIMITS);
				const retained = new Map([...entries].map(([key, entry]) => [key, entry.message]));
				for (const [key, message] of planned) retained.set(key, message);
				const ceiling = capacity.allocations.find((row) => row[0] === author)?.[1];
				if (ceiling === undefined || (shippingChatMessageCharges([...retained.values()]).get(author) ?? 0) > ceiling)
					return Object.freeze({ kind: "rejected", reason: "capacity" });
				// Validate the complete possible joined state, not only this author's
				// delta. All pending owners retain their bytes until they join/release.
				captureShippingChatCapacityState({
					version: 3,
					capacity,
					messages: [...retained.values()].sort((left, right) =>
						left.author < right.author
							? -1
							: left.author > right.author
								? 1
								: left.clientOperationId < right.clientOperationId
									? -1
									: left.clientOperationId > right.clientOperationId
										? 1
										: 0
					),
				});
				const held = [...planned].map(([key, message]) => {
					let entry = entries.get(key);
					if (entry === undefined) {
						entry = { message, bytes: encodeCanonical(message), committed: false, owners: 0 };
						entries.set(key, entry);
					}
					entry.owners++;
					return [key, entry] as const;
				});
				let released = false;
				return Object.freeze({
					kind: "fresh",
					commit: () => {
						if (released) throw new TypeError("Chat message reservation was released");
						for (const [, entry] of held) entry.committed = true;
						state = snapshot();
						return "committed";
					},
					release: () => {
						if (released) return;
						released = true;
						for (const [key, entry] of held) {
							entry.owners--;
							if (!entry.committed && entry.owners === 0) entries.delete(key);
						}
					},
				});
			} catch {
				return Object.freeze({ kind: "rejected" });
			}
		},
	});
}
