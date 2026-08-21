# Slice E3-03: Loss and Head-of-Line Proof

## Contract

Under 30% peer-to-peer packet loss, the raw unreliable lane has lower receiver
freshness p95 than the reliable lane and later frames do not wait behind a lost
frame.

## Measurement seam

Use the pinned Playwright Chromium and the DevTools Network peer-to-peer loss,
queue, and reordering controls. Apply one-sided outbound conditions to one exact
sender/target only after signaling and both data channels are open. The raw and
reliable comparison lanes use that same sender and target.

Before crediting a run:

1. capability-check the exact command;
2. set loss to 100% for 500 ms while sends continue;
3. require zero calibration payload delivery while sends continue;
4. require the libp2p and sibling peer connections and both data channels to
   remain open throughout calibration, with no ICE restart or reconnect;
5. set 30% loss on the same exact target and measure from receiver timestamps.

If calibration fails, stop. An application drop shim or a best-effort
unverified flag cannot satisfy this slice.

## TDD and acceptance

Run three fixed trials with 40 ms latency, 30% loss, reordering enabled, 600
256-byte samples per lane at 30 Hz, and a reliable sentinel large enough to
expose HOL without exceeding current envelope laws.

Those three trials are the frozen campaign, not a discretionary retry pool. A
failed trial fails the gate; rerunning only successful seeds is forbidden.

Require on every trial:

- raw-required and zero fallback;
- actual `ordered === false` and `maxRetransmits === 0` at both ends;
- monotonic unreliable sequence;
- at least one receiver-observed unreliable sequence gap `n ... n+k`, where
  `k > 1`, followed by a later received sequence in that same trial;
- unreliable age-of-information p95 at least 20% lower than reliable p95,
  sampled from receiver timestamps. Both pages run in the same pinned Chromium
  process, use `Date.now()`, and must show sampled clock skew at most 5 ms before
  the trial; undelivered reliable samples remain stale through the deadline
  rather than being excluded;
- at least ten later unreliable samples observed before the reliable sentinel
  completes;
- no unreliable freshness stall over 500 ms while sends continue;
- a receiver-delivery floor frozen from a preliminary calibration, not invented
  during GREEN;
- zero movement durable vertices and one durable `placeBlock` vertex.

Channel death, ICE restart, libp2p reconnect, or failure to observe an actual
30%-trial gap is a harness failure, not evidence of loss tolerance. Target: <3
minutes. Preserve raw metrics, scoped emulation parameters, clock samples and
exact browser revision as artifacts.

## Human surface

The fabric workbench shows p50/p95 age of information, max gap, delivered and
dropped counts, fallback, and durable vertex deltas. Run screenshot critique,
comparison against E3-02, and the non-blocking preview window.

## Must stay green

E3 functional browser case without emulation, Firefox/WebKit functional
support where available, and all E2 authority cases.

## Feedback that changes this slice

If the pinned CDP control is not causal for SCTP data channels, reslice the
harness around a real packet-level Linux mechanism. Do not change transport
semantics or lower the claim.
