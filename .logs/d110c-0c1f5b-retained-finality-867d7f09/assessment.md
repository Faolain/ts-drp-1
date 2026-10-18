# Parent f5b retained finality-roster correction

Signed/pushed tests-only commit `867d7f09a78bb106cae10419b636bfa3638b11d6` (G) implements only the prospective scope authorized at signed `15c66947ea8ece4eb5bf0a9bc0e7632e749b209c`. Exactly three array literals gain the existing `signCreatorIssuanceRetirementRequest` in sorted position: seal-types EXPECTED_EXPORTS.keychain, creator-actor-contract EXPECTED_EXPORTS.finality, and the creator-actor test's literal finality list. Exact equality remains enforced against precisely four exports.

AST span comparison proves every byte outside those array spans unchanged. The complete seal-safety test, all assertions/titles/counts, helper/type/API declarations, model, limits, and parent tests remain byte-identical. The actual keychain finality source is byte-identical to signed `d77ee315a7688cffb5fd55870c38231403ecc41f`, not merely an export-name match. No new API, production change, fixture scope expansion, subset equality, or registry-freeze repair was introduced. No design/code contradiction was found.

## Retained baseline and one isolated execution

The old gates 31/32 remain immutable in `.logs/d110c-0c1f5b-green-ab98cce6/`: 7+12 cases, 17 passed and two exact export-roster failures. Its 458-entry manifest validates at SHA-256 `16888af6758fb12fa0cf4c55cf231babac0b468665e04b7a8e6f4976a4f41523`. Neither those old gates nor any parent causal RED were rerun or relabeled.

A fresh sparse checkout at `/tmp/d110c-f5b-retained-finality-RkJzXV/checkout` was detached at the signed/pushed tests commit. Independent `pnpm install --offline --frozen-lockfile --ignore-scripts` completed without downloads, followed by the complete `pnpm build:packages` source build. No pending eight-owner patch, copied dist, linked main node_modules, or diagnostic runtime configuration was applied. Before/after source and runtime hashes match; tracked source is clean. Dependencies resolve within the independent installation. Node v22.15.0 and pnpm 10.24.0 are recorded.

Exact collection matched all 19 old file/title pairs: seven seal-safety and twelve creator-actor tests. The command and matrix were frozen before execution. Matrix SHA-256: `5b9ef72dd2ade61afced2f28eeffa87faebc07f2363a859be3b7b3adf251ded0`. The unchanged command runs only those two relative file paths with `--no-file-parallelism --coverage.enabled=false --reporter=json` and a fresh output path; there is no name filter or workload/timeout change.

The sole runtime returned status 0, success true, **19 total / 19 passed / 0 failed / 0 skipped**. There are no failure messages, suite messages, testExecError, unhandled errors, loader/fixture/timeout anomalies, or stderr output. All exact selected names and individual durations are preserved in result.json and the complete raw focused.json. Reporter SHA-256: `94e77d17b3cbcfe7d7b30bd39a578cca7f68ae4ad81bf4cdae7c336c44bd6f6c`.

The unchanged bounded n=4 Quint witness passed in 2390.5595 ms. The previously blocked certified-roster-key test passed in 112.443584 ms, now reaching its unchanged genuine signer binding, real signature verification, consumed-request, and raw-digest-rejection assertions after the exact export check. All twelve actor cases passed, including durable close, QC reopening, ambiguity/conflict handling, raw-digest/copy rejection and stop fencing. This is retained baseline preservation, not new parent causal RED or acceptance of the dirty parent production patch.

## Static findings: explicit inherited typing debt

Main and isolated exact-source lint and formatting passed, as did test diff, syntax, exact collection, and source build. The bounded TypeScript program did NOT pass: original isolated-preflight status 1 and its complete output remain preserved. It reported four TS2345 diagnostics in the unchanged seal-safety test at lines 300, 355, 488 and 532, zero diagnostics in the three edited owners, and zero external diagnostics.

The existing Phase 3b certificate fixture's `installInput` is declared `Readonly<Record<string, unknown>>`; the typed `installCertifiedAnchorTrustRoot` expects the five named canonical certificate/profile/signer-set/anchor inputs. These four unchanged call sites therefore fail static assignability. No helper, type, test, or production source was edited to address this debt.

Per root's explicit direction, one bounded read-only comparison used the exact same compiler program/options with only the three corrected files supplied in memory from signed pre-correction 15c66947. The complete diagnostics were byte-equivalent: four target / zero external / zero edited-owner diagnostics. The test, fixture and protocol source files involved are themselves byte-identical to that baseline. typecheck-inherited-attribution.json records the full current/baseline comparison and hashes. No source file was restored on disk; no build or runtime was repeated.

Root authorized the planned single runtime after that exact attribution. freeze.mjs separately validates the inherited-diagnostic result and successful collection; the original failed preflight was not modified or reexecuted. This is inherited Phase 3b certificate-fixture / retained-static debt, with deadline before applicable parent static closure. No target-wide or package-wide TypeScript pass is claimed.

One read-only source search initially referenced a nonexistent seal-runtime.ts and an unmatched static-output shell glob; corrected direct imports located the actual Phase 3b fixture. This was diagnostic-only and caused no source changes or runtime rerun.

## Custody and handoff

All eight dirty production owners and their full-index binary patch remain unchanged at SHA-256 `245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed`. All 27 stashes match, all 86,522 protected paths exist, and all nine named immutable evidence manifests validate. Protected seal-safety/parent tests and the formal model remain byte-identical. Before/after custody includes exact permitted array spans, existing API source attribution, source/runtime/config hashes and signatures.

Complete raw reporter, stdout/stderr, command/status, collection, static diagnostics, inherited comparison, build/install logs, and isolation records are sealed by the self-excluding manifest. No main runtime, accepted parent RED, additional retained gate, campaign, long worker, model reviewer, browser or subagent ran. No post-run source edit or runtime repetition occurred.

Root owns acceptance/plan status. The separate GREEN owner must run these same 19 cases against the preserved parent patch after acceptance. This baseline result does not clear other retained debt, authorize registry-freeze repair, close parent f5b, or commit production.
