import {decodeCanonical, encodeCanonical, hashDomain} from "@ts-drp/canonical";
import {canonicalPrimitiveResourceForSizing, canonicalBytesResourceForSizing,
	canonicalArrayResourceForSizing, canonicalArrayResourcesForSizing, canonicalRecordResourceForSizing,
	canonicalCarrierResourceForSizing, canonicalValueResourceForSizing, type CanonicalResourceFootprint} from "@ts-drp/canonical/resource";
import {digestBlob, digestClosure, parseGenerationId, parseHeadRevision, parseStorageObjectId,
	type ExpectedHead, type GenerationRecord, type PresentHead} from "@ts-drp/storage";
import {describe, expect, it} from "vitest";
import {
	createCreatorFinishingWidthCompiler,
	createCreatorNoneResourceProgramCompiler,
	evaluateCreatorNoneResourceProgramForSizing,
	evaluateCreatorFinishingWidthProgramForSizing,
	readCreatorFinishingLiveTrustStateCarrierForSizing,
	readCreatorFinishingSuccessorFenceCountForSizing,
	readCreatorClosedRetirementSourceCapacityForSizing,
	readCreatorClosedRetirementSourceCarrierWidthsForSizing,
	readCreatorPlacementFinishingArtifactCapacityForSizing,
	readCreatorPlacementSigningCapacityForSizing,
	readCreatorOrdinaryNoneGenerationCapacityForSizing,
	readCreatorOrdinaryNoneSnapshotCapacityForSizing,
	type CreatorCanonicalCapacityForSizing,
} from "../src/internal/creator-closed-rollback-data.js";
import {creatorCutFields, creatorSuccessorAnchorFields, creatorSuccessorTrustFields} from "@ts-drp/protocol-v3/creator-close";
import {creatorSnapshotManifestFields} from "@ts-drp/protocol-v3/snapshot-transfer";
import {creatorIssuanceRetirementFields} from "@ts-drp/protocol-v3/creator-issuance-retirement";
import {creatorAuthorIssuanceFrontierFields, creatorAuthorSettlementFields} from "@ts-drp/protocol-v3/creator-author-issuance-frontiers";
import {creatorQ1SealQcFields, creatorQ1SealVoteFields, creatorCloseSigningPhaseFields,
	creatorCloseSigningQcSummaryFields, creatorCloseSigningVotePreimageFields,
	creatorCloseSigningStoredCarrierFields, creatorPristineSigningSourceMatchesForSizing} from "@ts-drp/seal/creator";
import {blueprintSnapshotPayloadFields} from "@ts-drp/compaction/blueprint-snapshot";
import {creatorSuccessorProjectionFields} from "../src/internal/creator-snapshot-data.js";
import {creatorCloseHistoryFields, encodeCreatorCloseHistory} from "../src/internal/creator-close-history.js";
import {issuanceOrdinaryFinishingCapacityWidths, issuanceUnsignedContinuationWidths,
	issuanceUnsignedPostimageWidths, issuanceRetirementControlFields, captureIssuanceRetirementControl,
	encodeIssuanceRetirementControl, type IssuanceRetirementRows} from "../../issuance-store/src/retirement.js";
import {journalOrdinarySchemaFinishingCapacityWidths, journalFutureAppendPostimageWidths,
	journalRetirementCanonicalRow, journalRetirementControlFields, captureJournalRetirementControl,
	encodeJournalRetirementControl, journalRetirementNativeProgressFields} from "../../live-journal/src/retirement.js";
import {creatorCloseMembershipFields} from "../src/internal/creator-close-membership.js";
import {anchorMaterial} from "../../../tests/fixtures/journal-anchor-read/material.js";
import {snapshotRetirementContract} from "@ts-drp/storage/snapshot-transfer";

describe("source finishing numerical field program (no proof authority)", () => {
	it("reuses explicit NONE resource references across independent equal-valued count and PRE parameters", () => {
		const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128}, compiler = createCreatorNoneResourceProgramCompiler(),
			backend = compiler.backend(limits), count = compiler.inputNumber("count", 1), length = compiler.inputNumber("preimage", 1);
		const child = backend.record({exactCanonicalPreimageBytes: backend.bytes(length), signature: backend.bytes(64)}), rows = backend.array(count, child);
		compiler.outputResource("rows", rows);
		const programme = compiler.finish();
		for (const count of [0, 1, 127, 128]) for (const length of [127, 128, 8_334]) {
			const parameters = new Map([["count", count], ["preimage", length]]), result = evaluateCreatorNoneResourceProgramForSizing(programme, parameters);
			expect(result).toBeDefined();
			const actual = Array.from({length: count}, () => ({exactCanonicalPreimageBytes: new Uint8Array(length), signature: new Uint8Array(64)}));
			const oracle = canonicalValueResourceForSizing(actual, 128, limits, "exact");
			expect([result!.get("rows.bytes"), result!.get("rows.items"), result!.get("rows.depth")])
				.toEqual([oracle.byteLength, oracle.items, oracle.maxDepth]);
			expect(result!.get("rows.bytes")).toBe(encodeCanonical(actual).byteLength);
		}
		expect(evaluateCreatorNoneResourceProgramForSizing(programme, new Map([["count", 0]]))).toBeUndefined();
		for (const bad of [Number.NaN, -1, 0.5, Number.MAX_SAFE_INTEGER])
			expect(evaluateCreatorNoneResourceProgramForSizing(programme, new Map([["count", bad], ["preimage", 127]]))).toBeUndefined();
		const foreign = createCreatorNoneResourceProgramCompiler().inputNumber("count", 1);
		expect(() => backend.array(foreign, child)).toThrow();
		let reads = 0;
		expect(() => compiler.inputResource("accessor", {get byteLength() { reads++; return 127; }, items: 1, maxDepth: 0})).toThrow();
		expect(reads).toBe(0);
	});
	it("keeps exact page boundaries, physical/protected counts, and prior UNKNOWN occurrences in parametric sums", () => {
		const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128}, compiler = createCreatorNoneResourceProgramCompiler(),
			backend = compiler.backend(limits), count = compiler.inputNumber("count", 1), preimage = compiler.inputNumber("preimage", 1),
			physical = compiler.inputNumber("physical", 4), protectedCount = compiler.inputNumber("protected", 3),
			base = compiler.inputNumber("base", 127), previousUnknown = compiler.inputNumber("priorUnknown", 128);
		const row = backend.record({preimage: backend.bytes(preimage), signature: backend.bytes(64)}),
			full = backend.array(128, row), tail = backend.array(compiler.remainder(count, 128), row);
		const pages = compiler.sum(compiler.product(compiler.floorDivide(count, 128), compiler.references(full).byteLength),
			compiler.product(compiler.positive(compiler.remainder(count, 128)), compiler.references(tail).byteLength));
		const physicalFoot = backend.array(physical, backend.bytes(127)), protectedFoot = backend.array(protectedCount, backend.bytes(128));
		const common = compiler.sum(base, previousUnknown);
		const roots = [compiler.sum(common, pages), compiler.sum(common, compiler.references(physicalFoot).byteLength),
			compiler.sum(common, compiler.references(protectedFoot).byteLength), compiler.sum(common, pages,
				compiler.references(physicalFoot).byteLength, compiler.references(protectedFoot).byteLength)];
		roots.forEach((value, index) => compiler.outputNumber(`root.${index}`, value));
		const program = compiler.finish();
		for (const count of [0, 1, 127, 128, 129, 256]) for (const length of [127, 128, 8_334]) {
			// The overlapping protected bytes remain a second occurrence, exactly
			// as in the original full-book envelope; no dedup/refund is introduced.
			const known = 127 + 128, protectedBytes = 128 + 8_334, priorUnknown = 127 + 128 + 8_334,
				baseBytes = known + protectedBytes + 512;
			const result = evaluateCreatorNoneResourceProgramForSizing(program, new Map([["count", count], ["preimage", length],
				["physical", 4], ["protected", 3], ["base", baseBytes], ["priorUnknown", priorUnknown]]));
			expect(result).toBeDefined();
			let pageBytes = 0;
			for (let offset = 0; offset < count; offset += 128)
				pageBytes += encodeCanonical(Array.from({length: Math.min(128, count - offset)}, () =>
					({preimage: new Uint8Array(length), signature: new Uint8Array(64)}))).byteLength;
			const physicalBytes = encodeCanonical(Array.from({length: 4}, () => new Uint8Array(127))).byteLength,
				protectedCost = encodeCanonical(Array.from({length: 3}, () => new Uint8Array(128))).byteLength,
				commonBytes = baseBytes + priorUnknown;
			expect([0, 1, 2, 3].map(index => result!.get(`root.${index}`))).toEqual([commonBytes + pageBytes,
				commonBytes + physicalBytes, commonBytes + protectedCost, commonBytes + pageBytes + physicalBytes + protectedCost]);
		}
		const backwardViolation = {...program, nodes: [{kind: "sum" as const, children: [0]}]};
		expect(evaluateCreatorNoneResourceProgramForSizing(backwardViolation, new Map())).toBeUndefined();
		expect(() => compiler.maximum(...Array.from({length: 65_537}, () => 0))).toThrow();
	});
	it("compiles the SAME artifact and fourteen signing schemas once and matches fresh original scalar/codec costs", () => {
		const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128}, digest = "0".repeat(64),
			resource = (value: unknown) => canonicalValueResourceForSizing(value, 128, limits, "exact");
		for (const signerId of ["creator", "créateur", "🚀".repeat(16)]) {
			const compiler = createCreatorNoneResourceProgramCompiler(), leaf = resource(null), application = compiler.inputResource("application", leaf);
			const input = {profileId: "creator-trusted-v1" as const, writerCount: 64, objectId: "room", signerId, author: digest,
				currentAnchor: {cryptoSuiteId: "ed25519-sha256", parametersDigest: digest, profileDigest: digest, signerSetDigest: digest},
				parameters: leaf, parameterFields: {maxDependencies: 16, maxEpochBytes: 8_388_608, maxEpochVertices: 8192},
				signerSet: leaf, profileByteLength: 127, signerSetByteLength: 128, snapshotChunkBytes: 128,
				application, successorAcl: leaf, catalog: {artifactDigest: digest, artifactId: "grid", catalogDigest: digest, runtimeProfile: "grid-v1"}};
			const artifacts = readCreatorPlacementFinishingArtifactCapacityForSizing(input, {compiler});
			expect(artifacts).toBeDefined(); if (artifacts === undefined) throw Error("NONE_ARTIFACT_PROGRAMME_FIXTURE_REFUSED");
			for (const key of ["payload", "manifest", "cut", "anchor", "prepareQc", "commitQc", "trust", "history", "projection"] as const)
				compiler.outputResource(key, artifacts[key]);
			const signing = readCreatorPlacementSigningCapacityForSizing({objectId: input.objectId, signerId,
				storageIncarnation: "1".repeat(32), ...artifacts}, {compiler});
			expect(signing).toBeDefined(); expect(signing!.frames).toHaveLength(14);
			const programme = compiler.finish();
			for (const length of [127, 128, 8_334]) {
				const freshApp = resource({blocks: [new Uint8Array(length)]}), author = resource(digest),
				params = new Map([["application.bytes", freshApp.byteLength], ["application.items", freshApp.items], ["application.depth", freshApp.maxDepth],
					["author.bytes", author.byteLength], ["author.items", author.items], ["author.depth", author.maxDepth]]);
				const result = evaluateCreatorNoneResourceProgramForSizing(programme, params), exact = readCreatorPlacementFinishingArtifactCapacityForSizing({...input, application: freshApp});
				expect(result).toBeDefined(); expect(exact).toBeDefined(); if (exact === undefined) throw Error("NONE_ARTIFACT_SCALAR_FIXTURE_REFUSED");
				for (const key of ["payload", "manifest", "cut", "anchor", "prepareQc", "commitQc", "trust", "history", "projection"] as const)
					expect([result!.get(`${key}.bytes`), result!.get(`${key}.items`), result!.get(`${key}.depth`)])
						.toEqual([exact[key].byteLength, exact[key].items, exact[key].maxDepth]);
				const exactSigning = readCreatorPlacementSigningCapacityForSizing({objectId: input.objectId, signerId, storageIncarnation: "1".repeat(32), ...exact});
				expect(result!.get("signing.allPhaseOccurrenceBytes")).toBe(exactSigning!.allPhaseOccurrenceBytes);
			}
		}
	});
	it("preserves complete witness widths and the full known/protected/UNKNOWN base through the private scalar representation", () => {
		const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128};
		const resource = (value: unknown) => canonicalValueResourceForSizing(value, 128, limits, "exact");
		const digest = "a".repeat(64), signedPreimages = [127, 128, 8_334].map(length => new Uint8Array(length)),
			candidate = new Uint8Array(512), signature = new Uint8Array(64), graph = [new Uint8Array(31), new Uint8Array(127), new Uint8Array(128), new Uint8Array(512)];
		const oldWitnesses = [...signedPreimages, candidate].map(raw => ({vertexDigest: digest,
			exactCanonicalPreimageBytes: raw, detachedSignature: signature}));
		const scalarWitnesses = canonicalArrayResourcesForSizing([...signedPreimages.map(raw => raw.byteLength), candidate.byteLength]
			.map(byteLength => canonicalRecordResourceForSizing({vertexDigest: resource(digest),
				exactCanonicalPreimageBytes: canonicalBytesResourceForSizing(byteLength, limits), detachedSignature: resource(signature)}, limits)), limits);
		expect(scalarWitnesses).toEqual(resource(oldWitnesses));
		expect(scalarWitnesses.byteLength).toBe(encodeCanonical(oldWitnesses).byteLength);
		const membership = creatorCloseMembershipFields({cutValueDigest: digest,
			scope: {objectId: "room", epoch: 3, anchorDigest: digest}, historyStart: 1,
			exactCanonicalLatchedAclBytes: new Uint8Array(512), orderedVertexDigests: new Uint8Array((graph.length + 1) * 32),
			localVertexWitnesses: oldWitnesses});
		const scalarFields = Object.fromEntries(Object.entries(membership).map(([key, value]) => [key, resource(value)]));
		const graphCount = graph.length;
		const scalarMembership = canonicalRecordResourceForSizing({...scalarFields,
			orderedVertexDigests: canonicalBytesResourceForSizing((graphCount + 1) * 32, limits), localVertexWitnesses: scalarWitnesses}, limits);
		expect(scalarMembership).toEqual(resource(membership));
		// The protected carrier overlaps known material intentionally. The OLD
		// formula counts both vectors; owner scalars preserve that same occurrence
		// law rather than deduplicating it or treating the overlap as paid credit.
		const knownMaterial = [signedPreimages[0]!, signedPreimages[1]!], knownProtectedMaterial = [signedPreimages[1]!, signedPreimages[2]!],
			priorUnknown = [127, 128, 8_334], currentKnown = [candidate, signature];
		const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);
		const knownResourceTotals = {knownBytes: total(knownMaterial.map(raw => raw.byteLength)),
			protectedBytes: total(knownProtectedMaterial.map(raw => raw.byteLength)), unknownEncodedBytes: total(priorUnknown)};
		const oldBase = total([...knownMaterial.map(raw => raw.byteLength), ...knownProtectedMaterial.map(raw => raw.byteLength),
			...priorUnknown, ...currentKnown.map(raw => raw.byteLength)]);
		const scalarBase = total([knownResourceTotals.knownBytes, knownResourceTotals.protectedBytes,
			knownResourceTotals.unknownEncodedBytes, ...currentKnown.map(raw => raw.byteLength)]);
		expect(scalarBase).toBe(oldBase); expect(scalarBase).toBe(17_882);
	});
	it("keeps four physical snapshot pairs while the original correlated participant phases protect at most three", () => {
		// Numerical DATA premises only. No fake nominal proof, role capability,
		// receipt result or retirement grant is constructed by this control.
		const objectId = "room", digest = "a".repeat(64), integer = Number.MAX_SAFE_INTEGER;
		const scope = (epoch: number) => ({objectId, epoch, anchor: epoch.toString(16).repeat(64), manifestDigest: digest});
		const previousClose = scope(1), currentClose = scope(2), older = scope(0);
		const snapshotPair = (value: ReturnType<typeof scope>) => ({scope: value, incarnation: "0".repeat(36)});
		const retained = [snapshotPair(older), snapshotPair(previousClose), snapshotPair(currentClose)];
		const roles = {kind: "creator-snapshot-recovery-roles" as const, version: 1 as const, genesisAnchorDigest: digest,
			currentClose, previousClose, operationalSources: [], classifiedScopes: [older]};
		const correspondence = {sourceSelection: {selection: "prior-transfer" as const, previousClose: currentClose,
			installedPromotionSource: null}, currentRoles: roles, currentCutRoles: roles,
			protectedScopes: [currentClose, previousClose, older], certificates: [{roles, supportGenerations: [], authenticatedSourceGenerations: []}]};
		const value = <T>(result: {ok: true; value: T} | {ok: false}): T => {
			if (!result.ok) throw Error("SNAPSHOT_RESOURCE_FIXTURE_INVALID"); return result.value;
		};
		const maintenance = {snapshotScopesAfterCurrentTurnover: retained, snapshotScopesRetiring: [],
			generationReplayUnclassified: false, ordinaryCurrentNativeAdvance: {
				currentGenerationId: value(parseGenerationId("0".repeat(64))),
				companionGenerationId: value(parseGenerationId("1".repeat(64))),
				predecessorGenerationId: value(parseGenerationId("2".repeat(64)))},
			ordinaryRecoverySourcePair: {selection: "prior-transfer" as const, currentClose, previousClose, nextPreviousClose: currentClose},
			ordinaryRoleResourceCorrespondence: correspondence};
		const supportObject = value(parseStorageObjectId(`creator:${"0".repeat(32)}`)),
			supportRef = {digest: value(digestBlob(Uint8Array.of(1))), byteLength: 1};
		const supportGeneration: GenerationRecord = {objectId: supportObject,
			generationId: maintenance.ordinaryCurrentNativeAdvance.predecessorGenerationId,
			baseExpectedHead: {kind: "none", objectId: supportObject}, closure: [supportRef],
			closureDigest: value(digestClosure([supportRef])), state: "Superseded"};
		const input = {objectId, epoch: 3, snapshotScopes: retained, latestClosedScope: currentClose, maintenance};
		const before = encodeCanonical(input), capacity = readCreatorOrdinaryNoneSnapshotCapacityForSizing(input);
		expect(capacity).toEqual({physicalSnapshotCount: 4, protectedSnapshotCount: 3});
		expect(encodeCanonical(input)).toEqual(before); expect(Object.isFrozen(capacity)).toBe(true);
		if (capacity === undefined) throw Error("SNAPSHOT_RESOURCE_FIXTURE_REFUSED");
		const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 8};
		const resource = (value: unknown) => canonicalValueResourceForSizing(value, 8, limits, "exact");
		// The COMPLETE native image includes every old physical pair and birth,
		// even though later role turnover can classify two of those old pairs.
		const scopes = [...retained, snapshotPair(scope(3))], image = {imageDigest: digest,
			scopeCount: scopes.length, chunkCount: integer, metadataBytes: integer, scopes};
		const pairResource = resource(scopes[0]);
		const imageResource = canonicalRecordResourceForSizing({imageDigest: resource(digest), scopeCount: resource(4),
			chunkCount: resource(integer), metadataBytes: resource(integer),
			scopes: canonicalArrayResourceForSizing(capacity.physicalSnapshotCount, pairResource, limits)}, limits);
		expect(imageResource).toEqual(resource(image));
		expect(encodeCanonical(image).byteLength).toBe(imageResource.byteLength);
		const preparation = {throughEpoch: integer, decisionDigest: digest, sourceProofDigest: digest, protectedScopes: retained};
		const control = snapshotRetirementContract.controlFields({objectId, incarnation: digest, revision: integer,
			sequence: integer, active: {sequence: integer, preparation}, completed: preparation});
		expect(resource(control).items).toBe(225);
		expect(snapshotRetirementContract.decodeControl(snapshotRetirementContract.encodeControl(control))).toEqual(control);
		// Reusing the PHYSICAL count in the participant plan is the confirmed
		// E3 bug: 277 decoder items, still refused by the unchanged native 256.
		const tooWidePreparation = {...preparation, protectedScopes: scopes};
		const tooWideControl = snapshotRetirementContract.controlFields({objectId, incarnation: digest, revision: integer,
			sequence: integer, active: {sequence: integer, preparation: tooWidePreparation}, completed: tooWidePreparation});
		expect(resource(tooWideControl).items).toBe(277);
		expect(() => snapshotRetirementContract.decodeControl(snapshotRetirementContract.encodeControl(tooWideControl))).toThrow();
		// Existing completed control is NOT narrowed by the future prep bound.
		// Three active plus four genuinely completed pairs consumes 251 items.
		const mixedControl = snapshotRetirementContract.controlFields({objectId, incarnation: digest, revision: integer,
			sequence: integer, active: {sequence: integer, preparation}, completed: tooWidePreparation});
		expect(resource(mixedControl).items).toBe(251);
		expect(snapshotRetirementContract.decodeControl(snapshotRetirementContract.encodeControl(mixedControl))).toEqual(mixedControl);
		for (const changed of [
			{...maintenance, ordinaryRecoverySourcePair: undefined},
			{...maintenance, ordinaryCurrentNativeAdvance: undefined},
			{...maintenance, generationReplayUnclassified: true},
			{...maintenance, ordinaryRoleResourceCorrespondence: {...correspondence,
				protectedScopes: [currentClose, previousClose]}},
			{...maintenance, ordinaryRoleResourceCorrespondence: {...correspondence,
				sourceSelection: {...correspondence.sourceSelection, previousClose}}},
			{...maintenance, ordinaryRoleResourceCorrespondence: {...correspondence,
				currentCutRoles: {...roles, previousClose: null}}},
			{...maintenance, ordinaryRoleResourceCorrespondence: {...correspondence,
				certificates: [{...correspondence.certificates[0]!, supportGenerations: [supportGeneration]}]}},
			{...maintenance, snapshotScopesAfterCurrentTurnover: [...retained, snapshotPair(scope(3))]},
		]) expect(readCreatorOrdinaryNoneSnapshotCapacityForSizing({...input, maintenance: changed})).toBeUndefined();
		expect(readCreatorOrdinaryNoneSnapshotCapacityForSizing({...input, snapshotScopes: [...retained, snapshotPair(scope(3))]})).toBeUndefined();
		expect(readCreatorOrdinaryNoneSnapshotCapacityForSizing({...input, latestClosedScope: previousClose})).toBeUndefined();
	});
	it("uses the shared historical scope projection for complete mature generation headroom without retirement authority", () => {
		// These are pure numerical premises, not genuine source/proof wrappers.
		// Production resolves the private current source and every original grant.
		const value = <T>(result: {ok: true; value: T} | {ok: false}): T => {
			if (!result.ok) throw Error("GENERATION_RESOURCE_FIXTURE_INVALID"); return result.value;
		};
		const objectId = value(parseStorageObjectId(`creator:${"0".repeat(32)}`)), digest = "a".repeat(64);
		const closure = [{digest: value(digestBlob(Uint8Array.of(0))), byteLength: 1}];
		const generation = (index: number): GenerationRecord => ({objectId,
			generationId: value(parseGenerationId(index.toString(16).repeat(64))), baseExpectedHead: {kind: "none", objectId},
			closure, closureDigest: value(digestClosure(closure)), state: index === 0 ? "Adopted" : "Superseded"});
		const generations = Array.from({length: 5}, (_, index) => generation(index));
		const scope = (epoch: number) => ({objectId, epoch, anchor: epoch.toString(16).repeat(64), manifestDigest: digest});
		const currentClose = scope(3), previousClose = scope(2), retiring = scope(1);
		const pair = (snapshotScope: ReturnType<typeof scope>) => ({scope: snapshotScope, incarnation: "0".repeat(36)});
		const roles = {kind: "creator-snapshot-recovery-roles" as const, version: 1 as const, genesisAnchorDigest: digest,
			currentClose, previousClose, operationalSources: [], classifiedScopes: [retiring]};
		const certificate = {roles, supportGenerations: [], authenticatedSourceGenerations: [
			{scope: retiring, generation: generations[3]!}, {scope: previousClose, generation: generations[4]!}]};
		const maintenance = {snapshotScopesAfterCurrentTurnover: [pair(currentClose), pair(previousClose)], snapshotScopesRetiring: [pair(retiring)],
			generationReplayUnclassified: false, authenticatedExcludedGenerations: [],
			ordinaryCurrentNativeAdvance: {currentGenerationId: generations[0]!.generationId,
				companionGenerationId: generations[1]!.generationId, predecessorGenerationId: generations[2]!.generationId},
			ordinaryRecoverySourcePair: {selection: "prior-transfer" as const, currentClose, previousClose, nextPreviousClose: currentClose},
			ordinaryRoleResourceCorrespondence: {sourceSelection: {selection: "prior-transfer" as const,
				previousClose: currentClose, installedPromotionSource: null}, currentRoles: roles, currentCutRoles: roles,
				protectedScopes: [currentClose, previousClose, retiring], certificates: [certificate]}};
		const input = {objectId, epoch: 4, generations, latestClosedScope: currentClose, maintenance};
		const before = encodeCanonical(input), result = readCreatorOrdinaryNoneGenerationCapacityForSizing(input);
		expect(result).toEqual({beforeBirthGenerationDrains: 0, afterBirthGenerationDrains: 2, conditionalSourceGenerationCount: 1});
		expect(encodeCanonical(input)).toEqual(before); expect(Object.isFrozen(result)).toBe(true);
		// Lawful CURRENT turnover has already joined. Its original certificate
		// carries a positive retired-classified fact; an empty current retiring
		// vector alone must not lose that FUTURE source-width alternative.
		const joinedTurnover = {...maintenance, snapshotScopesRetiring: [], ordinaryRoleResourceCorrespondence: {
			...maintenance.ordinaryRoleResourceCorrespondence, certificates: [{...certificate, retiredClassifiedSnapshotScopes: [retiring]}]}};
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input, maintenance: joinedTurnover})).toEqual(result);
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input, maintenance: {...joinedTurnover,
			ordinaryRoleResourceCorrespondence: {...joinedTurnover.ordinaryRoleResourceCorrespondence,
				certificates: [{...certificate, retiredClassifiedSnapshotScopes: []}]}}})).toBeUndefined();
		// One Q companion suffices at four native generations; missing qualified
		// source pair never turns an omitted received-scope read into empty data.
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input, generations: generations.slice(0, 4)}))
			.toEqual({beforeBirthGenerationDrains: 0, afterBirthGenerationDrains: 1, conditionalSourceGenerationCount: 0});
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input,
			maintenance: {...maintenance, ordinaryRecoverySourcePair: undefined}})).toBeUndefined();
		const correspondence = maintenance.ordinaryRoleResourceCorrespondence;
		const alternatives = [
			{...certificate, supportGenerations: [generations[3]!]},
			{...certificate, authenticatedSourceGenerations: [...certificate.authenticatedSourceGenerations,
				{scope: previousClose, generation: generations[3]!}]},
			{...certificate, authenticatedSourceGenerations: [...certificate.authenticatedSourceGenerations,
				{scope: scope(4), generation: generations[3]!}]},
			{...certificate, authenticatedSourceGenerations: certificate.authenticatedSourceGenerations.map(binding =>
				binding.generation === generations[3] ? {...binding, generation: {...binding.generation, closureDigest: value(digestClosure([{digest: value(digestBlob(Uint8Array.of(1))), byteLength: 1}]))}} : binding)},
		];
		for (const changed of alternatives) expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input,
			maintenance: {...maintenance, ordinaryRoleResourceCorrespondence: {...correspondence, certificates: [changed]}}})).toBeUndefined();
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input, maintenance: {...maintenance,
			snapshotScopesAfterCurrentTurnover: [...maintenance.snapshotScopesAfterCurrentTurnover, pair(retiring)]}})).toBeUndefined();
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input,
			maintenance: {...maintenance, generationReplayUnclassified: true}})).toBeUndefined();
		expect(readCreatorOrdinaryNoneGenerationCapacityForSizing({...input,
			generations: [...generations, generation(5), generation(6)]})).toBeUndefined(); // Conditional sources cannot pay CURRENT headroom.
	});
	it("shares original pristine signing eligibility without granting current round authority", () => {
		const objectId = "room", epoch = 3, signerId = "a".repeat(64), anchor = "b".repeat(64), incarnation = "c".repeat(32);
		const metadata = encodeCanonical(["storageMeta", "incarnation", {value: incarnation}]);
		const row = {anchor, revision: 0, enteredRound: 0, retiredBeforeRound: 0, lockRound: null,
			lockedValueDigest: null, committedValueDigest: null, finalizedValueDigest: null,
			highestPrepareQC: null, finalizedCommitQC: null, durablePrepareQcCount: 0, durableCommitQcCount: 0};
		const frame = encodeCanonical(["signerState", [objectId, epoch, signerId], row]);
		const matches = (actualRows: readonly Uint8Array[]) => creatorPristineSigningSourceMatchesForSizing({
			objectId, currentEpoch: epoch, currentAnchorDigest: anchor, signerId, storageIncarnation: incarnation, actualRows});
		expect(matches([metadata])).toBe(true);
		expect(matches([metadata, frame, frame.slice()])).toBe(true);
		expect(matches([metadata, encodeCanonical(["voteSlots", [objectId, epoch - 1, 0, "prepare", signerId], {}])])).toBe(true);
		expect(matches([frame])).toBe(false);
		expect(matches([encodeCanonical(["storageMeta", "incarnation", {value: "d".repeat(32)}]), frame])).toBe(false);
		for (const changed of [{revision: 1}, {enteredRound: 1}, {durablePrepareQcCount: 1}, {anchor: "d".repeat(64)}])
			expect(matches([metadata, encodeCanonical(["signerState", [objectId, epoch, signerId], {...row, ...changed}])])).toBe(false);
		for (const store of ["voteSlots", "voteOutbox", "sealEvidence"])
			expect(matches([metadata, encodeCanonical([store, [objectId, epoch, signerId], {}])])).toBe(false);
		expect(matches([metadata, frame, encodeCanonical(["signerState", [objectId, epoch, signerId], {...row, extra: null}])])).toBe(false);
		expect(matches([metadata, Uint8Array.of(255)])).toBe(false);
	});
	it("checks the complete native snapshot active/completed overlap at three versus four pairs", () => {
		const digest = "0".repeat(64), objectId = "room", integer = Number.MAX_SAFE_INTEGER;
		for (const count of [2, 3, 4]) {
			const preparation = {throughEpoch: integer, decisionDigest: digest, sourceProofDigest: digest,
				protectedScopes: Array.from({length: count}, (_, epoch) => ({scope: {objectId, epoch, anchor: digest,
					manifestDigest: digest}, incarnation: "0".repeat(36)}))};
			const control = snapshotRetirementContract.controlFields({objectId, incarnation: digest, revision: integer,
				sequence: integer, active: {sequence: integer, preparation}, completed: preparation});
			const footprint = canonicalValueResourceForSizing(control, 8,
				{maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 8}, "exact");
			expect(footprint.items).toBe(69 + 52 * count); expect(footprint.maxDepth).toBe(6);
			const encoded = snapshotRetirementContract.encodeControl(control);
			expect(encoded.byteLength).toBe(footprint.byteLength);
			// The decoder counts collection edges as well as child values. Native
			// readback limits, not successful encoding alone, bound this overlap.
			if (count <= 3) expect(snapshotRetirementContract.decodeControl(encoded)).toEqual(control);
			else expect(() => snapshotRetirementContract.decodeControl(encoded)).toThrow();
		}
	});
	it("bounds original NONE journal images across SQL/browser and count/PRE byte boundaries without a future constructor", () => {
		for (const sql of [false, true]) for (const count of [0, 127, 128]) for (const preimage of [127, 128, 8_334]) {
			const current = anchorMaterial(0), successor = anchorMaterial(1), author = "writer", scope = current.scope;
			const parametersDigest = (decodeCanonical(current.bytes) as {parametersDigest: string}).parametersDigest;
			const header = sql ? {object_id: scope.objectId, epoch: scope.epoch, anchor_digest: scope.anchorDigest,
				next_journal_sequence: count, exact_anchor_preimage: current.bytes, detached_anchor_signature: current.install.detachedAnchorSignature,
				parameters_digest: parametersDigest, exact_parameters_carrier: current.install.exactCanonicalParametersCarrierBytes} :
				{...scope, nextJournalSequence: count, exactCanonicalAnchorPreimageBytes: current.bytes,
					detachedAnchorSignature: current.install.detachedAnchorSignature, parametersDigest,
					exactCanonicalParametersCarrierBytes: current.install.exactCanonicalParametersCarrierBytes};
			const frames = [journalRetirementCanonicalRow("scopes", [scope.objectId, scope.epoch, scope.anchorDigest], header),
				...Array.from({length: count}, (_, sequence) => journalRetirementCanonicalRow(sql ? "accepted_entries" : "acceptedEntries",
					[scope.objectId, scope.epoch, scope.anchorDigest, sequence], sql ? {object_id: scope.objectId, epoch: scope.epoch,
						anchor_digest: scope.anchorDigest, journal_sequence: sequence, source_kind: "local-issued",
						vertex_digest: sequence.toString(16).padStart(64, "0"), local_author: author, local_author_sequence: sequence,
						received_preimage: null, received_signature: null} : {...scope, journalSequence: sequence, sourceKind: "local-issued",
						vertexDigest: sequence.toString(16).padStart(64, "0"), localAuthor: author, localAuthorSequence: sequence}))];
			const input = {actualCanonicalRows: frames, currentScope: scope, canonicalPreimageByteLength: preimage,
				canonicalAuthorByteLength: encodeCanonical(author).byteLength, successorAnchorByteLength: successor.bytes.byteLength,
				parametersByteLength: successor.install.exactCanonicalParametersCarrierBytes.byteLength, closedMembershipByteLength: 128};
			const bound = journalOrdinarySchemaFinishingCapacityWidths(input);
			// Only this pure control invokes the ORIGINAL exact forecast as its
			// oracle. The production no-forecast projection never calls it.
			const exact = journalFutureAppendPostimageWidths(frames, {scope, sourceKind: "local-issued", author,
				authorSequence: count, vertexDigest: "f".repeat(64)}, {objectId: scope.objectId,
				exactCanonicalAnchorPreimageBytes: successor.bytes,
				exactCanonicalParametersCarrierBytes: successor.install.exactCanonicalParametersCarrierBytes}, undefined, [],
				{closedMembershipByteLength: 128}).afterSuccessor;
			expect(bound.scopeCount).toBe(exact.scopeCount); expect(bound.rowCount).toBe(exact.rowCount);
			expect(bound.canonicalRowsBytes).toBeGreaterThanOrEqual(exact.canonicalRowsBytes);
			expect(bound.nativeImageBytes).toBeGreaterThanOrEqual(exact.nativeImageBytes);
			expect(bound.canonicalRowByteLengthsTotal).toBeGreaterThanOrEqual(exact.canonicalRowBytes.reduce((sum, width) => sum + width, 0));
			expect(bound.canonicalRows.items).toBe(1 + 2 * (count + 3));
			expect(bound.additionalFrameByteLength).toBeGreaterThan(preimage);
			expect(() => journalOrdinarySchemaFinishingCapacityWidths({...input, actualCanonicalRows: [Uint8Array.of(255)]})).toThrow();
			expect(() => journalOrdinarySchemaFinishingCapacityWidths({...input, canonicalPreimageByteLength: 0})).toThrow();
		}
	});

	it("retains the original issuer/journal control and complete seven-field membership codecs", () => {
		const digest = "a".repeat(64), objectId = "room";
		for (const sequence of [0, 127, 128]) {
			const common = {objectId, incarnation: digest, revision: sequence, sequence, active: null, completed: null};
			const issuer = issuanceRetirementControlFields(common);
			expect(encodeIssuanceRetirementControl(captureIssuanceRetirementControl(issuer))).toEqual(encodeCanonical(issuer));
			expect(() => captureIssuanceRetirementControl({...issuer, extra: 0})).toThrow();
			for (const version2 of [false, true]) {
				const journal = journalRetirementControlFields({...common, version2, drain: null});
				expect(encodeJournalRetirementControl(captureJournalRetirementControl(journal))).toEqual(encodeCanonical(journal));
				expect(Object.hasOwn(journal, "drain")).toBe(version2);
				expect(() => captureJournalRetirementControl({...journal, extra: 0})).toThrow();
			}
		}
		for (const count of [0, 127, 128]) {
			const slots = {cutValueDigest: digest, scope: {objectId, epoch: 1, anchorDigest: digest}, historyStart: 128,
				exactCanonicalLatchedAclBytes: new Uint8Array(512), orderedVertexDigests: new Uint8Array(count * 32),
				localVertexWitnesses: Array.from({length: count}, () => ({vertexDigest: digest,
					exactCanonicalPreimageBytes: new Uint8Array(8_334), detachedSignature: new Uint8Array(64)}))};
			const projected = creatorCloseMembershipFields(slots), exact = {kind: "creator-close-membership-1", ...slots};
			expect(encodeCanonical(projected)).toEqual(encodeCanonical(exact));
			const footprint = canonicalRecordResourceForSizing(Object.fromEntries(Object.entries(projected).map(([key, value]) =>
				[key, canonicalValueResourceForSizing(value, 32, {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 32}, "exact")])));
			expect(footprint).toEqual(canonicalValueResourceForSizing(exact, 32, {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 32}, "exact"));
		}
	});
	it("composes every original compact journal progress drain field as a complete direct child", () => {
		const limits = {maxBytes: 4_194_304, maxItems: 65_536, maxDepth: 128}, digest = "a".repeat(64);
		const actual = (value: unknown) => canonicalValueResourceForSizing(value, 128, limits, "exact");
		for (const count of [0, 127, 128]) {
			const base = journalRetirementControlFields({objectId: "room", incarnation: digest, revision: count, sequence: count,
				active: null, completed: {throughEpoch: count, decisionDigest: digest, sourceProofDigest: digest,
					protectedScopes: [{objectId: "room", epoch: count, anchorDigest: digest}]}, version2: true, drain: null});
			const original = journalRetirementNativeProgressFields(base, digest, 8_334, count, count, digest);
			const baseFields = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, actual(value)]));
			const projected = journalRetirementNativeProgressFields(baseFields, actual(digest), actual(8_334), actual(count), actual(count), actual(digest));
			// A nested owner field record is intentionally not a scalar footprint.
			expect(() => canonicalRecordResourceForSizing(projected as never, limits)).toThrow();
			const composed = canonicalRecordResourceForSizing({...projected,
				drain: canonicalRecordResourceForSizing(projected.drain as Readonly<Record<string, CanonicalResourceFootprint>>, limits)}, limits);
			expect(composed).toEqual(actual(original));
			expect(composed.byteLength).toBe(encodeCanonical(original).byteLength);
			expect(Object.keys(projected.drain)).toEqual(["planDigest", "planByteLength", "cursor", "batches", "residualImageDigest"]);
		}
	});
	it("matches the original artifact field codecs, including signature types and expanded children", () => {
		// Resource controls only: none of these encoded fixtures is registered
		// trust, a prepared close, a QC, a native plan, or an admission grant.
		const capacity = (value: unknown): CanonicalResourceFootprint => {
			const shape = (node: unknown): {items: number; maxDepth: number} => {
				const children = Array.isArray(node) ? node : node !== null && typeof node === "object" &&
					!(node instanceof Uint8Array) ? Object.entries(node).flatMap(([key, child]) => [key, child]) : [];
				const parts = children.map(shape);
				return {items: 1 + children.length + parts.reduce((sum, part) => sum + part.items, 0),
					maxDepth: parts.length === 0 ? 0 : 1 + Math.max(...parts.map(part => part.maxDepth))};
			};
			return {...shape(value), byteLength: encodeCanonical(value).byteLength};
		};
		const integer = Number.MAX_SAFE_INTEGER, digest = "0".repeat(64), signature = new Uint8Array(64);
		expect(encodeCanonical("0".repeat(128)).byteLength).toBe(131);
		expect(canonicalBytesResourceForSizing(128)).toEqual(capacity("0".repeat(128)));
		expect(canonicalBytesResourceForSizing(64)).toEqual(capacity(signature));
		for (const profileId of ["creator-trusted-v1", "creator-trusted-settlement-v1"] as const)
			for (const writerCount of [1, 64]) {
				const objectId = "room".repeat(32), signerId = digest, author = digest;
				const currentAnchor = {cryptoSuiteId: "ed25519-sha256", parametersDigest: digest,
					profileDigest: digest, signerSetDigest: digest};
				const parameters = {maxDependencies: 16, maxEpochBytes: 8_388_608, maxEpochVertices: 8192};
				const signerSet = [{signerId, publicKey: new Uint8Array(32)}];
				const application = {creator: digest, roster: [], outcomes: [], blocks: Array.from({length: 128},
					(_, id) => ({id: String(id), kind: "block", x: integer, y: integer}))};
				const acl = {epoch: integer, owner: digest, members: Array.from({length: writerCount}, () => digest)};
				const catalog = {artifactDigest: digest, artifactId: "grid", catalogDigest: digest, runtimeProfile: "grid-v1"};
				const result = readCreatorPlacementFinishingArtifactCapacityForSizing({profileId, writerCount, objectId,
					signerId, author, currentAnchor, parameters: capacity(parameters), parameterFields: parameters,
					signerSet: capacity(signerSet), profileByteLength: 128, signerSetByteLength: encodeCanonical(signerSet).byteLength,
					snapshotChunkBytes: 131_072, application: capacity(application), successorAcl: capacity(acl), catalog});
				expect(result).toBeDefined();
				const payload = blueprintSnapshotPayloadFields({acl, application, anchor: digest, archiveIndexRoot: digest,
					blueprintDigest: digest, epoch: integer, objectId, schemaVersion: 1});
				const chunkCount = Math.ceil(encodeCanonical(payload).byteLength / 131_072);
				const manifest = creatorSnapshotManifestFields({aclDigest: digest, anchor: digest,
					chunks: Array.from({length: chunkCount}, () => ({byteLength: integer, digest, index: integer})),
					epoch: integer, objectId, payloadDigest: digest, schemaVersion: 1, stateDigest: digest, totalBytes: integer});
				const values = {aclDigest: digest, archiveIndexRoot: digest, blueprintDigest: digest, closeReason: "creator-requested",
					closeSetCount: integer, closeSetRoot: digest, historyRoot: digest, historySize: integer,
					snapshotManifestDigest: digest, stateDigest: digest};
				const cut = creatorCutFields({values, currentAnchor: {cutDigest: digest, historyRoot: digest, historySize: integer},
					currentEpoch: integer, objectId, currentAnchorDigest: digest, nextSignerSet: signerSet, parameters,
					availabilityPolicyDigest: digest});
				const anchor = creatorSuccessorAnchorFields({currentAnchor, cut, cutDigest: digest,
					successorEpoch: integer, effectiveStateDigest: digest});
				const vote = creatorQ1SealVoteFields({signature: "0".repeat(128), signerId, voteDigest: digest});
				const qc = (phase: "prepare" | "commit") => creatorQ1SealQcFields({epoch: integer, objectId, phase,
					proposalDigest: digest, proposalHash: digest, round: integer}, [vote]);
				const trust = creatorSuccessorTrustFields({currentAnchorDigest: digest, currentEpoch: integer,
					detachedCurrentAnchorSignature: signature, exactCanonicalCurrentAnchorPreimageBytes: encodeCanonical(anchor),
					exactCanonicalProfileBytes: new Uint8Array(128), exactCanonicalSignerSetBytes: encodeCanonical(signerSet),
					genesisAnchorDigest: digest, objectId, profileId});
				const compactHistory = {size: integer, peaks: Array.from({length: 53}, () => new Uint8Array(32))};
				const history = creatorCloseHistoryFields(digest, compactHistory);
				expect(encodeCreatorCloseHistory(digest, compactHistory)).toEqual(encodeCanonical(history));
				const projection = creatorSuccessorProjectionFields({currentAnchor: {historyRoot: digest, historySize: integer},
					successorAnchor: anchor, successorAnchorByteLength: integer, successorAnchorDigest: digest, successorEpoch: integer,
					parameters, history: {historyRoot: digest, historySize: integer, historySnapshot: compactHistory},
					catalog: {...catalog, evidence: {catalogDigest: digest}}, snapshotManifestDigest: digest,
					snapshotPayloadDigest: digest, graphDigest: digest, orderedVertexHashesDigest: digest});
				for (const [name, value] of Object.entries({payload, manifest, cut, anchor, prepareQc: qc("prepare"),
					commitQc: qc("commit"), trust, history, projection}))
					expect(result![name as keyof NonNullable<typeof result>]).toEqual(capacity(value));
				expect(result!.chunkCount).toBe(chunkCount);
				expect(result!.chunkPayloadByteLengthsTotal).toBe(encodeCanonical(payload).byteLength);
				const current = {currentAnchorDigest: digest, currentEpoch: integer, genesisAnchorDigest: digest, objectId},
					successor = {currentAnchorDigest: digest, currentEpoch: integer}, commitQcRef = {byteLength: integer, digest};
				const common = {...values, cutValueDigest: digest, commitQcRef, currentAclDigest: digest, successorAclDigest: digest,
					priorAggregateCandidateDigest: digest, priorCheckpointDigest: digest, priorCheckpointKind: "settled-v1"};
				const unsigned = profileId === "creator-trusted-v1" ? [
					creatorIssuanceRetirementFields({...common, admittedAuthorSequence: integer, author,
						observedLineage: {exhausted: false, next: integer}, priorAdmittedAuthorSequence: integer,
						priorRetirementCandidateDigest: digest}, current, successor),
					creatorAuthorIssuanceFrontierFields(common, current, successor,
						Array.from({length: writerCount}, () => [digest, integer])),
				] : [creatorAuthorSettlementFields(common, current, successor,
					Array.from({length: writerCount}, () => [digest, integer, integer]))];
				for (const [index, fields] of unsigned.entries()) {
					const signed = {...fields, [profileId === "creator-trusted-v1" ? "detachedCreatorSignature" :
						"detachedAuthoritySignature"]: signature};
					expect(result!.metadata[index]).toEqual({unsigned: capacity(fields), signed: capacity(signed)});
				}
			}
	});

	it("refuses missing finite artifact premises and retains direct ACL/app item and depth limits", () => {
		const digest = "0".repeat(64), leaf = canonicalPrimitiveResourceForSizing(null);
		const input = {profileId: "creator-trusted-v1" as const, writerCount: 64, objectId: "room", signerId: digest,
			author: digest, currentAnchor: {cryptoSuiteId: "ed25519-sha256", parametersDigest: digest,
				profileDigest: digest, signerSetDigest: digest}, parameters: leaf,
			parameterFields: {maxDependencies: 16, maxEpochBytes: 8_388_608, maxEpochVertices: 8192},
			signerSet: leaf, profileByteLength: 128, signerSetByteLength: 128, snapshotChunkBytes: 131_072,
			application: leaf, successorAcl: leaf,
			catalog: {artifactDigest: digest, artifactId: "grid", catalogDigest: digest, runtimeProfile: "grid-v1"}};
		expect(readCreatorPlacementFinishingArtifactCapacityForSizing(input)).toBeDefined();
		for (const writerCount of [0, 65, Number.NaN, 0.5])
			expect(readCreatorPlacementFinishingArtifactCapacityForSizing({...input, writerCount})).toBeUndefined();
		for (const child of [{...leaf, byteLength: 0}, {...leaf, byteLength: 4_194_305},
			{...leaf, items: 65_536}, {...leaf, maxDepth: 128}])
			for (const slot of ["application", "successorAcl"])
				expect(readCreatorPlacementFinishingArtifactCapacityForSizing({...input, [slot]: child})).toBeUndefined();
		for (const length of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER])
			expect(readCreatorPlacementFinishingArtifactCapacityForSizing({...input, profileByteLength: length})).toBeUndefined();
		for (const snapshotChunkBytes of [0, -1, Number.NaN, 0.5])
			expect(readCreatorPlacementFinishingArtifactCapacityForSizing({...input, snapshotChunkBytes})).toBeUndefined();
		const smallChunks = readCreatorPlacementFinishingArtifactCapacityForSizing({...input, snapshotChunkBytes: 128})!;
		expect(smallChunks.chunkCount).toBe(Math.ceil(smallChunks.payload.byteLength / 128));
		expect(smallChunks.manifest.byteLength).toBeGreaterThan(readCreatorPlacementFinishingArtifactCapacityForSizing(input)!.manifest.byteLength);
		expect(readCreatorPlacementFinishingArtifactCapacityForSizing({...input, snapshotChunkBytes: 262_144})!.chunkCount)
			.toBe(readCreatorPlacementFinishingArtifactCapacityForSizing(input)!.chunkCount);
		const direct = {byteLength: 3, items: 3, maxDepth: 1}, opaque = {byteLength: 3, items: 1, maxDepth: 0};
		const directResult = readCreatorPlacementFinishingArtifactCapacityForSizing({...input, application: direct})!,
			opaqueResult = readCreatorPlacementFinishingArtifactCapacityForSizing({...input, application: opaque})!;
		expect(directResult.payload.byteLength).toBe(opaqueResult.payload.byteLength);
		expect(directResult.payload.items).toBe(opaqueResult.payload.items + 2);
		expect(directResult.payload.maxDepth).toBe(opaqueResult.payload.maxDepth + 1);
	});

	it("retains complete original correlated signing rows and every distinct phase occurrence", () => {
		const digest = "0".repeat(64), incarnation = "1".repeat(32), epoch = Number.MAX_SAFE_INTEGER;
		for (const signerId of ["creator", digest, "créateur", "🚀".repeat(16)]) {
		const scope = {objectId: "room", epoch, signerId}, cut = new Uint8Array(8334),
			prepare = new Uint8Array(127), commit = new Uint8Array(128), trust = new Uint8Array(8334);
		const footprint = (value: unknown): CanonicalResourceFootprint => {
			const shape = (node: unknown): {items: number; maxDepth: number} => {
				const children = Array.isArray(node) ? node : node !== null && typeof node === "object" &&
					!(node instanceof Uint8Array) ? Object.entries(node).flatMap(([key, child]) => [key, child]) : [];
				const parts = children.map(shape);
				return {items: 1 + children.length + parts.reduce((sum, part) => sum + part.items, 0),
					maxDepth: parts.length === 0 ? 0 : 1 + Math.max(...parts.map(part => part.maxDepth))};
			};
			return {...shape(value), byteLength: encodeCanonical(value).byteLength};
		};
		const merged = (fields: {known: Readonly<Record<string, unknown>>; unknown: Readonly<Record<string, unknown>>}) =>
			({...fields.known, ...fields.unknown});
		const summary = (phase: "prepare" | "commit", qc: Uint8Array) => merged(creatorCloseSigningQcSummaryFields({phase,
			valueDigest: digest, digest, proposalHash: digest, exactCanonicalQcBytes: qc}));
		const carrier = (phase: "prepare" | "commit") => merged(creatorCloseSigningStoredCarrierFields({
			exactCanonicalPreimageBytes: encodeCanonical(merged(creatorCloseSigningVotePreimageFields({scope, phase,
				valueDigest: digest, proposalHash: digest}))), signature: new Uint8Array(64)}));
		const original = creatorCloseSigningPhaseFields<unknown>({scope, anchor: digest, valueDigest: digest,
			storageIncarnation: incarnation, signerPublicKey: new Uint8Array(32), exactCanonicalCutValueBytes: cut,
			prepareSummary: summary("prepare", prepare), commitSummary: summary("commit", commit),
			prepareCarrier: carrier("prepare"), commitCarrier: carrier("commit"), prepareQcBytes: prepare,
			commitQcBytes: commit, trustBytes: trust});
		// These are encoded fields/fixtures, not signed bytes or prepared objects.
		const result = readCreatorPlacementSigningCapacityForSizing({objectId: scope.objectId, signerId,
			storageIncarnation: incarnation, cut: {byteLength: cut.byteLength, items: 1, maxDepth: 0},
			prepareQc: {byteLength: prepare.byteLength, items: 1, maxDepth: 0},
			commitQc: {byteLength: commit.byteLength, items: 1, maxDepth: 0},
			trust: {byteLength: trust.byteLength, items: 1, maxDepth: 0}})!;
		expect(result.frames).toHaveLength(14);
		for (const [index, row] of original.entries()) {
			const value = merged(row), address = row.store === "voteSlots" || row.store === "voteOutbox"
				? [scope.objectId, epoch, 0, row.phase, signerId] : [scope.objectId, epoch, signerId];
			expect(result.frames[index]!.row).toEqual(footprint(value));
			expect(result.frames[index]!.frame).toEqual(footprint([row.store, address, value]));
		}
		expect(result.correlatedPhases.map(phase => phase.frames.length)).toEqual([1, 4, 4, 6, 6, 6]);
		expect(result.allPhaseOccurrenceBytes).toBe(result.frames.reduce((sum, row) => sum + row.frame.byteLength, 0));
		expect(result.allPhaseOccurrenceBytes).toBeGreaterThan(result.finalPhaseBytes);
		expect(readCreatorPlacementSigningCapacityForSizing({objectId: "room", signerId: digest, storageIncarnation: "bad",
			cut: footprint(null), prepareQc: footprint(null), commitQc: footprint(null), trust: footprint(null)})).toBeUndefined();
		for (const invalid of ["", "\ud800"])
			expect(readCreatorPlacementSigningCapacityForSizing({objectId: "room", signerId: invalid, storageIncarnation: incarnation,
				cut: footprint(null), prepareQc: footprint(null), commitQc: footprint(null), trust: footprint(null)})).toBeUndefined();
		}
	});

	it("keeps original scalar validation and exact heterogeneous codec costs without hypothetical bytes", () => {
		for (const value of [null, false, true, -0, -1, 0.5, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
			"\ufefforiginal BOM", "non-ASCII \ud83d\ude80"]) {
			const cost = canonicalPrimitiveResourceForSizing(value);
			expect(cost).toEqual({byteLength: encodeCanonical(value).byteLength, items: 1, maxDepth: 0});
		}
		for (const value of [Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "\ud800"])
			expect(() => canonicalPrimitiveResourceForSizing(value)).toThrow();
		for (const count of [0, 1, 127, 128]) {
			const bytes = Array.from({length: count}, (_, index) => new Uint8Array(index % 2 === 0 ? 127 : 128));
			const leaves = bytes.map(value => canonicalBytesResourceForSizing(value.byteLength));
			const heterogeneous = canonicalArrayResourcesForSizing(leaves);
			expect(heterogeneous).toEqual({byteLength: encodeCanonical(bytes).byteLength,
				items: 1 + count * 2, maxDepth: count === 0 ? 0 : 1});
			const homogeneous = canonicalArrayResourceForSizing(count, canonicalBytesResourceForSizing(128));
			expect(homogeneous.byteLength).toBe(encodeCanonical(Array.from({length: count}, () => new Uint8Array(128))).byteLength);
			const record = canonicalRecordResourceForSizing({"\ufefforiginal key": heterogeneous, revision: Number.MAX_SAFE_INTEGER});
			expect(record.byteLength).toBe(encodeCanonical({"\ufefforiginal key": bytes, revision: Number.MAX_SAFE_INTEGER}).byteLength);
			expect(record.items).toBe(1 + 2 * 2 + 2 + heterogeneous.items + 1);
		}
	});

	it("rejects resource accessors and large collection edges before touching children", () => {
		const leaf = canonicalPrimitiveResourceForSizing(null), limits = {maxBytes: 1024, maxItems: 3, maxDepth: 2};
		let reads = 0;
		const accessor = {items: 1, maxDepth: 0, get byteLength() {reads++; return 1;}};
		expect(() => canonicalArrayResourcesForSizing([accessor])).toThrow();
		expect(reads).toBe(0);
		const excessive: CanonicalResourceFootprint[] = [];
		excessive.length = 1024;
		Object.defineProperty(excessive, "0", {get() {reads++; return leaf;}});
		expect(() => canonicalArrayResourcesForSizing(excessive, limits)).toThrow();
		expect(reads).toBe(0);
		expect(() => canonicalArrayResourcesForSizing(Array(1) as CanonicalResourceFootprint[])).toThrow();
		expect(() => canonicalArrayResourceForSizing(Number.MAX_SAFE_INTEGER, leaf)).toThrow();
		expect(() => canonicalRecordResourceForSizing({get field() {reads++; return leaf;}})).toThrow();
		expect(reads).toBe(0);
		for (const invalid of [{...leaf, extra: 1}, {...leaf, byteLength: 0}, {...leaf, items: 0},
			{...leaf, maxDepth: -1}, {...leaf, byteLength: Number.NaN}])
			expect(() => canonicalArrayResourcesForSizing([invalid])).toThrow();
		const mutable = {...leaf}, before = canonicalArrayResourcesForSizing([mutable]);
		mutable.byteLength = 999;
		expect(before.byteLength).toBe(3);
		expect(Object.isFrozen(before)).toBe(true);
		const accessorLimits = {get maxItems() {reads++; return 100;}};
		expect(() => canonicalArrayResourcesForSizing([leaf], accessorLimits)).toThrow();
		expect(reads).toBe(0);
	});

	it("uses original actual-carrier decoder counts and verifies rather than guesses schema depth", () => {
		const value = {nested: {value: new Uint8Array(128)}}, bytes = encodeCanonical(value);
		const cost = canonicalCarrierResourceForSizing(bytes, 2);
		expect(cost).toEqual({byteLength: bytes.byteLength, items: 9, maxDepth: 2});
		expect(canonicalValueResourceForSizing(value, 8)).toEqual({...cost, maxDepth: 8});
		expect(canonicalCarrierResourceForSizing(bytes, 128, {}, "exact")).toEqual(cost);
		expect(canonicalValueResourceForSizing(value, 128, {}, "exact")).toEqual(cost);
		const mixed = {"\ufeffkey": [new Uint8Array(128), {float: 0.5, text: "\ufeffpayload"}]};
		expect(canonicalCarrierResourceForSizing(encodeCanonical(mixed), 128, {}, "exact")).toEqual({
			byteLength: encodeCanonical(mixed).byteLength, items: 17, maxDepth: 3});
		expect(() => canonicalCarrierResourceForSizing(bytes, 1)).toThrow();
		expect(() => canonicalCarrierResourceForSizing(bytes, 2, {maxItems: 8})).toThrow();
		expect(() => canonicalCarrierResourceForSizing(Uint8Array.from([...bytes, 0]), 2)).toThrow();
		expect(() => canonicalCarrierResourceForSizing(bytes, -1)).toThrow();
	});

	it("uses original source/decision field schemas with complete scalar widths and decoder edges", () => {
		const capacity = (value: unknown): CreatorCanonicalCapacityForSizing => {
			const shape = (node: unknown): {items: number; maxDepth: number} => {
				if (Array.isArray(node)) {
					const children = node.map(shape);
					return {items: 1 + children.length + children.reduce((sum, child) => sum + child.items, 0),
						maxDepth: children.length === 0 ? 0 : 1 + Math.max(...children.map(child => child.maxDepth))};
				}
				if (node !== null && typeof node === "object" && !(node instanceof Uint8Array)) {
					const children = Object.entries(node).flatMap(([key, child]) => [shape(key), shape(child)]);
					return {items: 1 + children.length + children.reduce((sum, child) => sum + child.items, 0),
						maxDepth: children.length === 0 ? 0 : 1 + Math.max(...children.map(child => child.maxDepth))};
				}
				return {items: 1, maxDepth: 0};
			};
			return {...shape(value), byteLength: encodeCanonical(value).byteLength};
		};
		for (const count of [0, 1, 127, 128]) {
			const actual = {summary: {floor: 4, cuts: []}, floor: {stable: {epoch: 4}, pending: null},
				rows: Array.from({length: count}, (_, ordinal) => ({ordinal, preimage: new Uint8Array(128)})),
				snapshots: [{scope: {epoch: 3}, incarnation: "native-fixture"}],
				snapshotImage: {scopeCount: 1, chunkCount: 1}, journalImage: {rowCount: count},
				cut: {kind: "drp-hard-epoch-cut", closeSetCount: count},
				journalPrefixes: [{rows: [1, 2]}], journalHeaders: {protectedHeaderScopes: [1, 2]},
				signingDetails: [{key: ["room", 1], revision: 3}], summarySource: {entries: []},
				generationSource: {generations: []}};
			const vector = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, capacity(value)])) as
				Parameters<typeof readCreatorClosedRetirementSourceCapacityForSizing>[0];
			const before = encodeCanonical(vector), result = readCreatorClosedRetirementSourceCapacityForSizing(vector);
			const lengths = Object.fromEntries(Object.entries(vector).map(([key, value]) => [key, value.byteLength])) as
				Parameters<typeof readCreatorClosedRetirementSourceCarrierWidthsForSizing>[0];
			expect(result.map(branch => branch.byteLength)).toEqual(readCreatorClosedRetirementSourceCarrierWidthsForSizing(lengths));
			const base = {summary: actual.summary, floor: actual.floor, rows: actual.rows,
				snapshots: actual.snapshots, snapshotImage: actual.snapshotImage, journalImage: actual.journalImage};
			const sourceVariants = [base, {...base, journalPrefixes: actual.journalPrefixes, journalHeaders: actual.journalHeaders},
				{...base, signingDetails: actual.signingDetails}, {...base, signingDetails: actual.signingDetails,
					journalPrefixes: actual.journalPrefixes, journalHeaders: actual.journalHeaders}, base, base];
			const policies = ["authenticated-closed-metadata-frontiers-no-drain", "authenticated-covered-local-journal-prefixes",
				"authenticated-covered-local-finalized-evidence", "authenticated-covered-local-finalized-evidence",
				"authenticated-fenced-local-finalized-signing-summaries-v2", "authenticated-excluded-native-generation-v3"];
			expect(result).toHaveLength(sourceVariants.length);
			for (const [index, branch] of result.entries()) {
				expect(branch.source).toEqual(capacity(sourceVariants[index]));
				expect(branch.decision).toEqual(capacity({cut: actual.cut, sourceProofDigest: "0".repeat(64), policy: policies[index]}));
			}
			expect(encodeCanonical(vector)).toEqual(before);
		}
	});

	it("refuses malformed or exhausted scalar source dimensions rather than hiding expanded children", () => {
		const leaf = {byteLength: 1, items: 1, maxDepth: 0}, input = {summary: leaf, floor: leaf, rows: leaf,
			snapshots: leaf, snapshotImage: leaf, journalImage: leaf, cut: leaf};
		for (const invalid of [{...leaf, byteLength: 0}, {...leaf, byteLength: 786_433},
			{...leaf, byteLength: Number.MAX_SAFE_INTEGER}, {...leaf, items: 0}, {...leaf, items: 65_536},
			{...leaf, maxDepth: 128}, {...leaf, maxDepth: -1}, {...leaf, items: Number.NaN}])
			expect(() => readCreatorClosedRetirementSourceCapacityForSizing({...input, rows: invalid})).toThrow();
		// The absent optional descriptor branch is not represented by a forged
		// zero-width value, and BYTES opacity cannot be inferred from byte length.
		expect(() => readCreatorClosedRetirementSourceCapacityForSizing({...input,
			journalPrefixes: {...leaf, byteLength: 0}})).toThrow();
		const expanded = readCreatorClosedRetirementSourceCapacityForSizing({...input,
			rows: {byteLength: 3, items: 3, maxDepth: 1}})[0]!;
		const opaque = readCreatorClosedRetirementSourceCapacityForSizing({...input,
			rows: {byteLength: 3, items: 1, maxDepth: 0}})[0]!;
		expect(expanded.byteLength).toBe(opaque.byteLength);
		expect(expanded.source.items).toBe(opaque.source.items + 2);
		expect(expanded.source.maxDepth).toBe(opaque.source.maxDepth + 1);
	});

	it("accepts only the original profile's exact zero-fence or one-fence numerical topology", () => {
		const zero = [{}, {}], one = [{successorJournalAppendForSizing: {author: "creator", authorSequence: 2},
			nativeJobPhases: [{phase: "reserved"}, {phase: "entered"}]}];
		expect(readCreatorFinishingSuccessorFenceCountForSizing("creator-trusted-v1", zero)).toBe(0);
		expect(readCreatorFinishingSuccessorFenceCountForSizing("creator-trusted-settlement-v1", one)).toBe(1);
		for (const profile of ["creator-trusted-v1", "creator-trusted-settlement-v1", "untrusted-profile"]) {
			expect(readCreatorFinishingSuccessorFenceCountForSizing(profile, [])).toBeUndefined();
			expect(readCreatorFinishingSuccessorFenceCountForSizing(profile, [{currentContinuation: {}}])).toBeUndefined();
			expect(readCreatorFinishingSuccessorFenceCountForSizing(profile, [{nativeJobPhases: []}])).toBeUndefined();
			expect(readCreatorFinishingSuccessorFenceCountForSizing(profile, [...zero, ...one])).toBeUndefined();
		}
		expect(readCreatorFinishingSuccessorFenceCountForSizing("creator-trusted-v1", one)).toBeUndefined();
		expect(readCreatorFinishingSuccessorFenceCountForSizing("creator-trusted-settlement-v1", zero)).toBeUndefined();
		expect(readCreatorFinishingSuccessorFenceCountForSizing("creator-trusted-settlement-v1", [{...one[0],
			nativeJobPhases: [{phase: "entered"}, {phase: "reserved"}]}])).toBeUndefined();
	});

	it("keeps complete zero-fence native PRE for local and received sizing without requiring or inventing a plan", () => {
		const scope = {objectId: "room", author: "1".repeat(64)};
		const preimage = (sequence: number, payload: number) => encodeCanonical({kind: "drp-vertex", protocolMajor: 3,
			...scope, authorSequence: sequence, epoch: 3, anchor: "a".repeat(64), dependencies: ["a".repeat(64)],
			logicalTime: sequence, operation: {action: "codecFixture", data: new Uint8Array(payload)}});
		const bytes = preimage(1, 8_334), digest = hashDomain("ts-drp/vertex/v3", bytes);
		const bootstrapBytes = preimage(0, 0);
		const issued = [{...scope, authorSequence: 0, canonicalPreimageBytes: bootstrapBytes,
			digest: hashDomain("ts-drp/vertex/v3", bootstrapBytes), signature: new Uint8Array(64)},
			{...scope, authorSequence: 1, canonicalPreimageBytes: bytes, digest, signature: new Uint8Array(64)}];
		// Mechanical native-codec data only; these opaque leaves confer no
		// signature, source, prepared close, or admitted runtime authority.
		const rows: IssuanceRetirementRows = {lineages: [{...scope, next: 2, exhausted: false, prunedThroughAuthorSequence: null}],
			issued, outbox: issued.map(row => ({objectId: row.objectId, author: row.author,
				authorSequence: row.authorSequence, digest: row.digest, publishState: "pending" as const})), plans: []};
		for (const count of [0, 1]) {
			const input = {rows, scope, control: null, maxAdditionalCurrentIssued: count,
				maxCanonicalPreimageByteLength: 512, successorFenceCount: 0 as const};
			const before = encodeCanonical(input), bound = issuanceOrdinaryFinishingCapacityWidths(input);
			const candidate = preimage(2, 16);
			const exact = count === 0 ? issuanceUnsignedContinuationWidths(rows, scope, undefined, null, []).final :
				issuanceUnsignedPostimageWidths(rows, scope, {kind: "v3-issuance-pending-unsigned-1", authorSequence: 2,
					canonicalPreimageBytes: candidate, digest: hashDomain("ts-drp/vertex/v3", candidate)}, null).final;
			for (const key of ["canonicalRowsBytes", "nativeCensusBytes", "encodedControlBytes", "rowCount"] as const)
				expect(bound.ordinaryFinal[key], key).toBeGreaterThanOrEqual(exact[key]);
			expect(bound.successorFinal).toEqual(bound.ordinaryFinal);
			expect(bound.successorPending).toEqual(bound.ordinaryFinal);
			expect(bound.canonicalRowsShape.successorFinal).toEqual(bound.canonicalRowsShape.ordinaryFinal);
			expect(bound.ordinaryFinal.canonicalRowsBytes).toBeGreaterThan(bytes.byteLength);
			expect(encodeCanonical(input)).toEqual(before);
			// The existing one-fence owner now includes an original absent-plan
			// birth. NONE still has no plan; numerical one-fence widths confer no
			// runtime frontier, append or signing authority.
			const fence = issuanceOrdinaryFinishingCapacityWidths({...input, successorFenceCount: 1});
			expect(fence.ordinaryFinal).toEqual(bound.ordinaryFinal);
			expect(fence.successorFinal.rowCount).toBe(bound.ordinaryFinal.rowCount + 3);
			for (const key of ["canonicalRowsBytes", "nativeCensusBytes"] as const) {
				expect(fence.successorFinal[key]).toBeGreaterThan(bound.ordinaryFinal[key]);
				expect(fence.successorPending[key]).toBeGreaterThan(fence.successorFinal[key]);
			}
			expect(encodeCanonical(input)).toEqual(before);
			expect(() => issuanceOrdinaryFinishingCapacityWidths({...input,
				rows: {...rows, plans: [{scope, revision: 0, fenceSequence: null, entries: []}]}})).toThrow();
		}
	});

	it("bounds included-current pending/final images with ordinary PRE limits without discounting OLD or future fence geometry", () => {
		const scope = {objectId: "room", author: "1".repeat(64)};
		const preimage = (sequence: number, payload: number) => encodeCanonical({kind: "drp-vertex", protocolMajor: 3,
			...scope, authorSequence: sequence, epoch: 3, anchor: "a".repeat(64), dependencies: ["a".repeat(64)],
			logicalTime: sequence, operation: {action: "codecFixture", data: new Uint8Array(payload)}});
		const pair = (raw: Uint8Array, sequence: number) => ({...scope, authorSequence: sequence,
			canonicalPreimageBytes: raw, digest: hashDomain("ts-drp/vertex/v3", raw), signature: new Uint8Array(64)});
		const old = pair(preimage(0, 8334), 0);
		// Mechanical native-codec oracle only: these leaves confer no signature
		// authority. OLD is deliberately larger than the NEW ordinary leaf cap.
		const base: IssuanceRetirementRows = {lineages: [{...scope, next: 1, exhausted: false, prunedThroughAuthorSequence: null}],
			issued: [old], outbox: [{...scope, authorSequence: 0, digest: old.digest, publishState: "pending"}], plans: []};
		for (const count of [1, 2, 8]) for (const reverse of [false, true]) {
			const raw = Array.from({length: count}, (_, index) => preimage(index + 1, [0, 127, 128, 1024][(reverse ? count - index - 1 : index) % 4]!));
			const total = raw.reduce((sum, value) => sum + value.byteLength, 0);
			const input = {rows: base, scope, control: null, maxAdditionalCurrentIssued: count,
				maxCanonicalPreimageByteLength: 16384, maxOrdinaryPreimageByteLength: 4096,
				maxAdditionalCurrentPreimageBytes: total, successorFenceCount: 1 as const};
			const before = encodeCanonical(base), bound = issuanceOrdinaryFinishingCapacityWidths(input);
			const broad = issuanceOrdinaryFinishingCapacityWidths({...input, maxOrdinaryPreimageByteLength: 16384});
			for (const phase of ["ordinaryPending", "ordinaryFinal", "successorPending", "successorFinal"] as const)
				expect(bound[phase]).toEqual(broad[phase]); // Full M geometry unchanged.
			let current = structuredClone(base);
			for (const [index, value] of raw.entries()) {
				const sequence = index + 1;
				const exact = issuanceUnsignedPostimageWidths(current, scope, {kind: "v3-issuance-pending-unsigned-1",
					authorSequence: sequence, canonicalPreimageBytes: value, digest: hashDomain("ts-drp/vertex/v3", value)}, null);
				for (const phase of ["reserved", "entered"] as const)
					expect(bound.currentAdmission.pendingNativeCensusByteLength).toBeGreaterThanOrEqual(exact[phase].nativeCensusBytes);
				expect(bound.currentAdmission.finalNativeCensusByteLength).toBeGreaterThanOrEqual(exact.final.nativeCensusBytes);
				const next = pair(value, sequence);
				current = {...current, lineages: [{...current.lineages[0]!, next: sequence + 1}], issued: [...current.issued, next],
					outbox: [...current.outbox, {...scope, authorSequence: sequence, digest: next.digest, publishState: "pending"}]};
			}
			expect(bound.currentAdmission.additionalIssuedByteLength).toBeGreaterThanOrEqual(
				current.issued.slice(1).reduce((sum, row) => sum + encodeCanonical(row).byteLength, 0));
			expect(bound.currentAdmission.pendingNativeCensusByteLength).toBeLessThan(bound.ordinaryPending.nativeCensusBytes);
			expect(bound.currentAdmission.finalNativeCensusByteLength).toBeGreaterThan(old.canonicalPreimageBytes.byteLength);
			expect(encodeCanonical(base)).toEqual(before); expect(Object.isFrozen(bound.currentAdmission)).toBe(true);
		}
		const empty = issuanceOrdinaryFinishingCapacityWidths({rows: base, scope, control: null,
			maxAdditionalCurrentIssued: 0, maxCanonicalPreimageByteLength: 16384, maxOrdinaryPreimageByteLength: 4096});
		expect(empty.currentAdmission.pendingNativeCensusByteLength).toBeNull();
		expect(empty.currentAdmission.additionalIssuedByteLength).toBe(0);
		for (const maximum of [0, 16385, 1.5]) expect(() => issuanceOrdinaryFinishingCapacityWidths({rows: base, scope,
			control: null, maxAdditionalCurrentIssued: 1, maxCanonicalPreimageByteLength: 16384,
			maxOrdinaryPreimageByteLength: maximum})).toThrow();
	});

	it("re-evaluates complete changed payload fields including BYTES count-prefix growth", () => {
		const compiler = createCreatorFinishingWidthCompiler(), payload = new Uint8Array(127);
		compiler.bindBytes("payload", payload);
		const width = compiler.measure({payload, revision: 3});
		compiler.result({unknownEncodedLengths: [width], fullFutureProofEnvelopeByteLengths: [width]});
		const program = compiler.finish();
		for (const length of [127, 128, 8_334, 16_384]) {
			const result = evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["payload", length]]));
			expect(result).toBeDefined();
			expect(result!.unknown).toBe(encodeCanonical({payload: new Uint8Array(length), revision: Number.MAX_SAFE_INTEGER}).byteLength);
			expect(result!.envelopes).toEqual([result!.unknown]);
		}
		// Retained program contains only numbers, parameter names and operations.
		expect(JSON.parse(JSON.stringify(program))).toEqual(program);
	});

	it("counts every ARRAY edge and native object key/value node across 127 to 128 rows", () => {
		const compiler = createCreatorFinishingWidthCompiler();
		const row = {logicalBytes: Number.MAX_SAFE_INTEGER, lineageCount: Number.MAX_SAFE_INTEGER,
			issuedCount: Number.MAX_SAFE_INTEGER, outboxCount: Number.MAX_SAFE_INTEGER,
			planCount: Number.MAX_SAFE_INTEGER, imageDigest: "0".repeat(64)};
		const rows = Array.from({length: 127}, () => row);
		compiler.bindArray(rows, "rows", rows.length, row);
		const width = compiler.measure(rows);
		compiler.result({unknownEncodedLengths: [width], fullFutureProofEnvelopeByteLengths: [width]});
		const program = compiler.finish();
		const before = evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["rows", 127]]));
		const after = evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["rows", 128]]));
		expect(before!.unknown).toBe(encodeCanonical(rows).byteLength);
		expect(after!.unknown).toBe(encodeCanonical(Array.from({length: 128}, () => row)).byteLength);
		expect(after!.unknown - before!.unknown).toBe(encodeCanonical(row).byteLength + 1);
	});

	it("enforces the combined runtime and direct native decoded-item limit", () => {
		const compiler = createCreatorFinishingWidthCompiler();
		const row = {logicalBytes: 0, lineageCount: 0, issuedCount: 0, outboxCount: 0, planCount: 0,
			imageDigest: "0".repeat(64)};
		const rows = Array.from({length: 127}, () => row), runtimeItems = 65_536 - (1 + 127 * 26);
		compiler.bindArray(rows, "rows", rows.length, row);
		compiler.bind("runtime.items", runtimeItems);
		const width = compiler.measure(rows);
		compiler.runtimeShape({items: runtimeItems, maxDepth: 1}, rows);
		compiler.result({unknownEncodedLengths: [width], fullFutureProofEnvelopeByteLengths: [width]});
		const program = compiler.finish();
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["rows", 127], ["runtime.items", runtimeItems]]))).toBeDefined();
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["rows", 128], ["runtime.items", runtimeItems]]))).toBeUndefined();
	});

	it("maxes ambiguous equal scalar widths and checks all original phase alternatives", () => {
		const compiler = createCreatorFinishingWidthCompiler();
		compiler.bind("first", 10); compiler.bind("second", 10);
		const width = compiler.measure({payload: compiler.encodedBytes(10)});
		compiler.result({unknownEncodedLengths: [width], fullFutureProofEnvelopeByteLengths: [width]});
		const program = compiler.finish();
		for (const [first, second] of [[10, 1_024], [1_024, 10], [127, 128]]) {
			const result = evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["first", first!], ["second", second!]]));
			expect(result!.unknown).toBeGreaterThanOrEqual(encodeCanonical({payload: new Uint8Array(Math.max(first!, second!))}).byteLength);
		}
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["first", 10]]))).toBeUndefined();
	});

	it("keeps all changing equal-width aliases in a linear backward-only MAX DAG", () => {
		const compiler = createCreatorFinishingWidthCompiler(), count = 512;
		const phaseWidths: number[] = [];
		for (let index = 0; index < count; index++) {
			compiler.bind(`alias.${index}`, 16);
			// Each original field lookup sees the accumulated aliases, then its
			// measured width registers another collision at the same cold value.
			phaseWidths.push(compiler.measure({payload: compiler.encodedBytes(16)}));
		}
		const constantFloor = 100, maximum = compiler.maximum([...phaseWidths, constantFloor]);
		// Re-registering the current MAX and an existing constant alias cannot
		// add another logically redundant alternative or lose any leaf.
		compiler.dominate(maximum, "constant-alias", maximum);
		compiler.result({unknownEncodedLengths: [maximum], fullFutureProofEnvelopeByteLengths: [maximum]});
		const program = compiler.finish();
		const maximumEdges = program.nodes.reduce((total, node) => total +
			(node.kind === "maximum" ? node.children.length : 0), 0);
		expect(program.nodes.length).toBeLessThan(count * 16 + 128);
		expect(maximumEdges).toBeLessThan(count * 8 + 128);
		for (const [index, node] of program.nodes.entries()) {
			const refs = node.kind === "sum" || node.kind === "maximum" ? node.children :
				node.kind === "bytes" || node.kind === "array-count" ? [node.child] :
				node.kind === "product" ? [node.left, node.right] : [];
			expect(refs.every(reference => reference < index)).toBe(true);
		}
		for (const winner of [0, 127, count - 1]) {
			const parameters = new Map(Array.from({length: count}, (_, index) =>
				[`alias.${index}`, index === winner ? 8_334 : 1 + index % 128] as const));
			parameters.set("constant-alias", maximum);
			const evaluated = evaluateCreatorFinishingWidthProgramForSizing(program, parameters);
			const originalFlatMaximum = Math.max(...Array.from(parameters.values()).slice(0, count));
			expect(evaluated).toBeDefined();
			expect(evaluated!.unknown).toBe(Math.max(constantFloor,
				encodeCanonical({payload: new Uint8Array(originalFlatMaximum)}).byteLength));
			expect(evaluated!.envelopes).toEqual([evaluated!.unknown]);
		}
		const decreased = new Map<string, number>(Array.from({length: count}, (_, index) => [`alias.${index}`, 1] as const));
		decreased.set("constant-alias", maximum);
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, decreased)!.unknown).toBe(constantFloor);
	});

	it("rejects native exhaustion, unsafe arithmetic and invalid forward references", () => {
		const compiler = createCreatorFinishingWidthCompiler(), payload = new Uint8Array(16);
		compiler.bindBytes("payload", payload);
		const width = compiler.measure({payload});
		compiler.native(width, 256);
		compiler.result({unknownEncodedLengths: [width], fullFutureProofEnvelopeByteLengths: [width]});
		const program = compiler.finish();
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["payload", 16]]))).toBeDefined();
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["payload", 256]]))).toBeUndefined();
		expect(evaluateCreatorFinishingWidthProgramForSizing(program, new Map([["payload", Number.MAX_SAFE_INTEGER]]))).toBeUndefined();
		const invalid = {...program, nodes: [{kind: "sum" as const, children: [0]}, ...program.nodes.slice(1)]};
		expect(evaluateCreatorFinishingWidthProgramForSizing(invalid, new Map([["payload", 16]]))).toBeUndefined();
	});

	it("keeps a cold non-maximal original phase when its fresh field becomes larger", () => {
		const compiler = createCreatorFinishingWidthCompiler();
		compiler.bind("reserved", 127); compiler.bind("entered", 128);
		const reserved = compiler.measure({payload: compiler.encodedBytes(127)});
		const entered = compiler.measure({payload: compiler.encodedBytes(128)});
		const maximum = compiler.maximum([reserved, entered]);
		compiler.result({unknownEncodedLengths: [maximum], fullFutureProofEnvelopeByteLengths: [reserved, entered]});
		const result = evaluateCreatorFinishingWidthProgramForSizing(compiler.finish(), new Map([["reserved", 2_048], ["entered", 128]]));
		expect(result!.unknown).toBeGreaterThanOrEqual(encodeCanonical({payload: new Uint8Array(2_048)}).byteLength);
		expect(Math.max(...result!.envelopes)).toBe(result!.unknown);
	});

	it("preserves growing protected-record ARRAY markers through nested common and branch copies", () => {
		const compiler = createCreatorFinishingWidthCompiler();
		const record = {author: "creator", authorSequence: Number.MAX_SAFE_INTEGER, digest: "0".repeat(64)};
		const protectedRecords = Array.from({length: 127}, () => record);
		compiler.bindArray(protectedRecords, "protection.future.count", protectedRecords.length, record);
		// The original branch copier transfers the invocation-local markers at
		// every copied ARRAY, including arrays nested inside preparation records.
		const copyBranchFields = (value: unknown): unknown => {
			if (Array.isArray(value)) {
				const copied = value.map(copyBranchFields);
				compiler.copyFields(value, copied);
				return copied;
			}
			if (value !== null && typeof value === "object")
				return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyBranchFields(child)]));
			return value;
		};
		const seed = {preparations: {issuance: {protectedRecords}}};
		const common = copyBranchFields(seed), branch = copyBranchFields(common);
		const width = compiler.measure(branch);
		compiler.result({unknownEncodedLengths: [width], fullFutureProofEnvelopeByteLengths: [width]});
		const program = compiler.finish();
		for (const count of [127, 128, 256]) {
			const result = evaluateCreatorFinishingWidthProgramForSizing(program,
				new Map([["protection.future.count", count]]));
			expect(result).toBeDefined();
			const fresh = {preparations: {issuance: {protectedRecords: Array.from({length: count}, () => record)}}};
			expect(result!.unknown).toBe(encodeCanonical(fresh).byteLength);
			expect(result!.envelopes).toEqual([result!.unknown]);
		}
		expect(protectedRecords).toHaveLength(127);
	});

	it("selects the exact native head in a reordered protected census without relaxing trust-carrier ambiguity", () => {
		// Detached structural data exercises selection only: no trust/proof
		// wrapper, signature capability, runtime lifetime or grant is minted.
		const value = <T>(result: {ok: true; value: T} | {ok: false}): T => {
			if (!result.ok) throw new Error("NATIVE_HEAD_SELECTOR_FIXTURE_INVALID");
			return result.value;
		};
		const objectId = value(parseStorageObjectId(`creator:${"0".repeat(32)}`));
		const oldBytes = encodeCanonical({kind: "drp-anchor-trust-state", currentEpoch: 1});
		const currentBytes = encodeCanonical({kind: "drp-anchor-trust-state", currentEpoch: 3});
		const blob = (bytes: Uint8Array) => ({bytes, ref: {digest: value(digestBlob(bytes)), byteLength: bytes.byteLength}});
		const oldBlob = blob(oldBytes), currentBlob = blob(currentBytes);
		const generation = (id: string, carriers: readonly ReturnType<typeof blob>[], baseExpectedHead: ExpectedHead): GenerationRecord => {
			const closure = carriers.map(carrier => carrier.ref).sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0);
			return {objectId, generationId: value(parseGenerationId(id.repeat(64))), baseExpectedHead,
				closure, closureDigest: value(digestClosure(closure)), state: baseExpectedHead.kind === "none" ? "Superseded" : "Adopted"};
		};
		const older = generation("a", [oldBlob], {kind: "none", objectId});
		const base: PresentHead = {kind: "present", objectId, generationId: older.generationId,
			closureDigest: older.closureDigest, revision: value(parseHeadRevision(2))};
		const current = generation("b", [currentBlob], base);
		const head: PresentHead = {kind: "present", objectId, generationId: current.generationId,
			closureDigest: current.closureDigest, revision: value(parseHeadRevision(3))};
		const reader = {head, generations: [older, current], blobs: [oldBlob, currentBlob]};
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing(reader, 3)).toEqual(currentBytes);
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader, generations: [current, older]}, 3)).toEqual(currentBytes);
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader, generations: [older]}, 3)).toBeUndefined();
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader, generations: [older, current, current]}, 3)).toBeUndefined();
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader, generations: [older, {...current, state: "Complete"}]}, 3)).toBeUndefined();
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader, head: {...head, revision: base.revision}}, 3)).toBeUndefined();
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing(reader, 2)).toBeUndefined();
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader, blobs: [oldBlob, currentBlob, currentBlob]}, 3)).toBeUndefined();
		// A contradictory recognized trust at another epoch still invalidates
		// the complete current closure; filtering by epoch cannot hide it.
		const contradictory = generation("b", [oldBlob, currentBlob], base);
		expect(readCreatorFinishingLiveTrustStateCarrierForSizing({...reader,
			head: {...head, closureDigest: contradictory.closureDigest}, generations: [older, contradictory]}, 3)).toBeUndefined();
	});
});
