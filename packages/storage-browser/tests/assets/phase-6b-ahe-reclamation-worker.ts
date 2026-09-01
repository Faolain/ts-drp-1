/* eslint-disable import/no-unresolved -- Focused build plugin owns the causal maintenance alias. */
import { D109C_BROWSER_MAINTENANCE_READY } from "#phase-6b-ahe-reclamation-maintenance";

const EDGES = Object.freeze([
	"after-floor-rewrite",
	"after-promotion-delete",
	"after-generation-delete",
	"after-blob-delete",
	"before-commit",
	"after-commit",
]);

self.addEventListener("message", (event: MessageEvent<{ readonly edge?: string }>) => {
	const edge = event.data.edge;
	if (!D109C_BROWSER_MAINTENANCE_READY || edge === undefined || !EDGES.includes(edge)) {
		self.postMessage({ kind: "refused", ready: D109C_BROWSER_MAINTENANCE_READY });
		return;
	}
	self.postMessage({ edge, kind: "armed", ready: true });
});

self.postMessage({ kind: "ready", ready: D109C_BROWSER_MAINTENANCE_READY });
