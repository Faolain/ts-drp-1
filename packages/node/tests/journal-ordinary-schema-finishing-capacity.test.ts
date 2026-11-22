import {readFileSync} from "node:fs";
import * as canonical from "@ts-drp/canonical";
import * as resources from "@ts-drp/canonical/resource";
import {AHE_BOUNDED_READ_LIMITS} from "@ts-drp/storage";
import * as ts from "typescript";
import {describe, expect, it, vi} from "vitest";
import * as codec from "../../live-journal/src/retirement.js";
import {anchorMaterial} from "../../../tests/fixtures/journal-anchor-read/material.js";

// Actual private numerical bodies and original exact forecast oracle only.
// Fixture signatures/rows confer no native currency, authentication or allowance.
const sourcePath = new URL("../../live-journal/src/retirement.ts", import.meta.url);
const tree = ts.createSourceFile(sourcePath.pathname, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
function extract(name: string): string {
	const declarations = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (declarations.length !== 1) throw Error(`JOURNAL_SCHEMA_ACTUAL_OWNER:${name}:${declarations.length}`);
	return declarations[0]!.getText(tree).replace(/^export /u, "");
}
type Input = {actualCanonicalRows: readonly Uint8Array[]; currentScope: ReturnType<typeof anchorMaterial>["scope"];
	canonicalPreimageByteLength: number; canonicalAuthorByteLength: number; successorAnchorByteLength: number;
	parametersByteLength: number; closedMembershipByteLength: number;
	maxAdditionalCurrentRows?: number;
	futureRows?: codec.JournalOrdinaryFutureRows;
	successorFenceCount?: 0 | 1; successorFencePreimageByteLength?: number};
type Capacity = {scopeCount: number; rowCount: number; canonicalRowByteLengthsTotal: number; canonicalRowsBytes: number;
	nativeImageBytes: number; additionalFrameByteLength: number; successorFenceFrameByteLength: number;
	canonicalRows: resources.CanonicalResourceFootprint; newHeaderRow: resources.CanonicalResourceFootprint;
	newHeaderFrame: resources.CanonicalResourceFootprint};
const hex = tree.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
	.filter(node => ts.isIdentifier(node.name) && node.name.text === "hex");
if (hex.length !== 1) throw Error("JOURNAL_SCHEMA_ACTUAL_HEX");
const bodies = ["record", "integer", "digest", "scope", "equalNative", "dense", "encodeNativeImagePart", "nativeScopeEncoding",
	"varUintWidth", "futureWidths", "decodeNativeFrames", "journalUnsignedSuccessorHeaderFields", "journalOrdinaryFinishingCapacityProjection",
	"journalOrdinaryFinishingCapacityFromGeometry", "journalOrdinarySchemaCapacityFromGeometry", "journalOrdinarySchemaFinishingCapacityWidths"];
const code = `const ${hex[0]!.getText(tree)};\n${bodies.map(extract).join("\n")}\njournalOrdinarySchemaFinishingCapacityWidths;`;
const bindings = {...codec, ...canonical, ...resources, AHE_BOUNDED_READ_LIMITS};
const emitted = ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
const owner = Function(...Object.keys(bindings), `"use strict"; return eval(${JSON.stringify(emitted)});`)(...Object.values(bindings)) as (input: Input) => Capacity;
function countedOwner() {
	const calls = {decode: 0, canonicalFrame: 0, rowCharge: 0};
	const observed = {...bindings,
		decodeCanonical: (...args: Parameters<typeof canonical.decodeCanonical>) => {calls.decode++; return canonical.decodeCanonical(...args);},
		journalRetirementCanonicalRow: (...args: Parameters<typeof codec.journalRetirementCanonicalRow>) => {
			calls.canonicalFrame++; return codec.journalRetirementCanonicalRow(...args);
		},
		journalRetirementRowCharge: (...args: Parameters<typeof codec.journalRetirementRowCharge>) => {
			calls.rowCharge++; return codec.journalRetirementRowCharge(...args);
		},
	};
	return {calls, run: Function(...Object.keys(observed), `"use strict"; return eval(${JSON.stringify(emitted)});`)(...Object.values(observed)) as typeof owner};
}

function countedPreparedProjection() {
	const calls = {decode: 0, canonicalFrame: 0, rowCharge: 0};
	const observed = {...bindings,
		decodeCanonical: (...args: Parameters<typeof canonical.decodeCanonical>) => {calls.decode++; return canonical.decodeCanonical(...args);},
		journalRetirementCanonicalRow: (...args: Parameters<typeof codec.journalRetirementCanonicalRow>) => {calls.canonicalFrame++; return codec.journalRetirementCanonicalRow(...args);},
		journalRetirementRowCharge: (...args: Parameters<typeof codec.journalRetirementRowCharge>) => {calls.rowCharge++; return codec.journalRetirementRowCharge(...args);},
	};
	const source = `const ${hex[0]!.getText(tree)};\n${[...bodies,
		"prepareJournalOrdinaryFinishingCapacityProjection", "createJournalOrdinaryProjectionCell"].map(extract).join("\n")}\nprepareJournalOrdinaryFinishingCapacityProjection;`;
	const emitted = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return {calls, prepare: Function(...Object.keys(observed), `"use strict"; return eval(${JSON.stringify(emitted)});`)(...Object.values(observed)) as typeof codec.prepareJournalOrdinaryFinishingCapacityProjection};
}

const rollbackSource = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const rollbackTree = ts.createSourceFile("rollback.ts", rollbackSource, ts.ScriptTarget.Latest, true);
const headerDrainOwner = rollbackTree.statements.find((node): node is ts.FunctionDeclaration =>
	ts.isFunctionDeclaration(node) && node.name?.text === "closedJournalHeaderDrainWidthsForSizing");
if (headerDrainOwner === undefined) throw Error("missing ORIGINAL full-composer header owner");
const fullHeaderDrain = new Function("decodeCanonical", "maintenanceCanonicalWidth", "maintenanceEncodedWidth",
	"maintenanceWidthSum", "maintenanceVarUintWidth", "LIVE_JOURNAL_RETIREMENT_BATCH_ROWS",
	ts.transpileModule(`${headerDrainOwner.getText(rollbackTree)}\nreturn closedJournalHeaderDrainWidthsForSizing;`,
		{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText)(
	canonical.decodeCanonical, (value: unknown) => canonical.encodeCanonical(value).byteLength,
	(byteLength: number) => ({byteLength}), (parts: number[]) => parts.reduce((a, b) => a + b, 0),
	(value: number) => {let width = 1; while (value >= 128) {value = Math.floor(value / 128); width++;} return width;},
	codec.LIVE_JOURNAL_RETIREMENT_BATCH_ROWS);

function fixture(sql: boolean, count: number, epoch = 0, wideAuthorSequence = false, oldMembership = 0) {
	const current = anchorMaterial(epoch), successor = anchorMaterial(epoch + 1), context = current.scope, author = "1".repeat(64);
	const sequenceBase = wideAuthorSequence ? Number.MAX_SAFE_INTEGER - count - 4 : 0;
	const parametersDigest = (canonical.decodeCanonical(current.bytes) as {parametersDigest: string}).parametersDigest;
	const header = (material: ReturnType<typeof anchorMaterial>, next: number, membership: number) => sql ? {
		object_id: material.scope.objectId, epoch: material.scope.epoch, anchor_digest: material.scope.anchorDigest,
		next_journal_sequence: next, exact_anchor_preimage: material.bytes, detached_anchor_signature: material.install.detachedAnchorSignature,
		parameters_digest: parametersDigest, exact_parameters_carrier: material.install.exactCanonicalParametersCarrierBytes,
		closed_membership_bytes: membership === 0 ? null : new Uint8Array(membership),
	} : {...material.scope, nextJournalSequence: next, exactCanonicalAnchorPreimageBytes: material.bytes,
		detachedAnchorSignature: material.install.detachedAnchorSignature, parametersDigest,
		exactCanonicalParametersCarrierBytes: material.install.exactCanonicalParametersCarrierBytes,
		...(membership === 0 ? {} : {closedMembershipBytes: new Uint8Array(membership)})};
	const local = (ordinal: number, scope = context) => ({scope, sourceKind: "local-issued" as const, author,
		authorSequence: sequenceBase + ordinal,
		vertexDigest: Buffer.from(canonical.hashDomain("ts-drp/journal-capacity-fixture/v1", canonical.encodeCanonical({scope, ordinal}))).toString("hex")});
	const row = (ordinal: number, scope = context) => sql ? {object_id: scope.objectId, epoch: scope.epoch, anchor_digest: scope.anchorDigest,
		journal_sequence: ordinal, source_kind: "local-issued",
		vertex_digest: local(ordinal, scope).vertexDigest, local_author: author, local_author_sequence: sequenceBase + ordinal,
		received_preimage: null, received_signature: null} : {...scope, journalSequence: ordinal, sourceKind: "local-issued",
		vertexDigest: local(ordinal, scope).vertexDigest, localAuthor: author, localAuthorSequence: sequenceBase + ordinal};
	const frame = (table: string, scope: typeof context, value: unknown, ordinal?: number) => codec.journalRetirementCanonicalRow(table,
		[scope.objectId, scope.epoch, scope.anchorDigest, ...(ordinal === undefined ? [] : [ordinal])], value);
	const table = sql ? "accepted_entries" : "acceptedEntries";
	const frames = [frame("scopes", context, header(current, count, oldMembership)),
		...Array.from({length: count}, (_, ordinal) => frame(table, context, row(ordinal), ordinal))];
	const install = {objectId: context.objectId, exactCanonicalAnchorPreimageBytes: successor.bytes,
		exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes};
	const input: Input = {actualCanonicalRows: frames, currentScope: context, canonicalPreimageByteLength: 512,
		canonicalAuthorByteLength: canonical.encodeCanonical(author).byteLength, successorAnchorByteLength: successor.bytes.byteLength,
		parametersByteLength: successor.install.exactCanonicalParametersCarrierBytes.byteLength, closedMembershipByteLength: 128};
	const finalFrames = (fence: boolean) => [frame("scopes", context, header(current, count + 1, oldMembership || 128)),
		...frames.slice(1), frame(table, context, row(count), count),
		frame("scopes", successor.scope, header(successor, fence ? 1 : 0, 0)),
		...(fence ? [frame(table, successor.scope, {...row(count + 1, successor.scope), [sql ? "journal_sequence" : "journalSequence"]: 0}, 0)] : [])];
	return {input, frames, current, successor, local, install, author, count, sequenceBase, finalFrames};
}
function dominates(bound: Capacity, exact: codec.JournalFutureNativeWidths): void {
	for (const key of ["scopeCount", "rowCount", "canonicalRowsBytes", "nativeImageBytes"] as const)
		expect(bound[key], key).toBeGreaterThanOrEqual(exact[key]);
	expect(bound.canonicalRowByteLengthsTotal).toBeGreaterThanOrEqual(exact.canonicalRowBytes.reduce((sum, bytes) => sum + bytes, 0));
}
function inspectCompleteFrames(bound: Capacity, frames: readonly Uint8Array[]): void {
	const decoded = frames.map(bytes => canonical.decodeCanonical(bytes) as [string, unknown, unknown]);
	const image = {scopes: decoded.filter(value => value[0] === "scopes").map(value => value[2]), rows: decoded.filter(value => value[0] !== "scopes").map(value => value[2])};
	expect(bound.nativeImageBytes).toBeGreaterThanOrEqual(canonical.encodeCanonical(image).byteLength);
	expect(bound.canonicalRows.byteLength).toBe(bound.canonicalRowsBytes);
	expect(bound.canonicalRows.items).toBe(1 + 2 * frames.length); expect(bound.canonicalRows.maxDepth).toBe(1);
	const bytes = canonical.encodeCanonical(frames);
	expect(bound.canonicalRows.byteLength).toBeGreaterThanOrEqual(bytes.byteLength);
	expect(canonical.decodeCanonical(bytes, {maxBytes: bound.canonicalRows.byteLength, maxItems: bound.canonicalRows.items, maxDepth: bound.canonicalRows.maxDepth})).toEqual(frames);
	const newHeader = decoded.find(value => value[0] === "scopes" && (value[1] as unknown[])[1] !== (decoded[0]![1] as unknown[])[1])!;
	const rowResource = resources.canonicalValueResourceForSizing(newHeader[2], 32, {maxBytes: codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32}, "exact");
	for (const key of ["byteLength", "items", "maxDepth"] as const) expect(bound.newHeaderRow[key]).toBeGreaterThanOrEqual(rowResource[key]);
	// Registered signature/digest/preimage fields are retained as complete unknown
	// encoded widths in this pure fixture, never authenticated identities/bytes.
	expect(bound.newHeaderFrame.byteLength).toBeGreaterThanOrEqual(canonical.encodeCanonical(newHeader).byteLength);
}

describe("original journal ordinary schema finishing capacity (pure widths, no native authority)", () => {
	it.each([false, true].flatMap(sql => [0, 124, 126, 127].map(count => ({sql, count}))))(
		"quoteCurrent bounds every mixed append prefix with complete OLD frames (sql=$sql count=$count)", ({sql, count}) => {
		for (const kinds of [[false, false, false, false], [true, true, true, true], [true, false, true, false], [false, true, false, true]]) {
			const f = fixture(sql, count, 128), old = fixture(sql, 1, 127, false, 16_384);
			const receivedRow = (local: Record<string, unknown>, size: number) => {
				if (sql) return {...local, source_kind: "received", local_author: null, local_author_sequence: null,
					received_preimage: new Uint8Array(size), received_signature: new Uint8Array(64)};
				const {localAuthor: _author, localAuthorSequence: _sequence, ...rest} = local;
				return {...rest, sourceKind: "received", exactCanonicalPreimageBytes: new Uint8Array(size), detachedSignature: new Uint8Array(64)};
			};
			const [oldTable, oldKey, oldRow] = canonical.decodeCanonical(old.frames[1]!) as [string, unknown[], Record<string, unknown>];
			old.frames[1] = codec.journalRetirementCanonicalRow(oldTable, oldKey, receivedRow(oldRow, 8192));
			const actualCanonicalRows = [...f.frames, ...old.frames], before = canonical.encodeCanonical(actualCanonicalRows);
			const observed = countedPreparedProjection(), prepared = observed.prepare({actualCanonicalRows, currentScope: f.current.scope});
			const sizes = [1, 127, 128, 2048], futureRows = {localCount: kinds.filter(value => !value).length,
				receivedCount: kinds.filter(Boolean).length, receivedPreimageBytes: kinds.reduce((sum, value, index) => sum + (value ? sizes[index]! : 0), 0)};
			const query = {maxAdditionalCurrentRows: kinds.length, canonicalPreimageByteLength: 4096,
				canonicalAuthorByteLength: canonical.encodeCanonical(f.author).byteLength, futureRows};
			const bound = prepared.quoteCurrent(query), finishingInput = {...f.input, actualCanonicalRows,
				...query, closedMembershipByteLength: 65_536, successorFenceCount: 1 as const, successorFencePreimageByteLength: 16_384};
			expect(prepared.quote(finishingInput)).toEqual(owner(finishingInput));
			expect(bound.scopeCount).toBe(2); expect(bound.rowCount).toBe(count + 1 + kinds.length);
			expect(bound.canonicalRowsBytes).toBeLessThan(prepared.quote(finishingInput).canonicalRowsBytes);
			const [headerTable, headerKey, headerRow] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const [table, key, local] = canonical.decodeCanonical(f.finalFrames(false)[count + 1]!) as [string, unknown[], Record<string, unknown>];
			const entries: Uint8Array[] = [];
			for (let index = 0; index <= kinds.length; index++) {
				const header = codec.journalRetirementCanonicalRow(headerTable, headerKey, {...headerRow,
					[sql ? "next_journal_sequence" : "nextJournalSequence"]: count + index});
				const frames = [header, ...actualCanonicalRows.slice(1), ...entries];
				const decoded = frames.map(bytes => canonical.decodeCanonical(bytes) as [string, unknown, unknown]);
				expect(bound.canonicalRowsBytes).toBeGreaterThanOrEqual(canonical.encodeCanonical(frames).byteLength);
				expect(bound.canonicalRowByteLengthsTotal).toBeGreaterThanOrEqual(frames.reduce((sum, bytes) => sum + bytes.byteLength, 0));
				expect(bound.nativeImageBytes).toBeGreaterThanOrEqual(canonical.encodeCanonical({
					scopes: decoded.filter(value => value[0] === "scopes").map(value => value[2]),
					rows: decoded.filter(value => value[0] !== "scopes").map(value => value[2])}).byteLength);
				expect(canonical.decodeCanonical(canonical.encodeCanonical(frames), {maxBytes: bound.canonicalRows.byteLength,
					maxItems: bound.canonicalRows.items, maxDepth: bound.canonicalRows.maxDepth})).toEqual(frames);
				if (index === kinds.length) break;
				const ordinal = count + index, row = {...local, [sql ? "journal_sequence" : "journalSequence"]: ordinal,
					[sql ? "local_author_sequence" : "localAuthorSequence"]: Number.MAX_SAFE_INTEGER};
				entries.push(codec.journalRetirementCanonicalRow(table, [...key.slice(0, 3), ordinal], kinds[index] ? receivedRow(row, sizes[index]!) : row));
			}
			const calls = {...observed.calls}, saved = structuredClone(query);
			futureRows.receivedPreimageBytes = Number.MAX_SAFE_INTEGER;
			for (let repeat = 0; repeat < 3; repeat++) expect(prepared.quoteCurrent(saved)).toEqual(bound);
			expect(observed.calls).toEqual(calls); expect(canonical.encodeCanonical(actualCanonicalRows)).toEqual(before);
			for (const bytes of actualCanonicalRows) bytes.fill(255);
			expect(prepared.quoteCurrent(saved)).toEqual(bound);
		}
	});
	it("quoteCurrent rejects malformed closed numerical geometry and counter overflow without effects or accessors", () => {
		const f = fixture(true, 1), observed = countedPreparedProjection(), prepared = observed.prepare({actualCanonicalRows: f.frames, currentScope: f.current.scope});
		const query = {maxAdditionalCurrentRows: 2, canonicalPreimageByteLength: 512, canonicalAuthorByteLength: 66,
			futureRows: {localCount: 1, receivedCount: 1, receivedPreimageBytes: 128}}, bound = prepared.quoteCurrent(query), calls = {...observed.calls};
		let accessed = false;
		const outer = Object.defineProperty({...query}, "canonicalPreimageByteLength", {enumerable: true, get() {accessed = true; return 512;}});
		const nested = Object.defineProperty({...query.futureRows}, "receivedPreimageBytes", {enumerable: true, get() {accessed = true; return 128;}});
		for (const input of [null, {...query, extra: 0}, Object.assign(Object.create({}), query), outer,
			{...query, maxAdditionalCurrentRows: NaN}, {...query, maxAdditionalCurrentRows: Infinity}, {...query, maxAdditionalCurrentRows: -1},
			{...query, maxAdditionalCurrentRows: codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows}, {...query, canonicalAuthorByteLength: 2},
			{...query, canonicalPreimageByteLength: 0}, {...query, canonicalPreimageByteLength: Number.MAX_SAFE_INTEGER},
			{...query, futureRows: undefined}, {...query, futureRows: nested}, {...query, futureRows: {...query.futureRows, extra: 0}},
			{...query, futureRows: {...query.futureRows, receivedCount: 2}}, {...query, futureRows: {...query.futureRows, receivedPreimageBytes: 0}},
			{...query, futureRows: {...query.futureRows, receivedPreimageBytes: 513}}, {...query, futureRows: {...query.futureRows, receivedPreimageBytes: Infinity}}])
			expect(() => prepared.quoteCurrent(input as typeof query)).toThrow();
		expect(accessed).toBe(false); expect(prepared.quoteCurrent(query)).toEqual(bound); expect(observed.calls).toEqual(calls);
		const [table, key, row] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
		const exhausted = observed.prepare({actualCanonicalRows: [codec.journalRetirementCanonicalRow(table, key,
			{...row, next_journal_sequence: Number.MAX_SAFE_INTEGER - 2})], currentScope: f.current.scope});
		expect(() => exhausted.quoteCurrent(query)).toThrow();
		expect(prepared.quoteCurrent({maxAdditionalCurrentRows: 0, canonicalPreimageByteLength: 512, canonicalAuthorByteLength: 66,
			futureRows: {localCount: 0, receivedCount: 0, receivedPreimageBytes: 0}}).rowCount).toBe(1);
	});
	it("mixed-source window covers variable PRE distributions and every prefix with complete historical frames", () => {
		for (const sql of [false, true]) for (const kinds of [[false, false, true, true], [true, false, true, false], [true, true, true, true], [false, false, false, false]]) {
			const f = fixture(sql, 2, 127), old = fixture(sql, 1, 126, false, 128);
			const actualCanonicalRows = [...f.frames, ...old.frames], observed = countedPreparedProjection();
			const prepared = observed.prepare({actualCanonicalRows, currentScope: f.current.scope});
			const receivedSizes = [1, 127, 128, 2048];
			const futureRows = {localCount: kinds.filter(value => !value).length, receivedCount: kinds.filter(Boolean).length,
				receivedPreimageBytes: kinds.reduce((sum, value, index) => sum + (value ? receivedSizes[index]! : 0), 0)};
			const quote = {...f.input, actualCanonicalRows, maxAdditionalCurrentRows: kinds.length, canonicalPreimageByteLength: 4096,
				futureRows, successorFenceCount: 1 as const, successorFencePreimageByteLength: 512};
			const before = canonical.encodeCanonical(actualCanonicalRows), bound = owner(quote);
			expect(prepared.quote(quote)).toEqual(bound);
			const {futureRows: _joint, ...rectangle} = quote;
			expect(bound.canonicalRowsBytes).toBeLessThan(owner(rectangle).canonicalRowsBytes);
			const [headerTable, headerKey, headerRow] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const [entryTable, entryKey, local] = canonical.decodeCanonical(f.finalFrames(false)[f.count + 1]!) as [string, unknown[], Record<string, unknown>];
			const entries: Uint8Array[] = [];
			for (let index = 0; index < kinds.length; index++) {
				const ordinal = f.count + index, received = kinds[index]!;
				const row = {...local, [sql ? "journal_sequence" : "journalSequence"]: ordinal,
					[sql ? "local_author_sequence" : "localAuthorSequence"]: ordinal,
					[sql ? "vertex_digest" : "vertexDigest"]: ordinal.toString(16).padStart(64, "0")};
				if (received) {
					if (sql) Object.assign(row, {source_kind: "received", local_author: null, local_author_sequence: null,
						received_preimage: new Uint8Array(receivedSizes[index]!), received_signature: new Uint8Array(64)});
					else {delete row.localAuthor; delete row.localAuthorSequence; Object.assign(row, {sourceKind: "received",
						exactCanonicalPreimageBytes: new Uint8Array(receivedSizes[index]!), detachedSignature: new Uint8Array(64)});}
				}
				entries.push(codec.journalRetirementCanonicalRow(entryTable, [...entryKey.slice(0, 3), ordinal], row));
				const header = codec.journalRetirementCanonicalRow(headerTable, headerKey, {...headerRow,
					[sql ? "next_journal_sequence" : "nextJournalSequence"]: ordinal + 1});
				const successor = f.finalFrames(false).at(-1)!;
				const frames = [header, ...actualCanonicalRows.slice(1), ...entries, successor];
				const decoded = frames.map(bytes => canonical.decodeCanonical(bytes) as [string, unknown, unknown]);
				const image = {scopes: decoded.filter(value => value[0] === "scopes").map(value => value[2]),
					rows: decoded.filter(value => value[0] !== "scopes").map(value => value[2])};
				expect(bound.nativeImageBytes).toBeGreaterThanOrEqual(canonical.encodeCanonical(image).byteLength);
				expect(bound.rowCount).toBeGreaterThanOrEqual(entries.length + f.count + old.count);
				const bytes = canonical.encodeCanonical(frames);
				expect(bound.canonicalRowsBytes).toBeGreaterThanOrEqual(bytes.byteLength);
				expect(canonical.decodeCanonical(bytes, {maxBytes: bound.canonicalRows.byteLength,
					maxItems: bound.canonicalRows.items, maxDepth: bound.canonicalRows.maxDepth})).toEqual(frames);
			}
			const decodes = observed.calls.decode;
			for (let repeat = 0; repeat < 3; repeat++) expect(prepared.quote(quote)).toEqual(bound);
			expect(observed.calls.decode).toBe(decodes);
			futureRows.receivedPreimageBytes += 1;
			expect(bound.canonicalRowsBytes).toBe(prepared.quote({...quote, futureRows: {...futureRows,
				receivedPreimageBytes: futureRows.receivedPreimageBytes - 1}}).canonicalRowsBytes);
			expect(canonical.encodeCanonical(actualCanonicalRows)).toEqual(before);
		}
	});
	it("mixed-source window refuses malformed counts, raw budgets and accessors without changing the prepared source", () => {
		const f = fixture(true, 1), prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: f.frames, currentScope: f.current.scope});
		const quote = {...f.input, maxAdditionalCurrentRows: 2, futureRows: {localCount: 1, receivedCount: 1, receivedPreimageBytes: 128}};
		for (const futureRows of [undefined, null, {...quote.futureRows, extra: 0}, {...quote.futureRows, localCount: -1},
			{...quote.futureRows, receivedCount: 2}, {...quote.futureRows, receivedPreimageBytes: 0},
			{...quote.futureRows, receivedPreimageBytes: 513}, {...quote.futureRows, receivedPreimageBytes: NaN},
			{...quote.futureRows, receivedPreimageBytes: Number.MAX_SAFE_INTEGER}]) {
			expect(() => prepared.quote({...quote, futureRows} as Input)).toThrow();
			expect(() => owner({...quote, futureRows} as Input)).toThrow();
		}
		let invoked = false;
		const nested = {...quote.futureRows}; Object.defineProperty(nested, "receivedPreimageBytes", {
			enumerable: true, get() {invoked = true; throw Error("untrusted nested accessor");}});
		expect(() => prepared.quote({...quote, futureRows: nested})).toThrow(); expect(invoked).toBe(false);
		const outer = {...quote}; Object.defineProperty(outer, "futureRows", {
			enumerable: true, get() {invoked = true; throw Error("untrusted outer accessor");}});
		expect(() => prepared.quote(outer)).toThrow(); expect(invoked).toBe(false);
		expect(() => owner(outer)).toThrow(); expect(invoked).toBe(false);
		expect(prepared.snapshot.rowCount).toBe(1); expect(prepared.quote(quote)).toEqual(owner(quote));
	});
	it("advances detached geometry through local/received appends and count edges without reparsing old rows for quotes", () => {
		for (const sql of [false, true]) for (const count of [0, 126, 127, 128]) for (const received of [false, true]) {
			const f = fixture(sql, count, 127), observed = countedPreparedProjection();
			const prepared = observed.prepare({actualCanonicalRows: f.frames, currentScope: f.current.scope});
			const quote = {...f.input, successorFenceCount: 1 as const, successorFencePreimageByteLength: 8_334};
			expect(prepared.quote(quote)).toEqual(owner(quote));
			expect(observed.calls).toEqual({decode: count + 1, canonicalFrame: count + 1, rowCharge: count + 1});
			const [headerTable, headerKey, headerRow] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const header = codec.journalRetirementCanonicalRow(headerTable, headerKey,
				{...headerRow, [sql ? "next_journal_sequence" : "nextJournalSequence"]: count + 1});
			const entryFrame = f.finalFrames(false)[count + 1]!;
			const [table, key, local] = canonical.decodeCanonical(entryFrame) as [string, unknown[], Record<string, unknown>];
			const row = !received ? local : sql ? {...local, source_kind: "received", local_author: null, local_author_sequence: null,
				received_preimage: new Uint8Array(512), received_signature: new Uint8Array(64)} :
				(({localAuthor: _author, localAuthorSequence: _sequence, ...rest}) => ({...rest, sourceKind: "received",
					exactCanonicalPreimageBytes: new Uint8Array(512), detachedSignature: new Uint8Array(64)}))(local);
			const entry = codec.journalRetirementCanonicalRow(table, key, row);
			const next = prepared.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: entry});
			const actualCanonicalRows = [header, ...f.frames.slice(1), entry];
			expect(next.quote(quote)).toEqual(owner({...quote, actualCanonicalRows}));
			expect(next.snapshot).toEqual(codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows, currentScope: f.current.scope}).snapshot);
			expect(observed.calls).toEqual({decode: count + 3, canonicalFrame: count + 3, rowCharge: count + 3});
			for (let repeat = 0; repeat < 3; repeat++) expect(next.quote(quote)).toEqual(owner({...quote, actualCanonicalRows}));
			expect(observed.calls.decode).toBe(count + 3); // Quotes never decode the retained PRE.
			expect(prepared.snapshot.rowCount).toBe(count); expect(next.snapshot.rowCount).toBe(count + 1);
			expect(next.snapshot.groups[0]!.receivedCount).toBe(received ? 1 : 0);
			// Borrowed frame mutation cannot alter either retained numerical cell.
			for (const bytes of f.frames) bytes.fill(255); header.fill(255); entry.fill(255);
			expect(next.snapshot.rowCount).toBe(count + 1); expect(() => next.quote(quote)).not.toThrow();
		}
	});
	it("refuses duplicate, foreign, missing and changed-header geometry updates without advancing the original", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 1), prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: f.frames, currentScope: f.current.scope});
			const [table, key, row] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const header = codec.journalRetirementCanonicalRow(table, key, {...row, [sql ? "next_journal_sequence" : "nextJournalSequence"]: 2});
			const entry = f.finalFrames(false)[2]!;
			expect(() => prepared.advance({exactCanonicalHeaderFrameBytes: f.frames[0]!, exactCanonicalAcceptedFrameBytes: entry})).toThrow();
			expect(() => prepared.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: f.frames[1]!})).toThrow();
			expect(() => prepared.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: Uint8Array.of(255)})).toThrow();
			const altered = codec.journalRetirementCanonicalRow(table, key, {...row, [sql ? "next_journal_sequence" : "nextJournalSequence"]: 2,
				[sql ? "exact_parameters_carrier" : "exactCanonicalParametersCarrierBytes"]: Uint8Array.of(0)});
			expect(() => prepared.advance({exactCanonicalHeaderFrameBytes: altered, exactCanonicalAcceptedFrameBytes: entry})).toThrow("retirement-stale");
			const [entryTable, entryKey, entryRow] = canonical.decodeCanonical(entry) as [string, unknown[], Record<string, unknown>];
			const foreign = codec.journalRetirementCanonicalRow(entryTable, ["foreign", ...entryKey.slice(1)], entryRow);
			expect(() => prepared.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: foreign})).toThrow();
			expect(prepared.snapshot.rowCount).toBe(1);
			const next = prepared.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: entry});
			expect(next.snapshot.rowCount).toBe(2);
			expect(() => next.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: entry})).toThrow();
		}
	});
	it("keeps nonempty historical scopes exact through successive mixed appends and immutable predecessor cells", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 126, 128), historical = fixture(sql, 3, 127, false, 16_384);
			let rows = [...f.frames, ...historical.frames];
			let prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: rows, currentScope: f.current.scope});
			const predecessors = [prepared], quote = {...f.input, maxAdditionalCurrentRows: 4,
				successorFenceCount: 1 as const, successorFencePreimageByteLength: 8_334};
			for (let index = 0; index < 6; index++) {
				const ordinal = 126 + index, [table, key, headerRow] = canonical.decodeCanonical(rows[0]!) as [string, unknown[], Record<string, unknown>];
				const header = codec.journalRetirementCanonicalRow(table, key, {...headerRow,
					[sql ? "next_journal_sequence" : "nextJournalSequence"]: ordinal + 1});
				const [entryTable, entryKey, local] = canonical.decodeCanonical(f.finalFrames(false)[127]!) as [string, unknown[], Record<string, unknown>];
				const received = index % 2 === 1;
				const row = {...local, [sql ? "journal_sequence" : "journalSequence"]: ordinal,
					[sql ? "local_author_sequence" : "localAuthorSequence"]: ordinal,
					[sql ? "vertex_digest" : "vertexDigest"]: ordinal.toString(16).padStart(64, "0")};
				if (received) {
					if (sql) Object.assign(row, {source_kind: "received", local_author: null, local_author_sequence: null,
						received_preimage: new Uint8Array(index % 3 === 0 ? 127 : 128), received_signature: new Uint8Array(64)});
					else {delete row.localAuthor; delete row.localAuthorSequence; Object.assign(row,
						{sourceKind: "received", exactCanonicalPreimageBytes: new Uint8Array(index % 3 === 0 ? 127 : 128), detachedSignature: new Uint8Array(64)});}
				}
				const entry = codec.journalRetirementCanonicalRow(entryTable, [...entryKey.slice(0, 3), ordinal], row);
				prepared = prepared.advance({exactCanonicalHeaderFrameBytes: header, exactCanonicalAcceptedFrameBytes: entry});
				rows = [header, ...rows.slice(1), entry]; predecessors.push(prepared);
				expect(prepared.quote(quote)).toEqual(owner({...quote, actualCanonicalRows: rows}));
				expect(prepared.snapshot).toEqual(codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: rows, currentScope: f.current.scope}).snapshot);
				const old = prepared.snapshot.groups.find(group => group.scope.epoch === 127)!;
				expect(old.count).toBe(3); expect(old.receivedCount).toBe(0); expect(old.pageable).toBe(true);
			}
			predecessors.forEach((cell, index) => expect(cell.snapshot.rowCount).toBe(129 + index));
			expect(prepared.snapshot.groups.find(group => group.scope.epoch === 128)!.receivedCount).toBe(3);
		}
	});
	it("shares one fully validated PRE decode and footprint pass only within an unchanged invocation", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 127, 127, false, 16_384), counted = countedOwner(), before = canonical.encodeCanonical(f.frames),
				input = {...f.input, successorFenceCount: 1 as const, successorFencePreimageByteLength: 8_334};
			expect(counted.run(input)).toEqual(owner(input));
			expect(counted.calls).toEqual({decode: f.frames.length, canonicalFrame: f.frames.length, rowCharge: f.frames.length});
			expect(canonical.encodeCanonical(f.frames)).toEqual(before);
			counted.run(input);
			expect(counted.calls).toEqual({decode: 2 * f.frames.length, canonicalFrame: 2 * f.frames.length, rowCharge: 2 * f.frames.length});
		}
	});
	it("keeps the second defensive capture after scalar getters mutate borrowed bytes or return another input vector", () => {
		for (const sql of [false, true]) for (const change of ["bytes", "remove", "reorder"] as const) {
			const f = fixture(sql, 2), original = f.frames[0]!.slice(); let reads = 0;
			const input = {...f.input, get canonicalAuthorByteLength() {
				reads++;
				if (change === "bytes") f.frames[0]![0] = 255;
				if (change === "remove") f.frames.splice(0, 1);
				if (change === "reorder") f.frames.reverse();
				return canonical.encodeCanonical(f.author).byteLength;
			}};
			if (change === "reorder") expect(owner(input).rowCount).toBe(3);
			else expect(() => owner(input)).toThrow();
			expect(reads).toBe(1);
			if (change === "bytes") {f.frames[0] = original; expect(owner(f.input).rowCount).toBe(3);}
		}
		const f = fixture(false, 1); let reads = 0, copies = 0;
		const iterable = {[Symbol.iterator]() {copies++; return (copies === 1 ? f.frames[0]! : Uint8Array.of(255))[Symbol.iterator]();}};
		const input = {...f.input, get actualCanonicalRows() {reads++; return [iterable, f.frames[1]!] as unknown as Uint8Array[];}};
		expect(() => owner(input)).toThrow(); expect(reads).toBe(2); expect(copies).toBe(2);
	});
	it("revalidates original RAW depth after a shrinking second capture and preserves map-hook byte mutation refusal", () => {
		const f = fixture(true, 2), [table, key, row] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
		let nested: unknown = 0; for (let index = 0; index < 15; index++) nested = [nested];
		const deep = canonical.encodeCanonical([table, key, {...row, nested}]);
		const input = {...f.input, get canonicalAuthorByteLength() {f.frames.splice(0, f.frames.length, deep); return 66;}};
		expect(() => owner(input)).toThrow(); // Shrinking cannot use sourceValidated's monotone-row RAW shortcut.
		const originalMap = Array.prototype.map, other = fixture(false, 2); let changed = false;
		const hook = vi.spyOn(Array.prototype, "map").mockImplementation(function(this: unknown[], ...args: Parameters<typeof originalMap>) {
			const result = Reflect.apply(originalMap, this, args);
			if (!changed && result.length === other.frames.length && result.every(value => value !== null &&
				typeof value === "object" && "table" in value && "bytes" in value)) {
				changed = true; other.frames[0]![0] = 255;
			}
			return result;
		});
		try {expect(() => owner(other.input)).toThrow(); expect(changed).toBe(true);} finally {hook.mockRestore();}
	});
	it("bounds a finite complete join suffix against the unchanged original multi-append oracle without widening old heterogeneous rows", () => {
		for (const sql of [false, true]) for (const count of [0, 127]) for (const additions of [1, 2, 4]) for (const fence of [0, 1] as const) {
			const f = fixture(sql, count, 127);
			if (count > 0) {
				const [table, key, original] = canonical.decodeCanonical(f.frames[1]!) as [string, unknown[], Record<string, unknown>];
				const largePreimage = new Uint8Array(4096).fill(7);
				const row = sql ? {...original, source_kind: "received", local_author: null, local_author_sequence: null,
					received_preimage: largePreimage, received_signature: new Uint8Array(64)} :
					(({localAuthor: _author, localAuthorSequence: _sequence, ...rest}) => ({...rest, sourceKind: "received",
						exactCanonicalPreimageBytes: largePreimage, detachedSignature: new Uint8Array(64)}))(original);
				f.frames[1] = codec.journalRetirementCanonicalRow(table, key, row);
			}
			const input = {...f.input, actualCanonicalRows: f.frames, maxAdditionalCurrentRows: additions,
				successorFenceCount: fence, successorFencePreimageByteLength: fence === 0 ? 0 : 8334};
			const before = canonical.encodeCanonical(input), bound = owner(input);
			const exact = codec.journalFutureAppendPostimageWidths(f.frames, f.local(count), f.install,
				fence === 0 ? undefined : {author: f.author, authorSequence: count + additions},
				Array.from({length: additions - 1}, (_, index) => f.local(count + index + 1)), {closedMembershipByteLength: 128});
			for (const point of [exact.afterLocal, exact.afterSuccessor, ...(exact.afterSuccessorLocal ? [exact.afterSuccessorLocal] : [])]) dominates(bound, point);
			expect(bound.rowCount).toBe(count + additions + fence);
			expect(bound.scopeCount).toBe(2);
			expect(canonical.encodeCanonical(input)).toEqual(before);
			if (additions === 1) {const {maxAdditionalCurrentRows: _count, ...implicit} = input; expect(owner(implicit)).toEqual(bound);}
		}
	});

	it("validates finite join-suffix counts and keeps original row/image limits enforced", () => {
		const f = fixture(true, 2);
		for (const maxAdditionalCurrentRows of [-1, 0.5, NaN, Infinity, codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows + 1])
			expect(() => owner({...f.input, maxAdditionalCurrentRows})).toThrow();
		expect(() => owner({...f.input, maxAdditionalCurrentRows: codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxRows})).toThrow();
		const zero = owner({...f.input, maxAdditionalCurrentRows: 0}); expect(zero.rowCount).toBe(2);
		const two = owner({...f.input, maxAdditionalCurrentRows: 2}), three = owner({...f.input, maxAdditionalCurrentRows: 3});
		for (const field of ["canonicalRowByteLengthsTotal", "canonicalRowsBytes", "nativeImageBytes"] as const) expect(three[field]).toBeGreaterThan(two[field]);
	});

	it("retains every original NONE result field from the pre-rename d4475888 actual-body baseline", () => {
		// Generated by executing the original private body from retirement.ts SHA
		// d4475888896394603d03f88c5242cdcb3ad56b9c923636ede16316509c69a066,
		// with the SAME fixture and original codecs. Direct old/new comparison
		// passed before freezing these scalar expectations; no old owner is shipped.
		const baseline = [
			[false, 0, 127, 4143, 4157, 3772, 654],
			[false, 126, 128, 67709, 68102, 50518, 656],
			[false, 127, 128, 68215, 68611, 50891, 656],
			[true, 0, 127, 4147, 4161, 3775, 690],
			[true, 126, 128, 74013, 74406, 56695, 692],
			[true, 127, 128, 74569, 74965, 57117, 692],
		] as const;
		for (const [sql, count, preimage, canonicalRowByteLengthsTotal, canonicalRowsBytes, nativeImageBytes, additionalFrameByteLength] of baseline) {
			const f = fixture(sql, count), {successorFenceFrameByteLength, ...result} = owner({...f.input, canonicalPreimageByteLength: preimage});
			expect(successorFenceFrameByteLength).toBe(0);
			expect(result).toEqual({scopeCount: 2, rowCount: count + 1, canonicalRowByteLengthsTotal, canonicalRowsBytes, nativeImageBytes, additionalFrameByteLength,
				canonicalRows: {byteLength: canonicalRowsBytes, items: 1 + 2 * (count + 3), maxDepth: 1},
				newHeaderRow: {byteLength: sql ? 1525 : 1542, items: 33, maxDepth: 1},
				newHeaderFrame: {byteLength: sql ? 1654 : 1671, items: 45, maxDepth: 2}});
		}
	});
	it("retains NONE when a successor fence is absent or explicitly zero", () => {
		for (const sql of [false, true]) for (const count of [0, 125, 126, 127, 128]) for (const preimage of [127, 128]) {
			const f = fixture(sql, count), input = {...f.input, canonicalPreimageByteLength: preimage}, before = canonical.encodeCanonical(input);
			const bound = owner(input);
			expect(owner({...input, successorFenceCount: 0, successorFencePreimageByteLength: 0})).toEqual(bound);
			expect(bound.successorFenceFrameByteLength).toBe(0);
			const exact = codec.journalFutureAppendPostimageWidths(f.frames, f.local(count), f.install, undefined, [], {closedMembershipByteLength: 128});
			for (const point of [exact.afterLocal, exact.afterSuccessor]) dominates(bound, point);
			expect(bound.scopeCount).toBe(2); expect(bound.rowCount).toBe(count + 1);
			inspectCompleteFrames(bound, f.finalFrames(false));
			expect(canonical.encodeCanonical(input)).toEqual(before); expect(Object.isFrozen(bound)).toBe(true);
		}
	});
	it("positively bounds complete PRE plus candidate, signed successor header and correctly addressed V1 fence across count/epoch widths", () => {
		for (const sql of [false, true]) for (const count of [0, 124, 125, 126, 127, 128]) for (const epoch of [0, 127, Number.MAX_SAFE_INTEGER - 1]) {
			const f = fixture(sql, count, epoch, true), input = {...f.input, successorFenceCount: 1 as const, successorFencePreimageByteLength: 8_334};
			const before = canonical.encodeCanonical(input), bound = owner(input), none = owner(f.input);
			const exact = codec.journalFutureAppendPostimageWidths(f.frames, f.local(count), f.install,
				{author: f.author, authorSequence: f.sequenceBase + count + 1}, [], {closedMembershipByteLength: 128});
			for (const point of [exact.afterLocal, exact.afterSuccessor, exact.afterSuccessorLocal!]) dominates(bound, point);
			expect(bound.scopeCount).toBe(2); expect(bound.rowCount).toBe(count + 2);
			expect(bound.successorFenceFrameByteLength).toBeGreaterThanOrEqual(bound.additionalFrameByteLength);
			for (const key of ["canonicalRowByteLengthsTotal", "canonicalRowsBytes", "nativeImageBytes"] as const) expect(bound[key]).toBeGreaterThan(none[key]);
			const final = f.finalFrames(true); inspectCompleteFrames(bound, final);
			const fence = canonical.decodeCanonical(final.at(-1)!) as [string, unknown[], Record<string, unknown>];
			expect(fence[1]).toEqual([f.successor.scope.objectId, f.successor.scope.epoch, f.successor.scope.anchorDigest, 0]);
			expect(fence[2][sql ? "journal_sequence" : "journalSequence"]).toBe(0);
			expect(fence[2].epoch).toBe(epoch + 1); expect(fence[2][sql ? "anchor_digest" : "anchorDigest"]).toBe(f.successor.scope.anchorDigest);
			expect(canonical.encodeCanonical(input)).toEqual(before);
		}
	});
	it("rejects invalid fence/count and independent candidate bounds, including candidates masked by a larger valid fence", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 1), input = {...f.input, successorFenceCount: 1 as const, successorFencePreimageByteLength: 8_334};
			const invalid = [
				...[-1, 0.5, 2, NaN, Infinity].map(successorFenceCount => ({...input, successorFenceCount})),
				...[-1, 0, 0.5, NaN, Infinity, codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1].map(successorFencePreimageByteLength => ({...input, successorFencePreimageByteLength})),
				...[-1, 0, 0.5, NaN, Infinity, codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes + 1].map(canonicalPreimageByteLength => ({...input, canonicalPreimageByteLength})),
				{...input, successorFenceCount: 0}, {...input, canonicalAuthorByteLength: 2},
				{...input, currentScope: {...input.currentScope, epoch: Number.MAX_SAFE_INTEGER}},
				{...input, successorAnchorByteLength: 0}, {...input, parametersByteLength: 0}, {...input, closedMembershipByteLength: -1},
			];
			for (const value of invalid) expect(() => owner(value as Input)).toThrow();
		}
	});
	it("keeps complete PRE byte/array/item/depth and image checks, old membership and unknown-leaf charges", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 2, 127, false, 16_384), input = {...f.input, successorFenceCount: 1 as const, successorFencePreimageByteLength: 128};
			const bound = owner(input); expect(bound.nativeImageBytes).toBeGreaterThan(16_384);
			const [table, key, row] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const malformed = [[], [Uint8Array.of(255)], new Array(1), [canonical.encodeCanonical(["foreign", key, row])],
				[canonical.encodeCanonical([table, key, {...row, oversized: new Uint8Array(codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes)}])]];
			let nested: unknown = 0; for (let i = 0; i < 15; i++) nested = [nested];
			const deep = canonical.encodeCanonical([table, key, {...row, nested}]);
			// Frame and standalone row fit; the ORIGINAL RAW image depth still fails.
			canonical.decodeCanonical(deep, {maxDepth: 17});
			expect(() => owner({...input, actualCanonicalRows: [deep, ...f.frames.slice(1)]})).toThrow();
			const many = {...row, ...Object.fromEntries(Array.from({length: 129}, (_, i) => [`extra-${i}`, 0]))};
			malformed.push([canonical.encodeCanonical([table, key, many])]);
			for (const frames of malformed) expect(() => owner({...input, actualCanonicalRows: frames})).toThrow();
			expect(() => owner({...input, currentScope: {...input.currentScope, anchorDigest: "f".repeat(64)}})).toThrow();
			const larger = owner({...input, successorFencePreimageByteLength: 8_334, canonicalAuthorByteLength: 128});
			for (const field of ["additionalFrameByteLength", "successorFenceFrameByteLength", "nativeImageBytes", "canonicalRowsBytes"] as const) expect(larger[field]).toBeGreaterThan(bound[field]);
			const first = owner(input); input.actualCanonicalRows[0]![0] ^= 255;
			expect(() => owner(input)).toThrow(); expect(first).toEqual(bound);
		}
	});
});

describe("captured HEADER-only finishing drain capacity", () => {
	it("matches the ORIGINAL full-composer top16 descriptors with the current HWM widened, for SQL and IDB", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 1, 127, false, 18_000);
			const old = Array.from({length: 20}, (_, index) => fixture(sql, 0, index + 1, false, (index + 1) * 1024).frames[0]!);
			const frames = [...old, ...f.frames];
			const [table, key, row] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const widened = codec.journalRetirementCanonicalRow(table, key,
				{...row, [sql ? "next_journal_sequence" : "nextJournalSequence"]: Number.MAX_SAFE_INTEGER});
			const original = fullHeaderDrain({objectId: f.current.scope.objectId, pinnedGenesisAnchorDigest: "0".repeat(64),
				canonicalRows: [...old, widened, ...f.frames.slice(1)], protectedHeaderScopes: []});
			const prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: frames, currentScope: f.current.scope});
			expect(prepared.snapshot.headerDrain.count).toBe(16);
			expect(prepared.snapshot.headerDrain.descriptors.byteLength).toBe(original.retiredEmptyHeaders.byteLength);
			expect(original.count).toBe(16);
			expect(Object.isFrozen(prepared.snapshot.headerDrain)).toBe(true);
			expect(Object.isFrozen(prepared.snapshot.headerDrain.descriptors)).toBe(true);
		}
	});
	it("never repeats a large accepted PRE or prospective membership/header as an OLD header", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 1, 127, false, 1024);
			const [table, key, local] = canonical.decodeCanonical(f.frames[1]!) as [string, unknown[], Record<string, unknown>];
			const row = sql ? {...local, source_kind: "received", local_author: null, local_author_sequence: null,
				received_preimage: new Uint8Array(200_000), received_signature: new Uint8Array(64)} :
				(({localAuthor: _a, localAuthorSequence: _s, ...rest}) => ({...rest, sourceKind: "received",
					exactCanonicalPreimageBytes: new Uint8Array(200_000), detachedSignature: new Uint8Array(64)}))(local);
			const frames = [f.frames[0]!, codec.journalRetirementCanonicalRow(table, key, row)];
			const prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: frames, currentScope: f.current.scope});
			const small = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: f.frames, currentScope: f.current.scope});
			expect(prepared.snapshot.canonicalRowByteLengthsTotal).toBeGreaterThan(200_000);
			expect(prepared.snapshot.headerDrain).toEqual(small.snapshot.headerDrain);
			const before = prepared.snapshot.headerDrain;
			const quoted = prepared.quote({...f.input, closedMembershipByteLength: 195_000, successorAnchorByteLength: 20_000,
				successorFenceCount: 1, successorFencePreimageByteLength: 4096});
			expect(quoted.canonicalRowsBytes).toBeGreaterThan(395_000);
			expect(prepared.snapshot.headerDrain).toBe(before);
			expect(before.descriptors.byteLength).toBeLessThan(5000);
		}
	});
	it("retains a genuinely large OLD header and bounds current 127→128 HWM without advancing its bound", () => {
		for (const sql of [false, true]) {
			const f = fixture(sql, 127, 127, false, 1024), old = fixture(sql, 0, 1, false, 195_000).frames[0]!;
			const frames = [old, ...f.frames], prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: frames, currentScope: f.current.scope});
			const [table, key, row] = canonical.decodeCanonical(f.frames[0]!) as [string, unknown[], Record<string, unknown>];
			const nextHeader = codec.journalRetirementCanonicalRow(table, key,
				{...row, [sql ? "next_journal_sequence" : "nextJournalSequence"]: 128});
			const entry = f.finalFrames(false)[128]!;
			const next = prepared.advance({exactCanonicalHeaderFrameBytes: nextHeader, exactCanonicalAcceptedFrameBytes: entry});
			expect(prepared.snapshot.headerDrain.descriptors.byteLength).toBeGreaterThan(195_000);
			expect(next.snapshot.headerDrain).toEqual(prepared.snapshot.headerDrain);
			expect(next.snapshot.headerDrain).toEqual(codec.prepareJournalOrdinaryFinishingCapacityProjection({
				actualCanonicalRows: [old, nextHeader, ...f.frames.slice(1), entry], currentScope: f.current.scope}).snapshot.headerDrain);
			const original = fullHeaderDrain({objectId: f.current.scope.objectId, pinnedGenesisAnchorDigest: "0".repeat(64),
				canonicalRows: [old, nextHeader, ...f.frames.slice(1), entry], protectedHeaderScopes: []});
			expect(next.snapshot.headerDrain.descriptors.byteLength).toBeGreaterThanOrEqual(original.retiredEmptyHeaders.byteLength);
		}
	});
	it("keeps OLD/resumed control and drainSource owners unchanged, and excludes genesis only by its original non-retirable role", () => {
		const owner = rollbackTree.statements.find((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "creatorOrdinaryJournalRawSupplementForSizing");
		if (owner === undefined) throw Error("missing ORIGINAL resumed RAW owner");
		const rawSupplement = new Function("compareBytes", "closedJournalNativeControlCarriers", "closedJournalReconstructedControlCarriers",
			"maintenanceWidthSum", ts.transpileModule(`${owner.getText(rollbackTree)}\nreturn creatorOrdinaryJournalRawSupplementForSizing;`,
				{compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText)(canonical.compareBytes,
			(journal: {controls: Uint8Array[]}) => journal.controls, (control: {reconstructed: Uint8Array[]}) => control.reconstructed,
			(parts: number[]) => parts.reduce((a, b) => a + b, 0));
		const header = new Uint8Array(195_000), oldRow = new Uint8Array(200_000).fill(1), oldControl = new Uint8Array(190_000).fill(2),
			oldPlan = new Uint8Array(180_000).fill(3);
		const journal = {canonicalRows: [header], controls: [oldControl],
			drainSource: {canonicalRows: [header.slice(), oldRow], control: {reconstructed: [oldPlan, oldControl.slice()]}}};
		expect(rawSupplement(journal, [])).toBe(oldRow.byteLength + oldControl.byteLength + oldPlan.byteLength);
		expect(rawSupplement(journal, [oldRow.slice()])).toBe(oldControl.byteLength + oldPlan.byteLength);
		const f = fixture(false, 0, 0), prepared = codec.prepareJournalOrdinaryFinishingCapacityProjection({actualCanonicalRows: f.frames, currentScope: f.current.scope});
		expect(prepared.snapshot.headerDrain).toEqual({count: 0, descriptors: resources.canonicalArrayResourcesForSizing([],
			{maxBytes: codec.LIVE_JOURNAL_RETIREMENT_LIMITS.maxImageBytes, maxItems: 65_536, maxDepth: 32})});
	});
});
