/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc */
import {
	createACL,
	createPermissionlessACL,
	createVertex,
	DRPObject as ReferenceDRPObject,
} from "../../../dist/src/index.js";

/**
 * Checked control: this engine resolves and constructs normally, but refuses
 * every offered vertex so the differential must report an outcome mismatch.
 */
export class DRPObject extends ReferenceDRPObject {
	applyVertices(vertices) {
		return Promise.resolve({
			applied: false,
			missing: vertices.map((vertex) => vertex.hash),
			invalid: [],
		});
	}
}

export { createACL, createPermissionlessACL, createVertex };
