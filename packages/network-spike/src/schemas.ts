import { z } from "zod";

export const EVIDENCE_SCHEMA_VERSION = "1.0.0";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "expected a lowercase SHA-256 digest");
const TimestampSchema = z.string().datetime({ offset: true });
const NonEmptyRecordSchema = z.record(z.string().min(1), z.string().min(1)).refine((value) => {
	return Object.keys(value).length > 0;
}, "expected at least one entry");

export const EndpointClassSchema = z.enum([
	"public-dht",
	"delegated-routing",
	"signed-registry",
	"public-relay",
	"owned-fallback",
	"none",
]);

export const TransportProfileSchema = z.enum(["wss-only", "wss-wt-webrtc-direct"]);
export const BrowserSchema = z.enum(["chromium", "firefox", "webkit"]);
export const TrialStatusSchema = z.enum(["success", "failure", "environment-blocked"]);

export const DeadlineBudgetSchema = z
	.object({
		parentMs: z.literal(30_000),
		children: z
			.object({
				endpointMs: z.literal(8_000),
				candidateAndFallbackMs: z.literal(5_000),
				ownedFallbackMs: z.literal(12_000),
				cleanupMs: z.literal(5_000),
			})
			.strict(),
	})
	.strict()
	.superRefine((budget, context) => {
		const allocated = Object.values(budget.children).reduce((total, child) => total + child, 0);
		if (allocated > budget.parentMs) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `child budgets allocate ${allocated}ms but parent permits ${budget.parentMs}ms`,
				path: ["children"],
			});
		}
	});

export const DecisionRuleSchema = z
	.object({
		id: z.string().min(1),
		evidencePhase: z.string().regex(/^phase-(?:0[0-9]|10)$/u),
		cellDimensions: z.array(z.string().min(1)),
		minimumSampleCount: z.number().int().positive(),
		statistic: z.enum(["observed-rate", "p95", "all-pass", "minimum-diversity", "report-only"]),
		ciMethod: z.enum(["wilson-95", "none"]),
		interpretation: z.enum(["public-observation", "deterministic-slo", "report-only"]),
		successThreshold: z.number().min(0).max(1).optional(),
		latencyThresholdMs: z.number().int().positive().optional(),
		fallbackLatencyThresholdMs: z.number().int().positive().optional(),
		minimumOperatorGroups: z.number().int().positive().optional(),
	})
	.strict()
	.superRefine((rule, context) => {
		if (rule.statistic === "observed-rate" && rule.ciMethod !== "wilson-95") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "observed-rate rules must declare Wilson 95% confidence intervals",
				path: ["ciMethod"],
			});
		}
		if (rule.statistic === "report-only" && rule.interpretation !== "report-only") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "report-only statistics must use report-only interpretation",
				path: ["interpretation"],
			});
		}
		if (
			rule.statistic !== "report-only" &&
			rule.statistic !== "minimum-diversity" &&
			rule.successThreshold === undefined &&
			rule.latencyThresholdMs === undefined &&
			rule.fallbackLatencyThresholdMs === undefined
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "non-report-only rules must freeze a success or latency threshold",
				path: ["statistic"],
			});
		}
		if (rule.statistic === "minimum-diversity" && rule.minimumOperatorGroups === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "minimum-diversity rules must freeze a minimum operator-group count",
				path: ["minimumOperatorGroups"],
			});
		}
	});

export const ThresholdSetSchema = z
	.object({
		id: z.string().min(1),
		version: z.number().int().positive(),
		frozenAt: TimestampSchema,
		rules: z.array(DecisionRuleSchema).min(1),
	})
	.strict()
	.superRefine((thresholdSet, context) => {
		const ids = thresholdSet.rules.map((rule) => rule.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "decision rule IDs must be unique",
				path: ["rules"],
			});
		}
	});

export const CoverageRequirementSchema = z
	.object({
		decisionId: z.string().min(1),
		evidencePhase: z.string().regex(/^phase-(?:0[0-9]|10)$/u),
		dimensions: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
		minimumSampleCount: z.number().int().positive(),
	})
	.strict();

export const ThresholdAmendmentSchema = z
	.object({
		kind: z.literal("threshold-change"),
		recordedAt: TimestampSchema,
		beforeFingerprint: Sha256Schema,
		afterFingerprint: Sha256Schema,
		rationale: z.string().min(20),
		invalidatesComparability: z.literal(true),
	})
	.strict();

export const CampaignAmendmentSchema = z
	.object({
		kind: z.literal("campaign-change"),
		recordedAt: TimestampSchema,
		beforeFingerprint: Sha256Schema,
		afterFingerprint: Sha256Schema,
		rationale: z.string().min(20),
		invalidatesComparability: z.literal(true),
	})
	.strict();

export const AmendmentSchema = z.discriminatedUnion("kind", [ThresholdAmendmentSchema, CampaignAmendmentSchema]);

export const RedactionStateSchema = z
	.object({
		state: z.literal("redacted"),
		saltScope: z.literal("per-run"),
		saltId: z.string().regex(/^salt_[a-f0-9]{12}$/u),
		peerIds: z.literal("per-run-pseudonyms"),
		namespaces: z.literal("per-run-pseudonyms"),
		diversity: z.literal("aggregate-only"),
		sensitiveValueDigests: z.array(Sha256Schema).min(1),
		rawOutputDirectory: z.string().regex(/^\.network-spike-raw\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/u),
	})
	.strict()
	.superRefine((redaction, context) => {
		const segments = redaction.rawOutputDirectory.split("/");
		if (segments.some((segment) => segment === "." || segment === "..")) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "raw output paths cannot contain dot segments",
				path: ["rawOutputDirectory"],
			});
		}
	});

export const PublicCampaignPlanSchema = z
	.object({
		conditions: z.array(z.string().min(1)).min(2),
		browsers: z.array(BrowserSchema).length(3),
		nodeIdentitiesPerCondition: z.literal(100),
		browserIdentitiesPerBrowserCondition: z.literal(100),
		transportProfileSplit: z
			.object({
				"wss-only": z.literal(50),
				"wss-wt-webrtc-direct": z.literal(50),
			})
			.strict(),
		endpointCallCaps: z
			.object({
				nodeRoutingPerIdentity: z.number().int().positive(),
				delegatedPerBrowserIdentity: z.number().int().positive(),
				registryPerBrowserIdentity: z.number().int().positive(),
				relayPerBrowserIdentity: z.number().int().positive(),
				gridCanaryPerBrowserCondition: z.number().int().positive(),
			})
			.strict(),
	})
	.strict()
	.superRefine((plan, context) => {
		if (new Set(plan.conditions).size !== plan.conditions.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "real network-condition labels must be unique",
				path: ["conditions"],
			});
		}
		if (new Set(plan.browsers).size !== 3) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "the browser matrix must contain Chromium, Firefox, and WebKit exactly once",
				path: ["browsers"],
			});
		}
	});

export const ExperimentManifestSchema = z
	.object({
		schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
		runId: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
		startedAt: TimestampSchema,
		git: z
			.object({
				sha: z.string().regex(/^[a-f0-9]{40}$/u),
				dirty: z.boolean(),
				lockfileDigest: Sha256Schema,
			})
			.strict(),
		versions: z
			.object({
				packages: NonEmptyRecordSchema,
				browsers: NonEmptyRecordSchema,
				node: z.string().min(1),
				pnpm: z.string().min(1),
				os: z.string().min(1),
			})
			.strict(),
		seed: z.number().int().nonnegative(),
		target: z.enum(["node", "browser", "public-campaign"]),
		networkCondition: z.string().min(1),
		transportProfile: z.union([TransportProfileSchema, z.literal("balanced-matrix")]),
		endpointClasses: z.array(EndpointClassSchema).min(1),
		thresholdSetFingerprint: Sha256Schema,
		publicCampaignFingerprint: Sha256Schema,
		hardRequestCap: z.number().int().positive(),
		evidenceChecksums: z
			.record(z.string().min(1), Sha256Schema)
			.refine((checksums) => Object.keys(checksums).length > 0, "expected at least one evidence checksum"),
		redaction: RedactionStateSchema,
		deadlineBudget: DeadlineBudgetSchema,
		publicCampaign: PublicCampaignPlanSchema,
		amendments: z.array(AmendmentSchema),
	})
	.strict()
	.superRefine((manifest, context) => {
		const expectedPrefix = `.network-spike-raw/${manifest.runId}`;
		if (
			manifest.redaction.rawOutputDirectory !== expectedPrefix &&
			!manifest.redaction.rawOutputDirectory.startsWith(`${expectedPrefix}/`)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "raw output must be scoped beneath the current run ID",
				path: ["redaction", "rawOutputDirectory"],
			});
		}
		for (const browser of manifest.publicCampaign.browsers) {
			if (manifest.versions.browsers[browser] === undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `missing exact resolved version for ${browser}`,
					path: ["versions", "browsers", browser],
				});
			}
		}
	});

export const TrialResultSchema = z
	.object({
		schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
		trialId: z.string().min(1),
		runId: z.string().min(1),
		decisionId: z.string().min(1),
		evidencePhase: z.string().regex(/^phase-(?:0[0-9]|10)$/u),
		identityPseudonym: z.string().regex(/^peer_[a-f0-9]{12}$/u),
		namespacePseudonym: z.string().regex(/^ns_[a-f0-9]{12}$/u),
		dimensions: NonEmptyRecordSchema,
		status: TrialStatusSchema,
		startedAt: TimestampSchema,
		finishedAt: TimestampSchema,
		durationMs: z.number().int().nonnegative(),
		fallbackDurationMs: z.number().int().nonnegative().optional(),
		requestCount: z.number().int().nonnegative(),
		endpointClass: EndpointClassSchema,
		telemetryChecksum: Sha256Schema,
	})
	.strict()
	.superRefine((trial, context) => {
		if (Date.parse(trial.finishedAt) < Date.parse(trial.startedAt)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "finishedAt cannot precede startedAt",
				path: ["finishedAt"],
			});
		}
		const elapsedMs = Date.parse(trial.finishedAt) - Date.parse(trial.startedAt);
		if (trial.durationMs !== elapsedMs) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `durationMs must equal the timestamp delta (${elapsedMs}ms)`,
				path: ["durationMs"],
			});
		}
		if (
			(trial.endpointClass === "none" && trial.requestCount !== 0) ||
			(trial.endpointClass !== "none" && trial.requestCount === 0)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "requestCount must be positive for endpoint work and zero when endpointClass is none",
				path: ["requestCount"],
			});
		}
	});

export const DecisionOutcomeSchema = z
	.object({
		decisionId: z.string().min(1),
		acceptance: z.enum(["pass", "fail", "report-only", "environment-blocked"]),
		sampleCount: z.number().int().nonnegative(),
		metrics: z
			.object({
				observedRate: z.number().min(0).max(1),
				fallbackP95Ms: z.number().int().nonnegative().optional(),
				p95Ms: z.number().int().nonnegative().optional(),
				successCount: z.number().int().nonnegative(),
				wilson95: z
					.object({
						lower: z.number().min(0).max(1),
						upper: z.number().min(0).max(1),
					})
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
		relayDiversity: z
			.object({
				acceptedReservations: z.number().int().nonnegative(),
				operatorGroupCount: z.number().int().nonnegative(),
				rawAggregateChecksum: Sha256Schema,
				sourceTrialIdsChecksum: Sha256Schema,
				verification: z.literal("local-raw-aggregate-attestation"),
			})
			.strict()
			.optional(),
		summary: z.string().min(1),
	})
	.strict()
	.superRefine((outcome, context) => {
		if (outcome.metrics !== undefined) {
			if (outcome.metrics.successCount > outcome.sampleCount) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "successCount cannot exceed sampleCount",
					path: ["metrics", "successCount"],
				});
			}
			if (outcome.metrics.wilson95 !== undefined && outcome.metrics.wilson95.lower > outcome.metrics.wilson95.upper) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Wilson interval lower bound cannot exceed its upper bound",
					path: ["metrics", "wilson95"],
				});
			}
		}
	});

export const EvidenceReportSchema = z
	.object({
		schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
		status: z.enum(["complete", "partial"]),
		comparability: z.enum(["comparable", "invalidated"]),
		partialReason: z.string().min(1).optional(),
		manifest: ExperimentManifestSchema,
		thresholdSet: ThresholdSetSchema,
		coverageRequirements: z.array(CoverageRequirementSchema).min(1),
		trials: z.array(TrialResultSchema),
		decisions: z.array(DecisionOutcomeSchema).min(1),
		reportChecksum: Sha256Schema,
	})
	.strict()
	.superRefine((report, context) => {
		if (report.status === "partial" && report.partialReason === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "partial reports must state the environmental or evidence blocker",
				path: ["partialReason"],
			});
		}
		if (
			report.status === "partial" &&
			!report.decisions.some((decision) => decision.acceptance === "environment-blocked")
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "partial reports must include an environment-blocked acceptance row",
				path: ["decisions"],
			});
		}
		if (
			report.status === "complete" &&
			report.decisions.some((decision) => decision.acceptance === "environment-blocked")
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "complete reports cannot contain environment-blocked acceptance rows",
				path: ["decisions"],
			});
		}
		if (report.manifest.amendments.length > 0 && report.comparability !== "invalidated") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "amended runs must be marked non-comparable",
				path: ["comparability"],
			});
		}
		if (report.manifest.amendments.length === 0 && report.comparability !== "comparable") {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "unamended runs must be marked comparable",
				path: ["comparability"],
			});
		}
	});

export type Browser = z.infer<typeof BrowserSchema>;
export type CoverageRequirement = z.infer<typeof CoverageRequirementSchema>;
export type DeadlineBudget = z.infer<typeof DeadlineBudgetSchema>;
export type DecisionRule = z.infer<typeof DecisionRuleSchema>;
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;
export type PublicCampaignPlan = z.infer<typeof PublicCampaignPlanSchema>;
export type ThresholdSet = z.infer<typeof ThresholdSetSchema>;
export type TrialResult = z.infer<typeof TrialResultSchema>;
