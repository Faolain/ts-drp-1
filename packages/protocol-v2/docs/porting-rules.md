# Protocol v2 semantics-preserving porting rules

The normative field and framing registry is
[`../registry/field-registry.json`](../registry/field-registry.json). These rules are requirements for the
JavaScript-to-TypeScript port; TypeScript must not silently change the reference semantics.

| #   | Hazard                                | Port rule                                                                                                                            | Violation-catching gate                                                |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1   | `number` vs `bigint`                  | Protocol integers remain safe `number` values and are checked with `Number.isSafeInteger`; `bigint` is outside the canonical domain. | `porting-rules.test.ts` rule 1                                         |
| 2   | `-0` and NaN                          | Every float encoder normalizes `-0` to `+0`; every float path rejects non-finite values.                                             | `porting-rules.test.ts` rule 2                                         |
| 3   | `undefined` vs an absent key          | Omission means the key is absent. Optional properties compile under `exactOptionalPropertyTypes`; builders never assign `undefined`. | `porting-rules.test.ts` rule 3                                         |
| 4   | Prototypes and null-prototype records | Decoded objects have a null prototype. Only ordinary or null-prototype objects encode; consumers use `Object.hasOwn`.                | `porting-rules.test.ts` rule 4                                         |
| 5   | `Map`/`Set` iteration order           | Canonical encoding sorts encoded key/value bytes; no consumer relies on insertion order.                                             | `porting-rules.test.ts` rule 5                                         |
| 6   | `structuredClone` vs canonical clone  | Consensus state uses `deepCloneCanonical` only. `structuredClone` is lint-banned in protocol source.                                 | `porting-rules.test.ts` rule 6 plus ESLint                             |
| 7   | Async WebCrypto vs sync noble         | Protocol hashing is synchronous `@noble/hashes/sha2`, exposed only through `hashDomain(domain, ...parts): Uint8Array`.               | `porting-rules.test.ts` rule 7 type assertion and runtime differential |
| 8   | DataView endianness vs `Buffer`       | Typed arrays are encoded with explicit big-endian DataView calls. `Buffer` is lint-banned in protocol source.                        | `porting-rules.test.ts` rule 8 plus ESLint                             |
| 9   | Locale-dependent sorting              | Protocol strings sort in UTF-8 byte order (`sortRule: "codepoint"`), never with `localeCompare`.                                     | `porting-rules.test.ts` rule 9                                         |
| 10  | String length units                   | Protocol string limits count UTF-16 code units, matching the reference.                                                              | `porting-rules.test.ts` rule 10                                        |
