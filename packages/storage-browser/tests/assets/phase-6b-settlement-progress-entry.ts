import { encodeCanonical } from "@ts-drp/canonical";

import { createBrowserDurableIssuanceStore } from "../../src/issuance.js";

const SCOPE = Object.freeze({ author: "author:browser-progress", objectId: "room:browser-progress" });
type Outcome = Readonly<{ ok: boolean; errorCode: string | null }>;
type Chunk = Readonly<{ lastLogicalTime: number; replacementSequence: number; throughIntent: number }>;
type Store = Awaited<ReturnType<typeof createBrowserDurableIssuanceStore>>;

function snapshot(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array) return [...value];
	if (Array.isArray(value)) return value.map(snapshot);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]));
}
function plan(revision: number, chunks?: readonly Chunk[], replacementSequence: number | null = null): never {
	return {
		entries: [
			{
				disposition: "rebase",
				...(chunks === undefined
					? {}
					: {
							replacementProgress: { chunks, intentCount: 2, intentDigest: new Uint8Array(32).fill(0xa5), version: 1 },
						}),
				replacementSequence,
				sourceDigest: new Uint8Array(32).fill(0xd1),
				sourceSequence: 7,
			},
		],
		fenceSequence: 4,
		revision,
		scope: SCOPE,
	} as never;
}
async function capture(operation: () => Promise<unknown>): Promise<Outcome> {
	try {
		await operation();
		return { ok: true, errorCode: null };
	} catch (error) {
		const code = error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
		return { ok: false, errorCode: typeof code === "string" ? code : "UNCLASSIFIED_ERROR" };
	}
}
function write(store: Store, expectedRevision: number | null, candidate: never): Promise<Outcome> {
	return capture(() => store.transactWriteSettlementPlan({ expectedRevision, plan: candidate, scope: SCOPE }));
}
function issue(store: Store, fromIntent: number, throughIntent: number, logicalTime: number): Promise<Outcome> {
	return capture(() =>
		store.transactIssue(SCOPE, (authorSequence) => {
			const envelope = {
				canonicalPreimageBytes: encodeCanonical({
					author: SCOPE.author,
					authorSequence,
					epoch: 0,
					kind: "drp-vertex",
					logicalTime,
					objectId: SCOPE.objectId,
					operation: { action: "add", value: 1 },
					protocolMajor: 3,
				}),
				digest: new Uint8Array(32).fill(authorSequence + 1),
				signature: new Uint8Array(64).fill(authorSequence + 1),
			};
			return Promise.resolve({
				authorSequence,
				envelope,
				issuedRecord: { authorSequence, envelope, scope: SCOPE },
				outboxEntry: { authorSequence, envelope, scope: SCOPE },
				planEffect: {
					fromIntent,
					intentDigest: new Uint8Array(32).fill(0xa5),
					kind: "replacement",
					sourceSequence: 7,
					throughIntent,
				},
			} as never);
		})
	);
}
async function vector(databaseName: string, name: string): Promise<Readonly<Record<string, unknown>>> {
	let store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
	try {
		const setup: Outcome[] = [await write(store, null, plan(0))];
		if (name === "partial" || name === "final") setup.push(await write(store, 0, plan(1, [])));
		if (name === "final") setup.push(await issue(store, 0, 1, 7));
		if (name === "stale-revision") setup.push(await write(store, 0, plan(1)));
		const before = snapshot(await store.readSettlementPlan(SCOPE));
		const beforeLineage = await store.readLineage(SCOPE);
		let attempt: Outcome;
		switch (name) {
			case "zero-origin":
				attempt = await write(store, 0, plan(1, []));
				break;
			case "nonempty-origin":
				attempt = await write(store, 0, plan(1, [{ lastLogicalTime: 7, replacementSequence: 0, throughIntent: 1 }]));
				break;
			case "partial":
				attempt = await issue(store, 0, 1, 7);
				break;
			case "final":
				attempt = await issue(store, 1, 2, 9);
				break;
			case "stale-revision":
				attempt = await write(store, 0, plan(1));
				break;
			case "inexact-revision":
				attempt = await write(store, 0, plan(2));
				break;
			default:
				throw new TypeError("D110C_F5B0U_UNKNOWN_BROWSER_VECTOR");
		}
		const after = snapshot(await store.readSettlementPlan(SCOPE));
		const lineage = await store.readLineage(SCOPE);
		const issued = await Promise.all([store.readIssued(SCOPE, 0), store.readIssued(SCOPE, 1)]);
		const outbox = await store.readOutboxPage({ scope: SCOPE, limit: 8 });
		await store.close();
		store = await createBrowserDurableIssuanceStore({ primaryDatabaseName: databaseName });
		return {
			name,
			setup,
			attempt,
			before,
			beforeLineage,
			after,
			lineage,
			issuedSequences: issued.flatMap((row) => (row === null ? [] : [row.authorSequence])),
			outboxSequences: outbox.map((row) => row.commit.authorSequence),
			reopened: snapshot(await store.readSettlementPlan(SCOPE)),
		};
	} finally {
		await store.close();
	}
}
async function run(databaseName: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
	const results: Readonly<Record<string, unknown>>[] = [];
	for (const name of ["zero-origin", "nonempty-origin", "partial", "final", "stale-revision", "inexact-revision"]) {
		results.push(await vector(databaseName + "-" + name, name));
	}
	return results;
}
Object.assign(globalThis, { d110cF5b0tBrowserProgress: Object.freeze({ run }) });
