import { build, type Plugin } from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	P4_NODE_DEATH_TUPLES,
	P4_NODE_METHODS,
	P4_NODE_NO_WRITE_DEATH_TUPLES,
	P4_NODE_SCHEMA,
	P4_NODE_SQLITE_CATALOG,
} from "./fixtures/phase-3a1b-p4-node-contract.js";
import * as nodePreload from "./fixtures/phase-3a1b-p4-node-preload.mjs";
import {
	isPhase3a1bP4NodeMutationScopeRead,
	referencesPhase3a1bP4NodeTable,
} from "./fixtures/phase-3a1b-p4-node-sql-classifier.mjs";
import { encodeCanonical, hashDomain } from "../../canonical/dist/src/index.js";

const {
	armPhase3a1bP4NodeReadbackFault,
	armPhase3a1bP4NodeReadbackInterleave,
	observePhase3a1bP4NodeOperation,
	takePhase3a1bP4NodeObservationLedger,
} = nodePreload;
const armPhase3a1bP4NodeDataVersionInterleaves = (
	nodePreload as unknown as {
		armPhase3a1bP4NodeDataVersionInterleaves(interleaves: readonly Readonly<Record<string, unknown>>[]): void;
	}
).armPhase3a1bP4NodeDataVersionInterleaves;

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

interface QueryEvidence {
	readonly connection: string;
	readonly dataVersion: boolean;
	readonly dataVersionValue: number | null;
	readonly method: "all" | "get" | "run";
	readonly operation: string;
	readonly parameters: readonly unknown[];
	readonly phase: "outside" | "postcommit" | "readonly" | "writer";
	readonly role: "distinct" | "ordinary" | "target";
	readonly sql: string;
	readonly table: "accepted_entries" | "scopes" | null;
	readonly tables: readonly ("accepted_entries" | "scopes")[];
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
const INTERLEAVE_WORKER = new URL("./fixtures/phase-3a1b-p4-node-interleave-worker.mjs", import.meta.url);
const DECISION_MUTANT = path.resolve(
	PACKAGE_DIRECTORY,
	"../../tests/fixtures/phase-3a1b-p4/runtime-mutants/shared-decision-runtime-mutant.ts"
);
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

async function loadDecisionMutantCandidate(label: string): Promise<Candidate> {
	const source = path.join(PACKAGE_DIRECTORY, "src/live-journal.ts");
	const shared = path.resolve(PACKAGE_DIRECTORY, "../live-journal/src/index.ts");
	const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `phase-3a1b-p4-node-${label}-`));
	directories.push(directory);
	const output = path.join(directory, "candidate.mjs");
	const plugin: Plugin = {
		name: "phase-3a1b-p4-shared-decision-mutant",
		setup(builder): void {
			builder.onResolve({ filter: /^@ts-drp\/live-journal$/ }, ({ importer }) => ({
				path: path.resolve(importer) === DECISION_MUTANT ? shared : DECISION_MUTANT,
			}));
		},
	};
	await build({
		bundle: true,
		entryPoints: [source],
		format: "esm",
		outfile: output,
		platform: "node",
		plugins: [plugin],
		target: "node22",
	});
	return (await import(`${pathToFileURL(output).href}?${label}`)) as Candidate;
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

function generatedInputs(
	seed: string,
	authorSequence = 0
): {
	readonly install: Readonly<Record<string, unknown>>;
	readonly local: Readonly<Record<string, unknown>>;
	readonly received: Readonly<Record<string, unknown>>;
	readonly scope: Readonly<{ readonly anchorDigest: string; readonly epoch: 0; readonly objectId: string }>;
} {
	const zero = "0".repeat(64);
	const objectId = `creator:${seed.repeat(32)}`;
	const parametersBytes = encodeCanonical({
		maxEpochVertices: 64,
		maxEpochBytes: 1_048_576,
		maxDependencies: 8,
		snapshotChunkBytes: 65_536,
		maxSnapshotBytes: 1_048_576,
		maxPendingEntries: 64,
		maxPendingBytes: 1_048_576,
	});
	const parametersDigest = Buffer.from(hashDomain("ts-drp/parameters/v3", parametersBytes)).toString("hex");
	const anchorBytes = encodeCanonical({
		kind: "drp-epoch-anchor",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		previousAnchor: zero,
		cutDigest: zero,
		stateDigest: zero,
		aclDigest: zero,
		historyRoot: zero,
		historySize: 0,
		archiveIndexRoot: zero,
		blueprintDigest: "2".repeat(64),
		signerSetDigest: "3".repeat(64),
		parametersDigest,
		profileDigest: "4".repeat(64),
		cryptoSuiteId: "ed25519-sha256-v3",
	});
	const anchorDigest = Buffer.from(hashDomain("ts-drp/epoch-anchor/v3", anchorBytes)).toString("hex");
	const vertexBytes = encodeCanonical({
		kind: "drp-vertex",
		protocolMajor: 3,
		objectId,
		epoch: 0,
		anchor: anchorDigest,
		author: `creator-${seed}`,
		authorSequence,
		logicalTime: authorSequence + 1,
		dependencies: ["5".repeat(64)],
		operation: { arguments: { value: authorSequence + 1 }, type: "append" },
	});
	const vertexDigest = Buffer.from(hashDomain("ts-drp/vertex/v3", vertexBytes)).toString("hex");
	const signature = new Uint8Array(64).fill(7);
	const scope = { anchorDigest, epoch: 0 as const, objectId };
	return {
		install: {
			detachedAnchorSignature: signature,
			exactCanonicalAnchorPreimageBytes: anchorBytes,
			exactCanonicalParametersCarrierBytes: parametersBytes,
			objectId,
		},
		local: { author: `creator-${seed}`, authorSequence, scope, sourceKind: "local-issued", vertexDigest },
		received: {
			detachedSignature: signature,
			exactCanonicalPreimageBytes: vertexBytes,
			scope,
			sourceKind: "received",
			vertexDigest,
		},
		scope,
	};
}

function takeQueryEvidence(): readonly QueryEvidence[] {
	return (
		nodePreload as unknown as {
			takePhase3a1bP4NodeQueryLedger(): readonly QueryEvidence[];
		}
	).takePhase3a1bP4NodeQueryLedger();
}

function acceptedAll(evidence: readonly QueryEvidence[]): readonly QueryEvidence[] {
	return evidence.filter(({ method, tables }) => method === "all" && tables.includes("accepted_entries"));
}

function normalizedTopology(evidence: readonly QueryEvidence[]): string {
	return JSON.stringify(
		evidence.map(({ dataVersion, method, parameters, phase, role, sql, tables }) => ({
			dataVersion,
			method,
			parameterCount: parameters.length,
			phase,
			role,
			sql: sql.trim().replace(/\s+/gu, " "),
			tables,
		}))
	);
}

function explainDetails(primaryFilename: string, evidence: QueryEvidence): readonly string[] {
	const database = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: true,
	});
	try {
		const parameters = evidence.parameters as readonly (bigint | number | string | Uint8Array | null)[];
		return database
			.prepare(`EXPLAIN QUERY PLAN ${evidence.sql}`)
			.all(...parameters)
			.map(({ detail }) => String(detail));
	} finally {
		database.close();
	}
}

function expectIndexedFastAppend(primaryFilename: string, evidence: readonly QueryEvidence[]): void {
	expect(acceptedAll(evidence)).toEqual([]);
	const versions = evidence.filter(({ dataVersion, method }) => dataVersion && method === "get");
	expect(new Set(versions.map(({ operation }) => operation))).toEqual(
		new Set(evidence.map(({ operation }) => operation))
	);
	for (const operation of new Set(versions.map(({ operation }) => operation))) {
		const operationVersions = versions.filter((evidence) => evidence.operation === operation);
		expect(
			operationVersions.map(({ phase }) => phase),
			operation
		).toEqual(["writer", "postcommit", "readonly", "outside"]);
		expect(
			operationVersions.every(({ dataVersionValue }) => Number.isSafeInteger(dataVersionValue)),
			operation
		).toBe(true);
		expect(new Set(operationVersions.map(({ dataVersionValue }) => dataVersionValue)), operation).toHaveLength(1);
	}
	const indexed = evidence.filter(
		(item) =>
			item.method === "get" && !item.dataVersion && (item.table === "scopes" || item.table === "accepted_entries")
	);
	expect(indexed.length).toBeGreaterThanOrEqual(4);
	const planned = indexed.map((item) => ({ item, details: explainDetails(primaryFilename, item) }));
	for (const { details } of planned) {
		expect(details.some((detail) => /\bSEARCH\b/u.test(detail))).toBe(true);
		expect(details.some((detail) => /\bSCAN(?:\s+TABLE)?\s+accepted_entries\b/u.test(detail))).toBe(false);
	}
	const detailFor = (pattern: RegExp): readonly string[] =>
		planned.filter(({ item }) => pattern.test(item.sql)).flatMap(({ details }) => details);
	expect(detailFor(/\bFROM\s+(?:main\.)?scopes\b/iu).some((detail) => /USING PRIMARY KEY/iu.test(detail))).toBe(true);
	expect(detailFor(/(?:^|\W)journal_sequence\s*=\s*\?/iu).some((detail) => /USING PRIMARY KEY/iu.test(detail))).toBe(
		true
	);
	expect(detailFor(/vertex_digest\s*=\s*\?/iu).some((detail) => /accepted_entries_2/iu.test(detail))).toBe(true);
	expect(
		detailFor(/local_author\s*=\s*\?[\s\S]*local_author_sequence\s*=\s*\?/iu).some((detail) =>
			/accepted_entries_3/iu.test(detail)
		)
	).toBe(true);
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

function corruptReceivedSignature(primaryFilename: string, objectId: string, byteLength = 63): void {
	const database = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: false,
	});
	try {
		database.exec("BEGIN IMMEDIATE");
		const update = database
			.prepare(
				`UPDATE accepted_entries SET received_signature=zeroblob(${byteLength}) WHERE object_id=? AND journal_sequence=0`
			)
			.run(objectId);
		if (update.changes !== 1) throw new Error("test-owned corruption target was not unique");
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the test-owned corruption failure.
		}
		throw error;
	} finally {
		database.close();
	}
}

function rawCatalog(primaryFilename: string): readonly Record<string, unknown>[] {
	const database = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: true,
	});
	try {
		return database
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
			.all() as readonly Record<string, unknown>[];
	} finally {
		database.close();
	}
}

function applyNodeReadbackFate(
	primaryFilename: string,
	operation: "append" | "install",
	fate: "exact-old" | "mixed"
): void {
	const database = new DatabaseSync(`${primaryFilename}.drp-live-journal-v1.sqlite`, {
		allowExtension: false,
		enableDoubleQuotedStringLiterals: false,
		enableForeignKeyConstraints: false,
		readOnly: false,
	});
	try {
		database.exec("BEGIN IMMEDIATE");
		if (operation === "install") {
			if (fate === "exact-old") database.exec("DELETE FROM scopes");
			else database.exec("UPDATE scopes SET detached_anchor_signature=zeroblob(64)");
		} else if (fate === "exact-old") {
			database.exec("DELETE FROM accepted_entries");
			database.exec("UPDATE scopes SET next_journal_sequence=0");
		} else {
			database.exec("UPDATE scopes SET next_journal_sequence=0");
		}
		database.exec("COMMIT");
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
	it("classifies exact quoted and qualified SQLite journal tables without writer/readback conflation", () => {
		for (const sql of [
			"SELECT * FROM scopes",
			'SELECT * FROM main."scopes"',
			'SELECT * FROM "main"."scopes"',
			"SELECT * FROM `main`.`scopes`",
		]) {
			expect(referencesPhase3a1bP4NodeTable(sql, "scopes")).toBe(true);
			expect(isPhase3a1bP4NodeMutationScopeRead(sql)).toBe(true);
		}
		for (const sql of [
			"SELECT * FROM scope",
			"SELECT 'FROM scopes'",
			"UPDATE accepted_entries SET source_kind = 'FROM scopes'",
			"SELECT * FROM scopes_archive",
		]) {
			expect(referencesPhase3a1bP4NodeTable(sql, "scopes")).toBe(false);
		}
		expect(isPhase3a1bP4NodeMutationScopeRead("UPDATE scopes SET next_journal_sequence = 1")).toBe(false);
	});

	it("round-trips the complete SQLite catalog and forbids permissive migration sediment", () => {
		const database = new DatabaseSync(":memory:", {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			enableForeignKeyConstraints: false,
			readOnly: false,
		});
		try {
			database.exec(P4_NODE_SCHEMA.scopes);
			database.exec(P4_NODE_SCHEMA.acceptedEntries);
			const rows = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
			expect(rows).toEqual(P4_NODE_SQLITE_CATALOG);
			expect(rows.filter(({ type }) => type === "trigger" || type === "view")).toEqual([]);
			expect(Object.values(P4_NODE_SCHEMA).every((sql) => !sql.includes("IF NOT EXISTS"))).toBe(true);
		} finally {
			database.close();
		}
	});

	it("uses exactly one readonly snapshot for readiness and each page and readbacks idempotent no-write paths", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const store = createNodeDurableLiveJournalStore({ primaryFilename: primary("readonly-ledger") });
		const values = exactInputs();
		try {
			takePhase3a1bP4NodeObservationLedger();
			await observePhase3a1bP4NodeOperation("genesis-new", () => store.installGenesis(values.install));
			await observePhase3a1bP4NodeOperation("genesis-repeat", () => store.installGenesis(values.install));
			await observePhase3a1bP4NodeOperation("received-new", () => store.appendAccepted(values.received));
			await observePhase3a1bP4NodeOperation("received-repeat", () => store.appendAccepted(values.received));
			await observePhase3a1bP4NodeOperation("local-cross-kind", () => store.appendAccepted(values.local));
			const local = { ...values.local, authorSequence: 1, vertexDigest: "6".repeat(64) };
			await observePhase3a1bP4NodeOperation("local-new", () => store.appendAccepted(local));
			await observePhase3a1bP4NodeOperation("local-repeat", () => store.appendAccepted(local));
			await observePhase3a1bP4NodeOperation("local-ref-conflict", () =>
				store.appendAccepted({ ...local, vertexDigest: "7".repeat(64) })
			);
			const ready = await observePhase3a1bP4NodeOperation("readiness", () => store.readiness({ scope: values.scope }));
			await observePhase3a1bP4NodeOperation("page", () =>
				store.readPage({ afterSequence: null, limit: 64, scope: values.scope, snapshot: ready.snapshot })
			);
			const ledger = takePhase3a1bP4NodeObservationLedger();
			const expectOneSnapshot = (label: string): void => {
				const begin = ledger.filter((event) => event.startsWith(`${label}:target:readonly-begin:`));
				const commit = ledger.filter((event) => event.startsWith(`${label}:target:readonly-commit:`));
				const queries = ledger.filter((event) => event.startsWith(`${label}:target:closure-query:readonly:`));
				expect(begin).toHaveLength(1);
				expect(commit).toHaveLength(1);
				expect(queries.map((event) => event.split(":").at(-2)).sort()).toEqual(["accepted_entries", "scopes"]);
				const connections = [...begin, ...commit, ...queries].map((event) => event.split(":").at(-1));
				expect(new Set(connections).size).toBe(1);
				expect(
					ledger.filter(
						(event) =>
							event.startsWith(`${label}:target:closure-query:outside:`) ||
							event.startsWith(`${label}:target:closure-query:postcommit:`)
					)
				).toEqual([]);
				expect(ledger.filter((event) => event === `${label}:target:return`)).toHaveLength(1);
			};
			for (const label of [
				"genesis-new",
				"genesis-repeat",
				"received-new",
				"received-repeat",
				"local-cross-kind",
				"local-new",
				"local-repeat",
			]) {
				expect(ledger.filter((event) => event === `${label}:target:begin-immediate`)).toHaveLength(1);
				expect(ledger.filter((event) => event === `${label}:target:commit`)).toHaveLength(1);
				expectOneSnapshot(label);
			}
			expect(ledger.filter((event) => event === "local-ref-conflict:target:begin-immediate")).toHaveLength(1);
			expect(ledger.filter((event) => event === "local-ref-conflict:target:rollback")).toHaveLength(1);
			expectOneSnapshot("local-ref-conflict");
			expectOneSnapshot("readiness");
			expectOneSnapshot("page");
		} finally {
			await store.close();
		}
	});

	it("uses only indexed addressed evidence for validated received and local monotonic appends", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("addressed-indexes");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		const first = generatedInputs("1", 0);
		const second = generatedInputs("1", 1);
		try {
			expect(await store.installGenesis(first.install)).toMatchObject({ ok: true });
			takeQueryEvidence();
			takePhase3a1bP4NodeObservationLedger();
			expect(
				await observePhase3a1bP4NodeOperation("addressed-received", () => store.appendAccepted(first.received))
			).toMatchObject({ idempotent: false, journalSequence: 0, ok: true, sourceKind: "received" });
			expect(
				await observePhase3a1bP4NodeOperation("addressed-local", () => store.appendAccepted(second.local))
			).toMatchObject({ idempotent: false, journalSequence: 1, ok: true, sourceKind: "local-issued" });
			const evidence = takeQueryEvidence();
			expectIndexedFastAppend(primaryFilename, evidence);
			expect(new Set(evidence.map(({ connection }) => connection))).toHaveLength(1);
			expect(
				evidence
					.filter(({ method, sql }) => method === "get" && /(?:^|\W)journal_sequence\s*=\s*\?/iu.test(sql))
					.map(({ operation, parameters }) => [operation, parameters.at(-1)])
			).toEqual([
				["addressed-received", 0],
				["addressed-local", 1],
			]);
			const topology = takePhase3a1bP4NodeObservationLedger();
			for (const label of ["addressed-received", "addressed-local"]) {
				expect(topology.filter((event) => event === `${label}:target:begin-immediate`)).toHaveLength(1);
				expect(topology.filter((event) => event === `${label}:target:commit`)).toHaveLength(1);
				expect(topology.filter((event) => event.startsWith(`${label}:target:readonly-begin:`))).toHaveLength(1);
				expect(topology.filter((event) => event.startsWith(`${label}:target:readonly-commit:`))).toHaveLength(1);
			}
		} finally {
			await store.close();
		}
	});

	it("keeps validated monotonic append statement topology constant without accepted-row materialization", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("addressed-bounded-loop");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		try {
			await store.installGenesis(generatedInputs("3").install);
			takeQueryEvidence();
			for (let index = 0; index < 12; index += 1) {
				const values = generatedInputs("3", index);
				expect(
					await observePhase3a1bP4NodeOperation(`bounded-${index}`, () => store.appendAccepted(values.received))
				).toMatchObject({ idempotent: false, journalSequence: index, ok: true });
			}
			const evidence = takeQueryEvidence();
			expect(acceptedAll(evidence)).toEqual([]);
			const perAppendEvidence = Array.from({ length: 12 }, (_, index) =>
				evidence.filter(({ operation }) => operation === `bounded-${index}`)
			);
			const perAppend = perAppendEvidence.map((operationEvidence) => operationEvidence.length);
			expect(new Set(perAppend)).toHaveLength(1);
			expect(perAppend[0]).toBeGreaterThan(0);
			expect(perAppend[0]).toBeLessThanOrEqual(16);
			expect(new Set(perAppendEvidence.map(normalizedTopology))).toHaveLength(1);
		} finally {
			await store.close();
		}
	});

	it("fully validates one reopened append, refreshes after external drift, then returns to addressed probes", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("addressed-reopen-drift");
		const first = createNodeDurableLiveJournalStore({ primaryFilename });
		try {
			await first.installGenesis(generatedInputs("4").install);
			await first.appendAccepted(generatedInputs("4", 0).received);
		} finally {
			await first.close();
		}

		const reopened = createNodeDurableLiveJournalStore({ primaryFilename });
		try {
			takeQueryEvidence();
			expect(
				await observePhase3a1bP4NodeOperation("reopen-full", () =>
					reopened.appendAccepted(generatedInputs("4", 1).local)
				)
			).toMatchObject({ idempotent: false, journalSequence: 1, ok: true });
			expect(
				await observePhase3a1bP4NodeOperation("reopen-fast", () =>
					reopened.appendAccepted(generatedInputs("4", 2).local)
				)
			).toMatchObject({ idempotent: false, journalSequence: 2, ok: true });
			let evidence = takeQueryEvidence();
			expect(acceptedAll(evidence.filter(({ operation }) => operation === "reopen-full")).length).toBeGreaterThan(0);
			expect(acceptedAll(evidence.filter(({ operation }) => operation === "reopen-fast"))).toEqual([]);

			const other = createNodeDurableLiveJournalStore({ primaryFilename });
			try {
				expect(await other.appendAccepted(generatedInputs("4", 3).local)).toMatchObject({
					idempotent: false,
					journalSequence: 3,
					ok: true,
				});
			} finally {
				await other.close();
			}
			takeQueryEvidence();
			expect(
				await observePhase3a1bP4NodeOperation("external-drift-full", () =>
					reopened.appendAccepted(generatedInputs("4", 4).local)
				)
			).toMatchObject({ idempotent: false, journalSequence: 4, ok: true });
			expect(
				await observePhase3a1bP4NodeOperation("external-drift-fast", () =>
					reopened.appendAccepted(generatedInputs("4", 5).local)
				)
			).toMatchObject({ idempotent: false, journalSequence: 5, ok: true });
			evidence = takeQueryEvidence();
			expect(
				acceptedAll(evidence.filter(({ operation }) => operation === "external-drift-full")).length
			).toBeGreaterThan(0);
			expect(acceptedAll(evidence.filter(({ operation }) => operation === "external-drift-fast"))).toEqual([]);
		} finally {
			await reopened.close();
		}
	});

	it("keeps independently validated scope watermarks when fast appends alternate", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("addressed-two-scopes");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		try {
			await store.installGenesis(generatedInputs("6").install);
			await store.installGenesis(generatedInputs("7").install);
			takeQueryEvidence();
			for (const [label, input] of [
				["scope-a-0", generatedInputs("6", 0).received],
				["scope-b-0", generatedInputs("7", 0).received],
				["scope-a-1", generatedInputs("6", 1).local],
				["scope-b-1", generatedInputs("7", 1).local],
			] as const) {
				expect(await observePhase3a1bP4NodeOperation(label, () => store.appendAccepted(input))).toMatchObject({
					idempotent: false,
					ok: true,
				});
			}
			const evidence = takeQueryEvidence();
			expect(acceptedAll(evidence)).toEqual([]);
			for (const [operation, scope] of [
				["scope-a-0", generatedInputs("6").scope],
				["scope-b-0", generatedInputs("7").scope],
				["scope-a-1", generatedInputs("6").scope],
				["scope-b-1", generatedInputs("7").scope],
			] as const) {
				const scopeGets = evidence.filter(
					(item) => item.operation === operation && item.method === "get" && item.table === "scopes"
				);
				expect(scopeGets.length, operation).toBeGreaterThanOrEqual(2);
				expect(
					scopeGets.map(({ parameters }) => parameters.slice(0, 3)),
					operation
				).toEqual(Array.from({ length: scopeGets.length }, () => [scope.objectId, scope.epoch, scope.anchorDigest]));
			}

			corruptReceivedSignature(primaryFilename, generatedInputs("7").scope.objectId);
			takeQueryEvidence();
			expect(
				await observePhase3a1bP4NodeOperation("scope-a-after-b-corruption", () =>
					store.appendAccepted(generatedInputs("6", 2).local)
				)
			).toMatchObject({ idempotent: false, journalSequence: 2, ok: true });
			expect(
				await observePhase3a1bP4NodeOperation("scope-b-after-corruption", () =>
					store.appendAccepted(generatedInputs("7", 2).local)
				)
			).toEqual({ kind: "store-poisoned", ok: false });
			const driftEvidence = takeQueryEvidence();
			expect(
				acceptedAll(driftEvidence.filter(({ operation }) => operation === "scope-a-after-b-corruption")).length
			).toBeGreaterThan(0);
			expect(
				acceptedAll(driftEvidence.filter(({ operation }) => operation === "scope-b-after-corruption")).length
			).toBeGreaterThan(0);
			expect(
				rawClosure(primaryFilename)
					.rows.filter(({ object_id: objectId }) => objectId === generatedInputs("7").scope.objectId)
					.map(({ journal_sequence: sequence }) => sequence)
			).toEqual([0, 1]);
		} finally {
			await store.close();
		}
	});

	it("falls back and poisons both received and local appends when prior corruption lands before or after target commit", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		for (const timing of ["before", "after"] as const) {
			for (const sourceKind of ["received", "local-issued"] as const) {
				const primaryFilename = primary(`addressed-corrupt-${timing}-${sourceKind}`);
				const store = createNodeDurableLiveJournalStore({ primaryFilename });
				const values = generatedInputs("8", 1);
				const candidate = sourceKind === "received" ? values.received : values.local;
				const corrupt = (): void => corruptReceivedSignature(primaryFilename, values.scope.objectId);
				try {
					await store.installGenesis(values.install);
					await store.appendAccepted(generatedInputs("8", 0).received);
					if (timing === "before") corrupt();
					else armPhase3a1bP4NodeReadbackFault("exact-new", corrupt);
					takeQueryEvidence();
					const result = await observePhase3a1bP4NodeOperation(`corrupt-${timing}-${sourceKind}`, () =>
						store.appendAccepted(candidate)
					);
					expect(result, `${timing}/${sourceKind}`).toEqual({ kind: "store-poisoned", ok: false });
					expect(acceptedAll(takeQueryEvidence()).length, `${timing}/${sourceKind}`).toBeGreaterThan(0);
					expect(await store.readiness({ scope: values.scope }), `${timing}/${sourceKind}`).toEqual({
						kind: "store-poisoned",
						ok: false,
					});
					const closure = rawClosure(primaryFilename);
					expect(
						closure.rows.map(({ journal_sequence: sequence }) => sequence),
						`${timing}/${sourceKind}`
					).toEqual(timing === "before" ? [0] : [0, 1]);
				} finally {
					await store.close();
				}
			}
		}
	});

	it("invalidates addressed and full-fallback evidence when another facade commits between version reads", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		for (const mode of ["inside", "fallback"] as const) {
			const primaryFilename = primary(`addressed-version-bracket-${mode}`);
			const store = createNodeDurableLiveJournalStore({ primaryFilename });
			const values = generatedInputs("9", 1);
			try {
				await store.installGenesis(values.install);
				await store.appendAccepted(generatedInputs("9", 0).received);
				armPhase3a1bP4NodeDataVersionInterleaves(
					mode === "inside"
						? [
								{
									callback: (): void => corruptReceivedSignature(primaryFilename, values.scope.objectId, 63),
									occurrence: 1,
									phase: "postcommit",
								},
							]
						: [
								{
									callback: (): void => corruptReceivedSignature(primaryFilename, values.scope.objectId, 63),
									occurrence: 1,
									phase: "readonly",
								},
								{
									callback: (): void => corruptReceivedSignature(primaryFilename, values.scope.objectId, 62),
									occurrence: 2,
									phase: "readonly",
								},
							]
				);
				takeQueryEvidence();
				takePhase3a1bP4NodeObservationLedger();
				const result = await observePhase3a1bP4NodeOperation(`version-bracket-${mode}`, () =>
					store.appendAccepted(values.local)
				);
				expect(result, mode).toEqual(
					mode === "inside" ? { kind: "store-poisoned", ok: false } : { kind: "outcome-unknown", ok: false }
				);
				const ledger = takePhase3a1bP4NodeObservationLedger();
				expect(
					ledger.filter((event) => event.startsWith(`version-bracket-${mode}:distinct:data-version-interleave:`)),
					mode
				).toHaveLength(mode === "inside" ? 1 : 2);
				const evidence = takeQueryEvidence().filter(({ operation }) => operation === `version-bracket-${mode}`);
				expect(acceptedAll(evidence).length, mode).toBeGreaterThan(0);
				expect(
					new Set(evidence.filter(({ dataVersion }) => dataVersion).map(({ dataVersionValue }) => dataVersionValue))
						.size
				).toBeGreaterThan(1);
			} finally {
				await store.close();
			}
		}
	});

	it("routes all four shared pure decisions through the real Node adapter build", async () => {
		for (const mode of ["capture", "duplicate", "snapshot", "observation"] as const) {
			const { createNodeDurableLiveJournalStore } = await loadDecisionMutantCandidate(mode);
			const primaryFilename = primary(`decision-${mode}`);
			const store = createNodeDurableLiveJournalStore({ primaryFilename });
			const material = loadMaterial();
			const values = exactInputs(material);
			try {
				if (mode === "capture") Reflect.set(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__", mode);
				const installed = await store.installGenesis(values.install);
				if (mode === "capture") {
					expect(installed).toMatchObject({ ok: false });
					expect(rawClosure(primaryFilename)).toEqual({ rows: [], scopes: [] });
					continue;
				}
				expect(installed).toMatchObject({ ok: true });
				if (mode === "duplicate" || mode === "snapshot") {
					expect(await store.appendAccepted(values.received)).toMatchObject({ idempotent: false, ok: true });
				}
				Reflect.set(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__", mode);
				const result =
					mode === "snapshot"
						? await store.readiness({ scope: values.scope })
						: await store.appendAccepted(values.received);
				expect(result).toMatchObject({ ok: false });
				expect(result).not.toMatchObject({ idempotent: true, ok: true });
				const closure = rawClosure(primaryFilename);
				expect(closure.rows).toHaveLength(1);
				expect(closure.rows[0]).toMatchObject({
					anchor_digest: material.anchorDigest,
					epoch: 0,
					journal_sequence: 0,
					local_author: null,
					local_author_sequence: null,
					object_id: material.objectId,
					source_kind: "received",
					vertex_digest: material.vertexDigest,
				});
				expect(Buffer.from(closure.rows[0]?.received_preimage as Uint8Array).toString("hex")).toBe(material.vertexHex);
				expect(Buffer.from(closure.rows[0]?.received_signature as Uint8Array).toString("hex")).toBe(
					material.signatureHex
				);
				expect(closure.scopes).toMatchObject([
					{
						anchor_digest: material.anchorDigest,
						next_journal_sequence: 1,
						object_id: material.objectId,
						parameters_digest: material.parametersDigest,
					},
				]);
			} finally {
				Reflect.deleteProperty(globalThis, "__TS_DRP_P4_LIVE_JOURNAL_DECISION_MUTANT__");
				await store.close();
			}
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

	it("opens a genuine strict facade with six methods and an injective sidecar filename", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("surface");
		const store = createNodeDurableLiveJournalStore({ primaryFilename });
		try {
			expect(Object.keys(store).sort()).toEqual([...P4_NODE_METHODS].sort());
			expect(fs.existsSync(primaryFilename)).toBe(false);
			expect(fs.existsSync(`${primaryFilename}.drp-live-journal-v1.sqlite`)).toBe(true);
			expect(rawCatalog(primaryFilename)).toEqual(P4_NODE_SQLITE_CATALOG);
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
		for (const operation of ["install", "append"] as const) {
			for (const fate of ["exact-new", "exact-old", "mixed", "unreadable"] as const) {
				const primaryFilename = primary(`fault-${operation}-${fate}`);
				const store = createNodeDurableLiveJournalStore({ primaryFilename });
				const values = exactInputs();
				try {
					if (operation === "append") await store.installGenesis(values.install);
					armPhase3a1bP4NodeReadbackFault(
						fate,
						fate === "exact-old" || fate === "mixed"
							? (): void => applyNodeReadbackFate(primaryFilename, operation, fate)
							: undefined
					);
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

	it("does not poison when a second facade legally commits a distinct row between target commit and readback", async () => {
		const { createNodeDurableLiveJournalStore } = await loadCandidate();
		const primaryFilename = primary("legal-readback-interleave");
		const first = createNodeDurableLiveJournalStore({ primaryFilename });
		const values = exactInputs();
		try {
			await first.installGenesis(values.install);
			armPhase3a1bP4NodeReadbackInterleave({
				appendInput: { ...values.local, authorSequence: 1, vertexDigest: "6".repeat(64) },
				moduleUrl: new URL("../dist/src/live-journal.js", import.meta.url).href,
				primaryFilename,
				readinessInput: { scope: values.scope },
			});
			takePhase3a1bP4NodeObservationLedger();
			expect(
				await observePhase3a1bP4NodeOperation("append", () => first.appendAccepted(values.received))
			).toMatchObject({
				idempotent: false,
				journalSequence: 0,
				ok: true,
				sourceKind: "received",
			});
			const ledger = takePhase3a1bP4NodeObservationLedger();
			expect(ledger).toEqual(
				expect.arrayContaining([
					"append:distinct:commit",
					"append:distinct:readonly-readback",
					"append:distinct:return",
				])
			);
			const targetConnections = ledger
				.filter(
					(event) =>
						event.startsWith("append:target:readonly-") || event.startsWith("append:target:closure-query:readonly:")
				)
				.map((event) => event.split(":").at(-1));
			expect(new Set(targetConnections).size).toBe(1);
			expect(
				ledger.filter(
					(event) =>
						event.startsWith("append:target:closure-query:outside:") ||
						event.startsWith("append:target:closure-query:postcommit:")
				)
			).toEqual([]);
			expect(ledger.some((event) => event.includes(":closure-query:writer:"))).toBe(false);
			const ordered = [
				ledger.indexOf("append:target:commit"),
				ledger.indexOf("append:distinct:commit"),
				ledger.indexOf("append:distinct:readonly-readback"),
				ledger.indexOf("append:distinct:return"),
				ledger.findIndex((event) => event.startsWith("append:target:readonly-begin:")),
				ledger.indexOf("append:target:return"),
			];
			expect(ordered.every((index) => index >= 0)).toBe(true);
			expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
			expect(await first.readiness({ scope: values.scope })).toMatchObject({ ok: true, ready: true, rowCount: 2 });
			const closure = rawClosure(primaryFilename);
			expect(closure.rows.map(({ journal_sequence: sequence }) => sequence)).toEqual([0, 1]);
			expect(closure.scopes).toMatchObject([{ next_journal_sequence: 2 }]);
		} finally {
			await first.close();
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
		const interleaveWorker = fs.readFileSync(INTERLEAVE_WORKER, "utf8");
		const child = fs.readFileSync(CHILD, "utf8");
		expect(preload).toContain("DatabaseSync.prototype.exec");
		expect(preload).toContain('observe("after-commit"');
		expect(interleaveWorker).toContain("createNodeDurableLiveJournalStore");
		expect(interleaveWorker).toContain("await store.readiness");
		expect(interleaveWorker).toContain("Atomics.notify");
		expect(child).toContain("child-error");
		expect(child).toContain("dist/src/live-journal.js");
		expect(
			JSON.stringify(JSON.parse(fs.readFileSync(path.join(PACKAGE_DIRECTORY, "package.json"), "utf8")))
		).not.toMatch(/phase-3a1b-p4-node-(?:interleave-worker|preload)/u);
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
			if (expectedReady) {
				expect(recovery.primary, tuple.id).toMatchObject({ ok: true, ready: true, rowCount: expectedRows });
			} else {
				expect(recovery.primary, tuple.id).toMatchObject({ ok: true, ready: false });
				expect(Object.hasOwn(recovery.primary ?? {}, "rowCount"), tuple.id).toBe(false);
			}
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
