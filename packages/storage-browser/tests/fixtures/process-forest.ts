import { execFileSync } from "node:child_process";
import path from "node:path";

export interface ProcessIdentity {
	readonly birthToken: string;
	readonly command: string;
	readonly pgid: number;
	readonly pid: number;
	readonly ppid: number;
	readonly state: string;
}

export type ProcessContentClass = "chromium-renderer" | "firefox-contentproc" | "webkit-webcontent";
export type ProcessCampaignPlatform = "darwin" | "linux";
export type ProcessCampaignScope = "phase2e6" | "phase2h";

export interface ProcessCampaignAuthority {
	readonly browserRoot: ProcessIdentity;
	readonly childRoot: ProcessIdentity;
	readonly contentProcessClass: ProcessContentClass;
	readonly controllerPgid: number;
	readonly executablePath: string;
	readonly platform: ProcessCampaignPlatform;
	readonly profilePath: string;
	readonly scope: ProcessCampaignScope;
}

export type ProcessRootAuthority = Omit<ProcessCampaignAuthority, "browserRoot">;

export interface StagedFreezeAuthority extends ProcessCampaignAuthority {
	readonly initialForest: readonly ProcessIdentity[];
}

const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/u;

export const PROCESS_FOREST_ARGUMENTS = Object.freeze(["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,state=,command="]);

/**
 * Captures and parses the complete C-locale process table.
 * @returns Frozen process identities.
 */
export function captureProcessForest(): readonly ProcessIdentity[] {
	return parseProcessForest(
		execFileSync("ps", PROCESS_FOREST_ARGUMENTS, {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			maxBuffer: 16 * 1024 * 1024,
		})
	);
}

/**
 * Returns one root's transitive descendant closure.
 * @param forest - Complete process forest.
 * @param rootPid - Closure root PID.
 * @returns Frozen descendant closure including the root.
 */
export function processClosure(forest: readonly ProcessIdentity[], rootPid: number): readonly ProcessIdentity[] {
	const owned = new Set([rootPid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const identity of forest) {
			if (owned.has(identity.ppid) && !owned.has(identity.pid)) {
				owned.add(identity.pid);
				changed = true;
			}
		}
	}
	return Object.freeze(forest.filter((identity) => owned.has(identity.pid)));
}

function exactPrefix(command: string, needle: string): boolean {
	return command === needle || (command.startsWith(needle) && command.charAt(needle.length) === " ");
}

function exactArgument(command: string, argument: string): boolean {
	let from = 0;
	for (;;) {
		const index = command.indexOf(argument, from);
		if (index < 0) return false;
		const before = index === 0 || command.charAt(index - 1) === " ";
		const after = index + argument.length === command.length || command.charAt(index + argument.length) === " ";
		if (before && after) return true;
		from = index + 1;
	}
}

function exactAdjacent(command: string, flag: string, value: string): boolean {
	return exactArgument(command, `${flag} ${value}`);
}

function validCanonicalProfile(platform: ProcessCampaignPlatform, profile: string): boolean {
	if (!path.posix.isAbsolute(profile) || profile.includes("\0")) return false;
	// On measured Darwin hosts /var is the noncanonical alias of /private/var.
	return platform !== "darwin" || !profile.startsWith("/var/");
}

function rootMatches(identity: ProcessIdentity, authority: ProcessRootAuthority): boolean {
	if (!validCanonicalProfile(authority.platform, authority.profilePath)) return false;
	if (authority.platform === "darwin") {
		return (
			authority.scope === "phase2e6" &&
			authority.contentProcessClass === "chromium-renderer" &&
			exactPrefix(identity.command, authority.executablePath) &&
			exactArgument(identity.command, `--user-data-dir=${authority.profilePath}`)
		);
	}
	if (authority.scope !== "phase2h" && authority.scope !== "phase2e6") return false;
	switch (authority.contentProcessClass) {
		case "chromium-renderer":
			return (
				exactPrefix(identity.command, authority.executablePath) &&
				exactArgument(identity.command, `--user-data-dir=${authority.profilePath}`) &&
				!exactPrefix(identity.command, `${authority.executablePath} ${authority.executablePath}`)
			);
		case "firefox-contentproc":
			return (
				exactPrefix(identity.command, authority.executablePath) &&
				exactAdjacent(identity.command, "-profile", authority.profilePath) &&
				!exactPrefix(identity.command, `${authority.executablePath} ${authority.executablePath}`)
			);
		case "webkit-webcontent":
			return (
				exactPrefix(identity.command, `bash ${authority.executablePath}`) &&
				exactArgument(identity.command, `--user-data-dir=${authority.profilePath}`) &&
				!exactPrefix(identity.command, `/usr/bin/bash bash ${authority.executablePath}`) &&
				!exactPrefix(identity.command, `${authority.executablePath} ${authority.executablePath}`) &&
				!exactPrefix(identity.command, `/usr/bin/node node ${authority.executablePath}`)
			);
	}
}

function darwinRendererExecutable(executablePath: string, command: string): string | undefined {
	const suffix = ".app/Contents/MacOS/";
	const marker = executablePath.lastIndexOf(suffix);
	if (marker <= 0) return undefined;
	const bundle = executablePath.slice(0, marker + 4);
	const browser = executablePath.slice(marker + suffix.length);
	if (browser.length === 0 || bundle !== executablePath.slice(0, marker + 4)) return undefined;
	const prefix = `${bundle}/Contents/Frameworks/${browser} Framework.framework/Versions/`;
	const helperSuffix = `/Helpers/${browser} Helper (Renderer).app/Contents/MacOS/${browser} Helper (Renderer)`;
	if (!command.startsWith(prefix)) return undefined;
	const end = command.indexOf(helperSuffix, prefix.length);
	if (end < 0) return undefined;
	const version = command.slice(prefix.length, end);
	if (!/^[0-9]+(?:\.[0-9]+)*$/u.test(version)) return undefined;
	return `${prefix}${version}${helperSuffix}`;
}

function hasLinuxWitness(
	forest: readonly ProcessIdentity[],
	browser: ProcessIdentity,
	authority: ProcessCampaignAuthority
): boolean {
	const closure = processClosure(forest, browser.pid);
	const descendants = closure.filter(({ pid, pgid }) => pid !== browser.pid && pgid === browser.pgid);
	switch (authority.contentProcessClass) {
		case "chromium-renderer":
			return descendants.some((identity) => {
				const zygote = closure.find(({ pid }) => pid === identity.ppid);
				return (
					exactPrefix(identity.command, authority.executablePath) &&
					exactArgument(identity.command, "--type=renderer") &&
					exactArgument(identity.command, `--user-data-dir=${authority.profilePath}`) &&
					zygote !== undefined &&
					zygote.ppid === browser.pid &&
					zygote.pgid === browser.pgid &&
					exactPrefix(zygote.command, authority.executablePath) &&
					exactArgument(zygote.command, "--type=zygote") &&
					exactArgument(zygote.command, `--user-data-dir=${authority.profilePath}`)
				);
			});
		case "firefox-contentproc":
			return descendants.some((identity) => {
				if (
					!exactPrefix(identity.command, authority.executablePath) ||
					!exactArgument(identity.command, "-contentproc") ||
					!exactAdjacent(identity.command, "-parentPid", String(browser.pid))
				)
					return false;
				const forkserver = closure.find(({ pid }) => pid === identity.ppid);
				const match = /(?:^| )(\d+) tab$/u.exec(identity.command);
				return (
					match !== null &&
					/^[1-9]\d*$/u.test(match[1] ?? "") &&
					Number.isSafeInteger(Number(match[1])) &&
					forkserver !== undefined &&
					forkserver.ppid === browser.pid &&
					forkserver.pgid === browser.pgid &&
					exactPrefix(forkserver.command, authority.executablePath) &&
					exactArgument(forkserver.command, "-contentproc") &&
					exactAdjacent(forkserver.command, "-parentPid", String(browser.pid)) &&
					/(?:^| )1 forkserver$/u.test(forkserver.command)
				);
			});
		case "webkit-webcontent": {
			const installation = path.posix.dirname(authority.executablePath);
			const miniPath = `${installation}/minibrowser-wpe/bin/MiniBrowser`;
			const webPath = `${installation}/minibrowser-wpe/bin/WPEWebProcess`;
			return descendants.some(
				(mini) =>
					exactPrefix(mini.command, miniPath) &&
					exactArgument(mini.command, `--user-data-dir=${authority.profilePath}`) &&
					processClosure(closure, mini.pid).some(
						(web) => web.pid !== mini.pid && web.pgid === browser.pgid && exactPrefix(web.command, webPath)
					)
			);
		}
	}
}

function hasDarwinPhase2e6Witness(
	forest: readonly ProcessIdentity[],
	browser: ProcessIdentity,
	authority: ProcessCampaignAuthority
): boolean {
	if (authority.scope !== "phase2e6" || authority.contentProcessClass !== "chromium-renderer") return false;
	return forest.some((identity) => {
		if (identity.ppid !== browser.pid || identity.pgid !== browser.pgid) return false;
		const helper = darwinRendererExecutable(authority.executablePath, identity.command);
		return (
			helper !== undefined &&
			exactPrefix(identity.command, helper) &&
			exactArgument(identity.command, "--type=renderer") &&
			exactArgument(identity.command, `--user-data-dir=${authority.profilePath}`)
		);
	});
}

/**
 * Locates the one direct browser root matching exact trusted authority.
 * @param forest - Complete live forest.
 * @param childPid - Pinned isolated-child PID.
 * @param profilePath - Canonical live profile bytes.
 * @param authority - Exact platform, class, executable and controller authority.
 * @returns Unique direct browser root.
 */
export function locateBrowserRoot(
	forest: readonly ProcessIdentity[],
	childPid: number,
	profilePath: string,
	authority: ProcessRootAuthority
): ProcessIdentity {
	if (
		!validAuthorityIdentity(authority.childRoot) ||
		!positiveSafeInteger(authority.controllerPgid) ||
		authority.childRoot.pid !== childPid ||
		authority.profilePath !== profilePath
	) {
		throw new TypeError("browser-root authority disagrees with requested child/profile");
	}
	const candidates = forest.filter(
		(identity) => validAuthorityIdentity(identity) && identity.ppid === childPid && rootMatches(identity, authority)
	);
	if (candidates.length !== 1) throw new TypeError(`expected one browser root, observed ${candidates.length}`);
	return candidates[0] as ProcessIdentity;
}

/**
 * Retains the complete raw admission forest before exact root classification.
 * @param forest - Complete live process forest.
 * @param childPid - Pinned isolated-child PID.
 * @param profilePath - Canonical live profile bytes.
 * @param authority - Exact platform, class, executable and controller authority.
 * @param retain - Create-only raw contradiction-evidence owner.
 * @returns Unique direct browser root.
 */
export function retainThenLocateBrowserRoot(
	forest: readonly ProcessIdentity[],
	childPid: number,
	profilePath: string,
	authority: ProcessRootAuthority,
	retain: (capture: readonly ProcessIdentity[]) => void
): ProcessIdentity {
	retain(forest);
	return locateBrowserRoot(forest, childPid, profilePath, authority);
}

/**
 * Parses the ratified C-locale ps output.
 * @param output - Raw process-table bytes decoded as text.
 * @returns Frozen process identities.
 */
export function parseProcessForest(output: string): readonly ProcessIdentity[] {
	if (output.length === 0) return [];
	return output
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => {
			const match = PROCESS_LINE.exec(line);
			if (!match) throw new TypeError(`malformed process line: ${line}`);
			const pid = Number(match[1]);
			const ppid = Number(match[2]);
			const pgid = Number(match[3]);
			if (
				!Number.isSafeInteger(pid) ||
				pid <= 0 ||
				!Number.isSafeInteger(ppid) ||
				ppid < 0 ||
				!Number.isSafeInteger(pgid) ||
				pgid < 0
			)
				throw new TypeError("pid must be positive and ppid/pgid must be non-negative safe integers");
			return Object.freeze({
				birthToken: match[4] as string,
				command: match[6] as string,
				pgid,
				pid,
				ppid,
				state: match[5] as string,
			});
		});
}

/**
 * Validates root, group and exact engine-witness authority.
 * @param forest - Complete or stored owned forest.
 * @param childPid - Pinned isolated-child PID.
 * @param browserPid - Pinned browser-root PID.
 * @param authority - Trusted campaign authority outside evidence schema.
 * @returns The two authorized PGIDs and owned union.
 */
export function validateTwoGroupForest(
	forest: readonly ProcessIdentity[],
	childPid: number,
	browserPid: number,
	authority: ProcessCampaignAuthority
): { readonly browserPgid: number; readonly childPgid: number; readonly ownedPids: readonly number[] } {
	if (!validUniqueObservationForest(forest))
		throw new TypeError("forest contains malformed or ambiguous process identity");
	if (
		!validAuthorityIdentity(authority.childRoot) ||
		!validAuthorityIdentity(authority.browserRoot) ||
		!positiveSafeInteger(authority.controllerPgid)
	)
		throw new TypeError("campaign roots and controller require positive process-group authority");
	if (authority.scope === "phase2h" && authority.platform !== "linux")
		throw new TypeError("Phase 2h process-death requires Linux host authority");
	if (authority.childRoot.pid !== childPid || authority.browserRoot.pid !== browserPid)
		throw new TypeError("forest roots disagree with campaign authority");
	const child = exactStableIdentity(forest, authority.childRoot);
	const browser = exactStableIdentity(forest, authority.browserRoot);
	if (child === undefined || browser === undefined)
		throw new TypeError("forest requires unique pinned child and browser roots");
	const closure = processClosure(forest, child.pid);
	if (!closure.every(validAuthorityIdentity))
		throw new TypeError("owned process closure requires positive process-group authority");
	if (child.pgid === browser.pgid) throw new TypeError("forest requires exactly two distinct process groups");
	if (child.pid !== child.pgid || browser.pid !== browser.pgid || browser.ppid !== child.pid)
		throw new TypeError("forest requires root-led child and browser process groups");
	if (authority.controllerPgid === child.pgid || authority.controllerPgid === browser.pgid)
		throw new TypeError("controller overlaps owned process groups");
	if (!rootMatches(browser, authority)) throw new TypeError("browser root executable/profile authority mismatch");
	const witness =
		authority.platform === "linux"
			? hasLinuxWitness(forest, browser, authority)
			: hasDarwinPhase2e6Witness(forest, browser, authority);
	if (!witness) throw new TypeError(`forest requires exact ${authority.contentProcessClass} witness`);
	const owned = forest.filter((identity) => identity.pgid === child.pgid || identity.pgid === browser.pgid);
	return Object.freeze({
		browserPgid: browser.pgid,
		childPgid: child.pgid,
		ownedPids: Object.freeze(owned.map(({ pid }) => pid)),
	});
}

/**
 * Checks the child-first staged stop against mirrored authority.
 * @param forest - Current complete forest.
 * @param authority - Previously validated campaign and initial forest.
 * @returns Whether the child stage is safely frozen.
 */
export function childGroupStoppedForFreeze(
	forest: readonly ProcessIdentity[],
	authority: StagedFreezeAuthority
): boolean {
	const authorized = validatedFreezeAuthority(authority);
	if (authorized === undefined || !validUniqueObservationForest(forest)) return false;
	if (
		exactStableIdentity(forest, authority.childRoot) === undefined ||
		exactStableIdentity(forest, authority.browserRoot) === undefined
	)
		return false;
	const currentChildGroup = forest.filter(({ pgid }) => pgid === authorized.childPgid);
	if (currentChildGroup.length === 0 || !currentChildGroup.every(stoppedOrZombie)) return false;
	return authorized.initialChildGroup.every((initial) => {
		const current = exactStableIdentity(forest, initial);
		return current !== undefined && stoppedOrZombie(current);
	});
}

/**
 * Revalidates both stopped groups and freezes their exact current union.
 * @param forest - Current complete forest.
 * @param authority - Previously validated campaign and initial forest.
 * @returns Frozen owned union or undefined on contradiction.
 */
export function freezeCurrentOwnedUnion(
	forest: readonly ProcessIdentity[],
	authority: StagedFreezeAuthority
): readonly ProcessIdentity[] | undefined {
	const authorized = validatedFreezeAuthority(authority);
	if (authorized === undefined || !validUniqueObservationForest(forest)) return undefined;
	if (
		exactStableIdentity(forest, authority.childRoot) === undefined ||
		exactStableIdentity(forest, authority.browserRoot) === undefined
	)
		return undefined;
	try {
		const groups = validateTwoGroupForest(forest, authority.childRoot.pid, authority.browserRoot.pid, authority);
		if (groups.childPgid !== authorized.childPgid || groups.browserPgid !== authorized.browserPgid) return undefined;
	} catch {
		return undefined;
	}
	const owned = forest.filter(({ pgid }) => pgid === authorized.childPgid || pgid === authorized.browserPgid);
	return owned.every(stoppedOrZombie) ? Object.freeze([...owned]) : undefined;
}

function validUniqueObservationForest(forest: readonly ProcessIdentity[]): boolean {
	return (
		Array.isArray(forest) &&
		forest.every(validObservedIdentity) &&
		new Set(forest.map(({ pid }) => pid)).size === forest.length
	);
}

function validObservedIdentity(identity: ProcessIdentity): boolean {
	return (
		typeof identity === "object" &&
		identity !== null &&
		Number.isSafeInteger(identity.pid) &&
		identity.pid > 0 &&
		Number.isSafeInteger(identity.ppid) &&
		identity.ppid >= 0 &&
		Number.isSafeInteger(identity.pgid) &&
		identity.pgid >= 0 &&
		typeof identity.birthToken === "string" &&
		identity.birthToken.length > 0 &&
		typeof identity.command === "string" &&
		identity.command.length > 0 &&
		typeof identity.state === "string" &&
		identity.state.length > 0
	);
}

function validAuthorityIdentity(identity: ProcessIdentity): boolean {
	return validObservedIdentity(identity) && identity.pgid > 0;
}

function positiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function sameNonStateIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.ppid === right.ppid &&
		left.pgid === right.pgid &&
		left.birthToken === right.birthToken &&
		left.command === right.command
	);
}

function exactStableIdentity(
	forest: readonly ProcessIdentity[],
	expected: ProcessIdentity
): ProcessIdentity | undefined {
	const matches = forest.filter(({ pid }) => pid === expected.pid);
	return matches.length === 1 && matches[0] !== undefined && sameNonStateIdentity(matches[0], expected)
		? matches[0]
		: undefined;
}

function stoppedOrZombie(identity: ProcessIdentity): boolean {
	return /T|Z/u.test(identity.state);
}

function validatedFreezeAuthority(
	authority: StagedFreezeAuthority
):
	| { readonly browserPgid: number; readonly childPgid: number; readonly initialChildGroup: readonly ProcessIdentity[] }
	| undefined {
	if (
		!validAuthorityIdentity(authority.childRoot) ||
		!validAuthorityIdentity(authority.browserRoot) ||
		!positiveSafeInteger(authority.controllerPgid) ||
		!validUniqueObservationForest(authority.initialForest)
	)
		return undefined;
	try {
		const groups = validateTwoGroupForest(
			authority.initialForest,
			authority.childRoot.pid,
			authority.browserRoot.pid,
			authority
		);
		return Object.freeze({
			browserPgid: groups.browserPgid,
			childPgid: groups.childPgid,
			initialChildGroup: Object.freeze(authority.initialForest.filter(({ pgid }) => pgid === groups.childPgid)),
		});
	} catch {
		return undefined;
	}
}
