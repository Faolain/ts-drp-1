/** The public codec boundary stays limited to its original primitives.
 * Resource planning shares the SAME internal codec through ./resource. */
export {
	CanonicalDecodingError,
	CanonicalEncodingError,
	compareBytes,
	decodeCanonical,
	deepCloneCanonical,
	encodeCanonical,
	hashDomain,
	type CanonicalLimits,
} from "./internal/codec.js";
