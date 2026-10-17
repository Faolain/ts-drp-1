// packages/storage-browser/tests/assets/phase-3a1b-p4-browser-live-journal-death-entry.ts
var parameters = new URLSearchParams(location.search);
var encoded = parameters.get("input");
if (encoded === null) throw new TypeError("missing p4 death input");
var input = JSON.parse(atob(encoded));
var worker = new Worker(new URL("./phase-3a1b-p4-browser-live-journal-worker.js", import.meta.url), {
  type: "module"
});
worker.addEventListener("message", ({ data }) => {
  console.log(`PHASE_3A1B_P4:${JSON.stringify(data)}`);
});
worker.postMessage(input);
