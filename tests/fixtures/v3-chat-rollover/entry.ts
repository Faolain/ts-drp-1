import { createBrowserRoomHeadAuthority } from "@ts-drp/storage-browser/room-head";

import "../../../examples/v3-chat/src/index.js";

// The v3-chat demo as a page opens it: each client's room over its own browser room-head floor
// (created on a device's first open, reopened after), with the demo's default automatic rollover
// and successor delivery. No test override is set.

type Demo = Readonly<{
	create(input: Readonly<Record<string, unknown>>): Promise<string>;
	join(input: Readonly<Record<string, unknown>>): Promise<void>;
	send(text: string): Promise<void>;
	snapshot(): unknown;
	rollover(): unknown;
	close(): Promise<void>;
}>;

const demo = Reflect.get(globalThis, "d9336V3Chat") as Demo;
let head: Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>> | undefined;

async function openHead(
	databaseName: string,
	kind: "create" | "reopen"
): Promise<Awaited<ReturnType<typeof createBrowserRoomHeadAuthority>>> {
	head = await createBrowserRoomHeadAuthority({ databaseName: `${databaseName}--room-head`, initialization: { kind } });
	return head;
}

async function closeAll(): Promise<void> {
	try {
		await demo.close();
	} finally {
		await head?.close();
		head = undefined;
	}
}

Object.defineProperty(globalThis, "v3ChatRollover", {
	configurable: false,
	enumerable: true,
	value: Object.freeze({
		async create(input: Readonly<{ channelName: string; databaseName: string }>): Promise<string> {
			const roomHeadAuthority = await openHead(input.databaseName, "create");
			return demo.create({ ...input, clientId: "alice", roomHeadAuthority });
		},
		async join(
			input: Readonly<{ channelName: string; clientId: string; databaseName: string; invite: string }>,
			kind: "create" | "reopen"
		): Promise<void> {
			const roomHeadAuthority = await openHead(input.databaseName, kind);
			await demo.join({ ...input, roomHeadAuthority });
		},
		send: (text: string): Promise<void> => demo.send(text),
		snapshot: (): unknown => demo.snapshot(),
		rollover: (): unknown => demo.rollover(),
		close: closeAll,
	}),
	writable: false,
});
