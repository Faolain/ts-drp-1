import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import type { V3RoomApplication } from "@ts-drp/node/v3-room";

type ResourceBoundReader = NonNullable<V3RoomApplication["readOrdinaryApplicationResourceBound"]>;

/**
 * Chat's ordinary resource bound (Track Q): the state-capture ceiling, which dominates every
 * state the Chat capture accepts for any material and reads no operation. The incremental
 * projection states the SAME theorem: it validates the bases exactly as the complete reader does,
 * once, and every quote is the same ceiling; advancing by admitted operations cannot change it.
 * Planning only: it grants no validity, admission, authority or credit.
 * @param validBases - The format's exact catalog/material check and base capture; true when every
 * base is this composition's own authenticated state (`projection`: the input has no candidate).
 * @param ceiling - The capture's enforced state limits.
 * @returns The reader, with its incremental projection.
 */
export function shippingChatCeilingResourceBound(
	validBases: (input: unknown, projection: boolean) => boolean,
	ceiling: Readonly<{ maxBytes: number; maxItems: number; maxDepth: number }>
): ResourceBoundReader {
	const footprint = (): CanonicalResourceFootprint =>
		Object.freeze({ byteLength: ceiling.maxBytes, items: ceiling.maxItems, maxDepth: ceiling.maxDepth });
	const checked = (input: unknown, projection: boolean): boolean => {
		try {
			return validBases(input, projection);
		} catch {
			return false;
		}
	};
	return Object.assign(
		(input: Parameters<ResourceBoundReader>[0]): CanonicalResourceFootprint | undefined =>
			checked(input, false) ? footprint() : undefined,
		{
			createIncrementalProjection: (input: unknown) =>
				checked(input, true)
					? Object.freeze({
							advance: (operations: readonly unknown[]): boolean => Array.isArray(operations),
							quote: (_candidateOperation: unknown): CanonicalResourceFootprint => footprint(),
							quoteWithoutApplicationCandidate: (): CanonicalResourceFootprint => footprint(),
						})
					: undefined,
		}
	);
}
