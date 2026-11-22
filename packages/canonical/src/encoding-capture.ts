/** Invocation-local ORIGINAL-codec child sharing for bounded multi-output
 * encoders. Captures carry syntax only, never authentication or native currency. */
export {
	createCanonicalEncodingCapture,
	type CanonicalEncodingCapture,
	type CanonicalEncodingCaptureValue,
} from "./internal/codec.js";
