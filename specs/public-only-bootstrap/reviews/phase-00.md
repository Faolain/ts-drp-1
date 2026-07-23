# Slice 00 Review Record

Date: 2026-07-20

No public network traffic was sent during this slice.

## Initial rejection

Grok rejected the first contract draft because non-canonical loopback forms and
loosely parsed multiaddrs could authorize private targets, provider dials had no
category budget, and relay candidate/reservation limits were not owned by the
runtime ledger.

The revision replaced public-looking string heuristics with code-owned exact
allowlists, reused the address policy's IP scope classifier for fresh DNS
answers, added an explicit provider budget, made request-kind ownership
exhaustive, and added separate relay-candidate and reservation-attempt ledgers.
It also froze strict browser input, milestone, and verdict schemas.

## Final independent verdicts

- Grok, maximum available reasoning: `VERDICT: ACCEPT`
- Kimi, thinking mode with 100-step allowance: `VERDICT: ACCEPT`

Both reviewers verified the odd-loopback, arbitrary-endpoint/seed, DNS
rebinding, budget, anti-cheat, zero-request, sanitization, browser-projection,
typed-evidence, and parent-deadline cases. Kimi's non-blocking observation that
a future request kind could fall through to the provider category was also
removed by an exhaustive `Record<PublicOnlyRequestKind, Category>` mapping.

## Local gate

- 33 public-only contract tests passed.
- 10 Node-routing regression tests passed.
- `@ts-drp/network-spike` typecheck passed.
- Focused ESLint passed.
