import { decodeCanonical, deepCloneCanonical, encodeCanonical } from "./canonical.js";
import { bytesToHex, hashDomain } from "./hash.js";

export function replaceEnumerableState(target, snapshot, { preserve = ["context"] } = {}) {
  if (target == null || typeof target !== "object" || snapshot == null || typeof snapshot !== "object") {
    throw new TypeError("state replacement requires objects");
  }
  const preserved = new Map();
  for (const key of preserve) if (Object.hasOwn(target, key)) preserved.set(key, target[key]);
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of preserved) target[key] = value;
  for (const key of Object.keys(snapshot)) {
    if (preserved.has(key)) continue;
    target[key] = deepCloneCanonical(snapshot[key]);
  }
  return target;
}

export async function stateDigest(state) {
  return bytesToHex(await hashDomain("ts-drp/state/v2", encodeCanonical(state)));
}

function assertSynchronous(result) {
  if (result && typeof result.then === "function") throw new TypeError("DRP reducers must be synchronous and deterministic");
}

export class DeterministicStateMachine {
  constructor({ initialState, reduce, validateState } = {}) {
    if (typeof reduce !== "function") throw new TypeError("a reducer function is required");
    this.reduce = reduce;
    this.validateState = validateState;
    this._state = deepCloneCanonical(initialState);
    this._validate(this._state);
  }

  _validate(state) {
    encodeCanonical(state);
    if (this.validateState) this.validateState(state);
  }

  snapshot() {
    return deepCloneCanonical(this._state);
  }

  apply(operation, context = Object.freeze({})) {
    const draft = this.snapshot();
    const result = this.reduce(draft, deepCloneCanonical(operation), context);
    assertSynchronous(result);
    const next = result === undefined ? draft : result;
    this._validate(next);
    this._state = deepCloneCanonical(next);
    return this.snapshot();
  }

  applyBatch(entries) {
    if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
    let draft = this.snapshot();
    for (const entry of entries) {
      const operation = Object.hasOwn(entry, "operation") ? entry.operation : entry;
      const context = entry.context ?? Object.freeze({});
      const result = this.reduce(draft, deepCloneCanonical(operation), context);
      assertSynchronous(result);
      if (result !== undefined) draft = result;
      this._validate(draft);
    }
    this._state = deepCloneCanonical(draft);
    return this.snapshot();
  }

  adopt(snapshot) {
    this._validate(snapshot);
    this._state = deepCloneCanonical(snapshot);
  }

  fork() {
    return new DeterministicStateMachine({
      initialState: this._state,
      reduce: this.reduce,
      validateState: this.validateState,
    });
  }

  async digest() {
    return stateDigest(this._state);
  }

  static fromCanonicalBytes(bytes, options) {
    return new DeterministicStateMachine({ ...options, initialState: decodeCanonical(bytes) });
  }
}
