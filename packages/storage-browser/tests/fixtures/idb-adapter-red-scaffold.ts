import type {
	AheDurableStore,
	BlobDigest,
	ExpectedHead,
	GenerationId,
	GenerationRecord,
	GenerationRef,
	PresentHead,
	StorageObjectId,
	StoreResult,
} from "@ts-drp/storage";

import type { BrowserAheDurableStoreOptions } from "../../src/index.js";

type BrowserAheDurableStoreFactory = (options: BrowserAheDurableStoreOptions) => Promise<AheDurableStore>;

type Phase2e1PublicStore = Pick<
	AheDurableStore,
	| "beginGeneration"
	| "capabilities"
	| "close"
	| "completeGeneration"
	| "discardGeneration"
	| "getBlob"
	| "promoteReference"
	| "putCachedBlob"
	| "swapHead"
> & {
	readHead(objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>>;
	readGenerationPage(input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: string;
		readonly limit: number;
	}): Promise<StoreResult<{ readonly generations: readonly GenerationRecord[]; readonly nextCursor: null }>>;
};

const CAUSE = Object.freeze({ code: "PHASE_2D2A_NOT_IMPLEMENTED" });

function unavailable<T>(): Promise<StoreResult<T>> {
	return Promise.resolve({ ok: false, reason: "SUBSTRATE_FAILURE", cause: CAUSE });
}

class InertStrictRedStore implements Phase2e1PublicStore {
	public readonly capabilities = Object.freeze({
		durability: "strict" as const,
		signingEligibility: "backend-capability-required" as const,
	});

	public readHead(_objectId: StorageObjectId): Promise<StoreResult<ExpectedHead>> {
		return unavailable();
	}

	public readGenerationPage(_input: {
		readonly objectId: StorageObjectId;
		readonly cursor?: string;
		readonly limit: number;
	}): Promise<StoreResult<{ readonly generations: readonly GenerationRecord[]; readonly nextCursor: null }>> {
		return unavailable();
	}

	public getBlob(_digest: BlobDigest): Promise<StoreResult<Uint8Array | null>> {
		return unavailable();
	}

	public beginGeneration(_input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly baseExpectedHead: ExpectedHead;
		readonly closure: readonly GenerationRef[];
	}): Promise<StoreResult<GenerationRecord>> {
		return unavailable();
	}

	public putCachedBlob(_input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly digest: BlobDigest;
		readonly bytes: Uint8Array;
	}): Promise<StoreResult<{ inserted: boolean }>> {
		return unavailable();
	}

	public promoteReference(_input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly digest: BlobDigest;
	}): Promise<StoreResult<undefined>> {
		return unavailable();
	}

	public completeGeneration(_input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return unavailable();
	}

	public swapHead(_input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
		readonly expectedHead: ExpectedHead;
	}): Promise<StoreResult<{ head: PresentHead; supersededGenerationId: GenerationId | null }>> {
		return unavailable();
	}

	public discardGeneration(_input: {
		readonly objectId: StorageObjectId;
		readonly generationId: GenerationId;
	}): Promise<StoreResult<GenerationRecord>> {
		return unavailable();
	}

	public close(): Promise<void> {
		return Promise.resolve();
	}
}

/**
 * Loads the future private production owner without making RED fail at import time.
 * The inert fallback is deliberately strict-labelled but behaviorally incapable.
 * @param options - Isolated production database options.
 * @returns The real private adapter when present, otherwise the behavioral RED scaffold.
 */
export async function createPhase2d2aRedStore(options: BrowserAheDurableStoreOptions): Promise<AheDurableStore> {
	const productionModulePath = ["..", "..", "src", "internal", "idb-adapter.js"].join("/");
	let candidate: unknown;
	try {
		candidate = await import(productionModulePath);
	} catch {
		return new InertStrictRedStore() as unknown as AheDurableStore;
	}
	if (typeof candidate === "object" && candidate !== null) {
		const factory = Reflect.get(candidate, "createBrowserAheDurableStore");
		if (typeof factory === "function") {
			return (factory as BrowserAheDurableStoreFactory)(options);
		}
	}
	return new InertStrictRedStore() as unknown as AheDurableStore;
}
