# Room authority-read-order observation-capture stop

Tests `ba15bb894d324bb8d8a0d8a7da3f3e61042a0283` are signed/pushed. Relative to signed plan `435bb0ef753b3d62729e776e476a22f26ba73c9f`, the only test change is `createV3ChatApplication("guard")` → `createV3ChatApplication("alice")`. All other bytes, all twelve original bodies and the new eight-row probe remain unchanged.

The sole unfiltered isolated execution produced **13 total, 11 passed, 2 failed, 0 skipped**, with no suite message or top-level error. Both failures are the frozen titles:

- Original: `rejects only unsupported cold successor compositions before reading room authorities`; raw failure begins `AssertionError: expected [ { …(3) }, { …(3) }, { …(3) } ] to deeply equal`.
- Additive: `classifies complete legacy and settlement successor compositions before reading room authorities`; raw failure includes `F5B_ROOM_GUARD_PROFILE_AUTHORITY_READ_ORDER` and an abbreviated eight-row comparison.

**This is not accepted causal RED.** The required bounded eight-row JSON observation is absent from stdout and from the JSON reporter. Locked Vitest 3.1.1 intercepts console output through `onUserConsoleLog`; its JSON-only reporter has no corresponding handler and writes assertion stack summaries rather than actual comparison values. Raw stdout contains only the JSON-report path. The recorder therefore correctly preserves an observation-incomplete stop (status 2); Vitest itself exited 1. Zero captured observations means missing evidence, not zero actual authority reads. The five-forbidden/three-permitted measured outcome remains unproved and must not be inferred from the aggregate counts or source.

All prerequisites passed: fresh exact signed checkout without the parent overlay; own frozen offline installation; own official locked NAPI prebuild download and retained archive/binary hashes; direct addon and fresh Node root imports; full source build; exact source/runtime identity; independent actual-genesis-signature and canonical-carrier validation for both profiles; lint/format; exact thirteen-title list; zero target diagnostics. A single same-program comparison against original signed `61a793d3` proves all 41 external diagnostics exactly unchanged, including full messages, positions and tokens. They remain OPEN with the existing creator-adoption and successor-product fixture static-contract owners, due before parent static closure; no blanket typecheck pass is claimed.

The prior stopped `da874b52` checkout and its 84-entry evidence manifest remain untouched. Before/after custody preserves eight dirty production owners and patch SHA256 `245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed`, seven main built files, 78 other retained/shared files, 27 stashes and 86,522 protected paths. No main runtime, production/plan/source/config change, repeated baseline, campaign, reviewer or second test run occurred.

Root owns the next smallest observation-capture correction and its freeze. No test or launcher repair was attempted after this sole run. `seal.mjs` is the unexecuted prospective acceptance checker; `seal-stopped.mjs` seals this actual stopped result instead.
