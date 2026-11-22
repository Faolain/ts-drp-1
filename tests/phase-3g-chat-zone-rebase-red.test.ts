import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { createV3ZoneApplication } from "../examples/grid/src/v3-zone.js";
import type { V3RoomAcceptedOperation, V3RoomAuthenticatedProjectionBase } from "../examples/v3-room/src/index.js";
import type { TrustedBlueprintCatalog } from "../packages/blueprint-catalog/src/index.js";

const chatProbe = vi.hoisted(() => ({ issues: [] as Readonly<Record<string, unknown>>[] }));

vi.mock("../examples/v3-room/src/index.js", async (importOriginal) => ({
	...(await importOriginal()),
	createV3RoomSession: (input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> => {
		const application = Reflect.get(input, "application");
		if (typeof application !== "object" || application === null) throw new TypeError("missing chat application");
		return Promise.resolve(
			Object.freeze({
				// A genesis room has no successor authority yet (the v3-chat rollover policy reads it).
				authority: () => null,
				close: () => Promise.resolve(),
				invite: "phase3g-controlled-invite",
				issue: (operation: Readonly<Record<string, unknown>>) => {
					chatProbe.issues.push(operation);
					return Promise.resolve();
				},
				openEphemeral: () => {
					throw new TypeError("controlled chat has no ephemeral channel");
				},
				previewLatchedAcl: () => Object.freeze({}),
				projection: () => Object.freeze({ accepted: [], transportPeerAuthors: [], writerAuthors: [] }),
				roomId: "phase3g-controlled-room",
				trustStatus: "Creator-trusted; not Byzantine-fault-tolerant.",
			})
		);
	},
}));

beforeEach(() => {
	chatProbe.issues = [];
});

describe("Grid placement-only resource growth", () => {
	it("quoteWindow bounds aggregate UTF-8 placements and batch actions across the 127/128 ARRAY header", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator";
		for (const version of ["current", "predecessor"] as const) {
			const kernel = createZoneStateKernel(creator, peer, version);
			const roster = {action: "installRoster", roster: {entries: [{author: creator, peerId: peer, order: 0}]}};
			let base = kernel.apply(kernel.emptyState(), roster, creator).state;
			for (let index = 0; index < 127; index++) base = kernel.apply(base,
				{action: "placeBlock", id: `base-${index.toString().padStart(3, "0")}`, kind: "stone", x: index, y: -index}, creator).state;
			const seed = {exactCanonicalBaseStateBytes: [encodeCanonical(base)], currentOperations: [],
				protectedOperations: [{action: "placeBlock", id: "base-000", kind: "protected".repeat(40), x: 0, y: 0}], recoveryOperations: []};
			const projection = kernel.createPlacementGrowthProjection(seed)!;
			const operations = [{action: "placeBlock", id: "新-\uFEFF", kind: "🧱".repeat(64), x: Number.MAX_SAFE_INTEGER, y: -Number.MAX_SAFE_INTEGER},
				{action: "placeBlock", id: "base-000", kind: "覆".repeat(80), x: -128, y: 128}];
			const batch = {action: "applicationBatch", batch: {version: 1, entries: operations.map((operation, index) => ({logicalTime: 127 + index, operation}))}};
			const budget = encodeCanonical(batch).byteLength;
			const before = projection.quoteWithoutApplicationCandidate()!;
			const window = projection.quoteWindow!({maxAdditionalActions: operations.length, maxAdditionalOperationBytes: budget})!;
			// One complete aggregate encoding budget, not that budget per action
			// or separate copies for possible blocks and possible roster growth.
			expect(window.byteLength).toBe(before.byteLength + budget + 1);
			for (const future of [[batch], operations, [...operations].reverse(), []]) {
				let actual = base;
				for (const operation of future) actual = kernel.apply(actual, operation, creator).state;
				const bytes = encodeCanonical(actual);
				expect(bytes.byteLength).toBeLessThanOrEqual(window.byteLength);
				expect(decodeCanonical(bytes, {maxBytes: window.byteLength, maxItems: window.items, maxDepth: window.maxDepth})).toEqual(actual);
			}
			expect(projection.quoteWithoutApplicationCandidate()).toEqual(before);
			expect(projection.quoteWindow!({maxAdditionalActions: 0, maxAdditionalOperationBytes: budget}))
				.toEqual({byteLength: before.byteLength, items: before.items, maxDepth: before.maxDepth});
		}
	});

	it("quoteWindow covers roster members independently of the action count and retains complete protected material", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator";
		for (const version of ["current", "predecessor"] as const) {
			const kernel = createZoneStateKernel(creator, peer, version), base = kernel.emptyState();
			const roster = {action: "installRoster", roster: {entries: Array.from({length: 128}, (_, order) => ({
				author: order === 0 ? creator : order.toString(16).padStart(64, "0"),
				peerId: order === 0 ? peer : `成员-${order}-🧱`, order: order === 127 ? Number.MAX_SAFE_INTEGER : order}))}};
			const protectedPlacement = {action: "placeBlock", id: "protected", kind: "widest".repeat(30), x: 0, y: 0};
			const projection = kernel.createPlacementGrowthProjection({exactCanonicalBaseStateBytes: [encodeCanonical(base)],
				currentOperations: [], protectedOperations: [protectedPlacement], recoveryOperations: [{action: "causalJoin"}]})!;
			const join = {action: "causalJoin"}, budget = encodeCanonical(roster).byteLength + encodeCanonical(join).byteLength;
			const window = projection.quoteWindow!({maxAdditionalActions: 2, maxAdditionalOperationBytes: budget})!;
			const actual = kernel.apply(kernel.apply(base, roster, creator).state, protectedPlacement, creator).state;
			expect(actual.roster).toHaveLength(128);
			const bytes = encodeCanonical(actual);
			expect(bytes.byteLength).toBeLessThanOrEqual(window.byteLength);
			expect(decodeCanonical(bytes, {maxBytes: window.byteLength, maxItems: window.items, maxDepth: window.maxDepth})).toEqual(actual);
		}
	});

	it("quoteWindow rejects malformed/accessor/prototype/overflow declarations without effects or retained aliases", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const kernel = createZoneStateKernel("a".repeat(64), "peer:creator");
		const projection = kernel.createPlacementGrowthProjection({exactCanonicalBaseStateBytes: [encodeCanonical(kernel.emptyState())],
			currentOperations: [], protectedOperations: [], recoveryOperations: []})!;
		const declaration = {maxAdditionalActions: 2, maxAdditionalOperationBytes: 1024};
		const before = projection.quoteWithoutApplicationCandidate(), expected = projection.quoteWindow!(declaration);
		let getterCalls = 0;
		const accessor = Object.defineProperty({...declaration}, "maxAdditionalActions", {get() {getterCalls++; return 2;}});
		for (const invalid of [null, [], {}, {...declaration, extra: 1}, {...declaration, maxAdditionalActions: -1},
			{...declaration, maxAdditionalActions: 1.5}, {...declaration, maxAdditionalActions: NaN},
			{...declaration, maxAdditionalOperationBytes: Infinity}, {...declaration, maxAdditionalOperationBytes: -1},
			{maxAdditionalActions: Number.MAX_SAFE_INTEGER, maxAdditionalOperationBytes: Number.MAX_SAFE_INTEGER}, accessor,
			Object.assign(Object.create({inherited: true}), declaration),
			Object.defineProperty({...declaration}, "maxAdditionalOperationBytes", {enumerable: false, value: 1024})])
			expect(Reflect.apply(projection.quoteWindow!, projection, [invalid])).toBeUndefined();
		expect(getterCalls).toBe(0);
		declaration.maxAdditionalOperationBytes = 1;
		expect(projection.quoteWithoutApplicationCandidate()).toEqual(before);
		expect(projection.quoteWindow!({maxAdditionalActions: 2, maxAdditionalOperationBytes: 1024})).toEqual(expected);
		expect(projection.quoteWindow!({maxAdditionalActions: 2, maxAdditionalOperationBytes: 0}))
			.toEqual(before === undefined ? undefined : {byteLength: before.byteLength, items: before.items, maxDepth: before.maxDepth});
		const accepted = {action: "placeBlock", id: "accepted", kind: "stone", x: 1, y: 2};
		expect(projection.advance([accepted])).toBe(true);
		expect(projection.quoteWindow!({maxAdditionalActions: 2, maxAdditionalOperationBytes: 1024})!.byteLength)
			.toBeGreaterThan(expected!.byteLength);
	});

	it("incremental accepted deltas equal the complete theorem while quotes retain no rejected candidates", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		for (const version of ["current", "predecessor"] as const) {
			const creator = "a".repeat(64), peer = "peer:creator", kernel = createZoneStateKernel(creator, peer, version);
			const roster = {action: "installRoster", roster: {entries: Array.from({length: 64}, (_, order) => ({
				author: order === 0 ? creator : order.toString(16).padStart(64, "0"), peerId: order === 0 ? peer : `peer:${order}`, order}))}};
			const seed = {exactCanonicalBaseStateBytes: [encodeCanonical(kernel.emptyState())], currentOperations: [roster],
				protectedOperations: [{action: "placeBlock", id: "protected", kind: "wide".repeat(40), x: 1, y: 2}],
				recoveryOperations: [{action: "placeBlock", id: "recovery", kind: "stone", x: -1, y: 1}]};
			const projection = kernel.createPlacementGrowthProjection(seed);
			if (projection === undefined) throw new TypeError("incremental projection unavailable");
			const accepted: unknown[] = [], join = {action: "causalJoin"};
			const baseline = projection.quote(join);
			for (let index = 0; index < 64; index++) {
				const candidate = {action: "placeBlock", id: `rejected-${index}`, kind: "wide".repeat(index + 1), x: index, y: -index};
				expect(projection.quote(candidate)).toEqual(kernel.readPlacementGrowthBound({...seed, candidateOperation: candidate}));
				expect(projection.quote(join)).toEqual(baseline);
			}
			for (const operation of [
				{action: "placeBlock", id: "accepted", kind: "long".repeat(32), x: 3, y: 4},
				{action: "placeBlock", id: "accepted", kind: "x", x: 5, y: 6},
				{action: "applicationBatch", batch: {version: 1, entries: [
					{logicalTime: 7, operation: {action: "placeBlock", id: "protected", kind: "short", x: 1, y: 2}},
					{logicalTime: 8, operation: {action: "placeBlock", id: "batch", kind: "\uFEFFstone", x: Number.MAX_SAFE_INTEGER, y: -1}},
				]}}, join,
			]) {
				expect(projection.advance([operation])).toBe(true); accepted.push(operation);
				for (const candidate of [join, {action: "placeBlock", id: "accepted", kind: "wider".repeat(64), x: 0, y: 0}])
					expect(projection.quote(candidate)).toEqual(kernel.readPlacementGrowthBound({...seed,
						currentOperations: [...seed.currentOperations, ...accepted], candidateOperation: candidate}));
			}
			const before = projection.quote(join);
			expect(projection.advance([{action: "placeBlock", id: "must-not-retain", kind: "stone", x: 0, y: 0},
				{action: "unsupported"}])).toBe(false);
			expect(projection.quote({action: "unsupported"})).toBeUndefined();
			expect(projection.quote(join)).toEqual(before);
		}
	});

	it("bounds retained projection items and detaches seed/delta material", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const kernel = createZoneStateKernel("a".repeat(64), "peer:creator"), join = {action: "causalJoin"};
		const operation = {action: "placeBlock", id: "retained", kind: "stone", x: 1, y: 2};
		const seed = {exactCanonicalBaseStateBytes: [encodeCanonical(kernel.emptyState())], currentOperations: [],
			protectedOperations: [operation], recoveryOperations: []};
		const projection = kernel.createPlacementGrowthProjection(seed);
		if (projection === undefined) throw new TypeError("incremental projection unavailable");
		const before = projection.quote(join); operation.kind = "mutated".repeat(100); seed.exactCanonicalBaseStateBytes[0]!.fill(255);
		expect(projection.quote(join)).toEqual(before);
		const delta = {action: "placeBlock", id: "delta", kind: "wood", x: 1, y: 2};
		expect(projection.advance([delta])).toBe(true); const after = projection.quote(join); delta.id = "changed";
		expect(projection.quote(join)).toEqual(after);
		const tooMany = Array.from({length: 2048}, (_, index) => ({action: "placeBlock", id: `wide-${index}`, kind: "stone", x: 0, y: 0}));
		expect(projection.advance(tooMany)).toBe(false); expect(projection.quote(join)).toEqual(after);
	});

	it("bounds 64 writers and widest base/current/protected/recovery/candidate rows across lawful headers", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator", kernel = createZoneStateKernel(creator, peer);
		const roster = Array.from({length: 64}, (_, order) => ({author: order === 0 ? creator : order.toString(16).padStart(64, "0"),
			peerId: order === 0 ? peer : `peer:writer-${order}`, order}));
		const blocks = Array.from({length: 64}, (_, index) => ({id: `base-${index.toString().padStart(2, "0")}`,
			kind: index === 0 ? "s\uFEFF" + "s".repeat(35_000) : "stone", x: index, y: -(index + 1)}));
		// Schema-only retained outcome material; no signature/authentication claim.
		const outcome = {action: "commit-outcome-v1", proof: {action: "commit-outcome-v1", clientOperationId: "retained-outcome",
			exactCanonicalIntentBytes: new Uint8Array([1, 2]), exactCanonicalPayloadBytes: new Uint8Array([239, 187, 191, 3]),
			approvals: [{signer: "1".repeat(64), signature: new Uint8Array(64)}, {signer: "2".repeat(64), signature: new Uint8Array(64)}]}};
		const base = kernel.captureState({version: 2, creatorAuthor: creator, creatorPeerId: peer, blocks, outcomes: [outcome], roster});
		const historical = kernel.captureState({...base, roster: [roster[0]], outcomes: []});
		const current = {action: "placeBlock", id: "current", kind: "wood", x: 3, y: 4};
		const protectedPlacement = {action: "placeBlock", id: "base-00", kind: "short", x: 5, y: 6};
		const recovery = {action: "placeBlock", id: "recovery", kind: "\uFEFFwood", x: Number.MAX_SAFE_INTEGER, y: -Number.MAX_SAFE_INTEGER};
		const candidate = {action: "placeBlock", id: "candidate", kind: "stone", x: 7, y: 8};
		const material = {exactCanonicalBaseStateBytes: [encodeCanonical(base), encodeCanonical(historical)],
			currentOperations: [current], protectedOperations: [protectedPlacement], recoveryOperations: [recovery],
			candidateOperation: {action: "applicationBatch", batch: {version: 1, entries: [
				{logicalTime: 9, operation: protectedPlacement}, {logicalTime: 11, operation: candidate}]}}};
		const bound = kernel.readPlacementGrowthBound(material);
		if (bound === undefined) throw new TypeError("placement resource bound unavailable");
		expect(bound.blockCount).toBe(67);
		expect(bound.byteLength).toBeGreaterThan(32_768);
		const original = material.exactCanonicalBaseStateBytes.map(bytes => bytes.slice());
		for (const selectedBase of [base, historical]) {
			for (const operations of [[current, protectedPlacement, recovery, candidate], [candidate, recovery, protectedPlacement, current],
				[current, recovery], [protectedPlacement], []]) {
				let state = selectedBase;
				for (const operation of operations) state = kernel.apply(state, operation, creator).state;
				const bytes = encodeCanonical(state);
				expect(bytes.byteLength).toBeLessThanOrEqual(bound.byteLength);
				expect(decodeCanonical(bytes, {maxBytes: bound.byteLength, maxItems: bound.items, maxDepth: bound.maxDepth})).toEqual(state);
			}
		}
		// Attain the maxima via original reducers, retaining the widest BASE version last.
		let widest = base;
		for (const operation of [current, recovery, candidate, {action: "placeBlock", ...blocks[0]}])
			widest = kernel.apply(widest, operation, creator).state;
		const exact = encodeCanonical(widest);
		expect(exact.byteLength).toBe(bound.byteLength);
		expect(() => decodeCanonical(exact, {maxItems: bound.items - 1})).toThrow();
		expect(() => decodeCanonical(exact, {maxDepth: bound.maxDepth - 1})).toThrow();
		expect(widest.roster).toHaveLength(64);
		expect(widest.outcomes).toEqual(base.outcomes);
		expect(material.exactCanonicalBaseStateBytes).toEqual(original);
	});

	it("preserves order-sensitive overwrites while bounding repeated identities in current and predecessor kernels", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator";
		for (const version of ["current", "predecessor"] as const) {
			const kernel = createZoneStateKernel(creator, peer, version);
			const base = kernel.apply(kernel.emptyState(), {action: "installRoster", roster: {entries: [{author: creator, peerId: peer, order: 0}]}}, creator).state;
			const first = {action: "placeBlock", id: "stable", kind: "longer-kind", x: 1, y: 2};
			const second = {action: "placeBlock", id: "stable", kind: "x", x: 3, y: 4};
			const bound = kernel.readPlacementGrowthBound({exactCanonicalBaseStateBytes: [encodeCanonical(base)],
				currentOperations: [first, second, first], protectedOperations: [], recoveryOperations: [], candidateOperation: second});
			if (bound === undefined) throw new TypeError("placement resource bound unavailable");
			expect(bound.blockCount).toBe(1);
			const forward = kernel.apply(kernel.apply(base, first, creator).state, second, creator).state;
			const reverse = kernel.apply(kernel.apply(base, second, creator).state, first, creator).state;
			expect(forward.blocks).not.toEqual(reverse.blocks);
			expect(encodeCanonical(reverse).byteLength).toBe(bound.byteLength);
			expect(encodeCanonical(forward).byteLength).toBeLessThan(bound.byteLength);
		}
	});

	it("bounds the original genesis roster bootstrap and causalJoin no-ops in both kernels", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator";
		const entries = Array.from({length: 64}, (_, order) => ({author: order === 0 ? creator : order.toString(16).padStart(64, "0"),
			peerId: order === 0 ? peer : `peer:writer-${order}`, order}));
		const bootstrap = {action: "installRoster", roster: {entries}}, join = {action: "causalJoin"};
		const placement = {action: "placeBlock", id: "bootstrap-block", kind: "stone", x: 1, y: 2};
		for (const version of ["current", "predecessor"] as const) {
			const kernel = createZoneStateKernel(creator, peer, version), base = kernel.emptyState();
			const material = {exactCanonicalBaseStateBytes: [encodeCanonical(base)], currentOperations: [bootstrap, join, placement],
				protectedOperations: [join], recoveryOperations: [], candidateOperation: join};
			const bound = kernel.readPlacementGrowthBound(material);
			if (bound === undefined) throw new TypeError("bootstrap resource bound unavailable");
			let state = base;
			for (const operation of [bootstrap, join, placement, join]) state = kernel.apply(state, operation, creator).state;
			const exact = encodeCanonical(state);
			expect(exact.byteLength).toBe(bound.byteLength);
			expect(bound.blockCount).toBe(1);
			expect(state.roster).toHaveLength(64);
			expect(decodeCanonical(exact, {maxItems: bound.items, maxDepth: bound.maxDepth})).toEqual(state);
			expect(() => decodeCanonical(exact, {maxItems: bound.items - 1})).toThrow();
			const initial = kernel.readPlacementGrowthBound({...material, currentOperations: [], protectedOperations: [], candidateOperation: bootstrap});
			if (initial === undefined) throw new TypeError("candidate roster resource bound unavailable");
			expect(initial.byteLength).toBe(encodeCanonical(kernel.apply(base, bootstrap, creator).state).byteLength);
		}
	});

	it("bounds genuine recipient roster no-ops without relaxing creator capture or retaining quoted inputs", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), recipient = "b".repeat(64), peer = "peer:creator", recipientPeer = "peer:recipient";
		const creatorRoster = {action: "installRoster", roster: {entries: [
			{author: creator, peerId: peer, order: 0}, {author: recipient, peerId: recipientPeer, order: 1},
		]}};
		// EXACT actual Grid join construction: a recipient declares only its own
		// member at order1. The original artifact ignores it BEFORE roster checks.
		for (const version of ["current", "predecessor"] as const) {
			const kernel = createZoneStateKernel(creator, peer, version), empty = kernel.emptyState();
			const foreign = {action: "installRoster", roster: {entries: [{author: recipient, peerId: recipientPeer, order: 1}]}};
			const installed = kernel.apply(empty, creatorRoster, creator).state;
			expect(kernel.apply(installed, foreign, recipient).state).toEqual(installed);
			expect(() => kernel.apply(installed, foreign, creator)).toThrow();
			expect(() => kernel.captureState({...installed, roster: foreign.roster.entries})).toThrow();
			const seed = {exactCanonicalBaseStateBytes: [encodeCanonical(empty)], currentOperations: [creatorRoster, foreign],
				protectedOperations: [foreign], recoveryOperations: [foreign]};
			const placement = {action: "placeBlock", id: "recipient-bootstrap", kind: "stone", x: 7, y: 11};
			const projection = kernel.createPlacementGrowthProjection(seed);
			if (projection === undefined) throw new TypeError("recipient bootstrap resource projection unavailable");
			const compare = () => {
				const bound = projection.quote(placement), complete = kernel.readPlacementGrowthBound({...seed, candidateOperation: placement});
				expect(bound).toEqual(complete);
				if (bound === undefined) throw new TypeError("recipient bootstrap resource quote unavailable");
				const exact = encodeCanonical(kernel.apply(installed, placement, creator).state);
				expect(bound.byteLength).toBe(exact.byteLength);
				expect(decodeCanonical(exact, {maxItems: bound.items, maxDepth: bound.maxDepth}))
					.toEqual(kernel.apply(installed, placement, creator).state);
				return bound;
			};
			compare(); expect(projection.advance([foreign])).toBe(true); compare();
			const before = projection.quote(placement);
			expect(projection.quote({...placement, x: 1.5})).toBeUndefined();
			expect(projection.quote(placement)).toEqual(before);
			expect(projection.advance([placement])).toBe(true);
			const after = projection.quote(placement);
			// Projection holds resource numbers, not aliases of the supplied roster.
			foreign.roster.entries[0]!.order = -1;
			expect(projection.quote(placement)).toEqual(after);
			expect(kernel.readPlacementGrowthBound({...seed, candidateOperation: placement})).toBeUndefined();
			const wrongCreator = {action: "installRoster", roster: {entries: [{author: recipient, peerId: recipientPeer, order: 0}]}};
			// Structural declaration sizing is NOT a creator validity verdict.
			expect(kernel.readPlacementGrowthBound({...seed, currentOperations: [creatorRoster], protectedOperations: [], recoveryOperations: [],
				candidateOperation: wrongCreator})).toBeDefined();
			expect(() => kernel.apply(installed, wrongCreator, creator)).toThrow();
			expect(() => kernel.captureState({...installed, roster: wrongCreator.roster.entries})).toThrow();
		}
	});

	it("returns unavailable for incomplete material, unsupported actions and malformed original schemas", async () => {
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator", kernel = createZoneStateKernel(creator, peer);
		const base = kernel.apply(kernel.emptyState(), {action: "installRoster", roster: {entries: [{author: creator, peerId: peer, order: 0}]}}, creator).state;
		const placement = {action: "placeBlock", id: "stable", kind: "stone", x: 1, y: 2};
		const material = {exactCanonicalBaseStateBytes: [encodeCanonical(base)], currentOperations: [], protectedOperations: [],
			recoveryOperations: [], candidateOperation: placement};
		expect(kernel.readPlacementGrowthBound(material)).toBeDefined();
		const missing = {...material} as Partial<typeof material>;
		delete missing.recoveryOperations;
		for (const unsupported of [missing, {...material, protectedOperations: undefined}, {...material, currentOperations: new Array(1)},
			{...material, exactCanonicalBaseStateBytes: []}, {...material, exactCanonicalBaseStateBytes: [encodeCanonical({...base, creatorAuthor: "b".repeat(64)})]},
			{...material, exactCanonicalBaseStateBytes: [encodeCanonical({...base, blocks: [{id: "bom-base", kind: "\uFEFFstone", x: 1, y: 2}]})]},
			{...material, recoveryOperations: [{action: "installRoster", roster: {entries: []}}]},
			{...material, candidateOperation: {action: "installRoster", roster: {entries: [base.roster[0], base.roster[0]]}}},
			{...material, candidateOperation: {action: "installRoster", roster: {entries: base.roster, extra: true}}},
			{...material, candidateOperation: {action: "causalJoin", extra: true}},
			{...material, candidateOperation: {action: "$drp.author-fence.v1"}},
			{...material, candidateOperation: {...placement, x: 1.5}}, {...material, candidateOperation: {...placement, extra: true}},
			{...material, candidateOperation: {...placement, kind: "\uD800"}},
			{...material, candidateOperation: {action: "applicationBatch", batch: {version: 1, entries: [
				{logicalTime: 2, operation: placement}, {logicalTime: 2, operation: placement}]}}},
			{...material, candidateOperation: {action: "applicationBatch", batch: {version: 1, entries: [
				{logicalTime: 2, operation: placement}, {logicalTime: 4, operation: {action: "commit-outcome-v1", proof: {}}}]}}}])
			expect(Reflect.apply(kernel.readPlacementGrowthBound, kernel, [unsupported])).toBeUndefined();
		let getterCalls = 0;
		const getter = Object.defineProperty({...placement}, "x", {enumerable: true, get() {getterCalls++; return 1;}});
		expect(kernel.readPlacementGrowthBound({...material, candidateOperation: getter})).toBeUndefined();
		expect(getterCalls).toBe(0);
	});
});

describe("Grid ordinary resource callback catalog binding", () => {
	it("quoteWindow adapter returns only resource scalars for its exact resolved catalog without retaining public carrier aliases", async () => {
		const {createV3ZoneApplication} = await import("../examples/grid/src/v3-zone.js");
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator";
		const app = createV3ZoneApplication([{author: creator, peerId: peer, order: 0}], peer, creator);
		const blueprintDigest = app.catalog.blueprintDigests[0];
		if (blueprintDigest === undefined) throw new TypeError("genuine catalog entry unavailable");
		const resolved = app.catalog.resolve(blueprintDigest);
		const catalog = {blueprintDigest: resolved.blueprintDigest, artifactId: resolved.artifactId, artifactDigest: resolved.artifactDigest,
			catalogDigest: resolved.evidence.catalogDigest, runtimeProfile: resolved.runtimeProfile,
			exactArtifactBytes: resolved.exactArtifactBytes.slice(), canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice()};
		const kernel = createZoneStateKernel(creator, peer);
		const material = {exactCanonicalBaseStateBytes: [encodeCanonical(kernel.emptyState())],
			currentOperations: [app.bootstrapOperation], protectedOperations: [], recoveryOperations: [],
			candidateOperation: {action: "placeBlock", id: "first", kind: "stone", x: 1, y: 2}};
		const expected = kernel.readPlacementGrowthBound(material), read = app.readOrdinaryApplicationResourceBound;
		if (expected === undefined || read === undefined) throw new TypeError("Grid resource callback unavailable");
		const result = read({catalog, material});
		expect(result).toEqual({byteLength: expected.byteLength, items: expected.items, maxDepth: expected.maxDepth});
		expect(Object.keys(result!)).toEqual(["byteLength", "items", "maxDepth"]);
		const {candidateOperation: _candidate, ...seed} = material;
		const projection = read.createIncrementalProjection?.({catalog, material: seed});
		const expectedWindow = kernel.createPlacementGrowthProjection(seed)!.quoteWindow!({maxAdditionalActions: 16, maxAdditionalOperationBytes: 2048});
		expect(projection?.quoteWindow?.({maxAdditionalActions: 16, maxAdditionalOperationBytes: 2048})).toEqual(expectedWindow);
		expect(Object.keys(expectedWindow!)).toEqual(["byteLength", "items", "maxDepth"]);
		expect(read.createIncrementalProjection?.({catalog: {...catalog, catalogDigest: "unknown"}, material: seed})).toBeUndefined();
		const publicFirst = app.canonicalBlueprintPackageBytes[0]!;
		try {
			app.canonicalBlueprintPackageBytes[0] = publicFirst ^ 1;
			resolved.exactArtifactBytes[0] = resolved.exactArtifactBytes[0]! ^ 1;
			expect(read({catalog, material})).toEqual(result);
		} finally {
			app.canonicalBlueprintPackageBytes[0] = publicFirst;
		}
	});

	it("refuses every identity mismatch, mutated exact carrier, missing field and unsupported material", async () => {
		const {createV3ZoneApplication} = await import("../examples/grid/src/v3-zone.js");
		const {createZoneStateKernel} = await import("../examples/grid/src/zone-state.js");
		const creator = "a".repeat(64), peer = "peer:creator";
		const app = createV3ZoneApplication([{author: creator, peerId: peer, order: 0}], peer, creator);
		const blueprintDigest = app.catalog.blueprintDigests[0];
		if (blueprintDigest === undefined) throw new TypeError("genuine catalog entry unavailable");
		const resolved = app.catalog.resolve(blueprintDigest);
		const catalog = {blueprintDigest: resolved.blueprintDigest, artifactId: resolved.artifactId, artifactDigest: resolved.artifactDigest,
			catalogDigest: resolved.evidence.catalogDigest, runtimeProfile: resolved.runtimeProfile,
			exactArtifactBytes: resolved.exactArtifactBytes.slice(), canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice()};
		const material = {exactCanonicalBaseStateBytes: [encodeCanonical(createZoneStateKernel(creator, peer).emptyState())],
			currentOperations: [app.bootstrapOperation], protectedOperations: [], recoveryOperations: [],
			candidateOperation: {action: "placeBlock", id: "first", kind: "stone", x: 1, y: 2}};
		const read = app.readOrdinaryApplicationResourceBound;
		if (read === undefined) throw new TypeError("Grid resource callback unavailable");
		expect(read({catalog, material})).toBeDefined();
		for (const key of ["blueprintDigest", "artifactId", "artifactDigest", "catalogDigest", "runtimeProfile"] as const)
			expect(read({catalog: {...catalog, [key]: "unknown"}, material})).toBeUndefined();
		for (const key of ["exactArtifactBytes", "canonicalBlueprintPackageBytes"] as const) {
			const changed = catalog[key].slice();
			changed[0] = changed[0]! ^ 1;
			expect(read({catalog: {...catalog, [key]: changed}, material})).toBeUndefined();
		}
		const missing = {...catalog} as Partial<typeof catalog>;
		delete missing.artifactDigest;
		expect(Reflect.apply(read, app, [{catalog: missing, material}])).toBeUndefined();
		expect(read({catalog, material: {...material, candidateOperation: {action: "unknown"}}})).toBeUndefined();
		let getterCalls = 0;
		const accessor = Object.defineProperty({...catalog}, "artifactId", {enumerable: true, get() {getterCalls++; return catalog.artifactId;}});
		expect(read({catalog: accessor, material})).toBeUndefined();
		expect(getterCalls).toBe(0);
	});
});

interface RebaseApplication {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly catalog: TrustedBlueprintCatalog;
	readonly displacementPolicies: Readonly<Record<string, "expire" | "manual-review" | "rebase" | "transform">>;
	displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string;
	projectAcceptedOperations(input: {
		readonly authenticatedBase: undefined;
		readonly currentEpochOperations: readonly unknown[];
	}): Readonly<Record<string, unknown>>;
}

function operations(application: RebaseApplication): readonly Readonly<Record<string, unknown>>[] {
	const decoded = decodeCanonical(application.canonicalBlueprintPackageBytes);
	const manifest = decoded !== null && typeof decoded === "object" ? Reflect.get(decoded, "manifest") : undefined;
	const values = manifest !== null && typeof manifest === "object" ? Reflect.get(manifest, "operations") : undefined;
	if (!Array.isArray(values)) throw new TypeError("Phase 3g product manifest is invalid");
	return values as readonly Readonly<Record<string, unknown>>[];
}

function accepted(
	operation: Readonly<Record<string, unknown>>,
	input: Readonly<{ readonly author: string; readonly sequence: number; readonly digestByte: number }>
): V3RoomAcceptedOperation {
	return Object.freeze({
		author: input.author,
		authorSequence: input.sequence,
		logicalTime: input.sequence * 2 + 1,
		operation,
		operationCount: 1,
		operationIndex: 0,
		vertexDigest: input.digestByte.toString(16).padStart(2, "0").repeat(32),
	});
}

describe("Phase 3g chat and zone stable rebase identity RED", () => {
	it("binds chat messages to author plus clientOperationId and preserves visible order", async () => {
		const module = await import("../examples/v3-chat/src/index.js");
		const application = Reflect.apply(
			Reflect.get(module, "createV3ChatApplication") as (...args: unknown[]) => unknown,
			undefined,
			["alice"]
		) as RebaseApplication;
		expect(application.displacementPolicies).toEqual({ message: "rebase" });
		const first = Object.freeze({ action: "message", clientOperationId: "message-1", text: "hello" });
		const second = Object.freeze({ action: "message", clientOperationId: "message-2", text: "world" });
		expect(application.displacedOperationIdentity(first)).toBe("message-1");
		const descriptor = operations(application).find((value) => Reflect.get(value, "name") === "message");
		expect(descriptor).toMatchObject({
			argumentSchema: {
				fields: [
					{ name: "clientOperationId", required: true, type: "string" },
					{ name: "text", required: true, type: "string" },
				],
				kind: "closed-record",
			},
		});
		const authorA = "a".repeat(64);
		const authorB = "b".repeat(64);
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(first, { author: authorA, digestByte: 1, sequence: 1 }),
				accepted(first, { author: authorA, digestByte: 2, sequence: 2 }),
				accepted(first, { author: authorB, digestByte: 3, sequence: 1 }),
				accepted(second, { author: authorA, digestByte: 4, sequence: 3 }),
			],
		});
		expect(Reflect.get(projection, "accepted")).toEqual([
			expect.objectContaining({ author: authorA, clientOperationId: "message-1", text: "hello" }),
			expect.objectContaining({ author: authorB, clientOperationId: "message-1", text: "hello" }),
			expect.objectContaining({ author: authorA, clientOperationId: "message-2", text: "world" }),
		]);
		expect(() =>
			application.projectAcceptedOperations({
				authenticatedBase: undefined,
				currentEpochOperations: [
					accepted(first, { author: authorA, digestByte: 5, sequence: 4 }),
					accepted(Object.freeze({ ...first, text: "changed" }), {
						author: authorA,
						digestByte: 6,
						sequence: 5,
					}),
				],
			})
		).toThrow();
	});

	it("mints a distinct client operation identity through each public chat send", async () => {
		await import("../examples/v3-chat/src/index.js");
		const api = Reflect.get(globalThis, "d9336V3Chat") as Readonly<{
			close(): Promise<void>;
			join(
				input: Readonly<{ channelName: string; clientId: "alice"; databaseName: string; invite: string }>
			): Promise<void>;
			send(text: string): Promise<void>;
		}>;
		await api.join({ channelName: "phase3g-chat", clientId: "alice", databaseName: "phase3g-chat", invite: "00" });
		await api.send("first public send");
		await api.send("second public send");
		expect(chatProbe.issues).toEqual([
			{
				action: "message",
				clientOperationId: expect.stringMatching(/\S+/u),
				text: "first public send",
			},
			{
				action: "message",
				clientOperationId: expect.stringMatching(/\S+/u),
				text: "second public send",
			},
		]);
		expect(Reflect.get(chatProbe.issues[0], "clientOperationId")).not.toBe(
			Reflect.get(chatProbe.issues[1], "clientOperationId")
		);
		await api.close();
	});

	it("reuses the genuine zone block id and projects one deterministic sorted board", async () => {
		const module = await import("../examples/grid/src/v3-zone.js");
		const author = "a".repeat(64);
		const application = Reflect.apply(
			Reflect.get(module, "createV3ZoneApplication") as (...args: unknown[]) => unknown,
			undefined,
			[Object.freeze([Object.freeze({ author, order: 0, peerId: "peer:creator" })]), "peer:creator", author]
		) as RebaseApplication;
		const first = Object.freeze({ action: "placeBlock", id: "block-b", kind: "stone", x: 1, y: 2 });
		const second = Object.freeze({ action: "placeBlock", id: "block-a", kind: "dirt", x: 3, y: 4 });
		expect(application.displacementPolicies).toEqual({ placeBlock: "rebase" });
		expect(application.displacedOperationIdentity(first)).toBe("block-b");
		const projection = application.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(first, { author, digestByte: 0x11, sequence: 1 }),
				accepted(first, { author, digestByte: 0x12, sequence: 2 }),
				accepted(second, { author, digestByte: 0x13, sequence: 3 }),
			],
		});
		expect(Reflect.get(projection, "blocks")).toEqual([
			{ id: second.id, kind: second.kind, x: second.x, y: second.y },
			{ id: first.id, kind: first.kind, x: first.x, y: first.y },
		]);
		expect(Reflect.get(projection, "acceptedDigests")).toEqual(["11".repeat(32), "12".repeat(32), "13".repeat(32)]);
	});
});

describe("grid authenticated successor projection semantics RED", () => {
	const creator = "a".repeat(64);
	const writer = "b".repeat(64);
	const outsider = "c".repeat(64);
	const roster = [
		{ author: creator, peerId: "peer:creator", order: 0 },
		{ author: writer, peerId: "peer:writer", order: 1 },
	];
	const blocks = [
		{ id: "block-a", kind: "dirt", x: 3, y: 4 },
		{ id: "block-b", kind: "stone", x: 1, y: 2 },
	];
	const state = { version: 2, creatorAuthor: creator, creatorPeerId: "peer:creator", blocks, outcomes: [], roster };
	const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
	// Unit boundary: the shared room authenticates these bytes and metadata before
	// calling the application. This helper proves no checkpoint, QC or signature.
	const base = (bytes: Uint8Array, epoch = 1): V3RoomAuthenticatedProjectionBase => ({
		blueprintDigest: "d".repeat(64),
		epoch,
		exactCanonicalApplicationStateBytes: bytes,
		objectId: "creator:00000000000000000000000000000001",
		stateDigest: hex(hashDomain("ts-drp/state/v3", bytes)),
	});
	const application = async (members = roster): Promise<ReturnType<typeof createV3ZoneApplication>> => {
		const { createV3ZoneApplication } = await import("../examples/grid/src/v3-zone.js");
		return createV3ZoneApplication(members, "peer:creator", creator);
	};
	const authority = {
		transportPeerAuthors: roster.map(({ author, peerId }) => ({ author, peerId })),
		writerAuthors: [creator, writer],
	};

	it("uses installRoster bootstrap and never interprets reserved join as application authority", async () => {
		const app = await application();
		expect(app.bootstrapOperation.action).toBe("installRoster");
		for (const authenticatedBase of [undefined, base(encodeCanonical(state))]) {
			const before = app.projectAcceptedOperations({ authenticatedBase, currentEpochOperations: [] });
			const after = app.projectAcceptedOperations({
				authenticatedBase,
				currentEpochOperations: [
					accepted(
						{ action: "join", roster: { entries: [{ author: outsider, peerId: "peer:forged", order: 0 }] } },
						{ author: creator, sequence: 1, digestByte: 7 }
					),
				],
			});
			if (app.migration === undefined) throw new TypeError("grid migration capability missing");
			expect(app.migration.canonicalStateBytes(after)).toEqual(app.migration.canonicalStateBytes(before));
			expect(after.writerAuthors).toEqual(before.writerAuthors);
			expect(after.transportPeerAuthors).toEqual(before.transportPeerAuthors);
		}
	});

	it("serializes creator-accepted roster authority and recovers it with no current operations", async () => {
		const app = await application();
		const projection = app.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(
					{ action: "installRoster", roster: { entries: [...roster].reverse() } },
					{ author: creator, sequence: 0, digestByte: 1 }
				),
				...blocks.map((block, index) =>
					accepted({ action: "placeBlock", ...block }, { author: writer, sequence: index + 1, digestByte: index + 2 })
				),
			],
		});
		expect(projection).toMatchObject({ ...authority, blocks });
		if (app.migration === undefined) throw new TypeError("grid migration capability missing");
		const bytes = app.migration.canonicalStateBytes(projection);
		expect(decodeCanonical(bytes)).toEqual(state);
		const restored = app.projectAcceptedOperations({ authenticatedBase: base(bytes), currentEpochOperations: [] });
		expect(restored).toMatchObject({ ...authority, blocks });
		expect(app.migration.canonicalStateBytes(restored)).toEqual(bytes);
	});

	it("roundtrips all 64 writers through authenticated successor state and a current writer operation", async () => {
		const members = Array.from({ length: 64 }, (_, order) => ({
			author: order === 0 ? creator : order.toString(16).padStart(64, "0"),
			peerId: order === 0 ? "peer:creator" : `peer:writer-${order}`,
			order,
		}));
		const board = members.map((_, index) => ({
			id: `writer-block-${index.toString().padStart(2, "0")}`,
			kind: "stone",
			x: index,
			y: -(index + 1),
		}));
		const app = await application(members);
		const projection = app.projectAcceptedOperations({
			authenticatedBase: undefined,
			currentEpochOperations: [
				accepted(
					{ action: "installRoster", roster: { entries: members } },
					{ author: creator, sequence: 0, digestByte: 1 }
				),
				...members.map((member, index) =>
					accepted(
						{ action: "placeBlock", ...board[index] },
						{ author: member.author, sequence: 1, digestByte: index + 2 }
					)
				),
			],
		});
		const expectedAuthority = {
			writerAuthors: members.map(({ author }) => author),
			transportPeerAuthors: members.map(({ author, peerId }) => ({ author, peerId })),
		};
		expect(projection).toMatchObject({ ...expectedAuthority, blocks: board });
		if (app.migration === undefined) throw new TypeError("grid migration capability missing");
		const bytes = app.migration.canonicalStateBytes(projection);
		expect(decodeCanonical(bytes)).toEqual({
			version: 2,
			creatorAuthor: creator,
			creatorPeerId: "peer:creator",
			blocks: board,
			outcomes: [],
			roster: members,
		});
		const lastMember = members[63];
		const lastBlock = board[63];
		if (lastMember === undefined || lastBlock === undefined) throw new TypeError("64-writer fixture is incomplete");
		const updated = { ...lastBlock, x: 164, y: -164 };
		const restored = app.projectAcceptedOperations({
			authenticatedBase: base(bytes),
			currentEpochOperations: [
				accepted({ action: "placeBlock", ...updated }, { author: lastMember.author, sequence: 2, digestByte: 66 }),
			],
		});
		expect(restored).toMatchObject({ ...expectedAuthority, blocks: [...board.slice(0, 63), updated] });
		expect(restored.blocks.map(({ id }) => id)).toEqual(board.map(({ id }) => id));
		expect(restored.writerAuthors).toHaveLength(64);
		expect(restored.transportPeerAuthors).toHaveLength(64);
	});

	it("updates a stable block over authenticated state and preserves authority over repeated empty successor reopens", async () => {
		const app = await application();
		if (app.migration === undefined) throw new TypeError("grid migration capability missing");
		const updated = { ...blocks[1], id: "block-b", kind: "stone", x: 99, y: -7 };
		let projection = app.projectAcceptedOperations({
			authenticatedBase: base(encodeCanonical(state)),
			currentEpochOperations: [
				accepted({ action: "placeBlock", ...updated }, { author: writer, sequence: 4, digestByte: 4 }),
			],
		});
		const expectedState = { ...state, blocks: [blocks[0], updated] };
		expect(projection).toMatchObject({ ...authority, blocks: expectedState.blocks });
		for (let epoch = 2; epoch <= 4; epoch += 1) {
			const bytes = app.migration.canonicalStateBytes(projection);
			expect(decodeCanonical(bytes)).toEqual(expectedState);
			projection = app.projectAcceptedOperations({ authenticatedBase: base(bytes, epoch), currentEpochOperations: [] });
			expect(projection).toMatchObject({ ...authority, blocks: expectedState.blocks });
			expect(app.migration.canonicalStateBytes(projection)).toEqual(bytes);
		}
	});

	it("does not seed or overwrite projection authority from constructor bootstrap members", async () => {
		const app = await application([{ author: outsider, peerId: "peer:injected", order: 0 }]);
		expect(app.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })).toMatchObject({
			transportPeerAuthors: [],
			writerAuthors: [],
			blocks: [],
		});
		expect(
			app.projectAcceptedOperations({ authenticatedBase: base(encodeCanonical(state)), currentEpochOperations: [] })
		).toMatchObject({ ...authority, blocks });
	});

	it.each([
		["wrong creator author", [{ ...roster[0], author: outsider }, roster[1]]],
		["wrong creator peer", [{ ...roster[0], peerId: "peer:wrong" }, roster[1]]],
		["missing creator", [roster[1]]],
		["duplicate entry", [...roster, roster[1]]],
		["conflicting peer author", [...roster, { author: outsider, peerId: "peer:writer", order: 2 }]],
		["conflicting order", [...roster, { author: outsider, peerId: "peer:other", order: 1 }]],
		["duplicate author", [...roster, { author: writer, peerId: "peer:other", order: 2 }]],
		["negative order", [roster[0], { ...roster[1], order: -1 }]],
		["extra member key", [roster[0], { ...roster[1], extra: true }]],
	] as const)("rejects authenticated roster %s", async (_label, invalidRoster) => {
		const app = await application();
		expect(() =>
			app.projectAcceptedOperations({
				authenticatedBase: base(encodeCanonical({ ...state, roster: invalidRoster })),
				currentEpochOperations: [],
			})
		).toThrow(/^v3 zone authenticated roster is invalid$/u);
	});

	it.each([
		["old array state", blocks],
		["old unseeded version", { ...state, version: 1 }],
		["foreign creator author", { ...state, creatorAuthor: outsider }],
		["foreign creator peer", { ...state, creatorPeerId: "peer:foreign" }],
		["extra state key", { ...state, extra: true }],
		["missing roster", { version: 1, blocks, outcomes: [] }],
		["non-array roster", { ...state, roster: {} }],
		["duplicate block identity", { ...state, blocks: [blocks[0], blocks[0]] }],
		["malformed coordinate", { ...state, blocks: [{ ...blocks[0], x: "3" }] }],
		["malformed outcome", { ...state, outcomes: [{}] }],
	] as const)("rejects malformed authenticated %s", async (_label, invalidState) => {
		const app = await application();
		expect(() =>
			app.projectAcceptedOperations({
				authenticatedBase: base(encodeCanonical(invalidState)),
				currentEpochOperations: [],
			})
		).toThrow(/^v3 zone authenticated (projection state|roster) is invalid$/u);
	});

	for (const withBase of [false, true]) {
		it.each([
			["extra key", { entries: roster, extra: "unregistered-authority" }],
			["nonobject", "not-a-roster"],
			["array", roster],
		] as const)(
			`rejects creator join roster envelope %s with authenticated base ${withBase}`,
			async (_label, envelope) => {
				const app = await application();
				expect(() =>
					app.projectAcceptedOperations({
						authenticatedBase: withBase ? base(encodeCanonical(state)) : undefined,
						currentEpochOperations: [
							accepted({ action: "installRoster", roster: envelope }, { author: creator, sequence: 6, digestByte: 6 }),
						],
					})
				).toThrow(/^v3 zone roster conflicts$/u);
			}
		);
	}

	it.each([
		["creator mismatch", [{ ...roster[0], author: outsider }, roster[1]]],
		["peer rebind", [roster[0], { ...roster[1], author: outsider }]],
		["order rebind", [roster[0], { ...roster[1], order: 0 }]],
		["duplicate member", [...roster, roster[1]]],
	] as const)("rejects current creator join %s against authenticated roster", async (_label, entries) => {
		const app = await application();
		expect(() =>
			app.projectAcceptedOperations({
				authenticatedBase: base(encodeCanonical(state)),
				currentEpochOperations: [
					accepted({ action: "installRoster", roster: { entries } }, { author: creator, sequence: 6, digestByte: 6 }),
				],
			})
		).toThrow(/^v3 zone roster conflicts$/u);
	});
});
