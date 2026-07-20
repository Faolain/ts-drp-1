import {
	BROWSER_DHT_PACKAGE_VERSIONS,
	type BrowserDhtVerdict,
	runBrowserDhtExperiment,
} from "@ts-drp/network-spike/browser-dht";

import bundleEvidence from "./browser-dht-bundle-evidence.json" with { type: "json" };

const HEALTH_URL = "http://127.0.0.1:4177/health";

interface FixtureHealth {
	address: string;
	status: "ready";
}

/**
 * Render the local browser-DHT feasibility workbench.
 * @param app Application root that receives the workbench.
 * @returns A promise that settles after the first probe renders.
 */
export async function renderBrowserDhtWorkbench(app: HTMLElement): Promise<void> {
	app.replaceChildren(browserDhtHeader());
	const shell = document.createElement("main");
	shell.className = "browser-dht-shell";
	shell.innerHTML = `
		<section class="browser-dht-hero">
			<div>
				<p class="eyebrow">BROWSER DHT / PHASE 03B / LOCAL WEBSOCKET FIXTURE</p>
				<h1>A full DHT,<br><em>cross-examined.</em></h1>
				<p class="dek">Two browser hosts construct Amino DHT clients, dial a local server, perform peer lookup, and attempt provider publication. Usable inbound dialability decides the verdict.</p>
				<button class="primary-action" type="button" data-dht-run>Run feasibility probe <span>↗</span></button>
			</div>
			<div class="dht-orbit" aria-hidden="true">
				<span></span><span></span><span></span>
				<strong>KAD</strong>
			</div>
		</section>
		<section class="browser-dht-output" data-dht-output>
			<p class="delegated-loading">Constructing two isolated browser DHT hosts…</p>
		</section>`;
	app.append(shell);
	const output = shell.querySelector<HTMLElement>("[data-dht-output]");
	if (output === null) throw new Error("missing browser DHT output");
	const run = async (): Promise<void> => {
		output.innerHTML = `<p class="delegated-loading">Dialing local WebSocket DHT fixture…</p>`;
		try {
			const fixture = await readFixture();
			const verdict = await runBrowserDhtExperiment({ fixtureAddress: fixture.address });
			renderVerdict(output, verdict);
		} catch (error) {
			renderFixtureFailure(output, error);
		}
	};
	shell.querySelector<HTMLButtonElement>("[data-dht-run]")?.addEventListener("click", () => void run());
	await run();
}

async function readFixture(): Promise<FixtureHealth> {
	const response = await fetch(HEALTH_URL, { cache: "no-store", credentials: "omit" });
	if (!response.ok) throw new Error(`fixture health returned HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (
		typeof value !== "object" ||
		value === null ||
		Reflect.get(value, "status") !== "ready" ||
		typeof Reflect.get(value, "address") !== "string"
	) {
		throw new Error("fixture health response was malformed");
	}
	return value as FixtureHealth;
}

function renderVerdict(output: HTMLElement, verdict: BrowserDhtVerdict): void {
	const reason = verdict.status === "rejected" ? verdict.reason : "all feasibility checks passed";
	const detail = verdict.status === "rejected" ? verdict.detail : "publication resolved to a browser-dialable provider";
	const engine = browserEngine(verdict.browser);
	const engineLabel = document.querySelector<HTMLElement>("[data-browser-engine]");
	if (engineLabel !== null) engineLabel.textContent = engine;
	output.innerHTML = `
		<div class="dht-terminal terminal-${verdict.status}" data-dht-status="${verdict.status}" data-dht-reason="${reason}">
			<span>FEASIBILITY VERDICT</span>
			<strong>${verdict.status}</strong>
			<small>${escapeHtml(reason)}</small>
		</div>
		<div class="dht-run-stamp" aria-label="Run identity and bounds">
			<span>RUN <code>${formatRunId(verdict.run.id)}</code></span>
			<time datetime="${escapeHtml(verdict.run.startedAt)}">${escapeHtml(verdict.run.startedAt)}</time>
			<span>${escapeHtml(engine)} · completed ${verdict.resources.wallTimeMs} ms · ${verdict.run.timeoutMs} ms protocol cap</span>
		</div>
		<div class="dht-metric-rack">
			${dhtMetric("CONSTRUCT", yesNo(verdict.checks.construction), "two browser hosts")}
			${dhtMetric("LOOKUP", yesNo(verdict.checks.peerLookup), "Amino peer query")}
			${dhtMetric("PROVIDE RPC", yesNo(verdict.checks.providerRpcCompleted), "response observed")}
			${dhtMetric("DIALABLE ADDRS", String(verdict.transport.dialableProviderAddresses.length), "publication criterion")}
			${dhtMetric("WALL TIME", `${verdict.resources.wallTimeMs} ms`, "bounded local run")}
		</div>
		<section class="dht-run-trace" aria-label="Run-bound event ledger">
			<div>
				<p class="section-index">RUN-BOUND EVENT LEDGER</p>
				<strong>${formatRunId(verdict.run.id)}</strong>
			</div>
			<ol>
				${verdict.run.steps.map((step) => `<li><time>T+${step.atMs.toFixed(1)} ms</time><strong>${escapeHtml(step.kind)}</strong>${traceFacts(step.detail)}</li>`).join("")}
			</ol>
		</section>
		<section class="dht-finding">
			<div>
				<p class="section-index">01 / DECISION</p>
				<h2>RPC success is not reachability.</h2>
			</div>
			<div>
				<p>${escapeHtml(detail)}</p>
				<p class="source-rule"><strong>Installed source rule</strong> @libp2p/kad-dht@${verdict.packageVersions.kadDht} <code>add-provider.ts</code> returns without storing provider records whose multiaddr list is empty.</p>
			</div>
		</section>
		<details class="dht-raw">
			<summary>Open run-bound typed verdict and exact versions</summary>
			<pre>${escapeHtml(JSON.stringify(verdict, undefined, 2))}</pre>
		</details>
		<div class="dht-ledgers">
			<section>
				<p class="section-index">02 / PROTOCOL CHECKS</p>
				<h2>Observed path</h2>
				${checkRow("Host construction", verdict.checks.construction)}
				${checkRow("Fixture connection", verdict.checks.bootstrapConnected)}
				${checkRow("DHT peer lookup", verdict.checks.peerLookup)}
				${checkRow("ADD_PROVIDER response", verdict.checks.providerRpcCompleted)}
				${checkRow("Provider query completed", verdict.checks.providerQueryCompleted)}
				${checkRow("Provider observed", verdict.checks.providerObserved)}
			</section>
			<section data-bundle-forbidden-count="${bundleEvidence.forbiddenInputs.length}">
				<p class="section-index">03 / RESOURCE + TRANSPORT</p>
				<h2>Browser constraints</h2>
				<dl class="dht-facts">
					${fact("Mode", verdict.dhtMode)}
					${fact("Engine", engine)}
					${fact("Fixture scope", "single local routing peer · feasibility only, not DHT scale")}
					${fact("Packages", `kad-dht ${verdict.packageVersions.kadDht} · libp2p ${verdict.packageVersions.libp2p}`)}
					${fact("Standalone bundle", `${formatBytes(bundleEvidence.bytes)} · ${formatBytes(bundleEvidence.gzipBytes)} gzip · ${bundleEvidence.inputCount} inputs`)}
					${fact("Forbidden imports", `${bundleEvidence.forbiddenInputs.length} · ${bundleEvidence.verification}`)}
					${fact("Transport", verdict.transport.constraint)}
					${fact("Listen addresses", String(verdict.transport.browserListenAddresses.length))}
					${fact("Publisher routing peers", String(verdict.routingTable.publisherPeers))}
					${fact("Observer routing peers", String(verdict.routingTable.observerPeers))}
					${fact("Runtime transfer", `${formatBytes(verdict.resources.loadedTransferBytes)} · Resource Timing · excludes WebSocket frames`)}
					${fact("JS heap", heapEvidence(verdict))}
					${fact("CPU proxy", cpuEvidence(verdict))}
				</dl>
			</section>
		</div>`;
}

function renderFixtureFailure(output: HTMLElement, error: unknown): void {
	const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	const evidence = {
		browser: navigator.userAgent,
		bundleEvidence,
		detail,
		packageVersions: BROWSER_DHT_PACKAGE_VERSIONS,
		reason: "fixture-unreachable" as const,
		status: "rejected" as const,
	};
	output.innerHTML = `
		<div class="dht-terminal terminal-rejected" data-dht-status="rejected" data-dht-reason="fixture-unreachable">
			<span>FEASIBILITY VERDICT</span>
			<strong>REJECTED</strong>
			<small>fixture-unreachable</small>
		</div>
		<section class="dht-finding">
			<div><p class="section-index">LOCAL FIXTURE PREFLIGHT</p><h2>The experiment could not start.</h2></div>
			<div><p>${escapeHtml(detail)}</p><p>Package and bundle versions remain attached so this is a reproducible typed rejection, not a blank error state.</p></div>
		</section>
		<details class="dht-raw">
			<summary>Open typed fixture rejection and exact versions</summary>
			<pre>${escapeHtml(JSON.stringify(evidence, undefined, 2))}</pre>
		</details>`;
}

function browserDhtHeader(): HTMLElement {
	const element = document.createElement("header");
	element.className = "masthead";
	element.innerHTML = `
		<div class="wordmark"><span class="wordmark-index">3B</span><span>TS—DRP / FULL DHT VERDICT</span></div>
		<div class="masthead-meta">
			<span data-browser-engine>CURRENT ENGINE</span>
			<span class="live-dot">LOCAL ONLY</span>
		</div>`;
	return element;
}

function dhtMetric(label: string, value: string, note: string): string {
	return `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

function checkRow(label: string, value: boolean): string {
	return `<div class="dht-check" data-check="${label.toLowerCase().replaceAll(" ", "-")}" data-pass="${String(value)}">
		<span>${value ? "PASS" : "FAIL"}</span><strong>${label}</strong><small>${value ? "observed" : "not observed"}</small>
	</div>`;
}

function traceFacts(detail: string): string {
	const facts = detail.split("; ").map((factValue) => {
		const separator = factValue.indexOf("=");
		if (separator === -1) return `<span>${escapeHtml(factValue)}</span>`;
		const label = factValue.slice(0, separator);
		const value = factValue.slice(separator + 1);
		return `<span><b>${escapeHtml(label)}</b><code title="${escapeHtml(value)}">${escapeHtml(compactAuditValue(value))}</code></span>`;
	});
	return `<div class="dht-trace-facts">${facts.join("")}</div>`;
}

function compactAuditValue(value: string): string {
	if (value.length <= 26) return value;
	return `${value.slice(0, 12)}…${value.slice(-9)}`;
}

function fact(label: string, value: string): string {
	return `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function yesNo(value: boolean): string {
	return value ? "YES" : "NO";
}

function formatBytes(value: number): string {
	return value < 1_024 ? `${value} B` : `${(value / 1_024).toFixed(1)} KiB`;
}

function browserEngine(userAgent: string): string {
	const firefox = /Firefox\/([\d.]+)/.exec(userAgent);
	if (firefox !== null) return `Firefox ${firefox[1]}`;
	const chromium = /(?:Chrome|Chromium)\/([\d.]+)/.exec(userAgent);
	if (chromium !== null) return `Chromium ${chromium[1]}`;
	const webkit = /Version\/([\d.]+).*Safari\//.exec(userAgent);
	if (webkit !== null) return `WebKit ${webkit[1]}`;
	return "unknown browser engine";
}

function heapEvidence(verdict: BrowserDhtVerdict): string {
	if (verdict.resources.heap.status === "unavailable") return verdict.resources.heap.reason;
	const deltaMiB = verdict.resources.heap.deltaBytes / (1_024 * 1_024);
	return `performance.memory · Δ ${deltaMiB >= 0 ? "+" : ""}${deltaMiB.toFixed(2)} MiB used JS heap`;
}

function cpuEvidence(verdict: BrowserDhtVerdict): string {
	if (verdict.resources.cpu.status === "unavailable") return verdict.resources.cpu.reason;
	return `Long Tasks API · ${verdict.resources.cpu.longTaskDurationMs.toFixed(1)} ms main-thread long tasks`;
}

function formatRunId(value: string): string {
	return escapeHtml(value).replaceAll("-", "-<wbr>");
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
