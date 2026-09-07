import { expect } from "vitest";

/** Keep expected publication errors and their room stacks out of Vitest's async assertion registry. */
export async function assertGridExpectedPublicationFailure(issue: Promise<unknown>): Promise<void> {
	const rejected = await issue.then(
		() => false,
		() => true
	);
	expect(rejected, "GRID100_REAL_PENDING_PUBLICATION_FAILURE").toBe(true);
}
