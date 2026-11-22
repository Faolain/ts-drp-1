# Profile-aware room authority-read-order causal RED

This command-only continuation uses signed/pushed checkout `5f6fb6c0e708dc31848931f06677e116659400e5` with unchanged tests `ba15bb894d324bb8d8a0d8a7da3f3e61042a0283`, SHA256 `66c26d38e25ed8bc3c765faab58a0167ca289efb4d97f438eac695c5af93e2a1`. The only execution-command addition is `--reporter=default` alongside the preserved JSON reporter and output path. No test, source, configuration, dependency, limit, timeout or selection was changed.

## Exact result

One unfiltered isolated run: **13 total, 11 passed, 2 causal failures, 0 skipped**, no suite message or top-level anomaly. Vitest exited 1 as expected; the exact evidence validator exited 0. Both frozen failing titles remain: the original unsupported-cold-composition guard and the additive complete-profile probe. The additive assertion retains `F5B_ROOM_GUARD_PROFILE_AUTHORITY_READ_ORDER`.

Exactly one bounded stdout JSON record captures eight rows before assertions. Every actual row has detail `D.108e2b application authority was read` and reads `{application:1,signer:0,store:0,transport:0}`.

| Composition with successor declaration | Legacy profile | Settlement profile |
| --- | --- | --- |
| Policy factory | Forbidden violation | Forbidden violation |
| Rebase invite | Forbidden violation | Forbidden violation |
| Creator finality signer | Forbidden violation | Permitted control passes |
| Declaration only | Permitted control passes | Permitted control passes |

Thus all five forbidden rows violate the exact required unsupported-composition refusal and zero-authority-read contract; all three permitted controls pass. Full names, durations, messages, raw stdout/stderr, reporter and observed values are retained. No missing import, fixture-genesis error, timeout, loader failure, changed token or observation anomaly occurred. Root acceptance is pending; this evidence itself makes no production GREEN claim.

## Independent preparation and static debt

Fresh checkout `/tmp/d110c-f5b-red-room-guard-reporters-L8TTrA/checkout` has its own frozen offline install, official locked native prebuild download in a fresh cache, direct addon import, full source build and fresh Node root import. Archive and native binary copies/hashes are retained. It has no pending parent overlay, copied dist or dependencies linked to main. Both stopped checkouts and evidence roots remain unchanged.

The locked reporter smoke parses the exact CLI and resolves both built-ins through the actual configuration: `silent:false`, no `onConsoleLog` hook. The real DefaultReporter sink retains one exact standalone marker; JsonReporter has no console handler. This mechanical check invokes no room constructor or test and does not alter configuration. The actual runtime retains both the readable failure output and complete JSON.

Independent execution of the exact signed helper verified both product-built genesis signatures, canonical carriers, anchor identity and carrier digest bindings before any constructor/test invocation. No room/epoch/adoption state was manufactured. These are real genesis inputs to a classification boundary, not signer-trust or activation proof; the genuine parent integration remains that owner.

Lint, format, syntax, exact thirteen-title listing and unchanged-twelve-body custody pass. Target diagnostics are zero. One same-program in-memory comparison against original signed `61a793d3` establishes exact equality of all **41 external diagnostics**, including file, code, full message, line, column, length, start and token. These remain OPEN with the existing creator-adoption and successor-product fixture static-contract owners, due before parent static closure. This is not a blanket typecheck pass.

## Custody and compatibility

Before/after checks preserve the eight dirty owners and patch SHA256 `245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed`, seven main built artifacts, 78 other retained/shared files, 27 stashes, 86,522 protected paths and all prior evidence manifests. Both earlier stopped attempts remain unaccepted and immutable; their missing observations are not retroactively filled from this run.

The measured cause matches the signed design-compatible freeze: bootstrap application access precedes refusal. Legacy behavior must regain early refusal while settlement signer/declaration composition remains allowed to proceed to application validation. No new API or authentication choice is selected; later genesis/floor/signer verification and genuine creator cold reopen remain production requirements. No main runtime, repeated baseline, wide workload, reviewer or production edit occurred. Root owns acceptance and any authorization to the separate GREEN owner.
