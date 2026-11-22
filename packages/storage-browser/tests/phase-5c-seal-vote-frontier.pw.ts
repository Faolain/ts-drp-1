import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";
type Image = { version: number; rows: unknown[] };
type Outcome = {
	ok?: boolean;
	version?: number;
	reason?: string;
	rejected?: string;
	revision?: number;
	retiredBeforeRound?: number;
};
interface Observation {
	losses: Outcome[];
	result: Outcome;
	floor: Outcome;
	stale: Outcome;
	retained: Outcome;
	entered: Outcome;
	delayedVote: Outcome;
	delayedQc: Outcome;
	delayedRound: Outcome;
	restore: Outcome;
	delayedAck: Outcome;
	current: Outcome;
	debt: Outcome;
	advance: Outcome;
	future: Outcome;
	snapshot: Outcome;
	before: Image;
	after: Image;
	old: Image;
	refusedImage: Image;
	debtImage: Image;
	debtAfter: Image;
	versionChanged: boolean;
	oldHandleRefused: boolean;
	events: { ordinal: number; kind: string; id?: number }[];
}
let server: Phase4cBrowserServer;
test.beforeAll(async () => {
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(import.meta.dirname, "assets/phase-5c-signing-frontier-entry.ts"),
	});
});
test.afterAll(async () => server?.close());
for (const scenario of [
	"frontier",
	"summary-debt",
	"stale-cas",
	"migration",
	"forged-legacy",
	"stale-incarnation",
] as const) {
	test(`native signing frontier ${scenario}`, async ({ page }, info) => {
		await page.goto(server.origin);
		const r = (await page.evaluate(({ name, scenario }) => window.signingFrontierRun(name, scenario), {
			name: `frontier-${crypto.randomUUID()}`,
			scenario,
		})) as Observation;
		await info.attach("native-signing-frontier.json", {
			body: Buffer.from(JSON.stringify(r)),
			contentType: "application/json",
		});
		if (scenario === "stale-incarnation") {
			expect(r.losses).toHaveLength(4);
			for (const loss of r.losses) {
				expect(loss.ok).toBe(false);
				expect(loss.reason).toBe("STORAGE_LOSS");
				expect(loss.rejected).toBeUndefined();
			}
			expect(r.after).toEqual(r.before);
		} else if (scenario === "migration") {
			expect(r.result.version).toBe(5);
			expect(r.versionChanged).toBe(true);
			expect(r.oldHandleRefused).toBe(true);
			expect(r.after.rows).toEqual(r.before.rows);
		} else if (scenario === "forged-legacy") {
			expect(r.result.rejected).toBeDefined();
			expect(r.after).toEqual(r.before);
			expect(r.after.version).toBe(4);
		} else if (scenario === "summary-debt") {
			expect(r.retained.ok).toBe(true);
			expect(r.entered.ok).toBe(true);
			expect(r.result).toEqual({ ok: false, reason: "CURRENT_QC_PROTECTED" });
			expect(r.after).toEqual(r.before);
		} else if (scenario === "stale-cas") {
			expect(r.floor.ok).toBe(true);
			expect(r.stale).toEqual({ ok: false, reason: "REVALIDATION_REQUIRED" });
			expect(r.after).toEqual(r.before);
		} else {
			expect(r.floor).toEqual({ ok: true, revision: 2, retiredBeforeRound: 1 });
			for (const k of ["delayedVote", "delayedQc", "delayedRound", "restore"] as const)
				expect(r[k].reason).toBe("SIGNING_RETIRED");
			expect(r.delayedAck.rejected).toContain("SIGNING_RETIRED");
			expect(r.refusedImage).toEqual(r.old);
			expect(r.current.ok).toBe(true);
			expect(r.entered.ok).toBe(true);
			expect(r.debt).toEqual({ ok: false, reason: "PUBLICATION_DEBT_HELD" });
			expect(r.debtAfter).toEqual(r.debtImage);
			expect(r.advance).toEqual({ ok: true, revision: 5, retiredBeforeRound: 2 });
			expect(r.future.ok).toBe(true);
			expect(r.snapshot.retiredBeforeRound).toBe(2);
			expect(r.snapshot.revision).toBe(5);
		}
		const events = r.events;
		expect(events.every((e, i) => e.ordinal === i + 1)).toBe(true);
		// Every observed native transaction reaches exactly one native terminal.
		// This census does not establish public-delivery ordering or full refinement.
		for (const e of events.filter((e) => e.kind === "native-invoke"))
			expect(events.filter((t) => t.id === e.id && ["native-complete", "native-abort"].includes(t.kind))).toHaveLength(
				1
			);
	});
}
