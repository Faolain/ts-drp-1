import { generateKeyPairFromSeed, publicKeyToProtobuf } from "@libp2p/crypto/keys";
import { type GossipSub, type GossipsubMessage, type SignedMessage, StrictSign } from "@libp2p/gossipsub";
import { RPC } from "@libp2p/gossipsub/message";
import { type PeerId, type PrivateKey } from "@libp2p/interface";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { type DRPNetworkNodeConfig, Message, MessageType } from "@ts-drp/types";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
	SignPrefix,
	validateToRawMessage,
} from "../../../node_modules/.pnpm/@libp2p+gossipsub@16.0.4/node_modules/@libp2p/gossipsub/dist/src/utils/buildRawMessage.js";
import { type DRPNetworkHostFactory, DRPNetworkNode } from "../src/node.js";

interface Seam3NetworkSurface {
	publishMessage?(topic: string, message: Message): Promise<true>;
	gossipTopicFor?(message: Message): string | undefined;
}

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEAM3_BUF_CLI_PACKAGE = "@bufbuild/buf@1.69.0";
const SEAM3_BUF_VERSION = "1.69.0";
const SEAM3_TS_PROTO_PACKAGE = "ts-proto";
const SEAM3_TS_PROTO_VERSION = "2.7.0";
const SEAM3_TS_PROTO_PLUGIN = "./node_modules/ts-proto/protoc-gen-ts_proto";
const SEAM3_BUF_GENERATE_ARGS = Object.freeze([
	"generate",
	"packages/types/src/proto",
	"-o",
	"packages/types/src/proto",
] as const);
const SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS = Object.freeze([
	"AttestationUpdate",
	"DRPDiscovery",
	"DRPDiscoveryResponse",
	"DRPDiscoveryResponse_Subscribers",
	"DRPDiscoveryResponse_SubscribersEntry",
	"FetchState",
	"FetchStateResponse",
	"Message",
	"MessageType",
	"Sync",
	"SyncAccept",
	"SyncReject",
	"Update",
	"V3Envelope",
] as const);
const SEAM3_TYPES_RUNTIME_EXPORTS = Object.freeze([
	"ACLConflictResolution",
	"ACLGroup",
	"ActionType",
	"AggregatedAttestation",
	"Attestation",
	"AttestationUpdate",
	"DRPDiscovery",
	"DRPDiscoveryResponse",
	"DRPDiscoveryResponse_Subscribers",
	"DRPDiscoveryResponse_SubscribersEntry",
	"DRPObjectBase",
	"DRPState",
	"DRPStateEntry",
	"DRPStateEntryOtherTheWire",
	"DRPStateOtherTheWire",
	"DRP_DISCOVERY_TOPIC",
	"DRP_INTERVAL_DISCOVERY_TOPIC",
	"DrpType",
	"FetchState",
	"FetchStateResponse",
	"IntervalRunnerState",
	"Message",
	"MessageType",
	"NodeEventName",
	"Operation",
	"SemanticsType",
	"Sync",
	"SyncAccept",
	"SyncReject",
	"Update",
	"V3Envelope",
	"Vertex",
] as const);
const CONFIG: DRPNetworkNodeConfig = {
	bootstrap_peers: [],
	listen_addresses: ["/ip4/127.0.0.1/tcp/0/ws"],
	log_config: { level: "silent" },
};
const TOPIC = "drp/v3/1/phase-3a1b-seam3";
let signer: PrivateKey;
let signerId: PeerId;
let sequence = BigInt(0);

function source(relative: string): string {
	return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function classMethod(sourceText: string, className: string, methodName: string): ts.MethodDeclaration | undefined {
	const unit = ts.createSourceFile("owner.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const owner = unit.statements.find(
		(statement): statement is ts.ClassDeclaration =>
			ts.isClassDeclaration(statement) && statement.name?.text === className
	);
	return owner?.members.find(
		(member): member is ts.MethodDeclaration =>
			ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName
	);
}

function thisCallNames(method: ts.MethodDeclaration): readonly string[] {
	const names: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
		) {
			names.push(node.expression.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(method);
	return Object.freeze(names);
}

function generatedMessageRootExports(indexSource: string): readonly string[] {
	const matches = [
		...indexSource.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']\.\/proto\/drp\/v1\/messages_pb\.js["'];/gu),
	];
	expect(matches).toHaveLength(1);
	return Object.freeze(
		(matches[0]?.[1] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "")
			.sort()
	);
}

interface V3EnvelopeCodecContract {
	decode(bytes: Uint8Array): { canonicalPreimage: Uint8Array; signature: Uint8Array };
	encode(value: { canonicalPreimage: Uint8Array; signature: Uint8Array }): { finish(): Uint8Array };
}

function v3EnvelopeCodec(module: object): V3EnvelopeCodecContract {
	const codec = Reflect.get(module, "V3Envelope") as Partial<V3EnvelopeCodecContract> | undefined;
	if (codec === undefined || typeof codec.decode !== "function" || typeof codec.encode !== "function") {
		throw new TypeError("missing @ts-drp/types root V3Envelope codec");
	}
	return codec as V3EnvelopeCodecContract;
}

function assertGeneratedWireMatchesProto(proto: string, generated: string): void {
	expect(proto.match(/MESSAGE_TYPE_V3_ENVELOPE = 11;/gu)).toHaveLength(1);
	expect(
		proto.match(/message V3Envelope \{\s*bytes canonical_preimage = 1;\s*bytes signature = 2;\s*\}/gu)
	).toHaveLength(1);
	expect(generated.startsWith("// Code generated by protoc-gen-ts_proto. DO NOT EDIT.")).toBe(true);
	expect(generated.match(/MESSAGE_TYPE_V3_ENVELOPE = 11,/gu)).toHaveLength(1);
	expect(
		generated.match(/export interface V3Envelope \{\s*canonicalPreimage: Uint8Array;\s*signature: Uint8Array;/gu)
	).toHaveLength(1);
	expect(generated.match(/export const V3Envelope: MessageFns<V3Envelope>/gu)).toHaveLength(1);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.length + right.length);
	result.set(left);
	result.set(right, left.length);
	return result;
}

function nextSequence(): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, ++sequence, false);
	return bytes;
}

async function signedIngress(message: Message): Promise<SignedMessage> {
	const unsigned: RPC.Message = {
		from: signerId.toMultihash().bytes,
		data: Message.encode(message).finish(),
		seqno: nextSequence(),
		topic: TOPIC,
	};
	const candidate: RPC.Message = {
		...unsigned,
		key: publicKeyToProtobuf(signer.publicKey),
		signature: await signer.sign(concat(SignPrefix, RPC.Message.encode(unsigned))),
	};
	const result = await validateToRawMessage(StrictSign, candidate);
	if (!result.valid || result.message.type !== "signed") throw new TypeError("signed fixture was rejected");
	return result.message;
}

async function makeStartedReceiver(): Promise<{ node: DRPNetworkNode; pubsub: GossipSub }> {
	let pubsub: GossipSub | undefined;
	const hostFactory: DRPNetworkHostFactory = async ({ createHost }) => {
		const host = await createHost();
		pubsub = host.services.pubsub as GossipSub;
		return host;
	};
	const node = new DRPNetworkNode(CONFIG, {
		hostFactory,
		hostPolicy: {
			bootstrapDiscovery: false,
			coldStartPubsubDiscovery: false,
			gossipSubPeerExchange: false,
		},
	});
	await node.start();
	if (pubsub === undefined) throw new TypeError("missing production gossipsub");
	return { node, pubsub };
}

function dispatch(pubsub: GossipSub, message: SignedMessage): void {
	pubsub.dispatchEvent(
		new CustomEvent<GossipsubMessage>("gossipsub:message", {
			detail: { msg: message, msgId: `seam3-${message.sequenceNumber}`, propagationSource: signerId },
		})
	);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new TypeError(`timed out waiting for ${label}`);
}

describe("Phase 3a-1B Seam 3 network and generated-wire RED", () => {
	const running: DRPNetworkNode[] = [];

	beforeAll(async () => {
		signer = await generateKeyPairFromSeed("Ed25519", new Uint8Array(32).fill(0x31));
		signerId = peerIdFromPublicKey(signer.publicKey);
	});

	afterEach(async () => {
		await Promise.allSettled(running.splice(0).map((node) => node.stop()));
	});

	it("adds exactly the truthful strict publication and identity-only provenance methods", () => {
		const types = source("packages/types/src/network.ts");
		const owner = source("packages/network/src/node.ts");
		expect(types.match(/publishMessage\(topic: string, message: Message\): Promise<true>;/gu)).toHaveLength(1);
		expect(types.match(/gossipTopicFor\(message: Message\): string \| undefined;/gu)).toHaveLength(1);
		expect(owner.match(/publishMessage\(topic: string, message: Message\)/gu)).toHaveLength(1);
		expect(owner.match(/gossipTopicFor\(message: Message\)/gu)).toHaveLength(1);
		expect(owner).toMatch(/WeakMap<\s*Message\s*,\s*string\s*>/u);
		expect(owner).not.toMatch(/(?:setGossipTopic|bindGossipTopic|gossipTopics\(\)|gossipTopicEntries)/u);
	});

	it("shares one encode/wait/publish core while preserving legacy swallow and strict literal truth", async () => {
		const owner = source("packages/network/src/node.ts");
		const broadcastOwner = classMethod(owner, "DRPNetworkNode", "broadcastMessage");
		const strictOwner = classMethod(owner, "DRPNetworkNode", "publishMessage");
		expect(broadcastOwner).toBeDefined();
		expect(strictOwner).toBeDefined();
		if (broadcastOwner === undefined || strictOwner === undefined) throw new TypeError("missing publication owners");
		const broadcastCalls = thisCallNames(broadcastOwner);
		const strictCalls = thisCallNames(strictOwner);
		const sharedPublicationCores = [...new Set(broadcastCalls)].filter((name) => {
			if (!strictCalls.includes(name)) return false;
			const candidate = classMethod(owner, "DRPNetworkNode", name);
			if (candidate === undefined) return false;
			const text = candidate.getText();
			return text.includes("Message.encode") && text.includes("waitForPeers") && text.includes(".publish(");
		});
		expect(sharedPublicationCores).toHaveLength(1);
		const sharedPublicationCore = sharedPublicationCores[0];
		expect(broadcastCalls.filter((name) => name === sharedPublicationCore)).toHaveLength(1);
		expect(strictCalls.filter((name) => name === sharedPublicationCore)).toHaveLength(1);
		const node = new DRPNetworkNode({ ...CONFIG, listen_addresses: [] });
		const surface = node as DRPNetworkNode & Seam3NetworkSurface;
		if (surface.publishMessage === undefined) throw new TypeError("missing publishMessage");
		const peer = { toString: (): string => "peer" };
		const publish = vi.fn(
			(_topic: string, _bytes: Uint8Array): Promise<void> => Promise.reject(new Error("synthetic publish failure"))
		);
		Reflect.set(node, "_pubsub", {
			getSubscribers: (): readonly (typeof peer)[] => [peer],
			streamsOutbound: new Map([["peer", {}]]),
			publish,
		});
		const message = Message.create({
			data: Uint8Array.of(1),
			objectId: TOPIC,
			sender: "sender",
			type: 11 as MessageType,
		});
		const readiness = vi.fn(() => Promise.reject(new Error("synthetic readiness failure")));
		Reflect.set(node, "waitForSubscriber", readiness);
		await expect(node.broadcastMessage("legacy-topic", message)).resolves.toBeUndefined();
		await expect(surface.publishMessage(TOPIC, message)).rejects.toThrow("synthetic readiness failure");
		expect(readiness).toHaveBeenCalledTimes(2);
		expect(publish).not.toHaveBeenCalled();

		Reflect.set(
			node,
			"waitForSubscriber",
			vi.fn(() => Promise.resolve())
		);

		await expect(node.broadcastMessage("legacy-topic", message)).resolves.toBeUndefined();
		await expect(surface.publishMessage(TOPIC, message)).rejects.toThrow("synthetic publish failure");
		expect(publish).toHaveBeenCalledTimes(2);
		expect(publish.mock.calls[0]?.[0]).toBe("legacy-topic");
		expect(publish.mock.calls[1]?.[0]).toBe(TOPIC);

		publish.mockResolvedValueOnce(undefined);
		await expect(surface.publishMessage(TOPIC, message)).resolves.toBe(true);
		expect(publish.mock.calls.at(-1)?.[0]).toBe(TOPIC);
	});

	it("binds only the exact authenticated gossip-decoded Message identity to its actual topic", async () => {
		const owner = source("packages/network/src/node.ts");
		const validate = owner.indexOf("validateToRawMessage");
		const decode = owner.indexOf("Message.decode", validate);
		const bind = owner.indexOf("gossipTopic", decode);
		const dispatchIndex = owner.indexOf("messageQueueCallback", bind);
		expect([validate, decode, bind, dispatchIndex].every((index) => index >= 0)).toBe(true);
		expect(validate).toBeLessThan(decode);
		expect(decode).toBeLessThan(bind);
		expect(bind).toBeLessThan(dispatchIndex);
		const { node, pubsub } = await makeStartedReceiver();
		running.push(node);
		const surface = node as DRPNetworkNode & Seam3NetworkSurface;
		if (surface.gossipTopicFor === undefined) throw new TypeError("missing gossipTopicFor");
		const received: Message[] = [];
		node.subscribeToMessageQueue((message) => {
			received.push(message);
		});
		const wire = Message.create({
			data: Uint8Array.of(2, 3),
			objectId: TOPIC,
			sender: "ignored",
			type: 11 as MessageType,
		});
		const authenticated = await signedIngress(wire);
		const corruptedSignature = new Uint8Array(authenticated.signature);
		corruptedSignature[0] = (corruptedSignature[0] ?? 0) ^ 0xff;
		dispatch(pubsub, { ...authenticated, signature: corruptedSignature });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(received).toEqual([]);
		dispatch(pubsub, authenticated);
		await waitFor(() => received.length === 1, "authenticated Seam3 ingress");
		const exact = received[0];
		if (exact === undefined) throw new TypeError("missing decoded message");
		expect(surface.gossipTopicFor(exact)).toBe(TOPIC);
		expect(surface.gossipTopicFor({ ...exact, data: new Uint8Array(exact.data) })).toBeUndefined();
		expect(surface.gossipTopicFor(wire)).toBeUndefined();
	});

	it("pins tag 11 and the strict two-field V3Envelope through authoritative generation", async () => {
		const proto = source("packages/types/src/proto/drp/v1/messages.proto");
		const generated = source("packages/types/src/proto/drp/v1/messages_pb.ts");
		const rootPackage = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
		expect(rootPackage.scripts["proto-gen:types"]).toBe(
			"buf generate packages/types/src/proto -o packages/types/src/proto"
		);
		expect(source("buf.gen.yaml")).toContain("protoc-gen-ts_proto");
		assertGeneratedWireMatchesProto(proto, generated);
		const typesRoot = await import("@ts-drp/types");
		const codec = v3EnvelopeCodec(typesRoot);
		const exact = Uint8Array.of(0x0a, 0x02, 0x01, 0x02, 0x12, 0x01, 0x03);
		const value = Object.freeze({ canonicalPreimage: Uint8Array.of(1, 2), signature: Uint8Array.of(3) });
		expect(codec.decode(Uint8Array.of(0x0a, 0x02, 0x01, 0x02))).toEqual({
			canonicalPreimage: Uint8Array.of(1, 2),
			signature: new Uint8Array(),
		});
		expect(codec.decode(Uint8Array.of(0x12, 0x01, 0x03))).toEqual({
			canonicalPreimage: new Uint8Array(),
			signature: Uint8Array.of(3),
		});
		for (const wrongWire of [
			Uint8Array.of(0x08, 0x01),
			Uint8Array.of(0x09, 0, 0, 0, 0, 0, 0, 0, 1),
			Uint8Array.of(0x0d, 0, 0, 0, 1),
			Uint8Array.of(0x10, 0x01),
			Uint8Array.of(0x11, 0, 0, 0, 0, 0, 0, 0, 1),
			Uint8Array.of(0x15, 0, 0, 0, 1),
		]) {
			const decoded = codec.decode(wrongWire);
			expect(decoded).toEqual({ canonicalPreimage: new Uint8Array(), signature: new Uint8Array() });
			expect(codec.encode(decoded).finish()).toEqual(new Uint8Array());
			expect(codec.encode(decoded).finish()).not.toEqual(wrongWire);
		}
		const withUnknown = Uint8Array.of(...exact, 0x1a, 0x01, 0xff);
		expect(codec.decode(withUnknown)).toEqual(value);
		expect(codec.encode(codec.decode(withUnknown)).finish()).toEqual(exact);
		expect(codec.encode(value).finish()).toEqual(exact);
		expect(codec.decode(exact)).toEqual(value);
		expect(codec.encode(codec.decode(exact)).finish()).toEqual(exact);

		const legacyNames = [
			"MESSAGE_TYPE_UNSPECIFIED",
			"MESSAGE_TYPE_FETCH_STATE",
			"MESSAGE_TYPE_FETCH_STATE_RESPONSE",
			"MESSAGE_TYPE_UPDATE",
			"MESSAGE_TYPE_SYNC",
			"MESSAGE_TYPE_SYNC_ACCEPT",
			"MESSAGE_TYPE_SYNC_REJECT",
			"MESSAGE_TYPE_ATTESTATION_UPDATE",
			"MESSAGE_TYPE_CUSTOM",
			"MESSAGE_TYPE_DRP_DISCOVERY",
			"MESSAGE_TYPE_DRP_DISCOVERY_RESPONSE",
		] as const;
		for (const [numericValue, name] of legacyNames.entries()) {
			expect(Reflect.get(MessageType, name)).toBe(numericValue);
		}
		expect(Reflect.get(MessageType, "MESSAGE_TYPE_V3_ENVELOPE")).toBe(11);
		expect(Reflect.get(MessageType, "UNRECOGNIZED")).toBe(-1);
	});

	it("adds V3Envelope as the sole exact generated root-surface delta", async () => {
		const indexSource = source("packages/types/src/index.ts");
		expect(generatedMessageRootExports(indexSource)).toEqual(SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS);
		const typesRoot = await import("@ts-drp/types");
		expect(Object.keys(typesRoot).sort()).toEqual(SEAM3_TYPES_RUNTIME_EXPORTS);
		v3EnvelopeCodec(typesRoot);
		expect(indexSource.match(/\bV3Envelope\b/gu)).toHaveLength(1);
		const packageManifest = JSON.parse(source("packages/types/package.json")) as Record<string, unknown>;
		expect(Object.keys(packageManifest).sort()).toEqual([
			"dependencies",
			"devDependencies",
			"exports",
			"files",
			"license",
			"name",
			"peerDependencies",
			"repository",
			"scripts",
			"type",
			"types",
			"version",
		]);
		expect(packageManifest.name).toBe("@ts-drp/types");
		expect(packageManifest.types).toBe("./dist/src/index.d.ts");
		expect(packageManifest.files).toEqual(["src", "dist", "!dist/test", "!**/*.tsbuildinfo"]);
		expect(packageManifest.exports).toEqual({
			".": {
				import: "./dist/src/index.js",
				types: "./dist/src/index.d.ts",
			},
		});
		expect(packageManifest.dependencies).toEqual({
			"@bufbuild/protobuf": "^2.0.0",
			"loglevel": "^1.9.2",
		});
		expect(packageManifest.peerDependencies).toEqual({
			"@libp2p/gossipsub": "^16.0.4",
			"@libp2p/interface": "^3.2.5",
			"@multiformats/multiaddr": "^13.0.3",
		});
		expect(packageManifest.devDependencies).toEqual({ "@types/object-inspect": "^1.13.0" });
		const lock = source("pnpm-lock.yaml");
		const typesImporterStart = lock.indexOf("  packages/types:\n");
		const nextImporter = lock.indexOf("\n  packages/", typesImporterStart + 1);
		expect(lock.slice(typesImporterStart, nextImporter)).toBe(
			[
				"  packages/types:",
				"    dependencies:",
				"      '@bufbuild/protobuf':",
				"        specifier: ^2.0.0",
				"        version: 2.2.5",
				"      '@libp2p/gossipsub':",
				"        specifier: ^16.0.4",
				"        version: 16.0.4",
				"      '@libp2p/interface':",
				"        specifier: ^3.2.5",
				"        version: 3.2.5",
				"      '@multiformats/multiaddr':",
				"        specifier: ^13.0.3",
				"        version: 13.0.3",
				"      loglevel:",
				"        specifier: ^1.9.2",
				"        version: 1.9.2",
				"    devDependencies:",
				"      '@types/object-inspect':",
				"        specifier: ^1.13.0",
				"        version: 1.13.0",
			].join("\n")
		);
		expect(source("packages/types/package.json")).not.toContain("V3Envelope");
	});

	it("fails the external source and type consumer only until the root V3Envelope export exists", () => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-seam3-types-consumer-"));
		try {
			const consumerPath = path.join(temporaryRoot, "consumer.ts");
			fs.writeFileSync(
				consumerPath,
				[
					'import { type V3Envelope, V3Envelope as V3EnvelopeCodec } from "@ts-drp/types";',
					"const value: V3Envelope = { canonicalPreimage: Uint8Array.of(1), signature: Uint8Array.of(2) };",
					"const roundTrip: V3Envelope = V3EnvelopeCodec.decode(V3EnvelopeCodec.encode(value).finish());",
					"void roundTrip;",
				].join("\n")
			);
			const configPath = path.join(temporaryRoot, "tsconfig.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					compilerOptions: {
						baseUrl: ROOT,
						lib: ["ES2022", "DOM"],
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						paths: { "@ts-drp/types": [path.join(ROOT, "packages/types/src/index.ts")] },
						rootDir: path.parse(ROOT).root,
						skipLibCheck: true,
						strict: true,
						target: "ES2022",
						typeRoots: [path.join(ROOT, "node_modules/@types")],
						types: ["node"],
					},
					files: [consumerPath],
				})
			);
			const result = spawnSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", configPath, "--pretty", "false"], {
				cwd: temporaryRoot,
				encoding: "utf8",
			});
			expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
				status: 0,
				stderr: "",
				stdout: "",
			});
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("reproduces the checked-in generated wire bytes with the pinned official Buf CLI", () => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-seam3-buf-"));
		try {
			const generatorConfig = source("buf.gen.yaml");
			expect(
				generatorConfig.split("\n").filter((line) => line.trim() === `- local: ${SEAM3_TS_PROTO_PLUGIN}`)
			).toHaveLength(1);
			const pluginPackage = JSON.parse(source(`node_modules/${SEAM3_TS_PROTO_PACKAGE}/package.json`)) as {
				version: string;
			};
			if (pluginPackage.version !== SEAM3_TS_PROTO_VERSION) {
				throw new TypeError("SEAM3_GENERATOR_HARNESS_FAILURE: lock-resolved ts-proto version mismatch");
			}
			const rootImporter = source("pnpm-lock.yaml").slice(0, source("pnpm-lock.yaml").indexOf("  packages/"));
			expect(rootImporter).toMatch(/ts-proto:\s*\n\s+specifier: \^2\.2\.4\s*\n\s+version: 2\.7\.0/u);
			fs.copyFileSync(path.join(ROOT, "buf.gen.yaml"), path.join(temporaryRoot, "buf.gen.yaml"));
			for (const protoPath of ["drp/v1/messages.proto", "drp/v1/object.proto"] as const) {
				const target = path.join(temporaryRoot, "packages/types/src/proto", protoPath);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.copyFileSync(path.join(ROOT, "packages/types/src/proto", protoPath), target);
			}
			expect(fs.existsSync(path.join(temporaryRoot, "packages/types/src/proto/drp/v1/messages_pb.ts"))).toBe(false);
			fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temporaryRoot, "node_modules"), "dir");
			if (!fs.existsSync(path.join(temporaryRoot, SEAM3_TS_PROTO_PLUGIN))) {
				throw new TypeError("SEAM3_GENERATOR_HARNESS_FAILURE: local ts-proto plugin is unresolved");
			}

			const version = spawnSync("pnpm", ["dlx", SEAM3_BUF_CLI_PACKAGE, "--version"], {
				cwd: temporaryRoot,
				encoding: "utf8",
				timeout: 120_000,
			});
			if (version.status !== 0 || version.stdout.trim() !== SEAM3_BUF_VERSION) {
				throw new TypeError("SEAM3_GENERATOR_HARNESS_FAILURE: pinned Buf CLI unavailable");
			}

			const generated = spawnSync("pnpm", ["dlx", SEAM3_BUF_CLI_PACKAGE, ...SEAM3_BUF_GENERATE_ARGS], {
				cwd: temporaryRoot,
				encoding: "utf8",
				timeout: 120_000,
			});
			if (generated.status !== 0) {
				throw new TypeError("SEAM3_GENERATOR_HARNESS_FAILURE: pinned Buf generation failed");
			}

			const relativeGenerated = "packages/types/src/proto/drp/v1/messages_pb.ts";
			if (!fs.existsSync(path.join(temporaryRoot, relativeGenerated))) {
				throw new TypeError("SEAM3_GENERATOR_HARNESS_FAILURE: generated output tree mismatch");
			}
			expect(fs.readFileSync(path.join(temporaryRoot, relativeGenerated))).toEqual(
				fs.readFileSync(path.join(ROOT, relativeGenerated))
			);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("emits and packs the exact root value, type and codec for an external consumer", async () => {
		const build = spawnSync("pnpm", ["--filter", "@ts-drp/types", "build"], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 120_000,
		});
		expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: "" });

		const builtIndex = source("packages/types/dist/src/index.js");
		const declarationIndex = source("packages/types/dist/src/index.d.ts");
		expect(generatedMessageRootExports(builtIndex)).toEqual(SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS);
		expect(generatedMessageRootExports(declarationIndex)).toEqual(SEAM3_TYPES_GENERATED_MESSAGE_EXPORTS);
		const builtRoot = (await import(
			`${pathToFileURL(path.join(ROOT, "packages/types/dist/src/index.js")).href}?seam3`
		)) as object;
		expect(Object.keys(builtRoot).sort()).toEqual(SEAM3_TYPES_RUNTIME_EXPORTS);
		v3EnvelopeCodec(builtRoot);

		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ts-drp-seam3-packed-types-"));
		try {
			const archive = path.join(temporaryRoot, "types.tgz");
			const packed = spawnSync("pnpm", ["pack", "--out", archive], {
				cwd: path.join(ROOT, "packages/types"),
				encoding: "utf8",
				timeout: 120_000,
			});
			expect({ status: packed.status, stderr: packed.stderr }).toEqual({ status: 0, stderr: "" });
			const packageRoot = path.join(temporaryRoot, "node_modules/@ts-drp/types");
			fs.mkdirSync(packageRoot, { recursive: true });
			const extracted = spawnSync("tar", ["-xzf", archive, "--strip-components=1", "-C", packageRoot], {
				encoding: "utf8",
			});
			if (extracted.status !== 0) throw new TypeError("SEAM3_PACK_HARNESS_FAILURE: packed archive extraction failed");
			fs.symlinkSync(path.join(ROOT, "packages/types/node_modules"), path.join(packageRoot, "node_modules"), "dir");
			const packedConsumerPath = path.join(temporaryRoot, "consumer.ts");
			fs.writeFileSync(
				packedConsumerPath,
				[
					'import { type V3Envelope, V3Envelope as V3EnvelopeCodec } from "@ts-drp/types";',
					"const value: V3Envelope = { canonicalPreimage: Uint8Array.of(1), signature: Uint8Array.of(2) };",
					"const roundTrip: V3Envelope = V3EnvelopeCodec.decode(V3EnvelopeCodec.encode(value).finish());",
					"void roundTrip;",
				].join("\n")
			);
			const packedConfigPath = path.join(temporaryRoot, "tsconfig.json");
			fs.writeFileSync(
				packedConfigPath,
				JSON.stringify({
					compilerOptions: {
						lib: ["ES2022", "DOM"],
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						skipLibCheck: true,
						strict: true,
						target: "ES2022",
						typeRoots: [path.join(ROOT, "node_modules/@types")],
						types: ["node"],
					},
					files: [packedConsumerPath],
				})
			);
			const packedTypes = spawnSync(
				path.join(ROOT, "node_modules/.bin/tsc"),
				["-p", packedConfigPath, "--pretty", "false"],
				{ cwd: temporaryRoot, encoding: "utf8" }
			);
			expect({ status: packedTypes.status, stderr: packedTypes.stderr, stdout: packedTypes.stdout }).toEqual({
				status: 0,
				stderr: "",
				stdout: "",
			});
			const external = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					[
						'import * as root from "@ts-drp/types";',
						'import { V3Envelope } from "@ts-drp/types";',
						`const expected = ${JSON.stringify(SEAM3_TYPES_RUNTIME_EXPORTS)};`,
						'if (JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(expected)) throw new TypeError("surface mismatch");',
						"const exact = Uint8Array.of(0x0a, 0x01, 0x01, 0x12, 0x01, 0x02);",
						'if (V3Envelope.encode(V3Envelope.decode(exact)).finish().toString() !== exact.toString()) throw new TypeError("codec mismatch");',
					].join("\n"),
				],
				{ cwd: temporaryRoot, encoding: "utf8" }
			);
			expect({ status: external.status, stderr: external.stderr, stdout: external.stdout }).toEqual({
				status: 0,
				stderr: "",
				stdout: "",
			});
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("keeps legacy numeric values exact and gives tag 11 an explicit undefined legacy handler", () => {
		const proto = source("packages/types/src/proto/drp/v1/messages.proto");
		const legacy = [
			"MESSAGE_TYPE_UNSPECIFIED",
			"MESSAGE_TYPE_FETCH_STATE",
			"MESSAGE_TYPE_FETCH_STATE_RESPONSE",
			"MESSAGE_TYPE_UPDATE",
			"MESSAGE_TYPE_SYNC",
			"MESSAGE_TYPE_SYNC_ACCEPT",
			"MESSAGE_TYPE_SYNC_REJECT",
			"MESSAGE_TYPE_ATTESTATION_UPDATE",
			"MESSAGE_TYPE_CUSTOM",
			"MESSAGE_TYPE_DRP_DISCOVERY",
			"MESSAGE_TYPE_DRP_DISCOVERY_RESPONSE",
		];
		for (const [value, name] of legacy.entries()) {
			expect(proto.match(new RegExp(`${name} = ${value};`, "gu"))).toHaveLength(1);
		}
		const generated = source("packages/types/src/proto/drp/v1/messages_pb.ts");
		expect(generated).toContain("UNRECOGNIZED = -1");
		const handlers = source("packages/node/src/handlers.ts");
		expect(handlers.match(/\[MessageType\.MESSAGE_TYPE_V3_ENVELOPE\]: undefined/gu)).toHaveLength(1);
	});

	it("keeps both public network names on their sole existing package surface", async () => {
		const networkRoot = Object.keys(await import("../src/index.js")).sort();
		expect(networkRoot).not.toContain("gossipTopicFor");
		expect(networkRoot).not.toContain("publishMessage");
		const networkPackage = JSON.parse(source("packages/network/package.json")) as { exports: unknown };
		expect(networkPackage.exports).toEqual({
			".": { import: "./dist/src/index.js", types: "./dist/src/index.d.ts" },
		});
	});
});
