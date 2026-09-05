/* eslint-disable @typescript-eslint/explicit-function-return-type -- Future-owner death child. */
import { DatabaseSync } from "node:sqlite";

import { encodeCanonical, hashDomain } from "../../../canonical/dist/src/index.js";

const [primaryFilename, targetJson] = process.argv.slice(2);
if (typeof primaryFilename !== "string" || typeof targetJson !== "string") process.exit(64);
const target = JSON.parse(targetJson);
let operation = "admission";
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function observedExec(sql) {
	const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
	const result = originalExec.call(this, sql);
	const edge = normalized === "BEGIN IMMEDIATE" ? "begin" : normalized === "COMMIT" ? "commit" : undefined;
	if (edge !== undefined && target.operation === operation && target.edge === edge) {
		process.send?.({ edge, kind: "checkpoint", operation });
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	}
	return result;
};

const { createNodeSnapshotQuarantineStore } = await import("@ts-drp/storage-node/snapshot-transfer");
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const digest = (domain, ...parts) => hex(hashDomain(domain, ...parts));
const chunks = [new Uint8Array(131_072).fill(1), new Uint8Array(131_072).fill(3), Uint8Array.of(2, 4, 6, 8, 10)];
const descriptors = chunks.map((bytes, index) => ({
	byteLength: bytes.byteLength,
	digest: digest("ts-drp/snapshot-chunk/v3", encodeCanonical(index), bytes),
	index,
}));
const payload = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.byteLength, 0));
let payloadOffset = 0;
for (const bytes of chunks) {
	payload.set(bytes, payloadOffset);
	payloadOffset += bytes.byteLength;
}
const manifest = {
	aclDigest: "22".repeat(32),
	anchor: "11".repeat(32),
	chunks: descriptors,
	encodingVersion: "drp-canonical-profile-1",
	epoch: 4,
	kind: "drp-snapshot-manifest",
	objectId: "phase-4c-b-node",
	payloadDigest: digest("ts-drp/snapshot-payload/v3", payload),
	protocolMajor: 3,
	schemaVersion: 1,
	stateDigest: "33".repeat(32),
	totalBytes: payload.byteLength,
};
const exactCanonicalManifestBytes = encodeCanonical(manifest);
const store = createNodeSnapshotQuarantineStore({ primaryFilename });
operation = "manifest";
const scope = await store.openScope({
	chunks: descriptors,
	exactCanonicalManifestBytes,
	scope: {
		anchor: manifest.anchor,
		epoch: manifest.epoch,
		manifestDigest: digest("ts-drp/snapshot-manifest/v3", exactCanonicalManifestBytes),
		objectId: manifest.objectId,
	},
	totalBytes: payload.byteLength,
});
operation = "chunk";
await scope.verificationQuarantine.open(new AbortController().signal).write(descriptors[0], chunks[0]);
process.send?.({ kind: "completed" });
