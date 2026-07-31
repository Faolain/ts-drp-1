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
	readonly hasPipelineStageShape: boolean;
	readonly isAsync: boolean;
	readonly isPrivate: boolean;
	readonly journalLifetimes: readonly JournalLifetime[];
	readonly name: string;
}

interface JournalLifetime {
	readonly closurePositions: number[];
	readonly constructionPosition: number;
}

interface MutationHelperFacts {
	readonly calls: Set<string>;
	readonly directPostCommitBookkeeping: boolean;
	readonly directSharedMutation: boolean;
	readonly hasOwnAwait: boolean;
	readonly hasMandatoryRollbackAuthority: boolean;
	readonly isAsync: boolean;
	readonly journalGuards: readonly string[];
	readonly ownsSynchronousRollbackAuthority: boolean;
	readonly optionalJournalAccesses: readonly string[];
	readonly optionalJournalParameters: readonly string[];
	readonly name: string;
}

interface RollbackAuthorityViolation {
	readonly name: string;
	readonly reason: "missing mandatory rollback authority" | "suspends while holding rollback authority";
}

const sourcePath = new URL("../src/drp-applier.ts", import.meta.url);
const sourceText = readFileSync(sourcePath, "utf8");
const sourceFile = ts.createSourceFile(sourcePath.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function parseSource(name: string, text: string): ts.SourceFile {
	return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function methodName(node: ts.MethodDeclaration): string | undefined {
	return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
}

function isThisExpression(node: ts.Node): boolean {
	return node.kind === ts.SyntaxKind.ThisKeyword;
}

function calledName(node: ts.CallExpression): string | undefined {
	if (ts.isIdentifier(node.expression)) return node.expression.text;
	if (
		ts.isElementAccessExpression(node.expression) &&
		node.expression.argumentExpression &&
		ts.isStringLiteral(node.expression.argumentExpression)
	) {
		return node.expression.argumentExpression.text;
	}
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function hasPipelineStageShape(node: ts.MethodDeclaration, input: ts.SourceFile): boolean {
	if (!node.type) return false;
	const parameterTypes = new Set(
		node.parameters.flatMap((parameter) => (parameter.type ? [parameter.type.getText(input)] : []))
	);
	let matchingReturn = false;
	const visit = (candidate: ts.Node): void => {
		if (
			ts.isTypeReferenceNode(candidate) &&
			ts.isIdentifier(candidate.typeName) &&
			candidate.typeName.text === "HandlerReturn" &&
			candidate.typeArguments?.length === 1 &&
			parameterTypes.has(candidate.typeArguments[0].getText(input))
		) {
			matchingReturn = true;
			return;
		}
		ts.forEachChild(candidate, visit);
	};
	visit(node.type);
	return matchingReturn;
}

function collectMethodFacts(input: ts.SourceFile = sourceFile): Map<string, MethodFacts> {
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
					if (ts.isAwaitExpression(child)) awaitPositions.push(child.getStart(input));
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
							constructionPosition: child.initializer.getStart(input),
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
								journal.closurePositions.push(child.getStart(input));
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
					hasPipelineStageShape: hasPipelineStageShape(member, input),
					isAsync: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
					isPrivate: hasModifier(member, ts.SyntaxKind.PrivateKeyword),
					journalLifetimes: [...journals.values()],
					name,
				});
			}
			return;
		}
		ts.forEachChild(node, visitClass);
	};
	visitClass(input);
	return methods;
}

function boundThisMethod(node: ts.Expression | undefined): string | undefined {
	if (
		!node ||
		!ts.isCallExpression(node) ||
		!ts.isPropertyAccessExpression(node.expression) ||
		node.expression.name.text !== "bind" ||
		!ts.isPropertyAccessExpression(node.expression.expression) ||
		!isThisExpression(node.expression.expression.expression)
	) {
		return undefined;
	}
	return node.expression.expression.name.text;
}

function productionPipelineHandlers(input: ts.SourceFile = sourceFile): Set<string> {
	const handlers = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const isPipelineRegistration =
				(ts.isIdentifier(node.expression) && node.expression.text === "createPipeline") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setNext");
			if (isPipelineRegistration) {
				const handler = boundThisMethod(node.arguments[0]);
				if (handler) handlers.add(handler);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(input);
	return handlers;
}

function pipelineHandlersForVariable(variableName: string, input: ts.SourceFile = sourceFile): string[] {
	const handlers: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === variableName &&
			node.initializer
		) {
			const visitInitializer = (candidate: ts.Node): void => {
				if (
					ts.isCallExpression(candidate) &&
					((ts.isIdentifier(candidate.expression) && candidate.expression.text === "createPipeline") ||
						(ts.isPropertyAccessExpression(candidate.expression) && candidate.expression.name.text === "setNext"))
				) {
					const handler = boundThisMethod(candidate.arguments[0]);
					if (handler) handlers.push(handler);
				}
				ts.forEachChild(candidate, visitInitializer);
			};
			visitInitializer(node.initializer);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(input);
	return handlers.reverse();
}

function unreachablePipelineStages(input: ts.SourceFile = sourceFile): {
	candidateCount: number;
	registeredCandidateCount: number;
	unreachable: string[];
} {
	const methods = collectMethodFacts(input);
	const handlers = productionPipelineHandlers(input);
	const candidates = [...methods.values()].filter(
		({ hasPipelineStageShape, isPrivate }) => hasPipelineStageShape && isPrivate
	);
	return {
		candidateCount: candidates.length,
		registeredCandidateCount: candidates.filter(({ name }) => handlers.has(name)).length,
		unreachable: candidates.filter(({ name }) => !handlers.has(name)).map(({ name }) => name),
	};
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

function declarationName(node: ts.FunctionDeclaration | ts.MethodDeclaration): string | undefined {
	if (!node.name || (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name))) return undefined;
	return node.name.text;
}

function isJournalName(node: ts.Node): node is ts.Identifier {
	return ts.isIdentifier(node) && node.text.toLowerCase().includes("journal");
}

function parameterIsOptional(parameter: ts.ParameterDeclaration): boolean {
	return (
		parameter.questionToken !== undefined ||
		parameter.initializer !== undefined ||
		(parameter.type !== undefined &&
			nodeContains(parameter.type, (candidate) => candidate.kind === ts.SyntaxKind.UndefinedKeyword))
	);
}

function journalAccessRoot(node: ts.Expression): ts.Identifier | undefined {
	let current = node;
	while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
	if (isJournalName(current)) return current;
	if (ts.isPropertyAccessExpression(current)) {
		if (isJournalName(current.name)) return current.name;
		return journalAccessRoot(current.expression);
	}
	if (ts.isElementAccessExpression(current)) {
		if (current.argumentExpression && isJournalName(current.argumentExpression)) return current.argumentExpression;
		if (current.argumentExpression && ts.isStringLiteral(current.argumentExpression)) {
			if (current.argumentExpression.text.toLowerCase().includes("journal")) {
				return ts.factory.createIdentifier(current.argumentExpression.text);
			}
		}
		return journalAccessRoot(current.expression);
	}
	return undefined;
}

function isOptionalJournalAccess(node: ts.Node): boolean {
	return (
		(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) &&
		node.questionDotToken !== undefined &&
		journalAccessRoot(node.expression) !== undefined
	);
}

function isUndefinedLike(node: ts.Expression): boolean {
	return (
		(ts.isIdentifier(node) && node.text === "undefined") ||
		node.kind === ts.SyntaxKind.NullKeyword ||
		(ts.isStringLiteral(node) && node.text === "undefined")
	);
}

function isJournalGuardExpression(node: ts.Expression): boolean {
	if (ts.isParenthesizedExpression(node)) return isJournalGuardExpression(node.expression);
	if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
		return journalAccessRoot(node.operand) !== undefined;
	}
	if (ts.isBinaryExpression(node)) {
		if (
			[
				ts.SyntaxKind.EqualsEqualsToken,
				ts.SyntaxKind.EqualsEqualsEqualsToken,
				ts.SyntaxKind.ExclamationEqualsToken,
				ts.SyntaxKind.ExclamationEqualsEqualsToken,
			].includes(node.operatorToken.kind)
		) {
			return (
				(journalAccessRoot(node.left) !== undefined && isUndefinedLike(node.right)) ||
				(journalAccessRoot(node.right) !== undefined && isUndefinedLike(node.left))
			);
		}
		if (
			[ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
				node.operatorToken.kind
			)
		) {
			return journalAccessRoot(node.left) !== undefined;
		}
	}
	if (
		ts.isTypeOfExpression(node) ||
		ts.isPropertyAccessExpression(node) ||
		ts.isElementAccessExpression(node) ||
		ts.isIdentifier(node)
	) {
		return journalAccessRoot(node as ts.Expression) !== undefined;
	}
	return false;
}

type RollbackAuthorityTypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function typeDeclarationName(node: RollbackAuthorityTypeDeclaration): string {
	return node.name.text;
}

function entityNameText(node: ts.EntityName): string {
	return ts.isIdentifier(node) ? node.text : node.right.text;
}

function memberNameText(node: ts.NamedDeclaration): string | undefined {
	if (!node.name || (!ts.isIdentifier(node.name) && !ts.isStringLiteral(node.name))) return undefined;
	return node.name.text;
}

function membersProvideRollbackAuthority(
	members: ts.NodeArray<ts.TypeElement>,
	declarations: ReadonlyMap<string, RollbackAuthorityTypeDeclaration>,
	visiting: ReadonlySet<string>
): boolean {
	return members.some(
		(member) =>
			ts.isPropertySignature(member) &&
			member.questionToken === undefined &&
			memberNameText(member)?.toLowerCase() === "journal" &&
			member.type !== undefined &&
			typeProvidesRollbackAuthority(member.type, declarations, visiting)
	);
}

function typeProvidesRollbackAuthority(
	node: ts.TypeNode,
	declarations: ReadonlyMap<string, RollbackAuthorityTypeDeclaration>,
	visiting: ReadonlySet<string> = new Set<string>()
): boolean {
	if (ts.isParenthesizedTypeNode(node)) {
		return typeProvidesRollbackAuthority(node.type, declarations, visiting);
	}
	if (ts.isUnionTypeNode(node)) {
		return (
			node.types.length > 0 && node.types.every((type) => typeProvidesRollbackAuthority(type, declarations, visiting))
		);
	}
	if (ts.isIntersectionTypeNode(node)) {
		return node.types.some((type) => typeProvidesRollbackAuthority(type, declarations, visiting));
	}
	if (ts.isTypeLiteralNode(node)) {
		return membersProvideRollbackAuthority(node.members, declarations, visiting);
	}
	if (!ts.isTypeReferenceNode(node)) return false;

	const name = entityNameText(node.typeName);
	if (name === "OperationJournal") return true;
	if (visiting.has(name)) return false;
	const declaration = declarations.get(name);
	if (!declaration) return false;

	const nextVisiting = new Set(visiting);
	nextVisiting.add(name);
	if (ts.isTypeAliasDeclaration(declaration)) {
		return typeProvidesRollbackAuthority(declaration.type, declarations, nextVisiting);
	}
	if (membersProvideRollbackAuthority(declaration.members, declarations, nextVisiting)) return true;
	return (
		declaration.heritageClauses?.some((clause) =>
			clause.types.some((heritageType) =>
				typeProvidesRollbackAuthority(
					ts.factory.createTypeReferenceNode(heritageType.expression.getText(), heritageType.typeArguments),
					declarations,
					nextVisiting
				)
			)
		) ?? false
	);
}

function hasOwnAwait(declaration: ts.FunctionDeclaration | ts.MethodDeclaration): boolean {
	if (!declaration.body) return false;
	let found = false;
	const inspect = (node: ts.Node): void => {
		if (found || (node !== declaration.body && ts.isFunctionLike(node))) return;
		if (ts.isAwaitExpression(node)) {
			found = true;
			return;
		}
		ts.forEachChild(node, inspect);
	};
	inspect(declaration.body);
	return found;
}

function ownsSynchronousRollbackAuthority(declaration: ts.FunctionDeclaration | ts.MethodDeclaration): boolean {
	if (!declaration.body || hasModifier(declaration, ts.SyntaxKind.AsyncKeyword)) return false;
	const journalClosures = new Map<string, Set<"commit" | "rollback">>();
	const inspect = (node: ts.Node): void => {
		if (node !== declaration.body && ts.isFunctionLike(node)) return;
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isNewExpression(node.initializer) &&
			ts.isIdentifier(node.initializer.expression) &&
			node.initializer.expression.text === "UndoJournal"
		) {
			journalClosures.set(node.name.text, new Set());
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			(node.expression.name.text === "commit" || node.expression.name.text === "rollback")
		) {
			journalClosures.get(node.expression.expression.text)?.add(node.expression.name.text as "commit" | "rollback");
		}
		ts.forEachChild(node, inspect);
	};
	inspect(declaration.body);
	return (
		!hasOwnAwait(declaration) &&
		[...journalClosures.values()].some((closures) => closures.has("commit") && closures.has("rollback"))
	);
}

function collectMutationHelperFacts(input: ts.SourceFile = sourceFile): Map<string, MutationHelperFacts> {
	const helpers = new Map<string, MutationHelperFacts>();
	const rollbackAuthorityTypes = new Map<string, RollbackAuthorityTypeDeclaration>();
	const collectRollbackAuthorityTypes = (node: ts.Node): void => {
		if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
			rollbackAuthorityTypes.set(typeDeclarationName(node), node);
		}
		ts.forEachChild(node, collectRollbackAuthorityTypes);
	};
	collectRollbackAuthorityTypes(input);

	const declaredHelpers = new Set<string>();
	for (const statement of input.statements) {
		if (ts.isFunctionDeclaration(statement)) {
			const name = declarationName(statement);
			if (name) declaredHelpers.add(name);
		}
		if (ts.isClassDeclaration(statement) && statement.name?.text === "DRPVertexApplier") {
			for (const member of statement.members) {
				if (!ts.isMethodDeclaration(member)) continue;
				const name = declarationName(member);
				if (name) declaredHelpers.add(name);
			}
		}
	}

	const canonicalStateRoots = new Set(["checkpoints", "finalityStore", "hashGraph", "states"]);
	const mutationVerb =
		/^(?:add|advance|assign|clear|delete|initialize|insert|pop|prune|push|remove|replace|restore|set|shift|splice|unshift|update)/;
	const postCommitBookkeepingCalls = new Set(["enqueueNotification", "rememberInvalidVertexHash"]);
	const thisOwnedRoot = (node: ts.Expression): string | undefined => {
		let current = node;
		while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
			const propertyName = ts.isPropertyAccessExpression(current)
				? current.name.text
				: ts.isStringLiteral(current.argumentExpression)
					? current.argumentExpression.text
					: undefined;
			if (isThisExpression(current.expression)) return propertyName;
			current = current.expression;
		}
		return undefined;
	};
	const isPostCommitBookkeepingMutation = (node: ts.CallExpression): boolean => {
		const call = calledName(node);
		if (call && postCommitBookkeepingCalls.has(call)) return true;
		if (!ts.isPropertyAccessExpression(node.expression)) return false;
		const receiver = node.expression.expression;
		return (
			ts.isPropertyAccessExpression(receiver) &&
			isThisExpression(receiver.expression) &&
			["knownInvalidVertexHashes", "notificationQueue"].includes(receiver.name.text)
		);
	};
	const isDirectCanonicalMutation = (node: ts.CallExpression): boolean => {
		const call = calledName(node);
		if (!call || !mutationVerb.test(call)) return false;
		if (ts.isIdentifier(node.expression)) return !declaredHelpers.has(call);
		if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) {
			return false;
		}
		const receiver = node.expression.expression;
		if (
			ts.isIdentifier(receiver) &&
			receiver.text === "Reflect" &&
			["defineProperty", "deleteProperty", "set"].includes(call)
		) {
			return true;
		}
		const root = thisOwnedRoot(receiver);
		return root !== undefined && canonicalStateRoots.has(root);
	};

	const collect = (declaration: ts.FunctionDeclaration | ts.MethodDeclaration): void => {
		const name = declarationName(declaration);
		if (!name || !declaration.body) return;
		const calls = new Set<string>();
		let directPostCommitBookkeeping = false;
		let directSharedMutation = false;
		const journalGuards: string[] = [];
		const optionalJournalAccesses: string[] = [];
		const optionalJournalParameters = declaration.parameters
			.filter((parameter) => isJournalName(parameter.name) && parameterIsOptional(parameter))
			.map((parameter) => parameter.name.getText(input));
		const hasMandatoryRollbackAuthority = declaration.parameters.some(
			(parameter) =>
				!parameterIsOptional(parameter) &&
				parameter.type !== undefined &&
				typeProvidesRollbackAuthority(parameter.type, rollbackAuthorityTypes)
		);
		const inspect = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const call = calledName(node);
				if (call) calls.add(call);
				if (isDirectCanonicalMutation(node)) directSharedMutation = true;
				if (isPostCommitBookkeepingMutation(node)) directPostCommitBookkeeping = true;
			}
			if (isOptionalJournalAccess(node)) optionalJournalAccesses.push(node.getText(input));
			if (ts.isIfStatement(node) && isJournalGuardExpression(node.expression)) {
				journalGuards.push(node.expression.getText(input));
			}
			if (ts.isConditionalExpression(node) && isJournalGuardExpression(node.condition)) {
				journalGuards.push(node.condition.getText(input));
			}
			if (
				ts.isBinaryExpression(node) &&
				[
					ts.SyntaxKind.AmpersandAmpersandToken,
					ts.SyntaxKind.BarBarToken,
					ts.SyntaxKind.QuestionQuestionToken,
				].includes(node.operatorToken.kind) &&
				isJournalGuardExpression(node)
			) {
				journalGuards.push(node.getText(input));
			}
			ts.forEachChild(node, inspect);
		};
		inspect(declaration.body);
		helpers.set(name, {
			calls,
			directPostCommitBookkeeping,
			directSharedMutation,
			hasOwnAwait: hasOwnAwait(declaration),
			hasMandatoryRollbackAuthority,
			isAsync: hasModifier(declaration, ts.SyntaxKind.AsyncKeyword),
			journalGuards,
			name,
			ownsSynchronousRollbackAuthority: ownsSynchronousRollbackAuthority(declaration),
			optionalJournalAccesses,
			optionalJournalParameters,
		});
	};

	for (const statement of input.statements) {
		if (ts.isFunctionDeclaration(statement)) collect(statement);
		if (ts.isClassDeclaration(statement) && statement.name?.text === "DRPVertexApplier") {
			for (const member of statement.members) {
				if (ts.isMethodDeclaration(member)) collect(member);
			}
		}
	}

	const authoritative = new Map<string, MutationHelperFacts>();
	const mutates = (name: string, visiting = new Set<string>()): boolean => {
		if (visiting.has(name)) return false;
		const helper = helpers.get(name);
		if (!helper) return false;
		if (helper.directSharedMutation) return true;
		const nextVisiting = new Set(visiting);
		nextVisiting.add(name);
		return [...helper.calls].some((called) => mutates(called, nextVisiting));
	};
	for (const [name, helper] of helpers) {
		if (mutates(name)) authoritative.set(name, helper);
	}
	return authoritative;
}

function rollbackAuthorityViolations(input: ts.SourceFile = sourceFile): RollbackAuthorityViolation[] {
	return [...collectMutationHelperFacts(input).values()]
		.flatMap(
			({
				directSharedMutation,
				hasMandatoryRollbackAuthority,
				hasOwnAwait,
				isAsync,
				name,
				ownsSynchronousRollbackAuthority,
			}): RollbackAuthorityViolation[] => {
				if (!directSharedMutation) return [];
				if (hasMandatoryRollbackAuthority && (isAsync || hasOwnAwait)) {
					return [{ name, reason: "suspends while holding rollback authority" }];
				}
				if (!hasMandatoryRollbackAuthority && !ownsSynchronousRollbackAuthority) {
					return [{ name, reason: "missing mandatory rollback authority" }];
				}
				return [];
			}
		)
		.sort((left, right) => left.name.localeCompare(right.name));
}

describe("Phase 0q-a structural commit gate", () => {
	it("registers every private pass-through HandlerReturn-shaped stage in a production pipeline", () => {
		const handlers = productionPipelineHandlers();
		const { candidateCount, registeredCandidateCount, unreachable } = unreachablePipelineStages();

		expect(handlers.size, "positive control: production must contain extracted pipeline registrations").toBeGreaterThan(
			0
		);
		expect(
			candidateCount,
			"positive control: production must contain private HandlerReturn-shaped stages"
		).toBeGreaterThan(0);
		expect(
			registeredCandidateCount,
			"positive control: at least one HandlerReturn-shaped private method must be a real pipeline stage"
		).toBeGreaterThan(0);
		expect(
			unreachable,
			"pipeline-shaped private methods must not survive solely as direct-call compatibility helpers"
		).toEqual([]);
	});

	it("requires journal parameters on authoritative mutation helpers", () => {
		const helpers = [...collectMutationHelperFacts().values()];
		expect(helpers.length, "positive control: the gate must discover authoritative mutation helpers").toBeGreaterThan(
			0
		);

		expect(
			rollbackAuthorityViolations(),
			"authoritative mutation helpers must not make rollback authority optional, undefined or defaultable"
		).toEqual([]);
	});

	it("reports direct canonical mutation without mandatory rollback authority", () => {
		const control = parseSource(
			"synthetic-mandatory-rollback-authority.ts",
			`
				interface OperationJournal {
					record(undo: () => void): void;
				}
				interface JournaledOperation {
					journal: OperationJournal;
				}
				interface CommitOperation extends JournaledOperation {}
				interface Transaction {
					commit(): void;
					rollback(): void;
				}
				class UndoJournal implements OperationJournal {
					record(_undo: () => void): void {}
					commit(): void {}
					rollback(): void {}
				}
				function optionalAuthority(journal?: OperationJournal): void {
					setACLState();
				}
				function requiredJournal(_journal: OperationJournal): void {
					setACLState();
				}
				function requiredJournaledOperation(_operation: JournaledOperation): void {
					setACLState();
				}
				function requiredCommitOperation(_operation: CommitOperation): void {
					setACLState();
				}
				function updateState(_journal: OperationJournal): void {
					setACLState();
				}
				function transitiveCaller(): void {
					updateState({} as OperationJournal);
				}
				function unrelatedTransaction(_transaction: Transaction): void {
					setACLState();
				}
				class DRPVertexApplier {
					private missingAuthority(): void {
						this.states["setACLState"]();
					}
					private synchronousJournalOwner(): void {
						const journal = new UndoJournal();
						try {
							setACLState();
							journal.commit();
							this.knownInvalidVertexHashes.delete("committed");
							this.notificationQueue.push("committed");
						} catch (error) {
							journal.rollback();
							throw error;
						}
					}
					private deferredJournalOwner(): void {
						const journal = new UndoJournal();
						setACLState();
						void Promise.resolve().then(
							() => journal.commit(),
							() => journal.rollback()
						);
					}
					private postCommitBookkeeping(): void {
						this.knownInvalidVertexHashes.delete("committed");
						this.notificationQueue.push("committed");
					}
				}
			`
		);
		const helpers = collectMutationHelperFacts(control);

		expect(
			{
				postCommitBookkeepingIsAuthoritative: helpers.has("postCommitBookkeeping"),
				requiredCommitOperationHasAuthority: helpers.get("requiredCommitOperation")?.hasMandatoryRollbackAuthority,
				requiredJournalHasAuthority: helpers.get("requiredJournal")?.hasMandatoryRollbackAuthority,
				requiredJournaledOperationHasAuthority:
					helpers.get("requiredJournaledOperation")?.hasMandatoryRollbackAuthority,
				synchronousOwnerBookkeepingClassified: helpers.get("synchronousJournalOwner")?.directPostCommitBookkeeping,
				synchronousOwnerOwnsAuthority: helpers.get("synchronousJournalOwner")?.ownsSynchronousRollbackAuthority,
				transitiveCallerIsDirect: helpers.get("transitiveCaller")?.directSharedMutation,
			},
			"known-invalid and notification bookkeeping are post-commit effects, not authoritative canonical state"
		).toEqual({
			postCommitBookkeepingIsAuthoritative: false,
			requiredCommitOperationHasAuthority: true,
			requiredJournalHasAuthority: true,
			requiredJournaledOperationHasAuthority: true,
			synchronousOwnerBookkeepingClassified: true,
			synchronousOwnerOwnsAuthority: true,
			transitiveCallerIsDirect: false,
		});
		expect(
			rollbackAuthorityViolations(control),
			"every direct authoritative mutator needs a required OperationJournal or journal-bearing operation, unless it synchronously owns construction, commit and rollback"
		).toEqual([
			{ name: "deferredJournalOwner", reason: "missing mandatory rollback authority" },
			{ name: "missingAuthority", reason: "missing mandatory rollback authority" },
			{ name: "optionalAuthority", reason: "missing mandatory rollback authority" },
			{ name: "unrelatedTransaction", reason: "missing mandatory rollback authority" },
		]);
	});

	it("rejects suspending authoritative helpers even with mandatory rollback authority", () => {
		const control = parseSource(
			"synthetic-suspending-rollback-authority.ts",
			`
				interface OperationJournal {
					record(undo: () => void): void;
				}
				interface JournaledOperation {
					journal: OperationJournal;
				}
				function synchronousAuthority(operation: JournaledOperation): void {
					setACLState();
					operation.journal.record(() => {});
				}
				async function suspendsWithJournaledOperation(operation: JournaledOperation): Promise<void> {
					setACLState();
					await Promise.resolve();
					operation.journal.record(() => {});
				}
				async function asyncWithoutAwait(journal: OperationJournal): Promise<void> {
					setACLState();
					journal.record(() => {});
				}
				async function transitiveAsync(operation: JournaledOperation): Promise<void> {
					await synchronousAuthority(operation);
				}
				function nestedCallbackAwait(operation: JournaledOperation): void {
					setACLState();
					const callback = async (): Promise<void> => {
						await Promise.resolve();
						operation.journal.record(() => {});
					};
					function nestedFunction(): void {
						void callback();
					}
					void nestedFunction;
					operation.journal.record(() => {});
				}
			`
		);
		const helpers = collectMutationHelperFacts(control);

		expect({
			asyncWithoutAwait: helpers.get("asyncWithoutAwait")?.directSharedMutation,
			nestedCallbackAwait: helpers.get("nestedCallbackAwait")?.directSharedMutation,
			suspendsWithJournaledOperation: helpers.get("suspendsWithJournaledOperation")?.hasMandatoryRollbackAuthority,
			synchronousAuthority: helpers.get("synchronousAuthority")?.hasMandatoryRollbackAuthority,
			transitiveAsync: helpers.get("transitiveAsync")?.directSharedMutation,
		}).toEqual({
			asyncWithoutAwait: true,
			nestedCallbackAwait: true,
			suspendsWithJournaledOperation: true,
			synchronousAuthority: true,
			transitiveAsync: false,
		});
		expect(
			rollbackAuthorityViolations(),
			"current production authoritative helpers must remain synchronous while holding rollback authority"
		).toEqual([]);
		expect(
			rollbackAuthorityViolations(control),
			"direct authoritative mutation must not suspend while its caller-provided rollback authority is live"
		).toEqual([
			{ name: "asyncWithoutAwait", reason: "suspends while holding rollback authority" },
			{ name: "suspendsWithJournaledOperation", reason: "suspends while holding rollback authority" },
		]);
	});

	it("does not optionally record rollback for authoritative mutations", () => {
		const helpers = [...collectMutationHelperFacts().values()];
		expect(
			helpers
				.filter(({ optionalJournalAccesses }) => optionalJournalAccesses.length > 0)
				.map(({ name, optionalJournalAccesses }) => ({ name, optionalJournalAccesses })),
			"every authoritative mutation must record rollback unconditionally"
		).toEqual([]);
	});

	it("does not branch around rollback authority in shared-mutation helpers", () => {
		const helpers = [...collectMutationHelperFacts().values()];
		expect(
			helpers
				.filter(({ journalGuards }) => journalGuards.length > 0)
				.map(({ journalGuards, name }) => ({ journalGuards, name })),
			"an authoritative shared-mutation helper must not retain a journal-less branch"
		).toEqual([]);
	});

	it("proves the structural extractors against synthetic violating source", () => {
		const control = parseSource(
			"synthetic-structural-control.ts",
			`
				class UndoJournal {
					commit(): void {}
					record(_undo: () => void): void {}
				}
				function syntheticMutation(journal: OperationJournal | undefined = undefined): void {
					setACLState();
					if (!journal) return;
					journal?.record(() => {});
				}
				class DRPVertexApplier {
					constructor() {
						createPipeline(this.registered.bind(this));
					}
					private async crossesAwait(): Promise<void> {
						const journal = new UndoJournal();
						await Promise.resolve();
						journal.commit();
					}
					private leavesJournalOpen(): void {
						const journal = new UndoJournal();
						journal.record(() => {});
					}
					private registered(value: string): HandlerReturn<string> {
						return { stop: false, result: value };
					}
					private stranded(value: string): HandlerReturn<string> {
						return { stop: false, result: value };
					}
				}
			`
		);
		const methods = collectMethodFacts(control);
		const mutationHelper = collectMutationHelperFacts(control).get("syntheticMutation");
		const stages = unreachablePipelineStages(control);

		expect({
			crossesAwait: journalLifetimeCrossesAwait(methods.get("crossesAwait") as MethodFacts),
			journalGuardCount: mutationHelper?.journalGuards.length,
			journalsAreClosed: journalsAreClosed(methods.get("leavesJournalOpen") as MethodFacts),
			optionalJournalAccessCount: mutationHelper?.optionalJournalAccesses.length,
			optionalJournalParameterCount: mutationHelper?.optionalJournalParameters.length,
			pipelineCandidateCount: stages.candidateCount,
			registeredPipelineCandidateCount: stages.registeredCandidateCount,
			unreachablePipelineStageCount: stages.unreachable.length,
		}).toEqual({
			crossesAwait: true,
			journalGuardCount: 1,
			journalsAreClosed: false,
			optionalJournalAccessCount: 1,
			optionalJournalParameterCount: 1,
			pipelineCandidateCount: 2,
			registeredPipelineCandidateCount: 1,
			unreachablePipelineStageCount: 1,
		});
	});

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
		const handlers = pipelineHandlersForVariable("callFnPipeline");
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
