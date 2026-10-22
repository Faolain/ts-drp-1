import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { describe, expect, it } from "vitest";

import { openShippingChatCatalogs } from "../examples/chat/src/chat-catalogs.js";
import {
	createShippingV3ChatApplication,
	type ShippingChatApplication,
	type ShippingChatMessage,
} from "../examples/chat/src/v3-chat-application.js";
import {
	createShippingChatSharesAdmissionPolicy,
	createShippingChatSharesGenesisStateBytes,
	restoreShippingChatSharesState,
	shareShippingChatWindow,
	SHIPPING_CHAT_SHARE_HOLDERS,
	SHIPPING_CHAT_SHARES_ARTIFACT_ID,
	shippingChatShareUpdate,
	shippingChatSharesStateBytes,
} from "../examples/chat/src/v3-chat-shares.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";

// Track W2: the shipped Chat's membership-aware format (state version 5, artifact
// `v3-shipping-chat.v5`), the owner's "guarantee and borrow" rule with N_max = 16:
// - allowance: every share holder may add a fixed A bytes per checkpoint (A from 16 holders);
// - guarantee: an equal split of the window budget among current holders, always at least A;
// - borrowing: the window keeps any messages up to the budget; when one does not fit, departed
//   members' messages leave first, oldest first, then the oldest message of an author above
//   their guarantee;
// - membership: an admin's share update, a pure idempotent function of the checkpoint's latched
//   ACL and the current rows, adds joiners from the next checkpoint and drops departed members.
// Exercised through the genuine compiled reducer (the shares catalog's artifact, folded by the
// library's blueprint runtime) and the shipped admission policy. The rooms are
// tests/track-w2-chat-shares-room.test.ts.

const OBJECT = "creator:chat-shares-rule";
const T = 1_791_662_400_000;
const A = "a".repeat(64); // the creator: admin, finality, writer
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const CREATOR = ["admin", "finality", "writer"] as const;
const WRITER = ["writer"] as const;
const ADMIN = ["admin"] as const;
type Roles = readonly (readonly [author: string, groups: readonly string[]])[];
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const size = (message: ShippingChatMessage): number => encodeCanonical(message).byteLength;
const identity = (message: Readonly<{ author: string; clientOperationId: string }>): string =>
	`${message.author}\u0000${message.clientOperationId}`;
const total = (messages: readonly ShippingChatMessage[]): number => messages.reduce((sum, row) => sum + size(row), 0);

function aclBytes(epoch: number, roles: Roles): Uint8Array {
	return encodeCanonical({
		epoch,
		kind: "drp-v3-latched-acl",
		members: [...roles]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([author, groups]) => ({
				author,
				finalityKey: groups.includes("finality") ? author : null,
				groups: [...groups],
			})),
		objectId: OBJECT,
		permissionless: false,
		version: 3,
	});
}
const aclDigest = (bytes: Uint8Array): string => hex(hashDomain("ts-drp/latched-acl/v3", bytes));
const GENESIS_ROLES: Roles = [
	[A, CREATOR],
	[B, WRITER],
	[C, WRITER],
];

// The budget, stated independently of the product code: 32,768 bytes less the empty state with
// `holders` rows at their widest values, less two bytes for the messages array's count.
function windowBytes(holders: number, basisObjectId = OBJECT): number {
	return (
		32_768 -
		2 -
		encodeCanonical({
			version: 5,
			messages: [],
			capacity: {
				version: 2,
				basisObjectId,
				allowanceBytes: 32_768,
				windowBytes: 32_768,
				allocations: Array.from({ length: holders }, (_, index) => [
					index.toString(16).padStart(64, "0"),
					32_768,
					Number.MAX_SAFE_INTEGER,
				]),
			},
		}).byteLength
	);
}
const ALLOWANCE = Math.floor(windowBytes(16) / 16);

/** The capacity record for these rows (author, sinceEpoch), sorted by author: the equal split. */
function capacityOf(rows: readonly (readonly [author: string, sinceEpoch: number])[]) {
	const sorted = [...rows].sort(([left], [right]) => (left < right ? -1 : 1));
	const budget = windowBytes(sorted.length);
	return {
		version: 2,
		basisObjectId: OBJECT,
		allowanceBytes: ALLOWANCE,
		windowBytes: budget,
		allocations: sorted.map(([author, since], index) => [
			author,
			Math.floor(budget / sorted.length) + (index < budget % sorted.length ? 1 : 0),
			since,
		]),
	};
}
function sharesState(
	rows: readonly (readonly [author: string, sinceEpoch: number])[],
	messages: readonly ShippingChatMessage[] = []
): Uint8Array {
	return shippingChatSharesStateBytes({ version: 5, messages, capacity: capacityOf(rows) });
}

function message(author: string, clientOperationId: string, text: string, displayTimeMs = T): ShippingChatMessage {
	return { author, clientOperationId, displayTimeMs, text };
}
/**
 * A message whose canonical record is exactly `bytes` long (bytes >= 140), with non-empty text.
 * A size the text alone cannot reach (where its length prefix grows a byte) uses a one-character
 * longer id.
 */
function sized(author: string, clientOperationId: string, bytes: number): ShippingChatMessage {
	for (const id of [clientOperationId, `${clientOperationId}z`]) {
		const fixed = size(message(author, id, ""));
		for (let length = Math.max(1, bytes - fixed - 3); length <= bytes - fixed; length++) {
			const value = message(author, id, "x".repeat(length));
			if (size(value) === bytes) return value;
		}
	}
	throw new TypeError("CHAT_SHARES_RULE_SIZE");
}
/** Messages of `author` whose records total exactly `bytes`, each between 140 and 1,500 bytes. */
function padding(author: string, prefix: string, bytes: number): ShippingChatMessage[] {
	const out: ShippingChatMessage[] = [];
	let rest = bytes;
	while (rest > 0) {
		const next = rest > 1_640 ? 1_500 : rest > 1_500 ? rest - 140 : rest;
		out.push(sized(author, `${prefix}-${out.length}`, next));
		rest -= next;
	}
	return out;
}
const operationOf = (value: ShippingChatMessage) => ({
	action: "message",
	clientOperationId: value.clientOperationId,
	displayTimeMs: value.displayTimeMs,
	text: value.text,
});
function shareUpdate(epoch: number, roles: Roles, rows: readonly (readonly [string, number])[]) {
	const acl = aclBytes(epoch, roles);
	return { action: "capacityAllocation", capacity: capacityOf(rows), epoch, aclDigest: aclDigest(acl) };
}

const catalogs = openShippingChatCatalogs();
async function sharesApplication(roles: Roles = GENESIS_ROLES): Promise<ShippingChatApplication> {
	return createShippingV3ChatApplication({
		catalog: catalogs.shares.catalog,
		blueprintDigest: catalogs.shares.blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: aclBytes(0, roles),
	});
}

type Operation = readonly [author: string, operation: Readonly<Record<string, unknown>>];
/** Folds `operations` (in this order) over `base` through the genuine compiled reducer. */
function project(application: ShippingChatApplication, base: Uint8Array, operations: readonly Operation[]) {
	return application.projectAcceptedOperations({
		authenticatedBase: {
			blueprintDigest: catalogs.shares.blueprintDigest,
			epoch: 7,
			exactCanonicalApplicationStateBytes: base,
			objectId: OBJECT,
			stateDigest: hex(hashDomain("ts-drp/state/v3", base)),
		},
		currentEpochOperations: operations.map(([author, operation], index) => ({
			author,
			authorSequence: index + 1,
			logicalTime: index + 3,
			operation,
			operationCount: 1,
			operationIndex: 0,
			vertexDigest: index.toString(16).padStart(64, "0"),
		})),
	});
}
const sent = (messages: readonly ShippingChatMessage[]): Operation[] =>
	messages.map((value) => [value.author, operationOf(value)] as const);
const stateOf = (application: ShippingChatApplication, projection: ReturnType<typeof project>) =>
	restoreShippingChatSharesState(required(application.migration).canonicalStateBytes(projection));

function policy(input: {
	epoch?: number;
	roles?: Roles;
	base?: Uint8Array;
	closed?: Uint8Array;
	acl?: Uint8Array;
	digest?: string;
}) {
	const epoch = input.epoch ?? 7;
	const acl = input.acl ?? aclBytes(epoch, input.roles ?? GENESIS_ROLES);
	return createShippingChatSharesAdmissionPolicy({
		aclDigest: input.digest ?? aclDigest(acl),
		epoch,
		exactCanonicalLatchedAclBytes: acl,
		...(input.base === undefined ? {} : { authenticatedApplicationStateBytes: input.base }),
		...(input.closed === undefined ? {} : { authenticatedClosedApplicationStateBytes: input.closed }),
		exactCanonicalGenesisStateBytes: createShippingChatSharesGenesisStateBytes({
			exactCanonicalLatchedAclBytes: aclBytes(0, GENESIS_ROLES),
		}),
	});
}
type Admission = ReturnType<typeof policy>;
/** Reserves and commits each operation; returns each outcome ("fresh", "conflict", "rejected:<reason>"). */
function admit(admission: Admission, operations: readonly Operation[]): string[] {
	return operations.map(([author, operation]) => {
		const reservation = admission.reserve(operation, { author });
		if (reservation.kind === "fresh") reservation.commit();
		return reservation.kind === "rejected" ? `rejected:${reservation.reason ?? ""}` : reservation.kind;
	});
}

/** A deterministic generator (xorshift32), so every run checks the same cases. */
function random(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_0000_0000;
	};
}

// The rule, stated independently of the product code, for the differential test.
interface ModelState {
	messages: ShippingChatMessage[];
	capacity: ReturnType<typeof capacityOf>;
}
function modelReclaim(state: ModelState): void {
	const guarantee = (author: string): number | undefined =>
		state.capacity.allocations.find((row) => row[0] === author)?.[1] as number | undefined;
	while (total(state.messages) > state.capacity.windowBytes) {
		let index = state.messages.findIndex((row) => guarantee(row.author) === undefined);
		if (index < 0) {
			const charges = new Map<string, number>();
			for (const row of state.messages) charges.set(row.author, (charges.get(row.author) ?? 0) + size(row));
			index = state.messages.findIndex((row) => (charges.get(row.author) ?? 0) > (guarantee(row.author) ?? 0));
		}
		state.messages.splice(index, 1);
	}
}
function modelApply(state: ModelState, [author, operation]: Operation): void {
	if (operation.action === "capacityAllocation") {
		state.capacity = operation.capacity as ModelState["capacity"];
		modelReclaim(state);
		return;
	}
	const value = message(
		author,
		operation.clientOperationId as string,
		operation.text as string,
		operation.displayTimeMs as number
	);
	const held = state.messages.findIndex((row) => identity(row) === identity(value));
	if (held >= 0) {
		state.messages.push(...state.messages.splice(held, 1));
		return;
	}
	state.messages.push(value);
	modelReclaim(state);
}

describe("Track W2: Chat's membership-aware format (v5)", () => {
	it("new rooms sign v5; v3 and v4 rooms keep their formats and catalogs, with no migration", async () => {
		expect(SHIPPING_CHAT_SHARES_ARTIFACT_ID).toBe("v3-shipping-chat.v5");
		expect(SHIPPING_CHAT_SHARE_HOLDERS).toBe(16);
		expect(catalogs.shares.catalog.blueprintDigests).toEqual([catalogs.shares.blueprintDigest]);
		expect(catalogs.shares.catalog.resolve(catalogs.shares.blueprintDigest).artifactId).toBe("v3-shipping-chat.v5");
		// v4 (Track W) and v3 (lifetime) stay byte for byte.
		expect(catalogs.window.blueprintDigest).toBe("b0bb30c5677e927b0a47a78508b436eae755e635f9c4613387ba490f62897560");
		expect(catalogs.window.catalog.resolve(catalogs.window.blueprintDigest).artifactId).toBe("v3-shipping-chat.v4");
		expect(catalogs.lifetime.blueprintDigest).toBe("61ab694a75cab170e0f2202a9f0f712a683d5f166334e59f8fdf0d4e43df065f");
		const application = await sharesApplication();
		const empty = { authenticatedBase: undefined, currentEpochOperations: [] };
		expect(
			decodeCanonical(required(application.migration).canonicalStateBytes(application.projectAcceptedOperations(empty)))
		).toMatchObject({ version: 5 });
		// No migration in either direction: v5 refuses a v4 state, v4 refuses a v5 state.
		const v4Genesis = createShippingChatWindowGenesisStateBytes({
			exactCanonicalLatchedAclBytes: aclBytes(0, GENESIS_ROLES),
		});
		expect(() => required(application.migration).prepare([], v4Genesis)).toThrow();
		expect(() => restoreShippingChatSharesState(v4Genesis)).toThrow();
		const window = await createShippingV3ChatApplication({
			catalog: catalogs.window.catalog,
			blueprintDigest: catalogs.window.blueprintDigest,
			exactCanonicalGenesisLatchedAclBytes: aclBytes(0, GENESIS_ROLES),
		});
		expect(() => required(window.migration).prepare([], sharesState([[A, 0]]))).toThrow();
	});

	it("the genesis gives each genesis Writer a share from checkpoint 0, with an allowance sized for 16 holders", () => {
		// For this basis: 32,768 - 2 - (the empty state with 16 widest rows), split 16 ways.
		expect(windowBytes(16)).toBe(31_329);
		expect(ALLOWANCE).toBe(1_958);
		// Each row costs the window 81 bytes.
		expect(windowBytes(1) - windowBytes(2)).toBe(81);
		const genesis = decodeCanonical(
			createShippingChatSharesGenesisStateBytes({
				exactCanonicalLatchedAclBytes: aclBytes(0, [
					[A, CREATOR],
					[B, WRITER],
					[C, ADMIN], // an admin without writer holds no share
				]),
			})
		);
		expect(genesis).toEqual({
			version: 5,
			messages: [],
			capacity: capacityOf([
				[A, 0],
				[B, 0],
			]),
		});
		// The shipped page's room: the creator alone holds the whole budget.
		const solo = restoreShippingChatSharesState(
			createShippingChatSharesGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0, [[A, CREATOR]]) })
		);
		expect(solo.capacity.allocations).toEqual([[A, windowBytes(1), 0]]);
		// Every guarantee is at least the allowance, at every holder count up to 16.
		for (let holders = 1; holders <= 16; holders++)
			expect(Math.floor(windowBytes(holders) / holders), `holders ${holders}`).toBeGreaterThanOrEqual(ALLOWANCE);
		// At most 16 holders: the first 16 Writers in author order.
		const many = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(2, "0").repeat(32));
		const crowded = restoreShippingChatSharesState(
			createShippingChatSharesGenesisStateBytes({
				exactCanonicalLatchedAclBytes: aclBytes(0, [[A, CREATOR], ...many.map((author) => [author, WRITER] as const)]),
			})
		);
		expect(crowded.capacity.allocations.map((row) => row[0])).toEqual([...many].sort().slice(0, 16));
		expect(crowded.capacity.allowanceBytes).toBe(ALLOWANCE);
	});

	it("a share update adds joiners from the next checkpoint, drops departed members, keeps custodians, and is idempotent", () => {
		const base = restoreShippingChatSharesState(
			sharesState([
				[A, 0],
				[B, 0],
				[D, 3],
			])
		);
		// Checkpoint 4: B lost writer but stays an admin (a custodian), C was granted writer, D left.
		const roles: Roles = [
			[A, CREATOR],
			[B, ADMIN],
			[C, WRITER],
		];
		const acl = aclBytes(4, roles);
		const next = shareShippingChatWindow({ capacity: base.capacity, exactCanonicalLatchedAclBytes: acl });
		expect(next).toEqual(
			capacityOf([
				[A, 0],
				[B, 0],
				[C, 5],
			])
		);
		// Idempotent: the update computed from its own result is itself, so every update in a
		// checkpoint has the same content whatever rows it was computed from.
		expect(shareShippingChatWindow({ capacity: next, exactCanonicalLatchedAclBytes: acl })).toEqual(next);
		expect(shippingChatShareUpdate({ capacity: base.capacity, exactCanonicalLatchedAclBytes: acl })).toEqual({
			action: "capacityAllocation",
			capacity: next,
			epoch: 4,
			aclDigest: aclDigest(acl),
		});
		expect(shippingChatShareUpdate({ capacity: next, exactCanonicalLatchedAclBytes: acl })).toBeUndefined();
		// No more than 16 holders: a 17th Writer waits for a free place.
		const sixteen = Array.from({ length: 16 }, (_, index) => index.toString(16).padStart(2, "0").repeat(32));
		const full = capacityOf(sixteen.map((author) => [author, 0] as const));
		const crowded = aclBytes(9, [...sixteen.map((author) => [author, WRITER] as const), [A, CREATOR]]);
		expect(shareShippingChatWindow({ capacity: full, exactCanonicalLatchedAclBytes: crowded })).toEqual(full);
		expect(shippingChatShareUpdate({ capacity: full, exactCanonicalLatchedAclBytes: crowded })).toBeUndefined();
		const freed = aclBytes(10, [...sixteen.slice(1).map((author) => [author, WRITER] as const), [A, CREATOR]]);
		expect(shareShippingChatWindow({ capacity: full, exactCanonicalLatchedAclBytes: freed })).toEqual(
			capacityOf([...sixteen.slice(1).map((author) => [author, 0] as const), [A, 11]])
		);
	});

	it("a holder borrows what others leave unused; once the window is full, the oldest surplus leaves", async () => {
		const application = await sharesApplication();
		const rows = [
			[A, 0],
			[B, 0],
		] as const;
		const budget = windowBytes(2);
		const guarantee = Math.floor(budget / 2);
		// A alone: 25 KB, far above its 16 KB guarantee, all kept while the window has room.
		const a = Array.from({ length: 25 }, (_, index) => sized(A, `a-${index}`, 1_000));
		const borrowed = stateOf(application, project(application, sharesState(rows), sent(a)));
		expect(borrowed.messages.map(identity)).toEqual(a.map(identity));
		expect(total(borrowed.messages)).toBeGreaterThan(guarantee);
		// B speaks: once the window is over budget, A's oldest messages leave, never B's.
		const b = Array.from({ length: 12 }, (_, index) => sized(B, `b-${index}`, 1_000));
		const after = stateOf(application, project(application, sharesState(rows), sent([...a, ...b])));
		expect(total(after.messages)).toBeLessThanOrEqual(budget);
		expect(total(after.messages)).toBeGreaterThan(budget - 1_000);
		expect(after.messages.filter((row) => row.author === B).map(identity)).toEqual(b.map(identity));
		const keptA = after.messages.filter((row) => row.author === A).map(identity);
		expect(keptA).toEqual(a.slice(a.length - keptA.length).map(identity));
		expect(keptA.length).toBeLessThan(a.length);
	});

	it("departed members' messages leave only when space is needed, oldest first, before anyone else's surplus", async () => {
		const application = await sharesApplication();
		const rows = [
			[A, 0],
			[B, 0],
		] as const;
		const budget = windowBytes(2);
		// Oldest first: A's surplus (above its guarantee), then D's (D left: no row), then B's.
		const a = Array.from({ length: 20 }, (_, index) => sized(A, `a-${index}`, 1_000));
		const d = Array.from({ length: 6 }, (_, index) => sized(D, `d-${index}`, 1_000));
		const b = Array.from({ length: 4 }, (_, index) => sized(B, `b-${index}`, 1_000));
		const base = sharesState(rows, [...a, ...d, ...b]);
		expect(total(restoreShippingChatSharesState(base).messages)).toBeLessThanOrEqual(budget);
		// While the window has room, D's messages stay.
		const room = budget - total([...a, ...d, ...b]);
		const fits = sized(B, "fits", Math.min(1_000, room));
		expect(stateOf(application, project(application, base, sent([fits]))).messages.map(identity)).toEqual(
			[...a, ...d, ...b, fits].map(identity)
		);
		// Under pressure: every one of D's messages leaves, oldest first, before any of A's surplus.
		const more = Array.from({ length: 12 }, (_, index) => sized(B, `b-more-${index}`, 1_000));
		let removedA = false;
		for (let count = 1; count <= more.length; count++) {
			const state = stateOf(application, project(application, base, sent(more.slice(0, count))));
			const keptD = state.messages.filter((row) => row.author === D).map(identity);
			const keptA = state.messages.filter((row) => row.author === A).map(identity);
			expect(keptD).toEqual(d.slice(d.length - keptD.length).map(identity));
			expect(keptA).toEqual(a.slice(a.length - keptA.length).map(identity));
			if (keptA.length < a.length) {
				expect(keptD, `pressure ${count}`).toEqual([]);
				removedA = true;
			}
			expect(state.messages.filter((row) => row.author === B).length).toBe(b.length + count);
			expect(total(state.messages)).toBeLessThanOrEqual(budget);
		}
		expect(removedA).toBe(true);
		// A share update that drops a row frees budget and evicts nothing; a new row costs 81 bytes,
		// taken from departed members first.
		const three = sharesState(
			[
				[A, 0],
				[B, 0],
				[D, 0],
			],
			[...a.slice(0, 8), ...d, ...b]
		);
		const dropped = stateOf(
			application,
			project(application, three, [
				[
					A,
					shareUpdate(
						7,
						[
							[A, CREATOR],
							[B, WRITER],
						],
						rows
					),
				],
			])
		);
		expect(dropped.messages.map(identity)).toEqual([...a.slice(0, 8), ...d, ...b].map(identity));
		expect(dropped.capacity).toEqual(capacityOf(rows));
		// Within 81 bytes of the budget: a joiner's row pushes out D's oldest message, not A's surplus.
		const prefix = [...a, ...d.slice(0, 4), ...b];
		const pads = padding(B, "pad", budget - 40 - total(prefix));
		const tight = sharesState(rows, [...prefix, ...pads]);
		expect(budget - total(restoreShippingChatSharesState(tight).messages)).toBe(40);
		const joined = stateOf(
			application,
			project(application, tight, [
				[
					A,
					shareUpdate(
						7,
						[
							[A, CREATOR],
							[B, WRITER],
							[C, WRITER],
						],
						[...rows, [C, 8]]
					),
				],
			])
		);
		expect(joined.messages.map(identity)).toEqual([...a, ...d.slice(1, 4), ...b, ...pads].map(identity));
	});

	it("an exact retry refreshes its message; a different message under a held identity is a conflict", async () => {
		const application = await sharesApplication();
		const one = message(A, "one", "first");
		const two = message(A, "two", "second");
		expect(
			stateOf(application, project(application, sharesState([[A, 0]]), sent([one, two, one]))).messages.map(identity)
		).toEqual([two, one].map(identity));
		const admission = policy({ base: sharesState([[A, 0]], [one]) });
		expect(admission.reserve(operationOf(message(A, "one", "changed")), { author: A })).toEqual({ kind: "conflict" });
		expect(admission.reserve(operationOf(one), { author: A })).toMatchObject({ kind: "fresh" });
	});

	it("admission lets each holder add A bytes per checkpoint, whatever the order, and replays accept what was admitted", async () => {
		const application = await sharesApplication();
		const rows = [
			[A, 0],
			[B, 0],
			[C, 0],
		] as const;
		// A full window of older messages, mostly A's.
		const old = Array.from({ length: 28 }, (_, index) => sized(index % 4 === 0 ? B : A, `old-${index}`, 1_100));
		const base = sharesState(rows, old);
		const candidates = Array.from({ length: 40 }, (_, index) => message(A, `new-${index}`, `new message ${index}`));
		const forward = admit(policy({ base }), sent(candidates));
		const admitted = candidates.filter((_, index) => forward[index] === "fresh");
		expect(total(admitted)).toBeLessThanOrEqual(ALLOWANCE);
		expect(total(admitted) + size(required(candidates[admitted.length]))).toBeGreaterThan(ALLOWANCE);
		expect(forward.slice(admitted.length).every((kind) => kind === "rejected:capacity")).toBe(true);
		// Any order of the same admitted set is accepted in full (journal replay, displaced rebase).
		expect(admit(policy({ base }), sent([...admitted].reverse())).every((kind) => kind === "fresh")).toBe(true);
		// Other holders are unaffected by A's checkpoint.
		expect(admit(policy({ base }), sent([message(B, "b-new", "hello")]))).toEqual(["fresh"]);
		// The sealed postimage keeps every admitted message, and the creator's transcript check
		// over it accepts every one of them again.
		const sealed = project(application, base, sent(admitted));
		const postimage = required(application.migration).canonicalStateBytes(sealed);
		const held = new Set(sealed.messages.map(identity));
		expect(admitted.every((row) => held.has(identity(row)))).toBe(true);
		expect(admit(policy({ closed: postimage }), sent(admitted)).every((kind) => kind === "fresh")).toBe(true);
		// The same backlog re-fits in a later checkpoint after a burst of joins (16 holders):
		// the allowance never changes, so a displaced member's rebase is never refused.
		const sixteen = [
			...rows,
			...Array.from({ length: 13 }, (_, index) => [index.toString(16).padStart(2, "0").repeat(32), 9] as const),
		];
		const crowded = sharesState(sixteen, old.slice(0, 20));
		expect(admit(policy({ epoch: 12, base: crowded }), sent(admitted)).every((kind) => kind === "fresh")).toBe(true);
		// A released reservation frees its bytes.
		const admission = policy({ base });
		const reservations = admitted.map((row) => admission.reserve(operationOf(row), { author: A }));
		expect(admission.reserve(operationOf(message(A, "late", "late message")), { author: A })).toMatchObject({
			kind: "rejected",
			reason: "capacity",
		});
		const last = required(reservations.at(-1));
		if (last.kind !== "fresh") throw new TypeError("expected a fresh reservation");
		last.release();
		expect(admission.reserve(operationOf(message(A, "late", "late message")), { author: A })).toMatchObject({
			kind: "fresh",
		});
	});

	it("admission refuses a Writer without a share in the checkpoint's base, and a joiner before its first checkpoint", () => {
		const roles: Roles = [
			[A, CREATOR],
			[B, WRITER],
			[C, WRITER],
		];
		const base = sharesState([
			[A, 0],
			[B, 0],
		]);
		// C is a Writer in the ACL but holds no share in this checkpoint's base.
		expect(admit(policy({ roles, base }), sent([message(C, "c", "hi")]))).toEqual(["rejected:capacity"]);
		// C's share added in this checkpoint (from checkpoint 8): still refused in checkpoint 7, also
		// in the creator's check over the closed postimage that holds C's new row.
		const withC = sharesState([
			[A, 0],
			[B, 0],
			[C, 8],
		]);
		expect(admit(policy({ roles, closed: withC }), sent([message(C, "c", "hi")]))).toEqual(["rejected:capacity"]);
		expect(admit(policy({ roles, base: withC }), sent([message(C, "c", "hi")]))).toEqual(["rejected:capacity"]);
		expect(admit(policy({ epoch: 8, roles, base: withC }), sent([message(C, "c", "hi")]))).toEqual(["fresh"]);
		// A message larger than the allowance never fits.
		expect(admit(policy({ base }), sent([sized(A, "big", ALLOWANCE + 1)]))).toEqual(["rejected:capacity"]);
		expect(admit(policy({ base }), sent([sized(A, "fits", ALLOWANCE)]))).toEqual(["fresh"]);
		// Batch entries count toward the allowance.
		const entries = Array.from({ length: 8 }, (_, index) => sized(A, `batch-${index}`, 300));
		const batch = (rows: readonly ShippingChatMessage[]) => ({
			action: "applicationBatch",
			batch: {
				version: 1,
				entries: rows.map((row, index) => ({ logicalTime: index + 1, operation: operationOf(row) })),
			},
		});
		expect(admit(policy({ base }), [[A, batch(entries)]])).toEqual(["rejected:capacity"]);
		expect(admit(policy({ base }), [[A, batch(entries.slice(0, 6))]])).toEqual(["fresh"]);
	});

	it("a share update is admitted only from an admin, for the checkpoint's own ACL, with the exact rows; duplicates are no-ops", () => {
		const roles: Roles = [
			[A, CREATOR],
			[B, WRITER],
			[C, WRITER],
			[E, ADMIN],
		];
		const base = sharesState([
			[A, 0],
			[B, 0],
			[D, 0],
		]);
		const update = shareUpdate(7, roles, [
			[A, 0],
			[B, 0],
			[C, 8],
		]);
		expect(update).toEqual(
			shippingChatShareUpdate({
				capacity: restoreShippingChatSharesState(base).capacity,
				exactCanonicalLatchedAclBytes: aclBytes(7, roles),
			})
		);
		const reserve = (author: string, operation: Readonly<Record<string, unknown>>, input = { roles, base }) =>
			admit(policy(input), [[author, operation]])[0];
		expect(reserve(A, update)).toBe("fresh");
		expect(reserve(E, update)).toBe("fresh"); // any admin, Writer or not
		expect(reserve(B, update)).toBe("rejected:"); // not an admin
		expect(reserve(A, { ...update, epoch: 6 })).toBe("rejected:");
		expect(reserve(A, { ...update, aclDigest: "f".repeat(64) })).toBe("rejected:");
		const tamper = (change: (capacity: ReturnType<typeof capacityOf>) => void) => {
			const capacity = structuredClone(update.capacity);
			change(capacity);
			return { ...update, capacity };
		};
		expect(
			reserve(
				A,
				tamper((capacity) => (capacity.allocations[0]![1] = (capacity.allocations[0]![1] as number) + 1))
			)
		).toBe("rejected:");
		expect(
			reserve(
				A,
				tamper((capacity) => (capacity.allocations[2]![2] = 7))
			)
		).toBe("rejected:");
		expect(
			reserve(
				A,
				tamper((capacity) => (capacity.allowanceBytes += 1))
			)
		).toBe("rejected:");
		expect(
			reserve(
				A,
				tamper((capacity) => (capacity.windowBytes -= 1))
			)
		).toBe("rejected:");
		expect(
			reserve(
				A,
				tamper((capacity) => (capacity.basisObjectId = "creator:other"))
			)
		).toBe("rejected:");
		expect(
			reserve(
				A,
				tamper((capacity) => capacity.allocations.pop())
			)
		).toBe("rejected:");
		expect(reserve(A, { ...update, extra: true })).toBe("rejected:");
		// Duplicates and order: the update commutes with messages and with itself.
		const one = message(A, "one", "x".repeat(400));
		const forward = admit(policy({ roles, base }), [
			[A, update],
			[A, operationOf(one)],
			[E, update],
			[A, update],
		]);
		const backward = admit(policy({ roles, base }), [
			[A, update],
			[E, update],
			[A, operationOf(one)],
			[A, update],
		]);
		expect(forward).toEqual(["fresh", "fresh", "fresh", "fresh"]);
		expect(backward).toEqual(forward);
		// The creator's check over the closed postimage (rows already updated) accepts it again.
		const closed = shippingChatSharesStateBytes({ version: 5, messages: [], capacity: update.capacity });
		expect(admit(policy({ roles, closed }), [[A, update]])).toEqual(["fresh"]);
	});

	it("nothing admitted in a checkpoint leaves the window before it is sealed, with joins and leaves, in any interleaving", async () => {
		const application = await sharesApplication();
		const next = random(0x5eed_5a7e);
		for (let round = 0; round < 40; round++) {
			// D is leaving (absent from this checkpoint's ACL), E is joining, A, B, C hold shares.
			const roles: Roles = [
				[A, CREATOR],
				[B, WRITER],
				[C, WRITER],
				[E, WRITER],
			];
			const rows = [
				[A, 0],
				[B, 0],
				[C, 0],
				[D, 0],
			] as const;
			const authors = [A, B, C, D];
			const old: ShippingChatMessage[] = [];
			for (let index = 0; total(old) < windowBytes(4) - 1_500; index++)
				old.push(sized(authors[Math.floor(next() * 4)]!, `old-${round}-${index}`, 200 + Math.floor(next() * 900)));
			const base = sharesState(rows, old);
			const admission = policy({ roles, base });
			const admitted: Operation[] = [];
			const update = shareUpdate(7, roles, [
				[A, 0],
				[B, 0],
				[C, 0],
				[E, 8],
			]);
			for (let index = 0; index < 60; index++) {
				const author = [A, B, C][Math.floor(next() * 3)]!;
				const own = admitted.filter(([who, operation]) => who === author && operation.action === "message");
				const candidate: Operation =
					next() < 0.1
						? [A, update]
						: next() < 0.1 && own.length > 0
							? own[Math.floor(next() * own.length)]!
							: [
									author,
									operationOf(
										message(author, `r${round}-${index}`, "m".repeat(1 + Math.floor(next() * 400)), T + index)
									),
								];
				const reservation = admission.reserve(candidate[1], { author: candidate[0] });
				if (reservation.kind !== "fresh") continue;
				reservation.commit();
				admitted.push(candidate);
			}
			admitted.push([A, update]);
			// Two interleavings that keep each author's own order.
			const interleave = (): Operation[] => {
				const queues = [A, B, C].map((author) => admitted.filter(([who]) => who === author));
				const out: Operation[] = [];
				while (queues.some((queue) => queue.length > 0)) {
					const open = queues.filter((queue) => queue.length > 0);
					out.push(open[Math.floor(next() * open.length)]!.shift()!);
				}
				return out;
			};
			for (const order of [interleave(), interleave()]) {
				const state = stateOf(application, project(application, base, order));
				const held = new Set(state.messages.map(identity));
				for (const [author, operation] of admitted)
					if (operation.action === "message")
						expect(
							held.has(identity({ author, clientOperationId: operation.clientOperationId as string })),
							`round ${round}: ${String(operation.clientOperationId)}`
						).toBe(true);
				expect(state.capacity).toEqual(update.capacity);
				expect(total(state.messages)).toBeLessThanOrEqual(update.capacity.windowBytes);
			}
		}
	});

	it("the compiled reducer folds exactly the stated rule (differential, 30 random rooms)", async () => {
		const application = await sharesApplication();
		const next = random(0xd1ff_5eed);
		const pool = [A, B, C, D, E];
		for (let round = 0; round < 30; round++) {
			let rows: (readonly [string, number])[] = [
				[A, 0],
				[B, 0],
				[C, 0],
			];
			const start: ModelState = { messages: [], capacity: capacityOf(rows) };
			const operations: Operation[] = [];
			const model: ModelState = structuredClone(start);
			for (let index = 0; index < 80; index++) {
				const roll = next();
				let operation: Operation;
				if (roll < 0.08) {
					// A share update: some authors leave, some join (never the creator).
					rows = pool
						.filter((author) => author === A || next() < 0.6)
						.map((author) => [author, rows.find(([held]) => held === author)?.[1] ?? 1] as const);
					operation = [
						A,
						{ action: "capacityAllocation", capacity: capacityOf(rows), epoch: 7, aclDigest: "c".repeat(64) },
					];
				} else {
					const holders = rows.map(([author]) => author);
					const author = holders[Math.floor(next() * holders.length)]!;
					const own = model.messages.filter((row) => row.author === author);
					operation =
						roll < 0.18 && own.length > 0
							? [author, operationOf(own[Math.floor(next() * own.length)]!)]
							: [
									author,
									operationOf(sized(author, `m-${round}-${index}`, 140 + Math.floor(next() * (ALLOWANCE - 140)))),
								];
				}
				operations.push(operation);
				modelApply(model, operation);
			}
			const folded = stateOf(
				application,
				project(application, shippingChatSharesStateBytes({ version: 5, ...start }), operations)
			);
			expect(encodeCanonical(folded), `round ${round}`).toEqual(encodeCanonical({ version: 5, ...model }));
		}
	});

	it("the application expires a share update that misses its checkpoint, with an identity, and batches it beside messages", async () => {
		const application = await sharesApplication();
		expect(application.batchableOperationActions).toEqual(["capacityAllocation", "message"]);
		expect(application.displacementPolicies).toEqual({ capacityAllocation: "expire", message: "rebase" });
		expect(Object.isFrozen(application.displacementPolicies)).toBe(true);
		const update = shareUpdate(4, GENESIS_ROLES, [
			[A, 0],
			[B, 0],
			[C, 0],
		]);
		expect(application.displacedOperationIdentity(update)).toBe(`capacity:4:${update.aclDigest}`);
		expect(application.displacedOperationIdentity(operationOf(message(A, "m-1", "hi")))).toBe("m-1");
		expect(() => application.displacedOperationIdentity({ ...update, epoch: -1 })).toThrow();
		expect(() => application.displacedOperationIdentity({ ...update, aclDigest: "nope" })).toThrow();
		expect(() => application.displacedOperationIdentity({ action: "acl", kind: "grant" })).toThrow();
		expect(application.bootstrapOperation).toEqual({
			action: "causalJoin",
			capacity: restoreShippingChatSharesState(
				createShippingChatSharesGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0, GENESIS_ROLES) })
			).capacity,
		});
		// A batch may carry a share update beside messages: the reducer applies both, and the policy
		// admits it only when every entry is admissible for its author.
		const roles: Roles = [
			[A, CREATOR],
			[B, WRITER],
			[C, WRITER],
			[E, WRITER],
		];
		const base = sharesState([
			[A, 0],
			[B, 0],
			[C, 0],
		]);
		const joined = shareUpdate(7, roles, [
			[A, 0],
			[B, 0],
			[C, 0],
			[E, 8],
		]);
		const hello = message(A, "hello", "hello");
		const batch = (first: Readonly<Record<string, unknown>>) => ({
			action: "applicationBatch",
			batch: {
				version: 1,
				entries: [
					{ logicalTime: 4, operation: first },
					{ logicalTime: 6, operation: operationOf(hello) },
				],
			},
		});
		const folded = stateOf(application, project(application, base, [[A, batch(joined)]]));
		expect(folded.capacity).toEqual(joined.capacity);
		expect(folded.messages.map(identity)).toEqual([identity(hello)]);
		expect(admit(policy({ roles, base }), [[A, batch(joined)]])).toEqual(["fresh"]);
		expect(admit(policy({ roles, base }), [[A, batch({ ...joined, epoch: 6 })]])).toEqual(["rejected:"]);
		expect(admit(policy({ roles, base }), [[B, batch(joined)]])).toEqual(["rejected:"]);
	});

	it("the state refuses what the format forbids", () => {
		const one = message(A, "one", "first");
		const valid = capacityOf([
			[A, 0],
			[B, 0],
		]);
		const state = (capacity: unknown, messages: readonly ShippingChatMessage[] = []) =>
			shippingChatSharesStateBytes({ version: 5, messages, capacity });
		expect(() => state(valid, [one])).not.toThrow();
		expect(() => state({ ...valid, windowBytes: valid.windowBytes + 1 })).toThrow();
		expect(() => state({ ...valid, allowanceBytes: valid.allowanceBytes - 1 })).toThrow();
		expect(() =>
			state({
				...valid,
				allocations: [
					[A, (valid.allocations[0]![1] as number) + 1, 0],
					[B, (valid.allocations[1]![1] as number) - 1, 0],
				],
			})
		).toThrow();
		expect(() => state({ ...valid, allocations: [...valid.allocations].reverse() })).toThrow();
		const seventeen = Array.from(
			{ length: 17 },
			(_, index) => [index.toString(16).padStart(2, "0").repeat(32), 0] as const
		);
		expect(() => state(capacityOf(seventeen.slice(0, 16)))).not.toThrow();
		expect(() => state(capacityOf(seventeen))).toThrow();
		expect(() => state(valid, [one, one])).toThrow();
		const over: ShippingChatMessage[] = [];
		while (total(over) <= valid.windowBytes) over.push(sized(D, `d-${over.length}`, 1_500));
		expect(() => state(valid, over)).toThrow();
		expect(() => state(valid, over.slice(0, -1))).not.toThrow(); // departed messages are allowed, within budget
		// A v5 room inherits no v4 state.
		expect(
			policy({}).reserve(
				{
					action: "migrationRecord",
					record: {
						version: 2,
						applicationState: decodeCanonical(
							createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0, GENESIS_ROLES) })
						),
					},
				},
				{ author: A }
			)
		).toMatchObject({ kind: "rejected" });
	});

	it("states Track Q's ordinary resource bound for its own catalog entry and v5 states only", async () => {
		const application = await sharesApplication();
		const read = required(application.readOrdinaryApplicationResourceBound);
		const entry = (catalog: (typeof catalogs)["shares"]) => {
			const resolved = catalog.catalog.resolve(catalog.blueprintDigest);
			return {
				blueprintDigest: resolved.blueprintDigest,
				artifactId: resolved.artifactId,
				artifactDigest: resolved.artifactDigest,
				catalogDigest: resolved.evidence.catalogDigest,
				runtimeProfile: resolved.runtimeProfile,
				exactArtifactBytes: resolved.exactArtifactBytes.slice(),
				canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice(),
			};
		};
		const material = (bases: readonly Uint8Array[]) => ({
			exactCanonicalBaseStateBytes: [...bases],
			currentOperations: [],
			protectedOperations: [],
			recoveryOperations: [],
			candidateOperation: null,
		});
		// The fullest state: 16 holders and a window filled to its budget.
		const sixteen = Array.from(
			{ length: 16 },
			(_, index) => [index.toString(16).padStart(2, "0").repeat(32), 9_007_199_254] as const
		);
		const full: ShippingChatMessage[] = [];
		for (let index = 0; total(full) + 1_900 <= windowBytes(16); index++)
			full.push(sized(sixteen[index % 16]![0], `full-${index}`, 1_900));
		const fullState = sharesState(sixteen, full);
		const genesis = createShippingChatSharesGenesisStateBytes({
			exactCanonicalLatchedAclBytes: aclBytes(0, GENESIS_ROLES),
		});
		const input = (catalog = entry(catalogs.shares), bases: readonly Uint8Array[] = [genesis, fullState]) =>
			({ catalog, material: material(bases) }) as unknown as Parameters<typeof read>[0];
		expect(read(input())).toEqual({ byteLength: 32_768, items: 16_384, maxDepth: 16 });
		expect(fullState.byteLength).toBeLessThanOrEqual(32_768);
		// The v4 catalog entry, a v4 state, or a tampered v5 state: no bound.
		expect(read(input(entry(catalogs.window)))).toBeUndefined();
		expect(
			read(
				input(entry(catalogs.shares), [
					createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0, GENESIS_ROLES) }),
				])
			)
		).toBeUndefined();
		expect(read(input(entry(catalogs.shares), [Uint8Array.of(...fullState, 0)]))).toBeUndefined();
		expect(read(input(entry(catalogs.shares), []))).toBeUndefined();
	});
});

function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("CHAT_SHARES_RULE_REQUIRED");
	return value;
}
