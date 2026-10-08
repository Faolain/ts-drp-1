import { build, type Metafile } from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chatEntry = resolve(repositoryRoot, "examples/v3-chat/src/index.ts");
const chatPackage = resolve(repositoryRoot, "examples/v3-chat/package.json");
const roomPackage = resolve(repositoryRoot, "examples/v3-room/package.json");
const roomPackageSpecifier = "@ts-drp/example-v3-room";
const chatOwnedCompositionPackageRoots = [
	"@ts-drp/control-plane",
	"@ts-drp/message-queue",
	"@ts-drp/node",
	"@ts-drp/protocol-v3",
	"@ts-drp/storage-browser",
] as const;

let bundleDirectory = "";
let chatMetafile: Metafile | undefined;

function inputKeyFor(metafile: Metafile, absolutePath: string): string | undefined {
	return Object.keys(metafile.inputs).find((input) => resolve(repositoryRoot, input) === absolutePath);
}

function requireChatMetafile(): Metafile {
	if (chatMetafile === undefined) throw new Error("V3_CHAT_METAFILE_ABSENT");
	return chatMetafile;
}

function isWithinDirectory(absolutePath: string, directory: string): boolean {
	const relativePath = relative(directory, absolutePath);
	return (
		relativePath !== "" &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(relativePath)
	);
}

beforeAll(async () => {
	bundleDirectory = mkdtempSync(join(tmpdir(), "d9346-v3-room-extraction-"));
	const result = await build({
		absWorkingDir: repositoryRoot,
		bundle: true,
		entryPoints: [chatEntry],
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: join(bundleDirectory, "v3-chat.mjs"),
		platform: "browser",
		target: "es2022",
	});
	chatMetafile = result.metafile;
});

afterAll(() => {
	if (bundleDirectory !== "") rmSync(bundleDirectory, { force: true, recursive: true });
});

describe("D.93.46a shared v3-room extraction", () => {
	it("keeps the existing v3-chat production entry independently bundleable", () => {
		const metafile = requireChatMetafile();
		expect(existsSync(join(bundleDirectory, "v3-chat.mjs"))).toBe(true);
		expect(inputKeyFor(metafile, chatEntry)).toBeDefined();
	});

	it("routes the v3-chat production bundle through one real shared room owner", async () => {
		expect(existsSync(roomPackage), "V3_ROOM_PACKAGE_ABSENT").toBe(true);

		const packageJson = JSON.parse(readFileSync(roomPackage, "utf8")) as Readonly<Record<string, unknown>>;
		expect(packageJson.name).toBe(roomPackageSpecifier);
		expect(packageJson.sideEffects, "V3_ROOM_SIDE_EFFECTS_MUST_BE_FALSE").toBe(false);
		expect(packageJson.exports, "V3_ROOM_PUBLIC_EXPORT_ABSENT").toBeDefined();
		const chatRoot = dirname(chatPackage);
		const roomBuild = await build({
			absWorkingDir: chatRoot,
			bundle: true,
			entryPoints: [roomPackageSpecifier],
			format: "esm",
			logLevel: "silent",
			metafile: true,
			platform: "browser",
			target: "es2022",
			write: false,
		});
		const roomExports = [
			...new Set(Object.values(roomBuild.metafile.outputs).flatMap((output) => output.exports)),
		].sort();
		const chatPackageJson = JSON.parse(readFileSync(chatPackage, "utf8")) as Readonly<Record<string, unknown>>;
		const chatDependencies = chatPackageJson.dependencies as Readonly<Record<string, unknown>> | undefined;
		expect(chatDependencies?.[roomPackageSpecifier], "V3_CHAT_ROOM_DEPENDENCY_ABSENT").toBe("workspace:*");

		const metafile = requireChatMetafile();
		const chatInputKey = inputKeyFor(metafile, chatEntry);
		expect(chatInputKey).toBeDefined();
		if (chatInputKey === undefined) throw new Error("V3_CHAT_ENTRY_INPUT_ABSENT");
		const chatLocalInputs = Object.entries(metafile.inputs).filter(([input]) =>
			isWithinDirectory(resolve(repositoryRoot, input), chatRoot)
		);
		const chatLocalImports = chatLocalInputs.flatMap(([inputPath, input]) =>
			input.imports.map((entry) => ({ entry, inputPath }))
		);
		const roomImport = chatLocalImports.find(({ entry }) => entry.original === roomPackageSpecifier);
		expect(roomImport?.inputPath, "V3_CHAT_PUBLIC_ROOM_IMPORT_ABSENT").toBeDefined();
		if (roomImport === undefined) throw new Error("V3_CHAT_PUBLIC_ROOM_IMPORT_ABSENT");
		for (const duplicateOwner of chatOwnedCompositionPackageRoots) {
			const duplicateImport = chatLocalInputs.find(([, input]) =>
				input.imports.some(
					(entry) => entry.original === duplicateOwner || entry.original.startsWith(`${duplicateOwner}/`)
				)
			);
			expect(duplicateImport?.[0], `V3_CHAT_DUPLICATE_COMPOSITION_IMPORT:${duplicateOwner}`).toBeUndefined();
		}

		const roomRoot = dirname(roomPackage);
		const roomInputKeys = Object.keys(metafile.inputs).filter((input) =>
			isWithinDirectory(resolve(repositoryRoot, input), roomRoot)
		);
		const standaloneRoomInputKeys = Object.keys(roomBuild.metafile.inputs).filter((input) =>
			isWithinDirectory(resolve(chatRoot, input), roomRoot)
		);
		expect(standaloneRoomInputKeys, "V3_ROOM_PUBLIC_EXPORT_RESOLUTION_ABSENT").not.toHaveLength(0);
		expect(
			standaloneRoomInputKeys.map((input) => resolve(chatRoot, input)),
			"V3_CHAT_ROOM_IMPORT_RESOLUTION_DIFFERS"
		).toContain(resolve(repositoryRoot, roomImport.entry.path));
		const roomBoundaryImports = chatLocalImports.filter(({ entry }) =>
			isWithinDirectory(resolve(repositoryRoot, entry.path), roomRoot)
		);
		expect(roomBoundaryImports, "V3_CHAT_SHARED_ROOM_OWNER_ABSENT").not.toHaveLength(0);
		for (const { entry, inputPath } of roomBoundaryImports)
			expect(entry.original, `V3_CHAT_ROOM_SUBPATH_BYPASS:${inputPath}`).toBe(roomPackageSpecifier);
		expect(roomInputKeys, "V3_CHAT_SHARED_ROOM_OWNER_ABSENT").not.toHaveLength(0);
		const roomBytesInOutput = Object.values(metafile.outputs).reduce(
			(total, output) =>
				total + roomInputKeys.reduce((subtotal, input) => subtotal + (output.inputs[input]?.bytesInOutput ?? 0), 0),
			0
		);
		expect(roomBytesInOutput, "V3_CHAT_SHARED_ROOM_OWNER_TREE_SHAKEN").toBeGreaterThan(0);
		expect(roomExports, "V3_ROOM_RUNTIME_EXPORTS_DIFFER").toEqual([
			"createV3RoomCreatorInviteMaterial",
			"createV3RoomSession",
		]);
	});
});
