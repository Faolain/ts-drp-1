// Existing native IPC/SIGKILL pattern, applied to the actual SDK terminal path.
// Hooks execute the real durable commit/unlink first; they grant no authority.
import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { decodeCanonical } from "@ts-drp/canonical";
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import type { DRPNetworkNode } from "@ts-drp/types";
import { createShippingV3ChatApplication } from "../../examples/chat/src/v3-chat-application.js";
import { createV3RoomSession, waitForV3RoomStartupForDiagnostics } from "../../packages/node/src/v3-room.js";
import { createNodeRoomHeadAuthority } from "../../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../../packages/storage-node/src/v3-room-host.js";

type ReopenInput = {
	directory: string; accountFilename: string; catalogDirectory: string;
	disposableSessionProfile: { slots: number; storeScopes: number; handles: number };
	selector: { slot: number; incarnation: number }; creatorInvite: string;
	databaseName: string; issuanceDatabaseName: string; migrationDatabaseNamespace: string;
	objectId: string; blueprintDigest: string; exactCanonicalGenesisLatchedAclBytes: Uint8Array;
};
const [, , inputFilename, checkpoint] = process.argv;
if (inputFilename === undefined || !["after-terminal-preparation", "after-independent-fence", "after-local-key-retirement", "after-first-owned-unlink"].includes(checkpoint ?? ""))
	throw new Error("R11_TERMINAL_CRASH_ARGUMENTS_REQUIRED");
const input = decodeCanonical(readFileSync(inputFilename)) as ReopenInput;
let terminalEntered = false, stopped = false;
function stop(): never {
	stopped = true;
	if (typeof process.send !== "function") throw new Error("R11_CRASH_IPC_REQUIRED");
	process.send({ kind: "checkpoint", checkpoint });
	process.kill(process.pid, "SIGSTOP");
	throw new Error("R11_CRASH_CHILD_MUST_NOT_RESUME");
}
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql: string): void {
	originalExec.call(this, sql);
	if (!terminalEntered || stopped || sql !== "COMMIT") return;
	let reached = false;
	try {
		if (checkpoint === "after-terminal-preparation")
			reached = this.prepare("SELECT 1 FROM local_session_terminal t JOIN local_session_slots s USING(slot,incarnation) WHERE t.slot=? AND t.incarnation=? AND s.status='active'").get(input.selector.slot, input.selector.incarnation) !== undefined;
		if (checkpoint === "after-independent-fence")
			reached = this.prepare("SELECT status FROM room_session_slots WHERE slot=? AND incarnation=?").get(input.selector.slot, input.selector.incarnation)?.status === "retiring";
		if (checkpoint === "after-local-key-retirement") {
			const row = this.prepare("SELECT status,key_retired FROM local_session_slots WHERE slot=? AND incarnation=?").get(input.selector.slot, input.selector.incarnation);
			reached = row?.status === "retiring" && row.key_retired === 1;
		}
	} catch { /* Another original native database, not the selected checkpoint. */ }
	if (reached) stop();
};
const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const originalUnlink = fs.unlinkSync;
fs.unlinkSync = (filename): void => {
	originalUnlink(filename);
	const selected = String(filename);
	if (terminalEntered && !stopped && checkpoint === "after-first-owned-unlink" &&
		selected.startsWith(input.directory + "/.r11-s") && selected.endsWith(".sqlite")) stop();
};
syncBuiltinESMExports();

const profile = input.disposableSessionProfile;
const account = createNodeRoomHeadAuthority({ filename: input.accountFilename, initialization: { kind: "reopen" }, disposableSessionProfile: profile });
const host = createNodeV3RoomStorageHost({ directory: input.directory, initialization: () => "reopen",
	localSessionSlots: profile.slots, localSessionStoreScopes: profile.storeScopes, localSessionHandles: profile.handles, localSessionAccount: account });
const lease = await host.acquireLocalSession({ kind: "reopen", selector: input.selector });
const catalog = openTrustedBlueprintCatalog({ catalogDirectory: input.catalogDirectory });
const application = await createShippingV3ChatApplication({ catalog, blueprintDigest: input.blueprintDigest,
	exactCanonicalGenesisLatchedAclBytes: input.exactCanonicalGenesisLatchedAclBytes });
// Same local no-network transport premise as the existing native room fixture.
// No receipt, signing, native storage or disposition capability is substituted.
const topics = new Set<string>();
const networkNode = { peerId: "r11-terminal-crash-child", membershipVerifier: undefined,
	start: async () => undefined, stop: async () => undefined, restart: async () => undefined,
	isDialable: async () => true, changeTopicScoreParams: () => undefined, removeTopicScoreParams: () => undefined,
	subscribe: (topic: string) => topics.add(topic), unsubscribe: (topic: string) => topics.delete(topic),
	connectToBootstraps: async () => undefined, connect: async () => undefined, disconnect: async () => undefined,
	getPeerMultiaddrs: async () => [], getBootstrapNodes: () => [], getSubscribedTopics: () => [...topics],
	getMultiaddrs: () => ["/ip4/127.0.0.1/tcp/1"], getAllPeers: () => [], getGroupPeers: () => [],
	broadcastMessage: async () => undefined, publishMessage: async () => true, sendMessage: async () => undefined,
	sendMessageToRandomPeer: async () => undefined, sendGroupMessage: async () => undefined,
	subscribeToMessageQueue: () => undefined, onGroupPeerChange: () => () => undefined,
	gossipTopicFor: (packet: { objectId: string }) => packet.objectId,
} as unknown as DRPNetworkNode;
const room = await createV3RoomSession({ application, creatorInvite: input.creatorInvite,
	createOperationAdmissionPolicy: application.createOperationAdmissionPolicy,
	databaseName: input.databaseName, issuanceDatabaseName: input.issuanceDatabaseName,
	migrationDatabaseNamespace: input.migrationDatabaseNamespace, initialLogicalTime: 3, objectId: input.objectId,
	localSession: { lease }, roomHeadAuthority: lease.roomHeadAuthority,
	onAcceptedVertex: () => undefined, onProjection: () => undefined,
	openTransport: () => ({ networkNode, close: () => undefined, requestRetainedHistory: () => undefined,
		setIngressHandler: () => undefined, setRetainedPublisher: () => undefined,
		openEphemeral: (): never => { throw new Error("ephemeral not exercised"); } }),
});
await waitForV3RoomStartupForDiagnostics(room);
if (room.localSession === undefined) throw new Error("R11_TERMINAL_CONTROL_REQUIRED");
terminalEntered = true;
await room.localSession.retire();
throw new Error("R11_TERMINAL_CRASH_CHECKPOINT_NOT_REACHED");
