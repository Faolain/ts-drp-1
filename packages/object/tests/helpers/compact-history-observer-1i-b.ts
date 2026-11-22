/* eslint-disable jsdoc/require-jsdoc -- shared tests-only behavioral fixture */
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Keychain } from "@ts-drp/keychain";
import {
	ACLGroup,
	type DRPObjectConfig,
	DrpType,
	type IDRP,
	Operation,
	SemanticsType,
	type Vertex,
	Vertex as VertexCodec,
} from "@ts-drp/types";
import { createHash } from "node:crypto";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";

import { createACL } from "../../src/acl/index.js";
import { createVertex, HashGraph } from "../../src/hashgraph/index.js";
import { DRPObject } from "../../src/index.js";

export interface CompactHistoryIdentity {
	keychain: Keychain;
	peerId: string;
}

export class CompactHistoryDRP implements IDRP {
	semanticsType = SemanticsType.pair;
	values: number[] = [];

	append(value: number): void {
		this.values.push(value);
	}

	query_values(): number[] {
		return [...this.values];
	}
}

export async function compactHistoryIdentity(seed: string): Promise<CompactHistoryIdentity> {
	const keychain = new Keychain({ private_key_seed: seed });
	await keychain.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(keychain.secp256k1PublicKey, "base64"));
	return { keychain, peerId: peerIdFromPublicKey(publicKey).toString() };
}

export function compactHistoryReplica(
	author: CompactHistoryIdentity,
	replicaMode: "observer" | "writer",
	historyStorage?: "compact" | "full"
): DRPObject<CompactHistoryDRP> {
	const config = {
		history_storage: historyStorage,
		log_config: { level: "silent" },
		replica_mode: replicaMode,
	} satisfies DRPObjectConfig;
	return new DRPObject({
		peerId: author.peerId,
		acl: createACL({ admins: [author.peerId] }),
		drp: new CompactHistoryDRP(),
		config,
	});
}

export async function signedCompactHistory(
	author: CompactHistoryIdentity,
	valueOffset = 0
): Promise<readonly Vertex[]> {
	const signed = async (
		opType: string,
		value: unknown[],
		dependencies: string[],
		timestamp: number,
		drpType = DrpType.DRP
	): Promise<Vertex> => {
		const vertex = createVertex(author.peerId, Operation.create({ drpType, opType, value }), dependencies, timestamp);
		vertex.signature = await author.keychain.signWithSecp256k1(vertex.hash);
		return vertex;
	};

	const first = await signed("append", [valueOffset + 1], [HashGraph.rootHash], 1_700_000_011_001 + valueOffset);
	const grant = await signed(
		"grant",
		["phase-1i-b-guest", ACLGroup.Writer],
		[first.hash],
		1_700_000_011_002 + valueOffset,
		DrpType.ACL
	);
	const second = await signed("append", [valueOffset + 2], [grant.hash], 1_700_000_011_003 + valueOffset);
	const left = await signed("append", [valueOffset + 4], [second.hash], 1_700_000_011_004 + valueOffset);
	const right = await signed("append", [valueOffset + 5], [left.hash], 1_700_000_011_005 + valueOffset);
	const revoke = await signed(
		"revoke",
		["phase-1i-b-guest", ACLGroup.Writer],
		[right.hash],
		1_700_000_011_006 + valueOffset,
		DrpType.ACL
	);
	const final = await signed("append", [valueOffset + 7], [revoke.hash], 1_700_000_011_007 + valueOffset);
	return [first, grant, second, left, right, revoke, final];
}

export function cloneVertex(vertex: Vertex): Vertex {
	return VertexCodec.decode(VertexCodec.encode(vertex).finish());
}

export function compactHistoryDigest(object: DRPObject<CompactHistoryDRP>, orderedHashes: readonly string[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				guestWriter: object.acl.query_isWriter("phase-1i-b-guest"),
				orderedHashes,
				values: object.drp?.query_values(),
			})
		)
		.digest("hex");
}
