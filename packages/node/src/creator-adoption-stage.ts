import "./creator-adoption-commit.js";

import { consumeCreatorAdoptionPublish, consumeCreatorAdoptionStage } from "./internal/creator-adoption-stage.js";

/**
 * Durably completes one authenticated successor without publishing its AHE head.
 * @param input - Exact genuine close handle and owner-bound adoption intent.
 * @returns Opaque staged custody or a typed fail-closed result.
 */
export function stageCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	return consumeCreatorAdoptionStage(input);
}

/**
 * Publishes one owner-bound staged successor through the exact AHE head CAS.
 * @param input - Exact staged capability and genuine close handle.
 * @returns Existing prepared-activation custody or a typed fail-closed result.
 */
export function publishStagedCreatorSuccessorAdoption(input: unknown): Promise<Readonly<Record<string, unknown>>> {
	return consumeCreatorAdoptionPublish(input);
}
