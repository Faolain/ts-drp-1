const encoder = new TextEncoder();

export function utf8(value) {
  return encoder.encode(String(value));
}

export function concatBytes(...parts) {
  const normalized = parts.map((part) =>
    typeof part === "string" ? utf8(part) : part instanceof Uint8Array ? part : new Uint8Array(part)
  );
  const total = normalized.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of normalized) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function bytesEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function compareBytes(left, right) {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}

export function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new TypeError("expected an even-length hexadecimal string");
  }
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index++) output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function getCrypto() {
  const implementation = globalThis.crypto;
  if (!implementation?.subtle) throw new Error("Web Crypto SubtleCrypto is required");
  return implementation;
}

export async function sha256(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new Uint8Array(await getCrypto().subtle.digest("SHA-256", bytes));
}

export async function hashDomain(domain, ...parts) {
  const domainBytes = utf8(domain);
  const framed = [Uint8Array.of(0x44, 0x52, 0x50, 0x00), u32be(domainBytes.byteLength), domainBytes];
  for (const part of parts) {
    const bytes = typeof part === "string" ? utf8(part) : part instanceof Uint8Array ? part : new Uint8Array(part);
    framed.push(u64be(bytes.byteLength), bytes);
  }
  return sha256(concatBytes(...framed));
}

export function u32be(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("u32 out of range");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

export function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("u64 value must be a non-negative safe integer");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}
