import {encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {describe, expect, it} from "vitest";
import {ISSUANCE_RETIREMENT_LIMITS, issuanceSettlementReplacementReserveCharge, issuanceSettlementReserveForecast,
	captureIssuanceNativeSignContext,
	type IssuanceRetirementRows} from "../src/retirement.js";

// fix/maintenance-image-capacity: a settlement-profile Writer's own move is admitted only if one
// settlement replacement of every own row of its epoch still fits its issuance bound. The creator
// may close the epoch without any of them, and the Writer then replaces each at its successor's
// install; that work must never be refused (it deadlocked the install's drainRebaseOutbox).
const scope = {objectId: "settlement-replacement-reserve", author: "a".repeat(64)};
const MAX_DEPENDENCIES = 16;
const digestHex = (seed: number): string => seed.toString(16).padStart(64, "0");

function preimage(sequence: number, epoch: number, dependencies: number, operationBytes: number, settlementSource?: unknown): Uint8Array {
	return encodeCanonical({
		anchor: digestHex(epoch + 1),
		author: scope.author,
		authorSequence: sequence,
		dependencies: Array.from({length: dependencies}, (_, index) => digestHex(1_000_000 + sequence * 32 + index)).sort(),
		epoch,
		kind: "drp-vertex",
		logicalTime: 1_000 + 2 * sequence,
		objectId: scope.objectId,
		operation: {action: "place", id: `block-1-${sequence}`, payload: "x".repeat(operationBytes), x: sequence % 16, y: 3},
		protocolMajor: 3,
		...(settlementSource === undefined ? {} : {settlementSource}),
	});
}
const digestOf = (bytes: Uint8Array): Uint8Array => hashDomain("ts-drp/vertex/v3", bytes);
const signature = new Uint8Array(64).fill(7);

/** The Writer's rows after `count` own moves in `epoch` (sequence 0 onward), each with one dependency. */
function writerRows(count: number, epoch: number, operationBytes: number): IssuanceRetirementRows {
	const issued = Array.from({length: count}, (_, authorSequence) => {
		const canonicalPreimageBytes = preimage(authorSequence, epoch, 1, operationBytes);
		return {...scope, authorSequence, canonicalPreimageBytes, digest: digestOf(canonicalPreimageBytes), signature};
	});
	return {
		lineages: [{...scope, next: count, exhausted: false, prunedThroughAuthorSequence: null}],
		issued,
		outbox: issued.map(row => ({...scope, authorSequence: row.authorSequence, digest: row.digest, publishState: "published" as const})),
		plans: [],
	};
}
function move(sequence: number, epoch: number, operationBytes: number) {
	const canonicalPreimageBytes = preimage(sequence, epoch, 1, operationBytes);
	return {authorSequence: sequence, canonicalPreimageBytes, digest: digestOf(canonicalPreimageBytes)};
}

/**
 * The settlement at the successor's install when the creator accepted none of the epoch's
 * moves: the fence, then one replacement per source (maximum dependencies, the next epoch),
 * and the plan naming every source with its replacement.
 */
function settled(rows: IssuanceRetirementRows, sources: number, epoch: number, operationBytes: number): IssuanceRetirementRows {
	let next = rows.lineages[0]!.next;
	const fencePreimage = encodeCanonical({anchor: digestHex(epoch + 2), author: scope.author, authorSequence: next,
		dependencies: Array.from({length: MAX_DEPENDENCIES}, (_, index) => digestHex(9_000_000 + index)),
		epoch: epoch + 1, kind: "drp-vertex", logicalTime: Number.MAX_SAFE_INTEGER, objectId: scope.objectId,
		operation: {action: "$drp.authorFence", fenceSequence: next}, protocolMajor: 3});
	const fence = {...scope, authorSequence: next++, canonicalPreimageBytes: fencePreimage, digest: digestOf(fencePreimage), signature};
	const replacements = Array.from({length: sources}, (_, index) => {
		const canonicalPreimageBytes = preimage(next + index, epoch + 1, MAX_DEPENDENCIES, operationBytes);
		return {...scope, authorSequence: next + index, canonicalPreimageBytes, digest: digestOf(canonicalPreimageBytes), signature};
	});
	const issued = [...rows.issued, fence, ...replacements];
	const sourceRows = rows.issued.slice(rows.issued.length - sources);
	return {
		lineages: [{...scope, next: next + sources, exhausted: false, prunedThroughAuthorSequence: null}],
		issued,
		outbox: issued.map(row => ({...scope, authorSequence: row.authorSequence, digest: row.digest, publishState: "published" as const})),
		plans: [{scope, revision: 1_000, fenceSequence: fence.authorSequence,
			entries: sourceRows.map((source, index) => ({sourceSequence: source.authorSequence, sourceDigest: source.digest,
				disposition: "rebase" as const, replacementSequence: replacements[index]!.authorSequence}))}],
	};
}
const rowCount = (rows: IssuanceRetirementRows): number =>
	rows.lineages.length + rows.issued.length + rows.outbox.length + rows.plans.length;

describe("settlement replacement reserve", () => {
	it.each([
		["rows bind (small moves)", 64, "row"],
		["bytes bind (large moves)", 1_800, "byte"],
	] as const)("%s: the last admitted move's whole epoch still settles; the next is refused, typed", (_, operationBytes, bound) => {
		const epoch = 7;
		let admitted = 0;
		for (;; admitted++) {
			try {
				issuanceSettlementReplacementReserveCharge(writerRows(admitted, epoch, operationBytes), scope,
					move(admitted, epoch, operationBytes), {maxDependencies: MAX_DEPENDENCIES});
			} catch (error) {
				expect(String(error)).toContain(`unsigned postimage exceeds ${bound} bound with its settlement replacement reserve`);
				break;
			}
		}
		expect(admitted).toBeGreaterThan(10);
		// Every admitted move of the epoch (sequence 0..admitted-1) is replaced under the bound.
		const after = settled(writerRows(admitted, epoch, operationBytes), admitted, epoch, operationBytes);
		expect(rowCount(after)).toBeLessThanOrEqual(ISSUANCE_RETIREMENT_LIMITS.maxRows);
		expect(encodeCanonical(after).byteLength).toBeLessThanOrEqual(ISSUANCE_RETIREMENT_LIMITS.maxBytes);
		// Without the reserve the store would have admitted moves whose settlement it cannot hold.
		const unreserved = settled(writerRows(2 * admitted, epoch, operationBytes), 2 * admitted, epoch, operationBytes);
		expect(rowCount(unreserved) > ISSUANCE_RETIREMENT_LIMITS.maxRows ||
			encodeCanonical(unreserved).byteLength > ISSUANCE_RETIREMENT_LIMITS.maxBytes).toBe(true);
	});

	it("reserves only the move's own epoch: rows of earlier epochs are settled already", () => {
		const rows = writerRows(300, 3, 64);
		// 300 own rows of epoch 3; a move of epoch 4 reserves for itself alone.
		const charged = issuanceSettlementReplacementReserveCharge(rows, scope, move(300, 4, 64), {maxDependencies: MAX_DEPENDENCIES});
		expect(charged.sources).toBe(1);
		expect(() => issuanceSettlementReplacementReserveCharge(rows, scope, move(300, 3, 64), {maxDependencies: MAX_DEPENDENCIES}))
			.toThrow("settlement replacement reserve");
	});

	it("is a closed sign-context field for an ordinary or handed-back move only", () => {
		const reserve = {maxDependencies: MAX_DEPENDENCIES};
		expect(captureIssuanceNativeSignContext({settlementReplacementReserve: reserve})).toEqual({settlementReplacementReserve: reserve});
		const handBack = {kind: "hand-back" as const, intent: 0, sourceSequence: 1};
		expect(captureIssuanceNativeSignContext({planEffect: handBack, settlementReplacementReserve: reserve}))
			.toEqual({planEffect: handBack, settlementReplacementReserve: reserve});
		expect(() => captureIssuanceNativeSignContext({planEffect: {kind: "fence"}, settlementReplacementReserve: reserve})).toThrow();
		expect(() => captureIssuanceNativeSignContext({settlementReplacementReserve: {maxDependencies: 0}})).toThrow();
		expect(() => captureIssuanceNativeSignContext({settlementReplacementReserve: {maxDependencies: 4, extra: 1}})).toThrow();
	});

	// fix/capacity-refusal-prompt-roll: the creator forecasts each Writer's admission from counts and a
	// preimage bound (issuanceSettlementReserveForecast). Its answer must never exceed what the Writer's
	// own admission admits: a forecast that is too high lets the Writer hit its wall before the creator rolls.
	it("the creator's forecast never reports more admissible moves than the Writer's own admission", () => {
		let seed = 0x5eed;
		const random = (limit: number): number => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed % limit;
		};
		const epoch = 9;
		const cases: {retained: number; epochRows: number; forecast: number; admitted: number}[] = [];
		for (let index = 0; index < 14; index++) {
			const retained = random(320);
			const epochRows = random(90);
			const large = index % 3 === 2;
			const operationBytes = (): number => (large ? 400 + random(2_200) : random(200));
			const dependencies = (): number => random(MAX_DEPENDENCIES + 1);
			const issued: IssuanceRetirementRows["issued"][number][] = [];
			for (let sequence = 0; sequence < retained + epochRows; sequence++) {
				const canonicalPreimageBytes = preimage(sequence, sequence < retained ? epoch - 1 : epoch,
					dependencies(), operationBytes());
				issued.push({...scope, authorSequence: sequence, canonicalPreimageBytes, digest: digestOf(canonicalPreimageBytes), signature});
			}
			const withPlan = index % 2 === 1 && retained > 0;
			const planned = issued.slice(0, Math.min(retained, random(retained + 1)));
			const futures = Array.from({length: 1_100}, () => [dependencies(), operationBytes()] as const);
			let bound = Math.max(0, ...issued.map((row) => row.canonicalPreimageBytes.byteLength));
			const futureRows = futures.map(([deps, bytes], offset) => preimage(retained + epochRows + offset, epoch, deps, bytes));
			bound = Math.max(bound, ...futureRows.map((bytes) => bytes.byteLength));
			const rowsWith = (extra: number): IssuanceRetirementRows => {
				const all = [...issued, ...futureRows.slice(0, extra).map((canonicalPreimageBytes, offset) => ({...scope,
					authorSequence: retained + epochRows + offset, canonicalPreimageBytes, digest: digestOf(canonicalPreimageBytes), signature}))];
				return {
					lineages: [{...scope, next: all.length, exhausted: false, prunedThroughAuthorSequence: null}],
					issued: all,
					outbox: all.map((row) => ({...scope, authorSequence: row.authorSequence, digest: row.digest, publishState: "published" as const})),
					plans: withPlan ? [{scope, revision: 1_000, fenceSequence: 0, entries: planned.map((source, entry) => ({
						sourceSequence: source.authorSequence, sourceDigest: source.digest, disposition: "rebase" as const,
						replacementSequence: entry}))}] : [],
				};
			};
			let admitted = 0;
			for (;; admitted++) {
				const rows = rowsWith(admitted);
				const next = futureRows[admitted]!;
				try {
					issuanceSettlementReplacementReserveCharge(rows, scope, {authorSequence: rows.lineages[0]!.next,
						canonicalPreimageBytes: next, digest: digestOf(next)}, {maxDependencies: MAX_DEPENDENCIES});
				} catch (error) {
					if (!String(error).includes("settlement replacement reserve") && !String(error).includes("exceeds")) throw error;
					break;
				}
			}
			const forecast = issuanceSettlementReserveForecast({scope, maxDependencies: MAX_DEPENDENCIES, retainedRows: retained,
				epochRows, rowPreimageBytes: bound});
			cases.push({retained, epochRows, forecast, admitted});
			expect(forecast, JSON.stringify(cases.at(-1))).toBeLessThanOrEqual(admitted);
		}
		// Conservative, not useless: where rows bind (small moves) the forecast stays close to the Writer's own answer.
		for (const row of cases.filter((_, index) => index % 3 !== 2 && _.admitted > 8))
			expect(row.forecast, JSON.stringify(row)).toBeGreaterThanOrEqual(Math.floor(row.admitted * 0.6) - 4);
		console.log(`RESERVE_FORECAST ${JSON.stringify(cases)}`);
	}, 120_000);
});

