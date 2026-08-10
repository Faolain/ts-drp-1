import type { PlaywrightTestConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import protocolConfig from "../playwright.protocol-v2.config.js";
import { declaredPhase2gObservations, derivePhase2gQuotaEdges } from "./fixtures/phase-2g-c-quota-fault-contract.js";
import { PHASE_2H_TUPLES } from "./fixtures/phase-2h-a-registry.js";

const REPRESENTATIVE_EDGE_ID = "swap-head-certificate-match/request-05-put-objects/settlement";
const packageDirectory = path.resolve(import.meta.dirname, "..");

describe("Phase 2h-c bounded capacity/quota producer census", () => {
	it("discovers the accepted browser surfaces before exactly two new scenarios", () => {
		expect(protocolConfig.testMatch).toEqual([
			"phase-2h-b-browser-surfaces-red.pw.ts",
			"phase-2h-c-capacity-quota-red.pw.ts",
			"phase-2h-d-process-death-red.pw.ts",
		]);
		expect(protocolConfig.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		expect(protocolConfig.fullyParallel).toBe(false);
		expect(protocolConfig.workers).toBe(1);
		expect(protocolConfig.retries).toBe(0);
		expect(protocolConfig.use?.trace).toBe("retain-on-failure");
	});

	it("projects exactly six capacity/quota tuple IDs from the closed 69-tuple registry", () => {
		expect(PHASE_2H_TUPLES).toHaveLength(69);
		expect(
			PHASE_2H_TUPLES.filter(({ scenario }) => scenario === "capacity" || scenario === "quota-fault").map(
				({ tupleId }) => tupleId
			)
		).toEqual([
			"capacity/chromium",
			"capacity/firefox",
			"capacity/webkit",
			"quota-fault/chromium",
			"quota-fault/firefox",
			"quota-fault/webkit",
		]);
	});

	it("selects one exact settlement edge without weakening the accepted 35-case matrix", () => {
		const edges = derivePhase2gQuotaEdges(declaredPhase2gObservations());
		expect(edges).toHaveLength(35);
		expect(edges.filter(({ id }) => id === REPRESENTATIVE_EDGE_ID)).toEqual([
			{
				id: REPRESENTATIVE_EDGE_ID,
				requestIndex: 5,
				scenarioId: "swap-head-certificate-match",
				target: "settlement",
			},
		]);
	});

	it("preserves capacity cross-engine evidence and genuine quota control as Chromium-only evidence", async () => {
		const loadConfig = async (name: string): Promise<PlaywrightTestConfig> => {
			const loaded = (await import(pathToFileURL(path.join(packageDirectory, name)).href)) as Readonly<{
				default: PlaywrightTestConfig;
			}>;
			return loaded.default;
		};
		const phase2gCapacityConfig = await loadConfig("playwright.phase-2g-a-capacity.config.ts");
		const phase2gQuotaConfig = await loadConfig("playwright.phase-2g-c-quota-fault.config.ts");
		expect(phase2gCapacityConfig.projects?.map(({ name }) => name)).toEqual(["chromium", "firefox", "webkit"]);
		expect(phase2gQuotaConfig.projects?.map(({ name }) => name)).toEqual(["chromium"]);
		expect(phase2gQuotaConfig.testMatch).toBe("phase-2g-c-quota-fault-red.pw.ts");
		expect(fs.existsSync(path.join(packageDirectory, "playwright.phase-2g-a-capacity.config.ts"))).toBe(true);
		expect(fs.existsSync(path.join(packageDirectory, "playwright.phase-2g-c-quota-fault.config.ts"))).toBe(true);
	});
});
