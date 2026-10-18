import {readFileSync} from "node:fs";
import {compareBytes, decodeCanonical, encodeCanonical} from "@ts-drp/canonical";
import {canonicalCarrierResourceForSizing} from "@ts-drp/canonical/resource";
import {settlementProfileFor} from "@ts-drp/protocol-v3/settlement-profile";
import {openTrustedBlueprintCatalogBytes} from "@ts-drp/blueprint-catalog/bytes";
import {createZoneStateKernel} from "../../../examples/grid/src/zone-state.js";
import * as ts from "typescript";
import {describe, expect, it} from "vitest";

// Actual original kernel and private numerical/delivery bodies, controlled
// nominal/native responses only. These fixtures confer no signature, proof,
// admitted control capability or native/ledger credit. Original native V1
// current-book/factory controls remain the end-to-end acceptance oracle.
const source = readFileSync(new URL("../src/internal/creator-closed-rollback-data.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("original.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
	const node = tree.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === name);
	if (node === undefined) throw new Error(`missing original resource owner: ${name}`);
	return node.getText(tree).replace(/^export /, "");
}
function execute<T>(body: string, bindings: Record<string, unknown>): T {
	const js = ts.transpileModule(body, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
	return new Function("bindings", `const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`)(bindings) as T;
}
const fence = {action: "$drp.author-fence.v1", fenceSequence: 3, version: 1};

describe("room-local finishing-window preparation policy", () => {
	const roomSource = readFileSync(new URL("../src/v3-room.ts", import.meta.url), "utf8");
	const roomTree = ts.createSourceFile("v3-room.ts", roomSource, ts.ScriptTarget.Latest, true);
	const selectOwner = roomTree.statements.find((node): node is ts.FunctionDeclaration =>
		ts.isFunctionDeclaration(node) && node.name?.text === "roomOrdinaryFinishingWindowForEpoch");
	if (selectOwner === undefined) throw new Error("missing original room-local finishing policy owner");
	const select = execute<(application: any, context: any) => any>(selectOwner.getText(roomTree) +
		"\nreturn roomOrdinaryFinishingWindowForEpoch;", {});
	it("keeps static/absent configuration and selects startup versus genuine successor/reopen context only at preparation", () => {
		const startup = Object.freeze({local: 8, received: 192}), successor = Object.freeze({local: 5, received: 128});
		expect(select({}, {objectId: "room", epoch: 0})).toBeUndefined();
		expect(select({ordinaryFinishingWindow: startup}, {objectId: "room", epoch: 3})).toBe(startup);
		const calls: any[] = [], configured = {ordinaryFinishingWindow(this: unknown, context: any) {
			expect(this).toBe(application); expect(Object.isFrozen(context)).toBe(true);
			expect(Object.keys(context)).toEqual(["objectId", "epoch"]); calls.push(context);
			return context.epoch === 0 ? startup : successor;
		}};
		// SAME room input snapshot: caller replacement does not replace its policy.
		const application = Object.freeze({...configured});
		configured.ordinaryFinishingWindow = () => {throw new Error("caller replacement");};
		expect(select(application, {objectId: "room", epoch: 0})).toBe(startup);
		expect(select(application, {objectId: "room", epoch: 3})).toBe(successor);
		expect(select(application, {objectId: "room", epoch: 3})).toBe(successor); // persisted reopen
		expect(calls).toHaveLength(3);
	});
	it("does not turn an absent/throwing selector result into disabled enforcement", () => {
		expect(() => select({ordinaryFinishingWindow: () => undefined}, {objectId: "room", epoch: 0})).toThrow("did not return limits");
		const failure = new Error("local configuration unavailable");
		expect(() => select({ordinaryFinishingWindow: () => {throw failure;}}, {objectId: "room", epoch: 3})).toThrow(failure);
		const bindOwners = roomTree.statements.filter((node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.getText(roomTree).includes("bindCurrentCreatorClose = (plane)"));
		expect(bindOwners).toHaveLength(1);
		expect(bindOwners[0]!.getText(roomTree)).toContain('reason: "CREATOR_ORDINARY_FINISHING_WINDOW_INVALID"');
	});
});

function kernelFixture(version: "current" | "predecessor" = "current") {
	const author = "a".repeat(64), kernel = createZoneStateKernel(author, "creator-peer", version);
	const state = kernel.apply(kernel.emptyState(), {action: "installRoster", roster: {entries: [{author, peerId: "creator-peer", order: 0}]}}, author).state;
	const seed = {exactCanonicalBaseStateBytes: [encodeCanonical(state)], currentOperations: [], protectedOperations: [], recoveryOperations: []};
	return {kernel, state, seed};
}
function fixture(control = true, version: "current" | "predecessor" = "current") {
	const {kernel, seed} = kernelFixture(version), events: string[] = [], sourceHandle = {}, unsigned = encodeCanonical({exactCandidate: fence});
	const frame = {alive: true, pending: new Set<Promise<unknown>>()};
	const chargedKnown: Uint8Array[] = [];
	const proof = {accounting: {chargedBytes: 64,
		charge(bytes: Uint8Array) {
			if (!chargedKnown.some(prior => compareBytes(prior, bytes) === 0)) {
				chargedKnown.push(bytes.slice()); this.chargedBytes += bytes.byteLength;
			}
			return true;
		},
		chargeUnknownEncodedLength(length: number) {this.chargedBytes += length; return true;}}};
	const state = {current: true, cursorAvailable: true, failCheck: 0, checks: 0, commits: 0, omitQuery: false, accessorQuery: false,
		mutateInput: false, window: false, accessorWindow: false, extraProjection: false,
		onQuery: undefined as (() => void) | undefined};
	const value = (bound: {byteLength: number; items: number; maxDepth: number} | undefined) => bound === undefined ? undefined :
		Object.freeze({byteLength: bound.byteLength, items: bound.items, maxDepth: bound.maxDepth});
	const reader = Object.assign((input: any) => {events.push("reader"); return value(kernel.readPlacementGrowthBound(input.material));}, {
		createIncrementalProjection: (input: any) => {
			events.push("create"); expect(input.material).not.toHaveProperty("candidateOperation");
			const projection = kernel.createPlacementGrowthProjection(input.material); if (projection === undefined) return undefined;
			const result: any = {advance: (operations: unknown[]) => {events.push("advance"); return projection.advance(operations);},
				quote: (operation: unknown) => {events.push("quote"); return value(projection.quote(operation));}};
			if (!state.omitQuery) result.quoteWithoutApplicationCandidate = () => {
				events.push("unchanged"); state.onQuery?.();
				if (state.mutateInput) input.material.currentOperations.push({action: "bad-mutation"});
				return value(projection.quoteWithoutApplicationCandidate());
			};
			if (state.accessorQuery) Object.defineProperty(result, "quoteWithoutApplicationCandidate", {get: () => {throw new Error("accessor invoked");}});
			if (state.window) result.quoteWindow = (declaration: Parameters<typeof projection.quoteWindow>[0]) => {
				events.push("window"); return projection.quoteWindow(declaration);
			};
			if (state.accessorWindow) Object.defineProperty(result, "quoteWindow", {get: () => {throw new Error("window accessor invoked");}});
			if (state.extraProjection) result.unowned = () => undefined;
			return result;
		},
	});
	const capacity: {application: any; template: any; readiness?: any} = {application: undefined, template: undefined}, sourceFacts = {capacity};
	const runtime = {captureApplicationResourceCursor: () => state.cursorAvailable ? {} : undefined, readApplicationResourceDelta: () => [],
		resolveCurrentDimensions: (current: unknown) => state.current ? current : undefined};
	const owner = {source: sourceHandle, frame, runtime, numerical: {}, check: async () => {
		state.checks++; events.push(`check:${state.checks}`);
		if (!frame.alive || state.checks === state.failCheck) throw new Error("original-native-currentness");
	}};
	const current: any = {runtime: {profileId: "creator-trusted-settlement-v1"}, blueprint: {maxApplicationStateBytes: 65536, maxItems: 16384, maxDepth: 16},
		candidate: {control, exactCanonicalOperationBytes: encodeCanonical(fence)}};
	const facts: any = {proof, source: sourceHandle, frame, sourceFacts, proofFacts: owner, current,
		chargedBytes: proof.accounting.chargedBytes, unsignedBytes: unsigned};
	let deliveredFacts: any;
	const api = execute<{derive(facts: any, reader: any): any; prepare(proof: any, bytes: Uint8Array, options: any): Promise<any>}>(`
		${["resolveCreatorOrdinaryNumericalDimensions", "creatorOrdinaryCurrentDimensionStampMatchesForSizing", "deriveCreatorOrdinaryApplicationResourceForSizing",
			"creatorOrdinarySizingRecord", "captureCreatorOrdinaryFinishingWindowLimitsForSizing",
			"creatorOrdinaryFinishingWindowCandidateUsageForSizing", "creatorOrdinaryFinishingWindowCanAdmitForSizing",
			"reserveCreatorOrdinaryFinishingCapacity"].map(declaration).join("\n")}
		return {derive: deriveCreatorOrdinaryApplicationResourceForSizing, prepare: reserveCreatorOrdinaryFinishingCapacity};`, {
		settlementProfileFor, decodeCanonical, record: decodeCanonical, encodeCanonical, compareBytes, closedRetirementBytes: encodeCanonical,
		canonicalCarrierResourceForSizing,
		LIVE_JOURNAL_RETIREMENT_LIMITS: {maxRows: 24576}, AHE_BOUNDED_READ_LIMITS: {maxBlobBytes: 65536, maxUnionBytes: 786432},
		CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4194304,
		creatorOrdinaryApplicationResourceInput: () => ({catalog: {}, material: {...structuredClone(seed), candidateOperation: structuredClone(fence)}}),
		creatorOrdinaryIssuanceProofFacts: (value: unknown) => value === proof && frame.alive ? owner : undefined,
		creatorOrdinaryIssuanceSourceFacts: (value: unknown) => value === sourceHandle ? sourceFacts : undefined,
		captureCreatorOrdinaryCurrentDimensionsForSizing: (_proof: unknown, bytes: Uint8Array) =>
			({...facts, unsignedBytes: bytes, chargedBytes: proof.accounting.chargedBytes}),
		creatorOrdinarySettlementCapacityFactsForSizing: (value: unknown) => value,
		deriveCreatorOrdinaryFinishingCapacityForSizing: (value: unknown, _proof: unknown, bytes: Uint8Array) => {
			deliveredFacts = value; events.push("finishing");
			return {capacity: {knownCarriers: [bytes.slice()], unknownEncodedLengths: [64, 128], fullFutureProofEnvelopeByteLengths: [128, 256, 512, 1024]},
				commit: () => {events.push("commit"); state.commits++; capacity.template = {delivered: true};}};
		}, Refusal: Error, failure: (code: string) => code,
	});
	return {kernel, seed, events, state, capacity, facts, reader, proof, frame, current, runtime, unsigned, api,
		get deliveredFacts() {return deliveredFacts;}, run: () => api.prepare(proof, unsigned, {reader})};
}

describe("explicit unchanged-APP numerical query (no operation authority)", () => {
	it("keeps the unchanged prepared projection after oversized refusal, admits valid continuation, and still invalidates stale currency", async () => {
		const f = fixture(); expect(await f.run()).toBeDefined();
		Object.assign(f.current, {parameters: {maxEpochVertices: 8192, maxEpochBytes: 8388608}, currentEpochVertexCount: 0,
			currentSignedPreimageByteLengths: []});
		Object.assign(f.current.runtime, {kind: "local-issuance", graphVersion: 0, epochBytes: 0});
		Object.assign(f.current.candidate, {operationCount: 1, exactCanonicalEpochVertexBytes: new Uint8Array(128)});
		const policy = {maxAdditionalLocalRows: 4, maxAdditionalReceivedRows: 4, maxAdditionalActions: 32,
			maxAdditionalOperationBytes: 1024, maxAdditionalPreimageBytes: 4096, maxAdditionalEpochVertexBytes: 3072,
			maxCanonicalOperationByteLength: 1024, maxCanonicalPreimageByteLength: 1024, maxCanonicalEpochVertexByteLength: 1024,
			maxSuccessorFencePreimageByteLength: 1024, maxReceivedPendingIngressByteLength: 2048,
			maxApplicationBytes: 16384, maxApplicationItems: 4096, maxApplicationDepth: 8};
		f.capacity.readiness = {geometry: {graphVersion: 0, baseGraphCount: 0, basePreimageCount: 0, acceptedCount: 0, localIssuedCount: 0},
			window: {declaredLimits: policy, limits: policy, acceptedActions: 0, acceptedOperationBytes: 0, acceptedPreimageBytes: 0, acceptedEpochVertexBytes: 0}};
		const before = f.capacity.application, charged = f.proof.accounting.chargedBytes, eventCount = f.events.length;
		const options = {reader: f.reader, window: policy};
		await expect(f.api.prepare(f.proof, new Uint8Array(1025), options)).rejects.toThrow("explicit boundary maintenance");
		expect(f.capacity.application).toBe(before); expect(f.proof.accounting.chargedBytes).toBe(charged);
		expect(f.events.slice(eventCount)).toEqual(["check:3", "check:4"]);
		expect(await f.api.prepare(f.proof, f.unsigned, options)).toBeDefined();
		f.state.failCheck = f.state.checks + 2;
		await expect(f.api.prepare(f.proof, new Uint8Array(1025), options)).rejects.toThrow("original-native-currentness");
		expect(f.capacity.application).toBeUndefined();
	});
	it("captures a finite local window without aliases, accessors or protocol authority and meters actual candidate bytes", () => {
		const api = execute<any>(`${["creatorOrdinarySizingRecord", "captureCreatorOrdinaryFinishingWindowLimitsForSizing",
			"creatorOrdinaryFinishingWindowCandidateUsageForSizing", "creatorOrdinaryFinishingWindowCanAdmitForSizing"].map(declaration).join("\n")}
			return {capture:captureCreatorOrdinaryFinishingWindowLimitsForSizing,usage:creatorOrdinaryFinishingWindowCandidateUsageForSizing,
				fits:creatorOrdinaryFinishingWindowCanAdmitForSizing};`, {encodeCanonical,
			LIVE_JOURNAL_RETIREMENT_LIMITS: {maxRows: 24576}, AHE_BOUNDED_READ_LIMITS: {maxBlobBytes: 65536, maxUnionBytes: 786432},
			CREATOR_MAINTENANCE_PROOF_MAX_BYTES: 4194304,
			creatorOrdinaryPreimageResourceGeometryForSizing: () => ({canonicalPreimageByteLength: 512, canonicalEpochVertexByteLength: 384})});
		const limits = {maxAdditionalLocalRows: 4, maxAdditionalReceivedRows: 4, maxAdditionalActions: 32,
			maxAdditionalOperationBytes: 1024, maxAdditionalPreimageBytes: 4096, maxAdditionalEpochVertexBytes: 3072,
			maxCanonicalOperationByteLength: 1024, maxCanonicalPreimageByteLength: 1024, maxCanonicalEpochVertexByteLength: 1024,
			maxSuccessorFencePreimageByteLength: 1024, maxReceivedPendingIngressByteLength: 2048,
			maxApplicationBytes: 16384, maxApplicationItems: 4096, maxApplicationDepth: 8};
		const captured = api.capture(limits); expect(captured).toEqual(limits); expect(captured).not.toBe(limits); expect(Object.isFrozen(captured)).toBe(true);
		limits.maxAdditionalActions = 31; expect(captured.maxAdditionalActions).toBe(32);
		for (const value of [{...limits, extra: 1}, {...limits, maxAdditionalLocalRows: -1}, {...limits, maxAdditionalActions: Infinity},
			{...limits, maxCanonicalPreimageByteLength: 65537}, {...limits, maxAdditionalOperationBytes: 4097},
			{...limits, maxAdditionalPreimageBytes: Number.MAX_SAFE_INTEGER}]) expect(api.capture(value)).toBeUndefined();
		let invoked = false;
		const accessor = {...limits}; Object.defineProperty(accessor, "maxAdditionalActions", {enumerable: true,
			get() {invoked = true; throw Error("declaration accessor");}});
		expect(api.capture(accessor)).toBeUndefined(); expect(invoked).toBe(false);
		const preimage = new Uint8Array(256), operation = encodeCanonical({action: "placeBlock", id: "x", kind: "stone", x: 0, y: 0});
		const current: any = {runtime: {kind: "local-issuance", graphVersion: 3, epochBytes: 256},
			parameters: {maxEpochVertices: 8192, maxEpochBytes: 8388608}, currentEpochVertexCount: 3, currentSignedPreimageByteLengths: [256, 256],
			candidate: {operationCount: 1, control: false, exactCanonicalOperationBytes: operation, exactCanonicalEpochVertexBytes: new Uint8Array(192)},
			pendingIngress: {roots: []}};
		const window = {declaredLimits: captured, limits: captured, acceptedActions: 0, acceptedOperationBytes: 0, acceptedPreimageBytes: 0, acceptedEpochVertexBytes: 0};
		const readiness = {window, geometry: {graphVersion: 3, baseGraphCount: 3, basePreimageCount: 2, acceptedCount: 0, localIssuedCount: 0}};
		expect(api.usage(current, preimage)).toMatchObject({localRows: 1, receivedRows: 0, actions: 1,
			operationBytes: operation.byteLength, preimageBytes: 256, vertexBytes: 192});
		expect(api.fits(readiness, current, preimage, captured)).toBe(true);
		for (const field of ["acceptedActions", "acceptedOperationBytes", "acceptedPreimageBytes", "acceptedEpochVertexBytes"] as const) {
			const ceilings = {acceptedActions: captured.maxAdditionalActions, acceptedOperationBytes: captured.maxAdditionalOperationBytes,
				acceptedPreimageBytes: captured.maxAdditionalPreimageBytes, acceptedEpochVertexBytes: captured.maxAdditionalEpochVertexBytes};
			expect(api.fits({...readiness, window: {...window, [field]: ceilings[field]}}, current, preimage, captured)).toBe(false);
		}
		expect(api.fits(readiness, current, preimage, {...captured, maxAdditionalActions: 31})).toBe(false);
		expect(api.fits(readiness, {...current, runtime: {...current.runtime, graphVersion: 4}}, preimage, captured)).toBe(false);
		expect(api.fits({...readiness, geometry: {...readiness.geometry, localIssuedCount: 4}}, current, preimage, captured)).toBe(false);
		current.runtime.kind = "received-append";
		expect(api.fits(readiness, current, preimage, captured)).toBe(true);
		const smaller = {...readiness, window: {...window, limits: {...captured, maxAdditionalReceivedRows: 1}}};
		expect(api.fits(smaller, current, preimage, captured)).toBe(true);
		for (const [key, maximum] of [["maxAdditionalOperationBytes", operation.byteLength - 1],
			["maxAdditionalPreimageBytes", preimage.byteLength - 1], ["maxAdditionalEpochVertexBytes", 191]] as const) {
			const effective = {...captured, [key]: maximum,
				maxAdditionalOperationBytes: Math.min(captured.maxAdditionalOperationBytes, maximum)};
			expect(api.capture(effective)).toBeDefined();
			// The configured declaration would admit this input. The actual
			// smaller certified budget must refuse it instead, before any effect.
			expect(api.fits({...readiness, window: {...window, limits: effective}}, current, preimage, captured)).toBe(false);
		}
		const afterOne = {...current, currentEpochVertexCount: 4, currentSignedPreimageByteLengths: [256, 256, 256],
			runtime: {...current.runtime, graphVersion: 4}};
		expect(api.fits({...smaller, geometry: {...readiness.geometry, graphVersion: 4, acceptedCount: 1}}, afterOne, preimage, captured)).toBe(false);
		expect(api.fits({...readiness, window: {...window, limits: {...captured, maxAdditionalReceivedRows: 5}}}, current, preimage, captured)).toBe(false);
		current.pendingIngress = {roots: [new Uint8Array(2048)]}; expect(api.fits(readiness, current, preimage, captured)).toBe(false);
		current.runtime.kind = "local-issuance"; current.candidate.control = true;
		const suffix = {additionalLocalVertices: 4, applicationOperationCount: 3, graphVersion: 3, exactCanonicalApplicationOperationBytes: operation};
		current.runtime.issuanceScope = {author: "a".repeat(64)};
		expect(api.usage(current, preimage, suffix)).toMatchObject({localRows: 4, receivedRows: 0, actions: 6,
			preimageBytes: 256 + 3 * 512, vertexBytes: 192 + 3 * 384});
		expect(api.fits(readiness, current, preimage, captured, suffix)).toBe(true);
		const smallerLocal = {...readiness, window: {...window, limits: {...captured, maxAdditionalLocalRows: 3}}};
		expect(api.fits(smallerLocal, current, preimage, captured, suffix)).toBe(false); // Refuse ALL four before the first join.
		expect(smallerLocal.geometry.localIssuedCount).toBe(0);
		expect(api.fits(smallerLocal, current, preimage, captured)).toBe(true); // Refusal did not consume new capacity.
		expect(api.fits(readiness, current, preimage, captured, {...suffix, applicationOperationCount: 17})).toBe(false);
	});
	it("accepts an optional whole-window method without invoking it as ordinary authority, while rejecting accessors and unknown methods", async () => {
		for (const version of ["current", "predecessor"] as const) {
			const f = fixture(true, version); f.state.window = true;
			expect(await f.run()).toBeDefined();
			expect(f.events).toContain("unchanged"); expect(f.events).not.toContain("window");
			expect(f.capacity.application.projection.quoteWindow({maxAdditionalActions: 2, maxAdditionalOperationBytes: 1024})).toBeDefined();
			for (const invalid of ["accessorWindow", "extraProjection"] as const) {
				const refused = fixture(true, version); refused.state[invalid] = true;
				expect(await refused.run()).toBeUndefined();
				expect(refused.state.commits).toBe(0);
				expect(refused.proof.accounting.chargedBytes).toBe(64);
			}
		}
	});
	it("keeps the actual Grid reader wrapper bound to current/predecessor generated catalog carriers", () => {
		const zoneSource = readFileSync(new URL("../../../examples/grid/src/v3-zone.ts", import.meta.url), "utf8");
		const zoneTree = ts.createSourceFile("v3-zone.ts", zoneSource, ts.ScriptTarget.Latest, true);
		const owner = zoneTree.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === "createV3ZoneApplication");
		if (owner === undefined || owner.body === undefined) throw new Error("missing original Grid resource wrapper");
		const names = ["kernel", "resolved", "expectedResourceCatalog", "captureResourceMaterial", "resourceFootprint", "resourceBoundReader"];
		const statements = owner.body.statements.filter(value => ts.isVariableStatement(value) && value.declarationList.declarations.some(declaration =>
			ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)));
		expect(statements).toHaveLength(names.length);
		for (const version of ["current", "predecessor"] as const) {
			const filename = version === "current" ? "zone-catalog-material.json" : "zone-catalog-predecessor-material.json";
			const data = JSON.parse(readFileSync(new URL(`../../../examples/grid/src/${filename}`, import.meta.url), "utf8"));
			const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
			const catalog = openTrustedBlueprintCatalogBytes({catalogBytes: bytes(data.catalogBytes),
				assets: Object.fromEntries(Object.entries(data.assets).map(([key, value]) => [key, bytes(value as string)]))});
			const blueprintDigest = catalog.blueprintDigests[0]!, resolved = catalog.resolve(blueprintDigest);
			const reader = execute<any>(`${statements.map(value => value.getText(zoneTree)).join("\n")}\nreturn resourceBoundReader;`, {
				material: {catalog, blueprintDigest, artifactVersion: version}, creatorAuthor: "a".repeat(64), creatorPeerId: "creator-peer",
				createZoneStateKernel, sameBytes: (left: Uint8Array, right: Uint8Array) => compareBytes(left, right) === 0});
			const {seed} = kernelFixture(version), context = {blueprintDigest, artifactId: resolved.artifactId, artifactDigest: resolved.artifactDigest,
				catalogDigest: resolved.evidence.catalogDigest, runtimeProfile: resolved.runtimeProfile,
				exactArtifactBytes: resolved.exactArtifactBytes, canonicalBlueprintPackageBytes: resolved.canonicalBlueprintPackageBytes};
			const projection = reader.createIncrementalProjection({catalog: context, material: seed});
			expect(projection.quoteWithoutApplicationCandidate()).toBeDefined(); expect(projection.quote(fence)).toBeUndefined();
			expect(reader({catalog: context, material: {...seed, candidateOperation: fence}})).toBeUndefined();
			expect(reader.createIncrementalProjection({catalog: {...context, catalogDigest: "untrusted"}, material: seed})).toBeUndefined();
			expect(reader.createIncrementalProjection({catalog: {...context, exactArtifactBytes: Uint8Array.of(0)}, material: seed})).toBeUndefined();
		}
	});

	it("uses the same current/predecessor complete-material theorem without accepting a raw fence", () => {
		for (const version of ["current", "predecessor"] as const) {
			const {kernel, state, seed} = kernelFixture(version), projection = kernel.createPlacementGrowthProjection(seed)!;
			expect(projection.quote(fence)).toBeUndefined();
			expect(kernel.readPlacementGrowthBound({...seed, candidateOperation: fence})).toBeUndefined();
			const resource = projection.quoteWithoutApplicationCandidate()!;
			expect(resource.byteLength).toBeGreaterThanOrEqual(encodeCanonical(state).byteLength);
			expect(projection.quote({action: "causalJoin"})).toEqual(resource); // Existing codec/resource oracle only.
			const operations = Array.from({length: 128}, (_, index) => ({action: "placeBlock", id: `块-${index}`, kind: "stone", x: index, y: -index}));
			expect(projection.advance(operations)).toBe(true);
			let actual = state; for (const operation of operations) actual = kernel.apply(actual, operation, "a".repeat(64)).state;
			const changed = projection.quoteWithoutApplicationCandidate()!;
			expect(changed.blockCount).toBe(128); expect(changed.byteLength).toBeGreaterThanOrEqual(encodeCanonical(actual).byteLength);
			expect(projection.quote(fence)).toBeUndefined(); expect(projection.quoteWithoutApplicationCandidate()).toEqual(changed);
		}
	});

	it("selects the explicit query only from fresh runtime control data, never from a fence name", async () => {
		for (const version of ["current", "predecessor"] as const) {
			const f = fixture(true, version), result = await f.run();
			expect(result.knownCarriers).toEqual([f.unsigned]); expect(result.unknownEncodedLengths).toEqual([64, 128]);
			expect(f.proof.accounting.chargedBytes).toBe(64 + f.unsigned.byteLength + 64 + 128);
			expect(f.deliveredFacts.applicationResource.candidateNoApplicationEffect).toBe(true);
			expect(f.events).toEqual(["check:1", "create", "unchanged", "finishing", "check:2", "commit"]);
			// Finishing derivation runs provisionally before the complete final delivery check.
			expect(f.events.indexOf("finishing")).toBeLessThan(f.events.indexOf("check:2"));
			expect(f.events).not.toContain("reader"); expect(f.events).not.toContain("quote"); expect(f.state.commits).toBe(1);
			f.events.length = 0; expect(await f.run()).toBeDefined();
			expect(f.events).toContain("advance"); expect(f.events).toContain("unchanged"); expect(f.events).not.toContain("create");
		}
		const raw = fixture(false); expect(await raw.run()).toBeUndefined(); expect(raw.events).toContain("reader");
		expect(raw.events).not.toContain("unchanged"); expect(raw.state.commits).toBe(0);
	});

	it("delivers a complete cold control quote without a warm cursor and retains no projection (controlled nominal owners)", async () => {
		for (const version of ["current", "predecessor"] as const) {
			const f = fixture(true, version); f.state.cursorAvailable = false;
			for (let attempt = 0; attempt < 2; attempt++) {
				f.events.length = 0;
				const result = await f.run();
				expect(result).toBeDefined(); expect(result.knownCarriers).toEqual([f.unsigned]);
				expect(f.deliveredFacts.applicationResource.candidateNoApplicationEffect).toBe(true);
				expect(f.events).toEqual([`check:${attempt * 2 + 1}`, "create", "unchanged", "finishing", `check:${attempt * 2 + 2}`, "commit"]);
				expect(f.events).not.toContain("reader"); expect(f.events).not.toContain("quote"); expect(f.events).not.toContain("advance");
				expect(f.capacity.application).toBeUndefined(); expect(f.state.commits).toBe(attempt + 1);
				expect(f.frame.pending.size).toBe(0);
			}
		}
	});

	it("refuses missing/accessor queries, wrong profile and mutated material without inventing an APP noop", async () => {
		for (const change of ["missing", "accessor", "profile", "mutation"] as const) {
			const f = fixture();
			if (change === "missing") f.state.omitQuery = true;
			if (change === "accessor") f.state.accessorQuery = true;
			if (change === "profile") f.current.runtime.profileId = "creator-trusted-v1";
			if (change === "mutation") f.state.mutateInput = true;
			expect(await f.run(), change).toBeUndefined(); expect(f.events).not.toContain("reader");
			expect(f.state.commits).toBe(0); expect(f.capacity.application).toBeUndefined(); expect(f.frame.pending.size).toBe(0);
		}
	});

	it("complete currency/book/source delivery still revokes provisional projection and program on failure", async () => {
		for (const change of ["currency", "book", "stamp", "revoked"] as const) {
			const f = fixture(); await f.run(); f.state.commits = 0;
			const oldProgram = f.capacity.template;
			if (change === "currency") f.state.failCheck = f.state.checks + 2;
			if (change === "book") f.state.onQuery = () => {f.proof.accounting.chargedBytes++;};
			if (change === "stamp") f.state.onQuery = () => {f.state.current = false;};
			if (change === "revoked") {f.frame.alive = false; f.events.length = 0;}
			if (change === "revoked") expect(await f.run()).toBeUndefined();
			else await expect(f.run()).rejects.toThrow(change === "currency" ? "original-native-currentness" : "snapshot-unavailable");
			expect(f.state.commits).toBe(0); expect(f.capacity.template).toBe(oldProgram); expect(f.frame.pending.size).toBe(0);
			if (change === "revoked") expect(f.events).toHaveLength(0); else expect(f.capacity.application).toBeUndefined();
		}
	});

	it("private unchanged-query evidence leaves every pending/native/profile eligibility gate intact", () => {
		const eligible = execute<(facts: any, options: any) => boolean>(`${declaration("creatorOrdinaryResourceCurrentFactsEligible")}\nreturn creatorOrdinaryResourceCurrentFactsEligible;`, {
			snapshotQuarantineContract: {limits: {snapshotChunkBytes: 131072}},
		});
		const reader = () => undefined, make = () => ({current: {runtime: {profileId: "creator-trusted-settlement-v1", pendingIngressCount: 0,
			pendingIngressBytes: 0, drainingPendingIngress: false}, successorFenceCount: 1, candidate: {control: true},
			blueprint: {maxItems: 128, maxDepth: 8, maxApplicationStateBytes: 65536}},
			sourceFacts: {material: {installedPromotionSource: null}}, proofFacts: {capture: {ahe: {}, nativeIssuance: {rows: {lineages: [], plans: []}}}},
			settlementCapacity: {successorFenceCount: 1}, applicationResource: {reader, value: {items: 4, maxDepth: 1, byteLength: 16}, candidateNoApplicationEffect: true}});
		const options = {reader, actualProducerChunkBytes: 131072}; expect(eligible(make(), options)).toBe(true);
		for (const change of ["evidence", "pending-count", "pending-bytes", "draining", "unsigned", "promotion", "nominee", "generation", "plan", "reader"] as const) {
			const f: any = make();
			if (change === "evidence") delete f.applicationResource.candidateNoApplicationEffect;
			if (change === "pending-count") f.current.runtime.pendingIngressCount = 1;
			if (change === "pending-bytes") f.current.runtime.pendingIngressBytes = 1;
			if (change === "draining") f.current.runtime.drainingPendingIngress = true;
			if (change === "unsigned") f.proofFacts.capture.nativeIssuance.rows.lineages = [{pendingUnsigned: {}}];
			if (change === "promotion") f.sourceFacts.material.installedPromotionSource = {};
			if (change === "nominee") f.proofFacts.capture.ahe.control = {nominee: {}};
			if (change === "generation") f.proofFacts.capture.ahe.control = {completed: {generationDrain: {phase: "pending"}}};
			if (change === "plan") delete f.settlementCapacity;
			if (change === "reader") f.applicationResource.reader = () => undefined;
			expect(eligible(f, options), change).toBe(false);
		}
	});
});
