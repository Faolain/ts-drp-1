import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNER_PATH = "packages/ephemeral/src/aoi-delta.ts";
const PUBLIC_PATH = "packages/ephemeral/src/index.ts";
const ZONE_PATH = "examples/grid/src/v3-zone.ts";
const ownerExists = existsSync(OWNER_PATH);

interface EntityDelta {
	readonly entityId: number;
	readonly sequence: number;
	readonly x: number;
	readonly y: number;
}

interface AoiSelectionInput {
	readonly entities: readonly EntityDelta[];
	readonly maxEntities: number;
	readonly observerX: number;
	readonly observerY: number;
	readonly radius: number;
}

interface AoiDeltaModule {
	readonly ENTITY_DELTA_BATCH_MAX_BYTES: number;
	readonly ENTITY_DELTA_BATCH_MAX_ENTITIES: number;
	readonly ENTITY_DELTA_BATCH_VERSION: number;
	decodeEntityDeltaBatch(bytes: Uint8Array): readonly EntityDelta[];
	encodeEntityDeltaBatch(entities: readonly EntityDelta[]): Uint8Array;
	selectAoiEntityDeltas(input: AoiSelectionInput): readonly EntityDelta[];
}

async function loadModule(path: string): Promise<AoiDeltaModule> {
	return (await import(pathToFileURL(path).href)) as AoiDeltaModule;
}

function entity(entityId: number, x: number, y: number, sequence = entityId): EntityDelta {
	return { entityId, sequence, x, y };
}

function ids(entities: readonly EntityDelta[]): number[] {
	return entities.map(({ entityId }) => entityId);
}

function invalidEntities(): readonly EntityDelta[] {
	return [
		entity(-1, 0, 0),
		entity(0.5, 0, 0),
		entity(0x1_0000_0000, 0, 0),
		entity(1, 0, 0, -1),
		entity(1, 0, 0, 0.5),
		entity(1, 0, 0, 0x1_0000_0000),
		entity(1, -2_147_483_649, 0),
		entity(1, 2_147_483_648, 0),
		entity(1, 0.5, 0),
		entity(1, 0, -2_147_483_649),
		entity(1, 0, 2_147_483_648),
		entity(1, 0, 0.5),
	];
}

function exactSquaredDistance(leftX: number, leftY: number, rightX: number, rightY: number): bigint {
	const dx = BigInt(leftX) - BigInt(rightX);
	const dy = BigInt(leftY) - BigInt(rightY);
	return dx * dx + dy * dy;
}

function parseZone(source: string): ts.SourceFile {
	return ts.createSourceFile(ZONE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importedNames(file: ts.SourceFile, moduleName: string): readonly string[] {
	for (const statement of file.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === moduleName &&
			statement.importClause?.namedBindings !== undefined &&
			ts.isNamedImports(statement.importClause.namedBindings)
		) {
			return statement.importClause.namedBindings.elements.map(({ name }) => name.text).sort();
		}
	}
	return [];
}

function sourceFunction(file: ts.SourceFile, name: string): string {
	let match: ts.FunctionDeclaration | ts.MethodDeclaration | undefined;
	const visit = (node: ts.Node): void => {
		if (
			match === undefined &&
			(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
			node.name?.getText(file) === name
		) {
			match = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	if (match === undefined) throw new TypeError(`grid function ${name} is absent`);
	return match.getText(file);
}

it("E4-01 RED exposes the missing public AOI delta owner", () => {
	expect(ownerExists).toBe(true);
});

describe.skipIf(!ownerExists)("E4-01 bounded AOI selection and entity delta batch", () => {
	it("publishes one exact public owner and its payload limits", async () => {
		const owner = await loadModule(OWNER_PATH);
		const publicModule = await loadModule(PUBLIC_PATH);

		expect(publicModule.selectAoiEntityDeltas).toBe(owner.selectAoiEntityDeltas);
		expect(publicModule.encodeEntityDeltaBatch).toBe(owner.encodeEntityDeltaBatch);
		expect(publicModule.decodeEntityDeltaBatch).toBe(owner.decodeEntityDeltaBatch);
		expect(owner.ENTITY_DELTA_BATCH_VERSION).toBe(1);
		expect(owner.ENTITY_DELTA_BATCH_MAX_ENTITIES).toBe(32);
		expect(owner.ENTITY_DELTA_BATCH_MAX_BYTES).toBe(514);
	});

	it("routes grid movement through the public batch owner without a durable fallback", () => {
		const source = readFileSync(ZONE_PATH, "utf8");
		const file = parseZone(source);
		const move = sourceFunction(file, "move");
		const decodePosition = sourceFunction(file, "decodePosition");

		expect(importedNames(file, "@ts-drp/ephemeral")).toEqual([
			"EphemeralChannel",
			"decodeEntityDeltaBatch",
			"encodeEntityDeltaBatch",
		]);
		expect(move).toContain('class: "unreliable-sequenced"');
		expect(move).toContain("payload: encodeEntityDeltaBatch(");
		expect(move).not.toContain("JSON.stringify");
		expect(move).not.toContain(".issue(");
		expect(decodePosition).toContain("decodeEntityDeltaBatch(payload)");
		expect(decodePosition).not.toContain("JSON.parse");
	});

	it("uses inclusive integer-radius bounds and excludes exact radius-squared plus one", async () => {
		const { selectAoiEntityDeltas } = await loadModule(OWNER_PATH);
		const observer = 2_147_483_647;
		const opposite = -2_147_483_648;
		const candidates = [
			entity(1, opposite, observer),
			entity(2, opposite + 1, observer),
			entity(3, opposite, observer - 1),
		];

		expect(exactSquaredDistance(observer, observer, opposite, observer - 1)).toBe(
			BigInt(0xffff_ffff) * BigInt(0xffff_ffff) + 1n
		);
		expect(
			ids(
				selectAoiEntityDeltas({
					entities: candidates,
					maxEntities: 32,
					observerX: observer,
					observerY: observer,
					radius: 0xffff_ffff,
				})
			)
		).toEqual([2, 1]);
		expect(
			ids(
				selectAoiEntityDeltas({
					entities: candidates,
					maxEntities: 32,
					observerX: observer,
					observerY: observer,
					radius: 0xffff_fffe,
				})
			)
		).toEqual([2]);
	});

	it("orders two-dimensional extreme distances by exact integer value rather than rounded Number ties", async () => {
		const { selectAoiEntityDeltas } = await loadModule(OWNER_PATH);
		const observerX = -2_147_483_648;
		const observerY = -2_147_483_648;
		const closer = entity(9, -2, -2);
		const farther = entity(3, -1, -3);

		expect(exactSquaredDistance(observerX, observerY, closer.x, closer.y)).toBe(
			exactSquaredDistance(observerX, observerY, farther.x, farther.y) - 2n
		);
		expect(
			ids(
				selectAoiEntityDeltas({
					entities: [farther, closer],
					maxEntities: 32,
					observerX,
					observerY,
					radius: 0xffff_ffff,
				})
			)
		).toEqual([9, 3]);
	});

	it("selects at most 32 nearest entities and breaks distance ties by entity id", async () => {
		const { selectAoiEntityDeltas } = await loadModule(OWNER_PATH);
		const candidates = Array.from({ length: 33 }, (_, index) => entity(index, index, 0));
		const selected = selectAoiEntityDeltas({
			entities: candidates,
			maxEntities: 32,
			observerX: 0,
			observerY: 0,
			radius: 100,
		});
		const tied = selectAoiEntityDeltas({
			entities: [entity(9, -3, 4), entity(3, 3, -4), entity(5, 0, 5)],
			maxEntities: 32,
			observerX: 0,
			observerY: 0,
			radius: 5,
		});

		expect(ids(selected)).toEqual(Array.from({ length: 32 }, (_, index) => index));
		expect(ids(tied)).toEqual([3, 5, 9]);
	});

	it("is independent of candidate iteration order and detaches selected records", async () => {
		const { selectAoiEntityDeltas } = await loadModule(OWNER_PATH);
		const aliased = { entityId: 7, sequence: 7, x: 1, y: 0 };
		const candidates = [aliased, entity(2, 0, 1), entity(9, 4, 4)];
		const input = {
			entities: candidates,
			maxEntities: 2,
			observerX: 0,
			observerY: 0,
			radius: 8,
		} as const;
		const selected = selectAoiEntityDeltas(input);
		const reversed = selectAoiEntityDeltas({ ...input, entities: [...candidates].reverse() });

		expect(selected).toEqual(reversed);
		expect(ids(selected)).toEqual([2, 7]);
		aliased.entityId = 99;
		aliased.sequence = 99;
		aliased.x = 99;
		aliased.y = 99;
		expect(selected).toEqual([entity(2, 0, 1), entity(7, 1, 0)]);
	});

	it("rejects duplicate identities and every invalid selection bound", async () => {
		const { selectAoiEntityDeltas } = await loadModule(OWNER_PATH);
		const valid = {
			entities: [entity(1, 0, 0)],
			maxEntities: 32,
			observerX: 0,
			observerY: 0,
			radius: 1,
		} as const;

		expect(() => selectAoiEntityDeltas({ ...valid, entities: [entity(4, 100, 100), entity(4, 101, 101)] })).toThrow();
		for (const input of [
			{ ...valid, maxEntities: 0 },
			{ ...valid, maxEntities: 33 },
			{ ...valid, observerX: 2_147_483_648 },
			{ ...valid, observerY: 0.5 },
			{ ...valid, radius: -1 },
			{ ...valid, radius: 0x1_0000_0000 },
		]) {
			expect(() => selectAoiEntityDeltas(input)).toThrow();
		}
		for (const invalid of invalidEntities()) {
			expect(() => selectAoiEntityDeltas({ ...valid, entities: [invalid] })).toThrow();
		}
	});

	it("encodes the fixed-width big-endian version-1 vector and exact field bounds", async () => {
		const { decodeEntityDeltaBatch, encodeEntityDeltaBatch } = await loadModule(OWNER_PATH);
		const batch = [entity(0x8102_0304, -1, 2, 0xa0b0_c0d0), entity(7, -2_147_483_648, 2_147_483_647, 9)];
		const bytes = encodeEntityDeltaBatch(batch);

		expect(Array.from(bytes)).toEqual([
			1, 2, 129, 2, 3, 4, 160, 176, 192, 208, 255, 255, 255, 255, 0, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 9, 128, 0, 0, 0, 127,
			255, 255, 255,
		]);
		expect(decodeEntityDeltaBatch(bytes)).toEqual(batch);
		expect(Array.from(encodeEntityDeltaBatch([]))).toEqual([1, 0]);
		const exactBounds = entity(0xffff_ffff, -2_147_483_648, 2_147_483_647, 0xffff_ffff);
		expect(decodeEntityDeltaBatch(encodeEntityDeltaBatch([exactBounds]))).toEqual([exactBounds]);
	});

	it("round-trips detached rows without retaining source or byte aliases", async () => {
		const { decodeEntityDeltaBatch, encodeEntityDeltaBatch } = await loadModule(OWNER_PATH);
		const sourceRow = { entityId: 11, sequence: 12, x: -13, y: 14 };
		const encoded = encodeEntityDeltaBatch([sourceRow]);
		const frozenBytes = encoded.slice();
		sourceRow.entityId = 99;
		sourceRow.sequence = 99;
		sourceRow.x = 99;
		sourceRow.y = 99;
		const decoded = decodeEntityDeltaBatch(encoded);
		encoded.fill(0);

		expect(frozenBytes).toEqual(new Uint8Array([1, 1, 0, 0, 0, 11, 0, 0, 0, 12, 255, 255, 255, 243, 0, 0, 0, 14]));
		expect(decoded).toEqual([entity(11, -13, 14, 12)]);
		expect(encodeEntityDeltaBatch(decoded)).toEqual(frozenBytes);
	});

	it("rejects over-cap, duplicate, malformed, and noncanonical batches", async () => {
		const { decodeEntityDeltaBatch, encodeEntityDeltaBatch } = await loadModule(OWNER_PATH);
		const tooMany = Array.from({ length: 33 }, (_, index) => entity(index, index, -index));
		const overCount = new Uint8Array(2 + 33 * 16);
		overCount[0] = 1;
		overCount[1] = 33;
		const overCountView = new DataView(overCount.buffer);
		for (let index = 0; index < 33; index += 1) overCountView.setUint32(2 + index * 16, index, false);

		expect(() => encodeEntityDeltaBatch(tooMany)).toThrow();
		expect(() => encodeEntityDeltaBatch([entity(1, 0, 0), entity(1, 1, 1)])).toThrow();
		for (const invalid of invalidEntities()) expect(() => encodeEntityDeltaBatch([invalid])).toThrow();

		for (const bytes of [
			new Uint8Array(),
			new Uint8Array([2, 0]),
			new Uint8Array([1, 1]),
			new Uint8Array([1, 0, 0]),
			overCount,
		]) {
			expect(() => decodeEntityDeltaBatch(bytes)).toThrow();
		}

		const duplicate = encodeEntityDeltaBatch([entity(4, 0, 0), entity(8, 1, 1)]);
		new DataView(duplicate.buffer, duplicate.byteOffset, duplicate.byteLength).setUint32(18, 4, false);
		expect(() => decodeEntityDeltaBatch(duplicate)).toThrow();
	});

	it("pins the 32-entity payload and its 30 Hz Profile-M payload budget", async () => {
		const { ENTITY_DELTA_BATCH_MAX_BYTES, encodeEntityDeltaBatch } = await loadModule(OWNER_PATH);
		const maximum = encodeEntityDeltaBatch(
			Array.from({ length: 32 }, (_, index) => entity(index, -2_147_483_648 + index, 2_147_483_647 - index))
		);
		const payloadBitsPerSecond = maximum.byteLength * 8 * 30;

		expect(maximum.byteLength).toBe(ENTITY_DELTA_BATCH_MAX_BYTES);
		expect(maximum.byteLength).toBe(514);
		expect(payloadBitsPerSecond).toBe(123_360);
		expect(payloadBitsPerSecond).toBeLessThan(256_000);
	});
});
