import { createRecordFixture, type RecordFixtureResult } from "@ts-drp/network-spike/record/fixture";

/**
 * Render the deterministic signed-rendezvous-record workbench.
 * @param app Application root that receives the workbench.
 */
export async function renderRecordWorkbench(app: HTMLElement): Promise<void> {
	app.replaceChildren(recordHeader());
	const main = document.createElement("main");
	main.className = "record-shell";
	main.innerHTML = `
		<section class="record-hero">
			<div>
				<p class="eyebrow">SIGNED RENDEZVOUS / PHASE 04 / DETERMINISTIC FIXTURE</p>
				<h1>Trust<br><em>expires.</em></h1>
				<p class="dek">A short-lived peer claim binds one opaque namespace to one libp2p identity, a bounded address set, capabilities, and a monotonic sequence. Admission stays explicit—and separate.</p>
				<button class="primary-action" type="button" data-record-run>Sign + cross-examine <span>↗</span></button>
			</div>
			<div class="record-seal" aria-hidden="true">
				<div><span>V1</span><strong>60</strong><small>SECONDS</small></div>
				<p>CANONICAL<br>ED25519</p>
			</div>
		</section>
		<section class="record-output" data-record-output>
			<p class="delegated-loading">Generating a deterministic identity and canonical payload…</p>
		</section>`;
	app.append(main);
	const output = main.querySelector<HTMLElement>("[data-record-output]");
	if (output === null) throw new Error("missing record output");
	const run = async (): Promise<void> => {
		output.innerHTML = `<p class="delegated-loading">Signing and validating seven bounded cases…</p>`;
		try {
			renderRecordResult(output, await createRecordFixture());
		} catch (error) {
			renderRecordFailure(output, error);
		}
	};
	main.querySelector<HTMLButtonElement>("[data-record-run]")?.addEventListener("click", () => void run());
	await run();
}

function renderRecordResult(output: HTMLElement, result: RecordFixtureResult): void {
	const allPassed = result.cases.every((fixtureCase) => fixtureCase.passed);
	const sanitized = {
		...result,
		record: undefined,
	};
	output.innerHTML = `
		<div class="record-terminal" data-record-status="${allPassed ? "accepted" : "rejected"}">
			<div><span>RECORD VALIDATION</span><strong>${allPassed ? "ACCEPTED" : "REJECTED"}</strong></div>
			<p>${result.peerAlias} controls the signed identity. ${result.namespaceAlias} is bound for ${formatDuration(result.expiresInMs)} under sequence ${result.sequence}.</p>
			<div class="record-terminal-boundary"><strong>NOT MEMBERSHIP</strong><span>NOT DRP-AUTHORIZED</span></div>
		</div>
		<div class="record-trace">
			<span>TRACE <code>${result.traceId}</code></span>
			<span>EVIDENCE <code>${result.evidenceDigest}</code></span>
			<strong>${result.cases.filter((item) => item.passed).length}/${result.cases.length} expected outcomes matched</strong>
		</div>
		<div class="record-metrics" aria-label="Signed record summary">
			${metric("CANONICAL BYTES", String(result.canonicalBytes), "8 KiB hard cap")}
			${metric("TTL", formatDuration(result.expiresInMs), "10–300 s accepted")}
			${metric("SEQUENCE", String(result.sequence), "monotonic per peer")}
			${metric("ADDRESSES", String(result.record.addresses.length), "8 hard cap")}
			${metric("PRIVATE KEY FIELDS", String(result.privateKeyFields), "never serialized")}
		</div>
		<section class="record-pipeline" aria-label="Validation pipeline">
			<p class="section-index">01 / CANONICAL TRUST PIPELINE</p>
			<ol>
				${pipelineStep("01", "Opaque namespace", "versioned · not a room name")}
				${pipelineStep("02", "Canonical payload", `${result.canonicalBytes} UTF-8 bytes`)}
				${pipelineStep("03", "Identity signature", "public key → Peer ID binding")}
				${pipelineStep("04", "Fresh + dialable", "TTL · sequence · DNS recheck")}
				${pipelineStep("05", "Admission", `${result.admission} decision · external policy · not signed`, true)}
			</ol>
		</section>
		<section class="record-cross-exam">
			<div>
				<p class="section-index">02 / ALTERED FIXTURES</p>
				<h2>Every failure keeps its name.</h2>
				<p>Each card is a deterministic oracle, not a generic “invalid record” bucket.</p>
			</div>
			<div class="record-case-grid">
				${result.cases.map(caseCard).join("")}
			</div>
		</section>
		<section class="record-boundary">
			<div>
				<p class="section-index">03 / SECURITY BOUNDARY</p>
				<h2>A signature is not membership.</h2>
			</div>
			<div class="record-boundary-grid">
				${boundary("PROVES", "Key control", "The public key derives the claimed Peer ID and verifies the canonical bytes.")}
				${boundary("LIMITS", "Discovery claim", "Namespace, TTL, sequence, capabilities, record bytes, addresses, and response count are bounded.")}
				${boundary("REQUIRES", "Registry admission", "Invite, allowlist, open, or proof-of-work policy supplies an explicit decision outside the published record.")}
				${boundary("DOES NOT PROVE", "DRP authorization", "Routing and rendezvous results remain untrusted dial candidates until application authorization.")}
			</div>
		</section>
		<section class="record-facts">
			<div><span>DNS POLICY</span><strong>${result.resolverChecks} fixture resolutions</strong><small>rechecked on every validation; private answers rejected</small></div>
			<div><span>CAPABILITIES</span><strong>${result.capabilities.join(" · ")}</strong><small>unknown or missing DRP capability rejected</small></div>
			<div><span>ADMISSION SECRET</span><strong>ABSENT FROM RECORD</strong><small>prevents token disclosure and offline guessing from discovery responses</small></div>
		</section>
		<details class="record-raw">
			<summary>Open redacted fixture evidence</summary>
			<pre>${escapeHtml(JSON.stringify(sanitized, undefined, 2))}</pre>
		</details>`;
}

function renderRecordFailure(output: HTMLElement, error: unknown): void {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	output.innerHTML = `
		<div class="record-terminal record-terminal-failed" data-record-status="rejected">
			<div><span>RECORD VERDICT</span><strong>REJECTED</strong></div>
			<p>${escapeHtml(message)}</p><small>fixture-construction-failed</small>
		</div>`;
}

function recordHeader(): HTMLElement {
	const element = document.createElement("header");
	element.className = "masthead";
	element.innerHTML = `
		<div class="wordmark"><span class="wordmark-index">04</span><span>TS—DRP / SIGNED RECORD LAB</span></div>
		<div class="masthead-meta">
			<span>CANONICAL V1</span>
			<span class="live-dot">NO PUBLIC EGRESS</span>
		</div>`;
	return element;
}

function metric(label: string, value: string, note: string): string {
	return `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
}

function pipelineStep(index: string, label: string, detail: string, external = false): string {
	return `<li class="${external ? "record-pipeline-external" : ""}">${external ? "<b>EXTERNAL POLICY BOUNDARY</b>" : ""}<span>${index}</span><strong>${label}</strong><small>${detail}</small></li>`;
}

function caseCard(item: RecordFixtureResult["cases"][number]): string {
	return `<article data-record-case="${item.code}" data-pass="${String(item.passed)}">
		<span>${item.passed ? `EXPECTED ${item.expected === "accepted" ? "ACCEPTANCE" : "REJECTION"} MATCHED` : "ORACLE MISMATCH"}</span>
		<h3>${escapeHtml(item.label)}</h3>
		<dl><div><dt>Expected</dt><dd><code>${escapeHtml(item.expected)}</code></dd></div><div><dt>Actual</dt><dd><code>${escapeHtml(item.code)}</code></dd></div></dl>
	</article>`;
}

function boundary(kicker: string, title: string, copy: string): string {
	return `<article><span>${kicker}</span><h3>${title}</h3><p>${copy}</p></article>`;
}

function formatDuration(value: number): string {
	return `${Math.round(value / 1_000)} s`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
