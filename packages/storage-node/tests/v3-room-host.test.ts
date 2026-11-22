import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import type { V3RoomStorageHost } from "../../node/src/v3-room-host.js";
import { createNodeV3RoomStorageHost } from "../src/v3-room-host.js";

const directories = new Set<string>();
const owners = new Set<{ close(): Promise<void> }>();
function directory(): string {
	const value = mkdtempSync(join(tmpdir(), "r9-native-host-"));
	directories.add(value);
	return value;
}
async function own<Owner extends { close(): Promise<void> }>(promise: Promise<Owner>): Promise<Owner> {
	const owner = await promise;
	owners.add(owner);
	return owner;
}
async function close(owner: { close(): Promise<void> }): Promise<void> {
	await owner.close();
	owners.delete(owner);
}
afterEach(async () => {
	await Promise.all([...owners].map((owner) => owner.close()));
	owners.clear();
	for (const value of directories) rmSync(value, { recursive: true, force: true });
	directories.clear();
});

const factoryNames = [
	"openAhe",
	"openIssuance",
	"openJournal",
	"openSnapshots",
	"openSealVote",
	"openSealEvidence",
] as const;

it("composes all original native owners, shared signing aliases, and explicit noncreating reopen", async () => {
	const root = directory();
	const host: V3RoomStorageHost = createNodeV3RoomStorageHost({ directory: root, initialization: () => "create" });
	for (const factory of factoryNames) {
		const owner = await own<{ close(): Promise<void> }>(host[factory]("retained"));
		await close(owner);
	}
	const vote = await own(host.openSealVote("retained"));
	const evidence = await own(host.openSealEvidence("retained"));
	expect(vote.observation.incarnation).toEqual(evidence.observation.incarnation);
	await close(vote);
	await close(evidence);
	const reopened: V3RoomStorageHost = createNodeV3RoomStorageHost({
		directory: root,
		initialization: ({ name }) => (name === "new-authorized-local-scope" ? "create" : "reopen"),
	});
	for (const factory of factoryNames) {
		const owner = await own<{ close(): Promise<void> }>(reopened[factory]("retained"));
		if (factory === "openSealVote" || factory === "openSealEvidence")
			expect(Reflect.get(owner, "observation").incarnation).toEqual(vote.observation.incarnation);
		await close(owner);
	}
	await close(await own(reopened.openAhe("new-authorized-local-scope")));
	const head = await own(host.openRoomHead("target", { kind: "create" }));
	await close(head);
	await close(await own(reopened.openRoomHead("target", { kind: "reopen" })));
});

it("refuses absent retained files in every native factory without creating anything", async () => {
	const root = directory();
	const host = createNodeV3RoomStorageHost({ directory: root, initialization: () => "reopen" });
	for (const factory of factoryNames) await expect(host[factory]("missing")).rejects.toThrow();
	await expect(host.openRoomHead("missing", { kind: "reopen" })).rejects.toThrow();
	expect(readdirSync(root)).toEqual([]);
});

it.each(["openAhe", "openIssuance", "openJournal", "openSnapshots"] as const)(
	"%s refuses an empty retained file without schema recreation, then resumes exact restored custody",
	async (factory) => {
		const root = directory();
		const host = createNodeV3RoomStorageHost({ directory: root, initialization: () => "create" });
		await close(await own<{ close(): Promise<void> }>(host[factory]("retained")));
		const files = readdirSync(root);
		expect(files).toHaveLength(1);
		const selected = files[0];
		if (selected === undefined) throw new TypeError("native fixture file is missing");
		const file = join(root, selected);
		const original = readFileSync(file);
		const preserved = `${file}.preserved`;
		renameSync(file, preserved);
		const database = new DatabaseSync(file);
		database.close();
		const empty = readFileSync(file);
		const reopened = createNodeV3RoomStorageHost({ directory: root, initialization: () => "reopen" });
		await expect(reopened[factory]("retained")).rejects.toThrow();
		expect(readFileSync(file)).toEqual(empty);
		renameSync(file, `${file}.refused-empty`);
		renameSync(preserved, file);
		expect(readFileSync(file)).toEqual(original);
		await close(await own<{ close(): Promise<void> }>(reopened[factory]("retained")));
	}
);
