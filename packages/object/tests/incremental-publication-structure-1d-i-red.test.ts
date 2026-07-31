import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.resolve(TEST_DIRECTORY, "../src");
interface Sources {
	readonly state: string;
	readonly applier: string;
	readonly proxy: string;
	readonly primitive?: string;
}

function count(source: string, pattern: RegExp): number {
	return [...source.matchAll(new RegExp(pattern.source, "g"))].length;
}

function namedBodies(source: string): { name: string; text: string }[] {
	const file = ts.createSourceFile("gate.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const result: { name: string; text: string }[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isConstructorDeclaration(node) && node.body) {
			result.push({ name: "constructor", text: node.body.getText(file) });
		} else if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && node.body) {
			const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file);
			result.push({ name, text: node.body.getText(file) });
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return result;
}

function body(source: string, method: string): string {
	const file = ts.createSourceFile("gate.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isConstructorDeclaration(node) && method === "constructor" && node.body) {
			found.push(node.body.getText(file));
			return;
		}
		if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && node.body) {
			const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(file);
			if (name === method) {
				found.push(node.body.getText(file));
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found.join("\n");
}

function violations(sources: Sources): string[] {
	const problems: string[] = [];
	if (!sources.primitive) problems.push("missing trusted publication-copy primitive");
	const vertexCaller = body(sources.applier, "assignState");
	const checkpointCaller = body(sources.applier, "advanceCheckpointIfNeeded");
	for (const [name, caller] of [
		["assignState", vertexCaller],
		["advanceCheckpointIfNeeded", checkpointCaller],
	] as const) {
		if (!/publishSnapshotPair/.test(caller)) problems.push(`${name} bypasses publishSnapshotPair`);
		for (const forbidden of [
			[/\bstateFromDRP\s*\(/, "full stateFromDRP capture"],
			[/\bcloneDeep\s*\(/, "cloneDeep"],
			[/\bstructuredClone\s*\(/, "structuredClone"],
			[/JSON\.(?:parse|stringify)\s*\(/, "JSON round trip"],
			[/\bserialize(?:Value|DRPState)\s*\(/, "serialization-as-clone"],
		] as const) {
			if (forbidden[0].test(caller)) problems.push(`${name} contains ${forbidden[1]}`);
		}
	}

	if (sources.primitive) {
		if (!/clonePayload/.test(sources.primitive)) problems.push("trusted primitive omits clonePayload");
		if (!/onPublication/.test(sources.primitive)) problems.push("trusted primitive omits publication attribution");
		if (!/serializeValue\s*\([^)]*\)\.byteLength/.test(sources.primitive)) {
			problems.push("payload byte accounting is not pinned to serializeValue(value).byteLength");
		}
	}

	const allowedCloneDeep = new Set([
		"state:constructor",
		"state:fromStates",
		"state:fromHashACL",
		"state:applyState",
		"state:stateFromDRP",
		"applier:captureBatchVertexOperation",
		"applier:cloneEnumerableInstance",
		"applier:createVertex",
		"applier:callDRP",
	]);
	for (const [file, source] of [
		["state", sources.state],
		["applier", sources.applier],
		["proxy", sources.proxy],
	] as const) {
		for (const candidate of namedBodies(source)) {
			if (/\bcloneDeep\s*\(/.test(candidate.text) && !allowedCloneDeep.has(`${file}:${candidate.name}`)) {
				problems.push(`${file}:${candidate.name} relocates cloneDeep outside the allowlist`);
			}
			if (/\b(?:structuredClone|serializeValue|serializeDRPState)\s*\(/.test(candidate.text)) {
				problems.push(`${file}:${candidate.name} contains an unapproved clone mechanism`);
			}
		}
	}
	for (const candidate of namedBodies(sources.applier)) {
		if (/\bstateFromDRP\s*\(/.test(candidate.text) && candidate.name !== "computeOperationUntraced") {
			problems.push(`applier:${candidate.name} relocates full stateFromDRP capture`);
		}
	}
	return problems;
}

function currentSources(): Sources {
	const primitivePath = path.join(SOURCE_DIRECTORY, "publication-copy.ts");
	return {
		state: fs.readFileSync(path.join(SOURCE_DIRECTORY, "state.ts"), "utf8"),
		applier: fs.readFileSync(path.join(SOURCE_DIRECTORY, "drp-applier.ts"), "utf8"),
		proxy: fs.readFileSync(path.join(SOURCE_DIRECTORY, "proxy.ts"), "utf8"),
		primitive: fs.existsSync(primitivePath) ? fs.readFileSync(primitivePath, "utf8") : undefined,
	};
}

describe("Phase 1d(i) publication transitive no-bypass closure", () => {
	it("routes both governed callers through the trusted pair publisher", () => {
		expect(violations(currentSources())).toEqual([]);
	});

	it.each([
		["clone-everything-then-share", "const staged = stateFromDRP(live); publishSnapshotPair(staged);"],
		["discarded pre-copy", "const discarded = cloneDeep(value); publishSnapshotPair(value);"],
		["serialization-as-clone", "const detached = serializeValue(value); publishSnapshotPair(detached);"],
		["ordinary full fallback", "const full = stateFromDRP(live); publishSnapshotPair(full);"],
		["just-outside-counter relocation", "const relocated = structuredClone(value); publishSnapshotPair(relocated);"],
	] as const)("kills the named %s mutant", (_name, mutant) => {
		const safeCaller = "{ publishSnapshotPair(); }";
		const mutated = {
			state: "",
			proxy: "",
			primitive:
				"function clonePayload(value: unknown) { return value; } function onPublication() {} const bytes = serializeValue(value).byteLength;",
			applier: `function assignState() { ${mutant} } function advanceCheckpointIfNeeded() ${safeCaller}`,
		};
		expect(violations(mutated).length).toBeGreaterThan(0);
	});

	it("pins the exact excluded-copy-site census outside governed publication", () => {
		const sources = currentSources();
		const census = {
			stateManagerContextInitialization: count(body(sources.state, "constructor"), /\bcloneDeep\s*\(/),
			mutableReconstructionContext: count(body(sources.state, "fromStates"), /\bcloneDeep\s*\(/),
			mutableReconstructionPayload: count(body(sources.state, "applyState"), /\bcloneDeep\s*\(/),
			aclReconstructionContext: count(body(sources.state, "fromHashACL"), /\bcloneDeep\s*\(/),
			incomingOperationDetachment: count(body(sources.applier, "captureBatchVertexOperation"), /\bcloneDeep\s*\(/),
			hintedAdoptionReconstruction: count(body(sources.applier, "cloneEnumerableInstance"), /\bcloneDeep\s*\(/),
			callerOperationDetachment: count(body(sources.applier, "createVertex"), /\bcloneDeep\s*\(/),
			operationArgumentDetachment: count(body(sources.applier, "callDRP"), /\bcloneDeep\s*\(/),
			proxyBypassCopies: count(sources.proxy, /\bcloneDeep\s*\(/),
		};
		expect(census).toEqual({
			stateManagerContextInitialization: 2,
			mutableReconstructionContext: 2,
			mutableReconstructionPayload: 1,
			aclReconstructionContext: 1,
			incomingOperationDetachment: 1,
			hintedAdoptionReconstruction: 1,
			callerOperationDetachment: 1,
			operationArgumentDetachment: 1,
			proxyBypassCopies: 0,
		});
	});
});
