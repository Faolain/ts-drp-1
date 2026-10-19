/** Canonicality-reporting decode over the SAME internal codec. An exact result
 * lets a caller skip its re-encode comparison; anything else keeps it. */
export { decodeCanonicalExactness, type CanonicalExactDecoding } from "./internal/codec.js";
