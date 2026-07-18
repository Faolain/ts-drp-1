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

function validateVertexTimestamp(a: number, b: number, hash: string): void {
	if (a - b > DRP_VERTEX_FUTURE_TOLERANCE_MS) {
		throw new InvalidTimestampError(
			`Vertex ${hash} has invalid timestamp ${a} - ${b} = ${a - b} > ${DRP_VERTEX_FUTURE_TOLERANCE_MS}`
		);
	}
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
	try {
		if (!options.skipHashValidation) validateVertexHash(vertex);
		validateVertexDependencies(vertex, hashGraph);
		validateVertexTimestamp(vertex.timestamp, currentTimeStamp, vertex.hash);
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error : new Error(`Vertex validation unknown error for vertex ${vertex.hash}`),
		};
	}
}
