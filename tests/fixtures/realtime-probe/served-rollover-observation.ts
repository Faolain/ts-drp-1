import type { BrowserContext } from "@playwright/test";

// Measurement only. The shipped pages roll their rooms over through the shared policy
// (examples/v3-room/src/rollover.ts) and deliver successor offers through the shared delivery
// (examples/v3-room/src/successor-delivery.ts). Their dev servers serve those modules from source;
// this route brackets the policy's and the delivery's own room calls, as served, with
// `__TS_DRP_ROLLOVER_OBSERVATION__.stage(name, run)` (installed by
// tests/fixtures/realtime-probe/page-probe.ts) and binds the delivery's room read-only so the
// probe can read the room's authenticated epoch and the delivery's counters. Each call still runs
// once, with the same receiver, arguments, result and throw; nothing else in the modules changes.
// Every anchor must match exactly once or the route fails the page load loudly
// (REALTIME_OBSERVATION_ANCHOR_*), so a change to the shipped modules cannot silently leave
// the gate without its windows.

const PRELUDE =
	"const __tsDrpObservation = globalThis.__TS_DRP_ROLLOVER_OBSERVATION__ ?? " +
	"{ stage: (_name, run) => run(), bindDelivery: () => undefined };\n" +
	// Brackets one method call with its own receiver and arguments (the call's text is left in place).
	"const __tsDrpStageCall = (name, receiver, method, ...args) => " +
	"__tsDrpObservation.stage(name, () => receiver[method](...args));\n";

interface Anchor {
	readonly name: string;
	readonly pattern: RegExp;
	replace(...groups: string[]): string;
}

const ROLLOVER_ANCHORS: readonly Anchor[] = [
	{
		name: "creator-seal",
		pattern: /const sealed = await selected\.sealEpoch\(\);/gu,
		replace: () => 'const sealed = await __tsDrpObservation.stage("creator-seal", () => selected.sealEpoch());',
	},
	{
		name: "creator-adopt",
		pattern: /await selected\.adoptCreatorSuccessor\(\);/gu,
		replace: () => 'await __tsDrpObservation.stage("creator-adopt", () => selected.adoptCreatorSuccessor());',
	},
	{
		name: "creator-export",
		pattern: /const offer = await selected\.exportCreatorSuccessor\(\);/gu,
		replace: () =>
			'const offer = await __tsDrpObservation.stage("creator-export", () => selected.exportCreatorSuccessor());',
	},
	{
		name: "creator-publish",
		pattern: /await hooks\.publishSuccessor\?\.\(offer, sealed\.successorEpoch\);/gu,
		replace: () =>
			'await __tsDrpObservation.stage("creator-publish", async () => hooks.publishSuccessor?.(offer, sealed.successorEpoch));',
	},
];

const DELIVERY_ANCHORS: readonly Anchor[] = [
	{
		name: "member-install",
		// The install call carries a multi-line options object (currency, newest); only its callee is
		// rewritten, so the original argument text and closing parenthesis are kept exactly.
		pattern: /await selectedRoom\.installCreatorSuccessor\(/gu,
		replace: () => 'await __tsDrpStageCall("member-install", selectedRoom, "installCreatorSuccessor", ',
	},
	{
		name: "delivery-bind",
		pattern: /room = selected;(\s+)unsubscribe\.push\(channel\.listen\(receive\)\);/gu,
		replace: (_match, space) =>
			`room = selected; __tsDrpObservation.bindDelivery(role, selected, () => ({ ...stats }));${space}unsubscribe.push(channel.listen(receive));`,
	},
];

function rewrite(body: string, anchors: readonly Anchor[], file: string): string {
	let result = body;
	for (const anchor of anchors) {
		const found = [...result.matchAll(anchor.pattern)].length;
		if (found !== 1)
			throw new Error(`REALTIME_OBSERVATION_ANCHOR_${found === 0 ? "ABSENT" : "AMBIGUOUS"} ${file} ${anchor.name}`);
		result = result.replace(anchor.pattern, (...args: unknown[]) => anchor.replace(...(args as string[])));
	}
	// After the module's imports (ES imports are hoisted, so the prelude may follow them anywhere).
	return PRELUDE + result;
}

/**
 * Routes one app origin's served v3-room modules through the observation rewrite.
 * @param context - The browser context.
 * @param origin - The app's dev-server origin.
 * @param failures - Collects rewrite failures (the route also fails the module request).
 */
export async function installServedRolloverObservation(
	context: BrowserContext,
	origin: string,
	failures: string[]
): Promise<void> {
	for (const [file, anchors] of [
		["examples/v3-room/src/rollover.ts", ROLLOVER_ANCHORS],
		["examples/v3-room/src/successor-delivery.ts", DELIVERY_ANCHORS],
	] as const) {
		await context.route(
			(url) => url.origin === origin && url.pathname.endsWith(`/${file}`),
			async (route) => {
				const response = await route.fetch();
				const body = await response.text();
				let rewritten: string;
				try {
					rewritten = rewrite(body, anchors, file);
				} catch (error) {
					failures.push(String(error));
					await route.fulfill({ status: 500, body: String(error) });
					return;
				}
				const headers = { ...response.headers() };
				delete headers["content-length"];
				delete headers["etag"];
				await route.fulfill({ status: response.status(), headers, body: rewritten });
			}
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Harness bridges are refused loudly.

/**
 * Page side (init script). The shipped pages read `__TS_DRP_<APP>_SUCCESSOR_PUBLISHER__`, a test
 * override that hands successor offers to the test instead of the page's own delivery. Here each
 * of them is an accessor that is always undefined and whose assignment throws and is recorded. For
 * Grid, the page's window zone API is wrapped so that a test call of its seal/export/adopt/install
 * (the calls a harness would use to pass offers between pages) throws and is recorded; the page's
 * own policy and delivery call the room directly and are unaffected.
 */
export function harnessBridgeGuardInitScript(): void {
	const violations: string[] = [];
	Reflect.set(globalThis, "__TS_DRP_HARNESS_BRIDGE_VIOLATIONS__", violations);
	for (const app of ["GRID", "CANVAS", "CHAT"]) {
		const name = `__TS_DRP_${app}_SUCCESSOR_PUBLISHER__`;
		Object.defineProperty(window, name, {
			configurable: false,
			enumerable: false,
			get: () => undefined,
			set: () => {
				violations.push(`assigned ${name}`);
				throw new Error(`HARNESS_OFFER_BRIDGE_REFUSED ${name}`);
			},
		});
	}
	const forbidden = new Set([
		"sealEpoch",
		"exportCreatorSuccessor",
		"adoptCreatorSuccessor",
		"installCreatorSuccessor",
		"rehearseMigration",
		"activateMigration",
	]);
	let zone: unknown;
	Object.defineProperty(window, "__TS_DRP_V3_ZONE__", {
		configurable: true,
		enumerable: true,
		get: () => zone,
		set: (value: unknown) => {
			if (value === undefined || value === null || typeof value !== "object") {
				zone = value;
				return;
			}
			const original = value as Record<string, unknown>;
			const guarded: Record<string, unknown> = {};
			for (const key of Object.keys(original)) {
				const member = original[key];
				if (forbidden.has(key))
					guarded[key] = (): never => {
						violations.push(`called __TS_DRP_V3_ZONE__.${key}`);
						throw new Error(`HARNESS_OFFER_BRIDGE_REFUSED __TS_DRP_V3_ZONE__.${key}`);
					};
				else
					guarded[key] =
						typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(original) : member;
			}
			zone = Object.freeze(guarded);
		},
	});
}

/**
 * Installs the guard in every page of a context.
 * @param context - The browser context.
 */
export async function installHarnessBridgeGuard(context: BrowserContext): Promise<void> {
	await context.addInitScript(harnessBridgeGuardInitScript);
}
