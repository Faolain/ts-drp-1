/** Numerical resource facts use the original codec/Reader, never a second
 * encoding, decoder, native authority, or available/charged balance. */
export {
	canonicalPrimitiveResourceForSizing,
	canonicalBytesResourceForSizing,
	canonicalArrayResourceForSizing,
	canonicalArrayResourcesForSizing,
	canonicalRecordResourceForSizing,
	canonicalCarrierResourceForSizing,
	canonicalValueResourceForSizing,
	type CanonicalResourceFootprint,
} from "./internal/codec.js";
