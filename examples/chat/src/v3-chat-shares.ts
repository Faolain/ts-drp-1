import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
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
	SHIPPING_CHAT_CAPACITY_STATE_LIMITS,
	SHIPPING_CHAT_RETAINED_BYTES,
	shippingChatWriters,
} from "./v3-chat-capacity.js";
import { captureShippingChatOperation, type ShippingChatMessage } from "./v3-chat-message.js";
import type { ShippingChatResourceBoundBases } from "./v3-chat-window.js";

// Track W2: the shipped Chat's membership-aware format (state version 5, artifact
// `v3-shipping-chat.v5`, examples/chat/shares-blueprint), the owner's "guarantee and borrow"
// rule. The replicated state is a rolling window within one budget (`windowBytes`):
// - allowance: every share holder may add `allowanceBytes` per checkpoint, fixed for the room
//   from SHIPPING_CHAT_SHARE_HOLDERS holders, so a displaced holder's rebase always re-fits;
// - guarantee: an equal split of the budget among current holders (never below the allowance);
// - borrowing: the window keeps any messages up to the budget; when one does not fit, departed
//   members' messages leave first, oldest first, then the oldest message of an author above
//   their guarantee (the compiled reducer owns this rule);
// - membership: an admin's share update (`capacityAllocation`), a pure idempotent function of
//   the checkpoint's latched ACL and the current rows, keeps rows of ACL members, adds rows for
//   new Writers from the next checkpoint (while there are fewer than 16) and drops the rest. It
//   expires when it misses its checkpoint (it has an identity), and the admin's page issues it
//   again in the next one.
// This module owns the state's validation, the genesis, the share formula, the native admission
// policy and the application wiring. Rooms whose genesis signed version 3 or 4 keep
// v3-chat-capacity.ts and v3-chat-window.ts unchanged; nothing migrates between formats.

export const SHIPPING_CHAT_SHARES_ARTIFACT_ID = "v3-shipping-chat.v5" as const;
/** The most share holders a room has at once (the owner's N_max); the allowance is sized for it. */
export const SHIPPING_CHAT_SHARE_HOLDERS = 16;

/** One share row: the holder, its guarantee, and the first checkpoint whose base holds the row. */
export type ShippingChatShareRow = readonly [author: string, guaranteeBytes: number, sinceEpoch: number];
export interface ShippingChatShares {
	readonly version: 2;
	readonly basisObjectId: string;
	/** What each holder may add per checkpoint, and the largest message; fixed for the room. */
	readonly allowanceBytes: number;
	/** The window budget for this many rows: canonical message records never exceed it. */
	readonly windowBytes: number;
	/** At most 16 rows, sorted by author; the guarantees are the equal split of `windowBytes`. */
	readonly allocations: readonly ShippingChatShareRow[];
}
export interface ShippingChatSharesState {
	readonly version: 5;
	/** The window, in application order (oldest first); identities are unique. */
	readonly messages: readonly ShippingChatMessage[];
	readonly capacity: ShippingChatShares;
}
export interface ShippingChatShareUpdate {
	readonly action: "capacityAllocation";
	readonly capacity: ShippingChatShares;
	readonly epoch: number;
	readonly aclDigest: string;
}

// The same state limits as the v3 and v4 formats (32,768 bytes, 16,384 items, depth 16): Track
// Q's approved ordinary resource bound rests on every Chat state passing a capture under them.
const LIMITS = SHIPPING_CHAT_CAPACITY_STATE_LIMITS;
type ResourceBoundReader = NonNullable<V3RoomApplication["readOrdinaryApplicationResourceBound"]>;
type ResourceCatalog = Parameters<ResourceBoundReader>[0]["catalog"];
const OPERATION_LIMITS = Object.freeze({ maxBytes: 65_536, maxDepth: 16, maxItems: 16_384 });
const AUTHOR = /^[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const CLIENT_OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const WIDEST = SHIPPING_CHAT_RETAINED_BYTES;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const rejected = (reason?: "capacity"): V3OperationAdmissionReservation =>
	Object.freeze(reason === undefined ? { kind: "rejected" as const } : { kind: "rejected" as const, reason });

function record(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
	)
		throw new TypeError("Chat shares record is invalid");
	const own = Reflect.ownKeys(value);
	if (
		own.length !== keys.length ||
		own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
		keys.some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor?.enumerable !== true || !("value" in descriptor);
		})
	)
		throw new TypeError("Chat shares fields are invalid");
	return value as Readonly<Record<string, unknown>>;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Chat shares integer is invalid");
	return value === 0 ? 0 : value;
}
function dense(value: unknown): readonly unknown[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		throw new TypeError("Chat shares array is invalid");
	return value;
}
function objectId(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 1024)
		throw new TypeError("Chat shares basis object is invalid");
	return value;
}
const identityOf = (message: Readonly<{ author: string; clientOperationId: string }>): string =>
	`${message.author}\u0000${message.clientOperationId}`;
const recordBytes = (message: ShippingChatMessage): number => encodeCanonical(message).byteLength;
const sameValue = (left: unknown, right: unknown): boolean =>
	compareBytes(encodeCanonical(left), encodeCanonical(right)) === 0;

// The window budget depends only on the basis and the row count; cached per (count, basis).
const budgets = new Map<string, number>();
/**
 * The window budget for `holders` share rows: 32,768 bytes less the empty state with that many
 * rows at their widest values (every integer at its largest), less two bytes for the growth of
 * the messages array's count. Every state with at most that many rows and at most this many
 * bytes of message records therefore encodes within 32,768 bytes.
 * @param basisObjectId - The room's object id (the capacity basis).
 * @param holders - The number of share rows.
 * @returns The budget in canonical message-record bytes.
 */
export function shippingChatSharesWindowBytes(basisObjectId: string, holders: number): number {
	const key = `${holders}\u0000${basisObjectId}`;
	const cached = budgets.get(key);
	if (cached !== undefined) return cached;
	const empty = encodeCanonical(
		{
			version: 5,
			messages: [],
			capacity: {
				version: 2,
				basisObjectId: objectId(basisObjectId),
				allowanceBytes: WIDEST,
				windowBytes: WIDEST,
				allocations: Array.from({ length: holders }, () => ["0".repeat(64), WIDEST, Number.MAX_SAFE_INTEGER]),
			},
		},
		LIMITS
	).byteLength;
	const budget = SHIPPING_CHAT_RETAINED_BYTES - 2 - empty;
	if (budgets.size > 256) budgets.clear();
	budgets.set(key, budget);
	return budget;
}
/**
 * The room's fixed allowance: the guarantee at SHIPPING_CHAT_SHARE_HOLDERS holders, so every
 * guarantee (at most that many holders) is at least the allowance.
 * @param basisObjectId - The room's object id.
 * @returns What each holder may add per checkpoint, and the largest message record.
 */
export function shippingChatSharesAllowanceBytes(basisObjectId: string): number {
	return Math.floor(
		shippingChatSharesWindowBytes(basisObjectId, SHIPPING_CHAT_SHARE_HOLDERS) / SHIPPING_CHAT_SHARE_HOLDERS
	);
}
/** The equal split of the budget for these rows (author, sinceEpoch), already sorted by author. */
function split(
	basisObjectId: string,
	rows: readonly (readonly [author: string, sinceEpoch: number])[]
): ShippingChatShares {
	const budget = shippingChatSharesWindowBytes(basisObjectId, rows.length);
	const share = rows.length === 0 ? 0 : Math.floor(budget / rows.length);
	const remainder = rows.length === 0 ? 0 : budget % rows.length;
	return Object.freeze({
		version: 2,
		basisObjectId,
		allowanceBytes: shippingChatSharesAllowanceBytes(basisObjectId),
		windowBytes: budget,
		allocations: Object.freeze(
			rows.map(([author, since], index) => Object.freeze([author, share + (index < remainder ? 1 : 0), since] as const))
		),
	});
}

/**
 * Validates a share record: at most 16 rows sorted by author, the allowance and budget of the
 * formula, and the exact equal split.
 * @param value - Untrusted capacity record.
 * @returns The captured, frozen record.
 */
function captureShares(value: unknown): ShippingChatShares {
	const capacity = record(value, ["version", "basisObjectId", "allowanceBytes", "windowBytes", "allocations"]);
	if (capacity.version !== 2) throw new TypeError("Chat shares version is invalid");
	const basisObjectId = objectId(capacity.basisObjectId);
	const rows: (readonly [string, number, number])[] = [];
	let previous = "";
	for (const value of dense(capacity.allocations)) {
		const row = dense(value);
		if (row.length !== 3 || typeof row[0] !== "string" || !AUTHOR.test(row[0]) || row[0] <= previous)
			throw new TypeError("Chat share row is invalid");
		previous = row[0];
		rows.push([row[0], integer(row[1]), integer(row[2])]);
	}
	if (rows.length > SHIPPING_CHAT_SHARE_HOLDERS) throw new TypeError("Chat shares have too many holders");
	const expected = split(
		basisObjectId,
		rows.map(([author, , since]) => [author, since] as const)
	);
	if (
		integer(capacity.allowanceBytes) !== expected.allowanceBytes ||
		integer(capacity.windowBytes) !== expected.windowBytes ||
		rows.some((row, index) => row[1] !== expected.allocations[index]?.[1])
	)
		throw new TypeError("Chat shares differ from the equal split");
	return expected;
}

/**
 * Validates a complete version-5 state; no capacity authority is inferred from unverified bytes.
 * Messages of authors without a row (departed members) are allowed, within the budget.
 * @param value - Untrusted state.
 * @returns The captured, frozen state.
 */
export function captureShippingChatSharesState(value: unknown): ShippingChatSharesState {
	const state = record(value, ["version", "messages", "capacity"]);
	if (state.version !== 5) throw new TypeError("Chat shares version is invalid");
	const capacity = captureShares(state.capacity);
	const messages: ShippingChatMessage[] = [];
	const identities = new Set<string>();
	let total = 0;
	for (const value of dense(state.messages)) {
		const row = record(value, ["author", "clientOperationId", "displayTimeMs", "text"]);
		if (
			typeof row.author !== "string" ||
			!AUTHOR.test(row.author) ||
			typeof row.clientOperationId !== "string" ||
			!CLIENT_OPERATION_ID.test(row.clientOperationId) ||
			typeof row.text !== "string" ||
			row.text.length === 0
		)
			throw new TypeError("Chat shares message is invalid");
		const message = Object.freeze({
			author: row.author,
			clientOperationId: row.clientOperationId,
			displayTimeMs: integer(row.displayTimeMs),
			text: row.text,
		});
		const identity = identityOf(message);
		if (identities.has(identity)) throw new TypeError("Chat shares identities repeat");
		identities.add(identity);
		total += recordBytes(message);
		messages.push(message);
	}
	if (total > capacity.windowBytes) throw new TypeError("Chat shares window exceeds its budget");
	const result: ShippingChatSharesState = Object.freeze({ version: 5, messages: Object.freeze(messages), capacity });
	encodeCanonical(result, LIMITS);
	return result;
}
/**
 * @param value - Untrusted state.
 * @returns Its exact canonical bytes.
 */
export function shippingChatSharesStateBytes(value: unknown): Uint8Array {
	return encodeCanonical(captureShippingChatSharesState(value), LIMITS);
}
/**
 * @param bytes - Exact canonical state bytes.
 * @returns The captured state.
 */
export function restoreShippingChatSharesState(bytes: Uint8Array): ShippingChatSharesState {
	const state = captureShippingChatSharesState(decodeCanonical(bytes, LIMITS));
	if (compareBytes(shippingChatSharesStateBytes(state), bytes) !== 0)
		throw new TypeError("Chat shares state is not canonical");
	return state;
}

interface ChatAcl {
	readonly bytes: Uint8Array;
	readonly digest: string;
	readonly epoch: number;
	readonly objectId: string;
	readonly members: ReadonlySet<string>;
	readonly admins: ReadonlySet<string>;
	/** Writers in author order. */
	readonly writers: readonly string[];
}
function readAcl(exactCanonicalLatchedAclBytes: Uint8Array): ChatAcl {
	const bytes = new Uint8Array(exactCanonicalLatchedAclBytes);
	// Canonical, sorted and well formed (the lifetime format's reader); it lists the Writers.
	const writers = shippingChatWriters(bytes);
	const acl = decodeCanonical(bytes) as Readonly<Record<string, unknown>>;
	const members = new Set<string>();
	const admins = new Set<string>();
	for (const value of dense(acl.members)) {
		const member = record(value, ["author", "finalityKey", "groups"]);
		members.add(member.author as string);
		if (dense(member.groups).includes("admin")) admins.add(member.author as string);
	}
	return Object.freeze({
		bytes,
		digest: hex(hashDomain("ts-drp/latched-acl/v3", bytes)),
		epoch: integer(acl.epoch),
		objectId: objectId(acl.objectId),
		members,
		admins,
		writers,
	});
}

/**
 * Sole NEW-genesis owner of the v5 format: a share from checkpoint 0 for each genesis Writer (the
 * first 16 in author order). It grants no portable authentication.
 * @param input - The exact canonical genesis ACL.
 * @returns The exact canonical version-5 genesis state.
 */
export function createShippingChatSharesGenesisStateBytes(
	input: Readonly<{ exactCanonicalLatchedAclBytes: Uint8Array }>
): Uint8Array {
	const acl = readAcl(input.exactCanonicalLatchedAclBytes);
	const rows = acl.writers.slice(0, SHIPPING_CHAT_SHARE_HOLDERS).map((author) => [author, 0] as const);
	return shippingChatSharesStateBytes({ version: 5, messages: [], capacity: split(acl.objectId, rows) });
}

/**
 * The share formula for a checkpoint: keep the row of every ACL member (Writer, or a member that
 * lost `writer` and keeps custody of its old work), add a row from the next checkpoint for each
 * Writer without one, in author order, while there are fewer than 16 rows, drop rows of authors
 * absent from the ACL, and split the budget equally. It reads no messages, and it is idempotent:
 * applied to its own result it returns that result, so every share update admitted in a
 * checkpoint has the same content.
 * @param input - The current rows and the checkpoint's exact latched ACL.
 * @returns The rows for the checkpoint's share update.
 */
export function shareShippingChatWindow(
	input: Readonly<{ capacity: ShippingChatShares; exactCanonicalLatchedAclBytes: Uint8Array }>
): ShippingChatShares {
	const current = captureShares(input.capacity);
	const acl = readAcl(input.exactCanonicalLatchedAclBytes);
	if (acl.objectId !== current.basisObjectId) throw new TypeError("Chat shares basis differs from the ACL");
	const rows: (readonly [string, number])[] = current.allocations
		.filter(([author]) => acl.members.has(author))
		.map(([author, , since]) => [author, since] as const);
	const held = new Set(rows.map(([author]) => author));
	for (const writer of acl.writers) {
		if (rows.length >= SHIPPING_CHAT_SHARE_HOLDERS) break;
		if (!held.has(writer)) rows.push([writer, acl.epoch + 1]);
	}
	rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return split(current.basisObjectId, rows);
}

/**
 * The share update an admin's page issues in a checkpoint, or undefined when the rows already
 * match the checkpoint's ACL.
 * @param input - The current rows and the checkpoint's exact latched ACL.
 * @returns The `capacityAllocation` operation, bound to the checkpoint's epoch and ACL digest.
 */
export function shippingChatShareUpdate(
	input: Readonly<{ capacity: ShippingChatShares; exactCanonicalLatchedAclBytes: Uint8Array }>
): ShippingChatShareUpdate | undefined {
	const next = shareShippingChatWindow(input);
	if (sameValue(next, captureShares(input.capacity))) return undefined;
	const acl = readAcl(input.exactCanonicalLatchedAclBytes);
	return Object.freeze({ action: "capacityAllocation", capacity: next, epoch: acl.epoch, aclDigest: acl.digest });
}

/**
 * The reducer's reclaim rule, mirrored for the admission policy's own view of the window (the
 * joined-state check only). The compiled reducer remains the only owner of the replicated state.
 * @param messages - The window, mutated in place.
 * @param capacity - The rows in force.
 */
function reclaim(messages: ShippingChatMessage[], capacity: ShippingChatShares): void {
	const guarantees = new Map(capacity.allocations.map(([author, guarantee]) => [author, guarantee]));
	const charges = new Map<string, number>();
	let total = 0;
	for (const message of messages) {
		const bytes = recordBytes(message);
		total += bytes;
		charges.set(message.author, (charges.get(message.author) ?? 0) + bytes);
	}
	while (total > capacity.windowBytes) {
		let index = messages.findIndex((message) => !guarantees.has(message.author));
		if (index < 0)
			index = messages.findIndex(
				(message) => (charges.get(message.author) ?? 0) > (guarantees.get(message.author) ?? 0)
			);
		if (index < 0) throw new TypeError("Chat shares window cannot fit");
		const [removed] = messages.splice(index, 1) as [ShippingChatMessage];
		const bytes = recordBytes(removed);
		total -= bytes;
		charges.set(removed.author, (charges.get(removed.author) ?? 0) - bytes);
	}
}
function applyMessage(
	messages: ShippingChatMessage[],
	capacity: ShippingChatShares,
	message: ShippingChatMessage
): void {
	const held = messages.findIndex((row) => identityOf(row) === identityOf(message));
	if (held >= 0) {
		messages.push(...messages.splice(held, 1));
		return;
	}
	messages.push(message);
	reclaim(messages, capacity);
}

interface EpochEntry {
	readonly message: ShippingChatMessage;
	readonly bytes: Uint8Array;
	committed: boolean;
	owners: number;
}
type Step =
	| Readonly<{ kind: "message"; message: ShippingChatMessage }>
	| Readonly<{ kind: "update"; capacity: ShippingChatShares }>;

/**
 * One exact native reservation owner per checkpoint. Writer identity, signatures and causal order
 * stay native. A holder whose row is in the checkpoint's base (from an earlier checkpoint) may add
 * at most the allowance in canonical message bytes within the checkpoint (distinct identities,
 * exact retries of window messages included). The allowance is at most every guarantee, so the
 * reclaim rule never removes a message admitted in the same checkpoint. A share update is
 * admitted from an admin, for this checkpoint's epoch and ACL, with exactly the formula's rows;
 * the formula reads no messages and is idempotent, so the result never depends on order, and
 * journal replay and the creator's closed-postimage transcript check accept what was admitted.
 * @param input - The native policy context and the exact genesis state.
 * @returns The admission policy.
 */
export function createShippingChatSharesAdmissionPolicy(
	input: Readonly<{
		aclDigest: string;
		epoch: number;
		exactCanonicalLatchedAclBytes?: Uint8Array;
		authenticatedApplicationStateBytes?: Uint8Array;
		authenticatedClosedApplicationStateBytes?: Uint8Array;
		authenticatedSettlementFrontiers?: unknown;
		exactCanonicalGenesisStateBytes: Uint8Array;
	}>
): V3OperationAdmissionPolicy {
	if (input.exactCanonicalLatchedAclBytes === undefined)
		throw new TypeError("Chat shares require the native-selected current ACL");
	const acl = readAcl(input.exactCanonicalLatchedAclBytes);
	if (acl.digest !== input.aclDigest || acl.epoch !== input.epoch) throw new TypeError("Chat shares ACL scope differs");
	const closedPostimage =
		input.authenticatedClosedApplicationStateBytes === undefined
			? undefined
			: restoreShippingChatSharesState(input.authenticatedClosedApplicationStateBytes);
	const base = restoreShippingChatSharesState(
		input.authenticatedApplicationStateBytes ??
			input.authenticatedClosedApplicationStateBytes ??
			input.exactCanonicalGenesisStateBytes
	);
	// Who may add work in this checkpoint: rows of its base from an earlier checkpoint. (In the
	// creator's check over the closed postimage, rows added in this checkpoint carry the next one.)
	const holders = new Map(base.capacity.allocations.map(([author, , since]) => [author, since]));
	const allowance = base.capacity.allowanceBytes;
	// The only share update this checkpoint admits.
	let updateRows: ShippingChatShares | undefined;
	let updateBytes: Uint8Array | undefined;
	const expectedUpdate = (): Readonly<{ rows: ShippingChatShares; bytes: Uint8Array }> => {
		updateRows ??= shareShippingChatWindow({ capacity: base.capacity, exactCanonicalLatchedAclBytes: acl.bytes });
		updateBytes ??= encodeCanonical(updateRows);
		return { rows: updateRows, bytes: updateBytes };
	};
	const update = (operation: unknown, author: string | undefined): ShippingChatShares => {
		const candidate = record(operation, ["action", "capacity", "epoch", "aclDigest"]);
		if (
			candidate.action !== "capacityAllocation" ||
			candidate.epoch !== input.epoch ||
			candidate.aclDigest !== input.aclDigest ||
			author === undefined ||
			!acl.admins.has(author)
		)
			throw new TypeError("Chat share update is not this checkpoint's admin update");
		const expected = expectedUpdate();
		if (compareBytes(expected.bytes, encodeCanonical(candidate.capacity, OPERATION_LIMITS)) !== 0)
			throw new TypeError("Chat share update rows differ from the formula");
		return expected.rows;
	};
	let capacity = base.capacity;
	let updated = false;
	// The authenticated base window's identities (conflicts and exact retries).
	let held = new Map(base.messages.map((message) => [identityOf(message), encodeCanonical(message)]));
	// This policy's view of the window after committed work (the joined-state check only).
	let window = [...base.messages];
	// Every identity reserved in this checkpoint, pending or committed.
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
	return Object.freeze({
		reserve(
			operation: Readonly<Record<string, unknown>>,
			context?: Readonly<{ author: string }>
		): V3OperationAdmissionReservation {
			try {
				encodeCanonical(operation, OPERATION_LIMITS);
				if (operation.action === "causalJoin") {
					if (operation.capacity !== undefined && !sameValue(operation.capacity, capacity)) return rejected();
					return fresh(() => undefined);
				}
				if (operation.action === "acl" || operation.action === "migrationActivation") return fresh(() => undefined);
				if (operation.action === "migrationRecord") {
					const recordValue = operation.record as Readonly<Record<string, unknown>>;
					if (recordValue?.version !== 2) return rejected();
					// Only a v5 state is inherited: a v3 or v4 state is refused here and by the
					// reducer, so no room changes format.
					const inherited = captureShippingChatSharesState(recordValue.applicationState);
					// The room wrapper independently authenticates exact source/target and prefix
					// membership. This does not grant ordinary author admission.
					if (held.size !== 0 || entries.size !== 0 || updated) {
						const exactClosedInheritance =
							closedPostimage !== undefined &&
							sameValue(inherited.capacity, closedPostimage.capacity) &&
							inherited.messages.every((message) => {
								const retained = held.get(identityOf(message));
								return retained !== undefined && compareBytes(retained, encodeCanonical(message)) === 0;
							});
						return exactClosedInheritance ? fresh(() => undefined) : rejected();
					}
					let released = false;
					return fresh(
						() => {
							if (released) throw new TypeError("Chat shares inheritance was released");
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
				if (typeof author !== "string" || !AUTHOR.test(author)) return rejected();
				let operations: readonly unknown[] = [operation];
				if (operation.action === "applicationBatch") {
					const outer = record(operation, ["action", "batch"]),
						batch = record(outer.batch, ["version", "entries"]),
						values = dense(batch.entries);
					if (batch.version !== 1 || values.length < 2 || values.length > 16) return rejected();
					let previous = -1;
					operations = values.map((value) => {
						const entry = record(value, ["logicalTime", "operation"]),
							time = integer(entry.logicalTime);
						if (time <= previous) throw new TypeError("Chat batch order is invalid");
						previous = time;
						return entry.operation;
					});
				}
				const steps: Step[] = [];
				const planned = new Map<string, Readonly<{ message: ShippingChatMessage; bytes: Uint8Array }>>();
				for (const value of operations) {
					if (Reflect.get(value as object, "action") === "capacityAllocation") {
						steps.push({ kind: "update", capacity: update(value, author) });
						continue;
					}
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
					steps.push({ kind: "message", message });
				}
				if (planned.size > 0) {
					// Only a holder whose row is in this checkpoint's base adds messages.
					const since = holders.get(author);
					if (since === undefined || since > input.epoch) return rejected("capacity");
					// This checkpoint's charge: every distinct identity of this author reserved in the
					// checkpoint (pending or committed), exact retries of window messages included.
					let charge = 0;
					for (const entry of entries.values()) if (entry.message.author === author) charge += entry.bytes.byteLength;
					for (const [key, value] of planned) if (!entries.has(key)) charge += value.bytes.byteLength;
					if (charge > allowance) return rejected("capacity");
				}
				// The joined window (committed work plus this reservation) passes the state check under
				// LIMITS before anything is admitted.
				const joined = [...window];
				let joinedCapacity = capacity;
				for (const step of steps) {
					if (step.kind === "update") {
						joinedCapacity = step.capacity;
						reclaim(joined, joinedCapacity);
					} else applyMessage(joined, joinedCapacity, step.message);
				}
				captureShippingChatSharesState({ version: 5, capacity: joinedCapacity, messages: joined });
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
						if (released) throw new TypeError("Chat shares reservation was released");
						for (const [, entry] of owned) entry.committed = true;
						for (const step of steps) {
							if (step.kind === "update") {
								capacity = step.capacity;
								updated = true;
								reclaim(window, capacity);
							} else applyMessage(window, capacity, step.message);
						}
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
				return rejected();
			}
		},
	});
}

/**
 * The application's identity for a displaced operation: a message's client operation id, or a
 * share update's checkpoint and ACL (`capacity:<epoch>:<aclDigest>`), so a share update that
 * misses its checkpoint expires instead of ending its author's session.
 * @param operation - A batchable operation.
 * @returns Its identity.
 */
function displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string {
	if (operation.action === "capacityAllocation") {
		const epoch = operation.epoch,
			digest = operation.aclDigest;
		if (
			typeof epoch !== "number" ||
			!Number.isSafeInteger(epoch) ||
			epoch < 0 ||
			typeof digest !== "string" ||
			!DIGEST.test(digest)
		)
			throw new TypeError("Chat share update identity is invalid");
		return `capacity:${epoch === 0 ? 0 : epoch}:${digest}`;
	}
	const id = operation.clientOperationId;
	if (operation.action !== "message" || typeof id !== "string" || !CLIENT_OPERATION_ID.test(id))
		throw new TypeError("Chat identity is invalid");
	return id;
}

/**
 * The v5 application: one genuine compiled kernel (`v3-shipping-chat.v5`); the native policy owns
 * per-checkpoint admission and the share-update check.
 * @param input - The shares catalog, its digest and the exact genesis ACL.
 * @param readResourceBases - Track Q's exact catalog-entry and material check for the ordinary
 * resource bound reader (v3-chat-application.ts `resourceBoundBases`).
 * @returns The room application.
 */
export async function createShippingChatSharesApplication(
	input: Readonly<{
		catalog: TrustedBlueprintCatalog;
		blueprintDigest: string;
		exactCanonicalGenesisLatchedAclBytes: Uint8Array;
	}>,
	readResourceBases: ShippingChatResourceBoundBases
): Promise<ShippingChatApplication> {
	const catalog = input.catalog,
		blueprintDigest = input.blueprintDigest;
	const genesisBytes = createShippingChatSharesGenesisStateBytes({
		exactCanonicalLatchedAclBytes: new Uint8Array(input.exactCanonicalGenesisLatchedAclBytes),
	});
	const genesis = restoreShippingChatSharesState(genesisBytes);
	const resolved = catalog.resolve(blueprintDigest);
	if (resolved.artifactId !== SHIPPING_CHAT_SHARES_ARTIFACT_ID)
		throw new TypeError("shipping Chat shares artifact differs");
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
	// Ordinary resource bound: Track Q's rule and value (approved 2026-10-20), unchanged by v5.
	// Every v5 state passes `captureShippingChatSharesState`, which encodes it under
	// SHIPPING_CHAT_CAPACITY_STATE_LIMITS: the reducer keeps the window's message records within
	// `windowBytes`, which is 32,768 bytes less the empty state with that many rows at their widest
	// values, and there are at most 16 rows; the projection and migration re-capture every state;
	// and the admission policy captures the joined window of every reservation and every inherited
	// state before admitting it. So that ceiling dominates every state, for any material; it reads
	// no operation. Planning only: it grants no validity, admission, authority or credit, and the
	// room re-checks every base under it.
	const resourceCatalog: ResourceCatalog = Object.freeze({
		blueprintDigest: resolved.blueprintDigest,
		artifactId: resolved.artifactId,
		artifactDigest: resolved.artifactDigest,
		catalogDigest: resolved.evidence.catalogDigest,
		runtimeProfile: resolved.runtimeProfile,
		exactArtifactBytes: resolved.exactArtifactBytes.slice(),
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice(),
	});
	const readOrdinaryApplicationResourceBound: ResourceBoundReader = (value): CanonicalResourceFootprint | undefined => {
		try {
			const bases = readResourceBases(value, resourceCatalog);
			if (bases === undefined) return undefined;
			// Only authenticated v5 states: captured, canonical, within the ceiling.
			for (const base of bases) restoreShippingChatSharesState(base);
			return Object.freeze({ byteLength: LIMITS.maxBytes, items: LIMITS.maxItems, maxDepth: LIMITS.maxDepth });
		} catch {
			return undefined;
		}
	};
	const project = (projection: V3RoomProjectionInput): ShippingChatProjection => {
		let state: unknown =
			projection.authenticatedBase === undefined
				? genesis
				: restoreShippingChatSharesState(projection.authenticatedBase.exactCanonicalApplicationStateBytes);
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
		const window = restoreShippingChatSharesState(shippingChatSharesStateBytes(state));
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
			return createShippingChatSharesGenesisStateBytes({
				exactCanonicalLatchedAclBytes: new Uint8Array(context.exactCanonicalLatchedAclBytes),
			});
		},
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes,
		snapshotReadPolicy: "authenticated-public" as const,
		bootstrapOperation: Object.freeze({ action: "causalJoin", capacity: genesis.capacity }),
		// Share updates are batchable so that they can carry a displacement policy (the room requires
		// the policy keys to be exactly the batchable actions): one that misses its checkpoint
		// expires, and the admin's page issues it again in the next checkpoint.
		batchableOperationActions: Object.freeze(["capacityAllocation", "message"]),
		displacementPolicies: Object.freeze({ capacityAllocation: "expire" as const, message: "rebase" as const }),
		displacedOperationIdentity,
		projectAcceptedOperations: project,
		createOperationAdmissionPolicy: (context: Parameters<V3OperationAdmissionPolicyFactory>[0]) =>
			createShippingChatSharesAdmissionPolicy({ ...context, exactCanonicalGenesisStateBytes: genesisBytes }),
		migration: Object.freeze({
			inheritAuthenticatedState: true as const,
			canonicalStateBytes(projection: ShippingChatProjection): Uint8Array {
				return shippingChatSharesStateBytes({
					version: 5,
					messages: projection.messages,
					capacity: projection.capacity,
				});
			},
			prepare(_accepted: readonly unknown[], exactCanonicalSourceStateBytes?: Uint8Array) {
				if (exactCanonicalSourceStateBytes === undefined)
					throw new TypeError("Chat shares migration requires authenticated source state");
				const bytes = shippingChatSharesStateBytes(restoreShippingChatSharesState(exactCanonicalSourceStateBytes));
				return Object.freeze({ exactCanonicalApplicationStateBytes: bytes, importOperations: Object.freeze([]) });
			},
			containsInheritedOperation(
				operation: Readonly<Record<string, unknown>>,
				exactCanonicalStateBytes: Uint8Array,
				context?: Readonly<{ sourceAuthor: string }>
			): boolean {
				if (context === undefined || operation.action !== "message") return false;
				try {
					return restoreShippingChatSharesState(exactCanonicalStateBytes).messages.some(
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
