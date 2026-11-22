# Formal model: the room worker bridge

`room-worker-bridge.qnt` models the ordering and handoff between a page and the dedicated worker that
hosts its room (`src/client.ts` is the page side, `src/server.ts` the worker side). Its header lists
what is modelled.

## Properties

| Property              | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `noUnadmittedDisplay` | The page never renders a move the room has not admitted.                  |
| `readYourWrites`      | Once a call resolves on the page, the page has rendered its move.         |
| `displayCurrency`     | What the page renders came from its current worker, never a dead one.     |
| `lifecycleFifo`       | The page handles no stream value of a session after that session's close. |
| `pageOrder`           | The room admits moves in the order the page posted them.                  |
| `safety`              | All five.                                                                 |

## Broken variants

Each is the design with one rule removed, started by its own init action. Each must violate the
property beside it; the design (`init`) must violate none.

| Init                    | The rule removed                                  | Violates              |
| ----------------------- | ------------------------------------------------- | --------------------- |
| `initReplyBeforeFlush`  | a result is posted after the pending stream value | `readYourWrites`      |
| `initNoSessionCheck`    | the page drops messages of another session        | `displayCurrency`     |
| `initOptimisticDisplay` | the page renders only what the worker sent        | `noUnadmittedDisplay` |
| `initEmitAfterClosed`   | a closed worker emits nothing                     | `lifecycleFifo`       |
| `initReorderCommands`   | the worker runs the oldest queued command         | `pageOrder`           |

## Commands

From the repository root, with Quint from `node_modules` and Java 17 for Apalache:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH
f=packages/room-worker/formal/room-worker-bridge.qnt
# Simulator: the design.
npx quint run $f --main roomWorkerBridge --init init --step step --invariant safety \
  --max-samples 100000 --max-steps 30 --seed 7
# Simulator: a broken variant.
npx quint run $f --main roomWorkerBridge --init initReplyBeforeFlush --step step --invariant readYourWrites \
  --max-samples 100000 --max-steps 30 --seed 7
# Apalache (bounded model checking): the design, and a broken variant.
npx quint verify $f --main roomWorkerBridge --init init --step step --invariant safety \
  --max-steps 8 --apalache-version=0.56.1
npx quint verify $f --main roomWorkerBridge --init initReorderCommands --step step --invariant pageOrder \
  --max-steps 8 --apalache-version=0.56.1
```

## Results

Quint 0.32.0, Apalache 0.56.1, on a loaded laptop (2026-11-20; logs in
`.logs/realtime-resume-2026-11-10/worker-default/quint-0{1,2}.txt`).

| Check                                          | Simulator (100,000 traces, 30 steps, seed 7) | Apalache                                        |
| ---------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `init`, `safety`                               | no violation (46 s)                          | no violation at 5, 6, 7 and 8 steps (8: 36 min) |
| `initReplyBeforeFlush`, `readYourWrites`       | violation                                    | counterexample within 8 steps (77 s)            |
| `initNoSessionCheck`, `displayCurrency`        | violation                                    | counterexample within 8 steps (7 s)             |
| `initOptimisticDisplay`, `noUnadmittedDisplay` | violation                                    | counterexample within 8 steps (7 s)             |
| `initEmitAfterClosed`, `lifecycleFifo`         | violation                                    | counterexample within 8 steps (35 s)            |
| `initReorderCommands`, `pageOrder`             | violation                                    | counterexample within 8 steps (7 s)             |

A 10-step Apalache run of the design was stopped after 2 h 15 min without a result.
