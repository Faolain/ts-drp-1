import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { Keychain } from "@ts-drp/keychain";
import { createACL, createVertex, DRPObject, HashGraph } from "@ts-drp/object";
import { type DRPObjectConfig, DrpType, type IDRP, Operation, SemanticsType, type Vertex } from "@ts-drp/types";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";

const BATCH_SIZE = 32;
const FINALITY_SIGNERS = 8;

interface ArtifactProvenance {
	artifactMtimeMs: number;
	artifactSha256: string;
	objectModulePath: string;
	sourceMaxMtimeMs: number;
	sourceTreeSha256: string;
}

class CompactScaleState implements IDRP {
	semanticsType = SemanticsType.pair;
	value = -1;

	setValue(value: number): void {
		this.value = value;
	}
}

function parseArguments(): { profile: "compact" | "writer"; vertexCount: number } {
	const profile = process.argv[2];
	const vertexCount = Number(process.argv[3]);
	if (profile !== "compact" && profile !== "writer") throw new Error("profile must be compact or writer");
	if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0 || vertexCount > 100_000) {
		throw new Error("vertex count must be within 1..100000");
	}
	return { profile, vertexCount };
}

async function collectHeap(): Promise<number> {
	if (global.gc === undefined) throw new Error("scale worker requires --expose-gc");
	for (let pass = 0; pass < 3; pass++) {
		global.gc();
		await setImmediatePromise();
	}
	return process.memoryUsage().heapUsed;
}

async function signedChain(keychain: Keychain, peerId: string, count: number): Promise<Vertex[]> {
	const vertices: Vertex[] = [];
	let dependency = HashGraph.rootHash;
	for (let offset = 0; offset < count; offset += BATCH_SIZE) {
		const batch: Vertex[] = [];
		for (let index = offset; index < Math.min(offset + BATCH_SIZE, count); index++) {
			const vertex = createVertex(
				peerId,
				Operation.create({ drpType: DrpType.DRP, opType: "setValue", value: [index] }),
				[dependency],
				index + 1
			);
			batch.push(vertex);
			dependency = vertex.hash;
		}
		await Promise.all(
			batch.map(async (vertex) => {
				vertex.signature = await keychain.signWithSecp256k1(vertex.hash);
			})
		);
		vertices.push(...batch);
	}
	return vertices;
}

function artifactProvenance(): ArtifactProvenance {
	const objectModulePath = realpathSync(fileURLToPath(import.meta.resolve("@ts-drp/object")));
	const objectPackageRoot = resolve(dirname(objectModulePath), "../..");
	const sourceRoot = resolve(objectPackageRoot, "src");
	const sourceFiles: string[] = [];
	const pending = [sourceRoot];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (directory === undefined) break;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = resolve(directory, entry.name);
			if (entry.isDirectory()) pending.push(entryPath);
			else if (entry.isFile()) sourceFiles.push(entryPath);
		}
	}
	sourceFiles.sort();
	const sourceDigest = createHash("sha256");
	let sourceMaxMtimeMs = 0;
	for (const sourceFile of sourceFiles) {
		sourceDigest.update(relative(sourceRoot, sourceFile)).update("\0").update(readFileSync(sourceFile)).update("\0");
		sourceMaxMtimeMs = Math.max(sourceMaxMtimeMs, statSync(sourceFile).mtimeMs);
	}
	return {
		artifactMtimeMs: statSync(objectModulePath).mtimeMs,
		artifactSha256: createHash("sha256").update(readFileSync(objectModulePath)).digest("hex"),
		objectModulePath,
		sourceMaxMtimeMs,
		sourceTreeSha256: sourceDigest.digest("hex"),
	};
}

function inventoryFacts(replica: DRPObject<CompactScaleState>): {
	availableNonRootPayloads: number;
	digest: string;
	knownNonRootHashes: number;
	payloadAvailabilityTruthful: boolean;
} {
	const inventory = replica.historyInventory;
	const knownHashes = inventory.knownHashes.filter((hash: string) => hash !== HashGraph.rootHash);
	const availableHashes = inventory.availablePayloadHashes.filter((hash: string) => hash !== HashGraph.rootHash);
	const advertisedHashes = replica.vertices.map(({ hash }) => hash).filter((hash) => hash !== HashGraph.rootHash);
	const payloadAvailabilityTruthful =
		new Set(knownHashes).size === knownHashes.length &&
		new Set(availableHashes).size === availableHashes.length &&
		availableHashes.every((hash: string) => knownHashes.includes(hash)) &&
		JSON.stringify(availableHashes) === JSON.stringify(advertisedHashes) &&
		availableHashes.every((hash: string) => replica.getVertexPayload(hash).status === "available") &&
		knownHashes
			.filter((hash: string) => !inventory.availablePayloadHashes.includes(hash))
			.every((hash: string) => replica.getVertexPayload(hash).status === "history-unavailable");
	const digest = createHash("sha256")
		.update(JSON.stringify({ knownHashes, value: replica.drp?.value }))
		.digest("hex");
	return {
		availableNonRootPayloads: availableHashes.length,
		digest,
		knownNonRootHashes: knownHashes.length,
		payloadAvailabilityTruthful,
	};
}

async function main(): Promise<void> {
	const { profile, vertexCount } = parseArguments();
	const provenance = artifactProvenance();
	const author = new Keychain({ private_key_seed: "phase-1i-b-compact-scale-author" });
	await author.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(author.secp256k1PublicKey, "base64"));
	const authorPeerId = peerIdFromPublicKey(publicKey).toString();
	const vertices = await signedChain(author, authorPeerId, vertexCount);
	const signerIds = [authorPeerId, ...Array.from({ length: FINALITY_SIGNERS - 1 }, (_, index) => `signer-${index}`)];
	const baselineHeap = await collectHeap();
	const config = {
		history_storage: profile === "compact" ? "compact" : "full",
		log_config: { level: "silent" },
		replica_mode: profile === "compact" ? "observer" : "writer",
	} satisfies DRPObjectConfig;
	const replica = new DRPObject({
		peerId: "phase-1i-b-compact-scale-receiver",
		acl: createACL({ admins: signerIds }),
		drp: new CompactScaleState(),
		config,
	});

	for (let offset = 0; offset < vertices.length; offset += BATCH_SIZE) {
		const result = await replica.applyVertices(vertices.slice(offset, offset + BATCH_SIZE));
		if (!result.applied || result.invalid.length !== 0 || result.missing.length !== 0 || result.quarantined) {
			throw new Error(`scale replay rejected a batch at offset ${offset}: ${JSON.stringify(result)}`);
		}
	}
	if (replica.drp?.value !== vertexCount - 1) throw new Error("scale replay did not converge to the final value");
	const facts = inventoryFacts(replica);
	const retainedHeapBytes = (await collectHeap()) - baselineHeap;
	process.stdout.write(`${JSON.stringify({ artifactProvenance: provenance, ...facts, retainedHeapBytes })}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
