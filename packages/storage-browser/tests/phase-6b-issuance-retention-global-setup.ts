import { build, type Plugin } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function maintenancePlugin(packageDirectory: string): Plugin {
	const candidate = resolve(packageDirectory, "src/issuance-maintenance.ts");
	const ready =
		existsSync(candidate) &&
		readFileSync(candidate, "utf8").includes("resolveBrowserDurableIssuancePruningMaintenance");
	process.env.D109B_BROWSER_MAINTENANCE_READY = String(ready);
	return {
		name: "phase-6b-issuance-maintenance",
		setup(builder): void {
			builder.onResolve({ filter: /^#phase-6b-issuance-maintenance$/ }, () =>
				ready ? { path: candidate } : { namespace: "d109b-absent", path: "maintenance" }
			);
			builder.onLoad({ filter: /.*/, namespace: "d109b-absent" }, () => ({
				contents:
					"export const D109B_BROWSER_MAINTENANCE_READY=false; export function resolveBrowserDurableIssuancePruningMaintenance(){return undefined}",
				loader: "js",
			}));
			if (ready) {
				builder.onLoad({ filter: /issuance-maintenance\.ts$/ }, async (args) => ({
					contents: `${readFileSync(args.path, "utf8")}\nexport const D109B_BROWSER_MAINTENANCE_READY=true;`,
					loader: "ts",
				}));
			}
		},
	};
}

export default async function globalSetup(): Promise<() => void> {
	const packageDirectory = resolve(import.meta.dirname, "..");
	const outputDirectory = mkdtempSync(join(packageDirectory, ".phase-6b-issuance-retention-assets-"));
	await build({
		bundle: true,
		entryPoints: {
			"phase-6b-issuance-retention": resolve(packageDirectory, "tests/assets/phase-6b-issuance-retention-entry.ts"),
		},
		format: "esm",
		outdir: outputDirectory,
		platform: "browser",
		plugins: [maintenancePlugin(packageDirectory)],
		target: "es2022",
	});
	writeFileSync(
		join(outputDirectory, "phase-6b-issuance-retention.html"),
		'<!doctype html><meta charset="utf-8"><script type="module" src="./phase-6b-issuance-retention.js"></script>',
		"utf8"
	);
	process.env.PHASE_6B_ISSUANCE_RETENTION_ASSET_DIR = outputDirectory;
	return () => rmSync(outputDirectory, { force: true, recursive: true });
}
