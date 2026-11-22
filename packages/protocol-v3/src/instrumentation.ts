/** Measurement seam for count-based cost tests: observe Ed25519 verifications (computed or memo).
 * Not exported from the package entry; never authority. */
export { type Ed25519VerifyObserver, observeEd25519Verifications } from "./internal/ed25519-verify.js";
