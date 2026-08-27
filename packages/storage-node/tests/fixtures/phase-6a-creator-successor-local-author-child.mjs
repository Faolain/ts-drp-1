/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { MessageQueueManager } from "@ts-drp/message-queue";
/* eslint-disable import/no-unresolved -- the exact built subpath is intentionally absent in RED */
import { reopenCreatorSuccessorAdoption } from "@ts-drp/node/creator-adoption-activate";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
/* eslint-enable import/no-unresolved */
import { createNodeDurableIssuanceStore } from "@ts-drp/storage-node/issuance";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
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
	const publicKey = createPublicKey(privateKey);
	const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
	return Object.freeze({
		author: Buffer.from(publicKeyBytes).subarray(-32).toString("hex"),
		id,
		privateKey,
		publicKey,
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
	const firstMember = acl.members[0];
	if (firstMember === undefined || !Array.isArray(firstMember.groups) || firstMember.groups.length === 0) {
		throw new TypeError("D.108e2c malformed-member control lacks an ACL member");
	}
	const malformedGroups =
		firstMember.groups.length === 1
			? [firstMember.groups[0], firstMember.groups[0]]
			: [firstMember.groups[1], firstMember.groups[0], ...firstMember.groups.slice(2)];
	const exactCanonicalMalformedAclBytes = encodeCanonical({
		...acl,
		members: [{ ...firstMember, groups: malformedGroups }, ...acl.members.slice(1)],
	});
	const malformedAclDigest = Buffer.from(hashDomain("ts-drp/latched-acl/v3", exactCanonicalMalformedAclBytes)).toString(
		"hex"
	);
	const authenticatedAnchor = decodeCanonical(material.creatorGenesis.exactCanonicalAnchorPreimageBytes);
	if (
		authenticatedAnchor === null ||
		typeof authenticatedAnchor !== "object" ||
		Array.isArray(authenticatedAnchor) ||
		typeof authenticatedAnchor.aclDigest !== "string"
	) {
		throw new TypeError("D.108e4 authenticated predecessor anchor is unavailable");
	}
	const authenticatedAcl = material.blobs.at(-1);
	if (authenticatedAcl?.bytes instanceof Uint8Array !== true) {
		throw new TypeError("D.108e4 authenticated predecessor ACL is unavailable");
	}
	const decodedAuthenticatedAcl = decodeCanonical(authenticatedAcl.bytes);
	if (
		decodedAuthenticatedAcl === null ||
		typeof decodedAuthenticatedAcl !== "object" ||
		Array.isArray(decodedAuthenticatedAcl)
	) {
		throw new TypeError("D.108e4 authenticated predecessor ACL is malformed");
	}
	const exactCanonicalAuthenticatedAclBytes = encodeCanonical(decodedAuthenticatedAcl);
	const authenticatedAclDigest = Buffer.from(
		hashDomain("ts-drp/latched-acl/v3", exactCanonicalAuthenticatedAclBytes)
	).toString("hex");
	const retainedAuthenticatedAclDigest = Buffer.from(
		hashDomain("ts-drp/latched-acl/v3", authenticatedAcl.bytes)
	).toString("hex");
	const decodedMalformedAcl = decodeCanonical(exactCanonicalMalformedAclBytes);
	return Object.freeze({
		aclMembers: Object.freeze(
			acl.members.map((member) =>
				Object.freeze({
					author: member.author,
					groups: Object.freeze([...member.groups]),
				})
			)
		),
		authenticatedAclControl: Object.freeze({
			anchorDigestMatches: authenticatedAclDigest === authenticatedAnchor.aclDigest,
			bytesMatch: sameBytes(exactCanonicalAuthenticatedAclBytes, authenticatedAcl.bytes),
			digestMatches: authenticatedAclDigest === retainedAuthenticatedAclDigest,
		}),
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
		malformedMemberControl: Object.freeze({
			canonical: sameBytes(encodeCanonical(decodedMalformedAcl), exactCanonicalMalformedAclBytes),
			digestMatches:
				Buffer.from(hashDomain("ts-drp/latched-acl/v3", exactCanonicalMalformedAclBytes)).toString("hex") ===
				malformedAclDigest,
			result: openCanonicalLatchedAclSnapshot({
				exactCanonicalLatchedAclBytes: exactCanonicalMalformedAclBytes,
				expectedAclDigest: malformedAclDigest,
				expectedEpoch: acl.epoch,
				expectedObjectId: acl.objectId,
			}),
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
			effects.authorityEvents.push({
				attempt: effects.authorityAttempt,
				author: scope.author,
				kind: "lineage-read",
			});
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
			if (input.lineageFault === "negative-next" && scope.author === input.authority.author) {
				return { ...lineage, next: -1 };
			}
			if (input.lineageFault === "unsafe-next" && scope.author === input.authority.author) {
				return { ...lineage, next: Number.MAX_SAFE_INTEGER + 1 };
			}
			return lineage;
		},
	};
	descriptors.readIssued = {
		...readIssued,
		value: async (scope, authorSequence) => {
			const predecessorWindow = effects.predecessorWindows.find(
				(window) => window.attempt === effects.authorityAttempt && !window.complete
			);
			if (predecessorWindow !== undefined) {
				predecessorWindow.issuedReads.push({
					authorSequence,
					scopeIdentity: scope === predecessorWindow.scope ? "captured" : "copied",
				});
			}
			const commit = await raw.readIssued(scope, authorSequence);
			if (authorSequence === 0 && input.currentOutboxFault !== undefined) {
				if (input.currentOutboxFault === "read-issued-throw") {
					throw new TypeError("D.108e2d current issued-record read failed");
				}
				if (commit === null) return null;
				const alternative = signedCloneCommit(
					commit,
					commit.authorSequence,
					input.authority,
					commit.issuedRecord.scope.objectId,
					1_000_000
				);
				const issuedDigest = hashDomain("ts-drp/vertex/v3", alternative.envelope.canonicalPreimageBytes);
				const outboxDigest = hashDomain("ts-drp/vertex/v3", commit.envelope.canonicalPreimageBytes);
				effects.issuedMismatchEvidence = Object.freeze({
					digestEqual: sameBytes(alternative.envelope.digest, commit.envelope.digest),
					issuedSignatureValid:
						sameBytes(issuedDigest, alternative.envelope.digest) &&
						verify(
							null,
							Buffer.from(alternative.envelope.digest),
							input.authority.publicKey,
							Buffer.from(alternative.envelope.signature)
						),
					outboxSignatureValid:
						sameBytes(outboxDigest, commit.envelope.digest) &&
						verify(
							null,
							Buffer.from(commit.envelope.digest),
							input.authority.publicKey,
							Buffer.from(commit.envelope.signature)
						),
					preimageEqual: sameBytes(alternative.envelope.canonicalPreimageBytes, commit.envelope.canonicalPreimageBytes),
					scopeAndSequenceEqual:
						alternative.authorSequence === commit.authorSequence &&
						alternative.issuedRecord.scope.author === commit.issuedRecord.scope.author &&
						alternative.issuedRecord.scope.objectId === commit.issuedRecord.scope.objectId,
				});
				return alternative;
			}
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
			const request = args[0];
			let predecessorWindow = effects.predecessorWindows.find((window) => window.attempt === effects.authorityAttempt);
			if (predecessorWindow === undefined) {
				predecessorWindow = {
					attempt: effects.authorityAttempt,
					complete: false,
					issuedReads: [],
					pages: [],
					scope: request?.scope,
				};
				effects.predecessorWindows.push(predecessorWindow);
			}
			const rows = await raw.readOutboxPage(...args);
			if (!predecessorWindow.complete && request?.scope === predecessorWindow.scope) {
				predecessorWindow.pages.push({
					afterSequence: Array.isArray(request?.afterKey) ? request.afterKey[2] : null,
					returnedSequences: rows.map((row) => row.commit.authorSequence),
				});
				if (rows.length === 0) predecessorWindow.complete = true;
			}
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

function signedCloneCommit(sourceCommit, authorSequence, selectedAuthority, objectId, logicalTimeOffset = 0) {
	const decoded = decodeCanonical(sourceCommit.envelope.canonicalPreimageBytes);
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new TypeError("D.108e2e source carrier is malformed");
	}
	const canonicalPreimageBytes = encodeCanonical({
		...decoded,
		authorSequence,
		logicalTime: authorSequence + logicalTimeOffset,
	});
	const digest = hashDomain("ts-drp/vertex/v3", canonicalPreimageBytes);
	return carrierCommit(
		Object.freeze({
			author: selectedAuthority.author,
			authorSequence,
			canonicalPreimageBytes,
			digest,
			signature: signBytes(digest, selectedAuthority),
		}),
		objectId
	);
}

function matchingCommit(left, right) {
	return (
		left !== null &&
		right !== null &&
		left.authorSequence === right.authorSequence &&
		left.issuedRecord.scope.author === right.issuedRecord.scope.author &&
		left.issuedRecord.scope.objectId === right.issuedRecord.scope.objectId &&
		sameBytes(left.envelope.canonicalPreimageBytes, right.envelope.canonicalPreimageBytes) &&
		sameBytes(left.envelope.digest, right.envelope.digest) &&
		sameBytes(left.envelope.signature, right.envelope.signature)
	);
}

async function appendCommit(raw, scope, commit) {
	await raw.transactIssue(scope, (selected) => {
		if (selected !== commit.authorSequence) throw new TypeError("D.108e2e seeded lineage diverged");
		return Promise.resolve(commit);
	});
}

function authenticateMaterializedRow(row, expectedSequence, scope, selectedAuthority) {
	const issued = row.issued;
	if (!matchingCommit(row.commit, issued)) throw new TypeError("D.108e2e issued/outbox rows diverged");
	const preimage = decodeCanonical(row.commit.envelope.canonicalPreimageBytes);
	const expectedEpoch = expectedSequence === 0 || expectedSequence === 8_193 ? 0 : 1;
	if (
		preimage === null ||
		typeof preimage !== "object" ||
		Array.isArray(preimage) ||
		preimage.author !== scope.author ||
		preimage.objectId !== scope.objectId ||
		preimage.authorSequence !== expectedSequence ||
		preimage.epoch !== expectedEpoch
	) {
		throw new TypeError("D.108e2e canonical row binding is invalid");
	}
	const digest = hashDomain("ts-drp/vertex/v3", row.commit.envelope.canonicalPreimageBytes);
	if (
		!sameBytes(digest, row.commit.envelope.digest) ||
		!verify(null, Buffer.from(digest), selectedAuthority.publicKey, Buffer.from(row.commit.envelope.signature))
	) {
		throw new TypeError("D.108e2e durable row authentication is invalid");
	}
	const detached = carrierCommit(
		Object.freeze({
			author: scope.author,
			authorSequence: expectedSequence,
			canonicalPreimageBytes: row.commit.envelope.canonicalPreimageBytes,
			digest: row.commit.envelope.digest,
			signature: row.commit.envelope.signature,
		}),
		scope.objectId
	);
	return Object.freeze({ commit: detached, publishState: row.publishState });
}

async function materializeVerifiedClosure(raw, scope, expectedCount, selectedAuthority) {
	const lineage = await raw.readLineage(scope);
	if (lineage.exhausted || lineage.next !== expectedCount) {
		throw new TypeError("D.108e2e real lineage does not match the expected closure");
	}
	const rows = [];
	let afterKey = null;
	while (rows.length < expectedCount) {
		const page = await raw.readOutboxPage({ afterKey, limit: 128, scope });
		if (page.length === 0) throw new TypeError("D.108e2e real outbox ended before the expected closure");
		for (const row of page) {
			const expectedSequence = rows.length;
			if (row.commit.authorSequence !== expectedSequence) {
				throw new TypeError("D.108e2e real outbox sequence is not contiguous");
			}
			const issued = await raw.readIssued(scope, expectedSequence);
			rows.push(authenticateMaterializedRow({ ...row, issued }, expectedSequence, scope, selectedAuthority));
		}
		const last = rows.at(-1);
		if (last === undefined) throw new TypeError("D.108e2e materialized page is empty");
		afterKey = Object.freeze([scope.objectId, scope.author, last.commit.authorSequence]);
	}
	if (rows.length !== expectedCount) throw new TypeError("D.108e2e materialized closure exceeds its bound");
	return Object.freeze(rows);
}

function compareOutboxKey(row, afterKey) {
	const left = [
		row.commit.issuedRecord.scope.objectId,
		row.commit.issuedRecord.scope.author,
		row.commit.authorSequence,
	];
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] < afterKey[index]) return -1;
		if (left[index] > afterKey[index]) return 1;
	}
	return 0;
}

function firstRowAfter(rows, afterKey) {
	if (afterKey === undefined || afterKey === null) return 0;
	let low = 0;
	let high = rows.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (compareOutboxKey(rows[middle], afterKey) <= 0) low = middle + 1;
		else high = middle;
	}
	return low;
}

function sameStoreShape(actual, expected) {
	const actualKeys = Reflect.ownKeys(actual);
	const expectedKeys = Reflect.ownKeys(expected);
	return (
		actualKeys.length === expectedKeys.length &&
		expectedKeys.every((key, index) => key === actualKeys[index]) &&
		expectedKeys.every((key) => {
			const expectedDescriptor = Object.getOwnPropertyDescriptor(expected, key);
			const actualDescriptor = Object.getOwnPropertyDescriptor(actual, key);
			return (
				expectedDescriptor !== undefined &&
				actualDescriptor !== undefined &&
				expectedDescriptor.enumerable === actualDescriptor.enumerable &&
				expectedDescriptor.configurable === actualDescriptor.configurable &&
				"value" in expectedDescriptor === "value" in actualDescriptor
			);
		})
	);
}

function boundedRecoveryStore(raw, rows, expectedScope, mismatchCommit) {
	const issuedBySequence = new Map(rows.map((row) => [row.commit.authorSequence, row.commit]));
	const newTelemetry = () => ({
		capturedIssuedCount: 0,
		capturedIssuedFirst: null,
		capturedIssuedLast: null,
		capturedIssuedStrictlyIncreasing: true,
		capturedIssuedSum: 0,
		capturedScope: undefined,
		copiedIssuedSequences: [],
		firstReturnedSequence: null,
		lastReturnedSequence: null,
		pageCount: 0,
		returnedSequenceCount: 0,
		returnedSequencesStrictlyIncreasing: true,
		successorPageFaultCount: 0,
		terminalEmpty: false,
	});
	let telemetry = newTelemetry();
	let invocationStarted = false;
	const snapshotTelemetry = () =>
		Object.freeze({
			capturedIssuedCount: telemetry.capturedIssuedCount,
			capturedIssuedFirst: telemetry.capturedIssuedFirst,
			capturedIssuedLast: telemetry.capturedIssuedLast,
			capturedIssuedStrictlyIncreasing: telemetry.capturedIssuedStrictlyIncreasing,
			capturedIssuedSum: telemetry.capturedIssuedSum,
			copiedIssuedSequences: Object.freeze([...telemetry.copiedIssuedSequences]),
			firstReturnedSequence: telemetry.firstReturnedSequence,
			lastReturnedSequence: telemetry.lastReturnedSequence,
			pageCount: telemetry.pageCount,
			returnedSequenceCount: telemetry.returnedSequenceCount,
			returnedSequencesStrictlyIncreasing: telemetry.returnedSequencesStrictlyIncreasing,
			successorPageFaultCount: telemetry.successorPageFaultCount,
			terminalEmpty: telemetry.terminalEmpty,
		});
	const store = Object.freeze({
		close: () => raw.close(),
		compareAndMarkOutboxPublished: (...args) => raw.compareAndMarkOutboxPublished(...args),
		readIssued: (scope, authorSequence) => {
			const predecessorOpen = !telemetry.terminalEmpty;
			if (predecessorOpen && scope === telemetry.capturedScope) {
				telemetry.capturedIssuedCount += 1;
				telemetry.capturedIssuedFirst ??= authorSequence;
				telemetry.capturedIssuedStrictlyIncreasing &&=
					telemetry.capturedIssuedLast === null || authorSequence > telemetry.capturedIssuedLast;
				telemetry.capturedIssuedLast = authorSequence;
				telemetry.capturedIssuedSum += authorSequence;
			} else if (predecessorOpen && telemetry.capturedScope !== undefined) {
				telemetry.copiedIssuedSequences.push(authorSequence);
			}
			if (scope === telemetry.capturedScope && authorSequence === 1 && mismatchCommit !== undefined) {
				return Promise.resolve(mismatchCommit);
			}
			if (scope.author !== expectedScope.author || scope.objectId !== expectedScope.objectId)
				return Promise.resolve(null);
			const commit = issuedBySequence.get(authorSequence);
			if (commit === undefined) return Promise.resolve(null);
			return Promise.resolve(commit);
		},
		readLineage: (...args) => raw.readLineage(...args),
		readOutboxPage: (input = {}) => {
			const limit = input.limit ?? 64;
			if (!Number.isInteger(limit) || limit < 1 || limit > 128) {
				throw new TypeError("D.108e2e page facade received an invalid limit");
			}
			const scope = input.scope;
			if (scope !== undefined && (scope.author !== expectedScope.author || scope.objectId !== expectedScope.objectId)) {
				return Promise.resolve([]);
			}
			const first = firstRowAfter(rows, input.afterKey);
			const selected = rows.slice(first, first + limit);
			if (scope === undefined) return Promise.resolve(Object.freeze([...selected]));
			telemetry.capturedScope ??= scope;
			if (scope !== telemetry.capturedScope) {
				telemetry.successorPageFaultCount += 1;
				return Promise.reject(new TypeError("D.108e2e successor-stage issuance sentinel"));
			}
			if (scope === telemetry.capturedScope && !telemetry.terminalEmpty) {
				telemetry.pageCount += 1;
				if (selected.length === 0) telemetry.terminalEmpty = true;
				for (const row of selected) {
					const sequence = row.commit.authorSequence;
					telemetry.firstReturnedSequence ??= sequence;
					telemetry.returnedSequencesStrictlyIncreasing &&=
						telemetry.lastReturnedSequence === null || sequence > telemetry.lastReturnedSequence;
					telemetry.lastReturnedSequence = sequence;
					telemetry.returnedSequenceCount += 1;
				}
			}
			return Promise.resolve(Object.freeze([...selected]));
		},
		transactIssue: (...args) => raw.transactIssue(...args),
	});
	return {
		beginInvocation: () => {
			const preceding = invocationStarted ? snapshotTelemetry() : undefined;
			telemetry = newTelemetry();
			invocationStarted = true;
			return preceding;
		},
		store,
		telemetry: snapshotTelemetry,
	};
}

async function observedMaximumPageLimit(raw, scope) {
	const maximumPage = await raw.readOutboxPage({ limit: 128, scope });
	if (maximumPage.length !== 128) throw new TypeError("D.108e2e real maximum page probe was incomplete");
	let rejectedAboveMaximum = false;
	try {
		await raw.readOutboxPage({ limit: 129, scope });
	} catch {
		rejectedAboveMaximum = true;
	}
	if (!rejectedAboveMaximum) throw new TypeError("D.108e2e real store accepted a page above the maximum");
	return maximumPage.length;
}

function signerFor(material, scenario, selectedAuthority, wrongAuthority, observations, state, effects, durableValues) {
	return async (bytes) => {
		effects.order.push(`${state.use}:signer`);
		if (state.use === "possession") {
			effects.authorityEvents.push({ attempt: effects.authorityAttempt, kind: "possession-signer" });
		}
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
		authorityAttempt: -1,
		authorityEvents: [],
		installEpochAnchorCount: 0,
		issuedMismatchEvidence: undefined,
		issuanceStoreShape: false,
		lineageReads: [],
		order: [],
		predecessorWindows: [],
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
	const reopen = () => {
		effects.authorityAttempt += 1;
		return withCryptoScenario(input.scenario, () =>
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
	};
	const shared = () => ({
		effects: {
			adoptionSwapCount: ahe.adoptionSwapCount(),
			aheRecoverCount: effects.aheRecoverCount,
			authorityEvents: effects.authorityEvents.map((event) => ({ ...event })),
			installEpochAnchorCount: effects.installEpochAnchorCount,
			issuanceStoreShape: effects.issuanceStoreShape,
			lineageReads: [...effects.lineageReads],
			order: [...effects.order],
			predecessorWindows: effects.predecessorWindows.map((window) => ({
				attempt: window.attempt,
				complete: window.complete,
				issuedReads: window.issuedReads.map((read) => ({ ...read })),
				pages: window.pages.map((page) => ({
					afterSequence: page.afterSequence,
					returnedSequences: [...page.returnedSequences],
				})),
			})),
			publicationCount: publications.length,
			snapshotOpenCount: effects.snapshotOpenCount,
			subscribeCount: events.filter((event) => event === "subscribe").length,
			transactIssueCount: effects.transactIssueCount,
		},
		name: input.name,
		...(effects.issuedMismatchEvidence === undefined ? {} : { issuedMismatchEvidence: effects.issuedMismatchEvidence }),
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

function budgetEffects() {
	return {
		aheRecoverCount: 0,
		installEpochAnchorCount: 0,
		snapshotOpenCount: 0,
	};
}

async function openBudgetContext(material, suffix) {
	const effects = budgetEffects();
	const events = [];
	const publications = [];
	const [ahe, liveJournal, snapshot] = await Promise.all([
		seedAhe(material, effects, suffix),
		seedJournal(peerJournalMaterial(material), effects, suffix),
		seedSnapshot(material, events, effects, suffix),
	]);
	return {
		ahe,
		effects,
		events,
		liveJournal,
		node: network(events, publications, `d108e2e-target-${suffix}`),
		publications,
		snapshot,
	};
}

async function closeBudgetContext(context) {
	await Promise.allSettled([context.snapshot.raw.close(), context.liveJournal.raw.close(), context.ahe.raw.close()]);
}

async function reopenBudgetCase(material, suffix, issuanceStore, selectedAuthority, separatorDigest) {
	const context = await openBudgetContext(material, suffix);
	let activeHandle;
	try {
		const result = await reopenCreatorSuccessorAdoption({
			...material.creatorGenesis,
			author: selectedAuthority.author,
			catalog: trustedCatalog(material),
			issuanceStore,
			liveJournalStore: context.liveJournal.store,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: context.node,
			onAdmittedVertex: () => undefined,
			signRegisteredVertexDigest: (bytes) => Promise.resolve(signBytes(bytes, selectedAuthority)),
			snapshotDeclaration: material.snapshot.declaration,
			snapshotStore: context.snapshot.store,
			store: context.ahe.store,
		});
		if (result.ok) activeHandle = result.handle;
		let separatorJournalAppended = false;
		if (separatorDigest !== undefined) {
			const rows = await journalRows(context.liveJournal.raw, {
				anchorDigest: material.oracle.genesisAnchorDigest,
				epoch: 0,
				objectId: material.proposed.head.objectId,
			});
			separatorJournalAppended = rows.some((row) => row.vertexDigest === separatorDigest);
		}
		return Object.freeze({
			effects: Object.freeze({
				adoptionSwapCount: context.ahe.adoptionSwapCount(),
				aheRecoverCount: context.effects.aheRecoverCount,
				installEpochAnchorCount: context.effects.installEpochAnchorCount,
				publicationCount: context.publications.length,
				snapshotOpenCount: context.effects.snapshotOpenCount,
				subscribeCount: context.events.filter((event) => event === "subscribe").length,
			}),
			result: result.ok
				? Object.freeze({ lifecycle: result.lifecycle, ok: true, recovery: result.recovery })
				: Object.freeze({ detail: result.detail, kind: result.kind, ok: false }),
			separatorJournalAppended,
		});
	} finally {
		await Promise.resolve(activeHandle?.deactivate());
		await closeBudgetContext(context);
	}
}

async function issueGenuineFuture(material, raw, selectedAuthority) {
	const context = await openBudgetContext(material, "-d108e2e-prime");
	let activeHandle;
	try {
		const reopened = await reopenCreatorSuccessorAdoption({
			...material.creatorGenesis,
			author: selectedAuthority.author,
			catalog: trustedCatalog(material),
			issuanceStore: raw,
			liveJournalStore: context.liveJournal.store,
			messageQueueManager: new MessageQueueManager({ logConfig: { level: "silent" } }),
			networkNode: context.node,
			onAdmittedVertex: () => undefined,
			signRegisteredVertexDigest: (bytes) => Promise.resolve(signBytes(bytes, selectedAuthority)),
			snapshotDeclaration: material.snapshot.declaration,
			snapshotStore: context.snapshot.store,
			store: context.ahe.store,
		});
		if (!reopened.ok) throw new TypeError(`D.108e2e prime reopen failed: ${reopened.kind}`);
		activeHandle = reopened.handle;
		const issued = await activeHandle.issueLocal({
			operations: [{ logicalTime: 512, operation: { action: "add", value: 512 } }],
			signRegisteredVertexDigest: (bytes) => Promise.resolve(signBytes(bytes, selectedAuthority)),
		});
		if (!issued.ok || issued.authorSequence !== 1) throw new TypeError("D.108e2e genuine future issue failed");
		const commit = await raw.readIssued(
			Object.freeze({ author: selectedAuthority.author, objectId: material.proposed.head.objectId }),
			1
		);
		if (commit === null) throw new TypeError("D.108e2e genuine future commit is unavailable");
		return commit;
	} finally {
		await Promise.resolve(activeHandle?.deactivate());
		await closeBudgetContext(context);
	}
}

async function skipBudgetProof(material) {
	const startedAt = performance.now();
	if (material.establishedPeer === undefined) throw new TypeError("D.108e2e established Bob carrier is unavailable");
	const parameters = decodeCanonical(material.creatorGenesis.exactCanonicalParametersCarrierBytes);
	if (
		parameters === null ||
		typeof parameters !== "object" ||
		Array.isArray(parameters) ||
		parameters.maxEpochVertices !== 8_192
	) {
		throw new TypeError("D.108e2e authenticated maxEpochVertices is not 8192");
	}
	const bob = authority("bob");
	if (material.establishedPeer.author !== bob.author) throw new TypeError("D.108e2e established carrier is not Bob's");
	const objectId = material.proposed.head.objectId;
	const scope = Object.freeze({ author: bob.author, objectId });
	const raw = createNodeDurableIssuanceStore({
		primaryFilename: join(material.directory, "issuance-local-author-d108e2e.sqlite"),
	});
	const mismatchRaw = createNodeDurableIssuanceStore({
		primaryFilename: join(material.directory, "issuance-local-author-d108e2e-mismatch.sqlite"),
	});
	try {
		const currentZero = carrierCommit(material.establishedPeer, objectId);
		await appendCommit(raw, scope, currentZero);
		const genuineFuture = await issueGenuineFuture(material, raw, bob);
		for (let authorSequence = 2; authorSequence <= 8_192; authorSequence += 1) {
			await appendCommit(raw, scope, signedCloneCommit(genuineFuture, authorSequence, bob, objectId, 1_000));
		}

		const maximumPageLimit = await observedMaximumPageLimit(raw, scope);
		const equalityRows = await materializeVerifiedClosure(raw, scope, 8_193, bob);
		const equalityBounded = boundedRecoveryStore(raw, equalityRows, scope);
		const boundedStoreShape = sameStoreShape(equalityBounded.store, raw);
		const reuseRows = Object.freeze(equalityRows.slice(0, 8_191));
		const reuseBounded = boundedRecoveryStore(raw, reuseRows, scope);
		const reuseFacade = reuseBounded.store;
		const passedFacades = [];

		const separator = signedCloneCommit(currentZero, 8_193, bob, objectId, 20_000);
		const finalFuture = signedCloneCommit(genuineFuture, 8_194, bob, objectId, 1_000);
		await appendCommit(raw, scope, separator);
		await appendCommit(raw, scope, finalFuture);
		const overBudgetLineage = await raw.readLineage(scope);
		if (overBudgetLineage.exhausted || overBudgetLineage.next !== 8_195) {
			throw new TypeError("D.108e2e real over-budget lineage does not match the expected closure");
		}
		const overBudgetSuffix = await raw.readOutboxPage({
			afterKey: Object.freeze([scope.objectId, scope.author, 8_192]),
			limit: 2,
			scope,
		});
		if (overBudgetSuffix.length !== 2) throw new TypeError("D.108e2e real over-budget suffix is incomplete");
		const authenticatedOverBudgetSuffix = [];
		for (const [offset, row] of overBudgetSuffix.entries()) {
			const expectedSequence = 8_193 + offset;
			if (row.commit.authorSequence !== expectedSequence) {
				throw new TypeError("D.108e2e real over-budget suffix is not contiguous");
			}
			const issued = await raw.readIssued(scope, expectedSequence);
			authenticatedOverBudgetSuffix.push(authenticateMaterializedRow({ ...row, issued }, expectedSequence, scope, bob));
		}
		const overBudgetRows = Object.freeze([...equalityRows, ...authenticatedOverBudgetSuffix]);
		const overBudgetBounded = boundedRecoveryStore(raw, overBudgetRows, scope);

		await appendCommit(mismatchRaw, scope, currentZero);
		await appendCommit(mismatchRaw, scope, genuineFuture);
		const mismatchRows = await materializeVerifiedClosure(mismatchRaw, scope, 2, bob);
		const mismatchCommit = signedCloneCommit(genuineFuture, 1, bob, objectId, 1_000_000);
		const mismatchBounded = boundedRecoveryStore(mismatchRaw, mismatchRows, scope, mismatchCommit);
		const equalityPromise = reopenBudgetCase(material, "-d108e2e-equality", equalityBounded.store, bob);
		const reusePromise = (async () => {
			const windows = [];
			for (let invocation = 0; invocation < 2; invocation += 1) {
				reuseBounded.beginInvocation();
				passedFacades.push(reuseFacade);
				const reopened = await reopenBudgetCase(material, `-d108e4-reuse-${invocation}`, reuseFacade, bob);
				const window = reuseBounded.telemetry();
				windows.push(
					Object.freeze({
						capturedIssuedCount: window.capturedIssuedCount,
						installEpochAnchorCount: reopened.effects.installEpochAnchorCount,
						result: reopened.result,
						successorPageFaultCount: window.successorPageFaultCount,
						terminalEmpty: window.terminalEmpty,
					})
				);
			}
			return windows;
		})();
		const overBudgetPromise = reopenBudgetCase(
			material,
			"-d108e2e-over-budget",
			overBudgetBounded.store,
			bob,
			Buffer.from(separator.envelope.digest).toString("hex")
		);
		const mismatchPromise = reopenBudgetCase(material, "-d108e2e-mismatch", mismatchBounded.store, bob);
		const [equality, reuseWindows, overBudget, mismatch] = await Promise.all([
			equalityPromise,
			reusePromise,
			overBudgetPromise,
			mismatchPromise,
		]);

		return Object.freeze({
			equality: Object.freeze({ ...equality, telemetry: equalityBounded.telemetry() }),
			maxCanonicalPreimageBytes: Math.max(
				...overBudgetRows.map((row) => row.commit.envelope.canonicalPreimageBytes.byteLength)
			),
			maxEpochVertices: parameters.maxEpochVertices,
			mismatch: Object.freeze({ ...mismatch, telemetry: mismatchBounded.telemetry() }),
			overBudget: Object.freeze({ ...overBudget, telemetry: overBudgetBounded.telemetry() }),
			pid: process.pid,
			realStore: Object.freeze({
				boundedStoreShape,
				equalityMaterializedRows: equalityRows.length,
				maximumPageLimit,
				overBudgetMaterializedRows: overBudgetRows.length,
			}),
			reuse: Object.freeze({
				allowance: parameters.maxEpochVertices,
				facadeObjectIsIdentical: passedFacades.every((candidate) => Object.is(candidate, reuseFacade)),
				materializedRows: reuseRows.length,
				windows: Object.freeze(reuseWindows),
			}),
			wallTimeMs: performance.now() - startedAt,
		});
	} finally {
		await Promise.allSettled([raw.close(), mismatchRaw.close()]);
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
			carriers: [bobCarrier],
			currentOutboxFault: "read-issued-throw",
			name: "current-outbox-read-failure",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			currentOutboxFault: "issued-mismatch",
			name: "current-outbox-issued-mismatch",
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
		{
			authority: bob,
			carriers: [bobCarrier],
			lineageFault: "negative-next",
			name: "negative-lineage-next",
			scenario: "valid",
			wrongAuthority: carol,
		},
		{
			authority: bob,
			carriers: [bobCarrier],
			lineageFault: "unsafe-next",
			name: "unsafe-lineage-next",
			scenario: "valid",
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
	.then((input) => (input?.mode === "skip-budget" ? skipBudgetProof(input.material) : matrix(input)))
	.then((proof) => send({ kind: "proof", proof }))
	.catch((error) => {
		send({ kind: "child-error", message: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	});
