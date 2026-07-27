import { type IHashGraph, type Vertex } from "@ts-drp/types";
import { computeHash } from "@ts-drp/utils/hash";

import { InvalidDependenciesError, InvalidHashError, InvalidTimestampError } from "./errors.js";

export const DRP_VERTEX_FUTURE_TOLERANCE_MS = 60_000;

export interface ValidationResult {
	success: boolean;
	error?: Error;
}

export interface VertexValidationOptions {
	skipHashValidation?: boolean;
}

const receiverClockPendingValidationResults = new WeakSet<ValidationResult>();

/**
 * Internal provenance predicate for whether this validation result can be repaired by the receiver clock advancing.
 * @param result - The validation result to classify.
 * @returns Whether the result came from finite receiver-clock future eligibility.
 */
export function isReceiverClockPendingValidationResult(result: ValidationResult): boolean {
	return receiverClockPendingValidationResults.has(result);
}

function validateVertexHash({ hash, peerId, operation, dependencies, timestamp }: Vertex): void {
	const correctHash = computeHash(peerId, operation, dependencies, timestamp);
	if (hash !== correctHash) {
		throw new InvalidHashError(`Invalid hash for vertex ${hash}`);
	}
}

function validateVertexDependencies({ hash, dependencies, timestamp }: Vertex, hashGraph: IHashGraph): void {
	if (dependencies.length === 0) {
		throw new InvalidDependenciesError(`Vertex ${hash} has no dependencies.`);
	}
	for (const dep of dependencies) {
		const depVertex = hashGraph.vertices.get(dep);
		if (depVertex === undefined) {
			throw new InvalidDependenciesError(`Vertex ${hash} has invalid dependency ${dep}.`);
		}
		validateVertexTimestamp(depVertex.timestamp, timestamp, hash);
	}
}

function createInvalidTimestampError(a: number, b: number, hash: string): InvalidTimestampError {
	return new InvalidTimestampError(
		`Vertex ${hash} has invalid timestamp ${a} - ${b} = ${a - b} > ${DRP_VERTEX_FUTURE_TOLERANCE_MS}`
	);
}

function validateVertexTimestamp(a: number, b: number, hash: string): void {
	if (a - b > DRP_VERTEX_FUTURE_TOLERANCE_MS) {
		throw createInvalidTimestampError(a, b, hash);
	}
}

function snapshotVertex(vertex: Vertex): Vertex {
	const hash = vertex.hash;
	const peerId = vertex.peerId;
	const operation = vertex.operation;
	const dependencies = [...vertex.dependencies];
	const timestamp = vertex.timestamp;
	const signature = new Uint8Array(vertex.signature);

	return {
		hash,
		peerId,
		operation,
		dependencies,
		timestamp,
		signature,
	};
}

/**
 * Validates a vertex, three validation checks are performed:
 * 1. The vertex hash is validated
 * 2. The vertex dependencies are validated
 * 3. The vertex timestamp is validated
 * @param vertex - The vertex to validate
 * @param hashGraph - The hash graph
 * @param currentTimeStamp - The current timestamp
 * @param options - Validation controls for trusted local pipeline stages.
 * @returns The validation result
 */
export function validateVertex(
	vertex: Vertex,
	hashGraph: IHashGraph,
	currentTimeStamp: number,
	options: VertexValidationOptions = {}
): ValidationResult {
	let validationHash = "<unknown>";
	try {
		const stableVertex = snapshotVertex(vertex);
		validationHash = stableVertex.hash;
		if (!options.skipHashValidation) validateVertexHash(stableVertex);
		validateVertexDependencies(stableVertex, hashGraph);
		const { hash, timestamp } = stableVertex;
		if (timestamp - currentTimeStamp > DRP_VERTEX_FUTURE_TOLERANCE_MS) {
			const result: ValidationResult = {
				success: false,
				error: createInvalidTimestampError(timestamp, currentTimeStamp, hash),
			};
			if (Number.isFinite(timestamp) && Number.isFinite(currentTimeStamp)) {
				receiverClockPendingValidationResults.add(result);
			}
			return result;
		}
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error : new Error(`Vertex validation unknown error for vertex ${validationHash}`),
		};
	}
}
