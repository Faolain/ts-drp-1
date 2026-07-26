import { bytesEqual, encodeCanonical } from "./canonical.js";
import { computeCutDigest, verifyEpochAnchorHash } from "./protocol.js";
import { verifyManifest } from "./snapshot.js";

function requireIndexedDB() {
  if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable in this runtime");
  return globalThis.indexedDB;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => {
      // onabort carries the authoritative final error.
    };
  });
}

function beginTransaction(db, stores, mode, durability = "default") {
  try {
    return db.transaction(stores, mode, { durability });
  } catch (error) {
    if (durability !== "default") return db.transaction(stores, mode);
    throw error;
  }
}

function voteKey(vote) {
  return `${vote.objectId}\u0000${vote.epoch}\u0000${vote.round}\u0000${vote.phase}\u0000${vote.signerId}`;
}

export async function openEpochDatabase({ name = "ts-drp-hard-epochs", version = 1 } = {}) {
  const request = requireIndexedDB().open(name, version);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("metadata")) db.createObjectStore("metadata", { keyPath: "objectId" });
    if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "digest" });
    if (!db.objectStoreNames.contains("manifests")) db.createObjectStore("manifests", { keyPath: "digest" });
    if (!db.objectStoreNames.contains("descriptors")) db.createObjectStore("descriptors", { keyPath: "key" });
    if (!db.objectStoreNames.contains("votes")) db.createObjectStore("votes", { keyPath: "key" });
    if (!db.objectStoreNames.contains("journals")) db.createObjectStore("journals", { keyPath: "objectId" });
    if (!db.objectStoreNames.contains("vertices")) {
      const store = db.createObjectStore("vertices", { keyPath: "hash" });
      store.createIndex("objectEpoch", ["objectId", "epoch"], { unique: false });
      store.createIndex("objectId", "objectId", { unique: false });
    }
    if (!db.objectStoreNames.contains("pending")) {
      const store = db.createObjectStore("pending", { keyPath: "hash" });
      store.createIndex("objectId", "objectId", { unique: false });
    }
  };
  const db = await requestPromise(request);
  return new IndexedDBEpochStore(db);
}

export class IndexedDBEpochStore {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  async putIfAbsentVote(vote) {
    const key = voteKey(vote);
    const tx = beginTransaction(this.db, ["votes"], "readwrite", "strict");
    const store = tx.objectStore("votes");
    const existing = await requestPromise(store.get(key));
    if (existing) {
      if (!bytesEqual(encodeCanonical(existing.vote), encodeCanonical(vote))) {
        tx.abort();
        throw new Error("durable vote slot already contains a conflicting vote");
      }
      await transactionPromise(tx).catch(() => {});
      return { inserted: false, vote: existing.vote };
    }
    store.add({ key, vote, recordedAt: Date.now() });
    await transactionPromise(tx);
    return { inserted: true, vote };
  }

  async getVotes({ objectId, epoch }) {
    const tx = beginTransaction(this.db, ["votes"], "readonly");
    const records = await requestPromise(tx.objectStore("votes").getAll());
    await transactionPromise(tx);
    return records.filter((record) => record.vote.objectId === objectId && record.vote.epoch === epoch).map((record) => record.vote);
  }

  async stageSnapshot({ objectId, manifest, chunks, chunkBatchSize = 16 }) {
    if (!(chunks instanceof Map)) throw new TypeError("chunks must be a Map keyed by digest");
    if (manifest.objectId !== objectId) throw new Error("snapshot manifest belongs to another object");
    await verifyManifest(manifest);
    const entries = [...chunks.entries()];
    for (let offset = 0; offset < entries.length; offset += chunkBatchSize) {
      const tx = beginTransaction(this.db, ["chunks"], "readwrite", "relaxed");
      const store = tx.objectStore("chunks");
      for (const [digest, bytes] of entries.slice(offset, offset + chunkBatchSize)) {
        store.put({ digest, bytes: new Uint8Array(bytes), byteLength: bytes.byteLength });
      }
      await transactionPromise(tx);
    }
    const tx = beginTransaction(this.db, ["manifests", "journals"], "readwrite", "strict");
    tx.objectStore("manifests").put({ ...manifest, digest: manifest.digest });
    tx.objectStore("journals").put({
      objectId,
      phase: "snapshot-staged",
      manifestDigest: manifest.digest,
      targetEpoch: manifest.epoch,
      updatedAt: Date.now(),
    });
    await transactionPromise(tx);
  }

  async commitEpoch({ objectId, descriptor, anchor, manifestDigest, activeVertices = [] }) {
    if (descriptor.objectId !== objectId || anchor.objectId !== objectId) throw new Error("epoch commit object mismatch");
    if (!(await verifyEpochAnchorHash(anchor))) throw new Error("invalid epoch anchor");
    const expectedCutDigest = await computeCutDigest(descriptor);
    if (anchor.cutDigest !== expectedCutDigest) throw new Error("anchor does not commit the supplied cut descriptor");
    if (anchor.epoch !== descriptor.epoch + 1) throw new Error("anchor epoch does not follow descriptor epoch");
    const tx = beginTransaction(
      this.db,
      ["metadata", "descriptors", "manifests", "journals", "vertices"],
      "readwrite",
      "strict"
    );
    const manifest = await requestPromise(tx.objectStore("manifests").get(manifestDigest));
    if (!manifest) {
      tx.abort();
      throw new Error("cannot adopt an unstaged snapshot manifest");
    }
    if (manifest.objectId !== objectId || manifest.epoch !== descriptor.epoch || manifest.digest !== descriptor.snapshotManifestDigest) {
      tx.abort();
      throw new Error("snapshot manifest does not match the cut descriptor");
    }
    if (manifest.stateDigest !== descriptor.stateDigest || manifest.aclDigest !== descriptor.aclDigest) {
      tx.abort();
      throw new Error("snapshot state digests do not match the cut descriptor");
    }
    const vertices = tx.objectStore("vertices");
    const index = vertices.index("objectId");
    await new Promise((resolve, reject) => {
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(objectId));
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve();
        vertices.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
    vertices.put(anchor);
    for (const vertex of activeVertices) vertices.put(vertex);
    tx.objectStore("descriptors").put({ key: `${objectId}\u0000${descriptor.epoch}`, objectId, epoch: descriptor.epoch, descriptor });
    tx.objectStore("metadata").put({
      objectId,
      protocolMajor: anchor.protocolMajor,
      epoch: anchor.epoch,
      anchor: anchor.hash,
      cutDigest: anchor.cutDigest,
      historyRoot: anchor.historyRoot,
      historySize: anchor.historySize,
      manifestDigest,
      updatedAt: Date.now(),
    });
    tx.objectStore("journals").delete(objectId);
    await transactionPromise(tx);
  }

  async getMetadata(objectId) {
    const tx = beginTransaction(this.db, ["metadata"], "readonly");
    const value = await requestPromise(tx.objectStore("metadata").get(objectId));
    await transactionPromise(tx);
    return value;
  }

  async getJournal(objectId) {
    const tx = beginTransaction(this.db, ["journals"], "readonly");
    const value = await requestPromise(tx.objectStore("journals").get(objectId));
    await transactionPromise(tx);
    return value;
  }

  async getManifest(digest) {
    const tx = beginTransaction(this.db, ["manifests"], "readonly");
    const value = await requestPromise(tx.objectStore("manifests").get(digest));
    await transactionPromise(tx);
    return value;
  }

  async getChunk(digest) {
    const tx = beginTransaction(this.db, ["chunks"], "readonly");
    const value = await requestPromise(tx.objectStore("chunks").get(digest));
    await transactionPromise(tx);
    return value?.bytes ? new Uint8Array(value.bytes) : undefined;
  }

  async recover(objectId) {
    const [metadata, journal] = await Promise.all([this.getMetadata(objectId), this.getJournal(objectId)]);
    if (!journal) return { status: "clean", metadata };
    if (metadata?.manifestDigest === journal.manifestDigest && metadata.epoch > journal.targetEpoch) {
      return { status: "committed-with-stale-journal", metadata, journal };
    }
    return { status: "staged-not-adopted", metadata, journal };
  }

  async garbageCollectUnreferencedChunks({ liveManifestDigests, maxDeletes = 256 }) {
    const liveChunkDigests = new Set();
    for (const digest of liveManifestDigests) {
      const manifest = await this.getManifest(digest);
      for (const chunk of manifest?.chunks ?? []) liveChunkDigests.add(chunk.digest);
    }
    const tx = beginTransaction(this.db, ["chunks"], "readwrite", "relaxed");
    const store = tx.objectStore("chunks");
    let deleted = 0;
    await new Promise((resolve, reject) => {
      const request = store.openKeyCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || deleted >= maxDeletes) return resolve();
        if (!liveChunkDigests.has(cursor.primaryKey)) {
          store.delete(cursor.primaryKey);
          deleted++;
        }
        cursor.continue();
      };
    });
    await transactionPromise(tx);
    return deleted;
  }
}

export async function requestPersistentStorage() {
  const storage = globalThis.navigator?.storage;
  if (!storage) return { supported: false, persisted: false };
  const before = storage.persisted ? await storage.persisted() : false;
  const persisted = before || (storage.persist ? await storage.persist() : false);
  const estimate = storage.estimate ? await storage.estimate() : undefined;
  return { supported: true, persisted, estimate };
}

export async function withObjectLock(objectId, callback) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return callback();
  return locks.request(`ts-drp:${objectId}:epoch-transition`, { mode: "exclusive" }, callback);
}
