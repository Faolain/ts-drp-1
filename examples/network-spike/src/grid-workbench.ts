import {
	createGridBrowserPeer,
	type GridBrowserPeerSession,
	type GridBrowserScenario,
	type GridBrowserTrace,
} from "@ts-drp/network-spike/grid/fixture";

/**
 * @param app - Application root to replace with the grid workbench.
 * @param parameters - Creator/joiner scenario parameters.
 */
export async function renderGridWorkbench(app: HTMLElement, parameters: URLSearchParams): Promise<void> {
	const role = window.location.pathname.endsWith("/joiner") ? "joiner" : "creator";
	const scenario = (parameters.get("scenario") ?? "success") as GridBrowserScenario;
	const run = Number.parseInt(parameters.get("run") ?? "1", 10);
	const objectId = parameters.get("object") ?? undefined;
	const namespace = parameters.get("namespace") ?? undefined;
	const session = await createGridBrowserPeer({
		...(objectId === undefined ? {} : { objectId }),
		...(namespace === undefined ? {} : { namespace }),
		role,
		run: Number.isSafeInteger(run) ? run : 1,
		scenario,
	});
	const trace = session.snapshot();
	render(app, trace);
	enableGridControls(session);
	updateLiveTrace(session.snapshot());
	const refresh = window.setInterval(() => updateLiveTrace(session.snapshot()), 100);
	const target = window as typeof window & { __TS_DRP_GRID_SESSION__?: GridBrowserPeerSession };
	target.__TS_DRP_GRID_SESSION__ = session;
	window.addEventListener(
		"beforeunload",
		() => {
			window.clearInterval(refresh);
			void session.stop();
		},
		{ once: true }
	);
	window.dispatchEvent(new CustomEvent("ts-drp:grid-ready", { detail: trace }));
}

function render(app: HTMLElement, trace: GridBrowserTrace): void {
	const run = Number.parseInt(trace.traceId.split("-").at(-1) ?? "1", 10);
	const joinUrl = `/grid/joiner?scenario=${trace.scenario}&run=${Number.isSafeInteger(run) ? run : 1}&namespace=${encodeURIComponent(trace.namespace)}&object=${encodeURIComponent(trace.objectId)}`;
	const direct = trace.direct;
	app.innerHTML = `
		<section class="grid-demo" data-grid-ready data-role="${trace.role}" data-scenario="${trace.scenario}" data-terminal="${trace.terminal}">
			<header class="grid-demo__nav">
				<a class="grid-demo__brand" href="/grid/creator">
					<span>TS—DRP</span><strong>GRID / 07</strong>
				</a>
				<div class="grid-demo__nav-meta">
					<span>BOOTSTRAP PEERS <b>0</b></span>
					<span>PREAUTH PX <b>OFF</b></span>
					<span class="grid-demo__status">${trace.terminal === "success" ? "LIVE" : "BOUNDED TERMINAL"}</span>
				</div>
			</header>

			<div class="grid-demo__hero">
				<div>
					<p class="grid-demo__eyebrow">${trace.role.toUpperCase()} WORKSPACE / ${trace.traceId}</p>
					<h1>Meet in public.<br><em>Move in sync.</em></h1>
					<p class="grid-demo__lede">No fixed seed. No creator PeerID input. A signed rendezvous record leads to a routing-backed relay reservation, then a measured direct browser path.</p>
				</div>
				<div class="grid-demo__oracle ${trace.terminal === "success" ? "is-pass" : "is-fallback"}">
					<span>TERMINAL ORACLE</span>
					<strong>${trace.terminal === "success" ? "DIRECT" : "EXHAUSTED"}</strong>
					<small>${trace.terminal === "success" ? "WEBRTC DATA CHANNEL OPEN" : `FALLBACK INITIATED ≤ ${Math.ceil(trace.fallbackInitiatedAtMs ?? 0)} MS`}</small>
				</div>
			</div>

			<div class="grid-demo__layout">
				<section class="grid-demo__board-panel">
					<div class="grid-demo__section-head">
						<div><span>01</span><h2>Shared grid</h2></div>
						<p>${trace.role === "creator" ? "Creator" : "Joiner"} controls / WASD or arrows</p>
					</div>
					<div class="grid-demo__board-wrap">
						<div class="grid-demo__board" role="application" aria-label="Playable synchronized grid">
							<div class="grid-demo__axes" aria-hidden="true"></div>
							<div class="grid-demo__axis-x" aria-hidden="true">${axisLabels()}</div>
							<div class="grid-demo__axis-y" aria-hidden="true">${axisLabels(true)}</div>
							<div class="grid-demo__token token-creator ${trace.role === "creator" ? "is-active" : ""}" data-token="creator"><span>C</span>${trace.role === "creator" ? "<small>YOU</small>" : ""}</div>
							<div class="grid-demo__token token-joiner ${trace.role === "joiner" ? "is-active" : ""}" data-token="joiner"><span>J</span>${trace.role === "joiner" ? "<small>YOU</small>" : ""}</div>
							<div class="grid-demo__crosshair" aria-hidden="true"></div>
						</div>
						<div class="grid-demo__controls" aria-label="Grid movement controls">
							<button type="button" data-move="U" aria-label="Move up">↑</button>
							<button type="button" data-move="L" aria-label="Move left">←</button>
							<button type="button" data-move="D" aria-label="Move down">↓</button>
							<button type="button" data-move="R" aria-label="Move right">→</button>
						</div>
					</div>
					<div class="grid-demo__movement-log" data-movement-log>
						${trace.movements.map((movement) => `<span>${movement.actor.slice(0, 1).toUpperCase()} · ${movement.direction} → ${movement.x},${movement.y}</span>`).join("") || "<span>Movement waits for a successful connection.</span>"}
					</div>
				</section>

				<aside class="grid-demo__evidence">
					<div class="grid-demo__section-head">
						<div><span>02</span><h2>Connection proof</h2></div>
					</div>
					<dl class="grid-demo__facts">
						<div><dt>Namespace</dt><dd data-namespace>${trace.namespace}</dd></div>
						<div><dt>Grid object</dt><dd data-object-id>${trace.objectId}</dd></div>
						<div><dt>Creator PeerID inputs</dt><dd data-creator-inputs>${trace.creatorPeerInputFields}</dd></div>
						<div><dt>Record validation</dt><dd data-record-validation>${trace.recordValidation}</dd></div>
						<div><dt>Reservations</dt><dd data-reservations>${trace.relayReservations}</dd></div>
						<div><dt>ICE candidate types</dt><dd data-ice-types>${direct?.iceCandidateTypes.join(" · ") ?? "none"}</dd></div>
						<div><dt>Direct sent / received</dt><dd data-direct-bytes>${direct === undefined ? "0 / 0" : `${direct.directBytesSent} / ${direct.directBytesReceived}`}</dd></div>
						<div><dt>Relayed sent / received</dt><dd>${direct === undefined ? "0 / 0" : `${direct.relayedBytesSent} / ${direct.relayedBytesReceived}`}</dd></div>
					</dl>
					<div class="grid-demo__correlation">
						<span>CORRELATION</span>
						<code>${direct?.connectionId ?? "no-direct-connection"}</code>
						<i>↕</i>
						<code>${direct?.rtcPeerConnectionId ?? "no-rtc-peer-connection"}</code>
					</div>
					${
						trace.role === "creator"
							? `<a class="grid-demo__join" href="${joinUrl}" data-join-url>Open joiner page <span>↗</span></a>`
							: `<a class="grid-demo__join secondary" href="/grid/creator?scenario=${trace.scenario}">New creator session <span>↺</span></a>`
					}
				</aside>
			</div>

			<section class="grid-demo__route">
				<div class="grid-demo__section-head">
					<div><span>03</span><h2>Cold-start provenance</h2></div>
					<p>Every arrow is asserted in order</p>
				</div>
				<ol data-provenance>${trace.provenance.map((step, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><strong>${step}</strong></li>`).join("")}</ol>
			</section>

			<section class="grid-demo__checks">
				${trace.assertions.map((item) => `<article data-assertion="${String(item.passed)}"><span>${item.passed ? "PASS" : "FAIL"}</span><h3>${item.label}</h3><p>${item.value}</p></article>`).join("")}
			</section>
			<output class="grid-demo__raw" data-trace-json hidden>${escapeHtml(JSON.stringify(trace))}</output>
		</section>`;
}

function enableGridControls(session: GridBrowserPeerSession): void {
	const move = async (direction: "D" | "L" | "R" | "U"): Promise<void> => {
		await session.move(direction);
		updateLiveTrace(session.snapshot());
	};
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-move]")) {
		button.addEventListener("click", () => {
			void move(button.dataset.move as "D" | "L" | "R" | "U");
		});
	}
	document.addEventListener("keydown", (event) => {
		const direction = (
			{ ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R", ArrowUp: "U", a: "L", d: "R", s: "D", w: "U" } as const
		)[event.key as "ArrowDown"];
		if (direction !== undefined) void move(direction);
	});
}

function updateLiveTrace(trace: GridBrowserTrace): void {
	for (const role of ["creator", "joiner"] as const) {
		const token = document.querySelector<HTMLElement>(`[data-token="${role}"]`);
		const position = trace.positions[role] ?? { x: 0, y: 0 };
		token?.style.setProperty("--grid-x", String(position.x));
		token?.style.setProperty("--grid-y", String(position.y));
	}
	const raw = document.querySelector<HTMLOutputElement>("[data-trace-json]");
	if (raw !== null) raw.textContent = JSON.stringify(trace);
	const movementLog = document.querySelector<HTMLElement>("[data-movement-log]");
	if (movementLog !== null) {
		movementLog.innerHTML =
			trace.movements
				.map(
					(movement) =>
						`<span>${movement.actor.slice(0, 1).toUpperCase()} · ${movement.direction} → ${movement.x},${movement.y}</span>`
				)
				.join("") || "<span>Movement waits for a successful connection.</span>";
	}
	const directBytes = document.querySelector<HTMLElement>("[data-direct-bytes]");
	if (directBytes !== null) {
		directBytes.textContent =
			trace.direct === undefined ? "0 / 0" : `${trace.direct.directBytesSent} / ${trace.direct.directBytesReceived}`;
	}
	const ice = document.querySelector<HTMLElement>("[data-ice-types]");
	if (ice !== null) ice.textContent = trace.direct?.iceCandidateTypes.join(" · ") ?? "none";
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function axisLabels(vertical = false): string {
	const values = vertical ? [4, 3, 2, 1, 0, -1, -2, -3, -4] : [-4, -3, -2, -1, 0, 1, 2, 3, 4];
	return values.map((value) => `<span>${value}</span>`).join("");
}
