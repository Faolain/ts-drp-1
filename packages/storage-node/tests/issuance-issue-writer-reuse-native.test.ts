// A persistent issuance store keeps its last issue job's private writer connection for the next
// job. Reuse must be invisible except for cost: the next job runs on the same prepared statements,
// a store whose file was removed or replaced never writes through the parked connection, concurrent
// jobs never share one, and close releases it.
import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type { DurableIssuanceStore, DurableIssueCommit, DurableIssueScope } from "@ts-drp/issuance-store";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { createNodeDurableIssuanceStore } from "../src/issuance.js";

const directories: string[] = [];
const stores: DurableIssuanceStore[] = [];
afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// The store's native file is the primary filename plus this suffix (node-issuance-store.ts).
const SUFFIX = ".drp-issuance-v1.sqlite";
const scope: DurableIssueScope = Object.freeze({ objectId: "reuse-room", author: "writer" });
const other: DurableIssueScope = Object.freeze({ objectId: "reuse-room", author: "other" });

async function openStore(): Promise<{ store: DurableIssuanceStore; filename: string }> {
	const directory = await mkdtemp(join(tmpdir(), "issuance-issue-writer-reuse-"));
	directories.push(directory);
	const filename = join(directory, "primary.sqlite");
	const store = createNodeDurableIssuanceStore({ primaryFilename: filename });
	stores.push(store);
	return { store, filename };
}

function commitFor(issueScope: DurableIssueScope, sequence: number): DurableIssueCommit {
	const canonicalPreimageBytes = encodeCanonical({
		author: issueScope.author,
		authorSequence: sequence,
		epoch: 0,
		kind: "drp-vertex",
		objectId: issueScope.objectId,
		protocolMajor: 3,
	});
	const envelope = {
		canonicalPreimageBytes,
		digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
		signature: new Uint8Array(64).fill(sequence + 1),
	};
	return {
		authorSequence: sequence,
		envelope,
		issuedRecord: { authorSequence: sequence, envelope, scope: issueScope },
		outboxEntry: { authorSequence: sequence, envelope, scope: issueScope },
	};
}

/**
 * Issues through the job's own private writer (its native sign admission).
 * @param store
 * @param issueScope
 * @param gate
 */
function issue(store: DurableIssuanceStore, issueScope: DurableIssueScope, gate?: Promise<void>): Promise<unknown> {
	return store.transactIssue(issueScope, async (sequence, admit) => {
		const commit = commitFor(issueScope, sequence);
		if (admit === undefined) throw new Error("own admission unavailable");
		await admit(commit.envelope.canonicalPreimageBytes, async () => {
			await gate;
			return commit.envelope.signature;
		});
		return commit;
	});
}

/**
 * The value, which must be present.
 * @param value - A value that is present by construction.
 * @returns The value.
 */
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new TypeError("expected value is missing");
	return value;
}

/**
 * Statement objects first executed while `run` runs (each one a fresh prepare).
 * @param run
 */
async function freshStatements(run: () => Promise<unknown>): Promise<number> {
	const methods = ["run", "get", "all", "iterate"] as const;
	const prototype = StatementSync.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const originals = methods.map((method) => required(prototype[method]));
	const seen = new Set<object>();
	const known = statementsSeen;
	let fresh = 0;
	methods.forEach((method, index) => {
		prototype[method] = function (this: object, ...args: unknown[]): unknown {
			if (!known.has(this) && !seen.has(this)) {
				seen.add(this);
				fresh++;
			}
			known.add(this);
			return required(originals[index]).apply(this, args);
		};
	});
	try {
		await run();
	} finally {
		methods.forEach((method, index) => {
			prototype[method] = required(originals[index]);
		});
	}
	return fresh;
}
const statementsSeen = new WeakSet<object>();

it("the next issue job reuses the previous job's prepared writer connection", async () => {
	const { store } = await openStore();
	const first = await freshStatements(() => issue(store, scope));
	expect(first).toBeGreaterThan(10);
	// Same job shape again: every statement it executes was already prepared.
	expect(await freshStatements(() => issue(store, scope))).toBe(0);
	expect(await freshStatements(() => issue(store, scope))).toBe(0);
	expect((await store.readLineage(scope)).next).toBe(3);
});

it("a removed or replaced store file is never written through the parked connection", async () => {
	const { store, filename } = await openStore();
	await issue(store, scope);
	// Move the whole database away: the parked connection still addresses the moved inode.
	const native = `${filename}${SUFFIX}`;
	for (const suffix of ["", "-wal", "-shm"])
		await rename(`${native}${suffix}`, `${filename}.moved${suffix}`).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	const outcome = await issue(store, scope).then(
		() => "committed",
		(error: unknown) => `refused: ${(error as Error).message}`
	);
	expect(outcome).toMatch(/^refused/u);
	// Reopening the moved file shows only the first issue.
	await rename(`${filename}.moved`, `${filename}.check${SUFFIX}`);
	for (const suffix of ["-wal", "-shm"])
		await rename(`${filename}.moved${suffix}`, `${filename}.check${SUFFIX}${suffix}`).catch(() => undefined);
	const check = createNodeDurableIssuanceStore({ primaryFilename: `${filename}.check`, initialization: "reopen" });
	stores.push(check);
	expect((await check.readLineage(scope)).next).toBe(1);
});

it("concurrent issue jobs never share the parked connection; close releases it", async () => {
	const { store } = await openStore();
	await issue(store, scope);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = issue(store, scope, gate);
	const second = issue(store, other);
	setTimeout(release, 10);
	await Promise.all([held, second]);
	expect((await store.readLineage(scope)).next).toBe(2);
	expect((await store.readLineage(other)).next).toBe(1);
	await store.close();
	await expect(issue(store, scope)).rejects.toThrow();
});
