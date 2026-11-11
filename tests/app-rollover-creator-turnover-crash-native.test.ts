/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native room helpers retain fixture types. */
import { decodeCanonical } from "@ts-drp/canonical";
import type { SnapshotChunkProtocolPort } from "@ts-drp/network/snapshot-transfer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { installEnvironment, nodeHostFor } from "./fixtures/track-m-apps/app-long-room.js";
import { openRole } from "./fixtures/track-m-apps/long-room-core.js";
import {
	fromBase64,
	type RoleEndpoint,
	successorWire,
	type WireRow,
} from "./fixtures/track-m-apps/long-room-driver.js";
import { createNodeRoomHeadAuthority } from "../packages/storage-node/src/room-head.js";

// The creator dies (SIGKILL, real SQLite COMMIT, nothing mocked) right after its snapshot store commits
// the recovery-pool turnover that retires its oldest recovery scope, before its native (AHE) store has
// recorded that turnover's retirement. On reopen the snapshot store holds the turnover receipt for the
// current head while the native retirement control is still completed one boundary back, so the
// reopened creator is halted by the receipt alone. That halt is the same request the original close
// reconstruction discharges; the creator's opening readiness boundary must discharge it too, not refuse
// to open ("creator readiness maintenance boundary is unavailable", seen intermittently in
// app-rollover-handback-crash-native "resolution", where the Writer's commit lands in this window).
const INNER = process.env.RUN_CREATOR_TURNOVER_CRASH === "1";
const MAX_EPOCHS = 10;

const track = {
	rooms: new Set<{ close(): Promise<void> }>(),
	heads: new Set<{ close(): Promise<void> }>(),
	ports: new Set<SnapshotChunkProtocolPort>(),
};
const directories: string[] = [];
afterEach(async () => {
	await Promise.allSettled([...track.rooms].map((room) => room.close()));
	await Promise.allSettled([...track.heads].map((head) => head.close()));
	await Promise.allSettled([...track.ports].map((port) => port.close()));
	track.rooms.clear();
	track.heads.clear();
	track.ports.clear();
	if (!INNER) for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const rowValue = (row: WireRow) => decodeCanonical(fromBase64(row.preimage)) as { epoch: number };
const chain = (cause: unknown) => {
	const parts: string[] = [];
	for (let value: unknown = cause; value instanceof Error && parts.length < 10; value = value.cause)
		parts.push(`${value.name}: ${value.message}`);
	return parts;
};
// The creator's snapshot owner opens `<sha256(["snapshots","creator"])>.sqlite.<suffix>` (track-m-apps fixture).
const creatorSnapshotFile = (directory: string) =>
	join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify(["snapshots", "creator"]))
			.digest("hex")}.sqlite.drp-snapshot-quarantine-v1.sqlite`
	);

async function openPair(directory: string, reopen: boolean) {
	const options = {
		app: "grid" as const,
		host: "node" as const,
		recipient: "writer" as const,
		creatorLull: false,
		epochs: 1,
		moves: 1,
		chatFormat: "shares" as const,
		rollover: "app" as const,
	};
	const env = {
		host: nodeHostFor("node", directory, reopen),
		unique: directory,
		track,
		openFloor: (role: string) =>
			createNodeRoomHeadAuthority({
				filename: join(directory, `${role}-external-floor.sqlite`),
				initialization: { kind: reopen ? ("reopen" as const) : ("create" as const) },
			}),
	};
	let stage = "open-creator";
	try {
		const creator = await openRole(options, 0, env);
		stage = "open-writer";
		const writer = await openRole(options, 1, { ...env, relay: (request) => creator.dispatch(request) });
		return { creator, writer };
	} catch (cause) {
		throw new Error(`${stage}: ${chain(cause).join(" <- ")}`, { cause });
	}
}

/** Each side's rows reach the other only in the receiver's current epoch. */
function rowWire(creator: RoleEndpoint, writer: RoleEndpoint) {
	const cursor = { creator: null as number | null, writer: null as number | null };
	const carry = async (from: RoleEndpoint, to: RoleEndpoint, key: "creator" | "writer") => {
		const published = await from.published(cursor[key]);
		if (published.length === 0) return;
		const current = (await to.authorityEpoch()) ?? 0;
		const ahead = published.findIndex((row) => rowValue(row).epoch > current);
		const rows = ahead < 0 ? published : published.slice(0, ahead);
		if (rows.length === 0) return;
		await to.inject(rows.filter((row) => rowValue(row).epoch === current));
		cursor[key] = rows.at(-1)?.authorSequence ?? cursor[key];
	};
	return { toWriter: () => carry(creator, writer, "creator"), toCreator: () => carry(writer, creator, "writer") };
}

async function rollCreator(creator: RoleEndpoint, carry: () => Promise<void>, ordinal: { next: number }) {
	const before = (await creator.rollover?.())?.epoch ?? 0;
	for (;;) {
		await creator.issue(0, ordinal.next++);
		await carry();
		const epoch = (await creator.rollover?.())?.epoch ?? 0;
		if (epoch > before) return epoch;
	}
}

it.runIf(INNER)(
	"the creator dies right after its snapshot store commits a recovery-pool turnover",
	async () => {
		const directory = process.env.CREATOR_TURNOVER_CRASH_DIRECTORY ?? "";
		if (directory === "") throw Error("CREATOR_TURNOVER_CRASH_DIRECTORY is required");
		const deathFile = join(directory, "death.json");
		const file = creatorSnapshotFile(directory);
		const exec = DatabaseSync.prototype.exec;
		const watch = { scopes: -1, inside: false, epoch: 0 };
		DatabaseSync.prototype.exec = function (sql: string) {
			const result = exec.call(this, sql);
			if (
				(sql === "COMMIT" || sql.endsWith("COMMIT")) &&
				!watch.inside &&
				this.location()?.endsWith(`/${basename(file)}`) === true
			) {
				watch.inside = true;
				try {
					const db = new DatabaseSync(file, { readOnly: true });
					let scopes: number;
					try {
						scopes = Number((db.prepare("SELECT count(*) AS n FROM snapshot_scopes_v2").get() as { n: number }).n);
					} finally {
						db.close();
					}
					// The first commit that retires a recovery scope is the pool turnover.
					if (watch.scopes >= 0 && scopes < watch.scopes) {
						writeFileSync(
							deathFile,
							JSON.stringify({ pid: process.pid, signal: "SIGKILL", epoch: watch.epoch, scopes, before: watch.scopes })
						);
						process.kill(process.pid, "SIGKILL");
						throw Error("SIGKILL_DID_NOT_TERMINATE");
					}
					watch.scopes = scopes;
				} finally {
					watch.inside = false;
				}
			}
			return result;
		};
		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, false);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: 0 };
			for (let epoch = 0; epoch < MAX_EPOCHS; ) {
				epoch = await rollCreator(creator, rows.toWriter, ordinal);
				watch.epoch = epoch;
				await wire.caughtUp(epoch, 60_000);
				await rows.toWriter();
				await writer.issue(1, epoch);
				await rows.toCreator();
				writeFileSync(join(directory, "setup.json"), JSON.stringify({ epoch, ordinal: ordinal.next }));
			}
			throw Error(`CREATOR_TURNOVER_NOT_REACHED after ${MAX_EPOCHS} epochs`);
		} finally {
			restore();
		}
	},
	900_000
);

it.skipIf(INNER)(
	"a creator killed right after its snapshot pool turnover commit reopens and keeps rolling over",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "app-rollover-creator-turnover-crash-"));
		directories.push(directory);
		const child = spawn(
			"npx",
			["vitest", "run", fileURLToPath(import.meta.url), "--no-file-parallelism", "--coverage.enabled=false"],
			{
				env: { ...process.env, RUN_CREATOR_TURNOVER_CRASH: "1", CREATOR_TURNOVER_CRASH_DIRECTORY: directory },
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		await new Promise<void>((resolve) => child.on("exit", () => resolve()));
		const deathFile = join(directory, "death.json");
		if (!existsSync(deathFile))
			throw new Error(`the creator did not die at its pool turnover:\n${output.slice(-6000)}`);
		const death = JSON.parse(readFileSync(deathFile, "utf8")) as Record<string, unknown>;
		const setup = JSON.parse(readFileSync(join(directory, "setup.json"), "utf8")) as { epoch: number; ordinal: number };
		process.stdout.write(`CREATOR_TURNOVER_CRASH_DEATH ${JSON.stringify({ death, setup })}\n`);
		expect(death).toMatchObject({ signal: "SIGKILL" });

		const restore = await installEnvironment("node", () => undefined);
		try {
			const { creator, writer } = await openPair(directory, true);
			const wire = successorWire(() => [creator, writer] as const);
			const rows = rowWire(creator, writer);
			const ordinal = { next: setup.ordinal + 1_000 };
			try {
				const reopened = (await creator.rollover?.())?.epoch ?? 0;
				let epoch = reopened;
				for (let round = 0; round < 3; round++) {
					epoch = await rollCreator(creator, rows.toWriter, ordinal);
					await wire.caughtUp(epoch, 60_000);
					await rows.toWriter();
					await writer.issue(1, epoch);
					await rows.toCreator();
				}
				expect(epoch).toBeGreaterThanOrEqual(reopened + 3);
				await rows.toWriter();
				await wire.caughtUp(epoch, 60_000);
			} finally {
				await wire.stop();
			}
		} finally {
			restore();
		}
	},
	1_200_000
);
