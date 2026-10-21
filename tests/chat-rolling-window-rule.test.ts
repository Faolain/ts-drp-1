import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { canonicalCarrierResourceForSizing } from "@ts-drp/canonical/resource";
import { describe, expect, it } from "vitest";

import { openShippingChatCatalogs } from "../examples/chat/src/chat-catalogs.js";
import {
	createShippingV3ChatApplication,
	type ShippingChatApplication,
	type ShippingChatMessage,
} from "../examples/chat/src/v3-chat-application.js";
import { createShippingChatGenesisStateBytes } from "../examples/chat/src/v3-chat-capacity.js";
import {
	createShippingChatWindowAdmissionPolicy,
	createShippingChatWindowGenesisStateBytes,
	restoreShippingChatWindowState,
	SHIPPING_CHAT_WINDOW_ARTIFACT_ID,
	shippingChatWindowStateBytes,
} from "../examples/chat/src/v3-chat-window.js";

// Track W: the window rule of the shipped Chat's new-room format (version 4), exercised through
// the genuine compiled reducer (the window catalog's artifact, folded by the library's blueprint
// runtime) and the shipped admission policy. The long room is tests/chat-rolling-window-native.test.ts.

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const OBJECT = "creator:chat-window-rule";
const T = 1_791_662_400_000;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const size = (message: ShippingChatMessage): number => encodeCanonical(message).byteLength;
const identity = (message: Readonly<{ author: string; clientOperationId: string }>): string =>
	`${message.author}\u0000${message.clientOperationId}`;

function aclBytes(epoch: number, writers: readonly string[] = [A, B, C]): Uint8Array {
	return encodeCanonical({
		epoch,
		kind: "drp-v3-latched-acl",
		members: writers.map((author, index) => ({
			author,
			finalityKey: index === 0 ? author : null,
			groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
		})),
		objectId: OBJECT,
		permissionless: false,
		version: 3,
	});
}
const aclDigest = (bytes: Uint8Array): string => hex(hashDomain("ts-drp/latched-acl/v3", bytes));

function message(author: string, clientOperationId: string, text: string, displayTimeMs = T): ShippingChatMessage {
	return { author, clientOperationId, displayTimeMs, text };
}
const operationOf = (value: ShippingChatMessage) => ({
	action: "message",
	clientOperationId: value.clientOperationId,
	displayTimeMs: value.displayTimeMs,
	text: value.text,
});

interface GenesisState {
	readonly version: number;
	readonly messages: readonly unknown[];
	readonly capacity: { readonly version: 1; readonly basisObjectId: string; allocations: [string, number, number][] };
}
/** The empty state with every row at the budget's width, two bytes of count framing, and the shares. */
const splitTotal = (state: GenesisState, budget: number): number =>
	encodeCanonical({
		...state,
		messages: [],
		capacity: {
			...state.capacity,
			allocations: state.capacity.allocations.map(([author, , epoch]) => [author, budget, epoch]),
		},
	}).byteLength +
	2 +
	state.capacity.allocations.reduce((sum, [, ceiling]) => sum + ceiling, 0);

/** A version-4 state with explicit ceilings (rows sorted by author). */
function windowState(ceilings: readonly (readonly [string, number])[], messages: readonly ShippingChatMessage[] = []) {
	return shippingChatWindowStateBytes({
		version: 4,
		messages,
		capacity: {
			version: 1,
			basisObjectId: OBJECT,
			allocations: ceilings.map(([author, ceiling]) => [author, ceiling, 0]),
		},
	});
}

const catalogs = openShippingChatCatalogs();
async function windowApplication(): Promise<ShippingChatApplication> {
	return createShippingV3ChatApplication({
		catalog: catalogs.window.catalog,
		blueprintDigest: catalogs.window.blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: aclBytes(0),
	});
}

/** Folds `operations` (in this order) over `base` through the genuine compiled reducer. */
function project(
	application: ShippingChatApplication,
	base: Uint8Array,
	operations: readonly (readonly [author: string, operation: Readonly<Record<string, unknown>>])[]
) {
	return application.projectAcceptedOperations({
		authenticatedBase: {
			blueprintDigest: catalogs.window.blueprintDigest,
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
const windowIdentities = (application: ShippingChatApplication, base: Uint8Array, messages: ShippingChatMessage[]) =>
	project(
		application,
		base,
		messages.map((value) => [value.author, operationOf(value)] as const)
	).messages.map(identity);

function policy(input: { epoch?: number; base?: Uint8Array; closed?: Uint8Array; writers?: readonly string[] }) {
	const epoch = input.epoch ?? 7;
	const acl = aclBytes(epoch, input.writers);
	return createShippingChatWindowAdmissionPolicy({
		aclDigest: aclDigest(acl),
		epoch,
		exactCanonicalLatchedAclBytes: acl,
		...(input.base === undefined ? {} : { authenticatedApplicationStateBytes: input.base }),
		...(input.closed === undefined ? {} : { authenticatedClosedApplicationStateBytes: input.closed }),
		exactCanonicalGenesisStateBytes: createShippingChatWindowGenesisStateBytes({
			exactCanonicalLatchedAclBytes: aclBytes(0),
		}),
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

describe("Track W: Chat's new-room window format", () => {
	it("new rooms sign the window format; the lifetime format and its catalog are unchanged", async () => {
		expect(SHIPPING_CHAT_WINDOW_ARTIFACT_ID).toBe("v3-shipping-chat.v4");
		expect(catalogs.window.catalog.blueprintDigests).toEqual([catalogs.window.blueprintDigest]);
		expect(catalogs.window.catalog.resolve(catalogs.window.blueprintDigest).artifactId).toBe("v3-shipping-chat.v4");
		// Rooms whose genesis signed v3 keep it, byte for byte.
		expect(catalogs.lifetime.blueprintDigest).toBe("61ab694a75cab170e0f2202a9f0f712a683d5f166334e59f8fdf0d4e43df065f");
		expect(catalogs.lifetime.catalog.resolve(catalogs.lifetime.blueprintDigest).artifactId).toBe("v3-shipping-chat.v3");
		// The window's own budget (65,536 bytes, owner review 2026-10-21) split equally among the
		// genesis roster, by the rule the lifetime format splits its unchanged 32,768: the empty
		// state with maximum-width rows, two bytes of count framing and the shares make exactly
		// the budget, and the shares differ by at most one byte.
		const v3 = decodeCanonical(
			createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
		) as GenesisState;
		const v4 = decodeCanonical(
			createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
		) as GenesisState;
		expect(v4).toMatchObject({ version: 4, messages: [], capacity: { version: 1, basisObjectId: OBJECT } });
		expect(v3.capacity.allocations.map(([, ceiling]) => ceiling)).toEqual([10_814, 10_813, 10_813]);
		expect(v4.capacity.allocations).toEqual([
			[A, 21_736, 0],
			[B, 21_736, 0],
			[C, 21_736, 0],
		]);
		expect(splitTotal(v3, 32_768)).toBe(32_768);
		expect(splitTotal(v4, 65_536)).toBe(65_536);
		const lifetime = await createShippingV3ChatApplication({
			catalog: catalogs.lifetime.catalog,
			blueprintDigest: catalogs.lifetime.blueprintDigest,
			exactCanonicalGenesisLatchedAclBytes: aclBytes(0),
		});
		const empty = { authenticatedBase: undefined, currentEpochOperations: [] };
		expect(
			decodeCanonical(lifetime.migration!.canonicalStateBytes(lifetime.projectAcceptedOperations(empty)))
		).toMatchObject({
			version: 3,
		});
		const window = await windowApplication();
		expect(
			decodeCanonical(window.migration!.canonicalStateBytes(window.projectAcceptedOperations(empty)))
		).toMatchObject({
			version: 4,
		});
	});

	it("the reducer charges a message its exact canonical record size", async () => {
		const application = await windowApplication();
		const texts = [
			"a",
			"é",
			"棋 ♟ café",
			"𝄞",
			"😀x",
			// UTF-8 length varint widths change at 128 and 16,384 bytes.
			"x".repeat(127),
			"x".repeat(128),
			"é".repeat(63) + "x",
			"é".repeat(64),
			"x".repeat(16_383),
			"x".repeat(16_384),
		];
		const ids = ["i", "x".repeat(127), "x".repeat(128), "A.b_c:d-9"];
		const times = [0, 63, 64, 8191, 8192, T, Number.MAX_SAFE_INTEGER];
		let cases = 0;
		for (const text of texts)
			for (const id of ids)
				for (const time of times) {
					if (cases++ % 3 !== 0 && text.length > 1000) continue;
					const first = message(A, `first-${cases}`, "first message");
					const second = message(A, id, text, time);
					const exact = size(first) + size(second);
					// Exactly enough: both stay. One byte less: the older one leaves.
					expect(windowIdentities(application, windowState([[A, exact]]), [first, second])).toEqual([
						identity(first),
						identity(second),
					]);
					expect(windowIdentities(application, windowState([[A, exact - 1]]), [first, second])).toEqual([
						identity(second),
					]);
				}
		expect(cases).toBeGreaterThan(100);
	});

	it("a member's new message pushes out only that member's own oldest messages", async () => {
		const application = await windowApplication();
		const pad = (index: number) => String(index).padStart(2, "0");
		const a = Array.from({ length: 12 }, (_, index) => message(A, `a-${pad(index)}`, `alpha ${pad(index)}`));
		const b = Array.from({ length: 3 }, (_, index) => message(B, `b-${pad(index)}`, `bravo ${pad(index)}`));
		const share = 4 * size(required(a[0]));
		const base = windowState([
			[A, share],
			[B, share],
		]);
		// B's three messages among A's twelve: A keeps its newest four, B keeps all three, and
		// the window keeps application order.
		const order = [...a.slice(0, 2), required(b[0]), ...a.slice(2, 8), required(b[1]), ...a.slice(8), required(b[2])];
		expect(windowIdentities(application, base, order)).toEqual(
			order.filter((value) => value.author === B || a.indexOf(value) >= 8).map(identity)
		);
		// The same messages over a base where B already holds old messages: A's messages never displace them.
		const held = message(B, "b-old", "an old bravo");
		const withB = windowState(
			[
				[A, share],
				[B, share],
			],
			[held]
		);
		const projected = windowIdentities(application, withB, a);
		expect(projected).toContain(identity(held));
		expect(projected.filter((value) => value.startsWith(A))).toEqual(a.slice(8).map(identity));
	});

	it("an exact retry refreshes its message; a different message under a held identity is a conflict", async () => {
		const application = await windowApplication();
		const one = message(A, "one", "first");
		const two = message(A, "two", "second");
		const three = message(A, "three", "third");
		const share = size(one) + size(two) + size(three);
		const base = windowState([[A, share]]);
		// The retry of "one" moves it to the newest position, so "two" is the oldest and leaves first.
		const four = message(A, "four", "x");
		expect(windowIdentities(application, base, [one, two, one, three])).toEqual([two, one, three].map(identity));
		expect(windowIdentities(application, base, [one, two, one, three, four])).toEqual([one, three, four].map(identity));
		const admission = policy({ base: windowState([[A, share]], [one]) });
		expect(admission.reserve(operationOf(message(A, "one", "changed")), { author: A })).toEqual({ kind: "conflict" });
		expect(admission.reserve(operationOf(one), { author: A })).toMatchObject({ kind: "fresh" });
	});

	it("admission caps a member's epoch at their share, whatever the order, and replays accept what was admitted", async () => {
		const application = await windowApplication();
		const share = 10_808;
		const ceilings = [
			[A, share],
			[B, share],
			[C, share],
		] as const;
		// A full window: every member already holds a share's worth of older messages.
		const old = [A, B, C].flatMap((author) => {
			const rows: ShippingChatMessage[] = [];
			for (let index = 0; ; index++) {
				const next = message(author, `old-${index}`, `older message ${index} ${"o".repeat(index % 40)}`);
				if (rows.reduce((sum, row) => sum + size(row), 0) + size(next) > share) break;
				rows.push(next);
			}
			return rows;
		});
		const base = windowState(ceilings, old);
		const sent = Array.from({ length: 120 }, (_, index) => message(A, `new-${index}`, `new message ${index}`));
		const admit = (rows: readonly ShippingChatMessage[], input: Parameters<typeof policy>[0]) => {
			const admission = policy(input);
			return rows.map((row) => {
				const reservation = admission.reserve(operationOf(row), { author: A });
				if (reservation.kind === "fresh") reservation.commit();
				return reservation.kind === "rejected" ? `rejected:${reservation.reason ?? ""}` : reservation.kind;
			});
		};
		const forward = admit(sent, { base });
		const admitted = sent.filter((_, index) => forward[index] === "fresh");
		const charge = admitted.reduce((sum, row) => sum + size(row), 0);
		expect(charge).toBeLessThanOrEqual(share);
		expect(charge + size(required(sent[admitted.length]))).toBeGreaterThan(share);
		expect(forward.slice(admitted.length).every((kind) => kind === "rejected:capacity")).toBe(true);
		// Any order of the same admitted set is accepted in full (journal replay, displaced rebase).
		expect(admit([...admitted].reverse(), { base }).every((kind) => kind === "fresh")).toBe(true);
		// Other members are unaffected by A's epoch.
		expect(policy({ base }).reserve(operationOf(message(B, "b-new", "hello")), { author: B })).toMatchObject({
			kind: "fresh",
		});
		// The sealed postimage keeps every admitted message, and the creator's transcript check over
		// it accepts every one of them again.
		const sealed = project(
			application,
			base,
			admitted.map((row) => [A, operationOf(row)] as const)
		);
		const postimage = application.migration!.canonicalStateBytes(sealed);
		expect(sealed.messages.filter((row) => row.author === A).map(identity)).toEqual(admitted.map(identity));
		expect(admit(admitted, { closed: postimage }).every((kind) => kind === "fresh")).toBe(true);
		// A released reservation frees its bytes.
		const admission = policy({ base });
		const held = admitted.map((row) => admission.reserve(operationOf(row), { author: A }));
		expect(admission.reserve(operationOf(message(A, "late", "late message")), { author: A })).toMatchObject({
			kind: "rejected",
			reason: "capacity",
		});
		const last = required(held.at(-1));
		if (last.kind !== "fresh") throw new TypeError("expected a fresh reservation");
		last.release();
		expect(admission.reserve(operationOf(message(A, "late", "late message")), { author: A })).toMatchObject({
			kind: "fresh",
		});
	});

	it("nothing admitted in an epoch leaves the window before that epoch is sealed, in any interleaving", async () => {
		const application = await windowApplication();
		const next = random(0x5eed_c4a7);
		const share = 2_000;
		const ceilings = [
			[A, share],
			[B, share],
			[C, share],
		] as const;
		for (let round = 0; round < 40; round++) {
			const old = [A, B, C].flatMap((author) =>
				Array.from({ length: 8 }, (_, index) => message(author, `old-${round}-${index}`, `o${round}-${index}`))
			);
			const base = windowState(ceilings, old);
			const admission = policy({ base });
			const admitted = new Map<string, ShippingChatMessage[]>([
				[A, []],
				[B, []],
				[C, []],
			]);
			for (let index = 0; index < 60; index++) {
				const author = [A, B, C][Math.floor(next() * 3)]!;
				const text = "m".repeat(1 + Math.floor(next() * 400));
				const candidate =
					next() < 0.1 && admitted.get(author)!.length > 0
						? admitted.get(author)![Math.floor(next() * admitted.get(author)!.length)]!
						: message(author, `r${round}-${index}`, text, T + index);
				const reservation = admission.reserve(operationOf(candidate), { author });
				if (reservation.kind !== "fresh") continue;
				reservation.commit();
				admitted.get(author)!.push(candidate);
			}
			// Two interleavings that keep each member's own order.
			const interleave = () => {
				const queues = [A, B, C].map((author) => [...admitted.get(author)!]);
				const out: (readonly [string, Record<string, unknown>])[] = [];
				while (queues.some((queue) => queue.length > 0)) {
					const open = queues.filter((queue) => queue.length > 0);
					const queue = open[Math.floor(next() * open.length)]!;
					const row = queue.shift()!;
					out.push([row.author, operationOf(row)]);
				}
				return out;
			};
			const first = project(application, base, interleave());
			const second = project(application, base, interleave());
			const held = new Set(first.messages.map(identity));
			for (const rows of admitted.values())
				for (const row of rows) expect(held.has(identity(row)), `round ${round}: ${row.clientOperationId}`).toBe(true);
			for (const author of [A, B, C])
				expect(second.messages.filter((row) => row.author === author)).toEqual(
					first.messages.filter((row) => row.author === author)
				);
		}
	});

	it("admission refuses a member without a share, a message larger than the share, and counts batch entries", async () => {
		const share = 1_000;
		const base = windowState([
			[A, share],
			[B, 0],
		]);
		expect(
			policy({ base, writers: [A, B, C] }).reserve(operationOf(message(C, "c", "hi")), { author: C })
		).toMatchObject({
			kind: "rejected",
		});
		expect(policy({ base }).reserve(operationOf(message(B, "b", "hi")), { author: B })).toMatchObject({
			kind: "rejected",
			reason: "capacity",
		});
		expect(policy({ base }).reserve(operationOf(message(A, "big", "x".repeat(share))), { author: A })).toMatchObject({
			kind: "rejected",
			reason: "capacity",
		});
		const entries = Array.from({ length: 8 }, (_, index) => message(A, `batch-${index}`, "y".repeat(100)));
		const batch = {
			action: "applicationBatch",
			batch: {
				version: 1,
				entries: entries.map((row, index) => ({ logicalTime: index + 1, operation: operationOf(row) })),
			},
		};
		expect(entries.reduce((sum, row) => sum + size(row), 0)).toBeGreaterThan(share);
		expect(policy({ base }).reserve(batch, { author: A })).toMatchObject({ kind: "rejected", reason: "capacity" });
		const fits = { ...batch, batch: { ...batch.batch, entries: batch.batch.entries.slice(0, 4) } };
		expect(policy({ base }).reserve(fits, { author: A })).toMatchObject({ kind: "fresh" });
	});

	it("the window state refuses what the format forbids, and a window room inherits no lifetime state", async () => {
		const one = message(A, "one", "first");
		expect(() => windowState([[A, size(one) - 1]], [one])).toThrow();
		expect(() => windowState([[A, 65_536]])).toThrow();
		expect(() => windowState([[A, 1_000]], [one, one])).toThrow();
		// A share may exceed the lifetime format's whole 32 KiB budget, and the reducer keeps what it holds.
		const big = [message(A, "big-1", "x".repeat(20_000)), message(A, "big-2", "y".repeat(20_000))];
		const large = windowState([[A, size(required(big[0])) + size(required(big[1]))]]);
		expect(windowIdentities(await windowApplication(), large, big)).toEqual(big.map(identity));
		expect(() =>
			restoreShippingChatWindowState(
				createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
			)
		).toThrow();
		const application = await windowApplication();
		expect(() =>
			application.migration!.prepare(
				[],
				createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
			)
		).toThrow();
		expect(
			policy({}).reserve(
				{
					action: "migrationRecord",
					record: {
						version: 2,
						applicationState: decodeCanonical(
							createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
						),
					},
				},
				{ author: A }
			)
		).toMatchObject({ kind: "rejected" });
	});

	it("states Track Q's ordinary resource bound for its own catalog entry and window states only", async () => {
		const application = await windowApplication();
		const read = required(application.readOrdinaryApplicationResourceBound);
		const entry = (catalog: (typeof catalogs)["window"]) => {
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
		// A full window: every member at (or just under) the ceiling.
		const genesis = createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) });
		const ceilings = (decodeCanonical(genesis) as { capacity: { allocations: [string, number, number][] } }).capacity
			.allocations;
		const full: ShippingChatMessage[] = [];
		for (const [author, ceiling] of ceilings) {
			let used = 0;
			for (let index = 0; ; index++) {
				const next = message(author, `full-${index}`, "x".repeat(200));
				if (used + size(next) > ceiling) break;
				used += size(next);
				full.push(next);
			}
		}
		const fullState = shippingChatWindowStateBytes({
			version: 4,
			messages: full,
			capacity: (decodeCanonical(genesis) as { capacity: unknown }).capacity,
		});
		const input = (catalog = entry(catalogs.window), bases: readonly Uint8Array[] = [genesis, fullState]) =>
			({ catalog, material: material(bases) }) as unknown as Parameters<typeof read>[0];
		// The window's own value (for owner review; the lifetime format keeps Track Q's approved
		// {32768, 16384, 16}): the widest state the window's capture admits, per dimension (the
		// next test shows each is reached and none exceeded). Every window state fits it.
		expect(read(input())).toEqual({ byteLength: 65_535, items: 9_503, maxDepth: 4 });
		expect(fullState.byteLength).toBeLessThanOrEqual(65_535);
		// The lifetime catalog entry, a lifetime state, or a tampered window state: no bound.
		expect(read(input(entry(catalogs.lifetime)))).toBeUndefined();
		expect(
			read(
				input(entry(catalogs.window), [
					createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) }),
				])
			)
		).toBeUndefined();
		expect(read(input(entry(catalogs.window), [Uint8Array.of(...fullState, 0)]))).toBeUndefined();
		expect(read(input(entry(catalogs.window), []))).toBeUndefined();
	});

	it("the window's bound is exact: a witness reaches each dimension, and no state its capture admits exceeds one", () => {
		const footprint = (bytes: Uint8Array): ReturnType<typeof canonicalCarrierResourceForSizing> =>
			canonicalCarrierResourceForSizing(bytes, 16, { maxBytes: 65_536, maxItems: 16_384, maxDepth: 16 }, "exact");
		// Bytes: the genesis shares, each filled exactly by its member, with at least 128 messages
		// (the messages count takes its second byte): one byte under the 65,536-byte budget.
		const genesis = decodeCanonical(
			createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
		) as GenesisState;
		const filled = genesis.capacity.allocations.flatMap(([author, ceiling]) => fillExactly(author, ceiling));
		expect(filled.length).toBeGreaterThanOrEqual(128);
		const widest = shippingChatWindowStateBytes({ version: 4, messages: filled, capacity: genesis.capacity });
		expect(widest.byteLength).toBe(65_535);
		// Depth: state, capacity, allocations, row.
		expect(footprint(widest).maxDepth).toBe(4);
		// Items: an exhaustive search over the capture's rules finds the most items any admitted
		// state can have, and the window's capture admits the state it finds.
		const search = widestByItems(65_536);
		expect(search.items).toBe(9_503);
		const witness = itemsWitness(search.messagesPerMember);
		const bytes = shippingChatWindowStateBytes(witness);
		expect(footprint(bytes)).toEqual({ byteLength: bytes.byteLength, items: 9_503, maxDepth: 4 });
		// One more smallest message is refused: over its member's share, or, with the share raised
		// to hold it, over the budget.
		const first = required(witness.capacity.allocations[0]);
		const extra = smallestMessage(first[0], required(search.messagesPerMember[0]));
		const messages = [...witness.messages, extra];
		expect(() => shippingChatWindowStateBytes({ ...witness, messages })).toThrow();
		const raised = [[first[0], first[1] + size(extra), first[2]], ...witness.capacity.allocations.slice(1)];
		expect(() =>
			shippingChatWindowStateBytes({ ...witness, messages, capacity: { ...witness.capacity, allocations: raised } })
		).toThrow();
	});
});

// The capture's identity alphabet (`[A-Za-z0-9._:-]`): 66 one-character identities per member.
const IDENTITY_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-";
const memberAuthor = (index: number): string => index.toString(16).padStart(64, "0");
/** A member's `index`th smallest message: shortest new identity, one-character text, display time 0. */
function smallestMessage(author: string, index: number): ShippingChatMessage {
	const n = IDENTITY_CHARACTERS.length;
	const id =
		index < n
			? required(IDENTITY_CHARACTERS[index])
			: required(IDENTITY_CHARACTERS[Math.floor((index - n) / n)]) + required(IDENTITY_CHARACTERS[(index - n) % n]);
	return message(author, id, "x", 0);
}
/** Messages of `author` whose records sum to exactly `ceiling` bytes (200, then two of 150-250). */
function fillExactly(author: string, ceiling: number): ShippingChatMessage[] {
	const make = (index: number, bytes: number): ShippingChatMessage => {
		const id = `f-${String(index).padStart(4, "0")}`;
		// Text of up to 127 characters: its length takes one byte, so each character is one byte.
		const base = size(message(author, id, "x")) - 2;
		return message(author, id, "x".repeat(bytes - base - 1));
	};
	const rows: ShippingChatMessage[] = [];
	let left = ceiling;
	for (; left > 500; left -= 200) rows.push(make(rows.length, 200));
	const half = Math.floor(left / 2);
	rows.push(make(rows.length, half), make(rows.length + 1, left - half));
	expect(rows.reduce((sum, row) => sum + size(row), 0)).toBe(ceiling);
	return rows;
}
interface WitnessState {
	readonly version: 4;
	readonly messages: ShippingChatMessage[];
	readonly capacity: { readonly version: 1; readonly basisObjectId: string; allocations: [string, number, number][] };
}
const emptyState = (allocations: readonly (readonly [string, number, number])[]): WitnessState => ({
	version: 4,
	messages: [],
	capacity: {
		version: 1 as const,
		basisObjectId: "x",
		allocations: allocations.map(([author, ceiling, epoch]): [string, number, number] => [author, ceiling, epoch]),
	},
});
const itemsOf = (value: unknown): number =>
	canonicalCarrierResourceForSizing(encodeCanonical(value), 16, { maxBytes: 65_536, maxItems: 16_384, maxDepth: 16 })
		.items;
/** The smallest charge of a member holding `count` messages (its `count` smallest). */
function smallestCharge(count: number): number {
	let charge = 0;
	for (let index = 0; index < count; index++) charge += size(smallestMessage(memberAuthor(1), index));
	return charge;
}
/**
 * The most decoder items of any state the window's capture admits within `budget`, by an
 * exhaustive search over the capture's rules, independent of the product: every member is a
 * distinct author with one row; a member's messages have distinct identities and charge at most
 * the member's ceiling; the empty state (shortest basis), two bytes of count framing and every
 * ceiling fit the budget. A member holding k messages costs its row plus its k smallest records
 * (ceiling = charge), and is worth its row's and messages' items; the search is an unbounded
 * knapsack over members.
 */
function widestByItems(budget: number): Readonly<{ items: number; messagesPerMember: readonly number[] }> {
	const empty = emptyState([]);
	const room = budget - 2 - encodeCanonical(empty).byteLength;
	const rowItems = itemsOf(emptyState([[memberAuthor(1), 0, 0]])) - itemsOf(empty);
	const messageItems =
		itemsOf({ ...emptyState([[memberAuthor(1), 1_000, 0]]), messages: [smallestMessage(memberAuthor(1), 0)] }) -
		itemsOf(emptyState([[memberAuthor(1), 1_000, 0]]));
	const options: { count: number; cost: number; value: number }[] = [];
	for (let count = 0; ; count++) {
		const charge = smallestCharge(count);
		const cost = encodeCanonical([memberAuthor(1), charge, 0]).byteLength + charge;
		if (cost > room) break;
		options.push({ count, cost, value: rowItems + count * messageItems });
	}
	const best = new Int32Array(room + 1);
	const pick = new Int32Array(room + 1).fill(-1);
	for (let bytes = 1; bytes <= room; bytes++) {
		best[bytes] = required(best[bytes - 1]);
		for (let index = 0; index < options.length; index++) {
			const option = required(options[index]);
			if (option.cost > bytes) break;
			const value = required(best[bytes - option.cost]) + option.value;
			if (value > required(best[bytes])) {
				best[bytes] = value;
				pick[bytes] = index;
			}
		}
	}
	const messagesPerMember: number[] = [];
	for (let bytes = room; bytes > 0; ) {
		const index = required(pick[bytes]);
		if (index < 0) bytes -= 1;
		else {
			const option = required(options[index]);
			messagesPerMember.push(option.count);
			bytes -= option.cost;
		}
	}
	return { items: itemsOf(empty) + required(best[room]), messagesPerMember };
}
/** The state the search found: member i holds its `perMember[i]` smallest messages at ceiling = charge. */
function itemsWitness(perMember: readonly number[]): WitnessState {
	const state = emptyState(perMember.map((count, index) => [memberAuthor(index + 1), smallestCharge(count), 0]));
	return {
		...state,
		messages: perMember.flatMap((count, index) =>
			Array.from({ length: count }, (_, ordinal) => smallestMessage(memberAuthor(index + 1), ordinal))
		),
	};
}

function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("CHAT_WINDOW_RULE_REQUIRED");
	return value;
}
