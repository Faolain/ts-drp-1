# D.110c-0b0b first high-risk design-review ledger

Reviewed signed/pushed checkpoint: `2291725250ff60ae5784ef53acf761e494f57409`
(`3bbf0091f25eb492a96c2f8a99ca4a78b6bc6803`), in clean detached checkout
`/tmp/ts-drp-d110c-0b0b-review.XbrmgX/checkout`.

## Results

- Grok 4.6/high completed normally after 630.282 seconds with
  `stop_reason=end_turn`, no timeout or cancellation. It emitted inspection
  prose before its terminal JSON, so the strict runner classified the run
  `NO_VERDICT`; its extracted terminal object was `APPROVED`, P0=0/P1=0/P2=1.
  The P2 identified the older two-trust active-closure sketch.
- Standard direct Kimi K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, session
  `session_ef3538ff-a75a-469d-b114-020e68398e4e`, returned `APPROVED`,
  P0=0/P1=0/P2=0. A preserved first CLI attempt failed before model execution
  because shorthand `k3` was not configured; the substantive invocation used
  configured alias `kimi-code/k3`.
- Opus xhigh, session `dfab6dec-9212-4ac9-815b-acef8ee180f1`, returned
  `CHANGES_REQUIRED`, P0=0/P1=1/P2=3. The P1 proved that the frozen
  `genesisTrust` input had no durable source once the epoch-0 generation/blob
  left the active plus two-Superseded window. The P2s identified the rollback
  generation off-by-one, omitted record-to-genesis object/digest equalities,
  and insufficient derivation binding for retiring CutValue/QC refs.

## Disposition

The P1 is accepted as a design defect, not a production failure. The corrected
contract consumes the existing caller-held genesis invite shape—pin, expected
object ID, exact canonical genesis-anchor preimage, and detached signature—and
authenticates it before using current-record profile/signer-set carriers. This
keeps one active trust record and counts one fixed O(1) bootstrap carrier; it
adds no product-input field, wire/schema field, dependency, authority, or
migration format.

All P2s are corrected in the same batch: the older/floor of the two
Superseded generations owns the predecessor trust under an explicit
two-head-advances-per-transition invariant; both retained records match genesis
object ID and digest; retiring refs derive from decoded authenticated current
CutValue/QC candidates; and the umbrella sketch no longer describes two trust
records in one closure. Because the correction changes the security input and
retention contract, one signed/pushed Grok/Kimi/Opus confirmation is required.
No production source, test, workload, D.110a invocation, Fable, or collaboration
subagent ran.
