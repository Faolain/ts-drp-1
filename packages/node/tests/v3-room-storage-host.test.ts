import { describe, expect, it } from "vitest";

import { captureV3RoomStorageHost, type V3RoomStorageHost } from "../src/v3-room-host.js";
import { createV3RoomSession, type CreateV3RoomSessionInput } from "../src/v3-room.js";

// Factory-identity controls only: these probes never claim native store authority.
const factoryNames = [
	"openAhe",
	"openIssuance",
	"openJournal",
	"openSnapshots",
	"openSealVote",
	"openSealEvidence",
	"openRoomHead",
] as const;

describe("supported SDK room storage host", () => {
	it("refuses a missing host before opening any room storage", async () => {
		const input = { application: {}, storageHost: undefined } as unknown as CreateV3RoomSessionInput;
		await expect(createV3RoomSession(input)).rejects.toThrow("v3 room storage host is unavailable");
	});

	it("requires every native factory without invoking any during capture", () => {
		let entered = 0;
		const refuse = (): Promise<never> => {
			entered += 1;
			return Promise.reject(new Error("unused factory"));
		};
		for (const missing of factoryNames) {
			const host = Object.fromEntries(factoryNames.filter((name) => name !== missing).map((name) => [name, refuse]));
			expect(() => captureV3RoomStorageHost(host as unknown as V3RoomStorageHost)).toThrow("factory is unavailable");
		}
		expect(entered).toBe(0);
	});

	it("preserves factory receiver and captured identity across caller replacement", async () => {
		const original = new Error("original native factory"),
			replaced = new Error("replacement must not enter");
		const refuse = (): Promise<never> => Promise.reject(original);
		const calls: string[] = [];
		const host: V3RoomStorageHost = {
			openAhe(name): Promise<never> {
				expect(this).toBe(host);
				calls.push(name);
				return Promise.reject(original);
			},
			openIssuance: refuse,
			openJournal: refuse,
			openSnapshots: refuse,
			openSealVote: refuse,
			openSealEvidence: refuse,
			openRoomHead: refuse,
		};
		const captured = captureV3RoomStorageHost(host);
		host.openAhe = (): Promise<never> => Promise.reject(replaced);
		await expect(captured.openAhe("durable-room--ahe")).rejects.toBe(original);
		expect(calls).toEqual(["durable-room--ahe"]);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.keys(captured)).toEqual(factoryNames);
	});

	it("captures the optional combined signing owner without invoking or rebinding a replacement", async () => {
		const original = new Error("original combined native factory"), calls: string[] = [];
		const refuse = (): Promise<never> => Promise.reject(new Error("unused independent factory"));
		const host = Object.fromEntries(factoryNames.map(name => [name, refuse])) as unknown as V3RoomStorageHost;
		host.openCreatorSigningStores = function(name): Promise<never> {
			expect(this).toBe(host); calls.push(name); return Promise.reject(original);
		};
		const captured = captureV3RoomStorageHost(host);
		expect(calls).toEqual([]);
		host.openCreatorSigningStores = refuse;
		await expect(captured.openCreatorSigningStores!("native-primary")).rejects.toBe(original);
		expect(calls).toEqual(["native-primary"]);
		expect(Object.isFrozen(captured)).toBe(true);
	});

	it("refuses a malformed combined factory rather than silently falling back", () => {
		const host = Object.fromEntries(factoryNames.map(name => [name, () => Promise.resolve({})]));
		for (const value of [null, {}, true, 1]) {
			expect(() => captureV3RoomStorageHost({...host, openCreatorSigningStores: value} as unknown as V3RoomStorageHost))
				.toThrow("signing factory is unavailable");
		}
	});
});
