import type { CanonicalResourceFootprint } from "@ts-drp/canonical/resource";
import type { V3OperationAdmissionPolicyFactory } from "@ts-drp/node/v3-live";
import type { V3RoomApplication } from "@ts-drp/node/v3-room";

type ResourceBoundReader = NonNullable<V3RoomApplication["readOrdinaryApplicationResourceBound"]>;

/** One Chat composition's ordinary resource bound and the admission policy it depends on. */
export type ShippingChatCeilingResourceBound = Readonly<{
	/** The complete reader, with its incremental projection. */
	reader: ResourceBoundReader;
	/**
	 * Wraps the composition's own admission policy factory: once the room has built a policy from
	 * it, the reader offers its incremental projection.
	 */
	admissionPolicy(factory: V3OperationAdmissionPolicyFactory): V3OperationAdmissionPolicyFactory;
}>;

/**
 * Chat's ordinary resource bound (Track Q): the state-capture ceiling, which dominates every
 * state the Chat capture accepts for any material and reads no operation. The incremental
 * projection states the SAME theorem: it validates the bases exactly as the complete reader does,
 * once, and every quote is the same ceiling; advancing by admitted operations cannot change it.
 * Planning only: it grants no validity, admission, authority or credit.
 *
 * The ceiling sits below the canonical encoding limits only because the composition's admission
 * policy refuses every reservation whose joined state the capture would refuse; the compiled
 * reducer alone does not. The reader travels with the application, but the room takes the policy
 * from its host (`createOperationAdmissionPolicy` is a session input). So the incremental
 * projection, whose quote the creator's warm path consumes on every admission, is offered only
 * after the room has built a policy from this composition's own factory (`admissionPolicy`). A
 * host that installs no policy, or a different one, gets no projection, and the creator keeps its
 * complete exact fallback.
 * @param validBases - The format's exact catalog/material check and base capture; true when every
 * base is this composition's own authenticated state (`projection`: the input has no candidate).
 * @param ceiling - The capture's enforced state limits.
 * @returns The reader and the admission policy wrapper.
 */
export function shippingChatCeilingResourceBound(
	validBases: (input: unknown, projection: boolean) => boolean,
	ceiling: Readonly<{ maxBytes: number; maxItems: number; maxDepth: number }>
): ShippingChatCeilingResourceBound {
	let admissionPolicyBuilt = false;
	const footprint = (): CanonicalResourceFootprint =>
		Object.freeze({ byteLength: ceiling.maxBytes, items: ceiling.maxItems, maxDepth: ceiling.maxDepth });
	const checked = (input: unknown, projection: boolean): boolean => {
		try {
			return validBases(input, projection);
		} catch {
			return false;
		}
	};
	const reader: ResourceBoundReader = Object.assign(
		(input: Parameters<ResourceBoundReader>[0]): CanonicalResourceFootprint | undefined =>
			checked(input, false) ? footprint() : undefined,
		{
			createIncrementalProjection: (input: unknown) =>
				admissionPolicyBuilt && checked(input, true)
					? Object.freeze({
							advance: (operations: readonly unknown[]): boolean => Array.isArray(operations),
							quote: (_candidateOperation: unknown): CanonicalResourceFootprint => footprint(),
							quoteWithoutApplicationCandidate: (): CanonicalResourceFootprint => footprint(),
						})
					: undefined,
		}
	);
	return Object.freeze({
		reader,
		admissionPolicy:
			(factory: V3OperationAdmissionPolicyFactory): V3OperationAdmissionPolicyFactory =>
			(context) => {
				const policy = factory(context);
				admissionPolicyBuilt = true;
				return policy;
			},
	});
}
