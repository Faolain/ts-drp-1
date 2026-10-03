import { ed25519 } from "@noble/curves/ed25519.js";

import { authority } from "./floor.js";
import { event, trace } from "./observation.js";
import { hex, seed, transport } from "./room.js";
import { createV3ZoneApi } from "../../../examples/grid/src/v3-zone.js";
import "../../../examples/v3-chat/src/index.js";
import type { DRPNode } from "../../../packages/node/dist/src/index.js";

type Chat = {
	create(input: { channelName: string; clientId: "alice"; databaseName: string }): Promise<string>;
	join(input: { channelName: string; clientId: "alice"; databaseName: string; invite: string }): Promise<void>;
	send(text: string): Promise<void>;
	snapshot(): unknown;
	close(): Promise<void>;
	rehearseMigration(): Promise<unknown>;
	activateMigration(receipt: unknown): Promise<unknown>;
};
const chat = Reflect.get(globalThis, "d9336V3Chat") as Chat;
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
Object.assign(globalThis, {
	startupShippedChat: async (identity: string, invite?: string) => {
		trace.length = 0;
		let created = invite;
		try {
			if (created === undefined)
				created = await chat.create({ channelName: identity, clientId: "alice", databaseName: identity });
			else await chat.join({ channelName: identity, clientId: "alice", databaseName: identity, invite: created });
			const before = chat.snapshot();
			await chat.send(invite === undefined ? "shipped-zero" : "shipped-continued");
			return { invite: created, before, after: chat.snapshot(), trace };
		} finally {
			await chat.close();
		}
	},
	startupShippedMigration: async (identity: string) => {
		trace.length = 0;
		try {
			await chat.create({ channelName: identity, clientId: "alice", databaseName: identity });
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
		} finally {
			await chat.close();
		}
	},
	startupShippedGrid: async (identity: string, invite?: string) => {
		trace.length = 0;
		const creator = node(identity),
			member = node(identity + "-member");
		const enrolled = createV3ZoneApi(
			member,
			() => undefined,
			() => authority(identity + "--unused-member", "create")
		);
		const api = createV3ZoneApi(
			creator,
			() => event("grid-projection"),
			({ operation }) => authority(identity, operation === "create" ? "create" : "reopen")
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
		} finally {
			await api.close();
			await enrolled.close();
		}
	},
});
