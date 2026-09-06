import { type AheDurableStore, digestBlob, type ExpectedHead, type GenerationRecord } from "@ts-drp/storage";

import { createBrowserAheDurableStore } from "../../dist/src/index.js";
import { resolveBrowserAheReclamationMaintenance } from "../../dist/src/maintenance.js";

const OBJECT_ID = `creator:${"f".repeat(32)}`;
const POLICY_DIGEST = "53775c5c1ee01e346f588966d6e7acb876df2bd8b2abcbe2b2591f216f7d4d9b";
const FACADE_KEYS = Object.freeze([
	"applyWrite",
	"applyWrites",
	"beginGeneration",
	"capabilities",
	"close",
	"completeGeneration",
	"discardGeneration",
	"ensureCertificate",
	"execute",
	"getBlob",
	"lifecycle",
	"loadBlob",
	"loadFacts",
	"loadGeneration",
	"loadPromotion",
	"observeHead",
	"probeBlobPresence",
	"promoteReference",
	"putCachedBlob",
	"readGenerationPage",
	"readHead",
	"recoverActiveGeneration",
	"recoverWithinTransaction",
	"recoveryCertificates",
	"request",
	"requiredHeadObservation",
	"run",
	"runRecovery",
	"swapHead",
	"verifyCandidate",
	"verifyClosure",
] as const);

function generationId(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function successful<T>(result: { ok: false; reason: string } | { ok: true; value: T }, label: string): T {
	if (!result.ok) throw new TypeError(`D109F_BROWSER_${label}:${result.reason}`);
	return result.value;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
		? String(Reflect.get(error, "code"))
		: undefined;
}

async function seed(
	store: AheDurableStore,
	count: number
): Promise<
	Readonly<{
		head: Exclude<ExpectedHead, { kind: "none" }>;
		records: readonly GenerationRecord[];
	}>
> {
	let head: ExpectedHead = successful(await store.readHead(OBJECT_ID), "HEAD");
	for (let index = 1; index <= count; index += 1) {
		const id = generationId(index) as GenerationRecord["generationId"];
		const bytes = Uint8Array.of(index, index + 1, index + 2);
		const digest = successful(digestBlob(bytes), "DIGEST");
		const closure = [{ byteLength: bytes.byteLength, digest }];
		successful(
			await store.beginGeneration({ baseExpectedHead: head, closure, generationId: id, objectId: OBJECT_ID }),
			"BEGIN"
		);
		successful(await store.putCachedBlob({ bytes, digest, generationId: id, objectId: OBJECT_ID }), "PUT");
		successful(await store.promoteReference({ digest, generationId: id, objectId: OBJECT_ID }), "PROMOTE");
		successful(await store.completeGeneration({ generationId: id, objectId: OBJECT_ID }), "COMPLETE");
		head = successful(await store.swapHead({ expectedHead: head, generationId: id, objectId: OBJECT_ID }), "SWAP").head;
	}
	if (head.kind !== "present") throw new TypeError("D109F_BROWSER_HEAD_ABSENT");
	const records = successful(await store.readGenerationPage({ limit: 128, objectId: OBJECT_ID }), "PAGE").generations;
	return Object.freeze({ head, records });
}

function request(fixture: Awaited<ReturnType<typeof seed>>): Readonly<Record<string, unknown>> {
	const [first, floor, rollback, active] = fixture.records;
	if (first === undefined || floor === undefined || rollback === undefined || active === undefined) {
		throw new TypeError("D109F_BROWSER_LINEAGE_MISSING");
	}
	return Object.freeze({
		activeGenerationId: active.generationId,
		availabilityPolicyDigest: POLICY_DIGEST,
		closedEpoch: 0,
		expectedHead: fixture.head,
		lineageFloor: Object.freeze({
			deleteGenerationIds: Object.freeze([first.generationId]),
			expectedBaseExpectedHead: floor.baseExpectedHead,
			generationId: floor.generationId,
			replacementBaseExpectedHead: Object.freeze({ kind: "none", objectId: OBJECT_ID }),
		}),
		objectId: OBJECT_ID,
		rollbackGenerationIds: Object.freeze([rollback.generationId, floor.generationId]),
	});
}

async function run(prefix: string): Promise<Readonly<Record<string, unknown>>> {
	const invalidStore = await createBrowserAheDurableStore({ databaseName: `${prefix}-invalid` });
	let invalidCode: string | undefined;
	try {
		const fixture = await seed(invalidStore, 4);
		const owner = resolveBrowserAheReclamationMaintenance(invalidStore);
		if (owner === undefined) throw new TypeError("D109F_BROWSER_OWNER_MISSING");
		const invalid = structuredClone(request(fixture)) as Record<string, unknown> & {
			lineageFloor: Record<string, unknown>;
		};
		invalid.lineageFloor.deleteGenerationIds = [];
		try {
			await owner.reclaimClosedEpoch(invalid);
		} catch (error) {
			invalidCode = errorCode(error);
		}
	} finally {
		await invalidStore.close();
	}

	const databaseName = `${prefix}-eligible`;
	const store = await createBrowserAheDurableStore({ databaseName });
	let receipt: unknown;
	let replay: unknown;
	let facadeKeys: readonly string[] = [];
	try {
		const fixture = await seed(store, 4);
		const owner = resolveBrowserAheReclamationMaintenance(store);
		if (owner === undefined) throw new TypeError("D109F_BROWSER_OWNER_MISSING");
		const input = request(fixture);
		receipt = await owner.reclaimClosedEpoch(input);
		replay = await owner.reclaimClosedEpoch(input);
		facadeKeys = Object.freeze(
			[...Object.keys(store), ...Object.getOwnPropertyNames(Object.getPrototypeOf(store))]
				.filter((key) => key !== "constructor")
				.sort()
		);
	} finally {
		await store.close();
	}
	const reopened = await createBrowserAheDurableStore({ databaseName });
	try {
		const head = successful(await reopened.readHead(OBJECT_ID), "REOPEN_HEAD");
		const generations = successful(
			await reopened.readGenerationPage({ limit: 128, objectId: OBJECT_ID }),
			"REOPEN_PAGE"
		).generations;
		return Object.freeze({
			expectedFacadeKeys: FACADE_KEYS,
			facadeKeys,
			generationCount: generations.length,
			head,
			invalidCode,
			receipt,
			replay,
		});
	} finally {
		await reopened.close();
	}
}

Reflect.set(globalThis, "phase6bDifferentialExit", Object.freeze({ ready: true, run }));
