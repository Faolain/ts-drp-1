import { TransitionOwner } from "../src/internal/transition.js";

/**
 * Package-test-internal facade over the one shipped transition owner.
 * @returns A strict modeled transition harness.
 */
export function createTransitionHarness(): TransitionOwner {
	return new TransitionOwner("strict");
}
