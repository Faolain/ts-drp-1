import { expectTypeOf } from "vitest";

import type {
	AheDurableStore,
	BlobDigest,
	ClosureDigest,
	GenerationId,
	GenerationPageCursor,
	HeadRevision,
	StorageObjectId,
} from "../src/index.js";

declare const objectId: StorageObjectId;
declare const generationId: GenerationId;
declare const blobDigest: BlobDigest;
declare const closureDigest: ClosureDigest;
declare const revision: HeadRevision;
declare const store: AheDurableStore;

expectTypeOf(store.readHead).parameter(0).toEqualTypeOf<StorageObjectId>();
expectTypeOf(store.readGenerationPage).parameter(0).toEqualTypeOf<{
	readonly objectId: StorageObjectId;
	readonly cursor?: GenerationPageCursor;
	readonly limit: number;
}>();
expectTypeOf(store.capabilities.durability).toEqualTypeOf<"ephemeral" | "strict">();

// @ts-expect-error Plain strings never cross the storage identity boundary.
void store.readHead("legacy-room-id");
// @ts-expect-error Object and generation brands are not interchangeable.
void store.readHead(generationId);
// @ts-expect-error The removed whole-state read cannot advertise a cross-call snapshot.
void store.readObjectState(objectId);
// @ts-expect-error Generation IDs cannot be forged into opaque continuation cursors.
void store.readGenerationPage({ objectId, cursor: generationId, limit: 1 });
// @ts-expect-error Blob and closure digest domains are nominally distinct.
const _wrongBlob: BlobDigest = closureDigest;
// @ts-expect-error Generation and object identities are nominally distinct.
const _wrongGeneration: GenerationId = objectId;
// @ts-expect-error Revisions are not plain numbers.
const _wrongRevision: HeadRevision = 1;
// @ts-expect-error Digest brands are not textual IDs.
const _wrongObject: StorageObjectId = blobDigest;

expectTypeOf(revision).toMatchTypeOf<number>();
