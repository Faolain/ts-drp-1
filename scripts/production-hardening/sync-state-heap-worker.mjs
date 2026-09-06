/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this profiling tooling directly. */
import { createRequire } from "node:module";
import { setImmediate as macrotask } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";

import {
	assertCanonicalHash,
	framedCorpusDigest,
	integerArgument,
	MEASUREMENT_CAPACITY_POLICY,
	parseArguments,
	requiredArgument,
	SHAPES,
} from "./sync-state-heap-common.mjs";

const argumentsMap = parseArguments(process.argv.slice(2));
const shape = requiredArgument(argumentsMap, "shape");
const placement = requiredArgument(argumentsMap, "placement");
const population = integerArgument(argumentsMap, "population");
const sampleSeed = requiredArgument(argumentsMap, "sample-seed");

if (!SHAPES.includes(shape)) throw new Error(`Unknown shape: ${shape}`);
if (globalThis.gc === undefined) throw new Error("The worker requires node --expose-gc");
if (process.env.NODE_V8_COVERAGE !== undefined) throw new Error("NODE_V8_COVERAGE must be unset");
if (process.execArgv.some((flag) => /inspect|source-maps|coverage/u.test(flag))) {
	throw new Error(`Instrumentation flag is forbidden: ${process.execArgv.join(" ")}`);
}
if (placement === "demand-20x14" && population !== 280) throw new Error("demand-20x14 requires exactly 280 pairs");

const repositoryRoot = new URL("../../", import.meta.url);
const nodeRequire = createRequire(new URL("packages/node/package.json", repositoryRoot));
const [{ peerIdFromPrivateKey }, { privateKeyFromRaw }, { DRPNode }, syncState] = await Promise.all([
	import(pathToFileURL(nodeRequire.resolve("@libp2p/peer-id")).href),
	import(pathToFileURL(nodeRequire.resolve("@libp2p/crypto/keys")).href),
	import(new URL("packages/node/dist/src/index.js", repositoryRoot).href),
	import(new URL("packages/node/dist/src/sync-state.js", repositoryRoot).href),
]);

const {
	advertisedTheseHeads,
	completePresentExactRequests,
	installSyncStateCapacity,
	prepareSyncSend,
	previewSyncSend,
	queueExactRequests,
	recordAdvertisedHeads,
	recordBranchCuts,
	recordSharedHeads,
	sharedHashes,
} = syncState;

class RuntimeValues {
	#counter = 0;
	#seen = new Set();

	digest(domain) {
		const digest = framedCorpusDigest(sampleSeed, domain, this.#counter++);
		assertCanonicalHash(digest);
		if (this.#seen.has(digest)) throw new Error("Runtime value generator produced a duplicate digest");
		this.#seen.add(digest);
		return digest;
	}

	hashes(count, domain) {
		return Array.from({ length: count }, (_, index) => this.digest(`${domain}:${index}`));
	}
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PEER_ID_PREFIX = "16Uiu2HAm";

function deterministicPeerId(values, pair) {
	let suffix = "";
	let block = 0;
	while (suffix.length < 44) {
		const digest = values.digest(`peer-id:${pair}:${block++}`);
		for (let index = 0; index < digest.length && suffix.length < 44; index += 2) {
			suffix += BASE58_ALPHABET[Number.parseInt(digest.slice(index, index + 2), 16) % BASE58_ALPHABET.length];
		}
	}
	const peerId = `${PEER_ID_PREFIX}${suffix}`;
	if (peerId.length !== 53 || !/^[1-9A-HJ-NP-Za-km-z]{53}$/u.test(peerId)) {
		throw new Error("Generated peer key is not a 53-character base58 production-shaped string");
	}
	return peerId;
}

function assertFramingAndN512CorpusProbe() {
	// This exact ambiguity occurred in the old N=512 outstanding corpus.
	const legacyLeft = `${sampleSeed}${"outstanding:11"}${1007}`;
	const legacyRight = `${sampleSeed}${"outstanding:1"}${11007}`;
	if (legacyLeft !== legacyRight) throw new Error("Legacy ambiguity probe is malformed");
	if (
		framedCorpusDigest(sampleSeed, "outstanding:11", 1007) === framedCorpusDigest(sampleSeed, "outstanding:1", 11007)
	) {
		throw new Error("Framed corpus inputs did not separate the pinned legacy ambiguity");
	}
	const probeValues = new RuntimeValues();
	const probe = new Set(Array.from({ length: 512 }, (_, pair) => deterministicPeerId(probeValues, pair)));
	if (probe.size !== 512) throw new Error("Pinned N=512 deterministic peer-key corpus contains a collision");
}

assertFramingAndN512CorpusProbe();

function shapeCensus(selectedShape) {
	if (selectedShape === "minimal-dormant") {
		return { advertisedHeads: 0, attempts: 0, branchCuts: 0, cooldown: "undefined", outstanding: 0, sharedHeads: 0 };
	}
	if (selectedShape === "maximum-dormant") {
		return { advertisedHeads: 32, attempts: 0, branchCuts: 32, cooldown: "undefined", outstanding: 0, sharedHeads: 32 };
	}
	if (selectedShape === "post-completion-dormant") {
		return { advertisedHeads: 0, attempts: 0, branchCuts: 0, cooldown: "undefined", outstanding: 0, sharedHeads: 0 };
	}
	if (selectedShape === "active-cooldown") {
		return {
			advertisedHeads: 0,
			attempts: 3,
			branchCuts: 0,
			cooldown: "active-defined",
			outstanding: 64,
			sharedHeads: 0,
		};
	}
	if (selectedShape === "expired-defined-cooldown") {
		return {
			advertisedHeads: 0,
			attempts: 3,
			branchCuts: 0,
			cooldown: "expired-defined",
			outstanding: 64,
			sharedHeads: 0,
		};
	}
	const attempts = Number(selectedShape.at(-1));
	return { advertisedHeads: 0, attempts, branchCuts: 0, cooldown: "undefined", outstanding: 64, sharedHeads: 0 };
}

function operationCensus(selectedShape) {
	const counts = {
		completePresentExactRequests: 0,
		prepareSyncSend: 0,
		queueExactRequests: 0,
		recordAdvertisedHeads: 0,
		recordBranchCuts: 0,
		recordSharedHeads: 0,
	};
	if (selectedShape === "minimal-dormant") counts.prepareSyncSend = 1;
	else if (selectedShape === "maximum-dormant") {
		counts.recordAdvertisedHeads = 1;
		counts.recordBranchCuts = 1;
		counts.recordSharedHeads = 1;
	} else {
		counts.queueExactRequests = 1;
		if (selectedShape === "post-completion-dormant") counts.completePresentExactRequests = 1;
		else if (selectedShape === "active-cooldown" || selectedShape === "expired-defined-cooldown") {
			counts.prepareSyncSend = 4;
		} else counts.prepareSyncSend = Number(selectedShape.at(-1));
	}
	return counts;
}

function operationSequence(selectedShape) {
	if (selectedShape === "minimal-dormant") {
		return [{ effect: "allocate dormant pair", inputCount: 0, operation: "prepareSyncSend", repeat: 1 }];
	}
	if (selectedShape === "maximum-dormant") {
		return [
			{ effect: "replace advertised heads", inputCount: 32, operation: "recordAdvertisedHeads", repeat: 1 },
			{ effect: "retain branch cuts", inputCount: 32, operation: "recordBranchCuts", repeat: 1 },
			{ effect: "replace shared heads", inputCount: 32, operation: "recordSharedHeads", repeat: 1 },
		];
	}
	const sequence = [
		{ effect: "allocate outstanding hashes", inputCount: 64, operation: "queueExactRequests", repeat: 1 },
	];
	if (selectedShape === "post-completion-dormant") {
		sequence.push({
			effect: "deallocate 64 outstanding hashes",
			inputCount: 64,
			operation: "completePresentExactRequests",
			repeat: 1,
		});
		return sequence;
	}
	const repeat = selectedShape.startsWith("outstanding-attempt-") ? Number(selectedShape.at(-1)) : 4;
	if (repeat > 0) {
		sequence.push({
			effect: selectedShape.includes("cooldown") ? "charge attempts then define cooldown" : `charge ${repeat} attempts`,
			inputCount: 0,
			operation: "prepareSyncSend",
			repeat,
		});
	}
	return sequence;
}

function multiplyCounts(counts, multiplier) {
	return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * multiplier]));
}

function objectCountFor(selectedPlacement, pairCount) {
	if (pairCount === 0) return 0;
	if (selectedPlacement === "one-hot-object") return 1;
	if (selectedPlacement === "round-robin-20" || selectedPlacement === "demand-20x14") return Math.min(20, pairCount);
	throw new Error(`Unknown placement: ${selectedPlacement}`);
}

function applyShape(node, objectId, peerId, values, selectedShape) {
	if (selectedShape === "minimal-dormant") {
		prepareSyncSend(node, objectId, peerId, "scheduled-probe");
		return;
	}
	if (selectedShape === "maximum-dormant") {
		const advertised = values.hashes(32, "advertised");
		const shared = values.hashes(32, "shared");
		const cuts = values.hashes(32, "cuts");
		recordAdvertisedHeads(node, objectId, peerId, advertised);
		recordBranchCuts(node, objectId, peerId, cuts);
		const retainedCuts = sharedHashes(node, objectId, peerId);
		if (retainedCuts.length !== 32 || !cuts.every((hash) => retainedCuts.includes(hash))) {
			throw new Error("Public structural verification failed for retained branch cuts");
		}
		recordSharedHeads(node, objectId, peerId, shared);
		const finalShared = sharedHashes(node, objectId, peerId);
		if (
			!advertisedTheseHeads(node, objectId, peerId, advertised) ||
			finalShared.length !== 32 ||
			!shared.every((hash) => finalShared.includes(hash))
		) {
			throw new Error("Public structural verification failed for maximum dormant state");
		}
		return;
	}
	const outstanding = values.hashes(64, "outstanding");
	if (!queueExactRequests(node, objectId, peerId, outstanding)) throw new Error("Expected exact request allocation");
	if (selectedShape === "post-completion-dormant") {
		completePresentExactRequests(node, objectId, peerId, () => true);
		if (previewSyncSend(node, objectId, peerId, "scheduled-probe").requestedHashes.length !== 0) {
			throw new Error("Post-completion state retained an outstanding request");
		}
		return;
	}
	const attempts = selectedShape.startsWith("outstanding-attempt-") ? Number(selectedShape.at(-1)) : 4;
	const actualNow = Date.now;
	if (selectedShape === "expired-defined-cooldown") {
		const past = actualNow() - 60_000;
		Date.now = () => past;
	}
	try {
		for (let index = 0; index < attempts; index++) prepareSyncSend(node, objectId, peerId, "scheduled-probe");
	} finally {
		Date.now = actualNow;
	}
	const preview = previewSyncSend(node, objectId, peerId, "scheduled-probe");
	if (selectedShape === "active-cooldown" && preview.send) throw new Error("Expected active cooldown suppression");
	if (selectedShape === "expired-defined-cooldown" && (!preview.send || preview.requestedHashes.length !== 32)) {
		throw new Error("Expected an expired, defined cooldown immediately before normal resume");
	}
}

function populate(node, creatorPeerId) {
	const values = new RuntimeValues();
	const objectCount = objectCountFor(placement, population);
	const objectIds = values
		.hashes(objectCount, "object-salt")
		.map((digest) => `${creatorPeerId}:${digest.slice(0, 32)}`);
	let peerLengthMin = Number.POSITIVE_INFINITY;
	let peerLengthMax = 0;
	const seenPeerIds = new Set();
	let compositeKeyLength;
	for (let pair = 0; pair < population; pair++) {
		const peerId = deterministicPeerId(values, pair);
		if (seenPeerIds.has(peerId)) throw new Error(`Duplicate deterministic peer key at pair ${pair}`);
		seenPeerIds.add(peerId);
		peerLengthMin = Math.min(peerLengthMin, peerId.length);
		peerLengthMax = Math.max(peerLengthMax, peerId.length);
		const objectIndex = placement === "one-hot-object" ? 0 : pair % 20;
		const objectId = objectIds[objectIndex];
		if (objectId === undefined || !objectId.startsWith(`${creatorPeerId}:`) || !/:[0-9a-f]{32}$/u.test(objectId)) {
			throw new Error("Generated object identity is not creator-bound with a 16-byte lowercase-hex salt");
		}
		const retainedCompositeKey = JSON.stringify([objectId, peerId]);
		if (retainedCompositeKey.length !== 146) {
			throw new Error(`Retained composite JSON tuple key length ${retainedCompositeKey.length}; expected 146`);
		}
		compositeKeyLength = retainedCompositeKey.length;
		applyShape(node, objectId, peerId, values, shape);
	}
	const pairsPerObject = Array.from({ length: objectCount }, (_, index) => {
		if (placement === "one-hot-object") return population;
		return Math.floor(population / 20) + (index < population % 20 ? 1 : 0);
	});
	return {
		creatorPeerIdLength: creatorPeerId.length,
		compositeJsonTupleKeyUtf16Length: compositeKeyLength,
		objectCount,
		objectIdLength: objectIds[0]?.length,
		operationSequence: operationSequence(shape),
		operationTotals: multiplyCounts(operationCensus(shape), population),
		pairCount: population,
		pairsPerObject: {
			maximum: pairsPerObject.length === 0 ? 0 : Math.max(...pairsPerObject),
			minimum: pairsPerObject.length === 0 ? 0 : Math.min(...pairsPerObject),
			sum: pairsPerObject.reduce((sum, count) => sum + count, 0),
		},
		peerIdLength: {
			maximum: population === 0 ? undefined : peerLengthMax,
			minimum: population === 0 ? undefined : peerLengthMin,
		},
		perPair: shapeCensus(shape),
	};
}

async function stableHeapReading() {
	const readings = [];
	let stabilized = false;
	for (let cycle = 1; cycle <= 10; cycle++) {
		globalThis.gc();
		await macrotask();
		const reading = {
			cycle,
			heapUsed: process.memoryUsage().heapUsed,
			usedHeapSize: getHeapStatistics().used_heap_size,
		};
		readings.push(reading);
		const previous = readings.at(-2);
		const threshold = Math.max(reading.heapUsed * 0.005, 64 * 1024);
		if (readings.length >= 3 && previous !== undefined && Math.abs(reading.heapUsed - previous.heapUsed) < threshold) {
			stabilized = true;
			break;
		}
	}
	if (!stabilized) throw new Error(`Heap did not stabilize in ten cycles: ${JSON.stringify(readings)}`);
	const finalThree = readings.slice(-3);
	const selected = finalThree.reduce((minimum, candidate) =>
		candidate.heapUsed < minimum.heapUsed ? candidate : minimum
	);
	return { readings, selected, stabilizationCycles: readings.length };
}

const node = new DRPNode({
	keychain_config: { private_key_seed: `phase-1o-f-${sampleSeed}` },
	log_config: { level: "silent" },
	network_config: { bootstrap_peers: [], listen_addresses: [], log_config: { level: "silent" } },
});
const measurementCapacity =
	population > 0 ? MEASUREMENT_CAPACITY_POLICY.nonzeroPopulation : MEASUREMENT_CAPACITY_POLICY.zeroPopulation;
if (measurementCapacity !== null) installSyncStateCapacity(node, measurementCapacity);
await node.keychain.start();
const creatorPrivateKey = privateKeyFromRaw(node.keychain.secp256k1PrivateKey);
if (creatorPrivateKey.type !== "secp256k1") throw new Error("Expected node creator secp256k1 key");
const creatorPeerId = peerIdFromPrivateKey(creatorPrivateKey).toString();
const structuralCensus = populate(node, creatorPeerId);
const heap = await stableHeapReading();

process.stdout.write(
	`${JSON.stringify({
		heap,
		measurementCapacity,
		placement,
		population,
		runtime: {
			arch: process.arch,
			execArgv: process.execArgv,
			modules: process.versions.modules,
			node: process.version,
			platform: process.platform,
			v8: process.versions.v8,
		},
		sampleSeed,
		shape,
		structuralCensus,
	})}\n`
);
