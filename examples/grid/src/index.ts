/**
 * The Grid page. By default the zone runs on the main thread, as it always has. `?roomWorker`
 * opts into hosting it in a dedicated worker (zone-worker-page.ts); a browser that cannot host it
 * there falls back to the main thread.
 */
if (new URLSearchParams(window.location.search).has("roomWorker")) {
	const { mainWithRoomWorker } = await import("./zone-worker-page");
	await mainWithRoomWorker(async () => (await import("./main-thread")).main());
} else await (await import("./main-thread")).main();

export {};
