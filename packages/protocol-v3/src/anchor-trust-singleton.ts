import { createAnchorTrustApi } from "./index.js";

const anchorTrustApi = createAnchorTrustApi();

export const {
	authenticateCurrentEpochAnchor,
	installCreatorAnchorTrustRoot,
	isAnchorTrustStateRecordBytes,
	openCurrentAnchorTrust,
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} = anchorTrustApi;
