import { type AuthFaultGraph, isAuthFaultCase, planAuthFault, verifyAuthFaultPersistence } from "./auth-fault-plan.js";
import { request, transaction } from "./browser-mutations.js";
import type { RecoveryCase, RestartBootstrap } from "./types.js";
/**
 * Run the named pending-only fixture seam.
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @param bootstrap - Explicit fixture-owned input for this isolated control.
 * @param mode - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function browserAuthMutation(
	identity: string,
	bootstrap: RestartBootstrap,
	mode: RecoveryCase
): Promise<number> {
	if (isAuthFaultCase(mode)) {
		const result = await transaction(
			`${identity}--ahe`,
			["objects", "generations", "blobs", "promotions"],
			async (tx) => {
				const objectId = bootstrap.expectedPreviousRoomHead.objectId;
				const graph = async (): Promise<AuthFaultGraph> => {
					const head = (await request(tx.objectStore("objects").get(objectId))) as Record<string, unknown> | undefined;
					const generations = (await request(tx.objectStore("generations").getAll())) as Record<string, unknown>[];
					const blobs = (await request(tx.objectStore("blobs").getAll())) as Record<string, unknown>[];
					const promotions = (await request(tx.objectStore("promotions").getAll())) as Record<string, unknown>[];
					return {
						headRecord: head?.record as Uint8Array,
						generations: generations
							.filter((row) => row.objectId === objectId)
							.map((row) => ({ generationId: String(row.generationId), record: row.record as Uint8Array })),
						blobs: blobs.map((row) => ({ digest: String(row.digest), bytes: row.bytes as Uint8Array })),
						promotions: promotions
							.filter((row) => row.objectId === objectId)
							.map((row) => ({ generationId: String(row.generationId), digest: String(row.digest) })),
					};
				};
				const before = await graph(),
					plan = planAuthFault(before, bootstrap, mode);
				await request(tx.objectStore("blobs").put(plan.blob));
				for (const row of plan.generations) await request(tx.objectStore("generations").put({ objectId, ...row }));
				for (const row of plan.promotions) {
					await request(tx.objectStore("promotions").delete([objectId, row.generationId, row.fromDigest]));
					await request(
						tx.objectStore("promotions").add({ objectId, generationId: row.generationId, digest: row.toDigest })
					);
				}
				if (plan.headRecord !== undefined)
					await request(tx.objectStore("objects").put({ objectId, record: plan.headRecord }));
				verifyAuthFaultPersistence(before, await graph(), plan);

				return plan.receipt.faultApplications;
			}
		);

		return result;
	}
	return 0;
}
