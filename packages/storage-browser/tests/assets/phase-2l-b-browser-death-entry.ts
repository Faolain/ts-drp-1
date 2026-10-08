// eslint-disable-next-line import/no-unresolved -- resolved by the private RED bundler.
import { createBrowserDurableIssuanceStore } from "#phase-2l-b-candidate";
import type {
	Phase2lBCommit,
	Phase2lBDeathTuple,
	Phase2lBStore,
} from "../fixtures/phase-2l-b-browser-issuance-contract.js";

declare global {
	interface Window {
		phase2lBRecover(databaseName: string, scenarioId: string): Promise<unknown>;
		phase2lBRunDeath(edge: Phase2lBDeathTuple, databaseName: string): Promise<unknown>;
		phase2lBRelay?(observation: Record<string, unknown>, cellValue: number): Promise<void>;
	}
}

const SCOPE = Object.freeze({ author: "death-author", objectId: "death-object" });

function plainCommit(commit: Awaited<ReturnType<Phase2lBStore["readIssued"]>>): unknown {
	if (commit === null) return null;
	return {
		authorSequence: commit.authorSequence,
		digest: [...commit.envelope.digest],
		preimage: [...commit.envelope.canonicalPreimageBytes],
		signature: [...commit.envelope.signature],
	};
}

window.phase2lBRunDeath = (edge, primaryDatabaseName): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const worker = new Worker("./phase-2l-b-browser-death-worker.js", { type: "module" });
		const signal = new SharedArrayBuffer(4);
		const cell = new Int32Array(signal);
		let ready = false;
		worker.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
			if (event.data.kind === "ready") {
				if (ready) return reject(new Error("duplicate death worker ready"));
				ready = true;
				worker.postMessage({ edge, kind: "run", primaryDatabaseName, signal });
				return;
			}
			if (event.data.kind === "worker-error") {
				void window.phase2lBRelay?.(event.data, Atomics.load(cell, 0));
				return reject(new Error(String(event.data.detail)));
			}
			if (event.data.kind !== "armed") return;
			void window.phase2lBRelay?.(event.data, Atomics.load(cell, 0));
			resolve(event.data);
		});
	});

window.phase2lBRecover = async (primaryDatabaseName, scenarioId): Promise<unknown> => {
	let store: Phase2lBStore | undefined;
	try {
		const opened = await createBrowserDurableIssuanceStore({ primaryDatabaseName });
		store = opened;
		const selectedOrdinal = scenarioId.startsWith("fresh/") ? 0 : 1;
		const lineage = await opened.readLineage(SCOPE);
		const selected = await opened.readIssued(SCOPE, selectedOrdinal);
		const outbox = await opened.readOutboxPage({ scope: SCOPE });
		const selectedOutbox = outbox.find(
			({ commit }: Readonly<{ commit: Phase2lBCommit }>) => commit.authorSequence === selectedOrdinal
		);
		const old = scenarioId.startsWith("fresh/")
			? lineage.next === 0 && !lineage.exhausted && selected === null && selectedOutbox === undefined
			: lineage.next === 1 && !lineage.exhausted && selected === null && selectedOutbox === undefined;
		const exactNew =
			lineage.next === selectedOrdinal + 1 &&
			!lineage.exhausted &&
			selected !== null &&
			selectedOutbox?.publishState === "pending" &&
			JSON.stringify(plainCommit(selectedOutbox.commit)) === JSON.stringify(plainCommit(selected));
		return {
			exactNew,
			lineage,
			old,
			outboxCount: outbox.length,
			selected: plainCommit(selected),
		};
	} finally {
		await store?.close();
	}
};
