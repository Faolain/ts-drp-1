import type { DurableIssuanceOutboxRecord } from "@ts-drp/issuance-store";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { isControl } from "./fixtures/track-x/outside-rows-room.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";
import { createNodeV3RoomStorageHost } from "../packages/storage-node/src/v3-room-host.js";

// C03 x room state limit: a creator's move enters a pending unsigned intent (the store's "entered"
// marker) only after the room's state check admitted it. If the process dies right after that marker
// commits, the reopened creator resumes the intent and signs exactly those bytes, with no new state
// check. Then a Writer's move that fits only WITHOUT the resumed one must not also be admitted:
// together they would pass the room's limit, and the creator's seal would refuse its own epoch.
// Wanted: the reopened creator seals and adopts; its state stays within the limit; the Writer's move
// is either admitted (and the creator's not) or refused, never both admitted.

const INNER = process.env.RUN_PENDING_INTENT_CRASH === "1";
const LIMIT = 32_768;
const block = (owner: string, ordinal: number) => ({
	action: "placeBlock",
	id: `${owner}-${String(ordinal).padStart(5, "0")}-${"b".repeat(1000)}`,
	kind: "stone",
	x: ordinal % 16,
	y: Math.floor(ordinal / 16),
});

afterEach(async () => {
	expect(await closeFixtures(), "native admitted work and owners join").toEqual([]);
});

async function room(directory: string, reopen: boolean) {
	const fixture = await readinessHoldRoom({ directory, writers: 1 });
	const creator = await fixture.open(0, { reopen });
	const writer = await fixture.open(1, { reopen });
	const reader = createNodeV3RoomStorageHost({ directory, initialization: () => "reopen" });
	const author = required(fixture.identities[1]).author;
	const writerRows = async (): Promise<readonly DurableIssuanceOutboxRecord[]> => {
		const store = await reader.openIssuance("peer-1");
		try {
			return await store.readOutboxPage({ scope: { objectId: fixture.objectId, author }, afterKey: null, limit: 128 });
		} finally {
			await store.close();
		}
	};
	return { fixture, creator, writer, writerRows };
}

/** The number of these blocks a creator alone places before the state limit refuses the next one. */
async function capacity(): Promise<number> {
	const fixture = await readinessHoldRoom({ writers: 1 });
	const creator = await fixture.open(0);
	for (let ordinal = 0; ; ordinal++) {
		try {
			await creator.room.issue(block("creator", ordinal));
		} catch {
			return ordinal;
		}
	}
}

it.runIf(INNER)(
	"the creator dies right after its pending intent's marker commits",
	async () => {
		const directory = process.env.PENDING_INTENT_CRASH_DIRECTORY!;
		const fits = Number(process.env.PENDING_INTENT_CRASH_FITS);
		const deathFile = join(directory, "death.json");
		const watch = { armed: false, inside: false };
		const exec = DatabaseSync.prototype.exec;
		DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
			const result = exec.call(this, sql);
			if (
				watch.armed &&
				!watch.inside &&
				(sql === "COMMIT" || sql.endsWith("COMMIT")) &&
				this.location()?.endsWith(".drp-issuance-v1.sqlite") === true
			) {
				watch.inside = true;
				try {
					const pending = this.prepare("SELECT count(*) AS n FROM lineages WHERE pending_unsigned IS NOT NULL").get() as {
						n: number;
					};
					if (Number(pending.n) > 0) {
						writeFileSync(deathFile, JSON.stringify({ pid: process.pid, signal: "SIGKILL" }));
						process.kill(process.pid, "SIGKILL");
					}
				} finally {
					watch.inside = false;
				}
			}
			return result;
		};
		const { creator, writer, writerRows } = await room(directory, false);
		for (let ordinal = 0; ordinal < fits - 1; ordinal++) await creator.room.issue(block("creator", ordinal));
		// The Writer's move fits on the creator's state now (its own check admits it); it is not delivered yet.
		await writer.room.issue(block("writer", 0));
		expect((await writerRows()).some((row) => !isControl(row))).toBe(true);
		watch.armed = true;
		await creator.room.issue(block("creator", fits - 1));
		throw Error("PENDING_INTENT_CRASH_NOT_REACHED");
	},
	300_000
);

it.skipIf(INNER)(
	"SIGKILL after a creator's pending intent commits: a resumed intent and a Writer's move never pass the limit together",
	async () => {
		const fits = await capacity();
		expect(await closeFixtures()).toEqual([]);
		const directory = mkdtempSync(join(tmpdir(), "pending-intent-crash-"));
		const file = fileURLToPath(import.meta.url);
		const child = spawn("npx", ["vitest", "run", file, "--no-file-parallelism", "--coverage.enabled=false"], {
			env: {
				...process.env,
				RUN_PENDING_INTENT_CRASH: "1",
				PENDING_INTENT_CRASH_DIRECTORY: directory,
				PENDING_INTENT_CRASH_FITS: String(fits),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		if (!existsSync(join(directory, "death.json"))) throw new Error(`the creator did not die:\n${output.slice(-6000)}`);

		const { creator, writerRows } = await room(directory, true);
		const ids = () => (creator.room.projection() as { blocks: readonly { id: string }[] }).blocks.map((value) => value.id);
		const before = ids().length;
		// The Writer's move reaches the reopened creator.
		const rows = await writerRows();
		creator.inject(rows, 1);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const ingress = rows.filter((row) => creator.accepted.has(Buffer.from(row.commit.envelope.digest).toString("hex"))).length;
		let sealed: unknown;
		let failure: string | undefined;
		try {
			sealed = await creator.room.sealEpoch();
			await creator.room.adoptCreatorSuccessor();
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		const after = ids();
		const stateBytes = new TextEncoder().encode(JSON.stringify(after)).byteLength;
		console.log(
			`PENDING_INTENT_CRASH ${JSON.stringify({ fits, before, after: after.length, ingress, sealed, failure, stateBytes, resumed: after.includes(block("creator", fits - 1).id), writer: after.includes(block("writer", 0).id) })}`
		);
		expect(failure, "the reopened creator seals and adopts").toBeUndefined();
		expect((sealed as { ok?: boolean }).ok, JSON.stringify(sealed)).toBe(true);
		expect(after.includes(block("creator", fits - 1).id) && after.includes(block("writer", 0).id), "never both").toBe(false);
		expect(stateBytes).toBeLessThanOrEqual(LIMIT);
	},
	600_000
);
