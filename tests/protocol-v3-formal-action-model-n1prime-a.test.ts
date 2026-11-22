import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import contractDocument from "./fixtures/phase-n1prime-a/formal-action-contract.json" with { type: "json" };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface SignedVertexControl {
	anchor: string;
	author: string;
	authorSequence: number;
	dependencies: string[];
	epoch: number;
	kind: string;
	logicalTime: number;
	objectId: string;
	operation: string;
	protocolMajor: number;
}

interface LocalAttempt {
	counterAfter: number;
	counterBefore: number;
	result: "failure" | "success";
	selectedSequence: number;
	signedMaterial: {
		exposed: boolean;
		stored: boolean;
		vertex: SignedVertexControl;
	} | null;
}

interface LocalLineageControl {
	attempts: LocalAttempt[];
	author: string;
	durableLineage: string;
	initialNextSequence: number;
	objectId: string;
}

interface RemoteEvent {
	admission: "accept" | "reject";
	envelopeId: string;
	observation: "contiguous" | "duplicate" | "equivocation" | "fills-gap" | "first" | "gap";
	operation: string;
	sequence: number;
}

interface RemoteDeliveryControl {
	candidatesAuthenticated: boolean;
	events: RemoteEvent[];
	name: string;
}

interface BoundedStateControl {
	atCapacity: {
		after: Record<string, number>;
		before: Record<string, number>;
		stuttered: boolean;
	};
	caps: Record<string, number>;
}

interface EquivocationObservation {
	author: string;
	authorSequence: number;
	detected: boolean;
	objectId: string;
	operations: string[];
}

interface FormalActionContract {
	controls: {
		authentication: {
			fieldMutations: Record<keyof SignedVertexControl, SignedVertexControl[keyof SignedVertexControl]>;
			signedVertex: SignedVertexControl;
		};
		boundedState: BoundedStateControl;
		equivocationObservations: EquivocationObservation[];
		localLineage: LocalLineageControl;
		remoteDeliveries: RemoteDeliveryControl[];
	};
	modelStructure: {
		authenticationPredicate: string;
		exposedRecordsField: string;
		issuedRecordsField: string;
		operationIdentity: string;
		remoteDecisionField: string;
		signedVertexType: string;
		stateType: string;
	};
	protocolMajor: number;
	quint: {
		invariants: string[];
		maxSamples: number;
		maxSteps: number;
		module: string;
		scenarioTests: string[];
		seed: string;
		stepAction: string;
		witnesses: string[];
	};
	requiredActions: string[];
	schemaVersion: "phase-n1prime-a-formal-action-contract-v2";
	signedVertexFields: Array<keyof SignedVertexControl>;
	targetArtifacts: {
		model: string;
		signedFieldDerivation: string;
	};
}

interface SignedFieldDerivation {
	algorithm: "signed-vertex-type-auth-action-usage-v1";
	derivedSignedFields: string[];
	inputs: {
		authenticatedActions: string[];
		authenticationPredicate: string;
		model: {
			path: string;
			sha256: string;
		};
		registry: [];
		signedVertexType: {
			fields: string[];
			name: string;
		};
	};
	protocolMajor: number;
	schemaVersion: "phase-n1prime-a-signed-field-derivation-v2";
}

interface QuintExpression {
	args?: QuintExpression[];
	expr?: QuintExpression;
	kind: string;
	name?: string;
	opcode?: string;
	params?: Array<{
		name: string;
	}>;
	value?: string;
}

interface QuintDeclaration {
	expr?: QuintExpression;
	kind: string;
	name: string;
	qualifier?: string;
	type?: QuintType;
	typeAnnotation?: QuintType;
}

interface QuintType {
	arg?: QuintType;
	args?: QuintType[];
	elem?: QuintType;
	fields?: {
		fields: Array<{
			fieldName: string;
			fieldType: QuintType;
		}>;
		kind: string;
		other: {
			kind: string;
		};
	};
	kind: string;
	name?: string;
	res?: QuintType;
}

interface QuintModule {
	declarations: QuintDeclaration[];
	name: string;
}

interface QuintParseDocument {
	errors: unknown[];
	modules: QuintModule[];
	stage: string;
}

const contract = contractDocument as unknown as FormalActionContract;
const modelPath = contract.targetArtifacts.model;
const derivationPath = contract.targetArtifacts.signedFieldDerivation;
const modelExists = existsSync(absolutePath(modelPath));
const derivationExists = existsSync(absolutePath(derivationPath));
const greenArtifactsExist = modelExists && derivationExists;

function absolutePath(path: string): string {
	return `${repositoryRoot}/${path}`;
}

function sha256(path: string): string {
	return createHash("sha256")
		.update(readFileSync(absolutePath(path)))
		.digest("hex");
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(absolutePath(path), "utf8")) as T;
}

function successfulSequences(lineage: LocalLineageControl): number[] {
	return lineage.attempts
		.filter(({ result }) => result === "success")
		.map(({ signedMaterial }) => signedMaterial?.vertex.authorSequence)
		.filter((sequence) => sequence !== undefined);
}

function validateLocalLineage(lineage: LocalLineageControl): void {
	expect(lineage.initialNextSequence, "the bounded durable-lineage control must begin at ordinal zero").toBe(0);
	const successes = successfulSequences(lineage);
	const expected = Array.from({ length: successes.length }, (_, index) => lineage.initialNextSequence + index);

	for (const attempt of lineage.attempts) {
		if (attempt.result === "success") {
			expect(attempt.selectedSequence, "a successful issue must select the transaction's current ordinal").toBe(
				attempt.counterBefore
			);
			expect(attempt.counterAfter, "one successful issue advances exactly one ordinal").toBe(attempt.counterBefore + 1);
			expect(attempt.signedMaterial, "successful issuance must construct signed material").not.toBeNull();
			if (attempt.signedMaterial !== null) {
				expect(attempt.signedMaterial.stored, "successful issuance must store one signed issued record").toBe(true);
				expect(attempt.signedMaterial.exposed, "successful issuance must expose that signed issued record").toBe(true);
				expect(
					attempt.signedMaterial.vertex.authorSequence,
					"embedded signed authorSequence must equal the selected current lineage ordinal"
				).toBe(attempt.selectedSequence);
			}
		} else {
			expect(attempt.counterAfter, "a failed issue must not consume an ordinal").toBe(attempt.counterBefore);
			expect(attempt.signedMaterial, "a failed issue must add, store and expose no signed record").toBeNull();
		}
	}

	expect(
		successes,
		"successful local issuance must expose exactly the contiguous durable-lineage ordinals 0..n-1"
	).toEqual(expected);
}

function remoteAdmissionByEnvelope(delivery: RemoteDeliveryControl): Map<string, Set<RemoteEvent["admission"]>> {
	const decisions = new Map<string, Set<RemoteEvent["admission"]>>();

	for (const event of delivery.events) {
		const envelopeDecisions = decisions.get(event.envelopeId) ?? new Set<RemoteEvent["admission"]>();
		envelopeDecisions.add(event.admission);
		decisions.set(event.envelopeId, envelopeDecisions);
	}

	return decisions;
}

function remoteCandidateByEnvelope(delivery: RemoteDeliveryControl): Map<string, Set<string>> {
	const candidates = new Map<string, Set<string>>();

	for (const event of delivery.events) {
		const envelopeCandidates = candidates.get(event.envelopeId) ?? new Set<string>();
		envelopeCandidates.add(JSON.stringify({ operation: event.operation, sequence: event.sequence }));
		candidates.set(event.envelopeId, envelopeCandidates);
	}

	return candidates;
}

function validateRemotePolicy(deliveries: RemoteDeliveryControl[]): void {
	expect(deliveries.length, "the control must exercise more than one arrival order").toBeGreaterThan(1);

	for (const delivery of deliveries) {
		expect(delivery.candidatesAuthenticated, `${delivery.name} must contain only valid signed candidates`).toBe(true);
		const seenOperationsBySequence = new Map<number, Set<string>>();
		let greatestSeenSequence = -1;

		for (const event of delivery.events) {
			expect(
				event.admission,
				`remote ${event.observation} observation must not become an admission rejection in ${delivery.name}`
			).toBe("accept");

			const priorOperations = seenOperationsBySequence.get(event.sequence) ?? new Set<string>();
			if (event.observation === "duplicate") {
				expect(
					priorOperations.has(event.operation),
					"a duplicate must repeat the same authenticated operation at the same slot"
				).toBe(true);
			}
			if (event.observation === "equivocation") {
				expect(
					priorOperations.size > 0 && !priorOperations.has(event.operation),
					"equivocation must introduce a different authenticated operation at an occupied slot"
				).toBe(true);
			}
			if (event.observation === "gap") {
				expect(
					event.sequence > greatestSeenSequence + 1,
					"a gap observation must be derived from prior arrival history"
				).toBe(true);
			}
			if (event.observation === "fills-gap") {
				expect(
					event.sequence < greatestSeenSequence && priorOperations.size === 0,
					"a fills-gap observation must be derived from prior arrival history"
				).toBe(true);
			}

			priorOperations.add(event.operation);
			seenOperationsBySequence.set(event.sequence, priorOperations);
			greatestSeenSequence = Math.max(greatestSeenSequence, event.sequence);
		}
	}

	const baseline = remoteAdmissionByEnvelope(deliveries[0]);
	const baselineCandidates = remoteCandidateByEnvelope(deliveries[0]);
	for (const [envelopeId, identities] of baselineCandidates) {
		expect(identities.size, `envelope ${envelopeId} must identify one immutable authenticated candidate`).toBe(1);
	}
	for (const delivery of deliveries.slice(1)) {
		const candidate = remoteAdmissionByEnvelope(delivery);
		const candidateIdentities = remoteCandidateByEnvelope(delivery);
		expect([...candidate.keys()].sort(), "arrival permutations must carry the same envelope identities").toEqual(
			[...baseline.keys()].sort()
		);
		for (const [envelopeId, decisions] of baseline) {
			expect(
				candidate.get(envelopeId),
				`remote admission for ${envelopeId} must be independent of arrival order`
			).toEqual(decisions);
			expect(
				candidateIdentities.get(envelopeId),
				`arrival permutations must preserve the authenticated operation and slot for ${envelopeId}`
			).toEqual(baselineCandidates.get(envelopeId));
		}
	}

	const observations = new Set(deliveries.flatMap(({ events }) => events.map(({ observation }) => observation)));
	expect(observations.has("duplicate"), "the control must observe an admitted duplicate").toBe(true);
	expect(observations.has("gap"), "the control must observe an admitted gap").toBe(true);
	const equivocationSequences = new Set(
		deliveries.flatMap(({ events }) =>
			events.filter(({ observation }) => observation === "equivocation").map(({ sequence }) => sequence)
		)
	);
	expect(
		equivocationSequences.size,
		"arrival-order controls must observe equivocation at more than one sequence slot"
	).toBeGreaterThanOrEqual(2);
	expect(
		[...equivocationSequences].some((sequence) => sequence !== 1),
		"arrival-order controls must include non-1 equivocation"
	).toBe(true);
}

function parseQuintModule(): QuintModule {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "ts-drp-phase-n1prime-a-quint-"));
	const parseOutputPath = join(temporaryDirectory, "parsed-model.json");

	try {
		const parsed = spawnSync("pnpm", ["exec", "quint", "parse", modelPath, "--out", parseOutputPath], {
			cwd: repositoryRoot,
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
		});
		expect(parsed.status, `Quint must parse the actual v3 model before dependency extraction\n${parsed.stderr}`).toBe(
			0
		);
		expect(
			existsSync(parseOutputPath),
			"Quint 0.32 must emit parser JSON through --out; stdout is not an artifact channel"
		).toBe(true);

		const document = JSON.parse(readFileSync(parseOutputPath, "utf8")) as QuintParseDocument;
		expect(document.stage, "dependency extraction must consume Quint's parser output").toBe("parsing");
		expect(document.errors, "the parsed model must have no syntax errors").toEqual([]);
		const module = document.modules.find(({ name }) => name === contract.quint.module);
		expect(module, `parsed Quint output must contain module ${contract.quint.module}`).toBeDefined();
		return module as QuintModule;
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

function declaration(module: QuintModule, name: string): QuintDeclaration {
	const matches = module.declarations.filter((candidate) => candidate.kind === "def" && candidate.name === name);
	expect(matches, `the parsed model must declare ${name} exactly once`).toHaveLength(1);
	return matches[0];
}

function typeDeclaration(module: QuintModule, name: string): QuintDeclaration {
	const matches = module.declarations.filter((candidate) => candidate.kind === "typedef" && candidate.name === name);
	expect(matches, `the parsed model must declare type ${name} exactly once`).toHaveLength(1);
	return matches[0];
}

function recordTypeFields(module: QuintModule, typeName: string): string[] {
	const type = typeDeclaration(module, typeName).type;
	expect(type, `${typeName} must be a closed Quint record type`).toMatchObject({
		kind: "rec",
		fields: {
			kind: "row",
			other: { kind: "empty" },
		},
	});
	const fields = type?.fields?.fields.map(({ fieldName }) => fieldName) ?? [];
	expect(new Set(fields).size, `${typeName} must not repeat a field`).toBe(fields.length);
	return fields.sort();
}

function expressionTree(expression: QuintExpression | undefined): QuintExpression[] {
	if (expression === undefined) {
		return [];
	}
	return [expression, ...expressionTree(expression.expr), ...(expression.args ?? []).flatMap(expressionTree)];
}

function invokes(expression: QuintExpression | undefined, operator: string): boolean {
	return expressionTree(expression).some(({ kind, opcode }) => kind === "app" && opcode === operator);
}

function writesRecordField(expression: QuintExpression | undefined, fieldName: string): boolean {
	return expressionTree(expression).some(
		({ args, kind, opcode }) =>
			kind === "app" && opcode === "with" && args?.[1]?.kind === "str" && args[1].value === fieldName
	);
}

function referencesRecordField(expression: QuintExpression | undefined, fieldName: string): boolean {
	return expressionTree(expression).some(
		({ args, kind, opcode }) =>
			kind === "app" && opcode === "field" && args?.[1]?.kind === "str" && args[1].value === fieldName
	);
}

function mentionsStringValue(expression: QuintExpression | undefined, value: string): boolean {
	return expressionTree(expression).some((node) => node.kind === "str" && node.value === value);
}

function typedArguments(declaration: QuintDeclaration): string[] {
	expect(declaration.typeAnnotation, `${declaration.name} must carry a parsed operator type`).toMatchObject({
		kind: "oper",
	});
	return (declaration.typeAnnotation?.args ?? []).map(({ kind, name }) => `${kind}:${name ?? ""}`);
}

function actionChoiceIdentity(expression: QuintExpression): string | undefined {
	if (expression.kind === "name") {
		return expression.name;
	}
	if (expression.kind === "app") {
		return expression.opcode;
	}
	return undefined;
}

function validateNondeterministicStep(step: QuintDeclaration): void {
	expect(step.qualifier, "the simulation step must be a real Quint action").toBe("action");
	expect(
		step.expr,
		"step must be a top-level nondeterministic action choice, not a deterministic if-scripted schedule"
	).toMatchObject({
		kind: "app",
		opcode: "actionAny",
	});
	const choiceIdentities = (step.expr?.args ?? []).map(actionChoiceIdentity).filter((name) => name !== undefined);
	expect(
		new Set(choiceIdentities).size,
		"nondeterministic step must expose at least two distinct action choices"
	).toBeGreaterThan(1);
}

function validateBoundedInvariantStructure(boundedInvariant: QuintDeclaration): void {
	const boundedOpcodes = new Set(
		expressionTree(boundedInvariant.expr)
			.map(({ opcode }) => opcode)
			.filter((opcode) => opcode !== undefined)
	);
	expect(
		boundedOpcodes.has("ilt") || boundedOpcodes.has("ilte"),
		"boundedStateFinite must structurally compare state against a finite upper bound"
	).toBe(true);
}

function typeReferences(type: QuintType | undefined, typeName: string): boolean {
	if (type === undefined) {
		return false;
	}
	if (type.kind === "const" && type.name === typeName) {
		return true;
	}
	return (
		typeReferences(type.arg, typeName) ||
		(type.args ?? []).some((argument) => typeReferences(argument, typeName)) ||
		typeReferences(type.elem, typeName) ||
		(type.fields?.fields ?? []).some(({ fieldType }) => typeReferences(fieldType, typeName)) ||
		typeReferences(type.res, typeName)
	);
}

function recordFieldType(module: QuintModule, typeName: string, fieldName: string): QuintType {
	const field = typeDeclaration(module, typeName).type?.fields?.fields.find(
		(candidate) => candidate.fieldName === fieldName
	);
	expect(field, `${typeName} must structurally store ${fieldName}`).toBeDefined();
	return (field as { fieldType: QuintType }).fieldType;
}

function validateTypedAuthentication(module: QuintModule): string[] {
	const annotationLaundering = module.declarations
		.filter(
			(candidate) =>
				/AuthenticationDependencies$/u.test(candidate.name) ||
				candidate.name === "requiredSignedFields" ||
				candidate.name === "derivedSignedFields"
		)
		.map(({ name }) => name);
	expect(
		annotationLaundering,
		"signed-field derivation must not retain free-floating pureval dependency annotations"
	).toEqual([]);

	const fields = recordTypeFields(module, contract.modelStructure.signedVertexType);
	expect(fields, "SignedVertex AST must contain exactly the ten semantic signed fields").toEqual(
		[...contract.signedVertexFields].sort()
	);

	const predicate = declaration(module, contract.modelStructure.authenticationPredicate);
	expect(predicate.qualifier, "authentication must be a real pure predicate").toBe("puredef");
	expect(
		typedArguments(predicate),
		"authentication must compare two complete SignedVertex values, not selected scalar annotations"
	).toEqual([`const:${contract.modelStructure.signedVertexType}`, `const:${contract.modelStructure.signedVertexType}`]);
	expect(predicate.typeAnnotation?.res, "authentication over two SignedVertex values must return Bool").toMatchObject({
		kind: "bool",
	});
	const lambda = predicate.expr;
	expect(lambda, "authentication predicate must parse as a two-argument lambda").toMatchObject({
		kind: "lambda",
	});
	expect(lambda?.params, "authentication predicate must bind two typed vertices").toHaveLength(2);
	expect(lambda?.expr, "authentication must compare the bound full-record values").toMatchObject({
		kind: "app",
		opcode: "eq",
	});
	const comparedNames = (lambda?.expr?.args ?? [])
		.filter(({ kind }) => kind === "name")
		.map(({ name }) => name)
		.sort();
	expect(comparedNames, "authentication equality must compare both lambda-bound SignedVertex values").toEqual(
		(lambda?.params ?? []).map(({ name }) => name).sort()
	);

	for (const actionName of ["issueLocalSuccess", "admitRemote"]) {
		const action = declaration(module, actionName);
		expect(action.qualifier, `${actionName} must remain a real action`).toBe("action");
		expect(
			invokes(action.expr, contract.modelStructure.authenticationPredicate),
			`${actionName} must invoke full SignedVertex authentication`
		).toBe(true);
	}
	return fields;
}

function validateOperationIdentity(module: QuintModule): void {
	const identity = declaration(module, contract.modelStructure.operationIdentity);
	expect(identity.qualifier, "operation identity must be a real pure function").toBe("puredef");
	expect(typedArguments(identity), "operation identity must derive from an authenticated SignedVertex").toEqual([
		`const:${contract.modelStructure.signedVertexType}`,
	]);
	const operationFields = expressionTree(identity.expr).filter(
		({ args, kind, opcode }) =>
			kind === "app" && opcode === "field" && args?.[1]?.kind === "str" && args[1].value === "operation"
	);
	expect(operationFields, "equivocation identity must be explicitly derived from SignedVertex.operation").toHaveLength(
		1
	);
	expect(
		invokes(declaration(module, "detectEquivocation").expr, contract.modelStructure.operationIdentity),
		"equivocation detection must invoke the operation-derived identity"
	).toBe(true);
}

function validateStateSurfaces(module: QuintModule): void {
	const stateFields = recordTypeFields(module, contract.modelStructure.stateType);
	for (const fieldName of [
		contract.modelStructure.issuedRecordsField,
		contract.modelStructure.exposedRecordsField,
		contract.modelStructure.remoteDecisionField,
	]) {
		expect(stateFields, `ModelState must carry history-sensitive ${fieldName}`).toContain(fieldName);
	}
	for (const fieldName of [contract.modelStructure.issuedRecordsField, contract.modelStructure.exposedRecordsField]) {
		expect(
			typeReferences(
				recordFieldType(module, contract.modelStructure.stateType, fieldName),
				contract.modelStructure.signedVertexType
			),
			`${fieldName} must store typed SignedVertex material`
		).toBe(true);
	}
	expect(
		recordFieldType(module, contract.modelStructure.stateType, contract.modelStructure.remoteDecisionField),
		"remote decisions must be Boolean history state keyed by envelope identity"
	).toMatchObject({
		arg: { kind: "str" },
		kind: "fun",
		res: { kind: "bool" },
	});

	const localSuccess = declaration(module, "issueLocalSuccess");
	for (const fieldName of [contract.modelStructure.issuedRecordsField, contract.modelStructure.exposedRecordsField]) {
		expect(
			writesRecordField(localSuccess.expr, fieldName),
			`successful local issuance must update ${fieldName} with typed signed material`
		).toBe(true);
		expect(
			writesRecordField(declaration(module, "issueLocalFailure").expr, fieldName),
			`failed local issuance must not update ${fieldName}`
		).toBe(false);
	}
	expect(
		mentionsStringValue(localSuccess.expr, "authorSequence"),
		"successful local issuance must construct an authorSequence field in its signed record"
	).toBe(true);
	expect(
		referencesRecordField(localSuccess.expr, "localNextSequence"),
		"successful local issuance must select the current localNextSequence"
	).toBe(true);
	expect(
		writesRecordField(declaration(module, "admitRemote").expr, contract.modelStructure.remoteDecisionField),
		"remote admission must record the candidate's decision in history state"
	).toBe(true);
	expect(
		referencesRecordField(
			declaration(module, "validRemoteDecisionHistoryIndependent").expr,
			contract.modelStructure.remoteDecisionField
		),
		"history-independence must constrain the executable per-envelope decision state"
	).toBe(true);
	for (const fieldName of [contract.modelStructure.issuedRecordsField, contract.modelStructure.exposedRecordsField]) {
		expect(
			referencesRecordField(declaration(module, "localIssuedRecordsBindSelectedSequence").expr, fieldName),
			`local sequence binding must constrain ${fieldName}`
		).toBe(true);
	}

	for (const forbiddenCounter of [
		"invalidSignatureRejectionCount",
		"invalidSignatureAdmissionCount",
		"validRemoteRejectionCount",
		"validRemoteAttemptCount",
		"admittedRemoteCount",
		"duplicateRejectionCount",
		"gapRejectionCount",
		"currentPayloadIdentity",
		"payloadsBySequence",
	]) {
		expect(
			stateFields,
			`${forbiddenCounter} must not launder executable policy through a counter or payload ID`
		).not.toContain(forbiddenCounter);
	}

	const parsedIdentifiers = module.declarations.flatMap((candidate) => [
		candidate.name,
		...expressionTree(candidate.expr).flatMap(({ name, params, value }) => [
			...(name === undefined ? [] : [name]),
			...(params ?? []).map((parameter) => parameter.name),
			...(typeof value === "string" ? [value] : []),
		]),
	]);
	expect(
		parsedIdentifiers.some((identifier) => /payloadIdentity/iu.test(identifier)),
		"the parsed model must derive equivocation identity from authenticated operation, never payloadIdentity"
	).toBe(false);
}

function validateModelStructure(module: QuintModule): string[] {
	const declaredActions = module.declarations
		.filter(({ kind, qualifier }) => kind === "def" && qualifier === "action")
		.map(({ name }) => name);
	expect(declaredActions, "every required transition must be an actual parsed Quint action").toEqual(
		expect.arrayContaining(contract.requiredActions)
	);

	validateNondeterministicStep(declaration(module, contract.quint.stepAction));
	const signedFields = validateTypedAuthentication(module);
	validateOperationIdentity(module);
	validateStateSurfaces(module);

	for (const invariant of contract.quint.invariants) {
		declaration(module, invariant);
	}

	validateBoundedInvariantStructure(declaration(module, "boundedStateFinite"));
	return signedFields;
}

function authenticatesSignedVertex(signed: SignedVertexControl, candidate: SignedVertexControl): boolean {
	return contract.signedVertexFields.every(
		(field) => JSON.stringify(signed[field]) === JSON.stringify(candidate[field])
	);
}

function validateEquivocationObservations(observations: EquivocationObservation[]): void {
	const sequences = new Set(observations.map(({ authorSequence }) => authorSequence));
	expect(
		sequences.size,
		"generic equivocation detection must cover at least two bounded sequence slots"
	).toBeGreaterThanOrEqual(2);
	expect(
		[...sequences].some((sequence) => sequence !== 1),
		"equivocation evidence must not be specialized to sequence 1"
	).toBe(true);

	for (const observation of observations) {
		expect(
			new Set(observation.operations).size,
			"equivocation requires distinct authenticated operations at the same slot"
		).toBeGreaterThan(1);
		expect(observation.detected, "same object/author/sequence with different operations must be detected").toBe(true);
	}
}

function validateBoundedState(control: BoundedStateControl): void {
	const capNames = Object.keys(control.caps).sort();
	expect(capNames.length, "the finite-state control must bind multiple model dimensions").toBeGreaterThan(1);
	expect(
		Object.values(control.caps).every((cap) => Number.isSafeInteger(cap) && cap >= 0),
		"every model cap must be a finite non-negative safe integer"
	).toBe(true);
	expect(Object.keys(control.atCapacity.before).sort(), "the cap state must cover every bounded dimension").toEqual(
		capNames
	);
	expect(Object.keys(control.atCapacity.after).sort(), "the stutter state must cover every bounded dimension").toEqual(
		capNames
	);
	expect(control.atCapacity.before, "the cap fixture must actually be at every declared bound").toEqual(control.caps);
	expect(control.atCapacity.after, "a capped transition must stutter without counter growth").toEqual(
		control.atCapacity.before
	);
	expect(control.atCapacity.stuttered, "the bounded cap transition must be observable as stutter").toBe(true);
}

function validateDerivedSignedFields(derivation: SignedFieldDerivation, signedVertexFields: string[]): void {
	expect(derivation.inputs.registry, "Phase -1'a derivation must consume no registry-chosen field list").toEqual([]);
	expect(
		derivation.inputs.signedVertexType,
		"derivation input must be the actual parsed typed SignedVertex surface"
	).toEqual({
		fields: signedVertexFields,
		name: contract.modelStructure.signedVertexType,
	});
	expect(derivation.inputs.authenticationPredicate, "derivation must bind the real full-record predicate").toBe(
		contract.modelStructure.authenticationPredicate
	);
	expect(
		derivation.inputs.authenticatedActions,
		"derivation must bind both actions that invoke authentication"
	).toEqual(["issueLocalSuccess", "admitRemote"]);
	expect(
		derivation.derivedSignedFields,
		"signed fields must come directly from the parsed SignedVertex record"
	).toEqual(signedVertexFields);
	expect(new Set(derivation.derivedSignedFields).size, "the typed signed-field set must not contain duplicates").toBe(
		derivation.derivedSignedFields.length
	);
	expect(derivation.derivedSignedFields).toContain("authorSequence");
	expect(derivation.derivedSignedFields).toContain("operation");
}

function withoutAnsi(value: string): string {
	const escapeCharacter = String.fromCharCode(27);
	return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu"), "");
}

describe("Phase -1'a formal action-model RED controls", () => {
	it("preserves the local successful-lineage versus failed-attempt distinction", () => {
		validateLocalLineage(contract.controls.localLineage);

		const mutation = {
			...contract.controls.localLineage,
			attempts: contract.controls.localLineage.attempts.map((attempt, index) =>
				index === 2 ? { ...attempt, counterAfter: attempt.counterBefore + 1 } : attempt
			),
		};
		expect(() => validateLocalLineage(mutation)).toThrowError("a failed issue must not consume an ordinal");
		const bindingMutation = {
			...contract.controls.localLineage,
			attempts: contract.controls.localLineage.attempts.map((attempt, index) =>
				index === 1 && attempt.signedMaterial !== null
					? {
							...attempt,
							signedMaterial: {
								...attempt.signedMaterial,
								vertex: { ...attempt.signedMaterial.vertex, authorSequence: 2 },
							},
						}
					: attempt
			),
		};
		expect(() => validateLocalLineage(bindingMutation)).toThrowError(
			"embedded signed authorSequence must equal the selected current lineage ordinal"
		);
		const failedMaterialMutation = {
			...contract.controls.localLineage,
			attempts: contract.controls.localLineage.attempts.map((attempt, index) =>
				index === 2
					? {
							...attempt,
							signedMaterial: contract.controls.localLineage.attempts[1].signedMaterial,
						}
					: attempt
			),
		};
		expect(() => validateLocalLineage(failedMaterialMutation)).toThrowError(
			"a failed issue must add, store and expose no signed record"
		);
	});

	it("preserves arrival-independent remote admission while observing duplicates, gaps and equivocation", () => {
		validateRemotePolicy(contract.controls.remoteDeliveries);
		validateEquivocationObservations(contract.controls.equivocationObservations);

		const mutation = contract.controls.remoteDeliveries.map((delivery, deliveryIndex) => ({
			...delivery,
			events: delivery.events.map((event, eventIndex) =>
				deliveryIndex === 0 && eventIndex === 0 ? { ...event, admission: "reject" as const } : event
			),
		}));
		expect(() => validateRemotePolicy(mutation)).toThrowError(
			"remote gap observation must not become an admission rejection"
		);
		const duplicateRejectionMutation = contract.controls.remoteDeliveries.map((delivery, deliveryIndex) => ({
			...delivery,
			events: delivery.events.map((event) =>
				deliveryIndex === 0 && event.observation === "duplicate" ? { ...event, admission: "reject" as const } : event
			),
		}));
		expect(() => validateRemotePolicy(duplicateRejectionMutation)).toThrowError(
			"remote duplicate observation must not become an admission rejection"
		);
		const falseDuplicateMutation = contract.controls.remoteDeliveries.map((delivery, deliveryIndex) => ({
			...delivery,
			events: delivery.events.map((event) =>
				deliveryIndex === 0 && event.observation === "duplicate"
					? { ...event, operation: "different-operation" }
					: event
			),
		}));
		expect(() => validateRemotePolicy(falseDuplicateMutation)).toThrowError(
			"a duplicate must repeat the same authenticated operation at the same slot"
		);
		const falseEquivocationMutation = contract.controls.remoteDeliveries.map((delivery, deliveryIndex) => ({
			...delivery,
			events: delivery.events.map((event) =>
				deliveryIndex === 0 && event.envelopeId === "alice-1b" ? { ...event, operation: "operation-1a" } : event
			),
		}));
		expect(() => validateRemotePolicy(falseEquivocationMutation)).toThrowError(
			"equivocation must introduce a different authenticated operation at an occupied slot"
		);
		expect(() =>
			validateEquivocationObservations(
				contract.controls.equivocationObservations.map((observation, index) =>
					index === 1 ? { ...observation, detected: false } : observation
				)
			)
		).toThrowError("same object/author/sequence with different operations must be detected");
		expect(() => validateEquivocationObservations([contract.controls.equivocationObservations[0]])).toThrowError(
			"generic equivocation detection must cover at least two bounded sequence slots"
		);
	});

	it("kills every one-field authentication mutation and typed-derivation omission", () => {
		const signed = contract.controls.authentication.signedVertex;
		expect(authenticatesSignedVertex(signed, signed), "the unmodified signed vertex must authenticate").toBe(true);
		expect(Object.keys(contract.controls.authentication.fieldMutations).sort()).toEqual(
			[...contract.signedVertexFields].sort()
		);
		for (const field of contract.signedVertexFields) {
			const candidate = {
				...signed,
				[field]: contract.controls.authentication.fieldMutations[field],
			} as SignedVertexControl;
			expect(
				authenticatesSignedVertex(signed, candidate),
				`one-field ${field} mutation must fail full-record authentication`
			).toBe(false);
		}

		const typedFields = [...contract.signedVertexFields].sort();
		const validDerivation: SignedFieldDerivation = {
			algorithm: "signed-vertex-type-auth-action-usage-v1",
			derivedSignedFields: typedFields,
			inputs: {
				authenticatedActions: ["issueLocalSuccess", "admitRemote"],
				authenticationPredicate: contract.modelStructure.authenticationPredicate,
				model: { path: modelPath, sha256: "0".repeat(64) },
				registry: [],
				signedVertexType: {
					fields: typedFields,
					name: contract.modelStructure.signedVertexType,
				},
			},
			protocolMajor: 3,
			schemaVersion: "phase-n1prime-a-signed-field-derivation-v2",
		};
		validateDerivedSignedFields(validDerivation, typedFields);
		const missingOperationMutation: SignedFieldDerivation = {
			...validDerivation,
			derivedSignedFields: typedFields.filter((field) => field !== "operation"),
		};
		expect(() => validateDerivedSignedFields(missingOperationMutation, typedFields)).toThrowError(
			"signed fields must come directly from the parsed SignedVertex record"
		);
	});

	it("preserves finite caps and kills counter-growth instead of accepting an unbounded model", () => {
		validateBoundedState(contract.controls.boundedState);
		const growthMutation: BoundedStateControl = {
			...contract.controls.boundedState,
			atCapacity: {
				...contract.controls.boundedState.atCapacity,
				after: {
					...contract.controls.boundedState.atCapacity.after,
					failureAttemptCount: contract.controls.boundedState.atCapacity.after.failureAttemptCount + 1,
				},
			},
		};
		expect(() => validateBoundedState(growthMutation)).toThrowError(
			"a capped transition must stutter without counter growth"
		);

		const nondeterministicStep: QuintDeclaration = {
			kind: "def",
			name: contract.quint.stepAction,
			qualifier: "action",
			expr: {
				kind: "app",
				opcode: "actionAny",
				args: [
					{ kind: "name", name: "issueLocalSuccess" },
					{ kind: "name", name: "observeRemote" },
				],
			},
		};
		validateNondeterministicStep(nondeterministicStep);
		expect(() =>
			validateNondeterministicStep({
				...nondeterministicStep,
				expr: { kind: "app", opcode: "ite", args: nondeterministicStep.expr?.args },
			})
		).toThrowError("step must be a top-level nondeterministic action choice");

		const boundedInvariant: QuintDeclaration = {
			kind: "def",
			name: "boundedStateFinite",
			qualifier: "val",
			expr: { kind: "app", opcode: "ilte", args: [] },
		};
		validateBoundedInvariantStructure(boundedInvariant);
		expect(() =>
			validateBoundedInvariantStructure({
				...boundedInvariant,
				expr: { kind: "app", opcode: "eq", args: [] },
			})
		).toThrowError("boundedStateFinite must structurally compare state against a finite upper bound");
	});
});

describe("Phase -1'a v3 formal action/invariant artifacts", () => {
	it("requires the v3 Quint action/invariant model to exist", () => {
		expect(
			modelExists,
			`Phase -1'a RED: missing ${modelPath}; GREEN must model local issuance, admission, observation and equivocation detection before registry bytes`
		).toBe(true);
	});

	it("requires the mechanically derived signed-field contract to exist", () => {
		expect(
			derivationExists,
			`Phase -1'a RED: missing ${derivationPath}; GREEN must derive signed fields from the parsed typed SignedVertex used by authentication actions, with no registry input`
		).toBe(true);
	});

	it.runIf(greenArtifactsExist)(
		"typechecks and executes every pinned Quint scenario and invariant",
		() => {
			const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", modelPath], {
				cwd: repositoryRoot,
				encoding: "utf8",
			});
			expect(
				typecheck.status,
				`the v3 action/invariant model must typecheck\n${typecheck.stdout}\n${typecheck.stderr}`
			).toBe(0);

			const quintTests = spawnSync(
				"pnpm",
				[
					"exec",
					"quint",
					"test",
					modelPath,
					"--main",
					contract.quint.module,
					"--seed",
					contract.quint.seed,
					"--max-samples",
					String(contract.quint.maxSamples),
					"--match",
					"^test",
					"--backend",
					"typescript",
				],
				{ cwd: repositoryRoot, encoding: "utf8" }
			);
			const testOutput = withoutAnsi(`${quintTests.stdout}\n${quintTests.stderr}`);
			expect(quintTests.status, `the pinned Quint scenario tests must pass\n${testOutput}`).toBe(0);
			for (const scenarioTest of contract.quint.scenarioTests) {
				expect
					.soft(testOutput, `the Quint run must execute, not merely declare, ${scenarioTest}`)
					.toContain(`ok ${scenarioTest} passed`);
			}

			const simulation = spawnSync(
				"pnpm",
				[
					"exec",
					"quint",
					"run",
					modelPath,
					"--main",
					contract.quint.module,
					"--step",
					contract.quint.stepAction,
					"--seed",
					contract.quint.seed,
					"--max-samples",
					String(contract.quint.maxSamples),
					"--max-steps",
					String(contract.quint.maxSteps),
					"--backend",
					"typescript",
					"--invariants",
					...contract.quint.invariants,
					"--witnesses",
					...contract.quint.witnesses,
					"--verbosity",
					"1",
				],
				{ cwd: repositoryRoot, encoding: "utf8" }
			);
			const simulationOutput = withoutAnsi(`${simulation.stdout}\n${simulation.stderr}`);
			expect(simulation.status, `the pinned Quint invariant simulation must pass\n${simulationOutput}`).toBe(0);
			for (const witness of contract.quint.witnesses) {
				expect(
					simulationOutput,
					`the simulation must reach ${witness}; a never-exercised invariant is not evidence`
				).toMatch(new RegExp(`${witness} was witnessed in [1-9][0-9]* trace`));
			}
		},
		120_000
	);

	it.runIf(greenArtifactsExist)(
		"derives the signed-field set mechanically from the typed authenticated SignedVertex",
		() => {
			const derivation = readJson<SignedFieldDerivation>(derivationPath);
			const module = parseQuintModule();
			const signedVertexFields = validateModelStructure(module);

			expect(derivation).toMatchObject({
				algorithm: "signed-vertex-type-auth-action-usage-v1",
				protocolMajor: contract.protocolMajor,
				schemaVersion: "phase-n1prime-a-signed-field-derivation-v2",
				inputs: {
					authenticatedActions: ["issueLocalSuccess", "admitRemote"],
					authenticationPredicate: contract.modelStructure.authenticationPredicate,
					model: {
						path: modelPath,
						sha256: sha256(modelPath),
					},
					registry: [],
					signedVertexType: {
						fields: signedVertexFields,
						name: contract.modelStructure.signedVertexType,
					},
				},
			});
			validateDerivedSignedFields(derivation, signedVertexFields);
		},
		120_000
	);
});
