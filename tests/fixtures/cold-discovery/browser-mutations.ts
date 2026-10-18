import { type AuthFaultGraph, isAuthFaultCase, planAuthFault, verifyAuthFaultPersistence } from "./auth-fault-plan.js";
import type { AuthMutationReceipt, NativeMutations, RecoveryCase, RestartBootstrap } from "./types.js";
import type { SnapshotQuarantineScopeKey } from "../../../packages/storage/dist/src/snapshot-transfer.js";

/**
 * Await a real native IndexedDB request.
 * @param value
 */
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = (): void => resolve(value.result);
		value.onerror = (): void => reject(value.error);
	});
}

/**
 * Mutate native durable rows in a strict transaction, then close its client.
 * @param name
 * @param stores
 * @param action
 */
async function transaction(
	name: string,
	stores: string[],
	action: (tx: IDBTransaction) => Promise<number>
): Promise<number> {
	const db = await request(indexedDB.open(name));
	try {
		const tx = db.transaction(stores, "readwrite", { durability: "strict" });
		if (tx.durability !== "strict") throw new Error("MUTATION_STRICT_DURABILITY_UNAVAILABLE");
		const done = new Promise<void>((resolve, reject) => {
			tx.oncomplete = (): void => resolve();
			tx.onabort = (): void => reject(tx.error);
		});
		try {
			const result = await action(tx);
			await done;
			return result;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				/* Already terminal. */
			}
			await done.catch(() => undefined);
			throw error;
		}
	} finally {
		db.close();
	}
}

/**
 * Native fixture-only corruption never replaces the product metadata or byte reader.
 * @param identity
 */
export function browserMutations(identity: string): NativeMutations {
	let authMutation: AuthMutationReceipt | undefined;
	const mutate = (
		mode: RecoveryCase,
		objectId: string,
		epoch: number,
		scope?: SnapshotQuarantineScopeKey
	): Promise<number> =>
		transaction(`${identity}--drp-snapshot-quarantine-v1`, ["scopes", "chunks", "owner"], async (tx) => {
			const scopes = tx.objectStore("scopes"),
				chunks = tx.objectStore("chunks");
			const rows = ((await request(scopes.getAll())) as Record<string, unknown>[]).filter(
				(row) => row.objectId === objectId && row.epoch === epoch
			);
			if (rows.length !== 1) throw new Error(`MUTATION_TARGET_NOT_UNIQUE:${rows.length}`);
			const row = rows[0] as Record<string, unknown>;
			if (scope !== undefined && (row.anchor !== scope.anchor || row.manifestDigest !== scope.manifestDigest))
				throw new Error("MUTATION_KEY_DIFFERS");
			const key = [objectId, epoch, String(row.anchor), String(row.manifestDigest)];
			if (
				row.retention === "recovery" &&
				["missing-metadata", "delete-after-lookup", "poisoned", "open", "legacy"].includes(mode)
			) {
				const owner = (await request(tx.objectStore("owner").get("owner"))) as Record<string, unknown>;
				await request(
					tx.objectStore("owner").put({
						...owner,
						recoveryScopes: Number(owner.recoveryScopes) - 1,
						recoveryContentBytes:
							Number(owner.recoveryContentBytes) -
							Number(row.totalBytes) -
							(row.exactCanonicalManifestBytes as Uint8Array).byteLength,
					})
				);
			}
			const bodies = ((await request(chunks.getAll())) as Record<string, unknown>[]).filter(
				(value) =>
					value.objectId === objectId &&
					value.epoch === epoch &&
					value.anchor === row.anchor &&
					value.manifestDigest === row.manifestDigest
			);
			if (["missing-metadata", "delete-after-lookup", "same-triple-conflict"].includes(mode)) {
				for (const body of bodies) await request(chunks.delete([...key, Number(body.index)]));
				await request(scopes.delete(key));
				if (mode === "same-triple-conflict") await request(scopes.add({ ...row, manifestDigest: "f".repeat(64) }));
				return 1;
			}
			if (mode === "poisoned" || mode === "open") {
				await request(scopes.put({ ...row, retention: "temporary", state: mode === "poisoned" ? "poisoned" : "open" }));
				return 1;
			}
			if (mode === "legacy") {
				const owner = (await request(tx.objectStore("owner").get("owner"))) as Record<string, unknown>;
				await request(
					tx.objectStore("owner").put({
						...owner,
						legacyUnclassifiedScopes: 1,
						legacyUnclassifiedContentBytes:
							Number(row.totalBytes) + (row.exactCanonicalManifestBytes as Uint8Array).byteLength,
						migration: "classification-required",
					})
				);
				await request(scopes.put({ ...row, retention: "legacy-unclassified", state: "open", descriptors: null }));
				return 1;
			}
			if (mode === "replace-after-lookup" || mode === "identical-replacement")
				await request(scopes.put({ ...row, incarnation: crypto.randomUUID() }));
			if (mode === "identical-replacement") return 1;
			const body = bodies.sort((left, right) => Number(left.index) - Number(right.index))[0];
			if (body === undefined) throw new Error("MUTATION_CHUNK_MISSING_BEFORE_FAULT");
			if (mode === "missing-chunk") {
				await request(chunks.delete([...key, Number(body.index)]));
				return 1;
			}
			if (mode === "corrupt-chunk" || mode === "replace-after-lookup") {
				const bytes = Uint8Array.from(body.exactBytes as Uint8Array);
				bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
				await request(chunks.put({ ...body, exactBytes: bytes }));
				return 1;
			}
			throw new Error(`UNKNOWN_NATIVE_MUTATION:${mode}`);
		});
	return {
		get authMutation(): AuthMutationReceipt | undefined {
			return authMutation;
		},
		before: async (mode: RecoveryCase, bootstrap: RestartBootstrap): Promise<number> => {
			if (isAuthFaultCase(mode)) {
				let receipt: AuthMutationReceipt | undefined;
				const result = await transaction(
					`${identity}--ahe`,
					["objects", "generations", "blobs", "promotions"],
					async (tx) => {
						const objectId = bootstrap.expectedRoomHead.objectId;
						const graph = async (): Promise<AuthFaultGraph> => {
							const head = (await request(tx.objectStore("objects").get(objectId))) as
								| Record<string, unknown>
								| undefined;
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
						receipt = plan.receipt;
						return plan.receipt.faultApplications;
					}
				);
				authMutation = receipt;
				return result;
			}
			return [
				"missing-metadata",
				"poisoned",
				"open",
				"legacy",
				"same-triple-conflict",
				"missing-chunk",
				"corrupt-chunk",
			].includes(mode)
				? mutate(mode, bootstrap.expectedRoomHead.objectId, bootstrap.expectedRoomHead.epoch - 1)
				: 0;
		},
		after: async (mode, scope) =>
			["delete-after-lookup", "replace-after-lookup", "identical-replacement"].includes(mode)
				? mutate(mode, scope.objectId, scope.epoch, scope)
				: 0,
	};
}
