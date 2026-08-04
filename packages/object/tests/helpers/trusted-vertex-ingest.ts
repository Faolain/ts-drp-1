import { type Vertex } from "@ts-drp/types";
import { vi } from "vitest";

import { type AuthenticatedVertex, type VertexAuthenticationResult } from "../../src/vertex-authentication.js";

/**
 * Batch adapter paired with this module's test-only provenance mock.
 * @param vertices - Synthetic low-level test vertices.
 * @returns The same batch typed for the runtime mock below.
 */
export function trustedTestVertices(vertices: Vertex[]): AuthenticatedVertex[] {
	return vertices as AuthenticatedVertex[];
}

/**
 * Low-level object tests historically use synthetic unsigned vertices so they
 * can isolate replay, rollback, and publication behavior. Keep that trust
 * local to the test module: production and public package consumers never see
 * a bypass or configuration switch.
 */
vi.mock("../../src/vertex-authentication.js", () => {
	return {
		authenticateVertices: (vertices: Vertex[]): AuthenticatedVertex[] => vertices as AuthenticatedVertex[],
		classifyNovelVertices: (
			vertices: Vertex[],
			_isTrustedHash: (hash: string) => boolean
		): VertexAuthenticationResult => {
			return {
				authenticated: vertices as AuthenticatedVertex[],
				invalid: [],
				occurrences: vertices.map(({ hash }) => ({ hash, status: "authenticated" })),
				offeredHashes: vertices.map(({ hash }) => hash),
			};
		},
		hasAuthenticatedVertexProvenance: (): boolean => true,
		resolveAuthenticatedVertex: (vertex: AuthenticatedVertex): AuthenticatedVertex => vertex,
	};
});
