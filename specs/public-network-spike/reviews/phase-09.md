# Phase 09 Review: Opt-In Public Campaign

Phase 09 implements the fail-closed public-campaign control plane described by
[slice 09](../slices/09-public-campaign.md). No public trial was authorized or
executed. The committed result is therefore an honest `environment-blocked`
artifact with zero observations, zero requests, and the issue criterion left
unsatisfied.

## Authorization and bounded execution

`PublicCampaignConfig` requires the exact consent phrase in both protected
configuration and the command line, the frozen Phase 09 plan, two independent
registry origins/operators, explicit endpoint-role allowlists, two authorized
real-egress descriptors, one-request concurrency, an end-to-start cooldown,
stop-on-rate-limit/terms policies, exact version metadata, and a run-scoped raw
directory. Placeholder authorization, `.invalid` endpoints, placeholder
versions, changed campaign caps, duplicate conditions, and missing independent
egress evidence fail preflight.

The frozen plan is computed before consent: 200 cold Node identities, 600
browser identities balanced 50/50 by transport, six grid canaries, 806 total
tasks, and a 12,920-request hard ceiling. A single serialized gate owns that
ceiling, cooldown, target allowlists, endpoint-role ownership, and immediate
rate-limit/terms stops. Per-task gates separately cap DHT, delegated, registry,
relay, and grid traffic. The composed grid canary may use every one of those
owners but shares one 20-request cap across them; completion requires DHT
anchor provide/lookup, delegated lookup, registry register/discover, relay
reserve/dial, and the direct canary. Registry registration/refresh/discovery
and DHT provide/reprovide/lookup consume the same ledger as every other public
request. A complete campaign must reach both configured registry origins.
Every task also has a validated 1–120 second deadline propagated to the
executor; a hung task settles as `task-timeout`.

## Evidence integrity and privacy

The runner binds every parsed observation to the exact scheduled identity,
condition, browser, transport profile, target, and decision set that produced
it. A complete task cannot omit or duplicate required decision evidence.
Coverage then refuses missing cells, reused decision identities, fewer than 600
relay-diversity identities, or fewer than the frozen two operator groups among
accepted reservations.

Registry-only failure is represented by a typed `registry-outage` partial cell;
the driver must have attempted a matching registry request, and it cannot
silently relabel another endpoint owner. The same proof exists for DHT,
delegated, relay, and grid partials.

Sanitized observation parsing accepts only per-run pseudonyms and bounded
protocol identifiers. Raw multiaddrs, IP locator segments, domain locators, and
Peer-ID-shaped protocol segments are rejected. Protected preflight output emits
only blocker codes, the precomputed public matrix, and a run ID; consent,
endpoints, DHT targets, and network authorization references are never printed.
The workflow retains that sanitized preflight artifact even when execution is
refused.

Per-trial observations exist only in memory for schema, task-binding, coverage,
and aggregation. Authorized durable output contains an observation count and
39 aggregates at each decision's exact pre-registered dimensions; it does not
contain identity-to-operator/IP/ASN rows. This prevents both privacy-sensitive
correlation and statistically invalid pooling across Node, browser, condition,
transport-profile, and canary populations.

## Runnable surfaces and blocked evidence

The local `public-campaign` command separates preflight from explicit
`--execute`. Task composition is fixed in the repository-owned reviewed driver;
the workflow accepts only a strict module basename for a checked-in protocol
executor below `packages/network-spike/src/public-campaign-executors/`, and the
CLI resolves that directory from its own module URL rather than the caller's
working directory. No executor is present on this environment-blocked ref, so
neither the workflow nor the CLI can make public requests even if invoked. An
authorized execution requires a separately reviewed ref that adds the
environment-specific executor under that directory. The serialized gate,
not the task driver, invokes that executor once per frozen request and requires
metadata proving one non-redirected top-level attempt. The GitHub workflow is
`workflow_dispatch`-only, uses a protected environment and base64 configuration
secret, and uploads only sanitized preflight/result files. Ordinary CI and
production code never invoke the campaign.

The browser workbench renders the committed blocked report, all 20 frozen
matrix rows including six grid canaries, the three missing authorization
interlocks, the exact cap, and a prominent zero-public-egress verdict. Its
Chromium, Firefox, and WebKit test intercepts requests and fails on any
non-loopback destination.

## Adversarial review dispositions

The first maximum-budget Grok and Kimi passes returned `REJECT`. Their material
findings were valid:

- observations were schema-valid but not bound to their producing task;
- the frozen two-operator diversity minimum was not enforced;
- registry-only outage had no typed partial representation;
- free-form protocol strings could carry raw multiaddr/Peer-ID/IP material;
- request kinds were not bound to configured endpoint-owner roles.

All five findings now have direct regression tests. The smaller review notes
also led to end-to-start cooldown measurement, duplicate-condition rejection,
an immutable pre-registered plan, explicit grid-canary matrix rows, and
preflight artifact retention. Final maximum-budget reviewer reruns occurred only
after these dispositions, without rewriting the history of the initial
rejection.

A later Grok pass rejected the arbitrary external driver seam and its ambiguous
HTTPS-versus-dynamic-multiaddr accounting. The proactive Codex review also
found per-trial diversity leakage, pooled statistics, callback-owned I/O,
unbounded tasks, and a two-label hostname redaction hole. Those findings caused
the seam rewrite described above: repository-owned task composition, gate-owned
executor invocation, checked-in executor scope, task deadlines, aggregate-only
decision cells, and the stricter hostname predicate. The executor receives the
frozen task identity and keeps raw opportunistic relay locators private while
the gate accounts against the configured relay owner.

The final reruns found and then confirmed fixes for a caller-working-directory
executor path, abort during cooldown, host-shaped protocol values, and URL
userinfo. Executor selection is now a strict basename resolved from the CLI
module URL; cooldown abort happens before budget consumption; protocol parsing
rejects trailing-dot, punycode, numeric-suffix, and localhost locators while
retaining numeric semantic versions; and both config parsing and the runtime gate
reject URL credentials before accounting or invocation. The environment-blocked
contract also states explicitly that this ref has no public executor and that an
authorized execution ref must add one under separate review. Final Grok and Kimi
maximum-budget passes returned `ACCEPT`.

## Verification

- Network-spike package: 13 files and 190 tests passed after the final
  reviewer dispositions.
- Complete example Playwright matrix: 113/114 passed on the first run; the
  single Firefox grid-rendezvous timeout passed immediately in isolation
  (1/1). All three Phase 09 public-campaign cases passed in every browser.
- Repository `pnpm typecheck`: passed across every workspace project.
- Repository `pnpm lint`: passed with 0 errors and 80 existing
  documentation-rule warnings.
- Repository test matrix: 770/775 passed in a deliberately concurrent first
  run; all five timing/convergence failures passed in a single-worker rerun
  (28/28, with the suite's two intentional skips), confirming resource
  contention rather than a Phase 09 regression.
- Final mobile capture: 390 px client and document width, with no horizontal
  overflow.
- Capture listener: zero non-loopback requests.
- No public-network request was made.
