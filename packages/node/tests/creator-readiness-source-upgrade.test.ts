import { readFileSync } from "node:fs";
import ts from "typescript";
import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { openAuthorFenceOperation } from "@ts-drp/protocol-v3/internal/received-vertex-authentication";
import { applySettlementPlanEffect } from "../../issuance-store/src/contract.js";
import { describe, expect, it } from "vitest";

const path = new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url);
const ast = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
	ts.isFunctionDeclaration(node) && node.name?.text === "prepareCreatorOrdinaryIssuanceProofSourceReadiness");
if (declaration === undefined) throw Error("READINESS_UPGRADE_FACTORY_MISSING");

/** Executes the actual private factory. Nominal owner/native premises and the
 * original finishing compiler are controlled here, not established by this
 * unit fixture. Existing native and exact-bound scenarios verify those owners. */
function fixture() {
	const proofFacts = new WeakMap<object, any>(), registry = new WeakMap<object, any>();
	const events: string[] = [], pending = new Set<Promise<unknown>>(), maxBytes = 1_310_720;
	const identity = {}, source = Object.freeze({}), reader = () => undefined;
	const oldMaterial = [Uint8Array.of(99)], material = [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)];
	const uses = [{protected: true, nativeReaderRefs: ["protected"]}, {protected: false, observation: "actual"}];
	const accounting = {maxBytes, chargedBytes: 5};
	const seed = {kind: "ordinary-source", identity, currentTrust: {objectId: "room", currentEpoch: 4, currentAnchorDigest: "anchor"},
		inventoryBytes: encodeCanonical({owner: "exact-current", scopes: ["protected"]}),
		knownMaterial: oldMaterial, knownMaterialUses: [{protected: true}], knownProtectedMaterial: oldMaterial,
		runtimeCensusObservation: {bytes: Uint8Array.of(99)}, replaceableJournalObservation: {bytes: Uint8Array.of(88)},
		nativeIssuance: {epoch: 0}, journal: {epoch: 0}, capacity: {readiness: {old: true}, material: {old: true}}};
	registry.set(source, seed);
	const capture = {journal: {epoch: 4, rows: [Uint8Array.of(7)]}, snapshot: {epoch: 3}, ahe: {epoch: 4},
		floorImage: {state: {epoch: 4}}, nativeIssuance: {epoch: 4, rows: [Uint8Array.of(8)]}, signingRows: []};
	let checks = 0, publishes = 0, runtimeCommits = 0, numericalCommits = 0;
	let checkHook: ((count: number) => Promise<void> | void) | undefined;
	let captureHook: (() => Promise<void> | void) | undefined;
	let prepareHook: (() => Promise<void> | void) | undefined;
	let commitResult = true, prepareResult = true, runtimeIdentity = identity;
	let runtimePrepared = true;
	let observed: any;
	const proof = {accounting};
	const facts = {kind: "ordinary-proof", source, frame: {accounting, pending}, capture,
		runtime: {readSourceIdentity: () => runtimeIdentity,
			captureReadinessPreparation: async (book: unknown) => {
				expect(book).toBe(accounting); events.push("runtime-prepare"); await captureHook?.();
				return !runtimePrepared ? undefined : {preparation: {actualEpoch: 4}, commit: () => {
					events.push("runtime-commit"); runtimeCommits++; return commitResult;
				}};
			}},
		check: async () => {events.push(`check:${++checks}`); await checkHook?.(checks);},
	};
	proofFacts.set(proof, facts);
	const owner: any = {captureKnownMaterial: () => material.map(bytes => bytes.slice()),
		captureKnownMaterialUses: () => uses.map(use => ({...use})), captureObservationOnlyMaterial: () => undefined};
	const materialOwners = new Map([[accounting, owner]]);
	const publishRegistry = {set: (token: object, value: unknown) => {
		publishes++; events.push("publish"); registry.set(token, value);
	}};
	const context = {
		creatorOrdinaryIssuanceProofFacts: (value: object) => proofFacts.get(value),
		creatorOrdinaryIssuanceSourceFacts: (value: object) => registry.get(value),
		CREATOR_ORDINARY_PROOF_MAX_BYTES: maxBytes,
		requireLaw: (condition: unknown, reason: string) => {if (!condition) throw Error(reason);},
		proofMaterialOwners: materialOwners,
		closedRetirementBytes: encodeCanonical, decodeCanonical, compareBytes,
		// The owner's own capture-journal detach (its in-memory drainSource never reaches the encoder).
		detachClosedCaptureJournal: Function("decodeCanonical", "closedRetirementBytes", `"use strict"; ${ts.transpile(
			ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
				node.name?.text === "detachClosedCaptureJournal")!.getText(ast), {target: ts.ScriptTarget.ES2022})}; return detachClosedCaptureJournal;`)(
			decodeCanonical, encodeCanonical),
		creatorIssuanceMaintenanceObservationCarriers: (value: unknown) => [value],
		createCreatorOrdinaryFinishingMaterialIndex: (bytes: unknown, annotations: unknown) => ({bytes, annotations}),
		maintenanceTerminalCustody: publishRegistry,
		prepareCreatorOrdinarySourceReadinessForSizing: async (newSource: any, preparation: unknown, frame: unknown,
			actualCapture: unknown, options: unknown, available: () => Promise<void>) => {
			events.push("numerical-prepare"); observed = {newSource, preparation, frame, actualCapture, options};
			await available(); await prepareHook?.();
			return !prepareResult ? undefined : () => {events.push("numerical-commit"); numericalCommits++;
				newSource.capacity.readiness = {reader, sourceIdentity: identity, actualEpoch: 4};};
		},
	};
	const code = ts.transpile(`${declaration!.getText(ast).replace(/^export /u, "")}\nprepareCreatorOrdinaryIssuanceProofSourceReadiness;`,
		{target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None});
	const run = new Function(...Object.keys(context), `return eval(${JSON.stringify(code)});`)(...Object.values(context)) as
		(proof: object, options: unknown) => Promise<object | undefined>;
	const options = {reader, window: {maxActions: 64}};
	return {run: (value: object = proof) => run(value, options), rawRun: run, proof, source, seed, facts, registry,
		proofFacts, capture, accounting, material, uses, owner, materialOwners, events, pending, options,
		onCheck(fn: typeof checkHook) {checkHook = fn;}, onCapture(fn: typeof captureHook) {captureHook = fn;},
		onPrepare(fn: typeof prepareHook) {prepareHook = fn;},
		commit(value: boolean) {commitResult = value;}, prepared(value: boolean) {prepareResult = value;},
		runtimePrepared(value: boolean) {runtimePrepared = value;}, identity(value: object) {runtimeIdentity = value;},
		get observed() {return observed;}, get publishes() {return publishes;}, get checks() {return checks;},
		get runtimeCommits() {return runtimeCommits;}, get numericalCommits() {return numericalCommits;},
	};
}

describe("warm readiness source factory safety", () => {
	it("stages fresh later-epoch native baselines and complete annotated PRE without mutating the old source", async () => {
		const f = fixture(), oldCapacity = f.seed.capacity;
		const token = await f.run(); expect(token).toBeDefined(); expect(token).not.toBe(f.source);
		const upgraded = f.registry.get(token!);
		expect(upgraded.currentTrust).toBe(f.seed.currentTrust); expect(upgraded.identity).toBe(f.seed.identity);
		expect(upgraded.nativeIssuance).toEqual(f.capture.nativeIssuance); expect(upgraded.nativeIssuance).not.toBe(f.capture.nativeIssuance);
		expect(upgraded.journal).toEqual(f.capture.journal); expect(upgraded.journal).not.toBe(f.capture.journal);
		expect(upgraded.knownMaterial).toEqual(f.material); expect(upgraded.knownMaterialUses).toEqual(f.uses);
		expect(upgraded.knownProtectedMaterial).toEqual([f.material[0]]);
		expect(upgraded.runtimeCensusObservation).toBeUndefined(); expect(upgraded.replaceableJournalObservation).toBeUndefined();
		expect(f.seed.capacity).toBe(oldCapacity); expect(f.seed.knownMaterial).toEqual([Uint8Array.of(99)]);
		expect(f.observed.actualCapture).toBe(f.capture); expect(f.observed.options).toBe(f.options);
		expect(f.events.slice(-4)).toEqual(["check:2", "runtime-commit", "numerical-commit", "publish"]);
		expect(f.accounting.chargedBytes).toBe(5); expect(f.pending.size).toBe(0);
		f.capture.nativeIssuance.rows[0]!.fill(44); f.capture.journal.rows[0]!.fill(55);
		expect(upgraded.nativeIssuance.rows[0]).toEqual(Uint8Array.of(8));
		expect(upgraded.journal.rows[0]).toEqual(Uint8Array.of(7));
	});
	it("refuses copied, capacity-only, wrong-book, missing-port and already-rebased owners before preparation", async () => {
		for (const change of ["copy", "capacity-only", "wrong-book", "wrong-limit", "missing-port", "already-rebased"] as const) {
			const f = fixture();
			if (change === "capacity-only") Object.assign(f.facts, {preparedCapacityOnly: true});
			if (change === "wrong-book") f.facts.frame.accounting = {...f.accounting};
			if (change === "wrong-limit") f.accounting.maxBytes--;
			if (change === "missing-port") f.facts.runtime.captureReadinessPreparation = undefined as never;
			if (change === "already-rebased") Object.assign(f.seed, {readinessRebased: true});
			expect(await f.run(change === "copy" ? {...f.proof} : f.proof)).toBeUndefined();
			expect(f.events).toEqual([]); expect(f.publishes).toBe(0); expect(f.pending.size).toBe(0);
		}
	});
	it("retains UNKNOWN rather than converting it into reusable known material or refunding the book", async () => {
		for (const change of ["unknown", "annotations", "missing-owner"] as const) {
			const f = fixture();
			if (change === "unknown") f.accounting.chargedBytes++;
			if (change === "annotations") f.owner.captureKnownMaterialUses = () => [];
			if (change === "missing-owner") f.materialOwners.delete(f.accounting);
			const before = f.accounting.chargedBytes;
			expect(await f.run()).toBeUndefined(); expect(f.accounting.chargedBytes).toBe(before);
			expect(f.numericalCommits).toBe(0); expect(f.runtimeCommits).toBe(0); expect(f.publishes).toBe(0);
		}
	});
	it("preserves a still-retained runtime observation and its complete original annotations", async () => {
		const f = fixture();
		f.material.push(f.seed.runtimeCensusObservation.bytes.slice());
		f.uses.push({protected: true, nativeReaderRefs: ["runtime-observation"]});
		f.accounting.chargedBytes++;
		const token = await f.run(); expect(token).toBeDefined();
		const upgraded = f.registry.get(token!);
		expect(upgraded.runtimeCensusObservation).toBe(f.seed.runtimeCensusObservation);
		expect(upgraded.knownMaterial).toEqual(f.material); expect(upgraded.knownMaterialUses).toEqual(f.uses);
		expect(upgraded.knownProtectedMaterial).toEqual([f.material[0], f.material[2]]);
		expect(f.accounting.chargedBytes).toBe(6);
	});
	it("checks fresh currency before capture and again after numerical callbacks; failures publish nothing", async () => {
		for (const failAt of [1, 2]) {
			const f = fixture(); f.onCheck(count => {if (count === failAt) throw Error("native-currency-stale");});
			await expect(f.run()).rejects.toThrow("native-currency-stale");
			expect(f.runtimeCommits).toBe(0); expect(f.numericalCommits).toBe(0); expect(f.publishes).toBe(0);
			expect(f.pending.size).toBe(0);
		}
	});
	it("revokes proof/source/context identity changes even when the detached bytes still look unchanged", async () => {
		for (const change of ["proof", "source", "context"] as const) {
			const f = fixture(); f.onPrepare(() => {
				if (change === "proof") f.proofFacts.delete(f.proof);
				if (change === "source") f.registry.set(f.source, {...f.seed});
				if (change === "context") f.identity({});
			});
			await expect(f.run()).rejects.toThrow("snapshot-unavailable");
			expect(f.runtimeCommits).toBe(0); expect(f.numericalCommits).toBe(0); expect(f.publishes).toBe(0);
		}
	});
	it("keeps the admitted task in the original join set until all callbacks and final checks settle", async () => {
		const f = fixture(); let unblock!: () => void, entered!: () => void;
		const started = new Promise<void>(resolve => {entered = resolve;});
		f.onPrepare(async () => {entered(); await new Promise<void>(resolve => {unblock = resolve;});});
		const running = f.run(); await started;
		expect(f.pending.size).toBe(1); expect(f.publishes).toBe(0);
		f.identity({}); unblock(); await expect(running).rejects.toThrow("snapshot-unavailable");
		expect(f.pending.size).toBe(0); expect(f.publishes).toBe(0);
	});
	it("does not enroll inconclusive preparation or a changed runtime commit", async () => {
		for (const change of ["no-runtime", "no-program", "changed-runtime"] as const) {
			const f = fixture();
			if (change === "no-runtime") f.runtimePrepared(false);
			if (change === "no-program") f.prepared(false);
			if (change === "changed-runtime") f.commit(false);
			expect(await f.run()).toBeUndefined(); expect(f.numericalCommits).toBe(0); expect(f.publishes).toBe(0);
			expect(f.seed.capacity.readiness).toEqual({old: true}); expect(f.accounting.chargedBytes).toBe(5);
		}
	});
	it("limits rebase retention to one generation and requires a fresh cold boundary for the next upgrade", async () => {
		const f = fixture(), token = await f.run(); expect(token).toBeDefined();
		const nextProof = {accounting: f.accounting};
		f.proofFacts.set(nextProof, {...f.facts, source: token});
		expect(await f.rawRun(nextProof, f.options)).toBeUndefined();
		expect(f.publishes).toBe(1); expect(f.runtimeCommits).toBe(1); expect(f.numericalCommits).toBe(1);
	});
});

function productionDeclaration(name: string): ts.FunctionDeclaration {
	const selected = ast.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (selected === undefined) throw Error(`PRODUCTION_DECLARATION_MISSING:${name}`);
	return selected;
}
function executeProduction<T>(code: string, context: Record<string, unknown>): T {
	const compiled = ts.transpile(code, {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None});
	return new Function(...Object.keys(context), `return eval(${JSON.stringify(compiled)});`)(...Object.values(context)) as T;
}
const canonicalEqual = (a: unknown, b: unknown): boolean => compareBytes(encodeCanonical(a), encodeCanonical(b)) === 0;
const mandatoryContext = {record: decodeCanonical, compareBytes, closedRetirementEqual: canonicalEqual,
	openAuthorFenceOperation, applySettlementPlanEffect};
function fenceFixture() {
	const context = {objectId: "room", currentEpoch: 4, currentAnchorDigest: "anchor"}, authorSequence = 7;
	const candidate: any = {kind: "drp-vertex", protocolMajor: 3, objectId: "room", epoch: 4, anchor: "anchor",
		author: "writer", authorSequence, operation: {action: "$drp.author-fence.v1", version: 1, fenceSequence: authorSequence}};
	const bytes = encodeCanonical(candidate), source = {objectId: "room", author: "writer"};
	const old = {...source, authorSequence: 6, canonicalPreimageBytes: Uint8Array.of(6),
		digest: new Uint8Array(32).fill(6), signature: new Uint8Array(64).fill(6)};
	const added = {...source, authorSequence, canonicalPreimageBytes: bytes, digest: new Uint8Array(32).fill(7),
		signature: new Uint8Array(64).fill(7)};
	const prior: any = {lineages: [{...source, next: authorSequence, exhausted: false, prunedThroughAuthorSequence: null},
		{objectId: "room", author: "other", next: 3, exhausted: false, prunedThroughAuthorSequence: null}],
		plans: [{scope: source, revision: 2, fenceSequence: null, entries: [{disposition: "expire", sourceSequence: 4,
			sourceDigest: new Uint8Array(32).fill(4), replacementSequence: null}]},
			{scope: {objectId: "room", author: "other"}, revision: 1, fenceSequence: null, entries: []}],
		issued: [old], outbox: [{...old, publishState: "published"}]};
	const present: any = {...prior, lineages: [{...prior.lineages[0], next: 8}, prior.lineages[1]],
		plans: [applySettlementPlanEffect(prior.plans[0], {kind: "fence"}, 7), prior.plans[1]],
		issued: [old, added], outbox: [...prior.outbox, {...added, publishState: "pending"}]};
	const fence = {exactCanonicalPreimageBytes: bytes, author: "writer", authorSequence};
	const copy = <T>(value: T): T => decodeCanonical(encodeCanonical(value)) as T;
	const issuedCorrespond = executeProduction<(...args: any[]) => boolean>(
		`${productionDeclaration("creatorOrdinaryNativeIssuedCorresponds").getText(ast)}\ncreatorOrdinaryNativeIssuedCorresponds;`, mandatoryContext);
	const corresponds = executeProduction<(...args: any[]) => boolean>(
		`${productionDeclaration("creatorOrdinaryMandatoryFencePlansCorrespond").getText(ast)}\ncreatorOrdinaryMandatoryFencePlansCorrespond;`,
		{...mandatoryContext, creatorOrdinaryNativeIssuedCorresponds: issuedCorrespond});
	// Actual signature verification is the independent current-plane owner's
	// premise; these predicates ensure both helpers call that exact owner.
	const verify = (row: unknown): boolean => canonicalEqual(row, added);
	return {context, candidate, prior, present, fence, added, copy, corresponds, verify,
		check: (actual = present, before = prior, hint = fence, current = context) =>
			corresponds(actual, before, current, hint, verify)};
}

describe("mandatory fence immutable-source handoff", () => {
	it("propagates the exact fresh verifier error, preserves false refusal and never verifies malformed syntax", () => {
		const f = fenceFixture(), failure = new Error("fresh-fence-verifier-revoked");
		let observed: unknown, calls = 0;
		try {
			f.corresponds(f.present, f.prior, f.context, f.fence, () => {calls++; throw failure;});
		} catch (cause) {observed = cause;}
		expect(observed).toBe(failure); expect(calls).toBe(1);
		expect(f.corresponds(f.present, f.prior, f.context, f.fence, () => false)).toBe(false);
		calls = 0;
		for (const bytes of [Uint8Array.of(255), encodeCanonical({...f.candidate, operation: {action: "move"}})]) {
			expect(f.corresponds(f.present, f.prior, f.context, {...f.fence, exactCanonicalPreimageBytes: bytes},
				() => {calls++; throw failure;})).toBe(false);
		}
		expect(calls).toBe(0);
	});
	it("accepts only the exact one-fence nonempty-plan postimage and keeps other plans, lineages and old rows exact", () => {
		const f = fenceFixture(); expect(f.check()).toBe(true);
		expect(f.present.plans[0]).toEqual(applySettlementPlanEffect(f.prior.plans[0], {kind: "fence"}, 7));
		expect(f.present.plans[1]).toEqual(f.prior.plans[1]);
	});
	it("rejects foreign/altered preimage context, author/sequence and malformed or non-fence operations", () => {
		const f = fenceFixture();
		for (const patch of [{objectId: "foreign"}, {epoch: 3}, {anchor: "foreign"}, {author: "other"},
			{authorSequence: 6}, {kind: "other"}, {protocolMajor: 2}, {operation: {action: "move", x: 1}},
			{operation: {...f.candidate.operation, version: 2}}, {operation: {...f.candidate.operation, extra: true}},
			{operation: {...f.candidate.operation, fenceSequence: 6}}]) {
			const hint = {...f.fence, exactCanonicalPreimageBytes: encodeCanonical({...f.candidate, ...patch})};
			expect(f.check(f.present, f.prior, hint)).toBe(false);
		}
		expect(f.check(f.present, f.prior, {...f.fence, exactCanonicalPreimageBytes: Uint8Array.of(255)})).toBe(false);
		expect(f.check(f.present, f.prior, f.fence, {...f.context, objectId: "foreign"})).toBe(false);
	});
	it("requires the current signed-leaf verifier, complete exact old rows and no extra new issuance/outbox", () => {
		const f = fenceFixture();
		expect(f.corresponds(f.present, f.prior, f.context, f.fence, () => false)).toBe(false);
		for (const changed of ["digest", "signature", "old-issued", "old-outbox", "missing-old", "extra-issued", "extra-outbox",
			"new-outbox-digest", "new-outbox-author", "new-outbox-context", "no-fence-outbox", "new-outbox-state"] as const) {
			const actual = f.copy(f.present);
			if (changed === "digest") actual.issued[1].digest[0] ^= 1;
			if (changed === "signature") actual.issued[1].signature[0] ^= 1;
			if (changed === "old-issued") actual.issued[0].signature[0] ^= 1;
			if (changed === "old-outbox") actual.outbox[0].publishState = "pending";
			if (changed === "missing-old") {actual.issued.shift(); actual.outbox.shift();}
			if (changed === "extra-issued") actual.issued.push({...actual.issued[1], authorSequence: 8});
			if (changed === "extra-outbox") actual.outbox.push({...actual.outbox[1], authorSequence: 8});
			if (changed === "new-outbox-digest") actual.outbox[1].digest[0] ^= 1;
			if (changed === "new-outbox-author") actual.outbox[1].author = "other";
			if (changed === "new-outbox-context") actual.outbox[1].objectId = "foreign";
			if (changed === "no-fence-outbox") actual.outbox[1].authorSequence = 6;
			if (changed === "new-outbox-state") actual.outbox[1].publishState = "forbidden";
			expect(f.check(actual)).toBe(false);
		}
	});
	it("rejects unrelated plan/revision or lineage changes, preexisting fences and pending unsigned work", () => {
		const f = fenceFixture();
		for (const changed of ["foreign-plan", "plan-revision", "selected-plan", "lineage", "other-lineage", "duplicate-plan"] as const) {
			const actual = f.copy(f.present);
			if (changed === "foreign-plan") actual.plans[1].scope.objectId = "foreign";
			if (changed === "plan-revision") actual.plans[1].revision++;
			if (changed === "selected-plan") actual.plans[0].entries[0].sourceSequence++;
			if (changed === "lineage") actual.lineages[0].next++;
			if (changed === "other-lineage") actual.lineages[1].next++;
			if (changed === "duplicate-plan") actual.plans.push(actual.plans[0]);
			expect(f.check(actual)).toBe(false);
		}
		for (const changed of ["fenced", "exhausted", "pending", "sequence"] as const) {
			const before = f.copy(f.prior);
			if (changed === "fenced") before.plans[0].fenceSequence = 6;
			if (changed === "exhausted") before.lineages[0].exhausted = true;
			if (changed === "pending") before.lineages[0].pendingUnsigned = {};
			if (changed === "sequence") before.lineages[0].next = 8;
			expect(f.check(f.present, before)).toBe(false);
		}
	});
	it("requires nominal fence purpose and the exact original frame/book before a maintenance proof can capture DATA", () => {
		const cold = productionDeclaration("captureCreatorOrdinaryIssuanceProofSource");
		const guard = cold.body!.statements.find((node): node is ts.IfStatement => ts.isIfStatement(node) &&
			node.expression.getText(ast).includes("custody?.kind"));
		expect(guard).toBeDefined();
		const run = (change = "valid") => {
			const trust = {}, accounting = {maxBytes: 4_194_304}, frame: any = {alive: true, accounting, maintenanceCapture: {currentTrust: trust}};
			const proof = {accounting, currentTrust: trust}, custody: any = {kind: "terminal", adoptionFencePurpose: true};
			const context: any = {custody, frame, proof, forward: {wholeFloor: {pending: null}},
				adoptionFenceUnsignedBytes: Uint8Array.of(1), fenceBytes: Uint8Array.of(1), readiness: undefined,
				CREATOR_ORDINARY_PROOF_MAX_BYTES: 1_310_720, ledgers: new Map([[accounting, frame]]), decline: (x: string) => x};
			if (change === "arbitrary-maintenance") delete custody.adoptionFencePurpose;
			if (change === "ordinary") context.adoptionFenceUnsignedBytes = undefined;
			if (change === "no-bytes") context.fenceBytes = undefined;
			if (change === "readiness") context.readiness = {};
			if (change === "wrong-book") frame.accounting = {...accounting};
			if (change === "wrong-trust") proof.currentTrust = {};
			if (change === "not-alive") frame.alive = false;
			return executeProduction<string>(`(()=>{${guard!.getText(ast)};return "accepted";})();`, context);
		};
		expect(run()).toBe("accepted");
		for (const change of ["arbitrary-maintenance", "ordinary", "no-bytes", "readiness", "wrong-book", "wrong-trust", "not-alive"])
			expect(run(change)).toBe("cold-owner-or-purpose");
		const mint: ts.SpreadAssignment[] = [];
		const visit = (node: ts.Node): void => {if (ts.isSpreadAssignment(node) &&
			node.expression.getText(ast).includes("adoptionFencePurpose: true")) mint.push(node); ts.forEachChild(node, visit);}; visit(ast);
		expect(mint).toHaveLength(1);
		for (const mandatoryAdoptionFence of [false, true]) for (const terminalWithdrawal of [false, true])
			for (const maintenancePurpose of [undefined, "archive-close"]) {
				const value = executeProduction<Record<string, unknown>>(`(${mint[0]!.expression.getText(ast)});`,
					{mandatoryAdoptionFence, terminalWithdrawal, maintenancePurpose});
				expect(value.adoptionFencePurpose === true).toBe(mandatoryAdoptionFence && !terminalWithdrawal && maintenancePurpose === undefined);
			}
	});
	it("retains ordinary corpus and annotation ceilings even for a genuine larger maintenance allowance", () => {
		const cold = productionDeclaration("captureCreatorOrdinaryIssuanceProofSource");
		const task = cold.body!.statements.find((node): node is ts.VariableStatement => ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "task"));
		const nodes: ts.Statement[] = [];
		const visit = (node: ts.Node): void => {if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
			ts.isIdentifier(d.name) && d.name.text === "knownMaterial")) {
			const body = node.parent as ts.Block, index = body.statements.indexOf(node);
			nodes.push(...body.statements.slice(index, index + 5));
		} ts.forEachChild(node, visit);}; visit(task!);
		expect(nodes).toHaveLength(5);
		const run = (bytes: number, charged: number, annotations = 1) => {
			const accounting = {maxBytes: 40, chargedBytes: charged};
			return executeProduction<string>(`(()=>{${nodes.map(node => node.getText(ast)).join("\n")}return "accepted";})();`, {
				frame: {accounting}, CREATOR_ORDINARY_PROOF_MAX_BYTES: 10,
				proofMaterialOwners: new Map([[accounting, {captureKnownMaterial: () => [new Uint8Array(bytes)],
					captureKnownMaterialUses: () => Array(annotations).fill({protected: true})}]]), decline: (x: string) => x});
		};
		expect(run(10, 10)).toBe("accepted"); expect(run(11, 11)).toBe("ordinary-source-retention-capacity");
		expect(run(9, 10)).toBe("known-material-UNKNOWN-mismatch");
		expect(run(10, 10, 0)).toBe("known-material-annotation-mismatch");
	});
	it("validates the actual pre-fence candidate/source-plan block and forwards exact candidate bytes through the scoped wrapper", () => {
		const cold = productionDeclaration("captureCreatorOrdinaryIssuanceProofSource");
		let block: ts.IfStatement | undefined;
		const visit = (node: ts.Node): void => {if (ts.isIfStatement(node) && node.expression.getText(ast) === "fenceBytes !== undefined") block = node;
			ts.forEachChild(node, visit);}; visit(cold);
		expect(block).toBeDefined();
		const f = fenceFixture();
		const run = (candidate: any, rows = f.prior) => executeProduction<any>(`(()=>{let adoptionFencePostimage;
			${block!.getText(ast)};return adoptionFencePostimage;})();`, {...mandatoryContext,
			fenceBytes: encodeCanonical(candidate), frame: {input: {objectId: "room"}, accounting: {}},
			forward: {currentTrust: f.context}, native: {rows}, decline: (reason: string) => reason,
			requireLaw: (value: unknown) => {if (!value) throw Error("proof-budget-exceeded");}, chargeProofObservation: () => true});
		expect(run(f.candidate)).toEqual(f.fence);
		expect(run({...f.candidate, operation: {action: "move"}})).toBe("mandatory-fence-candidate-context");
		expect(run({...f.candidate, anchor: "foreign"})).toBe("mandatory-fence-candidate-context");
		expect(run(f.candidate, {...f.prior, plans: []})).toBe("mandatory-fence-source-plan");
		let forwarded: unknown[] | undefined;
		const wrapper = executeProduction<(...args: unknown[]) => unknown>(
			`${productionDeclaration("captureCreatorOrdinaryIssuanceProofSourceForFence").getText(ast).replace(/^export /u, "")}\ncaptureCreatorOrdinaryIssuanceProofSourceForFence;`,
			{captureCreatorOrdinaryIssuanceProofSource: (...args: unknown[]) => {forwarded = args; return "captured";}});
		const proof = {}; expect(wrapper(proof, f.fence.exactCanonicalPreimageBytes)).toBe("captured");
		expect(forwarded).toEqual([proof, undefined, f.fence.exactCanonicalPreimageBytes]);
		expect(forwarded![2]).toBe(f.fence.exactCanonicalPreimageBytes);
	});
});
