/* eslint-disable import/no-unresolved -- Focused build plugin owns the causal maintenance alias. */
import { type AheDurableStore, createMemoryAheDurableStore, digestBlob, type ExpectedHead } from "@ts-drp/storage";

import {
	D109C_BROWSER_MAINTENANCE_READY,
	resolveBrowserAheReclamationMaintenance,
} from "#phase-6b-ahe-reclamation-maintenance";
import { createBrowserAheDurableStore } from "../../src/index.js";

const OBJECT_ID = `creator:${"a".repeat(32)}`;
const POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";

function successful<T>(result: { ok: false; reason: string } | { ok: true; value: T }, label: string): T {
	if (!result.ok) throw new TypeError(`D109C_BROWSER_${label}:${result.reason}`);
	return result.value;
}

async function fiveGenerations(store: AheDurableStore): Promise<Record<string, unknown>> {
	let head: ExpectedHead = successful(await store.readHead(OBJECT_ID), "HEAD");
	const records = [];
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
	if (head.kind !== "present") throw new TypeError("D109C_BROWSER_HEAD_ABSENT");
	const byId = new Map(records.map((record) => [record.generationId, record]));
	const active = byId.get(head.generationId);
	const first =
		active?.baseExpectedHead.kind === "present" ? byId.get(active.baseExpectedHead.generationId) : undefined;
	const floor = first?.baseExpectedHead.kind === "present" ? byId.get(first.baseExpectedHead.generationId) : undefined;
	if (active === undefined || first === undefined || floor === undefined) throw new TypeError("D109C_BROWSER_LINEAGE");
	const retained = new Set([active.generationId, first.generationId, floor.generationId]);
	return {
		activeGenerationId: active.generationId,
		availabilityPolicyDigest: POLICY_DIGEST,
		closedEpoch: 4,
		expectedHead: head,
		lineageFloor: {
			deleteGenerationIds: records
				.filter(({ generationId }) => !retained.has(generationId))
				.map(({ generationId }) => generationId)
				.sort(),
			expectedBaseExpectedHead: floor.baseExpectedHead,
			generationId: floor.generationId,
			replacementBaseExpectedHead: { kind: "none", objectId: OBJECT_ID },
		},
		objectId: OBJECT_ID,
		rollbackGenerationIds: [first.generationId, floor.generationId],
	};
}

async function run(databaseName: string): Promise<Record<string, unknown>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	const maintenance = resolveBrowserAheReclamationMaintenance(store);
	if (maintenance === undefined) throw new TypeError("D109C_BROWSER_MAINTENANCE_MISSING");
	const memory = createMemoryAheDurableStore();
	const memoryDenied = resolveBrowserAheReclamationMaintenance(memory) === undefined;
	await memory.close();
	try {
		const input = await fiveGenerations(store);
		const receipt = await maintenance.reclaimClosedEpoch(input);
		const replay = await maintenance.reclaimClosedEpoch(input);
		return {
			copiedDenied: resolveBrowserAheReclamationMaintenance({ ...store }) === undefined,
			facadeKeys: [...Object.keys(store), ...Object.getOwnPropertyNames(Object.getPrototypeOf(store))]
				.filter((key) => key !== "constructor")
				.sort(),
			memoryDenied,
			proxyDenied: resolveBrowserAheReclamationMaintenance(new Proxy(store, {})) === undefined,
			receipt,
			replay,
		};
	} finally {
		await store.close();
	}
}

function workerUrl(): string {
	return new URL("./phase-6b-ahe-reclamation-worker.js", import.meta.url).href;
}

Reflect.set(
	globalThis,
	"phase6bAheReclamation",
	Object.freeze({
		ready: D109C_BROWSER_MAINTENANCE_READY,
		run,
		workerUrl,
	})
);
