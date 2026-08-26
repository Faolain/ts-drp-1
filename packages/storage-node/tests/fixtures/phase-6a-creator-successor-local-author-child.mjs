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

function peerJournalMaterial(material) {
	const localCommits = new Map(
		material.issuance.outbox.map(({ commit }) => [Buffer.from(commit.envelope.digest).toString("hex"), commit])
	);
	return {
		...material,
		journalRows: material.journalRows.map((row) => {
			if (row.sourceKind !== "local-issued") return row;
			const commit = localCommits.get(row.vertexDigest);
			if (commit === undefined) throw new TypeError("D.108d1b peer journal carrier is unavailable");
			return Object.freeze({
				detachedSignature: commit.envelope.signature,
				exactCanonicalPreimageBytes: commit.envelope.canonicalPreimageBytes,
				journalSequence: row.journalSequence,
				scope: row.scope,
				sourceKind: "received",
				vertexDigest: row.vertexDigest,
			});
		}),
	};
}

function sameBytes(left, right) {
	return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function concatenate(chunks) {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function durableByteValues(value, selectedByteLength, output = new Set(), visited = new WeakSet()) {
	if (value instanceof Uint8Array) {
		if (value.byteLength === selectedByteLength) output.add(Buffer.from(value).toString("hex"));
		return output;
	}
	if (value === null || typeof value !== "object" || visited.has(value)) return output;
	visited.add(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		durableByteValues(entry, selectedByteLength, output, visited);
	}
	return output;
}

function packedOracle(material) {
	const payload = decodeCanonical(concatenate(material.snapshot.chunks));
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new TypeError("D.108d1b packed snapshot payload is malformed");
	}
	const acl = payload.acl;
	if (acl === null || typeof acl !== "object" || Array.isArray(acl) || !Array.isArray(acl.members)) {
		throw new TypeError("D.108d1b packed snapshot ACL is malformed");
	}
	const peerMaterial = peerJournalMaterial(material);
	const established = material.establishedPeer;
	const digest = Buffer.from(established.digest).toString("hex");
	const rows = peerMaterial.journalRows.filter((row) => row.vertexDigest === digest);
	const row = rows[0];
	return Object.freeze({
		aclMembers: Object.freeze(
			acl.members.map((member) =>
				Object.freeze({
					author: member.author,
					groups: Object.freeze([...member.groups]),
				})
			)
		),
		bobCarrier: Object.freeze({
			exactlyOnce: rows.length === 1,
			preimageMatches:
				row?.exactCanonicalPreimageBytes instanceof Uint8Array &&
				sameBytes(row.exactCanonicalPreimageBytes, established.canonicalPreimageBytes),
			scopeMatches:
				row?.scope?.anchorDigest === material.oracle.genesisAnchorDigest &&
				row.scope.epoch === 0 &&
				row.scope.objectId === material.proposed.head.objectId,
			signatureMatches:
				row?.detachedSignature instanceof Uint8Array && sameBytes(row.detachedSignature, established.signature),
			sourceKind: row?.sourceKind,
			vertexDigest: row?.vertexDigest,
		}),
	});
}

function repeatFaultCommit(commit, fault) {
	const decoded = decodeCanonical(commit.envelope.canonicalPreimageBytes);
	const canonicalPreimageBytes =
		fault === "malformed"
			? Uint8Array.of(0xff)
			: encodeCanonical({
					...decoded,
					logicalTime: Number(decoded.logicalTime) + 1,
				});
	const envelope = Object.freeze({
		canonicalPreimageBytes,
		digest: hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes),
		signature: Uint8Array.from(commit.envelope.signature, (byte, index) => (index === 0 ? byte ^ 1 : byte)),
	});
	return Object.freeze({
		...commit,
		envelope,
		issuedRecord: Object.freeze({ ...commit.issuedRecord, envelope }),
		outboxEntry: Object.freeze({ ...commit.outboxEntry, envelope }),
	});
}

function instrumentIssuanceStore(raw, effects, input) {
	const descriptors = Object.getOwnPropertyDescriptors(raw);
	const readIssued = descriptors.readIssued;
	const readLineage = descriptors.readLineage;
	const readOutboxPage = descriptors.readOutboxPage;
	const transactIssue = descriptors.transactIssue;
	if (
		readIssued === undefined ||
		!("value" in readIssued) ||
		readLineage === undefined ||
		!("value" in readLineage) ||
		readOutboxPage === undefined ||
		!("value" in readOutboxPage) ||
		transactIssue === undefined ||
		!("value" in transactIssue)
	) {
		throw new TypeError("D.108d1b issuance store shape is unavailable");
	}
	descriptors.readLineage = {
		...readLineage,
		value: async (scope) => {
			effects.lineageReads.push(scope.author);
			effects.order.push(`lineage:${scope.author}`);
			const lineage = await raw.readLineage(scope);
			if (input.lineageFault === "selected-exhausted" && scope.author === input.authority.author) {
				return { ...lineage, exhausted: true };
			}
			if (input.lineageFault === "malformed-exhausted" && scope.author === input.authority.author) {
				return { ...lineage, exhausted: 0 };
			}
			if (input.lineageFault === "foreign-exhausted" && scope.author === input.lineageFaultAuthor) {
				return { ...lineage, exhausted: true };
			}
			return lineage;
		},
	};
	descriptors.readIssued = {
		...readIssued,
		value: async (scope, authorSequence) => {
			const commit = await raw.readIssued(scope, authorSequence);
			if (!effects.repeatPhase || authorSequence !== 1 || input.repeatOutboxFault === undefined) return commit;
			if (input.repeatOutboxFault === "read-issued-throw") {
				throw new TypeError("D.108d1b repeat issued-record read failed");
			}
			return commit === null ? null : repeatFaultCommit(commit, input.repeatOutboxFault);
		},
	};
	descriptors.readOutboxPage = {
		...readOutboxPage,
		value: async (...args) => {
			const rows = await raw.readOutboxPage(...args);
			if (!effects.repeatPhase || input.repeatOutboxFault === undefined) return rows;
			return rows.map((row) =>
				row.commit.authorSequence === 1 && input.repeatOutboxFault !== "read-issued-throw"
					? Object.freeze({ ...row, commit: repeatFaultCommit(row.commit, input.repeatOutboxFault) })
					: row
			);
		},
	};
	descriptors.transactIssue = {
		...transactIssue,
		value: (...args) => {
			effects.transactIssueCount += 1;
			return raw.transactIssue(...args);
		},
	};
	const store = Object.freeze(Object.defineProperties(Object.create(Object.getPrototypeOf(raw)), descriptors));
	effects.issuanceStoreShape =
		Reflect.ownKeys(store).length === Reflect.ownKeys(raw).length &&
		Reflect.ownKeys(raw).every((key, index) => key === Reflect.ownKeys(store)[index]) &&
		Reflect.ownKeys(raw).every((key) => {
			const expected = Object.getOwnPropertyDescriptor(raw, key);
			const actual = Object.getOwnPropertyDescriptor(store, key);
			return (
				expected !== undefined &&
				actual !== undefined &&
				expected.enumerable === actual.enumerable &&
				expected.configurable === actual.configurable &&
				"value" in expected === "value" in actual
			);
		});
	return store;
}

async function seedIssuance(material, suffix, carriers, effects, input) {
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
	const store = instrumentIssuanceStore(raw, effects, input);
	return { raw, store };
}

function signerFor(material, scenario, selectedAuthority, wrongAuthority, observations, state, effects, durableValues) {
	return async (bytes) => {
		effects.order.push(`${state.use}:signer`);
		observations.push({
			bytes: Buffer.from(bytes).toString("hex"),
			matchesDurableCarrier: durableValues.has(Buffer.from(bytes).toString("hex")),
			ordinary: ordinary(bytes),
			use: state.use,
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

async function withCryptoScenario(scenario, operation) {
	if (scenario !== "missing-webcrypto" && scenario !== "ed25519-unavailable") return operation();
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const webCrypto = globalThis.crypto;
	try {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			enumerable: true,
			value:
				scenario === "missing-webcrypto"
					? undefined
					: Object.freeze({
							getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
							subtle: Object.freeze({
								importKey: () => Promise.reject(new DOMException("Ed25519 unavailable", "NotSupportedError")),
								verify: webCrypto.subtle.verify.bind(webCrypto.subtle),
							}),
						}),
		});
		return await operation();
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(globalThis, "crypto");
		else Object.defineProperty(globalThis, "crypto", descriptor);
	}
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
		issuanceStoreShape: false,
		lineageReads: [],
		order: [],
		repeatPhase: false,
		snapshotOpenCount: 0,
		transactIssueCount: 0,
	};
	const [ahe, liveJournal, snapshot] = await Promise.all([
		seedAhe(material, effects, suffix),
		seedJournal(peerJournalMaterial(material), effects, suffix),
		seedSnapshot(material, events, effects, suffix),
	]);
	const issuance = await seedIssuance(material, suffix, input.carriers, effects, input);
	const node = network(events, publications, `d108d1b-target-${index}`);
	const observations = [];
	const state = { use: "possession" };
	const signer = signerFor(
		material,
		input.scenario,
		input.authority,
		input.wrongAuthority,
		observations,
		state,
		effects,
		durableByteValues(material, 32)
	);
	const reopen = () =>
		withCryptoScenario(input.scenario, () =>
			reopenCreatorSuccessorAdoption({
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
			})
		);
	const shared = () => ({
		effects: {
			adoptionSwapCount: ahe.adoptionSwapCount(),
			aheRecoverCount: effects.aheRecoverCount,
			installEpochAnchorCount: effects.installEpochAnchorCount,
			issuanceStoreShape: effects.issuanceStoreShape,
			lineageReads: [...effects.lineageReads],
			order: [...effects.order],
			publicationCount: publications.length,
			snapshotOpenCount: effects.snapshotOpenCount,
			subscribeCount: events.filter((event) => event === "subscribe").length,
			transactIssueCount: effects.transactIssueCount,
		},
		name: input.name,
		signerCalls: [...observations],
	});
	const issuedEvidence = async (issued) => {
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
			acceptedJournalAuthor: accepted?.sourceKind === "local-issued" ? accepted.author : undefined,
			author: preimage.author,
			authorSequence: preimage.authorSequence,
			issuedRowAuthor: selected.commit.issuedRecord.scope.author,
			outboxRowAuthor: selected.commit.outboxEntry.scope.author,
		};
	};
	let activeHandle;
	try {
		const result = await reopen();
		if (!result.ok) {
			return { ...shared(), result: { detail: result.detail, kind: result.kind, ok: false } };
		}
		activeHandle = result.handle;
		state.use = "issue";
		const issued = await result.handle.issueLocal({
			operations: [{ logicalTime: 64 + index, operation: { action: "add", value: index + 10 } }],
			signRegisteredVertexDigest: signer,
		});
		if (!issued.ok) throw new TypeError(`D.108d1b ${input.name} issue failed: ${issued.kind}`);
		const firstIssued = await issuedEvidence(issued);
		let repeat;
		if (input.repeat === true) {
			await Promise.resolve(activeHandle.deactivate());
			activeHandle = undefined;
			effects.repeatPhase = true;
			state.use = "possession";
			const reopened = await reopen();
			if (!reopened.ok) {
				repeat = { result: { detail: reopened.detail, kind: reopened.kind, ok: false } };
			} else {
				activeHandle = reopened.handle;
				state.use = "issue";
				const reissued = await reopened.handle.issueLocal({
					operations: [{ logicalTime: 96 + index, operation: { action: "add", value: index + 20 } }],
					signRegisteredVertexDigest: signer,
				});
				if (!reissued.ok) throw new TypeError(`D.108d1b ${input.name} repeat issue failed: ${reissued.kind}`);
				repeat = {
					issued: await issuedEvidence(reissued),
					result: { lifecycle: reopened.lifecycle, ok: true, recovery: reopened.recovery },
				};
			}
		}
		return {
			...shared(),
			issued: firstIssued,
			...(repeat === undefined ? {} : { repeat }),
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
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "established-bob",
			repeat: true,
			scenario: "valid",
			wrongAuthority: carol,
		},
		{ authority: carol, carriers: [], name: "fresh-carol", scenario: "valid", wrongAuthority: bob },
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "forged-future-outbox",
			repeat: true,
			repeatOutboxFault: "forged-future",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "malformed-future-outbox",
			repeat: true,
			repeatOutboxFault: "malformed",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "future-outbox-read-failure",
			repeat: true,
			repeatOutboxFault: "read-issued-throw",
			scenario: "valid",
			wrongAuthority: carol,
		},
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
		{
			authority: bob,
			carriers: [bobCarrier],
			lineageFault: "selected-exhausted",
			name: "selected-exhausted-lineage",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			lineageFault: "foreign-exhausted",
			lineageFaultAuthor: carol.author,
			name: "foreign-exhausted-lineage",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			lineageFault: "malformed-exhausted",
			name: "malformed-exhausted-lineage",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "missing-webcrypto",
			scenario: "missing-webcrypto",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			name: "ed25519-unavailable",
			scenario: "ed25519-unavailable",
			wrongAuthority: carol,
		},
	];
	const results = [];
	for (let index = 0; index < cases.length; index += 1) {
		results.push(await runCase(material, index, cases[index]));
	}
	return Object.freeze({
		authors: Object.freeze({ alice: alice.author, bob: bob.author, carol: carol.author, dave: dave.author }),
		oracle: packedOracle(material),
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
