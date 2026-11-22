/**
 * The Canvas page. By default the room runs in a dedicated room worker (canvas-worker-page.ts), so
 * the page's main thread keeps only rendering and input; a browser that cannot host the room in a
 * worker falls back to the main thread. `?mainThread` opts out: the room runs on the main thread
 * (canvas-main-thread.ts). Both run the same room module (canvas-room.ts) and page (canvas-page.ts).
 */
const start = async (): Promise<void> => {
	if (new URLSearchParams(window.location.search).has("mainThread"))
		await (await import("./canvas-main-thread")).main();
	else {
		const { mainWithRoomWorker } = await import("./canvas-worker-page");
		await mainWithRoomWorker(async () => (await import("./canvas-main-thread")).main());
	}
};

void start().catch((error) => console.error("Canvas startup failed", error));

export {};
