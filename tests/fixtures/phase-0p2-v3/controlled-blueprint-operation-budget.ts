/* eslint-disable jsdoc/require-jsdoc */

import { compareBytes, decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { createHash } from "node:crypto";

import { ed25519 } from "../../../packages/protocol-v3/node_modules/@noble/curves/ed25519.js";

type Mutant =
	| "discriminator-excluding-meter"
	| "injected-counter-meter"
	| "json-stringify-meter"
	| "local-budget-after-issued-record"
	| "local-budget-after-outbox"
	| "local-budget-after-signing"
	| "local-budget-after-transaction"
	| "local-budget-before-detach"
	| "raw-frame-meter"
	| "remote-budget-after-fold"
	| "remote-budget-after-publication"
	| "remote-budget-after-reducer"
	| "remote-budget-before-abi"
	| "remote-budget-before-authentication"
	| "utf16-meter";

interface CompiledField {
	readonly name: string;
	readonly required: boolean;
	readonly type: "canonical-object" | "safe-integer" | "string";
}

interface CompiledOperation {
	readonly fields: readonly CompiledField[];
	readonly maxCanonicalOperationBytes?: number;
}

interface PreparedState {
	readonly discriminator: string;
	readonly operations: ReadonlyMap<string, CompiledOperation>;
}

interface PreparedBlueprintAdmission {
	readonly blueprintDigest: string;
}

interface LocalInput {
	readonly anchor: string;
	readonly dependencies: readonly string[];
	readonly epoch: number;
	readonly logicalTime: number;
	readonly objectId: string;
	readonly operation: Readonly<Record<string, unknown>>;
}

interface IssueScope {
	readonly author: string;
	readonly objectId: string;
}

interface Envelope {
	readonly canonicalPreimageBytes: Uint8Array;
	readonly digest: Uint8Array;
	readonly signature: Uint8Array;
}

interface Commit {
	readonly authorSequence: number;
	readonly envelope: Envelope;
	readonly issuedRecord: { readonly authorSequence: number; readonly envelope: Envelope; readonly scope: IssueScope };
	readonly outboxEntry: { readonly authorSequence: number; readonly envelope: Envelope; readonly scope: IssueScope };
}

interface ConstructionWitnesses {
	issuedRecords: number;
	outboxEntries: number;
}

declare global {
	// Test-only observation of internal construction points; never consulted as a meter.
	// eslint-disable-next-line no-var
	var __PHASE_0P2_CONSTRUCTION_WITNESSES__: ConstructionWitnesses | undefined;
}

const mutant = process.env.PHASE_0P2_MUTANT as Mutant | undefined;
const preparedStates = new WeakMap<object, PreparedState>();
const encoder = new TextEncoder();
const VERTEX_DOMAIN = "ts-drp/vertex/v3";
const BLUEPRINT_DOMAIN = "ts-drp/blueprint-admission/v3";

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownData(value: Record<string, unknown>, name: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${name} is required`);
	return descriptor.value;
}

function closed(value: unknown, keys: readonly string[], context: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError(`${context} must be a record`);
	const actual = Reflect.ownKeys(value);
	if (
		actual.length !== keys.length ||
		actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
		keys.some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return descriptor === undefined || !Object.hasOwn(descriptor, "value");
		})
	) {
		throw new TypeError(`${context} must be exact and closed`);
	}
}

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function unsigned(value: number, width: 4 | 8): Uint8Array {
	const output = new Uint8Array(width);
	const view = new DataView(output.buffer);
	if (width === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

function domainHash(domain: string, payload: Uint8Array): Uint8Array {
	const domainBytes = encoder.encode(domain);
	return new Uint8Array(
		createHash("sha256")
			.update(bytes(Uint8Array.of(0x44, 0x52, 0x50, 0), unsigned(domainBytes.length, 4), domainBytes))
			.update(unsigned(payload.length, 8))
			.update(payload)
			.digest()
	);
}

function digestHex(payload: Uint8Array): string {
	return Buffer.from(domainHash(BLUEPRINT_DOMAIN, payload)).toString("hex");
}

function compilePackage(value: unknown): PreparedState {
	closed(value, ["kind", "protocolMajor", "schemaVersion", "implementation", "manifest"], "package");
	if (value.kind !== "drp-blueprint-admission-package" || value.protocolMajor !== 3 || value.schemaVersion !== 1) {
		throw new TypeError("package identity is unsupported");
	}
	closed(value.implementation, ["artifactId", "artifactDigest", "runtimeProfile"], "implementation");
	closed(value.manifest, Reflect.ownKeys(value.manifest as object) as string[], "manifest carrier");
	const manifest = value.manifest;
	const version = ownData(manifest, "schemaVersion");
	if (version !== 1 && version !== 2) throw new TypeError("manifest schema version is unsupported");
	const manifestKeys =
		version === 2
			? ["schemaVersion", "operationDiscriminator", "workBudgetProfile", "operations"]
			: ["schemaVersion", "operationDiscriminator", "operations"];
	closed(manifest, manifestKeys, "manifest");
	if (version === 2 && manifest.workBudgetProfile !== "blueprint-work-budget-v1") {
		throw new TypeError("work budget profile is unsupported");
	}
	if (typeof manifest.operationDiscriminator !== "string" || manifest.operationDiscriminator.length === 0) {
		throw new TypeError("operation discriminator is invalid");
	}
	if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
		throw new TypeError("operations must be nonempty");
	}
	const operations = new Map<string, CompiledOperation>();
	for (const candidate of manifest.operations) {
		closed(
			candidate,
			version === 2 ? ["name", "argumentSchema", "maxCanonicalOperationBytes"] : ["name", "argumentSchema"],
			"operation"
		);
		if (typeof candidate.name !== "string" || operations.has(candidate.name)) throw new TypeError("operation name");
		if (
			version === 2 &&
			(!Number.isSafeInteger(candidate.maxCanonicalOperationBytes) ||
				(candidate.maxCanonicalOperationBytes as number) <= 0)
		) {
			throw new RangeError("operation limit");
		}
		closed(candidate.argumentSchema, ["kind", "fields"], "argument schema");
		if (candidate.argumentSchema.kind !== "closed-record" || !Array.isArray(candidate.argumentSchema.fields)) {
			throw new TypeError("argument schema");
		}
		const fields: CompiledField[] = candidate.argumentSchema.fields.map((field) => {
			closed(field, ["name", "required", "type"], "field");
			if (
				typeof field.name !== "string" ||
				field.name === manifest.operationDiscriminator ||
				typeof field.required !== "boolean" ||
				!["canonical-object", "safe-integer", "string"].includes(field.type as string)
			) {
				throw new TypeError("field");
			}
			return {
				name: field.name,
				required: field.required,
				type: field.type as CompiledField["type"],
			};
		});
		operations.set(candidate.name, {
			fields,
			...(version === 2 ? { maxCanonicalOperationBytes: candidate.maxCanonicalOperationBytes as number } : {}),
		});
	}
	return { discriminator: manifest.operationDiscriminator, operations };
}

function stateFor(input: object): PreparedState | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(input, "preparedBlueprintAdmission");
	return descriptor !== undefined && Object.hasOwn(descriptor, "value") && descriptor.value !== null
		? preparedStates.get(descriptor.value as object)
		: undefined;
}

function schemaFor(operation: unknown, state: PreparedState): CompiledOperation | undefined {
	if (!isRecord(operation) || Object.getOwnPropertySymbols(operation).length !== 0) return undefined;
	const discriminator = Object.getOwnPropertyDescriptor(operation, state.discriminator);
	if (
		discriminator === undefined ||
		!Object.hasOwn(discriminator, "value") ||
		typeof discriminator.value !== "string"
	) {
		return undefined;
	}
	const schema = state.operations.get(discriminator.value);
	if (schema === undefined) return undefined;
	const allowed = new Set([state.discriminator, ...schema.fields.map(({ name }) => name)]);
	if (Reflect.ownKeys(operation).some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
	for (const field of schema.fields) {
		const descriptor = Object.getOwnPropertyDescriptor(operation, field.name);
		if (descriptor === undefined) {
			if (field.required) return undefined;
			continue;
		}
		if (!Object.hasOwn(descriptor, "value")) return undefined;
		if (field.type === "string" && typeof descriptor.value !== "string") return undefined;
		if (
			field.type === "safe-integer" &&
			(typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value))
		) {
			return undefined;
		}
		if (field.type === "canonical-object" && !isRecord(descriptor.value)) return undefined;
	}
	return schema;
}

function operationMeterCase(operation: Readonly<Record<string, unknown>>): string | undefined {
	const nested = operation.nested;
	return isRecord(nested) && typeof nested.case === "string" ? nested.case : undefined;
}

function measuredLength(
	operation: Readonly<Record<string, unknown>>,
	discriminator: string,
	rawFrame?: Uint8Array
): number {
	const meterCase = operationMeterCase(operation);
	switch (mutant) {
		case "json-stringify-meter":
			return meterCase === "j" ? Buffer.byteLength(JSON.stringify(operation)) : encodeCanonical(operation).byteLength;
		case "utf16-meter":
			return meterCase === "u" ? JSON.stringify(operation).length : encodeCanonical(operation).byteLength;
		case "raw-frame-meter":
			return meterCase === "r" && rawFrame !== undefined ? rawFrame.byteLength : encodeCanonical(operation).byteLength;
		case "discriminator-excluding-meter": {
			if (meterCase !== "d") return encodeCanonical(operation).byteLength;
			const copy = structuredClone(operation);
			delete copy[discriminator];
			return encodeCanonical(copy).byteLength;
		}
		case "injected-counter-meter": {
			const nested = operation.nested;
			return isRecord(nested) && Number.isSafeInteger(nested.workUnits)
				? (nested.workUnits as number)
				: encodeCanonical(operation).byteLength;
		}
		default:
			return encodeCanonical(operation).byteLength;
	}
}

function withinBudget(
	operation: Readonly<Record<string, unknown>>,
	discriminator: string,
	schema: CompiledOperation,
	rawFrame?: Uint8Array
): boolean {
	return (
		schema.maxCanonicalOperationBytes === undefined ||
		measuredLength(operation, discriminator, rawFrame) <= schema.maxCanonicalOperationBytes
	);
}

function authenticated(
	input: Record<string, unknown>
): { digest: Uint8Array; preimage: Record<string, unknown> } | undefined {
	try {
		if (
			input.domain !== VERTEX_DOMAIN ||
			input.suiteId !== "ed25519-sha256-v3" ||
			!(input.receivedCanonicalPreimageBytes instanceof Uint8Array) ||
			!(input.signature instanceof Uint8Array) ||
			typeof input.resolveAuthorPublicKey !== "function"
		) {
			return undefined;
		}
		const preimage = decodeCanonical(input.receivedCanonicalPreimageBytes);
		if (!isRecord(preimage) || preimage.anchor !== input.expectedAnchor || !isRecord(preimage.operation)) {
			return undefined;
		}
		const key = (input.resolveAuthorPublicKey as (author: string) => { bytes: Uint8Array } | undefined)(
			preimage.author as string
		);
		if (key === undefined) return undefined;
		const digest = domainHash(VERTEX_DOMAIN, input.receivedCanonicalPreimageBytes);
		if (!ed25519.verify(input.signature, digest, key.bytes)) return undefined;
		return { digest, preimage };
	} catch {
		return undefined;
	}
}

function decodedOperation(input: Record<string, unknown>): Record<string, unknown> | undefined {
	try {
		const value = decodeCanonical(input.receivedCanonicalPreimageBytes as Uint8Array);
		return isRecord(value) && isRecord(value.operation) ? value.operation : undefined;
	} catch {
		return undefined;
	}
}

export function prepareBlueprintAdmission(input: {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
}): PreparedBlueprintAdmission {
	closed(input, ["canonicalBlueprintPackageBytes", "expectedBlueprintDigest"], "preparation input");
	const copy = new Uint8Array(input.canonicalBlueprintPackageBytes);
	const decoded = decodeCanonical(copy);
	if (compareBytes(encodeCanonical(decoded), copy) !== 0) throw new TypeError("package is not canonical");
	const actual = digestHex(copy);
	if (actual !== input.expectedBlueprintDigest) throw new TypeError("blueprint digest mismatch");
	const state = compilePackage(decoded);
	const prepared = Object.freeze({ blueprintDigest: actual });
	preparedStates.set(prepared, state);
	return prepared;
}

export function admitReceivedVertex(input: Record<string, unknown>): {
	readonly admitted: boolean;
	readonly digest?: Uint8Array;
} {
	const state = stateFor(input);
	if (state === undefined) return { admitted: false };
	if (mutant === "remote-budget-before-authentication") {
		const operation = decodedOperation(input);
		if (operation !== undefined) {
			const schema = schemaFor(operation, state);
			if (
				schema !== undefined &&
				!withinBudget(operation, state.discriminator, schema, input.receivedCanonicalPreimageBytes as Uint8Array)
			) {
				return { admitted: false };
			}
		}
	}
	const verified = authenticated(input);
	if (verified === undefined) return { admitted: false };
	const operation = verified.preimage.operation;
	if (!isRecord(operation)) return { admitted: false };
	if (mutant === "remote-budget-before-abi") {
		const discriminator = operation[state.discriminator];
		const schema = typeof discriminator === "string" ? state.operations.get(discriminator) : undefined;
		if (
			schema !== undefined &&
			!withinBudget(operation, state.discriminator, schema, input.receivedCanonicalPreimageBytes as Uint8Array)
		) {
			return { admitted: false };
		}
	}
	const schema = schemaFor(operation, state);
	if (schema === undefined) return { admitted: false };
	const delayedBudgetMarker =
		mutant === "remote-budget-after-publication"
			? "p"
			: mutant === "remote-budget-after-reducer"
				? "q"
				: mutant === "remote-budget-after-fold"
					? "f"
					: undefined;
	const budgetDelayed = delayedBudgetMarker !== undefined && operationMeterCase(operation) === delayedBudgetMarker;
	if (
		!budgetDelayed &&
		!withinBudget(operation, state.discriminator, schema, input.receivedCanonicalPreimageBytes as Uint8Array)
	) {
		return { admitted: false };
	}
	return { admitted: true, digest: verified.digest };
}

export function createAdmissionBoundTransactionalVertexIssuer(options: Record<string, unknown>): {
	issue(input: LocalInput): Promise<Commit>;
} {
	const state = stateFor(options);
	if (state === undefined) throw new TypeError("prepared admission is not genuine");
	if (!(options.privateKeySeed instanceof Uint8Array) || typeof options.transactIssue !== "function") {
		throw new TypeError("issuer options");
	}
	const privateKey = new Uint8Array(options.privateKeySeed);
	const author = options.author as string;
	const transactIssue = options.transactIssue as (
		scope: IssueScope,
		build: (sequence: number) => Promise<Commit>
	) => Promise<Commit>;
	return {
		async issue(input): Promise<Commit> {
			const rawSchema = schemaFor(input.operation, state);
			if (rawSchema === undefined) throw new TypeError("operation ABI");
			if (mutant === "local-budget-before-detach" && !withinBudget(input.operation, state.discriminator, rawSchema)) {
				throw new RangeError("operation budget");
			}
			const detached = decodeCanonical(encodeCanonical(input.operation));
			if (!isRecord(detached)) throw new TypeError("detached operation");
			const schema = schemaFor(detached, state);
			if (schema === undefined) throw new TypeError("detached operation ABI");
			const lateMarker =
				mutant === "local-budget-after-transaction"
					? "t"
					: mutant === "local-budget-after-signing"
						? "s"
						: mutant === "local-budget-after-issued-record"
							? "i"
							: mutant === "local-budget-after-outbox"
								? "o"
								: undefined;
			const budgetLate = lateMarker !== undefined && operationMeterCase(detached) === lateMarker;
			if (
				mutant !== "local-budget-before-detach" &&
				!budgetLate &&
				!withinBudget(detached, state.discriminator, schema)
			) {
				throw new RangeError("operation budget");
			}
			const scope = { author, objectId: input.objectId };
			return transactIssue(scope, (authorSequence): Promise<Commit> => {
				if (
					budgetLate &&
					mutant === "local-budget-after-transaction" &&
					!withinBudget(detached, state.discriminator, schema)
				) {
					throw new RangeError("operation budget");
				}
				const canonicalPreimageBytes = encodeCanonical({
					kind: "drp-vertex",
					protocolMajor: 3,
					objectId: input.objectId,
					epoch: input.epoch,
					anchor: input.anchor,
					author,
					authorSequence,
					logicalTime: input.logicalTime,
					dependencies: [...input.dependencies],
					operation: detached,
				});
				const digest = domainHash(VERTEX_DOMAIN, canonicalPreimageBytes);
				const envelope = { canonicalPreimageBytes, digest, signature: ed25519.sign(digest, privateKey) };
				if (
					budgetLate &&
					mutant === "local-budget-after-signing" &&
					!withinBudget(detached, state.discriminator, schema)
				) {
					throw new RangeError("operation budget");
				}
				const issuedRecord = { authorSequence, envelope, scope };
				if (globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__ !== undefined) {
					globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__.issuedRecords++;
				}
				if (
					budgetLate &&
					mutant === "local-budget-after-issued-record" &&
					!withinBudget(detached, state.discriminator, schema)
				) {
					throw new RangeError("operation budget");
				}
				const outboxEntry = { authorSequence, envelope, scope };
				if (globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__ !== undefined) {
					globalThis.__PHASE_0P2_CONSTRUCTION_WITNESSES__.outboxEntries++;
				}
				if (
					budgetLate &&
					mutant === "local-budget-after-outbox" &&
					!withinBudget(detached, state.discriminator, schema)
				) {
					throw new RangeError("operation budget");
				}
				return Promise.resolve({ authorSequence, envelope, issuedRecord, outboxEntry });
			});
		},
	};
}

export function prepareBlueprintRuntime(): Promise<never> {
	return Promise.reject(new TypeError("runtime preparation is outside the Phase 0p-2 control"));
}
