/* eslint-disable @typescript-eslint/explicit-function-return-type -- This deterministic evidence gate is plain Node ESM. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const [adoption, commit, activation, live, room, browser] = await Promise.all([
	read("packages/node/src/creator-adoption.ts"),
	read("packages/node/src/creator-adoption-commit.ts"),
	read("packages/node/src/creator-adoption-activate.ts"),
	read("packages/node/src/v3-live.ts"),
	read("examples/v3-room/src/index.ts"),
	read("packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts"),
]);

function section(source, start, end) {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from < 0 || to < 0) throw new TypeError(`D110C_B_SOURCE_SECTION_MISSING:${start}`);
	return source.slice(from, to);
}

const verifyChain = section(adoption, "function verifyChain(", "async function verifySnapshot(");
const activateMaterial = section(
	activation,
	"async function activateMaterial(",
	"/**\n * Activates one freshly committed"
);
const ownerWrapper = section(activation, "function wrapOwner(", "function browserLockRealm(");
const filteredIssuance = section(live, "function creatorFilteredIssuanceStore(", "function openRecoveryAuthorization(");
const liveActivation = section(
	live,
	"async function activateCreatorSuccessorLive(",
	"if (!installCreatorSuccessorLive(activateCreatorSuccessorLive))"
);
const roomAdoption = section(
	room,
	"const performCreatorSuccessorAdoption = async (): Promise<void> => {",
	"const adoptCreatorSuccessor = (): Promise<void> => {"
);
const roomAuthority = section(room, "export interface V3RoomSuccessorAuthority", "export interface V3RoomHead");
const successorAuthority = section(room, "function successorAuthority(", "function digest(");
const productProofStart = browser.indexOf(
	'test("D.110c-b advances one genuine room through hot epoch 0 to 1 to 2 and rebinds epoch 2 close custody"'
);
if (productProofStart < 0) throw new TypeError("D110C_B_SOURCE_SECTION_MISSING:product-proof");
const productProof = browser.slice(productProofStart);

const predicates = Object.freeze({
	activationDefersRetirementDuringReplacement:
		ownerWrapper.includes("if (owner.replacementInFlight)") &&
		ownerWrapper.includes("owner.retirementRequested = true") &&
		ownerWrapper.includes("await owner.replacementSettled"),
	activationPerformsExactOwnerCas:
		activateMaterial.includes("if (!currentOwner(existing) || existing.retirementRequested)") &&
		activateMaterial.includes("activeOwners.set(topic, replacement)"),
	activationRetainsAuthenticatedOwnerHeadAndToken:
		activation.includes("readonly head: ActiveHead;") && activation.includes("readonly token: object;"),
	commitRequiresExactNextEpoch:
		commit.includes("successorEpoch === currentEpoch + 1") &&
		commit.includes('currentEpoch === 0\n\t\t\t? "v3-live-generation-1"'),
	currentProjectionKindIsEpochRelative:
		adoption.includes('return epoch === 0 ? "v3-live-generation-1" : "v3-live-generation-2";') &&
		verifyChain.includes("successorEpoch !== currentEpoch + 1"),
	filteredIssuanceDelegatesToOneDurableOwner:
		filteredIssuance.includes("issuanceStore.compareAndMarkOutboxPublished") &&
		filteredIssuance.includes("issuanceStore.readIssued") &&
		filteredIssuance.includes("issuanceStore.transactIssue"),
	inheritedPredecessorRecoverySourceIsOneUse:
		live.includes("creatorPredecessorRecoverySource.set(predecessorValidation, transportHandoff.displacedSource)") &&
		live.includes("creatorPredecessorRecoverySource.get(input.capability as object)") &&
		live.includes("creatorPredecessorRecoverySource.delete(input.capability as object)"),
	liveActivationUsesOneFilteredStoreOwner:
		(liveActivation.match(/creatorFilteredIssuanceStore\(/gu)?.length ?? 0) === 2,
	productCloseIsReboundToReplacement:
		roomAdoption.includes("const rebound = await bindCurrentCreatorClose(replacement)") &&
		roomAdoption.includes("creatorCloseHandle = rebound.handle") &&
		roomAdoption.includes("await predecessorClose.stop()"),
	productHasNoPermanentFirstTransitionLatch: !roomAdoption.includes(
		"if (successorProjectionAuthority !== null) return;"
	),
	productPostTransferFailuresAreStalled:
		roomAdoption.includes('new TypeError("D110C_B_ACTIVATION_STALLED")') &&
		roomAdoption.includes('new TypeError("D110C_B_CLOSE_REBIND_FAILED")') &&
		roomAdoption.includes('creatorCloseUnavailableContinuity = "stalled"'),
	productProofClosesEpochTwoToThree:
		productProof.includes("D110C_B_PRODUCT_HOT_LOOP_COMPLETE") &&
		productProof.includes("{ epoch: 2, successorEpoch: 3 }"),
	productPublicAuthorityEpochIsGeneral:
		roomAuthority.includes("readonly epoch: number;") &&
		successorAuthority.includes("Number.isSafeInteger(currentEpoch)") &&
		successorAuthority.includes("currentEpoch < 1") &&
		successorAuthority.includes("epoch: currentEpoch"),
});

const failed = Object.entries(predicates).filter(([, value]) => value !== true);
process.stdout.write(`${JSON.stringify({ failed: failed.map(([name]) => name), predicates }, null, 2)}\n`);
if (failed.length > 0) throw new TypeError(`D110C_B_SOURCE_SHAPE_MISMATCH:${failed.map(([name]) => name).join(",")}`);
