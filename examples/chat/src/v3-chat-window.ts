import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	V3OperationAdmissionPolicy,
	V3OperationAdmissionPolicyFactory,
	V3OperationAdmissionReservation,
} from "@ts-drp/node/v3-live";
import type { V3RoomApplication, V3RoomProjectionInput } from "@ts-drp/node/v3-room";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { applyPreparedBlueprintOperation } from "@ts-drp/protocol-v3/blueprint-application";

import type { ShippingChatApplication, ShippingChatProjection } from "./v3-chat-application.js";
import {
	createShippingChatGenesisStateBytes,
	reallocateShippingChatCapacity,
	restoreShippingChatCapacityState,
	SHIPPING_CHAT_CAPACITY_STATE_LIMITS,
	SHIPPING_CHAT_RETAINED_BYTES,
	type ShippingChatAllocation,
	type ShippingChatCapacity,
	shippingChatMessageCharges,
	type ShippingChatSettlementFrontier,
	shippingChatWriters,
} from "./v3-chat-capacity.js";
import { captureShippingChatOperation, type ShippingChatMessage } from "./v3-chat-message.js";
import { shippingChatCeilingResourceBound } from "./v3-chat-resource-bound.js";

// Track W: the shipped Chat's new-room format (state version 4, artifact `v3-shipping-chat.v4`,
// examples/chat/window-blueprint). The replicated state is a rolling window: each member's
// allocation ceiling (the unchanged equal split of SHIPPING_CHAT_RETAINED_BYTES) bounds the
// exact canonical bytes of that member's messages in the window, and a member's new message
// pushes out that member's own oldest messages. The compiled reducer owns that rule; this
// module owns the state's validation, the genesis, the native admission policy (which caps what
// a member adds in one epoch at the member's ceiling, so nothing admitted in an epoch leaves the
// window before the epoch is sealed) and the application wiring. Rooms whose genesis signed the
// version-3 (lifetime) format keep examples/chat/src/v3-chat-capacity.ts unchanged.

export const SHIPPING_CHAT_WINDOW_ARTIFACT_ID = "v3-shipping-chat.v4" as const;

export interface ShippingChatWindowState {
	readonly version: 4;
	/** The window, in application order (oldest first); identities are unique. */
	readonly messages: readonly ShippingChatMessage[];
	readonly capacity: ShippingChatCapacity;
}

// The same state limits as the lifetime format (32,768 bytes, 16,384 items, depth 16): Track Q's
// approved ordinary resource bound rests on every Chat state passing a capture under them.
const LIMITS = SHIPPING_CHAT_CAPACITY_STATE_LIMITS;
type ResourceBoundReader = NonNullable<V3RoomApplication["readOrdinaryApplicationResourceBound"]>;
type ResourceCatalog = Parameters<ResourceBoundReader>[0]["catalog"];
/** Track Q's exact-entry check (v3-chat-application.ts `resourceBoundBases`), passed in by the caller. */
export type ShippingChatResourceBoundBases = (
	input: unknown,
	expected: ResourceCatalog,
	/** True for the incremental projection's input (its material has no candidate). */
	projection?: boolean
) => readonly Uint8Array[] | undefined;
const OPERATION_LIMITS = Object.freeze({ maxBytes: 65_536, maxDepth: 16, maxItems: 16_384 });
const AUTHOR = /^[0-9a-f]{64}$/u;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
	)
		throw new TypeError("Chat window record is invalid");
	const own = Reflect.ownKeys(value);
	if (
		own.length !== keys.length ||
		own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
		keys.some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable !== true || !("value" in descriptor);
		})
	)
		throw new TypeError("Chat window fields are invalid");
	return value as Readonly<Record<string, unknown>>;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Chat window integer is invalid");
	return value === 0 ? 0 : value;
}
function dense(value: unknown): readonly unknown[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		throw new TypeError("Chat window array is invalid");
	return value;
}
function objectId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024)
		throw new TypeError("Chat window basis object is invalid");
	return value;
}
const identityOf = (message: Readonly<{ author: string; clientOperationId: string }>): string =>
	`${message.author}\u0000${message.clientOperationId}`;

/**
 * Exact canonical bytes of one retained message record: the unit every share is charged in.
 * @param message - A captured message.
 * @returns Its canonical encoding's length.
 */
export function shippingChatRecordBytes(message: ShippingChatMessage): number {
	return encodeCanonical(message).byteLength;
}

/**
 * Validates a complete version-4 state; no capacity authority is inferred from unverified bytes.
 * @param value - Untrusted state.
 * @returns The captured, frozen state.
 */
export function captureShippingChatWindowState(value: unknown): ShippingChatWindowState {
	const state = record(value, ["version", "messages", "capacity"]);
	const capacity = record(state.capacity, ["version", "basisObjectId", "allocations"]);
	if (state.version !== 4 || capacity.version !== 1) throw new TypeError("Chat window version is invalid");
	let previous = "";
	const allocations: ShippingChatAllocation[] = [];
	for (const value of dense(capacity.allocations)) {
		const row = dense(value);
		if (row.length !== 3 || typeof row[0] !== "string" || !AUTHOR.test(row[0]) || row[0] <= previous)
			throw new TypeError("Chat window allocation is invalid");
		previous = row[0];
		allocations.push(Object.freeze([row[0], integer(row[1]), integer(row[2])] as const));
	}
	const messages: ShippingChatMessage[] = [];
	const identities = new Set<string>();
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
			throw new TypeError("Chat window message is invalid");
		const message = Object.freeze({
			author: row.author,
			clientOperationId: row.clientOperationId,
			displayTimeMs: integer(row.displayTimeMs),
			text: row.text,
		});
		const identity = identityOf(message);
		if (identities.has(identity)) throw new TypeError("Chat window identities repeat");
		identities.add(identity);
		messages.push(message);
	}
	const result: ShippingChatWindowState = Object.freeze({
		version: 4,
		messages: Object.freeze(messages),
		capacity: Object.freeze({
			version: 1,
			basisObjectId: objectId(capacity.basisObjectId),
			allocations: Object.freeze(allocations),
		}),
	});
	const ceilingByAuthor = new Map(allocations.map(([author, ceiling]) => [author, ceiling]));
	for (const [author, charge] of shippingChatMessageCharges(messages))
		if (charge > (ceilingByAuthor.get(author) ?? -1)) throw new TypeError("Chat window share is exceeded");
	// The same whole-budget check as the lifetime format: the empty state, the largest
	// messages-array count framing (two bytes) and every ceiling fit the retained budget.
	const emptyBytes = encodeCanonical({ ...result, messages: [] }, LIMITS).byteLength;
	if (emptyBytes + 2 + allocations.reduce((sum, row) => sum + row[1], 0) > SHIPPING_CHAT_RETAINED_BYTES)
		throw new TypeError("Chat window shares are overbooked");
	encodeCanonical(result, LIMITS);
	return result;
}
/**
 * @param value - Untrusted state.
 * @returns Its exact canonical bytes.
 */
export function shippingChatWindowStateBytes(value: unknown): Uint8Array {
	return encodeCanonical(captureShippingChatWindowState(value), LIMITS);
}
/**
 * @param bytes - Exact canonical state bytes.
 * @returns The captured state.
 */
export function restoreShippingChatWindowState(bytes: Uint8Array): ShippingChatWindowState {
	const state = captureShippingChatWindowState(decodeCanonical(bytes, LIMITS));
	if (compareBytes(shippingChatWindowStateBytes(state), bytes) !== 0)
		throw new TypeError("Chat window state is not canonical");
	return state;
}

/**
 * Sole NEW-genesis owner of the window format: the lifetime format's equal split of the same
 * budget among the genesis roster, as window shares. It grants no portable authentication.
 * @param input - The exact canonical genesis ACL.
 * @returns The exact canonical version-4 genesis state.
 */
export function createShippingChatWindowGenesisStateBytes(
	input: Readonly<{ exactCanonicalLatchedAclBytes: Uint8Array }>
): Uint8Array {
	const lifetime = restoreShippingChatCapacityState(createShippingChatGenesisStateBytes(input));
	return shippingChatWindowStateBytes({ version: 4, messages: [], capacity: lifetime.capacity });
}

/**
 * The reducer's window rule, mirrored for the admission policy's own view (its reallocation
 * input). The compiled reducer remains the only owner of the replicated state.
 * @param messages - The window, mutated in place.
 * @param ceiling - The author's ceiling, undefined when the author has no allocation.
 * @param author - The author whose share must fit.
 */
function fitShare(messages: ShippingChatMessage[], ceiling: number | undefined, author: string): void {
	const limit = ceiling ?? 0;
	let charge = messages.reduce(
		(sum, message) => sum + (message.author === author ? shippingChatRecordBytes(message) : 0),
		0
	);
	while (charge > limit) {
		const oldest = messages.findIndex((message) => message.author === author);
		charge -= shippingChatRecordBytes(messages[oldest] as ShippingChatMessage);
		messages.splice(oldest, 1);
	}
}
function applyMessage(
	messages: ShippingChatMessage[],
	capacity: ShippingChatCapacity,
	message: ShippingChatMessage
): void {
	const held = messages.findIndex((row) => identityOf(row) === identityOf(message));
	if (held >= 0) messages.splice(held, 1);
	messages.push(message);
	fitShare(messages, capacity.allocations.find((row) => row[0] === message.author)?.[1], message.author);
}

/**
 * The lifetime format's reviewed reallocation formula over a window: released incarnations keep
 * a ceiling equal to their current window charge, later Writers share what is free.
 * @param input - The current window state, the native-selected ACL and settlement frontiers.
 * @returns The reallocated capacity record.
 */
export function reallocateShippingChatWindowCapacity(
	input: Readonly<{
		state: ShippingChatWindowState;
		exactCanonicalLatchedAclBytes: Uint8Array;
		authenticatedSettlementFrontiers: readonly ShippingChatSettlementFrontier[];
	}>
): ShippingChatCapacity {
	const state = captureShippingChatWindowState(input.state);
	const capacity = reallocateShippingChatCapacity({
		// The same capacity and charges, presented as the lifetime format's identity-sorted view.
		state: {
			version: 3,
			messages: [...state.messages].sort((left, right) =>
				identityOf(left) < identityOf(right) ? -1 : identityOf(left) > identityOf(right) ? 1 : 0
			),
			capacity: state.capacity,
		},
		exactCanonicalLatchedAclBytes: input.exactCanonicalLatchedAclBytes,
		authenticatedSettlementFrontiers: input.authenticatedSettlementFrontiers,
	});
	captureShippingChatWindowState({ ...state, capacity });
	return capacity;
}

interface EpochEntry {
	readonly message: ShippingChatMessage;
	readonly bytes: Uint8Array;
	committed: boolean;
	owners: number;
}

/**
 * One exact native reservation owner per epoch. Writer identity, signatures and causal order stay
 * native. A member may add at most their ceiling in canonical message bytes within one epoch
 * (distinct identities, exact retries of window messages included), so the reducer's window rule
 * never pushes out a message admitted in the same epoch; acceptance depends only on the set of a
 * member's identities in the epoch, never on order, so journal replay and the creator's
 * closed-postimage transcript check accept what was admitted. No cross-member pool is spent.
 * @param input - The native policy context and the exact genesis state.
 * @returns The admission policy.
 */
export function createShippingChatWindowAdmissionPolicy(
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
		throw new TypeError("Chat window requires the native-selected current ACL");
	const aclBytes = new Uint8Array(input.exactCanonicalLatchedAclBytes);
	const acl = decodeCanonical(aclBytes) as Readonly<Record<string, unknown>>;
	if (hex(hashDomain("ts-drp/latched-acl/v3", aclBytes)) !== input.aclDigest || acl.epoch !== input.epoch)
		throw new TypeError("Chat window ACL scope differs");
	shippingChatWriters(aclBytes);
	const closedPostimage =
		input.authenticatedClosedApplicationStateBytes === undefined
			? undefined
			: restoreShippingChatWindowState(input.authenticatedClosedApplicationStateBytes);
	const base = restoreShippingChatWindowState(
		input.authenticatedApplicationStateBytes ??
			input.authenticatedClosedApplicationStateBytes ??
			input.exactCanonicalGenesisStateBytes
	);
	let capacity = base.capacity;
	// The authenticated base window's identities (conflicts and exact retries).
	let held = new Map(base.messages.map((message) => [identityOf(message), encodeCanonical(message)]));
	// This policy's view of the window after committed work (the reallocation input only).
	let window = [...base.messages];
	// Every identity reserved in this epoch, pending or committed.
	const entries = new Map<string, EpochEntry>();
	const fresh = (commit: () => void, release: () => void = () => undefined): V3OperationAdmissionReservation =>
		Object.freeze({
			kind: "fresh",
			commit: () => {
				commit();
				return "committed";
			},
			release,
		});
	const snapshot = (): ShippingChatWindowState =>
		captureShippingChatWindowState({ version: 4, capacity, messages: window });
	return Object.freeze({
		reserve(
			operation: Readonly<Record<string, unknown>>,
			context?: Readonly<{ author: string }>
		): V3OperationAdmissionReservation {
			try {
				encodeCanonical(operation, OPERATION_LIMITS);
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
						: reallocateShippingChatWindowCapacity({
								state: snapshot(),
								exactCanonicalLatchedAclBytes: aclBytes,
								authenticatedSettlementFrontiers: input.authenticatedSettlementFrontiers ?? [],
							});
					if (compareBytes(encodeCanonical(expected), encodeCanonical(candidate.capacity)) !== 0)
						return Object.freeze({ kind: "rejected" });
					let released = false;
					return fresh(
						() => {
							if (released) throw new TypeError("Chat window reservation was released");
							capacity = expected;
							for (const author of new Set(window.map((message) => message.author)))
								fitShare(window, capacity.allocations.find((row) => row[0] === author)?.[1], author);
						},
						() => {
							released = true;
						}
					);
				}
				if (operation.action === "causalJoin") {
					if (
						operation.capacity !== undefined &&
						compareBytes(encodeCanonical(operation.capacity), encodeCanonical(capacity)) !== 0
					)
						return Object.freeze({ kind: "rejected" });
					return fresh(() => undefined);
				}
				if (operation.action === "acl" || operation.action === "migrationActivation") return fresh(() => undefined);
				if (operation.action === "migrationRecord") {
					const recordValue = operation.record as Readonly<Record<string, unknown>>;
					if (recordValue?.version !== 2) return Object.freeze({ kind: "rejected" });
					// Only a window-format state is inherited: a lifetime-format state is refused here
					// and by the reducer, so no room changes format.
					const inherited = captureShippingChatWindowState(recordValue.applicationState);
					// The room wrapper independently authenticates exact source/target and prefix
					// membership. This does not grant ordinary author admission.
					if (held.size !== 0 || entries.size !== 0) {
						const exactClosedInheritance =
							closedPostimage !== undefined &&
							compareBytes(encodeCanonical(inherited.capacity), encodeCanonical(closedPostimage.capacity)) === 0 &&
							inherited.messages.every((message) => {
								const retained = held.get(identityOf(message));
								return retained !== undefined && compareBytes(retained, encodeCanonical(message)) === 0;
							});
						return exactClosedInheritance ? fresh(() => undefined) : Object.freeze({ kind: "rejected" });
					}
					let released = false;
					return fresh(
						() => {
							if (released) throw new TypeError("Chat window inheritance was released");
							capacity = inherited.capacity;
							window = [...inherited.messages];
							held = new Map(inherited.messages.map((message) => [identityOf(message), encodeCanonical(message)]));
						},
						() => {
							released = true;
						}
					);
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
				const planned = new Map<string, Readonly<{ message: ShippingChatMessage; bytes: Uint8Array }>>();
				const ordered: ShippingChatMessage[] = [];
				for (const value of operations) {
					const command = captureShippingChatOperation(value, author),
						message: ShippingChatMessage = Object.freeze({
							author,
							clientOperationId: command.clientOperationId,
							displayTimeMs: command.displayTimeMs,
							text: command.text,
						}),
						key = identityOf(message),
						bytes = encodeCanonical(message),
						prior = planned.get(key)?.bytes ?? entries.get(key)?.bytes ?? held.get(key);
					if (prior !== undefined && compareBytes(prior, bytes) !== 0) return Object.freeze({ kind: "conflict" });
					planned.set(key, { message, bytes });
					ordered.push(message);
				}
				encodeCanonical(ordered, LIMITS);
				const ceiling = capacity.allocations.find((row) => row[0] === author)?.[1];
				// The joined window (committed work plus this reservation) passes the state check under
				// LIMITS before anything is admitted, as the lifetime policy captures its joined state.
				const joined = [...window];
				for (const message of ordered) applyMessage(joined, capacity, message);
				captureShippingChatWindowState({ version: 4, capacity, messages: joined });
				// This epoch's charge: every distinct identity of this author reserved in the epoch
				// (pending or committed), exact retries of window messages included, plus the new ones.
				let charge = 0;
				for (const entry of entries.values()) if (entry.message.author === author) charge += entry.bytes.byteLength;
				for (const [key, value] of planned) if (!entries.has(key)) charge += value.bytes.byteLength;
				if (ceiling === undefined || charge > ceiling) return Object.freeze({ kind: "rejected", reason: "capacity" });
				const owned = [...planned].map(([key, value]) => {
					let entry = entries.get(key);
					if (entry === undefined) {
						entry = { message: value.message, bytes: value.bytes, committed: false, owners: 0 };
						entries.set(key, entry);
					}
					entry.owners++;
					return [key, entry] as const;
				});
				let released = false;
				return fresh(
					() => {
						if (released) throw new TypeError("Chat message reservation was released");
						for (const [, entry] of owned) entry.committed = true;
						for (const message of ordered) applyMessage(window, capacity, message);
					},
					() => {
						if (released) return;
						released = true;
						for (const [key, entry] of owned) {
							entry.owners--;
							if (!entry.committed && entry.owners === 0) entries.delete(key);
						}
					}
				);
			} catch {
				return Object.freeze({ kind: "rejected" });
			}
		},
	});
}

/**
 * The window-format application: one genuine compiled kernel (`v3-shipping-chat.v4`); the native
 * policy owns per-epoch byte admission.
 * @param input - The window catalog, its digest and the exact genesis ACL.
 * @param readResourceBases - Track Q's exact catalog-entry and material check for the ordinary
 * resource bound reader (v3-chat-application.ts `resourceBoundBases`).
 * @returns The room application.
 */
export async function createShippingChatWindowApplication(
	input: Readonly<{
		catalog: TrustedBlueprintCatalog;
		blueprintDigest: string;
		exactCanonicalGenesisLatchedAclBytes: Uint8Array;
	}>,
	readResourceBases: ShippingChatResourceBoundBases
): Promise<ShippingChatApplication> {
	const catalog = input.catalog,
		blueprintDigest = input.blueprintDigest;
	const genesisBytes = createShippingChatWindowGenesisStateBytes({
		exactCanonicalLatchedAclBytes: new Uint8Array(input.exactCanonicalGenesisLatchedAclBytes),
	});
	const genesis = restoreShippingChatWindowState(genesisBytes);
	const resolved = catalog.resolve(blueprintDigest);
	if (resolved.artifactId !== SHIPPING_CHAT_WINDOW_ARTIFACT_ID)
		throw new TypeError("shipping Chat window artifact differs");
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	const runtime = await prepareBlueprintRuntime({
		preparedBlueprintAdmission: admission,
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		expectedBlueprintDigest: blueprintDigest,
		exactArtifactBytes: resolved.exactArtifactBytes,
	});
	// Ordinary resource bound: Track Q's rule and value (approved 2026-10-20), unchanged by the
	// window. Every window state passes `captureShippingChatWindowState`, which encodes it under
	// SHIPPING_CHAT_CAPACITY_STATE_LIMITS: the reducer keeps each member's window charge within the
	// member's ceiling and the ceilings within 32,768 bytes; the projection and migration re-capture
	// every state; and the admission policy captures the joined window of every message reservation,
	// every inherited state and every capacity allocation before admitting it. So that ceiling
	// dominates every state, for any material; it reads no operation. Planning only: it grants no
	// validity, admission, authority or credit, and the room re-checks every base under it.
	const resourceCatalog: ResourceCatalog = Object.freeze({
		blueprintDigest: resolved.blueprintDigest,
		artifactId: resolved.artifactId,
		artifactDigest: resolved.artifactDigest,
		catalogDigest: resolved.evidence.catalogDigest,
		runtimeProfile: resolved.runtimeProfile,
		exactArtifactBytes: resolved.exactArtifactBytes.slice(),
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice(),
	});
	const readOrdinaryApplicationResourceBound = shippingChatCeilingResourceBound((value, projection) => {
		const bases = readResourceBases(value, resourceCatalog, projection);
		if (bases === undefined) return false;
		// Only authenticated window states: captured, canonical, within the ceiling.
		for (const base of bases) restoreShippingChatWindowState(base);
		return true;
	}, LIMITS);
	const project = (projection: V3RoomProjectionInput): ShippingChatProjection => {
		let state: unknown =
			projection.authenticatedBase === undefined
				? genesis
				: restoreShippingChatWindowState(projection.authenticatedBase.exactCanonicalApplicationStateBytes);
		for (const row of projection.currentEpochOperations) {
			if (row.operation.action === "acl") continue;
			state = applyPreparedBlueprintOperation({
				expectedBlueprintDigest: blueprintDigest,
				preparedBlueprintRuntime: runtime,
				state,
				operation: row.operation,
				executionContext: { author: row.author },
			}).state;
		}
		const window = restoreShippingChatWindowState(shippingChatWindowStateBytes(state));
		return Object.freeze({
			messages: window.messages,
			capacity: window.capacity,
			transportPeerAuthors: Object.freeze([]),
			writerAuthors: Object.freeze([]),
			epoch: projection.authenticatedBase?.epoch ?? 0,
		});
	};
	return Object.freeze({
		catalog,
		readOrdinaryApplicationResourceBound,
		createGenesisApplicationStateBytes(
			context: Readonly<{ objectId: string; exactCanonicalLatchedAclBytes: Uint8Array }>
		): Uint8Array {
			const acl = decodeCanonical(context.exactCanonicalLatchedAclBytes);
			if (typeof acl !== "object" || acl === null || Reflect.get(acl, "objectId") !== context.objectId)
				throw new TypeError("Chat signed genesis object differs");
			return createShippingChatWindowGenesisStateBytes({
				exactCanonicalLatchedAclBytes: new Uint8Array(context.exactCanonicalLatchedAclBytes),
			});
		},
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		snapshotReadPolicy: "authenticated-public" as const,
		bootstrapOperation: Object.freeze({ action: "causalJoin", capacity: genesis.capacity }),
		batchableOperationActions: Object.freeze(["message"]),
		displacementPolicies: Object.freeze({ message: "rebase" as const }),
		displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string {
			const id = operation.clientOperationId;
			if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id))
				throw new TypeError("Chat identity is invalid");
			return id;
		},
		projectAcceptedOperations: project,
		createOperationAdmissionPolicy: (context: Parameters<V3OperationAdmissionPolicyFactory>[0]) =>
			createShippingChatWindowAdmissionPolicy({ ...context, exactCanonicalGenesisStateBytes: genesisBytes }),
		migration: Object.freeze({
			inheritAuthenticatedState: true as const,
			canonicalStateBytes(projection: ShippingChatProjection): Uint8Array {
				return shippingChatWindowStateBytes({
					version: 4,
					messages: projection.messages,
					capacity: projection.capacity,
				});
			},
			prepare(_accepted: readonly unknown[], exactCanonicalSourceStateBytes?: Uint8Array) {
				if (exactCanonicalSourceStateBytes === undefined)
					throw new TypeError("Chat window migration requires authenticated source state");
				const bytes = shippingChatWindowStateBytes(restoreShippingChatWindowState(exactCanonicalSourceStateBytes));
				return Object.freeze({ exactCanonicalApplicationStateBytes: bytes, importOperations: Object.freeze([]) });
			},
			containsInheritedOperation(
				operation: Readonly<Record<string, unknown>>,
				exactCanonicalStateBytes: Uint8Array,
				context?: Readonly<{ sourceAuthor: string }>
			): boolean {
				if (context === undefined || operation.action !== "message") return false;
				try {
					return restoreShippingChatWindowState(exactCanonicalStateBytes).messages.some(
						(message) =>
							message.author === context.sourceAuthor &&
							message.clientOperationId === operation.clientOperationId &&
							message.displayTimeMs === operation.displayTimeMs &&
							message.text === operation.text
					);
				} catch {
					return false;
				}
			},
		}),
	});
}
