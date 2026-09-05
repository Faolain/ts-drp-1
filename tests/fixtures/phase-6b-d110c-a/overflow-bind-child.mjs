import { bindCreatorLiveClose } from "../../../packages/node/src/creator-close.ts";

const install = Reflect.get(bindCreatorLiveClose, "installV3CreatorCloseRegistrationResolver");
if (typeof install !== "function") throw new TypeError("D110C_A_OVERFLOW_INSTALLER_UNAVAILABLE");
const plane = Object.freeze({});
const installed = Reflect.apply(install, bindCreatorLiveClose, [
	(candidate) =>
		candidate === plane
			? Object.freeze({ currentTrust: Object.freeze({ currentEpoch: Number.MAX_SAFE_INTEGER }) })
			: undefined,
]);
if (installed !== true) throw new TypeError("D110C_A_OVERFLOW_INSTALL_FAILED");
const result = await bindCreatorLiveClose({ plane });
process.stdout.write(`${JSON.stringify(result)}\n`);
