import { openTrustedBlueprintCatalogBytes } from "@ts-drp/blueprint-catalog/bytes";
import {
	CANVAS_LIMITS,
	CANVAS_SNAPSHOT_LIMITS,
	type CanvasState,
	createV3CanvasDescriptor,
	fromCanvasWireOperation,
	toCanvasWireOperation,
} from "@ts-drp/blueprints/v3-canvas";
import { hashDomain } from "@ts-drp/canonical";
import {
	canonicalArrayResourceForSizing,
	canonicalPrimitiveResourceForSizing,
	canonicalRecordResourceForSizing,
	type CanonicalResourceFootprint,
} from "@ts-drp/canonical/resource";

import type { V3RoomAcceptedOperation, V3RoomApplication, V3RoomProjectionInput } from "../v3-room.js";
import catalogMaterial from "./canvas-catalog-material.json" with { type: "json" };

export interface CanvasProjection {
	readonly state: CanvasState;
	readonly transportPeerAuthors: readonly Readonly<{ author: string; peerId: string }>[];
	readonly writerAuthors: readonly string[];
}
function bytes(hex: string): Uint8Array {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex))
		throw new TypeError("invalid Canvas catalog bytes");
	return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}
const catalog = openTrustedBlueprintCatalogBytes({
	catalogBytes: bytes(catalogMaterial.catalogBytes),
	assets: Object.fromEntries(Object.entries(catalogMaterial.assets).map(([name, value]) => [name, bytes(value)])),
});

type ResourceBoundReader = NonNullable<V3RoomApplication["readOrdinaryApplicationResourceBound"]>;
type ResourceCatalog = Parameters<ResourceBoundReader>[0]["catalog"];
const RESOURCE_IDENTITY_KEYS = [
	"blueprintDigest",
	"artifactId",
	"artifactDigest",
	"catalogDigest",
	"runtimeProfile",
] as const;
const RESOURCE_CARRIER_KEYS = ["exactArtifactBytes", "canonicalBlueprintPackageBytes"] as const;
const RESOURCE_MATERIAL_KEYS = [
	"exactCanonicalBaseStateBytes",
	"currentOperations",
	"protectedOperations",
	"recoveryOperations",
	"candidateOperation",
] as const;

/**
 * Own data properties of a record with exactly `keys`; no accessor runs.
 * @param value - The untrusted value.
 * @param keys - Its exact own keys.
 * @returns The values by key, or undefined for any other shape.
 */
function resourceDataRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Reflect.ownKeys(value).length !== keys.length
	)
		return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (descriptor === undefined || !("value" in descriptor)) return undefined;
		out[key] = descriptor.value;
	}
	return out;
}

/**
 * The base states of a resource bound input that names exactly this composition's catalog
 * entry, in the shape the room supplies (packages/node/src/internal/runtime-reclamation.ts
 * `CreatorOrdinaryApplicationResourceBoundInput`), as the Grid's reader checks it
 * (examples/grid/src/v3-zone.ts `captureResourceMaterial`); undefined for anything else.
 * @param input - The room's resource bound input.
 * @param expected - The composition's own resolved catalog entry, copied at composition.
 * @returns The non-empty dense list of base state byte strings, unvalidated.
 */
function resourceBoundBases(input: unknown, expected: ResourceCatalog): readonly Uint8Array[] | undefined {
	const outer = resourceDataRecord(input, ["catalog", "material"]);
	const entry = resourceDataRecord(outer?.catalog, [...RESOURCE_IDENTITY_KEYS, ...RESOURCE_CARRIER_KEYS]);
	if (outer === undefined || entry === undefined || RESOURCE_IDENTITY_KEYS.some((key) => entry[key] !== expected[key]))
		return undefined;
	for (const key of RESOURCE_CARRIER_KEYS) {
		const value = entry[key];
		if (
			!(value instanceof Uint8Array) ||
			value.byteLength !== expected[key].byteLength ||
			value.some((byte, index) => byte !== expected[key][index])
		)
			return undefined;
	}
	const material = resourceDataRecord(outer.material, RESOURCE_MATERIAL_KEYS);
	if (
		material === undefined ||
		!Array.isArray(material.currentOperations) ||
		!Array.isArray(material.protectedOperations) ||
		!Array.isArray(material.recoveryOperations)
	)
		return undefined;
	const bases: unknown = material.exactCanonicalBaseStateBytes;
	if (!Array.isArray(bases) || bases.length === 0) return undefined;
	const out: Uint8Array[] = [];
	for (let index = 0; index < bases.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(bases, index);
		if (descriptor === undefined || !("value" in descriptor) || !(descriptor.value instanceof Uint8Array))
			return undefined;
		out.push(descriptor.value);
	}
	return out;
}

/**
 * Canvas product composition; authentication and current-head selection remain the room/host owners.
 * @param width - Admitted canvas width.
 * @param height - Admitted canvas height.
 * @returns Genuine catalog and additive application projection.
 */
export function createV3CanvasApplication(width: number, height: number): V3RoomApplication<CanvasProjection> {
	const descriptor = createV3CanvasDescriptor(width, height);
	const blueprintDigest = catalog.blueprintDigests[0];
	if (blueprintDigest === undefined || catalog.blueprintDigests.length !== 1)
		throw new TypeError("Canvas requires its exact single-entry catalog");
	// Ordinary resource bound (Track Q, docs/realtime-latency/tracks/27-track-q-canvas-chat-lull).
	// One rule for every application that states its bound this way (Canvas, shipping Chat):
	// a canonical footprint that dominates every state the application's own capture admits,
	// derived only from limits that capture enforces, never from observed sizes. The Canvas
	// capture (`kernel.captureState`, which the descriptor's `canonicalStateBytes` and
	// `restoreState` and every reducer result pass through) admits exactly
	// {version: 1, width, height, counters} with this composition's fixed dimensions and
	// width·height pixels of three safe integers in [0, CANVAS_LIMITS.maxCounter]; at the
	// ceiling, admission refuses. A canonical integer is a tag plus varuint(2n), so it never
	// narrows as it grows: the widest admitted state has every counter at maxCounter. Its
	// footprint, from the original codec's resource algebra under the descriptor's own
	// CANVAS_SNAPSHOT_LIMITS, bounds every base and every state any operations can produce.
	// It is the same for any material and reads no operation. Planning only: it grants no
	// validity, admission, authority or credit, and the room re-checks every base under it.
	const counter = canonicalPrimitiveResourceForSizing(CANVAS_LIMITS.maxCounter, CANVAS_SNAPSHOT_LIMITS);
	const pixel = canonicalArrayResourceForSizing(3, counter, CANVAS_SNAPSHOT_LIMITS);
	const widest = canonicalRecordResourceForSizing(
		{
			version: 1,
			width,
			height,
			counters: canonicalArrayResourceForSizing(width * height, pixel, CANVAS_SNAPSHOT_LIMITS),
		},
		CANVAS_SNAPSHOT_LIMITS
	);
	const resolved = catalog.resolve(blueprintDigest);
	const resourceCatalog: ResourceCatalog = Object.freeze({
		blueprintDigest: resolved.blueprintDigest,
		artifactId: resolved.artifactId,
		artifactDigest: resolved.artifactDigest,
		catalogDigest: resolved.evidence.catalogDigest,
		runtimeProfile: resolved.runtimeProfile,
		exactArtifactBytes: resolved.exactArtifactBytes.slice(),
		canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes.slice(),
	});
	const readOrdinaryApplicationResourceBound: ResourceBoundReader = (input): CanonicalResourceFootprint | undefined => {
		try {
			const bases = resourceBoundBases(input, resourceCatalog);
			if (bases === undefined) return undefined;
			// Only this composition's own authenticated states: exact dimensions, canonical bytes.
			for (const base of bases) descriptor.restoreState(base);
			return Object.freeze({ byteLength: widest.byteLength, items: widest.items, maxDepth: widest.maxDepth });
		} catch {
			return undefined;
		}
	};
	const gameplayRows = (rows: readonly V3RoomAcceptedOperation[]): readonly V3RoomAcceptedOperation[] =>
		rows.filter(
			({ operation }) => Reflect.get(operation, "action") === "paint" || Reflect.get(operation, "action") === "splash"
		);
	const project = (input: V3RoomProjectionInput): CanvasProjection => {
		const base = input.authenticatedBase;
		const epoch = base === undefined ? 0 : base.epoch + 1;
		const state = descriptor.projectAcceptedOperations({
			epoch,
			...(base === undefined
				? {}
				: { base: { epoch: base.epoch, state: descriptor.restoreState(base.exactCanonicalApplicationStateBytes) } }),
			operations: gameplayRows(input.currentEpochOperations).map((row) => ({
				vertexDigest: row.vertexDigest,
				author: row.author,
				epoch,
				operationIndex: row.operationIndex,
				operation: fromCanvasWireOperation(row.operation),
			})),
		});
		return Object.freeze({ state, transportPeerAuthors: Object.freeze([]), writerAuthors: Object.freeze([]) });
	};
	return Object.freeze({
		snapshotReadPolicy: "authenticated-public" as const,
		bootstrapOperation: Object.freeze({ action: "causalJoin" }),
		canonicalBlueprintPackageBytes: catalog.resolve(blueprintDigest).canonicalBlueprintPackageBytes,
		catalog,
		readOrdinaryApplicationResourceBound,
		batchableOperationActions: Object.freeze(["paint", "splash"]),
		displacementPolicies: Object.freeze({ paint: "rebase" as const, splash: "rebase" as const }),
		displacedOperationIdentity(operation: Readonly<Record<string, unknown>>): string {
			fromCanvasWireOperation(operation);
			return Reflect.get(operation, "clientOperationId") as string;
		},
		projectAcceptedOperations: project,
		migration: Object.freeze({
			canonicalStateBytes(projection: CanvasProjection): Uint8Array {
				return descriptor.canonicalStateBytes(projection.state);
			},
			prepare(rows: readonly V3RoomAcceptedOperation[], exactCanonicalSourceStateBytes?: Uint8Array) {
				const state =
					exactCanonicalSourceStateBytes === undefined
						? project({ authenticatedBase: undefined, currentEpochOperations: rows }).state
						: descriptor.restoreState(exactCanonicalSourceStateBytes);
				const exactState = descriptor.canonicalStateBytes(state);
				// Replay full additive counters, not modulo-256 colors or only the
				// current epoch. Bound the complete plan before allocating its rows.
				const count = state.counters.reduce((total, rgb) => total + Math.ceil(Math.max(...rgb) / 255), 0);
				if (count > 8192) throw new TypeError("Canvas migration imports are unbounded");
				const sourceId = Array.from(hashDomain("ts-drp/canvas-migration-import/v1", exactState), (byte) =>
					byte.toString(16).padStart(2, "0")
				).join("");
				const imports: Readonly<Record<string, unknown>>[] = [];
				state.counters.forEach((rgb, index) => {
					let remaining = [...rgb];
					for (let part = 0; remaining.some((channel) => channel !== 0); part++) {
						const increment = remaining.map((channel) => Math.min(channel, 255)) as [number, number, number];
						imports.push(
							toCanvasWireOperation(
								{ action: "paint", offset: [Math.floor(index / height), index % height], rgb: increment },
								`${sourceId}:${index}:${part}`
							)
						);
						remaining = remaining.map((channel, channelIndex) => channel - (increment[channelIndex] ?? 0));
					}
				});
				return Object.freeze({
					exactCanonicalApplicationStateBytes: exactState,
					importOperations: Object.freeze(imports),
				});
			},
		}),
	});
}
