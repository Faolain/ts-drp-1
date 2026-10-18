import { type OwnerCase, ownerCases, type RecoveryCase } from "./types.js";
export interface Case {
	id: string;
	epoch: 1 | 2;
	published: boolean;
	mode: RecoveryCase;
}
const positive: Case[] = [1, 2].flatMap((epoch) =>
	[false, true].map((published) => ({
		id: `positive-${epoch}-${published ? "active" : "staged"}`,
		epoch: epoch as 1 | 2,
		published,
		mode: "verified" as const,
	}))
);
export const authModes = [
	"bad-trust",
	"bad-cut",
	"bad-qc",
	"storage-corrupt-trust",
	"storage-corrupt-cut",
	"storage-corrupt-qc",
	"bad-pre-transition",
	"bad-projection",
	"bad-acl",
	"bad-settlement",
] as const;
export const envelopeModes = [
	"retained-key",
	"retained-undefined",
	"missing-key",
	"extra-key",
	"accessor",
	"symbol",
	"non-plain",
	"invalid-previous",
	"invalid-next",
	"invalid-object",
	"wrong-previous",
	"wrong-next",
	"wrong-profile",
	"nonconsecutive",
	"mutate-heads",
] as const;
export const candidateModes = [
	"retry",
	"retry-active",
	"mixed-unavailable",
	"fork",
	"fork-active",
	"incomplete",
	"unmatched",
	"duplicate-id",
	"stale-base",
	"lost-cas",
	"failed-cas",
	"reread-failed",
	"reread-unrelated",
	"storage-failed",
	"lineage-failed",
	"unexpected-read",
	"catalog-rejected",
	"parameters-rejected",
] as const;
const one = (modes: readonly RecoveryCase[], epoch: 1 | 2 = 1): Case[] =>
	modes.map((mode) => ({
		id: `${epoch}-${mode}`,
		epoch,
		published: ["retry-active", "fork-active"].includes(mode),
		mode,
	}));
/** Concrete review roster: shared semantics on SQLite; native owner controls and representative auth/candidate reach on every browser engine. */
export const sqliteCases: Case[] = [
	...positive,
	...one(ownerCases.filter((mode) => mode !== "verified")),
	...one(envelopeModes),
	...one(authModes),
	...one(authModes, 2),
	...one(candidateModes),
	...one(["divergent-mixed-unavailable"]),
];
export const browserCases: Case[] = [
	...positive,
	...one(ownerCases.filter((mode) => mode !== "verified")),
	...one([
		"bad-trust",
		"bad-cut",
		"bad-qc",
		"bad-pre-transition",
		"bad-projection",
		"bad-acl",
		"bad-settlement",
		"mixed-unavailable",
		"retry",
		"fork-active",
		"mutate-heads",
	]),
];
export const probeModes: readonly OwnerCase[] = ownerCases;
export const sqliteAuthProbes: Case[] = [
	...positive,
	...one(authModes),
	...one(authModes, 2),
	...one(candidateModes.filter((mode) => mode !== "mixed-unavailable")),
	...one(["wrong-previous", "wrong-next", "mutate-heads"]),
	...one(["divergent-mixed-unavailable"]),
];
export const browserAuthProbes: Case[] = [
	...positive,
	...one([
		"bad-trust",
		"bad-cut",
		"bad-qc",
		"bad-pre-transition",
		"bad-projection",
		"bad-acl",
		"bad-settlement",
		"retry",
		"fork-active",
		"mutate-heads",
	]),
];
export const budgets = Object.freeze({ workers: 3, retries: 0, caseMs: 15000, globalMs: 360000 });
