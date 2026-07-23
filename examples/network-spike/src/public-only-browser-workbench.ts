import {
	createPublicOnlyBrowserFixture,
	type PublicOnlyBrowserFixtureSession,
} from "@ts-drp/network-spike/public-only/browser-fixture";

const LOCAL_NAMESPACE = "public-only-browser-local-proof";

/**
 * Runs the dedicated no-registry browser bootstrap proof against loopback fixtures.
 * @param app Root element receiving machine-readable evidence.
 */
export async function renderPublicOnlyBrowserWorkbench(app: HTMLElement): Promise<void> {
	app.innerHTML = `<main><h1>Public-only browser bootstrap</h1><p data-public-only-status="starting">Starting local proof…</p></main>`;
	let session: PublicOnlyBrowserFixtureSession | undefined;
	try {
		session = await createPublicOnlyBrowserFixture({ namespace: LOCAL_NAMESPACE });
		const status = app.querySelector<HTMLElement>("[data-public-only-status]");
		if (status !== null) {
			status.dataset.publicOnlyStatus = session.trace.result.terminal;
			status.textContent = session.trace.result.terminal;
		}
		const evidence = document.createElement("pre");
		evidence.dataset.publicOnlyTrace = "";
		evidence.textContent = JSON.stringify(session.trace);
		app.querySelector("main")?.append(evidence);
		const current = session;
		window.addEventListener("pagehide", () => void current.stop(), { once: true });
	} catch (error) {
		await session?.stop().catch(() => undefined);
		const status = app.querySelector<HTMLElement>("[data-public-only-status]");
		if (status !== null) {
			status.dataset.publicOnlyStatus = "failure";
			status.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
	}
}
