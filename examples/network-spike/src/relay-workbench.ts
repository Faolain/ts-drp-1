import { RELAY_TRANSPORT_PROFILES } from "@ts-drp/network-spike/relay";
import {
	createRelayFixture,
	type RelayFixtureAttempt,
	type RelayFixtureResult,
	type RelayFixtureScenario,
} from "@ts-drp/network-spike/relay/fixture";

const SCENARIOS: ReadonlyArray<{ label: string; value: RelayFixtureScenario }> = [
	{ label: "Mixed field", value: "mixed" },
	{ label: "All refused", value: "all-refused" },
	{ label: "Stale fallback", value: "stale-fallback" },
];

/**
 * Renders the Phase 06 relay policy evidence lab.
 * @param app - Application root receiving the workbench.
 * @param parameters - Scenario and transport-profile query parameters.
 */
export async function renderRelayWorkbench(app: HTMLElement, parameters: URLSearchParams): Promise<void> {
	const initialScenario = parseScenario(parameters.get("scenario"));
	const initialProfile = parameters.get("profile") === "wss-only" ? "wss-only" : "broad-browser";
	app.replaceChildren(relayHeader());
	const main = document.createElement("main");
	main.className = "relay-shell";
	main.innerHTML = hero(initialScenario, initialProfile);
	app.append(main);
	const output = document.createElement("section");
	output.className = "relay-output";
	main.append(output);
	enableControls(output);
	await runFixture(output, initialScenario, initialProfile);
}

function relayHeader(): HTMLElement {
	const element = document.createElement("header");
	element.className = "masthead relay-masthead";
	element.innerHTML = `
		<div class="wordmark"><span class="wordmark-index">06</span><span>TS—DRP / RELAY POLICY INSTRUMENT</span></div>
		<nav class="relay-nav" aria-label="Network spike phases">
			<a href="/rendezvous">REGISTRY</a>
			<a href="/anchor">ANCHOR</a>
			<a href="/relay" aria-current="page">RELAY</a>
		</nav>
		<div class="masthead-meta"><span class="live-dot">LOCAL ROUTING FIXTURE</span><span>NO PUBLIC EGRESS</span></div>`;
	return element;
}

function hero(scenario: RelayFixtureScenario, profile: "broad-browser" | "wss-only"): string {
	return `
		<section class="relay-hero">
			<div class="relay-hero-copy">
				<p class="eyebrow">OPPORTUNISTIC RELAY / RESERVATION ≠ ADVERTISEMENT</p>
				<h1>Ask the wire.<br><em>Keep the exit.</em></h1>
				<p class="dek">Routing proposes a bounded candidate set. The policy dials, identifies HOP, decodes the actual reservation response, enforces operator diversity, and rotates before the owned fallback.</p>
			</div>
			<div class="relay-control-deck" aria-label="Relay fixture controls">
				<div>
					<span>SCENARIO</span>
					<div class="relay-segmented">
						${SCENARIOS.map(
							(item) =>
								`<button type="button" data-relay-scenario="${item.value}" aria-pressed="${String(item.value === scenario)}">${item.label}</button>`
						).join("")}
					</div>
				</div>
				<div>
					<span>TRANSPORT PROFILE</span>
					<div class="relay-segmented">
						<button type="button" data-relay-profile="broad-browser" aria-pressed="${String(profile === "broad-browser")}">WSS + WT + WebRTC</button>
						<button type="button" data-relay-profile="wss-only" aria-pressed="${String(profile === "wss-only")}">WSS only</button>
					</div>
				</div>
				<button class="relay-run" type="button" data-relay-run>RUN BOUNDED POLICY <span>↗</span></button>
			</div>
		</section>`;
}

async function runFixture(
	output: HTMLElement,
	scenario: RelayFixtureScenario,
	profile: "broad-browser" | "wss-only"
): Promise<void> {
	output.innerHTML = `<div class="relay-loading"><span></span><p>Querying the closest-peer seam, then decoding reservation status…</p></div>`;
	try {
		const result = await createRelayFixture(
			scenario,
			profile === "wss-only" ? RELAY_TRANSPORT_PROFILES.wssOnly : RELAY_TRANSPORT_PROFILES.broadBrowser
		);
		renderResult(output, result);
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		output.innerHTML = `<section class="relay-verdict relay-verdict-failed" data-relay-terminal="failure"><span>FIXTURE FAILURE</span><strong>${escapeHtml(message)}</strong></section>`;
	}
}

function renderResult(output: HTMLElement, result: RelayFixtureResult): void {
	const assertionCount = result.assertions.filter(({ passed }) => passed).length;
	const accepted = result.terminal === "reserved";
	output.innerHTML = `
		<section class="relay-verdict relay-verdict-${result.terminal}" data-relay-terminal="${result.terminal}">
			<div><span>TERMINAL / ${result.scenario.toUpperCase()}</span><strong>${terminalLabel(result.terminal)}</strong></div>
			<p>${terminalDescription(result)}</p>
			<div class="relay-verdict-metrics">
				${verdictMetric("ASSERTIONS", `${assertionCount}/${result.assertions.length}`, "deterministic")}
				${verdictMetric("RESERVATIONS", String(result.reservationCount), "actual status = 100")}
				${verdictMetric("OPERATOR GROUPS", String(result.operatorGroups.length), "aggregate only")}
				${verdictMetric("FIXTURE RUN", formatDuration(result.fixtureLatencyMs), "local sample")}
			</div>
			<b class="${accepted ? "relay-status-go" : "relay-status-caution"}">${accepted ? "DIVERSITY CONTRACT MET" : "PUBLIC PATH NOT BASELINE-READY"}</b>
		</section>
		<section class="relay-provenance">
			<span>TRACE <code>${result.traceId}</code></span>
			<span>SOURCE <code>browser-closest-peers</code></span>
			<span>PROFILE <code>${result.transportProfile}</code></span>
			<span>PRIVATE IDS <strong>${result.privateIdentifierFields}</strong></span>
		</section>
		<section class="relay-pipeline">
			<div class="relay-section-heading">
				<div><p class="section-index">01 / POLICY PIPELINE</p><h2>Support is only the middle.</h2></div>
				<p>Every row preserves routing query/result provenance. A green HOP observation cannot produce a reservation without an independently decoded <code>STATUS=100</code> and live expiry.</p>
			</div>
			<div class="relay-stage-key" aria-label="Relay attempt stages">
				<span>ROUTING CANDIDATE</span><i>→</i><span>DIAL</span><i>→</i><span>IDENTIFY</span><i>→</i><span>HOP</span><i>→</i><span>RESERVE</span>
			</div>
			<ol class="relay-attempt-list">${result.attempts.map((attempt, index) => attemptRow(attempt, index)).join("")}</ol>
		</section>
		<section class="relay-bounds">
			<div><p class="section-index">02 / ONE LIFECYCLE OWNER</p><h2>Pressure has edges.</h2></div>
			<div class="relay-bound-grid">
				${boundCard(String(result.limits.maxCandidates), "CANDIDATE CAP", "Routing cannot enqueue an unbounded relay list.", "max-candidates")}
				${boundCard(String(result.limits.maxConcurrentReservations), "CONCURRENT RESERVATIONS", "Surplus successes are released, never retained.", "max-concurrent-reservations")}
				${boundCard(`${result.limits.maxPerOperatorGroup} / GROUP`, "DIVERSITY CAP", `${result.limits.requiredReservations} reservations require ${result.limits.requiredOperatorGroups} coarse operator groups.`, "max-per-operator-group")}
				${boundCard(`${result.limits.perCandidateDeadlineMs.toLocaleString()} ms`, "CANDIDATE DEADLINE", "A literal race covers clients that ignore AbortSignal.", "per-candidate-deadline-ms")}
				${boundCard(`${result.limits.totalDeadlineMs.toLocaleString()} ms`, "TOTAL DEADLINE", "Public search and owned fallback share this budget.", "total-deadline-ms")}
				${boundCard(`${result.limits.ownedFallbackDeadlineMs.toLocaleString()} ms`, "OWNED FALLBACK", "Accepted only with a live, freshly resolved expiry.", "owned-fallback-deadline-ms")}
			</div>
		</section>
		<section class="relay-assertions">
			<div><p class="section-index">03 / FIXTURE ASSERTIONS</p><h2>What this run actually proves.</h2></div>
			<div>${result.assertions.map(assertionCard).join("")}</div>
		</section>
		<section class="relay-boundary">
			<strong>OVERFLOW VERDICT ONLY</strong>
			<p>This local fixture does not claim public relay availability, authorization, ASN truth, or stable cross-run latency. Public candidates are overflow; the owned relay remains the ordinary path until the opt-in campaign proves otherwise.</p>
		</section>
		<details class="relay-raw">
			<summary>Open sanitized relay evidence</summary>
			<pre>${escapeHtml(JSON.stringify(result, undefined, 2))}</pre>
		</details>`;
}

function attemptRow(attempt: RelayFixtureAttempt, index: number): string {
	const hopState = attempt.hopAdvertised ? "observed" : "absent";
	const reservationState =
		attempt.reservationStatus === undefined
			? "not sent"
			: attempt.reservationStatus === 100
				? "status 100"
				: `status ${attempt.reservationStatus}`;
	return `<li data-relay-attempt="${attempt.candidateAlias}" data-relay-status="${attempt.status}">
		<span class="relay-attempt-index">${String(index + 1).padStart(2, "0")}</span>
		<div class="relay-attempt-name"><strong>${attempt.candidateAlias}</strong><small>${attempt.operatorGroup} · result ${attempt.resultIndex}</small></div>
		<div class="relay-attempt-stage"><span>TRANSPORT</span><strong>${attempt.transport}</strong></div>
		<div class="relay-attempt-stage"><span>HOP</span><strong>${hopState}</strong></div>
		<div class="relay-attempt-stage"><span>RESERVATION</span><strong>${reservationState}</strong></div>
		<b class="relay-attempt-outcome relay-outcome-${attempt.status}">${attempt.status.replaceAll("-", " ")}</b>
		<code title="${attempt.queryDigest}">${attempt.queryDigest}</code>
	</li>`;
}

function terminalLabel(terminal: RelayFixtureResult["terminal"]): string {
	if (terminal === "reserved") return "RESERVED × 2";
	if (terminal === "owned-fallback") return "OWNED FALLBACK";
	if (terminal === "exhausted") return "EXHAUSTED";
	return "ABORTED";
}

function terminalDescription(result: RelayFixtureResult): string {
	if (result.terminal === "reserved") {
		return "Two live reservation responses survived the transport, HOP, expiry, and coarse operator-diversity gates.";
	}
	if (result.terminal === "owned-fallback") {
		return "Every public candidate failed; a fresh owned DNSADDR became the typed terminal path.";
	}
	return "Neither public reservations nor a fresh owned fallback met the policy contract.";
}

function verdictMetric(label: string, value: string, note: string): string {
	return `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

function boundCard(value: string, label: string, note: string, key: string): string {
	return `<article data-relay-bound="${key}" data-relay-bound-value="${escapeHtml(value)}"><strong>${value}</strong><span>${label}</span><p>${note}</p></article>`;
}

function assertionCard(item: RelayFixtureResult["assertions"][number]): string {
	return `<article data-relay-assertion="${escapeHtml(item.label)}" data-pass="${String(item.passed)}">
		<span>${item.passed ? "MATCH" : "MISMATCH"}</span><strong>${escapeHtml(item.label)}</strong>
		<dl><div><dt>EXPECTED</dt><dd>${escapeHtml(item.expected)}</dd></div><div><dt>ACTUAL</dt><dd>${escapeHtml(item.actual)}</dd></div></dl>
	</article>`;
}

function enableControls(output: HTMLElement): void {
	const scenarioButtons = document.querySelectorAll<HTMLButtonElement>("[data-relay-scenario]");
	const profileButtons = document.querySelectorAll<HTMLButtonElement>("[data-relay-profile]");
	const run = document.querySelector<HTMLButtonElement>("[data-relay-run]");
	const choose = (buttons: NodeListOf<HTMLButtonElement>, selected: HTMLButtonElement): void => {
		for (const button of buttons) button.setAttribute("aria-pressed", String(button === selected));
	};
	for (const button of scenarioButtons) button.addEventListener("click", () => choose(scenarioButtons, button));
	for (const button of profileButtons) button.addEventListener("click", () => choose(profileButtons, button));
	run?.addEventListener("click", () => {
		const scenario = document.querySelector<HTMLButtonElement>("[data-relay-scenario][aria-pressed=true]");
		const profile = document.querySelector<HTMLButtonElement>("[data-relay-profile][aria-pressed=true]");
		if (scenario === null || profile === null) return;
		const scenarioValue = parseScenario(scenario.dataset.relayScenario ?? null);
		const profileValue = profile.dataset.relayProfile === "wss-only" ? "wss-only" : "broad-browser";
		const parameters = new URLSearchParams({ profile: profileValue, scenario: scenarioValue });
		window.history.replaceState({}, "", `/relay?${parameters}`);
		void runFixture(output, scenarioValue, profileValue);
	});
}

function parseScenario(value: string | null): RelayFixtureScenario {
	return value === "all-refused" || value === "stale-fallback" ? value : "mixed";
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1) return "< 1 ms";
	if (durationMs < 10) return "1–10 ms";
	if (durationMs < 100) return "10–100 ms";
	return "≥ 100 ms";
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
