import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
	genesisProfileFor,
	SHIPPED_GENESIS_PROFILES,
	TRUSTED_V1_OVERRIDE,
} from "./fixtures/track-m-apps/genesis-profile.js";
import { CANVAS_GENESIS_PROFILE } from "../examples/canvas/src/profile.js";
import { CHAT_GENESIS_PROFILE } from "../examples/chat/src/profile.js";
import { GRID_GENESIS_PROFILE } from "../examples/grid/src/profile.js";
import { V3_CHAT_GENESIS_PROFILE } from "../examples/v3-chat/src/profile.js";

// Drift guard: the endurance fixture (tests/fixtures/track-m-apps) can never sign a different
// genesis profile from the shipped app. Each shipped app exports its profile from one place
// (examples/<app>/src/profile.ts); the fixture's default for each app must be that export, and the
// app's own page and session code must create rooms with that export and no other profile. The
// only exception is the explicit opt-in override (ACTIVE_ENDURANCE_PROFILE=trusted-v1). No native
// work: imports and source reads only.

const ROOT = join(import.meta.dirname, "..");
const APPS = [
	{ app: "canvas", exported: CANVAS_GENESIS_PROFILE, name: "CANVAS_GENESIS_PROFILE" },
	{ app: "chat", exported: CHAT_GENESIS_PROFILE, name: "CHAT_GENESIS_PROFILE" },
	{ app: "grid", exported: GRID_GENESIS_PROFILE, name: "GRID_GENESIS_PROFILE" },
] as const;
// Pages with an exported profile but no endurance fixture: the v3-chat demo.
const PAGES = [
	...APPS,
	{ app: "v3-chat", exported: V3_CHAT_GENESIS_PROFILE, name: "V3_CHAT_GENESIS_PROFILE" },
] as const;

const sources = (directory: string): string[] =>
	readdirSync(join(ROOT, directory), { recursive: true, encoding: "utf8" })
		.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))
		.map((path) => join(directory, path));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
// A quoted profile id ("creator-trusted-v1", 'creator-trusted-settlement-v1', `...`).
const QUOTED_PROFILE = /["'`]creator-trusted-[a-z0-9-]+["'`]/gu;

it.each(APPS)("the fixture's default $app profile is the app's own export", ({ app, exported }) => {
	expect(genesisProfileFor({ app })).toEqual(exported);
	expect(genesisProfileFor({ app, profile: "settlement-v1" })).toEqual(exported);
	expect(SHIPPED_GENESIS_PROFILES[app]).toBe(exported);
});

it("the only other profile the fixture signs is the explicit trusted-v1 opt-in", () => {
	expect(genesisProfileFor({ app: "grid", profile: "trusted-v1" })).toBe(TRUSTED_V1_OVERRIDE);
	expect(genesisProfileFor({ app: "chat", profile: "trusted-v1" })).toBe(TRUSTED_V1_OVERRIDE);
	expect(TRUSTED_V1_OVERRIDE).toEqual({ profileId: "creator-trusted-v1", latchedAclVersion: 1 });
	// The fixture states no profile id of its own outside the override's definition.
	for (const path of [...sources("tests/fixtures/track-m-apps"), ...sources("tests/fixtures/canvas-chat-lull")]) {
		const quoted = read(path).match(QUOTED_PROFILE) ?? [];
		if (path.endsWith("genesis-profile.ts")) expect(quoted, path).toEqual(['"creator-trusted-v1"']);
		else expect(quoted, `${path} restates a profile id`).toEqual([]);
	}
	expect(read("tests/fixtures/track-m-apps/long-room-core.ts")).toMatch(
		/const genesisProfile = genesisProfileFor\(options\);/u
	);
});

it.each(PAGES)("the $app page and session code create rooms with the app's export only", ({ app, name }) => {
	const files = sources(`examples/${app}/src`).filter((path) => !path.endsWith(`${app}/src/profile.ts`));
	const signing: string[] = [];
	for (const path of files) {
		const text = read(path);
		expect(text.match(QUOTED_PROFILE) ?? [], `${path} names a profile id instead of ${name}`).toEqual([]);
		const assigned = [...text.matchAll(/\bprofileId:\s*([^,\n}]+)/gu)].map((match) => match[1]?.trim());
		for (const value of assigned) expect(value, `${path} profileId`).toBe(`${name}.profileId`);
		if (/exactCanonicalProfileBytes(?::| =) encodeCanonical\(/u.test(text)) {
			signing.push(path);
			expect(text, `${path} signs the genesis ACL version of ${name}`).toContain(`version: ${name}.latchedAclVersion`);
		}
	}
	expect(signing, `${app} creates its rooms somewhere`).not.toEqual([]);
});
