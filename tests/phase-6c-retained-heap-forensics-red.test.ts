import { describe, it } from "vitest";

import {
	D110AX_FORENSICS_RED_TOKEN,
	requireD110axFailureForensics,
} from "./fixtures/phase-6c/retained-heap-contract.js";

describe("D.110a-x retained-heap failure forensics RED", () => {
	it(`closes ${D110AX_FORENSICS_RED_TOKEN}`, () => {
		requireD110axFailureForensics();
	});
});
