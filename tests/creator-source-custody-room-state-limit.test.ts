import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical } from "@ts-drp/canonical";
import { installCreatorAnchorTrustRoot } from "@ts-drp/protocol-v3";
import registry from "@ts-drp/protocol-v3/registry/registry-v1.json" with { type: "json" };
import { ROOM_APPLICATION_STATE_CEILING_BYTES } from "@ts-drp/protocol-v3/room-parameters";
import { describe, expect, it } from "vitest";

import { createV3ZoneApplication, GRID_ZONE_ROOM_PARAMETERS } from "../examples/grid/src/v3-zone.js";
import { createV3RoomCreatorInviteMaterial } from "../examples/v3-room/src/index.js";
import {
	captureCreatorSourceContext,
	creatorSourceCustodyGeometryForSizing,
	openCreatorSourceCustody,
	resolveCreatorSourceCustody,
} from "../packages/node/src/internal/creator-source-custody.js";

// A room's application state limit is the optional `maxApplicationStateBytes` of its signed parameters
// record (protocol-v3 room-parameters). Under creator-trusted-settlement-v1 the creator captures, for
// every Writer move it settles, a source context that carries the room's exact parameters record
// (creator-source-custody). Every validator of that record must accept the registered extension, and the
// context width the creator reserves for it (G22 sizing: maxContextByteLength) must cover the record's
// registered complete domain, the extension included. Before the fix the custody validator accepted only
// the registry's own fields: in every room declaring a limit (Grid's 98,304, a 128 KiB room) the creator
// refused to capture the source of any Writer move ("creator source context is not authenticated"), so no
// Writer move settled, successors were refused, and the room's planes stopped accepting operations.

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) throw new TypeError("required value is missing");
	return value;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const baseParameters = Object.freeze({
	maxDependencies: 16,
	maxEpochBytes: 8_388_608,
	maxEpochVertices: 8192,
	maxPendingBytes: 16_777_216,
	maxPendingEntries: 4096,
	maxSnapshotBytes: 268_435_456,
	snapshotChunkBytes: 131_072,
});

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the trust type is the protocol owner's
async function genesisTrust(parameters: Readonly<Record<string, number>>) {
	const seeds = [new Uint8Array(32).fill(0xa1), new Uint8Array(32).fill(0xa2)];
	const authors = seeds.map((seed) => hex(ed25519.getPublicKey(seed)));
	const roster = authors.map((author, order) => ({ author, order, peerId: `custody-limit-peer-${order}` }));
	const zone = createV3ZoneApplication(roster, required(roster[0]).peerId, required(authors[0]));
	const objectId = "creator:" + "c".repeat(32);
	const signers = [{ publicKey: required(authors[0]), signerId: "creator" }];
	const exactCanonicalLatchedAclBytes = encodeCanonical({
		epoch: 0,
		kind: "drp-v3-latched-acl",
		members: authors
			.map((author, index) => ({
				author,
				finalityKey: index === 0 ? author : null,
				groups: index === 0 ? ["admin", "finality", "writer"] : ["writer"],
			}))
			.sort((left, right) => left.author.localeCompare(right.author)),
		objectId,
		permissionless: false,
		version: 3,
	});
	const exactCanonicalParametersCarrierBytes = encodeCanonical(parameters);
	const blueprintDigest = required(zone.catalog.blueprintDigests[0]);
	const invite = await createV3RoomCreatorInviteMaterial({
		blueprintDigest,
		exactCanonicalApplicationStateBytes: required(zone.migration).canonicalStateBytes(
			zone.projectAcceptedOperations({ authenticatedBase: undefined, currentEpochOperations: [] })
		),
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes,
		exactCanonicalProfileBytes: encodeCanonical({
			cryptoSuiteId: "ed25519-sha256-v3",
			profileId: "creator-trusted-settlement-v1",
			quorum: 1,
			signers,
		}),
		exactCanonicalSignerSetBytes: encodeCanonical(signers),
		objectId,
		signGenesisAnchorDigest: (digest) => Promise.resolve(ed25519.sign(digest, required(seeds[0]))),
	});
	const installed = installCreatorAnchorTrustRoot({
		detachedGenesisSignature: invite.detachedGenesisSignature,
		exactCanonicalGenesisAnchorPreimageBytes: invite.exactCanonicalGenesisAnchorPreimageBytes,
		exactCanonicalProfileBytes: invite.exactCanonicalProfileBytes,
		exactCanonicalSignerSetBytes: invite.exactCanonicalSignerSetBytes,
		pinnedGenesisAnchorDigest: invite.pinnedGenesisAnchorDigest,
	});
	if (!installed.ok) throw new TypeError(installed.reason);
	return {
		trust: installed.trust,
		exactCanonicalLatchedAclBytes,
		exactCanonicalParametersCarrierBytes,
		blueprintDigest,
	};
}

describe("a creator-trusted-settlement source context carries a room's declared application state limit", () => {
	for (const [name, parameters] of [
		["a room without the setting (control)", baseParameters],
		["the shipped Grid zone (98,304)", GRID_ZONE_ROOM_PARAMETERS],
		["a 128 KiB room", { ...baseParameters, maxApplicationStateBytes: ROOM_APPLICATION_STATE_CEILING_BYTES }],
	] as const) {
		it(`${name}: the creator captures and reopens the source of a Writer move`, async () => {
			const room = await genesisTrust(parameters);
			const context = captureCreatorSourceContext(
				room.trust,
				room.exactCanonicalLatchedAclBytes,
				room.blueprintDigest,
				room.exactCanonicalParametersCarrierBytes
			);
			const source = openCreatorSourceCustody({ currentTrust: room.trust, context });
			expect(source, "the captured source reopens").toBeDefined();
			expect(resolveCreatorSourceCustody(required(source))?.exactCanonicalParametersBytes).toEqual(
				room.exactCanonicalParametersCarrierBytes
			);
			const geometry = creatorSourceCustodyGeometryForSizing(room.trust, room.exactCanonicalLatchedAclBytes, 8192);
			expect(context.exactCanonicalContextBytes.byteLength).toBeLessThanOrEqual(
				required(geometry).maxContextByteLength
			);
		});
	}

	it("the reserved source context width covers the parameters record's registered complete domain, the extension included", async () => {
		// Any room's geometry: the reserve is the registered domain's, whatever this room declares.
		const room = await genesisTrust(baseParameters);
		const geometry = creatorSourceCustodyGeometryForSizing(room.trust, room.exactCanonicalLatchedAclBytes, 8192);
		const context = captureCreatorSourceContext(
			room.trust,
			room.exactCanonicalLatchedAclBytes,
			room.blueprintDigest,
			room.exactCanonicalParametersCarrierBytes
		);
		// The widest record the registered domain admits: every registry field at its maximum and the room's
		// limit at the library ceiling. The context differs from the genuine one only in its parameters bytes.
		const widest = encodeCanonical({
			...Object.fromEntries(registry.kinds.parameters.fields.map((field) => [field.name, field.constraints.maximum])),
			maxApplicationStateBytes: ROOM_APPLICATION_STATE_CEILING_BYTES,
		});
		const widestContext =
			context.exactCanonicalContextBytes.byteLength -
			room.exactCanonicalParametersCarrierBytes.byteLength -
			varuintWidth(room.exactCanonicalParametersCarrierBytes.byteLength) +
			widest.byteLength +
			varuintWidth(widest.byteLength);
		expect(widestContext, "G22 reserves the widest source context").toBeLessThanOrEqual(
			required(geometry).maxContextByteLength
		);
	});
});

function varuintWidth(value: number): number {
	let width = 1;
	while (value >= 128) {
		value = Math.floor(value / 128);
		width++;
	}
	return width;
}
