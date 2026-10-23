import { ed25519 } from "@noble/curves/ed25519.js";
import { createV3CanvasDescriptor, toCanvasWireOperation } from "@ts-drp/blueprints/v3-canvas";
import { encodeCanonical } from "@ts-drp/canonical";
import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";

import { event, trace } from "./observation.js";
import { hex, parameters, seed, transport } from "./room.js";
import { createV3CanvasApplication } from "../../../packages/node/src/applications/canvas.js";
import { createV3ZoneApi, type V3ZoneApi } from "../../../examples/grid/src/v3-zone.js";
import "../../../examples/v3-chat/src/index.js";
import {
	createBrowserV3SixDatabaseStorageHost,
	createV3RoomCreatorInviteMaterial,
	createV3RoomSession,
	type V3RoomHeadAuthority,
} from "../../../examples/v3-room/src/index.js";
import { createRecoverableFinalitySigner } from "../../../packages/keychain/src/finality.js";
import type { DRPNode } from "../../../packages/node/dist/src/index.js";

type Chat = {
	create(input: {
		channelName: string;
		clientId: "alice";
		databaseName: string;
		roomHeadAuthority: V3RoomHeadAuthority;
	}): Promise<string>;
	join(input: {
		channelName: string;
		clientId: "alice";
		databaseName: string;
		invite: string;
		roomHeadAuthority: V3RoomHeadAuthority;
	}): Promise<void>;
	send(text: string): Promise<void>;
	snapshot(): unknown;
	close(): Promise<void>;
	rehearseMigration(): Promise<unknown>;
	activateMigration(receipt: unknown): Promise<unknown>;
};
const chat = Reflect.get(globalThis, "d9336V3Chat") as Chat;
async function closeChatHead(
	head: Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>,
	primary: unknown
): Promise<void> {
	// Join room work before releasing its caller-owned native head authority.
	const room = await Promise.allSettled([chat.close()]);
	const native = await Promise.allSettled([head.close()]);
	const errors = [...room, ...native].flatMap((result) =>
		result.status === "rejected" ? [result.reason as unknown] : []
	);
	if (errors.length !== 0)
		throw new AggregateError(primary === undefined ? errors : [primary, ...errors], "SHIPPED_CHAT_PRIMARY_AND_CLEANUP");
}
function node(identity: string): DRPNode {
	const key = seed(identity),
		author = hex(ed25519.getPublicKey(key));
	return {
		keychain: {
			localAuthorId: author,
			signWithLocalAuthor: async (value: Uint8Array) => Promise.resolve(ed25519.sign(value, key)),
		},
		networkNode: { peerId: author },
		openRoomNetwork: transport(author, true),
		ephemeralUnreliableWebRtcSnapshot: () => undefined,
	} as unknown as DRPNode;
}
async function closeGridHead(
	api: V3ZoneApi,
	enrolled: V3ZoneApi,
	head: Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>,
	primary: unknown
): Promise<void> {
	const rooms = await Promise.allSettled([api.close(), enrolled.close()]);
	const native = await Promise.allSettled([head.close()]);
	const errors = [...rooms, ...native].flatMap((result) =>
		result.status === "rejected" ? [result.reason as unknown] : []
	);
	if (errors.length !== 0)
		throw new AggregateError(primary === undefined ? errors : [primary, ...errors], "SHIPPED_GRID_PRIMARY_AND_CLEANUP");
}
Object.assign(globalThis, {
	startupShippedCanvas: async (identity: string) => {
		const key = seed(identity),
			author = hex(ed25519.getPublicKey(key));
		const objectId = `creator:${hex(seed(identity + "--canvas-object")).slice(0, 32)}`;
		const application = createV3CanvasApplication(2, 2);
		const descriptor = createV3CanvasDescriptor(2, 2);
		const blueprintDigest = application.catalog.blueprintDigests[0];
		if (blueprintDigest === undefined) throw new TypeError("genuine Canvas blueprint unavailable");
		const signers = [{ publicKey: author, signerId: "creator" }];
		const invite = await createV3RoomCreatorInviteMaterial({
			blueprintDigest,
			objectId,
			exactCanonicalApplicationStateBytes: descriptor.canonicalStateBytes(descriptor.initialState),
			exactCanonicalLatchedAclBytes: encodeCanonical({
				epoch: 0,
				kind: "drp-v3-latched-acl",
				members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }],
				objectId,
				permissionless: false,
				version: 1,
			}),
			exactCanonicalParametersCarrierBytes: encodeCanonical(parameters),
			exactCanonicalProfileBytes: encodeCanonical({
				cryptoSuiteId: "ed25519-sha256-v3",
				profileId: "creator-trusted-v1",
				quorum: 1,
				signers,
			}),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			signGenesisAnchorDigest: async (digest) => ed25519.sign(digest, key),
		});
		const finality = await createRecoverableFinalitySigner({ seed: key });
		const heads: Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>[] = [];
		const rooms: Awaited<
			ReturnType<typeof createV3RoomSession<ReturnType<typeof application.projectAcceptedOperations>>>
		>[] = [];
		const open = async (kind: "create" | "reopen") => {
			const head = await createBrowserRoomHeadAuthority({
				databaseName: identity + "--canvas-room-head",
				initialization: { kind },
			});
			heads.push(head);
			const room = await createV3RoomSession({
				application,
				storageHost: createBrowserV3SixDatabaseStorageHost(),
				author,
				creatorInvite: invite,
				creatorFinalitySigner: finality.signer,
				databaseName: identity,
				issuanceDatabaseName: identity,
				objectId,
				initialLogicalTime: 3,
				publicKeyBytes: ed25519.getPublicKey(key),
				roomHeadAuthority: head,
				onAcceptedVertex: () => undefined,
				onProjection: () => undefined,
				openTransport: transport(author),
				signRegisteredVertexDigest: async (digest) => ed25519.sign(digest, key),
			});
			rooms.push(room);
			return { room, head };
		};
		let primary: unknown;
		let report: unknown;
		try {
			const first = await open("create");
			await first.room.issue(
				toCanvasWireOperation({ action: "paint", offset: [0, 0], rgb: [255, 7, 1] }, "independent-1")
			);
			await first.room.issue(
				toCanvasWireOperation({ action: "paint", offset: [0, 0], rgb: [255, 7, 1] }, "independent-2")
			);
			await first.room.issue(
				toCanvasWireOperation({ action: "splash", offset: [1, 0], size: [1, 2], rgb: [2, 3, 4] }, "splash-1")
			);
			const beforeSnapshot = first.room.projection().state;
			const sealed = await first.room.sealEpoch();
			if (!sealed.ok) throw new TypeError("genuine Canvas healthy seal refused");
			await first.room.adoptCreatorSuccessor();
			const afterSnapshot = first.room.projection().state;
			await first.room.issue(toCanvasWireOperation({ action: "paint", offset: [0, 0], rgb: [1, 2, 3] }, "current-1"));
			const beforeReopen = first.room.projection().state;
			await first.room.close();
			await first.head.close();
			const reopened = await open("reopen");
			const afterReopen = reopened.room.projection().state;
			await reopened.room.issue(
				toCanvasWireOperation({ action: "paint", offset: [1, 1], rgb: [3, 4, 5] }, "continued-1")
			);
			report = {
				beforeSnapshot,
				afterSnapshot,
				beforeReopen,
				afterReopen,
				continued: reopened.room.projection().state,
				color: descriptor.kernel.queryColor(afterReopen, 0, 0),
				authority: reopened.room.authority(),
			};
		} catch (error) {
			primary = error;
		}
		const roomOutcomes = await Promise.allSettled(rooms.map((room) => room.close()));
		const headOutcomes = await Promise.allSettled(heads.map((head) => head.close()));
		const errors = [...roomOutcomes, ...headOutcomes].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : []
		);
		if (primary !== undefined || errors.length !== 0)
			throw new AggregateError(
				primary === undefined ? errors : [primary, ...errors],
				"SHIPPED_CANVAS_PRIMARY_AND_CLEANUP"
			);
		return {
			report,
			joinedRooms: roomOutcomes.length,
			joinedHeads: headOutcomes.length,
			databases: (await indexedDB.databases()).flatMap(({ name }) => (name === undefined ? [] : [name])),
		};
	},
	startupShippedChat: async (identity: string, invite?: string) => {
		trace.length = 0;
		let created = invite;
		let primary: unknown;
		const roomHeadAuthority = await createBrowserRoomHeadAuthority({
			databaseName: identity + "--chat-room-head",
			initialization: { kind: invite === undefined ? "create" : "reopen" },
		});
		try {
			if (created === undefined)
				created = await chat.create({
					channelName: identity,
					clientId: "alice",
					databaseName: identity,
					roomHeadAuthority,
				});
			else
				await chat.join({
					channelName: identity,
					clientId: "alice",
					databaseName: identity,
					invite: created,
					roomHeadAuthority,
				});
			const before = chat.snapshot();
			await chat.send(invite === undefined ? "shipped-zero" : "shipped-continued");
			return { invite: created, before, after: chat.snapshot(), trace };
		} catch (error) {
			primary = error;
			throw error;
		} finally {
			await closeChatHead(roomHeadAuthority, primary);
		}
	},
	startupShippedMigration: async (identity: string) => {
		trace.length = 0;
		let primary: unknown;
		const roomHeadAuthority = await createBrowserRoomHeadAuthority({
			databaseName: identity + "--chat-room-head",
			initialization: { kind: "create" },
		});
		try {
			await chat.create({ channelName: identity, clientId: "alice", databaseName: identity, roomHeadAuthority });
			await chat.send("migration-zero");
			event("explicit-rehearsal-start");
			const receipt = await chat.rehearseMigration();
			event("explicit-activation-start");
			const activation = await chat.activateMigration(receipt);
			const before = chat.snapshot();
			await chat.send("migration-continued");
			return {
				receipt,
				activation,
				before,
				after: chat.snapshot(),
				trace,
				databases: (await indexedDB.databases())
					.map((x) => x.name)
					.filter((name): name is string => name !== undefined),
			};
		} catch (error) {
			primary = error;
			throw error;
		} finally {
			await closeChatHead(roomHeadAuthority, primary);
		}
	},
	startupShippedGrid: async (identity: string, invite?: string) => {
		trace.length = 0;
		let primary: unknown;
		const roomHeadAuthority = await createBrowserRoomHeadAuthority({
			databaseName: identity + "--grid-room-head",
			initialization: { kind: invite === undefined ? "create" : "reopen" },
		});
		const creator = node(identity),
			member = node(identity + "-member");
		const enrolled = createV3ZoneApi(
			member,
			() => undefined,
			() => {
				throw new TypeError("enrollment-only member never opens a room");
			}
		);
		const api = createV3ZoneApi(
			creator,
			() => event("grid-projection"),
			() => roomHeadAuthority
		);
		try {
			if (invite === undefined) await api.create(enrolled.snapshot().enrollment);
			else await api.join(invite);
			const before = api.snapshot();
			await api.placeBlock({
				id: invite === undefined ? "first" : "continued",
				kind: "stone",
				x: invite === undefined ? 1 : 2,
				y: 1,
			});
			return {
				invite: api.snapshot().invite,
				before,
				after: api.snapshot(),
				trace,
				databases: (await indexedDB.databases())
					.map((x) => x.name)
					.filter((name): name is string => name !== undefined),
			};
		} catch (error) {
			primary = error;
			throw error;
		} finally {
			await closeGridHead(api, enrolled, roomHeadAuthority, primary);
		}
	},
});
