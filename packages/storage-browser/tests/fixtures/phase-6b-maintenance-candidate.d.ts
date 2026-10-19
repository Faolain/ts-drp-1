// Build-plugin aliases owned by the phase 6b global setups: each resolves to the
// real maintenance module (plus its readiness flag) or to an absent stand-in.
declare module "#phase-6b-ahe-reclamation-maintenance" {
	export const D109C_BROWSER_MAINTENANCE_READY: boolean;
	export const resolveBrowserAheReclamationMaintenance: typeof import("../../src/maintenance.js").resolveBrowserAheReclamationMaintenance;
}

declare module "#phase-6b-issuance-maintenance" {
	export const D109B_BROWSER_MAINTENANCE_READY: boolean;
	export const resolveBrowserDurableIssuancePruningMaintenance: typeof import("../../src/issuance-maintenance.js").resolveBrowserDurableIssuancePruningMaintenance;
}
