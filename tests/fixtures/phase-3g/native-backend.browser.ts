import { createBrowserAheDurableStore } from "../../../packages/storage-browser/src/index.js";
import { createBrowserDurableIssuanceStore } from "../../../packages/storage-browser/src/issuance.js";
import { createBrowserDurableLiveJournalStore } from "../../../packages/storage-browser/src/live-journal.js";

// Factory boundary only: the shared scenario still installs and authenticates
// all bytes through the original native owners. No database images are copied.
const directories = new Set<string>();
export function tmpdir(): string { return "/r8-native-completion"; }
export function mkdtempSync(prefix: string): string {
	const directory = prefix + crypto.randomUUID();
	directories.add(directory);
	return directory;
}
export async function createFixtureAheStore(input: { filename: string }) {
	return createBrowserAheDurableStore({ databaseName: input.filename });
}
export async function createFixtureIssuanceStore(input: { primaryFilename: string }) {
	return createBrowserDurableIssuanceStore({ primaryDatabaseName: input.primaryFilename });
}
export async function createFixtureJournalStore(input: { primaryFilename: string }) {
	return createBrowserDurableLiveJournalStore({ primaryDatabaseName: input.primaryFilename });
}
export async function removeFixtureDirectory(directory: string): Promise<void> {
	if (!directories.has(directory)) throw new Error("NATIVE_FIXTURE_DIRECTORY_NOT_OWNED");
	const databases = await indexedDB.databases();
	await Promise.all(databases.flatMap(database => {
		const name = database.name;
		if (name === undefined || !name.startsWith(directory + "/")) return [];
		return [new Promise<void>((resolve, reject) => {
			const deletion = indexedDB.deleteDatabase(name);
			deletion.onsuccess = () => resolve();
			deletion.onerror = () => reject(deletion.error);
			deletion.onblocked = () => reject(new Error("NATIVE_FIXTURE_DATABASE_OWNER_NOT_JOINED"));
		})];
	}));
	directories.delete(directory);
}
