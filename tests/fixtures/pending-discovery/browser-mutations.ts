import type { NativeMutations, OwnerCase } from "./types.js";
import type { SnapshotQuarantineScopeKey } from "../../../packages/storage/dist/src/snapshot-transfer.js";

/**
 * Await a real native IndexedDB request.
 * @param value - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = (): void => resolve(value.result);
		value.onerror = (): void => reject(value.error);
	});
}

/**
 * Mutate native durable rows in a strict transaction, then close its client.
 * @param name - Explicit fixture-owned input for this isolated control.
 * @param stores - Explicit fixture-owned input for this isolated control.
 * @param action - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export async function transaction(
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
 * @param identity - Explicit fixture-owned input for this isolated control.
 * @returns Original production values or isolated fixture evidence.
 */
export function browserMutations(identity: string): NativeMutations {
	const mutate = (
		mode: OwnerCase,
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
				[
					"missing-metadata",
					"delete-after-lookup",
					"poisoned",
					"open",
					"legacy-open",
					"legacy-verified",
					"expired-temporary",
					"expired-temporary-legacy-elsewhere",
					"open-legacy-elsewhere",
				].includes(mode)
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
			if (["expired-recovery", "expiry-after-acquisition"].includes(mode)) {
				await request(scopes.put({ ...row, expiresAt: 1 }));
				return 1;
			}
			if (["expired-temporary", "expired-temporary-legacy-elsewhere", "open-legacy-elsewhere"].includes(mode)) {
				if (mode.endsWith("legacy-elsewhere")) {
					const other = ((await request(scopes.getAll())) as Record<string, unknown>[]).filter(
						(r) => r.objectId === objectId && r.epoch !== epoch
					);
					if (other.length !== 1) throw new Error("LEGACY_OTHER_SCOPE_NOT_UNIQUE");
					const neighbor = other[0] as Record<string, unknown>;
					await request(scopes.put({ ...neighbor, retention: "legacy-unclassified", descriptors: null }));
					const owner = (await request(tx.objectStore("owner").get("owner"))) as Record<string, unknown>;
					await request(
						tx.objectStore("owner").put({
							...owner,
							legacyUnclassifiedScopes: 1,
							legacyUnclassifiedContentBytes:
								Number(neighbor.totalBytes) + (neighbor.exactCanonicalManifestBytes as Uint8Array).byteLength,
							migration: "classification-required",
						})
					);
				}
				await request(
					scopes.put({
						...row,
						retention: "temporary",
						state: mode === "open-legacy-elsewhere" ? "open" : "verified",
						expiresAt: mode === "open-legacy-elsewhere" ? Date.now() + 86400000 : 1,
					})
				);
				return 1;
			}
			if (mode === "poisoned" || mode === "open") {
				await request(scopes.put({ ...row, retention: "temporary", state: mode === "poisoned" ? "poisoned" : "open" }));
				return 1;
			}
			if (mode === "legacy-open" || mode === "legacy-verified") {
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
				await request(
					scopes.put({
						...row,
						retention: "legacy-unclassified",
						state: mode === "legacy-verified" ? "verified" : "open",
						descriptors: null,
					})
				);
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
		before: async (mode, bootstrap): Promise<number> => {
			if (mode === "expiry-after-acquisition")
				return mutate("open", bootstrap.expectedPreviousRoomHead.objectId, bootstrap.expectedPreviousRoomHead.epoch);
			if (
				[
					"verified",
					"lookup-rejected",
					"narrow-store",
					"delete-after-lookup",
					"replace-after-lookup",
					"identical-replacement",
				].includes(mode)
			)
				return 0;
			return mutate(mode, bootstrap.expectedPreviousRoomHead.objectId, bootstrap.expectedPreviousRoomHead.epoch);
		},
		after: async (mode, scope) =>
			["delete-after-lookup", "replace-after-lookup", "identical-replacement", "expiry-after-acquisition"].includes(
				mode
			)
				? mutate(mode, scope.objectId, scope.epoch, scope)
				: 0,
	};
}
