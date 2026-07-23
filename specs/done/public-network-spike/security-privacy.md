# Security and Privacy Analysis

## Trust boundaries

Public routing, delegated endpoints, registries, and relay candidates are
untrusted inputs. Signed rendezvous proves control of the key bound to a Peer
ID and the freshness of a bounded record. It does not prove DRP membership,
object authorization, benign behavior, reachability, or relay capacity.
Application authorization remains separate and occurs after discovery.

The public campaign has a separate authorization boundary from ordinary code:
configuration must assert explicit operator consent, endpoint allowlists,
independent operators, and distinct real egress, while the protected workflow
requires a named checked-in executor. Code can validate those declarations and
distinct values; it cannot prove external operator ownership, physical egress
independence, or human review. Those remain release approvals. Ordinary
pull-request CI and production do not import campaign authority; only the
protected manual campaign workflow does.

## Threats and controls

| Threat                                 | Control and residual risk                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace and membership leakage       | Use opaque versioned per-network namespaces, short TTLs, bounded responses, and no global enumeration. Registries and routing endpoints can still observe queries, timing, source network, Peer IDs, and returned addresses. Per-object namespaces reduce cross-room linkage but increase lifecycle and query surface.                                                                                                                                |
| Address leakage and DNS rebinding      | Signed records cap and filter address families. Spike routing filters through `AddressPolicy`, and the isolated grid's injected host gate rechecks DNS at dial time. Production still defaults to an allow-all dial gate when no policy is injected, so universal single-owner enforcement is a production gate rather than a shipped guarantee. Publicly dialable addresses are inherently disclosed to selected services and peers.                 |
| Malicious routing results              | Treat every result as a candidate. Cap, deduplicate, classify, identify, and validate before use. Routing never grants membership or authorization. Coordinated poisoned results can still degrade availability until owned fallback.                                                                                                                                                                                                                 |
| Sybil and eclipse attacks              | Limit clients, namespaces, records, responses, attempts, concurrency, and operator concentration. Require independent registry endpoints and owned fallback. Invite/allowlist admission raises control; proof-of-work only raises cost. Public/open membership cannot prevent determined Sybil or operator collusion.                                                                                                                                 |
| Replay and equivocation                | Bind canonical records to Peer ID/public key, namespace, sequence, issue/expiry time, capabilities, and signature. Enforce monotonic sequence and reject equal-sequence divergent payloads. Endpoint compromise can suppress fresh records but cannot forge a valid signer.                                                                                                                                                                           |
| Registry abuse and resource exhaustion | Apply bounded TTL, record/address/response sizes, client and namespace quotas, rate windows, literal endpoint deadlines, and capped reconciliation. Open admission is explicitly unsafe. Invite distribution and allowlist maintenance become operator responsibilities.                                                                                                                                                                              |
| Relay deception and exhaustion         | Separate HOP advertisement from decoded reservation acceptance; validate limits and expiry; cap candidate search and lifecycle queues; rotate or fall back under one deadline. A malicious relay can observe metadata and disrupt traffic before direct upgrade. End-to-end application security must not depend on relay trust.                                                                                                                      |
| Endpoint observation and correlation   | Use multiple endpoints, minimal bounded requests, short TTLs, and per-run pseudonyms. Operators can still correlate source IP, time, namespace, and query type. No telemetry promise can erase operator-side logs.                                                                                                                                                                                                                                    |
| Telemetry retention                    | Commit only schema-validated aggregates and run-scoped pseudonyms. Raw addresses, Peer IDs, namespaces, credentials, network descriptors, and traces stay under ignored local raw storage. The repository enforces path/ignore boundaries but does not delete raw files; deployments must define retention and deletion. Never treat a stable hash of a public identifier as anonymization.                                                           |
| Credential and authorization confusion | Admission credentials authorize registration policy only. They do not authorize DRP/object actions and are never stored in records, telemetry, or reports. URL userinfo and credential-bearing configuration are rejected.                                                                                                                                                                                                                            |
| Campaign misuse                        | Compute the work and hard request ceiling before consent; serialize requests; enforce cooldown, per-task deadlines, target-role allowlists, and immediate stop on rate limits or operator terms. The gate rejects executor metadata reporting retries or redirects, but a separately reviewed executor must prove its metadata matches actual I/O. No executor exists on this blocked ref. Absence of authorization produces a zero-request artifact. |

## Privacy decision

Public rendezvous is acceptable only for deployments whose operators and users
accept disclosure of coarse network membership and addresses to the configured
services. The default namespace is opaque and network-scoped, but opacity is
not confidentiality. Deployments requiring hidden membership must use an owned,
access-controlled rendezvous service and should not publish the namespace or
records to the public DHT.

Durable decision evidence must remain aggregate-only. Operator/ASN diversity is
reported only at the decision-cell level; identity-to-operator mappings are not
retained. The Node public-evidence helper uses an injected secret salt. The
campaign schema accepts run-scoped pseudonym formats but cannot prove how an
external executor derived them, so an authorized executor must use a secret
per-run salt and undergo review before cross-run unlinkability can be claimed.

## Security gates before production

- Complete threat modeling for the selected registry deployment and admission
  mode.
- Define credential issuance, rotation, revocation, and incident response.
- Require a production `AddressPolicy` instead of the current allow-all default
  when no injected gate is present.
- Define registry and relay data-retention policies, including operator logs.
- Run the authorized public campaign and refuse production public enablement if
  coverage, rate, latency, diversity, or stop-policy evidence is incomplete.
- Exercise compromise and partition scenarios across independently operated
  registries and owned fallback.

Implementation controls are pinned by the record, registry, relay, public
campaign, redaction, and failure-campaign tests under
`packages/network-spike/tests/`.
