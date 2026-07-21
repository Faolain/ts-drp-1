import { createEnvironmentBlockedCampaignReport } from "@ts-drp/network-spike/public-campaign";

/**
 * Renders the sanitized Phase 09 launch-clearance report.
 * @param app - Application root.
 */
export function renderPublicCampaignWorkbench(app: HTMLElement): void {
	const report = createEnvironmentBlockedCampaignReport();
	const nodeRows = report.plannedMatrix.rows.filter(({ target }) => target === "node");
	const browserRows = report.plannedMatrix.rows.filter(({ target }) => target === "browser");
	app.innerHTML = `
		<main class="public-board" data-public-campaign-ready data-status="${report.status}" data-public-requests="${report.publicRequests}">
			<header class="public-board__nav">
				<a href="/public-campaign"><b>TS—DRP</b><span>PUBLIC CAMPAIGN / 09</span></a>
				<div><span>LAUNCH CLEARANCE</span><strong>NO PUBLIC EGRESS</strong></div>
			</header>

			<section class="public-board__hero">
				<div class="public-board__hero-copy">
					<p>ISSUE 05 / EXTERNAL PROTOCOL MATRIX</p>
					<h1>Ready to measure.<br><em>Not cleared to launch.</em></h1>
					<p>The campaign machinery is bounded and reproducible. Execution remains deliberately blocked until the operator supplies all three public-network authorizations.</p>
				</div>
				<div class="public-board__seal" aria-label="Environment blocked">
					<span>CRITERION</span>
					<strong>UNSATISFIED</strong>
					<small>ENVIRONMENT BLOCKED</small>
				</div>
			</section>

			<section class="public-board__numbers" aria-label="Campaign budget">
				${numberCell("800", "fresh identities", "200 Node · 600 browser")}
				${numberCell("06", "grid canaries", "one per browser / condition")}
				${numberCell(format(report.requestBudget.hardCap), "request ceiling", "computed before consent")}
				${numberCell("00", "public requests", "this committed artifact")}
			</section>

			<section class="public-board__clearance">
				<header><span>01 / LAUNCH INTERLOCKS</span><h2>Three keys. All required.</h2></header>
				<div>
					${report.requiredInputs
						.map(
							(item, index) => `
								<article data-clearance="${item.code}" data-satisfied="${item.satisfied}">
									<span>${String(index + 1).padStart(2, "0")}</span>
									<div><h3>${clearanceTitle(item.code)}</h3><p>${item.message}</p></div>
									<b>OPEN</b>
								</article>`
						)
						.join("")}
				</div>
			</section>

			<section class="public-board__matrix">
				<header><span>02 / FROZEN MATRIX</span><h2>Real conditions, cold identities.</h2></header>
				<div class="public-board__matrix-grid">
					<div class="public-board__matrix-copy">
						<p>Browser emulation does not count as a network condition. Every transport cell is balanced before the first request and serialized behind one cooldown gate.</p>
						<dl>
							<div><dt>Node cells</dt><dd>${nodeRows.length}</dd></div>
							<div><dt>Browser cells</dt><dd>${browserRows.length}</dd></div>
							<div><dt>Transport split</dt><dd>50 / 50</dd></div>
							<div><dt>Concurrency</dt><dd>01</dd></div>
						</dl>
						<ol class="public-board__flow" aria-label="Campaign sealing sequence">
							<li><span>01</span>clear all interlocks</li>
							<li><span>02</span>mint cold identities</li>
							<li><span>03</span>serialize owner requests</li>
							<li><span>04</span>seal only complete coverage</li>
						</ol>
					</div>
					<div class="public-board__matrix-table" role="table" aria-label="Frozen public campaign matrix">
						<div role="row"><b>Target</b><b>Condition</b><b>Profile</b><b>N</b></div>
						${report.plannedMatrix.rows
							.map(
								(row) => `
									<div role="row">
										<span>${row.target === "node" ? "Node" : `${row.browser} ${row.target === "grid-canary" ? "canary" : "browser"}`}</span>
										<span>${row.condition.replaceAll("-", " ")}</span>
										<span>${row.transportProfile?.replaceAll("-", " ") ?? (row.target === "grid-canary" ? "Phase 07 canary" : "Amino DHT")}</span>
										<strong>${row.identities}</strong>
									</div>`
							)
							.join("")}
					</div>
					<div class="public-board__mobile-matrix" aria-label="Frozen public campaign matrix, mobile summary">
						${report.plannedMatrix.rows
							.filter(({ target }) => target === "node")
							.map(
								(nodeRow) => `
									<section>
										<h3>${nodeRow.condition.replaceAll("-", " ")}</h3>
										<div><b>Node / Amino DHT</b><span>${nodeRow.identities} cold identities</span></div>
										${report.plannedMatrix.rows
											.filter(
												(row) =>
													row.target === "browser" &&
													row.condition === nodeRow.condition &&
													row.transportProfile === "wss-only"
											)
											.map(
												(row) => `
													<div>
														<b>${row.browser}</b>
														<span>50 WSS-only · 50 WSS + WT + WebRTC Direct<br>1 Phase 07 canary</span>
													</div>`
											)
											.join("")}
									</section>`
							)
							.join("")}
					</div>
				</div>
			</section>

			<section class="public-board__rule">
				<div><span>ANTI-CHEAT RULE</span><h2>Missing evidence stays missing.</h2></div>
				<p>${report.note}</p>
			</section>
			<output data-public-campaign-json hidden>${escapeHtml(JSON.stringify(report))}</output>
		</main>`;
}

function numberCell(value: string, label: string, note: string): string {
	return `<div><strong>${value}</strong><span>${label}</span><small>${note}</small></div>`;
}

function clearanceTitle(code: "explicit-consent" | "independent-registries" | "second-real-egress"): string {
	switch (code) {
		case "explicit-consent":
			return "Operator consent + terms review";
		case "independent-registries":
			return "Two independent signed registries";
		case "second-real-egress":
			return "Second real egress / NAT";
	}
}

function format(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
