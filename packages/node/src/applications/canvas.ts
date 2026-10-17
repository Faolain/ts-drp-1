import { openTrustedBlueprintCatalogBytes } from "@ts-drp/blueprint-catalog/bytes";
import {
	type CanvasState,
	createV3CanvasDescriptor,
	fromCanvasWireOperation,
	toCanvasWireOperation,
} from "@ts-drp/blueprints/v3-canvas";
import { hashDomain } from "@ts-drp/canonical";

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
