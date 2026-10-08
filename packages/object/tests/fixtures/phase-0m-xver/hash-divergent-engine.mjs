/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */
import {
	createACL,
	createPermissionlessACL,
	createVertex as createReferenceVertex,
	DRPObject as ReferenceDRPObject,
} from "../../../dist/src/index.js";

function divergeHash(vertex) {
	const replacement = vertex.hash.startsWith("0") ? "1" : "0";
	return {
		...vertex,
		hash: `${replacement}${vertex.hash.slice(1)}`,
	};
}

/**
 * Checked control: only engine-local authoring diverges. The existing Gate-0
 * harness pre-materializes with the current tree and injects those vertices
 * into both engines, so it cannot observe this path.
 */
export class DRPObject extends ReferenceDRPObject {
	constructor(options) {
		super(options);
		const createReferenceLocalVertex = this.hashGraph.createVertex.bind(this.hashGraph);
		this.hashGraph.createVertex = (...args) => divergeHash(createReferenceLocalVertex(...args));
	}
}

export function createVertex(peerId, operation, dependencies, timestamp, signature) {
	return divergeHash(createReferenceVertex(peerId, operation, dependencies, timestamp, signature));
}

export { createACL, createPermissionlessACL };
