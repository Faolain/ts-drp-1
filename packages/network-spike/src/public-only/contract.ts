import { z } from "zod";

import { RequestBudget } from "../campaign-primitives.js";
import { classifyIpAddressScope } from "../probe/address-policy.js";
import { PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT } from "../public-campaign/config.js";
import { OFFICIAL_AMINO_BOOTSTRAPPERS, REVIEWED_DELEGATED_ROUTING_ENDPOINTS } from "../public-infrastructure.js";

export const PUBLIC_ONLY_SCHEMA_VERSION = "1.0.0";
export const PUBLIC_ONLY_ACKNOWLEDGEMENT = PUBLIC_CAMPAIGN_ACKNOWLEDGEMENT;

const IdentifierSchema = z
	.string()
	.min(8)
	.max(96)
	.regex(/^[a-zA-Z0-9_-]+$/u);

const PublicHttpsEndpointSchema = z.enum(REVIEWED_DELEGATED_ROUTING_ENDPOINTS);
const PublicBootstrapAddressSchema = z.enum(OFFICIAL_AMINO_BOOTSTRAPPERS);

export const PublicOnlyStageSchema = z.enum([
	"node-dht-bootstrap",
	"node-relay-reservation",
	"node-provider-publication",
	"provider-visibility",
	"browser-relay-reservation",
	"provider-dial",
	"gossipsub-mesh",
	"object-sync",
	"direct-webrtc",
	"relay-removal",
	"cleanup",
]);

export const PublicOnlyTerminalSchema = z.enum([
	"success",
	"missing-consent",
	"invalid-config",
	"deadline-exceeded",
	"request-budget-exhausted",
	"dht-bootstrap-failed",
	"relay-exhausted",
	"provider-not-visible",
	"provider-undialable",
	"delegated-endpoint-failed",
	"provider-dial-failed",
	"mesh-failed",
	"sync-failed",
	"direct-proof-failed",
	"inconclusive-public-outage",
]);

export const PublicOnlyVerdictSchema = z.enum(["success", "no-go", "blocked", "inconclusive"]);

export const PublicOnlyMilestoneStatusSchema = z.enum(["passed", "failed", "skipped"]);

export const PublicOnlyMilestoneSchema = z
	.object({
		elapsedMs: z.number().int().nonnegative(),
		order: z.number().int().nonnegative(),
		stage: PublicOnlyStageSchema,
		status: PublicOnlyMilestoneStatusSchema,
		terminal: PublicOnlyTerminalSchema.optional(),
	})
	.strict();

export const PublicOnlyRequestKindSchema = z.enum([
	"amino-bootstrap",
	"dht-provide",
	"dht-provider-lookup",
	"delegated-provider-lookup",
	"delegated-closest-peers",
	"relay-dial",
	"relay-reserve",
	"provider-dial",
]);

const PublicOnlyLimitsSchema = z
	.object({
		totalDeadlineMs: z.number().int().min(1_000).max(600_000),
		maxPublicRequests: z.number().int().min(1).max(128),
		maxDhtRequests: z.number().int().min(1).max(32),
		maxDelegatedRequests: z.number().int().min(1).max(64),
		maxProviderRequests: z.number().int().min(1).max(32),
		maxRelayRequests: z.number().int().min(1).max(64),
		maxRelayCandidates: z.number().int().min(1).max(32),
		maxReservationAttempts: z.number().int().min(1).max(16),
	})
	.strict();

export const PublicOnlyConfigSchema = z
	.object({
		schemaVersion: z.literal(PUBLIC_ONLY_SCHEMA_VERSION),
		runId: IdentifierSchema,
		consent: z
			.object({
				acknowledgement: z.literal(PUBLIC_ONLY_ACKNOWLEDGEMENT),
				grantedAt: z.string().datetime({ offset: true }),
				grantedBy: z.string().min(3).max(128),
				operatorTermsReviewedAt: z.string().datetime({ offset: true }),
			})
			.strict(),
		namespace: IdentifierSchema,
		objectId: IdentifierSchema,
		delegatedEndpoints: z.array(PublicHttpsEndpointSchema).length(1),
		publicDhtBootstrap: z.array(PublicBootstrapAddressSchema).min(1).max(OFFICIAL_AMINO_BOOTSTRAPPERS.length),
		transportProfile: z.literal("wss-only"),
		limits: PublicOnlyLimitsSchema,
	})
	.strict()
	.superRefine((config, context) => {
		if (
			new Set(config.delegatedEndpoints.map((endpoint) => new URL(endpoint).origin)).size !==
			config.delegatedEndpoints.length
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "delegated endpoint origins must be distinct",
				path: ["delegatedEndpoints"],
			});
		}
		const componentCap =
			config.limits.maxDhtRequests +
			config.limits.maxDelegatedRequests +
			config.limits.maxProviderRequests +
			config.limits.maxRelayRequests;
		if (componentCap !== config.limits.maxPublicRequests) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "component request caps must exactly equal the total public request cap",
				path: ["limits", "maxPublicRequests"],
			});
		}
		if (config.limits.maxReservationAttempts > config.limits.maxRelayRequests) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "reservation attempts cannot exceed the relay request cap",
				path: ["limits", "maxReservationAttempts"],
			});
		}
		if (config.limits.maxReservationAttempts > config.limits.maxRelayCandidates) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "reservation attempts cannot exceed the relay candidate cap",
				path: ["limits", "maxReservationAttempts"],
			});
		}
	});

export const PublicOnlyBrowserInputSchema = z
	.object({
		delegatedEndpoints: z.array(PublicHttpsEndpointSchema).length(1),
		limits: PublicOnlyLimitsSchema,
		namespace: IdentifierSchema,
		objectId: IdentifierSchema,
		schemaVersion: z.literal(PUBLIC_ONLY_SCHEMA_VERSION),
	})
	.strict();

export type PublicOnlyConfig = z.infer<typeof PublicOnlyConfigSchema>;
export type PublicOnlyBrowserInput = z.infer<typeof PublicOnlyBrowserInputSchema>;
export type PublicOnlyMilestone = z.infer<typeof PublicOnlyMilestoneSchema>;
export type PublicOnlyRequestKind = z.infer<typeof PublicOnlyRequestKindSchema>;
export type PublicOnlyStage = z.infer<typeof PublicOnlyStageSchema>;
export type PublicOnlyTerminal = z.infer<typeof PublicOnlyTerminalSchema>;
export type PublicOnlyVerdict = z.infer<typeof PublicOnlyVerdictSchema>;

export interface PublicOnlyPreflight {
	authorized: boolean;
	blockers: Array<{ code: "invalid-config" | "missing-cli-consent"; message: string }>;
	config?: PublicOnlyConfig;
}

export interface SanitizedPublicOnlyPreflight {
	authorized: boolean;
	blockers: Array<{ code: PublicOnlyPreflight["blockers"][number]["code"] }>;
	endpointCount?: number;
	publicRequestCap?: number;
	runId?: string;
	totalDeadlineMs?: number;
}

export interface BlockedPublicOnlyReport {
	schemaVersion: typeof PUBLIC_ONLY_SCHEMA_VERSION;
	status: "blocked";
	verdict: "blocked";
	terminal: "invalid-config" | "missing-consent";
	publicRequests: 0;
	milestones: [];
	blockers: Array<{ code: PublicOnlyPreflight["blockers"][number]["code"] }>;
}

export interface PublicOnlyBudgetSnapshot {
	consumed: number;
	hardCap: number;
	byKind: Partial<Record<PublicOnlyRequestKind, number>>;
	deadlineAtMs: number;
	remainingMs: number;
	relayCandidates: { consumed: number; hardCap: number };
	reservationAttempts: { consumed: number; hardCap: number };
}

/**
 * Projects the only values a browser may receive for a public-only run.
 * @param config - Strict public-only coordinator configuration.
 * @returns A strict projection with no consent, bootstrap peer, run ID, DRP identity, or address.
 */
export function createPublicOnlyBrowserInput(config: PublicOnlyConfig): PublicOnlyBrowserInput {
	return PublicOnlyBrowserInputSchema.parse({
		delegatedEndpoints: config.delegatedEndpoints,
		limits: config.limits,
		namespace: config.namespace,
		objectId: config.objectId,
		schemaVersion: config.schemaVersion,
	});
}

/**
 * Rejects a reviewed HTTPS endpoint when its fresh DNS result contains any non-public address.
 * The executor must call this immediately before every delegated-routing request.
 * @param endpoint - Endpoint selected from the code-owned reviewed allowlist.
 * @param resolvedAddresses - Fresh A/AAAA answers for the endpoint host.
 */
export function assertPublicEndpointResolution(endpoint: string, resolvedAddresses: readonly string[]): void {
	PublicHttpsEndpointSchema.parse(endpoint);
	if (resolvedAddresses.length === 0) throw new Error("delegated endpoint DNS returned no addresses");
	const rejectedScopes = resolvedAddresses
		.map((address) => classifyIpAddressScope(address))
		.filter((scope) => scope !== "public");
	if (rejectedScopes.length > 0) {
		throw new Error(`delegated endpoint DNS contained non-public addresses: ${[...new Set(rejectedScopes)].join(",")}`);
	}
}

/**
 * Validates configuration and the separate command-line consent gate without performing I/O.
 * @param input - Candidate public-only configuration.
 * @param cliAcknowledgement - Separate command-line operator acknowledgement.
 * @returns A fail-closed preflight result.
 */
export function preflightPublicOnly(input: unknown, cliAcknowledgement?: string): PublicOnlyPreflight {
	const blockers: PublicOnlyPreflight["blockers"] = [];
	const parsed = PublicOnlyConfigSchema.safeParse(input);
	if (!parsed.success) {
		blockers.push({
			code: "invalid-config",
			message: parsed.error.issues.map((issue) => issue.message).join("; "),
		});
	}
	if (cliAcknowledgement !== PUBLIC_ONLY_ACKNOWLEDGEMENT) {
		blockers.push({
			code: "missing-cli-consent",
			message: "the command-line acknowledgement must exactly match the issue #5 public-network consent phrase",
		});
	}
	return {
		authorized: blockers.length === 0,
		blockers,
		...(parsed.success ? { config: parsed.data } : {}),
	};
}

/**
 * Projects a preflight into the only endpoint- and consent-free shape safe for logs.
 * @param preflight - Internal readiness result.
 * @returns The sanitized projection safe for workflow output.
 */
export function sanitizePublicOnlyPreflight(preflight: PublicOnlyPreflight): SanitizedPublicOnlyPreflight {
	return {
		authorized: preflight.authorized,
		blockers: preflight.blockers.map(({ code }) => ({ code })),
		...(preflight.config === undefined
			? {}
			: {
					endpointCount: preflight.config.delegatedEndpoints.length,
					publicRequestCap: preflight.config.limits.maxPublicRequests,
					runId: preflight.config.runId,
					totalDeadlineMs: preflight.config.limits.totalDeadlineMs,
				}),
	};
}

/**
 * Creates the durable zero-request result used before a public-only run is authorized.
 * @param preflight - Optional failed preflight whose blocker codes should be retained.
 * @returns A zero-request blocked report.
 */
export function createBlockedPublicOnlyReport(preflight?: PublicOnlyPreflight): BlockedPublicOnlyReport {
	const blockers = preflight?.blockers.map(({ code }) => ({ code })) ?? [{ code: "missing-cli-consent" as const }];
	return {
		blockers,
		milestones: [],
		publicRequests: 0,
		schemaVersion: PUBLIC_ONLY_SCHEMA_VERSION,
		status: "blocked",
		terminal: blockers.some(({ code }) => code === "invalid-config") ? "invalid-config" : "missing-consent",
		verdict: "blocked",
	};
}

/** One parent deadline and request ledger shared by every public-only stage. */
export class PublicOnlyRunBudget {
	readonly #byKind = new Map<PublicOnlyRequestKind, number>();
	readonly #categoryBudgets: Record<"delegated" | "dht" | "provider" | "relay", RequestBudget>;
	readonly #deadlineAtMs: number;
	readonly #now: () => number;
	readonly #relayCandidates: RequestBudget;
	readonly #requests: RequestBudget;
	readonly #reservationAttempts: RequestBudget;

	/**
	 * Creates the one parent deadline and all request ledgers for a run.
	 * @param config - Validated public-only limits.
	 * @param now - Injectable monotonic-enough clock used by deterministic tests.
	 */
	constructor(config: Pick<PublicOnlyConfig, "limits">, now: () => number = Date.now) {
		this.#now = now;
		this.#deadlineAtMs = now() + config.limits.totalDeadlineMs;
		this.#requests = new RequestBudget(config.limits.maxPublicRequests);
		this.#categoryBudgets = {
			delegated: new RequestBudget(config.limits.maxDelegatedRequests),
			dht: new RequestBudget(config.limits.maxDhtRequests),
			provider: new RequestBudget(config.limits.maxProviderRequests),
			relay: new RequestBudget(config.limits.maxRelayRequests),
		};
		this.#relayCandidates = new RequestBudget(config.limits.maxRelayCandidates);
		this.#reservationAttempts = new RequestBudget(config.limits.maxReservationAttempts);
	}

	/**
	 * Fails before work begins when the deadline, total cap, or category cap is exhausted.
	 * @param kind - Public request about to start.
	 */
	consume(kind: PublicOnlyRequestKind): void {
		this.assertActive();
		const category = requestCategory(kind);
		if (this.#requests.remaining === 0 || this.#categoryBudgets[category].remaining === 0) {
			throw new PublicOnlyBudgetError("request-budget-exhausted");
		}
		this.#categoryBudgets[category].consume();
		this.#requests.consume();
		this.#byKind.set(kind, (this.#byKind.get(kind) ?? 0) + 1);
	}

	/** Charges one bounded public-relay candidate before it is evaluated. */
	consumeRelayCandidate(): void {
		this.assertActive();
		if (this.#relayCandidates.remaining === 0) throw new PublicOnlyBudgetError("request-budget-exhausted");
		this.#relayCandidates.consume();
	}

	/** Charges one bounded Relay v2 reservation attempt before HOP/RESERVE work begins. */
	consumeReservationAttempt(): void {
		this.assertActive();
		if (this.#reservationAttempts.remaining === 0) throw new PublicOnlyBudgetError("request-budget-exhausted");
		this.#reservationAttempts.consume();
	}

	/** Fails if the run's one parent deadline has elapsed. */
	assertActive(): void {
		if (this.#now() >= this.#deadlineAtMs) throw new PublicOnlyBudgetError("deadline-exceeded");
	}

	/** @returns A sanitized accounting snapshot with no endpoints or identities. */
	snapshot(): PublicOnlyBudgetSnapshot {
		return {
			byKind: Object.fromEntries(this.#byKind),
			consumed: this.#requests.consumed,
			deadlineAtMs: this.#deadlineAtMs,
			hardCap: this.#requests.limit,
			relayCandidates: {
				consumed: this.#relayCandidates.consumed,
				hardCap: this.#relayCandidates.limit,
			},
			remainingMs: Math.max(0, this.#deadlineAtMs - this.#now()),
			reservationAttempts: {
				consumed: this.#reservationAttempts.consumed,
				hardCap: this.#reservationAttempts.limit,
			},
		};
	}
}

/** Typed fail-closed error emitted before over-budget public work begins. */
export class PublicOnlyBudgetError extends Error {
	readonly terminal: "deadline-exceeded" | "request-budget-exhausted";

	/** @param terminal - Typed budget terminal safe for evidence. */
	constructor(terminal: PublicOnlyBudgetError["terminal"]) {
		super(terminal);
		this.name = "PublicOnlyBudgetError";
		this.terminal = terminal;
	}
}

/**
 * @param kind - Request kind being accounted.
 * @returns The category cap charged by a request, if it has one.
 */
const PUBLIC_ONLY_REQUEST_CATEGORIES = {
	"amino-bootstrap": "dht",
	"delegated-closest-peers": "delegated",
	"delegated-provider-lookup": "delegated",
	"dht-provider-lookup": "dht",
	"dht-provide": "dht",
	"provider-dial": "provider",
	"relay-dial": "relay",
	"relay-reserve": "relay",
} as const satisfies Record<PublicOnlyRequestKind, "delegated" | "dht" | "provider" | "relay">;

function requestCategory(kind: PublicOnlyRequestKind): "delegated" | "dht" | "provider" | "relay" {
	return PUBLIC_ONLY_REQUEST_CATEGORIES[kind];
}
