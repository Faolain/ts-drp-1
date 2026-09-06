import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

type MutationOperation =
	| "beginGeneration"
	| "completeGeneration"
	| "discardGeneration"
	| "promoteReference"
	| "putCachedBlob"
	| "swapHead";

type CrashCheckpoint =
	| Readonly<{
			edge: "after-statement";
			occurrence: number;
			operation: MutationOperation;
			statement:
				| "blob-insert"
				| "generation-insert"
				| "generation-update"
				| "head-upsert"
				| "object-ensure"
				| "promotion-insert";
	  }>
	| Readonly<{ edge: "after-commit" | "before-commit"; operation: MutationOperation }>;

type Scenario = Readonly<{
	checkpoints: readonly CrashCheckpoint[];
	operation: MutationOperation;
}>;

const commitEdges = (operation: MutationOperation): readonly CrashCheckpoint[] => [
	{ edge: "before-commit", operation },
	{ edge: "after-commit", operation },
];

const statement = (
	operation: MutationOperation,
	name: Extract<CrashCheckpoint, { edge: "after-statement" }>["statement"],
	occurrence = 1
): CrashCheckpoint => ({ edge: "after-statement", occurrence, operation, statement: name });

/** One inventory owns both fast acceptance and the opt-in repeated campaign. */
const SCENARIOS: readonly Scenario[] = [
	{
		operation: "beginGeneration",
		checkpoints: [
			statement("beginGeneration", "object-ensure"),
			statement("beginGeneration", "generation-insert"),
			...commitEdges("beginGeneration"),
		],
	},
	{
		operation: "putCachedBlob",
		checkpoints: [statement("putCachedBlob", "blob-insert"), ...commitEdges("putCachedBlob")],
	},
	{
		operation: "promoteReference",
		checkpoints: [statement("promoteReference", "promotion-insert"), ...commitEdges("promoteReference")],
	},
	{
		operation: "completeGeneration",
		checkpoints: [
			statement("completeGeneration", "object-ensure"),
			statement("completeGeneration", "generation-update"),
			...commitEdges("completeGeneration"),
		],
	},
	{
		operation: "swapHead",
		checkpoints: [
			statement("swapHead", "object-ensure", 1),
			statement("swapHead", "generation-update", 1),
			statement("swapHead", "object-ensure", 2),
			statement("swapHead", "generation-update", 2),
			statement("swapHead", "head-upsert"),
			...commitEdges("swapHead"),
		],
	},
	{
		operation: "discardGeneration",
		checkpoints: [
			statement("discardGeneration", "object-ensure"),
			statement("discardGeneration", "generation-update"),
			...commitEdges("discardGeneration"),
		],
	},
];

const CHECKPOINTS = SCENARIOS.flatMap(({ checkpoints }) => checkpoints);
const RUN_LONG = process.env.TS_DRP_STORAGE_NODE_LONG_SIGKILL === "1";
const FAST_REPETITIONS = 1;
const LONG_REPETITIONS = 5;
const temporaryDirectories: string[] = [];
const fixture = new URL("./fixtures/sqlite-sigkill-child.mjs", import.meta.url);

type ChildMessage = Readonly<{
	checkpoint?: CrashCheckpoint;
	kind: string;
	message?: string;
	result?: Readonly<{ ok: boolean; reason?: string }>;
}>;

type ChildRun = Readonly<{
	exitCode: number | null;
	messages: readonly ChildMessage[];
	signal: NodeJS.Signals | null;
	stderr: string;
}>;

function checkpointMatches(actual: CrashCheckpoint | undefined, expected: CrashCheckpoint | undefined): boolean {
	return (
		actual !== undefined &&
		expected !== undefined &&
		Object.entries(expected).every(([key, value]) => actual[key as keyof CrashCheckpoint] === value)
	);
}

async function databaseFilename(label: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `ts-drp-sigkill-${label}-`));
	temporaryDirectories.push(directory);
	return join(directory, "store.sqlite");
}

function runChild(
	filename: string,
	operation: MutationOperation,
	mode: "crash" | "new" | "old" | "retry",
	target?: CrashCheckpoint
): Promise<ChildRun> {
	return new Promise((resolve, reject) => {
		const arguments_ = [fixture.pathname, filename, operation, mode];
		if (target !== undefined) arguments_.push(JSON.stringify(target));
		const child = spawn(process.execPath, arguments_, {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const messages: ChildMessage[] = [];
		let stderr = "";
		let killedAtTarget = false;
		const childStderr = child.stderr;
		if (childStderr === null) {
			reject(new Error("SIGKILL fixture child has no stderr pipe"));
			return;
		}
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`child timeout for ${operation}:${JSON.stringify(target)}`));
		}, 10_000);
		childStderr.setEncoding("utf8");
		childStderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("message", (message: ChildMessage) => {
			messages.push(message);
			if (mode === "crash" && message.kind === "checkpoint" && checkpointMatches(message.checkpoint, target)) {
				killedAtTarget = true;
				child.kill("SIGKILL");
			}
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (exitCode, signal) => {
			clearTimeout(timeout);
			if (mode === "crash" && killedAtTarget && signal !== "SIGKILL") {
				reject(new Error(`targeted child exited without SIGKILL: ${signal ?? String(exitCode)}`));
				return;
			}
			resolve({ exitCode, messages, signal, stderr });
		});
	});
}

function bytesHex(value: unknown): string | null {
	return value === null ? null : Buffer.from(value as Uint8Array).toString("hex");
}

function databaseSnapshot(filename: string): unknown {
	const database = new DatabaseSync(filename);
	try {
		return {
			blobs: (
				database.prepare("SELECT digest, bytes FROM blobs ORDER BY digest").all() as Record<string, unknown>[]
			).map(({ bytes, digest }) => ({ bytes: bytesHex(bytes), digest })),
			generations: (
				database
					.prepare("SELECT object_id, generation_id, record FROM generations ORDER BY object_id, generation_id")
					.all() as Record<string, unknown>[]
			).map(({ generation_id, object_id, record }) => ({
				generationId: generation_id,
				objectId: object_id,
				record: bytesHex(record),
			})),
			objects: (
				database.prepare("SELECT object_id, head_record FROM objects ORDER BY object_id").all() as Record<
					string,
					unknown
				>[]
			).map(({ head_record, object_id }) => ({ headRecord: bytesHex(head_record), objectId: object_id })),
			promotions: database
				.prepare("SELECT object_id, generation_id, digest FROM promotions ORDER BY object_id, generation_id, digest")
				.all(),
		};
	} finally {
		database.close();
	}
}

async function createControl(operation: MutationOperation, state: "new" | "old"): Promise<unknown> {
	const filename = await databaseFilename(`${operation}-${state}`);
	const run = await runChild(filename, operation, state);
	expect.soft(run.stderr).not.toContain("fixture-error");
	expect.soft(run.exitCode).toBe(0);
	expect.soft(run.signal).toBeNull();
	if (state === "new") expect.soft(run.messages.some(({ kind }) => kind === "result")).toBe(true);
	return databaseSnapshot(filename);
}

async function assertCrashCheckpoint(
	operation: MutationOperation,
	target: CrashCheckpoint,
	oldState: unknown,
	newState: unknown,
	repetition: number
): Promise<string | undefined> {
	const filename = await databaseFilename(`${operation}-${target.edge}-${repetition}`);
	const run = await runChild(filename, operation, "crash", target);
	const targetSeen = run.messages.some(
		({ checkpoint, kind }) => kind === "checkpoint" && checkpointMatches(checkpoint, target)
	);
	if (!targetSeen) {
		return `${operation}:${JSON.stringify(target)} absent; exit=${String(run.exitCode)} signal=${String(run.signal)} stderr=${run.stderr}`;
	}
	if (run.messages.some(({ kind }) => kind === "result")) {
		return `${operation}:${JSON.stringify(target)} published a result before the parent SIGKILL`;
	}
	if (run.signal !== "SIGKILL" || run.exitCode !== null) {
		return `${operation}:${JSON.stringify(target)} did not prove SIGKILL death`;
	}
	const directoryEntries = await readdir(join(filename, ".."));
	if (!directoryEntries.includes("store.sqlite-wal")) {
		return `${operation}:${JSON.stringify(target)} did not retain the WAL sidecar with the database`;
	}
	const recovered = databaseSnapshot(filename);
	const expected = target.edge === "after-commit" ? newState : oldState;
	if (JSON.stringify(recovered) !== JSON.stringify(expected)) {
		return `${operation}:${JSON.stringify(target)} recovered neither its expected old/new side`;
	}
	const retry = await runChild(filename, operation, "retry");
	const retryResult = retry.messages.find(({ kind }) => kind === "result")?.result;
	if (
		retry.exitCode !== 0 ||
		retry.signal !== null ||
		retryResult === undefined ||
		(!retryResult.ok && retryResult.reason === "SUBSTRATE_FAILURE")
	) {
		return `${operation}:${JSON.stringify(target)} retry was not valid: ${JSON.stringify(retry)}`;
	}
	if (JSON.stringify(databaseSnapshot(filename)) !== JSON.stringify(newState)) {
		return `${operation}:${JSON.stringify(target)} retry did not converge to exact new state`;
	}
	return undefined;
}

async function runMatrix(repetitions: number): Promise<readonly string[]> {
	const failures: string[] = [];
	for (const scenario of SCENARIOS) {
		const oldState = await createControl(scenario.operation, "old");
		const newState = await createControl(scenario.operation, "new");
		expect.soft(newState).not.toEqual(oldState);
		for (let repetition = 0; repetition < repetitions; repetition += 1) {
			for (const checkpoint of scenario.checkpoints) {
				const failure = await assertCrashCheckpoint(scenario.operation, checkpoint, oldState, newState, repetition);
				if (failure !== undefined) failures.push(failure);
			}
		}
	}
	return failures;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
});

describe("Phase 2c-b SQLite process-death atomicity RED", () => {
	it("freezes one complete statement/commit inventory", () => {
		// Thirteen applyWrite SQL statements + six before-COMMIT edges + six
		// after-COMMIT-before-return edges. Killing after a statement is the
		// same durable state as killing before the adjacent next statement;
		// the exact-old control owns the edge before the first statement.
		expect({
			checkpointCount: CHECKPOINTS.length,
			operations: SCENARIOS.map(({ operation }) => operation),
			perOperation: Object.fromEntries(SCENARIOS.map(({ checkpoints, operation }) => [operation, checkpoints.length])),
		}).toEqual({
			checkpointCount: 25,
			operations: [
				"beginGeneration",
				"putCachedBlob",
				"promoteReference",
				"completeGeneration",
				"swapHead",
				"discardGeneration",
			],
			perOperation: {
				beginGeneration: 4,
				completeGeneration: 4,
				discardGeneration: 4,
				promoteReference: 3,
				putCachedBlob: 3,
				swapHead: 7,
			},
		});
	});

	it.skipIf(RUN_LONG)("keeps the bounded repeated crash campaign explicitly opt-in by default", () => {
		expect(process.env.TS_DRP_STORAGE_NODE_LONG_SIGKILL).not.toBe("1");
		expect({ fastRepetitions: FAST_REPETITIONS, longRepetitions: LONG_REPETITIONS }).toEqual({
			fastRepetitions: 1,
			longRepetitions: 5,
		});
	});

	it("recovers old XOR complete-new and permits retry at every fast checkpoint", async () => {
		const failures = await runMatrix(FAST_REPETITIONS);
		expect.soft(failures.filter((failure) => failure.includes(" absent;"))).toHaveLength(0);
		expect(failures).toEqual([]);
	}, 120_000);
});

describe.skipIf(!RUN_LONG)("Phase 2c-b bounded repeated SIGKILL campaign", () => {
	it("repeats the same frozen inventory without widening the durability claim", async () => {
		expect(await runMatrix(LONG_REPETITIONS)).toEqual([]);
	}, 600_000);
});
