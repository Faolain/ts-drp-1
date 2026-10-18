import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Phase4cBrowserServer, startPhase4cBrowserServer } from "./phase-4c-browser-server.js";

const PACKAGE_DIRECTORY = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "../..");
const REQUIRED = [
	"packages/live-journal/src/types.ts",
	"packages/live-journal/src/contract.ts",
	"packages/storage-node/src/live-journal.ts",
	"packages/storage-browser/src/live-journal.ts",
	"packages/node/src/v3-live.ts",
] as const;

function sourceOwner(text: string, start: string, end: string): string | undefined {
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end, startIndex + start.length);
	return startIndex < 0 || endIndex < 0 ? undefined : text.slice(startIndex, endIndex);
}

function ownerMatches(text: string | undefined, patterns: readonly RegExp[]): boolean {
	return text !== undefined && patterns.every((pattern) => pattern.test(text));
}

function ready(): boolean {
	if (!REQUIRED.every((path) => existsSync(resolve(REPOSITORY_ROOT, path)))) return false;
	const read = (path: string): string => readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
	const types = read(REQUIRED[0]);
	const contract = read(REQUIRED[1]);
	const nodeAdapter = read(REQUIRED[2]);
	const browserAdapter = read(REQUIRED[3]);
	const live = read(REQUIRED[4]);
	const journalScope = sourceOwner(types, "export interface LiveJournalScope", "export interface Install");
	const copyScope = sourceOwner(contract, "function copyScope", "function cloneScope");
	const cloneScope = sourceOwner(contract, "function cloneScope", "function sameScope");
	const provenanceType = sourceOwner(live, "interface ProvenanceSnapshot", "interface OpenedTrustSnapshot");
	const authenticatedProvenance = sourceOwner(
		live,
		"function snapshotAuthenticatedProvenance",
		"interface CapturedIteratorStep"
	);
	const usablePayload = sourceOwner(live, "function payloadIsUsable", "type V3IngressFailureCategory");
	const journalScopeOwner = sourceOwner(live, "function liveJournalScope", "function sameLiveJournalScope");
	const issueOwner = sourceOwner(live, "async function issueOneVertex", "async function issueLocal");
	const blueprintHandle = sourceOwner(live, "function makeV3BlueprintLiveHandle", "function importLiveSnapshotMachine");
	const planeHandle = sourceOwner(live, "function makeV3PlaneHandle", "export function activateV3LivePlane");
	return (
		types.includes("installEpochAnchor") &&
		ownerMatches(journalScope, [/readonly\s+epoch:\s*number;/u, /readonly\s+anchorDigest:\s*string;/u]) &&
		!journalScope?.includes("readonly epoch: 0;") &&
		contract.includes("installEpochAnchor") &&
		ownerMatches(copyScope, [/isSafeIntegerBetween\(epoch,\s*0\)/u, /epoch,\s*objectId/u]) &&
		ownerMatches(cloneScope, [/epoch:\s*scope\.epoch/u]) &&
		nodeAdapter.includes("installEpochAnchor") &&
		browserAdapter.includes("installEpochAnchor") &&
		ownerMatches(provenanceType, [/readonly\s+epoch:\s*number;/u]) &&
		ownerMatches(authenticatedProvenance, [
			/NumberIsSafeInteger\(provenance\.epoch\)/u,
			/provenance\.epoch\s*>=\s*0/u,
			/epoch:\s*provenance\.epoch/u,
		]) &&
		ownerMatches(usablePayload, [
			/NumberIsSafeInteger\(payload\.provenance\.epoch\)/u,
			/payload\.provenance\.epoch\s*>=\s*0/u,
		]) &&
		ownerMatches(journalScopeOwner, [/epoch:\s*payload\.provenance\.epoch/u]) &&
		ownerMatches(issueOwner, [/epoch:\s*registration\.payload\.provenance\.epoch/u]) &&
		ownerMatches(blueprintHandle, [/epoch:\s*registration\.payload\.provenance\.epoch/u]) &&
		ownerMatches(planeHandle, [/epoch:\s*registration\.payload\.provenance\.epoch/u])
	);
}

const GREEN_READY = ready();
let server: Phase4cBrowserServer | undefined;

interface BrowserRoundTrip {
	readonly appended: Readonly<Record<string, unknown>>;
	readonly crossScopePage: Readonly<Record<string, unknown>>;
	readonly extraRejected: Readonly<Record<string, unknown>>;
	readonly genesisAppended: Readonly<Record<string, unknown>>;
	readonly genesisInstalled: Readonly<Record<string, unknown>>;
	readonly genesisPage: Readonly<Record<string, unknown>>;
	readonly genesisReady: Readonly<Record<string, unknown>>;
	readonly genesisRejected: Readonly<Record<string, unknown>>;
	readonly hostileDispatchCount: number;
	readonly hostileRejected: Readonly<Record<string, unknown>>;
	readonly installed: Readonly<Record<string, unknown>>;
	readonly invalidEpochs: readonly Readonly<Record<string, unknown>>[];
	readonly page: Readonly<Record<string, unknown>>;
	readonly ready: Readonly<Record<string, unknown>>;
	readonly repeated: Readonly<Record<string, unknown>>;
	readonly unsafeEpochUnencodable: boolean;
	readonly unsafeScopeRejected: Readonly<Record<string, unknown>>;
	readonly values: Readonly<{
		readonly genesis: Readonly<{
			readonly scope: unknown;
			readonly vertexDigest: string;
		}>;
		readonly parametersDigest: string;
		readonly scope: unknown;
		readonly vertexDigest: string;
	}>;
}

test.beforeAll(async () => {
	if (!GREEN_READY) return;
	server = await startPhase4cBrowserServer({
		entryPoint: resolve(PACKAGE_DIRECTORY, "tests/assets/phase-6a-successor-epoch-entry.ts"),
	});
});

test.afterAll(async () => server?.close());
test.skip(!GREEN_READY, "D.108a successor representation owners are intentionally absent in RED");

test("persists and pages one epoch-one journal identically in the browser adapter", async ({ page }) => {
	await page.goto(server?.origin ?? "about:blank");
	const result = (await page.evaluate(
		(databaseName) => window.phase6aSuccessorEpoch.run(databaseName),
		`phase6a-successor-${crypto.randomUUID()}`
	)) as BrowserRoundTrip;
	const scope = result.values.scope;
	const genesisScope = result.values.genesis.scope;
	expect(result.genesisInstalled).toMatchObject({ idempotent: false, ok: true, scope: genesisScope });
	expect(result.genesisAppended).toMatchObject({
		journalSequence: 0,
		ok: true,
		scope: genesisScope,
		vertexDigest: result.values.genesis.vertexDigest,
	});
	expect(result.installed).toEqual({
		idempotent: false,
		ok: true,
		parametersDigest: result.values.parametersDigest,
		scope,
	});
	expect(result.repeated).toEqual({ ...result.installed, idempotent: true });
	expect(result.appended).toMatchObject({
		idempotent: false,
		journalSequence: 0,
		ok: true,
		scope,
		sourceKind: "received",
	});
	expect(result.ready).toMatchObject({ ok: true, ready: true, rowCount: 1, scope });
	expect(result.genesisReady).toMatchObject({ ok: true, ready: true, rowCount: 1, scope: genesisScope });
	expect((result.genesisReady.snapshot as Readonly<Record<string, unknown>>).orderedRowDigest).not.toBe(
		(result.ready.snapshot as Readonly<Record<string, unknown>>).orderedRowDigest
	);
	expect(result.genesisPage).toMatchObject({
		nextSequence: null,
		ok: true,
		rows: [{ journalSequence: 0, scope: genesisScope, vertexDigest: result.values.genesis.vertexDigest }],
		scope: genesisScope,
	});
	expect(result.page).toMatchObject({
		nextSequence: null,
		ok: true,
		rows: [{ journalSequence: 0, scope, sourceKind: "received" }],
		scope,
	});
	expect(result.genesisRejected).toEqual({ kind: "noncanonical-preimage", ok: false });
	expect(result.crossScopePage).toMatchObject({ ok: false });
	expect(result.invalidEpochs).toHaveLength(3);
	expect(result.invalidEpochs.every((value) => value.ok === false)).toBe(true);
	expect(result.unsafeEpochUnencodable).toBe(true);
	expect(result.unsafeScopeRejected).toEqual({ kind: "malformed-input", ok: false });
	expect(result.extraRejected).toEqual({ kind: "malformed-input", ok: false });
	expect(result.hostileRejected).toEqual({ kind: "malformed-input", ok: false });
	expect(result.hostileDispatchCount).toBe(0);
});
