/* eslint-disable @typescript-eslint/explicit-function-return-type, jsdoc/require-jsdoc -- Read-only native crash evidence. */
import { decodeCanonical } from "@ts-drp/canonical";
import { captureRoomHeadImage, decodeGenerationRecordV1, decodeHeadRecordV1 } from "@ts-drp/storage";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type KillEdge = "receipt-commit" | "floor-commit";

export function required<Value>(value: Value | null | undefined): Value {
	if (value === undefined || value === null) throw new Error("REJOIN_KILL_REQUIRED_VALUE");
	return value;
}

export function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("REJOIN_KILL_RECORD_REQUIRED");
	return value as Record<string, unknown>;
}

export function bytes(value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error("REJOIN_KILL_BYTES_REQUIRED");
	return value;
}

export function hex(value: Uint8Array): string {
	return Buffer.from(value).toString("hex");
}

export function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function nativeFilename(directory: string, family: "ahe" | "snapshots" | "issuance", peer = 1): string {
	const name = family === "ahe" ? `peer-${peer}--ahe` : `peer-${peer}`;
	const suffix =
		family === "snapshots"
			? ".drp-snapshot-quarantine-v1.sqlite"
			: family === "issuance"
				? ".drp-issuance-v1.sqlite"
				: "";
	return join(directory, `${sha256(JSON.stringify([family, name]))}.sqlite${suffix}`);
}

export function readNativeState(directory: string, objectId: string) {
	const databases: DatabaseSync[] = [];
	const open = (filename: string) => {
		const database = new DatabaseSync(filename, { readOnly: true });
		databases.push(database);
		return database;
	};
	try {
		const ahe = open(nativeFilename(directory, "ahe"));
		const snapshotFile = nativeFilename(directory, "snapshots");
		const snapshots = existsSync(snapshotFile) ? open(snapshotFile) : undefined;
		const issuance = open(nativeFilename(directory, "issuance"));
		const floor = open(join(directory, "peer-1-external-floor.sqlite"));
		const headBytes = bytes(
			required(ahe.prepare("SELECT head_record FROM objects WHERE object_id=?").get(objectId)).head_record
		);
		const openedHead = decodeHeadRecordV1(headBytes);
		if (!openedHead.ok) throw new Error("REJOIN_KILL_HEAD_INVALID");
		const generations = ahe
			.prepare("SELECT record FROM generations WHERE object_id=? ORDER BY generation_id")
			.all(objectId)
			.map((row) => {
				const opened = decodeGenerationRecordV1(bytes(row.record));
				if (!opened.ok) throw new Error("REJOIN_KILL_GENERATION_INVALID");
				const projection = opened.value.closure
					.map((ref) =>
						decodeCanonical(
							bytes(required(ahe.prepare("SELECT bytes FROM blobs WHERE digest=?").get(ref.digest)).bytes)
						)
					)
					.find(
						(value) =>
							value !== null &&
							typeof value === "object" &&
							!Array.isArray(value) &&
							["v3-live-generation-1", "v3-live-generation-2"].includes(String(Reflect.get(value, "kind")))
					);
				return {
					...opened.value,
					projectionEpoch: projection === undefined ? undefined : Reflect.get(projection as object, "epoch"),
					exactRecordHex: hex(bytes(row.record)),
				};
			});
		const receipts = (
			snapshots
				?.prepare(
					"SELECT epoch,anchor,manifest_digest,incarnation,state,retention,received_certificate_bytes FROM snapshot_scopes_v2 WHERE object_id=? AND received_certificate_bytes IS NOT NULL ORDER BY epoch"
				)
				.all(objectId) ?? []
		).map((row) => {
			const wrapper = bytes(row.received_certificate_bytes),
				decoded = record(decodeCanonical(wrapper));
			const certificateBytes = bytes(decoded.exactReceivedCertificateBytes),
				certificate = record(decodeCanonical(certificateBytes));
			return {
				epoch: Number(row.epoch),
				anchor: String(row.anchor),
				manifestDigest: String(row.manifest_digest),
				incarnation: String(row.incarnation),
				state: String(row.state),
				retention: String(row.retention),
				wrapperHex: hex(wrapper),
				certificateHex: hex(certificateBytes),
				certificateSha256: sha256(certificateBytes),
				kind: certificate.kind,
				candidateGenerationId: certificate.candidateGenerationId,
				candidateClosureDigest: certificate.candidateClosureDigest,
				oldHeadHex: hex(bytes(certificate.exactCanonicalOldHeadBytes)),
				cutHex: hex(bytes(certificate.exactCanonicalCutValueBytes)),
			};
		});
		const issued = issuance
			.prepare(
				"SELECT author,author_sequence,canonical_preimage,digest,signature FROM issued_records WHERE object_id=? ORDER BY author_sequence"
			)
			.all(objectId)
			.map((row) => {
				const preimage = bytes(row.canonical_preimage),
					vertex = record(decodeCanonical(preimage));
				return {
					author: String(row.author),
					sequence: Number(row.author_sequence),
					sourceEpoch: vertex.epoch,
					operation: vertex.operation,
					canonicalPreimageHex: hex(preimage),
					digest: hex(bytes(row.digest)),
					signatureHex: hex(bytes(row.signature)),
				};
			});
		const plans = issuance
			.prepare(
				"SELECT author,revision,fence_sequence,entries_json FROM settlement_plans WHERE object_id=? ORDER BY author"
			)
			.all(objectId)
			.map((row) => {
				const stored = JSON.parse(String(row.entries_json)) as unknown;
				const decoded: Record<string, unknown> =
					!Array.isArray(stored) && typeof record(stored).bytes === "string"
						? record(decodeCanonical(Buffer.from(String(record(stored).bytes), "base64")))
						: { entries: stored };
				const contexts = (decoded.sourceContexts ?? []) as readonly unknown[];
				return {
					author: String(row.author),
					revision: Number(row.revision),
					fenceSequence: row.fence_sequence,
					exactStorageJson: String(row.entries_json),
					entries: decoded.entries,
					sourceContexts: contexts.map((value) => {
						const context = record(value),
							exact = bytes(context.exactCanonicalContextBytes);
						return { digest: hex(bytes(context.digest)), exactCanonicalContextHex: hex(exact), sha256: sha256(exact) };
					}),
				};
			});
		const image = captureRoomHeadImage(required(floor.prepare("SELECT image FROM room_head WHERE id=1").get()).image);
		const files = readdirSync(directory)
			.filter((name) => name.includes(".sqlite"))
			.sort()
			.map((name) => ({ name, bytes: statSync(join(directory, name)).size }));
		return {
			head: openedHead.value,
			headRecordHex: hex(headBytes),
			generations,
			receipts,
			issued,
			plans,
			floor: image,
			files,
		};
	} finally {
		for (const database of databases.reverse()) database.close();
	}
}

export function json(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, selected: unknown) => (selected instanceof Uint8Array ? { hex: hex(selected) } : selected),
		2
	);
}

/**
 * Read-only receipt of Vitest’s actual execution module cache, including transformed code hashes.
 * @returns The exact module paths and byte fingerprints visible to this worker.
 */
export function loadedModules() {
	const state = record(Reflect.get(globalThis, "__vitest_worker__"));
	const cache = state.moduleCache;
	if (!(cache instanceof Map)) throw new Error("REJOIN_KILL_MODULE_CACHE_UNAVAILABLE");
	const checkout = realpathSync(process.cwd());
	return [...cache.entries()]
		.map(([id, value]) => {
			const raw = String(id);
			const filename = raw.startsWith("file://") ? fileURLToPath(raw) : raw.replace(/^\/@fs\//, "/");
			if (!existsSync(filename) || !statSync(filename).isFile()) return { id: raw, virtual: true };
			const resolved = realpathSync(filename);
			const local = resolved.startsWith(checkout + "/");
			const code = record(value).code;
			return {
				id: raw,
				resolved,
				checkoutRelative: local ? relative(checkout, resolved) : null,
				fileSha256: sha256(readFileSync(resolved)),
				transformedCodeSha256: typeof code === "string" ? sha256(code) : null,
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}
