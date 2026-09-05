import { createHash } from "node:crypto";

import { decodeCanonical, encodeCanonical } from "../../../packages/canonical/src/index.js";

export interface BlueprintPreparationInput {
	readonly canonicalBlueprintPackageBytes: Uint8Array;
	readonly expectedBlueprintDigest: string;
}

export interface PreparedBlueprintAdmission {
	readonly blueprintDigest: string;
}

type Mutant =
	| "digest-discriminator-omission"
	| "digest-identity-exclusion"
	| "digest-limit-omission"
	| "digest-operation-omission"
	| "duplicate-acceptance"
	| "limit-omission"
	| "unknown-acceptance";

const mutant = process.env.PHASE_0P0_MUTANT as Mutant | undefined;
const DOMAIN = "ts-drp/blueprint-admission/v3";
const encoder = new TextEncoder();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertClosed(
	value: unknown,
	keys: readonly string[],
	context: string
): asserts value is Record<string, unknown> {
	if (!isPlainRecord(value)) throw new TypeError(`${context} must be a plain object`);
	const actual = Reflect.ownKeys(value);
	if (
		actual.length !== keys.length ||
		actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
		actual.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))
	) {
		throw new TypeError(`${context} must be a closed own-data record`);
	}
}

function assertString(value: unknown, context: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${context} must be a nonempty well-formed string`);
	}
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) {
				throw new TypeError(`${context} must be a nonempty well-formed string`);
			}
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new TypeError(`${context} must be a nonempty well-formed string`);
		}
	}
}

function compareCodePoints(left: string, right: string): number {
	const leftPoints = Array.from(left);
	const rightPoints = Array.from(right);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index++) {
		const difference = (leftPoints[index]?.codePointAt(0) ?? 0) - (rightPoints[index]?.codePointAt(0) ?? 0);
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

function validateArgumentSchema(value: unknown, discriminator: string, context: string): void {
	assertClosed(value, ["kind", "fields"], context);
	if (value.kind !== "closed-record" || !Array.isArray(value.fields)) throw new TypeError(`${context} is malformed`);
	let previous: string | undefined;
	for (let index = 0; index < value.fields.length; index++) {
		const field = value.fields[index];
		assertClosed(field, ["name", "required", "type"], `${context}.fields[${index}]`);
		assertString(field.name, `${context}.fields[${index}].name`);
		if (
			field.name === discriminator ||
			(previous !== undefined && compareCodePoints(previous, field.name) >= 0) ||
			typeof field.required !== "boolean" ||
			!["canonical-object", "safe-integer", "string"].includes(field.type as string)
		) {
			throw new TypeError(`${context}.fields[${index}] is malformed`);
		}
		previous = field.name;
	}
}

function validateManifest(value: unknown): void {
	if (!isPlainRecord(value)) throw new TypeError("blueprint package.manifest must be a plain object");
	const version = value.schemaVersion;
	const expectedKeys =
		version === 1
			? ["schemaVersion", "operationDiscriminator", "operations"]
			: ["schemaVersion", "operationDiscriminator", "workBudgetProfile", "operations"];
	if (!(mutant === "unknown-acceptance" && value.unexpectedBudgetAuthority === true)) {
		assertClosed(value, expectedKeys, "blueprint package.manifest");
	}
	if (version !== 1 && version !== 2) throw new TypeError("blueprint package.manifest.schemaVersion is unsupported");
	const discriminator = value.operationDiscriminator;
	assertString(discriminator, "blueprint package.manifest.operationDiscriminator");
	if (version === 2 && value.workBudgetProfile !== "blueprint-work-budget-v1") {
		throw new TypeError("blueprint package.manifest.workBudgetProfile is unsupported");
	}
	if (!Array.isArray(value.operations) || value.operations.length === 0) {
		throw new TypeError("blueprint package.manifest.operations must be nonempty");
	}
	let previous: string | undefined;
	for (let index = 0; index < value.operations.length; index++) {
		const operation = value.operations[index];
		const operationKeys =
			version === 1 ? ["name", "argumentSchema"] : ["name", "argumentSchema", "maxCanonicalOperationBytes"];
		if (
			!(
				mutant === "limit-omission" &&
				version === 2 &&
				!Object.hasOwn(operation as object, "maxCanonicalOperationBytes")
			)
		) {
			assertClosed(operation, operationKeys, `blueprint package.manifest.operations[${index}]`);
		}
		if (!isPlainRecord(operation)) throw new TypeError("blueprint operation must be a plain object");
		assertString(operation.name, `blueprint package.manifest.operations[${index}].name`);
		if (
			previous !== undefined &&
			compareCodePoints(previous, operation.name) >= 0 &&
			!(mutant === "duplicate-acceptance" && operation.name === previous)
		) {
			throw new TypeError("blueprint manifest operations must be unique in codepoint order");
		}
		validateArgumentSchema(
			operation.argumentSchema,
			discriminator,
			`blueprint package.manifest.operations[${index}].argumentSchema`
		);
		if (
			version === 2 &&
			!(
				Number.isSafeInteger(operation.maxCanonicalOperationBytes) &&
				(operation.maxCanonicalOperationBytes as number) > 0
			) &&
			!(mutant === "limit-omission" && operation.maxCanonicalOperationBytes === undefined)
		) {
			throw new RangeError("maxCanonicalOperationBytes must be a positive safe integer");
		}
		previous = operation.name;
	}
}

function validatePackage(value: unknown): asserts value is Record<string, unknown> {
	assertClosed(value, ["kind", "protocolMajor", "schemaVersion", "implementation", "manifest"], "blueprint package");
	if (value.kind !== "drp-blueprint-admission-package" || value.protocolMajor !== 3 || value.schemaVersion !== 1) {
		throw new TypeError("blueprint package identity is unsupported");
	}
	assertClosed(value.implementation, ["artifactId", "artifactDigest", "runtimeProfile"], "blueprint implementation");
	assertString(value.implementation.artifactId, "blueprint implementation.artifactId");
	assertString(value.implementation.runtimeProfile, "blueprint implementation.runtimeProfile");
	if (
		typeof value.implementation.artifactDigest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.implementation.artifactDigest)
	) {
		throw new TypeError("blueprint implementation.artifactDigest is malformed");
	}
	validateManifest(value.manifest);
}

function unsignedBigEndian(value: number, bytes: 4 | 8): Uint8Array {
	const output = new Uint8Array(bytes);
	const view = new DataView(output.buffer);
	if (bytes === 4) view.setUint32(0, value, false);
	else view.setBigUint64(0, BigInt(value), false);
	return output;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function digestBytes(bytes: Uint8Array): string {
	const domain = encoder.encode(DOMAIN);
	return createHash("sha256")
		.update(
			concat([
				Uint8Array.from([0x44, 0x52, 0x50, 0]),
				unsignedBigEndian(domain.length, 4),
				domain,
				unsignedBigEndian(bytes.length, 8),
				bytes,
			])
		)
		.digest("hex");
}

function mutantPreimage(decoded: Record<string, unknown>): Uint8Array {
	const copy = structuredClone(decoded);
	const manifest = copy.manifest as Record<string, unknown>;
	const operations = manifest.operations as Array<Record<string, unknown>>;
	if (mutant === "digest-limit-omission" && operations[0]?.maxCanonicalOperationBytes === 4097) {
		for (const operation of operations) delete operation.maxCanonicalOperationBytes;
	}
	if (mutant === "digest-operation-omission" && operations.length === 2) manifest.operations = [];
	if (mutant === "digest-discriminator-omission" && manifest.operationDiscriminator === "kind") {
		delete manifest.operationDiscriminator;
	}
	if (mutant === "digest-identity-exclusion" && operations[0]?.name === "append2") delete operations[0].name;
	return encodeCanonical(copy);
}

/**
 * Independent positive oracle for Phase 0p-0 schema and digest governance.
 * @param input - Exact canonical package bytes and the independently expected whole-package digest.
 * @returns A frozen informational capability after closed-schema and digest validation.
 */
export function prepareBlueprintAdmission(input: BlueprintPreparationInput): PreparedBlueprintAdmission {
	assertClosed(input, ["canonicalBlueprintPackageBytes", "expectedBlueprintDigest"], "blueprint preparation input");
	if (!(input.canonicalBlueprintPackageBytes instanceof Uint8Array)) {
		throw new TypeError("canonicalBlueprintPackageBytes must be a Uint8Array");
	}
	if (!/^[0-9a-f]{64}$/u.test(input.expectedBlueprintDigest)) {
		throw new TypeError("expectedBlueprintDigest must be lowercase 64-hex");
	}
	const bytes = new Uint8Array(input.canonicalBlueprintPackageBytes);
	const decoded = decodeCanonical(bytes);
	const canonical = encodeCanonical(decoded);
	if (!Buffer.from(bytes).equals(Buffer.from(canonical))) throw new TypeError("blueprint package must be canonical");
	validatePackage(decoded);
	const actual = digestBytes(mutantPreimage(decoded));
	if (actual !== input.expectedBlueprintDigest) throw new TypeError("blueprint package digest mismatch");
	return Object.freeze({ blueprintDigest: actual });
}
