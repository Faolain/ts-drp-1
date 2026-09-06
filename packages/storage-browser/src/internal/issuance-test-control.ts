import { encodeCanonical } from "@ts-drp/canonical";
import {
	classifyDurableIssuanceTerminalSuppression,
	type DurableIssueCommit,
	type DurableIssueScope,
} from "@ts-drp/issuance-store";

import {
	browserIssuanceImplementationForTest,
	createBrowserDurableIssuanceStoreImplementation,
} from "./browser-issuance-store.js";

type AmbiguityCase = "absent-old" | "exact-pair" | "foreign-pair" | "torn-or-inconsistent" | "unreadable";

const SUFFIX = "--drp-issuance-v1";
const SCOPE = Object.freeze({ author: "ambiguity-author", objectId: "ambiguity-object" });

function candidate(scope: DurableIssueScope, authorSequence: number, seed: number): DurableIssueCommit {
	const envelope = {
		canonicalPreimageBytes: encodeCanonical({ ...scope, authorSequence }),
		digest: Uint8Array.of(seed, 0xd1),
		signature: Uint8Array.of(seed, 0x51),
	};
	return {
		authorSequence,
		envelope,
		issuedRecord: { authorSequence, envelope, scope: { ...scope } },
		outboxEntry: { authorSequence, envelope, scope: { ...scope } },
	};
}

function openDatabase(name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name);
		request.addEventListener("success", () => resolve(request.result), { once: true });
		request.addEventListener("error", () => reject(request.error ?? new Error("test database open failed")), {
			once: true,
		});
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve(), { once: true });
		transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("test transaction aborted")), {
			once: true,
		});
	});
}

function exposed(error: unknown): Readonly<{ code: string; exposedKeys: readonly string[] }> {
	if (typeof error !== "object" || error === null) return { code: "NON_OBJECT", exposedKeys: [] };
	return { code: String(Reflect.get(error, "code")), exposedKeys: Object.keys(error) };
}

/**
 * Executes the bounded private ambiguity fixture against the real browser database and shared classifier.
 * @param input - Closed ambiguity case and opaque primary identity.
 * @param input.caseId - One ratified terminal ambiguity case.
 * @param input.primaryDatabaseName - Opaque identity used to derive the private database.
 * @returns The closed classification code and enumerable exposed failure keys.
 */
export async function runBrowserTerminalAmbiguityCase(input: {
	readonly caseId: AmbiguityCase;
	readonly primaryDatabaseName: string;
}): Promise<Readonly<{ code: string; exposedKeys: readonly string[] }>> {
	const store = await createBrowserDurableIssuanceStoreImplementation({
		primaryDatabaseName: input.primaryDatabaseName,
	});
	try {
		const implementation = browserIssuanceImplementationForTest(store);
		if (implementation === undefined) throw new TypeError("private browser issuance implementation unavailable");
		const expected = candidate(SCOPE, 0, 41);
		if (input.caseId === "exact-pair") await store.transactIssue(SCOPE, () => Promise.resolve(expected));
		if (input.caseId === "foreign-pair") {
			await store.transactIssue(SCOPE, () => Promise.resolve(candidate(SCOPE, 0, 73)));
		}
		if (input.caseId === "torn-or-inconsistent") {
			const database = await openDatabase(`${input.primaryDatabaseName}${SUFFIX}`);
			try {
				const transaction = database.transaction("issuedRecords", "readwrite", { durability: "strict" });
				transaction.objectStore("issuedRecords").add({
					...SCOPE,
					authorSequence: 0,
					canonicalPreimageBytes: new Uint8Array(expected.envelope.canonicalPreimageBytes),
					digest: new Uint8Array(expected.envelope.digest),
					signature: new Uint8Array(expected.envelope.signature),
				});
				await transactionComplete(transaction);
			} finally {
				database.close();
			}
		}
		try {
			const observation =
				input.caseId === "unreadable"
					? ({ unreadable: true } as const)
					: await implementation.terminalObservationForTest(SCOPE, 0);
			classifyDurableIssuanceTerminalSuppression({
				candidate: expected,
				observation,
				priorLineage: { exhausted: false, next: 0 },
				scope: SCOPE,
			});
			return { code: "SUCCESS", exposedKeys: [] };
		} catch (error) {
			return exposed(error);
		}
	} finally {
		await store.close();
	}
}
