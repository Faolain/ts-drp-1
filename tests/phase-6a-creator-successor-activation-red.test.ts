import "fake-indexeddb/auto";

import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { Message } from "@ts-drp/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import {
	CREATOR_SUCCESSOR_ACTIVATION_EXPORTS,
	CREATOR_SUCCESSOR_ACTIVATION_FAILURE_KINDS,
	CREATOR_SUCCESSOR_ACTIVATION_INPUT_KEYS,
	CREATOR_SUCCESSOR_ACTIVATION_SUCCESS_KEYS,
	CREATOR_SUCCESSOR_REOPEN_INPUT_KEYS,
	D108D1_BROWSER_BEHAVIORS,
	D108D1_CHILD_BEHAVIORS,
	D108D1_GREEN_PATHS,
	D108D1_NODE_BEHAVIORS,
	D108D1_RED_PATHS,
	type D108d1CandidateModule,
	d108d1Readiness,
	d108d1SourceGovernance,
	deriveD108d1Oracle,
	REPOSITORY_ROOT,
} from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";

const readiness = d108d1Readiness();

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

describe("D.108d1 creator successor activation RED", () => {
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

	it("freezes the closed non-root surface without caller-selected identity", () => {
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
			exactColdInputCapture: readiness.ready,
			exactHotInputCapture: readiness.ready,
			internalCustody: readiness.ready,
			noProductConsumer: true,
			noRawEpochInput: true,
			noRootExport: true,
			privateEpochAnchor: readiness.ready,
			recoveredAuthorityUnchanged: true,
			webLockAuthority: readiness.ready,
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
		expect((unitSource.match(/it\.skipIf\(!readiness\.ready\)/gu) ?? []).length).toBe(D108D1_NODE_BEHAVIORS.length);
		expect((childSource.match(/it\.skipIf\(!readiness\.ready\)/gu) ?? []).length).toBe(D108D1_CHILD_BEHAVIORS.length);
		expect((browserSource.match(/test\.skip\(!GREEN_READY/gu) ?? []).length).toBe(1);
	});

	it("[RED readiness] requires all eight candidate owners and the exact non-root export", () => {
		expect(readiness, `missing D.108d1 owners: ${readiness.missing.join(", ")}`).toEqual({ missing: [], ready: true });
	});

	it.skipIf(!readiness.ready)(
		"genuine successor imports its verified snapshot before epoch-one activation",
		async () => {
			const fixture = await openGenuineCreatorAdoptionFixture();
			try {
				const oracle = deriveD108d1Oracle(fixture);
				const prepared = await committed(fixture);
				const activate = (await candidate()).activateCreatorSuccessorAdoption;
				if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
				const result = await activate({
					capability: prepared.capability,
					handle: fixture.handle,
					...runtimeBindings(`d108d1-${crypto.randomUUID()}`),
				});
				expect(result).toMatchObject({ lifecycle: "active", ok: true, recovery: "active-new" });
				const handle = result.handle as Readonly<Record<string, unknown>>;
				expect(handle).toMatchObject({ epoch: 1, objectId: oracle.objectId, topic: oracle.stableTopic });
				const journal = await fixture.journal.readiness({
					scope: { anchorDigest: oracle.anchorDigest, epoch: 1, objectId: oracle.objectId },
				});
				expect(journal).toMatchObject({ ok: true, ready: true, scope: { epoch: 1 } });
			} finally {
				await fixture.close();
			}
		}
	);

	it.skipIf(!readiness.ready)("private custody alone selects installEpochAnchor", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
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
			const forgedCold = Object.fromEntries(CREATOR_SUCCESSOR_REOPEN_INPUT_KEYS.map((key) => [key, Object.freeze({})]));
			expect(await surface.reopenCreatorSuccessorAdoption({ ...forgedCold, epoch: 1 })).toEqual(
				expect.objectContaining({ kind: "malformed-input", ok: false })
			);
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("divergent genesis identity fails before every live effect", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
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
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("pending epoch-zero outbox is classified and never published as epoch one", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const prepared = await committed(fixture);
			const bindings = runtimeBindings(`d108d1-displaced-${crypto.randomUUID()}`);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const result = await activate({ capability: prepared.capability, handle: fixture.handle, ...bindings });
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
			expect(bindings.networkNode).toMatchObject({
				publishMessage: expect.not.objectContaining({ calls: expect.anything() }),
			});
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("old handle registration author and prepared capability are terminal", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const prepared = await committed(fixture);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const input = {
				capability: prepared.capability,
				handle: fixture.handle,
				...runtimeBindings(`d108d1-terminal-${crypto.randomUUID()}`),
			};
			expect(await activate(input)).toMatchObject({ ok: true });
			expect(await activate(input)).toMatchObject({ kind: "capability-unavailable", ok: false });
			expect(fixture.handle.status()).toMatchObject({ lifecycle: "successor-pending-adoption" });
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("hot duplicate returns the same handle before a second source claim", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const bindings = runtimeBindings(`d108d1-duplicate-${crypto.randomUUID()}`);
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const firstPrepared = await committed(fixture);
			const first = await activate({ capability: firstPrepared.capability, handle: fixture.handle, ...bindings });
			const secondPrepared = await committed(fixture);
			const second = await activate({ capability: secondPrepared.capability, handle: fixture.handle, ...bindings });
			expect(first).toMatchObject({ ok: true });
			expect(second).toMatchObject({ ok: true });
			expect(second.handle).toBe(first.handle);
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)("conflicting hot duplicate bindings fail closed", async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		try {
			const activate = (await candidate()).activateCreatorSuccessorAdoption;
			if (activate === undefined) throw new TypeError("D.108d1 activation export missing");
			const firstPrepared = await committed(fixture);
			expect(
				await activate({
					capability: firstPrepared.capability,
					handle: fixture.handle,
					...runtimeBindings(`d108d1-binding-a-${crypto.randomUUID()}`),
				})
			).toMatchObject({ ok: true });
			const secondPrepared = await committed(fixture);
			expect(
				await activate({
					capability: secondPrepared.capability,
					handle: fixture.handle,
					...runtimeBindings(`d108d1-binding-b-${crypto.randomUUID()}`),
				})
			).toMatchObject({ ok: false });
		} finally {
			await fixture.close();
		}
	});

	it.skipIf(!readiness.ready)(
		"post-adoption activation failure cleans up and fresh reverify performs no second swapHead",
		async () => {
			const fixture = await openGenuineCreatorAdoptionFixture();
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
				expect(
					await activate({
						capability: replay.capability,
						handle: fixture.handle,
						...runtimeBindings(`d108d1-retry-${crypto.randomUUID()}`),
					})
				).toMatchObject({ ok: true });
				expect(fixture.controls.aheOperationCounts.get("swapHead")).toBe(1);
			} finally {
				await fixture.close();
			}
		}
	);

	it.skipIf(!readiness.ready)("TTL expiry performs one bounded full reverify attempt", async () => {
		const surface = await candidate();
		if (surface.reopenCreatorSuccessorAdoption === undefined) throw new TypeError("D.108d1 reopen export missing");
		let openCount = 0;
		const input = Object.fromEntries(CREATOR_SUCCESSOR_REOPEN_INPUT_KEYS.map((key) => [key, Object.freeze({})]));
		input.snapshotStore = Object.freeze({
			openScope: () => {
				openCount += 1;
				return Promise.reject(new Error("D108D1_EXPIRED_SCOPE"));
			},
		});
		expect(await surface.reopenCreatorSuccessorAdoption(input)).toMatchObject({ ok: false });
		expect(openCount).toBeLessThanOrEqual(1);
	});
});
