// Analyzer fixture only: this corpus helper is not a production substitute or acceptance gate.
import ts from "typescript";

const SHARED_RUNTIME_EXPORTS = Object.freeze([
	"LIVE_JOURNAL_DOMAINS",
	"LIVE_JOURNAL_FAILURE_KINDS",
	"captureLiveJournalInput",
	"classifyLiveJournalMutationObservation",
	"decideLiveJournalDuplicate",
	"deriveLiveJournalSnapshot",
]);
/**
 * Evaluates the bounded analyzer-only semantic-equivalence corpus.
 * @param source Fixture program source.
 * @param filename Diagnostic-only fixture name.
 * @returns Sorted analyzer findings.
 */
export function sharedDecisionViolations(source: string, filename: string): readonly string[] {
	const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const violations: string[] = [];
	const owners = new Map<string, ts.FunctionLikeDeclaration>();
	const classes = new Map<string, ts.ClassLikeDeclaration>();
	const immutableImmediateInvokers = new Map<string, ts.ArrowFunction>();
	const exportedOwners = new Set<string>();
	for (const statement of file.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
			owners.set(statement.name.text, statement);
			if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
				exportedOwners.add(statement.name.text);
			}
		} else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
			classes.set(statement.name.text, statement);
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer !== undefined &&
					(ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
				) {
					owners.set(declaration.name.text, declaration.initializer);
					if (
						(statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
						ts.isArrowFunction(declaration.initializer)
					) {
						immutableImmediateInvokers.set(declaration.name.text, declaration.initializer);
					}
					if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
						exportedOwners.add(declaration.name.text);
					}
				}
			}
		} else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
			for (const element of ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []) {
				exportedOwners.add(element.propertyName?.text ?? element.name.text);
			}
		}
	}
	const imported = file.statements.flatMap((statement) => {
		if (
			!ts.isImportDeclaration(statement) ||
			statement.moduleSpecifier.getText(file) !== '"@ts-drp/live-journal"' ||
			statement.importClause?.namedBindings === undefined
		) {
			return [];
		}
		const namedBindings = statement.importClause.namedBindings;
		if (ts.isNamespaceImport(namedBindings)) {
			return SHARED_RUNTIME_EXPORTS.filter((name) => !name.startsWith("LIVE_JOURNAL_")).map((owner) => ({
				local: namedBindings.name.text,
				namespace: true,
				owner,
			}));
		}
		return namedBindings.elements
			.filter((element) => !statement.importClause?.isTypeOnly && !element.isTypeOnly)
			.map((element) => ({
				local: element.name.text,
				namespace: false,
				owner: element.propertyName?.text ?? element.name.text,
			}));
	});
	const required = SHARED_RUNTIME_EXPORTS.filter((name) => !name.startsWith("LIVE_JOURNAL_"));
	const capabilityMethods = new Set(["installGenesis", "appendAccepted", "readiness", "readPage", "close"]);
	const reachableOwners = new Set(exportedOwners);
	const reachableCalls: ts.CallExpression[] = [];
	const enclosingFunction = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
		let owner: ts.Node | undefined = node.parent;
		while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
		return owner as ts.FunctionLikeDeclaration | undefined;
	};
	const reachableEventCallback = (callback: ts.ArrowFunction | ts.FunctionExpression): boolean => {
		const registration = callback.parent;
		if (
			!ts.isCallExpression(registration) ||
			registration.arguments[1] !== callback ||
			!ts.isPropertyAccessExpression(registration.expression) ||
			registration.expression.name.text !== "addEventListener" ||
			!ts.isStringLiteral(registration.arguments[0])
		) {
			return false;
		}
		const owner = enclosingFunction(registration);
		if (owner?.body === undefined) return false;
		const target = registration.expression.expression.getText(file);
		const eventName = registration.arguments[0].text;
		let dispatched = false;
		const visit = (node: ts.Node): void => {
			if (dispatched || node === callback) return;
			if (
				ts.isCallExpression(node) &&
				node.pos > registration.end &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.expression.getText(file) === target &&
				node.expression.name.text === "dispatchEvent" &&
				node.arguments.length === 1 &&
				ts.isNewExpression(node.arguments[0]) &&
				node.arguments[0].expression.getText(file) === "Event" &&
				ts.isStringLiteral(node.arguments[0].arguments?.[0]) &&
				node.arguments[0].arguments[0].text === eventName
			) {
				dispatched = true;
				return;
			}
			ts.forEachChild(node, visit);
		};
		visit(owner.body);
		return dispatched;
	};
	const controlsAdapterOutcome = (call: ts.CallExpression): boolean => {
		let cursor: ts.Node = call;
		while (!ts.isStatement(cursor) && cursor.parent !== undefined) {
			const parent = cursor.parent;
			if (ts.isArrowFunction(parent) && parent.body === cursor) return true;
			if (
				(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
				ts.isCallExpression(parent.parent) &&
				immediatelyInvokesCallback(parent.parent, parent)
			) {
				return controlsAdapterOutcome(parent.parent);
			}
			if (
				(ts.isIfStatement(parent) &&
					parent.expression === cursor &&
					cursor.kind !== ts.SyntaxKind.FalseKeyword &&
					cursor.kind !== ts.SyntaxKind.TrueKeyword) ||
				ts.isReturnStatement(parent)
			) {
				return true;
			}
			cursor = parent;
		}
		const assignment = call.parent;
		const binding =
			ts.isVariableDeclaration(assignment) && ts.isIdentifier(assignment.name)
				? assignment.name.text
				: ts.isBinaryExpression(assignment) &&
					  assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					  ts.isIdentifier(assignment.left)
					? assignment.left.text
					: undefined;
		if (binding === undefined) return false;
		let owner = enclosingFunction(call);
		if (
			ts.isBinaryExpression(assignment) &&
			owner !== undefined &&
			(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
			reachableEventCallback(owner)
		) {
			owner = enclosingFunction(owner);
		}
		if (owner === undefined || owner.body === undefined) return false;
		let controls = false;
		const isStaticallyDead = (node: ts.Node): boolean => {
			let child = node;
			for (let parent = node.parent; parent !== undefined && parent !== owner; parent = parent.parent) {
				if (
					ts.isIfStatement(parent) &&
					((parent.expression.kind === ts.SyntaxKind.FalseKeyword && parent.thenStatement === child) ||
						(parent.expression.kind === ts.SyntaxKind.TrueKeyword && parent.elseStatement === child))
				) {
					return true;
				}
				child = parent;
			}
			return false;
		};
		const visitUse = (node: ts.Node): void => {
			if (controls) return;
			if (node !== owner && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)))
				return;
			if (
				ts.isIdentifier(node) &&
				node.text === binding &&
				(!ts.isVariableDeclaration(assignment) || node !== assignment.name)
			) {
				if (isStaticallyDead(node)) return;
				let use: ts.Node = node;
				while (!ts.isStatement(use) && use.parent !== undefined) {
					const parent = use.parent;
					if (
						(ts.isIfStatement(parent) &&
							parent.expression === use &&
							parent.expression.kind !== ts.SyntaxKind.FalseKeyword &&
							parent.expression.kind !== ts.SyntaxKind.TrueKeyword) ||
						ts.isReturnStatement(parent)
					) {
						controls = true;
						return;
					}
					use = parent;
				}
			}
			ts.forEachChild(node, visitUse);
		};
		visitUse(owner.body);
		return controls;
	};
	const immediatelyInvokesCallback = (call: ts.CallExpression, callback: ts.Node): boolean => {
		if (!ts.isIdentifier(call.expression)) return false;
		const argumentIndex = call.arguments.findIndex((argument) => argument === callback);
		if (argumentIndex < 0) return false;
		const invoker = immutableImmediateInvokers.get(call.expression.text);
		const parameter = invoker?.parameters[argumentIndex]?.name;
		if (invoker === undefined || invoker.body === undefined || !ts.isIdentifier(parameter)) return false;
		const returned = ts.isBlock(invoker.body)
			? invoker.body.statements.length === 1 && ts.isReturnStatement(invoker.body.statements[0])
				? invoker.body.statements[0].expression
				: undefined
			: invoker.body;
		return (
			returned !== undefined &&
			ts.isCallExpression(returned) &&
			ts.isIdentifier(returned.expression) &&
			returned.expression.text === parameter.text &&
			returned.arguments.length === 0
		);
	};
	const inspectExpression = (node: ts.Node, localCalls: Set<string>): void => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
			const invoked =
				(ts.isCallExpression(node.parent) &&
					(node.parent.expression === node || immediatelyInvokesCallback(node.parent, node))) ||
				((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && reachableEventCallback(node));
			if (!invoked) return;
			if (ts.isBlock(node.body)) inspectStatements(node.body.statements, localCalls);
			else inspectExpression(node.body, localCalls);
			return;
		}
		if (ts.isCallExpression(node)) {
			reachableCalls.push(node);
			if (ts.isIdentifier(node.expression) && owners.has(node.expression.text)) localCalls.add(node.expression.text);
		}
		if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return;
		ts.forEachChild(node, (child) => inspectExpression(child, localCalls));
	};
	const inspectCapabilityFunction = (owner: ts.FunctionLikeDeclaration, localCalls: Set<string>): void => {
		if (owner.body === undefined) return;
		if (ts.isBlock(owner.body)) inspectStatements(owner.body.statements, localCalls);
		else inspectExpression(owner.body, localCalls);
	};
	const memberName = (member: ts.NamedDeclaration): string | undefined => {
		if (member.name === undefined) return undefined;
		return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
	};
	const unwrapFrozenCapability = (expression: ts.Expression): ts.Expression => {
		if (
			ts.isCallExpression(expression) &&
			expression.arguments.length === 1 &&
			ts.isPropertyAccessExpression(expression.expression) &&
			expression.expression.expression.getText(file) === "Object" &&
			expression.expression.name.text === "freeze"
		) {
			return expression.arguments[0];
		}
		return expression;
	};
	const localCapabilityOwner = (
		name: string,
		returnedExpression: ts.Expression
	): ts.FunctionLikeDeclaration | undefined => {
		let factoryNode: ts.Node | undefined = returnedExpression;
		while (factoryNode !== undefined && !ts.isFunctionLike(factoryNode)) factoryNode = factoryNode.parent;
		const factory = factoryNode as ts.FunctionLikeDeclaration | undefined;
		if (factory?.body === undefined || !ts.isBlock(factory.body)) return undefined;
		for (const statement of factory.body.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined) {
				return statement;
			}
			if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
				continue;
			}
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === name &&
					declaration.initializer !== undefined &&
					(ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
				) {
					return declaration.initializer;
				}
			}
		}
		return undefined;
	};
	const inspectReturnedCapability = (expression: ts.Expression, localCalls: Set<string>): void => {
		const capability = unwrapFrozenCapability(expression);
		if (ts.isObjectLiteralExpression(capability)) {
			const named = capability.properties.flatMap((property) => {
				const name = memberName(property);
				return name === undefined ? [] : [name];
			});
			if (
				named.length !== capabilityMethods.size ||
				named.some((name) => !capabilityMethods.has(name)) ||
				new Set(named).size !== capabilityMethods.size
			) {
				return;
			}
			for (const property of capability.properties) {
				if (ts.isMethodDeclaration(property)) {
					inspectCapabilityFunction(property, localCalls);
				} else if (
					ts.isPropertyAssignment(property) &&
					(ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))
				) {
					inspectCapabilityFunction(property.initializer, localCalls);
				} else if (ts.isShorthandPropertyAssignment(property)) {
					const owner = owners.get(property.name.text) ?? localCapabilityOwner(property.name.text, expression);
					if (owner !== undefined) inspectCapabilityFunction(owner, localCalls);
				}
			}
			return;
		}
		if (!ts.isNewExpression(capability) || !ts.isIdentifier(capability.expression)) return;
		const declaration = classes.get(capability.expression.text);
		if (declaration === undefined) return;
		const methods = declaration.members.filter(
			(member): member is ts.MethodDeclaration | ts.PropertyDeclaration =>
				(ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
				memberName(member) !== undefined &&
				capabilityMethods.has(memberName(member) ?? "")
		);
		if (new Set(methods.map((method) => memberName(method))).size !== capabilityMethods.size) return;
		for (const method of methods) {
			if (ts.isMethodDeclaration(method)) inspectCapabilityFunction(method, localCalls);
			else if (
				method.initializer !== undefined &&
				(ts.isArrowFunction(method.initializer) || ts.isFunctionExpression(method.initializer))
			) {
				inspectCapabilityFunction(method.initializer, localCalls);
			}
		}
	};
	const inspectStatement = (statement: ts.Statement, localCalls: Set<string>): boolean => {
		if (ts.isBlock(statement)) return inspectStatements(statement.statements, localCalls);
		if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
			if (statement.expression !== undefined) {
				if (ts.isReturnStatement(statement)) inspectReturnedCapability(statement.expression, localCalls);
				inspectExpression(statement.expression, localCalls);
			}
			return false;
		}
		if (ts.isIfStatement(statement)) {
			inspectExpression(statement.expression, localCalls);
			if (statement.expression.kind === ts.SyntaxKind.FalseKeyword) {
				return statement.elseStatement === undefined || inspectStatement(statement.elseStatement, localCalls);
			}
			if (statement.expression.kind === ts.SyntaxKind.TrueKeyword)
				return inspectStatement(statement.thenStatement, localCalls);
			const thenFalls = inspectStatement(statement.thenStatement, localCalls);
			const elseFalls = statement.elseStatement === undefined || inspectStatement(statement.elseStatement, localCalls);
			return thenFalls || elseFalls;
		}
		if (ts.isTryStatement(statement)) {
			const tryFalls = inspectStatement(statement.tryBlock, localCalls);
			const catchFalls =
				statement.catchClause === undefined || inspectStatement(statement.catchClause.block, localCalls);
			const finallyFalls = statement.finallyBlock === undefined || inspectStatement(statement.finallyBlock, localCalls);
			return finallyFalls && (statement.catchClause === undefined ? tryFalls : tryFalls || catchFalls);
		}
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return true;
		inspectExpression(statement, localCalls);
		return true;
	};
	function inspectStatements(statements: ts.NodeArray<ts.Statement>, localCalls: Set<string>): boolean {
		for (const statement of statements) if (!inspectStatement(statement, localCalls)) return false;
		return true;
	}
	for (const name of reachableOwners) {
		const owner = owners.get(name);
		if (owner === undefined || owner.body === undefined) continue;
		const localCalls = new Set<string>();
		if (ts.isBlock(owner.body)) inspectStatements(owner.body.statements, localCalls);
		else inspectExpression(owner.body, localCalls);
		for (const local of localCalls) reachableOwners.add(local);
	}
	for (const name of required) {
		const owner = imported.find((candidate) => candidate.owner === name);
		if (owner === undefined) {
			violations.push(`missing-import:${name}`);
			continue;
		}
		const calls = reachableCalls.filter((call) =>
			owner.namespace
				? ts.isPropertyAccessExpression(call.expression) &&
					call.expression.expression.getText(file) === owner.local &&
					call.expression.name.text === owner.owner
				: ts.isIdentifier(call.expression) && call.expression.text === owner.local
		);
		for (const call of calls) {
			if (ts.isExpressionStatement(call.parent) || ts.isVoidExpression(call.parent)) {
				violations.push(`discarded-result:${name}`);
			}
			if (!controlsAdapterOutcome(call)) violations.push(`outcome-uncontrolled:${name}`);
		}
		if (calls.length === 0) violations.push(`unreachable:${name}`);
	}
	return Object.freeze(violations.sort());
}
