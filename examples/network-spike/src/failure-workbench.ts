import {
	assertFailureCampaign,
	type FailureCampaignReport,
	type FailureCategory,
	runFailureCampaign,
} from "@ts-drp/network-spike/failure-campaign";

const categoryOrder: readonly FailureCategory[] = [
	"routing",
	"relay",
	"registry",
	"record",
	"control-plane",
	"composed",
];

/**
 * Renders the deterministic Phase 08 campaign report.
 * @param app - Application root.
 */
export async function renderFailureWorkbench(app: HTMLElement): Promise<void> {
	const report = await runFailureCampaign();
	assertFailureCampaign(report);
	app.innerHTML = `
		<main class="failure-lab" data-failure-ready data-total="${report.summary.total}" data-passed="${report.summary.passed}">
			<header class="failure-lab__nav">
				<a href="/failure-campaign" class="failure-lab__brand"><span>TS—DRP</span><strong>FAILURE / 08</strong></a>
				<div><span>DETERMINISTIC FIXTURE</span><span class="failure-lab__egress">LOCAL FIXTURE ONLY</span></div>
			</header>

			<section class="failure-lab__hero">
				<div>
					<p>FAULT CAMPAIGN / COMPLETE TELEMETRY / ZERO LEAKS</p>
					<h1>Break every dependency.<br><em>Keep every promise.</em></h1>
					<p class="failure-lab__lede">Twenty-four hostile schedules run through the same probe and grid-control owners. Passing means a typed recovery or terminal, a hard deadline, capped work, complete cleanup, and nothing left alive.</p>
				</div>
				<div class="failure-lab__stamp">
					<span>CAMPAIGN TERMINAL</span>
					<strong>${report.summary.passed}/${report.summary.total}</strong>
					<small>OWNER-DRIVEN ROWS</small>
				</div>
			</section>

			<section class="failure-lab__budget" aria-label="Composed deadline budget">
				${budgetCells(report)}
				<div class="failure-lab__budget-total"><span>ONE PARENT</span><strong>${formatInteger(report.parentDeadlineMs)} ms</strong></div>
			</section>

			<section class="failure-lab__summary">
				<div><span>SCENARIOS</span><strong>${report.summary.total}</strong><small>registered rows</small></div>
				<div><span>TYPED TERMINALS</span><strong>${new Set(report.scenarios.map(({ terminal }) => terminal)).size}</strong><small>distinct outcomes</small></div>
				<div><span>TELEMETRY KINDS</span><strong>${report.telemetryCoverage.length}</strong><small>strict schemas</small></div>
				<div><span>LEAKED WORK</span><strong>${leakedWork(report)}</strong><small>timers · handles · refresh</small></div>
			</section>

			<section class="failure-lab__matrix">
				<header>
					<div><span>01</span><h2>Failure matrix</h2></div>
					<p>EXPECTED ≠ ASSUMED / EVERY CHECK DERIVED</p>
				</header>
				<nav class="failure-lab__matrix-nav" aria-label="Failure categories">
					${categoryOrder.map((category) => `<a href="#failure-${category}">${category.replace("-", " ")}</a>`).join("")}
				</nav>
				${categoryOrder.map((category) => categorySection(report, category)).join("")}
			</section>

			<section class="failure-lab__composed">
				<div>
					<span>COMPOSED WORST CASE</span>
					<h2>All dependencies down.</h2>
					<p>Registry, delegated routing, public relay search, owned DNSADDR fallback, and control health each consume only their registered slice. No child restarts the parent.</p>
				</div>
				${composedOracle(report)}
			</section>

			<section class="failure-lab__telemetry">
				<header><span>02</span><h2>Observed vocabulary</h2></header>
				<div>${report.telemetryCoverage.map((kind) => `<code>${kind}</code>`).join("")}</div>
				<p>${productionReconnectDisclosure(report)}</p>
			</section>
			<output data-failure-json hidden>${escapeHtml(JSON.stringify(report))}</output>
		</main>`;
}

function categorySection(report: FailureCampaignReport, category: FailureCategory): string {
	const rows = report.scenarios.filter((row) => failureCategory(report, row.id) === category);
	return `
		<section class="failure-lab__group" id="failure-${category}" data-category="${category}">
			<div class="failure-lab__group-label"><span>${String(categoryOrder.indexOf(category) + 1).padStart(2, "0")}</span><h3>${category.replace("-", " ")}</h3><b>${rows.length}</b></div>
			<div class="failure-lab__rows">${rows.map((row) => scenarioCard(row, report.scenarios.indexOf(row) + 1)).join("")}</div>
		</section>`;
}

function failureCategory(report: FailureCampaignReport, id: string): FailureCategory {
	if (!report.scenarios.some((row) => row.id === id)) {
		throw new Error(`failure category missing for ${id}`);
	}
	if (id === "all-dependencies-down") return "composed";
	if (id.startsWith("control-")) return "control-plane";
	if (id.startsWith("delegated")) return "routing";
	if (id.startsWith("record-")) return "record";
	if (id.startsWith("registry-")) return "registry";
	return "relay";
}

function scenarioCard(row: FailureCampaignReport["scenarios"][number], index: number): string {
	return `
		<article data-scenario="${row.id}" data-terminal="${row.terminal}" data-verdict="${row.passed ? "pass" : "fail"}">
			<div class="failure-lab__row-index">${String(index).padStart(2, "0")}</div>
			<div><h4>${row.label}</h4><code>${row.id}</code></div>
			<div class="failure-lab__terminal"><span>TERMINAL</span><strong>${row.terminal.replaceAll("-", " ")}</strong></div>
			<div class="failure-lab__row-metrics">
				<span><small>ELAPSED</small>${row.durationMs} ms</span>
				<span><small>ATTEMPT / BACKOFF</small>${row.attempts}A / ${row.backoffs}B</span>
				<span><small>CLEANUP</small>${row.cleanup.completed}/${row.cleanup.registered} CLEAN</span>
			</div>
			<b>${row.passed ? "PASS" : "FAIL"}</b>
		</article>`;
}

function budgetCells(report: FailureCampaignReport): string {
	const row = composedRow(report);
	const labels = {
		"owned-fallback": "Owned fallback",
		"registry-and-routing": "Registry + routing",
		"relay-search": "Relay search",
	} as const;
	const childBudgetMs = row.childBudgets.reduce((sum, { budgetMs }) => sum + budgetMs, 0);
	const cleanupBudgetMs = report.parentDeadlineMs - childBudgetMs;
	if (cleanupBudgetMs <= 0) throw new Error("composed cleanup budget missing");
	const budgets = [
		...row.childBudgets.map(({ budgetMs, owner }) => ({ budgetMs, label: labels[owner] })),
		{ budgetMs: cleanupBudgetMs, label: "Terminal cleanup" },
	];
	return budgets
		.map(({ budgetMs, label }, index) =>
			budget(String(index + 1).padStart(2, "0"), label, budgetMs, report.parentDeadlineMs)
		)
		.join("");
}

function budget(index: string, label: string, milliseconds: number, parentDeadlineMs: number): string {
	const width = `${((milliseconds / parentDeadlineMs) * 100).toFixed(1)}%`;
	return `<div class="failure-lab__budget-cell" style="--budget-width:${width}"><span>${index}</span><strong>${label}</strong><b>${milliseconds / 1_000}s</b><i></i></div>`;
}

function composedOracle(report: FailureCampaignReport): string {
	const row = composedRow(report);
	const resources = finalResources(row);
	return `<dl>
		<div><dt>Terminal</dt><dd>${row.terminal}</dd></div>
		<div><dt>Elapsed</dt><dd>${row.durationMs} ms</dd></div>
		<div><dt>Attempt / backoff cap</dt><dd>${row.attempts} / ${row.backoffs}</dd></div>
		<div><dt>Cleanup</dt><dd>${row.cleanup.completed}/${row.cleanup.registered} · ${row.cleanup.failed} failed</dd></div>
		<div><dt>Final resources</dt><dd>${resources.activeTimers} timers · ${resources.openHandles} handles</dd></div>
		<div><dt>Control health</dt><dd>${row.controlPlaneHealth.state} · ${row.controlPlaneHealth.reconnectAttempts} attempt</dd></div>
		<div><dt>Verdict</dt><dd class="is-pass">${row.passed ? "PASS" : "FAIL"}</dd></div>
	</dl>`;
}

function composedRow(report: FailureCampaignReport): FailureCampaignReport["scenarios"][number] {
	const row = report.scenarios.find(({ id }) => id === "all-dependencies-down");
	if (row === undefined) throw new Error("composed outage evidence missing");
	return row;
}

function finalResources(row: FailureCampaignReport["scenarios"][number]): {
	readonly activeTimers: number;
	readonly openHandles: number;
} {
	const sample = row.events.findLast(({ kind }) => kind === "resource-sample");
	if (sample?.kind !== "resource-sample") throw new Error(`final resource evidence missing for ${row.id}`);
	return sample.details;
}

function leakedWork(report: FailureCampaignReport): number {
	return report.scenarios.reduce((total, row) => {
		const resources = finalResources(row);
		return total + resources.activeTimers + resources.openHandles;
	}, 0);
}

function formatInteger(value: number): string {
	return new Intl.NumberFormat("en-US").format(value).replaceAll(",", " ");
}

function productionReconnectDisclosure(report: FailureCampaignReport): string {
	if (!report.scenarios.every(({ controlPlaneHealth }) => controlPlaneHealth.productionReconnectRedesignUnshipped)) {
		throw new Error("production reconnect ownership disclosure missing");
	}
	return "Spike-only typed reconnect adapter. Production reconnect redesign remains unshipped; see the archived production follow-up plan.";
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
