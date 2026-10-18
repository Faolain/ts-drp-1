# Native browser baseline

Question: does a small genuine product lifecycle complete with native IndexedDB/quota and process-cold recovery?

Extract the existing product server builder into a shared test fixture, preserving regression instrumentation as a caller-supplied plugin. Add explicit native storage boot mode. Run one Chromium persistent profile, three committed/adopted transitions, graceful close, new browser process on the same profile/origin, and a new published operation. Reuse authenticated product reopen behavior; do not port the Node grid runner.

Record runtime/build identity, topology, monotonic checkpoint time, exact projection/authority/issuance accounting, native storage estimate, aggregate storage census and supported renderer heap counters. Label observer overhead and unsupported metrics. Capture owned process identities and verify disappearance at close. Keep the profile until evidence has been reviewed.

Verification: execute a dedicated serial no-retry browser config with bounded deadlines, plus existing product hot-transition and persistent-recovery controls. Natural completion and exact semantics are the verdict; observed memory is not an acceptance threshold. User device/topology budgets would change later scale testing, not this fidelity probe.
