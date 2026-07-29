import type { Rule, Scope } from "eslint";

const RULE_NAME = "no-ambient-in-reducer";

const messages = {
	ambientAccess: "Ambient or unresolved identifier '{{name}}' is forbidden in a consensus reducer module.",
	ambientAlias: "Alias '{{name}}' reaches forbidden ambient state in a consensus reducer module.",
	randomness: "Ambient randomness '{{name}}' is forbidden in a consensus reducer module.",
	asyncSyntax: "Async functions and await are forbidden in a consensus reducer module.",
	promiseUsage: "Promise and thenable usage are forbidden in a consensus reducer module.",
	moduleImport: "Static and dynamic imports are forbidden in a consensus reducer module.",
	dynamicCode: "Dynamic code evaluation is forbidden in a consensus reducer module.",
	moduleMutation: "Module-scoped mutable state is forbidden in a consensus reducer module.",
	mutableCapture: "Capturing a mutable module-scoped object or collection is forbidden in a consensus reducer module.",
} as const;

type MessageId = keyof typeof messages;
type AstNode = Scope.Scope["block"];
type IdentifierNode = Scope.Reference["identifier"] & { readonly parent: Rule.Node };
type MemberNode = Parameters<NonNullable<Rule.NodeListener["MemberExpression"]>>[0];
type FunctionNode =
	| Parameters<NonNullable<Rule.NodeListener["ArrowFunctionExpression"]>>[0]
	| Parameters<NonNullable<Rule.NodeListener["FunctionDeclaration"]>>[0]
	| Parameters<NonNullable<Rule.NodeListener["FunctionExpression"]>>[0];
type TypedReference = Scope.Reference & {
	readonly isTypeReference?: boolean;
	readonly isValueReference?: boolean;
};
type ValueShape =
	| { readonly kind: "array"; readonly elements: readonly ValueShape[]; readonly unknownElements: boolean }
	| { readonly kind: "mutable" }
	| {
			readonly kind: "object";
			readonly properties: ReadonlyMap<string, ValueShape>;
			readonly unknownProperties: boolean;
	  }
	| { readonly kind: "scalar" }
	| { readonly kind: "unknown" };

const AMBIENT_ROOTS = new Set(["global", "globalThis", "self", "window"]);
const PURE_IDENTIFIERS = new Set(["Infinity", "NaN", "undefined"]);
const MUTABLE_VALUE: ValueShape = { kind: "mutable" };
const SCALAR_VALUE: ValueShape = { kind: "scalar" };
const UNKNOWN_VALUE: ValueShape = { kind: "unknown" };
const RUNTIME_TRANSPARENT_EXPRESSIONS = new Set([
	"ChainExpression",
	"TSAsExpression",
	"TSInstantiationExpression",
	"TSNonNullExpression",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
]);
const PURE_MATH_MEMBERS = new Set([
	"E",
	"LN10",
	"LN2",
	"LOG10E",
	"LOG2E",
	"PI",
	"SQRT1_2",
	"SQRT2",
	"abs",
	"acos",
	"acosh",
	"asin",
	"asinh",
	"atan",
	"atan2",
	"atanh",
	"cbrt",
	"ceil",
	"clz32",
	"cos",
	"cosh",
	"exp",
	"expm1",
	"floor",
	"fround",
	"hypot",
	"imul",
	"log",
	"log10",
	"log1p",
	"log2",
	"max",
	"min",
	"pow",
	"round",
	"sign",
	"sin",
	"sinh",
	"sqrt",
	"tan",
	"tanh",
	"trunc",
]);

function staticMemberName(node: MemberNode): string | undefined {
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	if (
		node.computed &&
		node.property.type === "Literal" &&
		(typeof node.property.value === "string" || typeof node.property.value === "number")
	) {
		return String(node.property.value);
	}
	return undefined;
}

function isPossibleExpressionResult(parent: AstNode, child: AstNode): boolean {
	if (
		RUNTIME_TRANSPARENT_EXPRESSIONS.has(parent.type) &&
		(parent as AstNode & { readonly expression?: AstNode }).expression === child
	) {
		return true;
	}
	if (parent.type === "SequenceExpression") return parent.expressions.at(-1) === child;
	if (parent.type === "ConditionalExpression") return parent.consequent === child || parent.alternate === child;
	if (parent.type === "LogicalExpression") return parent.left === child || parent.right === child;
	if (parent.type === "AssignmentExpression") return parent.right === child;
	return false;
}

function isWriteTarget(node: MemberNode): boolean {
	let current: AstNode = node;
	for (;;) {
		const parent: AstNode | undefined = (current as AstNode & { readonly parent?: AstNode }).parent;
		if (parent === undefined) return false;
		if (isPossibleExpressionResult(parent, current)) {
			current = parent;
			continue;
		}
		if (parent.type === "MemberExpression" && parent.object === current) {
			current = parent;
			continue;
		}
		if (parent.type === "Property" && parent.value === current) {
			current = parent;
			continue;
		}
		if (
			parent.type === "ArrayPattern" ||
			parent.type === "ObjectPattern" ||
			(parent.type === "RestElement" && parent.argument === current) ||
			(parent.type === "AssignmentPattern" && parent.left === current)
		) {
			current = parent;
			continue;
		}
		return (
			(parent.type === "AssignmentExpression" && parent.left === current) ||
			(parent.type === "ForInStatement" && parent.left === current) ||
			(parent.type === "ForOfStatement" && parent.left === current) ||
			(parent.type === "UpdateExpression" && parent.argument === current) ||
			(parent.type === "UnaryExpression" && parent.operator === "delete" && parent.argument === current)
		);
	}
}

function variableDefinition(variable: Scope.Variable): Extract<Scope.Definition, { type: "Variable" }> | undefined {
	const definition = variable.defs[0];
	return definition?.type === "Variable" ? definition : undefined;
}

function moduleScope(globalScope: Scope.Scope): Scope.Scope | undefined {
	return globalScope.childScopes.find((scope) => scope.type === "module");
}

function unwrapExpression(node: AstNode | null | undefined): AstNode | undefined {
	let current = node;
	while (current !== null && current !== undefined) {
		const typedNode = current as unknown as { readonly expression?: AstNode; readonly type: string };
		if (!RUNTIME_TRANSPARENT_EXPRESSIONS.has(typedNode.type)) {
			return current;
		}
		current = typedNode.expression;
	}
	return undefined;
}

function bindingIdentifiers(node: AstNode): readonly IdentifierNode[] {
	if (node.type === "Identifier") return [node as IdentifierNode];

	const identifiers: IdentifierNode[] = [];
	if (node.type === "AssignmentPattern") return bindingIdentifiers(node.left);
	if (node.type === "RestElement") return bindingIdentifiers(node.argument);
	if (node.type === "ArrayPattern") {
		for (const element of node.elements) {
			if (element !== null) identifiers.push(...bindingIdentifiers(element));
		}
		return identifiers;
	}
	if (node.type === "ObjectPattern") {
		for (const property of node.properties) {
			if (property.type === "RestElement") {
				identifiers.push(...bindingIdentifiers(property.argument));
			} else {
				identifiers.push(...bindingIdentifiers(property.value));
			}
		}
	}
	return identifiers;
}

function isRuntimeReference(reference: Scope.Reference): boolean {
	return (reference as TypedReference).isValueReference !== false;
}

function crossesFunctionScope(reference: Scope.Reference, module: Scope.Scope): boolean {
	for (let scope: Scope.Scope | null = reference.from; scope !== null && scope !== module; scope = scope.upper) {
		const scopeType: string = scope.type;
		if (
			scopeType === "class-field-initializer" ||
			scopeType === "function" ||
			scopeType === "function-expression-name"
		) {
			return true;
		}
	}
	return false;
}

function outerMemberWrite(identifier: IdentifierNode): MemberNode | undefined {
	const member = memberFromBinding(identifier);
	return member !== undefined && isWriteTarget(member) ? member : undefined;
}

function memberFromBinding(identifier: IdentifierNode): MemberNode | undefined {
	let current: AstNode = identifier;
	for (;;) {
		const parent: AstNode | undefined = (current as AstNode & { readonly parent?: AstNode }).parent;
		if (parent === undefined) return undefined;
		if (isPossibleExpressionResult(parent, current)) {
			current = parent;
			continue;
		}
		if (parent.type === "MemberExpression" && parent.object === current) return parent as MemberNode;
		return undefined;
	}
}

function isDeclaredValue(variable: Scope.Variable): boolean {
	return variable.defs.some((definition) => {
		const definitionType: string = definition.type;
		if (definitionType === "Type") return false;
		const node = definition.node as AstNode & { readonly declare?: boolean; readonly type: string };
		const parent = definition.parent as (AstNode & { readonly declare?: boolean }) | null;
		return node.declare === true || parent?.declare === true || node.type.startsWith("TSDeclare");
	});
}

function createRule(): Rule.RuleModule {
	return {
		meta: {
			docs: {
				description: "Forbid ambient state and mutable module captures in designated consensus reducer modules.",
			},
			messages,
			schema: [],
			type: "problem",
		},
		create(context): Rule.NodeListener {
			const sourceCode = context.sourceCode;
			const ambientAliasNames = new Set<string>();
			const handledAmbientIdentifiers = new Set<AstNode>();
			const randomMembers: MemberNode[] = [];
			const reportedNodes = new Set<AstNode>();

			function report(node: AstNode, messageId: MessageId, data?: Readonly<Record<string, string>>): void {
				if (reportedNodes.has(node)) return;
				reportedNodes.add(node);
				context.report({ data, messageId, node });
			}

			function inspectAsyncFunction(node: FunctionNode): void {
				if (node.async) report(node, "asyncSyntax");
			}

			function inspectAliases(scope: Scope.Scope): void {
				const roots = new Set<string>(AMBIENT_ROOTS);
				const rootVariables = new Map<string, IdentifierNode>();
				const consumedRoots = new Set<string>();
				const aliases: IdentifierNode[] = [];

				let changed = true;
				while (changed) {
					changed = false;
					for (const variable of scope.variables) {
						const definition = variableDefinition(variable);
						if (definition === undefined || definition.parent.kind !== "const") continue;
						const declaration = definition.node;
						const initializer = declaration.init;
						if (initializer === null || initializer === undefined) continue;

						if (initializer.type === "Identifier" && roots.has(initializer.name)) {
							handledAmbientIdentifiers.add(initializer);
							if (declaration.id.type === "Identifier") {
								if (!roots.has(declaration.id.name)) {
									roots.add(declaration.id.name);
									rootVariables.set(declaration.id.name, declaration.id as IdentifierNode);
									changed = true;
								}
							} else {
								consumedRoots.add(initializer.name);
								aliases.push(...bindingIdentifiers(declaration.id));
							}
							continue;
						}

						if (initializer.type === "MemberExpression" && initializer.object.type === "Identifier") {
							if (!roots.has(initializer.object.name)) continue;
							handledAmbientIdentifiers.add(initializer.object);
							consumedRoots.add(initializer.object.name);
							for (const identifier of bindingIdentifiers(declaration.id)) aliases.push(identifier);
							continue;
						}
					}
				}

				for (const variable of scope.variables) {
					const definition = variableDefinition(variable);
					if (definition === undefined || definition.parent.kind !== "const") continue;
					const initializer = definition.node.init;
					if (initializer?.type !== "Identifier" || !roots.has(initializer.name)) continue;
					if (definition.node.id.type !== "ObjectPattern") continue;
					handledAmbientIdentifiers.add(initializer);
					consumedRoots.add(initializer.name);
					aliases.push(...bindingIdentifiers(definition.node.id));
				}

				for (const identifier of aliases) {
					ambientAliasNames.add(identifier.name);
					report(identifier, "ambientAlias", { name: identifier.name });
				}
				for (const [name, identifier] of rootVariables) {
					if (!consumedRoots.has(name)) {
						ambientAliasNames.add(name);
						report(identifier, "ambientAlias", { name });
					}
				}
			}

			function referenceMap(globalScope: Scope.Scope): ReadonlyMap<AstNode, Scope.Reference> {
				const references = new Map<AstNode, Scope.Reference>();
				const pending = [globalScope];
				while (pending.length > 0) {
					const scope = pending.pop();
					if (scope === undefined) continue;
					for (const reference of scope.references) references.set(reference.identifier, reference);
					pending.push(...scope.childScopes);
				}
				for (const reference of globalScope.through) references.set(reference.identifier, reference);
				return references;
			}

			function inspectRandomMembers(globalScope: Scope.Scope): void {
				const references = referenceMap(globalScope);
				for (const node of randomMembers) {
					if (node.object.type !== "Identifier") continue;
					const reference = references.get(node.object);
					if (reference !== undefined && reference.resolved !== null && reference.resolved.defs.length > 0) {
						continue;
					}
					const member = staticMemberName(node);
					if (node.object.name === "Math" && member === "random") {
						handledAmbientIdentifiers.add(node.object);
						report(node, "randomness", { name: "Math.random" });
					}
					if (node.object.name === "crypto" && member === "getRandomValues") {
						handledAmbientIdentifiers.add(node.object);
						report(node, "randomness", { name: "crypto.getRandomValues" });
					}
				}
			}

			function inspectAmbientDeclarations(scope: Scope.Scope): void {
				for (const variable of scope.variables) {
					if (!isDeclaredValue(variable)) continue;
					const reference = variable.references.find(isRuntimeReference);
					const identifier = reference?.identifier ?? variable.identifiers[0];
					if (identifier !== undefined) report(identifier, "ambientAccess", { name: variable.name });
				}
			}

			function inspectModuleState(scope: Scope.Scope): void {
				const variablesByName = new Map(scope.variables.map((variable) => [variable.name, variable]));
				const shapes = new Map<Scope.Variable, ValueShape>();

				function objectProperty(shape: ValueShape, name: string): ValueShape {
					if (shape.kind === "object") {
						return shape.properties.get(name) ?? (shape.unknownProperties ? UNKNOWN_VALUE : SCALAR_VALUE);
					}
					if (shape.kind === "scalar") return SCALAR_VALUE;
					return UNKNOWN_VALUE;
				}

				function arrayElement(shape: ValueShape, index: number): ValueShape {
					if (shape.kind === "array") {
						return shape.unknownElements ? UNKNOWN_VALUE : (shape.elements[index] ?? SCALAR_VALUE);
					}
					if (shape.kind === "scalar") return SCALAR_VALUE;
					return UNKNOWN_VALUE;
				}

				function propertyName(property: AstNode): string | undefined {
					if (property.type !== "Property") return undefined;
					if (!property.computed && property.key.type === "Identifier") return property.key.name;
					if (
						property.key.type === "Literal" &&
						(typeof property.key.value === "string" || typeof property.key.value === "number")
					) {
						return String(property.key.value);
					}
					return undefined;
				}

				function joinedShape(...alternatives: readonly ValueShape[]): ValueShape {
					return alternatives.every((alternative) => alternative.kind === "scalar") ? SCALAR_VALUE : MUTABLE_VALUE;
				}

				function shapeFromExpression(node: AstNode | null | undefined, visiting: Set<Scope.Variable>): ValueShape {
					const expression = unwrapExpression(node);
					if (expression === undefined) return UNKNOWN_VALUE;

					if (expression.type === "Literal") {
						const regexp = (expression as AstNode & { readonly regex?: { readonly flags: string } }).regex;
						return regexp !== undefined && /[gy]/u.test(regexp.flags) ? MUTABLE_VALUE : SCALAR_VALUE;
					}
					if (
						expression.type === "BinaryExpression" ||
						expression.type === "TemplateLiteral" ||
						expression.type === "UnaryExpression"
					) {
						return SCALAR_VALUE;
					}
					if (
						expression.type === "CallExpression" ||
						expression.type === "NewExpression" ||
						expression.type === "TaggedTemplateExpression"
					) {
						return MUTABLE_VALUE;
					}

					if (expression.type === "Identifier") {
						if (PURE_IDENTIFIERS.has(expression.name)) return SCALAR_VALUE;
						const target = variablesByName.get(expression.name);
						return target === undefined ? UNKNOWN_VALUE : shapeForVariable(target, visiting);
					}

					if (expression.type === "ConditionalExpression") {
						return joinedShape(
							shapeFromExpression(expression.consequent, visiting),
							shapeFromExpression(expression.alternate, visiting)
						);
					}

					if (expression.type === "LogicalExpression") {
						return joinedShape(
							shapeFromExpression(expression.left, visiting),
							shapeFromExpression(expression.right, visiting)
						);
					}

					if (expression.type === "SequenceExpression") {
						return shapeFromExpression(expression.expressions.at(-1), visiting);
					}

					if (expression.type === "ArrayExpression") {
						return {
							elements: expression.elements.map((element) => {
								if (element === null) return SCALAR_VALUE;
								return element.type === "SpreadElement" ? UNKNOWN_VALUE : shapeFromExpression(element, visiting);
							}),
							kind: "array",
							unknownElements: expression.elements.some((element) => element?.type === "SpreadElement"),
						};
					}

					if (expression.type === "ObjectExpression") {
						const properties = new Map<string, ValueShape>();
						let unknownProperties = false;
						for (const property of expression.properties) {
							const name = propertyName(property);
							if (property.type !== "Property" || name === undefined) {
								properties.clear();
								unknownProperties = true;
								continue;
							}
							properties.set(name, shapeFromExpression(property.value, visiting));
						}
						return { kind: "object", properties, unknownProperties };
					}

					if (expression.type === "MemberExpression") {
						const name = staticMemberName(expression as MemberNode);
						if (name === undefined) return MUTABLE_VALUE;

						const object = shapeFromExpression(expression.object, visiting);
						let projected: ValueShape;
						if (object.kind === "array") {
							if (name === "length") return SCALAR_VALUE;
							projected = /^(?:0|[1-9]\d*)$/u.test(name) ? arrayElement(object, Number(name)) : UNKNOWN_VALUE;
						} else {
							projected = objectProperty(object, name);
						}
						return projected.kind === "unknown" ? MUTABLE_VALUE : projected;
					}

					return UNKNOWN_VALUE;
				}

				function projectedBinding(pattern: AstNode, source: ValueShape, name: string): ValueShape | undefined {
					if (pattern.type === "Identifier") {
						if (pattern.name !== name) return undefined;
						return source.kind === "unknown" ? MUTABLE_VALUE : source;
					}
					if (pattern.type === "AssignmentPattern") {
						return projectedBinding(pattern.left, source, name) === undefined ? undefined : MUTABLE_VALUE;
					}
					if (pattern.type === "RestElement") {
						return projectedBinding(pattern.argument, source, name) === undefined ? undefined : MUTABLE_VALUE;
					}
					if (pattern.type === "ArrayPattern") {
						for (const [index, element] of pattern.elements.entries()) {
							if (element === null) continue;
							const projected = projectedBinding(element, arrayElement(source, index), name);
							if (projected !== undefined) return projected;
						}
					}
					if (pattern.type === "ObjectPattern") {
						for (const property of pattern.properties) {
							if (property.type === "RestElement") {
								const projected = projectedBinding(property.argument, MUTABLE_VALUE, name);
								if (projected !== undefined) return projected;
								continue;
							}
							const key = propertyName(property);
							const projected = projectedBinding(
								property.value,
								key === undefined ? UNKNOWN_VALUE : objectProperty(source, key),
								name
							);
							if (projected !== undefined) return projected;
						}
					}
					return undefined;
				}

				function shapeForVariable(variable: Scope.Variable, visiting: Set<Scope.Variable>): ValueShape {
					const cached = shapes.get(variable);
					if (cached !== undefined) return cached;
					if (visiting.has(variable)) return UNKNOWN_VALUE;

					const definition = variableDefinition(variable);
					if (definition === undefined) return UNKNOWN_VALUE;
					visiting.add(variable);
					const source = shapeFromExpression(definition.node.init, visiting);
					const shape =
						definition.node.id.type === "Identifier"
							? source
							: (projectedBinding(definition.node.id, source, variable.name) ?? UNKNOWN_VALUE);
					visiting.delete(variable);
					shapes.set(variable, shape);
					return shape;
				}

				const mutableVariables = new Set(
					scope.variables.filter((variable) => {
						if (ambientAliasNames.has(variable.name)) return false;
						const shape = shapeForVariable(variable, new Set());
						return shape.kind === "array" || shape.kind === "mutable" || shape.kind === "object";
					})
				);

				for (const variable of scope.variables) {
					const definition = variableDefinition(variable);
					if (definition !== undefined && definition.parent.kind !== "const") {
						report(definition.parent, "moduleMutation");
					}
				}

				for (const variable of scope.variables) {
					const definition = variableDefinition(variable);
					const alreadyRejectedDeclaration = definition !== undefined && definition.parent.kind !== "const";
					const directWrite = alreadyRejectedDeclaration
						? undefined
						: variable.references.find(
								(reference) => isRuntimeReference(reference) && reference.isWrite() && !reference.init
							);
					if (directWrite !== undefined) {
						report(directWrite.identifier, "moduleMutation");
						continue;
					}

					const writes = variable.references
						.filter(isRuntimeReference)
						.map((reference) => ({ member: outerMemberWrite(reference.identifier as IdentifierNode), reference }))
						.filter((entry): entry is { member: MemberNode; reference: Scope.Reference } => entry.member !== undefined);
					const deleteWrite = writes.find(
						({ member }) => member.parent.type === "UnaryExpression" && member.parent.operator === "delete"
					);
					const moduleWrite = writes.find(({ reference }) => !crossesFunctionScope(reference, scope));
					const nestedNonDataWrite = mutableVariables.has(variable) ? undefined : writes[0];
					const mutationNode = deleteWrite?.member ?? moduleWrite?.member ?? nestedNonDataWrite?.member;
					if (mutationNode !== undefined) {
						report(mutationNode, "moduleMutation");
						continue;
					}

					if (!mutableVariables.has(variable)) continue;
					const captured = variable.references.some(
						(reference) => isRuntimeReference(reference) && crossesFunctionScope(reference, scope)
					);
					if (captured) {
						const definition = variableDefinition(variable);
						if (definition !== undefined) report(definition.node, "mutableCapture");
					}
				}
			}

			function inspectAmbientReferences(scope: Scope.Scope): void {
				const references = [
					...scope.through,
					...scope.variables
						.filter((variable) => variable.defs.length === 0)
						.flatMap((variable) => variable.references),
				].sort((left, right) => sourceCode.getRange(left.identifier)[0] - sourceCode.getRange(right.identifier)[0]);

				for (const reference of references) {
					if (!isRuntimeReference(reference)) continue;
					const identifier = reference.identifier as IdentifierNode;
					const name = identifier.name;
					if (handledAmbientIdentifiers.has(identifier) || PURE_IDENTIFIERS.has(name)) continue;

					if (name === "Promise") {
						report(identifier, "promiseUsage");
						continue;
					}
					if (name === "eval" || name === "Function") {
						report(identifier, "dynamicCode");
						continue;
					}

					const parent = identifier.parent;
					if (name === "Math" && parent.type === "MemberExpression" && parent.object === identifier) {
						const member = staticMemberName(parent);
						if (member !== undefined && PURE_MATH_MEMBERS.has(member) && !isWriteTarget(parent)) continue;
					}

					report(identifier, "ambientAccess", { name });
				}
			}

			return {
				"AccessorProperty"(node): void {
					if (node.static) report(node, "moduleMutation");
				},
				"ArrowFunctionExpression": inspectAsyncFunction,
				"AwaitExpression"(node): void {
					const belongsToAsyncFunction = sourceCode
						.getAncestors(node)
						.some(
							(ancestor) =>
								(ancestor.type === "ArrowFunctionExpression" ||
									ancestor.type === "FunctionDeclaration" ||
									ancestor.type === "FunctionExpression") &&
								ancestor.async
						);
					if (!belongsToAsyncFunction) report(node, "asyncSyntax");
				},
				"ExportAllDeclaration"(node): void {
					report(node, "moduleImport");
				},
				"ExportNamedDeclaration"(node): void {
					if (node.source !== null) report(node, "moduleImport");
				},
				"ForOfStatement"(node): void {
					if (!node.await) return;
					const belongsToFunction = sourceCode
						.getAncestors(node)
						.some(
							(ancestor) =>
								ancestor.type === "ArrowFunctionExpression" ||
								ancestor.type === "FunctionDeclaration" ||
								ancestor.type === "FunctionExpression"
						);
					if (!belongsToFunction) report(node, "asyncSyntax");
				},
				"FunctionDeclaration": inspectAsyncFunction,
				"FunctionExpression": inspectAsyncFunction,
				"ImportDeclaration"(node): void {
					report(node, "moduleImport");
				},
				"ImportExpression"(node): void {
					report(node, "moduleImport");
				},
				"MemberExpression"(node): void {
					const member = staticMemberName(node);
					if (
						node.object.type === "Identifier" &&
						((node.object.name === "Math" && member === "random") ||
							(node.object.name === "crypto" && member === "getRandomValues"))
					) {
						randomMembers.push(node);
					}
					if (staticMemberName(node) === "then") report(node, "promiseUsage");
				},
				"MetaProperty"(node): void {
					if (node.meta.name === "import") report(node, "moduleImport");
				},
				"PropertyDefinition"(node): void {
					if (node.static) report(node, "moduleMutation");
				},
				"StaticBlock"(node): void {
					report(node, "moduleMutation");
				},
				"Program:exit"(): void {
					const globalScope = sourceCode.scopeManager.globalScope;
					if (globalScope === null) return;
					const scope = moduleScope(globalScope);
					if (scope === undefined) return;
					inspectAliases(scope);
					inspectRandomMembers(globalScope);
					inspectAmbientDeclarations(scope);
					inspectModuleState(scope);
					inspectAmbientReferences(globalScope);
				},
			};
		},
	};
}

const plugin = {
	meta: {
		name: "eslint-plugin-ts-drp",
	},
	rules: {
		[RULE_NAME]: createRule(),
	},
} as const;

export default plugin;
