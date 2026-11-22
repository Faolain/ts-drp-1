/* eslint-disable import/no-unresolved -- the governed GREEN owners are intentionally absent during RED */
import { foldBlueprintEpoch } from "../../../packages/compaction/src/blueprint-fold.js";
import type { BlueprintStateMachine } from "../../../packages/compaction/src/blueprint-fold.js";
import type { DeterministicStateMachine } from "../../../packages/test-utils/src/deterministic-state-machine.js";
import type { IStagedStateMachine } from "../../../packages/types/src/staged-state-machine.js";

declare const machine: BlueprintStateMachine;
declare const oracle: DeterministicStateMachine<unknown, unknown>;

const staged: IStagedStateMachine<unknown, unknown, unknown> = machine;
const referenceSnapshot: unknown = oracle.snapshot();

void [foldBlueprintEpoch, referenceSnapshot, staged];
