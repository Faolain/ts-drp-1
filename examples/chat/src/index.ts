import { status } from "./chat-page";

// The room runs in a room worker by default (chat-worker-page.ts); `?mainThread` opens it on the
// page's main thread (chat-main-thread.ts), which is also the fallback of a browser that cannot host
// it in a worker.
async function start(): Promise<void> {
	if (new URLSearchParams(window.location.search).has("mainThread")) await (await import("./chat-main-thread")).main();
	else {
		const { mainWithRoomWorker } = await import("./chat-worker-page");
		await mainWithRoomWorker(async (page) => (await import("./chat-main-thread")).main(page));
	}
}
void start().catch((error: unknown) => {
	status("Chat could not start. Check the configured catalog, identity and network.", "error");
	console.error("Chat startup failed", error);
});
