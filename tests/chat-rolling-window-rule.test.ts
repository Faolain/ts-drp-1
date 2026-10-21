import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
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
		// Same equal split of the same budget, now as a window share.
		const v3 = decodeCanonical(createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) }));
		const v4 = decodeCanonical(
			createShippingChatWindowGenesisStateBytes({ exactCanonicalLatchedAclBytes: aclBytes(0) })
		);
		expect(v4).toEqual({ ...(v3 as object), version: 4 });
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
		expect(() => windowState([[A, 32_768]])).toThrow();
		expect(() => windowState([[A, 1_000]], [one, one])).toThrow();
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
});

function required<Value>(value: Value | undefined): Value {
	if (value === undefined) throw new TypeError("CHAT_WINDOW_RULE_REQUIRED");
	return value;
}
