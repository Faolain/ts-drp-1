import { readFileSync } from "node:fs";
import ts from "typescript";
import { compareBytes, decodeCanonical, encodeCanonical, hashDomain } from "@ts-drp/canonical";
import { openCanonicalLatchedAclSnapshot } from "@ts-drp/protocol-v3/latched-acl";
import { AHE_BOUNDED_READ_LIMITS } from "@ts-drp/storage";
import { describe, expect, it } from "vitest";
import type { createCreatorCanonicalSyntaxReader, validateCreatorSnapshotData } from "../src/internal/creator-snapshot-data.js";

// Execute the actual existing syntax owner and complete snapshot predicate.
// Native custody, fresh storage reads and signatures remain the integration
// owner's native-test obligation; this is not a substitute for those checks.
const path = new URL("../src/internal/creator-snapshot-data.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const registry = JSON.parse(readFileSync(new URL("../../protocol-v3/registry/registry-v1.json", import.meta.url), "utf8"));
const declarations = ["canonicalCreatorDataRecord", "createCreatorCanonicalSyntaxReader", "creatorDataDigest",
	"validateCreatorSnapshotData", "validateCreatorSnapshotRecords"].map(name => {
	const matches = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
	if (matches.length !== 1) throw Error(`SNAPSHOT_OWNER_NOT_UNIQUE:${name}`);
	return matches[0]!.getText(source).replace(/^export /u, "");
}).join("\n");
const digest = (domain: string, bytes: Uint8Array) => Buffer.from(hashDomain(domain, bytes)).toString("hex");
function fixture(bounds: Readonly<{ maxObjectGenerations: number; maxClosureReferences: number; maxUnionBytes: number }> = AHE_BOUNDED_READ_LIMITS) {
	const counts = { decodes: new Map<string, number>(), encodes: 0, acl: 0 };
	const key = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
	const context = { compareBytes, hashDomain, registry, AHE_BOUNDED_READ_LIMITS: bounds,
		decodeCanonical: (bytes: Uint8Array) => { const k = key(bytes); counts.decodes.set(k, (counts.decodes.get(k) ?? 0) + 1); return decodeCanonical(bytes); },
		encodeCanonical: (value: unknown) => { counts.encodes++; return encodeCanonical(value as Parameters<typeof encodeCanonical>[0]); },
		openCanonicalLatchedAclSnapshot: (input: Parameters<typeof openCanonicalLatchedAclSnapshot>[0]) => { counts.acl++; return openCanonicalLatchedAclSnapshot(input); } };
	const js = ts.transpileModule(`${declarations}\n({reader:createCreatorCanonicalSyntaxReader, fresh:validateCreatorSnapshotData});`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
	const api = Function(...Object.keys(context), `"use strict";return eval(${JSON.stringify(js)});`)(...Object.values(context)) as {
		reader: typeof createCreatorCanonicalSyntaxReader; fresh: typeof validateCreatorSnapshotData };
	const acl = { kind: "drp-v3-latched-acl", version: 3, epoch: 3, objectId: "room", permissionless: false,
		members: [{ author: "a".repeat(64), finalityKey: "b".repeat(64), groups: ["admin", "finality", "writer"] }] };
	const application = { position: [10, 20], name: "game\ufeffname", data: new Uint8Array([1, 2, 3]) };
	const payload = { kind: "drp-snapshot-payload", protocolMajor: 3, schemaVersion: 1, objectId: "room", epoch: 2,
		anchor: "c".repeat(64), blueprintDigest: "d".repeat(64), archiveIndexRoot: "e".repeat(64), application, acl };
	const payloadBytes = encodeCanonical(payload);
	const manifest = { schemaVersion: 1, objectId: "room", epoch: 2, anchor: payload.anchor, totalBytes: payloadBytes.byteLength,
		payloadDigest: digest("ts-drp/snapshot-payload/v3", payloadBytes), stateDigest: digest("ts-drp/state/v3", encodeCanonical(application)),
		aclDigest: digest("ts-drp/latched-acl/v3", encodeCanonical(acl)) };
	const manifestBytes = encodeCanonical(manifest);
	const cut = { objectId: "room", epoch: 2, previousAnchor: payload.anchor, archiveIndexRoot: payload.archiveIndexRoot,
		blueprintDigest: payload.blueprintDigest, stateDigest: manifest.stateDigest, aclDigest: manifest.aclDigest };
	return { api, counts, key, payload, manifest, payloadBytes, manifestBytes, cut, profile: "creator-trusted-settlement-v1" };
}

describe("same-owner canonical snapshot syntax", () => {
	it("returns isolated one-field and scalar metadata projections and clears all retained parsing on release", () => {
		const f = fixture(), reader = f.api.reader();
		const bytes = encodeCanonical({kind: "drp-anchor-trust-state", objectId: "room", currentEpoch: 3,
			profileId: f.profile, exactCanonicalCurrentAnchorPreimageBytes: f.payloadBytes, application: f.payload.application});
		const first = reader.metadata(bytes, true)!.exactCanonicalCurrentAnchorPreimageBytes as Uint8Array;
		first.fill(255);
		expect(reader.metadata(bytes.slice(), true)!.exactCanonicalCurrentAnchorPreimageBytes).toEqual(f.payloadBytes);
		expect(reader.metadata(bytes)).toMatchObject({kind: "drp-anchor-trust-state", objectId: "room", currentEpoch: 3, profileId: f.profile});
		expect(reader.metadata(bytes)).not.toHaveProperty("application");
		expect(f.counts.decodes.get(f.key(bytes))).toBe(1);
		reader.release(); reader.metadata(bytes); reader.metadata(bytes);
		expect(f.counts.decodes.get(f.key(bytes))).toBe(3);
		const malformed = Uint8Array.of(255);
		expect(reader.metadata(malformed)).toBeUndefined();
		const fresh = f.api.reader(); fresh.metadata(bytes);
		expect(f.counts.decodes.get(f.key(bytes))).toBe(4);
		// A borrowed carrier can reenter release through the byte-comparison
		// surface. The admitted read must not repopulate the cleared inventory.
		const reentrant = f.api.reader(), carrier = bytes.slice(); reentrant.metadata(carrier);
		const count = f.counts.decodes.get(f.key(bytes))!;
		Object.defineProperty(carrier, "byteLength", {get: () => {reentrant.release(); return bytes.byteLength;}});
		expect(reentrant.metadata(carrier)).toMatchObject({objectId: "room"});
		expect(reentrant.metadata(carrier)).toMatchObject({objectId: "room"});
		expect(f.counts.decodes.get(f.key(bytes))).toBe(count + 2);
	});
	it("parses each distinct payload/manifest once while preserving all fresh content and ACL bindings", () => {
		const f = fixture(), reader = f.api.reader();
		const expected = f.api.fresh(f.payloadBytes, f.manifestBytes, f.cut, f.profile);
		expect(expected).toBeDefined();
		f.counts.decodes.clear(); f.counts.acl = 0;
		for (let index = 0; index < 5; index++) {
			// Fresh detached native-like arrays are exact bytes, not new evidence.
			expect(reader.snapshot(f.payloadBytes.slice(), f.manifestBytes.slice(), f.cut, f.profile)).toEqual(expected);
		}
		expect(f.counts.decodes.get(f.key(f.payloadBytes))).toBe(1);
		expect(f.counts.decodes.get(f.key(f.manifestBytes))).toBe(1);
		expect(f.counts.acl).toBe(5); // The syntax fact is never reused ACL authority.
		for (let index = 0; index < 3; index++) expect(f.api.fresh(f.payloadBytes, f.manifestBytes, f.cut, f.profile)).toEqual(expected);
		expect(f.counts.decodes.get(f.key(f.payloadBytes))).toBe(4);
		expect(f.counts.decodes.get(f.key(f.manifestBytes))).toBe(4);
	});

	it("reuses the existing record inventory, not a second snapshot cache", () => {
		const f = fixture(), reader = f.api.reader();
		expect(reader.record(f.payloadBytes)).toBeDefined();
		expect(reader.record(f.manifestBytes)).toBeDefined();
		expect(reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)).toBeDefined();
		expect(f.counts.decodes.get(f.key(f.payloadBytes))).toBe(1);
		expect(f.counts.decodes.get(f.key(f.manifestBytes))).toBe(1);
	});

	it("returns detached mutable trees and byte arrays without corrupting retained facts", () => {
		const f = fixture(), reader = f.api.reader();
		const first = reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)!;
		(first.payload.application as any).position[0] = 900;
		(first.payload.application as any).data[0] = 200;
		(first.payload.acl as any).members[0].groups.length = 0;
		(first.manifest as any).stateDigest = "wrong";
		first.successorAclBytes.fill(0);
		const next = reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)!;
		expect(next.payload).toEqual(f.payload);
		expect(next.manifest).toEqual(f.manifest);
		expect(decodeCanonical(next.successorAclBytes)).toEqual(f.payload.acl);
		expect((next.payload.application as any).name).toBe("game\ufeffname");
	});

	it("refuses every changed source/cut/commitment or profile despite a warm syntax fact", () => {
		const f = fixture(), reader = f.api.reader();
		expect(reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)).toBeDefined();
		for (const field of ["objectId", "epoch", "previousAnchor", "archiveIndexRoot", "blueprintDigest", "stateDigest", "aclDigest"] as const) {
			const changed = { ...f.cut, [field]: field === "epoch" ? 7 : "foreign" };
			expect(reader.snapshot(f.payloadBytes, f.manifestBytes, changed, f.profile)).toBeUndefined();
			expect(f.api.fresh(f.payloadBytes, f.manifestBytes, changed, f.profile)).toBeUndefined();
		}
		expect(reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, "creator-trusted-v1")).toBeUndefined();
		const changedState = encodeCanonical({ ...f.payload, application: { position: [11, 20] } });
		expect(reader.snapshot(changedState, f.manifestBytes, f.cut, f.profile)).toBeUndefined();
		const changedManifest = encodeCanonical({ ...f.manifest, payloadDigest: "0".repeat(64) });
		expect(reader.snapshot(f.payloadBytes, changedManifest, f.cut, f.profile)).toBeUndefined();
	});

	it("detects mutation of a previously captured input and keeps malformed/new owner boundaries fresh", () => {
		const f = fixture(), reader = f.api.reader(), bytes = f.payloadBytes.slice();
		expect(reader.snapshot(bytes, f.manifestBytes, f.cut, f.profile)).toBeDefined();
		bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
		expect(reader.snapshot(bytes, f.manifestBytes, f.cut, f.profile)).toBeUndefined();
		expect(reader.snapshot(Uint8Array.of(255), f.manifestBytes, f.cut, f.profile)).toBeUndefined();
		expect(reader.snapshot(f.payloadBytes, Uint8Array.of(255), f.cut, f.profile)).toBeUndefined();
		// Preserve the codec's existing initial-BOM stripping: a whole-record
		// canonical roundtrip rejects this, even though decode alone can read it.
		const bom = encodeCanonical({ ...f.payload, application: { name: "\ufeffgame" } });
		expect(reader.record(bom)).toBeUndefined();
		expect(reader.snapshot(bom, f.manifestBytes, f.cut, f.profile)).toBeUndefined();
		expect(f.api.fresh(bom, f.manifestBytes, f.cut, f.profile)).toBeUndefined();
		const before = f.counts.decodes.get(f.key(f.payloadBytes))!;
		expect(f.api.reader().snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)).toBeDefined();
		expect(f.counts.decodes.get(f.key(f.payloadBytes))).toBe(before + 1);
	});

	it("retains the original bounded inventory and parses evicted/oversize syntax freshly without changing validity", () => {
		const f = fixture({ ...AHE_BOUNDED_READ_LIMITS, maxObjectGenerations: 1, maxClosureReferences: 2 });
		const reader = f.api.reader();
		expect(reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)).toBeDefined();
		reader.record(encodeCanonical({ kind: "unrelated-a" }));
		reader.record(encodeCanonical({ kind: "unrelated-b" }));
		expect(reader.snapshot(f.payloadBytes, f.manifestBytes, f.cut, f.profile)).toBeDefined();
		expect(f.counts.decodes.get(f.key(f.payloadBytes))).toBe(2);
		const tiny = fixture({ ...AHE_BOUNDED_READ_LIMITS, maxUnionBytes: 1 }), unretained = tiny.api.reader();
		expect(unretained.snapshot(tiny.payloadBytes, tiny.manifestBytes, tiny.cut, tiny.profile)).toBeDefined();
		expect(unretained.snapshot(tiny.payloadBytes, tiny.manifestBytes, tiny.cut, tiny.profile)).toBeDefined();
		expect(tiny.counts.decodes.get(tiny.key(tiny.payloadBytes))).toBe(2);
	});
});
