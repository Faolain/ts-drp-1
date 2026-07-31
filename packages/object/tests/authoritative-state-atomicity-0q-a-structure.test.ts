import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface MethodFacts {
	readonly awaitPositions: readonly number[];
	readonly calls: Set<string>;
	readonly directSharedMutation: boolean;
	readonly hasFrontierCAS: boolean;
	readonly hasJournalCommit: boolean;
	readonly hasJournalRollback: boolean;
	readonly isAsync: boolean;
	readonly journalLifetimes: readonly JournalLifetime[];
	readonly name: string;
}

interface JournalLifetime {
	readonly closurePositions: number[];
	readonly constructionPosition: number;
}

const sourcePath = new URL("../src/drp-applier.ts", import.meta.url);
const sourceText = readFileSync(sourcePath, "utf8");
const sourceFile = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function methodName(node: ts.MethodDeclaration): string | undefined {
	return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
}

function isThisExpression(node: ts.Node): boolean {
	return node.kind === ts.SyntaxKind.ThisKeyword;
}

function calledName(node: ts.CallExpression): string | undefined {
	if (ts.isIdentifier(node.expression)) return node.expression.text;
	if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
	if (isThisExpression(node.expression.expression)) return node.expression.name.text;
	return node.expression.name.text;
}

function nodeContains(node: ts.Node, predicate: (candidate: ts.Node) => boolean): boolean {
	if (predicate(node)) return true;
	let found = false;
	ts.forEachChild(node, (child) => {
		if (!found && nodeContains(child, predicate)) found = true;
	});
	return found;
}

function isFrontierRead(node: ts.Node, frontierVariables: ReadonlySet<string>): boolean {
	if (ts.isIdentifier(node) && frontierVariables.has(node.text)) return true;
	return ts.isCallExpression(node) && calledName(node) === "getFrontier";
}

function isExpectedFrontierReference(node: ts.Node): boolean {
	return ts.isIdentifier(node) && node.text === "expectedFrontier";
}

function collectMethodFacts(): Map<string, MethodFacts> {
	const methods = new Map<string, MethodFacts>();
	const sharedPrimitiveCalls = new Set([
		"addVertex",
		"advanceCheckpointIfNeeded",
		"deleteACLState",
		"deleteDRPState",
		"enqueueNotification",
		"initializeState",
		"prune",
		"replaceEnumerableState",
		"setACLState",
		"setDRPState",
	]);

	const visitClass = (node: ts.Node): void => {
		if (ts.isClassDeclaration(node) && node.name?.text === "DRPVertexApplier") {
			for (const member of node.members) {
				if (!ts.isMethodDeclaration(member) || !member.body) continue;
				const name = methodName(member);
				if (!name) continue;
				const calls = new Set<string>();
				let directSharedMutation = false;
				const awaitPositions: number[] = [];
				const frontierVariables = new Set<string>();
				let hasFrontierCAS = false;
				let hasJournalCommit = false;
				let hasJournalRollback = false;
				const journals = new Map<string, JournalLifetime>();
				const inspect = (child: ts.Node): void => {
					if (ts.isAwaitExpression(child)) awaitPositions.push(child.getStart(sourceFile));
					if (
						ts.isVariableDeclaration(child) &&
						ts.isIdentifier(child.name) &&
						child.initializer &&
						ts.isNewExpression(child.initializer) &&
						ts.isIdentifier(child.initializer.expression) &&
						child.initializer.expression.text === "UndoJournal"
					) {
						journals.set(child.name.text, {
							closurePositions: [],
							constructionPosition: child.initializer.getStart(sourceFile),
						});
					}
					if (
						ts.isVariableDeclaration(child) &&
						ts.isIdentifier(child.name) &&
						child.initializer &&
						nodeContains(child.initializer, (candidate) => isFrontierRead(candidate, frontierVariables))
					) {
						frontierVariables.add(child.name.text);
					}
					if (ts.isCallExpression(child)) {
						const call = calledName(child);
						if (call) calls.add(call);
						if (call && sharedPrimitiveCalls.has(call)) directSharedMutation = true;
						if (call === "sameHashes" && child.arguments.length === 2) {
							const [left, right] = child.arguments;
							hasFrontierCAS =
								hasFrontierCAS ||
								(nodeContains(left, (candidate) => isFrontierRead(candidate, frontierVariables)) &&
									nodeContains(right, isExpectedFrontierReference)) ||
								(nodeContains(right, (candidate) => isFrontierRead(candidate, frontierVariables)) &&
									nodeContains(left, isExpectedFrontierReference));
						}
						if (
							(call === "commit" || call === "rollback") &&
							ts.isPropertyAccessExpression(child.expression) &&
							ts.isIdentifier(child.expression.expression)
						) {
							const journal = journals.get(child.expression.expression.text);
							if (journal) {
								journal.closurePositions.push(child.getStart(sourceFile));
								if (call === "commit") hasJournalCommit = true;
								else hasJournalRollback = true;
							}
						}
					}
					if (
						ts.isBinaryExpression(child) &&
						child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
						child.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
						ts.isPropertyAccessExpression(child.left) &&
						isThisExpression(child.left.expression) &&
						["checkpoints", "hasUnreconciledLiveState"].includes(child.left.name.text)
					) {
						directSharedMutation = true;
					}
					ts.forEachChild(child, inspect);
				};
				inspect(member.body);
				methods.set(name, {
					awaitPositions,
					calls,
					directSharedMutation,
					hasFrontierCAS,
					hasJournalCommit,
					hasJournalRollback,
					isAsync: member.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) ?? false,
					journalLifetimes: [...journals.values()],
					name,
				});
			}
			return;
		}
		ts.forEachChild(node, visitClass);
	};
	visitClass(sourceFile);
	return methods;
}

function callFnPipelineHandlers(): string[] {
	const handlers: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "callFnPipeline" &&
			node.initializer
		) {
			const visitInitializer = (candidate: ts.Node): void => {
				if (
					ts.isCallExpression(candidate) &&
					ts.isPropertyAccessExpression(candidate.expression) &&
					candidate.expression.name.text === "setNext"
				) {
					const argument = candidate.arguments[0];
					if (
						argument &&
						ts.isCallExpression(argument) &&
						ts.isPropertyAccessExpression(argument.expression) &&
						argument.expression.name.text === "bind" &&
						ts.isPropertyAccessExpression(argument.expression.expression) &&
						isThisExpression(argument.expression.expression.expression)
					) {
						handlers.push(argument.expression.expression.name.text);
					}
				}
				ts.forEachChild(candidate, visitInitializer);
			};
			visitInitializer(node.initializer);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return handlers.reverse();
}

function hasSharedMutation(
	name: string,
	methods: ReadonlyMap<string, MethodFacts>,
	visiting = new Set<string>()
): boolean {
	if (visiting.has(name)) return false;
	const method = methods.get(name);
	if (!method) return false;
	if (method.directSharedMutation) return true;
	const nextVisiting = new Set(visiting);
	nextVisiting.add(name);
	return [...method.calls].some((called) => hasSharedMutation(called, methods, nextVisiting));
}

function isSynchronousGuardedCommit(method: MethodFacts): boolean {
	return (
		!method.isAsync &&
		method.awaitPositions.length === 0 &&
		method.hasFrontierCAS &&
		method.journalLifetimes.length > 0 &&
		method.hasJournalCommit &&
		method.hasJournalRollback
	);
}

function journalLifetimeCrossesAwait(method: MethodFacts): boolean {
	return method.journalLifetimes.some(({ closurePositions, constructionPosition }) => {
		const finalClosure = Math.max(...closurePositions.filter((position) => position > constructionPosition));
		return method.awaitPositions.some(
			(awaitPosition) => awaitPosition > constructionPosition && awaitPosition < finalClosure
		);
	});
}

function journalsAreClosed(method: MethodFacts): boolean {
	return method.journalLifetimes.every(({ closurePositions, constructionPosition }) =>
		closurePositions.some((position) => position > constructionPosition)
	);
}

describe("Phase 0q-a structural commit gate", () => {
	it("keeps every UndoJournal lifetime inside a non-suspending function", () => {
		const methods = collectMethodFacts();
		const journalOwners = [...methods.values()].filter(({ journalLifetimes }) => journalLifetimes.length > 0);

		expect(
			journalOwners.map((method) => ({
				journalsAreClosed: journalsAreClosed(method),
				journalLifetimeCrossesAwait: journalLifetimeCrossesAwait(method),
				name: method.name,
			})),
			"rollback authority must be born, used and closed without crossing an await"
		).toEqual(
			journalOwners.map(({ name }) => ({
				journalsAreClosed: true,
				journalLifetimeCrossesAwait: false,
				name,
			}))
		);
	});

	it("routes post-suspension local publication through one CAS-guarded synchronous journal owner", () => {
		const methods = collectMethodFacts();
		const handlers = callFnPipelineHandlers();
		const suspensionIndex = handlers.indexOf("applyFn");
		expect(suspensionIndex, "the gate must find the async-capable blueprint application seam").toBeGreaterThanOrEqual(
			0
		);

		const postSuspensionPublishers = handlers
			.slice(suspensionIndex + 1)
			.filter((name) => hasSharedMutation(name, methods))
			.map((name) => methods.get(name))
			.filter((method): method is MethodFacts => method !== undefined);
		const unguardedPublishers = postSuspensionPublishers
			.filter((method) => !isSynchronousGuardedCommit(method))
			.map(({ name }) => name);

		expect(
			{
				guardedPublisherCount: postSuspensionPublishers.filter(isSynchronousGuardedCommit).length,
				unguardedPublishers,
			},
			"async callFn publication must cross exactly one synchronous owner that contains frontier CAS and the complete journal lifetime"
		).toEqual({
			guardedPublisherCount: 1,
			unguardedPublishers: [],
		});
	});
});
