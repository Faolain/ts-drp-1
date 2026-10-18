/* eslint-disable @typescript-eslint/explicit-function-return-type -- Existing native SDK fixture inference. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { openTrustedBlueprintCatalog } from "@ts-drp/blueprint-catalog";
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type * as Finality from "@ts-drp/keychain/finality";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { createShippingChatGenesisStateBytes, createShippingV3ChatApplication, type ShippingChatProjection } from "../examples/chat/src/v3-chat-application.js";
import { createV3RoomCreatorInviteMaterial, createV3RoomSession, type V3RoomSession, waitForV3RoomStartupForDiagnostics } from "../packages/node/src/v3-room.js";
import type { V3RoomLocalSessionSelector } from "../packages/node/src/v3-room-host.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";
import { createSqliteAheDurableStore } from "../packages/storage-node/src/index.js";
import { createNodeDurableIssuanceStore } from "../packages/storage-node/src/issuance.js";
import { createNodeDurableLiveJournalStore } from "../packages/storage-node/src/live-journal.js";
import { createNodeSnapshotQuarantineStore } from "../packages/storage-node/src/snapshot-transfer.js";
import { openNodeSealVoteStore } from "../packages/storage-node/src/seal-vote.js";
import { openNodeSealEvidenceStore } from "../packages/storage-node/src/seal-evidence.js";
import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";

// Pause only the existing registered, context-bound seal request. The actual
// codec, signer, cryptography, floors and native reservations remain intact.
const finalityBoundary = vi.hoisted(() => ({ pause: undefined as Promise<void> | undefined,
	entered: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined }));
vi.mock("@ts-drp/keychain/finality", async importOriginal => {
	const actual = await importOriginal<typeof Finality>();
	return { ...actual, signSealRegisteredDigest: async (input: Parameters<typeof actual.signSealRegisteredDigest>[0]) => {
		const pause = finalityBoundary.pause;
		if (pause !== undefined) { finalityBoundary.entered?.(); await pause; }
		return actual.signSealRegisteredDigest(input);
	} };
});

// Genuine native regressions for the approved disposable-session contract.
// Acceptance belongs to pinned execution results, not this source alone.
// No account key, raw-digest fallback or deletion grant is fabricated.
const directories = new Set<string>();
const rooms = new Set<V3RoomSession<ShippingChatProjection>>();
const leases = new Set<Awaited<ReturnType<ReturnType<typeof createNodeV3RoomStorageHost>["acquireLocalSession"]>>>();
const accounts = new Set<ReturnType<typeof createNodeRoomHeadAuthority>>();
const limits = Object.freeze({ slots: 2, storeScopes: 32, handles: 96 });
const main = resolve(import.meta.dirname, "..");
const candidate = main;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("R11_DISPOSABLE_FIXTURE_REQUIRED"); return value; }
const message = (id: string) => ({ action: "message", clientOperationId: id, displayTimeMs: 1791662400000, text: `owned disposable ${id}` });
function control(room: V3RoomSession<ShippingChatProjection>) { return required(room.localSession); }

function logicalDatabaseImage(filename: string) {
	const db = new DatabaseSync(filename, { readOnly: true });
	try {
		return encodeCanonical(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => {
			const escape = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
			const table = escape(row.name as string);
			const order = db.prepare(`PRAGMA table_info(${table})`).all().map(column => escape(column.name as string)).join(",");
			return { table: row.name, rows: db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() };
		}));
	} finally { db.close(); }
}
function ownedImage(directory: string) {
	return encodeCanonical(readdirSync(directory).sort().map(name => ({ name, bytes: readFileSync(join(directory, name)) })));
}
function census(directory: string, accountFilename: string) {
	const local = new DatabaseSync(join(directory, ".r11-local-sessions.sqlite"), { readOnly: true });
	const account = new DatabaseSync(accountFilename, { readOnly: true });
	try {
		return {
			localSlots: local.prepare("SELECT count(*) AS n FROM local_session_slots").get()?.n,
			localDeclarations: local.prepare("SELECT count(*) AS n FROM local_session_files").get()?.n,
			accountSlots: account.prepare("SELECT count(*) AS n FROM room_session_slots").get()?.n,
			accountHeads: account.prepare("SELECT count(*) AS n FROM room_session_heads").get()?.n,
			accountKeys: account.prepare("SELECT count(*) AS n FROM room_session_slots WHERE seed IS NOT NULL OR public_key IS NOT NULL").get()?.n,
			localFiles: readdirSync(directory).sort(),
			localBytes: readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0),
			accountBytes: statSync(accountFilename).size,
			accountPhysicalFiles: readdirSync(dirname(accountFilename)).sort().map(name => ({ name, bytes: statSync(join(dirname(accountFilename), name)).size })),
		};
	} finally { local.close(); account.close(); }
}

afterEach(async () => {
	finalityBoundary.release?.(); finalityBoundary.pause = undefined; finalityBoundary.entered = undefined; finalityBoundary.release = undefined;
	for (const room of rooms) await room.close(); rooms.clear();
	for (const lease of leases) await lease.close(); leases.clear();
	for (const account of accounts) await account.close(); accounts.clear();
	// Test-only disposal of explicitly tracked mkdtemp roots, never product cleanup.
	for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.clear();
});

export async function createDisposableNativeFixture() {
	const catalog = openTrustedBlueprintCatalog({ catalogDirectory: required(process.env.SHIPPING_CHAT_CATALOG_DIR) });
	expect(catalog.blueprintDigests).toHaveLength(1);
	const blueprintDigest = required(catalog.blueprintDigests[0]);
	const directory = mkdtempSync(join(tmpdir(), "r11-disposable-owned-")); directories.add(directory);
	// Physically independent of the only root eligible for terminal cleanup or
	// malicious backup restoration. Never rolled back with the session files.
	const accountDirectory = mkdtempSync(join(tmpdir(), "r11-independent-account-")); directories.add(accountDirectory);
	const accountFilename = join(accountDirectory, "session-account.sqlite");
	let account = createNodeRoomHeadAuthority({ filename: accountFilename, initialization: { kind: "create" }, disposableSessionProfile: limits });
	accounts.add(account);
	const options = { directory, initialization: (): "create" => "create", localSessionSlots: limits.slots,
		localSessionStoreScopes: limits.storeScopes, localSessionHandles: limits.handles, localSessionAccount: account };
	let host = createNodeV3RoomStorageHost(options);
	let publicationAllowed = true;
	let publications = 0;
	async function material(label: string) {
		const lease = await host.acquireLocalSession({ kind: "create" }); leases.add(lease);
		const author = lease.signing.author;
		const objectId = `creator:${hex(hashDomain("r11/disposable-room/v1", new TextEncoder().encode(`${directory}/${label}`))).slice(0, 32)}`;
		const acl = encodeCanonical({ epoch: 0, kind: "drp-v3-latched-acl", objectId, permissionless: false, version: 3,
			members: [{ author, finalityKey: author, groups: ["admin", "finality", "writer"] }] });
		const application = await createShippingV3ChatApplication({ catalog, blueprintDigest, exactCanonicalGenesisLatchedAclBytes: acl });
		const signers = [{ publicKey: author, signerId: "creator" }];
		const invite = await createV3RoomCreatorInviteMaterial({ blueprintDigest, objectId,
			exactCanonicalApplicationStateBytes: createShippingChatGenesisStateBytes({ exactCanonicalLatchedAclBytes: acl }),
			exactCanonicalLatchedAclBytes: acl,
			exactCanonicalParametersCarrierBytes: encodeCanonical({ maxDependencies: 16, maxEpochBytes: 8388608, maxEpochVertices: 8192,
				maxPendingBytes: 16777216, maxPendingEntries: 4096, maxSnapshotBytes: 268435456, snapshotChunkBytes: 131072 }),
			exactCanonicalProfileBytes: encodeCanonical({ cryptoSuiteId: "ed25519-sha256-v3", profileId: "creator-trusted-settlement-v1", quorum: 1, signers }),
			exactCanonicalSignerSetBytes: encodeCanonical(signers),
			ownedGenesis: { lease, roomHeadAuthority: lease.roomHeadAuthority },
		});
		return { label, lease, author, objectId, application, invite };
	}
	async function open(selected: Awaited<ReturnType<typeof material>>, selector?: V3RoomLocalSessionSelector) {
		const lease = selector === undefined ? selected.lease : await host.acquireLocalSession({ kind: "reopen", selector });
		leases.add(lease);
		const networkNode = fakeNetwork(`r11-disposable-${selected.label}`, false);
		Reflect.set(networkNode, "publishMessage", () => { publications += 1; return Promise.resolve(publicationAllowed); });
		Reflect.set(networkNode, "gossipTopicFor", (packet: { objectId: string }) => packet.objectId);
		const room = await createV3RoomSession({ application: selected.application, creatorInvite: selected.invite,
			createOperationAdmissionPolicy: selected.application.createOperationAdmissionPolicy,
			databaseName: selected.label, issuanceDatabaseName: selected.label, migrationDatabaseNamespace: selected.label,
			initialLogicalTime: 3, objectId: selected.objectId, localSession: { lease }, roomHeadAuthority: lease.roomHeadAuthority,
			onAcceptedVertex: (): void => undefined, onProjection: (): void => undefined,
			openTransport: () => ({ networkNode, close: (): void => undefined, requestRetainedHistory: (): void => undefined,
				setIngressHandler: (): void => undefined, setRetainedPublisher: (): void => undefined,
				openEphemeral: (): never => { throw new TypeError("ephemeral not exercised"); } }),
		});
		rooms.add(room); await waitForV3RoomStartupForDiagnostics(room); return { room, lease };
	}
	async function outbox(selected: Awaited<ReturnType<typeof material>>, selector: V3RoomLocalSessionSelector) {
		const alias = await host.acquireLocalSession({ kind: "reopen", selector });
		try { const store = await alias.storageHost.openIssuance(selected.label);
			try { return await store.readOutboxPage({ scope: { author: selected.author, objectId: selected.objectId }, limit: 128 }); }
			finally { await store.close(); }
		} finally { await alias.close(); }
	}
	async function close(room: V3RoomSession<ShippingChatProjection>) { await room.close(); rooms.delete(room); }
	// Plain existing-API inputs for a separately materialized real process-death
	// child. Root may relocate this helper; importing this test is not a launcher.
	const persistedReopenInput = (selected: Awaited<ReturnType<typeof material>>, selector: V3RoomLocalSessionSelector, invite: string) => ({
		directory, accountFilename, catalogDirectory: required(process.env.SHIPPING_CHAT_CATALOG_DIR),
		disposableSessionProfile: limits, selector: { ...selector }, creatorInvite: invite,
		databaseName: selected.label, issuanceDatabaseName: selected.label, migrationDatabaseNamespace: selected.label,
		objectId: selected.objectId, blueprintDigest, author: selected.author,
		exactCanonicalGenesisLatchedAclBytes: Uint8Array.from(selected.invite.exactCanonicalLatchedAclBytes),
	});
	async function closeIndependentOwner() { await account.close(); accounts.delete(account); }
	async function reopenIndependentOwner() {
		await closeIndependentOwner();
		account = createNodeRoomHeadAuthority({ filename: accountFilename, initialization: { kind: "reopen" }, disposableSessionProfile: limits });
		accounts.add(account); options.localSessionAccount = account; host = createNodeV3RoomStorageHost(options);
	}
	return { directory, accountDirectory, accountFilename, get account() { return account; }, options, get host() { return host; }, material, open, outbox, close, persistedReopenInput,
		closeIndependentOwner, reopenIndependentOwner,
		setPublicationAllowed: (allowed: boolean): void => { publicationAllowed = allowed; }, publicationCount: (): number => publications };
}

async function unguardedAliasesRefuse(directory: string, selector: V3RoomLocalSessionSelector, accountFilename: string) {
	const db = new DatabaseSync(join(directory, ".r11-local-sessions.sqlite"), { readOnly: true });
	let declarations: { family: string; digest: string }[];
	try { declarations = db.prepare("SELECT family,digest FROM local_session_files WHERE slot=? AND incarnation=? AND installed=1 ORDER BY family,digest LIMIT ?")
		.all(selector.slot, selector.incarnation, limits.storeScopes + 1) as typeof declarations; }
	finally { db.close(); }
	expect(declarations.length).toBeLessThanOrEqual(limits.storeScopes);
	const names = readdirSync(directory);
	const filename = (family: string): string => {
		const entry = required(declarations.find(row => row.family === family));
		const suffix = family === "issuance" ? ".drp-issuance-v1.sqlite" : family === "journal" ? ".drp-live-journal-v1.sqlite" : family === "snapshots" ? ".drp-snapshot-quarantine-v1.sqlite" : "";
		// Resolve actual installed files from the real catalog digest, rather than
		// guessing which incarnation or alternate native authority is current.
		const primaries = names.filter(name => name.endsWith(`-${family}-${entry.digest}.sqlite${suffix}`));
		expect(primaries).toHaveLength(1);
		const actual = join(directory, required(primaries[0]));
		return suffix === "" ? actual : actual.slice(0, -suffix.length);
	};
	const ahe = filename("ahe"), issuance = filename("issuance"), journal = filename("journal"), snapshots = filename("snapshots"), signing = filename("signing");
	const before = ownedImage(directory), accountBefore = logicalDatabaseImage(accountFilename);
	const openers = [
		() => createSqliteAheDurableStore({ filename: ahe, initialization: "reopen" }),
		() => createNodeDurableIssuanceStore({ primaryFilename: issuance, initialization: "reopen" }),
		() => createNodeDurableLiveJournalStore({ primaryFilename: journal, initialization: "reopen" }),
		() => createNodeSnapshotQuarantineStore({ primaryFilename: snapshots, initialization: "reopen" }),
		() => openNodeSealVoteStore({ filename: signing, initialization: "reopen" }),
		() => openNodeSealEvidenceStore({ filename: signing, initialization: "reopen" }),
	];
	for (const open of openers) {
		let unexpected: Awaited<ReturnType<typeof open>> | undefined;
		try { await expect(Promise.resolve().then(async () => { unexpected = await open(); })).rejects.toThrow(); }
		finally { await unexpected?.close(); }
		expect(ownedImage(directory)).toEqual(before); expect(logicalDatabaseImage(accountFilename)).toEqual(accountBefore);
	}
}

it("R11 disposable: nonempty authenticated create, ordinary reopen, terminal drain and distinct replacement keep total identity state finite", async () => {
	const f = await createDisposableNativeFixture(); let previous: V3RoomLocalSessionSelector | undefined;
	let terminalFiles: readonly string[] | undefined;
	const observations: ReturnType<typeof census>[] = [];
	const resources: unknown[] = [];
	for (let ordinal = 0; ordinal < 4; ordinal++) {
		const selected = await f.material(`session-${ordinal}`);
		let active = await f.open(selected); const selector = { ...control(active.room).selector };
		if (previous !== undefined) { expect(selector.slot).toBe(previous.slot); expect(selector.incarnation).toBeGreaterThan(previous.incarnation); }
		await active.room.issue(message(`before-${ordinal}`));
		const projection = encodeCanonical(active.room.projection());
		const before = await f.outbox(selected, selector);
		for (const row of before) expect(ed25519.verify(row.commit.envelope.signature, row.commit.envelope.digest,
			Uint8Array.from(Buffer.from(selected.author, "hex")), { zip215: false })).toBe(true);
		await f.close(active.room);
		if (ordinal === 0) await unguardedAliasesRefuse(f.directory, selector, f.accountFilename);
		active = await f.open(selected, selector);
		expect(encodeCanonical(active.room.projection())).toEqual(projection);
		expect(encodeCanonical((await f.outbox(selected, selector)).map(row => row.commit))).toEqual(encodeCanonical(before.map(row => row.commit)));
		await active.room.issue(message(`continued-${ordinal}`)); expect(active.room.projection().messages).toHaveLength(2);
		// Healthy rollover, not forced recreation/copying. The terminal owner must
		// lawfully withdraw only this ended local claim, including its usable window.
		expect(await active.room.sealEpoch()).toMatchObject({ ok: true }); await active.room.adoptCreatorSuccessor();
		const staleIssue = active.room.issue.bind(active.room);
		await control(active.room).retire(); rooms.delete(active.room);
		await expect(staleIssue(message(`retired-${ordinal}`))).rejects.toThrow();
		await expect(f.host.acquireLocalSession({ kind: "reopen", selector })).rejects.toThrow();
		const observed = census(f.directory, f.accountFilename); observations.push(observed);
		expect(observed.localSlots).toBe(limits.slots); expect(observed.accountSlots).toBe(limits.slots);
		expect(observed.localDeclarations).toBe(0); expect(observed.accountHeads).toBe(0); expect(observed.accountKeys).toBe(0);
		expect(observed.localFiles.filter(name => /^\.r11-s\d+-i\d+-/u.test(name))).toEqual([]);
		terminalFiles ??= observed.localFiles; expect(observed.localFiles).toEqual(terminalFiles);
		expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)).toMatchObject({ ...selector, status: "free" });
		// Separate actual quiescent storage and test-only GC from live-provider
		// WAL observations. Reopen the SAME independent authority afterward; this
		// is not a reset of its authenticated monotone incarnation state.
		await f.closeIndependentOwner();
		const accountFiles = readdirSync(f.accountDirectory).sort().map(name => ({ name, bytes: statSync(join(f.accountDirectory, name)).size }));
		const beforeGc = process.memoryUsage(), gcStarted = performance.now();
		const gc = Reflect.get(globalThis, "gc") as (() => void) | undefined;
		if (typeof gc === "function") { gc(); await new Promise<void>(resolve => setImmediate(resolve)); gc(); }
		resources.push({ session: ordinal, accountFiles, accountBytes: accountFiles.reduce((sum, file) => sum + file.bytes, 0),
			beforeGc, postGc: typeof gc === "function" ? process.memoryUsage() : null, testOnlyGcMs: typeof gc === "function" ? performance.now() - gcStarted : null,
			postGcExecuted: typeof gc === "function",
			qualification: "local native test worker; closed stale leases remain retained by this test, not a hard-memory or gameplay target" });
		await f.reopenIndependentOwner();
		previous = selector;
	}
	// Actual byte observations, not an invented hard-memory/storage threshold.
	process.stdout.write(JSON.stringify({ requirement: "R11.1/R11.3", observations, resources }) + "\n");
}, 120000);

it("R11 disposable: restoring old owned files cannot reactivate a retired incarnation while independent account freshness survives", async () => {
	const f = await createDisposableNativeFixture(), selected = await f.material("restore-old");
	let active = await f.open(selected); const selector = { ...control(active.room).selector };
	await active.room.issue(message("before-backup")); await f.close(active.room);
	// This is a deliberate old-backup negative, not a healthy transfer shortcut.
	const backup = mkdtempSync(join(tmpdir(), "r11-malicious-owned-backup-")); directories.add(backup);
	for (const name of readdirSync(f.directory)) cpSync(join(f.directory, name), join(backup, name), { preserveTimestamps: true });
	active = await f.open(selected, selector);
	await control(active.room).retire(); rooms.delete(active.room);
	const accountBefore = logicalDatabaseImage(f.accountFilename), sessionsBefore = f.account.inspectDisposableSessions();
	// Restore ONLY the exact tracked owned directory; the independent account
	// key/floor database and its WAL are deliberately outside this operation.
	for (const name of readdirSync(f.directory)) rmSync(join(f.directory, name), { force: true });
	for (const name of readdirSync(backup)) cpSync(join(backup, name), join(f.directory, name), { preserveTimestamps: true });
	const restored = ownedImage(f.directory);
	const restoredHost = createNodeV3RoomStorageHost(f.options);
	await expect(restoredHost.acquireLocalSession({ kind: "reopen", selector })).rejects.toThrow();
	expect(ownedImage(f.directory)).toEqual(restored);
	expect(logicalDatabaseImage(f.accountFilename)).toEqual(accountBefore);
	expect(f.account.inspectDisposableSessions()).toEqual(sessionsBefore);
	await expect(selected.lease.signing.signRequest({} as never)).rejects.toThrow();
	expect(logicalDatabaseImage(f.accountFilename)).toEqual(accountBefore);
}, 60000);

it("R11 disposable: pending publication prevents terminal fencing while normal publication and continued gameplay remain possible", async () => {
	const f = await createDisposableNativeFixture(), selected = await f.material("pending-debt"), active = await f.open(selected);
	const selector = { ...control(active.room).selector };
	f.setPublicationAllowed(false);
	// Publication may fail after durable issue; inspect the genuine native row,
	// rather than treating a rejected Promise alone as proof of protected debt.
	await active.room.issue(message("owed-publication")).catch(() => undefined);
	const debt = await f.outbox(selected, selector);
	expect(debt.some(row => row.publishState === "pending")).toBe(true);
	const commits = encodeCanonical(debt.map(row => row.commit));
	const accountBefore = logicalDatabaseImage(f.accountFilename), sessionsBefore = await f.host.inspectLocalSessions();
	await expect(control(active.room).retire()).rejects.toThrow();
	expect(logicalDatabaseImage(f.accountFilename)).toEqual(accountBefore);
	expect(await f.host.inspectLocalSessions()).toEqual(sessionsBefore);
	expect(encodeCanonical((await f.outbox(selected, selector)).map(row => row.commit))).toEqual(commits);
	expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)).toMatchObject({ ...selector, status: "active" });
	// The rejected cleanup is not terminal: publication recovers normally and
	// the same admitted incarnation remains useful without reclassification.
	f.setPublicationAllowed(true);
	await active.room.issue(message("after-refused-cleanup")); expect(active.room.projection().messages).toHaveLength(2);
	expect((await f.outbox(selected, selector)).every(row => row.publishState === "published")).toBe(true);
	await control(active.room).retire(); rooms.delete(active.room);
	await expect(f.host.acquireLocalSession({ kind: "reopen", selector })).rejects.toThrow();
}, 60000);

it("R11 disposable: uncovered native custody and caller-authored disposition refuse before effects while admitted gameplay remains usable", async () => {
	const f = await createDisposableNativeFixture(), selected = await f.material("uncovered-native"), active = await f.open(selected);
	await active.room.issue(message("before-uncovered-native"));
	const selector = { ...control(active.room).selector };
	const extra = await active.lease.storageHost.openAhe("uncovered-native-port");
	try {
		const accountBefore = logicalDatabaseImage(f.accountFilename), ownedBefore = ownedImage(f.directory), stateBefore = encodeCanonical(active.room.projection());
		await expect(active.lease.retire({ join: async () => undefined, disposition: {} })).rejects.toThrow("LOCAL_SESSION_PROTOCOL_DISPOSITION_REQUIRED");
		await expect(control(active.room).retire()).rejects.toThrow();
		expect(Buffer.from(logicalDatabaseImage(f.accountFilename)).equals(Buffer.from(accountBefore))).toBe(true);
		expect(Buffer.from(ownedImage(f.directory)).equals(Buffer.from(ownedBefore))).toBe(true);
		expect(encodeCanonical(active.room.projection())).toEqual(stateBefore);
		expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)?.status).toBe("active");
		await active.room.issue(message("after-uncovered-native"));
		expect(active.room.projection().messages).toHaveLength(2);
		// Unknown/uncovered scope is retained, not silently abandoned or granted
		// deletion by a caller callback. Test-only teardown is not product cleanup.
		expect(census(f.directory, f.accountFilename).localDeclarations).toBeGreaterThan(0);
	} finally { await extra.close(); }
}, 90000);

it("R11 disposable: admitted genuine finality signing prevents early withdrawal and completes before lawful terminal cleanup", async () => {
	const f = await createDisposableNativeFixture(), selected = await f.material("joined-finality"), active = await f.open(selected);
	await active.room.issue(message("before-joined-finality"));
	let entered!: () => void, release!: () => void;
	const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
	finalityBoundary.pause = new Promise<void>(resolve => { release = resolve; });
	finalityBoundary.entered = entered; finalityBoundary.release = release;
	const sealing = active.room.sealEpoch();
	const sealOutcome = sealing.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
	await enteredPromise;
	const selector = { ...control(active.room).selector }, accountBefore = logicalDatabaseImage(f.accountFilename);
	let terminalOutcome: Readonly<{ ok: boolean; error?: unknown }> | undefined;
	const retiring = control(active.room).retire().then(() => { terminalOutcome = { ok: true }; }, error => { terminalOutcome = { ok: false, error }; });
	try {
		// The existing FIFO lifetime owner waits for the admitted seal; it is not
		// required to reject synchronously. Do not await that join while keeping
		// its genuine signing continuation paused by this test.
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(terminalOutcome).toBeUndefined();
		expect(logicalDatabaseImage(f.accountFilename)).toEqual(accountBefore);
		expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)?.status).toBe("active");
	} finally { release(); finalityBoundary.pause = undefined; finalityBoundary.entered = undefined; finalityBoundary.release = undefined; }
	const outcome = await sealOutcome;
	if (!outcome.ok) throw outcome.error;
	expect(outcome.value).toMatchObject({ ok: true });
	await retiring;
	// Sealing creates a real promised successor. Until adoption settles it the
	// protected planner must refuse withdrawal, not erase that obligation.
		expect(terminalOutcome?.ok).toBe(false);
		expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)?.status).toBe("active");
	await active.room.adoptCreatorSuccessor();
	await active.room.issue(message("after-joined-finality"));
	expect(active.room.projection().messages).toHaveLength(2);
	await control(active.room).retire(); rooms.delete(active.room);
	const observed = census(f.directory, f.accountFilename);
	expect(observed.localDeclarations).toBe(0); expect(observed.accountHeads).toBe(0); expect(observed.accountKeys).toBe(0);
}, 90000);

it("R11 disposable: genuine admitted alias read blocks premature fencing and native custody blocks deletion until joined release", async () => {
	const f = await createDisposableNativeFixture(), selected = await f.material("joined-alias");
	const active = await f.open(selected), selector = { ...control(active.room).selector };
	await active.room.issue(message("joined-alias"));
	const alias = await f.host.acquireLocalSession({ kind: "reopen", selector }); leases.add(alias);
	const store = await alias.storageHost.openAhe(`${selected.label}--ahe`);
	const held = await store.acquireNativeReadReservation({ objectId: selected.objectId });
	try {
		await held.check();
		const before = logicalDatabaseImage(f.accountFilename), projection = encodeCanonical(active.room.projection());
		await expect(control(active.room).retire()).rejects.toThrow();
		expect(logicalDatabaseImage(f.accountFilename)).toEqual(before);
		expect(encodeCanonical(active.room.projection())).toEqual(projection);
		expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)?.status).toBe("active");
	} finally { await held.release(); }
	const ownedFiles = readdirSync(f.directory).filter(name => /^\.r11-s\d+-i\d+-/u.test(name));
	expect(ownedFiles.length).toBeGreaterThan(0);
	// No admitted read remains, so the original complete planner may fence.
	// The separately owned alias still holds real native/identity custody:
	// resolving the SDK room join cannot release that alias or delete its files.
	await expect(control(active.room).retire()).rejects.toThrow();
	expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)?.status).toBe("retiring");
	for (const name of ownedFiles.filter(name => name.endsWith(".sqlite"))) expect(existsSync(join(f.directory, name))).toBe(true);
	await expect(alias.storageHost.openJournal("late-after-fence")).rejects.toThrow();
	await expect(f.host.acquireLocalSession({ kind: "reopen", selector })).rejects.toThrow();
	await store.close(); await alias.close(); leases.delete(alias);
	await f.host.resumeTerminalCleanup(selector); await f.host.resumeTerminalCleanup(selector);
	const observed = census(f.directory, f.accountFilename);
	expect(observed.localDeclarations).toBe(0); expect(observed.accountHeads).toBe(0); expect(observed.accountKeys).toBe(0);
	const next = await f.material("joined-alias-continued"), continued = await f.open(next);
	expect(control(continued.room).selector).toMatchObject({ slot: selector.slot, incarnation: selector.incarnation + 1 });
	await continued.room.issue(message("joined-alias-continued")); expect(continued.room.projection().messages).toHaveLength(1);
	await control(continued.room).retire(); rooms.delete(continued.room);
}, 90000);

it.each(["after-terminal-preparation", "after-independent-fence", "after-local-key-retirement", "after-first-owned-unlink"] as const)(
	"R11 disposable SIGKILL: %s retains exact terminal intent, rejects resurrection and resumes joined cleanup", async checkpoint => {
	const f = await createDisposableNativeFixture(), selected = await f.material(`crash-${checkpoint}`);
	const active = await f.open(selected), selector = { ...control(active.room).selector };
	await active.room.issue(message(`before-${checkpoint}`));
	const beforeState = encodeCanonical(active.room.projection()), beforeOutbox = encodeCanonical(await f.outbox(selected, selector));
	const beforeAccount = logicalDatabaseImage(f.accountFilename);
	const reopen = f.persistedReopenInput(selected, selector, active.room.invite);
	await f.close(active.room); await f.closeIndependentOwner();
	const childDirectory = mkdtempSync(join(tmpdir(), "r11-terminal-crash-child-")); directories.add(childDirectory);
	const inputFilename = join(childDirectory, "reopen.cbor"), childFile = join(childDirectory, "terminal-child.mjs");
	writeFileSync(inputFilename, encodeCanonical(reopen), { mode: 0o600 });
	const installed = createRequire(join(main, "package.json"));
	const currentFile = (filename: string): string => {
		const isolated = filename.startsWith(main + "/") ? resolve(candidate, relative(main, filename)) : filename;
		return existsSync(isolated) ? isolated : filename;
	};
	// Same installed source bundler/routing used by the existing native crash
	// child. Necessary only to execute the candidate in a real killable process.
	// Read the existing literal routing entries without importing the runner
	// configuration back into its own SSR test graph (which forms a config cycle).
	const routing = readFileSync(join(main, "vite.config.mts"), "utf8");
	const aliases = Object.fromEntries([...routing.matchAll(/"(@ts-drp[^"\n]+)":\s*path\.resolve\(\s*__dirname,\s*"([^"\n]+)"\s*\)/gu)]
		.map(match => [match[1], currentFile(resolve(main, match[2]))]));
	await build({ entryPoints: [new URL("./fixtures/r11-disposable-session-child.ts", import.meta.url).pathname], outfile: childFile,
		bundle: true, platform: "node", format: "esm", target: "node22", absWorkingDir: main, nodePaths: [join(main, "node_modules")],
		alias: { ...aliases, "@ts-drp/storage/snapshot-transfer": join(main, "packages/storage/src/snapshot-transfer.ts"),
			"@ts-drp/canonical": join(main, "packages/canonical/src/index.ts"),
			"@ts-drp/blueprint-catalog": join(main, "packages/blueprint-catalog/src/index.ts"),
			"@ts-drp/protocol-v3/internal/owned-signing-request": join(candidate, "packages/protocol-v3/src/internal/owned-signing-request.ts"),
		},
		plugins: [{ name: "existing-native-child-source-routing", setup(builder) {
			builder.onResolve({ filter: /^@noble\/curves\/ed25519\.js$/ }, args => ({ path: installed.resolve(args.path) }));
			builder.onResolve({ filter: /^[^./]/ }, async args => {
				if (args.pluginData?.originalWorkspace || args.path.startsWith("node:") || !args.importer.startsWith(candidate + "/")) return;
				const resolved = await builder.resolve(args.path, { kind: args.kind,
					resolveDir: dirname(resolve(main, relative(candidate, args.importer))),
					pluginData: { originalWorkspace: true } });
				if (resolved.errors.length > 0) return resolved;
				const source = resolved.path.startsWith(main + "/packages/")
					? resolved.path.replace("/dist/src/", "/src/").replace(/\.js$/, ".ts") : resolved.path;
				return { ...resolved, path: existsSync(source) ? currentFile(source) : resolved.path };
			});
			builder.onResolve({ filter: /^\./ }, args => {
				const filename = resolve(args.resolveDir, args.path.endsWith(".js") ? args.path.slice(0, -3) + ".ts" : args.path);
				const selected = currentFile(filename);
				if (existsSync(selected)) return { path: selected };
				if (filename.startsWith(candidate + "/")) {
					const unchanged = resolve(main, relative(candidate, filename));
					if (existsSync(unchanged)) return { path: unchanged };
				}
			});
		} }],
	});
	const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; reached: boolean; stderr: string }>((accept, reject) => {
		const child = spawn(process.execPath, [childFile, inputFilename, checkpoint], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let reached = false, stderr = "";
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.stderr?.setEncoding("utf8"); child.stderr?.on("data", value => { stderr += value; });
		child.on("message", (message: { kind?: string; checkpoint?: string }) => {
			if (message.kind === "checkpoint" && message.checkpoint === checkpoint) { reached = true; child.kill("SIGKILL"); }
		});
		child.once("error", error => { clearTimeout(watchdog); reject(error); });
		child.once("close", (code, signal) => { clearTimeout(watchdog); accept({ code, signal, reached, stderr }); });
	});
	expect(killed, killed.stderr).toMatchObject({ code: null, signal: "SIGKILL", reached: true });
	await f.reopenIndependentOwner();
	if (checkpoint === "after-terminal-preparation") {
		// No terminal fence acknowledged: only the crash-abandoned preparation
		// metadata may be withdrawn. Keys, signing floors and admitted bytes
		// retain their original authority and remain usable for ordinary work.
		expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)).toMatchObject({ ...selector, status: "active" });
		expect(logicalDatabaseImage(f.accountFilename)).toEqual(beforeAccount);
		const resumed = await f.open(selected, selector);
		expect(encodeCanonical(resumed.room.projection())).toEqual(beforeState);
		expect(encodeCanonical(await f.outbox(selected, selector))).toEqual(beforeOutbox);
		const catalog = new DatabaseSync(join(f.directory, ".r11-local-sessions.sqlite"), { readOnly: true });
		try { expect(catalog.prepare("SELECT count(*) AS n FROM local_session_terminal WHERE slot=? AND incarnation=?").get(selector.slot, selector.incarnation)?.n).toBe(0); }
		finally { catalog.close(); }
		await resumed.room.issue(message(`continued-${checkpoint}`));
		expect(resumed.room.projection().messages).toHaveLength(2);
		// Actual supported new declarations during healthy successor adoption
		// establish progress beyond merely reopening already declared files.
		expect(await resumed.room.sealEpoch()).toMatchObject({ ok: true });
		await resumed.room.adoptCreatorSuccessor();
		await control(resumed.room).retire(); rooms.delete(resumed.room);
		const observed = census(f.directory, f.accountFilename);
		expect(observed.localDeclarations).toBe(0); expect(observed.accountHeads).toBe(0); expect(observed.accountKeys).toBe(0);
		return;
	}
	expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)).toMatchObject({ ...selector, status: "retiring" });
	const fenced = logicalDatabaseImage(f.accountFilename);
	await expect(f.host.acquireLocalSession({ kind: "reopen", selector })).rejects.toThrow();
	expect(logicalDatabaseImage(f.accountFilename)).toEqual(fenced);
	await f.host.resumeTerminalCleanup(selector); await f.host.resumeTerminalCleanup(selector);
	const observed = census(f.directory, f.accountFilename);
	expect(observed.localDeclarations).toBe(0); expect(observed.accountHeads).toBe(0); expect(observed.accountKeys).toBe(0);
	expect(observed.localFiles.filter(name => /^\.r11-s\d+-i\d+-/u.test(name))).toEqual([]);
	expect(f.account.inspectDisposableSessions().find(row => row.slot === selector.slot)).toMatchObject({ ...selector, status: "free" });
	// Full supported continuation after process-death recovery, not merely a
	// free catalog bit: fresh enrollment, genuine bootstrap and native gameplay.
	const next = await f.material(`continued-${checkpoint}`), continued = await f.open(next);
	expect(control(continued.room).selector.slot).toBe(selector.slot);
	expect(control(continued.room).selector.incarnation).toBeGreaterThan(selector.incarnation);
	expect(next.author).not.toBe(selected.author);
	await continued.room.issue(message(`continued-${checkpoint}`)); expect(continued.room.projection().messages).toHaveLength(1);
	await control(continued.room).retire(); rooms.delete(continued.room);
}, 90000);
