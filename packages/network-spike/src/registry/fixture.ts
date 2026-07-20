import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { base64url } from "multiformats/bases/base64";
import { sha256 } from "multiformats/hashes/sha2";

import {
	AdmissionPolicy,
	DhtAnchorPublisher,
	DhtAnchorResolver,
	FixtureRegistryEndpoint,
	namespaceAnchorCid,
	type ProofOfWorkChallengeV1,
	RegistryClient,
	RegistryServer,
	solveProofOfWork,
} from "./index.js";
import type { BrowserRoutingPeer } from "../browser-routing/index.js";
import { createOpaqueNamespaceV1, RecordSigner, RecordValidator, type SignedDrpRecordV1 } from "../record/index.js";

const FIXTURE_NOW = 1_750_000_000_000;
const INVITE_TOKEN = "fixture-invite-token-32-characters";
const publicResolver = { resolve: (): Promise<string[]> => Promise.resolve(["93.184.216.34"]) };

export interface RegistryFixtureCase {
	readonly actual: string;
	readonly expected: string;
	readonly label: string;
	readonly passed: boolean;
}

export interface AdmissionComparison {
	readonly abuseBehavior: string;
	readonly browserCostMs: number | null;
	readonly mode: "allowlist" | "invite" | "open" | "proof-of-work";
	readonly operatorBurden: string;
	readonly registrationResult: string;
	readonly serverVerifyMs: number;
	readonly warning?: string;
}

export interface RendezvousComparison {
	readonly availability: string;
	readonly dependencyHops: number;
	readonly discoveryResult: string;
	readonly freshness: string;
	readonly leakage: string;
	readonly operatorDependency: string;
	readonly operationMs: number;
	readonly path: "dht-anchor" | "signed-registry";
	readonly visibleArtifactClasses: number;
}

export interface RegistryFixtureResult {
	readonly admission: readonly AdmissionComparison[];
	readonly anchorCidAlias: string;
	readonly cases: readonly RegistryFixtureCase[];
	readonly comparison: readonly RendezvousComparison[];
	readonly digest: string;
	readonly discoveredPeerAlias: string;
	readonly endpointAttempts: readonly {
		readonly endpointAlias: string;
		readonly operation: string;
		readonly status: string;
		readonly code?: string;
	}[];
	readonly namespaceAlias: string;
	readonly privateCredentialFields: number;
	readonly traceId: string;
}

/**
 * Runs the deterministic two-registry and Node-anchor comparison without public
 * egress or serialized admission credentials.
 * @returns Sanitized evidence consumed by `/rendezvous` and `/anchor`.
 */
export async function createRegistryFixture(): Promise<RegistryFixtureResult> {
	const key = await generateKeyPairFromSeed("Ed25519", fixtureSeed(1));
	const peerId = peerIdFromPublicKey(key.publicKey).toString();
	const namespace = createOpaqueNamespaceV1(fixtureSeed(2));
	const signer = new RecordSigner(key);
	const first = await signer.sign(unsignedRecord(namespace, peerId, 1));
	const second = await signer.sign(unsignedRecord(namespace, peerId, 2));
	const primary = fixtureEndpoint("primary");
	const secondary = fixtureEndpoint("secondary");
	const client = fixtureClient(primary, secondary);
	const firstReceipt = await client.register(first, signal(), { kind: "invite", token: INVITE_TOKEN });
	primary.setAvailable(false);
	const refreshReceipt = await client.register(second, signal(), { kind: "invite", token: INVITE_TOKEN });
	const registryStarted = performance.now();
	const discovered = await client.discover(namespace, signal());
	const registryOperationMs = performance.now() - registryStarted;
	const attempts = client.lastAttempts;
	primary.setAvailable(true);
	const recovered = await client.discover(namespace, signal());

	const allDownPrimary = fixtureEndpoint("down-a");
	const allDownSecondary = fixtureEndpoint("down-b");
	allDownPrimary.setAvailable(false);
	allDownSecondary.setAvailable(false);
	const allDown = fixtureClient(allDownPrimary, allDownSecondary);
	let allDownCode = "unexpected-success";
	try {
		await allDown.discover(namespace, signal());
	} catch (error) {
		allDownCode = error instanceof Error ? error.name : "unknown-error";
	}

	const anchorCid = await namespaceAnchorCid(namespace);
	const publishedCids: string[] = [];
	const anchorPublisher = new DhtAnchorPublisher({
		cancelReprovide: (): Promise<void> => Promise.resolve(),
		peerId: "anchor-A",
		provide: (cid: string): Promise<{ cid: string }> => {
			publishedCids.push(cid);
			return Promise.resolve({ cid });
		},
	});
	const anchorStarted = performance.now();
	const anchorPublication = await anchorPublisher.publish(namespace, signal());
	const anchorResolver = new DhtAnchorResolver(
		{
			async *findProviders(): AsyncIterable<BrowserRoutingPeer> {
				await Promise.resolve();
				yield routingPeer("unconfigured-provider");
				yield routingPeer("anchor-A");
			},
		},
		["anchor-A"]
	);
	const anchorResolution = await anchorResolver.resolve(namespace, signal());
	const anchorOperationMs = performance.now() - anchorStarted;
	const admission = await admissionComparison(first);

	const cases: RegistryFixtureCase[] = [
		caseResult("Initial replication", firstReceipt.acceptedEndpointIds.join(","), "primary,secondary"),
		caseResult("Refresh during primary outage", refreshReceipt.acceptedEndpointIds.join(","), "secondary"),
		caseResult("Discovery failover", discovered[0]?.sourceEndpointId ?? "empty", "secondary"),
		caseResult("Monotonic refresh", String(discovered[0]?.record.sequence ?? -1), "2"),
		caseResult("All endpoints down", allDownCode, "RegistryExhaustedError"),
		caseResult(
			"Recovered stale primary",
			`${recovered[0]?.sourceEndpointId ?? "empty"}:${recovered[0]?.record.sequence ?? -1}`,
			"secondary:2"
		),
		caseResult("Anchor publishes itself", anchorPublication.anchorPeerId, "anchor-A"),
		caseResult("Anchor CID round-trip", publishedCids[0] ?? "missing", anchorCid),
		caseResult("Delegated anchor lookup", anchorResolution.providers[0]?.peerId ?? "empty", "anchor-A"),
		caseResult("Anchor semantics", anchorResolution.semantics, "configured-node-anchor-only"),
	];
	const sanitized = {
		admission: admission.map(({ mode, registrationResult, warning }) => ({ mode, registrationResult, warning })),
		cases: cases.map(({ actual, expected, passed }) => ({ actual, expected, passed })),
		schema: "registry-fixture-v1",
	};
	const digest = `sha256:${base64url.baseEncode((await sha256.digest(new TextEncoder().encode(JSON.stringify(sanitized)))).digest).slice(0, 16)}`;

	return {
		admission,
		anchorCidAlias: "anchor-cid-A",
		cases,
		comparison: [
			{
				availability: "2 ordered independent endpoints; either may fail",
				dependencyHops: 2,
				discoveryResult: `${discovered.length} validated short-TTL record`,
				freshness: "record TTL + monotonic refresh; exact expiry",
				leakage: "opaque namespace + signed peer addresses/capabilities",
				operationMs: registryOperationMs,
				operatorDependency: "DRP registry operators + admission-secret rotation",
				path: "signed-registry",
				visibleArtifactClasses: 2,
			},
			{
				availability: "DHT publication + delegated lookup + reachable Node anchor",
				dependencyHops: 3,
				discoveryResult: "1 Node anchor; browser publisher is not advertised",
				freshness: "DHT/provider reprovide cadence; record fetched after anchor dial",
				leakage: "namespace CID + Node anchor provider/address metadata",
				operationMs: anchorOperationMs,
				operatorDependency: "public DHT + delegated endpoint + Node anchor operator",
				path: "dht-anchor",
				visibleArtifactClasses: 3,
			},
		],
		digest,
		discoveredPeerAlias: "publisher-A",
		endpointAttempts: attempts.map(({ code, endpointId, operation, status }) => ({
			...(code === undefined ? {} : { code }),
			endpointAlias: endpointId,
			operation,
			status,
		})),
		namespaceAlias: "namespace-A",
		privateCredentialFields: countCredentialFields({
			admission,
			cases,
			comparison: "sanitized",
		}),
		traceId: "registry-fixture-v1",
	};
}

async function admissionComparison(record: SignedDrpRecordV1): Promise<readonly AdmissionComparison[]> {
	const invite = new AdmissionPolicy({ inviteToken: INVITE_TOKEN });
	const allowlist = new AdmissionPolicy({ allowedPeerIds: [record.peerId], mode: "allowlist" });
	const open = new AdmissionPolicy({ allowUnsafeOpen: true, mode: "open" });
	let nonce = 0;
	const proof = new AdmissionPolicy(
		{
			limits: {
				maxDifficultyBits: 9,
				maxIterations: 16_384,
				minDifficultyBits: 8,
			},
			mode: "proof-of-work",
			nonce: (): Uint8Array => Uint8Array.from({ length: 16 }, () => nonce++),
			secret: new Uint8Array(32).fill(9),
		},
		() => FIXTURE_NOW
	);
	const challenge = await proof.issueChallenge(record.namespace, record.peerId, record.peerId, signal());
	if (!isChallenge(challenge)) throw new Error(`proof challenge failed: ${challenge.code}`);
	const solved = await solveProofOfWork(challenge, 16_384, signal());
	const policies = [
		{
			abuseBehavior: "shared token rate-limited; token theft permits registration",
			browserCostMs: null,
			credential: { kind: "invite" as const, token: INVITE_TOKEN },
			mode: "invite" as const,
			operatorBurden: "secret distribution and rotation",
			policy: invite,
		},
		{
			abuseBehavior: "unknown Peer IDs rejected; identity list can grow stale",
			browserCostMs: null,
			credential: undefined,
			mode: "allowlist" as const,
			operatorBurden: "Peer-ID enrollment and revocation",
			policy: allowlist,
		},
		{
			abuseBehavior: "Sybil identities accepted until quotas/rates stop them",
			browserCostMs: null,
			credential: undefined,
			mode: "open" as const,
			operatorBurden: "abuse monitoring and aggressive quotas",
			policy: open,
			warning: "EXPLICITLY SYBIL-UNSAFE CANARY",
		},
		{
			abuseBehavior: "bounded client work raises cost; botnets and efficient hardware remain",
			browserCostMs: solved.durationMs,
			credential: { challenge, counter: solved.counter, kind: "proof-of-work" as const },
			mode: "proof-of-work" as const,
			operatorBurden: "difficulty tuning, challenge state, and expiry",
			policy: proof,
		},
	];
	const results: AdmissionComparison[] = [];
	for (const candidate of policies) {
		const started = performance.now();
		const decision = await candidate.policy.evaluate({
			clientId: record.peerId,
			credential: candidate.credential,
			record,
			signal: signal(),
		});
		results.push({
			abuseBehavior: candidate.abuseBehavior,
			browserCostMs: candidate.browserCostMs,
			mode: candidate.mode,
			operatorBurden: candidate.operatorBurden,
			registrationResult: decision.accepted ? "accepted" : (decision.reason ?? "rejected"),
			serverVerifyMs: performance.now() - started,
			...("warning" in candidate ? { warning: candidate.warning } : {}),
		});
	}
	return results;
}

function fixtureEndpoint(id: string): FixtureRegistryEndpoint {
	const now = (): number => FIXTURE_NOW;
	return new FixtureRegistryEndpoint(
		new RegistryServer({
			endpointId: id,
			now,
			policy: new AdmissionPolicy({ inviteToken: INVITE_TOKEN }, now),
			validator: new RecordValidator({ now, resolver: publicResolver }),
		})
	);
}

function fixtureClient(primary: FixtureRegistryEndpoint, secondary: FixtureRegistryEndpoint): RegistryClient {
	return new RegistryClient({
		backoffMs: 0,
		clientId: "browser-a",
		endpoints: [primary, secondary],
		timeoutMs: 1_000,
		validatorFactory: () => new RecordValidator({ now: () => FIXTURE_NOW, resolver: publicResolver }),
	});
}

function unsignedRecord(namespace: string, peerId: string, sequence: number): Parameters<RecordSigner["sign"]>[0] {
	return {
		addresses: [`/dns4/relay.example.test/tcp/443/wss/p2p/${peerId}`],
		capabilities: ["drp-gossipsub", "webrtc"] as const,
		expiresAtMs: FIXTURE_NOW + 60_000,
		issuedAtMs: FIXTURE_NOW,
		namespace,
		sequence,
	};
}

function fixtureSeed(index: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, offset) => (index * 31 + offset) % 256);
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

function caseResult(label: string, actual: string, expected: string): RegistryFixtureCase {
	return { actual, expected, label, passed: actual === expected };
}

function routingPeer(peerId: string): BrowserRoutingPeer {
	return {
		acceptedAddresses: [`/dns4/anchor.example.test/tcp/443/wss/p2p/${peerId}`],
		addressDecisions: [],
		inputAddressCount: 1,
		peerId,
		protocols: ["/ipfs/kad/1.0.0"],
		rawAddresses: [`/dns4/anchor.example.test/tcp/443/wss/p2p/${peerId}`],
		truncatedAddressCount: 0,
	};
}

function isChallenge(value: ProofOfWorkChallengeV1 | { readonly accepted: false }): value is ProofOfWorkChallengeV1 {
	return "kind" in value && value.kind === "ts-drp-registry-proof";
}

function countCredentialFields(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((count, item) => count + countCredentialFields(item), 0);
	if (typeof value !== "object" || value === null) return 0;
	return Object.entries(value).reduce(
		(count, [key, item]) =>
			count + (/token|credential|secret|private/iu.test(key) ? 1 : 0) + countCredentialFields(item),
		0
	);
}
