import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
	P4_NODE_DEATH_TUPLES,
	P4_NODE_METHODS,
	P4_NODE_NO_WRITE_DEATH_TUPLES,
	P4_NODE_SCHEMA,
} from "./fixtures/phase-3a1b-p4-node-contract.js";

interface JournalStore {
	appendAccepted(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	close(): Promise<void>;
	installGenesis(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readiness(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
	readPage(input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

interface Candidate {
	createNodeDurableLiveJournalStore(options: { readonly primaryFilename: string }): JournalStore;
}

interface CandidateTestControl {
	armPhase3a1bP4NodeReadbackFault(fate: "exact-new" | "exact-old" | "mixed" | "unreadable"): void;
}

interface Material {
	readonly anchorDigest: string;
	readonly anchorHex: string;
	readonly objectId: string;
	readonly parametersDigest: string;
	readonly parametersHex: string;
	readonly signatureHex: string;
	readonly vertexDigest: string;
	readonly vertexHex: string;
}

interface ChildMessage {
	readonly edge?: string;
	readonly expectedRaw?: Readonly<{
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	}>;
	readonly kind: string;
	readonly message?: string;
	readonly primary?: Readonly<Record<string, unknown>>;
	readonly raw?: Readonly<{
		readonly rows: readonly Record<string, unknown>[];
		readonly scopes: readonly Record<string, unknown>[];
	}>;
	readonly unaddressed?: Readonly<Record<string, unknown>> | null;
}

const PACKAGE_DIRECTORY = path.resolve(import.meta.dirname, "..");
const CHILD = new URL("./fixtures/phase-3a1b-p4-node-death-child.mjs", import.meta.url);
const PRELOAD = new URL("./fixtures/phase-3a1b-p4-node-preload.mjs", import.meta.url);
const RUN_LONG = process.env.TS_DRP_PHASE_3A1B_P4_NODE_DEATH === "1";
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

function primary(label: string): string {
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p4-node-${label}-`));
	directories.push(directory);
	return path.join(directory, "primary.sqlite");
}

async function loadCandidate(): Promise<Candidate> {
	try {
		return (await import(new URL("../dist/src/live-journal.js", import.meta.url).href)) as Candidate;
	} catch (error) {
		throw new Error("PHASE_3A1B_P4_NODE_CANDIDATE_UNAVAILABLE", { cause: error });
	}
}

async function loadTestControl(): Promise<CandidateTestControl> {
	try {
		return (await import(
			new URL("../dist/src/internal/live-journal-observation.js", import.meta.url).href
		)) as CandidateTestControl;
	} catch (error) {
		throw new Error("PHASE_3A1B_P4_NODE_TEST_CONTROL_UNAVAILABLE", { cause: error });
	}
}

function loadMaterial(): Material {
	return JSON.parse(
		fs.readFileSync(path.resolve(PACKAGE_DIRECTORY, "../../tests/fixtures/phase-3a1b-p4/material.json"), "utf8")
	) as Material;
}

function exactInputs(material = loadMaterial()): {
	readonly install: Readonly<Record<string, unknown>>;
	readonly local: Readonly<Record<string, unknown>>;
	readonly received: Readonly<Record<string, unknown>>;
	readonly scope: Readonly<Record<string, unknown>>;
} {
	const anchorBytes = Uint8Array.from(Buffer.from(material.anchorHex, "hex"));
	const parametersBytes = Uint8Array.from(Buffer.from(material.parametersHex, "hex"));
	const signature = Uint8Array.from(Buffer.from(material.signatureHex, "hex"));
	const vertexBytes = Uint8Array.from(Buffer.from(material.vertexHex, "hex"));
	const scope = { anchorDigest: material.anchorDigest, epoch: 0 as const, objectId: material.objectId };
	return {
		install: {
			detachedAnchorSignature: signature,
			exactCanonicalAnchorPreimageBytes: anchorBytes,
			exactCanonicalParametersCarrierBytes: parametersBytes,
			objectId: material.objectId,
		},
		local: {
			author: "creator",
			authorSequence: 0,
			scope,
			sourceKind: "local-issued",
			vertexDigest: material.vertexDigest,
		},
		received: {
			detachedSignature: signature,
			exactCanonicalPreimageBytes: vertexBytes,
			scope,
			sourceKind: "received",
			vertexDigest: material.vertexDigest,
		},
		scope,
	};
}

function rawClosure(primaryFilename: string): {
	readonly rows: readonly Record<string, unknown>[];
	readonly scopes: readonly Record<string, unknown>[];
} {
	const database = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: true,
	});
	try {
		return {
			rows: database.prepare("SELECT * FROM accepted_entries ORDER BY journal_sequence").all() as Record<
				string,
				unknown
			>[],
			scopes: database.prepare("SELECT * FROM scopes ORDER BY object_id,epoch,anchor_digest").all() as Record<
				string,
				unknown
			>[],
		};
	} finally {
		database.close();
	}
}

function runKilled(
	tuple: (typeof P4_NODE_DEATH_TUPLES)[number],
	primaryFilename: string
): Promise<readonly ChildMessage[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD.pathname, primaryFilename, JSON.stringify(tuple)], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const messages: ChildMessage[] = [];
		let armed = false;
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${tuple.id}: death harness timeout: ${stderr}`));
		}, 10_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			messages.push(message);
			if (message.kind === "child-error") {
				clearTimeout(timeout);
				reject(new Error(`${tuple.id}: ${message.message}`));
			} else if (message.kind === "checkpoint" && message.edge === tuple.edge && !armed) {
				armed = true;
				child.kill("SIGKILL");
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (!armed) reject(new Error(`${tuple.id}: exited before checkpoint (${String(code)}): ${stderr}`));
			else if (signal !== "SIGKILL") reject(new Error(`${tuple.id}: expected SIGKILL, got ${String(signal)}`));
			else resolve(messages);
		});
	});
}

function runRecovery(tuple: (typeof P4_NODE_DEATH_TUPLES)[number], primaryFilename: string): Promise<ChildMessage> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD.pathname, primaryFilename, JSON.stringify(tuple), "recover"], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let recovery: ChildMessage | undefined;
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${tuple.id}: recovery timeout: ${stderr}`));
		}, 10_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			if (message.kind === "recovery") recovery = message;
			else if (message.kind === "child-error") {
				clearTimeout(timeout);
				reject(new Error(`${tuple.id}: ${message.message}`));
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0 || recovery === undefined) {
				reject(new Error(`${tuple.id}: recovery exited ${String(code)}: ${stderr}`));
			} else resolve(recovery);
		});
	});
}

describe("D.93.34 p4-b Node strict live-journal RED", () => {
	it("round-trips the exact two-table WITHOUT ROWID schema and forbids permissive migration", () => {
		const database = new DatabaseSync(":memory:", {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
			readOnly: false,
		});
		try {
			database.exec(P4_NODE_SCHEMA.scopes);
			database.exec(P4_NODE_SCHEMA.acceptedEntries);
			const rows = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
			expect(rows).toEqual([
				{ name: "accepted_entries", sql: P4_NODE_SCHEMA.acceptedEntries },
				{ name: "scopes", sql: P4_NODE_SCHEMA.scopes },
			]);
			expect(Object.values(P4_NODE_SCHEMA).every((sql) => !sql.includes("IF NOT EXISTS"))).toBe(true);
		} finally {
			database.close();
		}
	});

	it("pins the exact additive package subpath, dependency, filename and unchanged root bytes", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			exports?: Record<string, unknown>;
		};
		expect(manifest.exports?.["./live-journal"]).toEqual({
			import: "./dist/src/live-journal.js",
			types: "./dist/src/live-journal.d.ts",
		});
		expect(manifest.dependencies?.["@ts-drp/live-journal"]).toBe("0.11.0");
		expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([".", "./issuance", "./live-journal"]);
		expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
			"@ts-drp/issuance-store",
			"@ts-drp/live-journal",
			"@ts-drp/storage",
		]);
		expect(
			createHash("sha256")
				.update(fs.readFileSync(path.join(PACKAGE_DIRECTORY, "src/index.ts")))
				.digest("hex")
		).toBe("14688ec0442cf331f329a5cb944bfa893f6a6ef08eeedd8bb6352651283d7211");
	});

	it("opens a genuine strict facade with five methods and an injective sidecar filename", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("surface");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		try {
			expect(Object.keys(store).sort()).toEqual(P4_NODE_METHODS);
			expect(fs.existsSync(primaryFilename)).toBe(false);
			expect(fs.existsSync(`${primaryFilename}.drp-live-journal-v1.sqlite`)).toBe(true);
		} finally {
			await store.close();
		}
	});

	it("serializes concurrent cross-kind writers to one immutable first label and sequence", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("race");
		const first = createNodeDurableLiveJournalStore({ primaryFilename });
		const second = createNodeDurableLiveJournalStore({ primaryFilename });
		const material = loadMaterial();
		const values = exactInputs(material);
		try {
			await first.installGenesis(values.install);
			const results = await Promise.all([first.appendAccepted(values.received), second.appendAccepted(values.local)]);
			expect(results.every((result) => result.ok === true && result.journalSequence === 0)).toBe(true);
			expect(new Set(results.map((result) => result.sourceKind))).toHaveLength(1);
			expect(results.filter((result) => result.idempotent === false)).toHaveLength(1);
			const closure = rawClosure(primaryFilename);
			expect(closure.rows).toHaveLength(1);
			expect(Object.keys(closure.rows[0] ?? {}).sort()).toEqual([
				"anchor_digest",
				"epoch",
				"journal_sequence",
				"local_author",
				"local_author_sequence",
				"object_id",
				"received_preimage",
				"received_signature",
				"source_kind",
				"vertex_digest",
			]);
			const row = closure.rows[0];
			expect(row).toMatchObject({
				anchor_digest: material.anchorDigest,
				epoch: 0,
				journal_sequence: 0,
				object_id: material.objectId,
				vertex_digest: material.vertexDigest,
			});
			if (row?.source_kind === "received") {
				expect(row).toMatchObject({ local_author: null, local_author_sequence: null });
				expect(Buffer.from(row.received_preimage as Uint8Array).toString("hex")).toBe(material.vertexHex);
				expect(Buffer.from(row.received_signature as Uint8Array).toString("hex")).toBe(material.signatureHex);
			} else {
				expect(row).toMatchObject({
					local_author: "creator",
					local_author_sequence: 0,
					received_preimage: null,
					received_signature: null,
					source_kind: "local-issued",
				});
			}
			expect(closure.scopes).toHaveLength(1);
			expect(Object.keys(closure.scopes[0] ?? {}).sort()).toEqual([
				"anchor_digest",
				"detached_anchor_signature",
				"epoch",
				"exact_anchor_preimage",
				"exact_parameters_carrier",
				"next_journal_sequence",
				"object_id",
				"parameters_digest",
			]);
			expect(closure.scopes[0]).toMatchObject({
				anchor_digest: material.anchorDigest,
				next_journal_sequence: 1,
				object_id: material.objectId,
				parameters_digest: material.parametersDigest,
			});
			expect(Buffer.from(closure.scopes[0]?.exact_anchor_preimage as Uint8Array).toString("hex")).toBe(
				material.anchorHex
			);
			expect(Buffer.from(closure.scopes[0]?.exact_parameters_carrier as Uint8Array).toString("hex")).toBe(
				material.parametersHex
			);
			expect(Buffer.from(closure.scopes[0]?.detached_anchor_signature as Uint8Array).toString("hex")).toBe(
				material.signatureHex
			);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});

	it("executes the full duplicate/local-reference/cross-kind precedence matrix against SQLite", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		for (const firstKind of ["received", "local-issued"] as const) {
			const primaryFilename = primary(`duplicates-${firstKind}`);
			const store = createNodeDurableLiveJournalStore({ primaryFilename });
			const values = exactInputs();
			try {
				await store.installGenesis(values.install);
				const first = firstKind === "received" ? values.received : values.local;
				expect(await store.appendAccepted(first)).toMatchObject({ idempotent: false, journalSequence: 0, ok: true });
				expect(await store.appendAccepted(first)).toMatchObject({
					idempotent: true,
					journalSequence: 0,
					ok: true,
					sourceKind: firstKind,
				});
				expect(await store.appendAccepted(firstKind === "received" ? values.local : values.received)).toMatchObject({
					idempotent: true,
					journalSequence: 0,
					ok: true,
					sourceKind: firstKind,
				});
				if (firstKind === "received") {
					expect(
						await store.appendAccepted({ ...values.received, detachedSignature: new Uint8Array(64).fill(9) })
					).toEqual({ kind: "evidence-conflict", ok: false });
				} else {
					expect(await store.appendAccepted({ ...values.local, vertexDigest: "6".repeat(64) })).toEqual({
						kind: "evidence-conflict",
						ok: false,
					});
					expect(await store.appendAccepted({ ...values.local, authorSequence: 1 })).toEqual({
						kind: "evidence-conflict",
						ok: false,
					});
				}
				await store.close();
				const closure = rawClosure(primaryFilename);
				expect(closure.rows).toHaveLength(1);
				expect(closure.rows[0]).toMatchObject({ journal_sequence: 0, source_kind: firstKind });
				expect(closure.scopes[0]).toMatchObject({ next_journal_sequence: 1 });
			} finally {
				await store.close();
			}
		}
		const primaryFilename = primary("duplicates-two-index-collision");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		const values = exactInputs();
		try {
			await store.installGenesis(values.install);
			expect(await store.appendAccepted(values.local)).toMatchObject({
				idempotent: false,
				journalSequence: 0,
				ok: true,
			});
			expect(
				await store.appendAccepted({ ...values.local, authorSequence: 1, vertexDigest: "6".repeat(64) })
			).toMatchObject({ idempotent: false, journalSequence: 1, ok: true });
			expect(await store.appendAccepted({ ...values.local, vertexDigest: "6".repeat(64) })).toEqual({
				kind: "evidence-conflict",
				ok: false,
			});
			await store.close();
			const closure = rawClosure(primaryFilename);
			expect(closure.rows).toHaveLength(2);
			expect(closure.rows.map(({ journal_sequence: sequence }) => sequence)).toEqual([0, 1]);
			expect(closure.scopes[0]).toMatchObject({ next_journal_sequence: 2 });
		} finally {
			await store.close();
		}
	});

	it("classifies the bounded exact-old/new/mixed/unreadable readback seam without leaking authority", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const { armPhase3a1bP4NodeReadbackFault } = await loadTestControl();
		for (const operation of ["install", "append"] as const) {
			for (const fate of ["exact-new", "exact-old", "mixed", "unreadable"] as const) {
				const store = createNodeDurableLiveJournalStore({ primaryFilename: primary(`fault-${operation}-${fate}`) });
				const values = exactInputs();
				try {
					if (operation === "append") await store.installGenesis(values.install);
					armPhase3a1bP4NodeReadbackFault(fate);
					const result =
						operation === "install"
							? await store.installGenesis(values.install)
							: await store.appendAccepted(values.received);
					if (fate === "exact-new") {
						expect(result).toMatchObject({ idempotent: false, ok: true });
					} else {
						expect(result).toEqual({
							kind:
								fate === "exact-old" ? "substrate-failure" : fate === "mixed" ? "store-poisoned" : "outcome-unknown",
							ok: false,
						});
					}
					if (fate === "mixed") {
						expect(await store.readiness({ scope: values.scope })).toEqual({ kind: "store-poisoned", ok: false });
					}
				} finally {
					await store.close();
				}
			}
		}
	});

	it("reopens a nonempty WAL without deleting sidecars and observes the exact durable closure", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("wal-reopen");
		const first = createNodeDurableLiveJournalStore({ primaryFilename });
		const values = exactInputs();
		try {
			await first.installGenesis(values.install);
			await first.appendAccepted(values.received);
			const wal = `${primaryFilename}.drp-live-journal-v1.sqlite-wal`;
			expect(fs.statSync(wal).size).toBeGreaterThan(0);
			const second = createNodeDurableLiveJournalStore({ primaryFilename });
			try {
				expect(await second.readiness({ scope: values.scope })).toMatchObject({ ok: true, ready: true, rowCount: 1 });
				expect(fs.statSync(wal).size).toBeGreaterThan(0);
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
		}
	});

	it("freezes 18 genuine statement-boundary tuples and a private, production-unreachable preload", () => {
		expect(P4_NODE_DEATH_TUPLES).toHaveLength(36);
		expect(new Set(P4_NODE_DEATH_TUPLES.map(({ id }) => id))).toHaveLength(36);
		expect(P4_NODE_NO_WRITE_DEATH_TUPLES.map(({ scenario }) => scenario)).toEqual([
			"idempotent-genesis",
			"received-repeat",
			"local-repeat",
			"cross-kind-race",
			"local-ref-race",
		]);
		const preload = fs.readFileSync(PRELOAD, "utf8");
		const child = fs.readFileSync(CHILD, "utf8");
		expect(preload).toContain("DatabaseSync.prototype.exec");
		expect(preload).toContain('observe("after-commit"');
		expect(child).toContain("child-error");
		expect(child).toContain("dist/src/live-journal.js");
		expect(
			JSON.stringify(JSON.parse(fs.readFileSync(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")))
		).not.toContain("phase-3a1b-p4-node-preload");
	});
});

describe.skipIf(!RUN_LONG)("D.93.34 p4-b genuine Node SIGKILL roster", () => {
	it("kills every install/received/local edge before authority can escape", async () => {
		for (const tuple of P4_NODE_DEATH_TUPLES) {
			const primaryFilename = primary(tuple.id.replaceAll("/", "-"));
			const messages = await runKilled(tuple, primaryFilename);
			expect(
				messages.filter(({ kind }) => kind === "checkpoint"),
				tuple.id
			).toHaveLength(1);
			expect(
				messages.some(({ kind }) => kind === "unexpected-result"),
				tuple.id
			).toBe(false);
			const recovery = await runRecovery(tuple, primaryFilename);
			const expectedReady = tuple.terminalFate === "exact-new" || tuple.scenario !== "install-genesis";
			const expectedRows = tuple.scenario === "install-genesis" || tuple.terminalFate === "old" ? 0 : 1;
			expect(recovery.primary, tuple.id).toMatchObject({ ok: true, ready: expectedReady, rowCount: expectedRows });
			expect(recovery.raw, tuple.id).toEqual(recovery.expectedRaw);
			expect(recovery.raw?.rows, tuple.id).toHaveLength(expectedRows);
			expect(recovery.raw?.scopes, tuple.id).toHaveLength(
				(expectedReady ? 1 : 0) + (tuple.scopeScenario === "two-scopes" ? 1 : 0)
			);
			if (expectedReady) {
				const primaryScope = recovery.raw?.scopes.find((scope) => scope.object_id === loadMaterial().objectId);
				expect(primaryScope, tuple.id).toMatchObject({ next_journal_sequence: expectedRows });
			}
			if (tuple.scopeScenario === "two-scopes") {
				expect(recovery.unaddressed, tuple.id).toMatchObject({ ok: true, ready: true, rowCount: 0 });
			}
		}
	}, 180_000);

	it("kills five no-write repeat/race paths and reopens the byte-identical durable closure", async () => {
		for (const tuple of P4_NODE_NO_WRITE_DEATH_TUPLES) {
			const primaryFilename = primary(tuple.id.replaceAll("/", "-"));
			const messages = await runKilled(tuple as (typeof P4_NODE_DEATH_TUPLES)[number], primaryFilename);
			expect(
				messages.filter(({ kind }) => kind === "checkpoint"),
				tuple.id
			).toHaveLength(1);
			if (tuple.scenario === "cross-kind-race" || tuple.scenario === "local-ref-race") {
				expect(
					messages.some(({ kind }) => kind === "race-writers-invoked"),
					tuple.id
				).toBe(true);
			}
			const recovery = await runRecovery(tuple as (typeof P4_NODE_DEATH_TUPLES)[number], primaryFilename);
			const expectedRows = tuple.scenario === "idempotent-genesis" ? 0 : 1;
			expect(recovery.raw, tuple.id).toEqual(recovery.expectedRaw);
			expect(recovery.raw?.rows).toHaveLength(expectedRows);
			expect(recovery.raw?.scopes).toHaveLength(1);
			expect(recovery.raw?.scopes[0]).toMatchObject({ next_journal_sequence: expectedRows });
		}
	}, 60_000);
});
