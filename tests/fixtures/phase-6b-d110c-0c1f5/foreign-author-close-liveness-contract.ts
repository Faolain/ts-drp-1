import type { V3LocalIssueResult } from "../../../packages/node/src/v3-live.js";
import { d108d1bChatAuthorities } from "../phase-6a-v3/creator-successor-local-author-contract.js";
import {
	type D110cARepeatCloseOptions,
	openD110cARepeatCloseFixture,
} from "../phase-6b-d110c-a/repeat-close-contract.js";

export const D110C_0C1F5_FOREIGN_AUTHOR_CLOSE_LIVENESS_REQUIRED =
	"D110C_0C1F5_FOREIGN_AUTHOR_CLOSE_LIVENESS_REQUIRED" as const;

const LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED = "D110C_0C1F1_LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED";
const BOUNDARY_REGRESSED = "creator issuance-frontier boundary regressed";
const AUTHOR_SLOT_AMBIGUOUS = "creator issuance-frontier author slot is ambiguous";
const SNAPSHOT_NOT_ACTIVE = "creator snapshot export failed: not-active";

type RepeatCloseContext = Parameters<NonNullable<D110cARepeatCloseOptions["beforeRepeatCloseBinding"]>>[0];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function acceptedIssue(
	result: V3LocalIssueResult,
	label: string
): Readonly<{ authorSequence: number; digest: string }> {
	if (result.ok !== true) throw new TypeError(`${label}:${result.kind}`);
	return Object.freeze({ authorSequence: result.authorSequence, digest: result.digest });
}

function twoWriterAuthorities(): Readonly<{
	readonly creator: ReturnType<typeof d108d1bChatAuthorities>[number];
	readonly foreign: ReturnType<typeof d108d1bChatAuthorities>[number];
}> {
	const authorities = d108d1bChatAuthorities();
	const creator = authorities.find(({ id }) => id === "alice");
	const foreign = authorities.find(({ id }) => id === "bob");
	if (creator === undefined || foreign === undefined) {
		throw new TypeError("D110C_0C1F5_TWO_WRITER_AUTHORITY_UNAVAILABLE");
	}
	return Object.freeze({ creator, foreign });
}

async function routeVertex(
	context: RepeatCloseContext,
	input: Readonly<{
		readonly authorSequence: number;
		readonly dependency?: string;
		readonly logicalTime: number;
		readonly privateKeySeedHex: string;
		readonly value: number;
	}>
): Promise<void> {
	const vertex = context.createRegisteredVertex({
		anchor: context.currentAnchorDigest,
		authorSequence: input.authorSequence,
		dependencies: [input.dependency ?? context.latestDependencyDigest],
		epoch: context.currentEpoch,
		logicalTime: input.logicalTime,
		objectId: context.plane.objectId,
		operation: Object.freeze({ action: "add", value: input.value }),
		privateKeySeedHex: input.privateKeySeedHex,
	});
	await context.routeRegisteredVertex(vertex, `d110c-0c1f5-${input.logicalTime}`);
}

async function observedCloseError(options: D110cARepeatCloseOptions, expected: string, label: string): Promise<void> {
	try {
		const fixture = await openD110cARepeatCloseFixture({ ...options, retainedControls: false });
		await fixture.close();
		throw new TypeError(`${label}:UNEXPECTED_CLOSE_SUCCESS`);
	} catch (error) {
		const observed = errorMessage(error);
		if (observed !== expected) {
			throw new TypeError(`${label}:NONCAUSAL_ERROR:${observed}`);
		}
	}
}

function revokedForeignCreatorOptions(
	creator: ReturnType<typeof d108d1bChatAuthorities>[number],
	foreign: ReturnType<typeof d108d1bChatAuthorities>[number]
): NonNullable<D110cARepeatCloseOptions["creator"]> {
	return Object.freeze({
		authorizedPrivateKeySeedHexes: Object.freeze([creator.privateKeySeedHex, foreign.privateKeySeedHex]),
		beforeCreatorClose: async ({ firstLogicalTime, plane, signRegisteredVertexDigest }) => {
			const result = await plane.issueLocal({
				operations: Object.freeze([
					Object.freeze({
						logicalTime: firstLogicalTime,
						operation: Object.freeze({
							action: "acl",
							group: "writer",
							kind: "revoke",
							target: foreign.author,
						}),
					}),
				]),
				signRegisteredVertexDigest,
			});
			return acceptedIssue(result, "D110C_0C1F5_INITIAL_REVOKE_FAILED");
		},
	});
}

function exactFrontiers(record: Readonly<Record<string, unknown>>): readonly (readonly [string, number | null])[] {
	if (!Array.isArray(record.frontiers)) throw new TypeError("D110C_0C1F5_FRONTIERS_UNAVAILABLE");
	return record.frontiers.map((entry) => {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			(entry[1] !== null && !Number.isSafeInteger(entry[1]))
		) {
			throw new TypeError("D110C_0C1F5_FRONTIER_ENTRY_INVALID");
		}
		return Object.freeze([entry[0], entry[1] as number | null] as const);
	});
}

async function stageForeignRemoval(
	context: RepeatCloseContext,
	foreignAuthor: string,
	logicalTime: number
): Promise<void> {
	acceptedIssue(
		await context.plane.issueLocal({
			operations: Object.freeze([
				Object.freeze({
					logicalTime,
					operation: Object.freeze({
						action: "acl",
						group: "writer",
						kind: "revoke",
						target: foreignAuthor,
					}),
				}),
			]),
			signRegisteredVertexDigest: context.signRegisteredVertexDigest,
		}),
		"D110C_0C1F5_SUCCESSOR_REVOKE_FAILED"
	);
}

async function latestCreatorSequence(context: RepeatCloseContext, label: string): Promise<number> {
	const lineage = await context.issuanceStore.readLineage(context.issuanceScope);
	if (lineage.exhausted !== false || !Number.isSafeInteger(lineage.next) || lineage.next <= 0) {
		throw new TypeError(`${label}:CREATOR_LINEAGE_INVALID`);
	}
	return lineage.next - 1;
}

/**
 * Demonstrates that foreign-author frontier anomalies currently abort an
 * otherwise valid creator close, while creator corruption remains fail closed.
 */
export async function proveD110c0c1f5ForeignAuthorCloseLivenessRequired(): Promise<void> {
	const { creator, foreign } = twoWriterAuthorities();
	const twoWriterSeeds = Object.freeze([creator.privateKeySeedHex, foreign.privateKeySeedHex]);

	await observedCloseError(
		{
			creator: Object.freeze({ authorizedPrivateKeySeedHexes: twoWriterSeeds }),
			beforeRepeatCloseBinding: async (context) => {
				await routeVertex(context, {
					authorSequence: 2,
					logicalTime: 50,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 50,
				});
			},
		},
		LEGACY_MULTI_AUTHOR_MIGRATION_REQUIRED,
		"D110C_0C1F5_NULL_PRIOR"
	);

	await observedCloseError(
		{
			creator: Object.freeze({
				authorizedPrivateKeySeedHexes: twoWriterSeeds,
				establishedPeerPrivateKeySeedHex: foreign.privateKeySeedHex,
			}),
			beforeRepeatCloseBinding: async (context) => {
				await routeVertex(context, {
					authorSequence: 0,
					logicalTime: 53,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 53,
				});
			},
		},
		BOUNDARY_REGRESSED,
		"D110C_0C1F5_FOREIGN_REGRESSION"
	);

	await observedCloseError(
		{
			creator: Object.freeze({
				authorizedPrivateKeySeedHexes: twoWriterSeeds,
				establishedPeerPrivateKeySeedHex: foreign.privateKeySeedHex,
			}),
			beforeRepeatCloseBinding: async (context) => {
				await routeVertex(context, {
					authorSequence: 1,
					logicalTime: 54,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 54,
				});
				await routeVertex(context, {
					authorSequence: 1,
					logicalTime: 55,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 55,
				});
			},
		},
		AUTHOR_SLOT_AMBIGUOUS,
		"D110C_0C1F5_FOREIGN_DUPLICATE"
	);

	await observedCloseError(
		{
			creator: Object.freeze({
				authorizedPrivateKeySeedHexes: twoWriterSeeds,
				establishedPeerPrivateKeySeedHex: foreign.privateKeySeedHex,
			}),
			beforeRepeatCloseBinding: async (context) => {
				await routeVertex(context, {
					authorSequence: 1,
					logicalTime: 60,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 60,
				});
				await routeVertex(context, {
					authorSequence: 1,
					logicalTime: 61,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 61,
				});
				await stageForeignRemoval(context, foreign.author, 62);
			},
		},
		AUTHOR_SLOT_AMBIGUOUS,
		"D110C_0C1F5_REMOVED_FOREIGN_DUPLICATE"
	);

	for (const creatorCase of [
		Object.freeze({ expected: BOUNDARY_REGRESSED, sequence: 0, label: "REGRESSION", logicalTime: 56 }),
		Object.freeze({ expected: AUTHOR_SLOT_AMBIGUOUS, sequence: null, label: "DUPLICATE", logicalTime: 57 }),
	]) {
		await observedCloseError(
			{
				creator: Object.freeze({ authorizedPrivateKeySeedHexes: twoWriterSeeds }),
				beforeRepeatCloseBinding: async (context) => {
					const sequence =
						creatorCase.sequence ?? (await latestCreatorSequence(context, `D110C_0C1F5_CREATOR_${creatorCase.label}`));
					await routeVertex(context, {
						authorSequence: sequence,
						logicalTime: creatorCase.logicalTime,
						privateKeySeedHex: creator.privateKeySeedHex,
						value: creatorCase.logicalTime,
					});
				},
			},
			creatorCase.expected,
			`D110C_0C1F5_CREATOR_${creatorCase.label}`
		);
	}

	let noGapCreatorBoundary: number | undefined;
	const noGap = await openD110cARepeatCloseFixture({
		creator: Object.freeze({
			authorizedPrivateKeySeedHexes: twoWriterSeeds,
			establishedPeerPrivateKeySeedHex: foreign.privateKeySeedHex,
		}),
		beforeRepeatCloseBinding: async (context) => {
			noGapCreatorBoundary = await latestCreatorSequence(context, "D110C_0C1F5_NO_GAP");
			await routeVertex(context, {
				authorSequence: 1,
				logicalTime: 58,
				privateKeySeedHex: foreign.privateKeySeedHex,
				value: 58,
			});
		},
		retainedControls: false,
	});
	try {
		const frontiers = exactFrontiers(noGap.evidence.authorIssuanceFrontiers.record);
		if (
			noGapCreatorBoundary === undefined ||
			frontiers.find(([author]) => author === creator.author)?.[1] !== noGapCreatorBoundary ||
			frontiers.find(([author]) => author === foreign.author)?.[1] !== 1
		) {
			throw new TypeError(`D110C_0C1F5_NO_GAP_CONTROL_INVALID:${JSON.stringify(frontiers)}`);
		}
	} finally {
		await noGap.close();
	}

	const deauthorized = await openD110cARepeatCloseFixture({
		creator: Object.freeze({
			authorizedPrivateKeySeedHexes: twoWriterSeeds,
			establishedPeerPrivateKeySeedHex: foreign.privateKeySeedHex,
		}),
		beforeRepeatCloseBinding: async (context) => {
			await routeVertex(context, {
				authorSequence: 1,
				logicalTime: 59,
				privateKeySeedHex: foreign.privateKeySeedHex,
				value: 59,
			});
			await stageForeignRemoval(context, foreign.author, 60);
		},
		retainedControls: false,
	});
	try {
		const frontiers = exactFrontiers(deauthorized.evidence.authorIssuanceFrontiers.record);
		if (frontiers.some(([author]) => author === foreign.author)) {
			throw new TypeError(`D110C_0C1F5_DEAUTHORIZED_FOREIGN_EMITTED:${JSON.stringify(frontiers)}`);
		}
	} finally {
		await deauthorized.close();
	}

	await observedCloseError(
		{
			creator: revokedForeignCreatorOptions(creator, foreign),
			beforeRepeatCloseBinding: async (context) => {
				await routeVertex(context, {
					authorSequence: 1,
					logicalTime: 63,
					privateKeySeedHex: foreign.privateKeySeedHex,
					value: 63,
				});
			},
		},
		SNAPSHOT_NOT_ACTIVE,
		"D110C_0C1F5_CURRENTLY_UNAUTHORIZED_FOREIGN"
	);

	throw new TypeError(D110C_0C1F5_FOREIGN_AUTHOR_CLOSE_LIVENESS_REQUIRED);
}
