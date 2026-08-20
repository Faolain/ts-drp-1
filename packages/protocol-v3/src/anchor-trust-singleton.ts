import { createAnchorTrustApi } from "./index.js";

const anchorTrustApi = createAnchorTrustApi();

export const {
	authenticateCurrentEpochAnchor,
	installCertifiedAnchorTrustRoot,
	installCreatorAnchorTrustRoot,
	isAnchorTrustStateRecordBytes,
	openCertifiedAnchorTrust,
	openCurrentAnchorTrust,
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} = anchorTrustApi;
