import { openBrowserRoomOwnerConnection, openPhase2dInternalDatabase, PHASE_5C_STORAGE_META_STORE } from "./schema-idb.js";
import { SigningRetirementOwner } from "./signing-retirement.js";
import {storedSealPlainRecord} from "@ts-drp/seal/internal/storage-port";

/** One original connection/incarnation/lifetime, never a database-name registry. */
export async function openSigningBackend(input: Readonly<{databaseName: string; onVersionChange?(): void}>,
	room = false) {
	let database: IDBDatabase | undefined, participant: SigningRetirementOwner | undefined;
	const onVersionChange = (): void => {
		database?.close();
		void participant?.close().catch(() => { /* Native versionchange already revoked the connection. */ });
		input.onVersionChange?.();
	};
	// Room mode (slice 14a): the same version-6 signing stores inside a ready version-7
	// room database, on the signing owner's own connection; never created or upgraded here.
	database = room
		? await openBrowserRoomOwnerConnection(input.databaseName, "signing", onVersionChange)
		: await openPhase2dInternalDatabase({databaseName: input.databaseName}, onVersionChange) as IDBDatabase;
	let terminal: Promise<void> | undefined;
	try {
		const transaction = database.transaction(PHASE_5C_STORAGE_META_STORE, "readonly");
		terminal = new Promise<void>((resolve, reject) => {
			transaction.addEventListener("complete", () => resolve(), {once: true});
			transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("NATIVE_ABORT")), {once: true});
		});
		void terminal.catch(() => undefined);
		const request = transaction.objectStore(PHASE_5C_STORAGE_META_STORE).get("incarnation");
		const meta: unknown = await new Promise((resolve, reject) => {
			request.addEventListener("success", () => resolve(request.result), {once: true});
			request.addEventListener("error", () => reject(request.error), {once: true});
		});
		await terminal;
		if (!storedSealPlainRecord(meta) || meta.key !== "incarnation" || typeof meta.value !== "string" ||
			meta.value.length < 32) throw new Error("invalid storage incarnation row");
		const incarnation = meta.value;
		participant = new SigningRetirementOwner(database, incarnation);
		return Object.freeze({database, incarnation, participant});
	} catch (cause) { await terminal?.catch(() => undefined); database.close(); throw cause; }
}

export type SigningBackend = Awaited<ReturnType<typeof openSigningBackend>>;
