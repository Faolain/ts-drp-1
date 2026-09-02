import type { CreatorLiveCloseResult } from "../../../packages/node/src/creator-close.js";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

type ExpectedKeys =
	| "closedVertexCount"
	| "commitQcRef"
	| "currentTrustRef"
	| "cutValueRef"
	| "epoch"
	| "lifecycle"
	| "ok"
	| "successorAnchorDigest"
	| "successorEpoch"
	| "successorTrustRef";

type ResultKeysRemainExact = Assert<Equal<keyof CreatorLiveCloseResult, ExpectedKeys>>;
type EpochIsExactlyNumber = Assert<Equal<CreatorLiveCloseResult["epoch"], number>>;
type SuccessorEpochIsExactlyNumber = Assert<Equal<CreatorLiveCloseResult["successorEpoch"], number>>;

declare const common: Omit<CreatorLiveCloseResult, "epoch" | "successorEpoch">;

export const epochZeroCompatibility: CreatorLiveCloseResult = Object.freeze({
	...common,
	epoch: 0,
	successorEpoch: 1,
});

export const genuineEpochOneToTwo: CreatorLiveCloseResult = Object.freeze({
	...common,
	epoch: 1,
	successorEpoch: 2,
});

export const laterEpoch: CreatorLiveCloseResult["epoch"] = 3;

export type D110cAResultTypeContract = Readonly<{
	epochExactlyNumber: EpochIsExactlyNumber;
	epochZeroCompatibility: typeof epochZeroCompatibility;
	genuineEpochOneToTwo: typeof genuineEpochOneToTwo;
	laterEpoch: typeof laterEpoch;
	resultKeys: ResultKeysRemainExact;
	successorEpochExactlyNumber: SuccessorEpochIsExactlyNumber;
}>;
