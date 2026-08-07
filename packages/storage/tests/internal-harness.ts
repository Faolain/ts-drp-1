import { PermissiveTransitionOwner } from "../src/internal/transition.js";

/** Package-test-internal facade over the one shipped transition owner. */
export function createTransitionHarness(): PermissiveTransitionOwner {
	return new PermissiveTransitionOwner();
}
