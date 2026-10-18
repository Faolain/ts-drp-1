import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { fixture, outcome, receiptFor, stable } from "../../../tests/fixtures/snapshot-recovery-owner/contract.js";
import { createNodeSnapshotQuarantineStore } from "../src/snapshot-transfer.js";

const modes = ["precommit-error", "ack-loss", "kill-before", "kill-after"] as const;
type Mode = (typeof modes)[number];
type Row = Record<string, unknown>;
interface RawImage {
	version: unknown;
	schema: Row[];
	owner: Row[];
	scopes: Row[];
	chunks: Row[];
}
interface ChildMessage {
	kind: string;
	token: string;
	pid: number;
	edge?: string;
	reason?: string;
	evidence?: { begins: number; mutations: number; nativeCommits: number; edgeReached: boolean };
	result?: { code: string; detail?: string };
}
const suffix = ".drp-snapshot-quarantine-v1.sqlite";
const sourceRoot = resolve(import.meta.dirname, "../../..");
const custodyFiles = [
	"packages/storage/src/snapshot-transfer.ts",
	"packages/storage-node/src/snapshot-transfer.ts",
	"packages/storage-browser/src/snapshot-transfer.ts",
	"packages/storage-node/tests/snapshot-recovery-retention-native-red.test.ts",
	"packages/storage-node/tests/fixtures/recovery-retention-child.ts",
];
const hashes = (): Record<string, string> =>
	Object.fromEntries(
		custodyFiles.map((file) => [
			file,
			createHash("sha256")
				.update(readFileSync(resolve(sourceRoot, file)))
				.digest("hex"),
		])
	);

function rawImage(primaryFilename: string): RawImage {
	// This must precede all adapter reopen/inspection after uncertainty.
	const database = new DatabaseSync(`${primaryFilename}${suffix}`, { readOnly: true });
	try {
		return {
			version: database.prepare("PRAGMA user_version").get()?.user_version,
			schema: database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
			owner: database.prepare("SELECT * FROM snapshot_owner_v2 ORDER BY id").all(),
			scopes: database
				.prepare("SELECT * FROM snapshot_scopes_v2 ORDER BY object_id,epoch,anchor,manifest_digest")
				.all(),
			chunks: database
				.prepare("SELECT * FROM snapshot_chunks_v2 ORDER BY object_id,epoch,anchor,manifest_digest,chunk_index")
				.all(),
		};
	} finally {
		database.close();
	}
}

function promoted(image: RawImage, charge: number): RawImage {
	return {
		...image,
		owner: image.owner.map((row) => ({ ...row, recovery_scopes: 1, recovery_content_bytes: charge })),
		scopes: image.scopes.map((row) => ({ ...row, retention: "recovery" })),
	};
}

async function runChild(
	bundle: string,
	primaryFilename: string,
	mode: Mode | "race",
	control: boolean,
	race?: { objectId: string; onReady(go: () => void): void }
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	messages: ChildMessage[];
	timedOut: boolean;
	birth: string;
	survivors: string[];
	stderr: string;
}> {
	const token = randomUUID();
	const child = spawn(
		process.execPath,
		[bundle, primaryFilename, mode, control ? "control" : "production", token, ...(race ? [race.objectId] : [])],
		{
			detached: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		}
	);
	const pid = child.pid;
	if (pid === undefined) throw new Error("RETENTION_CHILD_SPAWN_FAILED");
	let birth: string;
	try {
		birth = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], {
			encoding: "utf8",
			timeout: 2_000,
		}).trim();
	} catch (error) {
		// This is still our just-spawned, unreaped child; never leave it alive on a failed birth probe.
		child.kill("SIGKILL");
		await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
		throw error;
	}
	const messages: ChildMessage[] = [];
	let stderr = "";
	let timedOut = false;
	const killSameBirth = (signal: NodeJS.Signals): void => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			const actual = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid="], {
				encoding: "utf8",
				timeout: 2_000,
			}).trim();
			if (actual === birth && birth.split(/\s+/u).at(-1) === String(pid)) child.kill(signal);
		} catch {
			// A process that has already exited must not be replaced by an unrelated kill target.
		}
	};
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-16_384);
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		const timer = setTimeout(() => {
			timedOut = true;
			killSameBirth("SIGKILL");
		}, 8_000);
		child.on("message", (raw: unknown) => {
			if (raw === null || typeof raw !== "object") return;
			const message = raw as ChildMessage;
			if (message.token !== token || message.pid !== pid) return;
			messages.push(message);
			if (message.kind === "checkpoint") killSameBirth("SIGKILL");
			if (message.kind === "ready") race?.onReady(() => child.send({ kind: "go", token }));
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			killSameBirth("SIGKILL");
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolveExit({ code, signal });
		});
	});
	const survivors = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2_000 })
		.trim()
		.split("\n")
		.filter((line) => Number(line.trim().split(/\s+/u)[1]) === pid);
	return { ...result, messages, timedOut, birth, survivors, stderr };
}

describe("1a-1 native retention transaction fault evidence", () => {
	it("two independent processes compete for one retained scope without eviction or double charge", async () => {
		const beforeSources = hashes();
		const directory = mkdtempSync(join(tmpdir(), "ts-drp-retention-native-"));
		try {
			const primaryFilename = join(directory, "primary.sqlite");
			const selected = [fixture("retention-race-a"), fixture("retention-race-b")];
			const seed = createNodeSnapshotQuarantineStore({
				primaryFilename,
				recoveryLimits: { maxRecoveryScopes: 1, maxRecoveryContentBytes: 4096 },
			});
			try {
				for (const candidate of selected) {
					const scope = await seed.openScope(candidate.declaration);
					await scope.complete(await receiptFor(scope, candidate));
				}
			} finally {
				await seed.close();
			}
			const before = rawImage(primaryFilename);
			expect(before.scopes).toHaveLength(2);
			expect(before.scopes.map((row) => row.state)).toEqual(["verified", "verified"]);
			const bundle = join(directory, "retention-child.mjs");
			await build({
				entryPoints: [resolve(import.meta.dirname, "fixtures/recovery-retention-child.ts")],
				outfile: bundle,
				bundle: true,
				format: "esm",
				platform: "node",
			});
			const ready: (() => void)[] = [];
			const results = await Promise.all(
				selected.map((candidate) =>
					runChild(bundle, primaryFilename, "race", false, {
						objectId: candidate.declaration.scope.objectId,
						onReady: (go) => {
							ready.push(go);
							if (ready.length === 2) for (const release of ready) release();
						},
					})
				)
			);
			const after = rawImage(primaryFilename);
			console.info("RETENTION_NATIVE_RACE", JSON.stringify(results));
			expect(ready).toHaveLength(2);
			expect(new Set(results.map((result) => result.messages[0]?.pid)).size).toBe(2);
			for (const result of results) {
				expect(result.timedOut, result.stderr).toBe(false);
				expect(result.survivors).toEqual([]);
				expect(result.code).toBe(0);
				expect(result.signal).toBeNull();
				expect(result.messages.map((message) => message.kind).slice(0, 2)).toEqual(["born", "ready"]);
			}
			if (results.every((result) => result.messages.at(-1)?.kind === "masked")) {
				expect(stable(after)).toBe(stable(before));
			}
			const codes = results.map((result) => result.messages.at(-1)?.result?.code ?? "MASKED_BY_ABSENT_RETENTION_API");
			expect([...codes].sort(), `TWO_PROCESS_RETENTION_RESULTS:${JSON.stringify(results)}`).toEqual([
				"none",
				"recovery-full",
			]);
			const winner = selected[codes.indexOf("none")];
			if (winner === undefined) throw new Error("retention race has no winner");
			const charge = winner.declaration.totalBytes + winner.declaration.exactCanonicalManifestBytes.byteLength;
			expect(stable(after)).toBe(
				stable({
					...before,
					owner: before.owner.map((row) => ({ ...row, recovery_scopes: 1, recovery_content_bytes: charge })),
					scopes: before.scopes.map((row) =>
						row.object_id === winner.declaration.scope.objectId ? { ...row, retention: "recovery" } : row
					),
				})
			);
		} finally {
			expect(hashes()).toEqual(beforeSources);
			rmSync(directory, { recursive: true, force: true });
		}
	}, 20_000);
	for (const column of [
		"recovery_scopes",
		"recovery_content_bytes",
		"legacy_unclassified_scopes",
		"legacy_unclassified_content_bytes",
	] as const) {
		for (const representation of ["text", "blob"] as const) {
			it(`central owner status rejects actual SQL ${representation} in ${column} without mutation`, async () => {
				const beforeSources = hashes();
				const directory = mkdtempSync(join(tmpdir(), "ts-drp-retention-native-"));
				const primaryFilename = join(directory, "primary.sqlite");
				const store = createNodeSnapshotQuarantineStore({ primaryFilename });
				try {
					const selected = fixture("retention-counter-fault");
					const scope = await store.openScope(selected.declaration);
					await scope.complete(await receiptFor(scope, selected));
					expect(rawImage(primaryFilename).scopes[0]?.state).toBe("verified");
					const raw = new DatabaseSync(`${primaryFilename}${suffix}`);
					try {
						const injected = representation === "text" ? "0x1" : Uint8Array.of(0);
						raw.prepare(`UPDATE snapshot_owner_v2 SET ${column}=?`).run(injected);
						expect(raw.prepare(`SELECT typeof(${column}) AS kind FROM snapshot_owner_v2`).get()?.kind).toBe(
							representation
						);
						// These real SQLite storage classes would pass the former Number(...) coercion.
						expect(Number(injected)).toBe(representation === "text" ? 1 : 0);
					} finally {
						raw.close();
					}
					const before = rawImage(primaryFilename);
					const result = await outcome(() => store.recoveryStatus());
					expect(stable(rawImage(primaryFilename))).toBe(stable(before));
					expect(result.code, `ACTUAL_SQL_COUNTER_CLASS:${representation}:${column}:${JSON.stringify(result)}`).toBe(
						"storage-failed"
					);
				} finally {
					await store.close();
					expect(hashes()).toEqual(beforeSources);
					rmSync(directory, { recursive: true, force: true });
				}
			});
		}
	}
	for (const control of [true, false]) {
		for (const mode of modes) {
			it(`${control ? "native SQL instrumentation control (not adapter retention)" : "adapter retention"}: ${mode}`, async () => {
				const beforeSources = hashes();
				const directory = mkdtempSync(join(tmpdir(), "ts-drp-retention-native-"));
				try {
					const primaryFilename = join(directory, "primary.sqlite");
					const selected = fixture("retention-native-edge");
					const charge = selected.declaration.totalBytes + selected.declaration.exactCanonicalManifestBytes.byteLength;
					const seed = createNodeSnapshotQuarantineStore({ primaryFilename });
					try {
						const scope = await seed.openScope(selected.declaration);
						await scope.complete(await receiptFor(scope, selected));
					} finally {
						await seed.close();
					}
					const before = rawImage(primaryFilename);
					expect(before.scopes).toHaveLength(1);
					expect(before.scopes[0]?.state).toBe("verified");
					expect(before.scopes[0]?.retention).toBe("temporary");
					const bundle = join(directory, "retention-child.mjs");
					await build({
						entryPoints: [resolve(import.meta.dirname, "fixtures/recovery-retention-child.ts")],
						outfile: bundle,
						bundle: true,
						format: "esm",
						platform: "node",
					});
					const result = await runChild(bundle, primaryFilename, mode, control);
					const after = rawImage(primaryFilename);
					console.info("RETENTION_NATIVE_EDGE", JSON.stringify({ mode, control, ...result }));
					expect(result.timedOut, result.stderr).toBe(false);
					expect(result.survivors).toEqual([]);
					expect(result.birth).not.toBe("");
					expect(result.messages[0]?.kind).toBe("born");
					const terminal = result.messages.at(-1);
					if (terminal?.kind === "masked") {
						expect(stable(after)).toBe(stable(before));
						expect(terminal.evidence).toEqual({ begins: 0, mutations: 0, nativeCommits: 0, edgeReached: false });
					}
					expect(terminal?.kind, `MASKED_OR_UNREACHED_NATIVE_EDGE:${JSON.stringify(result)}`).toBe(
						mode.startsWith("kill-") ? "checkpoint" : "result"
					);
					expect(terminal?.evidence?.edgeReached).toBe(true);
					expect(terminal?.evidence?.begins).toBe(1);
					const committed = mode === "ack-loss" || mode === "kill-after";
					expect(terminal?.evidence?.nativeCommits).toBe(committed ? 1 : 0);
					if (mode.startsWith("kill-")) {
						expect(terminal?.edge).toBe(committed ? "native-commit-returned" : "post-write-precommit");
						expect(result.signal).toBe("SIGKILL");
						expect(result.code).toBeNull();
					} else {
						expect(result.code).toBe(0);
						expect(result.signal).toBeNull();
						expect(terminal?.result?.code).toBe(control ? "unclassified-error" : "storage-failed");
					}
					expect(stable(after)).toBe(stable(committed ? promoted(before, charge) : before));
					if (!control) {
						const reopened = createNodeSnapshotQuarantineStore({ primaryFilename });
						try {
							const inspection = await reopened.inspectRecovery(selected.declaration);
							expect(inspection.kind).toBe("present");
							expect(stable(rawImage(primaryFilename))).toBe(stable(after));
							const scope = await reopened.openScope(selected.declaration);
							const retain: unknown = Reflect.get(scope, "retainForRecovery");
							if (typeof retain !== "function") throw new Error("MASKED_BY_ABSENT_RETENTION_API");
							for (let retry = 0; retry < 2; retry += 1) {
								expect((await outcome(() => Reflect.apply(retain, scope, []))).code).toBe("none");
								expect(stable(rawImage(primaryFilename))).toBe(stable(promoted(before, charge)));
							}
						} finally {
							await reopened.close();
						}
					}
				} finally {
					expect(hashes()).toEqual(beforeSources);
					rmSync(directory, { recursive: true, force: true });
				}
			}, 20_000);
		}
	}
});
