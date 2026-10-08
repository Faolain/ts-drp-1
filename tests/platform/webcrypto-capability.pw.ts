import { devices, expect, test } from "@playwright/test";
import playwrightPackage from "@playwright/test/package.json" with { type: "json" };
import os from "node:os";
import path from "node:path";

import {
	type Phase2jProbe,
	phase2jProbeDescriptor,
	phase2jProjectDescriptor,
	type Phase2jProjectId,
	type Phase2jPublicationLayout,
	type Phase2jRecord,
	PHASE_2J_PROBE_IDS,
	PHASE_2J_PROJECT_IDS,
	publishPhase2jRecord,
} from "./fixtures/phase-2j-webcrypto-evidence.js";

/**
 * Standing, fail-on-any-change WebCrypto evidence.
 *
 * The mobile rows are desktop Playwright engines using iPhone 15 and Pixel 7
 * descriptors. They are engine-regression proxies, never physical-device proof.
 * P-256 is measured but remains reserved; this test does not activate a suite.
 */

function requiredEnvironment(name: "PHASE_2J_GIT_SHA" | "PHASE_2J_RUN_ID" | "PHASE_2J_RUN_ROOT"): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} was not established by global setup`);
	return value;
}

function currentLayout(): Phase2jPublicationLayout {
	const outputBase = path.resolve("test-results/phase-2j");
	return Object.freeze({
		aggregatePath: path.join(outputBase, "webcrypto-capability-matrix.json"),
		gitSha: requiredEnvironment("PHASE_2J_GIT_SHA"),
		outputBase,
		runId: requiredEnvironment("PHASE_2J_RUN_ID"),
		runRoot: requiredEnvironment("PHASE_2J_RUN_ROOT"),
	});
}

function currentProjectId(value: string): Phase2jProjectId {
	if (!(PHASE_2J_PROJECT_IDS as readonly string[]).includes(value))
		throw new TypeError(`untrusted Phase 2j project: ${value}`);
	return value as Phase2jProjectId;
}

test("observes, publishes and asserts the reviewed WebCrypto matrix", async ({ browser, browserName, page }) => {
	await page.route("**/*", (route) =>
		route.fulfill({ body: "<!doctype html><title>capability</title>", contentType: "text/html", status: 200 })
	);
	await page.goto("https://platform-capability.invalid/");

	const observed = await page.evaluate(async () => {
		const inputs = [
			{ algorithmName: "Ed25519", namedCurve: null, probeId: "ed25519" },
			{ algorithmName: "ECDSA", namedCurve: "P-256", probeId: "ecdsa-p256" },
			{ algorithmName: "ECDSA", namedCurve: "K-256", probeId: "ecdsa-k256" },
		] as const;
		const probes: Array<{
			algorithmName: "ECDSA" | "Ed25519";
			exceptionName: null | string;
			failureKind: "not-supported" | "probe-error" | null;
			namedCurve: "K-256" | "P-256" | null;
			observedOutcome: "extractable" | "non-extractable" | "probe-error" | "unsupported";
			operation: "generateKey";
			probeId: "ecdsa-k256" | "ecdsa-p256" | "ed25519";
			requestedExtractable: false;
			requestedUsages: readonly ["sign", "verify"];
		}> = [];
		for (const input of inputs) {
			const algorithm: EcKeyGenParams | Algorithm =
				input.namedCurve === null
					? { name: input.algorithmName }
					: { name: input.algorithmName, namedCurve: input.namedCurve };
			let observation: Pick<(typeof probes)[number], "exceptionName" | "failureKind" | "observedOutcome">;
			try {
				if (globalThis.crypto?.subtle === undefined) throw new TypeError("SubtleCrypto unavailable");
				const pair = (await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"])) as CryptoKeyPair;
				if (typeof pair?.privateKey?.extractable !== "boolean") throw new TypeError("malformed key pair");
				observation = {
					exceptionName: null,
					failureKind: null,
					observedOutcome: pair.privateKey.extractable ? "extractable" : "non-extractable",
				};
			} catch (error) {
				const unsupported = error instanceof DOMException && error.name === "NotSupportedError";
				const exceptionName =
					typeof error === "object" &&
					error !== null &&
					"name" in error &&
					typeof error.name === "string" &&
					error.name.length > 0 &&
					error.name.length <= 256
						? error.name
						: null;
				observation = unsupported
					? {
							exceptionName: "NotSupportedError",
							failureKind: "not-supported",
							observedOutcome: "unsupported",
						}
					: { exceptionName, failureKind: "probe-error", observedOutcome: "probe-error" };
			}
			probes.push({
				...input,
				...observation,
				operation: "generateKey",
				requestedExtractable: false,
				requestedUsages: ["sign", "verify"],
			});
		}
		return Object.freeze({
			isSecureContext: globalThis.isSecureContext,
			probes,
			userAgent: navigator.userAgent,
		});
	});

	const projectId = currentProjectId(test.info().project.name);
	const descriptor = phase2jProjectDescriptor(projectId);
	const platform = os.platform();
	const arch = os.arch();
	if (!(platform === "darwin" || platform === "linux") || !(arch === "arm64" || arch === "x64"))
		throw new TypeError(`unsupported Phase 2j host: ${platform}/${arch}`);
	const probes = observed.probes as readonly Phase2jProbe[];
	const changed = probes.some(
		(probe, index) =>
			probe.observedOutcome !== phase2jProbeDescriptor(PHASE_2J_PROBE_IDS[index] ?? "ed25519").expectedOutcome
	);
	const record: Phase2jRecord = Object.freeze({
		artifactKind: "ts-drp/webcrypto-capability-record/v1",
		device: Object.freeze({
			emulated: descriptor.emulated,
			profile: descriptor.profile,
			profileUserAgentMatch: observed.userAgent === devices[descriptor.profile].userAgent,
			realDevice: false,
		}),
		engine: Object.freeze({
			brand: descriptor.brand,
			browserVersion: browser.version(),
			name: browserName,
			playwrightVersion: playwrightPackage.version,
		}),
		evidenceClass: descriptor.evidenceClass,
		gitSha: requiredEnvironment("PHASE_2J_GIT_SHA"),
		os: Object.freeze({ arch, platform, release: os.release() }),
		probes,
		projectId,
		runId: requiredEnvironment("PHASE_2J_RUN_ID"),
		schemaVersion: 1,
		verdict: changed ? "fail" : "pass",
	});

	publishPhase2jRecord(currentLayout(), projectId, record);
	test.info().annotations.push({ description: browser.version(), type: `engine-build:${projectId}` });
	expect(observed.isSecureContext, `${projectId} did not run in a secure context`).toBe(true);
	expect(
		record.verdict,
		`WebCrypto support changed on ${projectId}; preserve this observation and re-review before changing expectations.`
	).toBe("pass");
});
