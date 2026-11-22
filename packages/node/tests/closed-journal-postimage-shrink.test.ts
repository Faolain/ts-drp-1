import { expect, it } from "vitest";

import { closedJournalCurrentEpochPlanWidthForSizing } from "../src/internal/creator-closed-rollback-data.js";

// The single-epoch plan bound sizes an admission's own journal rows as its postimage's growth over
// the captured journal: an append only adds rows. A postimage no larger than the capture (an open
// closed-journal drain checkpoint whose plan the postimage applies, or a capture that no longer
// describes the journal) is not a width this admission can bound. It refuses typed and before any
// frame is read, so a caller can tell it from a malformed width and not retry the same capture.

const scope = { objectId: "room", epoch: 5, anchorDigest: "aa".repeat(32) };

it("a journal postimage that did not grow over its capture refuses typed, before reading a frame", () => {
	const canonicalRows = [new Uint8Array(400), new Uint8Array(300)];
	for (const [afterLocalCanonicalRowBytes, appendReceived] of [
		[[300, 200, 100], true],
		[[400, 300], true],
		[[300, 200, 150], false],
	] as const)
		expect(() =>
			closedJournalCurrentEpochPlanWidthForSizing({
				canonicalRows,
				currentScope: scope,
				afterLocalCanonicalRowBytes,
				appendCount: 1,
				appendReceived,
				author: "w1",
			})
		).toThrow("MAINTENANCE_JOURNAL_POSTIMAGE_NOT_GROWN");
});
