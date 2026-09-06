import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

import { createBrowserLiveSnapshotFixture } from "../../../../tests/fixtures/phase-4c-v3/browser-live-snapshot.js";
import {
	ScriptedSnapshotChunkPort,
	snapshotPeerAuthorization,
} from "../../../../tests/fixtures/phase-4c-v3/snapshot-pull-transport.js";
import { createSnapshotTransferFixture } from "../../../../tests/fixtures/phase-4c-v3/snapshot-transfer-fixture.js";
/* eslint-disable import/no-unresolved -- The future node transfer owner is intentionally absent in RED. */
import { createV3SnapshotTransferOwner } from "../../../node/src/snapshot-transfer.js";
import { bindV3BlueprintLivePlane } from "../../../node/src/v3-live.js";

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = (): void => reject(request.error);
		request.onsuccess = (): void => resolvePromise();
	});
}

async function waitForMissing(
	scope: Readonly<{ missingIndices(): Promise<readonly number[]> }>,
	expected: number
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if ((await scope.missingIndices()).length === expected) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
	throw new TypeError("browser snapshot transfer did not reach the interruption boundary");
}

async function waitForOpen(transport: ScriptedSnapshotChunkPort): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (transport.opened.length > 0) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
	}
	throw new TypeError("browser snapshot transfer did not open the interrupted source");
}

function snapshotHandle(plane: object): Readonly<{
	exportSnapshotPayload(): Readonly<
		| {
				readonly applicationStateDigest: string;
				readonly exactCanonicalPayloadBytes: Uint8Array;
				readonly ok: true;
				readonly payloadDigest: string;
		  }
		| { readonly ok: false }
	>;
	stageBlueprintEpoch(): Promise<Readonly<{ readonly kind?: string; readonly ok: boolean }>>;
}> {
	const binding = bindV3BlueprintLivePlane({ plane } as Parameters<typeof bindV3BlueprintLivePlane>[0]);
	if (!binding.ok) throw new TypeError("browser snapshot blueprint handle is unavailable");
	return binding.handle;
}

async function runResume(): Promise<unknown> {
	const primaryDatabaseName = `phase4cc-${crypto.randomUUID()}`;
	const databaseName = `${primaryDatabaseName}--drp-snapshot-quarantine-v1`;
	const live = await createBrowserLiveSnapshotFixture(`${primaryDatabaseName}--live`);
	const fixture = createSnapshotTransferFixture(live.exported);
	if (fixture.declaration.chunks.length !== 1) throw new TypeError("browser snapshot activation fixture is not small");
	const expectedInterruptedMissing = fixture.declaration.chunks.map(({ index }) => index);
	let interruptedStore: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined;
	let resumedStore: Awaited<ReturnType<typeof createBrowserSnapshotQuarantineStore>> | undefined;
	let interruptedOwner: ReturnType<typeof createV3SnapshotTransferOwner> | undefined;
	let resumedOwner: ReturnType<typeof createV3SnapshotTransferOwner> | undefined;
	let receiverPlane: Readonly<{ deactivate(): void }> | undefined;
	try {
		interruptedStore = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const interruptedScope = await interruptedStore.openScope(fixture.declaration);
		const interruptedTransport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:source", "slow"]]));
		interruptedOwner = createV3SnapshotTransferOwner({ transport: interruptedTransport });
		const interruptedAuthority = await live.freshRecovered("interrupted");
		const controller = new AbortController();
		const interrupted = interruptedOwner
			.receive({
				authorization: snapshotPeerAuthorization(["peer:source"]),
				capability: interruptedAuthority.capability,
				descriptors: fixture.declaration.chunks,
				exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
				expectedManifestDigest: fixture.declaration.scope.manifestDigest,
				messageQueueManager: interruptedAuthority.messageQueueManager,
				networkNode: interruptedAuthority.networkNode,
				onAdmittedVertex: interruptedAuthority.onAdmittedVertex,
				peers: ["peer:source"],
				quarantine: interruptedScope,
				signal: controller.signal,
			})
			.then(
				() => "resolved",
				(error: unknown) => String(Reflect.get(error as object, "code"))
			);
		await waitForOpen(interruptedTransport);
		await waitForMissing(interruptedScope, expectedInterruptedMissing.length);
		const retainedMissing = await interruptedScope.missingIndices();
		controller.abort(new Error("phase4c-c-browser-interruption"));
		const interruptedCode = await interrupted;
		await interruptedOwner.close();
		interruptedOwner = undefined;
		await interruptedScope.release();
		await interruptedStore.close();
		interruptedStore = undefined;

		resumedStore = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName });
		const resumedScope = await resumedStore.openScope(fixture.declaration);
		const beforeResume = await resumedScope.missingIndices();
		const resumedTransport = new ScriptedSnapshotChunkPort(fixture, new Map([["peer:source", "honest"]]));
		resumedOwner = createV3SnapshotTransferOwner({ transport: resumedTransport });
		const resumedAuthority = await live.freshRecovered("resumed");
		const completed = await resumedOwner.receive({
			authorization: snapshotPeerAuthorization(["peer:source"]),
			capability: resumedAuthority.capability,
			descriptors: fixture.declaration.chunks,
			exactCanonicalManifestBytes: fixture.declaration.exactCanonicalManifestBytes,
			expectedManifestDigest: fixture.declaration.scope.manifestDigest,
			messageQueueManager: resumedAuthority.messageQueueManager,
			networkNode: resumedAuthority.networkNode,
			onAdmittedVertex: resumedAuthority.onAdmittedVertex,
			peers: ["peer:source"],
			quarantine: resumedScope,
		});
		const activated = resumedOwner.activateSmallSnapshot({
			expectedApplicationStateDigest: live.exported.applicationStateDigest,
			expectedPayloadDigest: live.exported.payloadDigest,
			transfer: completed.verified,
		});
		receiverPlane = activated.plane as Readonly<{ deactivate(): void }>;
		const receiverHandle = snapshotHandle(activated.plane);
		const receiverExport = receiverHandle.exportSnapshotPayload();
		if (!receiverExport.ok) throw new TypeError("browser resumed snapshot export failed");
		const sourceExport = live.sourceHandle.exportSnapshotPayload();
		if (!sourceExport.ok) throw new TypeError("browser source snapshot export failed after transfer");
		const status = await resumedScope.status();
		return Object.freeze({
			beforeResume,
			byteIdentical:
				receiverExport.exactCanonicalPayloadBytes.byteLength === live.exported.exactCanonicalPayloadBytes.byteLength &&
				receiverExport.exactCanonicalPayloadBytes.every(
					(value, index) => value === live.exported.exactCanonicalPayloadBytes[index]
				),
			expectedFetched: expectedInterruptedMissing,
			expectedReceivedBytes: fixture.declaration.chunks.reduce((sum, descriptor) => sum + descriptor.byteLength, 0),
			fetchedIndices: completed.stats.fetchedIndices,
			interruptedCode,
			receivedBytes: completed.stats.exactReceivedBytes,
			retainedMissing,
			reusedIndices: completed.stats.reusedIndices,
			snapshotClosed: (await receiverHandle.stageBlueprintEpoch()).kind === "already-folded",
			sourceUnchanged:
				sourceExport.payloadDigest === live.exported.payloadDigest &&
				sourceExport.applicationStateDigest === live.exported.applicationStateDigest,
			status,
		});
	} finally {
		receiverPlane?.deactivate();
		await resumedOwner?.close();
		await interruptedOwner?.close();
		await resumedStore?.close();
		await interruptedStore?.close();
		await live.close();
		await deleteDatabase(databaseName);
	}
}

declare global {
	interface Window {
		phase4cCResume(): Promise<unknown>;
	}
}

window.phase4cCResume = runResume;
