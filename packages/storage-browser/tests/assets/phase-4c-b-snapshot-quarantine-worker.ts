/* eslint-disable import/no-unresolved -- The future non-root owner is intentionally absent in RED. */
import { createBrowserSnapshotQuarantineStore } from "@ts-drp/storage-browser/snapshot-transfer";

import { createSnapshotQuarantineFixture } from "../../../../tests/fixtures/phase-4c-v3/snapshot-quarantine-contract.js";

self.onmessage = async (
	event: MessageEvent<{
		primaryDatabaseName: string;
		target: Readonly<{ edge: "precommit" | "postcommit"; operation: "chunk" | "manifest" }>;
	}>
): Promise<void> => {
	const { target } = event.data;
	const originalAdd = IDBObjectStore.prototype.add;
	const originalPut = IDBObjectStore.prototype.put;
	const observe = (store: IDBObjectStore, request: IDBRequest): void => {
		const operation = store.name === "scopes" ? "manifest" : store.name === "chunks" ? "chunk" : undefined;
		if (operation !== target.operation || target.edge !== "precommit") return;
		request.addEventListener("success", () => {
			self.postMessage({ edge: target.edge, kind: "checkpoint", operation });
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		});
	};
	IDBObjectStore.prototype.add = function observedAdd(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
		const request = originalAdd.call(this, value, key);
		observe(this, request);
		return request;
	};
	IDBObjectStore.prototype.put = function observedPut(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
		const request = originalPut.call(this, value, key);
		observe(this, request);
		return request;
	};
	const bytes = new Uint8Array(131_072).fill(7);
	const selected = createSnapshotQuarantineFixture({ chunks: [bytes], objectId: "phase-4c-b-browser-death" });
	const descriptor = selected.declaration.chunks[0];
	if (descriptor === undefined) throw new Error("missing death-test descriptor");
	const store = await createBrowserSnapshotQuarantineStore({ primaryDatabaseName: event.data.primaryDatabaseName });
	const scope = await store.openScope(selected.declaration);
	if (target.operation === "manifest" && target.edge === "postcommit") {
		self.postMessage({ edge: target.edge, kind: "checkpoint", operation: target.operation });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}
	await scope.verificationQuarantine.open(new AbortController().signal).write(descriptor, bytes);
	if (target.operation === "chunk" && target.edge === "postcommit") {
		self.postMessage({ edge: target.edge, kind: "checkpoint", operation: target.operation });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}
};
