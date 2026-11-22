import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

interface Result {
	results: Record<
		string,
		| {
				ok?: boolean;
				reason?: string;
				threw?: string;
				version?: number;
				control?: { active: unknown; completed: unknown; revision: number; sequence: number };
				logicalBytes?: number;
		  }
		| boolean
	>;
	images: Record<string, { version: number; rows: unknown[] }>;
	events: { ordinal: number; kind: string; id?: number; label?: string; mode?: string }[];
	cleanup: { status: string }[];
}
let server: Phase4cBrowserServer;
test.beforeAll(async () => {
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(import.meta.dirname, "assets/phase-5c-signing-participant-entry.ts"),
	});
});
test.afterAll(async () => server?.close());
test("native independent signing facets expose and rescue the same-primary acquisition cycle", async ({page}, info) => {
	await page.goto(server.origin);
	const raw = await page.evaluate(name => window.signingAcquisitionCycle(name), `signing-cycle-${crypto.randomUUID()}`) as {
		observation: {writerStarted: boolean; writerFinished: boolean; evidenceDelivered: boolean; emergency: boolean;
			transactions: {stage: string; mode: string; terminal?: string}[]};
		primary?: string; emergency: boolean; writerStarted: boolean; writerFinished: boolean; evidenceDelivered: boolean;
		events: string[]; transactions: {id: number; stage: string; mode: string; terminal?: string}[];
		cleanup: {label: string; status: string; reason?: string}[]; before: unknown; after: unknown;
	};
	await writeFile(info.outputPath("native-signing-acquisition-cycle.json"), JSON.stringify(raw), {flag: "wx"});
	expect(raw.primary).toBeUndefined(); expect(raw.emergency).toBe(false);
	expect(raw.observation).toMatchObject({writerStarted: false, writerFinished: false, evidenceDelivered: false, emergency: false});
	expect(raw.observation.transactions.map(({stage, mode}) => ({stage, mode}))).toEqual([
		{stage: "vote-ro", mode: "readonly"}, {stage: "foreign-rw", mode: "readwrite"}, {stage: "evidence-ro", mode: "readonly"}]);
	expect(raw.observation.transactions.every(row => row.terminal === undefined)).toBe(true);
	expect(raw.events.indexOf("vote-check-after-evidence-request")).toBeLessThan(raw.events.indexOf("vote-release-request"));
	expect(raw.events.indexOf("vote-release-request")).toBeLessThan(raw.events.indexOf("foreign-read-started"));
	expect(raw.events.indexOf("foreign-complete")).toBeLessThan(raw.events.indexOf("evidence-delivered"));
	expect(raw.events).toContain("evidence-check-joined");
	expect(raw.writerStarted && raw.writerFinished && raw.evidenceDelivered).toBe(true);
	expect(raw.transactions.every(row => row.terminal === "complete")).toBe(true);
	expect(raw.cleanup.every(row => row.status === "fulfilled")).toBe(true);
	expect(raw.after).toEqual(raw.before);
});
test("native shared signing facets acquire once and keep foreign writers excluded until both children join", async ({page}, info) => {
	await page.goto(server.origin);
	const result = await page.evaluate(name => window.sharedSigningAcquisition(name), `shared-signing-${crypto.randomUUID()}`) as {
		primary?: string; emergency: boolean; checks: Record<string, unknown>;
		transactions: {mode: string; stage: string; terminal?: string}[];
		writerStarted: boolean; writerFinished: boolean; before: unknown; after: unknown;
	};
	await writeFile(info.outputPath("native-shared-signing-acquisition.json"), JSON.stringify(result), {flag: "wx"});
	expect(result.primary).toBeUndefined(); expect(result.emergency).toBe(false);
	expect(result.checks.firstImageReads).toBeGreaterThan(0); expect(result.checks.rowCount).toBeGreaterThan(3);
	expect(result.checks.secondImageReads).toBe(0);
	for (const key of ["writerExcludedWithBoth", "sameCompleteRows", "detachedRows", "duplicateVoteRefused",
		"duplicateEvidenceRefused", "foreignObjectRefused", "releasedRoleRefused", "writerExcludedAfterFirstRelease",
		"closedRefused", "childCleanupJoined"]) expect(result.checks[key], key).toBe(true);
	expect(result.transactions).toEqual([{mode: "readonly", stage: "vote", terminal: "complete"},
		{mode: "readwrite", stage: "foreign", terminal: "complete"}]);
	expect(result.writerStarted && result.writerFinished).toBe(true);
	expect(result.after).toEqual(result.before);
});
test("native paired retirement joins sibling custody before original signing CAS and fresh readback", async ({page}, info) => {
	await page.goto(server.origin);
	const result = await page.evaluate(name => window.sharedSigningAcquisition(name, true), `paired-retirement-${crypto.randomUUID()}`) as {
		primary?: string; emergency: boolean; checks: Record<string, unknown>;
		transactions: {mode: string; stage: string; terminal?: string}[];
		writerStarted: boolean; writerFinished: boolean;
	};
	await writeFile(info.outputPath("native-paired-retirement.json"), JSON.stringify(result), {flag: "wx"});
	expect(result.primary).toBeUndefined(); expect(result.emergency).toBe(false);
	expect(result.checks.secondImageReads).toBe(0);
	for (const key of ["writerExcludedWithBoth", "sameCompleteRows", "detachedRows", "duplicateVoteRefused",
		"duplicateEvidenceRefused", "foreignObjectRefused", "releasedRoleRefused", "writerExcludedAfterFirstRelease",
		"mixedPurposeRefused", "mutationRevokesRead", "sameReadback", "closedRefused", "childCleanupJoined"])
		expect(result.checks[key], key).toBe(true);
	expect(result.checks.mutationBeforeJoin).toEqual({ok: false, reason: "READ_JOIN_REQUIRED"});
	expect(result.checks.mutationDuringCheck).toEqual({ok: false, reason: "READ_JOIN_REQUIRED"});
	expect(result.checks.prepareAfterJoin).toMatchObject({ok: true, control: {revision: 1, sequence: 1}});
	expect(result.checks.mutationOneUse).toEqual({ok: false, reason: "READ_RELEASED"});
	expect(result.checks.freshReadback).toMatchObject({throughEpoch: 0, protectedEpochs: [0],
		decisionDigest: "22".repeat(32), sourceProofDigest: "33".repeat(32)});
	expect(result.transactions).toEqual([{mode: "readonly", stage: "vote", terminal: "complete"},
		{mode: "readwrite", stage: "foreign", terminal: "complete"},
		{mode: "readwrite", stage: "retirement", terminal: "complete"},
		{mode: "readonly", stage: "readback", terminal: "complete"}]);
	expect(result.writerStarted && result.writerFinished).toBe(true);
});
for (const scenario of [
	"lifecycle",
	"holes",
	"image-cas",
	"custody",
	"migration",
	"forged-v5",
	"budget",
	"lost-response",
	"close-window",
	"capture-close",
]) {
	test(`native signing participant ${scenario}`, async ({ page }, info) => {
		await page.goto(server.origin);
		const raw = (await page.evaluate(({ name, scenario }) => window.signingParticipantRun(name, scenario), {
			name: `signing-participant-${crypto.randomUUID()}`,
			scenario,
		})) as Result;
		// Persist the actual original observations before any host oracle asserts.
		await writeFile(info.outputPath("native-signing-participant.json"), JSON.stringify(raw), { flag: "wx" });
		const result = (label: string): Exclude<Result["results"][string], boolean> =>
			raw.results[label] as Exclude<Result["results"][string], boolean>;
		expect(raw.results.primary).toBeUndefined();
		expect(raw.cleanup.every((item) => item.status === "fulfilled")).toBe(true);
		expect(raw.events.every((item, index) => item.ordinal === index + 1)).toBe(true);
		for (const event of raw.events.filter((item) => item.kind === "native-invoke"))
			expect(
				raw.events.filter((item) => item.id === event.id && ["native-complete", "native-abort"].includes(item.kind))
			).toHaveLength(1);
		// Selected actual mutation delivery follows this call's original RW
		// terminal, not another earlier transaction. Read interiors remain OPEN.
		for (const invocation of raw.events.filter(
			(item) =>
				item.kind === "public-invoke" &&
				["prepare", "abort", "prepare-again", "commit", "valid-next", "commit-readback"].includes(item.label ?? "")
		)) {
			const delivery = raw.events.find((item) => item.kind === "public-deliver" && item.id === invocation.id);
			expect(delivery).toBeDefined();
			const admitted = raw.events.filter(
				(item) =>
					item.kind === "native-invoke" &&
					item.mode === "readwrite" &&
					item.ordinal > invocation.ordinal &&
					item.ordinal < (delivery?.ordinal ?? -1)
			);
			expect(admitted).toHaveLength(1);
			const settled = raw.events.find((item) => item.kind === "native-complete" && item.id === admitted[0].id);
			expect(settled).toBeDefined();
			expect(settled?.ordinal).toBeLessThan(delivery?.ordinal ?? -1);
		}
		if (scenario === "migration") {
			expect(result("open").version).toBe(6);
			expect(raw.results.versionChanged).toBe(true);
			expect(raw.results.oldHandleRefused).toBe(true);
			expect(raw.images.after.rows).toEqual(raw.images.before.rows);
		} else if (scenario === "forged-v5") {
			expect(result("open").threw).toBeDefined();
			expect(raw.images.after).toEqual(raw.images.before);
		} else if (scenario === "budget") {
			expect(result("acquire").threw).toBeDefined();
			expect(raw.images.after).toEqual(raw.images.before);
		} else if (scenario === "image-cas") {
			expect(result("prepare")).toEqual({ ok: false, reason: "NATIVE_IMAGE_CHANGED" });
			expect(result("replay")).toEqual({ ok: false, reason: "READ_RELEASED" });
			for (const row of raw.images.before.rows as { name: string }[])
				if (row.name !== "signerState")
					expect((raw.images.after.rows as { name: string }[]).find((item) => item.name === row.name)).toEqual(row);
		} else if (scenario === "lost-response") {
			expect(result("prepare-lost").threw).toContain("TEST_RESPONSE_LOST_AFTER_NATIVE_COMPLETION");
			expect(result("readback").control?.active).not.toBeNull();
			expect(result("readback").control?.revision).toBe(1);
			expect(result("commit-readback").ok).toBe(true);
			expect(result("commit-readback").control?.completed).not.toBeNull();
		} else if (scenario === "capture-close") {
			expect(raw.results.closeEntered).toBe(true);
			expect(result("capture-close").threw).toBeDefined();
			expect(raw.results["returned-check"]).toBeUndefined();
			expect(result("capture-owner-close")).toEqual({ undefined: true });
			expect(raw.images.after).toEqual(raw.images.before);
			const revoked = raw.events.find((item) => item.kind === "capture-final-cursor-close");
			const delivered = raw.events.find((item) => item.kind === "public-deliver" && item.label === "capture-close");
			expect(revoked?.ordinal).toBeLessThan(delivered?.ordinal ?? -1);
		} else if (scenario === "close-window") {
			expect(raw.results.closeJoinedBeforeMutation).toBe(false);
			expect(result("during-close-round").threw).toContain("InvalidStateError");
			expect(result("owner-close")).toEqual({ undefined: true });
			expect(result("closed-check").threw).toBeDefined();
			expect(raw.images.after).toEqual(raw.images.before);
			const invoked = raw.events.find((item) => item.kind === "public-invoke" && item.label === "owner-close");
			const attempted = raw.events.find(
				(item) => item.kind === "public-deliver" && item.label === "during-close-round"
			);
			const joined = raw.events.find((item) => item.kind === "public-deliver" && item.label === "owner-close");
			expect(invoked?.ordinal).toBeLessThan(attempted?.ordinal ?? -1);
			expect(attempted?.ordinal).toBeLessThan(joined?.ordinal ?? -1);
		} else if (scenario === "custody") {
			expect(raw.results.foreign).toBe(true);
			expect(raw.results.copied).toBe(true);
			expect(raw.results.foreignEvidence).toBe(true);
			expect(result("copied-check").threw).toContain("FOREIGN_SIGNING_OBSERVATION");
			expect(result("early-abort")).toEqual({ ok: false, reason: "ILLEGAL_TRANSITION" });
			expect(result("prepare").ok).toBe(true);
			expect(result("used-check").threw).toContain("READ_RELEASED");
			expect(result("closed-check").threw).toBeDefined();
		} else {
			expect(result("capture").logicalBytes).toBeGreaterThan(0);
			expect(result("capture").logicalBytes).toBeLessThanOrEqual(262_144);
			for (const label of ["prepare", "abort", "prepare-again", "commit", "future-round"])
				expect(result(label).ok).toBe(true);
			expect(result("fenced-vote").reason).toBe("RETIREMENT_FENCED");
			expect(result("fenced-round").reason).toBe("RETIREMENT_FENCED");
			expect(result("fenced-ack").threw).toContain("RETIREMENT_FENCED");
			expect(raw.images.refused).toEqual(raw.images.prepared);
			expect(result("retired-round").reason).toBe("SIGNING_RETIRED");
			expect(result("fenced-scope").reason).toBe("RETIREMENT_FENCED");
			expect(result("future-scope").ok).toBe(true);
			if (scenario === "lifecycle") {
				expect(result("old-round-scope").reason).toBe("SIGNING_RETIRED");
				expect(result("current-round-scope").ok).toBe(true);
			}
			expect(result("commit").control?.revision).toBe(4);
			expect(result("commit").control?.sequence).toBe(2);
			if (scenario === "holes") {
				expect(result("hole-round").ok).toBe(true);
				expect(result("reintroduce").reason).toBe("RETIRED_HOLE_REINTRODUCED");
				expect(result("valid-next").ok).toBe(true);
			}
		}
	});
}

test("R8 signing control prefix widths match original native metadata and drain transitions", async ({
	page,
}, info) => {
	await page.goto(server.origin);
	const raw = (await page.evaluate(({ name }) => window.signingParticipantRun(name, "prefix-widths"), {
		name: `signing-prefix-${crypto.randomUUID()}`,
	})) as {
		results: {
			primary?: string;
			widths: {
				checks: { label: string; actual: unknown; expected: unknown }[];
				unsupported: boolean;
				entryCount: number;
				summaryCount: number;
			};
		};
		events: { kind: string; id?: number }[];
	};
	await writeFile(info.outputPath("signing-prefix-widths.json"), JSON.stringify(raw), { flag: "wx" });
	expect(raw.results.primary).toBeUndefined();
	expect(raw.results.widths.entryCount).toBe(17);
	expect(raw.results.widths.summaryCount).toBe(1);
	expect(raw.results.widths.unsupported).toBe(true);
	expect(raw.results.widths.checks).toHaveLength(15);
	for (const check of raw.results.widths.checks) expect(check.actual, check.label).toEqual(check.expected);
	for (const event of raw.events.filter((item) => item.kind === "native-invoke"))
		expect(
			raw.events.filter((item) => item.id === event.id && ["native-complete", "native-abort"].includes(item.kind))
		).toHaveLength(1);
});
