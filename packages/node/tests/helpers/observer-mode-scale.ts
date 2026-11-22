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

type Phase1iObjectConfig = DRPObjectConfig & { replica_mode: "observer" | "writer" };

interface ArtifactProvenance {
	artifactMtimeMs: number;
	artifactSha256: string;
	objectModulePath: string;
	sourceMaxMtimeMs: number;
	sourceTreeSha256: string;
}

class ScaleState implements IDRP {
	semanticsType = SemanticsType.pair;
	value = -1;

	setValue(value: number): void {
		this.value = value;
	}
}

function parseArguments(): { replicaMode: "observer" | "writer"; vertexCount: number } {
	const replicaMode = process.argv[2];
	const vertexCount = Number(process.argv[3]);
	if (replicaMode !== "observer" && replicaMode !== "writer") {
		throw new Error("replica mode must be observer or writer");
	}
	if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0 || vertexCount > 100_000) {
		throw new Error("vertex count must be within 1..100000");
	}
	return { replicaMode, vertexCount };
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

async function main(): Promise<void> {
	const { replicaMode, vertexCount } = parseArguments();
	const provenance = artifactProvenance();
	const author = new Keychain({ private_key_seed: "phase-1i-observer-scale-author" });
	await author.start();
	const publicKey = publicKeyFromRaw(uint8ArrayFromString(author.secp256k1PublicKey, "base64"));
	const authorPeerId = peerIdFromPublicKey(publicKey).toString();
	const vertices = await signedChain(author, authorPeerId, vertexCount);
	const signerIds = [authorPeerId, ...Array.from({ length: FINALITY_SIGNERS - 1 }, (_, index) => `signer-${index}`)];
	const baselineHeap = await collectHeap();
	const config = {
		log_config: { level: "silent" },
		replica_mode: replicaMode,
	} satisfies Phase1iObjectConfig;
	const replica = new DRPObject({
		peerId: "phase-1i-observer-scale-receiver",
		acl: createACL({ admins: signerIds }),
		drp: new ScaleState(),
		config,
	});

	for (let offset = 0; offset < vertices.length; offset += BATCH_SIZE) {
		const result = await replica.applyVertices(vertices.slice(offset, offset + BATCH_SIZE));
		if (!result.applied || result.invalid.length !== 0 || result.missing.length !== 0 || result.quarantined) {
			throw new Error(`scale replay rejected a batch at offset ${offset}: ${JSON.stringify(result)}`);
		}
	}
	if (replica.drp?.value !== vertexCount - 1) throw new Error("scale replay did not converge to the final value");
	const retainedHeapBytes = (await collectHeap()) - baselineHeap;
	const digest = createHash("sha256")
		.update(JSON.stringify({ hashes: replica.vertices.map(({ hash }) => hash), value: replica.drp.value }))
		.digest("hex");
	process.stdout.write(
		`${JSON.stringify({ artifactProvenance: provenance, digest, nonRootVertices: replica.vertices.length - 1, retainedHeapBytes })}\n`
	);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
