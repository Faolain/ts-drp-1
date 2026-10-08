import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	type freezeCurrentOwnedUnion,
	locateBrowserRoot,
	parseProcessForest,
	type ProcessIdentity,
	validateTwoGroupForest,
} from "./fixtures/process-forest.js";

type CampaignPlatform = "darwin" | "linux";
type CampaignScope = "phase2e6" | "phase2h";
type ContentClass = "chromium-renderer" | "firefox-contentproc" | "webkit-webcontent";

interface CorrectiveCampaignAuthority {
	readonly browserRoot: ProcessIdentity;
	readonly childRoot: ProcessIdentity;
	readonly contentProcessClass: ContentClass;
	readonly controllerPgid: number;
	readonly executablePath: string;
	readonly platform: CampaignPlatform;
	readonly profilePath: string;
	readonly scope: CampaignScope;
}

interface NativeAdmissionDependencies {
	arm(): void;
	readonly authority: CorrectiveCampaignAuthority;
	captureForest(): readonly ProcessIdentity[];
	constructRecord(): void;
	readonly native: Readonly<{ arch: "x64"; platform: CampaignPlatform }>;
	publish(): void;
	recover(): void;
	retainCapture(forest: readonly ProcessIdentity[]): void;
	signalGroup(pgid: number): void;
}

type NativeAdmissionProducer = (dependencies: NativeAdmissionDependencies) => Promise<void>;
type IsAny<T> = 0 extends 1 & T ? true : false;

type CorrectiveForestValidator = (
	forest: readonly ProcessIdentity[],
	childPid: number,
	browserPid: number,
	authority: CorrectiveCampaignAuthority
) => ReturnType<typeof validateTwoGroupForest>;

type CorrectiveRootLocator = (
	forest: readonly ProcessIdentity[],
	childPid: number,
	profilePath: string,
	authority: Omit<CorrectiveCampaignAuthority, "browserRoot">
) => ProcessIdentity;

type ClassifierAuthorityIsMandatory = CorrectiveForestValidator extends typeof validateTwoGroupForest ? true : false;
type RootLocatorAuthorityIsMandatory = CorrectiveRootLocator extends typeof locateBrowserRoot ? true : false;
type FreezeAuthorityIsMandatory = Parameters<typeof freezeCurrentOwnedUnion>[1] extends CorrectiveCampaignAuthority
	? true
	: false;

function identity(pid: number, ppid: number, pgid: number, command: string): ProcessIdentity {
	return Object.freeze({ birthToken: `birth-${pid}`, command, pgid, pid, ppid, state: "T" });
}

function trapOfflineLookups(action: () => void): readonly string[] {
	const calls: string[] = [];
	const originals: Array<Readonly<{ descriptor: PropertyDescriptor; key: PropertyKey; owner: object }>> = [];
	const instrument = (owner: object, prefix: string): void => {
		for (const key of Reflect.ownKeys(owner)) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key);
			if (descriptor?.configurable !== true || typeof descriptor.value !== "function") continue;
			originals.push({ descriptor, key, owner });
			Object.defineProperty(owner, key, {
				...descriptor,
				value: (..._args: readonly unknown[]): never => {
					const label = `${prefix}${String(key)}`;
					calls.push(label);
					throw new TypeError(`offline replay performed ${label}`);
				},
			});
		}
	};
	const promises = fs.promises;
	try {
		instrument(promises, "fs.promises.");
		instrument(fs, "fs.");
		instrument(childProcess, "child_process.");
		syncBuiltinESMExports();
		action();
	} finally {
		for (const { descriptor, key, owner } of originals.reverse()) Object.defineProperty(owner, key, descriptor);
		syncBuiltinESMExports();
	}
	return Object.freeze(calls);
}

function authority(
	forest: readonly ProcessIdentity[],
	options: Omit<CorrectiveCampaignAuthority, "browserRoot" | "childRoot">
): CorrectiveCampaignAuthority {
	return authorityForRoots(forest, 100, 200, options);
}

function authorityForRoots(
	forest: readonly ProcessIdentity[],
	childPid: number,
	browserPid: number,
	options: Omit<CorrectiveCampaignAuthority, "browserRoot" | "childRoot">
): CorrectiveCampaignAuthority {
	const childRoot = forest.find(({ pid }) => pid === childPid);
	const browserRoot = forest.find(({ pid }) => pid === browserPid);
	if (childRoot === undefined || browserRoot === undefined) throw new TypeError("control roots are absent");
	return Object.freeze({ ...options, browserRoot, childRoot });
}

function validateCampaignForest(
	forest: readonly ProcessIdentity[],
	campaign: CorrectiveCampaignAuthority
): ReturnType<typeof validateTwoGroupForest> {
	return Reflect.apply(validateTwoGroupForest, undefined, [
		forest,
		campaign.childRoot.pid,
		campaign.browserRoot.pid,
		campaign,
	]) as ReturnType<typeof validateTwoGroupForest>;
}

function locateCampaignBrowserRoot(
	forest: readonly ProcessIdentity[],
	campaign: CorrectiveCampaignAuthority
): ProcessIdentity {
	return Reflect.apply(locateBrowserRoot, undefined, [
		forest,
		campaign.childRoot.pid,
		campaign.profilePath,
		campaign,
	]) as ProcessIdentity;
}

const PROFILE = "/tmp/phase 2h/profile";
const DARWIN_PROFILE = "/private/tmp/phase 2h/profile";
const CHROMIUM = "/opt/playwright/chromium/chrome";
const FIREFOX = "/opt/playwright/firefox/firefox";
const DARWIN_FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const WEBKIT_SCRIPT = "/ms-playwright/webkit-2311/pw_run.sh";
const CONTROLLER_PID = 90;
const CONTROLLER_PGID = 80;

function linuxChromium(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `${CHROMIUM} --user-data-dir=${PROFILE}`),
		identity(201, 200, 200, `${CHROMIUM} --type=zygote --user-data-dir=${PROFILE}`),
		identity(202, 201, 200, `${CHROMIUM} --type=renderer --user-data-dir=${PROFILE}`),
	]);
}

function linuxFirefox(role = "2 tab"): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `${FIREFOX} -profile ${PROFILE} -no-remote`),
		identity(201, 200, 200, `${FIREFOX} -contentproc -parentPid 200 1 forkserver`),
		identity(202, 201, 200, `${FIREFOX} -contentproc -parentPid 200 ${role}`),
	]);
}

function linuxWebKit(script = WEBKIT_SCRIPT): readonly ProcessIdentity[] {
	const installation = path.posix.dirname(script);
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `bash ${script} --user-data-dir=${PROFILE}`),
		identity(201, 200, 200, `${installation}/minibrowser-wpe/bin/MiniBrowser --user-data-dir=${PROFILE}`),
		identity(202, 201, 200, `${installation}/minibrowser-wpe/bin/WPEWebProcess`),
	]);
}

function darwinPhase2hChromium(): readonly ProcessIdentity[] {
	const executable = "/Applications/Chromium.app/Contents/MacOS/Chromium";
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `${executable} --user-data-dir=${DARWIN_PROFILE}`),
		identity(
			201,
			200,
			200,
			`/Applications/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/153.0.0.0/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer) --type=renderer --user-data-dir=${DARWIN_PROFILE}`
		),
	]);
}

function darwinPhase2hFirefox(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `${DARWIN_FIREFOX} -profile ${DARWIN_PROFILE}`),
		identity(201, 200, 200, "/Applications/Firefox.app/Contents/MacOS/plugin-container -parentPid 200"),
	]);
}

function darwinPhase2hWebKit(): readonly ProcessIdentity[] {
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `bash ${WEBKIT_SCRIPT} --user-data-dir=${DARWIN_PROFILE}`),
		identity(
			201,
			1,
			201,
			"/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent"
		),
	]);
}

function darwinPhase2e6Chromium(profilePath = DARWIN_PROFILE): readonly ProcessIdentity[] {
	const executable = "/Applications/Chromium.app/Contents/MacOS/Chromium";
	const helper =
		"/Applications/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/153.0.0.0/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer)";
	return Object.freeze([
		identity(CONTROLLER_PID, 1, CONTROLLER_PGID, "node test-controller.js"),
		identity(100, CONTROLLER_PID, 100, "node isolated-child.js"),
		identity(200, 100, 200, `${executable} --user-data-dir=${profilePath}`),
		identity(201, 200, 200, `${helper} --type=renderer --user-data-dir=${profilePath}`),
	]);
}

function campaignFor(
	forest: readonly ProcessIdentity[],
	contentProcessClass: ContentClass,
	executablePath: string,
	platform: CampaignPlatform = "linux",
	scope: CampaignScope = "phase2h",
	profilePath = PROFILE
): CorrectiveCampaignAuthority {
	return authority(forest, {
		contentProcessClass,
		controllerPgid: CONTROLLER_PGID,
		executablePath,
		platform,
		profilePath,
		scope,
	});
}

const VALID_FOREST = [
	" 410 100 410 Fri Aug  7 16:00:00 2026 T node crash-child.js",
	` 420 410 420 Fri Aug  7 16:00:01 2026 T ${CHROMIUM} --user-data-dir=${PROFILE}`,
	` 421 420 420 Fri Aug  7 16:00:02 2026 T ${CHROMIUM} --type=zygote --user-data-dir=${PROFILE}`,
	` 422 421 420 Fri Aug  7 16:00:03 2026 T ${CHROMIUM} --type=renderer --user-data-dir=${PROFILE}`,
].join("\n");

function phase2bAuthority(forest: readonly ProcessIdentity[]): CorrectiveCampaignAuthority {
	return authorityForRoots(forest, 410, 420, {
		contentProcessClass: "chromium-renderer",
		controllerPgid: 100,
		executablePath: CHROMIUM,
		platform: "linux",
		profilePath: PROFILE,
		scope: "phase2h",
	});
}

describe("Phase 2b synthetic process-forest controls", () => {
	it("parses the exact C-locale process form and proves two groups", () => {
		const forest = parseProcessForest(VALID_FOREST);
		expect(validateCampaignForest(forest, phase2bAuthority(forest))).toEqual({
			childPgid: 410,
			browserPgid: 420,
			ownedPids: [410, 420, 421, 422],
		});
	});

	it("accepts a Linux renderer reached transitively through a same-browser-group zygote", () => {
		const forest = parseProcessForest(VALID_FOREST);
		expect(validateCampaignForest(forest, phase2bAuthority(forest))).toEqual({
			childPgid: 410,
			browserPgid: 420,
			ownedPids: [410, 420, 421, 422],
		});
	});

	it("rejects malformed, ambiguous, and unsafe renderer topologies", () => {
		expect(() => parseProcessForest("410 100 nope malformed")).toThrow("malformed process line");
		const oneGroup = parseProcessForest(
			[
				" 410 100 410 Fri Aug  7 16:00:00 2026 T node crash-child.js",
				" 420 410 410 Fri Aug  7 16:00:01 2026 T chromium --browser",
				" 421 420 410 Fri Aug  7 16:00:02 2026 T chromium --type=renderer",
			].join("\n")
		);
		expect(() => validateCampaignForest(oneGroup, phase2bAuthority(oneGroup))).toThrow("two distinct process groups");
		const rendererFree = parseProcessForest(VALID_FOREST.replace("--type=renderer", "--type=gpu-process"));
		expect(() => validateCampaignForest(rendererFree, phase2bAuthority(rendererFree))).toThrow("renderer");
		const crossGroupRenderer = parseProcessForest(VALID_FOREST.replace(" 422 421 420 ", " 422 421 430 "));
		expect(() => validateCampaignForest(crossGroupRenderer, phase2bAuthority(crossGroupRenderer))).toThrow("renderer");
		const brokenRendererAncestry = parseProcessForest(VALID_FOREST.replace(" 422 421 420 ", " 422 999 420 "));
		expect(() => validateCampaignForest(brokenRendererAncestry, phase2bAuthority(brokenRendererAncestry))).toThrow(
			"renderer"
		);
		const ambiguous = parseProcessForest(`${VALID_FOREST}\n 421 420 420 Fri Aug  7 16:00:02 2026 T chromium duplicate`);
		expect(() => validateCampaignForest(ambiguous, phase2bAuthority(ambiguous))).toThrow("ambiguous");
	});
});

describe("Phase 2h-d corrective host/content authority", () => {
	it("RED(implicit classifier/freeze defaults -> explicit compile-time campaign authority): makes all fields mandatory", () => {
		const classifierAuthorityIsMandatory: ClassifierAuthorityIsMandatory = true;
		const freezeAuthorityIsMandatory: FreezeAuthorityIsMandatory = true;
		const rootLocatorAuthorityIsMandatory: RootLocatorAuthorityIsMandatory = true;
		expect(classifierAuthorityIsMandatory).toBe(true);
		expect(freezeAuthorityIsMandatory).toBe(true);
		expect(rootLocatorAuthorityIsMandatory).toBe(true);
	});

	it.each([
		["Chromium", linuxChromium(), "chromium-renderer", CHROMIUM],
		["Firefox", linuxFirefox(), "firefox-contentproc", FIREFOX],
		["WebKit", linuxWebKit(), "webkit-webcontent", WEBKIT_SCRIPT],
	] as const)(
		"RED(baseline broad Chromium only -> current exact Linux classifiers): accepts native %s",
		(_engine, forest, contentClass, executable) => {
			expect(() => validateCampaignForest(forest, campaignFor(forest, contentClass, executable))).not.toThrow();
		}
	);

	it("RED(baseline broad role substring -> current exact executable/profile/role): rejects symmetric engine boundary mutants", () => {
		const control = linuxChromium();
		const chromiumMutants = [
			control.map((row) =>
				row.pid === 200 ? { ...row, command: row.command.replace(CHROMIUM, `${CHROMIUM}2`) } : row
			),
			control.map((row) => (row.pid === 200 ? { ...row, command: row.command.replace(PROFILE, `${PROFILE}2`) } : row)),
			control.map((row) => (row.pid === 200 ? { ...row, ppid: CONTROLLER_PID } : row)),
			control.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace(CHROMIUM, `${CHROMIUM}2`) } : row
			),
			control.map((row) => (row.pid === 201 ? { ...row, command: row.command.replace(PROFILE, `${PROFILE}2`) } : row)),
			control.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("--type=zygote", "--type=zygote-helper") } : row
			),
			control.map((row) => (row.pid === 201 ? { ...row, ppid: 100 } : row)),
			control.map((row) => (row.pid === 201 ? { ...row, pgid: 999 } : row)),
			control.map((row) =>
				row.pid === 202 ? { ...row, command: row.command.replace(CHROMIUM, `${CHROMIUM}2`) } : row
			),
			control.map((row) => (row.pid === 202 ? { ...row, command: row.command.replace(PROFILE, `${PROFILE}2`) } : row)),
			control.map((row) =>
				row.pid === 202 ? { ...row, command: row.command.replace("--type=renderer", "--type=renderer-helper") } : row
			),
			control.map((row) =>
				row.pid === 202
					? { ...row, command: row.command.replace("--type=renderer", "--type=gpu-process renderer") }
					: row
			),
			control.map((row) => (row.pid === 202 ? { ...row, ppid: 200 } : row)),
			control.map((row) => (row.pid === 202 ? { ...row, ppid: 999 } : row)),
			control.map((row) => (row.pid === 202 ? { ...row, pgid: 999 } : row)),
		];
		for (const mutant of chromiumMutants)
			expect.soft(() => validateCampaignForest(mutant, campaignFor(mutant, "chromium-renderer", CHROMIUM))).toThrow();

		const firefox = linuxFirefox();
		const firefoxMutants = [
			firefox.map((row) => (row.pid === 200 ? { ...row, command: row.command.replace(FIREFOX, `${FIREFOX}2`) } : row)),
			firefox.map((row) => (row.pid === 200 ? { ...row, command: row.command.replace(PROFILE, `${PROFILE}2`) } : row)),
			firefox.map((row) => (row.pid === 200 ? { ...row, ppid: CONTROLLER_PID } : row)),
			firefox.map((row) => (row.pid === 201 ? { ...row, command: row.command.replace(FIREFOX, `${FIREFOX}2`) } : row)),
			firefox.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("-parentPid 200", "-parentPid 999") } : row
			),
			firefox.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("1 forkserver", "1 forkserver-helper") } : row
			),
			firefox.map((row) => (row.pid === 201 ? { ...row, ppid: 100 } : row)),
			firefox.map((row) => (row.pid === 201 ? { ...row, pgid: 999 } : row)),
			firefox.map((row) => (row.pid === 202 ? { ...row, command: row.command.replace(FIREFOX, `${FIREFOX}2`) } : row)),
			firefox.map((row) =>
				row.pid === 202 ? { ...row, command: row.command.replace("-contentproc", "-contentproc-extra") } : row
			),
			firefox.map((row) => (row.pid === 202 ? { ...row, ppid: 200 } : row)),
			firefox.map((row) => (row.pid === 202 ? { ...row, ppid: 999 } : row)),
			firefox.map((row) => (row.pid === 202 ? { ...row, pgid: 999 } : row)),
		];
		for (const mutant of firefoxMutants)
			expect.soft(() => validateCampaignForest(mutant, campaignFor(mutant, "firefox-contentproc", FIREFOX))).toThrow();
		expect.soft(() => validateCampaignForest(firefox, campaignFor(firefox, "chromium-renderer", FIREFOX))).toThrow();

		const webkit = linuxWebKit();
		const webkitMutants = [
			webkit.map((row) =>
				row.pid === 200 ? { ...row, command: row.command.replace(WEBKIT_SCRIPT, `${WEBKIT_SCRIPT}2`) } : row
			),
			webkit.map((row) => (row.pid === 200 ? { ...row, command: row.command.replace(PROFILE, `${PROFILE}2`) } : row)),
			webkit.map((row) => (row.pid === 200 ? { ...row, ppid: CONTROLLER_PID } : row)),
			webkit.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("webkit-2311", "webkit-2312") } : row
			),
			webkit.map((row) => (row.pid === 201 ? { ...row, command: row.command.replace(PROFILE, `${PROFILE}2`) } : row)),
			webkit.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("/MiniBrowser", "/MiniBrowser-helper") } : row
			),
			webkit.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("/MiniBrowser", "/NotMiniBrowser") } : row
			),
			webkit.map((row) => (row.pid === 201 ? { ...row, ppid: 100 } : row)),
			webkit.map((row) => (row.pid === 201 ? { ...row, pgid: 999 } : row)),
			webkit.map((row) =>
				row.pid === 202 ? { ...row, command: row.command.replace("webkit-2311", "webkit-2312") } : row
			),
			webkit.map((row) =>
				row.pid === 202 ? { ...row, command: row.command.replace("/WPEWebProcess", "/WPEWebProcess-helper") } : row
			),
			webkit.map((row) =>
				row.pid === 202 ? { ...row, command: row.command.replace("/WPEWebProcess", "/NotWPEWebProcess") } : row
			),
			webkit.map((row) => (row.pid === 202 ? { ...row, ppid: 200 } : row)),
			webkit.map((row) => (row.pid === 202 ? { ...row, pgid: 999 } : row)),
		];
		for (const mutant of webkitMutants)
			expect
				.soft(() => validateCampaignForest(mutant, campaignFor(mutant, "webkit-webcontent", WEBKIT_SCRIPT)))
				.toThrow();
		expect
			.soft(() => validateCampaignForest(webkit, campaignFor(webkit, "firefox-contentproc", WEBKIT_SCRIPT)))
			.toThrow();
	});

	it("RED(baseline substring profile/PID -> current exact boundaries): rejects <p>2 and 12 versus 127", () => {
		const profileCollision = linuxChromium().map((row) => ({
			...row,
			command: row.pid >= 200 ? row.command.replaceAll(PROFILE, `${PROFILE}2`) : row.command,
		}));
		expect(() =>
			validateCampaignForest(profileCollision, campaignFor(profileCollision, "chromium-renderer", CHROMIUM))
		).toThrow();

		const firefox = linuxFirefox().map((row) =>
			row.pid === 202 ? { ...row, command: row.command.replace("-parentPid 200", "-parentPid 2007") } : row
		);
		expect(() => validateCampaignForest(firefox, campaignFor(firefox, "firefox-contentproc", FIREFOX))).toThrow();

		const directBoundary = [
			identity(10, 1, 10, "node controller.js"),
			identity(100, 10, 100, "node isolated-child.js"),
			identity(12, 100, 12, `${FIREFOX} -profile ${PROFILE}`),
			identity(13, 12, 12, `${FIREFOX} -contentproc -parentPid 127 2 tab`),
		];
		const directAuthority: CorrectiveCampaignAuthority = {
			browserRoot: directBoundary[2] as ProcessIdentity,
			childRoot: directBoundary[1] as ProcessIdentity,
			contentProcessClass: "firefox-contentproc",
			controllerPgid: 10,
			executablePath: FIREFOX,
			platform: "linux",
			profilePath: PROFILE,
			scope: "phase2h",
		};
		expect(() => validateCampaignForest(directBoundary, directAuthority)).toThrow();
	});

	it.each(["socket", "rdd", "utility"])("Firefox %s stays invalid when only the terminal role differs", (role) => {
		const forest = linuxFirefox(`2 ${role}`);
		expect(() => validateCampaignForest(forest, campaignFor(forest, "firefox-contentproc", FIREFOX))).toThrow();
	});

	it.each(["0 tab", "+2 tab", "02 tab", "2.0 tab", "2e0 tab", "9007199254740992 tab", "2 tab trailing"])(
		"Firefox rejects noncanonical terminal ordinal/role %s",
		(role) => {
			const forest = linuxFirefox(role);
			expect(() => validateCampaignForest(forest, campaignFor(forest, "firefox-contentproc", FIREFOX))).toThrow();
		}
	);

	it("RED(baseline controller-unaware -> current three-root authority): excludes controller PGID for every engine", () => {
		const controls = [
			[linuxChromium(), "chromium-renderer", CHROMIUM],
			[linuxFirefox(), "firefox-contentproc", FIREFOX],
			[linuxWebKit(), "webkit-webcontent", WEBKIT_SCRIPT],
		] as const;
		for (const [forest, contentClass, executable] of controls) {
			const overlapping = { ...campaignFor(forest, contentClass, executable), controllerPgid: 100 };
			expect.soft(() => validateCampaignForest(forest, overlapping)).toThrow();
		}
	});

	it("RED(baseline broad regex -> current Phase 2h Linux-only): rejects all measured Darwin host shapes", () => {
		const app = "/Applications/Chromium.app/Contents/MacOS/Chromium";
		for (const [forest, contentClass, executable] of [
			[darwinPhase2hChromium(), "chromium-renderer", app],
			[darwinPhase2hFirefox(), "firefox-contentproc", DARWIN_FIREFOX],
			[darwinPhase2hWebKit(), "webkit-webcontent", WEBKIT_SCRIPT],
		] as const) {
			expect
				.soft(() =>
					validateCampaignForest(
						forest,
						campaignFor(forest, contentClass, executable, "darwin", "phase2h", DARWIN_PROFILE)
					)
				)
				.toThrow();
		}
	});

	it("RED(baseline no Darwin authority -> current scoped Phase 2e6): accepts exact direct Renderer-helper only", () => {
		const app = "/Applications/Chromium.app/Contents/MacOS/Chromium";
		const helper =
			"/Applications/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/153.0.0.0/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer)";
		const control = darwinPhase2e6Chromium();
		expect(() =>
			validateCampaignForest(
				control,
				campaignFor(control, "chromium-renderer", app, "darwin", "phase2e6", DARWIN_PROFILE)
			)
		).not.toThrow();
		const mutants = [
			[
				...control.map((row) =>
					row.pid === 201 ? { ...row, command: row.command.replace("Versions/153.0.0.0", "Versions/A") } : row
				),
				identity(
					301,
					1,
					301,
					`${helper.replace("153.0.0.0", "152.0.0.0")} --type=renderer --user-data-dir=${DARWIN_PROFILE}`
				),
			],
			control.map((row) => (row.pid === 201 ? { ...row, ppid: 202 } : row)),
			[
				...control.map((row) => (row.pid === 201 ? { ...row, ppid: 202 } : row)),
				identity(202, 200, 200, `${app} --type=zygote`),
			],
			control.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("Helper (Renderer)", "Helper (GPU)") } : row
			),
			control.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace("--type=renderer", "--type=utility") } : row
			),
			control.map((row) =>
				row.pid === 201
					? { ...row, command: row.command.replace("/Applications/Chromium.app", "/Applications/Other.app") }
					: row
			),
			control.map((row) =>
				row.pid === 201 ? { ...row, command: `${app} --type=renderer --user-data-dir=${DARWIN_PROFILE}` } : row
			),
			control.map((row) =>
				row.pid === 201 ? { ...row, command: row.command.replace(DARWIN_PROFILE, `${DARWIN_PROFILE}2`) } : row
			),
			control.map((row) => (row.pid === 201 ? { ...row, pgid: 999 } : row)),
			control.map((row) =>
				row.pid === 200
					? { ...row, command: row.command.replace(app, "/Applications/Other.app/Contents/MacOS/Other") }
					: row
			),
			control.map((row) =>
				row.pid === 200 ? { ...row, command: row.command.replace(DARWIN_PROFILE, `${DARWIN_PROFILE}2`) } : row
			),
			control.map((row) => (row.pid === 200 ? { ...row, ppid: CONTROLLER_PID } : row)),
		];
		for (const mutant of mutants)
			expect
				.soft(() =>
					validateCampaignForest(
						mutant,
						campaignFor(mutant, "chromium-renderer", app, "darwin", "phase2e6", DARWIN_PROFILE)
					)
				)
				.toThrow();
		const overlapping = {
			...campaignFor(control, "chromium-renderer", app, "darwin", "phase2e6", DARWIN_PROFILE),
			controllerPgid: 100,
		};
		expect(() => validateCampaignForest(control, overlapping)).toThrow();
	});

	it("RED(baseline substring root locator -> current exact path/profile boundaries): locates no prefix collision", () => {
		const executableCollision = linuxChromium().map((row) =>
			row.pid === 200 ? { ...row, command: `${CHROMIUM}2 --user-data-dir=${PROFILE}` } : row
		);
		const profileCollision = linuxChromium().map((row) =>
			row.pid === 200 ? { ...row, command: `${CHROMIUM} --user-data-dir=${PROFILE}2` } : row
		);
		expect
			.soft(() =>
				locateCampaignBrowserRoot(executableCollision, campaignFor(executableCollision, "chromium-renderer", CHROMIUM))
			)
			.toThrow();
		expect
			.soft(() =>
				locateCampaignBrowserRoot(profileCollision, campaignFor(profileCollision, "chromium-renderer", CHROMIUM))
			)
			.toThrow();
	});

	it("RED(baseline host/emulation-blind -> current admission): producer retains every contradiction and aborts before side effects", async () => {
		const distorted = linuxChromium().map((row) =>
			row.pid === 200 ? { ...row, command: `${CHROMIUM} ${CHROMIUM} --user-data-dir=${PROFILE}` } : row
		);
		const distortedFirefox = linuxFirefox().map((row) =>
			row.pid === 202 ? { ...row, command: row.command.replace("2 tab", "2 forkserver") } : row
		);
		const distortedWebKit = linuxWebKit().map((row) =>
			row.pid === 200 ? { ...row, command: `/usr/bin/bash bash ${WEBKIT_SCRIPT} --user-data-dir=${PROFILE}` } : row
		);
		/* eslint-disable @typescript-eslint/ban-ts-comment, import/no-unresolved -- GREEN-owned injected runner is intentionally absent in RED. */
		// @ts-ignore RED: the GREEN-owned injected runner module is intentionally absent; this remains valid once it lands.
		const runnerModule = await import("./fixtures/phase-2e6-process-death-runner.js");
		/* eslint-enable @typescript-eslint/ban-ts-comment, import/no-unresolved */
		type RunnerExport = typeof runnerModule.runPhase2hNativeAdmission;
		type RunnerDependencies = Parameters<RunnerExport>[0];
		type RunnerAuthorityIsMandatory =
			IsAny<RunnerExport> extends true
				? false
				: RunnerExport extends NativeAdmissionProducer
					? RunnerDependencies extends NativeAdmissionDependencies
						? true
						: false
					: false;
		const runnerAuthorityIsMandatory: RunnerAuthorityIsMandatory = true;
		expect(runnerAuthorityIsMandatory).toBe(true);
		const runAdmission = runnerModule.runPhase2hNativeAdmission;
		if (typeof runAdmission !== "function") throw new TypeError("runPhase2hNativeAdmission export is absent");
		const liveControls = [
			[linuxChromium(), "chromium-renderer", CHROMIUM],
			[linuxFirefox(), "firefox-contentproc", FIREFOX],
			[linuxWebKit(), "webkit-webcontent", WEBKIT_SCRIPT],
		] as const;
		const controllerContradictions = liveControls.flatMap(([forest, contentClass, executable]) => {
			const missing = forest.filter(({ pid }) => pid !== CONTROLLER_PID);
			const mismatched = forest.map((row) => (row.pid === CONTROLLER_PID ? { ...row, pid: 91 } : row));
			const wrongGroup = forest.map((row) =>
				row.pid === CONTROLLER_PID ? { ...row, pgid: CONTROLLER_PGID + 1 } : row
			);
			return [missing, mismatched, wrongGroup].map(
				(mutant) => [mutant, campaignFor(mutant, contentClass, executable), "linux", "FOREST_CONTRADICTION"] as const
			);
		});
		for (const [forest, campaign, platform, error] of [
			[distorted, campaignFor(distorted, "chromium-renderer", CHROMIUM), "linux", "FOREST_CONTRADICTION"],
			[
				distortedFirefox,
				campaignFor(distortedFirefox, "firefox-contentproc", FIREFOX),
				"linux",
				"FOREST_CONTRADICTION",
			],
			[
				distortedWebKit,
				campaignFor(distortedWebKit, "webkit-webcontent", WEBKIT_SCRIPT),
				"linux",
				"FOREST_CONTRADICTION",
			],
			...controllerContradictions,
			[
				linuxChromium(),
				campaignFor(linuxChromium(), "chromium-renderer", CHROMIUM),
				"darwin",
				"HOST_AUTHORITY_CONTRADICTION",
			],
			[
				darwinPhase2hChromium(),
				campaignFor(
					darwinPhase2hChromium(),
					"chromium-renderer",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"darwin",
					"phase2h",
					DARWIN_PROFILE
				),
				"linux",
				"HOST_AUTHORITY_CONTRADICTION",
			],
			[
				darwinPhase2hChromium(),
				campaignFor(
					darwinPhase2hChromium(),
					"chromium-renderer",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"darwin",
					"phase2h",
					DARWIN_PROFILE
				),
				"darwin",
				"UNSUPPORTED_PLATFORM",
			],
			[
				darwinPhase2hFirefox(),
				campaignFor(darwinPhase2hFirefox(), "firefox-contentproc", DARWIN_FIREFOX, "darwin", "phase2h", DARWIN_PROFILE),
				"darwin",
				"UNSUPPORTED_PLATFORM",
			],
			[
				darwinPhase2hWebKit(),
				campaignFor(darwinPhase2hWebKit(), "webkit-webcontent", WEBKIT_SCRIPT, "darwin", "phase2h", DARWIN_PROFILE),
				"darwin",
				"UNSUPPORTED_PLATFORM",
			],
		] as const) {
			const retained: Array<readonly ProcessIdentity[]> = [];
			const effects: string[] = [];
			await expect(
				runAdmission({
					arm: () => effects.push("arm"),
					authority: campaign,
					captureForest: () => forest,
					constructRecord: () => effects.push("record"),
					native: { arch: "x64", platform },
					publish: () => effects.push("publication"),
					recover: () => effects.push("recovery"),
					retainCapture: (capture: readonly ProcessIdentity[]) => retained.push(capture),
					signalGroup: () => effects.push("signal"),
				})
			).rejects.toThrow(error);
			expect(retained).toEqual([forest]);
			expect(effects).toEqual([]);
		}
	});

	it.each([WEBKIT_SCRIPT, "/opt/relocated-webkit-999/pw_run.sh"])(
		"RED(baseline renderer predicate -> current native WebKit): derives and accepts bash %s",
		(script) => {
			const control = linuxWebKit(script);
			expect(() => validateCampaignForest(control, campaignFor(control, "webkit-webcontent", script))).not.toThrow();
		}
	);

	it.each([
		`/usr/bin/bash bash ${WEBKIT_SCRIPT} --user-data-dir=${PROFILE}`,
		`${WEBKIT_SCRIPT} ${WEBKIT_SCRIPT} --user-data-dir=${PROFILE}`,
		`/usr/bin/node node ${WEBKIT_SCRIPT} --user-data-dir=${PROFILE}`,
		`${WEBKIT_SCRIPT} --user-data-dir=${PROFILE}`,
	])("rejects the finite Linux emulation shape %s", (command) => {
		const control = linuxWebKit();
		const mutant = control.map((row) => (row.pid === 200 ? { ...row, command } : row));
		expect(() => validateCampaignForest(mutant, campaignFor(mutant, "webkit-webcontent", WEBKIT_SCRIPT))).toThrow();
	});

	it("rejects minibrowser-gtk without treating the class label as an argv token", () => {
		const control = linuxWebKit();
		const gtk = control.map((row) => ({
			...row,
			command: row.command.replaceAll("minibrowser-wpe", "minibrowser-gtk"),
		}));
		expect(() => validateCampaignForest(gtk, campaignFor(gtk, "webkit-webcontent", WEBKIT_SCRIPT))).toThrow();
	});

	it("keeps referenced and unreferenced crashpad diagnostics outside owned authority", () => {
		for (const referenced of [true, false]) {
			const base = linuxChromium();
			const crashpad = identity(300, 1, 300, `${CHROMIUM} --type=crashpad-handler`);
			const forest = [
				...base.map((row) =>
					row.pid === 202 && referenced ? { ...row, command: `${row.command} --crashpad-handler-pid=300` } : row
				),
				crashpad,
			];
			const result = validateCampaignForest(forest, campaignFor(forest, "chromium-renderer", CHROMIUM));
			expect(result.ownedPids).not.toContain(crashpad.pid);
			expect(forest.some(({ command }) => command.endsWith(`--crashpad-handler-pid=${crashpad.pid}`))).toBe(referenced);
		}
	});

	it("RED(baseline accepts archived path bytes -> current canonical live/offline authority): never recanonicalizes replay", () => {
		const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "phase-2h-profile-"));
		const canonical = fs.realpathSync(temporary);
		try {
			const forest = linuxChromium().map((row) => ({ ...row, command: row.command.replaceAll(PROFILE, canonical) }));
			const live = { ...campaignFor(forest, "chromium-renderer", CHROMIUM), profilePath: canonical };
			expect(canonical).toBe(temporary);
			expect(() => validateCampaignForest(forest, live)).not.toThrow();
			const archived = JSON.parse(JSON.stringify({ forest, live })) as {
				forest: readonly ProcessIdentity[];
				live: CorrectiveCampaignAuthority;
			};
			fs.rmSync(temporary, { recursive: true });
			const calls = trapOfflineLookups(() => {
				expect(() => validateCampaignForest(archived.forest, archived.live)).not.toThrow();
				expect(archived.live.profilePath).toBe(canonical);
			});
			expect(calls).toEqual([]);
		} finally {
			fs.rmSync(temporary, { force: true, recursive: true });
		}

		const noncanonicalProfile = "/var/folders/noncanonical/profile";
		const noncanonical = darwinPhase2e6Chromium(noncanonicalProfile);
		const bad = {
			...campaignFor(
				noncanonical,
				"chromium-renderer",
				"/Applications/Chromium.app/Contents/MacOS/Chromium",
				"darwin",
				"phase2e6",
				noncanonicalProfile
			),
			profilePath: noncanonicalProfile,
		};
		expect(() => validateCampaignForest(noncanonical, bad)).toThrow();
	});
});
