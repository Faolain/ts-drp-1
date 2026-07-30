/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */
import {
	createACL,
	createPermissionlessACL,
	createVertex,
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
 * Checked control: fixture materialization remains reference-identical while
 * engine-local Map authoring diverges. A harness that only calls Set.add or
 * only compares injected fixture hashes cannot observe this control.
 */
export class DRPObject extends ReferenceDRPObject {
	constructor(options) {
		super(options);
		const createReferenceLocalVertex = this.hashGraph.createVertex.bind(this.hashGraph);
		this.hashGraph.createVertex = (...args) => divergeHash(createReferenceLocalVertex(...args));
	}
}

export { createACL, createPermissionlessACL, createVertex };
