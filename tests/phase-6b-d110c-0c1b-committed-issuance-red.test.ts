import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import {
	D110C_0C1B_PREBOUND_REFUSAL,
	proveD110c0c1bCommittedIssuanceRecovery,
} from "./fixtures/phase-6b-d110c-0c1b/committed-issuance-recovery-contract.js";

describe("D.110c-0c1b committed-issuance recovery-required RED", () => {
	it("refuses a pre-bound close after a durable issue is omitted from live admission", async () => {
		Object.defineProperty(navigator, "storage", {
			configurable: true,
			value: Object.freeze({ estimate: () => Promise.resolve({ quota: 1_000_000_000_000, usage: 0 }) }),
		});
		await expect(proveD110c0c1bCommittedIssuanceRecovery()).resolves.toEqual({
			currentCloseAdvanced: false,
			firstCloseError: D110C_0C1B_PREBOUND_REFUSAL,
			issueKind: "journal-rejected",
			journalWriteDelegated: false,
			pendingRowDelta: 1,
		});
	});
});
