import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import {
	createD108d1PackedDurableMaterial,
	CREATOR_SUCCESSOR_ACTIVATION_EXPORTS,
	CREATOR_SUCCESSOR_ACTIVATION_FAILURE_KINDS,
	CREATOR_SUCCESSOR_ACTIVATION_INPUT_KEYS,
	CREATOR_SUCCESSOR_ACTIVATION_SUCCESS_KEYS,
	CREATOR_SUCCESSOR_LOCAL_AUTHOR_REOPEN_INPUT_KEYS,
	CREATOR_SUCCESSOR_REOPEN_INPUT_KEYS,
	D108D1_BROWSER_BEHAVIORS,
	D108D1_CHILD_BEHAVIORS,
	D108D1_GREEN_PATHS,
	D108D1_NODE_BEHAVIORS,
	D108D1_RED_PATHS,
	type D108d1CandidateModule,
	d108d1SourceGovernance,
	D108E2A_BROWSER_BEHAVIORS,
	D108E2A_GREEN_PATHS,
	D108E2A_RED_PATHS,
	d108e2aTopicGovernance,
	deriveD108d1Oracle,
	REPOSITORY_ROOT,
	runD108d1ActivationChild,
} from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

async function committed(
	fixture: Awaited<ReturnType<typeof openGenuineCreatorAdoptionFixture>>
): Promise<Readonly<Record<string, unknown>>> {
	const verifier = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts")).href
	)) as { verifyCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> };
	const committer = (await import(
		pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption-commit.ts")).href
	)) as { commitCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> };
	const verified = await verifier.verifyCreatorSuccessorAdoption({ catalog: fixture.catalog, handle: fixture.handle });
	if (verified.ok !== true) throw new TypeError(`D.108d1 verification failed: ${String(verified.kind)}`);
	const result = await committer.commitCreatorSuccessorAdoption({ handle: fixture.handle, intent: verified.intent });
	if (result.ok !== true) throw new TypeError(`D.108d1 commit failed: ${String(result.kind)}`);
	return result;
}

async function candidate(): Promise<D108d1CandidateModule> {
	return import(pathToFileURL(resolve(REPOSITORY_ROOT, D108D1_GREEN_PATHS[0])).href) as Promise<D108d1CandidateModule>;
}

function runtimeBindings(peerId: string): Readonly<Record<string, unknown>> {
	return Object.freeze({
		messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
		networkNode: fakeNetwork(peerId),
		onAdmittedVertex: () => undefined,
	});
}

type ActiveResult = Readonly<Record<string, unknown>> & {
	readonly handle?: Readonly<{ deactivate(): void }>;
};

async function deactivate(result: ActiveResult | undefined): Promise<void> {
	await Promise.resolve(result?.handle?.deactivate());
}

function recordingRuntimeBindings(peerId: string): Readonly<{
	readonly input: Readonly<Record<string, unknown>>;
	readonly publications: unknown[];
}> {
	const publications: unknown[] = [];
	const networkNode = fakeNetwork(peerId);
	Object.defineProperties(networkNode, {
		broadcastMessage: {
			value: (...args: unknown[]) => {
				publications.push(args);
				return Promise.resolve();
			},
		},
		publishMessage: {
			value: (...args: unknown[]) => {
				publications.push(args);
				return Promise.resolve(true);
			},
		},
	});
	return Object.freeze({
		input: Object.freeze({
			messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
			networkNode,
			onAdmittedVertex: () => undefined,
		}),
		publications,
	});
}

function containsDigest(value: unknown, expected: Uint8Array): boolean {
	if (value instanceof Uint8Array) return Buffer.from(value).equals(expected);
	if (Array.isArray(value)) return value.some((entry) => containsDigest(entry, expected));
	if (value !== null && typeof value === "object") {
		return Object.values(value).some((entry) => containsDigest(entry, expected));
	}
	return false;
}

async function childMaterial(
	options: Readonly<{ readonly stageAclChange?: boolean }> = {}
): Promise<Readonly<{ readonly directory: string; readonly material: unknown }>> {
	const directory = mkdtempSync(join(tmpdir(), "ts-drp-d108d1-unit-"));
	const fixture = await openGenuineCreatorAdoptionFixture(options);
	try {
		return Object.freeze({ directory, material: await createD108d1PackedDurableMaterial(fixture, directory) });
	} catch (error) {
		rmSync(directory, { force: true, recursive: true });
		throw error;
	} finally {
		await fixture.close();
	}
}

describe("D.108d1 creator successor activation RED", () => {
	it("freezes the D.108e2a activation boundary and its single topic owner", () => {
		expect(D108E2A_RED_PATHS).toHaveLength(6);
		expect(new Set(D108E2A_RED_PATHS).size).toBe(6);
		expect(D108E2A_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108E2A_GREEN_PATHS).toEqual([
			"packages/node/src/internal/v3-topic.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/src/creator-adoption-activate.ts",
		]);
		expect(D108E2A_BROWSER_BEHAVIORS).toHaveLength(2);
		expect(d108e2aTopicGovernance()).toEqual({
			helperIsPrivate: true,
			helperPresent: true,
			implementationCount: 1,
			ownersConsumeHelper: true,
		});
	});

	it("rejects a hostile cold authentication profile before every downstream effect", async () => {
		const reopen = (await candidate()).reopenCreatorSuccessorAdoption;
		if (reopen === undefined) throw new TypeError("D.108e2a reopen export missing");
		let signerCount = 0;
		let propertyReadCount = 0;
		const downstream = new Proxy(Object.create(null) as Record<string, unknown>, {
			get: (): never => {
				propertyReadCount += 1;
				throw new TypeError("D108E2A_DOWNSTREAM_EFFECT");
			},
		});
		const result = await reopen({
			authenticationProfile: "attacker-selected",
			author: "d108e2a-hostile-author",
			catalog: downstream,
			detachedSignature: new Uint8Array(),
			exactCanonicalAnchorPreimageBytes: new Uint8Array(),
			exactCanonicalParametersCarrierBytes: new Uint8Array(),
			issuanceStore: downstream,
			liveJournalStore: downstream,
			messageQueueManager: downstream,
			networkNode: downstream,
			onAdmittedVertex: () => undefined,
			pinnedGenesisAnchorDigest: "0".repeat(64),
			signRegisteredVertexDigest: (): Promise<Uint8Array> => {
				signerCount += 1;
				return Promise.resolve(new Uint8Array());
			},
			snapshotDeclaration: downstream,
			snapshotStore: downstream,
			store: downstream,
		});
		expect(result).toEqual(expect.objectContaining({ kind: "malformed-input", ok: false }));
		expect({ propertyReadCount, signerCount }).toEqual({ propertyReadCount: 0, signerCount: 0 });
	});

	it("freezes exactly seven RED and eight GREEN owners", () => {
		expect(D108D1_RED_PATHS).toHaveLength(7);
		expect(D108D1_GREEN_PATHS).toHaveLength(8);
		expect(new Set(D108D1_RED_PATHS).size).toBe(7);
		expect(D108D1_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(D108D1_GREEN_PATHS).toEqual([
			"packages/node/src/creator-adoption-activate.ts",
			"packages/node/src/creator-adoption.ts",
			"packages/node/src/creator-adoption-commit.ts",
			"packages/node/src/creator-close.ts",
			"packages/node/src/internal/creator-adoption-intent.ts",
			"packages/node/src/internal/creator-successor-live.ts",
			"packages/node/src/v3-live.ts",
			"packages/node/package.json",
		]);
	});

	it("retains the pre-D.108d1b cold input only as a malformed negative beside the authoritative local-author roster", () => {
		expect(CREATOR_SUCCESSOR_ACTIVATION_EXPORTS).toEqual([
			"activateCreatorSuccessorAdoption",
			"reopenCreatorSuccessorAdoption",
		]);
		expect(CREATOR_SUCCESSOR_ACTIVATION_INPUT_KEYS).toEqual([
			"capability",
			"handle",
			"messageQueueManager",
			"networkNode",
			"onAdmittedVertex",
		]);
		expect(CREATOR_SUCCESSOR_ACTIVATION_SUCCESS_KEYS).toEqual(["handle", "lifecycle", "ok", "recovery", "trust"]);
		expect(CREATOR_SUCCESSOR_REOPEN_INPUT_KEYS).toEqual([
			"authenticationProfile",
			"catalog",
			"detachedSignature",
			"exactCanonicalAnchorPreimageBytes",
			"exactCanonicalParametersCarrierBytes",
			"issuanceStore",
			"liveJournalStore",
			"messageQueueManager",
			"networkNode",
			"onAdmittedVertex",
			"pinnedGenesisAnchorDigest",
			"snapshotDeclaration",
			"snapshotStore",
			"store",
		]);
		expect(CREATOR_SUCCESSOR_LOCAL_AUTHOR_REOPEN_INPUT_KEYS).toEqual([
			"authenticationProfile",
			"author",
			"catalog",
			"detachedSignature",
			"exactCanonicalAnchorPreimageBytes",
			"exactCanonicalParametersCarrierBytes",
			"issuanceStore",
			"liveJournalStore",
			"messageQueueManager",
			"networkNode",
			"onAdmittedVertex",
			"pinnedGenesisAnchorDigest",
			"signRegisteredVertexDigest",
			"snapshotDeclaration",
			"snapshotStore",
			"store",
		]);
		expect(CREATOR_SUCCESSOR_ACTIVATION_FAILURE_KINDS).toEqual([
			"malformed-input",
			"capability-unavailable",
			"source-unavailable",
			"snapshot-unavailable",
			"preparation-rejected",
			"recovery-rejected",
			"activation-rejected",
			"authority-unavailable",
			"chain-invalid",
			"storage-failed",
			"internal-invariant",
		]);
	});

	it("derives the exact epoch-one identity and pending epoch-zero lineage independently", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const oracle = deriveD108d1Oracle(fixture);
			expect(oracle).toMatchObject({
				anchorDigest: fixture.evidence.closeResult.successorAnchorDigest,
				epoch: 1,
				genesisAnchorDigest: fixture.evidence.currentTrust.genesisAnchorDigest,
				objectId: fixture.evidence.proposed.head.objectId,
			});
			expect(oracle.stableTopic).toMatch(/^drp\/v3\/1\/[0-9a-f]{64}$/u);
			const lineage = await fixture.evidence.issuanceStore.readLineage(fixture.evidence.issuanceScope);
			const pending = await fixture.evidence.issuanceStore.readOutboxPage({ scope: fixture.evidence.issuanceScope });
			expect(lineage).toEqual({ exhausted: false, next: fixture.evidence.localIssued.authorSequence + 1 });
			expect(pending).toContainEqual(
				expect.objectContaining({
					commit: expect.objectContaining({ authorSequence: fixture.evidence.localIssued.authorSequence }),
					publishState: "pending",
				})
			);
		} finally {
			await fixture.close();
		}
	});

	it("keeps the root and products outside D.108d1", () => {
		expect(d108d1SourceGovernance()).toEqual({
			internalCustody: true,
			noDirectChatActivationConsumer: true,
			noRootExport: true,
			privateEpochAnchor: true,
			recoveredAuthorityUnchanged: true,
			roomOwnsActivationWhenProductExists: true,
			webLockAuthority: true,
		});
	});

	it("pins the complete zero-skip GREEN inventory", () => {
		expect(D108D1_NODE_BEHAVIORS).toHaveLength(9);
		expect(D108D1_CHILD_BEHAVIORS).toHaveLength(2);
		expect(D108D1_BROWSER_BEHAVIORS).toHaveLength(2);
		expect(new Set([...D108D1_NODE_BEHAVIORS, ...D108D1_CHILD_BEHAVIORS, ...D108D1_BROWSER_BEHAVIORS]).size).toBe(13);
		const unitSource = readFileSync(import.meta.filename, "utf8");
		const childSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-node/tests/phase-6a-creator-successor-activation-death-red.test.ts"),
			"utf8"
		);
		const browserSource = readFileSync(
			resolve(REPOSITORY_ROOT, "packages/storage-browser/tests/phase-6a-creator-successor-activation.pw.ts"),
			"utf8"
		);
		for (const name of D108D1_NODE_BEHAVIORS) expect(unitSource).toContain(name);
		for (const name of D108D1_CHILD_BEHAVIORS) expect(childSource).toContain(name);
		for (const name of D108D1_BROWSER_BEHAVIORS) expect(browserSource).toContain(name);
		expect(childSource).not.toContain("it.skipIf(!readiness.ready)");
		expect(browserSource).not.toContain("test.skip(!GREEN_READY");
	});

	it("imports the shipped successor activation owner without a source-pattern readiness gate", async () => {
		expect(await candidate()).toMatchObject({
			activateCreatorSuccessorAdoption: expect.any(Function),
			reopenCreatorSuccessorAdoption: expect.any(Function),
		});
	});

	it("genuine successor imports its verified snapshot before epoch-one activation", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let result: ActiveResult | undefined;
		try {
			const oracle = deriveD108d1Oracle(fixture);
			const prepared = await committed(fixture);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			result = await activate({
				capability: prepared.capability,
				handle: fixture.handle,
				...fixture.runtimeBindings,
			});
			expect(result).toMatchObject({ lifecycle: "active", ok: true, recovery: "active-new" });
			const handle = result.handle as Readonly<Record<string, unknown>>;
			expect(handle).toMatchObject({ epoch: 1, objectId: oracle.objectId, topic: oracle.stableTopic });
			const journal = await fixture.journal.readiness({
				scope: { anchorDigest: oracle.anchorDigest, epoch: 1, objectId: oracle.objectId },
			});
			expect(journal).toMatchObject({ ok: true, ready: true, scope: { epoch: 1 } });
		} finally {
			await deactivate(result);
			await fixture.close();
		}
	});

	it("private custody alone selects installEpochAnchor", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		const childRuns: string[] = [];
		try {
			const prepared = await committed(fixture);
			const surface = await candidate();
			if (
				surface.activateCreatorSuccessorAdoption === undefined ||
				surface.reopenCreatorSuccessorAdoption === undefined
			) {
				throw new TypeError("D.108d1 activation surface missing");
			}
			const malformedHot = Object.freeze({
				capability: prepared.capability,
				epoch: 1,
				handle: fixture.handle,
				...runtimeBindings(`d108d1-forged-hot-${crypto.randomUUID()}`),
			});
			expect(await surface.activateCreatorSuccessorAdoption(malformedHot)).toEqual(
				expect.objectContaining({ kind: "malformed-input", ok: false })
			);
			for (const mode of ["cold", "extra-epoch"] as const) {
				const child = await childMaterial({ stageAclChange: mode === "cold" });
				childRuns.push(child.directory);
				const proof = (await runD108d1ActivationChild(mode, child.material)).proof;
				if (mode === "cold") {
					expect(proof).toMatchObject({ activation: { ok: true }, snapshotImportedBeforeActivation: true });
				} else {
					expect(proof).toMatchObject({
						effects: { adoptionSwapCount: 0, installEpochAnchorCount: 0, publicationCount: 0 },
						failure: { kind: "malformed-input", ok: false },
					});
				}
			}
		} finally {
			await fixture.close();
			for (const directory of childRuns) rmSync(directory, { force: true, recursive: true });
		}
	});

	it("divergent genesis identity fails before every live effect", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let childDirectory: string | undefined;
		try {
			const ref = fixture.evidence.closeResult.successorTrustRef;
			const candidateEvidence = fixture.evidence.proposed.candidates.find(
				(candidate) => candidate.ref.digest === ref.digest && candidate.ref.byteLength === ref.byteLength
			);
			if (candidateEvidence === undefined) throw new TypeError("D.108d1 successor trust candidate missing");
			const trust = decodeCanonical(candidateEvidence.bytes) as Readonly<Record<string, unknown>>;
			fixture.controls.blobOverrides.set(
				ref.digest,
				encodeCanonical({ ...trust, genesisAnchorDigest: "f".repeat(64) })
			);
			fixture.controls.aheOperationCounts.clear();
			const verifier = (await import(
				pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts")).href
			)) as { verifyCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> };
			const result = await verifier.verifyCreatorSuccessorAdoption({
				catalog: fixture.catalog,
				handle: fixture.handle,
			});
			expect(result).toMatchObject({ ok: false });
			expect(fixture.controls.aheOperationCounts.get("swapHead") ?? 0).toBe(0);
			const child = await childMaterial();
			childDirectory = child.directory;
			const cold = await runD108d1ActivationChild("divergent-genesis", child.material);
			expect(cold.proof).toMatchObject({
				effects: {
					adoptionSwapCount: 0,
					installEpochAnchorCount: 0,
					publicationCount: 0,
					subscribeCount: 0,
				},
				failure: { kind: "chain-invalid", ok: false },
			});
		} finally {
			await fixture.close();
			if (childDirectory !== undefined) rmSync(childDirectory, { force: true, recursive: true });
		}
	});

	it("pending epoch-zero outbox is classified and never published as epoch one", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let result: ActiveResult | undefined;
		try {
			const prepared = await committed(fixture);
			const recording = recordingRuntimeBindings(`d108d1-displaced-${crypto.randomUUID()}`);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			result = await activate({ capability: prepared.capability, handle: fixture.handle, ...recording.input });
			expect(result.ok).toBe(true);
			const handle = result.handle as Readonly<{
				publishPending(): Promise<Readonly<Record<string, unknown>>>;
				readRebaseOutbox(): Promise<Readonly<Record<string, unknown>>>;
			}>;
			expect(await handle.readRebaseOutbox()).toMatchObject({
				kind: "displaced",
				ok: true,
				source: { authorSequence: fixture.evidence.localIssued.authorSequence, publishState: "pending" },
			});
			expect(await handle.publishPending()).toMatchObject({ kind: "empty", ok: true });
			const oldDigest = (
				await fixture.evidence.issuanceStore.readOutboxPage({ scope: fixture.evidence.issuanceScope })
			)[0]?.commit.envelope.digest as Uint8Array;
			expect(recording.publications.some((publication) => containsDigest(publication, oldDigest))).toBe(false);
		} finally {
			await deactivate(result);
			await fixture.close();
		}
	});

	it("old handle registration author and prepared capability are terminal", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let activated: ActiveResult | undefined;
		try {
			const prepared = await committed(fixture);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const input = {
				capability: prepared.capability,
				handle: fixture.handle,
				...runtimeBindings(`d108d1-terminal-${crypto.randomUUID()}`),
			};
			activated = await activate(input);
			expect(activated).toMatchObject({ ok: true });
			expect(await activate(input)).toMatchObject({ kind: "capability-unavailable", ok: false });
			expect(fixture.handle.status()).toMatchObject({ closeAuthority: "unavailable", lifecycle: "successor-adopted" });
			const verifier = (await import(
				pathToFileURL(resolve(REPOSITORY_ROOT, "packages/node/src/creator-adoption.ts")).href
			)) as { verifyCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> };
			expect(
				await verifier.verifyCreatorSuccessorAdoption({ catalog: fixture.catalog, handle: fixture.handle })
			).toMatchObject({
				ok: false,
			});
		} finally {
			await deactivate(activated);
			await fixture.close();
		}
	});

	it("hot duplicate returns the same handle before a second source claim", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let first: ActiveResult | undefined;
		try {
			const bindings = runtimeBindings(`d108d1-duplicate-${crypto.randomUUID()}`);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const firstPrepared = await committed(fixture);
			const secondPrepared = await committed(fixture);
			first = await activate({ capability: firstPrepared.capability, handle: fixture.handle, ...bindings });
			const second = await activate({ capability: secondPrepared.capability, handle: fixture.handle, ...bindings });
			expect(first).toMatchObject({ ok: true });
			expect(second).toMatchObject({ ok: true });
			expect(second.handle).toBe(first.handle);
		} finally {
			await deactivate(first);
			await fixture.close();
		}
	});

	it("conflicting hot duplicate bindings fail closed", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let first: ActiveResult | undefined;
		try {
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const firstPrepared = await committed(fixture);
			const secondPrepared = await committed(fixture);
			first = await activate({
				capability: firstPrepared.capability,
				handle: fixture.handle,
				...runtimeBindings(`d108d1-binding-a-${crypto.randomUUID()}`),
			});
			expect(first).toMatchObject({ ok: true });
			expect(
				await activate({
					capability: secondPrepared.capability,
					handle: fixture.handle,
					...runtimeBindings(`d108d1-binding-b-${crypto.randomUUID()}`),
				})
			).toMatchObject({ ok: false });
		} finally {
			await deactivate(first);
			await fixture.close();
		}
	});

	it("post-adoption activation failure cleans up and fresh reverify performs no second swapHead", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		let recovered: ActiveResult | undefined;
		try {
			fixture.controls.aheOperationCounts.clear();
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const failedPrepared = await committed(fixture);
			const broken = fakeNetwork(`d108d1-failure-${crypto.randomUUID()}`);
			Object.defineProperty(broken, "subscribe", {
				value: () => Promise.reject(new Error("D108D1_SUBSCRIBE_FAILURE")),
			});
			expect(
				await activate({
					capability: failedPrepared.capability,
					handle: fixture.handle,
					messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
					networkNode: broken,
					onAdmittedVertex: () => undefined,
				})
			).toMatchObject({ ok: false });
			const replay = await committed(fixture);
			expect(replay).toMatchObject({ ok: true, recovery: "active-new" });
			recovered = await activate({
				capability: replay.capability,
				handle: fixture.handle,
				...runtimeBindings(`d108d1-retry-${crypto.randomUUID()}`),
			});
			expect(recovered).toMatchObject({ ok: true });
			expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);
		} finally {
			await deactivate(recovered);
			await fixture.close();
		}
	});

	it("TTL expiry performs one bounded full reverify attempt", async () => {
		const child = await childMaterial();
		try {
			const result = await runD108d1ActivationChild("ttl-expired", child.material);
			expect(result.proof).toMatchObject({
				effects: {
					aheRecoverCount: 1,
					adoptionSwapCount: 0,
					publicationCount: 0,
					snapshotOpenCount: 1,
					subscribeCount: 0,
				},
				failure: { kind: "snapshot-unavailable", ok: false },
			});
		} finally {
			rmSync(child.directory, { force: true, recursive: true });
		}
	});
});
