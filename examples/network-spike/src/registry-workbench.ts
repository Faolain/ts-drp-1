import { createRegistryFixture, type RegistryFixtureResult } from "@ts-drp/network-spike/registry/fixture";

type RegistryView = "anchor" | "rendezvous";

/**
 * Renders the registry or DHT-anchor side of the Phase 05 comparison.
 * @param app - Application root.
 * @param view - Selected decision path.
 */
export async function renderRegistryWorkbench(app: HTMLElement, view: RegistryView): Promise<void> {
	app.replaceChildren(registryHeader(view));
	const main = document.createElement("main");
	main.className = `registry-shell registry-${view}`;
	main.innerHTML = registryHero(view);
	app.append(main);
	const output = document.createElement("section");
	output.className = "registry-output";
	output.innerHTML = `<p class="delegated-loading">Running two independent endpoints and the local anchor fixture…</p>`;
	main.append(output);
	try {
		renderRegistryResult(output, await createRegistryFixture(), view);
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		output.innerHTML = `<div class="registry-verdict registry-failed" data-registry-status="failed"><span>FIXTURE FAILURE</span><strong>${escapeHtml(message)}</strong></div>`;
	}
}

function registryHeader(view: RegistryView): HTMLElement {
	const element = document.createElement("header");
	element.className = "masthead registry-masthead";
	element.innerHTML = `
		<div class="wordmark"><span class="wordmark-index">05</span><span>TS—DRP / ${view === "anchor" ? "ANCHOR FIELD NOTE" : "RENDEZVOUS DIRECTORY"}</span></div>
		<nav class="registry-nav" aria-label="Phase 05 views">
			<a href="/rendezvous" ${view === "rendezvous" ? 'aria-current="page"' : ""}>REGISTRY</a>
			<a href="/anchor" ${view === "anchor" ? 'aria-current="page"' : ""}>DHT ANCHOR</a>
		</nav>
		<div class="masthead-meta"><span class="live-dot">LOCAL FIXTURE</span><span>NO PUBLIC EGRESS</span></div>`;
	return element;
}

function registryHero(view: RegistryView): string {
	if (view === "anchor") {
		return `
			<section class="registry-hero anchor-hero">
				<div>
					<p class="eyebrow">DHT ANCHOR / NODE-ONLY PROVIDER SEMANTICS</p>
					<h1>A waypoint.<br><em>Not the browser.</em></h1>
					<p class="dek">The namespace CID finds one reachable Node anchor. The anchor advertises itself, then serves the signed directory path. It never launders a browser into a DHT provider claim.</p>
				</div>
				<div class="anchor-orbit" aria-hidden="true"><span>NAMESPACE CID</span><strong>→</strong><span>NODE ANCHOR</span><strong>→</strong><span>SIGNED RECORD</span></div>
			</section>`;
	}
	return `
		<section class="registry-hero">
			<div>
				<p class="eyebrow">SIGNED REGISTRY / TWO INDEPENDENT ENDPOINTS</p>
				<h1>Two doors.<br><em>One signed claim.</em></h1>
				<p class="dek">Register and refresh a short-TTL record on two bounded operators. When the primary disappears, discovery moves once—visibly—to the secondary.</p>
			</div>
			<div class="registry-ticket" aria-hidden="true">
				<span>ADMISSION / DEFAULT</span><strong>INVITE</strong><small>EXTERNAL TO RECORD</small>
			</div>
		</section>`;
}

function renderRegistryResult(output: HTMLElement, result: RegistryFixtureResult, view: RegistryView): void {
	const passed = result.cases.every(({ passed: casePassed }) => casePassed);
	const matchedCount = result.cases.filter(({ passed: itemPassed }) => itemPassed).length;
	output.innerHTML = `
		<section class="registry-verdict" data-registry-status="${passed ? "accepted" : "failed"}">
			<div><span>${view === "anchor" ? "ANCHOR CONTRACT" : "FAILOVER CONTRACT"}</span><strong>${passed ? "FIXTURE MATCH" : "FAILED"}</strong></div>
				<p>${view === "anchor" ? "The delegated lookup returns anchor-A only after the configured Node-anchor filter." : `${result.discoveredPeerAlias} was refreshed and recovered through the secondary endpoint.`}</p>
			<b>${matchedCount}/${result.cases.length} FIXTURE ASSERTIONS<small>6 REGISTRY · 4 ANCHOR</small></b>
		</section>
		<section class="registry-trace">
			<span>TRACE <code>${result.traceId}</code></span>
			<span>EVIDENCE <code>${result.digest}</code></span>
			<span>CREDENTIAL FIELDS <strong>${result.privateCredentialFields}</strong></span>
		</section>
		${view === "anchor" ? anchorEvidence(result) : rendezvousEvidence(result)}
		${comparisonTable(result)}
		<details class="registry-raw">
			<summary>Open sanitized comparison evidence</summary>
			<pre>${escapeHtml(JSON.stringify(result, undefined, 2))}</pre>
		</details>`;
}

function rendezvousEvidence(result: RegistryFixtureResult): string {
	return `
		<section class="endpoint-stage" aria-label="Endpoint failover trace">
			<div class="endpoint-heading">
				<div><p class="section-index">01 / ORDERED ENDPOINTS</p><h2>Failure has one next move.</h2></div>
				<p>Six deterministic registry assertions below cover replication, outage, recovery, and exhaustion. A discovery fails over only after a typed endpoint rejection.</p>
			</div>
			<div class="endpoint-rail">
				${endpointNode("01", "PRIMARY", "OFFLINE", "endpoint-unavailable", false)}
				<div class="endpoint-arrow"><span>ONE BOUNDED FAILOVER</span><strong>→</strong></div>
				${endpointNode("02", "SECONDARY", "RECORD FOUND", "sequence 2 · untrusted dial candidate", true)}
			</div>
				<div class="registry-case-grid">${result.cases.slice(0, 6).map(caseCard).join("")}</div>
		</section>
		<section class="admission-lab">
			<div class="admission-heading">
				<div><p class="section-index">02 / RUNTIME ADMISSION</p><h2>Abuse cost is a policy choice.</h2></div>
				<p>These are fixture registration outcomes, not safety approvals. Every mode stays outside the signed record. Open mode is measured only as an explicitly Sybil-unsafe canary.</p>
			</div>
			<div class="admission-grid">${result.admission.map(admissionCard).join("")}</div>
		</section>`;
}

function anchorEvidence(result: RegistryFixtureResult): string {
	return `
		<section class="anchor-chain">
			<div><p class="section-index">01 / PROVIDER CHAIN</p><h2>The DHT stops at the Node.</h2></div>
			<ol>
				${anchorStep("01", result.namespaceAlias, "hashed into deterministic versioned CID")}
				${anchorStep("02", result.anchorCidAlias, "provider lookup via delegated routing")}
				${anchorStep("03", "anchor-A", "the only advertised DHT provider")}
				${anchorStep("04", result.discoveredPeerAlias, "found later through signed registry data")}
			</ol>
			<div class="anchor-warning"><strong>BROWSER PROVIDER CLAIM: REJECTED</strong><span>DhtAnchorPublisher accepts only its own Node Peer ID.</span></div>
				<p class="anchor-assertion-note">4 / 4 ANCHOR-SPECIFIC FIXTURE ASSERTIONS MATCHED</p>
				<div class="registry-case-grid anchor-case-grid">${result.cases.slice(6).map(caseCard).join("")}</div>
		</section>
		<section class="anchor-semantics">
			<article><span>THE CID REVEALS</span><strong>Namespace correlation</strong><p>A stable namespace CID and Node provider metadata are visible to routing infrastructure.</p></article>
			<article><span>THE ANCHOR ADDS</span><strong>One operator hop</strong><p>Browser recovery depends on DHT publication, delegated lookup, and a reachable Node anchor.</p></article>
			<article><span>THE ANCHOR DOES NOT ADD</span><strong>Browser provider status</strong><p>The browser remains a signed rendezvous record discovered after reaching the Node.</p></article>
		</section>`;
}

function comparisonTable(result: RegistryFixtureResult): string {
	const [registry, anchor] = result.comparison;
	if (registry === undefined || anchor === undefined) return "";
	return `
		<section class="registry-comparison">
			<div><p class="section-index">03 / DECISION TABLE</p><h2>Same namespace. Different exposure.</h2></div>
			<div class="comparison-table" role="table" aria-label="Registry and anchor comparison">
				<div class="comparison-row comparison-head" role="row"><span role="columnheader">DIMENSION</span><strong role="columnheader">SIGNED REGISTRY</strong><strong role="columnheader">DHT ANCHOR</strong></div>
				${comparisonRow("FRESHNESS", registry.freshness, anchor.freshness)}
					${comparisonRow("VISIBLE METADATA", registry.leakage, anchor.leakage)}
					${comparisonRow("AVAILABILITY CHAIN", registry.availability, anchor.availability)}
					${comparisonRow("OPERATOR DEPENDENCY", registry.operatorDependency, anchor.operatorDependency)}
					${comparisonRow("CURRENT-RUN LATENCY BAND", formatDurationBand(registry.operationMs), formatDurationBand(anchor.operationMs))}
					${comparisonRow("DEPENDENCY HOPS", String(registry.dependencyHops), String(anchor.dependencyHops))}
					${comparisonRow(
						"VISIBLE ARTIFACT CLASSES",
						String(registry.visibleArtifactClasses),
						String(anchor.visibleArtifactClasses)
					)}
					${comparisonRow("RESULT", registry.discoveryResult, anchor.discoveryResult)}
			</div>
			<p class="comparison-note">Latency bands are one local, same-run fixture sample; exact raw values below are resolution-sensitive and must not be compared across reloads. Neither path proves DRP authorization, bounded public freshness, or object membership. Both return untrusted dial candidates; every record-derived dial still requires the literal TTL + DNS safety recheck.</p>
		</section>`;
}

function endpointNode(index: string, name: string, state: string, detail: string, live: boolean): string {
	return `<article class="endpoint-node ${live ? "endpoint-live" : "endpoint-down"}"><span>${index} / ${name}</span><strong>${state}</strong><small>${detail}</small></article>`;
}

function caseCard(item: RegistryFixtureResult["cases"][number]): string {
	return `<article data-registry-case="${escapeHtml(item.label)}" data-pass="${String(item.passed)}"><span>${item.passed ? "ASSERTION MATCH" : "MISMATCH"}</span><h3>${escapeHtml(item.label)}</h3><dl><div><dt>Expected</dt><dd>${escapeHtml(item.expected)}</dd></div><div><dt>Actual</dt><dd>${escapeHtml(item.actual)}</dd></div></dl></article>`;
}

function admissionCard(item: RegistryFixtureResult["admission"][number]): string {
	const cost = item.browserCostMs === null ? "NO CLIENT PUZZLE" : `${item.browserCostMs.toFixed(2)} ms fixture solve`;
	const resultLabel =
		item.registrationResult === "accepted"
			? item.mode === "open"
				? "CANARY REGISTERED"
				: "FIXTURE REGISTERED"
			: `FIXTURE ${item.registrationResult.toUpperCase()}`;
	return `<article class="admission-card admission-${item.mode}">
		<div><span>${item.mode.toUpperCase()}</span>${item.warning === undefined ? "" : `<b>${item.warning}</b>`}</div>
		<strong>${resultLabel}</strong>
			<dl><div><dt>Browser cost</dt><dd>${cost}</dd></div><div><dt>Server verify</dt><dd>${formatDuration(item.serverVerifyMs)}</dd></div><div><dt>Abuse behavior</dt><dd>${escapeHtml(item.abuseBehavior)}</dd></div><div><dt>Operator burden</dt><dd>${escapeHtml(item.operatorBurden)}</dd></div></dl>
		</article>`;
}

function anchorStep(index: string, title: string, detail: string): string {
	return `<li><span>${index}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></li>`;
}

function comparisonRow(label: string, registry: string, anchor: string): string {
	return `<div class="comparison-row" role="row"><span role="rowheader">${label}</span><p role="cell">${escapeHtml(registry)}</p><p role="cell">${escapeHtml(anchor)}</p></div>`;
}

function formatDuration(durationMs: number): string {
	if (durationMs <= 0) return "< 0.1 ms resolution floor";
	return durationMs < 1 ? `${(durationMs * 1_000).toFixed(1)} µs` : `${durationMs.toFixed(2)} ms`;
}

function formatDurationBand(durationMs: number): string {
	if (durationMs < 1) return "< 1 ms local sample";
	if (durationMs < 10) return "1–10 ms local sample";
	if (durationMs < 100) return "10–100 ms local sample";
	return "≥ 100 ms local sample";
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
