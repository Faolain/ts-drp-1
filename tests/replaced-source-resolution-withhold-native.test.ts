/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// fix/creator-replaced-source-resolution (b), the reachable native path: a plan whose author fence is
// withheld for good ("withhold": the author is no longer a member) keeps every completed replacement
// entry's source as a protected hole, because the per-entry retirement clause lets a replaced source go
// only under the plan's current fence (held-anchor-retention.qnt: P1's mechanism, released by
// releaseFenceOverLost). The Writer's move m1 is signed in epoch 0 and never reaches the creator; the
// adjacent install replaces it (a completed `rebase`, replacement issued and admitted); the creator then
// revokes the Writer before m1's epoch leaves the retirement window under that fence. From then on the
// plan has no fence, so m1 stays protected forever (RED). With (b) the Writer's drain records a write-once
// replaced-source frontier resolution once the installed frontier proves m1 is settled (the creator's
// signed terminalThrough passed it, or it is displaced, fence-guarded and window-expired), and the
// retirement releases it. The release never moves the lineage and never applies the move twice.
//
// Process death (G28): the whole process (creator and Writer) dies by SIGKILL right after a real SQLite
// COMMIT of the Writer's issuance store, then a fresh process reopens the SAME directory:
//   resolution: the plan write that first carries m1's replaced-source resolution.
//   retirement: the retirement commit that first leaves m1 out of the protected records.
// The reopened room authenticates the stored resolution again (fails closed if it does not verify), and
// the release completes: m1 is not protected, its move is in the creator's history exactly once.
const INNER = process.env.RUN_REPLACED_SOURCE_CRASH === "1";
const EDGES = ["resolution", "retirement"] as const;
type Edge = (typeof EDGES)[number];
const MOVE = "replaced-move";

const directories: string[] = [];
afterEach(async () => {
	expect(await closeChatSharesRooms()).toEqual([]);
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = (directory?: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ ...(directory === undefined ? {} : { directory }), members: ["genesis"], format: "window",
		localMembers: [1], ...(localSelectors === undefined ? {} : { localSelectors }),
		genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const texts = (peer: Peer) => peer.room.projection().messages.map((entry) => entry.clientOperationId);
const count = (peer: Peer, text: string) => texts(peer).filter((entry) => entry === text).length;
const chain = (cause: unknown) => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 10; value = value.cause) parts.push(value.message);
	return parts;
};

async function nativeImage(f: Fixture) {
	const author = required(f.identities[1]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(1, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const completed = control.control.completed; await control.release();
		const plan = await store.readSettlementPlan(scope);
		return {
			plan: plan === null ? null : { fenceSequence: plan.fenceSequence, entries: plan.entries.map(entry => ({
				sequence: entry.sourceSequence, disposition: entry.disposition, replacement: entry.replacementSequence,
				resolved: entry.sourceResolutionDigest !== undefined,
				...(Reflect.get(entry, "sourceResolutionScope") === undefined ? {} : { scope: Reflect.get(entry, "sourceResolutionScope") }) })),
				contexts: plan.sourceContexts?.length ?? 0 },
			lineage: await store.readLineage(scope),
			outbox: (await store.readOutboxPage({ scope, limit: 128 })).map(row => {
				const value = decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as
					{ epoch: number; operation: { action?: unknown; clientOperationId?: unknown } };
				return { sequence: row.commit.authorSequence, epoch: value.epoch, publishState: row.publishState,
					action: value.operation.action, ...(value.operation.clientOperationId === undefined ? {} : { id: value.operation.clientOperationId }) };
			}),
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null,
			retiredThroughEpoch: completed?.throughEpoch ?? null,
		};
	});
}

async function roll(f: Fixture, creator: Peer, member: Peer, label: string) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	const image = await nativeImage(f);
	console.info(`REPLACED_SOURCE ${label} epoch=${member.room.authority().epoch} ${JSON.stringify(image)}`);
	return image;
}

/**
 * Up to the revocation: m1 signed in epoch 0 and kept from the creator, the creator closes epoch 0,
 * the Writer's adjacent install replaces m1 (completed `rebase`) and the replacement is admitted;
 * then the creator revokes the Writer, so the plan's author fence is withheld from the next install on.
 * @returns m1's author sequence and the image after the replacement.
 */
async function replacedThenRevoked(f: Fixture, creator: Peer, member: Peer) {
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false)); // Accepted, never delivered.
	await member.room.issue(message(MOVE)).catch(() => undefined);
	const signed = await nativeImage(f);
	const m1 = required(signed.outbox.find(row => row.id === MOVE));
	expect(m1).toMatchObject({ epoch: 0, publishState: "pending" });
	// The creator closes epoch 0 without m1; m1 can never enter history from here on.
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
	await f.install(member);
	const replaced = await nativeImage(f);
	console.info(`REPLACED_SOURCE replaced epoch=${member.room.authority().epoch} ${JSON.stringify(replaced)}`);
	const entry = required(replaced.plan?.entries.find(value => value.sequence === m1.sequence));
	expect(entry.disposition).toBe("rebase");
	expect(entry.replacement).not.toBeNull();
	expect(replaced.plan?.fenceSequence).not.toBeNull();
	// The Writer's epoch-1 rows (its fence and the replacement) reach the creator; m1 never does.
	const rows = (await f.issuedAfter(1, m1.sequence)).filter(row => row.commit.authorSequence > m1.sequence);
	expect(rows.length).toBeGreaterThan(0);
	expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	expect(count(creator, MOVE)).toBe(1);
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });
	return { m1: m1.sequence, replaced };
}

/**
 * After the revocation: the plan is fenceless for good and the replaced source m1 must be released.
 * @returns The last image.
 */
function expectReleased(image: Awaited<ReturnType<typeof nativeImage>>, m1: number) {
	expect(image.plan?.fenceSequence ?? null).toBeNull();
	// RELEASED: m1 is no longer a protected hole.
	expect(image.holes, "the replaced source of a fenceless plan is released").not.toContain(m1);
	// What released it: the write-once replaced-source frontier resolution on its completed entry (or
	// the entry is gone with its pruned row).
	const entry = image.plan?.entries.find(value => value.sequence === m1);
	if (entry !== undefined) expect(entry).toMatchObject({ disposition: "rebase", resolved: true, scope: "replaced-source" });
}

describe.skipIf(INNER)("replaced-source frontier resolution: a withheld (non-member) plan", () => {
	it("releases a completed replacement entry's source; the lineage never moves; the move is applied once", async () => {
		const f = await fixture();
		const creator = await f.open(0), member = await f.open(1);
		const { m1, replaced } = await replacedThenRevoked(f, creator, member);
		let image = replaced;
		// m1's epoch (0) must leave the retirement cut (through - 2) and the settlement window (4).
		for (let seal = 0; seal < 6; seal++) image = await roll(f, creator, member, `withheld-${seal}`);
		expect(image.retiredThroughEpoch).toBeGreaterThanOrEqual(4);
		expectReleased(image, m1);
		expect(image.lineage).toEqual(replaced.lineage);
		expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
		expect(count(creator, MOVE)).toBe(1);
		// The release survives a reopen: the stored resolution authenticates again.
		await f.stop(member);
		const reopened = await f.open(1, { reopen: true, promote: true });
		const after = await roll(f, creator, reopened, "reopened");
		expectReleased(after, m1);
		expect(count(creator, MOVE)).toBe(1);
	}, 600_000);
});

type Setup = { selectors: Record<number, { slot: number; incarnation: number }>; author: string; m1: number; next: number };
const planEntries = (database: DatabaseSync, author: string) => {
	const row = database.prepare("SELECT entries_json FROM settlement_plans WHERE author=?").get(author) as { entries_json: string } | undefined;
	if (row === undefined) return [];
	const decoded = JSON.parse(row.entries_json) as unknown;
	if (Array.isArray(decoded)) return decoded as Record<string, unknown>[];
	return (decodeCanonical(new Uint8Array(Buffer.from((decoded as { bytes: string }).bytes, "base64"))) as
		{ entries: Record<string, unknown>[] }).entries;
};
const protectedSequences = (database: DatabaseSync, objectId: string, author: string) => {
	const row = database.prepare("SELECT record FROM retirement_controls WHERE object_id=?").get(objectId) as { record: Uint8Array } | undefined;
	if (row === undefined) return null;
	const control = decodeCanonical(new Uint8Array(row.record)) as
		{ completed: { protectedRecords: { author: string; authorSequence: number }[] } | null };
	return control.completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null;
};

it.runIf(INNER)("the Writer dies right after a replaced-source release commit", async () => {
	const directory = required(process.env.REPLACED_SOURCE_CRASH_DIRECTORY);
	const edge = process.env.REPLACED_SOURCE_CRASH_EDGE as Edge;
	const deathFile = join(directory, "death.json");
	const exec = DatabaseSync.prototype.exec;
	const watch = { author: "", objectId: "", m1: -1, armed: false, inside: false, resolved: false };
	const die = (detail: Record<string, unknown>) => {
		writeFileSync(deathFile, JSON.stringify({ edge, pid: process.pid, signal: "SIGKILL", ...detail }));
		process.kill(process.pid, "SIGKILL");
		throw Error("SIGKILL_DID_NOT_TERMINATE");
	};
	DatabaseSync.prototype.exec = function (sql: string) {
		const result = exec.call(this, sql);
		const location = this.location();
		if (watch.armed && !watch.inside && (sql === "COMMIT" || sql.endsWith("COMMIT")) && location?.endsWith(".drp-issuance-v1.sqlite") === true) {
			watch.inside = true;
			const reader = new DatabaseSync(location, { readOnly: true });
			try {
				const entry = planEntries(reader, watch.author).find(value => value.sourceSequence === watch.m1);
				const resolved = entry?.sourceResolutionScope === "replaced-source";
				if (edge === "resolution" && resolved) die({ m1: watch.m1, entry: { disposition: entry?.disposition } });
				if (resolved) watch.resolved = true;
				const holes = protectedSequences(reader, watch.objectId, watch.author);
				if (edge === "retirement" && watch.resolved && holes !== null && !holes.includes(watch.m1)) die({ m1: watch.m1, holes });
			} catch (cause) {
				if (cause instanceof Error && cause.message === "SIGKILL_DID_NOT_TERMINATE") throw cause;
			} finally {
				reader.close();
				watch.inside = false;
			}
		}
		return result;
	};
	const f = await fixture(directory);
	const creator = await f.open(0), member = await f.open(1);
	watch.author = required(f.identities[1]).author;
	watch.objectId = f.objectId;
	const { m1, replaced } = await replacedThenRevoked(f, creator, member);
	watch.m1 = m1;
	writeFileSync(join(directory, "setup.json"), JSON.stringify({ selectors: f.localSelectors, author: watch.author, m1,
		next: replaced.lineage.next } satisfies Setup));
	watch.armed = true;
	for (let seal = 0; seal < 8; seal++) await roll(f, creator, member, `inner-${seal}`);
	throw Error(`REPLACED_SOURCE_EDGE_NOT_REACHED:${edge}`);
}, 900_000);

it.skipIf(INNER).each(EDGES)("SIGKILL right after the Writer's %s commit: the reopened room completes the release", async (edge) => {
	const directory = mkdtempSync(join(tmpdir(), `replaced-source-crash-${edge}-`));
	directories.push(directory);
	const child = spawn("npx", ["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"], {
		env: { ...process.env, RUN_REPLACED_SOURCE_CRASH: "1", REPLACED_SOURCE_CRASH_DIRECTORY: directory, REPLACED_SOURCE_CRASH_EDGE: edge },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	await new Promise<void>((resolve) => child.on("exit", () => resolve()));
	const deathFile = join(directory, "death.json");
	if (!existsSync(deathFile)) throw new Error(`the Writer did not die at ${edge}:\n${output.slice(-8000)}`);
	const death = JSON.parse(readFileSync(deathFile, "utf8")) as Record<string, unknown>;
	expect(death).toMatchObject({ signal: "SIGKILL", edge });
	const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as Setup;
	console.info(`REPLACED_SOURCE_DEATH ${JSON.stringify({ death, setup })}`);
	const f = await fixture(directory, setup.selectors);
	let stage = "open-creator";
	const { creator, member } = await (async () => {
		const opened = await f.open(0, { reopen: true });
		stage = "open-member";
		return { creator: opened, member: await f.open(1, { reopen: true, promote: true }) };
	})().catch((cause: unknown) => { throw new Error(`${stage}: ${chain(cause).join(" <- ")}`, { cause }); });
	// The reopened Writer authenticated the stored resolution: it is still there (or its row is gone).
	let image = await nativeImage(f);
	console.info(`REPLACED_SOURCE reopened ${JSON.stringify(image)}`);
	for (let seal = 0; seal < 3; seal++) image = await roll(f, creator, member, `after-${edge}-${seal}`);
	expectReleased(image, setup.m1);
	expect(image.lineage.next).toBe(setup.next);
	expect(await member.room.unresolvedAcceptedWork()).toEqual([]);
	expect(count(creator, MOVE)).toBe(1);
}, 1_200_000);
