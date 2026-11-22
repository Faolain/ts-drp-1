import { encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import blueprintPackage from "./fixtures/phase-4a-v3/blueprint-package.json" with { type: "json" };
import contract from "./fixtures/phase-4b-v3/blueprint-snapshot-contract.json" with { type: "json" };
import { BlueprintStateMachine } from "../packages/compaction/src/blueprint-fold.js";
import {
	exportBlueprintSnapshotPayload,
	importBlueprintSnapshotPayload,
} from "../packages/compaction/src/blueprint-snapshot.js";
import { prepareBlueprintAdmission, prepareBlueprintRuntime } from "../packages/protocol-v3/src/public.js";

// The room's application state limit is a per-room authenticated parameter (owner decision 2026-11-21).
// A member that activates a snapshot-closed plane imports the signed snapshot's application state into a
// machine. That machine must take the room's limit as its state bound, so the member refuses a signed state
// above the room's limit, as the successor install already does. Before: the import bounded the state by the
// 256 MiB snapshot bound (maxSnapshotBytes), and v3-live passed no room limit.

const here = dirname(fileURLToPath(import.meta.url));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const artifactBytes = new Uint8Array(readFileSync(resolve(here, "fixtures/phase-4a-v3/application-blueprint.mjs")));
const packageBytes = encodeCanonical(blueprintPackage);
const blueprintDigest = hex(hashDomain(contract.domains.blueprint, packageBytes));
const aclBytes = encodeCanonical(contract.acl);
const DEFAULT_LIMIT = 32_768;
const ROOM_LIMIT = 131_072;

function runtime() {
	const admission = prepareBlueprintAdmission({
		canonicalBlueprintPackageBytes: packageBytes,
		expectedBlueprintDigest: blueprintDigest,
	});
	return prepareBlueprintRuntime({
		canonicalBlueprintPackageBytes: packageBytes,
		exactArtifactBytes: artifactBytes,
		expectedBlueprintDigest: blueprintDigest,
		preparedBlueprintAdmission: admission,
	});
}

/** A signed snapshot whose application state is about `bytes` canonical bytes. */
function snapshotOfState(prepared: Awaited<ReturnType<typeof runtime>>, bytes: number) {
	const map: Record<string, string> = {};
	for (let index = 0; encodeCanonical({ map, set: [], total: 1 }).byteLength < bytes; index++)
		map[`k${String(index).padStart(5, "0")}`] = "v".repeat(200);
	const stateBytes = encodeCanonical({ map, set: [], total: 1 });
	const machine = new BlueprintStateMachine({
		maxApplicationStateBytes: ROOM_LIMIT,
		exactCanonicalInitialStateBytes: stateBytes,
		expectedBlueprintDigest: blueprintDigest,
		expectedInitialStateDigest: hex(hashDomain(contract.domains.state, stateBytes)),
		preparedBlueprintRuntime: prepared,
	});
	const exported = exportBlueprintSnapshotPayload({
		anchor: contract.metadata.anchor,
		archiveIndexRoot: contract.metadata.archiveIndexRoot,
		epoch: contract.metadata.epoch,
		exactCanonicalAclBytes: aclBytes,
		machine,
		maxSnapshotBytes: contract.limits.maxSnapshotBytes,
		objectId: contract.metadata.objectId,
		schemaVersion: contract.metadata.schemaVersion,
	});
	return { exported, stateBytes: stateBytes.byteLength };
}

function importWith(
	prepared: Awaited<ReturnType<typeof runtime>>,
	exported: ReturnType<typeof snapshotOfState>["exported"],
	extra: Readonly<Record<string, unknown>>
) {
	return importBlueprintSnapshotPayload({
		exactCanonicalPayloadBytes: exported.exactCanonicalPayloadBytes,
		expectedAnchor: contract.metadata.anchor,
		expectedApplicationStateDigest: exported.applicationStateDigest,
		expectedArchiveIndexRoot: contract.metadata.archiveIndexRoot,
		expectedBlueprintDigest: blueprintDigest,
		expectedEpoch: contract.metadata.epoch,
		expectedExactCanonicalAclBytes: aclBytes,
		expectedObjectId: contract.metadata.objectId,
		expectedPayloadDigest: exported.payloadDigest,
		expectedSchemaVersion: contract.metadata.schemaVersion,
		maxSnapshotBytes: contract.limits.maxSnapshotBytes,
		preparedBlueprintRuntime: prepared,
		...extra,
	} as Parameters<typeof importBlueprintSnapshotPayload>[0]);
}

describe("a snapshot import bounds the application state by the room's limit", () => {
	it("refuses a signed state above the room's limit and takes one within it", async () => {
		const prepared = await runtime();
		const { exported, stateBytes } = snapshotOfState(prepared, 40_000);
		expect(stateBytes).toBeGreaterThan(DEFAULT_LIMIT);
		expect(stateBytes).toBeLessThan(ROOM_LIMIT);
		// A 32 KiB room: the signed 40 KB state is above its limit.
		expect(() => importWith(prepared, exported, { maxApplicationStateBytes: DEFAULT_LIMIT })).toThrow();
		// No limit given: the machine's own default (32,768), never the 256 MiB snapshot bound.
		expect(() => importWith(prepared, exported, {})).toThrow();
		// A 128 KiB room takes it, and its machine refuses growth past 128 KiB.
		const imported = importWith(prepared, exported, { maxApplicationStateBytes: ROOM_LIMIT });
		expect(imported.machine.snapshot().exactCanonicalStateBytes.byteLength).toBe(stateBytes);
	});

	it("v3-live's snapshot-closed activation hands the import the room's authenticated limit", () => {
		const path = resolve(here, "../packages/node/src/v3-live.ts");
		const tree = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const owner = tree.statements.find(
			(node): node is ts.FunctionDeclaration =>
				ts.isFunctionDeclaration(node) && node.name?.text === "importLiveSnapshotMachine"
		);
		if (owner === undefined) throw new Error("missing importLiveSnapshotMachine");
		const js = ts.transpileModule(`${owner.getText(tree)}\nreturn importLiveSnapshotMachine;`, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText;
		const inputs: Record<string, unknown>[] = [];
		const machine = {};
		const bindings = {
			latchedAclPreview: () => ({ next: { acl: true } }),
			liveSnapshotMetadata: () => ({ anchor: "a", archiveIndexRoot: "r", epoch: 2, objectId: "room" }),
			encodeCanonical: () => new Uint8Array(1),
			importBlueprintSnapshotPayload: (input: Record<string, unknown>) => {
				inputs.push(input);
				return { machine };
			},
			SNAPSHOT_SCHEMA_VERSION: 1,
		};
		const importLiveSnapshotMachine = new Function(
			"bindings",
			`const {${Object.keys(bindings).join(",")}}=bindings;\n${js}`
		)(bindings) as (recovered: unknown, input: unknown) => unknown;
		const recovered = {
			authorization: { kind: "latched-acl" },
			latchedOperations: [],
			prepared: {
				provenance: { blueprintDigest: "b".repeat(64) },
				parameters: { maxApplicationStateBytes: ROOM_LIMIT, maxSnapshotBytes: 268_435_456 },
				runtime: {},
			},
		};
		const result = importLiveSnapshotMachine(recovered, {
			exactCanonicalPayloadBytes: new Uint8Array(1),
			expectedApplicationStateDigest: "d".repeat(64),
			expectedPayloadDigest: "e".repeat(64),
		});
		expect(result).toBe(machine);
		expect(inputs).toHaveLength(1);
		expect(inputs[0]!.maxApplicationStateBytes, "the room's authenticated limit").toBe(ROOM_LIMIT);
	});
});
