/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from "node:fs/promises";

import { encodeCanonical } from "../../../canonical/dist/src/index.js";
import { assertTrustPreserved, createCurrentAnchorTrustStore } from "../../../control-plane/dist/src/index.js";
import { authenticateCurrentEpochAnchor, installCreatorAnchorTrustRoot } from "../../../protocol-v3/dist/src/public.js";
import { digestBlob, parseGenerationId, parseStorageObjectId } from "../../../storage/dist/src/index.js";
import { createSqliteAheDurableStore } from "../../dist/src/index.js";
import { createInstrumentedSqliteAheDurableStore } from "../../dist/src/test-instrumentation.js";

const [, , filename, scenario, mode, materialFilename, encodedTarget] = process.argv;
const material = JSON.parse(await readFile(materialFilename, "utf8"));
const target = encodedTarget === undefined ? undefined : JSON.parse(encodedTarget);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const expandedCrashInstrumentation = Object.freeze({ crashCheckpoints: "expanded" });

const CREATOR_INITIAL_GENERATION_ID = "1".repeat(64);
const CREATOR_RETRY_GENERATION_ID = "2".repeat(64);
const COMBINED_GENERATION_ID = must(parseGenerationId("3".repeat(64)));
const COMBINED_RETRY_GENERATION_ID = must(parseGenerationId("4".repeat(64)));
const OBJECT_ID = must(parseStorageObjectId(material.objectId));

function must(result) {
	if (!result.ok) throw new Error(`fixture value rejected: ${result.reason}`);
	return result.value;
}

function bytes(hex) {
	return Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function hex(value) {
	return Buffer.from(value).toString("hex");
}

function installInput() {
	return {
		detachedGenesisSignature: bytes(material.signatureHex),
		exactCanonicalGenesisAnchorPreimageBytes: bytes(material.anchorBytesHex),
		exactCanonicalProfileBytes: bytes(material.profileBytesHex),
		exactCanonicalSignerSetBytes: bytes(material.signerSetBytesHex),
		pinnedGenesisAnchorDigest: material.anchorDigest,
	};
}

function send(message) {
	if (typeof process.send === "function") process.send(message);
}

function checkpointMatches(actual, expected) {
	return (
		expected !== undefined &&
		Object.entries(expected).every(
			([key, value]) => Object.prototype.hasOwnProperty.call(actual, key) && actual[key] === value
		)
	);
}

function pinGenerationId(hexId) {
	const byte = Number.parseInt(hexId.slice(0, 2), 16);
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: Object.freeze({
			getRandomValues(view) {
				view.fill(byte);
				return view;
			},
		}),
	});
}

function refFor(value) {
	return Object.freeze({ byteLength: value.byteLength, digest: must(digestBlob(value)) });
}

function sortedRefs(candidates) {
	return candidates
		.map(({ ref }) => Object.freeze({ ...ref }))
		.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0));
}

function creatorInstall(store, generationId) {
	pinGenerationId(generationId);
	const durable = createCurrentAnchorTrustStore({
		objectId: OBJECT_ID,
		pinnedGenesisAnchorDigest: material.anchorDigest,
		store,
	});
	return durable.install(installInput());
}

async function installInitialCreator(filename_) {
	const store = createSqliteAheDurableStore({ filename: filename_ });
	const result = await creatorInstall(store, CREATOR_INITIAL_GENERATION_ID);
	if (!result.ok) throw new Error(`initial creator install failed: ${result.reason}`);
	await store.close();
	return result;
}

async function openExistingCreator(filename_) {
	const store = createSqliteAheDurableStore({ filename: filename_ });
	const durable = createCurrentAnchorTrustStore({
		objectId: OBJECT_ID,
		pinnedGenesisAnchorDigest: material.anchorDigest,
		store,
	});
	const result = await durable.open();
	await store.close();
	if (!result.ok) throw new Error(`existing creator open failed: ${result.reason}`);
	return result;
}

function combinedCandidates() {
	const installed = installCreatorAnchorTrustRoot(installInput());
	if (!installed.ok) throw new Error(`trust record construction failed: ${installed.reason}`);
	const trustBytes = new Uint8Array(installed.exactCanonicalTrustStateRecordBytes);
	const stateBytes = encodeCanonical({ kind: "phase-3a0-c-simulated-state", value: 1 });
	return [
		Object.freeze({ bytes: trustBytes, ref: refFor(trustBytes) }),
		Object.freeze({ bytes: stateBytes, ref: refFor(stateBytes) }),
	];
}

async function prepareCombined(store, generationId, expectedHead) {
	const candidates = combinedCandidates();
	const closure = sortedRefs(candidates);
	const trustRef = candidates[0].ref;
	const preserved = assertTrustPreserved({ candidates, closure, expectedTrustRef: trustRef });
	if (!preserved.ok) throw new Error(`trust preservation failed: ${preserved.reason}`);
	const begun = await store.beginGeneration({
		baseExpectedHead: expectedHead,
		closure,
		generationId,
		objectId: OBJECT_ID,
	});
	if (!begun.ok) throw new Error(`combined begin failed: ${begun.reason}`);
	for (const candidate of candidates) {
		const cached = await store.putCachedBlob({
			bytes: candidate.bytes,
			digest: candidate.ref.digest,
			generationId,
			objectId: OBJECT_ID,
		});
		if (!cached.ok) throw new Error(`combined cache failed: ${cached.reason}`);
		const promoted = await store.promoteReference({
			digest: candidate.ref.digest,
			generationId,
			objectId: OBJECT_ID,
		});
		if (!promoted.ok) throw new Error(`combined promote failed: ${promoted.reason}`);
	}
	const completed = await store.completeGeneration({ generationId, objectId: OBJECT_ID });
	if (!completed.ok) throw new Error(`combined complete failed: ${completed.reason}`);
	return { closure, trustRef };
}

function summarizeHead(head) {
	return Object.freeze({ ...head });
}

async function authoritativeState(filename_) {
	const store = createSqliteAheDurableStore({ filename: filename_ });
	if (store.capabilities.durability !== "strict") throw new Error("fixture backend is not strict durable");
	const read = await store.readHead(OBJECT_ID);
	if (!read.ok) throw new Error(`head read failed: ${read.reason}`);
	const recovery = await store.recoverActiveGeneration(OBJECT_ID);
	if (!recovery.ok) throw new Error(`recovery failed: ${recovery.reason}`);
	const blobs = [];
	for (const ref of recovery.value.references) {
		const loaded = await store.getBlob(ref.digest);
		if (!loaded.ok || loaded.value === null) throw new Error("active closure blob missing");
		blobs.push({ bytesHex: hex(loaded.value), ref: { ...ref } });
	}
	const durable = createCurrentAnchorTrustStore({
		objectId: OBJECT_ID,
		pinnedGenesisAnchorDigest: material.anchorDigest,
		store,
	});
	const opened = await durable.open();
	const openSummary = opened.ok
		? {
				head: summarizeHead(opened.head),
				ok: true,
				trustRef: { ...opened.trustRef },
			}
		: { ...opened };
	const authentication = opened.ok
		? authenticateCurrentEpochAnchor({
				detachedSignature: bytes(material.signatureHex),
				exactCanonicalAnchorPreimageBytes: bytes(material.anchorBytesHex),
				trust: opened.trust,
			})
		: null;
	if (read.value.kind === "none") {
		if (opened.ok || opened.reason !== "not-installed" || authentication !== null) {
			throw new Error("absent authority did not fail closed as not-installed");
		}
	} else {
		if (!opened.ok) throw new Error(`durable authority reopen failed: ${opened.reason}`);
		if (!authentication?.ok) {
			throw new Error(`recovered authority authentication failed: ${authentication?.reason ?? "missing"}`);
		}
		if (JSON.stringify(authentication.provenance) !== JSON.stringify(material.expectedAuthority)) {
			throw new Error("recovered authority provenance mismatch");
		}
		if (
			opened.head.objectId !== material.expectedAuthority.objectId ||
			opened.head.objectId !== read.value.objectId ||
			opened.head.revision !== read.value.revision ||
			opened.head.generationId !== read.value.generationId ||
			opened.head.closureDigest !== read.value.closureDigest ||
			authentication.provenance.anchorDigest !== material.anchorDigest
		) {
			throw new Error("recovered authority head, object, or genesis pin mismatch");
		}
	}
	const summary = {
		authentication,
		authorityContext: {
			expectedObjectId: material.expectedAuthority.objectId,
			pinnedGenesisAnchorDigest: material.anchorDigest,
		},
		blobs,
		head: summarizeHead(read.value),
		open: openSummary,
		recovery:
			recovery.value.kind === "empty"
				? { head: summarizeHead(recovery.value.head), kind: "empty", references: [] }
				: {
						head: summarizeHead(recovery.value.head),
						kind: "active",
						recomputedClosureDigest: recovery.value.recomputedClosureDigest,
						references: recovery.value.references.map((ref) => ({ ...ref })),
					},
		strictDurability: true,
	};
	await store.close();
	return summary;
}

function instrumentedStore(filename_) {
	return createInstrumentedSqliteAheDurableStore(
		{ filename: filename_ },
		(checkpoint) => {
			send({ checkpoint, kind: "checkpoint" });
			if (mode === "crash" && checkpointMatches(checkpoint, target)) Atomics.wait(waitBuffer, 0, 0);
		},
		expandedCrashInstrumentation
	).store;
}

async function runCreator() {
	if (mode === "old") {
		const store = createSqliteAheDurableStore({ filename });
		await store.close();
		return;
	}
	if (mode === "new-initial") {
		await installInitialCreator(filename);
		return;
	}
	if (mode === "new-retry") {
		const store = createSqliteAheDurableStore({ filename });
		const result = await creatorInstall(store, CREATOR_RETRY_GENERATION_ID);
		if (!result.ok) throw new Error(`retry control failed: ${result.reason}`);
		await store.close();
		return;
	}
	const store = mode === "crash" ? instrumentedStore(filename) : createSqliteAheDurableStore({ filename });
	const result = await creatorInstall(
		store,
		mode === "retry" ? CREATOR_RETRY_GENERATION_ID : CREATOR_INITIAL_GENERATION_ID
	);
	send({ kind: "result", result: result.ok ? { head: result.head, ok: true } : result });
	await store.close();
}

async function runCombined() {
	const initial = mode === "retry" ? await openExistingCreator(filename) : await installInitialCreator(filename);
	if (mode === "retry" && initial.head.revision === 2) {
		send({ kind: "result", result: { ok: false, reason: "already-new" } });
		return;
	}
	if (initial.head.revision !== 1) throw new Error("unexpected combined base");
	const store = mode === "crash" ? instrumentedStore(filename) : createSqliteAheDurableStore({ filename });
	const generationId = mode === "new-retry" || mode === "retry" ? COMBINED_RETRY_GENERATION_ID : COMBINED_GENERATION_ID;
	await prepareCombined(store, generationId, initial.head);
	if (mode === "old") {
		await store.close();
		return;
	}
	const result = await store.swapHead({ expectedHead: initial.head, generationId, objectId: OBJECT_ID });
	send({ kind: "result", result });
	await store.close();
}

try {
	if (mode === "inspect") {
		send({ kind: "state", state: await authoritativeState(filename) });
	} else {
		if (scenario === "creator") await runCreator();
		else if (scenario === "combined") await runCombined();
		else throw new Error(`unknown scenario: ${scenario}`);
		if (mode !== "crash") send({ kind: "state", state: await authoritativeState(filename) });
	}
} catch (error) {
	send({ kind: "fixture-error", message: error instanceof Error ? error.stack : String(error) });
	process.exitCode = 1;
}
