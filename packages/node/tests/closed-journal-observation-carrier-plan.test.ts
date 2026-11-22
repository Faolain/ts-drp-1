import { readFileSync } from "node:fs";

import { CanonicalEncodingError, compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, LIVE_JOURNAL_RETIREMENT_LIMITS, encodeJournalRetirementNativeCarriers,
	type LiveJournalRetirementControl } from "@ts-drp/live-journal";
import { capturePromotionArray, capturePromotionBytes, capturePromotionRecord } from "@ts-drp/protocol-v3/internal/creator-forward-promotion";
import { AHE_BOUNDED_READ_LIMITS, LOCAL_WORKLOAD_CAPACITY } from "@ts-drp/storage";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ISSUANCE_RETIREMENT_LIMITS } from "../../issuance-store/src/retirement.js";
import { JOURNAL_POSTIMAGE_NOT_GROWN } from "../src/internal/creator-closed-rollback-data.js";

// fix/maintenance-image-capacity C1: the journal observation carrier {control, image, canonicalRows} is one encode
// under the close's 786,432-byte cap (CLOSED_RETIREMENT_BYTES, the one-bound rule). A drain control carries its plan,
// and the plan carries the exact native frame of every received row it retires. At beginDrain each of those frames is
// byte-equal to a row the same carrier still holds in canonicalRows, so the carrier held the collectible rows twice.
// j19/j23 (5 Writers, epoch 2's adoption drain) stopped there: 692 rows of about 1.1 KB (764,717 B) plus a plan of
// 520,499 B for epoch 0's 385 rows, 1,304,739/786,432 at the forecast's journal observation site.

const CAP = { maxBytes: 786_432, maxItems: 65_536, maxDepth: 128 };
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("creator-closed-rollback-data.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string | undefined {
	const found = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
	// The owner's declaration is compiled into a function body here, where an `export` modifier cannot stand.
	return found?.getText(parsed).replace(/^export\s+/u, "");
}
// The owner's carrier function and whatever helpers it uses, compiled from the owner's own declarations.
const OWNERS = ["creatorIssuanceMaintenanceObservationCarriers", "closedJournalObservationControl", "closedJournalDrainPlanCarriers",
	"closedJournalObservationRowsDigest", "closedRetirementBytes", "closedRetirementDigest", "closedObservationCarrierBytes"];
const compiled = new Function("encodeCanonical", "hashDomain", "CLOSED_RETIREMENT_BYTES", "CanonicalEncodingError", "requireLaw",
	"maintenanceWidthAtom", `${OWNERS.flatMap(name => declaration(name) ?? []).map(text => ts.transpile(text, { target: ts.ScriptTarget.ES2022 })).join("\n")}
	return {carriers: creatorIssuanceMaintenanceObservationCarriers, carrierBytes: closedObservationCarrierBytes};`)(
	encodeCanonical, hashDomain, CAP, CanonicalEncodingError,
	(ok: boolean, reason = "internal-invariant") => { if (!ok) throw new TypeError(reason); }, Symbol("maintenance-width")) as {
	carriers: (input: Record<string, unknown>) => readonly unknown[];
	carrierBytes: (value: unknown) => Uint8Array | undefined;
};

const objectId = "j19-room";
const hex = (seed: number) => (seed.toString(16).padStart(8, "0")).repeat(8);
const scopes = [0, 1, 2].map(epoch => ({ objectId, epoch, anchorDigest: hex(0xa0 + epoch) }));
// A received native row (SQLite shape): about 1,105 B per frame, as j19 measured.
function receivedFrame(scope: (typeof scopes)[number], sequence: number): Uint8Array {
	return encodeCanonical(["accepted_entries", [scope.objectId, scope.epoch, scope.anchorDigest, sequence], {
		journal_sequence: sequence, vertex_digest: hex(scope.epoch * 1000 + sequence), source_kind: "received",
		received_preimage: new Uint8Array(764).fill(sequence & 0xff), received_signature: new Uint8Array(64).fill(7) }]);
}
const header = (scope: (typeof scopes)[number], next: number) => encodeCanonical(["scopes",
	[scope.objectId, scope.epoch, scope.anchorDigest], { object_id: scope.objectId, epoch: scope.epoch,
		anchor_digest: scope.anchorDigest, next_journal_sequence: next }]);
const perEpoch = [385, 160, 147]; // 692 rows; epoch 0's 385 are collectible at epoch 2's adoption (throughEpoch 0).
const frames = scopes.map((scope, index) => Array.from({ length: perEpoch[index]! }, (_, sequence) => receivedFrame(scope, sequence)));
const canonicalRows = scopes.flatMap((scope, index) => [header(scope, perEpoch[index]!), ...frames[index]!]);
const rowsBytes = encodeCanonical(canonicalRows, { maxBytes: 4_194_304 }).byteLength;
const image = { imageDigest: hex(0xbeef), scopeCount: 3, rowCount: 692, byteCharge: rowsBytes };
const completed = { decisionDigest: hex(0xd1), sourceProofDigest: hex(0xd2), throughEpoch: 0,
	protectedScopes: [scopes[1], scopes[2]] };
const baseControl = { kind: "v3-live-journal-retirement-control-2", objectId, incarnation: hex(0xc0), revision: 6, sequence: 3,
	active: null, completed, drain: null };
function planFor(rows: readonly Uint8Array[]) {
	return { baseControl, sourceImage: image, prefixes: [{ scope: scopes[0], highWatermark: rows.length, rows: rows.map((bytes, sequence) => ({
		journalSequence: sequence, vertexDigest: hex(sequence), author: hex(0x5000 + (sequence % 4)), authorSequence: sequence,
		nativeFrameDigest: [...hashDomain("ts-drp/live-journal-native-frame/v1", bytes)].map(b => b.toString(16).padStart(2, "0")).join(""),
		exactCanonicalNativeFrameBytes: bytes })) }], retiredEmptyHeaders: [], protectedHeaderScopes: [scopes[1], scopes[2]] };
}
const drainControl = (plan: unknown, cursor = 0) => ({ ...baseControl, revision: 7 + cursor / 16, drain: { plan, cursor, batches: cursor / 16,
	residualImageDigest: hex(0xe0) } });
const rest = { snapshot: null, ahe: null, floor: null, floorImage: null, snapshotInventory: null };

describe("journal observation carrier at j19 widths (C1)", () => {
	it("the fixture has j19's widths: about 765 KB of rows, a plan of about 520 KB for epoch 0's 385 rows", () => {
		expect(rowsBytes).toBeGreaterThan(760_000);
		expect(rowsBytes).toBeLessThan(CAP.maxBytes);
		const planBytes = encodeCanonical(planFor(frames[0]!), { maxBytes: 4_194_304 }).byteLength;
		expect(planBytes).toBeGreaterThan(480_000);
		expect(planBytes).toBeLessThan(CAP.maxBytes);
	});

	it("a drain control's carrier fits the one encode cap: the plan rides by digest, not beside the rows it duplicates", () => {
		const carrier = compiled.carriers({ journal: { control: drainControl(planFor(frames[0]!)), image, canonicalRows }, ...rest })[0];
		const bytes = compiled.carrierBytes(carrier);
		const width = encodeCanonical(carrier, { maxBytes: 4_194_304 }).byteLength;
		expect(width, `journal observation carrier ${width}/${CAP.maxBytes}`).toBeLessThanOrEqual(CAP.maxBytes);
		expect(bytes).toBeDefined();
		// Rows plus less than 4 KB: the control (with its base control), image and one {scope, highWatermark, rowsDigest} prefix.
		expect(width - rowsBytes).toBeLessThan(4_096);
	});

	it("every journal observation carrier the owner encodes or sizes holds its control through the one projection", () => {
		// The real carriers (creatorIssuanceMaintenanceObservationCarriers) and every forecast/readiness mirror of them:
		// {control, image, canonicalRows} records given to an encoder or width measure. A mirror that kept the whole plan
		// would refuse what the carrier itself now encodes (or admit what it cannot).
		const MEASURES = new Set(["closedRetirementBytes", "maintenanceCanonicalWidth", "observe", "exactWidth", "record",
			"canonicalRecordResourceForSizing"]);
		const unwrap = (node: ts.Expression): ts.Expression =>
			ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ? unwrap(node.expression) : node;
		const projected = (node: ts.Expression): boolean => {
			const value = unwrap(node);
			if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return false;
			if (value.expression.text === "closedJournalObservationControl") return true;
			// A resource footprint of the projected control (readiness geometry).
			return value.expression.text === "resource" && value.arguments.length === 1 && projected(value.arguments[0]!);
		};
		const offenders: string[] = [];
		const check = (literal: ts.ObjectLiteralExpression, viaOwner: boolean): void => {
			const names = literal.properties.map(property => property.name?.getText(parsed));
			if (!names.includes("control") || !names.includes("image") || !names.includes("canonicalRows")) return;
			const control = literal.properties.find(property => property.name?.getText(parsed) === "control");
			const initializer = control !== undefined && ts.isPropertyAssignment(control) ? control.initializer : undefined;
			// The resource program's journalControl composes its drain from the owner (checked below).
			if (initializer !== undefined && ts.isIdentifier(initializer) && initializer.text === "journalControl") return;
			// creatorIssuanceMaintenanceObservationCarriers projects a value or width-tree control itself; a footprint must
			// already be the projection's.
			if (initializer !== undefined && (projected(initializer) || (viaOwner && !(ts.isCallExpression(unwrap(initializer)) &&
				(unwrap(initializer) as ts.CallExpression).expression.getText(parsed) === "resource")))) return;
			offenders.push(`${parsed.getLineAndCharacterOfPosition(literal.getStart()).line + 1}: ${literal.getText(parsed).slice(0, 90)}`);
		};
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				const callee = node.expression.text;
				for (const argument of node.arguments) {
					const value = unwrap(argument);
					if (!ts.isObjectLiteralExpression(value)) continue;
					if (MEASURES.has(callee)) check(value, false);
					if (callee === "creatorIssuanceMaintenanceObservationCarriers")
						for (const property of value.properties)
							if (ts.isPropertyAssignment(property) && property.name.getText(parsed) === "journal" &&
								ts.isObjectLiteralExpression(unwrap(property.initializer)))
								check(unwrap(property.initializer) as ts.ObjectLiteralExpression, true);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		expect(offenders).toEqual([]);
		const owner = declaration("creatorIssuanceMaintenanceObservationCarriers") ?? "";
		expect(owner).toMatch(/closedJournalObservationControl\(/u);
		// The resource program's semantic journal progress holds the owner's observed plan.
		const progress = source.slice(source.indexOf("const semanticJournalProgress"), source.indexOf("const journalControl = maximum("));
		expect(progress).toMatch(/drain: record\(\{plan: observedJournalPlan,/u);
		expect(source).toMatch(/const observedJournalPlan = closedJournalDrainPlanCarriers\(/u);
	});

	it("a carrier with no drain is unchanged", () => {
		const carrier = compiled.carriers({ journal: { control: baseControl, image, canonicalRows }, ...rest })[0];
		expect(encodeCanonical(carrier, { maxBytes: 4_194_304 })).toEqual(
			encodeCanonical({ control: baseControl, image, canonicalRows }, { maxBytes: 4_194_304 }));
	});
});

// What the projection must not weaken: the exact plan stays the native carrier, compared byte for byte and charged on its
// own; the carrier's digest still distinguishes every plan; sizing mirrors measure the same projection.
const requireLaw = (ok: unknown, reason = "internal-invariant") => { if (!ok) throw new TypeError(reason); };
const owner = (names: readonly string[], bindings: Record<string, unknown>) => new Function(...Object.keys(bindings),
	`"use strict"; ${names.map(name => ts.transpile(declaration(name)!, { target: ts.ScriptTarget.ES2022 })).join("\n")}
	return {${names.join(", ")}};`)(...Object.values(bindings)) as Record<string, (...args: any[]) => any>;
const closedRetirementBytes = (value: unknown) => encodeCanonical(value, CAP);
const closedRetirementDigest = (domain: string, ...parts: readonly Uint8Array[]) =>
	[...hashDomain(domain, ...parts)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const plans = owner(["closedJournalDrainPlanCarriers", "closedJournalObservationRowsDigest", "closedJournalObservationControl"],
	{ closedRetirementBytes, closedRetirementDigest, requireLaw, maintenanceWidthAtom: Symbol("maintenance-width") });
// A small valid native drain (local rows: the codec validates them without received frames).
const digest = "d".repeat(64), roomScope = { objectId: "room", epoch: 0, anchorDigest: digest };
const nativeBase: LiveJournalRetirementControl = { kind: "v3-live-journal-retirement-control-2", objectId: "room", incarnation: digest,
	revision: 2, sequence: 1, active: null, drain: null, completed: { decisionDigest: digest, sourceProofDigest: digest, throughEpoch: 0,
		protectedScopes: [] } };
const nativePlan = (vertexSeed = 0) => ({ baseControl: nativeBase, sourceImage: { imageDigest: digest, scopeCount: 1, rowCount: 17, byteCharge: 1 },
	prefixes: [{ scope: roomScope, highWatermark: 17, rows: Array.from({ length: 17 }, (_, journalSequence) => ({ journalSequence,
		vertexDigest: (journalSequence + vertexSeed).toString(16).padStart(64, "0"), author: "writer", authorSequence: journalSequence + 1,
		nativeFrameDigest: digest })) }] });
const nativeDrain = (plan: ReturnType<typeof nativePlan>): LiveJournalRetirementControl => ({ ...nativeBase, revision: 3,
	drain: { plan, cursor: 0, batches: 0, residualImageDigest: digest } });

describe("C1 keeps the exact plan where it was", () => {
	const native = owner(["closedJournalReconstructedControlCarriers", "closedJournalNativeObservationEqual", "closedJournalNativeControlCarriers"], {
		capturePromotionRecord, capturePromotionArray, capturePromotionBytes, compareBytes, LIVE_JOURNAL_RETIREMENT_LIMITS,
		LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, encodeJournalRetirementNativeCarriers, requireLaw, closedRetirementBytes,
		closedRetirementEqual: (a: unknown, b: unknown) => Buffer.from(encodeCanonical(a)).equals(Buffer.from(encodeCanonical(b))) });
	const observation = (control: LiveJournalRetirementControl) => {
		const carriers = encodeJournalRetirementNativeCarriers(control);
		return { control, exactCanonicalControlCarriers: [carriers.controlBytes, carriers.planBytes!],
			image: { imageDigest: digest, scopeCount: 1, rowCount: 1, byteCharge: 9 }, canonicalRows: [Uint8Array.of(1, 2, 3)] };
	};

	it("native control carriers are still compared byte for byte, plan included", () => {
		const value = observation(nativeDrain(nativePlan()));
		expect(native.closedJournalNativeObservationEqual(value, observation(nativeDrain(nativePlan())))).toBe(true);
		// One plan row differs: the native comparison refuses, through the full plan carrier.
		const other = observation(nativeDrain(nativePlan(1)));
		expect(native.closedJournalNativeObservationEqual(value, other)).toBe(false);
		const flipped = value.exactCanonicalControlCarriers.map(bytes => bytes.slice()); flipped[1]![flipped[1]!.length - 1] ^= 1;
		expect(native.closedJournalNativeObservationEqual(value, { ...value, exactCanonicalControlCarriers: flipped })).toBe(false);
	});

	it("native control carriers are still charged separately: the plan once, whole, beside the projected carrier", () => {
		const control = nativeDrain(nativePlan());
		const value = observation(control);
		const charged = native.closedJournalNativeControlCarriers(value) as readonly Uint8Array[];
		expect(charged).toEqual(value.exactCanonicalControlCarriers);
		expect(charged[1]).toEqual(encodeCanonical(nativePlan(), { maxBytes: LIVE_JOURNAL_RETIREMENT_CONTROL_MAX_BYTES, maxItems: 65_536, maxDepth: 32 }));
		const carrier = compiled.carriers({ journal: value, ...rest })[0] as { control: { drain: { plan: unknown } } };
		expect(JSON.stringify(carrier.control.drain.plan)).not.toContain("authorSequence");
		// Each real acquisition charges the projected carriers and then every native control carrier, separately.
		const sites = [...source.matchAll(/creatorIssuanceMaintenanceObservationCarriers\(\{journal: journal\.value,/gu)];
		expect(sites.length).toBeGreaterThanOrEqual(1);
		for (const site of sites)
			expect(source.slice(site.index, site.index + 700)).toContain("for (const bytes of closedJournalNativeControlCarriers(journal.value))");
	});

	it("the carrier's digest distinguishes plans that differ only in their rows (mutant: a carrier without rowsDigest)", () => {
		const left = plans.closedJournalObservationControl(nativeDrain(nativePlan())) as { drain: { plan: { prefixes: { rowsDigest: string }[] } } };
		const right = plans.closedJournalObservationControl(nativeDrain(nativePlan(1)));
		expect(encodeCanonical(left)).not.toEqual(encodeCanonical(right));
		expect(left.drain.plan.prefixes[0]!.rowsDigest).toBe(plans.closedJournalObservationRowsDigest(nativePlan().prefixes[0]!.rows));
		// Frames too: j19's received rows differ only inside exactCanonicalNativeFrameBytes.
		const altered = frames[0]!.map(bytes => bytes.slice()); altered[200]![300] ^= 1;
		const a = compiled.carriers({ journal: { control: drainControl(planFor(frames[0]!)), image, canonicalRows }, ...rest })[0];
		const b = compiled.carriers({ journal: { control: drainControl(planFor(altered)), image, canonicalRows }, ...rest })[0];
		expect(encodeCanonical(a, { maxBytes: 4_194_304 })).not.toEqual(encodeCanonical(b, { maxBytes: 4_194_304 }));
		// Retired empty headers ride by digest too.
		const withHeaders = (bytes: Uint8Array) => plans.closedJournalObservationControl({ ...baseControl, drain: { plan: { ...planFor([]),
			retiredEmptyHeaders: [{ scope: scopes[1], exactCanonicalNativeFrameBytes: bytes }] }, cursor: 0, batches: 0, residualImageDigest: digest } });
		expect(encodeCanonical(withHeaders(Uint8Array.of(1)))).not.toEqual(encodeCanonical(withHeaders(Uint8Array.of(2))));
	});

	it("a sizing mirror measures the same projection: a digest-width leaf has the real digest's width", () => {
		const control = drainControl(planFor(frames[0]!));
		const real = encodeCanonical(plans.closedJournalObservationControl(control), CAP).byteLength;
		const sized = encodeCanonical(plans.closedJournalObservationControl(control, () => "0".repeat(64)), CAP).byteLength;
		expect(sized).toBe(real);
	});
});

describe("single-epoch plan bound (readiness, same owner as the carrier)", () => {
	const sizing = owner(["closedJournalCurrentEpochPlanWidthForSizing", "closedJournalDrainPlanCarriers", "creatorOrdinaryJournalDescriptorGroupsForSizing",
		"creatorOrdinaryNativeJournalFrames", "creatorOrdinarySizingRecord", "maintenanceEncodedWidth", "maintenanceEncodedBytes",
		"maintenanceCanonicalWidth", "maintenanceCanonicalCapacityWidth", "maintenanceWidthSum", "maintenanceVarUintWidth", "closedRetirementBytes"], {
		decodeCanonical, encodeCanonical, CLOSED_RETIREMENT_BYTES: CAP, AHE_BOUNDED_READ_LIMITS, ISSUANCE_RETIREMENT_LIMITS,
		LIVE_JOURNAL_RETIREMENT_LIMITS, CREATOR_MAINTENANCE_PROOF_MAX_BYTES: LOCAL_WORKLOAD_CAPACITY.maintenanceProofBytes,
		maintenanceWidthAtom: Symbol("maintenance-width"), JOURNAL_POSTIMAGE_NOT_GROWN });
	// An append always adds a row of positive width (a postimage that did not grow refuses typed); a local row is planned by
	// reference, so its frame width does not change the plan width and the default is just a real row's width.
	const width = (rows: readonly Uint8Array[], scope: (typeof scopes)[number], appendReceived = false, appendFrame = rows.at(-1)!.byteLength) =>
		sizing.closedJournalCurrentEpochPlanWidthForSizing({ canonicalRows: rows, currentScope: scope,
			afterLocalCanonicalRowBytes: [...rows.map(bytes => bytes.byteLength), appendFrame], appendCount: 1, appendReceived,
			author: "creator" }) as number;

	it("measures the plan codec's per-row cost: at least the actual plan, and the collectible-to-plan ratio is derived", () => {
		const epoch0 = [canonicalRows[0]!, ...frames[0]!];
		const bound = width(epoch0, scopes[0]!);
		const actual = encodeCanonical(planFor(frames[0]!), { maxBytes: 4_194_304 }).byteLength;
		expect(bound).toBeGreaterThanOrEqual(actual);
		expect(bound).toBeLessThan(actual * 1.1);
		// About 0.82 collectible bytes per plan byte at j19's row width: frame over frame-plus-descriptor.
		const collectible = frames[0]!.reduce((total, bytes) => total + bytes.byteLength, 0);
		expect(collectible / bound).toBeGreaterThan(0.75);
		expect(collectible / bound).toBeLessThan(0.9);
		expect(bound).toBeLessThan(CAP.maxBytes);
	});

	it("refuses the admission that would make one epoch's own plan outgrow the cap", () => {
		const scope = scopes[0]!;
		const many = Array.from({ length: 640 }, (_, sequence) => receivedFrame(scope, sequence));
		expect(width([header(scope, many.length), ...many], scope)).toBeGreaterThan(CAP.maxBytes);
		// One more received row: its whole canonical growth is charged as a frame.
		const fits = many.slice(0, 500);
		const before = width([header(scope, fits.length), ...fits], scope);
		const after = width([header(scope, fits.length), ...fits], scope, true, fits[0]!.byteLength);
		expect(after - before).toBeGreaterThanOrEqual(fits[0]!.byteLength);
	});

	it("the composer and the template evaluator both bound the same function's width", () => {
		expect(source.match(/closedJournalCurrentEpochPlanWidthForSizing\(\{/gu)?.length).toBe(2);
		expect(source).toMatch(/compiler\?\.bind\("journal\.currentEpochPlan", currentEpochPlanWidth\)/u);
		expect(source).toMatch(/set\("journal\.currentEpochPlan", closedJournalCurrentEpochPlanWidthForSizing\(/u);
		expect(declaration("closedJournalCurrentEpochPlanWidthForSizing")).toMatch(/closedJournalDrainPlanCarriers\(/u);
		expect(declaration("closedJournalCurrentEpochPlanWidthForSizing")).not.toMatch(/0\.8\d/u);
	});
});

