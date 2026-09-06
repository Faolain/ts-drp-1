/* eslint-disable import/no-unresolved -- Focused build plugin owns the causal maintenance alias. */
import { digestBlob, type ExpectedHead, type GenerationRecord } from "@ts-drp/storage";

import {
	D109C_BROWSER_MAINTENANCE_READY,
	resolveBrowserAheReclamationMaintenance,
} from "#phase-6b-ahe-reclamation-maintenance";
import { createBrowserAheDurableStore } from "../../src/index.js";
import { installBrowserAheReclamationCrashObserver } from "../../src/internal/ahe-reclamation.js";

const EDGES = Object.freeze([
	"after-floor-rewrite",
	"after-promotion-delete",
	"after-generation-delete",
	"after-blob-delete",
	"before-commit",
	"after-commit",
]);
const OBJECT_ID = `creator:${"a".repeat(32)}`;
const POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";

function successful<T>(result: { ok: false; reason: string } | { ok: true; value: T }, label: string): T {
	if (result.ok === false) throw new TypeError(`D109C_BROWSER_WORKER_${label}:${result.reason}`);
	return result.value;
}

async function run(databaseName: string, edge: string): Promise<void> {
	const store = await createBrowserAheDurableStore({ databaseName });
	const maintenance = resolveBrowserAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	let head: ExpectedHead = successful(await store.readHead(OBJECT_ID), "HEAD");
	const records: GenerationRecord[] = [];
	for (let index = 1; index <= 5; index += 1) {
		const generationId = index.toString(16).padStart(64, "0");
		const bytes = Uint8Array.of(index, index + 1, index + 2);
		const digest = successful(digestBlob(bytes), "DIGEST");
		const closure = [{ byteLength: bytes.byteLength, digest }];
		successful(
			await store.beginGeneration({ baseExpectedHead: head, closure, generationId, objectId: OBJECT_ID }),
			"BEGIN"
		);
		successful(await store.putCachedBlob({ bytes, digest, generationId, objectId: OBJECT_ID }), "PUT");
		successful(await store.promoteReference({ digest, generationId, objectId: OBJECT_ID }), "PROMOTE");
		successful(await store.completeGeneration({ generationId, objectId: OBJECT_ID }), "COMPLETE");
		head = successful(await store.swapHead({ expectedHead: head, generationId, objectId: OBJECT_ID }), "SWAP").head;
	}
	records.push(...successful(await store.readGenerationPage({ limit: 16, objectId: OBJECT_ID }), "PAGE").generations);
	const floor = records[2];
	const first = records[3];
	const active = records[4];
	const olderFirst = records[0];
	const olderSecond = records[1];
	if (
		olderFirst === undefined ||
		olderSecond === undefined ||
		floor === undefined ||
		first === undefined ||
		active === undefined ||
		head.kind !== "present"
	) {
		throw new TypeError("D109C_BROWSER_WORKER_LINEAGE_MISSING");
	}
	installBrowserAheReclamationCrashObserver(store, (observed) => {
		if (observed !== edge) return;
		self.postMessage({ edge, kind: "checkpoint" });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	});
	await maintenance.reclaimClosedEpoch({
		activeGenerationId: active.generationId,
		availabilityPolicyDigest: POLICY_DIGEST,
		closedEpoch: 4,
		expectedHead: head,
		lineageFloor: {
			deleteGenerationIds: [olderFirst.generationId, olderSecond.generationId].sort(),
			expectedBaseExpectedHead: floor.baseExpectedHead,
			generationId: floor.generationId,
			replacementBaseExpectedHead: { kind: "none", objectId: OBJECT_ID },
		},
		objectId: OBJECT_ID,
		rollbackGenerationIds: [first.generationId, floor.generationId],
	});
	throw new TypeError(`D109C_BROWSER_WORKER_CHECKPOINT_MISSED:${edge}`);
}

self.addEventListener("message", (event: MessageEvent<{ readonly databaseName?: string; readonly edge?: string }>) => {
	const { databaseName, edge } = event.data;
	if (!D109C_BROWSER_MAINTENANCE_READY || databaseName === undefined || edge === undefined || !EDGES.includes(edge)) {
		self.postMessage({ kind: "refused", ready: D109C_BROWSER_MAINTENANCE_READY });
		return;
	}
	void run(databaseName, edge).catch((error: unknown) => {
		self.postMessage({
			kind: "worker-error",
			message: error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
	});
});

self.postMessage({ kind: "ready", ready: D109C_BROWSER_MAINTENANCE_READY });
