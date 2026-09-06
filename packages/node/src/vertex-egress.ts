import { type AggregatedAttestation, type IDRP, type IDRPObject, type Vertex } from "@ts-drp/types";

import { type DRPNode } from "./index.js";
import { log } from "./logger.js";

/** Sign every locally authored vertex that has not yet been signed. */
export async function signGeneratedVertices(node: DRPNode, vertices: Vertex[]): Promise<void> {
	await Promise.all(
		vertices.map(async (vertex) => {
			if (vertex.peerId !== node.networkNode.peerId || vertex.signature.length !== 0) return;
			try {
				vertex.signature = await node.keychain.signWithSecp256k1(vertex.hash);
			} catch (error) {
				log.error("::signGeneratedVertices: Error signing vertex:", vertex.hash, error);
			}
		})
	);
}

/** Read finality attestations paired with an outbound vertex prefix. */
export function getAttestations<T extends IDRP>(object: IDRPObject<T>, vertices: Vertex[]): AggregatedAttestation[] {
	if (object.replicaMode === "observer" || object.finalityStore.enabled === false) return [];
	return vertices
		.map((vertex) => object.finalityStore.getAttestation(vertex.hash))
		.filter((attestation): attestation is AggregatedAttestation => attestation !== undefined);
}
