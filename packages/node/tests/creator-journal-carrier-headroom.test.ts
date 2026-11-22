import { readFileSync } from "node:fs";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import "../src/index.js"; // creator-close resolves its registration through the node index.
import { ISSUANCE_CAPACITY_FORECAST_EXCEEDED, issuanceCapacityRefusal } from "../src/creator-close.js";

// Journal headroom for the mandatory close/adoption rows (fix/maintenance-image-capacity). The creator's
// own maintenance quote projects the journal after this move (afterLocal), after the close and the
// successor's install (afterSuccessor: the closed scope's membership row and the successor's scope
// header) and after the successor's fence (afterSuccessorLocal). Each of those wrappers is the journal
// observation carrier that the close, the adoption's settlement fence and the successor's first own
// move encode with closedRetirementBytes, capped at 786,432 bytes. The quote bounded them by the
// journal's own image bound (2 MiB) instead, so a five-Writer room admitted moves until the close's
// own rows pushed the carrier past the cap and the next fence was refused: the room stopped.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const found = tree.statements.filter((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (found.length !== 1) throw new Error(`missing owner: ${name}:${found.length}`);
	return found[0]!.getText(tree);
}

describe("journal headroom for the mandatory close/adoption rows", () => {
	it("bounds every projected journal carrier phase of the creator's own quote by the close's per-carrier encode cap", () => {
		const composer = declaration("composeProspectiveCreatorMaintenancePrefixesForSizing");
		// The after-local / after-successor / after-successor-local wrappers.
		expect(composer).toContain("nativeObservations.push({width: wrapperWidth, maxBytes: CLOSED_RETIREMENT_BYTES.maxBytes});");
		// The final source journal and each successor job's observation carriers.
		expect(composer).toContain("}, CLOSED_RETIREMENT_BYTES.maxBytes); // The journal observation carrier's encode cap.");
		expect(composer).toContain("for (const width of observations) nativeObservations.push({width, maxBytes: CLOSED_RETIREMENT_BYTES.maxBytes});");
		expect(composer).toContain("maxBytes: index === 0 ? CLOSED_RETIREMENT_BYTES.maxBytes :");
		// No journal carrier keeps the journal's image bound as its observation bound. (The rows FIELD
		// keeps its own native entitlement: maintenanceEncodedWidth(..., LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes).)
		expect(composer).not.toMatch(/maxBytes: (?:index === 0 \? )?LIVE_JOURNAL_RETIREMENT_LIMITS\.maxImageBytes/u);
		expect(composer).not.toMatch(/\}, LIVE_JOURNAL_RETIREMENT_LIMITS\.maxImageBytes\);/u);
		// The window programme's scalar check of the successor jobs' observations agrees with its compiled limit.
		const builder = declaration("buildCreatorOrdinaryFinishingResourceProgramForSizing");
		expect(builder).toContain("successorObservations.some(value => value.byteLength > CLOSED_RETIREMENT_BYTES.maxBytes)");
		expect(builder).not.toMatch(/\? LIVE_JOURNAL_RETIREMENT_LIMITS\.maxImageBytes : AHE_BOUNDED_READ_LIMITS\.maxUnionBytes/u);
		// A phase past the cap is the quote's typed native-image refusal: admission refuses the move with
		// the one capacity reason, and the rollover policy rolls the room while the close still fits.
		expect(composer).toContain("reason: `MAINTENANCE_NATIVE_IMAGE_EXHAUSTED:${exhaustedNative.width}/${exhaustedNative.maxBytes}`");
		expect(issuanceCapacityRefusal("MAINTENANCE_NATIVE_IMAGE_EXHAUSTED:786437/786432")?.startsWith(ISSUANCE_CAPACITY_FORECAST_EXCEEDED)).toBe(true);
	});
});
