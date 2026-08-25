import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	createSnapshotQuarantineFixture,
	referenceSnapshot,
	SNAPSHOT_QUARANTINE_BROWSER_EXPORTS,
	SNAPSHOT_QUARANTINE_COMMON_EXPORTS,
	SNAPSHOT_QUARANTINE_DECLARATION_FIELDS,
	SNAPSHOT_QUARANTINE_DESCRIPTOR_FIELDS,
	SNAPSHOT_QUARANTINE_FAILURE_CODES,
	SNAPSHOT_QUARANTINE_MAX_BYTES,
	SNAPSHOT_QUARANTINE_MAX_CHUNKS,
	SNAPSHOT_QUARANTINE_MAX_MANIFEST_BYTES,
	SNAPSHOT_QUARANTINE_NODE_EXPORTS,
	SNAPSHOT_QUARANTINE_PACKAGE_EXPORT_MAPS,
	SNAPSHOT_QUARANTINE_RECEIPT_EXPORTS,
	SNAPSHOT_QUARANTINE_RETENTION_MS,
	SNAPSHOT_QUARANTINE_ROOT_RUNTIME_ROSTERS,
	SNAPSHOT_QUARANTINE_SCHEMA,
	SNAPSHOT_QUARANTINE_SCOPE_FIELDS,
} from "./fixtures/phase-4c-v3/snapshot-quarantine-contract.js";
import type {
	SnapshotChunkDescriptor,
	SnapshotQuarantinePort,
	SnapshotQuarantineReceiptModule,
	SnapshotQuarantineScopeKey,
	SnapshotVerificationQuarantine,
} from "./fixtures/phase-4c-v3/snapshot-quarantine-types.js";
import { snapshotQuarantineTypeContractSource } from "./fixtures/phase-4c-v3/snapshot-quarantine-types.js";

const CURRENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(CURRENT_DIRECTORY, "..");
const RECEIPT_OWNER = resolve(REPOSITORY_ROOT, "packages/compaction/src/snapshot-quarantine-receipt.ts");
const COMMON_OWNER = resolve(REPOSITORY_ROOT, "packages/storage/src/snapshot-transfer.ts");
const NODE_OWNER = resolve(REPOSITORY_ROOT, "packages/storage-node/src/snapshot-transfer.ts");
const BROWSER_OWNER = resolve(REPOSITORY_ROOT, "packages/storage-browser/src/snapshot-transfer.ts");
const EXPECTED_TYPES = resolve(CURRENT_DIRECTORY, "fixtures/phase-4c-v3/snapshot-quarantine-types.ts");
const RECEIPT_MODULE_PATH: string = "../packages/compaction/src/snapshot-quarantine-receipt.js";
const COMMON_MODULE_PATH: string = "../packages/storage/src/snapshot-transfer.js";
const NODE_MODULE_PATH: string = "../packages/storage-node/src/snapshot-transfer.js";
const BROWSER_MODULE_PATH: string = "../packages/storage-browser/src/snapshot-transfer.js";
const ownersExist = [RECEIPT_OWNER, COMMON_OWNER, NODE_OWNER, BROWSER_OWNER].every(existsSync);

const PROFILE = Object.freeze({
	maxManifestBytes: 212_387 as const,
	maxSnapshotBytes: 268_435_456 as const,
	snapshotChunkBytes: 131_072 as const,
});

function snapshotFixture(): Readonly<{
	chunks: readonly Uint8Array[];
	declaration: ReturnType<typeof createSnapshotQuarantineFixture>["declaration"];
	scope: SnapshotQuarantineScopeKey;
}> {
	const selected = createSnapshotQuarantineFixture({ epoch: 7, objectId: "phase-4c-b-object" });
	return Object.freeze({ ...selected, scope: selected.declaration.scope });
}

function packageExports(packagePath: string): Readonly<Record<string, unknown>> {
	return (
		(JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, packagePath), "utf8")) as { exports?: Record<string, unknown> })
			.exports ?? {}
	);
}

function assertTypeContract(): void {
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-phase4cb-types-"));
	try {
		const source = resolve(directory, "contract.ts");
		const project = resolve(directory, "tsconfig.json");
		writeFileSync(
			source,
			snapshotQuarantineTypeContractSource({
				browserModule: BROWSER_OWNER,
				commonModule: COMMON_OWNER,
				expectedModule: EXPECTED_TYPES,
				nodeModule: NODE_OWNER,
				receiptModule: RECEIPT_OWNER,
			})
		);
		writeFileSync(
			project,
			JSON.stringify({
				compilerOptions: {
					allowImportingTsExtensions: true,
					composite: false,
					declaration: false,
					declarationMap: false,
					noEmit: true,
				},
				extends: resolve(REPOSITORY_ROOT, "tsconfig.json"),
				files: [source],
			})
		);
		execFileSync("pnpm", ["exec", "tsc", "--project", project, "--pretty", "false"], {
			cwd: REPOSITORY_ROOT,
			stdio: "pipe",
		});
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

async function loadReceiptOwner(): Promise<SnapshotQuarantineReceiptModule> {
	return (await import(RECEIPT_MODULE_PATH)) as SnapshotQuarantineReceiptModule;
}

class MemoryVerificationQuarantine implements SnapshotVerificationQuarantine {
	readonly #chunks = new Map<number, Uint8Array>();
	readonly #expected: readonly Uint8Array[];
	#blockedWrite: number | undefined;
	#releaseBlockedWrite: (() => void) | undefined;
	readonly reads: number[] = [];
	readonly ports: SnapshotQuarantinePort[] = [];
	readonly sourceReads: number[] = [];
	readonly writes: number[] = [];

	constructor(expected: readonly Uint8Array[]) {
		this.#expected = expected;
	}

	blockWrite(index: number): void {
		this.#blockedWrite = index;
	}

	releaseWrite(): void {
		this.#releaseBlockedWrite?.();
	}

	open(signal: AbortSignal): SnapshotQuarantinePort {
		const chunks = this.#chunks;
		const port: SnapshotQuarantinePort = Object.freeze({
			discard: () => Promise.resolve(),
			read: (descriptor) => {
				if (signal.aborted) throw signal.reason;
				this.reads.push(descriptor.index);
				const selected = chunks.get(descriptor.index);
				return Promise.resolve(selected === undefined ? undefined : new Uint8Array(selected));
			},
			write: async (descriptor, exactBytes) => {
				if (signal.aborted) throw signal.reason;
				const captured = new Uint8Array(exactBytes);
				this.writes.push(descriptor.index);
				if (descriptor.index === this.#blockedWrite) {
					await new Promise<void>((resolvePromise) => {
						this.#releaseBlockedWrite = resolvePromise;
					});
				}
				chunks.set(descriptor.index, captured);
			},
		});
		this.ports.push(port);
		return port;
	}

	source(overrides: ReadonlyMap<number, Uint8Array | undefined> = new Map()): Readonly<{
		read(
			descriptor: SnapshotChunkDescriptor,
			options: Readonly<{ signal: AbortSignal }>
		): Promise<Uint8Array | undefined>;
	}> {
		return Object.freeze({
			read: (descriptor: SnapshotChunkDescriptor, options: Readonly<{ signal: AbortSignal }>) => {
				if (options.signal.aborted) throw options.signal.reason;
				this.sourceReads.push(descriptor.index);
				const selected = overrides.has(descriptor.index)
					? overrides.get(descriptor.index)
					: this.#expected[descriptor.index];
				return Promise.resolve(selected === undefined ? undefined : new Uint8Array(selected));
			},
		});
	}
}

async function waitForTrace(trace: readonly number[], length: number): Promise<void> {
	for (let attempt = 0; attempt < 100 && trace.length < length; attempt += 1) await Promise.resolve();
	if (trace.length !== length) throw new Error(`trace stopped at ${trace.length}, expected ${length}`);
}

describe("Phase 4c-b durable snapshot quarantine RED", () => {
	it("pins one backend-neutral resource contract and exact physical schemas", () => {
		expect(SNAPSHOT_QUARANTINE_RETENTION_MS).toBe(86_400_000);
		expect(SNAPSHOT_QUARANTINE_MAX_MANIFEST_BYTES).toBe(212_387);
		expect(SNAPSHOT_QUARANTINE_MAX_CHUNKS * 131_072).toBe(SNAPSHOT_QUARANTINE_MAX_BYTES);
		expect(SNAPSHOT_QUARANTINE_SCOPE_FIELDS).toEqual(["anchor", "epoch", "manifestDigest", "objectId"]);
		expect(SNAPSHOT_QUARANTINE_DESCRIPTOR_FIELDS).toEqual(["byteLength", "digest", "index"]);
		expect(SNAPSHOT_QUARANTINE_DECLARATION_FIELDS).toEqual([
			"chunks",
			"exactCanonicalManifestBytes",
			"scope",
			"totalBytes",
		]);
		expect(SNAPSHOT_QUARANTINE_SCHEMA.browser.stores).toEqual(["chunks", "scopes"]);
		expect(SNAPSHOT_QUARANTINE_SCHEMA.node.tables).toEqual(["snapshot_chunks", "snapshot_scopes"]);
	});

	it("keeps the independent missing-set and retention oracle non-prefix and boundary-exact", () => {
		const selected = snapshotFixture();
		const occupied = new Map<number, Uint8Array>([[1, selected.chunks[1] as Uint8Array]]);
		const initial = referenceSnapshot({ declaration: selected.declaration, now: 17, occupied });
		expect(initial.missingIndices).toEqual([0, 2]);
		expect(initial.expiresAt).toBe(17 + SNAPSHOT_QUARANTINE_RETENTION_MS);
		occupied.set(0, new Uint8Array(selected.chunks[0] as Uint8Array));
		occupied.set(2, new Uint8Array(selected.chunks[2] as Uint8Array));
		const complete = referenceSnapshot({ declaration: selected.declaration, now: 18, occupied });
		expect(complete.missingIndices).toEqual([]);
		expect(complete.expiresAt - 1).toBe(18 + SNAPSHOT_QUARANTINE_RETENTION_MS - 1);
	});

	it("pins one closed failure taxonomy used by the causal backend cases", () => {
		expect(new Set(SNAPSHOT_QUARANTINE_FAILURE_CODES).size).toBe(SNAPSHOT_QUARANTINE_FAILURE_CODES.length);
		expect(SNAPSHOT_QUARANTINE_FAILURE_CODES).toEqual([...SNAPSHOT_QUARANTINE_FAILURE_CODES].sort());
	});

	it("binds the signed 4c-a predecessor and leaves package roots outside the new authority graph", () => {
		expect(
			execFileSync("git", ["cat-file", "-t", "cbb3ae69e8deddbe56ba4cbc26fd9f41c5b94b65^{commit}"], {
				cwd: REPOSITORY_ROOT,
				encoding: "utf8",
			}).trim()
		).toBe("commit");
		expect(packageExports("packages/compaction/package.json")).toHaveProperty("./snapshot-stream");
		expect(packageExports("packages/storage/package.json")).toHaveProperty("./adapter");
	});

	it("has exactly one readiness failure for the four missing non-root owners", () => {
		expect(ownersExist).toBe(true);
	});

	describe.skipIf(!ownersExist)("dormant GREEN receipt and public-surface contract", () => {
		it("adds only the four explicit non-root runtime surfaces and exact future types", async () => {
			const [receipt, common, node, browser] = await Promise.all([
				import(RECEIPT_MODULE_PATH),
				import(COMMON_MODULE_PATH),
				import(NODE_MODULE_PATH),
				import(BROWSER_MODULE_PATH),
			]);
			expect(Object.keys(receipt).sort()).toEqual([...SNAPSHOT_QUARANTINE_RECEIPT_EXPORTS].sort());
			expect(Object.keys(common).sort()).toEqual([...SNAPSHOT_QUARANTINE_COMMON_EXPORTS].sort());
			expect(Object.keys(node).sort()).toEqual([...SNAPSHOT_QUARANTINE_NODE_EXPORTS].sort());
			expect(Object.keys(browser).sort()).toEqual([...SNAPSHOT_QUARANTINE_BROWSER_EXPORTS].sort());
			expect(packageExports("packages/compaction/package.json")).toEqual(
				SNAPSHOT_QUARANTINE_PACKAGE_EXPORT_MAPS.compaction
			);
			expect(packageExports("packages/storage/package.json")).toEqual(SNAPSHOT_QUARANTINE_PACKAGE_EXPORT_MAPS.common);
			expect(packageExports("packages/storage-node/package.json")).toEqual(
				SNAPSHOT_QUARANTINE_PACKAGE_EXPORT_MAPS.node
			);
			expect(packageExports("packages/storage-browser/package.json")).toEqual(
				SNAPSHOT_QUARANTINE_PACKAGE_EXPORT_MAPS.browser
			);
			const roots = await Promise.all([
				import("../packages/compaction/src/index.js"),
				import("../packages/storage/src/index.js"),
				import("../packages/storage-node/src/index.js"),
				import("../packages/storage-browser/src/index.js"),
			]);
			expect(Object.keys(roots[0] as object).sort()).toEqual(SNAPSHOT_QUARANTINE_ROOT_RUNTIME_ROSTERS.compaction);
			expect(Object.keys(roots[1] as object).sort()).toEqual(SNAPSHOT_QUARANTINE_ROOT_RUNTIME_ROSTERS.common);
			expect(Object.keys(roots[2] as object).sort()).toEqual(SNAPSHOT_QUARANTINE_ROOT_RUNTIME_ROSTERS.node);
			expect(Object.keys(roots[3] as object).sort()).toEqual(SNAPSHOT_QUARANTINE_ROOT_RUNTIME_ROSTERS.browser);
			assertTypeContract();
		});

		it("mints only after genuine 4c-a completion and rejects forged, foreign, wrong-scope and replayed receipts", async () => {
			const receiptOwner = await loadReceiptOwner();
			const selected = snapshotFixture();
			const quarantine = new MemoryVerificationQuarantine(selected.chunks);
			quarantine.blockWrite(2);
			const stream = receiptOwner.verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.scope.manifestDigest,
				expectedScope: selected.scope,
				profile: PROFILE,
				quarantine,
				source: quarantine.source(),
			});
			let receiptSettled = false;
			void stream.receipt.then(
				() => {
					receiptSettled = true;
				},
				() => {
					receiptSettled = true;
				}
			);
			await waitForTrace(quarantine.writes, 3);
			expect(receiptSettled).toBe(false);
			quarantine.releaseWrite();
			const first = Object.freeze({
				quarantine,
				receipt: await stream.receipt,
				scope: selected.scope,
				stream,
			});
			await expect(first.stream.completion).resolves.toMatchObject({ manifestDigest: first.scope.manifestDigest });
			expect(quarantine.sourceReads).toEqual([0, 1, 2]);
			expect(quarantine.writes).toEqual([0, 1, 2]);
			expect(() =>
				receiptOwner.consumeSnapshotVerificationReceipt({
					expectedScope: first.scope,
					quarantine: first.quarantine,
					receipt: Object.freeze({}) as typeof first.receipt,
				})
			).toThrowError(expect.objectContaining({ code: "receipt-invalid" }));
			for (const forged of [structuredClone(first.receipt), new Proxy(first.receipt, {})]) {
				expect(() =>
					receiptOwner.consumeSnapshotVerificationReceipt({
						expectedScope: first.scope,
						quarantine: first.quarantine,
						receipt: forged,
					})
				).toThrowError(expect.objectContaining({ code: "receipt-invalid" }));
			}

			const foreign = new MemoryVerificationQuarantine(snapshotFixture().chunks);
			expect(() =>
				receiptOwner.consumeSnapshotVerificationReceipt({
					expectedScope: first.scope,
					quarantine: foreign,
					receipt: first.receipt,
				})
			).toThrowError(expect.objectContaining({ code: "receipt-invalid" }));

			for (const expectedScope of [
				{ ...first.scope, objectId: `${first.scope.objectId}-wrong` },
				{ ...first.scope, epoch: first.scope.epoch + 1 },
				{ ...first.scope, anchor: "ff".repeat(32) },
				{ ...first.scope, manifestDigest: "ee".repeat(32) },
			]) {
				expect(() =>
					receiptOwner.consumeSnapshotVerificationReceipt({
						expectedScope,
						quarantine: first.quarantine,
						receipt: first.receipt,
					})
				).toThrowError(expect.objectContaining({ code: "receipt-invalid" }));
			}

			const completion = receiptOwner.consumeSnapshotVerificationReceipt({
				expectedScope: first.scope,
				quarantine: first.quarantine,
				receipt: first.receipt,
			});
			expect(completion.manifestDigest).toBe(first.scope.manifestDigest);
			expect(Object.isFrozen(completion)).toBe(true);
			expect(() =>
				receiptOwner.consumeSnapshotVerificationReceipt({
					expectedScope: first.scope,
					quarantine: first.quarantine,
					receipt: first.receipt,
				})
			).toThrowError(expect.objectContaining({ code: "receipt-invalid" }));
		});

		it("never mints a receipt for missing or corrupt genuine source bytes", async () => {
			const receiptOwner = await loadReceiptOwner();
			const selected = snapshotFixture();
			for (const [overrides, code] of [
				[new Map<number, Uint8Array | undefined>([[1, undefined]]), "chunk-missing"],
				[new Map<number, Uint8Array | undefined>([[1, new Uint8Array(131_072).fill(9)]]), "chunk-digest-mismatch"],
			] as const) {
				const quarantine = new MemoryVerificationQuarantine(selected.chunks);
				const stream = receiptOwner.verifySnapshotStreamWithReceipt({
					exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
					expectedManifestDigest: selected.scope.manifestDigest,
					expectedScope: selected.scope,
					profile: PROFILE,
					quarantine,
					source: quarantine.source(overrides),
				});
				await expect(stream.receipt).rejects.toMatchObject({ code });
			}
		});

		it("binds the aborting port to the exact quarantine receiver without widening signed 4c-a", async () => {
			const receiptOwner = await loadReceiptOwner();
			const selected = snapshotFixture();
			const quarantine = new MemoryVerificationQuarantine(selected.chunks);
			const controller = new AbortController();
			controller.abort(new Error("test-abort"));
			const stream = receiptOwner.verifySnapshotStreamWithReceipt({
				exactCanonicalManifestBytes: selected.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: selected.scope.manifestDigest,
				expectedScope: selected.scope,
				profile: PROFILE,
				quarantine,
				signal: controller.signal,
				source: quarantine.source(),
			});
			await expect(stream.receipt).rejects.toMatchObject({ code: "aborted" });
			expect(quarantine.ports).toHaveLength(1);
		});
	});
});
