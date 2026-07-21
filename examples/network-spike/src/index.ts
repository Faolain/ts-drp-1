import {
	type AllRefusedFixture,
	type ProbeEvent,
	type ProbeEventKind,
	runAllRefusedFixture,
} from "@ts-drp/network-spike/probe";

import { renderBrowserDhtWorkbench } from "./browser-dht-workbench.js";
import { renderDelegatedWorkbench } from "./delegated-workbench.js";
import { renderFailureWorkbench } from "./failure-workbench.js";
import { renderGridWorkbench } from "./grid-workbench.js";
import { renderPublicCampaignWorkbench } from "./public-campaign-workbench.js";
import { renderPublicOnlyBrowserWorkbench } from "./public-only-browser-workbench.js";
import { renderRecordWorkbench } from "./record-workbench.js";
import { renderRegistryWorkbench } from "./registry-workbench.js";
import { renderRelayWorkbench } from "./relay-workbench.js";
import "./styles.css";

type Filter = "all" | "relay" | "control" | "terminal";

const appElement = document.querySelector<HTMLElement>("#app");
if (appElement === null) throw new Error("missing application root");
const app: HTMLElement = appElement;

performance.mark("evidence-load-start");
void boot();

async function boot(): Promise<void> {
	const parameters = new URLSearchParams(window.location.search);
	if (window.location.pathname === "/public-only-browser") {
		await renderPublicOnlyBrowserWorkbench(app);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/public-campaign") {
		renderPublicCampaignWorkbench(app);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/failure-campaign") {
		await renderFailureWorkbench(app);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname.startsWith("/grid")) {
		await renderGridWorkbench(app, parameters);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/relay") {
		await renderRelayWorkbench(app, parameters);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/rendezvous" || window.location.pathname === "/anchor") {
		await renderRegistryWorkbench(app, window.location.pathname === "/anchor" ? "anchor" : "rendezvous");
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/record") {
		await renderRecordWorkbench(app);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/browser-dht") {
		await renderBrowserDhtWorkbench(app);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	if (window.location.pathname === "/delegated") {
		await renderDelegatedWorkbench(app, parameters);
		performance.mark("evidence-render-end");
		performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
		return;
	}
	const fixtureName = parameters.get("fixture") ?? "all-refused";
	if (window.location.pathname !== "/evidence" || fixtureName !== "all-refused") {
		renderNotFound(fixtureName);
		return;
	}
	const fixture = await runAllRefusedFixture();
	renderEvidence(fixture);
	performance.mark("evidence-render-end");
	performance.measure("evidence-first-render", "evidence-load-start", "evidence-render-end");
	const renderMeasure = performance.getEntriesByName("evidence-first-render").at(-1);
	const metric = document.querySelector<HTMLElement>("[data-render-duration]");
	if (metric !== null && renderMeasure !== undefined) metric.textContent = `${renderMeasure.duration.toFixed(1)} ms`;
}

function renderEvidence(fixture: AllRefusedFixture): void {
	const reservations = fixture.events.filter((event) => event.kind === "relay-reservation");
	const cleanup = fixture.events.findLast((event) => event.kind === "cleanup");
	app.replaceChildren(header(), summary(fixture, reservations.length, cleanup), workspace(fixture), footer(fixture));
	enableFilters(fixture.events);
	enableReplay();
}

function header(): HTMLElement {
	const element = document.createElement("header");
	element.className = "masthead";
	element.innerHTML = `
		<div class="wordmark" aria-label="ts-drp network spike">
			<span class="wordmark-index">05</span>
			<span>TS—DRP / FIELD INSTRUMENT</span>
		</div>
		<div class="masthead-meta">
			<span>DETERMINISTIC REPLAY</span>
			<span>NO PUBLIC EGRESS</span>
			<span class="live-dot">CAPTURE COMPLETE</span>
		</div>`;
	return element;
}

function summary(fixture: AllRefusedFixture, reservationCount: number, cleanup: ProbeEvent | undefined): HTMLElement {
	const cleanupCompleted =
		cleanup?.kind === "cleanup" && cleanup.details.phase === "finish"
			? `${cleanup.details.completed}/${cleanup.details.registered}`
			: "—";
	const element = document.createElement("section");
	element.className = "hero";
	element.innerHTML = `
		<div class="hero-copy">
			<p class="eyebrow">EVIDENCE / RELAY EXHAUSTION / FIXTURE 01</p>
			<h1>Every refusal<br><em>leaves a trace.</em></h1>
			<p class="dek">A bounded replay of four relay candidates, one owned-fallback decision, and a typed terminal outcome. The raw network never participates.</p>
			<div class="hero-actions">
				<button class="primary-action" type="button" data-replay>Replay sequence <span>↗</span></button>
				<a href="#jsonl">Inspect JSONL <span>↓</span></a>
			</div>
		</div>
		<div class="terminal-stamp" aria-label="Expected terminal failure">
			<span class="stamp-kicker">TERMINAL / EXPECTED</span>
			<strong>REFUSED</strong>
			<span>OWNED FALLBACK SIGNALLED</span>
		</div>
		<div class="metric-rack" aria-label="Fixture summary">
			${metric("EVENTS", String(fixture.events.length), "strict ordered rows")}
			${metric("CANDIDATES", String(reservationCount), "hard bounded")}
			${metric("CLEANUP", cleanupCompleted, "registered work")}
			${metric("RENDER", "measuring", "instrumented", "data-render-duration")}
		</div>`;
	return element;
}

function metric(label: string, value: string, note: string, attribute = ""): string {
	return `<div class="metric"><span>${label}</span><strong ${attribute}>${value}</strong><small>${note}</small></div>`;
}

function workspace(fixture: AllRefusedFixture): HTMLElement {
	const element = document.createElement("section");
	element.className = "evidence-workspace";
	const controls = document.createElement("div");
	controls.className = "timeline-controls";
	controls.innerHTML = `
		<div>
			<p class="section-index">01 / ORDERED TELEMETRY</p>
			<h2>Candidate → terminal</h2>
		</div>
		<div class="filters" role="group" aria-label="Filter timeline">
			${filterButton("all", "All", true)}
			${filterButton("relay", "Relay")}
			${filterButton("control", "Control")}
			${filterButton("terminal", "Terminal")}
		</div>`;

	const timeline = document.createElement("ol");
	timeline.className = "timeline";
	timeline.dataset.timeline = "";
	for (const event of fixture.events) timeline.append(eventCard(event));

	const aside = document.createElement("aside");
	aside.className = "run-ledger";
	aside.innerHTML = `
		<div class="ledger-heading">
			<span>RUN LEDGER</span>
			<code>fixture-all-refused</code>
		</div>
		<dl>
			<div><dt>Parent budget</dt><dd>30 000 ms</dd></div>
			<div><dt>Candidate set</dt><dd>4 / 4 refused</dd></div>
			<div><dt>Backoff</dt><dd>100 · 200 · 400</dd></div>
			<div><dt>Fallback delay</dt><dd>700 ms</dd></div>
			<div><dt>Raw identifiers</dt><dd>0 persisted</dd></div>
			<div><dt>Active handles</dt><dd>0 terminal</dd></div>
		</dl>
		<div class="ledger-note">
			<span aria-hidden="true">✳</span>
			<p><strong>Interpretation</strong>This is a failure fixture, not a network availability claim. Refusal is the expected proof.</p>
		</div>`;

	const grid = document.createElement("div");
	grid.className = "workspace-grid";
	const timelinePanel = document.createElement("div");
	timelinePanel.className = "timeline-panel";
	timelinePanel.append(controls, timeline);
	grid.append(timelinePanel, aside);
	element.append(grid);
	return element;
}

function eventCard(event: ProbeEvent): HTMLLIElement {
	const category = eventCategory(event.kind);
	const item = document.createElement("li");
	item.className = `event-card event-${category} event-kind-${event.kind}`;
	item.dataset.category = category;
	item.style.setProperty("--event-order", String(event.sequence));

	const index = document.createElement("span");
	index.className = "event-sequence";
	index.textContent = String(event.sequence).padStart(2, "0");

	const marker = document.createElement("span");
	marker.className = "event-marker";
	marker.setAttribute("aria-hidden", "true");

	const body = document.createElement("div");
	body.className = "event-body";
	const heading = document.createElement("div");
	heading.className = "event-heading";
	const kind = document.createElement("strong");
	kind.textContent = event.kind.replaceAll("-", " ");
	const time = document.createElement("time");
	time.textContent = `T+${String(event.atMs).padStart(4, "0")} ms`;
	heading.append(kind, time);

	const details = document.createElement("p");
	details.className = "event-details";
	details.textContent = summarizeEvent(event);
	body.append(heading, details);
	item.append(index, marker, body);
	return item;
}

function summarizeEvent(event: ProbeEvent): string {
	switch (event.kind) {
		case "relay-candidate":
			return `${event.details.candidatePseudonym} · ${event.details.source} / ${event.details.provenance}`;
		case "relay-hop-support":
			return `${event.details.candidatePseudonym} · HOP ${event.details.supported ? "advertised" : "absent"}`;
		case "dial-attempt":
			return `${event.details.addressPseudonym} · ${event.details.family} / ${event.details.transport} · attempt ${event.details.attempt}`;
		case "dial-result":
			return `${event.details.addressPseudonym} · ${event.details.outcome} in ${event.details.latencyMs} ms`;
		case "relay-reservation":
			return `${event.details.candidatePseudonym} · reservation ${event.details.outcome} · ${event.details.latencyMs} ms`;
		case "endpoint-backoff":
			return `${event.details.endpointClass} · ${event.details.delayMs} ms before attempt ${event.details.attempt + 1}`;
		case "fallback":
			return `${event.details.from} exhausted · ${event.details.to} after ${event.details.delayMs} ms`;
		case "cleanup":
			return `${event.details.phase} · ${event.details.completed}/${event.details.registered} completed · ${event.details.failed} failed`;
		case "resource-sample":
			return `${event.details.openHandles} handles · ${event.details.activeTimers} active timers`;
		case "terminal":
			return `${event.details.status} · ${event.details.reason} · ${event.details.durationMs} ms`;
		case "redaction":
			return "Peer IDs and namespaces use per-run pseudonyms · diversity remains aggregate-only";
		default:
			return JSON.stringify(event.details);
	}
}

function eventCategory(kind: ProbeEventKind): Exclude<Filter, "all"> {
	if (kind.startsWith("relay-") || kind === "dial-attempt" || kind === "dial-result") return "relay";
	if (kind === "terminal" || kind === "fallback") return "terminal";
	return "control";
}

function filterButton(filter: Filter, label: string, active = false): string {
	return `<button type="button" data-filter="${filter}" aria-pressed="${String(active)}">${label}</button>`;
}

function enableFilters(events: readonly ProbeEvent[]): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>("[data-filter]");
	const cards = document.querySelectorAll<HTMLElement>(".event-card");
	for (const button of buttons) {
		button.addEventListener("click", () => {
			const filter = button.dataset.filter as Filter;
			for (const candidate of buttons) candidate.setAttribute("aria-pressed", String(candidate === button));
			for (const card of cards) {
				card.hidden = filter !== "all" && card.dataset.category !== filter;
			}
			const visibleCount = events.filter((event) => filter === "all" || eventCategory(event.kind) === filter).length;
			document
				.querySelector<HTMLElement>("[data-timeline]")
				?.setAttribute("aria-label", `${visibleCount} visible events`);
		});
	}
}

function enableReplay(): void {
	document.querySelector<HTMLButtonElement>("[data-replay]")?.addEventListener("click", () => {
		const timeline = document.querySelector<HTMLElement>("[data-timeline]");
		if (timeline === null) return;
		timeline.classList.remove("is-replaying");
		void timeline.offsetWidth;
		timeline.classList.add("is-replaying");
	});
}

function footer(fixture: AllRefusedFixture): HTMLElement {
	const element = document.createElement("section");
	element.className = "raw-evidence";
	element.id = "jsonl";
	const heading = document.createElement("div");
	heading.innerHTML = `
		<p class="section-index">02 / DURABLE ARTIFACT</p>
		<h2>Replayable JSONL</h2>
		<p>Every line passes its kind-specific strict schema. Sequence gaps are rejected.</p>`;
	const details = document.createElement("details");
	const summary = document.createElement("summary");
	summary.textContent = `Open ${fixture.events.length} sanitized rows`;
	const pre = document.createElement("pre");
	pre.textContent = fixture.jsonl;
	details.append(summary, pre);
	element.append(heading, details);
	return element;
}

function renderNotFound(fixtureName: string): void {
	const section = document.createElement("section");
	section.className = "not-found";
	const heading = document.createElement("h1");
	heading.textContent = "Fixture not registered.";
	const copy = document.createElement("p");
	copy.textContent = `"${fixtureName}" is not part of the bounded replay catalog.`;
	const link = document.createElement("a");
	link.href = "/evidence?fixture=all-refused";
	link.textContent = "Open all-refused fixture";
	section.append(heading, copy, link);
	app.replaceChildren(section);
}
