/* eslint-disable @typescript-eslint/explicit-function-return-type -- Observation-only evidence helper. */
// Physical, observation-only census of one peer's native creator stores. It opens
// its own read handles through the shipped native host, grants nothing, writes
// nothing, and never selects or relabels a rollback point.
import { decodeCanonical } from "@ts-drp/canonical";
import { AHE_BOUNDED_READ_LIMITS, parseStorageObjectId } from "@ts-drp/storage";

import { createNodeV3RoomStorageHost } from "../../../packages/storage-node/src/v3-room-host.js";
import { hex, required } from "../chat-membership-shares/room.js";

type Value = Record<string, unknown>;
const text = (value: unknown): unknown => (value instanceof Uint8Array ? hex(value) : value);

/** One AHE generation header with the protocol facts its own closure carries. */
export interface CensusGeneration {
	readonly generationId: string;
	readonly closureDigest: string;
	readonly state: string;
	readonly base: string;
	readonly projectionKind: string | null;
	readonly projectionEpoch: number | null;
	readonly cutEpoch: number | null;
	readonly cutStateDigest: string | null;
	readonly forwardPromotionClosedEpoch: number | null;
	readonly forwardPromotionStateDigest: string | null;
	readonly forwardPromotionCutValueDigest: string | null;
	readonly kinds: readonly string[];
}

/** Physical census row; every identity is copied from native records. */
export interface NativeCensus {
	readonly head: Readonly<{ kind: string; generationId?: string; revision?: unknown; closureDigest?: string }>;
	readonly chain: readonly number[];
	readonly generations: readonly CensusGeneration[];
	readonly snapshots: readonly Readonly<{ epoch: number; anchor: string; manifestDigest: string; incarnation: string;
		contentBytes: number; retirement: boolean }>[];
	readonly owner: Readonly<{ recoveryScopes: number; recoveryContentBytes: number }>;
}

/**
 * Reads one named replica's AHE generations and snapshot recovery inventory.
 * @param directory - The fixture's native directory.
 * @param objectId - The room object.
 * @param name - The replica's database name (e.g. `peer-0`).
 * @returns The census.
 */
export async function nativeCensus(directory: string, objectId: string, name: string): Promise<NativeCensus> {
	const host = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const ahe = await host.openAhe(`${name}--ahe`), snapshots = await host.openSnapshots(name);
	const object = parseStorageObjectId(objectId); if (!object.ok) throw Error("invalid fixture object");
	try {
		const acquired = await ahe.acquireBoundedRecoveryRoleRead({ objectId: object.value, limits: AHE_BOUNDED_READ_LIMITS });
		if (!acquired.ok) throw Error(`native role census: ${acquired.kind}`);
		try {
			const read = acquired.value;
			const decode = (digest: string): Value => decodeCanonical(required(read.blobs.find(blob => blob.ref.digest === digest)).bytes) as Value;
			const generations: CensusGeneration[] = read.generations.map(row => {
				const records = row.closure.map(ref => decode(ref.digest));
				const projection = records.find(value => value.kind === "v3-live-generation-1" || value.kind === "v3-live-generation-2");
				const cut = records.find(value => value.kind === "drp-hard-epoch-cut");
				const promotion = cut?.forwardPromotion as Value | undefined;
				const source = promotion?.source as Value | undefined;
				return {
					generationId: String(row.generationId), closureDigest: String(row.closureDigest), state: String(row.state),
					base: row.baseExpectedHead.kind === "present" ? String(row.baseExpectedHead.generationId) : "none",
					projectionKind: projection === undefined ? null : String(projection.kind),
					projectionEpoch: projection === undefined ? null : Number(projection.epoch),
					cutEpoch: cut === undefined ? null : Number(cut.epoch),
					cutStateDigest: cut === undefined ? null : String(text(cut.stateDigest)),
					forwardPromotionClosedEpoch: source === undefined ? null : Number(source.closedEpoch),
					forwardPromotionStateDigest: source === undefined ? null : String(text(source.stateDigest)),
					forwardPromotionCutValueDigest: source === undefined ? null : String(text(source.cutValueDigest)),
					kinds: records.map(value => String(value.kind)).sort(),
				};
			});
			const chain: number[] = [];
			let head = read.head;
			while (head.kind === "present" && chain.length < 8) {
				const id = head.generationId;
				const row = required(read.generations.find(value => value.generationId === id));
				const facts = required(generations.find(value => value.generationId === String(id)));
				if (facts.projectionEpoch === null) break;
				chain.push(facts.projectionEpoch); head = row.baseExpectedHead;
			}
			const inventory = await snapshots.captureRecoveryRoleInventory!({ objectId });
			return {
				head: read.head.kind === "present" ? { kind: "present", generationId: String(read.head.generationId),
					revision: read.head.revision, closureDigest: String(read.head.closureDigest) } : { kind: read.head.kind },
				chain, generations,
				snapshots: inventory.scopes.map(row => ({ epoch: row.scope.epoch, anchor: row.scope.anchor,
					manifestDigest: row.scope.manifestDigest, incarnation: row.incarnation, contentBytes: row.contentBytes,
					retirement: row.retirement !== undefined })).sort((a, b) => a.epoch - b.epoch),
				owner: { recoveryScopes: inventory.owner.recoveryScopes, recoveryContentBytes: inventory.owner.recoveryContentBytes },
			};
		} finally { await acquired.value.release(); }
	} finally { await snapshots.close(); await ahe.close(); }
}

/** The stable/pending floor exactly as the peer's own native floor owner reads it. */
export async function floorCensus(peer: Readonly<{ floor: { read(input: unknown): Promise<unknown> } }>,
	objectId: string, pinnedGenesisAnchorDigest: string) {
	const read = await peer.floor.read({ scope: { objectId, pinnedGenesisAnchorDigest } }) as Value;
	if (read.ok !== true) throw Error(`floor census unavailable: ${JSON.stringify(read)}`);
	const state = read.state as { stable: Value; pending: Value | null };
	return { stableEpoch: Number(state.stable.epoch), stableAnchor: String(state.stable.currentAnchorDigest),
		pending: state.pending === null ? null : JSON.stringify(state.pending) };
}
