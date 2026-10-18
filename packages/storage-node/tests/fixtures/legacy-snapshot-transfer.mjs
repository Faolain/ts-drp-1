import { consumeSnapshotVerificationReceipt } from "@ts-drp/compaction/snapshot-quarantine-receipt";
import {
  SNAPSHOT_QUARANTINE_RETENTION_MS
} from "@ts-drp/storage/snapshot-transfer";
import { DatabaseSync } from "node:sqlite";
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
  if (!exactRecord(value, ["primaryFilename"]) || typeof value.primaryFilename !== "string" || value.primaryFilename === "") {
    throw failure("malformed-input", "Node snapshot quarantine options are malformed");
  }
  return value.primaryFilename;
}
function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
function keyParameters(scope) {
  return [scope.objectId, scope.epoch, scope.anchor, scope.manifestDigest];
}
function runTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
    }
    throw error;
  }
}
function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_xinfo(${table})`).all().map(({ name }) => String(name));
}
function admitSchema(database) {
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => String(name));
  if (version === 0 && tables.length === 0) {
    database.exec(`
			CREATE TABLE snapshot_scopes(
				object_id TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				anchor TEXT NOT NULL,
				manifest_digest TEXT NOT NULL,
				exact_manifest_bytes BLOB NOT NULL,
				total_bytes INTEGER NOT NULL,
				chunk_count INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				state TEXT NOT NULL,
				PRIMARY KEY(object_id, epoch, anchor, manifest_digest)
			) WITHOUT ROWID;
			CREATE TABLE snapshot_chunks(
				object_id TEXT NOT NULL,
				epoch INTEGER NOT NULL,
				anchor TEXT NOT NULL,
				manifest_digest TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_digest TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				exact_bytes BLOB NOT NULL,
				PRIMARY KEY(object_id, epoch, anchor, manifest_digest, chunk_index),
				FOREIGN KEY(object_id, epoch, anchor, manifest_digest)
					REFERENCES snapshot_scopes(object_id, epoch, anchor, manifest_digest) ON DELETE CASCADE
			) WITHOUT ROWID;
			PRAGMA user_version=1;
		`);
    return;
  }
  if (version !== 1 || JSON.stringify(tables) !== JSON.stringify(["snapshot_chunks", "snapshot_scopes"]) || JSON.stringify(tableColumns(database, "snapshot_scopes")) !== JSON.stringify([
    "object_id",
    "epoch",
    "anchor",
    "manifest_digest",
    "exact_manifest_bytes",
    "total_bytes",
    "chunk_count",
    "expires_at",
    "state"
  ]) || JSON.stringify(tableColumns(database, "snapshot_chunks")) !== JSON.stringify([
    "object_id",
    "epoch",
    "anchor",
    "manifest_digest",
    "chunk_index",
    "chunk_digest",
    "byte_length",
    "exact_bytes"
  ])) {
    throw failure("unsupported-schema", "Node snapshot quarantine schema is unsupported");
  }
}
function createNodeSnapshotQuarantineStore(options) {
  const primaryFilename = captureOptions(options);
  const database = new DatabaseSync(`${primaryFilename}.drp-snapshot-quarantine-v1.sqlite`);
  try {
    database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;"
    );
    admitSchema(database);
  } catch (error) {
    database.close();
    if (error instanceof QuarantineError) throw error;
    throw failure("storage-failed", "Node snapshot quarantine admission failed", error);
  }
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
  const sweep = (now) => {
    const result = database.prepare("DELETE FROM snapshot_scopes WHERE expires_at <= ?").run(now);
    return Number(result.changes);
  };
  const openScope = (declarationInput, optionsInput = {}) => {
    return promiseCapture(() => {
      const declaration = captureDeclaration(declarationInput);
      const signal = optionsInput.signal;
      throwIfAborted(signal);
      return schedule(() => {
        throwIfAborted(signal);
        try {
          runTransaction(database, () => {
            sweep(Date.now());
            const selector = database.prepare("SELECT manifest_digest FROM snapshot_scopes WHERE object_id=? AND epoch=? AND anchor=? LIMIT 1").get(declaration.scope.objectId, declaration.scope.epoch, declaration.scope.anchor);
            if (selector !== void 0 && selector.manifest_digest !== declaration.scope.manifestDigest) {
              throw failure("conflict", "snapshot quarantine manifest conflicts with the occupied scope");
            }
            const existing = database.prepare(
              "SELECT exact_manifest_bytes,total_bytes,chunk_count FROM snapshot_scopes WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
            ).get(...keyParameters(declaration.scope));
            if (existing === void 0) {
              database.prepare(
                "INSERT INTO snapshot_scopes(object_id,epoch,anchor,manifest_digest,exact_manifest_bytes,total_bytes,chunk_count,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?)"
              ).run(
                ...keyParameters(declaration.scope),
                declaration.exactCanonicalManifestBytes,
                declaration.totalBytes,
                declaration.chunks.length,
                Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS,
                "open"
              );
              return;
            }
            const storedManifest = new Uint8Array(existing.exact_manifest_bytes);
            if (!sameBytes(storedManifest, declaration.exactCanonicalManifestBytes) || Number(existing.total_bytes) !== declaration.totalBytes || Number(existing.chunk_count) !== declaration.chunks.length) {
              throw failure("conflict", "snapshot quarantine declaration conflicts with durable state");
            }
          });
        } catch (error) {
          if (error instanceof QuarantineError) throw error;
          throw failure("storage-failed", "Node snapshot quarantine open failed", error);
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
        const queryStatus = () => {
          const row = database.prepare(
            "SELECT expires_at,state FROM snapshot_scopes WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
          ).get(...keyParameters(declaration.scope));
          if (row === void 0) throw failure(canceled ? "closed" : "expired", "snapshot quarantine scope is absent");
          const missing = database.prepare(
            "SELECT chunk_index FROM snapshot_chunks WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? ORDER BY chunk_index"
          ).all(...keyParameters(declaration.scope));
          const occupied = new Set(missing.map(({ chunk_index }) => Number(chunk_index)));
          return Object.freeze({
            expiresAt: Number(row.expires_at),
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
                  return schedule(() => {
                    ensurePort();
                    const row = database.prepare(
                      "SELECT chunk_digest,byte_length,exact_bytes FROM snapshot_chunks WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
                    ).get(...keyParameters(declaration.scope), descriptor.index);
                    if (row === void 0) return void 0;
                    const bytes = new Uint8Array(row.exact_bytes);
                    if (row.chunk_digest !== descriptor.digest || Number(row.byte_length) !== descriptor.byteLength || bytes.byteLength !== descriptor.byteLength) {
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
                  return schedule(() => {
                    ensurePort();
                    let conflict = false;
                    try {
                      runTransaction(database, () => {
                        const state = queryStatus();
                        if (state.kind === "poisoned") throw failure("poisoned", "snapshot quarantine is poisoned");
                        if (state.kind === "verified")
                          throw failure("closed", "verified snapshot quarantine is immutable");
                        const existing = database.prepare(
                          "SELECT chunk_digest,byte_length,exact_bytes FROM snapshot_chunks WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND chunk_index=?"
                        ).get(...keyParameters(declaration.scope), descriptor.index);
                        if (existing !== void 0) {
                          const stored = new Uint8Array(existing.exact_bytes);
                          if (existing.chunk_digest !== descriptor.digest || Number(existing.byte_length) !== descriptor.byteLength || !sameBytes(stored, bytes)) {
                            database.prepare(
                              "UPDATE snapshot_scopes SET state='poisoned' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
                            ).run(...keyParameters(declaration.scope));
                            conflict = true;
                          }
                          return;
                        }
                        database.prepare(
                          "INSERT INTO snapshot_chunks(object_id,epoch,anchor,manifest_digest,chunk_index,chunk_digest,byte_length,exact_bytes) VALUES(?,?,?,?,?,?,?,?)"
                        ).run(
                          ...keyParameters(declaration.scope),
                          descriptor.index,
                          descriptor.digest,
                          descriptor.byteLength,
                          bytes
                        );
                        database.prepare(
                          "UPDATE snapshot_scopes SET expires_at=? WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
                        ).run(Date.now() + SNAPSHOT_QUARANTINE_RETENTION_MS, ...keyParameters(declaration.scope));
                      });
                    } catch (error) {
                      if (error instanceof QuarantineError) throw error;
                      throw failure("storage-failed", "Node snapshot chunk write failed", error);
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
            return schedule(() => {
              throwIfAborted(cancelOptions.signal);
              try {
                runTransaction(database, () => {
                  database.prepare(
                    "DELETE FROM snapshot_scopes WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
                  ).run(...keyParameters(declaration.scope));
                });
                canceled = true;
              } catch (error) {
                throw failure("storage-failed", "Node snapshot quarantine cancel failed", error);
              }
            });
          },
          complete: (receipt, completeOptions = {}) => {
            throwIfAborted(completeOptions.signal);
            return schedule(() => {
              ensureSession();
              throwIfAborted(completeOptions.signal);
              try {
                return runTransaction(database, () => {
                  const status = queryStatus();
                  if (status.kind === "poisoned") throw failure("poisoned", "snapshot quarantine is poisoned");
                  if (status.kind !== "open" && status.kind !== "verified")
                    throw failure("poisoned", "snapshot quarantine state is invalid");
                  if (status.missingIndices.length !== 0)
                    throw failure("incomplete", "snapshot quarantine is incomplete");
                  const occupied = Number(
                    database.prepare(
                      "SELECT COUNT(*) AS count FROM snapshot_chunks WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=?"
                    ).get(...keyParameters(declaration.scope))?.count
                  );
                  if (occupied !== declaration.chunks.length)
                    throw failure("poisoned", "snapshot quarantine chunk closure is invalid");
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
                  if (status.kind === "open") {
                    const transition = database.prepare(
                      "UPDATE snapshot_scopes SET state='verified' WHERE object_id=? AND epoch=? AND anchor=? AND manifest_digest=? AND state='open'"
                    ).run(...keyParameters(declaration.scope));
                    if (Number(transition.changes) !== 1)
                      throw failure("poisoned", "snapshot quarantine completion lost its state transition");
                  }
                  return Object.freeze({
                    chunkCount: declaration.chunks.length,
                    exactByteLength: declaration.totalBytes,
                    scope: declaration.scope
                  });
                });
              } catch (error) {
                if (error instanceof QuarantineError) throw error;
                throw failure("storage-failed", "Node snapshot quarantine completion failed", error);
              }
            });
          },
          missingIndices: (missingOptions = {}) => {
            throwIfAborted(missingOptions.signal);
            return schedule(() => {
              ensureSession();
              throwIfAborted(missingOptions.signal);
              return queryStatus().missingIndices;
            });
          },
          release: () => {
            released = true;
            return Promise.resolve();
          },
          scope: declaration.scope,
          status: (statusOptions = {}) => {
            throwIfAborted(statusOptions.signal);
            return schedule(() => {
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
    return schedule(() => {
      throwIfAborted(options2.signal);
      try {
        return runTransaction(database, () => sweep(Date.now()));
      } catch (error) {
        throw failure("storage-failed", "Node snapshot quarantine sweep failed", error);
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
  createNodeSnapshotQuarantineStore
};
