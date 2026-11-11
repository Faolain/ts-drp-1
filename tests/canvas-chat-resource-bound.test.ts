/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers: inference keeps the reader's input shape. */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- Each asserted value was produced a line earlier by the test. */
import { openTrustedBlueprintCatalogBytes, type TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { canonicalCarrierResourceForSizing, type CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import { describe, expect, it } from "vitest";

import catalogMaterial from "../examples/chat/src/chat-catalog-material.json";
import { openShippingChatCatalogs } from "../examples/chat/src/chat-catalogs.js";
import {
	createShippingChatGenesisStateBytes,
	createShippingV3ChatApplication,
	type ShippingChatApplication,
} from "../examples/chat/src/v3-chat-application.js";
import {
	captureShippingChatCapacityState,
	restoreShippingChatCapacityState,
	SHIPPING_CHAT_RETAINED_BYTES,
	shippingChatCapacityStateBytes,
} from "../examples/chat/src/v3-chat-capacity.js";
import {
	CANVAS_LIMITS,
	CANVAS_SNAPSHOT_LIMITS,
	type CanvasState,
	createV3CanvasDescriptor,
} from "../packages/blueprints/src/v3-canvas.js";
import { createV3CanvasApplication } from "../packages/node/src/applications/canvas.js";

// Track Q (Canvas and Chat creator lull), RED first. The shipped Canvas and Chat
// compositions supply `readOrdinaryApplicationResourceBound`, derived by ONE rule from each
// application's own reviewed limits (docs/realtime-latency/tracks/27-track-q-canvas-chat-lull):
// the bound is a canonical footprint that dominates every state the application's own state
// capture accepts, computed only from limits that capture enforces, never from observed
// sizes. It does not depend on the operations, and it refuses (undefined) any input that is
// not this application's exact catalog and its own authenticated base states.
//
// The room's consumer (packages/node/src/internal/creator-closed-rollback-data.ts
// `deriveCreatorOrdinaryApplicationResourceForSizing`) accepts a value only as a plain
// three-field footprint and re-decodes every base state under it. `fitsUnder` below is that
// base check.

type Reader = NonNullable<ReturnType<typeof createV3CanvasApplication>["readOrdinaryApplicationResourceBound"]>;
type ReaderInput = Parameters<Reader>[0];

function fitsUnder(bytes: Uint8Array, bound: CanonicalResourceFootprint): boolean {
	try {
		const base = canonicalCarrierResourceForSizing(bytes, bound.maxDepth, {
			maxBytes: bound.byteLength,
			maxItems: bound.items,
		});
		return base.byteLength <= bound.byteLength && base.items <= bound.items;
	} catch {
		return false;
	}
}

function exactFootprint(bytes: Uint8Array, maxDepth: number): CanonicalResourceFootprint {
	return canonicalCarrierResourceForSizing(bytes, maxDepth, {}, "exact");
}

function catalogInput(catalog: TrustedBlueprintCatalog): ReaderInput["catalog"] {
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined) throw new TypeError("genuine catalog entry unavailable");
	const resolved = catalog.resolve(blueprintDigest);
	return {
		blueprintDigest: resolved.blueprintDigest,
		artifactId: resolved.artifactId,
		artifactDigest: resolved.artifactDigest,
		catalogDigest: resolved.evidence.catalogDigest,
		runtimeProfile: resolved.runtimeProfile,
		exactArtifactBytes: resolved.exactArtifactBytes.slice(),
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice(),
	} as ReaderInput["catalog"];
}

/** The room hands the reader a canonical round trip of its complete input. */
function roomInput(input: ReaderInput): ReaderInput {
	return decodeCanonical(encodeCanonical(input)) as ReaderInput;
}

function material(bases: readonly Uint8Array[], operations: readonly unknown[] = [], candidate: unknown = null) {
	return {
		exactCanonicalBaseStateBytes: [...bases],
		currentOperations: [...operations],
		protectedOperations: [],
		recoveryOperations: [],
		candidateOperation: candidate,
	};
}

/**
 * The incremental projection states the reader's theorem: built only from this composition's own
 * catalog and bases (the material without a candidate), every quote equals the complete reader's
 * value for any candidate, advancing never changes it, and foreign input builds no projection.
 */
function expectSameTheoremProjection(read: Reader, input: ReaderInput, foreignBase: Uint8Array): void {
	const create = Object.getOwnPropertyDescriptor(read, "createIncrementalProjection")?.value as
		| ((input: unknown) => Record<string, (...args: unknown[]) => unknown> | undefined)
		| undefined;
	expect(typeof create).toBe("function");
	if (create === undefined) return;
	const { candidateOperation: _candidate, ...withoutCandidate } = input.material;
	const projectionInput = { catalog: input.catalog, material: withoutCandidate };
	const value = read(input);
	expect(value).toBeDefined();
	const projection = create(projectionInput);
	expect(projection).toBeDefined();
	expect(Reflect.ownKeys(projection ?? {}).sort()).toEqual(["advance", "quote", "quoteWithoutApplicationCandidate"]);
	expect(projection?.quoteWithoutApplicationCandidate?.()).toEqual(value);
	for (const candidate of [null, { action: "anything" }, "x".repeat(1024)])
		expect(projection?.quote?.(candidate)).toEqual(value);
	expect(projection?.advance?.([{ action: "anything" }])).toBe(true);
	expect(projection?.quoteWithoutApplicationCandidate?.()).toEqual(value);
	// The complete reader's input (with a candidate) is not the projection's shape.
	expect(create(input)).toBeUndefined();
	expect(create({ ...projectionInput, catalog: { ...input.catalog, blueprintDigest: "unknown" } })).toBeUndefined();
	expect(
		create({ ...projectionInput, material: { ...withoutCandidate, exactCanonicalBaseStateBytes: [foreignBase] } })
	).toBeUndefined();
}

/** Refusals every reader must give: foreign identity, mutated carrier, missing or accessor field, foreign material shape. */
function expectBindingRefusals(read: Reader, input: ReaderInput, foreignBase: Uint8Array): void {
	expect(read(input)).toBeDefined();
	for (const key of ["blueprintDigest", "artifactId", "artifactDigest", "catalogDigest", "runtimeProfile"] as const)
		expect(read({ ...input, catalog: { ...input.catalog, [key]: "unknown" } })).toBeUndefined();
	for (const key of ["exactArtifactBytes", "canonicalBlueprintPackageBytes"] as const) {
		const changed = input.catalog[key].slice();
		changed[0] = (changed[0] ?? 0) ^ 1;
		expect(read({ ...input, catalog: { ...input.catalog, [key]: changed } })).toBeUndefined();
	}
	const missing: Partial<ReaderInput["catalog"]> = { ...input.catalog };
	delete missing.artifactDigest;
	expect(read({ ...input, catalog: missing as ReaderInput["catalog"] })).toBeUndefined();
	expect(read({ ...input, catalog: { ...input.catalog, extra: 1 } as ReaderInput["catalog"] })).toBeUndefined();
	let getterCalls = 0;
	const accessor = Object.defineProperty({ ...input.catalog }, "artifactId", {
		enumerable: true,
		get() {
			getterCalls++;
			return input.catalog.artifactId;
		},
	});
	expect(read({ ...input, catalog: accessor })).toBeUndefined();
	expect(getterCalls).toBe(0);
	const bases = input.material.exactCanonicalBaseStateBytes;
	const withMaterial = (value: unknown) => read({ ...input, material: value as ReaderInput["material"] });
	expect(withMaterial({ ...input.material, exactCanonicalBaseStateBytes: [] })).toBeUndefined();
	expect(withMaterial({ ...input.material, exactCanonicalBaseStateBytes: [foreignBase] })).toBeUndefined();
	expect(withMaterial({ ...input.material, exactCanonicalBaseStateBytes: [...bases, foreignBase] })).toBeUndefined();
	const first = bases[0] ?? new Uint8Array();
	expect(
		withMaterial({ ...input.material, exactCanonicalBaseStateBytes: [Uint8Array.of(...first, 0)] })
	).toBeUndefined();
	expect(withMaterial({ ...input.material, exactCanonicalBaseStateBytes: [Array.from(first)] })).toBeUndefined();
	// eslint-disable-next-line no-sparse-arrays -- a hole is the case under test
	expect(withMaterial({ ...input.material, exactCanonicalBaseStateBytes: [first, , first] })).toBeUndefined();
	expect(withMaterial({ ...input.material, currentOperations: "not-a-list" })).toBeUndefined();
	const { candidateOperation: _candidate, ...withoutCandidate } = input.material;
	expect(withMaterial(withoutCandidate)).toBeUndefined();
	expect(withMaterial({ ...input.material, extra: [] })).toBeUndefined();
	expect(read({ ...input, extra: 1 } as ReaderInput)).toBeUndefined();
	expect(read(undefined as unknown as ReaderInput)).toBeUndefined();
}

// ---------------------------------------------------------------------------------------

function widestCanvas(width: number, height: number): CanvasState {
	const max = CANVAS_LIMITS.maxCounter;
	return {
		version: 1,
		width,
		height,
		counters: Array.from({ length: width * height }, () => [max, max, max] as const),
	};
}

/** Deterministic pseudo-random walk of admitted paints and splashes from `state`. */
function reachableCanvasStates(width: number, height: number, start: CanvasState, steps: number): CanvasState[] {
	const descriptor = createV3CanvasDescriptor(width, height);
	let seed = 0x9e3779b9;
	const next = (bound: number) => {
		seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
		return seed % bound;
	};
	const out: CanvasState[] = [];
	let state = start;
	for (let step = 0; step < steps; step++) {
		const rgb = [next(256), next(256), next(256)] as const;
		const offset = [next(width), next(height)] as const;
		const operation =
			next(2) === 0
				? { action: "paint" as const, offset, rgb }
				: {
						action: "splash" as const,
						offset,
						size: [1 + next(width - offset[0]), 1 + next(height - offset[1])] as const,
						rgb,
					};
		try {
			state = descriptor.kernel.apply(state, operation).state;
		} catch {
			// At `maxCounter` admission refuses: no state is produced.
			continue;
		}
		out.push(state);
	}
	return out;
}

describe("Canvas ordinary resource bound", () => {
	it("is supplied by the shipped composition with an incremental projection of the same theorem", () => {
		const application = createV3CanvasApplication(10, 10);
		const descriptor = createV3CanvasDescriptor(10, 10);
		const read = application.readOrdinaryApplicationResourceBound;
		expect(typeof read).toBe("function");
		if (read === undefined) return;
		const otherSize = createV3CanvasDescriptor(2, 2);
		expectSameTheoremProjection(
			read,
			{
				catalog: catalogInput(application.catalog),
				material: material([descriptor.canonicalStateBytes(descriptor.initialState)]),
			},
			otherSize.canonicalStateBytes(otherSize.initialState)
		);
	});

	it.each([
		[1, 1],
		[2, 2],
		[10, 10],
		[64, 32],
		[64, 64],
	])("at %ix%i equals the exact footprint of the widest state the Canvas capture admits", (width, height) => {
		const application = createV3CanvasApplication(width, height);
		const descriptor = createV3CanvasDescriptor(width, height);
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Canvas resource bound reader unavailable");
		const initial = descriptor.canonicalStateBytes(descriptor.initialState);
		const widest = descriptor.canonicalStateBytes(widestCanvas(width, height));
		const result = read(roomInput({ catalog: catalogInput(application.catalog), material: material([initial]) }));
		expect(result).toEqual(exactFootprint(widest, CANVAS_SNAPSHOT_LIMITS.maxDepth));
		expect(Object.keys(result ?? {})).toEqual(["byteLength", "items", "maxDepth"]);
		expect(Object.isFrozen(result)).toBe(true);
		// Inside the descriptor's own reviewed codec law (v3-canvas.ts CANVAS_SNAPSHOT_LIMITS).
		expect(result?.byteLength).toBeLessThanOrEqual(128 + 29 * width * height);
		expect(result?.items).toBe(17 + 8 * width * height);
		expect(result?.maxDepth).toBe(CANVAS_SNAPSHOT_LIMITS.maxDepth);
		// The consumer's base check accepts both extremes under it.
		expect(fitsUnder(initial, result!)).toBe(true);
		expect(fitsUnder(widest, result!)).toBe(true);
	});

	it("dominates every state reachable by admitted moves, including at the counter ceiling", () => {
		const application = createV3CanvasApplication(10, 10);
		const descriptor = createV3CanvasDescriptor(10, 10);
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Canvas resource bound reader unavailable");
		const bound = read({
			catalog: catalogInput(application.catalog),
			material: material([descriptor.canonicalStateBytes(descriptor.initialState)]),
		});
		if (bound === undefined) throw new TypeError("Canvas resource bound refused its own input");
		const nearCeiling = {
			...widestCanvas(10, 10),
			counters: widestCanvas(10, 10).counters.map(() => [CANVAS_LIMITS.maxCounter - 300, 7, 0] as const),
		};
		const states = [
			...reachableCanvasStates(10, 10, descriptor.initialState, 400),
			...reachableCanvasStates(10, 10, nearCeiling, 200),
		];
		expect(states.length).toBeGreaterThan(300);
		for (const state of states) {
			const bytes = descriptor.canonicalStateBytes(state);
			expect(fitsUnder(bytes, bound)).toBe(true);
			const actual = exactFootprint(bytes, CANVAS_SNAPSHOT_LIMITS.maxDepth);
			expect(actual.byteLength).toBeLessThanOrEqual(bound.byteLength);
			expect(actual.items).toBeLessThanOrEqual(bound.items);
			expect(actual.maxDepth).toBeLessThanOrEqual(bound.maxDepth);
		}
	});

	it("depends only on the composition, never on the operations or the candidate", () => {
		const application = createV3CanvasApplication(10, 10);
		const descriptor = createV3CanvasDescriptor(10, 10);
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Canvas resource bound reader unavailable");
		const catalog = catalogInput(application.catalog);
		const initial = descriptor.canonicalStateBytes(descriptor.initialState);
		const painted = descriptor.canonicalStateBytes(reachableCanvasStates(10, 10, descriptor.initialState, 50).at(-1)!);
		const expected = read({ catalog, material: material([initial]) });
		const paint = { action: "paint", clientOperationId: "p", payload: { offset: [1, 2], rgb: [255, 255, 255] } };
		expect(read({ catalog, material: material([initial, painted]) })).toEqual(expected);
		expect(read({ catalog, material: material([painted], [paint, paint], paint) })).toEqual(expected);
		expect(
			read({
				catalog,
				material: material(
					[initial],
					Array.from({ length: 64 }, () => paint),
					null
				),
			})
		).toEqual(expected);
		// Operations are never interpreted: an operation the capture would reject produces no state.
		expect(read({ catalog, material: material([initial], [{ action: "unknown" }], { action: "x" }) })).toEqual(
			expected
		);
	});

	it("refuses a foreign catalog, a mutated carrier and any base that is not this composition's own state", () => {
		const application = createV3CanvasApplication(10, 10);
		const descriptor = createV3CanvasDescriptor(10, 10);
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Canvas resource bound reader unavailable");
		const input = {
			catalog: catalogInput(application.catalog),
			material: material([descriptor.canonicalStateBytes(descriptor.initialState)]),
		};
		const otherSize = createV3CanvasDescriptor(2, 2);
		expectBindingRefusals(read, input, otherSize.canonicalStateBytes(otherSize.initialState));
		// A public carrier mutated after composition does not move the bound.
		const before = read(input);
		const first = application.canonicalBlueprintPackageBytes[0] ?? 0;
		try {
			application.canonicalBlueprintPackageBytes[0] = first ^ 1;
			expect(read(input)).toEqual(before);
		} finally {
			application.canonicalBlueprintPackageBytes[0] = first;
		}
	});
});

// ---------------------------------------------------------------------------------------

const AUTHORS = ["a".repeat(64), "b".repeat(64)] as const;
const CHAT_OBJECT = "creator:0123456789abcdef0123456789abcdef";

function chatCatalog(): TrustedBlueprintCatalog {
	const bytes = (value: string) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
	return openTrustedBlueprintCatalogBytes({
		catalogBytes: bytes(catalogMaterial.catalogBytes),
		assets: Object.fromEntries(
			Object.entries(catalogMaterial.assets as Record<string, string>).map(([file, value]) => [file, bytes(value)])
		),
	});
}

function chatAcl(objectId = CHAT_OBJECT, epoch = 0): Uint8Array {
	return encodeCanonical({
		epoch,
		kind: "drp-v3-latched-acl",
		members: [
			{ author: AUTHORS[0], finalityKey: AUTHORS[0], groups: ["admin", "finality", "writer"] },
			{ author: AUTHORS[1], finalityKey: null, groups: ["writer"] },
		],
		objectId,
		permissionless: false,
		version: 3,
	});
}

async function shippingChat() {
	const catalog = chatCatalog();
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined) throw new TypeError("genuine Chat catalog entry unavailable");
	const application = await createShippingV3ChatApplication({
		catalog,
		blueprintDigest,
		exactCanonicalGenesisLatchedAclBytes: chatAcl(),
	});
	return { application, genesis: createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: chatAcl() }) };
}

/** Fills each Writer's allocation with messages until the capture refuses the next one. */
function fullChatStates(genesis: Uint8Array, text: string): Uint8Array[] {
	const start = restoreShippingChatCapacityState(genesis);
	const out: Uint8Array[] = [];
	let messages = [...start.messages];
	for (const author of AUTHORS)
		for (let index = 0; ; index++) {
			const candidate = [
				...messages,
				{ author, clientOperationId: `m-${String(index).padStart(6, "0")}`, displayTimeMs: 1_791_662_400_000, text },
			];
			try {
				out.push(shippingChatCapacityStateBytes({ ...start, messages: candidate }));
			} catch {
				break;
			}
			messages = candidate;
		}
	return out;
}

describe("Chat ordinary resource bound", () => {
	it("is supplied by the shipped composition with an incremental projection of the same theorem", async () => {
		const { application, genesis } = await shippingChat();
		const read = application.readOrdinaryApplicationResourceBound;
		expect(typeof read).toBe("function");
		if (read === undefined) return;
		const canvas = createV3CanvasDescriptor(2, 2);
		const input = { catalog: catalogInput(application.catalog), material: material([genesis]) };
		// No projection until the room has built this composition's own admission policy.
		const { candidateOperation: _candidate, ...withoutCandidate } = input.material;
		expect(createProjectionOf(read)({ catalog: input.catalog, material: withoutCandidate })).toBeUndefined();
		installChatPolicy(application, chatAcl());
		expectSameTheoremProjection(read, input, canvas.canonicalStateBytes(canvas.initialState));
	});

	it("offers its incremental projection only once the room built the composition's own admission policy", async () => {
		for (const format of ["lifetime", "window", "shares"] as const) {
			const catalog = SHIPPING_CHAT_CATALOGS[format];
			const application = await createShippingV3ChatApplication({
				catalog: catalog.catalog,
				blueprintDigest: catalog.blueprintDigest,
				exactCanonicalGenesisLatchedAclBytes: chatAcl(),
			});
			const read = application.readOrdinaryApplicationResourceBound!;
			const genesis = application.createGenesisApplicationStateBytes({
				objectId: CHAT_OBJECT,
				exactCanonicalLatchedAclBytes: chatAcl(),
			});
			const input = { catalog: catalogInput(application.catalog), material: projectionMaterial([genesis]) };
			// The complete reader keeps Track Q's value; only the incremental theorem waits for the policy.
			expect(read({ ...input, material: { ...input.material, candidateOperation: null } })).toBeDefined();
			expect(createProjectionOf(read)(input), format).toBeUndefined();
			// A policy built from another composition's factory does not enable this one.
			const other = await createShippingV3ChatApplication({
				catalog: catalog.catalog,
				blueprintDigest: catalog.blueprintDigest,
				exactCanonicalGenesisLatchedAclBytes: chatAcl(),
			});
			installChatPolicy(other, chatAcl());
			expect(createProjectionOf(read)(input), format).toBeUndefined();
			expect(createProjectionOf(other.readOrdinaryApplicationResourceBound!)(input), format).toBeDefined();
			installChatPolicy(application, chatAcl());
			expect(createProjectionOf(read)(input), format).toBeDefined();
		}
	});

	it("equals the ceiling the Chat capture enforces on every state, and dominates every state it accepts", async () => {
		const { application, genesis } = await shippingChat();
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Chat resource bound reader unavailable");
		const bound = read(roomInput({ catalog: catalogInput(application.catalog), material: material([genesis]) }));
		expect(bound).toEqual({ byteLength: SHIPPING_CHAT_RETAINED_BYTES, items: 16_384, maxDepth: 16 });
		expect(Object.keys(bound ?? {})).toEqual(["byteLength", "items", "maxDepth"]);
		expect(Object.isFrozen(bound)).toBe(true);
		const states = [...fullChatStates(genesis, "x"), ...fullChatStates(genesis, "y".repeat(900))];
		expect(states.length).toBeGreaterThan(100);
		for (const bytes of [genesis, ...states]) expect(fitsUnder(bytes, bound!)).toBe(true);
		// The ceiling is the capture's own: a state over it is refused, so no accepted state exceeds it.
		const start = restoreShippingChatCapacityState(genesis);
		const over = {
			...start,
			messages: [
				{
					author: AUTHORS[0],
					clientOperationId: "over",
					displayTimeMs: 1,
					text: "z".repeat(SHIPPING_CHAT_RETAINED_BYTES),
				},
			],
		};
		expect(() => captureShippingChatCapacityState(over)).toThrow();
	});

	it("depends only on the composition, never on the operations or the candidate", async () => {
		const { application, genesis } = await shippingChat();
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Chat resource bound reader unavailable");
		const catalog = catalogInput(application.catalog);
		const expected = read({ catalog, material: material([genesis]) });
		const message = { action: "message", clientOperationId: "m-1", displayTimeMs: 1, text: "hello" };
		const full = fullChatStates(genesis, "w".repeat(400)).at(-1)!;
		expect(read({ catalog, material: material([genesis, full], [message], message) })).toEqual(expected);
		expect(
			read({
				catalog,
				material: material(
					[full],
					Array.from({ length: 64 }, () => message),
					null
				),
			})
		).toEqual(expected);
		expect(read({ catalog, material: material([genesis], [{ action: "unknown" }], { action: "x" }) })).toEqual(
			expected
		);
	});

	it("refuses a foreign catalog, a mutated carrier and any base that is not a Chat state", async () => {
		const { application, genesis } = await shippingChat();
		const read = application.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Chat resource bound reader unavailable");
		const input = { catalog: catalogInput(application.catalog), material: material([genesis]) };
		const canvas = createV3CanvasDescriptor(2, 2);
		expectBindingRefusals(read, input, canvas.canonicalStateBytes(canvas.initialState));
		const canvasCatalog = catalogInput(createV3CanvasApplication(2, 2).catalog);
		expect(read({ ...input, catalog: canvasCatalog })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------------------
// Helpers for the Chat projection's admission-policy dependency.

const SHIPPING_CHAT_CATALOGS = openShippingChatCatalogs();

type Projection = Readonly<{
	advance(operations: readonly unknown[]): boolean;
	quote(candidateOperation: unknown): CanonicalResourceFootprint | undefined;
	quoteWithoutApplicationCandidate(): CanonicalResourceFootprint | undefined;
}>;

function createProjectionOf(read: Reader): (input: unknown) => Projection | undefined {
	const create = Object.getOwnPropertyDescriptor(read, "createIncrementalProjection")?.value as
		| ((input: unknown) => Projection | undefined)
		| undefined;
	if (create === undefined) throw new TypeError("incremental projection unavailable");
	return create;
}

function projectionMaterial(bases: readonly Uint8Array[]) {
	return {
		exactCanonicalBaseStateBytes: [...bases],
		currentOperations: [],
		protectedOperations: [],
		recoveryOperations: [],
	};
}

function hexOf(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The admission policy the room builds from the composition's own factory (epoch 0, genesis). */
function installChatPolicy(application: ShippingChatApplication, acl: Uint8Array) {
	return application.createOperationAdmissionPolicy({
		aclDigest: hexOf(hashDomain("ts-drp/latched-acl/v3", acl)),
		anchorDigest: "0".repeat(64),
		epoch: 0,
		objectId: CHAT_OBJECT,
		exactCanonicalLatchedAclBytes: acl,
	});
}
