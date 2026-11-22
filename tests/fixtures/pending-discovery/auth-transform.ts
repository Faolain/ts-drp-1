import type { Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dirname, "../../..");
const observer = join(root, "tests/fixtures/pending-discovery/observer.ts");
const owner = join(root, "packages/node/dist/src/creator-adoption.js");
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
/**
 * Run the named pending-only fixture seam.
 * @param raw - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function transformPending(raw: string): { code: string; insertions: { offset: number; text: string }[] } {
	if (raw.includes("__pendingEvent")) throw new Error("PENDING_TRANSFORM_ALREADY_PRESENT");
	const ast = ts.createSourceFile(owner, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const functions = ast.statements.filter(
		(node): node is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(node) && node.name?.text === "authenticatePendingCandidate"
	);
	const fn = functions[0];
	if (functions.length !== 1 || fn?.body === undefined) throw new Error("PENDING_AUTH_OWNER_NOT_UNIQUE");
	const insertions = [
		{
			offset: 0,
			text:
				"import { candidate as __pendingCandidate, event as __pendingEvent, result as __pendingResult, condition as __pendingCondition, snapshot as __pendingSnapshot } from " +
				JSON.stringify(observer) +
				";\n",
		},
		{ offset: fn.body.getStart(ast) + 1, text: "\n__pendingCandidate(candidate.generationId);" },
	];
	const loaders = ast.statements.filter(
		(node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "loadClosure"
	);
	const loader = loaders[0];
	if (loaders.length !== 1 || loader?.body === undefined) throw new Error("PENDING_BLOB_LOADER_NOT_UNIQUE");
	let blobReads = 0;
	const visitLoader = (node: ts.Node): void => {
		if (ts.isIfStatement(node) && node.expression.getText(ast) === "!loaded.ok || loaded.value === null") {
			blobReads++;
			insertions.push({
				offset: node.end,
				text: '\n__pendingEvent("native-blob-integrity", {ok: digestBlob(loaded.value).value === ref.digest});',
			});
		}
		ts.forEachChild(node, visitLoader);
	};
	visitLoader(loader.body);
	if (blobReads !== 1) throw new Error("PENDING_BLOB_READ_NOT_UNIQUE");
	const sites: Record<string, string> = {
		openCurrentAnchorTrust: "genesis-trust",
		openCreatorSuccessorTrust: "successor-trust",
		openCreatorCheckpointTrust: "checkpoint-trust",
		verifySnapshot: "snapshot-result",
		verifiedCatalog: "catalog-result",
		openCanonicalLatchedAclSnapshot: "acl-result",
	};
	const counts = new Map<string, number>();
	let transitions = 0;
	let headComparisons = 0;
	let closureLoads = 0;
	const conditions: Record<string, string> = {
		"successorProjection.record.snapshotPayloadDigest !== snapshot.manifest.payloadDigest": "projection-payload",
		'hex(hashDomain("ts-drp/parameters/v3", input.exactCanonicalParametersCarrierBytes)) !== successorAnchor.parametersDigest':
			"parameters",
		"predecessorAclCandidates.length !== 1": "acl-selection",
	};
	const conditionCounts = new Map<string, number>();
	const visit = (node: ts.Node): void => {
		if (
			ts.isPrefixUnaryExpression(node) &&
			node.operator === ts.SyntaxKind.ExclamationToken &&
			ts.isCallExpression(node.operand) &&
			node.operand.expression.getText(ast) === "sameRoomHead"
		) {
			const head = node.operand.arguments[1]?.getText(ast);
			if (head !== "expectedPrevious" && head !== "expectedNext") throw new Error("PENDING_HEAD_COMPARISON_CHANGED");
			headComparisons++;
			insertions.push(
				{
					offset: node.getStart(ast),
					text:
						"__pendingCondition(" +
						JSON.stringify(head === "expectedPrevious" ? "authenticated-previous" : "authenticated-next") +
						", ",
				},
				{ offset: node.end, text: ")" }
			);
		}
		if (ts.isBinaryExpression(node)) {
			const site = conditions[node.getText(ast).replace(/\s+/gu, " ")];
			if (site !== undefined) {
				conditionCounts.set(site, (conditionCounts.get(site) ?? 0) + 1);
				insertions.push(
					{ offset: node.getStart(ast), text: "__pendingCondition(" + JSON.stringify(site) + ", " },
					{ offset: node.end, text: ")" }
				);
			}
		}
		if (ts.isCallExpression(node) && node.expression.getText(ast) === "inspectCreatorTransitionAdvance") {
			const site = ++transitions === 1 ? "pre-transition" : "settlement-repeat";
			insertions.push(
				{ offset: node.getStart(ast), text: "__pendingResult(" + JSON.stringify(site) + ", " },
				{ offset: node.end, text: ")" }
			);
		}
		if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
			if (
				node.declarationList.declarations[0]?.name.getText(ast) ===
				"[currentCandidates, proposedCandidates, candidateCandidates]"
			) {
				closureLoads++;
				insertions.push({
					offset: node.end,
					text: '\n__pendingEvent("closure-load", { ok: currentCandidates !== undefined && proposedCandidates !== undefined && candidateCandidates !== undefined });',
				});
			}

			const d = node.declarationList.declarations[0];
			const original = d?.initializer;
			const call =
				original !== undefined && (ts.isAwaitExpression(original) || ts.isYieldExpression(original))
					? original.expression
					: original;
			if (call !== undefined && ts.isCallExpression(call)) {
				const site = sites[call.expression.getText(ast)];
				if (site !== undefined) {
					counts.set(site, (counts.get(site) ?? 0) + 1);
					const name = d?.name.getText(ast);
					if (site === "snapshot-result" && name !== "snapshot") throw new Error("PENDING_VERIFIER_LOCAL_CHANGED");
					insertions.push({
						offset: node.end,
						text:
							"\n__pendingEvent(" +
							JSON.stringify(site) +
							", " +
							(site === "snapshot-result" || site === "catalog-result" ? "{ ok: " + name + " !== undefined }" : name) +
							");" +
							(site === "snapshot-result" ? "\n__pendingSnapshot(snapshot);" : ""),
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(fn.body);
	if (headComparisons !== 2 || closureLoads !== 1) throw new Error("PENDING_HEAD_OR_CLOSURE_SEAM_NOT_UNIQUE");
	for (const site of Object.values(conditions))
		if (conditionCounts.get(site) !== 1)
			throw new Error("PENDING_CONDITION_SITE_NOT_UNIQUE:" + site + ":" + conditionCounts.get(site));
	if (transitions !== 2) throw new Error("PENDING_TRANSITION_SITES_NOT_UNIQUE:" + transitions);
	for (const site of Object.values(sites))
		if (counts.get(site) !== 1) throw new Error("PENDING_AUTH_SITE_NOT_UNIQUE:" + site + ":" + counts.get(site));
	let code = raw;
	for (const insertion of [...insertions].sort((a, b) => b.offset - a.offset))
		code = code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset);
	return { code, insertions };
}
/**
 * Run the named pending-only fixture seam.
 * @param archive - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function pendingTransform(archive: string): { plugin: Plugin; finish(): unknown } {
	let receipt: unknown;
	return {
		plugin: {
			name: "pending-candidate-auth-observation",
			setup(context): void {
				context.onLoad({ filter: /creator-adoption\.js$/ }, ({ path }) => {
					if (resolve(path) !== owner) return undefined;
					if (receipt !== undefined) throw new Error("PENDING_AUTH_DUPLICATE_MODULE");
					const raw = readFileSync(path, "utf8"),
						transformed = transformPending(raw);
					mkdirSync(archive, { recursive: true });
					writeFileSync(join(archive, "raw.js"), raw, { flag: "wx" });
					writeFileSync(join(archive, "observed.js"), transformed.code, { flag: "wx" });
					receipt = {
						owner,
						rawSha256: hash(raw),
						observedSha256: hash(transformed.code),
						insertions: transformed.insertions,
						observer,
						observerSha256: hash(readFileSync(observer)),
						transformSha256: hash(readFileSync(import.meta.filename)),
					};
					writeFileSync(join(archive, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
					return { contents: transformed.code, loader: "js", resolveDir: dirname(path) };
				});
			},
		},
		finish(): unknown {
			if (receipt === undefined) throw new Error("PENDING_AUTH_MISSING_MODULE");
			return receipt;
		},
	};
}
