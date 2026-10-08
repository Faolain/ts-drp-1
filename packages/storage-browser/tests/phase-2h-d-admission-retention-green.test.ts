import { describe, expect, it } from "vitest";

import protocolConfig from "../playwright.protocol-v2.config.js";
import { revalidateStoppedCleanupIdentities } from "./fixtures/phase-2e6-process-death-runner.js";
import { type ProcessIdentity, retainThenLocateBrowserRoot } from "./fixtures/process-forest.js";

const PROFILE = "/tmp/phase 2h/profile";
const CHROMIUM = "/opt/chromium/chrome";

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state: "S" });
}

describe("Phase 2h-d live admission retention", () => {
	it("bounds all fifteen serial tests without reviving the stale draft timeouts", () => {
		expect(protocolConfig.timeout).toBe(118_800);
		expect(protocolConfig.globalTimeout).toBe(118_800 * 15 + 60_000);
		expect(protocolConfig.timeout).not.toBe(300_000);
		expect(protocolConfig.globalTimeout).not.toBe(900_000);
	});

	it("retains the complete raw forest before browser-root classification rejects", () => {
		const forest = Object.freeze([
			identity(90, 1, 90, "node playwright-controller.js"),
			identity(100, 90, 100, "node phase-2e6-crash-child.js"),
			identity(200, 100, 200, `${CHROMIUM} --user-data-dir=${PROFILE}2`),
		]);
		const retained: Array<readonly ProcessIdentity[]> = [];
		expect(() =>
			retainThenLocateBrowserRoot(
				forest,
				100,
				PROFILE,
				{
					childRoot: forest[1] as ProcessIdentity,
					contentProcessClass: "chromium-renderer",
					controllerPgid: 90,
					executablePath: CHROMIUM,
					platform: "linux",
					profilePath: PROFILE,
					scope: "phase2h",
				},
				(capture) => retained.push(capture)
			)
		).toThrow("expected one browser root, observed 0");
		expect(retained).toEqual([forest]);
	});

	it("resumes a post-stop PID reuse and withholds negative-PGID authority", () => {
		const expected = identity(200, 100, 200, `${CHROMIUM} --user-data-dir=${PROFILE}`);
		const reused = Object.freeze({ ...expected, birthToken: "foreign-birth", pgid: 300 });
		const continued: number[] = [];
		const observed = revalidateStoppedCleanupIdentities([expected], [reused], (pid) => continued.push(pid));
		expect(continued).toEqual([200]);
		expect(observed.groups).toEqual([]);
		expect(observed.errors).toHaveLength(1);
		expect(observed.errors[0]).toMatchObject({
			message: "UNRESOLVED_CLEANUP_GROUP: identity changed for 200",
		});
	});
});
