import {encodeAheRetirementControl, type AheRetirementControl} from "@ts-drp/storage";
import {describe, expect, it} from "vitest";
import {
	captureCreatorEarlyTurnoverToken,
	creatorCloseRetirementResumeRequired,
	creatorRecoveryPoolPressure,
} from "../src/internal/creator-recovery-pool.js";

// Pure scheduling policy only. Eligibility, authentication and native atomicity
// stay with the original planner/reconciliation owner and are not exercised here.
const objectId = `creator:${"a".repeat(32)}` as AheRetirementControl["objectId"];
const domain = () => [255, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32), new Uint8Array(32), 0] as const;
function completed(throughEpoch: number, overrides: Partial<AheRetirementControl> = {}): AheRetirementControl {
	return {kind: "ahe-retirement-control-3", objectId, incarnation: "b".repeat(64), revision: 9, sequence: 4,
		completed: {throughEpoch, decisionDigest: "c".repeat(64), snapshotHoles: [], generationHoles: [],
			generationIdentities: [], sourceProofDigest: "d".repeat(64), domains: [domain()]},
		active: null, binding: null, nominee: null, ...overrides};
}
const closeInput = (intent: AheRetirementControl | null, extra: object = {}) => ({
	reconciliationPending: false, reconstructionPresent: false, intent, currentEpoch: 5, ...extra});

describe("recovery-pool watermark", () => {
	it("requests early turnover only when the next close would turn over inline", () => {
		const limits = {maxRecoveryScopes: 4, maxObjectGenerations: 7};
		expect(creatorRecoveryPoolPressure({...limits, recoveryScopes: 3, generations: 5})).toBe(false);
		expect(creatorRecoveryPoolPressure({...limits, recoveryScopes: 4, generations: 0})).toBe(true);
		expect(creatorRecoveryPoolPressure({...limits, recoveryScopes: 0, generations: 6})).toBe(true);
	});
});

describe("early turnover token", () => {
	it("captures exact canonical bytes of a completed idle control only", () => {
		const control = completed(4), token = captureCreatorEarlyTurnoverToken(5, control);
		expect(token?.epoch).toBe(5);
		expect(token?.control).toEqual(encodeAheRetirementControl(control));
		expect(Object.isFrozen(token)).toBe(true);
		expect(captureCreatorEarlyTurnoverToken(5, null)).toBeUndefined();
		expect(captureCreatorEarlyTurnoverToken(5, {...control, completed: null})).toBeUndefined();
		expect(captureCreatorEarlyTurnoverToken(5, {...control, active: {} as AheRetirementControl["active"]})).toBeUndefined();
		const {domains: _, ...withoutDomains} = control.completed!;
		expect(captureCreatorEarlyTurnoverToken(5, {...control, completed: withoutDomains})).toBeUndefined();
		// A pending capacity drain is unfinished native work, never a consumed boundary.
		const pending = {...control, completed: {...control.completed!,
			generationDrain: {phase: "pending"}}} as unknown as AheRetirementControl;
		expect(captureCreatorEarlyTurnoverToken(5, pending)).toBeUndefined();
	});
});

describe("close-time resume rule", () => {
	it("keeps the original rule when no early turnover ran", () => {
		expect(creatorCloseRetirementResumeRequired(closeInput(null))).toBe(false);
		expect(creatorCloseRetirementResumeRequired(closeInput(completed(3)))).toBe(false); // Older completion: not at boundary.
		expect(creatorCloseRetirementResumeRequired(closeInput(completed(4)))).toBe(true); // Original boundary resume.
		expect(creatorCloseRetirementResumeRequired(closeInput(null, {reconciliationPending: true}))).toBe(true);
		expect(creatorCloseRetirementResumeRequired(closeInput(null, {reconstructionPresent: true}))).toBe(true);
		expect(creatorCloseRetirementResumeRequired(closeInput(completed(3, {active: {} as AheRetirementControl["active"]})))).toBe(true);
	});

	it("skips only the byte-equal control this process's same-epoch turnover produced", () => {
		const control = completed(4), earlyTurnover = captureCreatorEarlyTurnoverToken(5, control)!;
		expect(creatorCloseRetirementResumeRequired(closeInput(control, {earlyTurnover}))).toBe(false);
		// A structurally equal reread is still the same durable record.
		expect(creatorCloseRetirementResumeRequired(closeInput(completed(4), {earlyTurnover}))).toBe(false);
	});

	it("resumes on any other epoch, revision, recorded work or pending recovery", () => {
		const control = completed(4), earlyTurnover = captureCreatorEarlyTurnoverToken(5, control)!;
		for (const input of [
			closeInput(completed(5), {earlyTurnover, currentEpoch: 6}),
			closeInput(completed(4, {revision: 10}), {earlyTurnover}),
			closeInput(completed(4, {sequence: 5}), {earlyTurnover}),
			closeInput({...control, completed: {...control.completed!, decisionDigest: "e".repeat(64)}}, {earlyTurnover}),
			closeInput(control, {earlyTurnover: captureCreatorEarlyTurnoverToken(4, control)}),
			closeInput(control, {earlyTurnover, reconciliationPending: true}),
			closeInput(control, {earlyTurnover, reconstructionPresent: true}),
		]) expect(creatorCloseRetirementResumeRequired(input)).toBe(true);
		// An undecodable observation never matches a token.
		const invalid = {...control, incarnation: "not a digest"};
		expect(creatorCloseRetirementResumeRequired(closeInput(invalid, {earlyTurnover}))).toBe(true);
	});
});
