import { consumeSnapshotVerificationReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import {
  SNAPSHOT_QUARANTINE_RETENTION_MS
} from "@ts-drp/storage/snapshot-transfer";
const MAX_MANIFEST_BYTES = 212387;
const MAX_CHUNKS = 2048;
const MAX_BYTES = 268435456;
const intrinsicArrayBufferPrototype = ArrayBuffer.prototype;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicReflectApply = Reflect.apply;
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(Uint8Array.prototype);
const intrinsicTypedArrayBufferGetter = intrinsicObjectGetOwnPropertyDescriptor(intrinsicTypedArrayPrototype, "buffer")?.get;
const intrinsicTypedArrayByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "byteLength"
)?.get;
const intrinsicTypedArrayByteOffsetGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "byteOffset"
)?.get;
const intrinsicArrayBufferByteLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicArrayBufferPrototype,
  "byteLength"
)?.get;
const intrinsicArrayBufferResizableGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicArrayBufferPrototype,
  "resizable"
)?.get;
const intrinsicUint8Array = Uint8Array;
const intrinsicUint8ArrayPrototype = Uint8Array.prototype;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;
class QuarantineError extends Error {
  code;
  constructor(code, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.code = code;
  }
}
function failure(code, message, cause) {
  return new QuarantineError(code, message, cause);
}
function promiseCapture(operation) {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw failure("aborted", "snapshot quarantine operation was aborted", signal.reason);
}
function exactRecord(value, fields) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === fields.length && fields.every((field) => Reflect.has(value, field));
}
function exactBytes(value, label, maximum) {
  try {
    if (intrinsicObjectGetPrototypeOf(value) !== intrinsicUint8ArrayPrototype) throw new TypeError();
    const byteLength = intrinsicReflectApply(intrinsicTypedArrayByteLengthGetter, value, []);
    const byteOffset = intrinsicReflectApply(intrinsicTypedArrayByteOffsetGetter, value, []);
    const buffer = intrinsicReflectApply(intrinsicTypedArrayBufferGetter, value, []);
    if (intrinsicObjectGetPrototypeOf(buffer) !== intrinsicArrayBufferPrototype) throw new TypeError();
    const bufferByteLength = intrinsicReflectApply(intrinsicArrayBufferByteLengthGetter, buffer, []);
    const resizable = intrinsicArrayBufferResizableGetter === void 0 ? false : intrinsicReflectApply(intrinsicArrayBufferResizableGetter, buffer, []);
    if (byteLength <= 0 || byteOffset !== 0 || byteLength !== bufferByteLength || byteLength > maximum || resizable) {
      throw new TypeError();
    }
    const copy = new intrinsicUint8Array(byteLength);
    intrinsicReflectApply(intrinsicUint8ArraySet, copy, [value]);
    return copy;
  } catch (error) {
    throw failure("invalid-carrier", `${label} carrier is invalid`, error);
  }
}
function hex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function captureScope(value) {
  if (!exactRecord(value, ["anchor", "epoch", "manifestDigest", "objectId"])) {
    throw failure("malformed-input", "snapshot quarantine scope is malformed");
  }
  const { anchor, epoch, manifestDigest, objectId } = value;
  if (!hex64(anchor) || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || !hex64(manifestDigest) || typeof objectId !== "string" || objectId.length === 0) {
    throw failure("malformed-input", "snapshot quarantine scope is malformed");
  }
  return Object.freeze({ anchor, epoch, manifestDigest, objectId });
}
function captureDescriptor(value) {
  if (!exactRecord(value, ["byteLength", "digest", "index"])) {
    throw failure("malformed-input", "snapshot chunk descriptor is malformed");
  }
  const { byteLength, digest, index } = value;
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > 131072 || !hex64(digest) || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw failure("malformed-input", "snapshot chunk descriptor is malformed");
  }
  return Object.freeze({ byteLength, digest, index });
}
function captureDeclaration(value) {
  if (!exactRecord(value, ["chunks", "exactCanonicalManifestBytes", "scope", "totalBytes"])) {
    throw failure("malformed-input", "snapshot quarantine declaration is malformed");
  }
  if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > MAX_CHUNKS) {
    throw failure("malformed-input", "snapshot quarantine descriptor count is invalid");
  }
  const chunks = Object.freeze(value.chunks.map(captureDescriptor));
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.index !== index) throw failure("malformed-input", "snapshot descriptors are not contiguous");
  }
  const sum = chunks.reduce((total, descriptor) => total + descriptor.byteLength, 0);
  if (typeof value.totalBytes !== "number" || !Number.isSafeInteger(value.totalBytes) || value.totalBytes <= 0 || value.totalBytes > MAX_BYTES || value.totalBytes !== sum) {
    throw failure("malformed-input", "snapshot quarantine totalBytes is invalid");
  }
  return Object.freeze({
    chunks,
    exactCanonicalManifestBytes: exactBytes(value.exactCanonicalManifestBytes, "snapshot manifest", MAX_MANIFEST_BYTES),
    scope: captureScope(value.scope),
    totalBytes: value.totalBytes
  });
}
function captureOptions(value) {
  if (!exactRecord(value, ["primaryDatabaseName"]) || typeof value.primaryDatabaseName !== "string" || value.primaryDatabaseName === "") {
    throw failure("malformed-input", "browser snapshot quarantine options are malformed");
  }
  return value.primaryDatabaseName;
}
function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
function scopeKey(scope) {
  return [scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest];
}
function chunkKey(scope, index) {
  return [...scopeKey(scope), index];
}
function chunkRange(scope) {
  return IDBKeyRange.bound([...scopeKey(scope), 0], [...scopeKey(scope), MAX_CHUNKS]);
}
function selectorRange(scope) {
  return IDBKeyRange.bound(
    [scope.objectId, scope.epoch, scope.anchor, ""],
    [scope.objectId, scope.epoch, scope.anchor, "\uFFFF"]
  );
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb-request-failed")), {
      once: true
    });
  });
}
function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("indexeddb-transaction-aborted")),
      { once: true }
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("indexeddb-transaction-failed")),
      { once: true }
    );
  });
}
function strictTransaction(database, stores, mode) {
  return database.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : void 0);
}
async function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener(
      "upgradeneeded",
      (event) => {
        if (event.oldVersion !== 0) {
          request.transaction?.abort();
          return;
        }
        const scopes = request.result.createObjectStore("scopes", {
          keyPath: ["objectId", "epoch", "anchor", "manifestDigest"]
        });
        scopes.createIndex("expiryAsc", "expiresAt", { unique: false });
        request.result.createObjectStore("chunks", {
          keyPath: ["objectId", "epoch", "anchor", "manifestDigest", "index"]
        });
      },
      { once: true }
    );
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("indexeddb-open-failed")), {
      once: true
    });
  });
}
function sameKeyPath(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}
function admitSchema(database) {
  if (database.version !== 1 || JSON.stringify([...database.objectStoreNames]) !== JSON.stringify(["chunks", "scopes"])) {
    throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
  }
  const transaction = database.transaction(["chunks", "scopes"], "readonly");
  const chunks = transaction.objectStore("chunks");
  const scopes = transaction.objectStore("scopes");
  if (!sameKeyPath(chunks.keyPath, ["objectId", "epoch", "anchor", "manifestDigest", "index"]) || chunks.autoIncrement || !sameKeyPath(scopes.keyPath, ["objectId", "epoch", "anchor", "manifestDigest"]) || scopes.autoIncrement || JSON.stringify([...scopes.indexNames]) !== JSON.stringify(["expiryAsc"])) {
    throw failure("unsupported-schema", "browser snapshot quarantine schema is unsupported");
  }
}
async function deleteChunks(transaction, scope) {
  const chunks = transaction.objectStore("chunks");
  const keys = await requestResult(chunks.getAllKeys(chunkRange(scope)));
  for (const key of keys) chunks.delete(key);
}
async function deleteScope(transaction, scope) {
  await deleteChunks(transaction, scope);
  transaction.objectStore("scopes").delete(scopeKey(scope));
}
function fromScopeRow(value) {
  if (!exactRecord(value, [
    "anchor",
    "chunkCount",
    "epoch",
    "exactCanonicalManifestBytes",
    "expiresAt",
    "manifestDigest",
    "objectId",
    "state",
    "totalBytes"
  ])) {
    throw failure("poisoned", "browser snapshot quarantine scope row is malformed");
  }
  return value;
}
async function createBrowserSnapshotQuarantineStore(options) {
  const primaryDatabaseName = captureOptions(options);
  const estimate = await navigator.storage.estimate();
  if ((estimate.quota ?? 0) - (estimate.usage ?? 0) < MAX_BYTES) {
    throw failure("storage-failed", "browser storage quota is below the snapshot ceiling");
  }
  let database;
  try {
    database = await openDatabase(`${primaryDatabaseName}--drp-snapshot-quarantine-v1`);
    admitSchema(database);
  } catch (error) {
    if (error instanceof QuarantineError) throw error;
    throw failure("unsupported-schema", "browser snapshot quarantine admission failed", error);
  }
  database.addEventListener("versionchange", () => database.close());
  let closed = false;
  let closing;
  let tail = Promise.resolve();
  const schedule = (operation) => {
    if (closed) return Promise.reject(failure("closed", "snapshot quarantine store is closed"));
    const selected = tail.then(operation);
    tail = selected.then(
      () => void 0,
      () => void 0
    );
    return selected;
  };
  const sweep = async (now) => {
    const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
    const scopes = transaction.objectStore("scopes");
    const rows = await requestResult(scopes.index("expiryAsc").getAll(IDBKeyRange.upperBound(now)));
    for (const row of rows) await deleteScope(transaction, row);
    await transactionComplete(transaction);
    return rows.length;
  };
  const openScope = (declarationInput, optionsInput = {}) => {
    return promiseCapture(() => {
      const declaration = captureDeclaration(declarationInput);
      const signal = optionsInput.signal;
      throwIfAborted(signal);
      return schedule(async () => {
        throwIfAborted(signal);
        await sweep(Date.now());
        try {
          const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
          const scopes = transaction.objectStore("scopes");
          const selectedKey = await requestResult(scopes.getKey(selectorRange(declaration.scope)));
          if (selectedKey !== void 0 && JSON.stringify(selectedKey) !== JSON.stringify(scopeKey(declaration.scope))) {
            transaction.abort();
            throw failure("conflict", "snapshot quarantine manifest conflicts with the occupied scope");
          }
          const raw = await requestResult(scopes.get(scopeKey(declaration.scope)));
          if (raw === void 0) {
            const row = Object.freeze({
              ...declaration.scope,
              chunkCount: declaration.chunks.length,
              exactCanonicalManifestBytes: new Uint8Array(declaration.exactCanonicalManifestBytes),
              expiresAt: Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
              state: "open",
              totalBytes: declaration.totalBytes
            });
            scopes.add(row);
          } else {
            const row = fromScopeRow(raw);
            if (!sameBytes(row.exactCanonicalManifestBytes, declaration.exactCanonicalManifestBytes) || row.totalBytes !== declaration.totalBytes || row.chunkCount !== declaration.chunks.length) {
              transaction.abort();
              throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
            }
          }
          await transactionComplete(transaction);
        } catch (error) {
          if (error instanceof QuarantineError) throw error;
          throw failure("storage-failed", "browser snapshot quarantine open failed", error);
        }
        let released = false;
        let canceled = false;
        const ensureSession = () => {
          if (released) throw failure("closed", "snapshot quarantine scope is closed");
        };
        const descriptorAt = (value) => {
          const descriptor = captureDescriptor(value);
          const expected = declaration.chunks[descriptor.index];
          if (expected === void 0 || expected.byteLength !== descriptor.byteLength || expected.digest !== descriptor.digest) {
            throw failure("malformed-input", "snapshot chunk descriptor is foreign to this scope");
          }
          return expected;
        };
        const queryStatus = async () => {
          const transaction = strictTransaction(database, ["chunks", "scopes"], "readonly");
          const [rawScope, keys] = await Promise.all([
            requestResult(transaction.objectStore("scopes").get(scopeKey(declaration.scope))),
            requestResult(transaction.objectStore("chunks").getAllKeys(chunkRange(declaration.scope)))
          ]);
          await transactionComplete(transaction);
          if (rawScope === void 0)
            throw failure(canceled ? "closed" : "expired", "snapshot quarantine scope is absent");
          const row = fromScopeRow(rawScope);
          const occupied = new Set(keys.map((key) => Number(key[4])));
          return Object.freeze({
            expiresAt: row.expiresAt,
            kind: row.state,
            missingIndices: Object.freeze(
              declaration.chunks.filter(({ index }) => !occupied.has(index)).map(({ index }) => index)
            )
          });
        };
        const verificationQuarantine = Object.freeze({
          open(portSignal) {
            ensureSession();
            let portClosed = false;
            const ensurePort = () => {
              ensureSession();
              if (portClosed) throw failure("closed", "snapshot quarantine port is closed");
              throwIfAborted(portSignal);
            };
            const port = Object.freeze({
              discard: () => {
                if (portClosed) return Promise.resolve();
                portClosed = true;
                return Promise.resolve();
              },
              read: (descriptorInput) => {
                return promiseCapture(() => {
                  const descriptor = descriptorAt(descriptorInput);
                  ensurePort();
                  return schedule(async () => {
                    ensurePort();
                    const transaction = strictTransaction(database, ["chunks"], "readonly");
                    const raw = await requestResult(
                      transaction.objectStore("chunks").get(chunkKey(declaration.scope, descriptor.index))
                    );
                    await transactionComplete(transaction);
                    if (raw === void 0) return void 0;
                    const row = raw;
                    const bytes = exactBytes(row.exactBytes, "persisted snapshot chunk", descriptor.byteLength);
                    if (row.digest !== descriptor.digest || row.byteLength !== descriptor.byteLength || bytes.byteLength !== descriptor.byteLength) {
                      throw failure("poisoned", "snapshot quarantine chunk row is corrupt");
                    }
                    return new Uint8Array(bytes);
                  });
                });
              },
              write: (descriptorInput, exactBytesInput) => {
                return promiseCapture(() => {
                  const descriptor = descriptorAt(descriptorInput);
                  const bytes = exactBytes(exactBytesInput, "snapshot chunk", descriptor.byteLength);
                  if (bytes.byteLength !== descriptor.byteLength) {
                    throw failure("malformed-input", "snapshot chunk length is invalid");
                  }
                  ensurePort();
                  return schedule(async () => {
                    ensurePort();
                    let conflict = false;
                    const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
                    try {
                      const scopes = transaction.objectStore("scopes");
                      const chunks = transaction.objectStore("chunks");
                      const rawScope = await requestResult(scopes.get(scopeKey(declaration.scope)));
                      if (rawScope === void 0) throw failure("expired", "snapshot quarantine scope is absent");
                      const scopeRow = fromScopeRow(rawScope);
                      if (scopeRow.state === "poisoned") throw failure("poisoned", "snapshot quarantine is poisoned");
                      if (scopeRow.state === "verified")
                        throw failure("closed", "verified snapshot quarantine is immutable");
                      const raw = await requestResult(chunks.get(chunkKey(declaration.scope, descriptor.index)));
                      if (raw !== void 0) {
                        const existing = raw;
                        if (existing.digest !== descriptor.digest || existing.byteLength !== descriptor.byteLength || !sameBytes(existing.exactBytes, bytes)) {
                          scopes.put({ ...scopeRow, state: "poisoned" });
                          conflict = true;
                        }
                      } else {
                        chunks.add({
                          ...declaration.scope,
                          byteLength: descriptor.byteLength,
                          digest: descriptor.digest,
                          exactBytes: new Uint8Array(bytes),
                          index: descriptor.index
                        });
                        scopes.put({
                          ...scopeRow,
                          expiresAt: Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS
                        });
                      }
                      await transactionComplete(transaction);
                    } catch (error) {
                      if (error instanceof QuarantineError) throw error;
                      throw failure("storage-failed", "browser snapshot chunk write failed", error);
                    }
                    if (conflict) throw failure("conflict", "snapshot chunk conflicts with occupied bytes");
                  });
                });
              }
            });
            return port;
          }
        });
        const scope = Object.freeze({
          cancel: (cancelOptions = {}) => {
            throwIfAborted(cancelOptions.signal);
            if (canceled) return Promise.resolve();
            return schedule(async () => {
              throwIfAborted(cancelOptions.signal);
              try {
                const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
                await deleteScope(transaction, declaration.scope);
                await transactionComplete(transaction);
                canceled = true;
              } catch (error) {
                throw failure("storage-failed", "browser snapshot quarantine cancel failed", error);
              }
            });
          },
          complete: (receipt, completeOptions = {}) => {
            throwIfAborted(completeOptions.signal);
            return schedule(async () => {
              ensureSession();
              throwIfAborted(completeOptions.signal);
              const transaction = strictTransaction(database, ["chunks", "scopes"], "readwrite");
              try {
                const scopes = transaction.objectStore("scopes");
                const [rawScope, keys] = await Promise.all([
                  requestResult(scopes.get(scopeKey(declaration.scope))),
                  requestResult(transaction.objectStore("chunks").getAllKeys(chunkRange(declaration.scope)))
                ]);
                if (rawScope === void 0) throw failure("expired", "snapshot quarantine scope is absent");
                const row = fromScopeRow(rawScope);
                if (row.state === "poisoned") throw failure("poisoned", "snapshot quarantine is poisoned");
                if (row.state !== "open" && row.state !== "verified")
                  throw failure("poisoned", "snapshot quarantine state is invalid");
                const occupied = new Set(keys.map((key) => Number(key[4])));
                if (keys.length !== declaration.chunks.length || declaration.chunks.some(({ index }) => !occupied.has(index))) {
                  throw failure("incomplete", "snapshot quarantine is incomplete");
                }
                let completion;
                try {
                  completion = consumeSnapshotVerificationReceipt({
                    expectedScope: declaration.scope,
                    quarantine: verificationQuarantine,
                    receipt
                  });
                } catch (error) {
                  throw failure("receipt-invalid", "snapshot verification receipt is invalid", error);
                }
                if (completion.chunkCount !== declaration.chunks.length || completion.exactByteLength !== declaration.totalBytes || completion.manifestDigest !== declaration.scope.manifestDigest) {
                  throw failure("receipt-invalid", "snapshot verification completion does not match the scope");
                }
                if (row.state === "open") scopes.put({ ...row, state: "verified" });
                await transactionComplete(transaction);
              } catch (error) {
                try {
                  transaction.abort();
                } catch {
                }
                if (error instanceof QuarantineError) throw error;
                throw failure("storage-failed", "browser snapshot quarantine completion failed", error);
              }
              return Object.freeze({
                chunkCount: declaration.chunks.length,
                exactByteLength: declaration.totalBytes,
                scope: declaration.scope
              });
            });
          },
          missingIndices: (missingOptions = {}) => {
            throwIfAborted(missingOptions.signal);
            return schedule(async () => {
              ensureSession();
              throwIfAborted(missingOptions.signal);
              return (await queryStatus()).missingIndices;
            });
          },
          release: () => {
            released = true;
            return Promise.resolve();
          },
          scope: declaration.scope,
          status: (statusOptions = {}) => {
            throwIfAborted(statusOptions.signal);
            return schedule(async () => {
              ensureSession();
              throwIfAborted(statusOptions.signal);
              return queryStatus();
            });
          },
          verificationQuarantine
        });
        return scope;
      });
    });
  };
  const sweepExpired = (options2 = {}) => {
    throwIfAborted(options2.signal);
    return schedule(async () => {
      throwIfAborted(options2.signal);
      try {
        return await sweep(Date.now());
      } catch (error) {
        throw failure("storage-failed", "browser snapshot quarantine sweep failed", error);
      }
    });
  };
  const close = () => {
    if (closing !== void 0) return closing;
    closed = true;
    closing = tail.then(() => database.close());
    return closing;
  };
  return Object.freeze({ close, openScope, sweepExpired });
}
export {
  createBrowserSnapshotQuarantineStore
};
