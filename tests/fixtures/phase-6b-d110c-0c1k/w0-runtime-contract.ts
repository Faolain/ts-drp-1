import { decodeCanonical } from "@ts-drp/canonical";

import {
	commitGenuineCreatorAdoptionFixture,
	openGenuineCreatorAdoptionFixture,
} from "../phase-6a-v3/creator-adoption-contract.js";

export const W0_MAX_EPOCH_VERTICES = 8_192;
export const W0_WRITER_COUNT = 22;
export const W0_AUTHOR_SHARE_MULTIPLIER = 4;
export const W0_AUTHOR_SHARE = Math.ceil(W0_MAX_EPOCH_VERTICES / W0_WRITER_COUNT) * W0_AUTHOR_SHARE_MULTIPLIER;
export const W0_FRONTIERS_KIND = "drp-creator-author-issuance-frontiers-state";
export const W0_FRONTIERS_CEILING = 8_192;
export const W0_FENCE_ACTION = "$drp.author-fence.v1";

function seed(index: number): string {
	return (index + 101).toString(16).padStart(64, "0");
}

/**
 * Returns a stable roster of valid, distinct Ed25519 seeds.
 * @param count - Required roster size.
 * @returns Frozen deterministic private seeds.
 */
export function deterministicAuthorSeeds(count: number): readonly string[] {
	return Object.freeze(Array.from({ length: count }, (_, index) => seed(index)));
}

/**
 * Runs preparation/recovery, creator close, verification, and adoption for one accepted ACL size.
 * @param memberCount - Accepted W0 boundary size.
 * @returns Real close count and committed recovery disposition.
 */
export async function exerciseAcceptedAclLifecycle(memberCount: 31 | 64): Promise<
	Readonly<{
		readonly closeCount: number;
		readonly committedRecovery: unknown;
	}>
> {
	const fixture = await openGenuineCreatorAdoptionFixture({
		authorizedPrivateKeySeedHexes: deterministicAuthorSeeds(memberCount),
		latchedAclGroups: Object.freeze(["admin", "finality", "referee", "writer"]),
	});
	try {
		const committed = await commitGenuineCreatorAdoptionFixture(fixture);
		return Object.freeze({
			closeCount: fixture.evidence.closeResult.closedVertexCount,
			committedRecovery: committed.recovery,
		});
	} finally {
		await fixture.close();
	}
}

/**
 * Returns the real preparation failure at the forbidden 65-member boundary.
 * @returns Failure detail, or undefined if the invalid lifecycle opened.
 */
export async function rejectedAclLifecycleAt65(): Promise<string | undefined> {
	try {
		const fixture = await openGenuineCreatorAdoptionFixture({
			authorizedPrivateKeySeedHexes: deterministicAuthorSeeds(65),
		});
		await fixture.close();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Exercises one real recognized creator-close record below and above its byte ceiling.
 * @returns Fitting acceptance and loud oversize failure detail.
 */
export async function exerciseCreatorCloseOversize(): Promise<
	Readonly<{
		readonly fittingAccepted: boolean;
		readonly oversizeFailure: string | undefined;
	}>
> {
	const fixture = await openGenuineCreatorAdoptionFixture();
	try {
		const fitting = await fixture.handle.inspectDurableHead();
		fixture.controls.activeRefLengthMutation = Object.freeze({
			byteLength: W0_FRONTIERS_CEILING + 1,
			kind: W0_FRONTIERS_KIND,
		});
		let oversizeFailure: string | undefined;
		try {
			await fixture.handle.inspectDurableHead();
		} catch (error) {
			oversizeFailure = error instanceof Error ? error.message : String(error);
		}
		return Object.freeze({ fittingAccepted: fitting.references.length > 0, oversizeFailure });
	} finally {
		await fixture.close();
	}
}

function decodedRow(bytes: Uint8Array): Readonly<Record<string, unknown>> {
	const decoded = decodeCanonical(bytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D110C_0C1K_JOURNAL_ROW_INVALID");
	}
	return decoded as Readonly<Record<string, unknown>>;
}

/**
 * Runs the fixed-profile multi-writer share boundary through real ingress, issue, journal, and close paths.
 * @returns Runtime admission, accounting, progress, and close observations.
 */
export async function exerciseAuthorShareRuntime(): Promise<
	Readonly<{
		readonly causalJoinCount: number;
		readonly closeCount: number;
		readonly fenceCount: number;
		readonly globalCapacityRemaining: number;
		readonly journalCount: number;
		readonly offenderCount: number;
		readonly offenderOverflowAdmitted: boolean;
		readonly otherWriterProgressed: boolean;
	}>
> {
	const seeds = deterministicAuthorSeeds(W0_WRITER_COUNT);
	let offenderAuthor = "";
	let offenderOverflowAdmitted = false;
	let markerDigest = "";
	const fixture = await openGenuineCreatorAdoptionFixture({
		authorizedPrivateKeySeedHexes: seeds,
		causalJoinOperation: true,
		beforeCreatorClose: async ({
			createRegisteredVertex,
			initialDependency,
			plane,
			routeRegisteredVertex,
			routeRegisteredVertexUnchecked,
			signRegisteredVertexDigest,
			wasRegisteredVertexAdmitted,
		}) => {
			const fence = createRegisteredVertex({
				authorSequence: 0,
				dependencies: [initialDependency],
				logicalTime: 3,
				operation: Object.freeze({ action: W0_FENCE_ACTION, fenceSequence: 0, version: 1 }),
				privateKeySeedHex: seeds[20] as string,
			});
			if (!routeRegisteredVertexUnchecked(fence, "d110c-w0-fence")) {
				throw new TypeError("D110C_0C1K_FENCE_NOT_CLAIMED");
			}
			const drainMarker = createRegisteredVertex({
				authorSequence: 0,
				dependencies: [initialDependency],
				logicalTime: 3,
				operation: Object.freeze({ action: "add", value: 19 }),
				privateKeySeedHex: seeds[19] as string,
			});
			await routeRegisteredVertex(drainMarker, "d110c-w0-fence-drain");
			const offenderFirst = createRegisteredVertex({
				authorSequence: 0,
				dependencies: [initialDependency],
				logicalTime: 3,
				operation: Object.freeze({ action: "add", value: 1 }),
				privateKeySeedHex: seeds[1] as string,
			});
			offenderAuthor = offenderFirst.author;
			await routeRegisteredVertex(offenderFirst, "d110c-w0-offender");
			for (let writer = 2; writer < 17; writer += 1) {
				await routeRegisteredVertex(
					createRegisteredVertex({
						authorSequence: 0,
						dependencies: [initialDependency],
						logicalTime: 3,
						operation: Object.freeze({ action: "add", value: writer }),
						privateKeySeedHex: seeds[writer] as string,
					}),
					`d110c-w0-tip-${writer}`
				);
			}
			const joined = await plane.issueLocal({
				operations: Object.freeze([
					Object.freeze({ logicalTime: 4, operation: Object.freeze({ action: "add", value: 1 }) }),
				]),
				signRegisteredVertexDigest,
			});
			if (!joined.ok) throw new TypeError(`D110C_0C1K_JOIN_ISSUE_FAILED:${joined.kind}:${joined.detail}`);

			let offenderDependency = Buffer.from(offenderFirst.digest).toString("hex");
			for (let authorSequence = 1; authorSequence < W0_AUTHOR_SHARE; authorSequence += 1) {
				const vertex = createRegisteredVertex({
					authorSequence,
					dependencies: [offenderDependency],
					logicalTime: authorSequence + 3,
					operation: Object.freeze({ action: "add", value: 1 }),
					privateKeySeedHex: seeds[1] as string,
				});
				await routeRegisteredVertex(vertex, "d110c-w0-offender");
				offenderDependency = Buffer.from(vertex.digest).toString("hex");
			}
			const overflow = createRegisteredVertex({
				authorSequence: W0_AUTHOR_SHARE,
				dependencies: [offenderDependency],
				logicalTime: W0_AUTHOR_SHARE + 3,
				operation: Object.freeze({ action: "add", value: 1 }),
				privateKeySeedHex: seeds[1] as string,
			});
			if (!routeRegisteredVertexUnchecked(overflow, "d110c-w0-overflow")) {
				throw new TypeError("D110C_0C1K_OVERFLOW_NOT_CLAIMED");
			}
			const marker = createRegisteredVertex({
				authorSequence: 0,
				dependencies: [offenderDependency],
				logicalTime: W0_AUTHOR_SHARE + 4,
				operation: Object.freeze({ action: "add", value: 1 }),
				privateKeySeedHex: seeds[18] as string,
			});
			markerDigest = Buffer.from(marker.digest).toString("hex");
			await routeRegisteredVertex(marker, "d110c-w0-other-writer");
			offenderOverflowAdmitted = wasRegisteredVertexAdmitted(overflow);
			const afterRejection = await plane.issueLocal({
				operations: Object.freeze([
					Object.freeze({
						logicalTime: W0_AUTHOR_SHARE + 5,
						operation: Object.freeze({ action: "add", value: 1 }),
					}),
				]),
				signRegisteredVertexDigest,
			});
			if (!afterRejection.ok) {
				throw new TypeError(`D110C_0C1K_OTHER_WRITER_LOCAL_FAILED:${afterRejection.kind}:${afterRejection.detail}`);
			}
			return Object.freeze({ authorSequence: afterRejection.authorSequence, digest: afterRejection.digest });
		},
	});
	try {
		const decodedRows = await Promise.all(
			fixture.evidence.journalRows.map(async (row) => {
				if (row.sourceKind === "received") return decodedRow(row.exactCanonicalPreimageBytes);
				const issued = await fixture.evidence.issuanceStore.readIssued(
					Object.freeze({ author: row.author, objectId: fixture.evidence.issuanceScope.objectId }),
					row.authorSequence
				);
				if (issued === null) throw new TypeError("D110C_0C1K_LOCAL_ROW_UNAVAILABLE");
				return decodedRow(issued.envelope.canonicalPreimageBytes);
			})
		);
		const rowDigests = new Set(fixture.evidence.journalRows.map(({ vertexDigest }) => vertexDigest));
		return Object.freeze({
			causalJoinCount: decodedRows.filter(({ operation }) =>
				operation !== null && typeof operation === "object"
					? (operation as Readonly<Record<string, unknown>>).action === "causalJoin"
					: false
			).length,
			closeCount: fixture.evidence.closeResult.closedVertexCount,
			fenceCount: decodedRows.filter(({ operation }) =>
				operation !== null && typeof operation === "object"
					? (operation as Readonly<Record<string, unknown>>).action === W0_FENCE_ACTION
					: false
			).length,
			globalCapacityRemaining: W0_MAX_EPOCH_VERTICES - decodedRows.length,
			journalCount: decodedRows.length,
			offenderCount: decodedRows.filter(({ author }) => author === offenderAuthor).length,
			offenderOverflowAdmitted,
			otherWriterProgressed: rowDigests.has(markerDigest),
		});
	} finally {
		await fixture.close();
	}
}
