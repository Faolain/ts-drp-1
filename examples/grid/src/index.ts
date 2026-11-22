/**
 * The Grid page. By default the zone runs in a dedicated room worker (zone-worker-page.ts), so the
 * page's main thread keeps only rendering and input; a browser that cannot host the room in a
 * worker falls back to the main thread. `?mainThread` opts out: the zone runs on the main thread
 * (main-thread.ts). `?roomWorker`, the former opt-in, names the default and is still accepted.
 */
if (new URLSearchParams(window.location.search).has("mainThread")) await (await import("./main-thread")).main();
else {
	const { mainWithRoomWorker } = await import("./zone-worker-page");
	await mainWithRoomWorker(async () => (await import("./main-thread")).main());
}

export {};
