import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { base64url } from "multiformats/bases/base64";
import { sha256 } from "multiformats/hashes/sha2";

import {
	createOpaqueNamespaceV1,
	type RecordRejectionCode,
	RecordSigner,
	type RecordValidationResult,
	RecordValidator,
	type SignedDrpRecordV1,
} from "./index.js";

export const RECORD_FIXTURE_NOW_MS = 1_750_000_000_000;

export interface RecordFixtureCase {
	readonly code: "accepted" | RecordRejectionCode;
	readonly expected: "accepted" | RecordRejectionCode;
	readonly label: string;
	readonly passed: boolean;
}

export interface RecordFixtureResult {
	readonly admission: "invite";
	readonly canonicalBytes: number;
	readonly cases: readonly RecordFixtureCase[];
	readonly capabilities: readonly string[];
	readonly expiresInMs: number;
	readonly evidenceDigest: string;
	readonly namespaceAlias: "namespace-A";
	readonly peerAlias: "publisher-A";
	readonly privateKeyFields: number;
	readonly record: SignedDrpRecordV1;
	readonly resolverChecks: number;
	readonly sequence: number;
	readonly traceId: "record-fixture-v1";
}

/**
 * Builds the deterministic Phase 04 positive and adversarial fixture.
 * @returns Redaction-safe fixture evidence plus the in-memory signed record.
 */
export async function createRecordFixture(): Promise<RecordFixtureResult> {
	const key = await generateKeyPairFromSeed(
		"Ed25519",
		Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 7) % 256)
	);
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	const namespace = createOpaqueNamespaceV1(Uint8Array.from({ length: 32 }, (_, index) => index + 11));
	const signer = new RecordSigner(key);
	const record = await signer.sign({
		namespace,
		addresses: [`/dns4/relay.example.test/tcp/443/wss/p2p/${peerId}`],
		capabilities: ["drp-gossipsub", "webrtc"],
		sequence: 7,
		issuedAtMs: RECORD_FIXTURE_NOW_MS,
		expiresAtMs: RECORD_FIXTURE_NOW_MS + 60_000,
	});
	let resolverChecks = 0;
	const resolver = {
		resolve(): Promise<string[]> {
			resolverChecks += 1;
			return Promise.resolve(["93.184.216.34"]);
		},
	};
	const context = {
		admission: { accepted: true, mode: "invite" } as const,
		expectedNamespace: namespace,
		signal: new AbortController().signal,
	};
	const accepted = await new RecordValidator({ now: fixtureNow, resolver }).validate(record, context);
	if (!accepted.accepted) throw new Error(`record fixture unexpectedly rejected: ${accepted.code}`);

	const forged = await validateSingle(
		{ ...record, signature: mutateBase64(record.signature) },
		namespace,
		resolver,
		context.admission
	);
	const expired = await validateSingle(
		await signer.sign({
			namespace,
			addresses: record.addresses,
			capabilities: record.capabilities,
			sequence: 8,
			issuedAtMs: RECORD_FIXTURE_NOW_MS - 70_000,
			expiresAtMs: RECORD_FIXTURE_NOW_MS - 10_000,
		}),
		namespace,
		resolver,
		context.admission
	);
	const unsafe = await validateSingle(
		await signer.sign({
			namespace,
			addresses: [`/ip4/127.0.0.1/tcp/4001/p2p/${peerId}`],
			capabilities: record.capabilities,
			sequence: 9,
			issuedAtMs: RECORD_FIXTURE_NOW_MS,
			expiresAtMs: RECORD_FIXTURE_NOW_MS + 60_000,
		}),
		namespace,
		resolver,
		context.admission
	);
	const missingAdmission = await validateSingle(record, namespace, resolver, undefined);
	const replayValidator = new RecordValidator({ now: fixtureNow, resolver });
	await replayValidator.validate(record, context);
	const replayed = await replayValidator.validate(record, context);
	const responseCap = await new RecordValidator({ now: fixtureNow, resolver }).validateResponse(
		Array.from({ length: 65 }, () => record),
		context
	);

	const cases = [
		caseResult("Canonical signature + explicit invite decision", accepted, "accepted"),
		caseResult("Forged signature", forged, "invalid-signature"),
		caseResult("Expired TTL", expired, "expired"),
		caseResult("Private / loopback address", unsafe, "unsafe-address"),
		caseResult("Missing admission decision", missingAdmission, "admission-required"),
		caseResult("Replayed sequence", replayed, "replayed-sequence"),
		caseResult("Response count over 64", responseCap[0], "response-cap-exceeded"),
	];
	const digestInput = new TextEncoder().encode(
		JSON.stringify({
			canonicalBytes: accepted.canonicalBytes,
			cases: cases.map(({ code, expected, passed }) => ({ code, expected, passed })),
			expiresInMs: record.expiresAtMs - record.issuedAtMs,
			schema: "record-fixture-v1",
		})
	);
	const evidenceDigest = `sha256:${base64url.baseEncode((await sha256.digest(digestInput)).digest).slice(0, 16)}`;

	return {
		admission: "invite",
		canonicalBytes: accepted.canonicalBytes,
		cases,
		capabilities: record.capabilities,
		evidenceDigest,
		expiresInMs: record.expiresAtMs - record.issuedAtMs,
		namespaceAlias: "namespace-A",
		peerAlias: "publisher-A",
		privateKeyFields: Object.keys(record).filter((keyName) => /private|secret/iu.test(keyName)).length,
		record,
		resolverChecks,
		sequence: record.sequence,
		traceId: "record-fixture-v1",
	};
}

async function validateSingle(
	record: SignedDrpRecordV1,
	namespace: string,
	resolver: { resolve(): Promise<string[]> },
	admission: { accepted: true; mode: "invite" } | undefined
): Promise<RecordValidationResult> {
	return new RecordValidator({ now: fixtureNow, resolver }).validate(record, {
		admission,
		expectedNamespace: namespace,
		signal: new AbortController().signal,
	});
}

function fixtureNow(): number {
	return RECORD_FIXTURE_NOW_MS;
}

function caseResult(
	label: string,
	result: RecordValidationResult,
	expected: "accepted" | RecordRejectionCode
): RecordFixtureCase {
	const code = result.accepted ? "accepted" : result.code;
	return { code, expected, label, passed: code === expected };
}

function mutateBase64(value: string): string {
	const last = value.at(-1);
	return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}
