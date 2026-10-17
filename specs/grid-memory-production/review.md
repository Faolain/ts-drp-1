# Independent review and triage

These reviews concern test/report fidelity, not production memory acceptance, a whole-storage bound, or authorization for additional deletion. Reviewer agreement does not override a source-grounded finding.

## Candidate reviews

- [Codex public finding](../../.logs/grid-memory-attribution/native-codex-review-01/stdout.log): one P2. A generic rejected classification could pass for an unrelated startup failure. The test now asserts the exact snapshot-unavailable detail recorded by the canonical capture.
- [Opus xhigh result](../../.logs/grid-memory-attribution/native-opus-review-01/stdout.log): seven findings, all accepted after source checks. Corrections are listed below.
- [Grok public review](../../.logs/grid-memory-attribution/native-grok-review-01/public.txt): explicit PASS with scope limitations. The original runner recorded NO_VERDICT because the requested PASS format omitted its expected marker. That receipt is preserved. A [tool-free formatting correction](../../.logs/grid-memory-attribution/native-grok-terminal-format-01/public.txt) supplied the marker; it is not another independent review or approval of later edits.
- [Kimi terminal review](../../.logs/grid-memory-attribution/native-kimi-review-finalize-02/stdout.log): explicit PASS from the same session, under the process-local 100-step cap. The initial invocation rejected incompatible CLI flags; the subsequent source review timed out without a verdict. A first completion request omitted the session identifier's required prefix and failed. All attempts are preserved in the corresponding `native-kimi-review-*` logs. Only the successful same-session terminal result is counted, not the failed or timed-out attempts.

The reviews checked the original canonical capture against the candidate. They did not rerun tests or independently recompute every source hash. Kimi's PASS did not invalidate Opus's more precise issuance-gate finding. Grok and Kimi's same-timestamp expiry checks did not replace the discriminating test correction identified by Opus.

## Accepted Opus findings

1. **Issuance gate:** the live path uses `pruneAuthenticatedSettledPrefix`, whose planner admits pending or published records under the authenticated frontier. Publication-only requirements belong to another operation. The lifecycle table and prospective bound now describe the actual gate.
2. **Completion expiry:** the final chunk write and verification previously shared one timestamp. Advancing time before verification makes the existing expiry-equality assertion detect an accidental completion refresh.
3. **Origin accounting:** the cited pre/post numbers cross a browser-process boundary; boots also initially report zero usage for a persisted profile. The report now discloses those observations and does not attribute a physical-byte delta solely to deletion.
4. **Regression scope:** six passing cases are two selected test definitions across three engines, not the full 17-definition suite. The report names that scope explicitly. Opus corrected its initial denominator of 18 during follow-up; a direct count of top-level `test(` declarations independently confirmed 17.
5. **Typecheck scope:** the modified product entry still has pre-existing cross-root import diagnostics. The report names it instead of allowing the new test/server's clean diagnostics to imply a clean package.
6. **Recovery ordering:** the failing case retains the declaration before deleting snapshot bytes. Declaration discovery after maintenance is explicitly untested.
7. **Age labels:** census `closed-epoch`/`current-epoch` labels are not deletion eligibility.

The main audit also makes the grid default-profile distinction explicit and includes required recovery snapshots as a separate term in the prospective logical-content bound. No retention rule or production implementation changed.

## Correction closure

[Codex](../../.logs/grid-memory-attribution/native-codex-correction-review-01/stdout.log) returned RESOLVED for the exact-error assertion, the distinct verification timestamp and the corresponding report corrections. [Opus's same-session follow-up](../../.logs/grid-memory-attribution/native-opus-correction-review-01/stdout.log) resolved its seven findings subject to correcting its own suite denominator from 18 to 17; that correction is applied and independently checked.

The final native cases (2) and three-engine quarantine cases (21) passed after the test changes. Scoped lint and formatting passed. Package typecheck remains failing with output identical to the pre-correction run. The [audit](lifecycle-audit.md#verification-and-review-status) owns those receipts. No review or passing diagnostic is a production bounded-storage sign-off.
