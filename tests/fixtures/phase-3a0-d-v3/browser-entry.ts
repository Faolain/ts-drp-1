import { encodeCanonical } from "@ts-drp/canonical";
import { assertTrustPreserved, createCurrentAnchorTrustStore } from "@ts-drp/control-plane";
import { authenticateCurrentEpochAnchor } from "@ts-drp/protocol-v3";
import {
	digestBlob,
	type GenerationId,
	type GenerationRef,
	parseGenerationId,
	parseStorageObjectId,
	type PresentHead,
} from "@ts-drp/storage";

import material from "./material.json" with { type: "json" };
import { createBrowserAheDurableStore } from "../../../packages/storage-browser/src/index.js";
import { withForcedPhase2dDurability } from "../../../packages/storage-browser/tests/fixtures/idb-adapter-browser-oracle.js";

type Scenario = "combined" | "creator";

type AuthoritySummary = Readonly<{
	authentication: unknown;
	authorityContext: Readonly<{ expectedObjectId: string; pinnedGenesisAnchorDigest: string }>;
	capability: Readonly<{ frozen: boolean; ownKeys: readonly string[] }>;
	head: unknown;
	recovery: unknown;
	strictDurability: boolean;
	trustRecordBytesHex: string;
	trustRef: GenerationRef;
}>;

declare global {
	interface Window {
		phase3a0D: Readonly<{
			cleanup(databaseName: string): Promise<void>;
			failClosed(databaseName: string): Promise<unknown>;
			inspect(databaseName: string): Promise<unknown>;
			install(databaseName: string, scenario: Scenario): Promise<unknown>;
			reopen(databaseName: string): Promise<unknown>;
		}>;
	}
}

function must<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>): T {
	if (!result.ok) throw new TypeError(`invalid Phase 3a0-D fixture: ${result.reason}`);
	return result.value;
}

function bytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const objectId = must(parseStorageObjectId(material.expectedAuthority.objectId));
const creatorInput = Object.freeze({
	detachedGenesisSignature: bytes(material.signatureHex),
	exactCanonicalGenesisAnchorPreimageBytes: bytes(material.anchorBytesHex),
	exactCanonicalProfileBytes: bytes(material.profileBytesHex),
	exactCanonicalSignerSetBytes: bytes(material.signerSetBytesHex),
	pinnedGenesisAnchorDigest: material.anchorDigest,
});

function generation(value: string): GenerationId {
	return must(parseGenerationId(value));
}

function sortedRefs(refs: readonly GenerationRef[]): readonly GenerationRef[] {
	return Object.freeze([...refs].sort((left, right) => left.digest.localeCompare(right.digest)));
}

async function summarize(databaseName: string): Promise<AuthoritySummary | Readonly<{ kind: "absent" }>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	try {
		const head = await store.readHead(objectId);
		if (!head.ok) throw new Error(`D head read failed: ${head.reason}`);
		if (head.value.kind === "none") {
			const durable = createCurrentAnchorTrustStore({
				objectId,
				pinnedGenesisAnchorDigest: material.anchorDigest,
				store,
			});
			const opened = await durable.open();
			if (opened.ok || opened.reason !== "not-installed") throw new Error("D absent state minted authority");
			return Object.freeze({ kind: "absent" as const });
		}
		const recovery = await store.recoverActiveGeneration(objectId);
		if (!recovery.ok || recovery.value.kind !== "active") throw new Error("D active recovery failed");
		const durable = createCurrentAnchorTrustStore({
			objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store,
		});
		const opened = await durable.open();
		if (!opened.ok) throw new Error(`D trust open failed: ${opened.reason}`);
		const record = await store.getBlob(opened.trustRef.digest);
		if (!record.ok || record.value === null) throw new Error("D trust record is missing");
		const authentication = authenticateCurrentEpochAnchor({
			detachedSignature: bytes(material.signatureHex),
			exactCanonicalAnchorPreimageBytes: bytes(material.anchorBytesHex),
			trust: opened.trust,
		});
		if (!authentication.ok) throw new Error(`D authentication failed: ${authentication.reason}`);
		return Object.freeze({
			authentication,
			authorityContext: Object.freeze({
				expectedObjectId: objectId,
				pinnedGenesisAnchorDigest: material.anchorDigest,
			}),
			capability: Object.freeze({
				frozen: Object.isFrozen(opened.trust),
				ownKeys: Object.freeze(Object.keys(opened.trust).sort()),
			}),
			head: Object.freeze({ ...head.value }),
			recovery: Object.freeze({
				head: Object.freeze({ ...recovery.value.head }),
				recomputedClosureDigest: recovery.value.recomputedClosureDigest,
				references: Object.freeze(recovery.value.references.map((ref) => Object.freeze({ ...ref }))),
			}),
			strictDurability: store.capabilities.durability === "strict",
			trustRecordBytesHex: hex(record.value),
			trustRef: Object.freeze({ ...opened.trustRef }),
		});
	} finally {
		await store.close();
	}
}

async function installCreator(databaseName: string): Promise<Readonly<{ head: PresentHead; trustRef: GenerationRef }>> {
	const store = await createBrowserAheDurableStore({ databaseName });
	try {
		const durable = createCurrentAnchorTrustStore({
			objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store,
		});
		const installed = await durable.install(creatorInput);
		if (!installed.ok) throw new Error(`D creator install failed: ${installed.reason}`);
		return Object.freeze({ head: installed.head, trustRef: installed.trustRef });
	} finally {
		await store.close();
	}
}

async function installCombined(databaseName: string): Promise<void> {
	const installed = await installCreator(databaseName);
	const store = await createBrowserAheDurableStore({ databaseName });
	try {
		const stateBytes = encodeCanonical({ kind: "phase-3a0-d-synthetic-state", version: 1 });
		const stateDigest = must(digestBlob(stateBytes));
		const stateRef = Object.freeze({ byteLength: stateBytes.byteLength, digest: stateDigest });
		const closure = sortedRefs([installed.trustRef, stateRef]);
		const trustBlob = must(await store.getBlob(installed.trustRef.digest));
		if (trustBlob === null) throw new Error("D installed trust blob is missing");
		const candidates = [
			{ bytes: trustBlob, ref: installed.trustRef },
			{ bytes: stateBytes, ref: stateRef },
		];
		const preserved = assertTrustPreserved({ candidates, closure, expectedTrustRef: installed.trustRef });
		if (!preserved.ok) throw new Error(`D trust preservation failed: ${preserved.reason}`);
		const generationId = generation("d".repeat(64));
		const begun = await store.beginGeneration({
			baseExpectedHead: installed.head,
			closure,
			generationId,
			objectId,
		});
		if (!begun.ok) throw new Error(`D combined begin failed: ${begun.reason}`);
		const cached = await store.putCachedBlob({ bytes: stateBytes, digest: stateDigest, generationId, objectId });
		if (!cached.ok) throw new Error(`D combined cache failed: ${cached.reason}`);
		for (const ref of closure) {
			const promoted = await store.promoteReference({ digest: ref.digest, generationId, objectId });
			if (!promoted.ok) throw new Error(`D combined promotion failed: ${promoted.reason}`);
		}
		const completed = await store.completeGeneration({ generationId, objectId });
		if (!completed.ok) throw new Error(`D combined complete failed: ${completed.reason}`);
		const swapped = await store.swapHead({ expectedHead: installed.head, generationId, objectId });
		if (!swapped.ok) throw new Error(`D combined swap failed: ${swapped.reason}`);
	} finally {
		await store.close();
	}
}

async function install(databaseName: string, scenario: Scenario): Promise<unknown> {
	if (scenario === "creator") await installCreator(databaseName);
	else await installCombined(databaseName);
	return summarize(databaseName);
}

async function failClosed(databaseName: string): Promise<unknown> {
	const store = await createBrowserAheDurableStore({ databaseName });
	try {
		const durable = createCurrentAnchorTrustStore({
			objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
			store,
		});
		const forced = await withForcedPhase2dDurability("default", () => durable.install(creatorInput));
		const head = await store.readHead(objectId);
		return Object.freeze({
			head: head.ok ? head.value : head,
			observed: forced.observed,
			requested: forced.requested,
			result: forced.result,
			writes: forced.writes,
		});
	} finally {
		await store.close();
	}
}

function deleteDatabase(databaseName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.addEventListener("success", () => resolve(), { once: true });
		request.addEventListener("blocked", () => reject(new Error(`D delete blocked: ${databaseName}`)), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("D delete failed")), { once: true });
	});
}

window.phase3a0D = Object.freeze({
	cleanup: deleteDatabase,
	failClosed,
	inspect: summarize,
	install,
	reopen: summarize,
});
