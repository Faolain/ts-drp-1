import {
	createNodeRouting,
	namespaceCid,
	OFFICIAL_AMINO_BOOTSTRAPPERS,
	PUBLIC_NETWORK_ACKNOWLEDGEMENT,
} from "@ts-drp/routing-node";
import { randomBytes } from "node:crypto";

import { runLocalAminoFixture } from "./node-routing/fixture.js";
import {
	assertSanitizedEvidenceOutputRoot,
	createPublicCanaryArtifacts,
	writePublicCanaryArtifacts,
} from "./node-routing/public-evidence.js";

const MAX_PUBLIC_REQUESTS = 8;
const MAX_PUBLIC_DURATION_MS = 30_000;

async function main(argv: string[]): Promise<void> {
	if (argv.length === 1 && argv[0] === "--fixture") {
		const fixture = await runLocalAminoFixture();
		process.stdout.write(fixture.jsonl);
		if (fixture.result.status !== "success") process.exitCode = 1;
		return;
	}
	if (argv[0] === "--public") {
		const acknowledgement = readFlag(argv, "--ack");
		if (acknowledgement !== PUBLIC_NETWORK_ACKNOWLEDGEMENT) {
			throw new Error(`public mode requires --ack ${PUBLIC_NETWORK_ACKNOWLEDGEMENT}`);
		}
		const dhtRequestBudget = parseBoundedInteger(
			readFlag(argv, "--max-requests"),
			"--max-requests",
			1,
			MAX_PUBLIC_REQUESTS
		);
		const durationMs = parseBoundedInteger(readFlag(argv, "--duration-ms"), "--duration-ms", 1, MAX_PUBLIC_DURATION_MS);
		const outputDirectory = readFlag(argv, "--output-directory");
		if (outputDirectory === undefined) {
			throw new Error("--output-directory is required for durable sanitized evidence");
		}
		assertSanitizedEvidenceOutputRoot(outputDirectory);
		await runPublicCanary(dhtRequestBudget, durationMs, outputDirectory);
		return;
	}
	throw new Error(
		"usage: node-routing --fixture | node-routing --public --ack I_ACKNOWLEDGE_PUBLIC_NETWORK_TRAFFIC --max-requests <1..8> --duration-ms <1..30000> --output-directory specs/done/public-network-spike/evidence"
	);
}

async function runPublicCanary(dhtRequestBudget: number, durationMs: number, outputDirectory: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("public canary deadline exceeded")), durationMs);
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const runId = `phase02-${startedAtMs}-${randomBytes(4).toString("hex")}`;
	const namespace = `drp/public-canary/${runId}`;
	let routing: Awaited<ReturnType<typeof createNodeRouting>> | undefined;
	try {
		routing = await createNodeRouting({
			bootstrapPeers: [],
			limits: { maxNetworkRequests: dhtRequestBudget, maxOperations: 6, maxResults: 16 },
			listenAddresses: ["/ip4/0.0.0.0/tcp/0"],
			mode: "client",
			network: "public",
		});
		if (controller.signal.aborted) throw controller.signal.reason;
		await connectToOneBootstrapper(routing, controller.signal);
		await routing.waitForRoutingTable(1, controller.signal);
		const cid = await namespaceCid(namespace);
		const closest = [];
		for await (const peer of routing.getClosestPeers(cid.multihash.bytes, controller.signal)) {
			closest.push(peer);
		}
		const status = await routing.status(controller.signal);
		const finishedAt = new Date().toISOString();
		const artifacts = await createPublicCanaryArtifacts({
			addressScopes: status.addresses.map(({ decision }) => decision.scope),
			closestPeerIds: closest.map(({ peerId }) => peerId),
			dhtRequestBudget,
			dialable: status.dialable,
			finishedAt,
			measurements: [...routing.measurements],
			namespace,
			reachabilityObservations: [...routing.reachabilityObservations],
			routingTableSize: status.routingTableSize,
			runId,
			salt: randomBytes(32),
			startedAt,
		});
		const paths = await writePublicCanaryArtifacts(outputDirectory, artifacts);
		process.stdout.write(`${JSON.stringify({ runId, ...paths })}\n`);
	} finally {
		clearTimeout(timeout);
		await routing?.stop();
	}
}

async function connectToOneBootstrapper(
	routing: Awaited<ReturnType<typeof createNodeRouting>>,
	signal: AbortSignal
): Promise<void> {
	const failures: unknown[] = [];
	for (const address of OFFICIAL_AMINO_BOOTSTRAPPERS) {
		try {
			await routing.connect(address, signal);
			return;
		} catch (error) {
			failures.push(error);
			if (signal.aborted) throw signal.reason;
		}
	}
	throw new AggregateError(failures, "all official Amino bootstrappers failed");
}

function readFlag(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

function parseBoundedInteger(value: string | undefined, name: string, minimum: number, maximum: number): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
	}
	return parsed;
}

void main(process.argv.slice(2));
