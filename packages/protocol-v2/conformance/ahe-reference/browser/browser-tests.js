import { encodeCanonical } from "../src/canonical.js";
import { openEpochDatabase } from "../src/indexeddb-store.js";
import { createAnchorFromCut, DEFAULT_PROTOCOL_PARAMETERS } from "../src/protocol.js";
import { buildSnapshotChunks, snapshotManifest } from "../src/snapshot.js";

const H = (value) => Number(value).toString(16).padStart(64, "0");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion blocked"));
  });
}

async function workerResponsiveness() {
  const gaps = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 5);
  const worker = new Worker("./worker.js", { type: "module" });
  const result = await new Promise((resolve, reject) => {
    worker.onmessage = (event) => (event.data.ok ? resolve(event.data) : reject(new Error(event.data.error)));
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage({ run: true });
  });
  worker.terminate();
  clearInterval(timer);
  return {
    ...result,
    heartbeatSamples: gaps.length,
    maxMainThreadHeartbeatGapMs: gaps.length ? Math.max(...gaps) : 0,
    medianMainThreadHeartbeatGapMs: gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0,
  };
}

async function indexedDBAtomicity() {
  const name = `ts-drp-ahe-browser-${crypto.randomUUID()}`;
  const store = await openEpochDatabase({ name });
  try {
    const baseVote = {
      kind: "drp-seal-vote",
      objectId: "browser-room",
      epoch: 4,
      round: 0,
      phase: "prepare",
      proposalDigest: H(101),
      proposalHash: H(201),
      signerId: "peer-a",
      signature: "sig-a",
    };
    const conflicting = { ...baseVote, proposalDigest: H(102), proposalHash: H(202), signature: "sig-b" };
    const race = await Promise.allSettled([store.putIfAbsentVote(baseVote), store.putIfAbsentVote(conflicting)]);
    const fulfilled = race.filter((entry) => entry.status === "fulfilled").length;
    const rejected = race.filter((entry) => entry.status === "rejected").length;
    assert(fulfilled === 1 && rejected === 1, `vote CAS race did not serialize: ${fulfilled}/${rejected}`);

    const payload = encodeCanonical({ application: { count: 7 }, acl: { writers: new Set(["peer-a"]) } });
    const chunks = await buildSnapshotChunks(payload, { chunkSize: 16 * 1024 });
    const manifest = await snapshotManifest({
      objectId: "browser-room",
      epoch: 4,
      anchor: H(3),
      stateDigest: H(5),
      aclDigest: H(6),
      chunks,
    });
    const descriptor = {
      objectId: "browser-room",
      epoch: 4,
      round: 0,
      previousAnchor: H(3),
      previousCutDigest: H(2),
      previousHistoryRoot: H(1),
      previousHistorySize: 122,
      closeSetRoot: H(8),
      closeSetCount: 1,
      historyRoot: H(7),
      historySize: 123,
      stateDigest: H(5),
      aclDigest: H(6),
      snapshotManifestDigest: manifest.digest,
      nextSignerSet: [],
      parameters: DEFAULT_PROTOCOL_PARAMETERS,
      closeReason: "browser-validation",
    };
    const anchor = await createAnchorFromCut(descriptor);
    await store.stageSnapshot({
      objectId: "browser-room",
      manifest,
      chunks: new Map(chunks.map((chunk) => [chunk.digest, chunk.bytes])),
    });
    assert((await store.recover("browser-room")).status === "staged-not-adopted", "journal stage not recoverable");
    await store.commitEpoch({
      objectId: "browser-room",
      descriptor,
      anchor,
      manifestDigest: manifest.digest,
    });
    const metadata = await store.getMetadata("browser-room");
    const recovery = await store.recover("browser-room");
    assert(metadata.epoch === 5 && metadata.anchor === anchor.hash, "atomic metadata pointer not committed");
    assert(recovery.status === "clean", "journal not cleared after commit");
    return { voteRace: { fulfilled, rejected }, metadata, recoveryStatus: recovery.status };
  } finally {
    store.close();
    await deleteDatabase(name);
  }
}

async function run() {
  const started = performance.now();
  const tests = [];
  try {
    assert(globalThis.crypto?.subtle, "WebCrypto unavailable");
    assert(globalThis.indexedDB, "IndexedDB unavailable");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("browser"));
    tests.push({ name: "webcrypto", pass: new Uint8Array(digest).byteLength === 32 });

    const worker = await workerResponsiveness();
    tests.push({ name: "worker-compute-and-responsiveness", pass: worker.ok, details: worker });

    const storage = await indexedDBAtomicity();
    tests.push({ name: "indexeddb-vote-cas-and-epoch-commit", pass: true, details: storage });

    const result = {
      verdict: tests.every((test) => test.pass) ? "pass" : "fail",
      userAgent: navigator.userAgent,
      tests,
      elapsedMs: performance.now() - started,
    };
    window.__AHE_RESULTS__ = result;
    document.body.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    window.__AHE_RESULTS__ = { verdict: "fail", error: error?.stack ?? String(error), tests, elapsedMs: performance.now() - started };
    document.body.textContent = JSON.stringify(window.__AHE_RESULTS__, null, 2);
  }
}

run();
