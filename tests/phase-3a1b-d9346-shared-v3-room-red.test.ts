import { build, type Metafile } from "esbuild";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gridEntry = resolve(repositoryRoot, "examples/grid/src/index.ts");
const gridPackage = resolve(repositoryRoot, "examples/grid/package.json");
const gridRoot = dirname(gridPackage);
const roomPackage = resolve(repositoryRoot, "examples/v3-room/package.json");
const roomRoot = dirname(roomPackage);
const roomSpecifier = "@ts-drp/example-v3-room";
const typeContract = resolve(repositoryRoot, "tests/fixtures/phase-3a1b-d9346/tsconfig.test.json");
const duplicateCompositionOwners = [
	"@ts-drp/control-plane",
	"@ts-drp/message-queue",
	"@ts-drp/node/v3-live",
	"@ts-drp/protocol-v3",
	"@ts-drp/storage-browser",
] as const;

let gridMetafile: Metafile | undefined;

function isWithin(absolutePath: string, directory: string): boolean {
	const selected = relative(directory, absolutePath);
	return (
		selected !== "" &&
		selected !== ".." &&
		!selected.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(selected)
	);
}

function requireGridMetafile(): Metafile {
	if (gridMetafile === undefined) throw new Error("D9346_GRID_METAFILE_ABSENT");
	return gridMetafile;
}

beforeAll(async () => {
	const result = await build({
		absWorkingDir: repositoryRoot,
		bundle: true,
		entryPoints: [gridEntry],
		external: [
			"assert",
			"buffer",
			"crypto",
			"events",
			"fs",
			"http",
			"https",
			"node:*",
			"os",
			"path",
			"process",
			"stream",
			"url",
			"util",
			"zlib",
		],
		format: "esm",
		logLevel: "silent",
		metafile: true,
		platform: "browser",
		target: "es2022",
		write: false,
	});
	gridMetafile = result.metafile;
});

describe("D.93.46b shared room contract", () => {
	it("keeps the current grid production entry independently bundleable", () => {
		const metafile = requireGridMetafile();
		expect(Object.keys(metafile.inputs).some((input) => resolve(repositoryRoot, input) === gridEntry)).toBe(true);
	});

	it("requires deterministic projection, a signed transport roster, and room-bound E1", () => {
		const result = spawnSync("pnpm", ["exec", "tsc", "-p", typeContract, "--pretty", "false"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		});
		expect(result.signal, result.stderr).toBeNull();
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	});

	it("routes the grid production bundle through the public shared-room owner", () => {
		const packageJson = JSON.parse(readFileSync(gridPackage, "utf8")) as {
			readonly dependencies?: Readonly<Record<string, unknown>>;
		};
		expect(packageJson.dependencies?.[roomSpecifier], "D9346_GRID_ROOM_DEPENDENCY_ABSENT").toBe("workspace:*");

		const metafile = requireGridMetafile();
		const localInputs = Object.entries(metafile.inputs).filter(([input]) =>
			isWithin(resolve(repositoryRoot, input), gridRoot)
		);
		const localImports = localInputs.flatMap(([inputPath, input]) =>
			input.imports.map((entry) => ({ entry, inputPath }))
		);
		const publicImport = localImports.find(({ entry }) => entry.original === roomSpecifier);
		expect(publicImport?.inputPath, "D9346_GRID_PUBLIC_ROOM_IMPORT_ABSENT").toBeDefined();
		const roomInputs = Object.keys(metafile.inputs).filter((input) =>
			isWithin(resolve(repositoryRoot, input), roomRoot)
		);
		expect(roomInputs, "D9346_GRID_SHARED_ROOM_OWNER_ABSENT").not.toHaveLength(0);
		for (const duplicateOwner of duplicateCompositionOwners) {
			const duplicate = localImports.find(
				({ entry }) => entry.original === duplicateOwner || entry.original.startsWith(`${duplicateOwner}/`)
			);
			expect(duplicate?.inputPath, `D9346_GRID_DUPLICATE_ROOM_OWNER:${duplicateOwner}`).toBeUndefined();
		}
		for (const { entry, inputPath } of localImports) {
			if (!isWithin(resolve(repositoryRoot, entry.path), roomRoot)) continue;
			expect(entry.original, `D9346_GRID_ROOM_SUBPATH_BYPASS:${inputPath}`).toBe(roomSpecifier);
		}
	});

	it("retires the legacy durable-object composition from the grid product bundle", () => {
		const metafile = requireGridMetafile();
		const localInputs = Object.entries(metafile.inputs).filter(([input]) =>
			isWithin(resolve(repositoryRoot, input), gridRoot)
		);
		const localSource = localInputs.map(([input]) => readFileSync(resolve(repositoryRoot, input), "utf8")).join("\n");
		const localPaths = localInputs.map(([input]) => resolve(repositoryRoot, input));
		expect({
			connectObject: /\.connectObject\s*\(/u.test(localSource),
			createObject: /\.createObject\s*\(/u.test(localSource),
			legacyGridObject: localPaths.includes(resolve(repositoryRoot, "examples/grid/src/objects/grid.ts")),
			legacyGridState: localPaths.includes(resolve(repositoryRoot, "examples/grid/src/state.ts")),
		}).toEqual({ connectObject: false, createObject: false, legacyGridObject: false, legacyGridState: false });
	});
});
