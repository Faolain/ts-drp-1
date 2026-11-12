/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { copySettlementPlan } from "../packages/issuance-store/src/contract.js";
import { durableIssuancePruningMaintenanceForStore } from "../packages/issuance-store/src/maintenance.js";
import { createShippingChatWindowGenesisStateBytes } from "../examples/chat/src/v3-chat-window.js";
import { chatSharesRoomFixture, closeChatSharesRooms, required } from "./fixtures/chat-membership-shares/room.js";

// Cross-version probe for the replaced-source frontier resolution (fix/creator-replaced-source-resolution,
// no schema version bump; owner decision: a downgrade after a release is unsupported and must fail
// closed on first open). One store directory, two processes, each run from a checkout of its own
// version (the driver runs "continue" from the old checkout against the SAME directory):
//   setup (new version): the Writer's move m1 is replaced by an adjacent install, the creator revokes
//     the Writer, and the rolls past the window release m1 through its replaced-source resolution.
//   continue: reopens the SAME stores. REPLACED_SOURCE_VERSION_EXPECT says what must happen:
//     "refuse" (old version): opening fails closed (the closed settlement-plan record refuses the
//       unknown resolution scope) and changes nothing durable: the plan rows, retirement controls and
//       issued rows of every issuance store are byte-identical before and after;
//     "continue" (new version): the room reopens, keeps rolling, and m1 stays released.
// Skipped unless REPLACED_SOURCE_VERSION_PHASE is set.
const PHASE = process.env.REPLACED_SOURCE_VERSION_PHASE;
const DIRECTORY = process.env.REPLACED_SOURCE_VERSION_DIRECTORY;
const EXPECT = process.env.REPLACED_SOURCE_VERSION_EXPECT;
const MOVE = "replaced-move";

afterEach(async () => expect(await closeChatSharesRooms()).toEqual([]));

const message = (clientOperationId: string) => ({ action: "message", clientOperationId,
	displayTimeMs: 1_791_662_400_000, text: clientOperationId });
const fixture = (directory: string, localSelectors?: Readonly<Record<number, { slot: number; incarnation: number }>>) =>
	chatSharesRoomFixture({ directory, members: ["genesis"], format: "window", localMembers: [1],
		...(localSelectors === undefined ? {} : { localSelectors }), genesisStateBytes: createShippingChatWindowGenesisStateBytes });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Peer = Awaited<ReturnType<Fixture["open"]>>;
const count = (peer: Peer, text: string) => peer.room.projection().messages.filter((entry) => entry.clientOperationId === text).length;
const chain = (cause: unknown) => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 10; value = value.cause) parts.push(value.message);
	return parts;
};

async function image(f: Fixture) {
	const author = required(f.identities[1]).author, scope = { objectId: f.objectId, author };
	return f.withIssuance(1, async (store) => {
		const maintenance = required(durableIssuancePruningMaintenanceForStore(store));
		const control = await required(maintenance.acquireRetirementControl)({ objectId: f.objectId });
		const { completed } = control.control; await control.release();
		const plan = await store.readSettlementPlan(scope);
		return { fenceSequence: plan?.fenceSequence ?? null, next: (await store.readLineage(scope)).next,
			entries: plan?.entries.map(entry => ({ sequence: entry.sourceSequence, disposition: entry.disposition,
				scope: Reflect.get(entry, "sourceResolutionScope") ?? null, kind: Reflect.get(entry, "sourceResolutionKind") ?? null })) ?? [],
			holes: completed?.protectedRecords.filter(hole => hole.author === author).map(hole => hole.authorSequence) ?? null,
			throughEpoch: completed?.throughEpoch ?? null };
	});
}

async function roll(f: Fixture, creator: Peer, member: Peer, log: unknown[], label: string) {
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	await f.install(member);
	const value = { label, epoch: member.room.authority().epoch, ...(await image(f)) };
	log.push(value);
	return value;
}

/** Every issuance store's durable plan, retirement control and issued rows, digested (read-only). */
function durableCensus(directory: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) {
				const database = new DatabaseSync(full, { readOnly: true });
				try {
					const hash = createHash("sha256");
					for (const table of ["settlement_plans", "retirement_controls", "issued_records", "lineages"])
						hash.update(JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all(),
							(_key, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value)));
					out[full.slice(directory.length)] = hash.digest("hex");
				} finally {
					database.close();
				}
			}
		}
	};
	walk(directory);
	return out;
}

/**
 * The Writer's stored plans (canonical carrier), decoded, read-only. Used by the "refuse" phase: this
 * version's own plan reader (the checkout it runs from) must refuse the stored plan exactly because of
 * the replaced-source resolution keys, and accept the same plan without them.
 */
function storedPlans(directory: string) {
	const plans: { scope: { objectId: string; author: string }; plan: Record<string, unknown> }[] = [];
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".drp-issuance-v1.sqlite")) {
				const database = new DatabaseSync(full, { readOnly: true });
				try {
					for (const row of database.prepare("SELECT object_id, author, entries_json FROM settlement_plans").all()) {
						const stored = JSON.parse(String(row.entries_json)) as { bytes?: string };
						if (stored.bytes === undefined) continue;
						plans.push({ scope: { objectId: String(row.object_id), author: String(row.author) },
							plan: decodeCanonical(Buffer.from(stored.bytes, "base64"), { maxBytes: 4_194_304, maxDepth: 32, maxItems: 65_536 }) as Record<string, unknown> });
					}
				} finally { database.close(); }
			}
		}
	};
	walk(directory);
	return plans;
}
const RESOLUTION_KEYS = ["sourceResolutionScope", "sourceResolutionKind", "sourceResolutionDigest"];
/** The plan without the replaced-source resolution and without later fields older readers never knew. */
function withoutReplacedSourceResolution(plan: Record<string, unknown>): Record<string, unknown> {
	const entries = (plan.entries as Record<string, unknown>[]).map(entry => entry.sourceResolutionScope === undefined ? entry
		: Object.fromEntries(Object.entries(entry).filter(([key]) => !RESOLUTION_KEYS.includes(key))));
	const referenced = (digest: unknown) => entries.some(entry => [entry.sourceContextDigest, entry.sourceResolutionDigest]
		.some(value => value instanceof Uint8Array && Buffer.from(value).equals(Buffer.from(digest as Uint8Array))));
	const contexts = ((plan.sourceContexts ?? []) as { digest: Uint8Array }[]).filter(value => referenced(value.digest));
	const { memberFrontier: _frontier, completedSourceCustody: _custody, sourceContexts: _contexts, ...rest } = plan;
	return { ...rest, entries, ...(contexts.length === 0 ? {} : { sourceContexts: contexts }) };
}

it.runIf(PHASE === "setup")("setup: replace m1, revoke the Writer, roll until m1 is released", async () => {
	const directory = required(DIRECTORY), log: unknown[] = [];
	const f = await fixture(directory);
	const creator = await f.open(0), member = await f.open(1);
	const publish = Reflect.get(member.networkNode, "publishMessage") as (...args: unknown[]) => unknown;
	Reflect.set(member.networkNode, "publishMessage", () => Promise.resolve(false));
	await member.room.issue(message(MOVE)).catch(() => undefined);
	const m1 = required((await f.withIssuance(1, async (store) => (await store.readOutboxPage({
		scope: { objectId: f.objectId, author: required(f.identities[1]).author }, limit: 128 })).map(row => ({
		sequence: row.commit.authorSequence,
		id: (decodeCanonical(row.commit.envelope.canonicalPreimageBytes) as { operation: { clientOperationId?: unknown } })
			.operation.clientOperationId })))).find(row => row.id === MOVE)).sequence;
	expect((await creator.room.sealEpoch()).ok).toBe(true);
	await creator.room.adoptCreatorSuccessor();
	Reflect.set(member.networkNode, "publishMessage", (...args: unknown[]) => publish.apply(member.networkNode, args));
	await f.install(member);
	const rows = (await f.issuedAfter(1, m1)).filter(row => row.commit.authorSequence > m1);
	expect(await creator.receive(rows, 1, 30_000)).toBe(true);
	expect(count(creator, MOVE)).toBe(1);
	await creator.room.issue({ action: "acl", kind: "revoke", group: "writer", target: required(f.identities[1]).author });
	let last = await roll(f, creator, member, log, "revoked");
	for (let seal = 0; seal < 6; seal++) last = await roll(f, creator, member, log, `setup-${seal}`);
	// Released through the replaced-source resolution; its entry stays while its row is present.
	expect(last.holes).not.toContain(m1);
	// The replacement was admitted, so the committed-replacement basis resolved it (kind "replacement").
	expect(last.entries.find(entry => entry.sequence === m1)).toMatchObject({ disposition: "rebase", scope: "replaced-source",
		kind: "replacement" });
	writeFileSync(join(directory, "setup.json"), JSON.stringify({ selectors: f.localSelectors, m1, log }));
	console.info(`REPLACED_SOURCE_VERSION setup ${JSON.stringify(last)}`);
}, 600_000);

it.runIf(PHASE === "continue")("continue: reopen the same stores", async () => {
	const directory = required(DIRECTORY), log: unknown[] = [];
	const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as
		{ selectors: Record<number, { slot: number; incarnation: number }>; m1: number };
	const before = durableCensus(directory);
	const f = await fixture(directory, setup.selectors);
	let opened: { creator: Peer; member: Peer } | undefined, error: string[] | undefined;
	let stage = "open-creator";
	try {
		const creator = await f.open(0, { reopen: true });
		stage = "open-member";
		opened = { creator, member: await f.open(1, { reopen: true, promote: true }) };
		stage = "image";
		log.push({ label: "reopened", ...(await image(f)) });
	} catch (cause) {
		error = [stage, ...chain(cause)];
	}
	if (EXPECT === "refuse") {
		await closeChatSharesRooms();
		const after = durableCensus(directory);
		writeFileSync(join(directory, "continue.json"), JSON.stringify({ error, log, before, after }));
		console.info(`REPLACED_SOURCE_VERSION continue ${JSON.stringify({ error, log })}`);
		// Fails closed on first open, and nothing durable changed.
		expect(error, "the older version must refuse to open a store holding a replaced-source resolution").toBeDefined();
		expect(after).toEqual(before);
		// This version's own plan reader refuses the stored plan because of the resolution keys alone: it
		// accepts the same plan without them (and without the unreleased F2/lost-twice fields).
		const resolved = storedPlans(directory).filter(value => (value.plan.entries as Record<string, unknown>[])
			.some(entry => entry.sourceResolutionScope !== undefined));
		expect(resolved.length).toBeGreaterThan(0);
		for (const { scope, plan } of resolved) {
			const readsStored = copySettlementPlan(plan, scope) !== undefined;
			const readsWithout = copySettlementPlan(withoutReplacedSourceResolution(plan), scope) !== undefined;
			console.info(`REPLACED_SOURCE_VERSION reader ${JSON.stringify({ author: scope.author.slice(0, 12), readsStored, readsWithout })}`);
			expect(readsStored).toBe(false);
			expect(readsWithout).toBe(true);
		}
		return;
	}
	expect(error).toBeUndefined();
	const { creator, member } = required(opened);
	let last: Awaited<ReturnType<typeof roll>> | undefined;
	for (let seal = 0; seal < 3; seal++) last = await roll(f, creator, member, log, `continue-${seal}`);
	writeFileSync(join(directory, "continue.json"), JSON.stringify({ log }));
	for (const row of log) console.info(`REPLACED_SOURCE_VERSION continue ${JSON.stringify(row)}`);
	expect(required(last).holes).not.toContain(setup.m1);
	expect(count(creator, MOVE)).toBe(1);
}, 600_000);
