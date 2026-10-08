import { createBrowserLiveSnapshotFixture } from "../../../../tests/fixtures/phase-4c-v3/browser-live-snapshot.js";
import { createSnapshotTransferFixture } from "../../../../tests/fixtures/phase-4c-v3/snapshot-transfer-fixture.js";

async function runSource(): Promise<unknown> {
	const fixture = await createBrowserLiveSnapshotFixture(`phase4cc-source-${crypto.randomUUID()}`);
	try {
		const transfer = createSnapshotTransferFixture(fixture.exported);
		const secondExport = fixture.sourceHandle.exportSnapshotPayload();
		if (!secondExport.ok) throw new TypeError("browser source re-export failed");
		return Object.freeze({
			byteLength: fixture.exported.exactCanonicalPayloadBytes.byteLength,
			chunkCount: transfer.declaration.chunks.length,
			payloadDigest: fixture.exported.payloadDigest,
			stable:
				secondExport.applicationStateDigest === fixture.exported.applicationStateDigest &&
				secondExport.payloadDigest === fixture.exported.payloadDigest &&
				secondExport.exactCanonicalPayloadBytes.every(
					(value, index) => value === fixture.exported.exactCanonicalPayloadBytes[index]
				),
		});
	} finally {
		await fixture.close();
	}
}

declare global {
	interface Window {
		phase4cCSource(): Promise<unknown>;
	}
}

window.phase4cCSource = runSource;
