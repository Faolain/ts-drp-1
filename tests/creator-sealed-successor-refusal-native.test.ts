import { decodeCanonical, encodeCanonical } from "@ts-drp/canonical";
import { afterEach, expect, it } from "vitest";
import { closeFixtures, required } from "./fixtures/track-m/room-retention-fixture.js";
import { readinessHoldRoom } from "./fixtures/track-x/readiness-hold-room.js";

afterEach(async () => { expect(await closeFixtures()).toEqual([]); });

it.each(["changed-cut", "stale-view", "fenced-source"] as const)(
	"refuses %s during native sealed-successor reconstruction before publishing a head",
	async (mode) => {
		const fixture = await readinessHoldRoom();
		const creator = await fixture.open(0);
		await creator.room.issue({action: "placeBlock", id: "durable-before-refusal", kind: "stone", x: 1, y: 0});
		await new Promise(resolve => setTimeout(resolve, 300));
		expect(await creator.room.sealEpoch()).toMatchObject({ok: true});
		await fixture.stop(creator);
		let injected = 0, published = 0;
		await expect(fixture.open(0, {reopen: true, host: host => ({...host, openAhe: async name => {
			const store = await host.openAhe(name);
			return {...store,
				swapHead: async input => { published++; return store.swapHead(input); },
				readRetirementControl: async objectId => {
					if (mode === "fenced-source") { injected++; return {ok: false, reason: "RETIREMENT_FENCED"} as const; }
					return required(store.readRetirementControl)(objectId);
				},
				acquireBoundedRecoveryRoleRead: async input => {
					const result = await store.acquireBoundedRecoveryRoleRead(input);
					if (!result.ok) return result;
					const reader = result.value;
					if (mode === "stale-view") return {...result, value: {...reader, checkCurrency: async () => {
						injected++; return {ok: false, reason: "READ_STALE_ROLE_VIEW"} as const;
					}}};
					if (mode !== "changed-cut") return result;
					const blobs = reader.blobs.map(blob => {
						const record = decodeCanonical(blob.bytes) as Record<string, unknown>;
						if (record.kind !== "drp-hard-epoch-cut") return blob;
						injected++;
						return {...blob, bytes: encodeCanonical({...record, closeReason: "forged"})};
					});
					return {...result, value: {...reader, blobs}};
				},
			};
		}})})).rejects.toThrow();
		expect(injected).toBeGreaterThan(0);
		expect(published).toBe(0);
		const recovered = await fixture.open(0, {reopen: true});
		expect(recovered.room.authority()?.epoch).toBe(1);
		expect((recovered.room.projection() as unknown as {blocks: {id: string}[]}).blocks.map(row => row.id))
			.toContain("durable-before-refusal");
	}, 120_000
);
