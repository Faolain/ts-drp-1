import type { TrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog/bytes";
import { decodeCanonical } from "@ts-drp/canonical";
import type { V3OperationAdmissionPolicyFactory } from "@ts-drp/node/v3-live";
import type { V3RoomApplication, V3RoomProjectionInput } from "@ts-drp/node/v3-room";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "@ts-drp/protocol-v3";
import { applyPreparedBlueprintOperation } from "@ts-drp/protocol-v3/blueprint-application";

import {
	createShippingChatCapacityAdmissionPolicy,
	createShippingChatGenesisStateBytes,
	restoreShippingChatCapacityState,
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
