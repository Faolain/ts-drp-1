import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

// Track X, decision row 73 (step 14 A, RED first). On the epoch-0 target of a migration, the
// creator's ordinary warm source declines every capture by design
// (creator-closed-rollback-data "native-or-cross-context-source"), so the OPTIONAL ordinary prime
// that creator close runs before each mandatory cold quote (creator-close.ts
// captureCreatorOrdinarySourceWithoutForecast, called by the ordinary admission's initial prime
// and its joined-source refresh) spends a complete cold read lifetime to learn nothing. A skips
// that optional prime when the registration's private live hint reports the migration source.
// These proofs run the exact helper source (as astra's consult-4 probe did) with its
// collaborators stubbed, and the exact live predicate source; the native proofs are in
// tests/track-x-ordinary-prime-migration-native.test.ts.
//
// The claim is narrow on purpose: healthy outcomes are unchanged, every check of the mandatory
// cold quote stays, and failures that only the skipped optional lifetime could raise are no
// longer raised (pinned below).

/**
 * The exact source of one top-level function declaration, transpiled.
 * @param path - The source file.
 * @param name - The function's name.
 * @returns The function's JavaScript.
 */
function functionSource(path: string, name: string): string {
	const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
	expect(found, `${name} in ${path}`).toBeDefined();
	return ts.transpileModule(found!.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const SOURCE = Object.freeze({ kind: "captured-ordinary-source" });
type Stage = "acquire" | "capture" | "release" | "capture-and-release";
type Registration = Record<string, unknown> & { hasMigrationSourceForOrdinaryPrime?: () => boolean };

interface Run {
	readonly result: string;
	readonly seals: number;
	readonly acquires: number;
	readonly captures: readonly string[];
	readonly releases: number;
	readonly events: readonly Readonly<Record<string, unknown>>[];
}

const prime = functionSource("packages/node/src/creator-close.ts", "captureCreatorOrdinarySourceWithoutForecast");

/**
 * A close registration stand-in with an optional migration-source hint.
 * @param hint - The hint, or none.
 * @returns The stand-in (the seal stub is added per run).
 */
const registrationWith = (hint?: () => boolean): Registration =>
	hint === undefined ? {} : { hasMigrationSourceForOrdinaryPrime: hint };

/**
 * Runs the exact helper once with stubbed collaborators.
 * @param registration - The close registration stand-in (it receives the seal stub).
 * @param options - The call's arguments and an injected failure.
 * @returns What the call did.
 */
async function runPrime(
	registration: Registration,
	options: Readonly<{ receipt?: object; readiness?: boolean; fail?: Stage; archive?: boolean }> = {}
): Promise<Run> {
	let seals = 0,
		acquires = 0,
		releases = 0;
	const captures: string[] = [];
	const events: Readonly<Record<string, unknown>>[] = [];
	const failure = (stage: string): Error => new Error(`TRACK_X_${stage.toUpperCase()}_FAILURE`);
	Object.assign(registration, {
		objectId: "creator:track-x",
		store: {},
		liveJournalStore: {},
		currentTrust: { currentEpoch: 0 },
		sealIssuanceMaintenanceDependencies: async () => {
			seals++;
			return { hold: true };
		},
	});
	const helper = runInNewContext(`${prime};captureCreatorOrdinarySourceWithoutForecast;`, {
		__warmProofEvent: (event: Readonly<Record<string, unknown>>) => events.push(event),
		isCreatorOrdinarySourceCapacityRefusal: () => false,
		acquireCreatorIssuanceMaintenanceProof: async () => {
			acquires++;
			if (options.fail === "acquire") throw failure("acquire");
			return {
				release: async () => {
					releases++;
					if (options.fail === "release" || options.fail === "capture-and-release") throw failure("release");
				},
			};
		},
		captureCreatorOrdinaryIssuanceProofSource: async (_proof: unknown, readiness: unknown) => {
			captures.push(readiness === undefined ? "ordinary" : "readiness");
			if (options.fail === "capture" || options.fail === "capture-and-release") throw failure("capture");
			return SOURCE;
		},
	}) as (registration: object, input: object, receipt?: object, readiness?: boolean) => Promise<unknown>;
	const input = {
		promotionContext: {},
		readOrdinaryApplicationResourceBound: () => undefined,
		storageIncarnation: 1,
		...(options.archive === true ? { archive: {} } : {}),
	};
	const result = await helper(registration, input, options.receipt, options.readiness).then(
		(value) => (value === SOURCE ? "source" : value === undefined ? "unavailable" : "other"),
		// The helper's own AggregateError belongs to the sandbox realm: read its shape.
		(error: unknown) => {
			const errors = (error as { errors?: unknown }).errors;
			return Array.isArray(errors)
				? `aggregate: ${errors.map((each: Error) => each.message).join(", ")}`
				: `failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	);
	return { result, seals, acquires, captures, releases, events };
}

const skipped = { kind: "ordinary-incremental-source-prime-skipped", epoch: 0, reason: "migration-source" };

it("A's hint is private: an internal member that the published declarations strip", () => {
	const close = readFileSync("packages/node/src/creator-close.ts", "utf8");
	expect(close).toMatch(
		/\/\*\* @internal [^*]*(?:\*(?!\/)[^*]*)*\*\/\s*hasMigrationSourceForOrdinaryPrime\?\(\): boolean;/
	);
	expect(
		(JSON.parse(readFileSync("tsconfig.json", "utf8")) as { compilerOptions: object }).compilerOptions
	).toMatchObject({
		stripInternal: true,
	});
	expect(readFileSync("packages/node/tsconfig.json", "utf8")).toMatch(/"extends": "\.\.\/\.\.\/tsconfig\.json"/);
	// The declaration emit itself (in memory): with the repository's stripInternal the published
	// V3CreatorCloseRegistration has no such member; without it, the member would be published.
	const registration = (stripInternal: boolean): string => {
		const output = ts.transpileDeclaration(close, {
			fileName: "creator-close.ts",
			compilerOptions: { stripInternal },
		}).outputText;
		const start = output.indexOf("interface V3CreatorCloseRegistration");
		expect(start).toBeGreaterThanOrEqual(0);
		return output.slice(start, output.indexOf("\n}", start));
	};
	expect(registration(true)).toContain("sealIssuanceMaintenanceDependencies");
	expect(registration(true)).not.toContain("hasMigrationSourceForOrdinaryPrime");
	expect(registration(false)).toContain("hasMigrationSourceForOrdinaryPrime");
});

it("a migration-source registration skips the optional prime: no seal, proof, capture or release", async () => {
	for (const receipt of [undefined, { received: true }])
		expect(
			await runPrime(
				registrationWith(() => true),
				{ receipt }
			)
		).toEqual({
			result: "unavailable",
			seals: 0,
			acquires: 0,
			captures: [],
			releases: 0,
			events: [skipped],
		});
});

it("a readiness prime is never skipped, even for a migration source", async () => {
	let reads = 0;
	const registration = registrationWith(() => {
		reads++;
		return true;
	});
	expect(await runPrime(registration, { readiness: true })).toEqual({
		result: "source",
		seals: 1,
		acquires: 1,
		captures: ["readiness"],
		releases: 1,
		events: [],
	});
	expect(reads).toBe(0);
});

it("a missing, false or failing hint keeps the original route", async () => {
	const failing = () => {
		throw new Error("TRACK_X_HINT_FAILURE");
	};
	for (const registration of [registrationWith(), registrationWith(() => false), registrationWith(failing)])
		expect(await runPrime(registration)).toEqual({
			result: "source",
			seals: 1,
			acquires: 1,
			captures: ["ordinary"],
			releases: 1,
			events: [],
		});
});

it("the hint is read at each call, so a replaced or retired source restores the prime at once", async () => {
	let migrating = true;
	const registration = registrationWith(() => migrating);
	expect((await runPrime(registration)).seals).toBe(0);
	migrating = false;
	expect(await runPrime(registration)).toMatchObject({ result: "source", seals: 1, acquires: 1, releases: 1 });
	migrating = true;
	expect((await runPrime(registration)).seals).toBe(0);
});

it("outside the optional source domain the hint is not consulted", async () => {
	let reads = 0;
	const registration = registrationWith(() => {
		reads++;
		return true;
	});
	expect(await runPrime(registration, { archive: true })).toEqual({
		result: "unavailable",
		seals: 0,
		acquires: 0,
		captures: [],
		releases: 0,
		events: [],
	});
	expect(reads).toBe(0);
});

it("narrowed claim: a skipped lifetime raises nothing, and an entered lifetime still raises the same failures", async () => {
	const expected: Readonly<Record<Stage, string>> = {
		"acquire": "failed: TRACK_X_ACQUIRE_FAILURE",
		"capture": "failed: TRACK_X_CAPTURE_FAILURE",
		"release": "failed: TRACK_X_RELEASE_FAILURE",
		"capture-and-release": "aggregate: TRACK_X_CAPTURE_FAILURE, TRACK_X_RELEASE_FAILURE",
	};
	for (const fail of Object.keys(expected) as Stage[]) {
		expect(
			await runPrime(
				registrationWith(() => true),
				{ fail }
			),
			fail
		).toMatchObject({
			result: "unavailable",
			seals: 0,
			acquires: 0,
		});
		expect(
			(
				await runPrime(
					registrationWith(() => false),
					{ fail }
				)
			).result,
			fail
		).toBe(expected[fail]);
		expect(
			(
				await runPrime(
					registrationWith(() => true),
					{ fail, readiness: true }
				)
			).result,
			`${fail} (readiness)`
		).toBe(expected[fail]);
	}
});

it("the live hint is exactly the recovery census's migration-source selection", () => {
	const live = "packages/node/src/v3-live.ts";
	const select = runInNewContext(
		`${functionSource(live, "migrationDisplacedSource")};migrationDisplacedSource;`,
		{}
	) as (registration: object) => unknown;
	const runtime = runInNewContext(
		`${functionSource(live, "captureCreatorRecoveryRuntime")};captureCreatorRecoveryRuntime;`,
		{
			ObjectFreeze: Object.freeze,
			currentRegistration: () => true,
			nativeBranchDisplacedSource: () => undefined,
			sameScope: () => false,
			creatorOriginalIssuanceStore: () => undefined,
		}
	) as (registration: object, ...flags: boolean[]) => { migrationSource: unknown };
	const source = (objectId: string, activated: boolean) => ({
		prepared: { trust: { trust: { objectId } }, provenance: {}, input: {} },
		...(activated ? { activationVertexDigest: new Uint8Array(32) } : {}),
	});
	const cases = [
		undefined,
		source("creator:source", false),
		source("creator:target", true),
		source("creator:target", false),
		source("creator:source", true),
	];
	const selected = cases.map((displacedSource) => {
		const registration = {
			payload: { trust: { trust: { objectId: "creator:target" } }, input: {} },
			displacedSource,
			pendingIngress: new Map(),
			pendingIngressBytes: 0,
		};
		const hint = select(registration);
		expect(hint, "the hint selects exactly the census migration source").toBe(
			runtime(registration, false, false, false).migrationSource
		);
		return hint === undefined ? null : cases.indexOf(displacedSource);
	});
	expect(selected).toEqual([null, null, null, null, 4]);
	expect(readFileSync(live, "utf8")).toMatch(
		/hasMigrationSourceForOrdinaryPrime: \(\): boolean => migrationDisplacedSource\(registration\) !== undefined,/
	);
});
