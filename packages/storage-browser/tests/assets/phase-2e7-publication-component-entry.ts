import {
	type AheDurableStore,
	digestBlob,
	type ExpectedHead,
	type GenerationId,
	parseGenerationId,
	type ParseResult,
	parseStorageObjectId,
	type StorageObjectId,
} from "@ts-drp/storage";
import { runStoreContract } from "@ts-drp/storage/contract";
// RED: the publishable package root is intentionally absent until Phase 2e7 GREEN.
// eslint-disable-next-line import/no-unresolved
import { type BrowserAheDurableStoreOptions, createBrowserAheDurableStore } from "@ts-drp/storage-browser";

function must<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error(`invalid public component fixture: ${result.reason}`);
	return result.value;
}

const publicOptions = (databaseName: string): BrowserAheDurableStoreOptions => ({ databaseName });

async function stageComplete(
	store: AheDurableStore,
	objectId: StorageObjectId,
	generationId: GenerationId,
	bytes: Uint8Array,
	baseExpectedHead: ExpectedHead
): Promise<void> {
	const digest = must(digestBlob(bytes));
	const begun = await store.beginGeneration({
		baseExpectedHead,
		closure: [{ byteLength: bytes.byteLength, digest }],
		generationId,
		objectId,
	});
	if (!begun.ok) throw new Error(`public begin failed: ${begun.reason}`);
	const cached = await store.putCachedBlob({ bytes, digest, generationId, objectId });
	if (!cached.ok) throw new Error(`public cache failed: ${cached.reason}`);
	const promoted = await store.promoteReference({ digest, generationId, objectId });
	if (!promoted.ok) throw new Error(`public promote failed: ${promoted.reason}`);
	const completed = await store.completeGeneration({ generationId, objectId });
	if (!completed.ok) throw new Error(`public complete failed: ${completed.reason}`);
}

async function runPublicComponent(): Promise<unknown> {
	const contractDatabase = `phase-2e7-contract-${crypto.randomUUID()}`;
	const contract = await runStoreContract(() => createBrowserAheDurableStore(publicOptions(contractDatabase)));
	const databaseName = `phase-2e7-reopen-${crypto.randomUUID()}`;
	const objectId = must(parseStorageObjectId(`phase-2e7:${"a".repeat(32)}`));
	const generationId = must(parseGenerationId("b".repeat(64)));
	const competingGenerationId = must(parseGenerationId("c".repeat(64)));
	const futureGenerationId = must(parseGenerationId("d".repeat(64)));
	const bytes = Uint8Array.of(2, 7, 2, 7);
	const digest = must(digestBlob(bytes));
	const first = await createBrowserAheDurableStore(publicOptions(databaseName));
	try {
		await stageComplete(first, objectId, generationId, bytes, { kind: "none", objectId });
	} finally {
		await first.close();
	}
	const reopened = await createBrowserAheDurableStore(publicOptions(databaseName));
	try {
		const blob = await reopened.getBlob(digest);
		const adopted = await reopened.swapHead({
			expectedHead: { kind: "none", objectId },
			generationId,
			objectId,
		});
		if (!adopted.ok) throw new Error(`public adoption failed: ${adopted.reason}`);
		await stageComplete(reopened, objectId, competingGenerationId, Uint8Array.of(1, 1, 2, 3), adopted.value.head);
		await stageComplete(reopened, objectId, futureGenerationId, Uint8Array.of(5, 8, 13), adopted.value.head);
		const advanced = await reopened.swapHead({
			expectedHead: adopted.value.head,
			generationId: futureGenerationId,
			objectId,
		});
		if (!advanced.ok) throw new Error(`public advance failed: ${advanced.reason}`);
		const rollback = await reopened.swapHead({
			expectedHead: adopted.value.head,
			generationId: competingGenerationId,
			objectId,
		});
		const candidates = await reopened.readGenerationPage({ limit: 16, objectId });
		if (!candidates.ok) throw new Error(`public candidate read failed: ${candidates.reason}`);
		const candidate = candidates.value.generations.find(
			(record: { readonly generationId: GenerationId; readonly state: string }) =>
				record.generationId === competingGenerationId
		);
		const finalHead = await reopened.readHead(objectId);
		return {
			contract,
			// eslint-disable-next-line import/no-unresolved -- RED root resolution is the causal boundary.
			publicKeys: Object.keys(await import("@ts-drp/storage-browser")).sort(),
			reopened: blob.ok && [...blob.value].join(",") === [...bytes].join(","),
			rollbackControl: {
				candidateState: candidate?.state,
				finalHeadGeneration: finalHead.ok && finalHead.value.kind === "present" ? finalHead.value.generationId : null,
				futureGeneration: futureGenerationId,
				result: rollback.ok ? "OK" : rollback.reason,
			},
		};
	} finally {
		await reopened.close();
	}
}

Reflect.set(globalThis, "phase2e7PublicComponent", Object.freeze({ run: runPublicComponent }));
