import { build, type Plugin } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function maintenancePlugin(packageDirectory: string): Plugin {
	const candidate = resolve(packageDirectory, "src/maintenance.ts");
	const internal = resolve(packageDirectory, "src/internal/ahe-reclamation.ts");
	const ready =
		existsSync(candidate) &&
		existsSync(internal) &&
		readFileSync(candidate, "utf8").includes("resolveBrowserAheReclamationMaintenance") &&
		readFileSync(internal, "utf8").includes("reclaimClosedEpoch");
	process.env.D109C_BROWSER_MAINTENANCE_READY = String(ready);
	return {
		name: "phase-6b-ahe-reclamation-maintenance",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-6b-ahe-reclamation-maintenance$/ }, () =>
				ready ? { path: candidate } : { namespace: "d109c-absent", path: "maintenance" }
			);
			builder.onLoad({ filter: /.*/, namespace: "d109c-absent" }, () => ({
				contents:
					"export const D109C_BROWSER_MAINTENANCE_READY=false; export function resolveBrowserAheReclamationMaintenance(){return undefined}",
				loader: "js",
			}));
			if (ready) {
				builder.onLoad({ filter: /maintenance\.ts$/ }, (args) => ({
					contents: `${readFileSync(args.path, "utf8")}\nexport const D109C_BROWSER_MAINTENANCE_READY=true;`,
					loader: "ts",
				}));
			}
		},
	};
}

/**
 * Builds the causal browser fixtures against either the missing-owner stub or real owner.
 * @returns Cleanup for the temporary asset directory.
 */
export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = resolve(import.meta.dirname, "..");
	const outputDirectory = mkdtempSync(join(packageDirectory, ".phase-6b-ahe-reclamation-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-6b-ahe-reclamation": resolve(packageDirectory, "tests/assets/phase-6b-ahe-reclamation-entry.ts"),
			"phase-6b-ahe-reclamation-worker": resolve(packageDirectory, "tests/assets/phase-6b-ahe-reclamation-worker.ts"),
		},
		format: "esm",
		outdir: outputDirectory,
		platform: "browser",
		plugins: [maintenancePlugin(packageDirectory)],
		target: "es2022",
	});
	writeFileSync(
		join(outputDirectory, "phase-6b-ahe-reclamation.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-6b-ahe-reclamation.js"></script>',
		"utf8"
	);
	process.env.PHASE_6B_AHE_RECLAMATION_ASSET_DIR = outputDirectory;
	return () => rmSync(outputDirectory, { force: true, recursive: true });
}
