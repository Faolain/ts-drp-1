# Slice 01 Review Record

Date: 2026-07-20

No public network traffic was sent. The live gate used only loopback relay
processes.

## Initial rejection and repair

Grok rejected the first extraction because status `100` could be returned
without retaining a listener handle, release deleted ownership before teardown
succeeded, refresh could overwrite a handle, and reserve could dial a different
candidate address than Identify inspected.

The final client now waits for both the advertised circuit address and matching
listener, retains every listener in a set across refreshes, removes each
resource only after its own teardown succeeds, keeps failed resources available
for retry/stop, tracks disconnect separately, and binds RESERVE to the address
accepted by inspection. Listener handles created just before a later timeout
are also retained for `stop()` cleanup.

## Final independent verdicts

- Grok, maximum available reasoning: `VERDICT: ACCEPT`
- Kimi, thinking mode with 100-step allowance: `VERDICT: ACCEPT`

## Local gate

- 50 relay tests and 8 grid tests passed.
- Package typecheck and focused ESLint passed.
- Chromium passed one success and one exhaustion case against real local relay
  processes after the final resource-ownership revision.
- The success case observed HOP plus accepted status `100`; the exhaustion case
  observed explicit status `200` refusals and no WebRTC path.
