/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
/* eslint-disable import/no-unresolved -- the exact built subpath is intentionally absent in RED */
import { reopenCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption-activate";
/* eslint-enable import/no-unresolved */
import { createNodeDurableIssuanceStore } from "@ts-drp/storage-node/issuance";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { join } from "node:path";

import { network, seedAhe, seedJournal, seedSnapshot, unpack } from "./phase-6a-creator-successor-activation-child.mjs";

const CHAT_SEEDS = Object.freeze({
	alice: "d9336-v3-chat-alice",
	bob: "d9336-v3-chat-bob",
	carol: "d9339-v3-chat-carol",
	dave: "d9339-v3-chat-dave",
	erin: "d9339-v3-chat-erin",
	frank: "d9339-v3-chat-frank",
	grace: "d9339-v3-chat-grace",
	heidi: "d9339-v3-chat-heidi",
});
const LOCAL_AUTHOR_DOMAIN = new TextEncoder().encode("ts-drp-keychain/local-author-ed25519/v1");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function send(value) {
	if (typeof process.send === "function") process.send(value);
}

function localAuthorSeed(configuredSeed) {
	const expanded = createHash("sha512").update(new TextEncoder().encode(configuredSeed)).digest();
	const preimage = new Uint8Array(LOCAL_AUTHOR_DOMAIN.byteLength + 1 + expanded.byteLength);
	preimage.set(LOCAL_AUTHOR_DOMAIN);
	preimage.set(expanded, LOCAL_AUTHOR_DOMAIN.byteLength + 1);
	return new Uint8Array(createHash("sha256").update(preimage).digest());
}

function authority(id) {
	const configuredSeed = CHAT_SEEDS[id];
	if (configuredSeed === undefined) throw new TypeError(`unknown D.108d1b authority ${id}`);
	const seed = localAuthorSeed(configuredSeed);
	const privateKey = createPrivateKey({
		format: "der",
		key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
		type: "pkcs8",
	});
	const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	return Object.freeze({
		author: Buffer.from(publicKey).subarray(-32).toString("hex"),
		id,
		privateKey,
	});
}

function signBytes(bytes, selectedAuthority) {
	return new Uint8Array(sign(null, Buffer.from(bytes), selectedAuthority.privateKey));
}

function trustedCatalog(material) {
	return Object.freeze({
		blueprintDigests: Object.freeze([...material.catalog.blueprintDigests]),
		catalogDigest: material.catalog.catalogDigest,
		resolve(blueprintDigest) {
			if (blueprintDigest !== material.catalog.resolved.blueprintDigest) {
				throw new TypeError("D.108d1b blueprint is not catalogued");
			}
			return material.catalog.resolved;
		},
	});
}

function ordinary(bytes) {
	return (
		bytes instanceof Uint8Array &&
		bytes.constructor === Uint8Array &&
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength
	);
}

function carrierCommit(carrier, objectId) {
	const scope = Object.freeze({ author: carrier.author, objectId });
	const envelope = Object.freeze({
		canonicalPreimageBytes: new Uint8Array(carrier.canonicalPreimageBytes),
		digest: new Uint8Array(carrier.digest),
		signature: new Uint8Array(carrier.signature),
	});
	return Object.freeze({
		authorSequence: carrier.authorSequence,
		envelope,
		issuedRecord: Object.freeze({ authorSequence: carrier.authorSequence, envelope, scope }),
		outboxEntry: Object.freeze({ authorSequence: carrier.authorSequence, envelope, scope }),
	});
}

function derivedCarrier(material, selectedAuthority) {
	const base = decodeCanonical(material.establishedPeer.canonicalPreimageBytes);
	if (base === null || typeof base !== "object" || Array.isArray(base)) {
		throw new TypeError("D.108d1b established preimage is malformed");
	}
	const canonicalPreimageBytes = encodeCanonical({
		...base,
		author: selectedAuthority.author,
		authorSequence: 0,
	});
	const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	return Object.freeze({
		author: selectedAuthority.author,
		authorSequence: 0,
		canonicalPreimageBytes,
		digest,
		signature: signBytes(digest, selectedAuthority),
	});
}

async function seedIssuance(material, suffix, carriers, effects) {
	const raw = createNodeDurableIssuanceStore({
		primaryFilename: join(material.directory, `issuance-local-author-${suffix}.sqlite`),
	});
	for (const carrier of carriers) {
		const commit = carrier.commit ?? carrierCommit(carrier, material.proposed.head.objectId);
		const scope = commit.issuedRecord.scope;
		await raw.transactIssue(scope, (selected) => {
			if (selected !== commit.authorSequence) throw new TypeError("D.108d1b seeded lineage diverged");
			return Promise.resolve(commit);
		});
	}
	const store = new Proxy(raw, {
		get(target, property, receiver) {
			if (property === "readLineage") {
				return (scope) => {
					effects.lineageReads.push(scope.author);
					return target.readLineage(scope);
				};
			}
			if (property === "transactIssue") {
				return (...args) => {
					effects.transactIssueCount += 1;
					return target.transactIssue(...args);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	return { raw, store };
}

function signerFor(material, scenario, selectedAuthority, wrongAuthority, observations) {
	return async (bytes) => {
		observations.push({
			bytes: Buffer.from(bytes).toString("hex"),
			ordinary: ordinary(bytes),
		});
		if (scenario === "throw") throw new TypeError("D.108d1b signer threw");
		if (scenario === "reject") return Promise.reject(new TypeError("D.108d1b signer rejected"));
		if (scenario === "anchor-replay") return new Uint8Array(material.creatorGenesis.detachedSignature);
		if (scenario === "mutation") {
			const retained = new Uint8Array(bytes);
			bytes[0] ^= 0xff;
			return signBytes(retained, selectedAuthority);
		}
		const signature = signBytes(bytes, scenario === "wrong-key" ? wrongAuthority : selectedAuthority);
		if (scenario === "signature-view") {
			const carrier = new Uint8Array(signature.byteLength + 1);
			carrier.set(signature, 1);
			return carrier.subarray(1);
		}
		return signature;
	};
}

async function journalRows(raw, scope) {
	const readiness = await raw.readiness({ scope });
	if (!readiness.ok || !readiness.ready) throw new TypeError("D.108d1b epoch-one journal is unavailable");
	const rows = [];
	let afterSequence = null;
	while (true) {
		const page = await raw.readPage({ afterSequence, limit: 128, scope, snapshot: readiness.snapshot });
		if (!page.ok) throw new TypeError("D.108d1b epoch-one journal page is unavailable");
		rows.push(...page.rows);
		if (page.nextSequence === null) return rows;
		afterSequence = page.nextSequence;
	}
}

async function runCase(material, index, input) {
	const suffix = `-${index}-${input.name}`;
	const events = [];
	const publications = [];
	const effects = {
		aheRecoverCount: 0,
		installEpochAnchorCount: 0,
		lineageReads: [],
		snapshotOpenCount: 0,
		transactIssueCount: 0,
	};
	const [ahe, liveJournal, snapshot] = await Promise.all([
		seedAhe(material, effects, suffix),
		seedJournal(material, effects, suffix),
		seedSnapshot(material, events, effects, suffix),
	]);
	const issuance = await seedIssuance(material, suffix, input.carriers, effects);
	const node = network(events, publications, `d108d1b-target-${index}`);
	const observations = [];
	const signer = signerFor(material, input.scenario, input.authority, input.wrongAuthority, observations);
	let activeHandle;
	try {
		const result = await reopenCreatorSuccessorAdoption({
			...material.creatorGenesis,
			author: input.authority.author,
			catalog: trustedCatalog(material),
			issuanceStore: issuance.store,
			liveJournalStore: liveJournal.store,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: node,
			onAdmittedVertex: () => undefined,
			signRegisteredVertexDigest: signer,
			snapshotDeclaration: material.snapshot.declaration,
			snapshotStore: snapshot.store,
			store: ahe.store,
		});
		const shared = {
			effects: {
				adoptionSwapCount: ahe.adoptionSwapCount(),
				installEpochAnchorCount: effects.installEpochAnchorCount,
				lineageReads: [...effects.lineageReads],
				publicationCount: publications.length,
				snapshotOpenCount: effects.snapshotOpenCount,
				subscribeCount: events.filter((event) => event === "subscribe").length,
				transactIssueCount: effects.transactIssueCount,
			},
			name: input.name,
			signerCalls: observations,
		};
		if (!result.ok) {
			return { ...shared, result: { detail: result.detail, kind: result.kind, ok: false } };
		}
		activeHandle = result.handle;
		const issued = await result.handle.issueLocal({
			operations: [{ logicalTime: 64 + index, operation: { action: "add", value: index + 10 } }],
			signRegisteredVertexDigest: signer,
		});
		if (!issued.ok) throw new TypeError(`D.108d1b ${input.name} issue failed: ${issued.kind}`);
		const scope = Object.freeze({ author: input.authority.author, objectId: material.proposed.head.objectId });
		const outbox = await issuance.raw.readOutboxPage({ scope });
		const selected = outbox.find((row) => row.commit.authorSequence === issued.authorSequence);
		if (selected === undefined) throw new TypeError(`D.108d1b ${input.name} outbox row is unavailable`);
		const preimage = decodeCanonical(selected.commit.envelope.canonicalPreimageBytes);
		const rows = await journalRows(liveJournal.raw, {
			anchorDigest: material.oracle.anchorDigest,
			epoch: 1,
			objectId: material.proposed.head.objectId,
		});
		const accepted = rows.find((row) => row.vertexDigest === issued.digest);
		return {
			...shared,
			issued: {
				acceptedJournalAuthor: accepted?.sourceKind === "local-issued" ? accepted.author : undefined,
				author: preimage.author,
				authorSequence: preimage.authorSequence,
				issuedRowAuthor: selected.commit.issuedRecord.scope.author,
				outboxRowAuthor: selected.commit.outboxEntry.scope.author,
			},
			result: { lifecycle: result.lifecycle, ok: true, recovery: result.recovery },
		};
	} finally {
		await Promise.resolve(activeHandle?.deactivate());
		await Promise.allSettled([snapshot.raw.close(), liveJournal.raw.close(), issuance.raw.close(), ahe.raw.close()]);
	}
}

async function matrix(material) {
	if (material.establishedPeer === undefined) throw new TypeError("D.108d1b established peer carrier is unavailable");
	const alice = authority("alice");
	const bob = authority("bob");
	const carol = authority("carol");
	const dave = authority("dave");
	if (material.establishedPeer.author !== bob.author) {
		throw new TypeError("D.108d1b established carrier does not belong to Bob");
	}
	const bobCarrier = material.establishedPeer;
	const carolCarrier = derivedCarrier(material, carol);
	const creatorRows = material.issuance.outbox.map(({ commit }) => ({ commit }));
	const cases = [
		{ authority: bob, carriers: [bobCarrier], name: "established-bob", scenario: "valid", wrongAuthority: carol },
		{ authority: carol, carriers: [], name: "fresh-carol", scenario: "valid", wrongAuthority: bob },
		{
			authority: bob,
			carriers: [bobCarrier, ...creatorRows],
			name: "copied-creator-lineage",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{ authority: carol, carriers: [], name: "wrong-author-right-signer", scenario: "wrong-key", wrongAuthority: bob },
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "right-author-wrong-signer",
			scenario: "wrong-key",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier, carolCarrier],
			name: "two-nonzero-lineages",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{ authority: bob, carriers: [bobCarrier], name: "anchor-replay", scenario: "anchor-replay", wrongAuthority: carol },
		{ authority: bob, carriers: [bobCarrier], name: "signer-mutation", scenario: "mutation", wrongAuthority: carol },
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "signature-alias",
			scenario: "signature-view",
			wrongAuthority: carol,
		},
		{ authority: bob, carriers: [bobCarrier], name: "signer-throw", scenario: "throw", wrongAuthority: carol },
		{ authority: bob, carriers: [bobCarrier], name: "signer-reject", scenario: "reject", wrongAuthority: carol },
		{ authority: dave, carriers: [], name: "non-writer", scenario: "valid", wrongAuthority: alice },
	];
	const results = [];
	for (let index = 0; index < cases.length; index += 1) {
		results.push(await runCase(material, index, cases[index]));
	}
	return Object.freeze({
		authors: Object.freeze({ alice: alice.author, bob: bob.author, carol: carol.author, dave: dave.author }),
		pid: process.pid,
		results: Object.freeze(results),
	});
}

void new Promise((resolve) => process.once("message", (message) => resolve(unpack(message))))
	.then(matrix)
	.then((proof) => send({ kind: "proof", proof }))
	.catch((error) => {
		send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	});
