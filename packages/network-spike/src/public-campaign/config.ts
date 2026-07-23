import { z } from "zod";

import { frozenPublicCampaign } from "../campaign-plan.js";
import { summarizePublicCampaign } from "../campaign-primitives.js";
import { type PublicCampaignPlan, PublicCampaignPlanSchema } from "../schemas.js";

export const PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_ISSUE_5_PUBLIC_NETWORK_TRAFFIC_AND_OPERATOR_TERMS";

const TimestampSchema = z.string().datetime({ offset: true });
const HttpsUrlSchema = z
	.string()
	.url()
	.refine((value) => new URL(value).protocol === "https:", "public endpoints must use HTTPS")
	.refine((value) => {
		const endpoint = new URL(value);
		return endpoint.username === "" && endpoint.password === "";
	}, "public endpoints cannot contain URL credentials");
const IdentifierSchema = z
	.string()
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/u);
const PseudonymSchema = z.string().regex(/^[a-z]+_[a-f0-9]{12}$/u);
const VersionValueSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/u);
const VersionRecordSchema = z
	.record(z.string().regex(/^[@a-zA-Z0-9][a-zA-Z0-9._@/-]{0,79}$/u), VersionValueSchema)
	.refine((value) => Object.keys(value).length > 0, "expected at least one version");
const ParsedFrozenPublicCampaign = PublicCampaignPlanSchema.parse(frozenPublicCampaign);

export const PublicRequestKindSchema = z.enum([
	"registry-register",
	"registry-refresh",
	"registry-discover",
	"dht-provide",
	"dht-reprovide",
	"dht-lookup",
	"delegated-lookup",
	"relay-discover",
	"relay-dial",
	"relay-reserve",
	"relay-refresh",
	"relay-replace",
	"grid-canary",
]);

export const PublicCampaignConfigSchema = z
	.object({
		schemaVersion: z.literal("1.0.0"),
		runId: IdentifierSchema,
		consent: z
			.object({
				acknowledgement: z.literal(PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT),
				grantedAt: TimestampSchema,
				grantedBy: z.string().min(3),
				operatorTermsReviewedAt: TimestampSchema,
			})
			.strict(),
		plan: PublicCampaignPlanSchema,
		endpointAllowlist: z.array(HttpsUrlSchema).min(1),
		endpoints: z
			.object({
				delegatedRouting: z.array(HttpsUrlSchema).min(1).max(4),
				publicDhtBootstrap: z.array(z.string().regex(/^\/(?:dns|ip)[^ ]+\/p2p\/[^/ ]+$/u)).min(1),
				registries: z
					.array(
						z
							.object({
								operatorPseudonym: PseudonymSchema,
								url: HttpsUrlSchema,
							})
							.strict()
					)
					.length(2),
				relays: z.array(HttpsUrlSchema).min(1),
			})
			.strict(),
		conditions: z
			.array(
				z
					.object({
						authorizationReference: z.string().min(8),
						descriptorPseudonym: PseudonymSchema,
						egressPseudonym: PseudonymSchema,
						kind: z.literal("real-egress"),
						label: IdentifierSchema,
						natClass: z.enum(["public", "full-cone", "restricted", "port-restricted", "symmetric", "unknown"]),
					})
					.strict()
			)
			.min(2),
		trialBudget: z.number().int().positive(),
		requestBudget: z
			.object({
				hardCap: z.number().int().positive(),
			})
			.strict(),
		maxConcurrency: z.literal(1),
		cooldownMs: z.number().int().min(1_000).max(60_000),
		taskTimeoutMs: z.number().int().min(1_000).max(120_000),
		rawOutputDirectory: z.string().regex(/^\.network-spike-raw\/[a-zA-Z0-9_-]+$/u),
		stopPolicy: z
			.object({
				onOperatorTermsConcern: z.literal(true),
				onRateLimit: z.literal(true),
			})
			.strict(),
		versions: z
			.object({
				browsers: z
					.object({
						chromium: VersionValueSchema,
						firefox: VersionValueSchema,
						webkit: VersionValueSchema,
					})
					.strict(),
				node: VersionValueSchema,
				os: VersionValueSchema,
				packages: VersionRecordSchema,
				pnpm: VersionValueSchema,
				sources: VersionRecordSchema,
			})
			.strict(),
	})
	.strict()
	.superRefine((config, context) => {
		const summary = summarizePublicCampaign(config.plan);
		if (JSON.stringify(config.plan) !== JSON.stringify(ParsedFrozenPublicCampaign)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "campaign plan must exactly match the pre-registered Phase 09 plan",
				path: ["plan"],
			});
		}
		const plannedTrialBudget = summary.requiredTrialCount + config.plan.conditions.length * config.plan.browsers.length;
		if (config.requestBudget.hardCap !== summary.hardRequestCap) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `hard request cap must equal precomputed plan cap ${summary.hardRequestCap}`,
				path: ["requestBudget", "hardCap"],
			});
		}
		if (config.trialBudget !== plannedTrialBudget) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `trial budget must equal ${plannedTrialBudget} identities and canaries`,
				path: ["trialBudget"],
			});
		}
		if (config.rawOutputDirectory !== `.network-spike-raw/${config.runId}`) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "raw output directory must be scoped to the run ID",
				path: ["rawOutputDirectory"],
			});
		}

		const conditionLabels = config.conditions.map((condition) => condition.label);
		if (!sameMembers(conditionLabels, config.plan.conditions)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "real-egress condition labels must exactly match the frozen plan",
				path: ["conditions"],
			});
		}
		for (const [field, values] of [
			["authorizationReference", config.conditions.map((condition) => condition.authorizationReference)],
			["descriptorPseudonym", config.conditions.map((condition) => condition.descriptorPseudonym)],
			["egressPseudonym", config.conditions.map((condition) => condition.egressPseudonym)],
		] as const) {
			if (new Set(values).size !== values.length) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `conditions must have materially distinct ${field} values`,
					path: ["conditions"],
				});
			}
		}

		const registryOrigins = config.endpoints.registries.map((endpoint) => new URL(endpoint.url).origin);
		if (new Set(registryOrigins).size !== 2) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "signed registries must have two independent URL origins",
				path: ["endpoints", "registries"],
			});
		}
		if (new Set(config.endpoints.registries.map((endpoint) => endpoint.operatorPseudonym)).size !== 2) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "signed registries must have two independent operator pseudonyms",
				path: ["endpoints", "registries"],
			});
		}

		const allowedOrigins = new Set(config.endpointAllowlist.map((url) => new URL(url).origin));
		const publicUrls = [
			...config.endpoints.delegatedRouting,
			...config.endpoints.registries.map((endpoint) => endpoint.url),
			...config.endpoints.relays,
		];
		for (const publicUrl of publicUrls) {
			const endpoint = new URL(publicUrl);
			if (endpoint.hostname.endsWith(".invalid")) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "placeholder public endpoint hostnames are not executable",
					path: ["endpoints"],
				});
			}
			if (!allowedOrigins.has(endpoint.origin)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "a public endpoint origin is not allowlisted",
					path: ["endpointAllowlist"],
				});
			}
		}
		if (config.endpoints.publicDhtBootstrap.some((target) => target.includes(".invalid/"))) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "placeholder public DHT bootstrap targets are not executable",
				path: ["endpoints", "publicDhtBootstrap"],
			});
		}
		if (
			config.consent.grantedBy.startsWith("replace-") ||
			config.conditions.some(({ authorizationReference }) => authorizationReference.startsWith("replace-"))
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "placeholder authorization references are not executable",
				path: ["consent"],
			});
		}
		if (containsPlaceholderVersion(config.versions)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "placeholder version metadata is not executable",
				path: ["versions"],
			});
		}
	});

export type PublicCampaignConfig = z.infer<typeof PublicCampaignConfigSchema>;
export type PublicRequestKind = z.infer<typeof PublicRequestKindSchema>;

export interface PublicCampaignPreflight {
	authorized: boolean;
	blockers: Array<{
		code: string;
		message: string;
	}>;
	config?: PublicCampaignConfig;
	plan?: PublicCampaignPlan;
	precomputed?: ReturnType<typeof summarizePublicCampaign> & {
		trialBudget: number;
	};
}

export interface SanitizedPublicCampaignPreflight {
	authorized: boolean;
	blockers: Array<{
		code: string;
	}>;
	precomputed?: PublicCampaignPreflight["precomputed"];
	runId?: string;
}

/**
 * Computes the frozen ceiling before checking either consent acknowledgement.
 * @param input - Candidate campaign configuration.
 * @param cliAcknowledgement - Separate command-line operator acknowledgement.
 * @returns A fail-closed readiness result.
 */
export function preflightPublicCampaign(input: unknown, cliAcknowledgement?: string): PublicCampaignPreflight {
	const blockers: PublicCampaignPreflight["blockers"] = [];
	const candidatePlan =
		typeof input === "object" && input !== null && "plan" in input ? (input as { plan?: unknown }).plan : undefined;
	const parsedPlan = PublicCampaignPlanSchema.safeParse(candidatePlan);
	let precomputed: PublicCampaignPreflight["precomputed"];
	if (parsedPlan.success) {
		const summary = summarizePublicCampaign(parsedPlan.data);
		precomputed = {
			...summary,
			trialBudget: summary.requiredTrialCount + parsedPlan.data.conditions.length * parsedPlan.data.browsers.length,
		};
	} else {
		blockers.push({
			code: "invalid-plan",
			message: parsedPlan.error.issues.map((issue) => issue.message).join("; "),
		});
	}

	const parsedConfig = PublicCampaignConfigSchema.safeParse(input);
	if (!parsedConfig.success) {
		blockers.push({
			code: "invalid-config",
			message: parsedConfig.error.issues.map((issue) => issue.message).join("; "),
		});
	}
	if (cliAcknowledgement !== PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT) {
		blockers.push({
			code: "missing-cli-consent",
			message: "the command-line acknowledgement must exactly match the public campaign consent phrase",
		});
	}

	return {
		authorized: blockers.length === 0,
		blockers,
		...(parsedConfig.success ? { config: parsedConfig.data } : {}),
		...(parsedPlan.success ? { plan: parsedPlan.data } : {}),
		...(precomputed === undefined ? {} : { precomputed }),
	};
}

/**
 * Removes protected consent, endpoint, DHT, and egress values before logging.
 * @param preflight - Internal readiness result containing protected configuration.
 * @returns The only preflight shape safe for workflow output.
 */
export function sanitizePublicCampaignPreflight(preflight: PublicCampaignPreflight): SanitizedPublicCampaignPreflight {
	return {
		authorized: preflight.authorized,
		blockers: preflight.blockers.map(({ code }) => ({ code })),
		...(preflight.precomputed === undefined ? {} : { precomputed: preflight.precomputed }),
		...(preflight.config === undefined ? {} : { runId: preflight.config.runId }),
	};
}

function sameMembers(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		new Set(right).size === right.length &&
		left.every((value) => right.includes(value))
	);
}

function containsPlaceholderVersion(value: unknown): boolean {
	if (typeof value === "string") return value.toLowerCase() === "replace";
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some(containsPlaceholderVersion);
}
