/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing genuine native SDK fixture inference. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { createV3RoomCreatorInviteMaterial, createV3RoomSession, type V3RoomSession, waitForV3RoomStartupForDiagnostics } from "@ts-drp/node/v3-room";
import { createNodeRoomHeadAuthority } from "@ts-drp/storage-node/room-head";
import { createNodeV3RoomStorageHost } from "@ts-drp/storage-node/v3-room-host";
import { Message, MessageType, V3Envelope } from "@ts-drp/types";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { createNativeGameApplication, type GameKind, type GameProjection } from "./game-application.js";

const directories = new Set<string>(), rooms = new Set<V3RoomSession<GameProjection>>();
const accounts = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const leases = new Set<Awaited<ReturnType<ReturnType<typeof createNodeV3RoomStorageHost>["acquireLocalSession"]>>>();
const profile = Object.freeze({ slots: 2, storeScopes: 32, handles: 96 });
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("R11_REAL_GAME_FIXTURE_REQUIRED"); return value; }
afterEach(async () => {
	for (const room of rooms) await room.close(); rooms.clear();
	for (const lease of leases) await lease.close(); leases.clear();
	for (const account of accounts) await account.close(); accounts.clear();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.clear();
});
function physicalDirectoryCensus(directory: string) {
	const files = readdirSync(directory).sort().map(name => ({ name, bytes: statSync(join(directory, name)).size }));
	return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
function localFileImage(directory: string) {
	// Complete retained file bytes, including WAL/shm/coordination files. Never
	// printed: this is a no-effects assertion, not exported signing material.
	return encodeCanonical(readdirSync(directory).sort().map(name => ({ name, bytes: readFileSync(join(directory, name)) })));
}
function retainedDatabaseImage(directory: string) {
	return encodeCanonical(readdirSync(directory).filter(name => name.endsWith(".sqlite")).sort().map(name => {
		// As in the existing native lifecycle fixture, coordination databases
		// may hold native EXCLUSIVE transactions. Read full persisted bytes,
		// never introduce a competing SQLite reader or omit their state.
		if (/^\.r11-local-(?:slot|handle)-\d+\.sqlite$/u.test(name) || /\.session-\d+\.sqlite$/u.test(name))
			return { name, coordinationBytes: readFileSync(join(directory, name)) };
		const db = new DatabaseSync(join(directory, name), { readOnly: true });
		try {
			return { name, tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => {
				const escape = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
				const table = escape(row.name as string);
				const order = db.prepare(`PRAGMA table_info(${table})`).all().map(column => escape(column.name as string)).join(",");
				return { table: row.name, rows: db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() };
			}) };
		} finally { db.close(); }
	}));
}
function retainedStateImage(directory: string, accountDirectory: string) {
	// Finish test-only SQL observations before capturing physical bytes, so
	// their read transactions are not silently attributed to delayed work.
	const localDatabases = retainedDatabaseImage(directory), accountDatabases = retainedDatabaseImage(accountDirectory);
	return { localDatabases, accountDatabases, localFiles: localFileImage(directory), accountFiles: localFileImage(accountDirectory) };
}
function counts(directory: string, accountFilename: string) {
	const local = new DatabaseSync(join(directory, ".r11-local-sessions.sqlite"), { readOnly: true });
	const independent = new DatabaseSync(accountFilename, { readOnly: true });
	let logical: { declarations: unknown; localSlots: unknown; accountSlots: unknown; accountHeads: unknown; accountKeys: unknown };
	try {
		logical = { declarations: local.prepare("SELECT count(*) AS n FROM local_session_files").get()?.n,
			localSlots: local.prepare("SELECT count(*) AS n FROM local_session_slots").get()?.n,
			accountSlots: independent.prepare("SELECT count(*) AS n FROM room_session_slots").get()?.n,
			accountHeads: independent.prepare("SELECT count(*) AS n FROM room_session_heads").get()?.n,
			accountKeys: independent.prepare("SELECT count(*) AS n FROM room_session_slots WHERE seed IS NOT NULL OR public_key IS NOT NULL").get()?.n };
	} finally { local.close(); independent.close(); }
	const owned = physicalDirectoryCensus(directory), account = physicalDirectoryCensus(dirname(accountFilename));
	return { ...logical, files: owned.files.map(file => file.name), bytes: owned.bytes, ownedPhysicalFiles: owned.files,
		accountFiles: account.files.map(file => file.name), accountPhysicalFiles: account.files, accountBytes: account.bytes };
}

it.each(["fps", "chess"] as const)("R11 actual %s short games use native owned custody through legal play, reopen, ended-session drain and stale callback refusal", async (kind: GameKind) => {
	const root = required(process.env.R11_NATIVE_GAME_CATALOG_ROOT);
	const memoryObservations: { phase: string; session: number | null; bytes: ReturnType<typeof process.memoryUsage> }[] = [];
	const observeMemory = (phase: string, session: number | null): void => { memoryObservations.push({ phase, session, bytes: process.memoryUsage() }); };
	observeMemory("before-account-and-session-creation", null);
	const directory = mkdtempSync(join(tmpdir(), `r11-real-${kind}-owned-`)); directories.add(directory);
	const accountDirectory = mkdtempSync(join(tmpdir(), `r11-real-${kind}-account-`)); directories.add(accountDirectory);
	const accountFilename = join(accountDirectory, "account.sqlite");
	const account = createNodeRoomHeadAuthority({ filename: accountFilename, initialization: { kind: "create" }, disposableSessionProfile: profile }); accounts.add(account);
	const hostOptions = { directory, initialization: (): "create" => "create", localSessionSlots: profile.slots,
		localSessionStoreScopes: profile.storeScopes, localSessionHandles: profile.handles, localSessionAccount: account };
	const host = createNodeV3RoomStorageHost(hostOptions);
	let previousIncarnation = 0, previousSlot: number | undefined, terminalFiles: readonly string[] | undefined;
	const observations: ReturnType<typeof counts>[] = [];
	for (let ordinal = 0; ordinal < 3; ordinal++) {
		observeMemory("before-session-create", ordinal);
		const lease = await host.acquireLocalSession({ kind: "create" });
		leases.add(lease);
		const selected = await createNativeGameApplication({ kind, controller: lease.signing.author, catalogDirectory: join(root, `${kind}-catalog`) });
		const objectId = `creator:${hex(hashDomain("r11/actual-short-game/v1", new TextEncoder().encode(`${directory}/${ordinal}`))).slice(0, 32)}`;
		const author = lease.signing.author, signers = [{ publicKey: author, signerId: "creator" }];
		const acl = encodeCanonical({ epoch: 0, kind: "drp-v3-latched-acl", objectId, permissionless: false, version: 3,
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }] });
		const creatorInvite = await createV3RoomCreatorInviteMaterial({ blueprintDigest: selected.blueprintDigest, objectId,
			exactCanonicalApplicationStateBytes: selected.exactCanonicalGenesisStateBytes, exactCanonicalLatchedAclBytes: acl,
			exactCanonicalParametersCarrierBytes: encodeCanonical({ maxDependencies: 16, maxEpochBytes: 8388608, maxEpochVertices: 8192,
				maxPendingBytes: 16777216, maxPendingEntries: 4096, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 }),
			exactCanonicalProfileBytes: encodeCanonical({ cryptoSuiteId: "ed25519-sha256-v3", profileId: "creator-trusted-settlement-v1", quorum: 1, signers }),
			exactCanonicalSignerSetBytes: encodeCanonical(signers), ownedGenesis: { lease, roomHeadAuthority: lease.roomHeadAuthority } });
		let publications = 0, accepted = 0, transportClosed = false;
		let live: (message: Message) => void = () => undefined, retained: (message: Message) => void = () => undefined;
		const open = async (ownedLease: typeof lease) => {
			leases.add(ownedLease);
			const networkNode = fakeNetwork(`r11-real-${kind}-${ordinal}`, false);
			Reflect.set(networkNode, "publishMessage", () => { publications += 1; return Promise.resolve(true); });
			Reflect.set(networkNode, "gossipTopicFor", (message: Message) => message.objectId);
			const room = await createV3RoomSession({ application: selected.application, creatorInvite,
				createOperationAdmissionPolicy: selected.createOperationAdmissionPolicy,
				databaseName: `game-${ordinal}`, issuanceDatabaseName: `game-${ordinal}`, migrationDatabaseNamespace: `game-${ordinal}`,
				initialLogicalTime: 3, objectId, localSession: { lease: ownedLease }, roomHeadAuthority: ownedLease.roomHeadAuthority,
				onAcceptedVertex: (): void => { accepted += 1; }, onProjection: (): void => undefined,
				openTransport: () => ({ networkNode, close: (): void => { transportClosed = true; }, requestRetainedHistory: (): void => undefined,
					setIngressHandler: (_topic, onLive, onRetained): void => { live = onLive; retained = onRetained; },
					setRetainedPublisher: (): void => undefined, openEphemeral: (): never => { throw new TypeError("no realtime/device claim in native short-game case"); } }),
			}); rooms.add(room); await waitForV3RoomStartupForDiagnostics(room); return room;
		};
		let room = await open(lease); const selector = { ...required(room.localSession).selector };
		observeMemory("after-session-startup", ordinal);
		if (previousSlot !== undefined) expect(selector.slot).toBe(previousSlot);
		expect(selector.incarnation).toBeGreaterThan(previousIncarnation);
		const outbox = async () => {
			const alias = await host.acquireLocalSession({ kind: "reopen", selector });
			try { const issuance = await alias.storageHost.openIssuance(`game-${ordinal}`);
				try { return await issuance.readOutboxPage({ scope: { author, objectId }, limit: 128 }); }
				finally { await issuance.close(); }
			} finally { await alias.close(); }
		};
		const unchanged = async (operation: Readonly<Record<string, unknown>>) => {
			const beforeState = encodeCanonical(room.projection()), beforeRows = encodeCanonical(await outbox());
			const pub = publications, admitted = accepted;
			await expect(room.issue(operation)).rejects.toThrow();
			expect(encodeCanonical(room.projection())).toEqual(beforeState); expect(encodeCanonical(await outbox())).toEqual(beforeRows);
			expect(publications).toBe(pub); expect(accepted).toBe(admitted);
		};
		if (kind === "fps") {
			await unchanged({ action: "fpsMove", step: 0, forward: 100, turn: 0 });
			await unchanged({ action: "fpsShot", step: 0, claimedHit: true });
			await room.issue({ action: "fpsMove", step: 0, forward: 1, turn: 0 });
			expect(room.projection().game).toMatchObject({ step: 1, player: { x: 2, y: 2, heading: 0 } });
		} else {
			await unchanged({ action: "chessMove", ply: 0, from: "e2", to: "e5" });
			await unchanged({ action: "chessMove", ply: 0, from: "e7", to: "e5" });
			await room.issue({ action: "chessMove", ply: 0, from: "f2", to: "f3" });
			expect(room.projection().game).toMatchObject({ ply: 1, turn: -1, status: "playing" });
		}
		const persisted = encodeCanonical(room.projection());
		const persistedRows = await outbox();
		for (const row of persistedRows) expect(ed25519.verify(row.commit.envelope.signature, row.commit.envelope.digest,
			Uint8Array.from(Buffer.from(author, "hex")), { zip215: false })).toBe(true);
		await room.close(); rooms.delete(room);
		room = await open(await host.acquireLocalSession({ kind: "reopen", selector }));
		expect(encodeCanonical(room.projection())).toEqual(persisted);
		if (kind === "fps") {
			await unchanged({ action: "fpsMove", step: 0, forward: 0, turn: 1 }); // Conflicting carried identity, not a fresh move.
			await room.issue({ action: "fpsShot", step: 1 }); await room.issue({ action: "fpsShot", step: 2 });
			expect(room.projection().game).toMatchObject({ step: 3, status: "won", bot: { health: 0 }, player: { ammo: 1 } });
			await unchanged({ action: "fpsShot", step: 3 });
		} else {
			await unchanged({ action: "chessMove", ply: 0, from: "e2", to: "e4" }); // Conflicting carried identity after reopen.
			await room.issue({ action: "chessMove", ply: 1, from: "e7", to: "e5" });
			await room.issue({ action: "chessMove", ply: 2, from: "g2", to: "g4" });
			await room.issue({ action: "chessMove", ply: 3, from: "d8", to: "h4" });
			expect(room.projection().game).toMatchObject({ ply: 4, turn: 1, status: "checkmate", winner: -1 });
			const board = room.projection().game.board as string;
			expect(board[31]).toBe("q"); expect(board[59]).toBe(".");
			await unchanged({ action: "chessMove", ply: 4, from: "e1", to: "e2" });
		}
		const packetRow = required((await outbox()).at(-1));
		observeMemory("after-legal-game-completion-before-rollover", ordinal);
		const packet = Message.create({ objectId, sender: "delayed-original-peer", type: MessageType.MESSAGE_TYPE_V3_ENVELOPE,
			data: V3Envelope.encode({ canonicalPreimage: packetRow.commit.envelope.canonicalPreimageBytes, signature: packetRow.commit.envelope.signature }).finish() });
		const staleIssue = room.issue.bind(room), oldLive = live, oldRetained = retained;
		expect(await room.sealEpoch()).toMatchObject({ ok: true }); await room.adoptCreatorSuccessor();
		await unchanged(kind === "fps" ? { action: "fpsShot", step: 2 } : { action: "chessMove", ply: 3, from: "d8", to: "h4" });
		await required(room.localSession).retire(); rooms.delete(room);
		observeMemory("after-joined-terminal-cleanup", ordinal);
		expect(transportClosed).toBe(true); const pubs = publications, admits = accepted;
		const beforeDelayed = retainedStateImage(directory, accountDirectory);
		oldLive(packet); oldRetained(packet);
		// Observe both immediate queued microtasks and one genuine event-loop
		// turn; this does not pretend to join arbitrary future timers or jobs.
		await Promise.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
		expect(retainedStateImage(directory, accountDirectory)).toEqual(beforeDelayed);
		await expect(staleIssue(kind === "fps" ? { action: "fpsShot", step: 3 } : { action: "chessMove", ply: 4, from: "e1", to: "e2" })).rejects.toThrow();
		await expect(host.acquireLocalSession({ kind: "reopen", selector })).rejects.toThrow();
		expect(publications).toBe(pubs); expect(accepted).toBe(admits);
		const census = counts(directory, accountFilename); observations.push(census);
		expect(census.declarations).toBe(0); expect(census.localSlots).toBe(profile.slots); expect(census.accountSlots).toBe(profile.slots);
		expect(census.accountHeads).toBe(0); expect(census.accountKeys).toBe(0);
		expect(census.files.filter(name => /^\.r11-s\d+-i\d+-/u.test(name))).toEqual([]);
		terminalFiles ??= census.files; expect(census.files).toEqual(terminalFiles);
		observeMemory("end-session-after-delayed-work-assertions", ordinal);
		previousIncarnation = selector.incarnation; previousSlot = selector.slot;
	}
	observeMemory("end-all-terminal-sessions-before-test-only-teardown", null);
	process.stdout.write(JSON.stringify({ requirement: "R11 actual distinct game sessions", kind,
		workload: kind === "fps" ? "single-player bounded arena target match" : "orthodox Fool's Mate in authenticated hot-seat short chess", observations,
		memory: { observations: memoryObservations, scope: "local Vitest worker/process; includes runtime, compiler modules and test assertions/retained fixtures",
			peakMeasurement: false, forcedGc: false, postGcMeasurement: false, hardMemoryTarget: null, gamePerformanceEvidence: false },
		claims: { nativeProtocolLifecycle: true, multiplayer: false, realtimePerformance: false, renderedProduct: false, deviceAcceptance: false, hostRotation: false } }) + "\n");
}, 180000);
