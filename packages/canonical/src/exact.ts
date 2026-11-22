/** Canonicality-reporting decode over the SAME internal codec. An exact result
 * lets a caller skip its re-encode comparison; anything else keeps it. The
 * resumable walker accepts exactly the exact inputs, in bounded steps. */
export {
	createCanonicalWalker,
	decodeCanonicalExactness,
	type CanonicalExactDecoding,
	type CanonicalWalkEvent,
	type CanonicalWalker,
	type CanonicalWalkerOptions,
	type CanonicalWalkKind,
} from "./internal/codec.js";
