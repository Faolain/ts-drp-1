import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import type {
	DurableIssuanceOutboxRecord,
	DurableIssuanceStore,
	DurableIssueCommit,
	DurableIssueScope,
} from "@ts-drp/issuance-store";
import type { DurableLiveJournalStore, LiveJournalAcceptedRow, LiveJournalScope } from "@ts-drp/live-journal";
import { MessageQueueManager } from "@ts-drp/message-queue";
import type { DRPNetworkNode, Message as MessageShape } from "@ts-drp/types";
import { Message, MessageType } from "@ts-drp/types";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	const originalWarn = console.warn;
	vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
		if (values[0] !== "::v3-ingress") Reflect.apply(originalWarn, console, values);
	});
});

import {
	createGenuinePreparedV3Fixture,
	type GenuinePreparedV3Fixture,
	type PrepareV3LiveGenerationForFixture,
} from "./fixtures/phase-3a1b-p3/live-fixture.js";
import {
	ACTIVATION_FAILURE_KINDS,
	ACTIVATION_ORDER,
	EGRESS_FAILURE_KINDS,
	EGRESS_ORDER,
	INGRESS_ORDER,
	SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS,
	type Seam3PrivateSurface,
	type V3PlaneActivationInputContract,
	type V3PlaneActivationResultContract,
} from "./fixtures/phase-3a1b-p3/seam3-contract.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIVE_OWNER = path.join(ROOT, "packages/node/src/v3-live.ts");

function source(relative: string): string {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function productionSources(): readonly Readonly<{ path: string; text: string }>[] {
	const results: Array<Readonly<{ path: string; text: string }>> = [];
	const walk = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(absolute);
			} else if (entry.isFile() && /\.(?:mts|ts)$/u.test(entry.name)) {
				results.push(Object.freeze({ path: path.relative(ROOT, absolute), text: fs.readFileSync(absolute, "utf8") }));
			}
		}
	};
	for (const packageEntry of fs.readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })) {
		const sourceRoot = path.join(ROOT, "packages", packageEntry.name, "src");
		if (packageEntry.isDirectory() && fs.existsSync(sourceRoot)) walk(sourceRoot);
	}
	return Object.freeze(results);
}

function topicCensusSources(): readonly Readonly<{ path: string; text: string }>[] {
	const results = [...productionSources()];
	const walk = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(absolute);
			} else if (entry.isFile() && /\.(?:cts|mts|tsx?|ts)$/u.test(entry.name)) {
				results.push(Object.freeze({ path: path.relative(ROOT, absolute), text: fs.readFileSync(absolute, "utf8") }));
			}
		}
	};
	for (const exampleEntry of fs.readdirSync(path.join(ROOT, "examples"), { withFileTypes: true })) {
		const sourceRoot = path.join(ROOT, "examples", exampleEntry.name, "src");
		if (exampleEntry.isDirectory() && fs.existsSync(sourceRoot)) walk(sourceRoot);
	}
	return Object.freeze(results);
}

function resolvesToSource(importer: string, specifier: string, expected: string): boolean {
	const selected = specifier.replace(/[?#].*$/u, "");
	let unresolved: string;
	if (selected.startsWith(".")) {
		unresolved = path.resolve(ROOT, path.dirname(importer), selected);
	} else {
		const workspace = /^@ts-drp\/([^/]+)(?:\/(.+))?$/u.exec(selected);
		if (workspace === null) return false;
		const subpath = (workspace[2] ?? "index").replace(/^src\//u, "");
		unresolved = path.resolve(ROOT, "packages", workspace[1] as string, "src", subpath);
	}
	const candidates = [
		unresolved,
		unresolved.replace(/\.js$/u, ".ts"),
		unresolved.replace(/\.mjs$/u, ".mts"),
		unresolved.replace(/\.cjs$/u, ".cts"),
		`${unresolved}.ts`,
		`${unresolved}.mts`,
		`${unresolved}.cts`,
		path.join(unresolved, "index.ts"),
	];
	return candidates.some((candidate) => path.normalize(candidate) === path.normalize(expected));
}

const GENERATED_MESSAGE_MODULE = "./proto/drp/v1/messages_pb.js";

function isPrivateGeneratedSpecifier(specifier: string): boolean {
	return (
		specifier === GENERATED_MESSAGE_MODULE ||
		/(?:^@ts-drp\/types\/|packages\/types\/src\/proto|\.\.\/types\/src\/proto|proto\/drp\/v1\/messages_pb)/u.test(
			specifier
		)
	);
}

function privateGeneratedReferenceViolations(
	relativePath: string,
	sourceText: string
): readonly Readonly<{ kind: string; specifier: string }>[] {
	const unit = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const violations: Array<Readonly<{ kind: string; specifier: string }>> = [];
	const expectedNames = [...SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS].sort();
	const preSeam3Names = expectedNames.filter((name) => name !== "V3Envelope");
	const allowRootExport = (node: ts.ExportDeclaration, specifier: string): boolean => {
		if (
			relativePath !== "packages/types/src/index.ts" ||
			node.parent !== unit ||
			specifier !== GENERATED_MESSAGE_MODULE ||
			node.exportClause === undefined ||
			!ts.isNamedExports(node.exportClause) ||
			node.exportClause.elements.some((element) => element.propertyName !== undefined)
		) {
			return false;
		}
		const names = node.exportClause.elements.map((element) => element.name.text).sort();
		return (
			JSON.stringify(names) === JSON.stringify(preSeam3Names) || JSON.stringify(names) === JSON.stringify(expectedNames)
		);
	};
	const allowExistingTypesNetworkImport = (node: ts.Node, specifier: string): boolean => {
		if (
			relativePath !== "packages/types/src/network.ts" ||
			specifier !== GENERATED_MESSAGE_MODULE ||
			!ts.isImportDeclaration(node) ||
			node.importClause?.name !== undefined ||
			node.importClause?.isTypeOnly === true ||
			node.importClause?.namedBindings === undefined ||
			!ts.isNamedImports(node.importClause.namedBindings)
		) {
			return false;
		}
		const bindings = node.importClause.namedBindings.elements;
		return (
			bindings.length === 1 &&
			bindings[0]?.isTypeOnly === true &&
			bindings[0].propertyName === undefined &&
			bindings[0].name.text === "Message"
		);
	};
	const visit = (node: ts.Node): void => {
		let specifier: string | undefined;
		let kind = ts.SyntaxKind[node.kind] ?? "unknown";
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifier = node.moduleSpecifier.text;
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0] as ts.Expression)
		) {
			specifier = (node.arguments[0] as ts.StringLiteral).text;
			kind = "dynamic-import";
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		) {
			specifier = node.argument.literal.text;
			kind = "import-type";
		}
		if (specifier !== undefined && isPrivateGeneratedSpecifier(specifier)) {
			if (
				!(ts.isExportDeclaration(node) && allowRootExport(node, specifier)) &&
				!allowExistingTypesNetworkImport(node, specifier)
			) {
				violations.push(Object.freeze({ kind, specifier }));
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(unit);
	return Object.freeze(violations);
}

async function privateSurface(): Promise<Seam3PrivateSurface> {
	return import("../packages/node/src/v3-live.js") as Promise<Seam3PrivateSurface>;
}

function lowerHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactNodeIssuanceImporterCount(importerText: string): number {
	return (
		importerText.match(
			/(?:^|\n)\s+(['"]?)@ts-drp\/issuance-store\1:\s*\n\s+specifier:\s*0\.11\.0\s*\n\s+version:\s*link:\.\.\/issuance-store[\t ]*(?=\n|$)/gu
		)?.length ?? 0
	);
}

function nodeBoundaryViolations(manifestText: string, importerText: string): readonly string[] {
	const violations: string[] = [];
	let manifest: {
		dependencies?: Record<string, unknown>;
		exports?: Record<string, unknown>;
	};
	try {
		manifest = JSON.parse(manifestText) as typeof manifest;
	} catch {
		return Object.freeze(["manifest-json"]);
	}
	if (manifest.dependencies?.["@ts-drp/issuance-store"] !== "0.11.0") violations.push("issuance-dependency");
	if (manifest.dependencies?.["@ts-drp/live-journal"] !== "0.11.0") violations.push("journal-dependency");
	if (
		JSON.stringify(manifest.exports) !==
		JSON.stringify({
			".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" },
			"./runtime": { types: "./dist/src/runtime.d.ts", import: "./dist/src/runtime.js" },
			"./v3-live": { types: "./dist/src/v3-live.d.ts", import: "./dist/src/v3-live.js" },
		})
	) {
		violations.push("export-targets");
	}
	if (exactNodeIssuanceImporterCount(importerText) !== 1) {
		violations.push("issuance-importer");
	}
	return Object.freeze(violations);
}

function exactTopic(objectId: string, genesisAnchorDigest: string): string {
	const utf8 = new TextEncoder();
	return `drp/v3/1/${lowerHex(
		hashDomain("ts-drp/live-topic/v3", utf8.encode(objectId), utf8.encode(genesisAnchorDigest))
	)}`;
}

function topLevelFunction(sourceText: string, name: string): ts.FunctionDeclaration | undefined {
	const unit = ts.createSourceFile("v3-live.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	return unit.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === name
	);
}

function functionText(sourceText: string, name: string): string {
	const declaration = topLevelFunction(sourceText, name);
	if (declaration === undefined) return "";
	return sourceText.slice(declaration.getStart(), declaration.end);
}

function descendantIdentifierNames(node: ts.Node): readonly string[] {
	const names: string[] = [];
	const visit = (candidate: ts.Node): void => {
		if (ts.isIdentifier(candidate)) names.push(candidate.text);
		ts.forEachChild(candidate, visit);
	};
	visit(node);
	return Object.freeze(names);
}

function activationOrderingEvidence(sourceText: string): Readonly<{
	consumeCount: number;
	consumePosition: number;
	directInputAfterConsume: number;
	firstEffect: number;
	outerCapturedKeys: readonly string[];
	recoveredReferencesAfterConsume: number;
}> {
	const declaration = topLevelFunction(sourceText, "activateV3LivePlane");
	if (declaration?.body === undefined) {
		return Object.freeze({
			consumeCount: 0,
			consumePosition: -1,
			directInputAfterConsume: 0,
			firstEffect: -1,
			outerCapturedKeys: [],
			recoveredReferencesAfterConsume: 0,
		});
	}
	const consumeCalls: ts.CallExpression[] = [];
	const effectCalls: ts.CallExpression[] = [];
	const visitCalls = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			if (ts.isIdentifier(node.expression) && node.expression.text === "consumeRecoveredV3Live") {
				consumeCalls.push(node);
			}
			if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "subscribe") {
				effectCalls.push(node);
			}
		}
		ts.forEachChild(node, visitCalls);
	};
	visitCalls(declaration.body);
	const consume = consumeCalls[0];
	const consumePosition = consume?.getStart() ?? Number.MAX_SAFE_INTEGER;
	const captured = new Set<string>();
	let directInputAfterConsume = 0;
	let recoveredBinding: string | undefined;
	if (consume !== undefined && ts.isVariableDeclaration(consume.parent) && ts.isIdentifier(consume.parent.name)) {
		recoveredBinding = consume.parent.name.text;
	}
	let recoveredReferencesAfterConsume = 0;
	const visitEvidence = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "input") {
			if (node.getStart() < consumePosition) captured.add(node.name.text);
			else directInputAfterConsume += 1;
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.initializer) &&
			node.initializer.text === "input" &&
			ts.isObjectBindingPattern(node.name) &&
			node.getStart() < consumePosition
		) {
			for (const element of node.name.elements) {
				if (ts.isIdentifier(element.name)) captured.add((element.propertyName ?? element.name).getText());
			}
		}
		if (
			recoveredBinding !== undefined &&
			ts.isIdentifier(node) &&
			node.text === recoveredBinding &&
			node.getStart() > consumePosition
		) {
			recoveredReferencesAfterConsume += 1;
		}
		ts.forEachChild(node, visitEvidence);
	};
	visitEvidence(declaration.body);
	return Object.freeze({
		consumeCount: consumeCalls.length,
		consumePosition: consume === undefined ? -1 : consumePosition,
		directInputAfterConsume,
		firstEffect: effectCalls.length === 0 ? -1 : Math.min(...effectCalls.map((call) => call.getStart())),
		outerCapturedKeys: Object.freeze([...captured].sort()),
		recoveredReferencesAfterConsume,
	});
}

function exportedNames(sourceText: string): readonly string[] {
	const unit = ts.createSourceFile("v3-live.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names: string[] = [];
	for (const statement of unit.statements) {
		if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause !== undefined &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const element of statement.exportClause.elements) names.push(element.name.text);
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement)) &&
			statement.name !== undefined &&
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
		) {
			names.push(statement.name.text);
		}
	}
	return names.sort();
}

function count(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

function fakeNetwork(
	started = true,
	publish: (topic: string, message: MessageShape) => Promise<unknown> = () => Promise.resolve(true)
): DRPNetworkNode {
	const topics = new Set<string>();
	const network = {
		peerId: started ? "peer:seam3" : "",
		membershipVerifier: undefined,
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
		restart: vi.fn(() => Promise.resolve()),
		isDialable: vi.fn(() => Promise.resolve(true)),
		changeTopicScoreParams: vi.fn(),
		removeTopicScoreParams: vi.fn(),
		subscribe: vi.fn((topic: string) => topics.add(topic)),
		unsubscribe: vi.fn((topic: string) => topics.delete(topic)),
		connectToBootstraps: vi.fn(() => Promise.resolve()),
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		getPeerMultiaddrs: vi.fn(() => Promise.resolve([])),
		getBootstrapNodes: vi.fn(() => []),
		getSubscribedTopics: vi.fn(() => [...topics]),
		getMultiaddrs: vi.fn(() => (started ? ["/ip4/127.0.0.1/tcp/1"] : undefined)),
		getAllPeers: vi.fn(() => []),
		getGroupPeers: vi.fn(() => []),
		broadcastMessage: vi.fn(() => Promise.resolve()),
		sendMessage: vi.fn(() => Promise.resolve()),
		sendMessageToRandomPeer: vi.fn(() => Promise.resolve()),
		sendGroupMessage: vi.fn(() => Promise.resolve()),
		subscribeToMessageQueue: vi.fn(),
		onGroupPeerChange: vi.fn((): (() => void) => () => undefined),
	} as unknown as DRPNetworkNode;
	Reflect.set(network, "publishMessage", vi.fn(publish));
	Reflect.set(
		network,
		"gossipTopicFor",
		vi.fn(() => undefined)
	);
	return network;
}

function fakeIssuanceStore(overrides: Partial<DurableIssuanceStore> = {}): DurableIssuanceStore {
	return {
		transactIssue: vi.fn(() => Promise.reject(new Error("unused"))),
		compareAndMarkOutboxPublished: vi.fn(() => Promise.resolve()),
		readIssued: vi.fn(() => Promise.resolve(null)),
		readOutboxPage: vi.fn(() => Promise.resolve([])),
		readLineage: vi.fn(() => Promise.resolve({ exhausted: false, next: 0 })),
		close: vi.fn(() => Promise.resolve()),
		...overrides,
	};
}

const activationJournalStores = new WeakMap<object, DurableLiveJournalStore>();

interface SignedScopeCarrier {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

class RecoveryAttemptError extends TypeError {
	readonly kind: string;

	constructor(kind: string) {
		super(`v3 recovery failed with ${kind}`);
		this.kind = kind;
	}
}

async function createSignedScopeCarrier(
	fixture: GenuinePreparedV3Fixture,
	input: Readonly<{
		readonly authorSequence: number;
		readonly dependencies: readonly string[];
		readonly epoch?: number;
		readonly objectId?: string;
	}>
): Promise<SignedScopeCarrier> {
	const canonicalPreimageBytes = encodeCanonical({
		anchor: fixture.descriptor.anchorDigest,
		author: fixture.author,
		authorSequence: input.authorSequence,
		dependencies: [...input.dependencies],
		epoch: input.epoch ?? fixture.descriptor.epoch,
		kind: "drp-vertex",
		logicalTime: input.authorSequence + 1,
		objectId: input.objectId ?? fixture.descriptor.objectId,
		operation: { action: "add", value: 1 },
		protocolMajor: 3,
	});
	const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	return Object.freeze({
		canonicalPreimageBytes,
		digest,
		signature: await fixture.signRegisteredVertexDigest(digest),
	});
}

function receivedJournalRow(
	fixture: GenuinePreparedV3Fixture,
	carrier: SignedScopeCarrier,
	journalSequence = 0
): LiveJournalAcceptedRow {
	return Object.freeze({
		detachedSignature: new Uint8Array(carrier.signature),
		exactCanonicalPreimageBytes: new Uint8Array(carrier.canonicalPreimageBytes),
		journalSequence,
		scope: Object.freeze({
			anchorDigest: fixture.descriptor.anchorDigest,
			epoch: 0 as const,
			objectId: fixture.descriptor.objectId,
		}),
		sourceKind: "received" as const,
		vertexDigest: lowerHex(carrier.digest),
	});
}

function journalStoreForFixture(
	fixture: GenuinePreparedV3Fixture,
	rows: readonly LiveJournalAcceptedRow[] = Object.freeze([])
): DurableLiveJournalStore {
	const journalScope: LiveJournalScope = Object.freeze({
		anchorDigest: fixture.descriptor.anchorDigest,
		epoch: 0,
		objectId: fixture.descriptor.objectId,
	});
	const snapshot = Object.freeze({
		kind: "v3-live-journal-snapshot-token-1" as const,
		scope: journalScope,
		highWatermark: Math.max(0, rows.length - 1),
		genesisDigest: "1".repeat(64),
		parametersDigest: fixture.descriptor.parametersDigest,
		orderedRowDigest: "2".repeat(64),
		snapshotDigest: "3".repeat(64),
	});
	return Object.freeze({
		installGenesis: vi.fn(() =>
			Promise.resolve(
				Object.freeze({
					ok: true as const,
					scope: journalScope,
					parametersDigest: fixture.descriptor.parametersDigest,
					idempotent: false,
				})
			)
		),
		readiness: vi.fn(() =>
			Promise.resolve(
				Object.freeze({ ok: true as const, ready: true as const, scope: journalScope, snapshot, rowCount: rows.length })
			)
		),
		readPage: vi.fn((input) => {
			const index = input.afterSequence == null ? 0 : input.afterSequence + 1;
			const pageRows = index < rows.length ? Object.freeze([rows[index] as LiveJournalAcceptedRow]) : Object.freeze([]);
			return Promise.resolve(
				Object.freeze({
					ok: true as const,
					scope: journalScope,
					snapshot,
					rows: pageRows,
					nextSequence: index + 1 < rows.length ? index : null,
				})
			);
		}),
		appendAccepted: vi.fn((input) =>
			Promise.resolve(
				Object.freeze({
					ok: true as const,
					scope: journalScope,
					journalSequence: rows.length,
					vertexDigest: input.vertexDigest,
					sourceKind: input.sourceKind,
					idempotent: false,
				})
			)
		),
		close: vi.fn(() => Promise.resolve()),
	});
}

async function recoverActivationCapability(
	surface: Seam3PrivateSurface,
	fixture: GenuinePreparedV3Fixture,
	preparedCapability: object,
	activationStore: DurableIssuanceStore = fakeIssuanceStore(),
	journalRows: readonly LiveJournalAcceptedRow[] = Object.freeze([])
): Promise<Readonly<{ capability: object; recoveryDigest: string; scope: DurableIssueScope }>> {
	if (surface.recoverV3LiveReplica === undefined) throw new TypeError("missing recoverV3LiveReplica");
	const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
	const carrier = fixture.createRecoveryVertex(0, [fixture.descriptor.anchorDigest]);
	const envelope = Object.freeze({
		canonicalPreimageBytes: new Uint8Array(carrier.canonicalPreimageBytes),
		digest: new Uint8Array(carrier.digest),
		signature: new Uint8Array(carrier.signature),
	});
	const recoveryCommit: DurableIssueCommit = Object.freeze({
		authorSequence: 0,
		envelope,
		issuedRecord: Object.freeze({ authorSequence: 0, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence: 0, envelope, scope }),
	});
	const mutableStore = activationStore as {
		readIssued: DurableIssuanceStore["readIssued"];
		readOutboxPage: DurableIssuanceStore["readOutboxPage"];
	};
	const originalReadIssued = mutableStore.readIssued;
	const originalReadOutboxPage = mutableStore.readOutboxPage;
	mutableStore.readIssued = (selectedScope, authorSequence): Promise<DurableIssueCommit | null> =>
		Promise.resolve(
			journalRows.length === 0 &&
				selectedScope.objectId === scope.objectId &&
				selectedScope.author === scope.author &&
				authorSequence === 0
				? recoveryCommit
				: null
		);
	mutableStore.readOutboxPage = (input = {}): Promise<readonly DurableIssuanceOutboxRecord[]> =>
		Promise.resolve(
			journalRows.length === 0 && input.afterKey == null
				? Object.freeze([Object.freeze({ commit: recoveryCommit, publishState: "published" as const })])
				: Object.freeze([])
		);
	const journalStore: DurableLiveJournalStore =
		activationJournalStores.get(activationStore as object) ?? journalStoreForFixture(fixture, journalRows);
	activationJournalStores.set(activationStore as object, journalStore);
	let recovered: Awaited<ReturnType<NonNullable<Seam3PrivateSurface["recoverV3LiveReplica"]>>>;
	try {
		recovered = await surface.recoverV3LiveReplica({
			capability: preparedCapability,
			...(fixture.exactCanonicalLatchedAclBytes === undefined
				? { exactCanonicalAuthorAuthorizationBytes: fixture.exactCanonicalAuthorAuthorizationBytes }
				: { exactCanonicalLatchedAclBytes: fixture.exactCanonicalLatchedAclBytes }),
			issuanceScope: scope,
			issuanceStore: activationStore,
			liveJournalStore: journalStore,
		});
	} finally {
		mutableStore.readIssued = originalReadIssued;
		mutableStore.readOutboxPage = originalReadOutboxPage;
	}
	if (!recovered.ok) throw new RecoveryAttemptError(recovered.kind);
	return Object.freeze({
		capability: recovered.capability,
		recoveryDigest: Array.from(carrier.digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
		scope,
	});
}

function outboxRecord(
	scope: DurableIssueScope,
	authorSequence: number,
	publishState: "pending" | "published"
): DurableIssuanceOutboxRecord {
	const canonicalPreimageBytes = encodeCanonical({
		author: scope.author,
		authorSequence,
		objectId: scope.objectId,
	});
	const envelope = Object.freeze({
		canonicalPreimageBytes,
		digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
		signature: Uint8Array.of(authorSequence, 3),
	});
	const issuedRecord = Object.freeze({ authorSequence, envelope, scope: Object.freeze({ ...scope }) });
	const outboxEntry = Object.freeze({ authorSequence, envelope, scope: Object.freeze({ ...scope }) });
	return Object.freeze({
		commit: Object.freeze({ authorSequence, envelope, issuedRecord, outboxEntry }),
		publishState,
	});
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void }> {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return Object.freeze({ promise, resolve: resolvePromise, reject: rejectPromise });
}

function forgedInput(overrides: Readonly<Record<string, unknown>> = {}): V3PlaneActivationInputContract {
	return {
		capability: Object.freeze({ counterfeit: true }),
		messageQueueManager: new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } }),
		networkNode: fakeNetwork(),
		onAdmittedVertex: vi.fn(),
		...overrides,
	} as V3PlaneActivationInputContract;
}

function expectClosedFrozenActivationFailure(
	result: V3PlaneActivationResultContract,
	kind: (typeof ACTIVATION_FAILURE_KINDS)[number]
): void {
	expect(result).toEqual({ ok: false, kind, detail: expect.any(String) });
	expect(Reflect.ownKeys(result).sort()).toEqual(["detail", "kind", "ok"]);
	expect(Object.isFrozen(result)).toBe(true);
}

describe("Phase 3a-1B Seam 3 private live-plane RED", () => {
	it("adds only the exact private activation, ingress, handle and error surface", async () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		expect(exportedNames(liveSource)).toEqual([
			"PrepareV3LiveFailureKind",
			"PrepareV3LiveGenerationInput",
			"PrepareV3LiveResult",
			"PreparedV3Live",
			"RecoverV3LiveReplicaFailureKind",
			"RecoverV3LiveReplicaInput",
			"RecoverV3LiveReplicaResult",
			"RecoveredV3Live",
			"V3AdmittedVertexSink",
			"V3EgressResult",
			"V3LiveDescriptor",
			"V3LocalIssueInput",
			"V3LocalIssueResult",
			"V3PlaneActivationFailureKind",
			"V3PlaneActivationInput",
			"V3PlaneActivationResult",
			"V3PlaneHandle",
			"V3TerminalPublishResult",
			"V3TerminalTransitionResult",
			"V3TerminalVertexClassifier",
			"activateV3LivePlane",
			"bindV3BlueprintLivePlane",
			"prepareV3LiveGeneration",
			"recoverV3LiveReplica",
			"republishV3RetainedTo",
			"routeV3Ingress",
			"routeV3RetainedIngress",
		]);
		const surface = await privateSurface();
		expect(Object.keys(surface).sort()).toEqual([
			"activateV3LivePlane",
			"bindV3BlueprintLivePlane",
			"prepareV3LiveGeneration",
			"recoverV3LiveReplica",
			"republishV3RetainedTo",
			"routeV3Ingress",
			"routeV3RetainedIngress",
		]);
		expect(ACTIVATION_FAILURE_KINDS).toEqual([
			"malformed-input",
			"capability-consumed",
			"not-started",
			"topic-derivation-failed",
			"queue-capacity",
			"subscribe-failed",
			"internal-invariant",
		]);
		expect(EGRESS_FAILURE_KINDS).toEqual([
			"not-active",
			"store-failed",
			"record-rejected",
			"publish-failed",
			"publication-state-unknown",
		]);
	});

	it("captures malformed outer input without consuming, then burns a genuine recovered token", async () => {
		const surface = await privateSurface();
		if (surface.activateV3LivePlane === undefined) throw new TypeError("missing activateV3LivePlane");
		const effects: string[] = [];
		const malformed = forgedInput({ extra: true });
		const malformedResult = surface.activateV3LivePlane(malformed);
		expect(malformedResult).toEqual({ ok: false, kind: "malformed-input", detail: expect.any(String) });

		const forged = forgedInput({
			messageQueueManager: {
				hasQueue: (): boolean => false,
				subscribe: (): void => effects.push("queue.subscribe"),
				close: (): void => effects.push("queue.close"),
			},
		});
		expect(surface.activateV3LivePlane(forged)).toEqual({
			ok: false,
			kind: "capability-consumed",
			detail: expect.any(String),
		});
		expect(effects).toEqual([]);

		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const queueSubscribe = vi.spyOn(queue, "subscribe");
			const network = fakeNetwork();
			const networkSubscribe = Reflect.get(network, "subscribe") as ReturnType<typeof vi.fn>;
			const recovered = await recoverActivationCapability(surface, fixture, fixture.capability);
			const base = forgedInput({
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
			});
			expect(surface.activateV3LivePlane({ ...base, extra: true } as V3PlaneActivationInputContract)).toEqual({
				ok: false,
				kind: "malformed-input",
				detail: expect.any(String),
			});
			const activated = surface.activateV3LivePlane(base);
			expect(activated).toEqual({ ok: true, handle: expect.any(Object) });
			expect(queueSubscribe).toHaveBeenCalledTimes(1);
			expect(networkSubscribe).toHaveBeenCalledTimes(1);
			expect(surface.activateV3LivePlane(base)).toEqual({
				ok: false,
				kind: "capability-consumed",
				detail: expect.any(String),
			});
			if (activated.ok) activated.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("rejects every hostile outer-record shape without invocation or authority and returns fresh frozen failures", async () => {
		const surface = await privateSurface();
		if (surface.activateV3LivePlane === undefined) throw new TypeError("missing activateV3LivePlane");
		const base = forgedInput();
		const accessorCalls = vi.fn();
		const accessor = Object.create(null) as Record<PropertyKey, unknown>;
		for (const key of Reflect.ownKeys(base)) {
			if (key === "capability") {
				Object.defineProperty(accessor, key, {
					configurable: true,
					enumerable: true,
					get: (): unknown => {
						accessorCalls();
						return base.capability;
					},
				});
			} else {
				Object.defineProperty(accessor, key, {
					configurable: true,
					enumerable: true,
					value: Reflect.get(base, key),
					writable: true,
				});
			}
		}
		const symbolKey = { ...base } as Record<PropertyKey, unknown>;
		symbolKey[Symbol("extra")] = true;
		const hidden = { ...base } as Record<PropertyKey, unknown>;
		Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
		const inherited = Object.assign(Object.create({ inherited: true }) as object, base);
		const nonPlain = Object.assign([] as unknown[], base);
		const throwing = new Proxy(
			{ ...base },
			{
				ownKeys: (): ArrayLike<string | symbol> => {
					throw new Error("synthetic ownKeys poison");
				},
			}
		);
		for (const candidate of [symbolKey, accessor, hidden, inherited, nonPlain, throwing]) {
			let first!: V3PlaneActivationResultContract;
			let second!: V3PlaneActivationResultContract;
			expect(() => {
				first = surface.activateV3LivePlane(candidate as V3PlaneActivationInputContract);
			}).not.toThrow();
			expect(() => {
				second = surface.activateV3LivePlane(candidate as V3PlaneActivationInputContract);
			}).not.toThrow();
			expectClosedFrozenActivationFailure(first, "malformed-input");
			expectClosedFrozenActivationFailure(second, "malformed-input");
			expect(second).not.toBe(first);
		}
		expect(accessorCalls).not.toHaveBeenCalled();
	});

	it("pins every activation first-failure stage and zero effects under combined faults", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined) throw new TypeError("missing activateV3LivePlane");
			const topic = exactTopic(fixture.descriptor.objectId, fixture.descriptor.anchorDigest);
			const run = async (
				kind: (typeof ACTIVATION_FAILURE_KINDS)[number],
				configure: (input: {
					capability: object;
					messageQueueManager: MessageQueueManager<MessageShape>;
					networkNode: DRPNetworkNode;
					onAdmittedVertex: ReturnType<typeof vi.fn>;
				}) => void,
				expectedQueueSubscribeCalls = 0
			): Promise<void> => {
				const prepared = await fixture.prepareAgain();
				const readOutboxPage = vi.fn(() => Promise.resolve([]));
				const recovered = await recoverActivationCapability(
					surface,
					fixture,
					prepared.capability,
					fakeIssuanceStore({ readOutboxPage })
				);
				const input = {
					capability: recovered.capability,
					messageQueueManager: new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } }),
					networkNode: fakeNetwork(),
					onAdmittedVertex: vi.fn(),
				};
				configure(input);
				const queueSubscribe = vi.spyOn(input.messageQueueManager, "subscribe");
				const networkSubscribe = Reflect.get(input.networkNode, "subscribe") as ReturnType<typeof vi.fn>;
				let result!: V3PlaneActivationResultContract;
				expect(() => {
					result = surface.activateV3LivePlane(input);
				}).not.toThrow();
				expectClosedFrozenActivationFailure(result, kind);
				expect(readOutboxPage).not.toHaveBeenCalled();
				expect(queueSubscribe).toHaveBeenCalledTimes(expectedQueueSubscribeCalls);
				expect(networkSubscribe).not.toHaveBeenCalled();
				expect(input.messageQueueManager.hasQueue(topic)).toBe(false);
			};

			await run("not-started", (input) => {
				input.networkNode = fakeNetwork(false);
				Reflect.set(
					input.networkNode,
					"getSubscribedTopics",
					vi.fn(() => {
						throw new Error("later snapshot poison");
					})
				);
			});

			const sparseSnapshot = new Array<string>(3);
			sparseSnapshot[0] = "foreign-topic";
			sparseSnapshot[2] = "another-topic";
			for (const snapshot of [
				Object.freeze(sparseSnapshot),
				new Proxy(["foreign-topic"], {
					get: (): never => {
						throw new Error("synthetic subscription getter");
					},
				}),
				Object.freeze([1]),
			] as readonly unknown[]) {
				await run("internal-invariant", (input) => {
					Reflect.set(
						input.networkNode,
						"getSubscribedTopics",
						vi.fn(() => snapshot)
					);
				});
			}

			await run(
				"internal-invariant",
				(input) => {
					vi.spyOn(input.messageQueueManager, "subscribe").mockImplementation(() => {
						throw new Error("synthetic unexpected queue subscribe failure");
					});
					Reflect.set(
						input.networkNode,
						"subscribe",
						vi.fn(() => {
							throw new Error("later network failure");
						})
					);
				},
				1
			);

			const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
			const installThrowingTextEncoder = (): void => {
				Object.defineProperty(globalThis, "TextEncoder", {
					configurable: true,
					value: class ThrowingTextEncoder {
						encode(): Uint8Array {
							throw new Error("synthetic topic UTF-8 failure");
						}
					},
				});
			};
			const restoreTextEncoder = (): void => {
				if (originalTextEncoder === undefined) Reflect.deleteProperty(globalThis, "TextEncoder");
				else Object.defineProperty(globalThis, "TextEncoder", originalTextEncoder);
			};
			let topicSurface!: Seam3PrivateSurface & {
				readonly prepareV3LiveGeneration: PrepareV3LiveGenerationForFixture;
			};
			try {
				installThrowingTextEncoder();
				topicSurface = (await import(
					"../packages/node/src/v3-live.js?seam3-topic-derivation-failure"
				)) as typeof topicSurface;
			} finally {
				restoreTextEncoder();
			}
			const topicFixture = await createGenuinePreparedV3Fixture({
				prepareV3LiveGeneration: topicSurface.prepareV3LiveGeneration,
			});
			try {
				if (topicSurface.activateV3LivePlane === undefined) throw new TypeError("missing activateV3LivePlane");
				const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
				const queueSubscribe = vi.spyOn(queue, "subscribe");
				const network = fakeNetwork();
				const networkSubscribe = Reflect.get(network, "subscribe") as ReturnType<typeof vi.fn>;
				const recovered = await recoverActivationCapability(topicSurface, topicFixture, topicFixture.capability);
				installThrowingTextEncoder();
				const result = topicSurface.activateV3LivePlane({
					capability: recovered.capability,
					messageQueueManager: queue,
					networkNode: network,
					onAdmittedVertex: vi.fn(),
				});
				expectClosedFrozenActivationFailure(result, "topic-derivation-failed");
				expect(queueSubscribe).not.toHaveBeenCalled();
				expect(networkSubscribe).not.toHaveBeenCalled();
			} finally {
				restoreTextEncoder();
				await topicFixture.close();
			}
		} finally {
			await fixture.close();
		}
	});

	it("reaches genuine recovered activation, binding conflict, ingress queueing, egress and deactivation", async () => {
		const fixture = await createGenuinePreparedV3Fixture({ authorizationMode: "latched-acl" });
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined || surface.routeV3Ingress === undefined) {
				throw new TypeError("missing Seam3 private surface");
			}
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const rows = Object.freeze([outboxRecord(scope, 1, "published"), outboxRecord(scope, 2, "pending")]);
			let pageOrdinal = 0;
			const readOutboxPage = vi.fn((_input: Parameters<DurableIssuanceStore["readOutboxPage"]>[0]) =>
				Promise.resolve(pageOrdinal < rows.length ? [rows[pageOrdinal++]] : [])
			);
			const compareAndMarkOutboxPublished = vi.fn(() => Promise.resolve());
			const issuanceStore = fakeIssuanceStore({ readOutboxPage, compareAndMarkOutboxPublished });
			const published: [string, MessageShape][] = [];
			const network = fakeNetwork(true, (topic, message) => {
				published.push([topic, message]);
				return Promise.resolve(true);
			});
			const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const queueSubscribe = vi.spyOn(queue, "subscribe");
			const queueEnqueue = vi.spyOn(queue, "enqueue");
			const queueClose = vi.spyOn(queue, "close");
			const sink = vi.fn();
			const recovered = await recoverActivationCapability(surface, fixture, fixture.capability, issuanceStore);
			const input = {
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: sink,
			};
			const activated = surface.activateV3LivePlane(input);
			expect(activated).toEqual({ ok: true, handle: expect.any(Object) });
			if (!activated.ok) throw new TypeError(`activation failed: ${activated.kind}`);
			expect(Reflect.ownKeys(activated).sort()).toEqual(["handle", "ok"]);
			expect(Object.isFrozen(activated)).toBe(true);
			expect(Object.isFrozen(activated.handle)).toBe(true);
			expect(activated.handle.objectId).toBe(fixture.descriptor.objectId);
			expect(activated.handle.queueId).toBe(activated.handle.topic);
			const currentEphemeralAuthority = Reflect.get(activated.handle, "currentEphemeralAuthority");
			expect(typeof currentEphemeralAuthority).toBe("function");
			if (typeof currentEphemeralAuthority !== "function") {
				throw new TypeError("missing current ephemeral authority view");
			}
			const authority = Reflect.apply(currentEphemeralAuthority, activated.handle, []) as
				| Readonly<{
						aclDigest: string;
						anchorDigest: string;
						epoch: 0;
						objectId: string;
						isCurrentWriter(author: string): boolean;
				  }>
				| undefined;
			expect(fixture.exactCanonicalLatchedAclBytes).toBeDefined();
			if (fixture.exactCanonicalLatchedAclBytes === undefined) {
				throw new TypeError("missing genuine latched ACL bytes");
			}
			expect(authority).toMatchObject({
				aclDigest: lowerHex(hashDomain("ts-drp/latched-acl/v3", fixture.exactCanonicalLatchedAclBytes)),
				anchorDigest: fixture.descriptor.anchorDigest,
				epoch: 0,
				objectId: fixture.descriptor.objectId,
			});
			expect(authority?.isCurrentWriter(fixture.author)).toBe(true);
			expect(authority?.isCurrentWriter(`untrusted:${fixture.author}`)).toBe(false);
			expect(Object.isFrozen(authority)).toBe(true);
			expect(queue.hasQueue(activated.handle.queueId)).toBe(true);
			const networkSubscribe = Reflect.get(network, "subscribe") as ReturnType<typeof vi.fn>;
			const networkUnsubscribe = Reflect.get(network, "unsubscribe") as ReturnType<typeof vi.fn>;
			expect(queueSubscribe).toHaveBeenCalledTimes(1);
			expect(networkSubscribe).toHaveBeenCalledTimes(1);

			const repeated = await fixture.prepareAgain();
			const repeatedRecovered = await recoverActivationCapability(surface, fixture, repeated.capability, issuanceStore);
			const conflicting = surface.activateV3LivePlane({ ...input, capability: repeatedRecovered.capability });
			expectClosedFrozenActivationFailure(conflicting, "internal-invariant");
			expect(queueSubscribe).toHaveBeenCalledTimes(1);
			expect(networkSubscribe).toHaveBeenCalledTimes(1);
			expect(queueClose).not.toHaveBeenCalled();
			expect(networkUnsubscribe).not.toHaveBeenCalled();
			expect(queue.hasQueue(activated.handle.queueId)).toBe(true);
			expect(network.getSubscribedTopics()).toEqual([activated.handle.topic]);
			expect(readOutboxPage).not.toHaveBeenCalled();
			expect(compareAndMarkOutboxPublished).not.toHaveBeenCalled();
			expect(published).toEqual([]);
			expect(sink).not.toHaveBeenCalled();
			expect(surface.activateV3LivePlane({ ...input, capability: repeatedRecovered.capability })).toEqual({
				ok: false,
				kind: "capability-consumed",
				detail: expect.any(String),
			});
			expect(queueSubscribe).toHaveBeenCalledTimes(1);
			expect(networkSubscribe).toHaveBeenCalledTimes(1);
			expect(queueClose).not.toHaveBeenCalled();
			expect(networkUnsubscribe).not.toHaveBeenCalled();
			expect(queue.hasQueue(activated.handle.queueId)).toBe(true);
			expect(network.getSubscribedTopics()).toEqual([activated.handle.topic]);
			expect(readOutboxPage).not.toHaveBeenCalled();
			expect(compareAndMarkOutboxPublished).not.toHaveBeenCalled();
			expect(published).toEqual([]);
			expect(sink).not.toHaveBeenCalled();

			const gossipTopicFor = vi.fn((): string | undefined => activated.handle.topic);
			Reflect.set(network, "gossipTopicFor", gossipTopicFor);
			const generated = (await import("@ts-drp/types")) as unknown as {
				V3Envelope?: {
					decode(bytes: Uint8Array): { canonicalPreimage: Uint8Array; signature: Uint8Array };
					encode(value: { canonicalPreimage: Uint8Array; signature: Uint8Array }): { finish(): Uint8Array };
				};
			};
			if (generated.V3Envelope === undefined) throw new TypeError("missing generated V3Envelope");
			const ingressCarrier = fixture.createRecoveryVertex(1, [recovered.recoveryDigest]);
			const canonicalEnvelopeBytes = generated.V3Envelope.encode({
				canonicalPreimage: ingressCarrier.canonicalPreimageBytes,
				signature: ingressCarrier.signature,
			}).finish();
			const ingress = Message.create({
				data: canonicalEnvelopeBytes,
				objectId: activated.handle.topic,
				sender: "authenticated-peer",
				type: 11,
			});
			const waitForIngress = async (): Promise<void> => {
				await new Promise((resolve) => setTimeout(resolve, 5));
			};
			const expectNoDelivery = async (
				message: MessageShape,
				provenance: string | undefined,
				expectedClaim: boolean,
				expectedEnqueueDelta: 0 | 1
			): Promise<void> => {
				const sinkCount = sink.mock.calls.length;
				const enqueueCount = queueEnqueue.mock.calls.length;
				gossipTopicFor.mockReturnValue(provenance);
				expect(surface.routeV3Ingress(network, message)).toBe(expectedClaim);
				await waitForIngress();
				expect(queueEnqueue).toHaveBeenCalledTimes(enqueueCount + expectedEnqueueDelta);
				expect(sink).toHaveBeenCalledTimes(sinkCount);
			};
			await expectNoDelivery(
				Message.create({ ...ingress, type: MessageType.MESSAGE_TYPE_UPDATE }),
				activated.handle.topic,
				true,
				0
			);
			await expectNoDelivery(
				Message.create({ ...ingress, objectId: "drp/v3/1/foreign" }),
				activated.handle.topic,
				true,
				0
			);
			await expectNoDelivery(ingress, "drp/v3/1/foreign", true, 0);
			await expectNoDelivery(ingress, undefined, true, 0);
			await expectNoDelivery(
				Message.create({ ...ingress, data: Uint8Array.of(0xff) }),
				activated.handle.topic,
				true,
				1
			);
			await expectNoDelivery(
				Message.create({ ...ingress, data: new Uint8Array([...canonicalEnvelopeBytes, 0x18, 0x01]) }),
				activated.handle.topic,
				true,
				1
			);
			gossipTopicFor.mockReset();
			gossipTopicFor.mockReturnValueOnce(activated.handle.topic).mockReturnValue(undefined);
			const enqueueBeforeRevalidation = queueEnqueue.mock.calls.length;
			expect(surface.routeV3Ingress(network, ingress)).toBe(true);
			await waitForIngress();
			expect(gossipTopicFor).toHaveBeenCalledTimes(2);
			expect(queueEnqueue).toHaveBeenCalledTimes(enqueueBeforeRevalidation + 1);
			expect(sink).not.toHaveBeenCalled();
			gossipTopicFor.mockReset();
			gossipTopicFor.mockReturnValue(activated.handle.topic);
			const enqueueBeforeDelivery = queueEnqueue.mock.calls.length;
			expect(surface.routeV3Ingress(network, ingress)).toBe(true);
			for (let count = 0; count < 100 && sink.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(sink).toHaveBeenCalledTimes(1);
			expect(queueEnqueue).toHaveBeenCalledTimes(enqueueBeforeDelivery + 1);
			const delivery = sink.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(Object.isFrozen(delivery)).toBe(true);
			expect(Reflect.ownKeys(delivery)).toEqual([
				"vertex",
				"exactReceivedCanonicalPreimageBytes",
				"signature",
				"transportSender",
			]);
			expect(delivery.exactReceivedCanonicalPreimageBytes).toEqual(ingressCarrier.canonicalPreimageBytes);
			expect(delivery.exactReceivedCanonicalPreimageBytes).not.toBe(ingressCarrier.canonicalPreimageBytes);
			expect(delivery.signature).toEqual(ingressCarrier.signature);
			expect(delivery.signature).not.toBe(ingressCarrier.signature);
			expect(delivery.transportSender).toBe("authenticated-peer");

			const publicationResult = await activated.handle.publishPending();
			expect(publicationResult).toEqual({ ok: true, kind: "published" });
			expect(Reflect.ownKeys(publicationResult).sort()).toEqual(["kind", "ok"]);
			expect(Object.isFrozen(publicationResult)).toBe(true);
			expect(readOutboxPage).toHaveBeenCalledTimes(2);
			expect(readOutboxPage.mock.calls).toEqual([
				[{ limit: 1, scope }],
				[{ afterKey: [scope.objectId, scope.author, 1], limit: 1, scope }],
			]);
			expect(readOutboxPage.mock.calls[0]?.[0].scope).not.toBe(scope);
			expect(readOutboxPage.mock.calls[1]?.[0].scope).not.toBe(scope);
			expect(published).toHaveLength(1);
			const publication = published[0];
			expect(publication?.[0]).toBe(activated.handle.topic);
			expect(publication?.[1]).toMatchObject({
				objectId: activated.handle.topic,
				sender: network.peerId,
				type: 11,
			});
			const publishedEnvelope = generated.V3Envelope.decode(publication?.[1].data ?? new Uint8Array());
			expect(publishedEnvelope).toEqual({
				canonicalPreimage: rows[1]?.commit.envelope.canonicalPreimageBytes,
				signature: rows[1]?.commit.envelope.signature,
			});
			expect(compareAndMarkOutboxPublished).toHaveBeenCalledWith({
				authorSequence: 2,
				digest: rows[1]?.commit.envelope.digest,
				scope,
			});

			activated.handle.deactivate();
			activated.handle.deactivate();
			expect(Reflect.apply(currentEphemeralAuthority, activated.handle, [])).toBeUndefined();
			expect(queue.hasQueue(activated.handle.queueId)).toBe(false);
			expect(network.getSubscribedTopics()).toEqual([]);
			expect(queueClose).toHaveBeenCalledTimes(1);
			expect(networkUnsubscribe).toHaveBeenCalledTimes(1);
			const readsBeforeDeadCall = readOutboxPage.mock.calls.length;
			const publishesBeforeDeadCall = published.length;
			const firstDeadResult = await activated.handle.publishPending();
			const secondDeadResult = await activated.handle.publishPending();
			expect(firstDeadResult).toEqual({
				ok: false,
				kind: "not-active",
				detail: expect.any(String),
			});
			expect(secondDeadResult).toEqual(firstDeadResult);
			expect(secondDeadResult).not.toBe(firstDeadResult);
			expect(Reflect.ownKeys(firstDeadResult).sort()).toEqual(["detail", "kind", "ok"]);
			expect(Object.isFrozen(firstDeadResult)).toBe(true);
			expect(Object.isFrozen(secondDeadResult)).toBe(true);
			expect(readOutboxPage).toHaveBeenCalledTimes(readsBeforeDeadCall);
			expect(published).toHaveLength(publishesBeforeDeadCall);

			const fresh = await fixture.prepareAgain();
			const rejectingSink = vi.fn(() => Promise.reject(new Error("synthetic sink failure")));
			const freshStore = fakeIssuanceStore();
			const freshRecovered = await recoverActivationCapability(surface, fixture, fresh.capability, freshStore);
			const reactivated = surface.activateV3LivePlane({
				...input,
				capability: freshRecovered.capability,
				onAdmittedVertex: rejectingSink,
			});
			if (!reactivated.ok) throw new TypeError(`reactivation failed: ${reactivated.kind}`);
			expect(reactivated.handle).not.toBe(activated.handle);
			Reflect.set(
				network,
				"gossipTopicFor",
				vi.fn(() => reactivated.handle.topic)
			);
			expect(surface.routeV3Ingress(network, Message.create({ ...ingress, objectId: reactivated.handle.topic }))).toBe(
				true
			);
			for (let count = 0; count < 100 && rejectingSink.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(rejectingSink).toHaveBeenCalledTimes(1);
			expect(await reactivated.handle.publishPending()).toEqual({ ok: true, kind: "empty" });
		} finally {
			await fixture.close();
		}
	});

	it("rejects genuine signed wrong-object and wrong-epoch live vertices before the journal boundary", async () => {
		const fixture = await createGenuinePreparedV3Fixture({ authorizationMode: "latched-acl" });
		let deactivate: (() => void) | undefined;
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined || surface.routeV3Ingress === undefined) {
				throw new TypeError("missing Seam3 private surface");
			}
			const issuanceStore = fakeIssuanceStore();
			const recovered = await recoverActivationCapability(surface, fixture, fixture.capability, issuanceStore);
			const journal = activationJournalStores.get(issuanceStore as object);
			if (journal === undefined) throw new TypeError("missing genuine live journal owner");
			const appendAccepted = vi.mocked(journal.appendAccepted);
			const sink = vi.fn();
			const network = fakeNetwork();
			const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const activated = surface.activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: sink,
			});
			if (!activated.ok) throw new TypeError(`activation failed: ${activated.kind}`);
			deactivate = activated.handle.deactivate;
			const initialAppendCount = appendAccepted.mock.calls.length;
			Reflect.set(
				network,
				"gossipTopicFor",
				vi.fn(() => activated.handle.topic)
			);
			const generated = (await import("@ts-drp/types")) as unknown as {
				V3Envelope?: {
					encode(value: { canonicalPreimage: Uint8Array; signature: Uint8Array }): { finish(): Uint8Array };
				};
			};
			if (generated.V3Envelope === undefined) throw new TypeError("missing generated V3Envelope");
			const current = await createSignedScopeCarrier(fixture, {
				authorSequence: 1,
				dependencies: [recovered.recoveryDigest],
			});
			const wrongObject = await createSignedScopeCarrier(fixture, {
				authorSequence: 2,
				dependencies: [recovered.recoveryDigest],
				objectId: `creator:${"d".repeat(32)}`,
			});
			const wrongEpoch = await createSignedScopeCarrier(fixture, {
				authorSequence: 2,
				dependencies: [recovered.recoveryDigest],
				epoch: 1,
			});
			const route = (carrier: SignedScopeCarrier): boolean =>
				surface.routeV3Ingress?.(
					network,
					Message.create({
						data: generated.V3Envelope?.encode({
							canonicalPreimage: carrier.canonicalPreimageBytes,
							signature: carrier.signature,
						}).finish(),
						objectId: activated.handle.topic,
						sender: "authenticated-peer",
						type: 11,
					})
				) === true;
			expect(route(wrongObject)).toBe(true);
			expect(route(wrongEpoch)).toBe(true);
			expect(route(current)).toBe(true);
			for (let count = 0; count < 200 && sink.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(sink).toHaveBeenCalledTimes(1);
			expect(appendAccepted).toHaveBeenCalledTimes(initialAppendCount + 1);
			expect(appendAccepted.mock.calls.at(-1)?.[0]).toMatchObject({
				exactCanonicalPreimageBytes: current.canonicalPreimageBytes,
				sourceKind: "received",
				vertexDigest: lowerHex(current.digest),
			});
		} finally {
			deactivate?.();
			await fixture.close();
		}
	});

	it("keeps wrong-scope evidence from consuming capacity needed by current-scope pending ingress", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		let deactivate: (() => void) | undefined;
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined || surface.routeV3Ingress === undefined) {
				throw new TypeError("missing Seam3 private surface");
			}
			const issuanceStore = fakeIssuanceStore();
			const recovered = await recoverActivationCapability(surface, fixture, fixture.capability, issuanceStore);
			const journal = activationJournalStores.get(issuanceStore as object);
			if (journal === undefined) throw new TypeError("missing genuine live journal owner");
			const appendAccepted = vi.mocked(journal.appendAccepted);
			const initialAppendCount = appendAccepted.mock.calls.length;
			const network = fakeNetwork();
			const queue = new MessageQueueManager<MessageShape>({
				logConfig: { level: "silent" },
				maxQueueSize: 5_000,
			});
			const activated = surface.activateV3LivePlane({
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: vi.fn(),
			});
			if (!activated.ok) throw new TypeError(`activation failed: ${activated.kind}`);
			deactivate = activated.handle.deactivate;
			Reflect.set(
				network,
				"gossipTopicFor",
				vi.fn(() => activated.handle.topic)
			);
			const generated = (await import("@ts-drp/types")) as unknown as {
				V3Envelope?: {
					encode(value: { canonicalPreimage: Uint8Array; signature: Uint8Array }): { finish(): Uint8Array };
				};
			};
			if (generated.V3Envelope === undefined) throw new TypeError("missing generated V3Envelope");
			const envelopeCodec = generated.V3Envelope;
			const encodeCarrier = (carrier: SignedScopeCarrier): Uint8Array =>
				envelopeCodec
					.encode({
						canonicalPreimage: carrier.canonicalPreimageBytes,
						signature: carrier.signature,
					})
					.finish();
			const routeBytes = (bytes: Uint8Array): boolean =>
				surface.routeV3Ingress?.(
					network,
					Message.create({
						data: bytes,
						objectId: activated.handle.topic,
						sender: "authenticated-peer",
						type: 11,
					})
				) === true;

			const barrier = await createSignedScopeCarrier(fixture, {
				authorSequence: 1,
				dependencies: [recovered.recoveryDigest],
			});
			const release = await createSignedScopeCarrier(fixture, {
				authorSequence: 2,
				dependencies: [lowerHex(barrier.digest)],
			});
			const currentPending = await createSignedScopeCarrier(fixture, {
				authorSequence: 3,
				dependencies: [lowerHex(release.digest)],
			});
			const pendingWireBytes = encodeCarrier(currentPending);
			const pendingCapacity = 4_096;
			const wrongCapacity = await Promise.all(
				Array.from({ length: pendingCapacity }, (_, index) =>
					createSignedScopeCarrier(fixture, {
						authorSequence: index + 10,
						dependencies: ["f".repeat(64)],
						epoch: 1,
					})
				)
			);
			for (const carrier of wrongCapacity) expect(routeBytes(encodeCarrier(carrier))).toBe(true);
			expect(routeBytes(encodeCarrier(barrier))).toBe(true);
			for (let count = 0; count < 10_000 && appendAccepted.mock.calls.length < initialAppendCount + 1; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(appendAccepted).toHaveBeenCalledTimes(initialAppendCount + 1);
			expect(routeBytes(pendingWireBytes)).toBe(true);
			expect(routeBytes(encodeCarrier(release))).toBe(true);
			const tail = await createSignedScopeCarrier(fixture, {
				authorSequence: 4,
				dependencies: [lowerHex(release.digest)],
			});
			expect(routeBytes(encodeCarrier(tail))).toBe(true);
			for (let count = 0; count < 10_000 && appendAccepted.mock.calls.length < initialAppendCount + 3; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(appendAccepted.mock.calls.some(([row]) => row.vertexDigest === lowerHex(currentPending.digest))).toBe(
				true
			);
		} finally {
			deactivate?.();
			await fixture.close();
		}
	});

	it("rejects genuine persisted wrong scope before graph replay while preserving current-scope recovery", async () => {
		const surface = await privateSurface();
		if (surface.recoverV3LiveReplica === undefined) throw new TypeError("missing recoverV3LiveReplica");
		const observedFailures: string[] = [];
		for (const mutation of ["object", "epoch"] as const) {
			const fixture = await createGenuinePreparedV3Fixture();
			try {
				const carrier = await createSignedScopeCarrier(fixture, {
					authorSequence: 0,
					dependencies: [fixture.descriptor.anchorDigest],
					...(mutation === "object" ? { objectId: `creator:${"e".repeat(32)}` } : { epoch: 1 }),
				});
				const issuanceStore = fakeIssuanceStore();
				const journal = journalStoreForFixture(fixture, Object.freeze([receivedJournalRow(fixture, carrier)]));
				activationJournalStores.set(issuanceStore as object, journal);
				try {
					await recoverActivationCapability(
						surface,
						fixture,
						fixture.capability,
						issuanceStore,
						Object.freeze([receivedJournalRow(fixture, carrier)])
					);
					observedFailures.push("unexpected-success");
				} catch (error) {
					observedFailures.push(error instanceof RecoveryAttemptError ? error.kind : "unknown-error");
				}
				expect(journal.appendAccepted).not.toHaveBeenCalled();
			} finally {
				await fixture.close();
			}
		}

		let currentRecovered = false;
		const currentFixture = await createGenuinePreparedV3Fixture();
		try {
			const current = await createSignedScopeCarrier(currentFixture, {
				authorSequence: 0,
				dependencies: [currentFixture.descriptor.anchorDigest],
			});
			const recovered = await recoverActivationCapability(
				surface,
				currentFixture,
				currentFixture.capability,
				fakeIssuanceStore(),
				Object.freeze([receivedJournalRow(currentFixture, current)])
			);
			currentRecovered = typeof recovered.capability === "object";
		} finally {
			await currentFixture.close();
		}
		expect(currentRecovered).toBe(true);
		expect(observedFailures).toEqual(["admission-rejected", "admission-rejected"]);
	});

	it("retires membership-lost registrations and requires a fresh token for one replacement handle", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined || surface.routeV3Ingress === undefined) {
				throw new TypeError("missing Seam3 private surface");
			}
			const readOutboxPage = vi.fn(() => Promise.resolve([]));
			const issuanceStore = fakeIssuanceStore({ readOutboxPage });
			const network = fakeNetwork();
			const queue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const queueEnqueue = vi.spyOn(queue, "enqueue");
			const queueClose = vi.spyOn(queue, "close");
			const recovered = await recoverActivationCapability(surface, fixture, fixture.capability, issuanceStore);
			const input = {
				capability: recovered.capability,
				messageQueueManager: queue,
				networkNode: network,
				onAdmittedVertex: vi.fn(),
			};
			const first = surface.activateV3LivePlane(input);
			if (!first.ok) throw new TypeError(`first activation failed: ${first.kind}`);
			const authorListAuthority = Reflect.get(first.handle, "currentEphemeralAuthority");
			expect(typeof authorListAuthority).toBe("function");
			if (typeof authorListAuthority !== "function") {
				throw new TypeError("missing current ephemeral authority view");
			}
			expect(Reflect.apply(authorListAuthority, first.handle, [])).toBeUndefined();
			const topic = first.handle.topic;
			network.unsubscribe(topic);
			expect(network.getSubscribedTopics()).toEqual([]);
			Reflect.set(
				network,
				"gossipTopicFor",
				vi.fn(() => topic)
			);
			expect(
				surface.routeV3Ingress(
					network,
					Message.create({ data: Uint8Array.of(0xff), objectId: topic, sender: "peer", type: 11 })
				)
			).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(queueEnqueue).not.toHaveBeenCalled();
			expect(await first.handle.publishPending()).toEqual({
				ok: false,
				kind: "not-active",
				detail: expect.any(String),
			});
			expect(readOutboxPage).not.toHaveBeenCalled();
			expect(surface.activateV3LivePlane(input)).toEqual({
				ok: false,
				kind: "capability-consumed",
				detail: expect.any(String),
			});

			const replacementToken = await fixture.prepareAgain();
			const replacementRecovered = await recoverActivationCapability(
				surface,
				fixture,
				replacementToken.capability,
				issuanceStore
			);
			const replacement = surface.activateV3LivePlane({ ...input, capability: replacementRecovered.capability });
			if (!replacement.ok) throw new TypeError(`replacement activation failed: ${replacement.kind}`);
			expect(replacement.handle).not.toBe(first.handle);
			expect(replacement.handle.topic).toBe(topic);
			expect(queueClose).toHaveBeenCalledWith(topic);
			expect(queue.hasQueue(topic)).toBe(true);
			expect(network.getSubscribedTopics()).toEqual([topic]);
			expect(await first.handle.publishPending()).toEqual({
				ok: false,
				kind: "not-active",
				detail: expect.any(String),
			});
			replacement.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("burns genuine tokens across foreign ownership and reverse-rolls a failed subscription", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined) throw new TypeError("missing activateV3LivePlane");
			const topic = exactTopic(fixture.descriptor.objectId, fixture.descriptor.anchorDigest);
			const foreignQueue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			foreignQueue.subscribe(topic, vi.fn());
			const cleanNetwork = fakeNetwork();
			const issuanceStore = fakeIssuanceStore();
			const shared = {
				networkNode: cleanNetwork,
				onAdmittedVertex: vi.fn(),
			};
			const firstRecovered = await recoverActivationCapability(surface, fixture, fixture.capability, issuanceStore);
			expect(
				surface.activateV3LivePlane({
					...shared,
					capability: firstRecovered.capability,
					messageQueueManager: foreignQueue,
				})
			).toEqual({ ok: false, kind: "internal-invariant", detail: expect.any(String) });
			expect(foreignQueue.hasQueue(topic)).toBe(true);
			expect(cleanNetwork.getSubscribedTopics()).toEqual([]);
			expect(
				surface.activateV3LivePlane({
					...shared,
					capability: firstRecovered.capability,
					messageQueueManager: new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } }),
				})
			).toEqual({ ok: false, kind: "capability-consumed", detail: expect.any(String) });

			const topicToken = await fixture.prepareAgain();
			const topicRecovered = await recoverActivationCapability(surface, fixture, topicToken.capability, issuanceStore);
			const foreignTopicNetwork = fakeNetwork();
			foreignTopicNetwork.subscribe(topic);
			expect(
				surface.activateV3LivePlane({
					...shared,
					capability: topicRecovered.capability,
					messageQueueManager: new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } }),
					networkNode: foreignTopicNetwork,
				})
			).toEqual({ ok: false, kind: "internal-invariant", detail: expect.any(String) });
			expect(foreignTopicNetwork.getSubscribedTopics()).toEqual([topic]);

			const capacityToken = await fixture.prepareAgain();
			const capacityRecovered = await recoverActivationCapability(
				surface,
				fixture,
				capacityToken.capability,
				issuanceStore
			);
			const fullQueue = new MessageQueueManager<MessageShape>({ maxQueues: 0, logConfig: { level: "silent" } });
			const capacityQueueSubscribe = vi.spyOn(fullQueue, "subscribe");
			const capacityNetworkSubscribe = Reflect.get(cleanNetwork, "subscribe") as ReturnType<typeof vi.fn>;
			expect(
				surface.activateV3LivePlane({
					...shared,
					capability: capacityRecovered.capability,
					messageQueueManager: fullQueue,
				})
			).toEqual({ ok: false, kind: "queue-capacity", detail: expect.any(String) });
			expect(capacityQueueSubscribe).toHaveBeenCalledTimes(1);
			expect(capacityNetworkSubscribe).not.toHaveBeenCalled();
			expect(fullQueue.hasQueue(topic)).toBe(false);

			const retry = await fixture.prepareAgain();
			const retryRecovered = await recoverActivationCapability(surface, fixture, retry.capability, issuanceStore);
			const rollbackQueue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const brokenNetwork = fakeNetwork();
			const brokenSubscribe = vi.fn();
			Reflect.set(brokenNetwork, "subscribe", brokenSubscribe);
			expect(
				surface.activateV3LivePlane({
					...shared,
					capability: retryRecovered.capability,
					messageQueueManager: rollbackQueue,
					networkNode: brokenNetwork,
				})
			).toEqual({ ok: false, kind: "subscribe-failed", detail: expect.any(String) });
			expect(brokenSubscribe).toHaveBeenCalledTimes(1);
			expect(rollbackQueue.hasQueue(topic)).toBe(false);
			expect(brokenNetwork.getSubscribedTopics()).toEqual([]);

			const cleanupToken = await fixture.prepareAgain();
			const cleanupRecovered = await recoverActivationCapability(
				surface,
				fixture,
				cleanupToken.capability,
				issuanceStore
			);
			const cleanupQueue = new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } });
			const cleanupNetwork = fakeNetwork();
			const originalSubscribe = cleanupNetwork.subscribe.bind(cleanupNetwork);
			const originalUnsubscribe = cleanupNetwork.unsubscribe.bind(cleanupNetwork);
			const cleanupSubscribe = vi.fn((value: string): void => {
				originalSubscribe(value);
				throw new Error("synthetic subscribe failure after effect");
			});
			const cleanupUnsubscribe = vi.fn((value: string): void => {
				originalUnsubscribe(value);
				throw new Error("synthetic unsubscribe failure after effect");
			});
			const originalClose = cleanupQueue.close.bind(cleanupQueue);
			const cleanupClose = vi.spyOn(cleanupQueue, "close").mockImplementation((value: string): void => {
				originalClose(value);
				throw new Error("synthetic close failure after effect");
			});
			Reflect.set(cleanupNetwork, "subscribe", cleanupSubscribe);
			Reflect.set(cleanupNetwork, "unsubscribe", cleanupUnsubscribe);
			expect(
				surface.activateV3LivePlane({
					...shared,
					capability: cleanupRecovered.capability,
					messageQueueManager: cleanupQueue,
					networkNode: cleanupNetwork,
				})
			).toEqual({ ok: false, kind: "subscribe-failed", detail: expect.any(String) });
			expect(cleanupSubscribe).toHaveBeenCalledWith(topic);
			expect(cleanupUnsubscribe).toHaveBeenCalledWith(topic);
			expect(cleanupClose).toHaveBeenCalledWith(topic);
			expect(cleanupQueue.hasQueue(topic)).toBe(false);
			expect(cleanupNetwork.getSubscribedTopics()).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	it("serializes genuine egress and classifies page, publish and mark deactivation races", async () => {
		const fixture = await createGenuinePreparedV3Fixture();
		try {
			const surface = await privateSurface();
			if (surface.activateV3LivePlane === undefined) throw new TypeError("missing activateV3LivePlane");
			const scope = Object.freeze({ author: fixture.author, objectId: fixture.descriptor.objectId });
			const pending = outboxRecord(scope, 3, "pending");
			const activate = async (
				capability: object,
				issuanceStore: DurableIssuanceStore,
				network: DRPNetworkNode
			): Promise<V3PlaneActivationResultContract> => {
				const recovered = await recoverActivationCapability(surface, fixture, capability, issuanceStore);
				return surface.activateV3LivePlane({
					capability: recovered.capability,
					messageQueueManager: new MessageQueueManager<MessageShape>({ logConfig: { level: "silent" } }),
					networkNode: network,
					onAdmittedVertex: vi.fn(),
				});
			};

			const secondPending = outboxRecord(scope, 4, "pending");
			const fifoRows = [pending, secondPending] as const;
			const fifoPublishes = [deferred<unknown>(), deferred<unknown>()] as const;
			const fifoTrace: string[] = [];
			let fifoPublishOrdinal = 0;
			const fifoPublish = vi.fn((_topic: string, _message: MessageShape) => {
				const row = fifoRows[fifoPublishOrdinal];
				const next = fifoPublishes[fifoPublishOrdinal];
				fifoPublishOrdinal += 1;
				if (row !== undefined) fifoTrace.push(`publish:${row.commit.authorSequence}`);
				return next?.promise ?? Promise.reject(new Error("unexpected third publication"));
			});
			const fifoRead = vi.fn(() => {
				const row = fifoRows[fifoRead.mock.calls.length - 1];
				if (row !== undefined) fifoTrace.push(`read:${row.commit.authorSequence}`);
				return Promise.resolve(row === undefined ? [] : [row]);
			});
			const fifoMarks: number[] = [];
			const fifoMark = vi.fn((input: { readonly authorSequence: number }) => {
				fifoMarks.push(input.authorSequence);
				fifoTrace.push(`mark:${input.authorSequence}`);
				return Promise.resolve();
			});
			const fifoActivation = await activate(
				fixture.capability,
				fakeIssuanceStore({ compareAndMarkOutboxPublished: fifoMark, readOutboxPage: fifoRead }),
				fakeNetwork(true, fifoPublish)
			);
			if (!fifoActivation.ok) throw new TypeError(`FIFO activation failed: ${fifoActivation.kind}`);
			const fifoFirst = fifoActivation.handle.publishPending();
			const fifoSecond = fifoActivation.handle.publishPending();
			for (let count = 0; count < 100 && fifoPublish.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(fifoRead).toHaveBeenCalledTimes(1);
			expect(fifoPublish).toHaveBeenCalledTimes(1);
			expect(fifoMarks).toEqual([]);
			fifoPublishes[0].resolve(true);
			for (let count = 0; count < 100 && fifoPublish.mock.calls.length < 2; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(await fifoFirst).toEqual({ ok: true, kind: "published" });
			expect(fifoRead).toHaveBeenCalledTimes(2);
			expect(fifoPublish).toHaveBeenCalledTimes(2);
			expect(fifoMarks).toEqual([3]);
			fifoPublishes[1].resolve(true);
			const fifoSecondResult = await fifoSecond;
			expect(fifoSecondResult).toEqual({ ok: true, kind: "published" });
			expect(fifoSecondResult).not.toBe(await fifoFirst);
			expect(fifoMarks).toEqual([3, 4]);
			expect(fifoPublish.mock.calls.map((call) => call[0])).toEqual([
				fifoActivation.handle.topic,
				fifoActivation.handle.topic,
			]);
			expect(fifoPublish.mock.calls.map((call) => call[1].data)).toHaveLength(2);
			expect(fifoPublish.mock.calls[1]?.[1].data).not.toEqual(fifoPublish.mock.calls[0]?.[1].data);
			expect(fifoMark.mock.calls).toEqual([
				[{ authorSequence: 3, digest: pending.commit.envelope.digest, scope }],
				[{ authorSequence: 4, digest: secondPending.commit.envelope.digest, scope }],
			]);
			expect(fifoTrace).toEqual(["read:3", "publish:3", "mark:3", "read:4", "publish:4", "mark:4"]);
			fifoActivation.handle.deactivate();

			const page = deferred<readonly DurableIssuanceOutboxRecord[]>();
			const pageRead = vi.fn(() => page.promise);
			const pageMark = vi.fn(() => Promise.resolve());
			const pageNetwork = fakeNetwork();
			const pageToken = await fixture.prepareAgain();
			const pageActivation = await activate(
				pageToken.capability,
				fakeIssuanceStore({ compareAndMarkOutboxPublished: pageMark, readOutboxPage: pageRead }),
				pageNetwork
			);
			if (!pageActivation.ok) throw new TypeError(`page activation failed: ${pageActivation.kind}`);
			const first = pageActivation.handle.publishPending();
			const second = pageActivation.handle.publishPending();
			expect(pageRead).toHaveBeenCalledTimes(1);
			pageActivation.handle.deactivate();
			page.resolve([pending]);
			expect(await first).toEqual({ ok: false, kind: "not-active", detail: expect.any(String) });
			expect(await second).toEqual({ ok: false, kind: "not-active", detail: expect.any(String) });
			expect(pageRead).toHaveBeenCalledTimes(1);
			expect(Reflect.get(pageNetwork, "publishMessage")).not.toHaveBeenCalled();
			expect(pageMark).not.toHaveBeenCalled();

			const publish = deferred<unknown>();
			const publishCalls = vi.fn(() => publish.promise);
			const publishMark = vi.fn(() => Promise.resolve());
			const publishToken = await fixture.prepareAgain();
			const publishActivation = await activate(
				publishToken.capability,
				fakeIssuanceStore({
					compareAndMarkOutboxPublished: publishMark,
					readOutboxPage: vi.fn(() => Promise.resolve([pending])),
				}),
				fakeNetwork(true, publishCalls)
			);
			if (!publishActivation.ok) throw new TypeError(`publish activation failed: ${publishActivation.kind}`);
			const publishing = publishActivation.handle.publishPending();
			for (let count = 0; count < 100 && publishCalls.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			publishActivation.handle.deactivate();
			publish.resolve(true);
			expect(await publishing).toEqual({
				ok: false,
				kind: "publication-state-unknown",
				detail: expect.any(String),
			});
			expect(publishCalls).toHaveBeenCalledTimes(1);
			expect(publishMark).not.toHaveBeenCalled();

			const rejectedPublish = deferred<unknown>();
			const rejectedPublishCalls = vi.fn(() => rejectedPublish.promise);
			const rejectedPublishMark = vi.fn(() => Promise.resolve());
			const rejectedPublishToken = await fixture.prepareAgain();
			const rejectedPublishActivation = await activate(
				rejectedPublishToken.capability,
				fakeIssuanceStore({
					compareAndMarkOutboxPublished: rejectedPublishMark,
					readOutboxPage: vi.fn(() => Promise.resolve([pending])),
				}),
				fakeNetwork(true, rejectedPublishCalls)
			);
			if (!rejectedPublishActivation.ok) {
				throw new TypeError(`rejected publication race activation failed: ${rejectedPublishActivation.kind}`);
			}
			const rejectedPublishing = rejectedPublishActivation.handle.publishPending();
			for (let count = 0; count < 100 && rejectedPublishCalls.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			rejectedPublishActivation.handle.deactivate();
			rejectedPublish.reject(new Error("synthetic publication race rejection"));
			expect(await rejectedPublishing).toEqual({
				ok: false,
				kind: "publication-state-unknown",
				detail: expect.any(String),
			});
			expect(rejectedPublishCalls).toHaveBeenCalledTimes(1);
			expect(rejectedPublishMark).not.toHaveBeenCalled();

			const mark = deferred<undefined>();
			const markCalls = vi.fn(() => mark.promise);
			const markToken = await fixture.prepareAgain();
			const markActivation = await activate(
				markToken.capability,
				fakeIssuanceStore({
					compareAndMarkOutboxPublished: markCalls,
					readOutboxPage: vi.fn(() => Promise.resolve([pending])),
				}),
				fakeNetwork()
			);
			if (!markActivation.ok) throw new TypeError(`mark activation failed: ${markActivation.kind}`);
			const marking = markActivation.handle.publishPending();
			for (let count = 0; count < 100 && markCalls.mock.calls.length === 0; count += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			markActivation.handle.deactivate();
			mark.resolve(undefined);
			expect(await marking).toEqual({ ok: true, kind: "published" });

			const malformedToken = await fixture.prepareAgain();
			const crossRowCommit = Object.freeze({
				...pending.commit,
				outboxEntry: secondPending.commit.outboxEntry,
			});
			const inconsistentRow = Object.freeze({ ...pending, commit: crossRowCommit });
			expect(inconsistentRow.commit.issuedRecord.envelope.canonicalPreimageBytes).not.toEqual(
				inconsistentRow.commit.outboxEntry.envelope.canonicalPreimageBytes
			);
			expect(inconsistentRow.commit.issuedRecord.envelope.signature).not.toEqual(
				inconsistentRow.commit.outboxEntry.envelope.signature
			);
			const malformedNetwork = fakeNetwork();
			const malformedActivation = await activate(
				malformedToken.capability,
				fakeIssuanceStore({ readOutboxPage: vi.fn(() => Promise.resolve([inconsistentRow])) }),
				malformedNetwork
			);
			if (!malformedActivation.ok) throw new TypeError(`record activation failed: ${malformedActivation.kind}`);
			expect(await malformedActivation.handle.publishPending()).toEqual({
				ok: false,
				kind: "record-rejected",
				detail: expect.any(String),
			});
			expect(Reflect.get(malformedNetwork, "publishMessage")).not.toHaveBeenCalled();

			const crossScopeToken = await fixture.prepareAgain();
			const crossScopeNetwork = fakeNetwork();
			const crossScopeActivation = await activate(
				crossScopeToken.capability,
				fakeIssuanceStore({
					readOutboxPage: vi.fn(() =>
						Promise.resolve([outboxRecord({ ...scope, objectId: "creator:foreign" }, 5, "pending")])
					),
				}),
				crossScopeNetwork
			);
			if (!crossScopeActivation.ok) throw new TypeError(`scope activation failed: ${crossScopeActivation.kind}`);
			expect(await crossScopeActivation.handle.publishPending()).toEqual({
				ok: false,
				kind: "record-rejected",
				detail: expect.any(String),
			});
			expect(Reflect.get(crossScopeNetwork, "publishMessage")).not.toHaveBeenCalled();

			const truthyToken = await fixture.prepareAgain();
			const truthyMark = vi.fn(() => Promise.resolve());
			const truthyActivation = await activate(
				truthyToken.capability,
				fakeIssuanceStore({
					compareAndMarkOutboxPublished: truthyMark,
					readOutboxPage: vi.fn(() => Promise.resolve([pending])),
				}),
				fakeNetwork(true, () => Promise.resolve({ truthy: true }))
			);
			if (!truthyActivation.ok) throw new TypeError(`truthy activation failed: ${truthyActivation.kind}`);
			expect(await truthyActivation.handle.publishPending()).toEqual({
				ok: false,
				kind: "publish-failed",
				detail: expect.any(String),
			});
			expect(truthyMark).not.toHaveBeenCalled();
			truthyActivation.handle.deactivate();

			const rejectedToken = await fixture.prepareAgain();
			const rejectedMark = vi.fn(() => Promise.resolve());
			const rejectedActivation = await activate(
				rejectedToken.capability,
				fakeIssuanceStore({
					compareAndMarkOutboxPublished: rejectedMark,
					readOutboxPage: vi.fn(() => Promise.resolve([pending])),
				}),
				fakeNetwork(true, () => Promise.reject(new Error("synthetic publish rejection")))
			);
			if (!rejectedActivation.ok) throw new TypeError(`rejected activation failed: ${rejectedActivation.kind}`);
			expect(await rejectedActivation.handle.publishPending()).toEqual({
				ok: false,
				kind: "publish-failed",
				detail: expect.any(String),
			});
			expect(rejectedMark).not.toHaveBeenCalled();
			rejectedActivation.handle.deactivate();

			const rejectedMarkToken = await fixture.prepareAgain();
			const rejectedMarkCall = vi.fn(() => Promise.reject(new Error("synthetic mark rejection")));
			const rejectedMarkActivation = await activate(
				rejectedMarkToken.capability,
				fakeIssuanceStore({
					compareAndMarkOutboxPublished: rejectedMarkCall,
					readOutboxPage: vi.fn(() => Promise.resolve([pending])),
				}),
				fakeNetwork()
			);
			if (!rejectedMarkActivation.ok) {
				throw new TypeError(`mark-rejection activation failed: ${rejectedMarkActivation.kind}`);
			}
			expect(await rejectedMarkActivation.handle.publishPending()).toEqual({
				ok: false,
				kind: "publication-state-unknown",
				detail: expect.any(String),
			});
			expect(rejectedMarkCall).toHaveBeenCalledTimes(1);
			rejectedMarkActivation.handle.deactivate();
		} finally {
			await fixture.close();
		}
	});

	it("routes an unbound non-v3 message to legacy and claims unbound tag 11 without decode", async () => {
		const surface = await privateSurface();
		if (surface.routeV3Ingress === undefined) throw new TypeError("missing routeV3Ingress");
		const network = fakeNetwork();
		Reflect.set(
			network,
			"gossipTopicFor",
			vi.fn(() => undefined)
		);
		const legacy = Message.create({
			data: Uint8Array.of(1),
			objectId: "legacy",
			sender: "peer",
			type: MessageType.MESSAGE_TYPE_UPDATE,
		});
		const v3 = Message.create({ data: Uint8Array.of(0xff), objectId: TOPIC, sender: "peer", type: 11 });
		expect(surface.routeV3Ingress(network, legacy)).toBe(false);
		expect(surface.routeV3Ingress(network, v3)).toBe(true);
	});

	it("derives only the exact stable-genesis topic and uses it as queue and wire identity", async () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		const activationSource = source("packages/node/src/creator-adoption-activate.ts");
		const helperPath = path.join(ROOT, "packages/node/src/internal/v3-topic.ts");
		const objectId = `creator:${"a".repeat(32)}`;
		const genesis = "b".repeat(64);
		expect(exactTopic(objectId, genesis)).toMatch(/^drp\/v3\/1\/[0-9a-f]{64}$/u);
		expect(fs.existsSync(helperPath)).toBe(true);
		const helperSource = fs.existsSync(helperPath) ? fs.readFileSync(helperPath, "utf8") : "";
		expect(liveSource).toContain('from "./internal/v3-topic.js"');
		expect(activationSource).toContain('from "./internal/v3-topic.js"');
		expect(helperSource).toContain('"ts-drp/live-topic/v3"');
		expect(helperSource).toContain("drp/v3/1/");
		const unit = ts.createSourceFile("v3-topic.ts", helperSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const topicHashes: ts.CallExpression[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "hashDomain" &&
				node.arguments[0] !== undefined &&
				ts.isStringLiteral(node.arguments[0]) &&
				node.arguments[0].text === "ts-drp/live-topic/v3"
			) {
				topicHashes.push(node);
			}
			ts.forEachChild(node, visit);
		};
		visit(unit);
		expect(topicHashes).toHaveLength(1);
		const topicHash = topicHashes[0];
		expect(topicHash?.arguments).toHaveLength(3);
		expect(descendantIdentifierNames(topicHash?.arguments[1] as ts.Expression)).toContain("objectId");
		const genesisIdentifiers = descendantIdentifierNames(topicHash?.arguments[2] as ts.Expression);
		expect(genesisIdentifiers).toContain("genesisAnchorDigest");
		expect(genesisIdentifiers).not.toContain("anchorDigest");
		expect(genesisIdentifiers).not.toContain("currentAnchorDigest");
		expect(topLevelFunction(helperSource, "deriveV3StableTopic")).toBeDefined();
		expect(liveSource).toMatch(/queueId\s*:\s*topic/u);

		const { deriveV3StableTopic } = await import("../packages/node/src/internal/v3-topic.js");
		const expectedTopic = deriveV3StableTopic(objectId, genesis);
		const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
		const iteratorDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.iterator);
		if (iteratorDescriptor === undefined) throw new TypeError("missing typed-array iterator intrinsic");
		try {
			Object.defineProperty(typedArrayPrototype, Symbol.iterator, {
				...iteratorDescriptor,
				value: function* invertedTypedArrayIterator(this: Uint8Array): Generator<number> {
					for (let index = 0; index < this.length; index += 1) {
						yield (this[index] as number) ^ 0xff;
					}
				},
			});
			expect(deriveV3StableTopic(objectId, genesis)).toBe(expectedTopic);
		} finally {
			Object.defineProperty(typedArrayPrototype, Symbol.iterator, iteratorDescriptor);
		}

		const domainOwners: string[] = [];
		const consumers: string[] = [];
		for (const production of topicCensusSources()) {
			const sourceFile = ts.createSourceFile(
				production.path,
				production.text,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS
			);
			let ownsDomain = false;
			let consumesHelper = false;
			const census = (node: ts.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isIdentifier(node.expression) &&
					node.expression.text === "hashDomain" &&
					node.arguments[0] !== undefined &&
					ts.isStringLiteral(node.arguments[0]) &&
					node.arguments[0].text === "ts-drp/live-topic/v3"
				) {
					ownsDomain = true;
				}
				const consumes = (specifier: ts.Expression | undefined): void => {
					if (
						specifier !== undefined &&
						ts.isStringLiteralLike(specifier) &&
						resolvesToSource(production.path, specifier.text, helperPath)
					) {
						consumesHelper = true;
					}
				};
				if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) consumes(node.moduleSpecifier);
				if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
					consumes(node.moduleReference.expression);
				}
				if (
					ts.isCallExpression(node) &&
					(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
						(ts.isIdentifier(node.expression) && node.expression.text === "require"))
				) {
					consumes(node.arguments[0]);
				}
				ts.forEachChild(node, census);
			};
			census(sourceFile);
			if (ownsDomain) domainOwners.push(production.path);
			if (consumesHelper) consumers.push(production.path);
		}
		expect(domainOwners).toEqual(["packages/node/src/internal/v3-topic.ts"]);
		expect(consumers.sort()).toEqual([
			"packages/node/src/creator-adoption-activate.ts",
			"packages/node/src/v3-live.ts",
		]);

		const textEncoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
		let hostileModule!: Readonly<{ deriveV3StableTopic(objectId: string, genesisAnchorDigest: string): string }>;
		try {
			Object.defineProperty(globalThis, "TextEncoder", {
				configurable: true,
				value: class D108e2cThrowingTextEncoder {
					encode(): Uint8Array {
						throw new TypeError("D.108e2c hostile cached TextEncoder");
					}
				},
			});
			hostileModule = (await import(
				"../packages/node/src/internal/v3-topic.js?d108e2c-hostile-text-encoder"
			)) as typeof hostileModule;
		} finally {
			if (textEncoderDescriptor === undefined) Reflect.deleteProperty(globalThis, "TextEncoder");
			else Object.defineProperty(globalThis, "TextEncoder", textEncoderDescriptor);
		}
		expect(() => hostileModule.deriveV3StableTopic(objectId, genesis)).toThrow("D.108e2c hostile cached TextEncoder");
	});

	it("binds activation to the sole existing token owner and exact effect sequence", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		const activate = functionText(liveSource, "activateV3LivePlane");
		expect(activate).not.toBe("");
		expect(count(liveSource, /new WeakMap<DRPNetworkNode, Map<string, V3PlaneRegistration>>/gu)).toBe(1);
		const ordering = activationOrderingEvidence(liveSource);
		expect(ordering.consumeCount).toBe(1);
		expect(ordering.outerCapturedKeys).toEqual([
			"capability",
			"messageQueueManager",
			"networkNode",
			"onAdmittedVertex",
		]);
		expect(ordering.directInputAfterConsume).toBe(0);
		expect(ordering.recoveredReferencesAfterConsume).toBeGreaterThan(0);
		expect(ordering.consumePosition).toBeGreaterThan(-1);
		expect(ordering.firstEffect).toBeGreaterThan(ordering.consumePosition);
		expect(activate).toContain("hasQueue");
		expect(activate).toContain("getSubscribedTopics");
		expect(ACTIVATION_ORDER).toHaveLength(12);
		expect(liveSource).not.toMatch(/preparedV3LiveAuthority\.(?:set|delete)[\s\S]{0,80}activateV3LivePlane/u);
	});

	it("owns reverse rollback, postcondition cleanup and dead-handle invalidation without touching legacy", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		expect(liveSource).toMatch(/unsubscribe[\s\S]{0,500}(?:close|hasQueue)/u);
		expect(liveSource).toMatch(
			/deactivate[\s\S]{0,900}(?:inactive|active\s*=\s*false)[\s\S]{0,900}unsubscribe[\s\S]{0,900}close/u
		);
		expect(liveSource).toContain('"not-active"');
		expect(liveSource).not.toMatch(/(?:DISCOVERY_QUEUE_ID|GENERAL_QUEUE_ID|DRP_DISCOVERY_TOPIC|groupPeer)/u);
	});

	it("places the sole v3 routing decision before discovery and legacy, with true terminating dispatch", () => {
		const nodeSource = source("packages/node/src/index.ts");
		const handlers = source("packages/node/src/handlers.ts");
		expect(count(nodeSource, /routeV3Ingress\(/gu)).toBe(1);
		const route = nodeSource.indexOf("routeV3Ingress(");
		const discovery = nodeSource.indexOf("MESSAGE_TYPE_DRP_DISCOVERY", route);
		const legacy = nodeSource.indexOf("handleMessage(", route);
		expect(route).toBeGreaterThan(-1);
		expect(route).toBeLessThan(discovery);
		expect(route).toBeLessThan(legacy);
		expect(nodeSource.slice(route, Math.max(discovery, legacy))).toMatch(/if\s*\([^)]*routeV3Ingress[^)]*\)\s*return/u);
		expect(handlers).toContain("[MessageType.MESSAGE_TYPE_V3_ENVELOPE]: undefined");
	});

	it("decodes one canonical envelope then invokes only the genuine Seam-1 extractor with exact seven keys", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		const route = functionText(liveSource, "routeV3Ingress");
		expect(route).not.toBe("");
		expect(INGRESS_ORDER).toHaveLength(14);
		expect(count(liveSource, /V3Envelope\.decode\(/gu)).toBe(1);
		expect(count(liveSource, /V3Envelope\.encode\(/gu)).toBe(3);
		expect(count(liveSource, /extractAdmittedReceivedVertex\(/gu)).toBe(1);
		expect(liveSource).toMatch(
			/extractAdmittedReceivedVertex\(\{\s*domain,\s*expectedAnchor,\s*preparedBlueprintAdmission,\s*receivedCanonicalPreimageBytes,\s*resolveAuthorPublicKey,\s*signature,\s*suiteId,?\s*\}\)/u
		);
		expect(liveSource).not.toMatch(
			/(?:topic|transportSender|issuanceScope\.author)[\s\S]{0,80}(?:resolveAuthorPublicKey|authorId)/u
		);
	});

	it("walks one-record pages past published rows and publishes one durable pending row before exact mark", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		const publish = functionText(liveSource, "publishPending");
		const ownerText = publish === "" ? liveSource : publish;
		expect(EGRESS_ORDER).toHaveLength(15);
		expect(ownerText).toContain("readOutboxPage");
		expect(ownerText).toMatch(/limit\s*:\s*1/u);
		expect(ownerText).toContain("afterKey");
		expect(ownerText).toContain('"published"');
		expect(ownerText).toContain('"pending"');
		expect(ownerText).toContain("publishMessage");
		expect(ownerText).toContain("compareAndMarkOutboxPublished");
		expect(ownerText.indexOf("publishMessage")).toBeLessThan(ownerText.indexOf("compareAndMarkOutboxPublished"));
		expect(ownerText).toMatch(/publishedResult\s*!==\s*true|publicationResult\s*!==\s*true/u);
	});

	it("pins same-row preimage/signature/scope/sequence/digest authority and no automatic drain claim", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		for (const token of [
			"canonicalPreimageBytes",
			"signature",
			"authorSequence",
			"digest",
			"issuedRecord",
			"outboxEntry",
			"publishState",
		]) {
			expect(liveSource).toContain(token);
		}
		expect(liveSource).not.toMatch(
			/(?:setInterval|setTimeout|automaticDrain|publishAllPending|exactlyOnce|acknowledg)/iu
		);
	});

	it("keeps the Seam3 owner private and excludes protocol-v2, B effects and extra authority", async () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		const nodeRoot = Object.keys(await import("../packages/node/src/index.js")).sort();
		const protocolRoot = Object.keys(await import("@ts-drp/protocol-v3")).sort();
		for (const name of ["activateV3LivePlane", "routeV3Ingress", "V3PlaneHandle", "V3EgressResult"]) {
			expect(nodeRoot).not.toContain(name);
			expect(protocolRoot).not.toContain(name);
		}
		expect(liveSource).not.toMatch(/@ts-drp\/protocol-v2|protocol-v2\/|from ["']\.\/index/u);
		expect(liveSource).not.toMatch(
			/(?:applyReducer|subscribeObject|appendVertex|publishIndex|chargeVertex|issueVertex)/u
		);
	});

	it("pins the sole node dependency and forbids manifest, export-map and lock widening", () => {
		const manifestText = source("packages/node/package.json");
		const manifest = JSON.parse(manifestText) as {
			dependencies: Record<string, string>;
			exports: Record<string, unknown>;
		};
		expect(Object.keys(manifest.dependencies).sort()).toEqual([
			"@bufbuild/protobuf",
			"@chainsafe/bls",
			"@grpc/grpc-js",
			"@grpc/proto-loader",
			"@grpc/reflection",
			"@libp2p/crypto",
			"@libp2p/gossipsub",
			"@libp2p/interface",
			"@libp2p/peer-id",
			"@multiformats/multiaddr",
			"@noble/hashes",
			"@noble/secp256k1",
			"@ts-drp/blueprints",
			"@ts-drp/canonical",
			"@ts-drp/compaction",
			"@ts-drp/control-plane",
			"@ts-drp/ephemeral",
			"@ts-drp/interval-discovery",
			"@ts-drp/interval-reconnect",
			"@ts-drp/interval-runner",
			"@ts-drp/issuance-store",
			"@ts-drp/keychain",
			"@ts-drp/live-journal",
			"@ts-drp/logger",
			"@ts-drp/message-queue",
			"@ts-drp/network",
			"@ts-drp/object",
			"@ts-drp/protocol-v3",
			"@ts-drp/relay-policy",
			"@ts-drp/rendezvous",
			"@ts-drp/routing-browser",
			"@ts-drp/routing-node",
			"@ts-drp/storage",
			"@ts-drp/tracer",
			"@ts-drp/types",
			"@ts-drp/utils",
			"@ts-drp/validation",
			"@types/node",
			"commander",
			"dotenv",
			"esbuild-plugins-node-modules-polyfill",
			"race-event",
			"uint8arrays",
		]);
		expect(manifest.dependencies["@ts-drp/issuance-store"]).toBe("0.11.0");
		expect(manifest.dependencies["@ts-drp/live-journal"]).toBe("0.11.0");
		expect(manifest.exports).toEqual({
			".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" },
			"./runtime": { types: "./dist/src/runtime.d.ts", import: "./dist/src/runtime.js" },
			"./v3-live": { types: "./dist/src/v3-live.d.ts", import: "./dist/src/v3-live.js" },
		});
		const lock = source("pnpm-lock.yaml");
		const importer = lock.slice(lock.indexOf("  packages/node:"), lock.indexOf("  packages/object:"));
		expect(exactNodeIssuanceImporterCount(importer)).toBe(1);
		expect(nodeBoundaryViolations(manifestText, importer)).toEqual([]);

		const manifestControl = manifestText.includes('"@ts-drp/issuance-store": "0.11.0"')
			? manifestText
			: manifestText.replace(
					'\t\t"@ts-drp/interval-runner": "0.11.0",\n',
					'\t\t"@ts-drp/interval-runner": "0.11.0",\n\t\t"@ts-drp/issuance-store": "0.11.0",\n'
				);
		const importerControl = importer.includes("      '@ts-drp/issuance-store':")
			? importer
			: importer.replace(
					"      '@ts-drp/interval-runner':\n        specifier: 0.11.0\n        version: link:../interval-runner\n",
					"      '@ts-drp/interval-runner':\n        specifier: 0.11.0\n        version: link:../interval-runner\n      '@ts-drp/issuance-store':\n        specifier: 0.11.0\n        version: link:../issuance-store\n"
				);
		expect(nodeBoundaryViolations(manifestControl, importerControl)).toEqual([]);
		const unquotedImporterControl = importerControl.replace(
			"      '@ts-drp/issuance-store':",
			"      @ts-drp/issuance-store:"
		);
		expect(exactNodeIssuanceImporterCount(importerControl)).toBe(1);
		expect(exactNodeIssuanceImporterCount(unquotedImporterControl)).toBe(1);
		expect(nodeBoundaryViolations(manifestControl, unquotedImporterControl)).toEqual([]);
		expect(
			nodeBoundaryViolations(
				manifestControl.replace('"@ts-drp/types": "0.11.0"', '"@ts-drp/types": "0.11.1"'),
				importerControl
			)
		).toEqual([]);
		expect(
			nodeBoundaryViolations(
				manifestControl.replace('"import": "./dist/src/runtime.js"', '"import": "./dist/src/private-runtime.js"'),
				importerControl
			)
		).toContain("export-targets");
		expect(
			nodeBoundaryViolations(manifestControl, importerControl.replace("version: 2.2.5", "version: 2.2.4"))
		).toEqual([]);
		expect(
			nodeBoundaryViolations(
				manifestControl,
				importerControl.replace(
					"      '@ts-drp/issuance-store':\n        specifier: 0.11.0",
					"      '@ts-drp/issuance-store':\n        specifier: 0.11.1"
				)
			)
		).toContain("issuance-importer");
		expect(
			nodeBoundaryViolations(
				manifestControl,
				importerControl.replace("version: link:../issuance-store", "version: link:../storage")
			)
		).toContain("issuance-importer");
		expect(
			nodeBoundaryViolations(
				manifestControl,
				importerControl.replace("version: link:../issuance-store", "version: link:../issuance-store-evil")
			)
		).toContain("issuance-importer");
		expect(
			nodeBoundaryViolations(
				manifestControl,
				importerControl.replace(
					"      '@ts-drp/issuance-store':\n        specifier: 0.11.0\n        version: link:../issuance-store\n",
					""
				)
			)
		).toContain("issuance-importer");
	});

	it("causally compiles the mutually exact A and Seam3 private type contracts", () => {
		const result = spawnSync(
			path.join(ROOT, "node_modules/.bin/tsc"),
			["-p", path.join(ROOT, "tests/fixtures/phase-3a1b-p3/tsconfig.test.json")],
			{ cwd: ROOT, encoding: "utf8" }
		);
		expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
			status: 0,
			stderr: "",
			stdout: "",
		});
	});

	it("keeps errors path-free and byte-free while freezing every result record", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		expect(liveSource).toContain("Object.freeze");
		expect(liveSource).not.toMatch(/detail:\s*(?:error|cause|caught|String\()/u);
		expect(liveSource).not.toMatch(/detail:[^\n]*(?:path|bytes|peerId|signature|preimage)/iu);
	});

	it("retains generated and source ownership without a hand-written second envelope codec", () => {
		const liveSource = source("packages/node/src/v3-live.ts");
		const nonGeneratedOwners = [
			liveSource,
			source("packages/network/src/node.ts"),
			source("packages/node/src/index.ts"),
			source("packages/node/src/handlers.ts"),
		];
		for (const owner of nonGeneratedOwners) {
			expect(owner).not.toMatch(/function (?:encode|decode)V3Envelope|class V3EnvelopeCodec/u);
		}
		for (const production of productionSources()) {
			expect(privateGeneratedReferenceViolations(production.path, production.text), production.path).toEqual([]);
		}
		for (const mutant of [
			{
				path: "packages/node/src/v3-live.ts",
				text: 'import { V3Envelope } from "@ts-drp/types/private-generated";',
			},
			{
				path: "packages/node/src/v3-live.ts",
				text: 'import type { Message } from "@ts-drp/types/proto/drp/v1/messages_pb.js";',
			},
			{
				path: "packages/types/src/network.ts",
				text: `import { type Message, type V3Envelope } from "${GENERATED_MESSAGE_MODULE}";`,
			},
			{
				path: "packages/types/src/index.ts",
				text: `export { V3Envelope as HiddenEnvelope } from "${GENERATED_MESSAGE_MODULE}";`,
			},
			{
				path: "packages/types/src/index.ts",
				text: `export * from "${GENERATED_MESSAGE_MODULE}";`,
			},
			{
				path: "packages/types/src/index.ts",
				text: `export { ${SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS.join(", ")}, PrivateCodec } from "${GENERATED_MESSAGE_MODULE}";`,
			},
			{
				path: "packages/node/src/index.ts",
				text: `export { V3Envelope } from "${GENERATED_MESSAGE_MODULE}";`,
			},
			{
				path: "packages/node/src/index.ts",
				text: 'export { Message } from "@ts-drp/types/proto/drp/v1/messages_pb.js";',
			},
			{
				path: "packages/node/src/v3-live.ts",
				text: 'const codec = import("@ts-drp/types/proto/drp/v1/messages_pb.js");',
			},
			{
				path: "packages/node/src/v3-live.ts",
				text: 'type V3Codec = import("@ts-drp/types/proto/drp/v1/messages_pb.js").V3Envelope;',
			},
		] as const) {
			expect(privateGeneratedReferenceViolations(mutant.path, mutant.text), mutant.path).not.toEqual([]);
		}
		expect(liveSource).toMatch(/import[\s\S]{0,400}\bV3Envelope\b[\s\S]{0,400}from ["']@ts-drp\/types["']/u);
		expect(encodeCanonical({ tag: 11 })).not.toEqual(encodeCanonical({ tag: 10 }));
	});
});

const TOPIC = "drp/v3/1/test";
void LIVE_OWNER;
