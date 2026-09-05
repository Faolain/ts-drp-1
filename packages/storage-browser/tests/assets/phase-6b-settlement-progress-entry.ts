import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";

const SCOPE = Object.freeze({ author: "author:browser-progress", objectId: "room:browser-progress" });

function snapshot(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(snapshot);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]));
}

async function run(databaseName: string): Promise<Readonly<Record<string, unknown>>> {
	const store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
	try {
		const candidate = Object.freeze({
			entries: Object.freeze([
				Object.freeze({
					disposition: "rebase",
					replacementProgress: Object.freeze({
						chunks: Object.freeze([]),
						intentCount: 2,
						intentDigest: new Uint8Array(32).fill(0xa5),
						version: 1,
					}),
					replacementSequence: null,
					sourceDigest: new Uint8Array(32).fill(0xd1),
					sourceSequence: 7,
				}),
			]),
			fenceSequence: 4,
			revision: 0,
			scope: SCOPE,
		});
		let errorCode: unknown;
		try {
			await store.transactWriteSettlementPlan({ expectedRevision: null, plan: candidate as never, scope: SCOPE });
		} catch (error) {
			errorCode = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
		}
		const durable = await store.readSettlementPlan(SCOPE);
		return Object.freeze({
			accepted: errorCode === undefined,
			errorCode,
			plan: snapshot(durable),
		});
	} finally {
		await store.close();
	}
}

Object.assign(globalThis, { d110cF5b0tBrowserProgress: Object.freeze({ run }) });
