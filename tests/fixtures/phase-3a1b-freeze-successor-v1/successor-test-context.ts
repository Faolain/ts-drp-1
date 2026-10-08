import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SuccessorContract } from "./successor-contract-type.js";
import contractJson from "./successor-contract.json" with { type: "json" };

export const FREEZE_SUCCESSOR_FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(FREEZE_SUCCESSOR_FIXTURE_ROOT, "../../..");
export const successorContract = contractJson as unknown as SuccessorContract;

/**
 * Normalizes child-process output without leaking the checkout location.
 * @param result - Child-process evidence to normalize.
 * @returns Output with the repository path replaced by a stable marker.
 */
export function normalizedChildOutput(result: Readonly<{ readonly output: string }>): string {
	return result.output.replaceAll(REPOSITORY_ROOT, "<repository>");
}
