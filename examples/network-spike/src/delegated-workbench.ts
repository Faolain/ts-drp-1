import {
	type BrowserRouting,
	BrowserRoutingExhaustedError,
	type BrowserRoutingPeer,
	type BrowserRoutingTrace,
	createBrowserRouting,
	PUBLIC_DELEGATED_ROUTING_ACKNOWLEDGEMENT,
} from "@ts-drp/routing-browser";

const TEST_PEER_ID = "QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN";
const TEST_CID = "bafkreigh2akiscaildcuxp5g4t5s6xrk5g3w7i7xvq5y5u5h5gj5f3f6aa";
const FIXTURE_ORIGIN = "http://127.0.0.1:4175";
const SCENARIOS = [
	"success",
	"cors",
	"cache",
	"cache-disabled",
	"timeout",
	"abort",
	"empty",
	"404",
	"malformed",
	"oversized",
	"poisoned",
	"stale",
	"rate-limit",
	"outage",
	"failover",
] as const;
type Scenario = (typeof SCENARIOS)[number];
type Operation = "closest" | "peer" | "providers";

interface WorkbenchResult {
	error?: string;
	peers: BrowserRoutingPeer[];
	traces: BrowserRoutingTrace[];
}

/**
 * Render and execute the bounded delegated-routing fixture workbench.
 * @param app - Root element that owns the workbench
 * @param parameters - URL parameters selecting fixture, operation, and opt-in mode
 */
export async function renderDelegatedWorkbench(app: HTMLElement, parameters: URLSearchParams): Promise<void> {
	const scenario = parseScenario(parameters.get("fixture"));
	const operation = parseOperation(parameters.get("operation"));
	const publicMode = parameters.get("mode") === "public";
	app.replaceChildren(delegatedHeader(publicMode));
	if (publicMode && parameters.get("ack") !== PUBLIC_DELEGATED_ROUTING_ACKNOWLEDGEMENT) {
		app.append(publicCanaryBlocked());
		return;
	}

	const shell = document.createElement("main");
	shell.className = "delegated-shell";
	shell.innerHTML = `
		<section class="delegated-hero">
			<div>
				<p class="eyebrow">BROWSER ROUTING / PHASE 03 / ${publicMode ? "OPT-IN PUBLIC" : "SEPARATE-ORIGIN FIXTURE"}</p>
				<h1>HTTP routing,<br><em>under glass.</em></h1>
				<p class="dek">Every endpoint attempt is bounded, every address is classified, and publication is absent by construction.</p>
			</div>
			<div class="routing-radar" aria-hidden="true">
				<span></span><span></span><span></span>
				<strong>V1</strong>
			</div>
		</section>
		<section class="delegated-controls" aria-label="Delegated routing controls">
			<label>Fixture
				<select id="routing-fixture" name="routing-fixture" data-scenario>${SCENARIOS.map((value) => `<option${value === scenario ? " selected" : ""}>${value}</option>`).join("")}</select>
			</label>
			<label>Operation
				<select id="routing-operation" name="routing-operation" data-operation>
					${(["peer", "providers", "closest"] as const).map((value) => `<option${value === operation ? " selected" : ""}>${value}</option>`).join("")}
				</select>
			</label>
			<button class="primary-action" type="button" data-run>Run bounded query <span>↗</span></button>
		</section>`;
	app.append(shell);

	const output = document.createElement("section");
	output.className = "delegated-output";
	output.dataset.delegatedOutput = "";
	output.innerHTML = `<p class="delegated-loading">Opening ${scenario} / ${operation}…</p>`;
	shell.append(output);

	const run = async (): Promise<void> => {
		output.innerHTML = `<p class="delegated-loading">Routing ${operation} through ${scenario}…</p>`;
		const result = await runWorkbenchQuery(scenario, operation, parameters, publicMode);
		renderResult(output, scenario, operation, result);
	};
	shell.querySelector<HTMLButtonElement>("[data-run]")?.addEventListener("click", () => void run());
	shell.querySelector<HTMLSelectElement>("[data-scenario]")?.addEventListener("change", updateLocation);
	shell.querySelector<HTMLSelectElement>("[data-operation]")?.addEventListener("change", updateLocation);
	await run();
}

async function runWorkbenchQuery(
	scenario: Scenario,
	operation: Operation,
	parameters: URLSearchParams,
	publicMode: boolean
): Promise<WorkbenchResult> {
	const traces: BrowserRoutingTrace[] = [];
	const controller = new AbortController();
	let routing: BrowserRouting | undefined;
	if (scenario === "abort") setTimeout(() => controller.abort(new DOMException("fixture abort", "AbortError")), 25);
	try {
		routing = createRouting(scenario, parameters, publicMode);
		const peers = await execute(routing, operation, controller.signal);
		if (routing.lastTrace !== undefined) traces.push(routing.lastTrace);
		if (scenario === "cache" || scenario === "cache-disabled" || scenario === "stale") {
			if (scenario === "stale") await delay(45);
			await execute(routing, operation, controller.signal);
			if (routing.lastTrace !== undefined) traces.push(routing.lastTrace);
		}
		return { peers, traces };
	} catch (error) {
		if (routing?.lastTrace !== undefined) traces.push(routing.lastTrace);
		return {
			error:
				error instanceof BrowserRoutingExhaustedError
					? "all delegated endpoints exhausted"
					: error instanceof Error
						? `${error.name}: ${error.message}`
						: String(error),
			peers: [],
			traces,
		};
	} finally {
		await routing?.stop();
	}
}

function createRouting(scenario: Scenario, parameters: URLSearchParams, publicMode: boolean): BrowserRouting {
	let endpoints;
	let allowedOrigins;
	if (publicMode) {
		const endpoint = parameters.get("endpoint");
		if (endpoint === null) throw new Error("public canary requires an explicit endpoint parameter");
		const url = new URL(endpoint);
		endpoints = [{ id: "public", url: url.toString() }];
		allowedOrigins = [url.origin];
	} else {
		endpoints = [
			{ id: "primary", url: `${FIXTURE_ORIGIN}/fixture/${scenario}/primary/` },
			{ id: "secondary", url: `${FIXTURE_ORIGIN}/fixture/${scenario}/secondary/` },
		];
		allowedOrigins = [FIXTURE_ORIGIN];
	}
	return createBrowserRouting({
		allowInsecureLoopback: !publicMode,
		allowedOrigins,
		backoffBaseMs: 15,
		cacheTTLms: scenario === "cache-disabled" ? 0 : scenario === "stale" ? 25 : 2_000,
		endpoints,
		limits: { maxResponseBytes: 2_048, maxResults: 8 },
		resolver: {
			resolve(hostname) {
				return Promise.resolve(hostname === "relay.example" ? ["8.8.8.8"] : []);
			},
		},
		timeoutMs: scenario === "timeout" ? 70 : 800,
	});
}

async function execute(
	routing: BrowserRouting,
	operation: Operation,
	signal: AbortSignal
): Promise<BrowserRoutingPeer[]> {
	if (operation === "peer") return [await routing.findPeer(TEST_PEER_ID, signal)];
	if (operation === "providers") return collect(routing.findProviders(TEST_CID, signal));
	return collect(routing.getClosestPeers(new TextEncoder().encode("phase-03-closest"), signal));
}

function renderResult(output: HTMLElement, scenario: Scenario, operation: Operation, result: WorkbenchResult): void {
	const trace = result.traces.at(-1);
	const terminal = trace?.terminal ?? "exhausted";
	output.innerHTML = `
		<div class="delegated-verdict terminal-${terminal}" data-terminal="${terminal}">
			<span>TERMINAL / ${operation.toUpperCase()}</span>
			<strong>${terminal}</strong>
			<small>${result.error ?? `${result.peers.length} browser-dialable peer${result.peers.length === 1 ? "" : "s"}`}</small>
		</div>
		<div class="delegated-metrics">
			${routingMetric("SCENARIO", scenario, "fixture cell")}
			${routingMetric("CACHE", trace?.cache ?? "—", `${result.traces.length} query trace${result.traces.length === 1 ? "" : "s"}`)}
			${routingMetric("ATTEMPTS", String(trace?.attempts.length ?? 0), "ordered endpoints")}
			${routingMetric("DURATION", `${trace?.durationMs ?? 0} ms`, "wall clock")}
		</div>
		<div class="delegated-grid">
			<section>
				<p class="section-index">01 / ENDPOINT LEDGER</p>
				<h2>Attempt by attempt</h2>
				<div class="attempt-ledger" data-attempts>
					${result.traces.map((item, queryIndex) => traceCard(item, queryIndex)).join("")}
				</div>
			</section>
			<section>
				<p class="section-index">02 / ADDRESS ACCEPTANCE</p>
				<h2>Raw → dialable</h2>
				<div class="address-ledger">
					${result.peers.length === 0 ? `<p class="empty-ledger">No accepted peer records.</p>` : result.peers.map(peerCard).join("")}
				</div>
			</section>
		</div>
		<div class="publication-proof" data-can-provide="false">
			<span>PUBLICATION SURFACE</span>
			<strong>ABSENT</strong>
			<code>canProvide: false</code>
		</div>`;
}

function traceCard(trace: BrowserRoutingTrace, queryIndex: number): string {
	return `<article class="trace-card">
		<header><span>QUERY ${queryIndex + 1}</span><strong>CACHE ${trace.cache.toUpperCase()}</strong></header>
		${
			trace.attempts.length === 0
				? `<p class="cache-hit-row">No network attempt — result served by adapter cache.</p>`
				: trace.attempts
						.map(
							(attempt, index) => `<div class="attempt-row status-${attempt.status}">
					<span>${String(index + 1).padStart(2, "0")}</span>
					<strong>${attempt.endpointId}</strong>
					<em>${attempt.status}</em>
					<small>${attempt.httpStatus ?? "fetch"} · ${attempt.durationMs} ms${attempt.retryAfterMs === undefined ? "" : ` · retry ${attempt.retryAfterMs} ms`}</small>
				</div>`
						)
						.join("")
		}
	</article>`;
}

function peerCard(peer: BrowserRoutingPeer): string {
	return `<article class="peer-card">
		<header><span>PEER</span><code>${peer.peerId.slice(0, 12)}…${peer.peerId.slice(-6)}</code></header>
		${peer.addressDecisions
			.map(
				({ address, decision }) => `<div class="address-row ${decision.dialable ? "accepted" : "rejected"}">
					<span>${decision.dialable ? "ACCEPT" : "REJECT"}</span>
					<code>${address}</code>
					<small>${decision.dialable ? decision.transports.join(" + ") : decision.reasons.join(", ")}</small>
				</div>`
			)
			.join("")}
	</article>`;
}

function delegatedHeader(publicMode: boolean): HTMLElement {
	const element = document.createElement("header");
	element.className = "masthead";
	element.innerHTML = `
		<div class="wordmark"><span class="wordmark-index">03</span><span>TS—DRP / DELEGATED ROUTING</span></div>
		<div class="masthead-meta">
			<span>CHROMIUM · FIREFOX · WEBKIT</span>
			<span class="live-dot">${publicMode ? "PUBLIC ACKNOWLEDGED" : "LOCAL FIXTURE"}</span>
		</div>`;
	return element;
}

function publicCanaryBlocked(): HTMLElement {
	const element = document.createElement("section");
	element.className = "not-found";
	element.innerHTML = `
		<p class="eyebrow">PUBLIC CANARY / BLOCKED</p>
		<h1>Explicit consent<br><em>required.</em></h1>
		<p>Supply an HTTPS <code>endpoint</code>, a target, and <code>ack=${PUBLIC_DELEGATED_ROUTING_ACKNOWLEDGEMENT}</code>. No request was made.</p>
		<a href="/delegated?fixture=success">Return to the local fixture</a>`;
	return element;
}

function routingMetric(label: string, value: string, note: string): string {
	return `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

function parseScenario(value: string | null): Scenario {
	return SCENARIOS.includes(value as Scenario) ? (value as Scenario) : "success";
}

function parseOperation(value: string | null): Operation {
	return value === "providers" || value === "closest" ? value : "peer";
}

function updateLocation(): void {
	const scenario = document.querySelector<HTMLSelectElement>("[data-scenario]")?.value ?? "success";
	const operation = document.querySelector<HTMLSelectElement>("[data-operation]")?.value ?? "peer";
	window.location.assign(
		`/delegated?fixture=${encodeURIComponent(scenario)}&operation=${encodeURIComponent(operation)}`
	);
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
	const output: T[] = [];
	for await (const value of input) output.push(value);
	return output;
}

function delay(durationMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}
