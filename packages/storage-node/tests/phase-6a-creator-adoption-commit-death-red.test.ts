import "fake-indexeddb/auto";

import { decodeCanonical } from "@ts-drp/canonical";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	classifyD108cTerminal,
	d108cTransactionFaultRoster,
	deriveD108cCandidateClosure,
} from "../../../tests/fixtures/phase-6a-v3/creator-adoption-commit-contract.js";
import { openGenuineCreatorAdoptionFixture } from "../../../tests/fixtures/phase-6a-v3/creator-adoption-contract.js";

const childPath = new URL("./fixtures/phase-6a-creator-adoption-commit-child.mjs", import.meta.url);
const directories: string[] = [];

interface ChildMessage {
	readonly checkpoint?: Readonly<{ readonly edge: string; readonly occurrence: number; readonly operation: string }>;
	readonly generations?: readonly Readonly<Record<string, unknown>>[];
	readonly kind: string;
	readonly message?: string;
	readonly recovered?: Readonly<Record<string, unknown>>;
}

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

function encodedBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

async function material(): Promise<Readonly<Record<string, unknown>>> {
	const fixture = await openGenuineCreatorAdoptionFixture();
	try {
		const { current, exactCanonicalProjectionBytes, proposed } = fixture.evidence;
		const shared = current.candidates
			.filter(({ bytes, ref }) => {
				try {
					const decoded = decodeCanonical(bytes) as Readonly<Record<string, unknown>>;
					return (
						decoded.kind === "v3-live-generation-1" &&
						proposed.references.some(
							(proposedRef) => proposedRef.digest === ref.digest && proposedRef.byteLength === ref.byteLength
						)
					);
				} catch {
					return false;
				}
			})
			.map(({ ref }) => ref);
		if (shared.length !== 1) throw new TypeError("D.108c predecessor live ref is not unique");
		const candidate = deriveD108cCandidateClosure(
			proposed.references,
			shared[0] as (typeof shared)[number],
			exactCanonicalProjectionBytes
		);
		const pendingHead = {
			closureDigest: proposed.head.closureDigest,
			generationId: proposed.head.generationId,
			kind: "present" as const,
			objectId: proposed.head.objectId,
			revision: 1,
		};
		return Object.freeze({
			candidateClosure: candidate.closure,
			candidateGeneration: {
				baseExpectedHead: pendingHead,
				closure: candidate.closure,
				generationId: "d".repeat(64),
				objectId: proposed.head.objectId,
			},
			pendingBlobs: proposed.candidates.map(({ bytes, ref }) => ({ bytes: encodedBytes(bytes), ref })),
			pendingGeneration: {
				baseExpectedHead: { kind: "none", objectId: proposed.head.objectId },
				closure: proposed.references,
				generationId: proposed.head.generationId,
				objectId: proposed.head.objectId,
			},
			pendingHead,
			projectionBlob: { bytes: encodedBytes(exactCanonicalProjectionBytes), ref: candidate.projectionRef },
		});
	} finally {
		await fixture.close();
	}
}

function parseTarget(value: string): Readonly<Record<string, unknown>> {
	const [operation, occurrenceOrEdge, maybeEdge] = value.split(":");
	return {
		edge: maybeEdge ?? occurrenceOrEdge,
		occurrence: maybeEdge === undefined ? 0 : Number(occurrenceOrEdge),
		operation,
	};
}

function runKilled(filename: string, input: Readonly<Record<string, unknown>>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[childPath.pathname, filename, "mutate", Buffer.from(JSON.stringify(input)).toString("base64url")],
			{
				detached: true,
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			}
		);
		let stderr = "";
		let killed = false;
		const timeout = setTimeout(() => {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			reject(new Error(`D.108c SQLite death timeout: ${stderr}`));
		}, 20_000);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			if (message.kind === "child-error") reject(new Error(message.message));
			if (message.kind === "checkpoint" && child.pid !== undefined) {
				killed = true;
				process.kill(-child.pid, "SIGKILL");
			}
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (!killed || signal !== "SIGKILL" || code !== null)
				reject(new Error(`expected SIGKILL, got ${String(code)}/${String(signal)}`));
			else resolve();
		});
	});
}

function recover(filename: string, input: Readonly<Record<string, unknown>>): Promise<ChildMessage> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[childPath.pathname, filename, "recover", Buffer.from(JSON.stringify(input)).toString("base64url")],
			{
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			}
		);
		let observed: ChildMessage | undefined;
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (value: string) => (stderr += value));
		child.on("message", (message: ChildMessage) => {
			if (message.kind === "recovery") observed = message;
			if (message.kind === "child-error") reject(new Error(message.message));
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0 || observed === undefined) reject(new Error(`D.108c recovery failed: ${stderr}`));
			else resolve(observed);
		});
	});
}

afterAll(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("D.108c real SQLite process-death RED", () => {
	it("freezes both native transaction edges for every numbered candidate mutation", () => {
		const roster = d108cTransactionFaultRoster(5);
		expect(roster).toHaveLength(18);
		expect(new Set(roster).size).toBe(roster.length);
		expect(roster).toContain("promoteReference:4:after-commit");
		expect(roster).toContain("swapHead:before-commit");
	});

	it("recovers pending-old XOR active-new after genuine SIGKILL at every edge", async () => {
		const base = await material();
		const candidateClosure = base.candidateClosure as Parameters<typeof classifyD108cTerminal>[0]["candidateClosure"];
		const pendingHead = base.pendingHead as Parameters<typeof classifyD108cTerminal>[0]["pendingHead"];
		for (const row of d108cTransactionFaultRoster(candidateClosure.length)) {
			const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108c-node-death-"));
			directories.push(directory);
			const filename = join(directory, "ahe.sqlite");
			const input = { ...base, target: parseTarget(row) };
			await runKilled(filename, input);
			const observation = await recover(filename, input);
			const recoveredResult = observation.recovered as Readonly<Record<string, unknown>>;
			expect(recoveredResult.ok, row).toBe(true);
			const recovered = recoveredResult.value as Readonly<Record<string, unknown>>;
			expect(recovered.kind, row).toBe("active");
			const classification = classifyD108cTerminal({
				candidateClosure,
				pendingHead,
				recovered: {
					head: recovered.head as Parameters<typeof classifyD108cTerminal>[0]["recovered"]["head"],
					references: recovered.references as Parameters<typeof classifyD108cTerminal>[0]["recovered"]["references"],
					state: (recovered.adoptedGeneration as Readonly<Record<string, unknown>>).state as string,
				},
			});
			expect(classification, row).toBe(row === "swapHead:after-commit" ? "active-new" : "pending-old");
		}
	}, 240_000);
});
