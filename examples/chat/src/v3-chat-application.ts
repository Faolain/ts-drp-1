import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";
import { decodeCanonical } from "@ts-drp/canonical";
import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import type { V3OperationAdmissionPolicyFactory } from "@ts-drp/node/v3-live";
import type { V3RoomApplication, V3RoomProjectionInput } from "@ts-drp/node/v3-room";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { applyPreparedBlueprintOperation } from "@ts-drp/protocol-v3/blueprint-application";

import {
	createShippingChatCapacityAdmissionPolicy,
	createShippingChatGenesisStateBytes,
	restoreShippingChatCapacityState,
	SHIPPING_CHAT_CAPACITY_STATE_LIMITS,
	type ShippingChatCapacity,
	shippingChatCapacityStateBytes,
} from "./v3-chat-capacity.js";
import { type ShippingChatMessage } from "./v3-chat-message.js";

export { createShippingChatGenesisStateBytes } from "./v3-chat-capacity.js";
export {
	captureShippingChatOperation,
	SHIPPING_CHAT_OPERATION_LIMITS,
	SHIPPING_CHAT_STATE_LIMITS,
	type ShippingChatMessage,
	type ShippingChatMessageOperation,
} from "./v3-chat-message.js";

export const SHIPPING_CHAT_ARTIFACT_ID = "v3-shipping-chat.v3" as const;
export interface ShippingChatProjection {
	readonly messages: readonly ShippingChatMessage[];
	readonly capacity: ShippingChatCapacity;
	readonly transportPeerAuthors: readonly Readonly<{ author: string; peerId: string }>[];
	readonly writerAuthors: readonly string[];
}

export type ShippingChatApplication = V3RoomApplication<ShippingChatProjection> &
	Readonly<{
		createOperationAdmissionPolicy: V3OperationAdmissionPolicyFactory;
	}>;

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
 * The same check as packages/node/src/applications/canvas.ts `resourceBoundBases`.
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
 * One genuine compiled application kernel; the native policy owns exact byte entitlements.
 * @param input
 */
export async function createShippingV3ChatApplication(
	input: Readonly<{
		catalog: TrustedBlueprintCatalog;
		blueprintDigest: string;
		exactCanonicalGenesisLatchedAclBytes: Uint8Array;
	}>
): Promise<ShippingChatApplication> {
	const catalog = input.catalog,
		blueprintDigest = input.blueprintDigest;
	const genesisBytes = createShippingChatGenesisStateBytes({
		exactCanonicalLatchedAclBytes: new Uint8Array(input.exactCanonicalGenesisLatchedAclBytes),
	});
	const genesis = restoreShippingChatCapacityState(genesisBytes);
	const resolved = catalog.resolve(blueprintDigest);
	if (resolved.artifactId !== SHIPPING_CHAT_ARTIFACT_ID) throw new TypeError("shipping Chat capacity artifact differs");
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
	// Ordinary resource bound (Track Q, docs/realtime-latency/tracks/27-track-q-canvas-chat-lull).
	// One rule for every application that states its bound this way (Canvas, shipping Chat):
	// a canonical footprint that dominates every state the application's own capture admits,
	// derived only from limits that capture enforces, never from observed sizes. Every
	// shipping Chat state passes `captureShippingChatCapacityState`, which encodes it under
	// SHIPPING_CHAT_CAPACITY_STATE_LIMITS (the reviewed 32 KiB retained-state bound, 16,384
	// items, depth 16): the projection and migration below re-capture every state, and this
	// composition's admission policy (`createOperationAdmissionPolicy`, which the room must
	// install with it) captures the complete joined state of every reservation, every
	// inherited state and every capacity allocation before admitting it. So that ceiling is
	// the bound, for any material; it reads no operation. Planning only: it grants no
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
	const readOrdinaryApplicationResourceBound: ResourceBoundReader = (input): CanonicalResourceFootprint | undefined => {
		try {
			const bases = resourceBoundBases(input, resourceCatalog);
			if (bases === undefined) return undefined;
			// Only authenticated shipping Chat states: captured, canonical, within the ceiling.
			for (const base of bases) restoreShippingChatCapacityState(base);
			return Object.freeze({
				byteLength: SHIPPING_CHAT_CAPACITY_STATE_LIMITS.maxBytes,
				items: SHIPPING_CHAT_CAPACITY_STATE_LIMITS.maxItems,
				maxDepth: SHIPPING_CHAT_CAPACITY_STATE_LIMITS.maxDepth,
			});
		} catch {
			return undefined;
		}
	};
	const project = (projection: V3RoomProjectionInput): ShippingChatProjection => {
		let state: unknown =
			projection.authenticatedBase === undefined
				? genesis
				: restoreShippingChatCapacityState(projection.authenticatedBase.exactCanonicalApplicationStateBytes);
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
		const retained = restoreShippingChatCapacityState(shippingChatCapacityStateBytes(state));
		return Object.freeze({
			messages: retained.messages,
			capacity: retained.capacity,
			transportPeerAuthors: Object.freeze([]),
			writerAuthors: Object.freeze([]),
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
			return createShippingChatGenesisStateBytes({
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
			createShippingChatCapacityAdmissionPolicy({ ...context, exactCanonicalGenesisStateBytes: genesisBytes }),
		migration: Object.freeze({
			inheritAuthenticatedState: true as const,
			canonicalStateBytes(projection: ShippingChatProjection): Uint8Array {
				return shippingChatCapacityStateBytes({
					version: 3,
					messages: projection.messages,
					capacity: projection.capacity,
				});
			},
			prepare(_accepted: readonly unknown[], exactCanonicalSourceStateBytes?: Uint8Array) {
				if (exactCanonicalSourceStateBytes === undefined)
					throw new TypeError("Chat capacity migration requires authenticated source state");
				const bytes = shippingChatCapacityStateBytes(restoreShippingChatCapacityState(exactCanonicalSourceStateBytes));
				return Object.freeze({ exactCanonicalApplicationStateBytes: bytes, importOperations: Object.freeze([]) });
			},
			containsInheritedOperation(
				operation: Readonly<Record<string, unknown>>,
				exactCanonicalStateBytes: Uint8Array,
				context?: Readonly<{ sourceAuthor: string }>
			): boolean {
				if (context === undefined || operation.action !== "message") return false;
				try {
					return restoreShippingChatCapacityState(exactCanonicalStateBytes).messages.some(
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
