import "fake-indexeddb/auto";

import { MessageQueueManager } from "@ts-drp/message-queue";
import { type Message, V3Envelope } from "@ts-drp/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { fakeNetwork } from "./fixtures/phase-4b-v3/live-snapshot.js";
import { openGenuineCreatorAdoptionFixture } from "./fixtures/phase-6a-v3/creator-adoption-contract.js";
import { deriveD108d1Oracle, REPOSITORY_ROOT } from "./fixtures/phase-6a-v3/creator-successor-activation-contract.js";
import {
	commitD108d1aFixture,
	D108D1A_GREEN_PATHS,
	D108D1A_HOT_BEHAVIOR,
	D108D1A_RED_PATHS,
	D108D1A_V3_LIVE_EXPORTS,
	type D108d1aCandidateModule,
	d108d1aReadiness,
	d108d1aRetainedMessage,
	d108d1aSourceGovernance,
	type D108d1aV3LiveModule,
	signD108d1aVertexDigest,
} from "./fixtures/phase-6a-v3/creator-successor-handle-identity-contract.js";

const readiness = d108d1aReadiness();

beforeAll(() => {
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
	});
});

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
	}
	throw new Error("D.108d1a asynchronous admission did not complete");
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
	return left !== undefined && Buffer.from(left).equals(Buffer.from(right));
}

describe("D.108d1a successor handle registration identity RED", () => {
	it("freezes exact six-RED/three-GREEN ownership and the unchanged v3-live surface", async () => {
		expect(D108D1A_RED_PATHS).toHaveLength(6);
		expect(D108D1A_GREEN_PATHS).toEqual([
			"packages/node/src/creator-adoption-activate.ts",
			"packages/node/src/internal/creator-successor-live.ts",
			"packages/node/src/v3-live.ts",
		]);
		expect(D108D1A_RED_PATHS.every((path) => readFileSync(resolve(REPOSITORY_ROOT, path)).byteLength > 0)).toBe(true);
		expect(d108d1aSourceGovernance()).toEqual({
			noManifestExport: true,
			noProductConsumer: true,
			noRootExport: true,
		});
		const live = await import(pathToFileURL(resolve(REPOSITORY_ROOT, D108D1A_GREEN_PATHS[2])).href);
		expect(Object.keys(live).sort()).toEqual([...D108D1A_V3_LIVE_EXPORTS].sort());
	});

	it("[RED readiness] requires the private one-shot handle-alias bridge", () => {
		expect(readiness, `missing D.108d1a facts: ${readiness.missing.join(", ")}`).toEqual({
			missing: [],
			ready: true,
		});
	});

	it.skipIf(!readiness.ready)(D108D1A_HOT_BEHAVIOR, async () => {
		const fixture = await openGenuineCreatorAdoptionFixture();
		const admitted: Readonly<Record<string, unknown>>[] = [];
		const published: Message[] = [];
		const sent: Readonly<{ readonly message: Message; readonly peerId: string }>[] = [];
		let active: Readonly<Record<string, unknown>> | undefined;
		try {
			const prepared = await commitD108d1aFixture(fixture);
			const oracle = deriveD108d1Oracle(fixture);
			const localPeerId = `d108d1a-hot-${crypto.randomUUID()}`;
			const targetPeerId = `d108d1a-target-${crypto.randomUUID()}`;
			const networkNode = fakeNetwork(localPeerId);
			Object.defineProperties(networkNode, {
				getAllPeers: { value: vi.fn(() => [targetPeerId]) },
				publishMessage: {
					value: vi.fn((_topic: string, message: Message) => {
						published.push(message);
						return Promise.resolve(true);
					}),
				},
				sendMessage: {
					value: vi.fn((peerId: string, message: Message) => {
						sent.push(Object.freeze({ message, peerId }));
						return Promise.resolve();
					}),
				},
			});
			const candidate = (await import(
				pathToFileURL(resolve(REPOSITORY_ROOT, D108D1A_GREEN_PATHS[0])).href
			)) as D108d1aCandidateModule;
			const live = (await import(
				pathToFileURL(resolve(REPOSITORY_ROOT, D108D1A_GREEN_PATHS[2])).href
			)) as D108d1aV3LiveModule;
			if (
				candidate.activateCreatorSuccessorAdoption === undefined ||
				live.routeV3RetainedIngress === undefined ||
				live.republishV3RetainedTo === undefined
			) {
				throw new TypeError("D.108d1a candidate surface is absent");
			}
			active = await candidate.activateCreatorSuccessorAdoption({
				capability: prepared.capability,
				handle: fixture.handle,
				messageQueueManager: new MessageQueueManager<Message>({ logConfig: { level: "silent" } }),
				networkNode,
				onAdmittedVertex: (delivery: Readonly<Record<string, unknown>>) => admitted.push(delivery),
			});
			expect(active).toMatchObject({ lifecycle: "active", ok: true, recovery: "active-new" });
			const handle = active.handle as Readonly<{
				deactivate(): void | Promise<void>;
				issueLocal(input: unknown): Promise<Readonly<Record<string, unknown>>>;
				publishPending(): Promise<Readonly<Record<string, unknown>>>;
				topic: string;
			}>;
			const issued = await handle.issueLocal({
				operations: Object.freeze([
					Object.freeze({ logicalTime: 10, operation: Object.freeze({ action: "add", value: 7 }) }),
				]),
				signRegisteredVertexDigest: signD108d1aVertexDigest,
			});
			expect(issued).toMatchObject({ kind: "accepted", ok: true });
			expect(await handle.publishPending()).toEqual({ kind: "published", ok: true });
			expect(published).toHaveLength(1);
			const publishedEnvelope = V3Envelope.decode(published[0]?.data ?? new Uint8Array());
			const remote = d108d1aRetainedMessage({
				anchorDigest: oracle.anchorDigest,
				author: fixture.evidence.issuanceScope.author,
				authorSequence: Number(issued.authorSequence) + 1,
				dependency: String(issued.digest),
				objectId: oracle.objectId,
				sender: `d108d1a-remote-${crypto.randomUUID()}`,
				topic: handle.topic,
			});
			expect(live.routeV3RetainedIngress(handle, remote.message)).toBe(true);
			await eventually(() =>
				admitted.some((delivery) =>
					sameBytes(
						delivery.exactReceivedCanonicalPreimageBytes as Uint8Array | undefined,
						remote.canonicalPreimageBytes
					)
				)
			);
			const journalReadiness = await fixture.journal.readiness({
				scope: { anchorDigest: oracle.anchorDigest, epoch: 1, objectId: oracle.objectId },
			});
			expect(journalReadiness).toMatchObject({ ok: true, ready: true });
			if (!journalReadiness.ok || !journalReadiness.ready) throw new TypeError("D.108d1a journal is unavailable");
			const page = await fixture.journal.readPage({
				afterSequence: null,
				limit: 16,
				scope: journalReadiness.scope,
				snapshot: journalReadiness.snapshot,
			});
			expect(page).toMatchObject({ ok: true });
			if (!page.ok) throw new TypeError("D.108d1a journal page is unavailable");
			expect(page.rows).toContainEqual(
				expect.objectContaining({ sourceKind: "received", vertexDigest: remote.digest })
			);
			expect(await live.republishV3RetainedTo(handle, targetPeerId)).toEqual({ kind: "published", ok: true });
			expect(
				sent.some(({ message, peerId }) => {
					if (peerId !== targetPeerId) return false;
					const envelope = V3Envelope.decode(message.data ?? new Uint8Array());
					return (
						sameBytes(envelope.canonicalPreimage, publishedEnvelope.canonicalPreimage) &&
						sameBytes(envelope.signature, publishedEnvelope.signature)
					);
				})
			).toBe(true);
			await Promise.resolve(handle.deactivate());
			active = undefined;
			expect(live.routeV3RetainedIngress(handle, remote.message)).toBe(false);
			expect(await live.republishV3RetainedTo(handle, targetPeerId)).toMatchObject({ kind: "not-active", ok: false });
		} finally {
			await Promise.resolve(
				(active?.handle as Readonly<{ deactivate?(): void | Promise<void> }> | undefined)?.deactivate?.()
			);
			await fixture.close();
		}
	});
});
