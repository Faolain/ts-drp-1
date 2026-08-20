const parameters = new URLSearchParams(location.search);
const encoded = parameters.get("input");
if (encoded === null) throw new TypeError("missing p4 death input");
const input = JSON.parse(atob(encoded)) as unknown;
const worker = new Worker(new URL("./phase-3a1b-p4-browser-live-journal-worker.js", import.meta.url), {
	type: "module",
});
worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
	console.log(`PHASE_3A1B_P4:${JSON.stringify(data)}`);
});
worker.postMessage(input);
